
// apps/frontend/tests/frete-gps.test.js
// Execução: node --test apps/frontend/tests/frete-gps.test.js

import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.resolve(__dirname, '../index.html');
const vitrineSrcPath = path.resolve(__dirname, '../js/vitrine-adicionais.js');
const freteGpsSrcPath = path.resolve(__dirname, '../js/frete-gps.js');

const rawIndexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
const vitrineSrc = fs.readFileSync(vitrineSrcPath, 'utf8');
const freteGpsSrc = fs.readFileSync(freteGpsSrcPath, 'utf8');

// Remove apenas links e scripts externos para rodar o DOM e o script inline do index.html offline no JSDOM
const offlineIndexHtml = rawIndexHtml
  .replace(/<link[^>]+href="https?:\/\/[^"]+"[^>]*>/gi, '')
  .replace(/<script\s+src="[^"]+"\s*><\/script>/gi, '');

function aguardar(ms = 15) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function criarAmbienteTeste({ fetchHandler, geolocationDisponivel = true } = {}) {
  const dom = new JSDOM(offlineIndexHtml, {
    url: 'http://localhost:5173/?r=imperial',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  const { document } = window;

  // Rastreia timers para encerrar o event loop imediatamente após cada teste
  const timeouts = new Set();
  const intervals = new Set();
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);

  window.setTimeout = (fn, delay, ...args) => {
    const id = origSetTimeout(() => {
      timeouts.delete(id);
      fn(...args);
    }, delay);
    timeouts.add(id);
    return id;
  };
  window.clearTimeout = (id) => {
    timeouts.delete(id);
    return origClearTimeout(id);
  };
  window.setInterval = (fn, delay, ...args) => {
    const id = origSetInterval(fn, delay, ...args);
    intervals.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    intervals.delete(id);
    return origClearInterval(id);
  };

  // Implementa APIs ausentes no JSDOM usadas pelo fluxo real
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.confirm = () => true;
  if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
    let seqUuid = 0;
    Object.defineProperty(window, 'crypto', {
      configurable: true,
      value: {
        randomUUID: () => `00000000-0000-4000-8000-${String(++seqUuid).padStart(12, '0')}`,
      },
    });
  }

  // Registra requisições HTTP disparadas por frete-gps.js e index.html
  const requisicoes = [];
  window.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    requisicoes.push({
      url: urlStr,
      method: opts.method || 'GET',
      body,
    });
    if (!fetchHandler) {
      throw new Error(`fetchHandler não configurado para ${urlStr}`);
    }
    return fetchHandler(urlStr, body, opts);
  };

  // Controlador da API de geolocalização
  let geoCallbacks = null;
  if (geolocationDisponivel) {
    Object.defineProperty(window.navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success, error, options) {
          geoCallbacks = { success, error, options };
        },
      },
    });
  } else {
    Object.defineProperty(window.navigator, 'geolocation', {
      configurable: true,
      value: undefined,
    });
  }

  const selectBairro = document.getElementById('select-bairro');
  selectBairro.innerHTML = [
    '<option value="">Selecione seu bairro...</option>',
    '<option value="b-centro" data-taxa="8" data-tempo="35 min">Centro</option>',
    '<option value="b-cidade-nova" data-taxa="6" data-tempo="30 min">Cidade Nova</option>',
  ].join('');

  // Injeta vitrine-adicionais.js e frete-gps.js via <script> para compartilhar o mesmo
  // escopo léxico global do <script> inline de index.html (preservando let modoEntrega, etc.)
  function carregarScriptNoDom(codigo) {
    const script = document.createElement('script');
    script.textContent = codigo;
    document.body.appendChild(script);
  }

  carregarScriptNoDom(vitrineSrc);
  carregarScriptNoDom(freteGpsSrc);

  // Inicializa explicitamente todas as variáveis globais do checkout real
  // usadas por atualizarTaxa(), alternância entrega/retirada e finalizarPedido()
  window.eval(`
    restauranteInfo = {
      id: 'rest-imperial-1',
      slug: 'imperial',
      nome: 'Pastel e Batata Imperial',
      ativo: true,
      frete_por_distancia: true,
      raio_max_km: 12,
      whatsapp: '5533991754863',
      chave_pix: ''
    };
    produtos = [
      { id: 'prod-1', nome: 'Pastel Imperial', preco: 20, categoria: 'Pastéis', disponivel: true }
    ];
    carrinho = [];
    taxaAtual = 0;
    filtroBusca = '';
    categoriaAtiva = '';
    modoEntrega = 'entrega';
    enviando = false;
    tentativaPendente = null;
    tentativaSalvaNoDispositivo = false;
    timerAcompanhamento = null;
    acompanhamentoAtual = null;
    acompanhamentoCtx = null;
    vtAdicionais = {};
    vtProdutoAberto = null;
    vtMarcados = new Set();
    vtQtd = 1;
  `);

  assert.equal(window.eval('modoEntrega'), 'entrega');
  assert.equal(window.eval('taxaAtual'), 0);
  assert.equal(window.eval('enviando'), false);

  // Aguarda o polling de inicialização (300ms) montar #gps-box e #btn-gps
  for (let i = 0; i < 20 && !document.getElementById('btn-gps'); i += 1) {
    await aguardar(30);
  }
  assert.ok(document.getElementById('btn-gps'), 'o botão #btn-gps deve ser montado quando frete_por_distancia=true');

  function entrarNaSacola() {
    window.eval(`adicionarCarrinho('prod-1');`);
    document.body.classList.add('sacola');
    window.eval(`renderCarrinho();`);
  }

  function preencherDadosCheckoutValidos() {
    document.getElementById('cli-nome').value = 'Hild Duarte';
    document.getElementById('cli-fone').value = '33991754863';
    document.getElementById('cli-rua').value = 'Rua Epaminondas Otoni';
    document.getElementById('cli-numero').value = '120';
    const radioPix = document.querySelector('input[name="pagto"][value="pix"]');
    radioPix.checked = true;
  }

  async function simularLeituraGps({ lat, lon, accuracy = 15, confirmarLocal = true }) {
    geoCallbacks = null;
    const btnGps = document.getElementById('btn-gps');
    btnGps.click();
    assert.ok(geoCallbacks, 'navigator.geolocation.getCurrentPosition deve ser chamado ao clicar em #btn-gps');

    const fluxoPromise = geoCallbacks.success({
      coords: { latitude: lat, longitude: lon, accuracy },
    });

    await aguardar(20);
    const modalConfirma = document.getElementById('gps-confirma');
    if (modalConfirma) {
      const botoes = modalConfirma.querySelectorAll('button');
      const alvo = confirmarLocal ? botoes[0] : botoes[1];
      alvo.click();
    }

    await fluxoPromise;
    await aguardar(10);
  }

  async function simularErroGps(err = { code: 1, message: 'User denied Geolocation' }) {
    geoCallbacks = null;
    const btnGps = document.getElementById('btn-gps');
    btnGps.click();
    assert.ok(geoCallbacks, 'navigator.geolocation.getCurrentPosition deve ser chamado');
    await geoCallbacks.error(err);
    await aguardar(10);
  }

  function destruir() {
    for (const id of timeouts) origClearTimeout(id);
    for (const id of intervals) origClearInterval(id);
    timeouts.clear();
    intervals.clear();
    window.close();
  }

  return {
    window,
    document,
    requisicoes,
    entrarNaSacola,
    preencherDadosCheckoutValidos,
    simularLeituraGps,
    simularErroGps,
    destruir,
  };
}

