import { supabaseAdmin } from '../config/supabase.js';
import { calcularDistanciaKm } from '../services/frete.js';

// ==========================================
// FUNÇÕES AUXILIARES DE VALIDAÇÃO E SANITIZAÇÃO
// ==========================================

function sanitizarTexto(texto, minLen, maxLen) {
  if (typeof texto !== 'string') return null;
  const limpo = texto.trim();
  if (limpo.length < minLen || limpo.length > maxLen) return null;
  return limpo;
}

function validarCoordenadas(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  const latValida = Number.isFinite(latitude) && Math.abs(latitude) <= 90;
  const lonValida = Number.isFinite(longitude) && Math.abs(longitude) <= 180;
  return latValida && lonValida ? { lat: latitude, lon: longitude } : null;
}

// ==========================================
// CONTROLADOR PRINCIPAL DE CRIAÇÃO DE PEDIDOS
// ==========================================

export async function criarPedido(req, res) {
  try {
    const {
      restaurante_id,
      cliente_nome,
      cliente_whatsapp,
      endereco_completo,
      bairro_id,
      cliente_lat,
      cliente_lon,
      itens,
      forma_pagamento,
      troco_para,
      observacao_geral
    } = req.body || {};

    // 1. Validação estrita dos dados do cliente
    const nomeValidado = sanitizarTexto(cliente_nome, 2, 80);
    const enderecoValidado = sanitizarTexto(endereco_completo, 5, 200);
    const restIdValidado = sanitizarTexto(restaurante_id, 10, 50);

    if (!restIdValidado) {
      return res.status(400).json({ erro: 'ID do restaurante é obrigatório e inválido.' });
    }
    if (!nomeValidado) {
      return res.status(400).json({ erro: 'Nome do cliente deve ter entre 2 e 80 caracteres.' });
    }
    if (!enderecoValidado) {
      return res.status(400).json({ erro: 'Endereço completo deve ter entre 5 e 200 caracteres.' });
    }

    // Validação básica do array de itens
    if (!Array.isArray(itens) || itens.length === 0 || itens.length > 30) {
      return res.status(400).json({ erro: 'O pedido deve conter entre 1 e 30 itens.' });
    }

    // 2. Busca o restaurante e verifica se está ativo
    const { data: restaurante, error: restErro } = await supabaseAdmin
      .from('restaurantes')
      .select('id, nome, ativo, loja_lat, loja_lon, taxa_base, valor_km, raio_max_km')
      .eq('id', restIdValidado)
      .maybeSingle();

    if (restErro || !restaurante) {
      return res.status(404).json({ erro: 'Restaurante não localizado na base de dados.' });
    }
    if (!restaurante.ativo) {
      return res.status(422).json({ erro: 'O restaurante está com as operações encerradas no momento.' });
    }

    // 3. Validação dos produtos e recálculo do subtotal (Zero-Trust)
    const idsProdutos = [...new Set(itens.map(i => i.produto_id).filter(Boolean))];
    
    if (idsProdutos.length === 0) {
      return res.status(400).json({ erro: 'Nenhum produto válido foi informado no carrinho.' });
    }

    // Consulta todos os produtos envolvidos de uma só vez (Performance/1 Round-trip)
    const { data: produtosBanco, error: prodErro } = await supabaseAdmin
      .from('produtos')
      .select('id, nome, preco, disponivel, restaurante_id')
      .in('id', idsProdutos)
      .eq('restaurante_id', restaurante.id);

    if (prodErro || !produtosBanco) {
      return res.status(500).json({ erro: 'Erro ao validar os produtos no banco de dados.' });
    }

    const mapaProdutos = new Map(produtosBanco.map(p => [p.id, p]));
    let subtotalCalculado = 0;
    const itensEnriquecidos = [];

    for (const item of itens) {
      const prodId = item.produto_id;
      const qtd = parseInt(item.quantidade, 10);
      const obsItem = sanitizarTexto(item.observacao || '', 0, 100);

      if (!prodId || isNaN(qtd) || qtd <= 0 || qtd > 50) {
        return res.status(400).json({ erro: 'Quantidade ou item com formato inválido.' });
      }

      const produto = mapaProdutos.get(prodId);

      if (!produto) {
        return res.status(400).json({ erro: `Produto com ID ${prodId} não pertence a este cardápio.` });
      }
      if (!produto.disponivel) {
        return res.status(422).json({ erro: `O produto "${produto.nome}" está indisponível no momento.` });
      }

      const precoUnitario = Number(produto.preco);
      const subtotalItem = Number((precoUnitario * qtd).toFixed(2));
      subtotalCalculado += subtotalItem;

      // Cria o snapshot imutável para a comanda
      itensEnriquecidos.push({
        produto_id: produto.id,
        nome: produto.nome,
        preco_unitario: precoUnitario,
        quantidade: qtd,
        subtotal: subtotalItem,
        observacao: obsItem || null
      });
    }

    subtotalCalculado = Number(subtotalCalculado.toFixed(2));

    // 4. Recálculo da taxa de entrega e modalidade de frete
    let taxaEntregaCalculada = 0;
    let freteTipo = 'bairro';
    let distanciaKmCalculada = null;

    if (cliente_lat !== undefined && cliente_lon !== undefined) {
      const coordsCliente = validarCoordenadas(cliente_lat, cliente_lon);
      const coordsLoja = validarCoordenadas(restaurante.loja_lat, restaurante.loja_lon);

      if (coordsCliente && coordsLoja) {
        distanciaKmCalculada = await calcularDistanciaKm(
          coordsLoja.lat,
          coordsLoja.lon,
          coordsCliente.lat,
          coordsCliente.lon
        );

        if (restaurante.raio_max_km > 0 && distanciaKmCalculada > restaurante.raio_max_km) {
          return res.status(400).json({
            erro: `Endereço excede o raio máximo de entrega (${restaurante.raio_max_km}km).`
          });
        }

        taxaEntregaCalculada = Number(restaurante.taxa_base) + (distanciaKmCalculada * Number(restaurante.valor_km));
        freteTipo = 'gps';
      }
    }

    // Fallback ou opção direta por bairro cadastrado
    if (freteTipo === 'bairro' && bairro_id) {
      const { data: bairro, error: bairroErro } = await supabaseAdmin
        .from('bairros')
        .select('taxa, ativo')
        .eq('id', bairro_id)
        .eq('restaurante_id', restaurante.id)
        .maybeSingle();

      if (bairroErro || !bairro || !bairro.ativo) {
        return res.status(400).json({ erro: 'Bairro selecionado é inválido ou não atendido.' });
      }

      taxaEntregaCalculada = Number(bairro.taxa);
    }

    taxaEntregaCalculada = Number(taxaEntregaCalculada.toFixed(2));
    const totalCalculado = Number((subtotalCalculado + taxaEntregaCalculada).toFixed(2));

    // 5. Inserção final do pedido no Supabase via Service Role
    const novoPedidoPayload = {
      restaurante_id: restaurante.id,
      cliente_nome: nomeValidado,
      cliente_whatsapp: sanitizarTexto(cliente_whatsapp || '', 0, 20),
      endereco_completo: enderecoValidado,
      bairro_id: bairro_id || null,
      frete_tipo: freteTipo,
      distancia_km: distanciaKmCalculada ? Number(distanciaKmCalculada.toFixed(2)) : null,
      subtotal: subtotalCalculado,
      taxa_entrega: taxaEntregaCalculada,
      total: totalCalculado,
      status: 'pendente_pagamento',
      itens: itensEnriquecidos,
      forma_pagamento: sanitizarTexto(forma_pagamento || 'pix', 2, 30),
      troco_para: troco_para ? Number(Number(troco_para).toFixed(2)) : null,
      observacao: sanitizarTexto(observacao_geral || '', 0, 250) || null
    };

    const { data: pedidoCriado, error: insertErro } = await supabaseAdmin
      .from('pedidos')
      .insert([novoPedidoPayload])
      .select('id, total, status, created_at')
      .single();

    if (insertErro || !pedidoCriado) {
      throw new Error(`Erro de banco ao inserir pedido: ${insertErro?.message}`);
    }

    // 6. Resposta com o pedido registrado
    return res.status(201).json({
      sucesso: true,
      mensagem: 'Pedido recebido com sucesso!',
      pedido: {
        id: pedidoCriado.id,
        subtotal: subtotalCalculado,
        taxa_entrega: taxaEntregaCalculada,
        total: pedidoCriado.total,
        status: pedidoCriado.status,
        created_at: pedidoCriado.created_at
      }
    });

  } catch (error) {
    console.error('[ERRO CRÍTICO - CRIAR PEDIDO]:', error.message);
    return res.status(500).json({
      erro: 'Falha interna ao processar o pedido. Nenhuma cobrança foi gerada.'
    });
  }
}
