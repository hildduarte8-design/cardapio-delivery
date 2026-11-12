// Rota POST /api/pedidos/:id/avisar-pagamento
// O cliente avisa que pagou o Pix. NÃO muda o status: quem confirma é o lojista.
import { supabaseAdmin } from '../config/supabase.js';
import { sanitizarTexto, respostaErro } from '../utils/pedidosUtils.js';

export function criarControladorAvisoPagamento({ db = supabaseAdmin } = {}) {
  async function avisarPagamento(req, res) {
    try {
      const id = sanitizarTexto(req.params.id, 1, 60);

      if (!id) {
        return respostaErro(res, 400, 'Pedido inválido.', 'PEDIDO_INVALIDO');
      }

      const { data: pedido, error: buscaErro } = await db
        .from('pedidos')
        .select('id, forma_pagamento, status, pagamento_avisado_em')
        .eq('id', id)
        .maybeSingle();

      // ID mal formado também cai aqui: resposta igual à de "não existe"
      if (buscaErro || !pedido) {
        return respostaErro(res, 404, 'Pedido não localizado.', 'PEDIDO_NAO_ENCONTRADO');
      }

      if (String(pedido.forma_pagamento || '').toLowerCase() !== 'pix') {
        return respostaErro(res, 422, 'Este pedido não é Pix.', 'PEDIDO_NAO_E_PIX');
      }

      // Já avisou antes: responde sucesso sem gravar de novo
      if (pedido.pagamento_avisado_em) {
        return res.status(200).json({ sucesso: true, ja_avisado: true });
      }

      if (pedido.status !== 'pendente_pagamento') {
        return respostaErro(res, 409, 'Este pedido não está aguardando pagamento.', 'STATUS_INVALIDO');
      }

      const { error: updErro } = await db
        .from('pedidos')
        .update({ pagamento_avisado_em: new Date().toISOString() })
        .eq('id', pedido.id)
        .eq('status', 'pendente_pagamento')
        .is('pagamento_avisado_em', null);

      if (updErro) {
        console.error('[AVISO PAGAMENTO] Erro ao gravar:', updErro.message);
        return respostaErro(res, 500, 'Não foi possível enviar o aviso.', 'ERRO_PERSISTENCIA');
      }

      return res.status(200).json({ sucesso: true, ja_avisado: false });
    } catch (erro) {
      console.error('[ERRO CRÍTICO - AVISAR PAGAMENTO]:', erro.message);
      return respostaErro(res, 500, 'Falha interna ao enviar o aviso.', 'ERRO_INTERNO');
    }
  }

  return { avisarPagamento };
}

export const { avisarPagamento } = criarControladorAvisoPagamento();
