import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { criarLimitadorDeRequisicoes } from '../src/services/frete.js';
import {
  normalizarTexto,
  prepararBusca,
  indexarBairrosDaLoja,
  criarServicoRuas,
  middlewaresBuscaRuas
} from '../src/services/ruas.js';

const REST_ID = 'b6175a0c-cdc3-42b8-a8e8-d4f304da8fd8';
const OUTRO_ID = '11111111-2222-4333-8444-555555555555';

const BAIRROS = [
  { id: 'b-centro', nome: 'Centro', ativo: true, taxa: '8.50' },
  { id: 'b-altamiro', nome: 'Altamiro Nunes Leite', ativo: true, taxa: 8 },
  { id: 'b-vila-barreiros', nome: 'Vila Barreiros', ativo: true, taxa: 4 },
  { id: 'b-cidade-nova', nome: 'Cidade Nova', ativo: true, taxa: 4.5 },
  { id: 'b-inativo', nome: 'Bairro Inativo', ativo: false, taxa: 8 },
  { id: 'b-sem-taxa', nome: 'Bairro Sem Taxa', ativo: true, taxa: null },
  { id: 'b-dup-1', nome: 'Jardim Duplo', ativo: true, taxa: 8 },
  { id: 'b-dup-2', nome: 'JARDIM  duplo', ativo: true, taxa: 9 }
];

function linha(logradouro, bairro) {
  return {
    logradouro,
    logradouro_normalizado: normalizarTexto(logradouro),
    bairro,
    bairro_normalizado: normalizarTexto(bairro)
  };
}

const RUAS = [
  linha('Rua Getulio Vargas', 'Centro'),
  linha('Rua Getulio Vargas', 'Vila Betel'),
  linha('Rua Getulio Vargas', 'Bela Vista'),
  linha('Rua Getulio Vargas', 'Altamiro Nunes Leite'),
  linha('Avenida Getulio Vargas', 'Centro'),
  linha('Rua Martins Scofield', 'Vila Barreiros'),
  linha('Rua Martins Scofield', 'Barreiros'),
  linha('Rua Chile', 'Bela Vista'),
  linha('Rua Chile', 'Vila Betel'),
  linha('Rua Sao Joao', 'Bairro Inativo'),
  linha('Rua Sao Joao', 'Bairro Sem Taxa'),
  linha('Rua Sao Joao', 'Jardim Duplo'),
  linha('Rua Joao Pessoa', 'Centro'),
  linha('Travessa Getulio', 'Centro')
];

function criarDbFalso({ restaurantes = { [REST_ID]: { id: REST_ID, ativo: true } }, bairros = BAIRROS, ruas = RUAS } = {}) {
  const db = {
    chamadas: { restaurante: 0, bairros: 0, ruas: 0 },
    ultimaBuscaRuas: null,
    async buscarRestaurante(id) { db.chamadas.restaurante += 1; return restaurantes[id] || null; },
    async listarBairros() { db.chamadas.bairros += 1; return bairros; },
    async buscarRuas({ cidadeIbge, palavras }) {
      db.chamadas.ruas += 1;
      db.ultimaBuscaRuas = { cidadeIbge, palavras };
      return ruas.filter((r) => palavras.every((p) => r.logradouro_normalizado.includes(p)));
    }
  };
  return db;
}

async function buscar(servico, q, restauranteId = REST_ID) {
  return servico.buscar({ restauranteId, q });
}

// ---------------------------------------------------------------------------
// Normalização e validação do texto
// ---------------------------------------------------------------------------

test('normaliza sem acento, maiúscula e só letras/números/espaço', () => {
  assert.equal(normalizarTexto('  Getúlio   Vargas! '), 'GETULIO VARGAS');
  assert.equal(normalizarTexto("Rua d'Água 12"), 'RUA D AGUA 12');
  assert.equal(normalizarTexto(null), '');
});

