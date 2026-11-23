  
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-falsa-de-teste';

const { criarControladorPedidos } = await import(
  '../src/controllers/pedidosController.js'
);

const REST_ID = 'rest-1';
const CHAVE = 'a1234567-b123-4123-8123-a12345678901';

function criarBancoFalso() {
  const tabelas = {
    pedidos: [],
    restaurantes: [
      {
        id: REST_ID,
        nome: 'Imperial',
        ativo: true,
        loja_lat: -17.9,
        loja_lon: -41.5,
        taxa_base: 4,
        valor_km: 1,
        raio_max_km: 12,
        frete_por_distancia: false
      }
    ],
    produtos: [
      {
        id: 'produto-1',
        nome: 'Pastel',
        preco: 10,
        preco_promocional: null,
        disponivel: true,
        restaurante_id: REST_ID
      }
    ],
    bairros: [
      {
        id: 'bairro-1',
        nome: 'Centro',
        taxa: 8,
        restaurante_id: REST_ID,
        ativo: true
      }
    ]
  };

  const inseridos = [];
  const chamadas = [];

  function from(nomeTabela) {
    const filtros = [];
    let linhasInsert = null;
    let colunasSelect = '';

    const builder = {
      select(colunas) {
        colunasSelect = colunas;
        return builder;
      },

      eq(coluna, valor) {
        filtros.push(linha => linha[coluna] === valor);
        return builder;
      },

      in(coluna, valores) {
        filtros.push(linha => valores.includes(linha[coluna]));
        return builder;
      },

      insert(linhas) {
        linhasInsert = linhas;
        return builder;
      },

      filtrar() {
        return (tabelas[nomeTabela] || []).filter(
          linha => filtros.every(filtro => filtro(linha))
        );
      },

      async maybeSingle() {
        chamadas.push({
          tabela: nomeTabela,
          operacao: 'maybeSingle'
        });

        return {
          data: builder.filtrar()[0] || null,
          error: null
        };
      },

      async single() {
        if (linhasInsert) {
          const linha = {
            ...linhasInsert[0],
            id: `pedido-${inseridos.length + 1}`,
            created_at: '2026-11-23T12:00:00Z'
          };

          tabelas[nomeTabela].push(linha);
          inseridos.push(linha);

          chamadas.push({
            tabela: nomeTabela,
            operacao: 'insert'
          });

          const campos = colunasSelect
            .split(',')
            .map(campo => campo.trim())
            .filter(Boolean);

          const data = {};

          for (const campo of campos) {
            data[campo] = linha[campo];
          }

          return { data, error: null };
        }

        return {
          data: builder.filtrar()[0] || null,
          error: null
        };
      },

      then(resolve, reject) {
        return Promise.resolve({
          data: builder.filtrar(),
          error: null
        }).then(resolve, reject);
      }
    };

    return builder;
  }

  const rpcChamadas = [];

  return {
    from,
    inseridos,
    chamadas,
    tabelas,
    rpcChamadas,

    async rpc(nome, parametros) {
      rpcChamadas.push({ nome, parametros });
      return { data: null, error: null };
    }
  };
}

function respostaFalsa() {
  return {
    statusCode: 200,
    body: null,

    status(codigo) {
      this.statusCode = codigo;
      return this;
    },

    json(corpo) {
      this.body = corpo;
      return this;
    }
  };
}

function corpoPedido(extra = {}) {
  return {
    restaurante_id: REST_ID,
    chave_idempotencia: CHAVE,
    cliente_nome: 'Maria Silva',
    cliente_whatsapp: '33999991234',
    endereco_completo: 'Rua das Flores, 100',
    bairro_id: 'bairro-1',
    itens: [
      {
        produto_id: 'produto-1',
        quantidade: 2
      }
    ],
    forma_pagamento: 'pix',
    ...extra
  };
}

function criarFrete(taxa = 8) {
  const chamadas = [];

  const fn = async dados => {
    chamadas.push(dados);

    return {
      taxa,
      frete_tipo: 'bairro',
      distancia_km: null,
      requer_confirmacao: false
    };
  };

  fn.chamadas = chamadas;

  return fn;
}

