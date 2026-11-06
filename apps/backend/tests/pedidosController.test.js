// apps/backend/tests/pedidosController.test.js
// Rodar: cd apps/backend && npm test   (node --test, Node 18+)
// Não usa o Supabase real: o banco é simulado em memória.

import test from 'node:test';
import assert from 'node:assert/strict';

// O módulo do Supabase cria o cliente ao ser importado, então as variáveis
// precisam existir ANTES do import. Valores falsos, só para não dar erro.
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-falsa-de-teste';

const { criarControladorPedidos } = await import('../src/controllers/pedidosController.js');
const { FreteError } = await import('../src/services/frete.js');

// ---- banco falso -----------------------------------------------------------

function criarBancoFalso(tabelas) {
  const inseridos = [];

  function from(nomeTabela) {
    const filtros = [];
    let modoInsert = null;

    const builder = {
      select() { return builder; },
      eq(coluna, valor) { filtros.push((l) => l[coluna] === valor); return builder; },
      in(coluna, valores) { filtros.push((l) => valores.includes(l[coluna])); return builder; },
      insert(linhas) { modoInsert = linhas; return builder; },
      _linhas() { return (tabelas[nomeTabela] || []).filter((l) => filtros.every((f) => f(l))); },
      async maybeSingle() { return { data: builder._linhas()[0] || null, error: null }; },
      async single() {
        if (modoInsert) {
          const linha = modoInsert[0];
          inseridos.push(linha);
          return {
            data: { id: 'pedido-123', total: linha.total, status: linha.status, created_at: '2026-11-05T12:00:00Z' },
            error: null,
          };
        }
        return { data: builder._linhas()[0] || null, error: null };
      },
      then(resolve, reject) {
        return Promise.resolve({ data: builder._linhas(), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  return { from, inseridos };
}

function resFalso() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// ---- dados de exemplo ------------------------------------------------------

const REST_ID = 'rest-1';
const OUTRO_REST_ID = 'rest-2';

function tabelasPadrao() {
  return {
    restaurantes: [
      { id: REST_ID, nome: 'Imperial', ativo: true, loja_lat: -17.9, loja_lon: -41.5, taxa_base: 4, valor_km: 1, raio_max_km: 12 },
      { id: OUTRO_REST_ID, nome: 'Fechado', ativo: false, loja_lat: -17.9, loja_lon: -41.5, taxa_base: 4, valor_km: 1, raio_max_km: 12 },
    ],
    produtos: [
      { id: 'p-pastel', nome: 'Pastel de Carne', preco: 10.5, disponivel: true, restaurante_id: REST_ID },
      { id: 'p-batata', nome: 'Batata Frita', preco: 12, disponivel: true, restaurante_id: REST_ID },
      { id: 'p-acabou', nome: 'Pastel de Camarão', preco: 20, disponivel: false, restaurante_id: REST_ID },
      { id: 'p-alheio', nome: 'Produto de Outro', preco: 5, disponivel: true, restaurante_id: OUTRO_REST_ID },
    ],
    bairros: [
      { id: 'b-centro', nome: 'Centro', taxa: 8, restaurante_id: REST_ID, ativo: true },
      { id: 'b-off', nome: 'Bairro Desativado', taxa: 9, restaurante_id: REST_ID, ativo: false },
      { id: 'b-alheio', nome: 'Bairro de Outro', taxa: 7, restaurante_id: OUTRO_REST_ID, ativo: true },
    ],
  };
}

function pedidoValido(extra = {}) {
  return {
    restaurante_id: REST_ID,
    cliente_nome: 'Maria Silva',
    cliente_whatsapp: '(33) 99999-1234',
    endereco_completo: 'Rua das Flores, 100',
    bairro_id: 'b-centro',
    itens: [{ produto_id: 'p-pastel', quantidade: 2 }],
    forma_pagamento: 'pix',
    ...extra,
  };
}

// Frete falso: devolve a taxa do bairro, como o motor real faria
function freteFalso(taxa = 8, tipo = 'bairro') {
  const chamadas = [];
  const fn = async (args) => {
    chamadas.push(args);
    return { taxa, frete_tipo: tipo, distancia_km: null, requer_confirmacao: false };
  };
  fn.chamadas = chamadas;
  return fn;
}

async function enviar(corpo, { tabelas = tabelasPadrao(), frete = freteFalso() } = {}) {
  const db = criarBancoFalso(tabelas);
  const { criarPedido } = criarControladorPedidos({ db, calcularFreteFn: frete });
  const res = resFalso();
  await criarPedido({ body: corpo }, res);
  return { res, db, frete };
}

// ---- testes: caminho feliz -------------------------------------------------

test('pedido válido: grava com preço do BANCO, total certo e status pendente_pagamento', async () => {
  const { res, db } = await enviar(pedidoValido());

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.sucesso, true);
  assert.equal(db.inseridos.length, 1);

  const gravado = db.inseridos[0];
  assert.equal(gravado.subtotal, 21);       // 2 x 10,50
  assert.equal(gravado.taxa_entrega, 8);
  assert.equal(gravado.total, 29);
  assert.equal(gravado.status, 'pendente_pagamento');
  assert.equal(gravado.restaurante_id, REST_ID);
  assert.equal(gravado.bairro_id, 'b-centro');
  assert.equal(gravado.frete_tipo, 'bairro');
});

test('itens gravados no formato que o painel lê (qtd, nome, preco)', async () => {
  const { db } = await enviar(pedidoValido({ itens: [{ produto_id: 'p-pastel', quantidade: 3 }] }));
  const item = db.inseridos[0].itens[0];

  assert.equal(item.qtd, 3);
  assert.equal(item.quantidade, 3);
  assert.equal(item.nome, 'Pastel de Carne');
  assert.equal(item.preco, 10.5);
  assert.equal(item.subtotal, 31.5);
  assert.equal(item.id, 'p-pastel');
});

test('telefone é gravado só com dígitos', async () => {
  const { db } = await enviar(pedidoValido({ cliente_whatsapp: '(33) 99999-1234' }));
  assert.equal(db.inseridos[0].cliente_whatsapp, '33999991234');
});

test('aceita os nomes antigos do frontend (id e qtd)', async () => {
  const { res, db } = await enviar(pedidoValido({ itens: [{ id: 'p-batata', qtd: 1 }] }));
  assert.equal(res.statusCode, 201);
  assert.equal(db.inseridos[0].subtotal, 12);
});

test('soma de vários itens sem erro de centavos (10,50 + 12 + 12)', async () => {
  const { db } = await enviar(pedidoValido({
    itens: [{ produto_id: 'p-pastel', quantidade: 1 }, { produto_id: 'p-batata', quantidade: 2 }],
  }));
  assert.equal(db.inseridos[0].subtotal, 34.5);
  assert.equal(db.inseridos[0].total, 42.5);
});

// ---- testes: segurança (nunca confiar no cliente) --------------------------

test('preço e total enviados pelo cliente são IGNORADOS', async () => {
  const { res, db } = await enviar(pedidoValido({
    subtotal: 0.01,
    total: 0.01,
    taxa_entrega: 0,
    itens: [{ produto_id: 'p-pastel', quantidade: 1, preco: 0.01, preco_unitario: 0.01 }],
  }));
  assert.equal(res.statusCode, 201);
  assert.equal(db.inseridos[0].itens[0].preco, 10.5);
  assert.equal(db.inseridos[0].total, 18.5); // 10,50 + taxa 8 do motor de frete
});

test('taxa vem do motor de frete, não do corpo da requisição', async () => {
  const frete = freteFalso(15, 'rota_mapbox');
  const { db } = await enviar(pedidoValido({ taxa_entrega: 1 }), { frete });
  assert.equal(db.inseridos[0].taxa_entrega, 15);
  assert.equal(db.inseridos[0].frete_tipo, 'rota_mapbox');
});

test('produto de OUTRO restaurante é recusado (422)', async () => {
  const { res, db } = await enviar(pedidoValido({ itens: [{ produto_id: 'p-alheio', quantidade: 1 }] }));
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.codigo, 'PRODUTO_INVALIDO');
  assert.equal(db.inseridos.length, 0);
});

test('produto indisponível é recusado (422)', async () => {
  const { res, db } = await enviar(pedidoValido({ itens: [{ produto_id: 'p-acabou', quantidade: 1 }] }));
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.codigo, 'PRODUTO_INDISPONIVEL');
  assert.equal(db.inseridos.length, 0);
});

test('produto que não existe é recusado', async () => {
  const { res } = await enviar(pedidoValido({ itens: [{ produto_id: 'inventado', quantidade: 1 }] }));
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.codigo, 'PRODUTO_INVALIDO');
});

test('bairro de outro restaurante é recusado', async () => {
  const { res, db } = await enviar(pedidoValido({ bairro_id: 'b-alheio' }));
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.codigo, 'BAIRRO_INVALIDO');
  assert.equal(db.inseridos.length, 0);
});

