import { supabaseAdmin } from '../config/supabase.js';
import { calcularFrete, FreteError } from '../services/frete.js';

function sanitizarTexto(texto, minLen, maxLen) {
  if (typeof texto !== 'string') return null;
  const limpo = texto.trim();
  if (limpo.length < minLen || limpo.length > maxLen) return null;
  return limpo;
}

export async function criarPedido(req, res) {
  try {
    const {
      restaurante_id,
      cliente_nome,
      cliente_whatsapp: whatsappInput,
      cliente_phone: phoneInput,
      endereco_completo,
      bairro_id,
      bairro_nome: bairroNomeInput,
      cliente_lat,
      cliente_lon,
      itens,
      forma_pagamento,
      troco_para,
      observacao_geral,
      observacao
    } = req.body || {};

    // 1. Normalização dos dados do cliente (Compatibilidade Frontend <-> Backend)
    const rawWhatsapp = whatsappInput || phoneInput || '';
    const rawObservacao = observacao_geral || observacao || '';
    const nomeValidado = sanitizarTexto(cliente_nome, 2, 80);
    const enderecoValidado = sanitizarTexto(endereco_completo, 5, 200);
    const restIdValidado = sanitizarTexto(restaurante_id, 10, 50);

    if (!restIdValidado) {
      return res.status(400).json({ erro: 'ID do restaurante é obrigatório.' });
    }
    if (!nomeValidado) {
      return res.status(400).json({ erro: 'Nome do cliente deve ter entre 2 e 80 caracteres.' });
    }
    if (!enderecoValidado) {
      return res.status(400).json({ erro: 'Endereço completo deve ter entre 5 e 200 caracteres.' });
    }
    if (!Array.isArray(itens) || itens.length === 0 || itens.length > 30) {
      return res.status(400).json({ erro: 'O pedido deve conter entre 1 e 30 itens.' });
    }

    // 2. Consulta do restaurante no Supabase via Service Role
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

    // 3. Normalização e validação dos itens em lote (Zero-Trust)
    const itensNormalizados = itens.map(i => ({
      produto_id: i.produto_id || i.id,
      quantidade: parseInt(i.quantidade || i.qtd, 10),
      observacao: i.observacao || ''
    }));

    const idsProdutos = [...new Set(itensNormalizados.map(i => i.produto_id).filter(Boolean))];

    if (idsProdutos.length === 0) {
      return res.status(400).json({ erro: 'Nenhum produto válido foi informado.' });
    }

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

    for (const item of itensNormalizados) {
      const { produto_id: prodId, quantidade: qtd, observacao: obsItem } = item;

      if (!prodId || isNaN(qtd) || qtd <= 0 || qtd > 50) {
        return res.status(400).json({ erro: 'Quantidade ou ID de produto inválido.' });
      }

      const produto = mapaProdutos.get(prodId);

      if (!produto) {
        return res.status(400).json({ erro: `O produto com ID ${prodId} não pertence a este restaurante.` });
      }
      if (!produto.disponivel) {
        return res.status(422).json({ erro: `O produto "${produto.nome}" está indisponível no momento.` });
      }

      const precoUnitario = Number(produto.preco);
      const subtotalItem = Number((precoUnitario * qtd).toFixed(2));
      subtotalCalculado += subtotalItem;

      itensEnriquecidos.push({
        produto_id: produto.id,
        nome: produto.nome,
        preco_unitario: precoUnitario,
        quantidade: qtd,
        subtotal: subtotalItem,
        observacao: sanitizarTexto(obsItem, 0, 100) || null
      });
    }

    subtotalCalculado = Number(subtotalCalculado.toFixed(2));

    // 4. Resolução do nome do bairro se enviado apenas o bairro_id
    let nomeBairroParaFrete = sanitizarTexto(bairroNomeInput || '', 2, 80);
    let idBairroConfirmado = bairro_id || null;

    if (bairro_id && !nomeBairroParaFrete) {
      const { data: bairroBanco } = await supabaseAdmin
        .from('bairros')
        .select('id, nome')
        .eq('id', bairro_id)
        .eq('restaurante_id', restaurante.id)
        .maybeSingle();

      if (bairroBanco) {
        nomeBairroParaFrete = bairroBanco.nome;
        idBairroConfirmado = bairroBanco.id;
      }
    }

    // 5. Chamada ao Motor de Frete (frete.js)
    let calculoFrete = null;
    try {
      calculoFrete = await calcularFrete({
        restaurante,
        destino: (cliente_lat !== undefined && cliente_lon !== undefined) 
          ? { lat: cliente_lat, lon: cliente_lon } 
          : null,
        bairro: nomeBairroParaFrete
      });
    } catch (errFrete) {
      if (errFrete instanceof FreteError) {
        return res.status(errFrete.status).json({
          erro: errFrete.message,
          codigo: errFrete.code,
          detalhes: errFrete.detalhes
        });
      }
      throw errFrete;
    }

    const taxaEntregaCalculada = Number(calculoFrete.taxa.toFixed(2));
    const totalCalculado = Number((subtotalCalculado + taxaEntregaCalculada).toFixed(2));

    // 6. Registra o pedido no Supabase
    const novoPedidoPayload = {
      restaurante_id: restaurante.id,
      cliente_nome: nomeValidado,
      cliente_whatsapp: sanitizarTexto(rawWhatsapp, 0, 20),
      endereco_completo: enderecoValidado,
      bairro_id: idBairroConfirmado,
      frete_tipo: calculoFrete.frete_tipo,
      distancia_km: calculoFrete.distancia_km || null,
      subtotal: subtotalCalculado,
      taxa_entrega: taxaEntregaCalculada,
      total: totalCalculado,
      status: 'pendente_pagamento',
      itens: itensEnriquecidos,
      forma_pagamento: sanitizarTexto(forma_pagamento || 'pix', 2, 30),
      troco_para: troco_para ? Number(Number(troco_para).toFixed(2)) : null,
      observacao: sanitizarTexto(rawObservacao, 0, 250) || null
    };

    const { data: pedidoCriado, error: insertErro } = await supabaseAdmin
      .from('pedidos')
      .insert([novoPedidoPayload])
      .select('id, total, status, created_at')
      .single();

    if (insertErro || !pedidoCriado) {
      throw new Error(`Erro ao inserir pedido no Supabase: ${insertErro?.message}`);
    }

    return res.status(201).json({
      sucesso: true,
      mensagem: 'Pedido registrado com sucesso!',
      pedido: {
        id: pedidoCriado.id,
        subtotal: subtotalCalculado,
        taxa_entrega: taxaEntregaCalculada,
        total: pedidoCriado.total,
        status: pedidoCriado.status,
        created_at: pedidoCriado.created_at,
        frete_tipo: calculoFrete.frete_tipo,
        requer_confirmacao: calculoFrete.requer_confirmacao || false
      }
    });

  } catch (error) {
    console.error('[ERRO CRÍTICO - CRIAR PEDIDO]:', error.message);
    return res.status(500).json({
      erro: 'Falha interna ao processar o pedido. Nenhuma cobrança foi gerada.'
    });
  }
}
