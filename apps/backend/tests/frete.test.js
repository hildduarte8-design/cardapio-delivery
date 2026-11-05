// apps/backend/tests/frete.test.js
// Rodar: cd apps/backend && npm test   (node --test, Node 18+; sem dependências)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  criarServicoFrete,
  lerConfigDoAmbiente,
  validarCoordenadas,
  criarLimitadorDeRequisicoes,
  FreteError,
  FRETE_TIPO,
} from '../src/services/frete.js';

// Token falso, só com o formato válido
const TOKEN = 'pk.eyJ1IjoidGVzdGUiLCJhIjoiYWJjZGVmZ2hpamtsbW5vcCJ9.abcdefghijklmnop';

const LOJA = {
  id: 'r1', ativo: true, taxa_base: 5, valor_km: 2, raio_max_km: 12,
  loja_lat: -17.8575, loja_lon: -41.5053,
};
const PERTO = { lat: -17.9, lon: -41.5 };      // ~4,8 km em linha reta
const LONGE = { lat: -18.4, lon: -41.5 };      // ~60 km

// ---- helpers ---------------------------------------------------------------
const resp = (corpo, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => corpo,
});
const rotaOk = (metros) => resp({ code: 'Ok', routes: [{ distance: metros }] });
// AbortSignal.timeout() usa timer "unref": num servidor o listener HTTP mantém o
// processo vivo, mas no teste não. Por isso o mock segura um timer comum até abortar.
const pendura = (_url, { signal }) =>
  new Promise((_, rej) => {
    const seguraVivo = setTimeout(() => {}, 10_000);
    signal.addEventListener('abort', () => {
      clearTimeout(seguraVivo);
      rej(signal.reason);
    });
  });

function roteador({ mapbox, osrm }) {
  const chamadas = { mapbox: [], osrm: [] };
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.mapbox.com/')) {
      chamadas.mapbox.push(u);
      return mapbox(u, opts);
    }
    if (u.startsWith('http://osrm.interno:5000/')) {
      chamadas.osrm.push(u);
      return osrm(u, opts);
    }
    throw new Error(`URL inesperada: ${u}`);
  };
  return { fetchImpl, chamadas };
}

function criar({ env = {}, mapbox, osrm, bairro, agora } = {}) {
  const logs = [];
  const logger = {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m) => logs.push(m),
  };
  const { fetchImpl, chamadas } = roteador({
    mapbox: mapbox ?? (() => rotaOk(1000)),
    osrm: osrm ?? (() => rotaOk(1000)),
  });
  const config = lerConfigDoAmbiente({
    MAPBOX_TOKEN: TOKEN,
    OSRM_BASE_URL: 'http://osrm.interno:5000',
    NODE_ENV: 'test',
    ...env,
  });
  const servico = criarServicoFrete({
    config,
    deps: { fetchImpl, logger, buscarTaxaBairro: bairro, ...(agora ? { agora } : {}) },
  });
  return { servico, chamadas, logs };
}

// ---- 1. sucesso ------------------------------------------------------------
test('sucesso via Mapbox: calcula taxa, tipo e usa overview=false', async () => {
  const { servico, chamadas } = criar({ mapbox: () => rotaOk(3456) });
  const r = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  assert.equal(r.frete_tipo, FRETE_TIPO.ROTA_MAPBOX);
  assert.equal(r.distancia_km, 3.46);
  assert.equal(r.taxa, 11.92); // 5,00 + 3,46 * 2,00
  assert.equal(r.estimado, false);
  assert.equal(r.requer_confirmacao, false);
  assert.equal(chamadas.mapbox.length, 1);
  assert.match(chamadas.mapbox[0], /overview=false/);
  assert.equal(chamadas.osrm.length, 0);
});

// ---- 2. cache --------------------------------------------------------------
test('cache: segunda cotação igual não chama o provedor e mantém o tipo', async () => {
  const { servico, chamadas } = criar({ mapbox: () => rotaOk(2000) });
  const a = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  const b = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  assert.equal(chamadas.mapbox.length, 1);
  assert.equal(a.cache, false);
  assert.equal(b.cache, true);
  assert.equal(b.frete_tipo, FRETE_TIPO.ROTA_MAPBOX);
  assert.equal(b.taxa, a.taxa);
});

