import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import process from 'node:process';
import { supabaseAdmin } from './src/config/supabase.js';
import { calcularDistanciaKm } from './src/services/frete.js';
import { criarPedido } from './src/controllers/pedidosController.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. MIDDLEWARES DE SEGURANÇA E PARSER
// ==========================================

// Configuração estrita de CORS para evitar abusos externos
const origensPermitidas = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Permite requisições sem origin (como apps mobile/PWA nativos ou ferramentas de dev)
    if (!origin || origensPermitidas.some(o => origin.startsWith(o))) {
      return callback(null, true);
    }
    return callback(new Error('Bloqueado pelas políticas de CORS do SaaS.'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Desativa o cabeçalho X-Powered-By por questões de segurança
app.disable('x-powered-by');

// Limite rigoroso de tamanho do payload para evitar ataques de estouro de memória
app.use(express.json({ limit: '10kb' }));

// ==========================================
// 2. HELPER DE VALIDAÇÃO E SANITIZAÇÃO
// ==========================================

function validarCoordenadas(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  
  const latValida = Number.isFinite(latitude) && Math.abs(latitude) <= 90;
  const lonValida = Number.isFinite(longitude) && Math.abs(longitude) <= 180;
  
  return latValida && lonValida ? { lat: latitude, lon: longitude } : null;
}

function sanitizarErro(err) {
  // Garante que senhas, tokens ou URLs internas com chaves não vazem nos logs
  const mensagem = String(err?.message || err || 'Erro desconhecido');
  return mensagem.replace(/(access_token|key|secret|password)=[^&]*/gi, '$1=***REDACTED***');
}

// ==========================================
// 3. ROTAS OPERACIONAIS
// ==========================================

// Rota de Health Check (Monitorização de Uptime)
app.get('/health', (_req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    servico: 'Cardapio Delivery Backend SaaS',
    timestamp: new Date().toISOString() 
  });
});

// Endpoint Seguro de Cotação de Frete Híbrido
app.post('/api/frete/cotar', async (req, res) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000); // Timeout global de 6s

  try {
    const { restaurante_id, cliente_lat, cliente_lon, bairro_id } = req.body || {};

    if (!restaurante_id || typeof restaurante_id !== 'string') {
      clearTimeout(timeoutId);
      return res.status(400).json({ erro: 'ID do restaurante é obrigatório e deve ser válido.' });
    }

    // 1. Busca configurações reais da loja no banco (Bypass seguro via Service Role)
    const { data: rest, error: restErro } = await supabaseAdmin
      .from('restaurantes')
      .select('loja_lat, loja_lon, taxa_base, valor_km, ativo, raio_max_km')
      .eq('id', restaurante_id)
      .maybeSingle();

    if (restErro) {
      throw new Error(`Erro ao consultar restaurante: ${restErro.message}`);
    }

    if (!rest || !rest.ativo) {
      clearTimeout(timeoutId);
      return res.status(404).json({ erro: 'Restaurante não localizado ou com operações pausadas.' });
    }

    // 2. Opção A: Cálculo Híbrido por GPS
    if (cliente_lat !== undefined && cliente_lon !== undefined) {
      const coordsCliente = validarCoordenadas(cliente_lat, cliente_lon);
      const coordsLoja = validarCoordenadas(rest.loja_lat, rest.loja_lon);

      if (!coordsCliente) {
        clearTimeout(timeoutId);
        return res.status(400).json({ erro: 'Coordenadas de latitude/longitude do cliente são inválidas.' });
      }

      if (!coordsLoja) {
        clearTimeout(timeoutId);
        return res.status(422).json({ erro: 'Coordenadas geográficas da loja não estão configuradas no painel.' });
      }

      // Calcula distância por rota real com fallback defensivo interno
      const distanciaKm = await calcularDistanciaKm(
        coordsLoja.lat, 
        coordsLoja.lon, 
        coordsCliente.lat, 
        coordsCliente.lon,
        { signal: controller.signal }
      );

      // Validação de raio máximo de atendimento
      if (rest.raio_max_km > 0 && distanciaKm > rest.raio_max_km) {
        clearTimeout(timeoutId);
        return res.status(400).json({ 
          erro: `Endereço fora da área de entrega. Distância (${distanciaKm}km) excede o raio máximo de ${rest.raio_max_km}km.` 
        });
      }

      const taxaCalculada = Number(rest.taxa_base) + (distanciaKm * Number(rest.valor_km));
      clearTimeout(timeoutId);

      return res.status(200).json({
        tipo: 'gps',
        distancia_km: Number(distanciaKm.toFixed(2)),
        taxa: Number(taxaCalculada.toFixed(2))
      });
    }

    // 3. Opção B: Cálculo por Tabela de Bairros (Fallback)
    if (bairro_id) {
      const { data: bairro, error: bairroErro } = await supabaseAdmin
        .from('bairros')
        .select('taxa, tempo_estimado, ativo')
        .eq('id', bairro_id)
        .eq('restaurante_id', restaurante_id)
        .maybeSingle();

      if (bairroErro) {
        throw new Error(`Erro ao consultar tabela de bairros: ${bairroErro.message}`);
      }

      if (!bairro || !bairro.ativo) {
        clearTimeout(timeoutId);
        return res.status(404).json({ erro: 'Bairro selecionado não é atendido por este estabelecimento.' });
      }

      clearTimeout(timeoutId);
      return res.status(200).json({
        tipo: 'bairro',
        taxa: Number(Number(bairro.taxa).toFixed(2)),
        tempo: bairro.tempo_estimado || '40-50 min'
      });
    }

    clearTimeout(timeoutId);
    return res.status(400).json({ erro: 'Informe as coordenadas de GPS ou selecione um bairro válido.' });

  } catch (error) {
    clearTimeout(timeoutId);
    console.error('[ERRO INTERNO - COTAR FRETE]:', sanitizarErro(error));
    
    return res.status(500).json({ 
      erro: 'Não foi possível processar a cotação de frete no momento. Tente novamente em instantes.' 
    });
  }
});

// Endpoint Seguro de Criação de Pedidos (Zero-Trust)
app.post('/api/pedidos', criarPedido);

// Rota coringa para tratar endpoints inexistentes (404)
app.use((_req, res) => {
  res.status(404).json({ erro: 'Recurso não encontrado no servidor.' });
});

// ==========================================
// 4. INICIALIZAÇÃO GRACIOSA DO SERVIDOR
// ==========================================

const server = app.listen(PORT, () => {
  console.log(`🚀 [Sonnet-G Engine] Servidor SaaS rodando na porta ${PORT}`);
});

// Tratamento de encerramento gracioso (evita conexões pendentes no Render)
function fecharServidor(sinal) {
  console.log(`\nRecebido ${sinal}. Encerrando conexões graciosamente...`);
  server.close(() => {
    console.log('Servidor HTTP finalizado com sucesso.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => fecharServidor('SIGTERM'));
process.on('SIGINT', () => fecharServidor('SIGINT'));
