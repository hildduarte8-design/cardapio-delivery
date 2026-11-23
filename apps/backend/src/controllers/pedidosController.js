
// Rota /api/pedidos — pedido feito pelo cliente no cardápio público.
import { createHash } from 'node:crypto';
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
import { registrarClienteESelo } from '../utils/clientesSelos.js';
import { avisarLojistaPedidoNovo } from '../services/pushLojista.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function calcularHashIdempotencia(dados) {
  const conteudoCanonico = JSON.stringify(dados);

  return createHash('sha256')
    .update(conteudoCanonico, 'utf8')
    .digest('hex');
}

function montarRespostaPedido(pedido, {
  reutilizado = false,
  requerConfirmacao = false
} = {}) {
  return {
    sucesso: true,
    mensagem: reutilizado
      ? 'Pedido já registrado anteriormente.'
      : 'Pedido registrado com sucesso!',
    ...(reutilizado ? { reutilizado: true } : {}),
    pedido: {
      id: pedido.id,
      subtotal: pedido.subtotal,
      taxa_entrega: pedido.taxa_entrega,
      total: pedido.total,
      status: pedido.status,
      created_at: pedido.created_at,
      frete_tipo: pedido.frete_tipo ?? null,
      requer_confirmacao: requerConfirmacao
    }
  };
}

async function buscarPedidoPorChave(db, restauranteId, chave) {
  return db
    .from('pedidos')
    .select('id, subtotal, taxa_entrega, total, status, created_at, frete_tipo, idempotencia_hash')
    .eq('restaurante_id', restauranteId)
    .eq('chave_idempotencia', chave)
    .maybeSingle();
}