test('bairro desativado é recusado', async () => {
  const { res } = await enviar(pedidoValido({ bairro_id: 'b-off' }));
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.codigo, 'BAIRRO_INVALIDO');
});

test('restaurante inexistente: 404', async () => {
  const { res } = await enviar(pedidoValido({ restaurante_id: 'nao-existe' }));
  assert.equal(res.statusCode, 404);
});

test('restaurante inativo: 422', async () => {
  const { res, db } = await enviar(pedidoValido({
    restaurante_id: OUTRO_REST_ID,
    itens: [{ produto_id: 'p-alheio', quantidade: 1 }],
    bairro_id: 'b-alheio',
  }));
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.codigo, 'RESTAURANTE_INATIVO');
  assert.equal(db.inseridos.length, 0);
});

// ---- testes: validação de entrada ------------------------------------------

const casosInvalidos = [
  ['nome curto demais', { cliente_nome: 'A' }, 'NOME_INVALIDO'],
  ['WhatsApp curto demais', { cliente_whatsapp: '123' }, 'WHATSAPP_INVALIDO'],
  ['endereço curto demais', { endereco_completo: 'Rua' }, 'ENDERECO_INVALIDO'],
  ['carrinho vazio', { itens: [] }, 'CARRINHO_INVALIDO'],
  ['mais de 30 itens', { itens: Array.from({ length: 31 }, () => ({ produto_id: 'p-pastel', quantidade: 1 })) }, 'CARRINHO_INVALIDO'],
  ['quantidade zero', { itens: [{ produto_id: 'p-pastel', quantidade: 0 }] }, 'QUANTIDADE_INVALIDA'],
  ['quantidade negativa', { itens: [{ produto_id: 'p-pastel', quantidade: -2 }] }, 'QUANTIDADE_INVALIDA'],
  ['quantidade fracionada', { itens: [{ produto_id: 'p-pastel', quantidade: 1.5 }] }, 'QUANTIDADE_INVALIDA'],
  ['quantidade acima do limite', { itens: [{ produto_id: 'p-pastel', quantidade: 51 }] }, 'QUANTIDADE_INVALIDA'],
  ['sem bairro e sem coordenadas', { bairro_id: undefined }, 'LOCALIZACAO_OBRIGATORIA'],
  ['coordenadas inválidas', { cliente_lat: 999, cliente_lon: 10 }, 'COORDENADAS_INVALIDAS'],
  ['troco menor que o total', { forma_pagamento: 'dinheiro', troco_para: 5 }, 'TROCO_INVALIDO'],
  ['forma de pagamento desconhecida', { forma_pagamento: 'bitcoin' }, 'PAGAMENTO_INVALIDO'],
];