test('entradas ruins: curta, longa, tipo errado e símbolos', () => {
  assert.equal(prepararBusca('ab').codigo, 'TERMO_CURTO');
  assert.equal(prepararBusca('%%%').codigo, 'TERMO_CURTO');
  assert.equal(prepararBusca("'\"").codigo, 'TERMO_CURTO');
  assert.equal(prepararBusca('a'.repeat(61)).codigo, 'TERMO_LONGO');
  assert.equal(prepararBusca('a'.repeat(101)).codigo, 'TERMO_LONGO');
  assert.equal(prepararBusca('a b c d e f g h i').codigo, 'TERMO_LONGO');
  assert.equal(prepararBusca(123).codigo, 'TERMO_INVALIDO');
  assert.equal(prepararBusca(undefined).codigo, 'TERMO_INVALIDO');
  assert.equal(prepararBusca({ $ne: 1 }).codigo, 'TERMO_INVALIDO');
});

test('% _ e aspas no meio do texto são removidos antes de chegar ao banco', async () => {
  const db = criarDbFalso();
  const servico = criarServicoRuas({ db });
  const r = await buscar(servico, "get%_ulio' \"vargas");
  assert.equal(r.status, 200);
  assert.deepEqual(db.ultimaBuscaRuas.palavras, ['GET', 'ULIO', 'VARGAS']);
  for (const p of db.ultimaBuscaRuas.palavras) assert.match(p, /^[A-Z0-9]+$/);
});

// ---------------------------------------------------------------------------
// Busca e ordenação
// ---------------------------------------------------------------------------

test('acha sem digitar Rua/Avenida, sem acento e sem caixa', async () => {
  const servico = criarServicoRuas({ db: criarDbFalso() });
  const r = await buscar(servico, 'GETÚLIO vargas');
  assert.equal(r.status, 200);
  const ruas = r.corpo.sugestoes.map((s) => s.rua);
  assert.ok(ruas.includes('Rua Getulio Vargas'));
  assert.ok(ruas.includes('Avenida Getulio Vargas'));
});

test('uma opção por combinação rua + bairro (Getúlio Vargas em 4 bairros)', async () => {
  const servico = criarServicoRuas({ db: criarDbFalso() });
  const r = await buscar(servico, 'rua getulio vargas');
  const combos = r.corpo.sugestoes.map((s) => `${s.rua}|${s.bairro_exibicao}`);
  assert.equal(combos.length, 4);
  assert.equal(new Set(combos).size, 4);
});

test('não repete a mesma combinação se o banco devolver linha duplicada', async () => {
  const dup = [...RUAS, linha('Rua Chile', 'Bela Vista')];
  const servico = criarServicoRuas({ db: criarDbFalso({ ruas: dup }) });
  const r = await buscar(servico, 'chile');
  assert.equal(r.corpo.sugestoes.length, 2);
});

test('ordena: começa com o texto, depois início de palavra, depois o resto', async () => {
  const ruas = [
    linha('Rua Antonio Getulio', 'Centro'),
    linha('Rua Aragetulio', 'Centro'),
    linha('Getulio Teste', 'Centro')
  ];
  const servico = criarServicoRuas({ db: criarDbFalso({ ruas }) });
  const r = await buscar(servico, 'getulio');
  assert.deepEqual(r.corpo.sugestoes.map((s) => s.rua), [
    'Getulio Teste',
    'Rua Antonio Getulio',
    'Rua Aragetulio'
  ]);
});

test('devolve no máximo 12 sugestões', async () => {
  const muitas = Array.from({ length: 40 }, (_, i) => linha(`Rua Teste ${i}`, 'Centro'));
  const servico = criarServicoRuas({ db: criarDbFalso({ ruas: muitas }) });
  const r = await buscar(servico, 'teste');
  assert.equal(r.corpo.sugestoes.length, 12);
});

test('usa o código IBGE configurado na consulta', async () => {
  const db = criarDbFalso();
  await buscar(criarServicoRuas({ db }), 'chile');
  assert.equal(db.ultimaBuscaRuas.cidadeIbge, '3168606');
  const db2 = criarDbFalso();
  await buscar(criarServicoRuas({ db: db2, cidadeIbge: '3100000' }), 'chile');
  assert.equal(db2.ultimaBuscaRuas.cidadeIbge, '3100000');
});

// ---------------------------------------------------------------------------
// Quando preenche o bairro e quando NÃO preenche
// ---------------------------------------------------------------------------