async function enviar(db, corpo, frete = criarFrete()) {
  const { criarPedido } = criarControladorPedidos({
    db,
    calcularFreteFn: frete
  });

  const res = respostaFalsa();

  await criarPedido({ body: corpo }, res);

  return { res, frete };
}

test('primeiro envio grava o pedido com chave e hash', async () => {
  const db = criarBancoFalso();

  const { res } = await enviar(db, corpoPedido());

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.sucesso, true);
  assert.equal(res.body.reutilizado, undefined);

  assert.equal(db.inseridos.length, 1);

  const pedido = db.inseridos[0];

  assert.equal(pedido.chave_idempotencia, CHAVE);
  assert.match(pedido.idempotencia_hash, /^[0-9a-f]{64}$/);
  assert.equal(pedido.total, 28);
});

test('repetição idêntica recupera o pedido original sem inserir outro', async () => {
  const db = criarBancoFalso();

  const primeira = await enviar(db, corpoPedido());

  const segunda = await enviar(db, corpoPedido());

  assert.equal(primeira.res.statusCode, 201);
  assert.equal(segunda.res.statusCode, 200);

  assert.equal(segunda.res.body.reutilizado, true);
  assert.equal(
    segunda.res.body.pedido.id,
    primeira.res.body.pedido.id
  );

  assert.equal(db.inseridos.length, 1);
});

test('mesma chave com conteúdo diferente retorna conflito 409', async () => {
  const db = criarBancoFalso();

  await enviar(db, corpoPedido());

  const segunda = await enviar(
    db,
    corpoPedido({
      cliente_nome: 'Outro Cliente'
    })
  );

  assert.equal(segunda.res.statusCode, 409);
  assert.equal(
    segunda.res.body.codigo,
    'IDEMPOTENCIA_CONFLITO'
  );

  assert.equal(db.inseridos.length, 1);
});

test('repetição não recalcula frete nem depende do preço atual', async () => {
  const db = criarBancoFalso();

  const fretePrimeiro = criarFrete(8);

  const primeira = await enviar(
    db,
    corpoPedido(),
    fretePrimeiro
  );

  assert.equal(primeira.res.statusCode, 201);
  assert.equal(fretePrimeiro.chamadas.length, 1);

  // O produto muda de preço depois da primeira gravação.
  db.tabelas.produtos[0].preco = 99;

  const freteSegundo = criarFrete(15);

  const segunda = await enviar(
    db,
    corpoPedido(),
    freteSegundo
  );

  assert.equal(segunda.res.statusCode, 200);
  assert.equal(segunda.res.body.reutilizado, true);

  assert.equal(segunda.res.body.pedido.total, 28);
  assert.equal(freteSegundo.chamadas.length, 0);
  assert.equal(db.inseridos.length, 1);
});

test('chave inválida é recusada antes de gravar', async () => {
  const db = criarBancoFalso();

  const { res } = await enviar(
    db,
    corpoPedido({
      chave_idempotencia: 'chave-invalida'
    })
  );

  assert.equal(res.statusCode, 400);
  assert.equal(
    res.body.codigo,
    'CHAVE_IDEMPOTENCIA_INVALIDA'
  );

  assert.equal(db.inseridos.length, 0);
});

test('pedido sem chave continua funcionando no fluxo antigo', async () => {
  const db = criarBancoFalso();

  const corpo = corpoPedido();
  delete corpo.chave_idempotencia;

  const { res } = await enviar(db, corpo);

  assert.equal(res.statusCode, 201);
  assert.equal(db.inseridos.length, 1);

  assert.equal(
    db.inseridos[0].chave_idempotencia,
    undefined
  );

  assert.equal(
    db.inseridos[0].idempotencia_hash,
    undefined
  );
});

test('taxa cotada diferente da taxa calculada continua exigindo confirmação', async () => {
  const db = criarBancoFalso();

  const { res } = await enviar(
    db,
    corpoPedido({ taxa_cotada: 5 }),
    criarFrete(8)
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.codigo, 'FRETE_DIVERGENTE');
  assert.equal(db.inseridos.length, 0);
});
