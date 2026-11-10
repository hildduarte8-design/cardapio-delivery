// Rota /api/pedidos/manual — pedido lançado pelo próprio lojista no painel administrativo.
// Requer autenticação com token JWT do Supabase (Bearer).
// Suporta entrega (com bairro) ou retirada no balcão (sem endereço).
// Permite desconto opcional com motivo registrado.
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
  respostaErro
} from '../utils/pedidosUtils.js';

const FORMAS_PAGAMENTO = ['pix', 'dinheiro', 'cartao'];
const TIPOS_ATENDIMENTO = ['entrega', 'retirada'];
const MAX_MOTIVO_DESCONTO = 60;
const ENDERECO_RETIRADA = 'Retirada no balcão';

/**
 * Dispara uma consulta ao banco já (sem esperar) e devolve uma promessa que NUNCA rejeita:
 * se der falha de rede, vira { data: null, error } igual aos outros erros do Supabase.
 * Assim várias consultas rodam ao mesmo tempo e o resultado é lido onde era lido antes.
 */
function iniciar(consulta) {
  return Promise.resolve(consulta).then(
    (resultado) => resultado,
    (erro) => ({ data: null, error: { message: erro?.message || 'falha na consulta' } })
  );
}

/**
 * Identifica o usuário logado pelo token do Supabase (cabeçalho Authorization: Bearer ...).
 * Devolve { id } ou null. Qualquer falha vira "não autenticado".
 */
export async function autenticarUsuario(req, cliente = supabaseAdmin) {
  try {
    const cabecalho = req?.headers?.authorization;

    if (typeof cabecalho !== 'string') return null;

    const partes = cabecalho.trim().split(/\s+/);

    if (partes.length !== 2 || partes[0].toLowerCase() !== 'bearer') return null;

    const token = partes[1];

    if (!token || token.length > 4096) return null;

    const { data, error } = await cliente.auth.getUser(token);

    if (error || !data?.user?.id) return null;

    return { id: data.user.id };
  } catch (erro) {
    console.error('[PEDIDO MANUAL] Falha ao validar o token:', erro.message);
    return null;
  }
}

/**
 * Factory para permitir testes sem Supabase real.
 * O servidor usa criarPedidoManual normalmente.
 */