test('Getúlio Vargas no Centro preenche Centro; Altamiro preenche Altamiro', async () => {
  const servico = criarServicoRuas({ db: criarDbFalso() });
  const r = await buscar(servico, 'rua getulio vargas');
  const centro = r.corpo.sugestoes.find((s) => s.bairro_exibicao === 'Centro' && s.rua === 'Rua Getulio Vargas');
  assert.deepEqual(centro, { rua: 'Rua Getulio Vargas', bairro_exibicao: 'Centro', bairro_id: 'b-centro', preenche: true });
  const altamiro = r.corpo.sugestoes.find((s) => s.bairro_id === 'b-altamiro');
  assert.equal(altamiro.bairro_exibicao, 'Altamiro Nunes Leite');
  assert.equal(altamiro.preenche, true);
});

test('bairro sem correspondência fica em branco e mostra o nome do IBGE', async () => {
  const servico = criarServicoRuas({ db: criarDbFalso() });
  const r = await buscar(servico, 'rua chile');
  assert.equal(r.corpo.sugestoes.length, 2);
  for (const s of r.corpo.sugestoes) {
    assert.equal(s.bairro_id, null);
    assert.equal(s.preenche, false);
  }
  assert.deepEqual(r.corpo.sugestoes.map((s) => s.bairro_exibicao).sort(), ['Bela Vista', 'Vila Betel']);
});

test('Martins Scofield: Vila Barreiros preenche; "Barreiros" fica em branco (nunca por sinônimo)', async () => {
  const servico = criarServicoRuas({ db: criarDbFalso() });
  const r = await buscar(servico, 'martins scofield');
  const vila = r.corpo.sugestoes.find((s) => s.bairro_exibicao === 'Vila Barreiros');
  const barreiros = r.corpo.sugestoes.find((s) => s.bairro_exibicao === 'Barreiros');
  assert.equal(vila.bairro_id, 'b-vila-barreiros');
  assert.equal(vila.preenche, true);
  assert.equal(barreiros.bairro_id, null);
  assert.equal(barreiros.preenche, false);
});

test('bairro inativo, sem taxa ou com nome repetido nunca vira bairro_id', async () => {
  const servico = criarServicoRuas({ db: criarDbFalso() });
  const r = await buscar(servico, 'sao joao');
  assert.equal(r.corpo.sugestoes.length, 3);
  for (const s of r.corpo.sugestoes) {
    assert.equal(s.bairro_id, null, `${s.bairro_exibicao} não deveria preencher`);
    assert.equal(s.preenche, false);
  }
});

test('bairro de outro restaurante nunca é usado (lista vem só do restaurante pedido)', () => {
  const indice = indexarBairrosDaLoja([{ id: 'x', nome: 'Centro', ativo: true, taxa: 5 }]);
  assert.equal(indice.get('CENTRO').id, 'x');
  assert.equal(indice.get('VILA BETEL'), undefined);
});

test('taxa 0 conta como preenchida; taxa vazia ou não numérica não', () => {
  const indice = indexarBairrosDaLoja([
    { id: 'a', nome: 'Gratis', ativo: true, taxa: 0 },
    { id: 'b', nome: 'Vazio', ativo: true, taxa: '' },
    { id: 'c', nome: 'Texto', ativo: true, taxa: 'abc' }
  ]);
  assert.equal(indice.get('GRATIS').id, 'a');
  assert.equal(indice.has('VAZIO'), false);
  assert.equal(indice.has('TEXTO'), false);
});

// ---------------------------------------------------------------------------
// Restaurante
// ---------------------------------------------------------------------------

test('restaurante inexistente, inativo ou id inválido', async () => {
  const servico = criarServicoRuas({
    db: criarDbFalso({ restaurantes: { [REST_ID]: { id: REST_ID, ativo: true }, [OUTRO_ID]: { id: OUTRO_ID, ativo: false } } })
  });
  assert.equal((await buscar(servico, 'chile', '99999999-9999-4999-8999-999999999999')).status, 404);
  assert.equal((await buscar(servico, 'chile', OUTRO_ID)).status, 404);
  assert.equal((await buscar(servico, 'chile', 'nao-e-uuid')).status, 400);
  assert.equal((await servico.buscar({ q: 'chile' })).status, 400);
  assert.equal((await buscar(servico, 'chile', { $ne: 1 })).status, 400);
});

