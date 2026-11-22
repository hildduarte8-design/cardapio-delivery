import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import process from 'node:process';

import { supabaseAdmin } from './src/config/supabase.js';

import {
  configurarFrete,
  calcularFrete,
  criarLimitadorDeRequisicoes,
  FreteError
} from './src/services/frete.js';

import { criarPedido } from './src/controllers/pedidosController.js';
import { criarPedidoManual } from './src/controllers/pedidosManualController.js';
import { avisarPagamento } from './src/controllers/pedidosAvisoController.js';
import { statusPedido } from './src/controllers/pedidosStatusController.js';
import { iniciarPushLojista } from './src/services/pushLojista.js';
import { criarServicoGeocodificacao } from './src/services/geocodificacao.js';
import {
  criarServicoRuas,
  criarDbRuas,
  middlewaresBuscaRuas,
  CIDADE_IBGE_PADRAO
} from './src/services/ruas.js';

// ==========================================
// 1. CONFIGURAÇÃO INICIAL
// ==========================================

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.disable('x-powered-by');

// ==========================================
// 2. CONFIGURAÇÃO DE CORS
// ==========================================

// Domínios autorizados a acessar o backend.
// Não liberamos todos os subdomínios da Vercel.

function normalizarOrigem(origem) {
  if (!origem) return null;

  try {
    const valor = origem.startsWith('http')
      ? origem
      : `https://${origem}`;

    return new URL(valor).origin;
  } catch {
    return null;
  }
}

const origensConfiguradas = [
  ...(process.env.FRONTEND_URL || '').split(','),
  ...(process.env.VERCEL_URL || '').split(','),
  'https://cardapio-delivery-beta.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000'
];

const origensPermitidas = [
  ...new Set(
    origensConfiguradas
      .map(origem => normalizarOrigem(origem.trim()))
      .filter(Boolean)
  )
];

console.log('[CORS] Origens autorizadas:', origensPermitidas);

const corsOptions = {
  origin: (origin, callback) => {

    // Permite chamadas sem Origin, como algumas chamadas
    // internas ou server-to-server.

    if (!origin) {
      return callback(null, true);
    }

    const origemNormalizada = normalizarOrigem(origin);

    if (origensPermitidas.includes(origemNormalizada)) {
      return callback(null, true);
    }

    console.warn('[CORS] Origem bloqueada:', origin);

    return callback(new Error('Origem não autorizada pelo CORS.'));
  },

  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],

  allowedHeaders: [
    'Content-Type',
    'Authorization'
  ],

  maxAge: 86400,
  optionsSuccessStatus: 204
};

// O CORS precisa vir antes das rotas e do rate limit.
// O middleware também responde automaticamente ao preflight OPTIONS.

app.use(cors(corsOptions));

// ==========================================
// 2B. BUSCA DE RUAS (autocomplete do endereço)
// ==========================================

// Fica ANTES do express.json global e do limitador geral (30/min) de propósito:
// o autocomplete faz várias buscas por minuto e tem limitador, leitor de JSON
// (limite de 2 KB) e tratamento de JSON inválido (400) próprios.
// O código IBGE da cidade vem da variável CIDADE_IBGE (padrão: Teófilo Otoni).

const cidadeIbgeRuas = /^\d{7}$/.test(process.env.CIDADE_IBGE || '')
  ? process.env.CIDADE_IBGE
  : CIDADE_IBGE_PADRAO;

const servicoRuas = criarServicoRuas({
  db: criarDbRuas(supabaseAdmin),
  cidadeIbge: cidadeIbgeRuas
});

const limitadorBuscaRuas = criarLimitadorDeRequisicoes({
  janelaMs: 60_000,
  max: 60
});

app.post(
  '/api/ruas/buscar',
  middlewaresBuscaRuas({
    servico: servicoRuas,
    limitador: limitadorBuscaRuas,
    parserJson: express.json({ limit: '2kb' })
  })
);

// ==========================================
// 3. MIDDLEWARES GERAIS
// ==========================================

app.use(express.json({
  limit: '10kb'
}));

// Limitador geral: 30 requisições por minuto por IP.

const limitadorGeral = criarLimitadorDeRequisicoes({
  janelaMs: 60_000,
  max: 30
});

app.use('/api/', limitadorGeral);

// ==========================================
// 4. INICIALIZAÇÃO DO MOTOR DE FRETE
// ==========================================

configurarFrete({

  buscarTaxaBairro: async ({ restauranteId, bairro }) => {

    const { data, error } = await supabaseAdmin
      .from('bairros')
      .select('id, nome, taxa')
      .eq('restaurante_id', restauranteId)
      .ilike('nome', bairro.trim())
      .eq('ativo', true)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      nome: data.nome,
      taxa: data.taxa
    };
  }

});

// ==========================================
// 5. HEALTH CHECK
// ==========================================

app.get('/health', (_req, res) => {

  return res.status(200).json({
    status: 'OK',
    servico: 'Cardapio Delivery Backend SaaS',
    timestamp: new Date().toISOString()
  });

});

// ==========================================
// 5B. GEOCODIFICAÇÃO REVERSA (confirmação do local)
// ==========================================

const geocodificacao = criarServicoGeocodificacao({
  token: process.env.MAPBOX_TOKEN,
  log: console
});

const limitadorGeocodificacao = criarLimitadorDeRequisicoes({
  janelaMs: 60_000,
  max: 10
});