test('cache: requisições simultâneas idênticas viram uma só chamada', async () => {
  const { servico, chamadas } = criar({
    mapbox: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return rotaOk(2000);
    },
  });
  await Promise.all([1, 2, 3, 4, 5].map(() => servico.calcularFrete({ restaurante: LOJA, destino: PERTO })));
  assert.equal(chamadas.mapbox.length, 1);
});

// ---- 3. timeout ------------------------------------------------------------
test('timeout no Mapbox cai para OSRM e registra o motivo', async () => {
  const { servico } = criar({
    env: { MAPBOX_TIMEOUT_MS: '200' },
    mapbox: pendura,
    osrm: () => rotaOk(4000),
  });
  const r = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  assert.equal(r.frete_tipo, FRETE_TIPO.ROTA_OSRM);
  assert.equal(r.distancia_km, 4);
  assert.equal(r.tentativas[0].provedor, 'mapbox');
  assert.equal(r.tentativas[0].resultado, 'timeout');
});

// ---- 4. falha dos provedores -----------------------------------------------
test('Mapbox e OSRM falham: usa a taxa do bairro', async () => {
  const { servico } = criar({
    mapbox: () => resp({}, 500),
    osrm: () => { throw new Error('ECONNREFUSED'); },
    bairro: async ({ restauranteId, bairro }) => {
      assert.equal(restauranteId, 'r1');
      assert.equal(bairro, 'Centro');
      return { id: 7, nome: 'Centro', taxa: 8 };
    },
  });
  const r = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO, bairro: 'Centro' });
  assert.equal(r.frete_tipo, FRETE_TIPO.BAIRRO);
  assert.equal(r.taxa, 8);
  assert.equal(r.distancia_km, null);
  assert.deepEqual(r.bairro, { id: 7, nome: 'Centro' });
});

test('sem provedores e sem bairro: Haversine marcado como estimativa', async () => {
  const { servico } = criar({
    mapbox: () => resp({}, 503),
    osrm: () => resp({}, 503),
    bairro: async () => null,
  });
  const r = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO, bairro: 'Inexistente' });
  assert.equal(r.frete_tipo, FRETE_TIPO.ESTIMADO);
  assert.equal(r.estimado, true);
  assert.equal(r.requer_confirmacao, true);
  assert.ok(r.distancia_km > 4.8, 'estimativa deve ser >= linha reta');
});

test('falha na busca do bairro não derruba o cálculo (cai para estimativa)', async () => {
  const { servico } = criar({
    mapbox: () => resp({}, 500),
    osrm: () => resp({}, 500),
    bairro: async () => { throw new Error('db fora'); },
  });
  const r = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO, bairro: 'Centro' });
  assert.equal(r.frete_tipo, FRETE_TIPO.ESTIMADO);
});

test('sem coordenadas e sem bairro utilizável: SEM_DADOS_PARA_FRETE', async () => {
  const { servico } = criar({ bairro: async () => null });
  await assert.rejects(
    servico.calcularFrete({ restaurante: LOJA, destino: null, bairro: 'ab' }),
    (e) => e instanceof FreteError && e.code === 'SEM_DADOS_PARA_FRETE',
  );
});

test('NoRoute do Mapbox segue para o OSRM sem abrir o circuito', async () => {
  const { servico } = criar({
    env: { FRETE_CB_FALHAS: '1' },
    mapbox: () => resp({ code: 'NoRoute', routes: [] }),
    osrm: () => rotaOk(3000),
  });
  const a = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  assert.equal(a.frete_tipo, FRETE_TIPO.ROTA_OSRM);
  const b = await servico.calcularFrete({ restaurante: LOJA, destino: { lat: -17.901, lon: -41.501 } });
  assert.equal(b.tentativas[0].resultado, 'sem_rota'); // Mapbox continua sendo tentado
});

// ---- 5. coordenadas inválidas ----------------------------------------------
test('coordenadas inválidas são recusadas antes de qualquer chamada externa', async () => {
  const { servico, chamadas } = criar();
  const invalidas = [
    { lat: 91, lon: -41.5 },
    { lat: -17.9, lon: 181 },
    { lat: 'abc', lon: -41.5 },
    { lat: NaN, lon: -41.5 },
    { lat: Infinity, lon: -41.5 },
    { lat: '1e2', lon: -41.5 },
    { lat: 0, lon: 0 },
    { lat: null, lon: null },
    { lat: undefined, lon: -41.5 },
    'texto',
  ];
  for (const destino of invalidas) {
    await assert.rejects(
      servico.calcularFrete({ restaurante: LOJA, destino, bairro: 'Centro' }),
      (e) => e instanceof FreteError && e.code === 'COORDENADAS_INVALIDAS' && e.status === 400,
      `deveria recusar ${JSON.stringify(destino)}`,
    );
  }
  assert.equal(chamadas.mapbox.length + chamadas.osrm.length, 0);
});