test('cache de ~60 s: bairros são lidos uma vez e relidos depois do prazo', async () => {
  let t = 1_000;
  const db = criarDbFalso();
  const servico = criarServicoRuas({ db, agora: () => t, ttlMs: 60_000 });
  await buscar(servico, 'chile');
  await buscar(servico, 'getulio');
  assert.equal(db.chamadas.bairros, 1);
  assert.equal(db.chamadas.ruas, 2);
  t += 61_000;
  await buscar(servico, 'chile');
  assert.equal(db.chamadas.bairros, 2);
});

// ---------------------------------------------------------------------------
// A resposta nunca traz taxa
// ---------------------------------------------------------------------------

test('resposta sem taxa em nenhuma forma', async () => {
  const servico = criarServicoRuas({ db: criarDbFalso() });
  const r = await buscar(servico, 'getulio');
  const texto = JSON.stringify(r.corpo).toLowerCase();
  assert.ok(!texto.includes('taxa'));
  assert.ok(!texto.includes('8.5'));
  for (const s of r.corpo.sugestoes) {
    assert.deepEqual(Object.keys(s).sort(), ['bairro_exibicao', 'bairro_id', 'preenche', 'rua']);
  }
});

// ---------------------------------------------------------------------------
// Rota HTTP: 400 de JSON inválido, 429, erro do banco
// ---------------------------------------------------------------------------

async function subirApp({ db = criarDbFalso(), max = 60, log } = {}) {
  const app = express();
  const servico = criarServicoRuas({ db });
  app.post('/api/ruas/buscar', middlewaresBuscaRuas({
    servico,
    limitador: criarLimitadorDeRequisicoes({ janelaMs: 60_000, max }),
    parserJson: express.json({ limit: '2kb' }),
    log: log || { error() {} }
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/ruas/buscar`;
  const post = (corpo, cabecalhos = { 'Content-Type': 'application/json' }) =>
    fetch(url, { method: 'POST', headers: cabecalhos, body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });
  return { post, fechar: () => new Promise((r) => server.close(r)) };
}

test('rota: busca normal devolve 200 com sugestões', async () => {
  const app = await subirApp();
  try {
    const r = await app.post({ restaurante_id: REST_ID, q: 'chile' });
    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.equal(corpo.sucesso, true);
    assert.equal(corpo.sugestoes.length, 2);
  } finally { await app.fechar(); }
});

test('rota: JSON inválido devolve 400 (não 500)', async () => {
  const app = await subirApp();
  try {
    const r = await app.post('{ isto nao e json');
    assert.equal(r.status, 400);
    assert.equal((await r.json()).codigo, 'JSON_INVALIDO');
  } finally { await app.fechar(); }
});

test('rota: corpo vazio ou sem q devolve 400', async () => {
  const app = await subirApp();
  try {
    assert.equal((await app.post({})).status, 400);
    assert.equal((await app.post({ restaurante_id: REST_ID })).status, 400);
    assert.equal((await app.post({ restaurante_id: REST_ID, q: 'ab' })).status, 400);
  } finally { await app.fechar(); }
});

test('rota: corpo acima de 2 KB devolve 413', async () => {
  const app = await subirApp();
  try {
    const r = await app.post({ restaurante_id: REST_ID, q: 'a'.repeat(3000) });
    assert.equal(r.status, 413);
  } finally { await app.fechar(); }
});

test('rota: acima do limite devolve 429', async () => {
  const app = await subirApp({ max: 3 });
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await app.post({ restaurante_id: REST_ID, q: 'chile' })).status, 200);
    }
    const r = await app.post({ restaurante_id: REST_ID, q: 'chile' });
    assert.equal(r.status, 429);
  } finally { await app.fechar(); }
});

test('rota: falha do banco devolve 500 genérico, sem vazar a mensagem', async () => {
  const db = criarDbFalso();
  db.buscarRuas = async () => { throw new Error('cidade_ruas: senha secreta no erro'); };
  const registros = [];
  const app = await subirApp({ db, log: { error: (...a) => registros.push(a.join(' ')) } });
  try {
    const r = await app.post({ restaurante_id: REST_ID, q: 'chile' });
    assert.equal(r.status, 500);
    const texto = await r.text();
    assert.ok(!texto.includes('secreta'));
    assert.equal(JSON.parse(texto).codigo, 'ERRO_BUSCA');
    assert.equal(registros.length, 1);
  } finally { await app.fechar(); }
});
