// Rota GET /api/pedidos/:id/status
// Devolve só o andamento do pedido (sem nome, telefone, endereço ou valores).
import { supabaseAdmin } from '../config/supabase.js';
import { sanitizarTexto, respostaErro } from '../utils/pedidosUtils.js';

const PASSOS_ENTREGA = ['Pedido recebido', 'Em preparo', 'Saiu para entrega', 'Entregue'];
const PASSOS_RETIRADA = ['Pedido recebido', 'Em preparo', 'Pronto para retirar', 'Retirado'];

function descrever(pedido) {
  const retirada = pedido.tipo_atendimento === 'retirada';
  const forma = String(pedido.forma_pagamento || '').trim().toLowerCase();
  const passos = retirada ? PASSOS_RETIRADA : PASSOS_ENTREGA;
  const ultimo = passos.length - 1;

  if (pedido.status === 'cancelado') {
    return {
      passos, passo_atual: 0, cancelado: true,
      titulo: 'Pedido cancelado',
      descricao: 'Qualquer dúvida, fale com a loja pelo WhatsApp.'
    };
  }

  if (pedido.status === 'pendente_pagamento') {
    if (forma === 'pix') {
      return {
        passos, passo_atual: 0, cancelado: false,
        titulo: 'Aguardando confirmação do pagamento',
        descricao: 'A loja vai conferir o seu Pix e já começa o preparo.'
      };
    }
    return {
      passos, passo_atual: 0, cancelado: false,
      titulo: 'Aguardando a loja aceitar',
      descricao: 'Seu pedido já chegou. Assim que a loja aceitar, o preparo começa.'
    };
  }

  if (pedido.status === 'pago') {
    return {
      passos, passo_atual: 0, cancelado: false,
      titulo: 'Pagamento confirmado',
      descricao: 'Já vamos começar a preparar o seu pedido.'
    };
  }

  if (pedido.status === 'preparando') {
    return {
      passos, passo_atual: 1, cancelado: false,
      titulo: 'Em preparo',
      descricao: retirada
        ? 'Estamos preparando o seu pedido. Avisamos quando estiver pronto.'
        : 'Estamos preparando o seu pedido com carinho.'
    };
  }

  if (pedido.status === 'saiu_entrega') {
    return {
      passos, passo_atual: 2, cancelado: false,
      titulo: 'Saiu para entrega',
      descricao: 'Seu pedido está a caminho.'
    };
  }

 if (pedido.status === 'pronto_retirada') {
    return {
      passos, passo_atual: 2, cancelado: false,
      titulo: 'Pronto para retirar',
      descricao: 'Seu pedido está pronto, pode vir buscar.'
    };
  }
  
  if (pedido.status === 'entregue') {
    return {
      passos, passo_atual: ultimo, cancelado: false,
      titulo: retirada ? 'Pedido retirado' : 'Pedido entregue',
      descricao: 'Obrigado pela preferência!'
    };
  }

  return {
    passos, passo_atual: 0, cancelado: false,
    titulo: 'Pedido recebido',
    descricao: 'Estamos cuidando do seu pedido.'
  };
}

const STATUS_NA_FILA = ['pago', 'preparando'];
const FORMAS_PAGA_NA_ENTREGA = ['dinheiro', 'cartao', 'cartão'];
const JANELA_FILA_MS = 2 * 60 * 60 * 1000;
const FAIXA_PREVISAO_MIN = 10;

// Previsão de tempo (opcional, ligada pelo lojista). Qualquer falha devolve null e a tela segue sem previsão.
async function calcularPrevisao(db, pedido) {
  try {
    if (!['pendente_pagamento', 'pago', 'preparando'].includes(pedido.status)) return null;
    const forma = String(pedido.forma_pagamento || '').trim().toLowerCase();
    if (pedido.status === 'pendente_pagamento' && !FORMAS_PAGA_NA_ENTREGA.includes(forma)) return null;

    const { data: base, error: erroBase } = await db
      .from('pedidos')
      .select('restaurante_id, created_at')
      .eq('id', pedido.id)
      .maybeSingle();
    if (erroBase || !base || !base.restaurante_id || !base.created_at) return null;

    const { data: rest, error: erroRest } = await db
      .from('restaurantes')
      .select('previsao_ativa, previsao_base_entrega_min, previsao_base_retirada_min, previsao_min_por_pedido')
      .eq('id', base.restaurante_id)
      .maybeSingle();
    if (erroRest || !rest || rest.previsao_ativa !== true) return null;

    const desde = new Date(Date.now() - JANELA_FILA_MS).toISOString();
    const contar = (status, formas) => {
      let consulta = db
        .from('pedidos')
        .select('id', { count: 'exact', head: true })
        .eq('restaurante_id', base.restaurante_id)
        .in('status', status)
        .lt('created_at', base.created_at)
        .gte('created_at', desde);
      if (formas) consulta = consulta.in('forma_pagamento', formas);
      return consulta;
    };

    const [fila1, fila2] = await Promise.all([
      contar(STATUS_NA_FILA),
      contar(['pendente_pagamento'], FORMAS_PAGA_NA_ENTREGA)
    ]);
    const naFrente = (fila1.error ? 0 : fila1.count || 0) + (fila2.error ? 0 : fila2.count || 0);

    const retirada = pedido.tipo_atendimento === 'retirada';
    const tempoBase = Number(retirada ? rest.previsao_base_retirada_min : rest.previsao_base_entrega_min) || 0;
    const porPedido = Number(rest.previsao_min_por_pedido) || 0;
    if (tempoBase <= 0) return null;

    const minimo = tempoBase + naFrente * porPedido;
    return { minimo, maximo: minimo + FAIXA_PREVISAO_MIN };
  } catch (erro) {
    return null;
  }
}

export function criarControladorStatusPedido({ db = supabaseAdmin } = {}) {
  async function statusPedido(req, res) {
    try {
      const id = sanitizarTexto(req.params.id, 1, 60);

      if (!id) {
        return respostaErro(res, 400, 'Pedido inválido.', 'PEDIDO_INVALIDO');
      }

      const { data: pedido, error } = await db
        .from('pedidos')
        .select('id, status, forma_pagamento, tipo_atendimento')
        .eq('id', id)
        .maybeSingle();

      // ID mal formado cai aqui também: mesma resposta de "não existe"
      if (error || !pedido) {
        return respostaErro(res, 404, 'Pedido não localizado.', 'PEDIDO_NAO_ENCONTRADO');
      }

      res.setHeader('Cache-Control', 'no-store');

            const previsao = await calcularPrevisao(db, pedido);

      return res.status(200).json({
        sucesso: true,
        codigo: String(pedido.id).slice(-4).toUpperCase(),
        status: pedido.status,
        ...descrever(pedido),
        ...(previsao ? { previsao } : {})
      });
    } catch (erro) {
      console.error('[ERRO CRÍTICO - STATUS PEDIDO]:', erro.message);
      return respostaErro(res, 500, 'Não foi possível consultar o pedido.', 'ERRO_INTERNO');
    }
  }

  return { statusPedido };
}

export const { statusPedido } = criarControladorStatusPedido();