test('validarCoordenadas aceita number e string decimal simples', () => {
  assert.deepEqual(validarCoordenadas('-17.85', '-41.50'), { lat: -17.85, lon: -41.5 });
  assert.deepEqual(validarCoordenadas(-17.85, -41.5), { lat: -17.85, lon: -41.5 });
  assert.equal(validarCoordenadas('', ''), null);
});

// ---- 6. área de entrega ----------------------------------------------------
test('fora do raio (linha reta) é recusado sem gastar chamada', async () => {
  const { servico, chamadas } = criar();
  await assert.rejects(
    servico.calcularFrete({ restaurante: LOJA, destino: LONGE }),
    (e) => e.code === 'FORA_DA_AREA' && e.status === 422,
  );
  assert.equal(chamadas.mapbox.length, 0);
});

test('rota real maior que o raio também é recusada', async () => {
  const { servico } = criar({ mapbox: () => rotaOk(15_000) });
  await assert.rejects(
    servico.calcularFrete({ restaurante: LOJA, destino: PERTO }),
    (e) => e.code === 'FORA_DA_AREA',
  );
});

// ---- 7. multi-tenant -------------------------------------------------------
test('configurações de frete são isoladas por restaurante (mesma rota, taxas diferentes)', async () => {
  const { servico, chamadas } = criar({ mapbox: () => rotaOk(5000) });
  const outra = { ...LOJA, id: 'r2', taxa_base: 3, valor_km: 1.5 };
  const a = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  const b = await servico.calcularFrete({ restaurante: outra, destino: PERTO });
  assert.equal(a.taxa, 15); // 5 + 5*2
  assert.equal(b.taxa, 10.5); // 3 + 5*1.5
  assert.equal(chamadas.mapbox.length, 1); // a rota (só geografia) é compartilhada
});

test('restaurante inativo ou com configuração inválida é recusado', async () => {
  const { servico } = criar();
  await assert.rejects(servico.calcularFrete({ restaurante: { ...LOJA, ativo: false }, destino: PERTO }),
    (e) => e.code === 'RESTAURANTE_INATIVO');
  await assert.rejects(servico.calcularFrete({ restaurante: { ...LOJA, taxa_base: -1 }, destino: PERTO }),
    (e) => e.code === 'RESTAURANTE_INVALIDO');
  await assert.rejects(servico.calcularFrete({ restaurante: null, destino: PERTO }),
    (e) => e.code === 'RESTAURANTE_INVALIDO');
});

// ---- 8. segurança de logs ---------------------------------------------------
test('token do Mapbox nunca aparece nos logs nem nas tentativas', async () => {
  const { servico, logs } = criar({
    mapbox: (url) => { throw new Error(`falha em ${url}`); }, // erro "vazando" a URL com o token
    osrm: () => resp({}, 500),
  });
  const r = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  const tudo = JSON.stringify(logs) + JSON.stringify(r);
  assert.ok(!tudo.includes(TOKEN), 'token vazou');
  assert.ok(!/access_token/i.test(tudo), 'parâmetro access_token vazou');
  assert.ok(!tudo.includes('-17.9'), 'coordenada do cliente vazou');
});

// ---- 9. OSRM demo em produção ----------------------------------------------
test('OSRM demo público é bloqueado em produção (e liberado fora dela)', async () => {
  const chamadasDemo = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.mapbox.com/')) return resp({}, 500);
    chamadasDemo.push(u);
    return rotaOk(2000);
  };
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const mk = (nodeEnv) => criarServicoFrete({
    config: lerConfigDoAmbiente({ MAPBOX_TOKEN: TOKEN, OSRM_BASE_URL: 'https://router.project-osrm.org', NODE_ENV: nodeEnv }),
    deps: { fetchImpl, logger },
  });

  const prod = await mk('production').calcularFrete({ restaurante: LOJA, destino: PERTO });
  assert.equal(chamadasDemo.length, 0);
  assert.equal(prod.frete_tipo, FRETE_TIPO.ESTIMADO);
  assert.ok(logs.some((l) => l.includes('osrm_demo_bloqueado_em_producao')));

  const dev = await mk('development').calcularFrete({ restaurante: LOJA, destino: PERTO });
  assert.equal(chamadasDemo.length, 1);
  assert.equal(dev.frete_tipo, FRETE_TIPO.ROTA_OSRM);
});

