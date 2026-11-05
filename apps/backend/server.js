import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import process from 'node:process';
import { supabaseAdmin } from './src/config/supabase.js';
import { 
  configurarFrete, 
  calcularFrete, 
  criarLimitadorDeRequisicoes, 
  FreteError 
} from './src/services/frete.js';
import { criarPedido } from './src/controllers/pedidosController.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// O Render fica atrás de um Reverse Proxy (necessário para ler o IP real no Rate Limiter)
app.set('trust proxy', 1);

// ==========================================
// 1. INICIALIZAÇÃO DO MOTOR DE FRETE
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

    if (error || !data) return null;
    return { id: data.id, nome: data.nome, taxa: data.taxa };
  }
});

// ==========================================
// 2. MIDDLEWARES DE SEGURANÇA E RATE LIMIT
// ==========================================

const origensValidas = [
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  'http://localhost:5173',
  'http://localhost:3000'
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    try {
      const urlOrigin = new URL(origin).origin;
      const permitida = origensValidas.some(o => {
        try { return new URL(o).origin === urlOrigin; } catch { return false; }
      });
      if (permitida) return callback(null, true);
    } catch {
      // URL malformada
    }
    return callback(new Error('Bloqueado pelas políticas de segurança CORS do SaaS.'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// Rate Limit em memória exportado pelo frete.js (30 requisições/min por IP)
const limitadorGeral = criarLimitadorDeRequisicoes({ janelaMs: 60_000, max: 30 });
app.use('/api/', limitadorGeral);

// ==========================================
// 3. ROTAS OPERACIONAIS
// ==========================================

// Health Check (Monitoramento de Uptime)
app.get('/health', (_req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    servico: 'Cardapio Delivery Backend SaaS',
    timestamp: new Date().toISOString() 
  });
});

// Endpoint Seguro de Cotação de Frete (Consome o frete.js)
app.post('/api/frete/cotar', async (req, res) => {
  try {
    const { restaurante_id, cliente_lat, cliente_lon, bairro_nome, bairro_id } = req.body || {};

    if (!restaurante_id || typeof restaurante_id !== 'string') {
      return res.status(400).json({ erro: 'ID do restaurante é obrigatório.' });
    }

    const { data: rest, error: restErro } = await supabaseAdmin
      .from('restaurantes')
      .select('id, ativo, taxa_base, valor_km, raio_max_km, loja_lat, loja_lon')
      .eq('id', restaurante_id)
      .maybeSingle();

    if (restErro) throw new Error(`Erro ao consultar restaurante: ${restErro.message}`);
    if (!rest || !rest.ativo) {
      return res.status(404).json({ erro: 'Restaurante inativo ou não localizado.' });
    }

    let nomeBairro = bairro_nome || null;
    if (bairro_id && !nomeBairro) {
      const { data: bData } = await supabaseAdmin
        .from('bairros')
        .select('nome')
        .eq('id', bairro_id)
        .eq('restaurante_id', rest.id)
        .maybeSingle();
      if (bData) nomeBairro = bData.nome;
    }

    const resultadoFrete = await calcularFrete({
      restaurante: rest,
      destino: (cliente_lat !== undefined && cliente_lon !== undefined)
        ? { lat: cliente_lat, lon: cliente_lon }
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

    console.error('[ERRO COTAÇÃO FRETE]:', error.message);
    return res.status(500).json({ erro: 'Não foi possível cotar o frete no momento.' });
  }
});

// Endpoint Seguro de Criação de Pedidos (Zero-Trust)
app.post('/api/pedidos', criarPedido);

// Rota 404 para URLs não encontradas
app.use((_req, res) => {
  res.status(404).json({ erro: 'Recurso não encontrado no servidor.' });
});

// ==========================================
// 4. INICIALIZAÇÃO GRACIOSA DO SERVIDOR
// ==========================================

const server = app.listen(PORT, () => {
  console.log(`🚀 [Sonnet-G Engine] Servidor SaaS operacional na porta ${PORT}`);
});

function fecharServidor(sinal) {
  console.log(`\nRecebido ${sinal}. Encerrando o servidor graciosamente...`);
  server.close(() => {
    console.log('Servidor HTTP encerrado com sucesso.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => fecharServidor('SIGTERM'));
process.on('SIGINT', () => fecharServidor('SIGINT'));