export function criarControladorPedidoManual({
  db = supabaseAdmin,
  calcularFreteFn = calcularFrete,
  autenticarFn = autenticarUsuario
} = {}) {
  async function criarPedidoManual(req, res) {
    try {
      // 1. Quem está pedindo: só o lojista logado
      const usuario = await autenticarFn(req);

      if (!usuario) {
        return respostaErro(res, 401, 'Entre no painel para lançar pedidos.', 'NAO_AUTENTICADO');
      }

      const {
        restaurante_id,
        tipo_atendimento,
        cliente_nome,
        cliente_whatsapp,
        endereco_completo,
        bairro_id,
        itens,
        forma_pagamento,
        troco_para,
        desconto,
        desconto_motivo,
        observacao
      } = req.body || {};

      const restauranteId = sanitizarTexto(restaurante_id, 1, 50);

      if (!restauranteId) {
        return respostaErro(res, 400, 'ID do restaurante é obrigatório.', 'RESTAURANTE_INVALIDO');
      }

      const tempoInicio = Date.now();

      // Consultas independentes saem TODAS juntas (antes eram uma esperando a outra).
      // As validações e as mensagens de erro abaixo continuam na mesma ordem de antes.
      const consultaVinculo = iniciar(
        db
          .from('restaurante_usuarios')
          .select('restaurante_id')
          .eq('user_id', usuario.id)
          .eq('restaurante_id', restauranteId)
          .maybeSingle()
      );

      const consultaRestaurante = iniciar(
        db
          .from('restaurantes')
          .select('id, nome, ativo, loja_lat, loja_lon, taxa_base, valor_km, raio_max_km')
          .eq('id', restauranteId)
          .maybeSingle()
      );

      const idsPrevios = Array.isArray(itens)
        ? [
            ...new Set(
              itens
                .slice(0, MAX_ITENS)
                .map((item) => (item && typeof item === 'object' ? item.produto_id || item.id : null))
                .filter((id) => typeof id === 'string' && id.trim())
                .map((id) => id.trim())
            )
          ]
        : [];

      const consultaProdutos = idsPrevios.length
        ? iniciar(
            db
              .from('produtos')
              .select('id, nome, preco, preco_promocional, disponivel, restaurante_id')
              .in('id', idsPrevios)
              .eq('restaurante_id', restauranteId)
          )
        : null;

      const consultaBairro =
        typeof bairro_id === 'string' && bairro_id.trim()
          ? iniciar(
              db
                .from('bairros')
                .select('id, nome, taxa, restaurante_id, ativo')
                .eq('id', bairro_id.trim())
                .eq('restaurante_id', restauranteId)
                .maybeSingle()
            )
          : null;

      // 2. O usuário precisa estar vinculado a ESTE restaurante
      const { data: vinculo, error: vinculoErro } = await consultaVinculo;

      if (vinculoErro) {
        console.error('[PEDIDO MANUAL] Erro ao consultar vínculo:', vinculoErro.message);
        return respostaErro(res, 500, 'Não foi possível validar o acesso.', 'ERRO_CONSULTA_VINCULO');
      }

      if (!vinculo) {
        return respostaErro(res, 403, 'Você não tem acesso a este restaurante.', 'SEM_ACESSO');
      }

      // 3. Dados do pedido
      const tipo = sanitizarTexto(tipo_atendimento || 'entrega', 1, 20)?.toLowerCase();

      if (!tipo || !TIPOS_ATENDIMENTO.includes(tipo)) {
        return respostaErro(res, 400, 'Tipo de atendimento inválido.', 'TIPO_ATENDIMENTO_INVALIDO');
      }

      const ehEntrega = tipo === 'entrega';
      const nome = sanitizarTexto(cliente_nome, 2, 80);

      if (!nome) {
        return respostaErro(res, 400, 'Nome do cliente inválido.', 'NOME_INVALIDO');
      }

      // O telefone é opcional no balcão, mas se vier precisa ser válido
      let telefone = null;
      const telefoneInformado = normalizarTelefone(cliente_whatsapp);

      if (telefoneInformado) {
        if (telefoneInformado.length < 10 || telefoneInformado.length > 13) {
          return respostaErro(res, 400, 'WhatsApp inválido com DDD.', 'WHATSAPP_INVALIDO');
        }

        telefone = telefoneInformado;
      }

      let endereco = ENDERECO_RETIRADA;

      if (ehEntrega) {
        endereco = sanitizarTexto(endereco_completo, 5, 200);

        if (!endereco) {
          return respostaErro(res, 400, 'Endereço completo inválido.', 'ENDERECO_INVALIDO');
        }

        if (typeof bairro_id !== 'string' || !bairro_id.trim()) {
          return respostaErro(res, 400, 'Informe o bairro de entrega.', 'BAIRRO_OBRIGATORIO');
        }
      }

      if (!Array.isArray(itens) || itens.length === 0 || itens.length > MAX_ITENS) {
        return respostaErro(res, 400, `O pedido deve conter entre 1 e ${MAX_ITENS} itens.`, 'CARRINHO_INVALIDO');
      }

      // 4. Restaurante
      const { data: restaurante, error: restErro } = await consultaRestaurante;

      if (restErro) {
        console.error('[PEDIDO MANUAL] Erro ao consultar restaurante:', restErro.message);
        return respostaErro(res, 500, 'Não foi possível validar o restaurante.', 'ERRO_CONSULTA_RESTAURANTE');
      }

      if (!restaurante) {
        return respostaErro(res, 404, 'Restaurante não localizado.', 'RESTAURANTE_NAO_ENCONTRADO');
      }

      if (!restaurante.ativo) {
        return respostaErro(res, 422, 'O restaurante está com as operações encerradas.', 'RESTAURANTE_INATIVO');
      }

      // 5. Itens: preço e disponibilidade sempre lidos do banco
      const itensNormalizados = [];

      for (const item of itens) {
        if (!item || typeof item !== 'object') {
          return respostaErro(res, 400, 'Item do pedido inválido.', 'ITEM_INVALIDO');
        }

        const produtoId = item.produto_id || item.id;
        const quantidade = Number(item.quantidade ?? item.qtd);

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

      const idsProdutos = [...new Set(itensNormalizados.map((item) => item.produto_id))];

      const { data: produtosBanco, error: produtosErro } = await (consultaProdutos ||
        iniciar(
          db
            .from('produtos')
            .select('id, nome, preco, preco_promocional, disponivel, restaurante_id')
            .in('id', idsProdutos)
            .eq('restaurante_id', restaurante.id)
        ));

      if (produtosErro) {
        console.error('[PEDIDO MANUAL] Erro ao consultar produtos:', produtosErro.message);
        return respostaErro(res, 500, 'Não foi possível validar os produtos.', 'ERRO_CONSULTA_PRODUTOS');
      }

      const mapaProdutos = new Map((produtosBanco || []).map((produto) => [produto.id, produto]));

      if (mapaProdutos.size !== idsProdutos.length) {
        return respostaErro(
          res,
          422,
          'Um ou mais produtos são inválidos ou não pertencem a este restaurante.',
          'PRODUTO_INVALIDO'
        );
      }

      let subtotalCentavos = 0;
      const itensValidados = [];

      for (const item of itensNormalizados) {
        const produto = mapaProdutos.get(item.produto_id);

        if (!produto.disponivel) {
          return respostaErro(res, 422, `O produto "${produto.nome}" está indisponível.`, 'PRODUTO_INDISPONIVEL');
        }

        const promo = Number(produto.preco_promocional);
        const precoVenda = promo > 0 && promo < Number(produto.preco) ? produto.preco_promocional : produto.preco;
        const precoCentavos = paraCentavos(precoVenda);

        if (precoCentavos === null || precoCentavos <= 0) {
          console.error('[PEDIDO MANUAL] Produto com preço inválido:', produto.id);
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

      // 6. Entrega: bairro do restaurante e taxa calculada no servidor. Retirada: sem taxa.
      let bairroConfirmado = null;
      let calculoFrete = null;
      let taxaCentavos = 0;

      if (ehEntrega) {
        const { data: bairroBanco, error: bairroErro } = await consultaBairro;

        if (bairroErro) {
          console.error('[PEDIDO MANUAL] Erro ao consultar bairro:', bairroErro.message);
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

        try {
          calculoFrete = await calcularFreteFn({
            restaurante,
            destino: null,
            bairro: bairroConfirmado.nome
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

        taxaCentavos = paraCentavos(calculoFrete?.taxa);

        if (taxaCentavos === null) {
          throw new Error('O motor de frete retornou uma taxa inválida.');
        }
      }

      // 7. Desconto (opcional): a taxa NUNCA é editada, o benefício fica registrado à parte
      let descontoCentavos = 0;

      if (desconto !== undefined && desconto !== null && desconto !== '') {
        descontoCentavos = paraCentavos(desconto);

        if (descontoCentavos === null) {
          return respostaErro(res, 400, 'Desconto inválido.', 'DESCONTO_INVALIDO');
        }
      }

      const brutoCentavos = subtotalCentavos + taxaCentavos;

      if (descontoCentavos > brutoCentavos) {
        return respostaErro(
          res,
          400,
          'O desconto não pode ser maior que o valor dos itens somado à entrega.',
          'DESCONTO_INVALIDO'
        );
      }

      let motivoDesconto = null;

      if (desconto_motivo !== undefined && desconto_motivo !== null && String(desconto_motivo).trim() !== '') {
        motivoDesconto = sanitizarTexto(desconto_motivo, 1, MAX_MOTIVO_DESCONTO);

        if (!motivoDesconto) {
          return respostaErro(
            res,
            400,
            `O motivo do desconto pode ter até ${MAX_MOTIVO_DESCONTO} caracteres.`,
            'MOTIVO_INVALIDO'
          );
        }
      }

      // Motivo sem desconto não faz sentido: descarta
      if (descontoCentavos === 0) motivoDesconto = null;

      const totalCentavos = brutoCentavos - descontoCentavos;

      if (!Number.isSafeInteger(totalCentavos) || totalCentavos < 0) {
        throw new Error('Total do pedido fora do limite permitido.');
      }

      // 8. Pagamento e troco
      const pagamento = sanitizarTexto(forma_pagamento || 'dinheiro', 2, 30)?.toLowerCase();

      if (!pagamento || !FORMAS_PAGAMENTO.includes(pagamento)) {
        return respostaErro(res, 400, 'Forma de pagamento inválida.', 'PAGAMENTO_INVALIDO');
      }

      let trocoCentavos = null;

      if (
        pagamento === 'dinheiro' &&
        totalCentavos > 0 &&
        troco_para !== undefined &&
        troco_para !== null &&
        troco_para !== ''
      ) {
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

      // 9. Status inicial: lojista já confirmou, então só o Pix espera pagamento
      const status = pagamento === 'pix' && totalCentavos > 0 ? 'pendente_pagamento' : 'preparando';

      const observacaoFinal = sanitizarTexto(observacao || '', 0, MAX_OBSERVACAO);

      const novoPedidoPayload = {
        restaurante_id: restaurante.id,
        cliente_nome: nome,
        cliente_whatsapp: telefone,
        endereco_completo: endereco,
        bairro_id: bairroConfirmado?.id || null,
        frete_tipo: calculoFrete?.frete_tipo ?? null,
        distancia_km: calculoFrete?.distancia_km ?? null,
        subtotal: deCentavos(subtotalCentavos),
        taxa_entrega: deCentavos(taxaCentavos),
        desconto: deCentavos(descontoCentavos),
        desconto_motivo: motivoDesconto,
        total: deCentavos(totalCentavos),
        status,
        itens: itensValidados,
        forma_pagamento: pagamento,
        troco_para: trocoCentavos === null ? null : deCentavos(trocoCentavos),
        observacao: observacaoFinal || null,
        origem: 'manual',
        tipo_atendimento: tipo
      };

      const tempoValidacao = Date.now() - tempoInicio;
      const tempoAntesInsert = Date.now();

      const { data: pedidoCriado, error: insertErro } = await db
        .from('pedidos')
        .insert([novoPedidoPayload])
        .select('id, total, status, created_at')
        .single();

      if (insertErro || !pedidoCriado) {
        console.error('[PEDIDO MANUAL] Erro ao inserir pedido:', insertErro?.message);
        return respostaErro(res, 500, 'Falha ao registrar pedido no banco de dados.', 'ERRO_PERSISTENCIA');
      }

      console.log(
        `[PEDIDO MANUAL] tempos: validação=${tempoValidacao}ms, gravação=${Date.now() - tempoAntesInsert}ms, total=${Date.now() - tempoInicio}ms`
      );

      return res.status(201).json({
        sucesso: true,
        mensagem: 'Pedido registrado com sucesso!',
        pedido: {
          id: pedidoCriado.id,
          subtotal: deCentavos(subtotalCentavos),
          taxa_entrega: deCentavos(taxaCentavos),
          desconto: deCentavos(descontoCentavos),
          total: pedidoCriado.total,
          status: pedidoCriado.status,
          created_at: pedidoCriado.created_at,
          tipo_atendimento: tipo
        }
      });
    } catch (erro) {
      console.error('[ERRO CRÍTICO - PEDIDO MANUAL]:', erro.message);

      return respostaErro(res, 500, 'Falha interna ao processar o pedido.', 'ERRO_INTERNO');
    }
  }

  return { criarPedidoManual };
}

export const { criarPedidoManual } = criarControladorPedidoManual();