function respostaConflito(res) {
  return respostaErro(
    res,
    409,
    'Esta tentativa já foi utilizada com outros dados. Inicie uma nova tentativa de pedido.',
    'IDEMPOTENCIA_CONFLITO'
  );
}

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
        chave_idempotencia,
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
      const temChaveIdempotencia = chave_idempotencia !== undefined &&
        chave_idempotencia !== null &&
        chave_idempotencia !== '';

      // 1. Dados básicos do cliente e do pedido
      const restauranteId = sanitizarTexto(restaurante_id, 1, 50);
      const nome = sanitizarTexto(cliente_nome, 2, 80);
      const endereco = retirada
        ? 'Retirada no balcão'
        : sanitizarTexto(endereco_completo, 5, 200);
      const telefone = normalizarTelefone(cliente_whatsapp || cliente_phone);

      if (!restauranteId) {
        return respostaErro(
          res,
          400,
          'ID do restaurante é obrigatório.',
          'RESTAURANTE_INVALIDO'
        );
      }

      if (!nome) {
        return respostaErro(
          res,
          400,
          'Nome do cliente inválido.',
          'NOME_INVALIDO'
        );
      }

      if (telefone.length < 10 || telefone.length > 13) {
        return respostaErro(
          res,
          400,
          'WhatsApp inválido com DDD.',
          'WHATSAPP_INVALIDO'
        );
      }

      if (!endereco) {
        return respostaErro(
          res,
          400,
          'Endereço completo inválido.',
          'ENDERECO_INVALIDO'
        );
      }

      if (!Array.isArray(itens) || itens.length === 0 || itens.length > MAX_ITENS) {
        return respostaErro(
          res,
          400,
          `O pedido deve conter entre 1 e ${MAX_ITENS} itens.`,
          'CARRINHO_INVALIDO'
        );
      }

      if (temChaveIdempotencia && (
        typeof chave_idempotencia !== 'string' ||
        !UUID_REGEX.test(chave_idempotencia)
      )) {
        return respostaErro(
          res,
          400,
          'Chave de idempotência inválida.',
          'CHAVE_IDEMPOTENCIA_INVALIDA'
        );
      }

      const temCoordenadas = coordenadasValidas(cliente_lat, cliente_lon);

      if ((cliente_lat != null || cliente_lon != null) && !temCoordenadas) {
        return respostaErro(
          res,
          400,
          'As coordenadas de entrega são inválidas.',
          'COORDENADAS_INVALIDAS'
        );
      }

      if (!retirada && !bairro_id && !temCoordenadas) {
        return respostaErro(
          res,
          400,
          'Informe o bairro de entrega ou a localização do endereço.',
          'LOCALIZACAO_OBRIGATORIA'
        );
      }

      // 2. Normalização rigorosa dos itens
      const itensNormalizados = [];

      for (const item of itens) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return respostaErro(
            res,
            400,
            'Item do carrinho inválido.',
            'ITEM_INVALIDO'
          );
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
          return respostaErro(
            res,
            400,
            'Produto ou quantidade inválida.',
            'QUANTIDADE_INVALIDA'
          );
        }

        itensNormalizados.push({
          produto_id: produtoId.trim(),
          quantidade,
          observacao: sanitizarTexto(item.observacao || '', 0, 100)
        });
      }

      // 3. Validação do pagamento e normalização dos dados
      const FORMAS_PAGAMENTO = ['pix', 'dinheiro', 'cartao'];
      const pagamento = sanitizarTexto(
        forma_pagamento || 'pix',
        2,
        30
      )?.toLowerCase();

      if (!pagamento || !FORMAS_PAGAMENTO.includes(pagamento)) {
        return respostaErro(
          res,
          400,
          'Forma de pagamento inválida.',
          'PAGAMENTO_INVALIDO'
        );
      }

      let trocoCentavos = null;

      const trocoInformado =
        troco_para !== undefined &&
        troco_para !== null &&
        troco_para !== '';

      // Troco só existe para pagamento em dinheiro.
      if (pagamento === 'dinheiro' && trocoInformado) {
        trocoCentavos = paraCentavos(troco_para);

        if (trocoCentavos === null) {
          return respostaErro(
            res,
            400,
            'O valor informado para troco é inválido.',
            'TROCO_INVALIDO'
          );
        }
      }

      const observacaoFinal = sanitizarTexto(
        observacao_geral || observacao || '',
        0,
        MAX_OBSERVACAO
      );

      // A cotação inválida continua sendo ignorada, como no fluxo original.
      const taxaCotadaBruta = req.body?.taxa_cotada;
      const taxaCotadaCentavos =
        taxaCotadaBruta === undefined || taxaCotadaBruta === null
          ? null
          : paraCentavos(taxaCotadaBruta);

      // 4. Hash do conteúdo normalizado.
      // Não inclui preços ou frete atuais, pois são dados mutáveis.
      const dadosParaHash = {
        restaurante_id: restauranteId,
        cliente_nome: nome,
        cliente_whatsapp: telefone,
        endereco_completo: endereco,
        bairro_id: retirada ? null : (bairro_id || null),
        cliente_lat: temCoordenadas && !retirada
          ? Number(cliente_lat)
          : null,
        cliente_lon: temCoordenadas && !retirada
          ? Number(cliente_lon)
          : null,
        itens: itensNormalizados,
        forma_pagamento: pagamento,
        troco_centavos: pagamento === 'dinheiro'
          ? trocoCentavos
          : null,
        observacao: observacaoFinal || null,
        tipo_atendimento: retirada ? 'retirada' : 'entrega',
        taxa_cotada_centavos: taxaCotadaCentavos
      };

      const idempotenciaHash = temChaveIdempotencia
        ? calcularHashIdempotencia(dadosParaHash)
        : null;

      // 5. Recuperação antecipada.
      // A consulta ocorre antes de validar preços, disponibilidade e frete atuais.
      if (temChaveIdempotencia) {
        const { data: pedidoExistente, error: buscaErro } =
          await buscarPedidoPorChave(
            db,
            restauranteId,
            chave_idempotencia
          );

        if (buscaErro) {
          console.error(
            '[PEDIDO] Falha ao consultar idempotência:',
            buscaErro.code || 'ERRO_CONSULTA'
          );

          return respostaErro(
            res,
            500,
            'Não foi possível verificar a tentativa anterior.',
            'ERRO_IDEMPOTENCIA'
          );
        }

        if (pedidoExistente) {
          if (pedidoExistente.idempotencia_hash !== idempotenciaHash) {
            return respostaConflito(res);
          }

          return res.status(200).json(
            montarRespostaPedido(pedidoExistente, {
              reutilizado: true,
              // No serviço atual, somente o frete estimado exige confirmação.
              requerConfirmacao: pedidoExistente.frete_tipo === 'estimado'
            })
          );
        }
      }

      // 6. Restaurante
      const { data: restaurante, error: restErro } = await db
        .from('restaurantes')
        .select('id, nome, ativo, loja_lat, loja_lon, taxa_base, valor_km, raio_max_km, frete_por_distancia')
        .eq('id', restauranteId)
        .maybeSingle();

      if (restErro) {
        console.error(
          '[PEDIDO] Erro ao consultar restaurante:',
          restErro.code || 'ERRO_CONSULTA'
        );

        return respostaErro(
          res,
          500,
          'Não foi possível validar o restaurante.',
          'ERRO_CONSULTA_RESTAURANTE'
        );
      }

      if (!restaurante) {
        return respostaErro(
          res,
          404,
          'Restaurante não localizado.',
          'RESTAURANTE_NAO_ENCONTRADO'
        );
      }

      if (!restaurante.ativo) {
        return respostaErro(
          res,
          422,
          'O restaurante está com as operações encerradas.',
          'RESTAURANTE_INATIVO'
        );
      }

      // 7. Consulta de produtos por IDs únicos
      const idsProdutos = [
        ...new Set(itensNormalizados.map(item => item.produto_id))
      ];

      const { data: produtosBanco, error: produtosErro } = await db
        .from('produtos')
        .select('id, nome, preco, preco_promocional, disponivel, restaurante_id')
        .in('id', idsProdutos)
        .eq('restaurante_id', restaurante.id);

      if (produtosErro) {
        console.error(
          '[PEDIDO] Erro ao consultar produtos:',
          produtosErro.code || 'ERRO_CONSULTA'
        );

        return respostaErro(
          res,
          500,
          'Não foi possível validar os produtos.',
          'ERRO_CONSULTA_PRODUTOS'
        );
      }

      const mapaProdutos = new Map(
        (produtosBanco || []).map(produto => [produto.id, produto])
      );

      if (mapaProdutos.size !== idsProdutos.length) {
        return respostaErro(
          res,
          422,
          'Um ou mais produtos são inválidos ou não pertencem a este restaurante.',
          'PRODUTO_INVALIDO'
        );
      }

      // 8. Validação de disponibilidade e cálculo do subtotal
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

        const promo = Number(produto.preco_promocional);
        const precoVenda =
          promo > 0 && promo < Number(produto.preco)
            ? produto.preco_promocional
            : produto.preco;

        const precoCentavos = paraCentavos(precoVenda);

        if (precoCentavos === null || precoCentavos <= 0) {
          console.error(
            '[PEDIDO] Produto com preço inválido:',
            produto.id
          );

          return respostaErro(
            res,
            500,
            'Um produto possui preço inválido no cadastro.',
            'PRECO_PRODUTO_INVALIDO'
          );
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
        return respostaErro(
          res,
          400,
          'Subtotal do pedido inválido.',
          'SUBTOTAL_INVALIDO'
        );
      }

      // 9. Validação estrita do bairro, sempre consultando o banco
      let bairroConfirmado = null;

      if (!retirada && bairro_id) {
        if (typeof bairro_id !== 'string' || !bairro_id.trim()) {
          return respostaErro(
            res,
            422,
            'Bairro inválido.',
            'BAIRRO_INVALIDO'
          );
        }

        const { data: bairroBanco, error: bairroErro } = await db
          .from('bairros')
          .select('id, nome, taxa, restaurante_id, ativo')
          .eq('id', bairro_id)
          .eq('restaurante_id', restaurante.id)
          .maybeSingle();

        if (bairroErro) {
          console.error(
            '[PEDIDO] Erro ao consultar bairro:',
            bairroErro.code || 'ERRO_CONSULTA'
          );

          return respostaErro(
            res,
            500,
            'Não foi possível validar o bairro.',
            'ERRO_CONSULTA_BAIRRO'
          );
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

      // 10. Cálculo do frete no servidor
      let calculoFrete;

      try {
        calculoFrete = retirada
          ? {
              taxa: 0,
              frete_tipo: null,
              distancia_km: null,
              requer_confirmacao: false
            }
          : await calcularFreteFn({
              restaurante,
              destino: (temCoordenadas && restaurante.frete_por_distancia === true)
                ? {
                    lat: Number(cliente_lat),
                    lon: Number(cliente_lon)
                  }
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

      // A cotação enviada pelo cardápio precisa bater com o frete recalculado.
      if (
        !retirada &&
        taxaCotadaCentavos !== null &&
        taxaCotadaCentavos !== taxaCentavos
      ) {
        return res.status(409).json({
          erro: 'O valor do frete mudou. Confira o novo valor antes de finalizar.',
          codigo: 'FRETE_DIVERGENTE',
          detalhes: {
            taxa: deCentavos(taxaCentavos),
            taxa_centavos: taxaCentavos,
            frete_tipo: calculoFrete.frete_tipo,
            requer_confirmacao: calculoFrete.requer_confirmacao || false
          }
        });
      }

      const totalCentavos = subtotalCentavos + taxaCentavos;

      if (!Number.isSafeInteger(totalCentavos)) {
        throw new Error('Total do pedido excedeu o limite permitido.');
      }

      // A comparação com o total só pode ocorrer depois de calcular
      // os preços e o frete atuais. Em uma repetição idêntica, a recuperação
      // antecipada já terá retornado o pedido original.
      if (
        pagamento === 'dinheiro' &&
        trocoCentavos !== null &&
        trocoCentavos < totalCentavos
      ) {
        return respostaErro(
          res,
          400,
          'O valor informado para troco deve ser igual ou maior que o total.',
          'TROCO_INVALIDO'
        );
      }

      // 11. Payload final
      const novoPedidoPayload = {
        restaurante_id: restaurante.id,
        cliente_nome: nome,
        cliente_whatsapp: telefone,
        endereco_completo: endereco,
        bairro_id: bairroConfirmado?.id || null,
        frete_tipo: calculoFrete.frete_tipo,
        distancia_km: calculoFrete.distancia_km ?? null,
        cliente_lat: (temCoordenadas && !retirada)
          ? Number(cliente_lat)
          : null,
        cliente_lon: (temCoordenadas && !retirada)
          ? Number(cliente_lon)
          : null,
        subtotal: deCentavos(subtotalCentavos),
        taxa_entrega: deCentavos(taxaCentavos),
        total: deCentavos(totalCentavos),
        status: 'pendente_pagamento',
        itens: itensValidados,
        forma_pagamento: pagamento,
        troco_para: trocoCentavos === null
          ? null
          : deCentavos(trocoCentavos),
        observacao: observacaoFinal || null,
        origem: 'cardapio',
        tipo_atendimento: retirada ? 'retirada' : 'entrega',
        ...(temChaveIdempotencia
          ? {
              chave_idempotencia: chave_idempotencia,
              idempotencia_hash: idempotenciaHash
            }
          : {})
      };

      // 12. Gravação
      const { data: pedidoCriado, error: insertErro } = await db
        .from('pedidos')
        .insert([novoPedidoPayload])
        .select('id, total, status, created_at')
        .single();

      if (insertErro || !pedidoCriado) {
        // Duas requisições simultâneas podem tentar gravar a mesma chave.
        // O índice único decide qual delas vence.
        if (
          temChaveIdempotencia &&
          insertErro?.code === '23505'
        ) {
          const { data: pedidoConcorrente, error: buscaConcorrenteErro } =
            await buscarPedidoPorChave(
              db,
              restaurante.id,
              chave_idempotencia
            );

          if (!buscaConcorrenteErro && pedidoConcorrente) {
            if (pedidoConcorrente.idempotencia_hash !== idempotenciaHash) {
              return respostaConflito(res);
            }

            return res.status(200).json(
              montarRespostaPedido(pedidoConcorrente, {
                reutilizado: true,
                requerConfirmacao:
                  pedidoConcorrente.frete_tipo === 'estimado'
              })
            );
          }
        }

        console.error(
          '[PEDIDO] Erro ao inserir pedido:',
          insertErro?.code || 'ERRO_PERSISTENCIA'
        );

        return respostaErro(
          res,
          500,
          'Falha ao registrar pedido no banco de dados.',
          'ERRO_PERSISTENCIA'
        );
      }

      // 13. Efeitos posteriores.
      // Uma falha nesses efeitos não deve informar ao cliente que o pedido
      // falhou depois de ele já ter sido gravado.
      try {
        await registrarClienteESelo(db, {
          restauranteId: restaurante.id,
          nome,
          telefone,
          endereco,
          total: deCentavos(subtotalCentavos),
          retirada
        });
      } catch (erroSelo) {
        console.error(
          '[PEDIDO] Falha ao registrar cliente/selo:',
          erroSelo?.name || 'ERRO'
        );
      }

      try {
        avisarLojistaPedidoNovo();
      } catch (erroPush) {
        console.error(
          '[PEDIDO] Falha ao iniciar aviso push:',
          erroPush?.name || 'ERRO'
        );
      }

      // 14. Resposta da primeira criação.
      // Mantém os valores calculados e a propriedade original do motor de frete.
      return res.status(201).json(
        montarRespostaPedido({
          id: pedidoCriado.id,
          subtotal: deCentavos(subtotalCentavos),
          taxa_entrega: deCentavos(taxaCentavos),
          total: pedidoCriado.total,
          status: pedidoCriado.status,
          created_at: pedidoCriado.created_at,
          frete_tipo: calculoFrete.frete_tipo
        }, {
          requerConfirmacao: calculoFrete.requer_confirmacao || false
        })
      );
    } catch (erro) {
      // Não registrar a mensagem completa para evitar exposição acidental
      // de credenciais ou dados sensíveis em logs.
      console.error(
        '[ERRO CRÍTICO - CRIAR PEDIDO]:',
        erro?.name || 'Erro desconhecido'
      );

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