test('OSRM com credenciais na URL é desativado', async () => {
  const { servico } = criar({ env: { OSRM_BASE_URL: 'http://user:senha@osrm.interno:5000' } });
  const r = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  assert.ok(!r.tentativas.some((t) => t.provedor === 'osrm'));
});

// ---- 10. circuito e orçamento ----------------------------------------------
test('circuit breaker: após N falhas o Mapbox é pulado e depois volta', async () => {
  let t = 1_000_000;
  const { servico, chamadas } = criar({
    env: { FRETE_CB_FALHAS: '2', FRETE_CB_PAUSA_MS: '5000' },
    mapbox: () => resp({}, 500),
    osrm: () => rotaOk(2000),
    agora: () => t,
  });
  const d = (i) => ({ lat: -17.9 + i * 0.001, lon: -41.5 });
  await servico.calcularFrete({ restaurante: LOJA, destino: d(1) });
  await servico.calcularFrete({ restaurante: LOJA, destino: d(2) });
  const terceira = await servico.calcularFrete({ restaurante: LOJA, destino: d(3) });
  assert.equal(chamadas.mapbox.length, 2);
  assert.equal(terceira.tentativas[0].resultado, 'circuito_aberto');
  t += 6000; // passou a pausa
  await servico.calcularFrete({ restaurante: LOJA, destino: d(4) });
  assert.equal(chamadas.mapbox.length, 3);
});

test('orçamento diário do Mapbox esgotado: usa OSRM sem chamar o Mapbox', async () => {
  const { servico, chamadas } = criar({ env: { MAPBOX_MAX_CHAMADAS_DIA: '1' }, mapbox: () => rotaOk(2000), osrm: () => rotaOk(2500) });
  const a = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  const b = await servico.calcularFrete({ restaurante: LOJA, destino: { lat: -17.91, lon: -41.5 } });
  assert.equal(a.frete_tipo, FRETE_TIPO.ROTA_MAPBOX);
  assert.equal(b.frete_tipo, FRETE_TIPO.ROTA_OSRM);
  assert.equal(chamadas.mapbox.length, 1);
  assert.equal(b.tentativas[0].resultado, 'orcamento_esgotado');
});

test('sem MAPBOX_TOKEN: pula direto para o OSRM', async () => {
  const { servico, chamadas } = criar({ env: { MAPBOX_TOKEN: '' }, osrm: () => rotaOk(2000) });
  const r = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  assert.equal(r.frete_tipo, FRETE_TIPO.ROTA_OSRM);
  assert.equal(chamadas.mapbox.length, 0);
});

test('resposta inválida do provedor não é aceita como distância', async () => {
  const { servico } = criar({
    mapbox: () => resp({ code: 'Ok', routes: [{ distance: 'muito' }] }),
    osrm: () => resp({ code: 'Ok', routes: [{ distance: -5 }] }),
  });
  const r = await servico.calcularFrete({ restaurante: LOJA, destino: PERTO });
  assert.equal(r.frete_tipo, FRETE_TIPO.ESTIMADO);
  assert.equal(r.tentativas[0].resultado, 'resposta_invalida');
});

// ---- 11. limitador ---------------------------------------------------------
test('limitador responde 429 depois do máximo e libera na próxima janela', () => {
  let t = 0;
  const lim = criarLimitadorDeRequisicoes({ max: 2, janelaMs: 1000, agora: () => t, chave: () => 'ip1' });
  const novaRes = () => ({
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  });
  let passou = 0;
  const next = () => { passou += 1; };
  const r1 = novaRes(), r2 = novaRes(), r3 = novaRes();
  lim({}, r1, next); lim({}, r2, next); lim({}, r3, next);
  assert.equal(passou, 2);
  assert.equal(r3.statusCode, 429);
  assert.equal(r3.body.erro, 'MUITAS_REQUISICOES');
  assert.ok(r3.headers['Retry-After']);
  t += 1001;
  const r4 = novaRes();
  lim({}, r4, next);
  assert.equal(passou, 3);
  lim.encerrar();
});