describe('Bloqueio por raio de entrega (frete-gps.js + index.html)', () => {
  let env = null;

  afterEach(() => {
    if (env) {
      env.destruir();
      env = null;
    }
  });

  test('1. Resposta FORA_DA_AREA bloqueia o envio na modalidade entrega', async () => {
    env = await criarAmbienteTeste({
      fetchHandler: async () => {
        throw new Error('Não deveria consultar a API neste teste');
      },
    });

    const tratou = await env.window.freteGps.tratarErro(
      422,
      { codigo: 'FORA_DA_AREA', detalhes: { limite_km: 12 } },
      { cliente_lat: -18.42, cliente_lon: -41.52 }
    );

    assert.equal(tratou, true);
    assert.equal(env.window.freteGps.bloqueado(), true);
    assert.equal(env.document.getElementById('btn-enviar').disabled, true);
    assert.equal(
      env.document.getElementById('btn-enviar').textContent,
      'Fora da área de entrega'
    );
  });

  test('2. Selecionar bairro manualmente não remove o bloqueio', async () => {
    const cotacoes = [];

    env = await criarAmbienteTeste({
      fetchHandler: async (url, body) => {
        if (url.endsWith('/api/frete/cotar')) {
          cotacoes.push(body);
          return {
            ok: false,
            status: 422,
            json: async () => ({
              codigo: 'FORA_DA_AREA',
              detalhes: { limite_km: 12 },
            }),
          };
        }

        throw new Error(`URL inesperada: ${url}`);
      },
    });

    await env.window.freteGps.tratarErro(
      422,
      { codigo: 'FORA_DA_AREA', detalhes: { limite_km: 12 } },
      { cliente_lat: -18.4, cliente_lon: -41.5 }
    );

    const selectBairro = env.document.getElementById('select-bairro');
    selectBairro.value = 'b-centro';
    selectBairro.dispatchEvent(
      new env.window.Event('change', { bubbles: true })
    );

    await aguardar(30);

    assert.ok(cotacoes.length > 0);
    assert.equal(cotacoes.at(-1).bairro_id, 'b-centro');
    assert.equal(cotacoes.at(-1).cliente_lat, -18.4);
    assert.equal(cotacoes.at(-1).cliente_lon, -41.5);

    assert.equal(env.window.freteGps.bloqueado(), true);
    assert.equal(env.document.getElementById('btn-enviar').disabled, true);
  });

  test('3. Retirada permite continuar mesmo com endereço de entrega bloqueado', async () => {
    env = await criarAmbienteTeste({
      fetchHandler: async () => {
        throw new Error('Não deveria consultar a API neste teste');
      },
    });

    await env.window.freteGps.tratarErro(
      422,
      { codigo: 'FORA_DA_AREA', detalhes: { limite_km: 12 } },
      { cliente_lat: -18.4, cliente_lon: -41.5 }
    );

    assert.equal(env.document.getElementById('btn-enviar').disabled, true);

    const abaRetirada = env.document.querySelector(
      '#abas-ent [data-modo="retirada"]'
    );
    const abaEntrega = env.document.querySelector(
      '#abas-ent [data-modo="entrega"]'
    );

    assert.ok(abaRetirada, 'A aba de retirada deve existir');
    assert.ok(abaEntrega, 'A aba de entrega deve existir');

    abaRetirada.click();

    assert.equal(env.window.eval('modoEntrega'), 'retirada');
    assert.equal(env.document.getElementById('btn-enviar').disabled, false);

    abaEntrega.click();

    assert.equal(env.window.eval('modoEntrega'), 'entrega');
    assert.equal(env.document.getElementById('btn-enviar').disabled, true);
  });

  test('4. limpar() remove o bloqueio e reinicia o módulo', async () => {
    env = await criarAmbienteTeste({
      fetchHandler: async () => {
        throw new Error('Não deveria consultar a API neste teste');
      },
    });

    await env.window.freteGps.tratarErro(
      422,
      { codigo: 'FORA_DA_AREA', detalhes: { limite_km: 12 } },
      { cliente_lat: -18.4, cliente_lon: -41.5 }
    );

    assert.equal(env.window.freteGps.bloqueado(), true);
    assert.equal(env.document.getElementById('btn-enviar').disabled, true);

    env.window.freteGps.limpar();

    assert.equal(env.window.freteGps.bloqueado(), false);
    assert.equal(Object.keys(env.window.freteGps.payload()).length, 0);
    assert.equal(env.document.getElementById('gps-info').textContent, '');
    assert.equal(env.document.getElementById('btn-enviar').disabled, false);
  });

  test('5. Endereço bloqueado não envia pedido para a API', async () => {
    env = await criarAmbienteTeste({
      fetchHandler: async (url) => {
        if (url.endsWith('/api/pedidos')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              sucesso: true,
              pedido: { id: 'ped-teste' },
            }),
          };
        }

        throw new Error(`URL inesperada: ${url}`);
      },
    });

    env.entrarNaSacola();
    env.preencherDadosCheckoutValidos();

    await env.window.freteGps.tratarErro(
      422,
      { codigo: 'FORA_DA_AREA', detalhes: { limite_km: 12 } },
      { cliente_lat: -18.42, cliente_lon: -41.52 }
    );

    const pedidosAntes = env.requisicoes.filter(
      (r) => r.url.endsWith('/api/pedidos')
    ).length;

    await env.window.eval('finalizarPedido()');

    const pedidosDepois = env.requisicoes.filter(
      (r) => r.url.endsWith('/api/pedidos')
    ).length;

    assert.equal(
      pedidosDepois,
      pedidosAntes,
      'Nenhum pedido deve ser enviado enquanto a entrega estiver bloqueada'
    );
  });

  test('6. Payload não inclui taxa cotada quando o endereço está bloqueado', async () => {
    env = await criarAmbienteTeste({
      fetchHandler: async () => {
        throw new Error('Não deveria consultar a API neste teste');
      },
    });

    await env.window.freteGps.tratarErro(
      422,
      { codigo: 'FORA_DA_AREA', detalhes: { limite_km: 12 } },
      { cliente_lat: -18.42, cliente_lon: -41.52 }
    );

    assert.equal(env.window.freteGps.bloqueado(), true);
    assert.equal(Object.keys(env.window.freteGps.payload()).length, 0);
    assert.equal(
      Object.hasOwn(env.window.freteGps.payload(), 'taxa_cotada'),
      false
    );
  });
});