app.post('/api/geocodificacao/reverso', limitadorGeocodificacao, async (req, res) => {
  const { lat, lon } = req.body || {};
  const la = Number(lat);
  const lo = Number(lon);

  if (
    lat == null || lon == null ||
    !Number.isFinite(la) || !Number.isFinite(lo) ||
    Math.abs(la) > 90 || Math.abs(lo) > 180
  ) {
    return res.status(400).json({ sucesso: false, codigo: 'COORDENADAS_INVALIDAS' });
  }

  const lugar = await geocodificacao.reverso(la, lo);

  if (!lugar) {
    return res.json({ sucesso: false, codigo: 'SEM_NOME' });
  }

  return res.json({
    sucesso: true,
    rua: lugar.rua,
    bairro: lugar.bairro,
    cidade: lugar.cidade
  });
});

// ==========================================
// 6. COTAÇÃO DE FRETE
// ==========================================

const limitadorCotacaoFrete = criarLimitadorDeRequisicoes({
  janelaMs: 60_000,
  max: 20
});

app.post('/api/frete/cotar', limitadorCotacaoFrete, async (req, res) => {

  try {

    const {
      restaurante_id,
      cliente_lat,
      cliente_lon,
      bairro_nome,
      bairro_id
    } = req.body || {};

    if (
      !restaurante_id ||
      typeof restaurante_id !== 'string'
    ) {
      return res.status(400).json({
        erro: 'ID do restaurante é obrigatório.'
      });
    }

    const { data: rest, error: restErro } = await supabaseAdmin
      .from('restaurantes')
      .select(
        'id, ativo, taxa_base, valor_km, raio_max_km, loja_lat, loja_lon, frete_por_distancia'
      )
      .eq('id', restaurante_id)
      .maybeSingle();

    if (restErro) {
      throw new Error(
        `Erro ao consultar restaurante: ${restErro.message}`
      );
    }

    if (!rest || !rest.ativo) {
      return res.status(404).json({
        erro: 'Restaurante inativo ou não localizado.'
      });
    }

    let nomeBairro = bairro_nome || null;

    if (bairro_id && !nomeBairro) {

      const { data: bData } = await supabaseAdmin
        .from('bairros')
        .select('nome')
        .eq('id', bairro_id)
        .eq('restaurante_id', rest.id)
        .maybeSingle();

      if (bData) {
        nomeBairro = bData.nome;
      }

    }

    const usarRota = rest.frete_por_distancia === true;

    const resultadoFrete = await calcularFrete({

      restaurante: rest,

      destino:
        usarRota &&
        cliente_lat !== undefined &&
        cliente_lon !== undefined
          ? {
              lat: cliente_lat,
              lon: cliente_lon
            }
          : null,

      bairro: nomeBairro

    });

    return res.status(200).json({

      sucesso: true,
      tipo: resultadoFrete.frete_tipo,
      taxa: resultadoFrete.taxa,
      taxa_centavos: resultadoFrete.taxa_centavos,
      distancia_km: resultadoFrete.distancia_km,
      estimado: resultadoFrete.estimado,
      requer_confirmacao: resultadoFrete.requer_confirmacao,
      bairro: resultadoFrete.bairro,
      cache: resultadoFrete.cache

    });

  } catch (error) {

    if (error instanceof FreteError) {

      return res.status(error.status).json({
        erro: error.message,
        codigo: error.code,
        detalhes: error.detalhes
      });

    }

    console.error(
      '[ERRO COTAÇÃO FRETE]:',
      error.message
    );

    return res.status(500).json({
      erro: 'Não foi possível cotar o frete no momento.'
    });

  }

});

// ==========================================
// 7. CRIAÇÃO DE PEDIDOS
// ==========================================

// Pedido do cliente pelo cardápio público (sem autenticação).
app.post('/api/pedidos', criarPedido);

// Pedido manual lançado pelo lojista no painel (requer token JWT).
app.post('/api/pedidos/manual', criarPedidoManual);

// Cliente avisa que pagou o Pix (sem login; limite próprio: 10 tentativas a cada 5 min por IP).
const limitadorAvisoPagamento = criarLimitadorDeRequisicoes({
  janelaMs: 300_000,
  max: 10
});

app.post('/api/pedidos/:id/avisar-pagamento', limitadorAvisoPagamento, avisarPagamento);

// Acompanhamento do pedido pelo cliente (só leitura do andamento; limite: 20 consultas por minuto por IP).
const limitadorStatusPedido = criarLimitadorDeRequisicoes({
  janelaMs: 60_000,
  max: 20
});

app.get('/api/pedidos/:id/status', limitadorStatusPedido, statusPedido);

// ==========================================
// 8. ROTA NÃO ENCONTRADA
// ==========================================

app.use((_req, res) => {

  return res.status(404).json({
    erro: 'Recurso não encontrado no servidor.'
  });

});

// ==========================================
// 9. TRATAMENTO GLOBAL DE ERROS
// ==========================================

app.use((error, _req, res, _next) => {

  console.error('[ERRO BACKEND]:', error.message);

  if (error.message === 'Origem não autorizada pelo CORS.') {

    return res.status(403).json({
      erro: 'Origem não autorizada.'
    });

  }

  return res.status(500).json({
    erro: 'Erro interno do servidor.'
  });

});

// ==========================================
// 10. INICIALIZAÇÃO DO SERVIDOR
// ==========================================

// Avisos push para o lojista (ficam desativados se faltarem as variáveis VAPID_* na Render)
iniciarPushLojista();

const server = app.listen(PORT, () => {

  console.log(
    `Backend Cardapio Delivery operacional na porta ${PORT}`
  );

});

function fecharServidor(sinal) {

  console.log(
    `Recebido ${sinal}. Encerrando servidor...`
  );

  server.close(() => {

    console.log(
      'Servidor HTTP encerrado com sucesso.'
    );

    process.exit(0);

  });

}

process.on('SIGTERM', () => fecharServidor('SIGTERM'));
process.on('SIGINT', () => fecharServidor('SIGINT'));
