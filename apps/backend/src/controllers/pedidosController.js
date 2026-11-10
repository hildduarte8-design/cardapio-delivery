// Rota /api/pedidos — pedido feito pelo cliente no cardápio público.
import { supabaseAdmin } from '../config/supabase.js';
import { calcularFrete, FreteError } from '../services/frete.js';
import {
  MAX_ITENS,
  MAX_QTD_POR_ITEM,
  MAX_OBSERVACAO,
  sanitizarTexto,
  paraCentavos,
  deCentavos,
  normalizarTelefone,
  coordenadasValidas,
  respostaErro
} from '../utils/pedidosUtils.js';

/**
 * Factory para permitir testes sem conexão real com o Supabase.
 * O servidor continua usando criarPedido normalmente.
 */
export function criarControladorPedidos({
  db = supabaseAdmin,
  calcularFreteFn = calcularFrete
} = {}) {
  async function criarPedido(req, res) {
    try {
      const {
        restaurante_id,
        cliente_nome,
        cliente_whatsapp,
        cliente_phone,
        endereco_completo,
        bairro_id,
        cliente_lat,
        cliente_lon,
        itens,
        forma_pagamento,
        troco_para,
        observacao_geral,
        observacao,
        tipo_atendimento
      } = req.body || {};
      const retirada = tipo_atendimento === 'retirada';

      // 1. Dados básicos do cliente e do pedido
      const restauranteId = sanitizarTexto(restaurante_id, 1, 50);
      const nome = sanitizarTexto(cliente_nome, 2, 80);
      const endereco = retirada ? 'Retirada no balcão' : sanitizarTexto(endereco_completo, 5, 200);
      const telefone = normalizarTelefone(cliente_whatsapp || cliente_phone);

      if (!restauranteId) {
        return respostaErro(res, 400, 'ID do restaurante é obrigatório.', 'RESTAURANTE_INVALIDO');
      }

      if (!nome) {
        return respostaErro(res, 400, 'Nome do cliente inválido.', 'NOME_INVALIDO');
      }

      if (telefone.length < 10 || telefone.length > 13) {
        return respostaErro(res, 400, 'WhatsApp inválido com DDD.', 'WHATSAPP_INVALIDO');
      }

      if (!endereco) {
        return respostaErro(res, 400, 'Endereço completo inválido.', 'ENDERECO_INVALIDO');
      }

      if (!Array.isArray(itens) || itens.length === 0 || itens.length > MAX_ITENS) {
        return respostaErro(res, 400, `O pedido deve conter entre 1 e ${MAX_ITENS} itens.`, 'CARRINHO_INVALIDO');
      }

      const temCoordenadas = coordenadasValidas(cliente_lat, cliente_lon);

      if ((cliente_lat != null || cliente_lon != null) && !temCoordenadas) {
        return respostaErro(res, 400, 'As coordenadas de entrega são inválidas.', 'COORDENADAS_INVALIDAS');
      }

      if (!retirada && !bairro_id && !temCoordenadas) {
        return respostaErro(
          res,
          400,
          'Informe o bairro de entrega ou a localização do endereço.',
          'LOCALIZACAO_OBRIGATORIA'
        );
      }

      // 2. Restaurante
      const { data: restaurante, error: restErro } = await db
        .from('restaurantes')
        .select('id, nome, ativo, loja_lat, loja_lon, taxa_base, valor_km, raio_max_km')
        .eq('id', restauranteId)
        .maybeSingle();

      if (restErro) {
        console.error('[PEDIDO] Erro ao consultar restaurante:', restErro.message);
        return respostaErro(res, 500, 'Não foi possível validar o restaurante.', 'ERRO_CONSULTA_RESTAURANTE');
      }

      if (!restaurante) {
        return respostaErro(res, 404, 'Restaurante não localizado.', 'RESTAURANTE_NAO_ENCONTRADO');
      }

      if (!restaurante.ativo) {
        return respostaErro(res, 422, 'O restaurante está com as operações encerradas.', 'RESTAURANTE_INATIVO');
      }

      // 3. Normalização rigorosa dos itens
      const itensNormalizados = [];

      for (const item of itens) {
        if (!item || typeof item !== 'object') {
          return respostaErro(res, 400, 'Item do carrinho inválido.', 'ITEM_INVALIDO');
        }

        const produtoId = item.produto_id || item.id;
        const quantidadeInformada = item.quantidade ?? item.qtd;
        const quantidade = Number(quantidadeInformada);

        if (
          typeof produtoId !== 'string' ||
          !produtoId.trim() ||
          !Number.isInteger(quantidade) ||
          quantidade < 1 ||
          quantidade > MAX_QTD_POR_ITEM
        ) {
          return respostaErro(res, 400, 'Produto ou quantidade inválida.', 'QUANTIDADE_INVALIDA');
        }

        itensNormalizados.push({
          produto_id: produtoId.trim(),
          quantidade,
          observacao: sanitizarTexto(item.observacao || '', 0, 100)
        });
      }

      // 4. Consulta de produtos por IDs únicos
      const idsProdutos = [...new Set(itensNormalizados.map(item => item.produto_id))];

      const { data: produtosBanco, error: produtosErro } = await db
        .from('produtos')
        .select('id, nome, preco, disponivel, restaurante_id')
        .in('id', idsProdutos)
        .eq('restaurante_id', restaurante.id);

      if (produtosErro) {
        console.error('[PEDIDO] Erro ao consultar produtos:', produtosErro.message);
        return respostaErro(res, 500, 'Não foi possível validar os produtos.', 'ERRO_CONSULTA_PRODUTOS');
      }

      const mapaProdutos = new Map((produtosBanco || []).map(produto => [produto.id, produto]));

      if (mapaProdutos.size !== idsProdutos.length) {
        return respostaErro(
          res,
          422,
          'Um ou mais produtos são inválidos ou não pertencem a este restaurante.',
          'PRODUTO_INVALIDO'
        );
      }

      // 5. Validação de disponibilidade e cálculo do subtotal
      let subtotalCentavos = 0;
      const itensValidados = [];

      for (const item of itensNormalizados) {
        const produto = mapaProdutos.get(item.produto_id);

        if (!produto.disponivel) {
          return respostaErro(
            res,
            422,
            `O produto "${produto.nome}" está indisponível.`,
            'PRODUTO_INDISPONIVEL'
          );
        }

        const precoCentavos = paraCentavos(produto.preco);

        if (precoCentavos === null || precoCentavos <= 0) {
          console.error('[PEDIDO] Produto com preço inválido:', produto.id);
          return respostaErro(res, 500, 'Um produto possui preço inválido no cadastro.', 'PRECO_PRODUTO_INVALIDO');
        }

        const subtotalItemCentavos = precoCentavos * item.quantidade;

        subtotalCentavos += subtotalItemCentavos;

        itensValidados.push({
          id: produto.id,
          produto_id: produto.id,
          nome: produto.nome,
          preco: deCentavos(precoCentavos),
          preco_unitario: deCentavos(precoCentavos),
          qtd: item.quantidade,
          quantidade: item.quantidade,
          subtotal: deCentavos(subtotalItemCentavos),
          observacao: item.observacao || null
        });
      }

      if (!Number.isSafeInteger(subtotalCentavos) || subtotalCentavos <= 0) {
        return respostaErro(res, 400, 'Subtotal do pedido inválido.', 'SUBTOTAL_INVALIDO');
      }

      // 6. Validação estrita do bairro, sempre consultando o banco
      let bairroConfirmado = null;

      if (!retirada && bairro_id) {
        if (typeof bairro_id !== 'string' || !bairro_id.trim()) {
          return respostaErro(res, 422, 'Bairro inválido.', 'BAIRRO_INVALIDO');
        }

        const { data: bairroBanco, error: bairroErro } = await db
          .from('bairros')
          .select('id, nome, taxa, restaurante_id, ativo')
          .eq('id', bairro_id)
          .eq('restaurante_id', restaurante.id)
          .maybeSingle();

        if (bairroErro) {
          console.error('[PEDIDO] Erro ao consultar bairro:', bairroErro.message);
          return respostaErro(res, 500, 'Não foi possível validar o bairro.', 'ERRO_CONSULTA_BAIRRO');
        }

        if (!bairroBanco || !bairroBanco.ativo) {
          return respostaErro(
            res,
            422,
            'Bairro inválido, inativo ou não pertencente a este restaurante.',
            'BAIRRO_INVALIDO'
          );
        }

        bairroConfirmado = bairroBanco;
      }

      // 7. Cálculo do frete no servidor
      let calculoFrete;

      try {
        calculoFrete = retirada ? { taxa: 0, frete_tipo: null, distancia_km: null } : await calcularFreteFn({
          restaurante,
          destino: temCoordenadas
            ? { lat: Number(cliente_lat), lon: Number(cliente_lon) }
            : null,
          bairro: bairroConfirmado?.nome || null
        });
      } catch (erroFrete) {
        if (erroFrete instanceof FreteError) {
          return res.status(erroFrete.status).json({
            erro: erroFrete.message,
            codigo: erroFrete.code,
            detalhes: erroFrete.detalhes
          });
        }

        throw erroFrete;
      }

      const taxaCentavos = paraCentavos(calculoFrete?.taxa);

      if (taxaCentavos === null) {
        throw new Error('O motor de frete retornou uma taxa inválida.');
      }

      const totalCentavos = subtotalCentavos + taxaCentavos;

      if (!Number.isSafeInteger(totalCentavos)) {
        throw new Error('Total do pedido excedeu o limite permitido.');
      }

      // 8. Pagamento e troco
      const FORMAS_PAGAMENTO = ['pix', 'dinheiro', 'cartao'];
      const pagamento = sanitizarTexto(forma_pagamento || 'pix', 2, 30)?.toLowerCase();

      if (!pagamento || !FORMAS_PAGAMENTO.includes(pagamento)) {
        return respostaErro(res, 400, 'Forma de pagamento inválida.', 'PAGAMENTO_INVALIDO');
      }

      let trocoCentavos = null;

      // Troco só existe para pagamento em dinheiro; nas outras formas é ignorado
      if (pagamento === 'dinheiro' && troco_para !== undefined && troco_para !== null && troco_para !== '') {
        trocoCentavos = paraCentavos(troco_para);

        if (trocoCentavos === null || trocoCentavos < totalCentavos) {
          return respostaErro(
            res,
            400,
            'O valor informado para troco deve ser igual ou maior que o total.',
            'TROCO_INVALIDO'
          );
        }
      }

      const observacaoFinal = sanitizarTexto(
        observacao_geral || observacao || '',
        0,
        MAX_OBSERVACAO
      );

      // 9. Payload final
      const novoPedidoPayload = {
        restaurante_id: restaurante.id,
        cliente_nome: nome,
        cliente_whatsapp: telefone,
        endereco_completo: endereco,
        bairro_id: bairroConfirmado?.id || null,
        frete_tipo: calculoFrete.frete_tipo,
        distancia_km: calculoFrete.distancia_km ?? null,
        subtotal: deCentavos(subtotalCentavos),
        taxa_entrega: deCentavos(taxaCentavos),
        total: deCentavos(totalCentavos),
        status: 'pendente_pagamento',
        itens: itensValidados,
        forma_pagamento: pagamento,
        troco_para: trocoCentavos === null ? null : deCentavos(trocoCentavos),
        observacao: observacaoFinal || null,
        origem: 'cardapio',
        tipo_atendimento: retirada ? 'retirada' : 'entrega'
      };

      const { data: pedidoCriado, error: insertErro } = await db
        .from('pedidos')
        .insert([novoPedidoPayload])
        .select('id, total, status, created_at')
        .single();

      if (insertErro || !pedidoCriado) {
        console.error('[PEDIDO] Erro ao inserir pedido:', insertErro?.message);
        return respostaErro(res, 500, 'Falha ao registrar pedido no banco de dados.', 'ERRO_PERSISTENCIA');
      }

      return res.status(201).json({
        sucesso: true,
        mensagem: 'Pedido registrado com sucesso!',
        pedido: {
          id: pedidoCriado.id,
          subtotal: deCentavos(subtotalCentavos),
          taxa_entrega: deCentavos(taxaCentavos),
          total: pedidoCriado.total,
          status: pedidoCriado.status,
          created_at: pedidoCriado.created_at,
          frete_tipo: calculoFrete.frete_tipo,
          requer_confirmacao: calculoFrete.requer_confirmacao || false
        }
      });
    } catch (erro) {
      console.error('[ERRO CRÍTICO - CRIAR PEDIDO]:', erro.message);

      return respostaErro(
        res,
        500,
        'Falha interna ao processar o pedido.',
        'ERRO_INTERNO'
      );
    }
  }

  return { criarPedido };
}

// Mantém a assinatura usada atualmente em server.js.
export const { criarPedido } = criarControladorPedidos();