for (const [descricao, alteracao, codigoEsperado] of casosInvalidos) {
  test(`recusa (400): ${descricao}`, async () => {
    const { res, db } = await enviar(pedidoValido(alteracao));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.codigo, codigoEsperado);
    assert.equal(db.inseridos.length, 0);
  });
}

test('troco maior que o total é aceito e gravado (dinheiro)', async () => {
  const { res, db } = await enviar(pedidoValido({ forma_pagamento: 'dinheiro', troco_para: 50 }));
  assert.equal(res.statusCode, 201);
  assert.equal(db.inseridos[0].forma_pagamento, 'dinheiro');
  assert.equal(db.inseridos[0].troco_para, 50);
});

test('cartão e pix ignoram o troco enviado', async () => {
  for (const forma of ['cartao', 'pix']) {
    const { res, db } = await enviar(pedidoValido({ forma_pagamento: forma, troco_para: 50 }));
    assert.equal(res.statusCode, 201);
    assert.equal(db.inseridos[0].forma_pagamento, forma);
    assert.equal(db.inseridos[0].troco_para, null);
  }
});

test('sem forma de pagamento informada, o padrão continua sendo pix', async () => {
  const { res, db } = await enviar(pedidoValido({ forma_pagamento: undefined }));
  assert.equal(res.statusCode, 201);
  assert.equal(db.inseridos[0].forma_pagamento, 'pix');
});

// ---- testes: frete e falhas ------------------------------------------------

test('erro do motor de frete (fora da área) vira resposta com código e nada é gravado', async () => {
  const frete = async () => { throw new FreteError('FORA_DA_AREA', 'Endereço fora da área de entrega.', 422); };
  const { res, db } = await enviar(pedidoValido(), { frete });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.codigo, 'FORA_DA_AREA');
  assert.equal(db.inseridos.length, 0);
});

test('o motor de frete recebe o NOME do bairro vindo do banco', async () => {
  const frete = freteFalso();
  await enviar(pedidoValido({ bairro_nome: 'Texto Falso Do Cliente' }), { frete });
  assert.equal(frete.chamadas[0].bairro, 'Centro');
});

test('com coordenadas válidas, elas seguem para o motor de frete', async () => {
  const frete = freteFalso(9, 'rota_mapbox');
  const { res } = await enviar(
    pedidoValido({ bairro_id: undefined, cliente_lat: -17.88, cliente_lon: -41.51 }),
    { frete },
  );
  assert.equal(res.statusCode, 201);
  assert.deepEqual(frete.chamadas[0].destino, { lat: -17.88, lon: -41.51 });
});

test('falha inesperada vira 500 genérico, sem vazar detalhes', async () => {
  const frete = async () => { throw new Error('senha do banco: 12345'); };
  const { res } = await enviar(pedidoValido(), { frete });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.codigo, 'ERRO_INTERNO');
  assert.ok(!JSON.stringify(res.body).includes('12345'));
});

test('corpo vazio não derruba o servidor', async () => {
  const db = criarBancoFalso(tabelasPadrao());
  const { criarPedido } = criarControladorPedidos({ db, calcularFreteFn: freteFalso() });
  const res = resFalso();
  await criarPedido({}, res);
  assert.equal(res.statusCode, 400);
});
