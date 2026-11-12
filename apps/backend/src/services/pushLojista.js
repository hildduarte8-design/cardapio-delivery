// Avisos push para o lojista: pedido novo aguardando aceite, repetido a cada ~30 segundos.
// Nunca derruba o servidor: qualquer falha só vai para o log.
import webpush from 'web-push';
import process from 'node:process';
import { supabaseAdmin } from '../config/supabase.js';

const INTERVALO_AVISO_MS = 30_000;            // repete o aviso a cada ~30 segundos
const VERIFICACAO_MS = 10_000;                // de quanto em quanto tempo o servidor confere os pedidos
const MAX_AVISOS_POR_PEDIDO = 20;             // 20 avisos x 30 s = 10 minutos
const IDADE_MAX_PEDIDO_MS = 15 * 60 * 1000;   // ignora pedidos com mais de 15 minutos
const STATUS_QUE_PEDEM_ACEITE = ['pendente_pagamento', 'pago'];

let ativo = false;
let verificando = false;

// Trava extra na memória: mesmo que o banco falhe ao gravar, nunca repete o aviso em menos de 25 s
const ultimoEnvio = new Map();

function brl(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function codigoDe(pedido) {
  return String(pedido.id || '').slice(-4).toUpperCase();
}

function montarMensagem(pedidos) {
  if (pedidos.length === 1) {
    const p = pedidos[0];
    const forma = String(p.forma_pagamento || '').trim().toLowerCase();
    const pagamento =
      forma === 'pix' ? 'Pix'
      : forma === 'dinheiro' ? 'Dinheiro'
      : forma === 'cartao' || forma === 'cartão' ? 'Cartão'
      : '';

    return {
      titulo: '🔔 Novo pedido!',
      corpo: `#${codigoDe(p)} · ${p.cliente_nome || 'Cliente'} · ${brl(p.total)}${pagamento ? ' · ' + pagamento : ''}`
    };
  }

  return {
    titulo: `🔔 ${pedidos.length} pedidos aguardando!`,
    corpo: 'Toque para abrir o painel e aceitar.'
  };
}

async function enviarParaAparelhos(aparelhos, mensagem) {
  const payload = JSON.stringify({ ...mensagem, tag: 'pedido-novo', url: 'admin.html' });

  await Promise.all(aparelhos.map(async (aparelho) => {
    try {
      await webpush.sendNotification(
        { endpoint: aparelho.endpoint, keys: { p256dh: aparelho.p256dh, auth: aparelho.auth } },
        payload,
        { TTL: 60, urgency: 'high', topic: 'novo-pedido' }
      );
    } catch (erro) {
      if (erro.statusCode === 404 || erro.statusCode === 410) {
        // O aparelho cancelou ou a inscrição expirou: remove para não tentar de novo
        await supabaseAdmin.from('push_aparelhos').delete().eq('id', aparelho.id);
        console.log('[PUSH] Aparelho removido (inscrição expirada).');
      } else {
        console.error('[PUSH] Falha ao enviar:', erro.statusCode || '', erro.message);
      }
    }
  }));
}

export async function verificarPedidosPendentes() {
  if (!ativo || verificando) return;
  verificando = true;

  try {
    const agora = Date.now();
    const desde = new Date(agora - IDADE_MAX_PEDIDO_MS).toISOString();
    const vencidos = new Date(agora - (INTERVALO_AVISO_MS - 5_000)).toISOString();

    const { data: pedidos, error } = await supabaseAdmin
      .from('pedidos')
      .select('id, restaurante_id, cliente_nome, total, forma_pagamento, alerta_push_qtd')
      .is('aceito_em', null)
      .in('status', STATUS_QUE_PEDEM_ACEITE)
      .gte('created_at', desde)
      .lt('alerta_push_qtd', MAX_AVISOS_POR_PEDIDO)
      .or(`alerta_push_em.is.null,alerta_push_em.lte.${vencidos}`)
      .limit(50);

    if (error) {
      console.error('[PUSH] Erro ao consultar pedidos:', error.message);
      return;
    }

    // Limpa a memória de pedidos antigos
    for (const [id, quando] of ultimoEnvio) {
      if (agora - quando > 20 * 60 * 1000) ultimoEnvio.delete(id);
    }

    const porRestaurante = new Map();
    for (const pedido of pedidos || []) {
      if (agora - (ultimoEnvio.get(pedido.id) || 0) < INTERVALO_AVISO_MS - 5_000) continue;
      if (!porRestaurante.has(pedido.restaurante_id)) porRestaurante.set(pedido.restaurante_id, []);
      porRestaurante.get(pedido.restaurante_id).push(pedido);
    }

    for (const [restauranteId, lista] of porRestaurante) {
      const { data: aparelhos, error: erroAparelhos } = await supabaseAdmin
        .from('push_aparelhos')
        .select('id, endpoint, p256dh, auth')
        .eq('restaurante_id', restauranteId);

      if (erroAparelhos) {
        console.error('[PUSH] Erro ao buscar aparelhos:', erroAparelhos.message);
        continue;
      }
      if (!aparelhos || !aparelhos.length) continue;

      await enviarParaAparelhos(aparelhos, montarMensagem(lista));

      const agoraIso = new Date().toISOString();
      await Promise.all(lista.map(async (pedido) => {
        ultimoEnvio.set(pedido.id, Date.now());
        const { error: erroUpdate } = await supabaseAdmin
          .from('pedidos')
          .update({ alerta_push_qtd: (pedido.alerta_push_qtd || 0) + 1, alerta_push_em: agoraIso })
          .eq('id', pedido.id);
        if (erroUpdate) console.error('[PUSH] Erro ao registrar o aviso:', erroUpdate.message);
      }));
    }
  } catch (erro) {
    console.error('[PUSH] Erro inesperado:', erro.message);
  } finally {
    verificando = false;
  }
}

// Chamado logo depois que um pedido é criado: dispara o primeiro aviso sem esperar o ciclo
export function avisarLojistaPedidoNovo() {
  if (!ativo) return;
  verificarPedidosPendentes().catch((erro) => console.error('[PUSH] Falha ao avisar:', erro.message));
}

export function iniciarPushLojista() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    console.warn('[PUSH] Desativado: faltam VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY ou VAPID_SUBJECT na Render.');
    return;
  }

  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (erro) {
    console.error('[PUSH] Chaves VAPID inválidas:', erro.message);
    return;
  }

  ativo = true;
  setInterval(() => {
    verificarPedidosPendentes().catch((erro) => console.error('[PUSH] Erro no ciclo:', erro.message));
  }, VERIFICACAO_MS);

  console.log('[PUSH] Avisos ao lojista ativos.');
}
