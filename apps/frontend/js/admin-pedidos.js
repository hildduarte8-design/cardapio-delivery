import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, aviso, tratarErro, atualizar, achar } from './admin-utils.js';

const STATUS = {
  pendente_pagamento: {
    rotulo: 'Aguardando Pix',
    cor: 'bg-yellow-100 text-yellow-700',
    prox: 'pago',
    acao: 'Confirmar pagamento'
  },
  pago: {
    rotulo: 'Pago',
    cor: 'bg-blue-100 text-blue-700',
    prox: 'preparando',
    acao: 'Iniciar preparo'
  },
  preparando: {
    rotulo: 'Em preparo',
    cor: 'bg-orange-100 text-orange-700',
    prox: 'saiu_entrega',
    acao: 'Saiu para entrega'
  },
  saiu_entrega: {
    rotulo: 'Saiu p/ entrega',
    cor: 'bg-purple-100 text-purple-700',
    prox: 'entregue',
    acao: 'Marcar entregue'
  },
  entregue: {
    rotulo: 'Entregue',
    cor: 'bg-green-100 text-green-700'
  },
  cancelado: {
    rotulo: 'Cancelado',
    cor: 'bg-gray-200 text-gray-600'
  }
};

const ENCERRADOS = ['entregue', 'cancelado'];

// Pedido em dinheiro/cartão não espera pagamento antecipado:
// no banco continua 'pendente_pagamento', mas no painel vira "Novo pedido".
const STATUS_NOVO_NA_ENTREGA = {
  rotulo: 'Novo pedido',
  cor: 'bg-yellow-100 text-yellow-700',
  prox: 'preparando',
  acao: 'Aceitar e preparar'
};

function formaDe(pedido) {
  return String(pedido.forma_pagamento || '').trim().toLowerCase();
}

function pagaNaEntrega(pedido) {
  return (
    pedido.status === 'pendente_pagamento' &&
    ['dinheiro', 'cartao', 'cartão'].includes(formaDe(pedido))
  );
}

function statusDe(pedido) {
  if (pagaNaEntrega(pedido)) return STATUS_NOVO_NA_ENTREGA;
  return STATUS[pedido.status] || null;
}

function rotuloPagamento(pedido) {
  const forma = formaDe(pedido);

  if (forma === 'pix') return 'Pix';
  if (forma === 'cartao' || forma === 'cartão') return 'Cartão na entrega';

  if (forma === 'dinheiro') {
    const troco = Number(pedido.troco_para) || 0;
    return troco > 0
      ? `Dinheiro · troco para ${brl.format(troco)}`
      : 'Dinheiro · sem troco';
  }

  return pedido.forma_pagamento || '';
}

function dataDoPedido(pedido) {
  return pedido.created_at || pedido.criado_em || null;
}

function hora(valor) {
  if (!valor) return '--:--';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '--:--';

  return data.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function minutosDesde(valor) {
  if (!valor) return 0;
  const data = new Date(valor).getTime();
  if (!Number.isFinite(data)) return 0;
  return Math.max(0, Math.round((Date.now() - data) / 60000));
}

function codigo(pedido) {
  return String(pedido.id || '').slice(-4).toUpperCase();
}

function itensDe(pedido) {
  try {
    const itens = typeof pedido.itens === 'string'
      ? JSON.parse(pedido.itens)
      : pedido.itens;

    return Array.isArray(itens) ? itens : [];
  } catch (error) {
    console.error('Não foi possível interpretar os itens do pedido:', error);
    return [];
  }
}

function quantidadeDoItem(item) {
  const quantidade = Number(item?.qtd ?? item?.quantidade ?? 0);
  return Number.isInteger(quantidade) && quantidade > 0
    ? quantidade
    : 0;
}

function telefoneDoPedido(pedido) {
  return String(
    pedido.cliente_whatsapp || pedido.cliente_phone || ''
  ).replace(/\D/g, '');
}

function nomeBairroPedido(pedido) {
  if (pedido.bairro) return pedido.bairro;

  const bairro = state.bairros.find(
    (item) => String(item.id) === String(pedido.bairro_id)
  );

  return bairro?.nome || 'Bairro não informado';
}

function desbloquearAudio() {
  try {
    state.audioCtx = state.audioCtx ||
      new (window.AudioContext || window.webkitAudioContext)();

    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
  } catch (error) {
    console.warn('Áudio não disponível neste navegador.', error);
  }
}

function beep() {
  if (!state.somLigado || !state.audioCtx) return;

  try {
    const tempo = state.audioCtx.currentTime;

    [0, 0.25].forEach((atraso) => {
      const oscilador = state.audioCtx.createOscillator();
      const ganho = state.audioCtx.createGain();

      oscilador.frequency.value = 880;
      ganho.gain.setValueAtTime(0.2, tempo + atraso);
      ganho.gain.exponentialRampToValueAtTime(0.001, tempo + atraso + 0.2);

      oscilador.connect(ganho);
      ganho.connect(state.audioCtx.destination);
      oscilador.start(tempo + atraso);
      oscilador.stop(tempo + atraso + 0.2);
    });
  } catch (error) {
    console.warn('Falha ao reproduzir aviso sonoro.', error);
  }
}

export async function carregarPedidos() {
  if (!state.rest || !sb) return;

  const { data, error } = await sb
    .from('pedidos')
    .select('*')
    .eq('restaurante_id', state.rest.id)
    .limit(100);

  if (error) {
    tratarErro(error, 'Erro ao carregar pedidos.');
    return;
  }

  const lista = (data || []).sort((a, b) => {
    return new Date(dataDoPedido(b) || 0) - new Date(dataDoPedido(a) || 0);
  });

  if (
    state.idsVistos &&
    lista.some((pedido) => !state.idsVistos.has(String(pedido.id)))
  ) {
    beep();
    aviso('🔔 Novo pedido!');
  }

  state.idsVistos = new Set(lista.map((pedido) => String(pedido.id)));
  state.pedidos = lista;
  renderPedidos();
}

export function iniciarPedidos() {
  if (state.timerPedidos || !state.rest || !sb) return;

  try {
    state.canalPedidos = sb
      .channel(`pedidos-${state.rest.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pedidos',
          filter: `restaurante_id=eq.${state.rest.id}`
        },
        carregarPedidos
      )
      .subscribe();
  } catch (error) {
    console.error('Não foi possível iniciar o Realtime:', error);
  }

  state.timerPedidos = setInterval(carregarPedidos, 30000);
}

export function pararPedidos() {
  if (state.canalPedidos && sb) {
    try {
      sb.removeChannel(state.canalPedidos);
    } catch (error) {
      console.warn('Erro ao encerrar canal de pedidos:', error);
    }
  }

  state.canalPedidos = null;
  clearInterval(state.timerPedidos);
  state.timerPedidos = null;
  state.pedidos = [];
  state.idsVistos = null;
}

export function renderPedidos() {
  const ativos = state.pedidos
    .filter((pedido) => !ENCERRADOS.includes(pedido.status))
    .sort((a, b) => {
      return new Date(dataDoPedido(a) || 0) - new Date(dataDoPedido(b) || 0);
    });

  const encerrados = state.pedidos.filter(
    (pedido) => ENCERRADOS.includes(pedido.status)
  );

  const badge = $('badge-pedidos');
  badge.innerText = ativos.length;
  badge.classList.toggle('hidden', ativos.length === 0);

  document.querySelectorAll('[data-filtro]').forEach((botao) => {
    botao.className =
      'flex-1 py-2 rounded-lg text-xs font-bold border ' +
      (botao.dataset.filtro === state.filtroPedidos
        ? 'bg-orange-600 text-white border-orange-600'
        : 'bg-white text-gray-700');
  });

  $('btn-som').innerText = state.somLigado ? '🔔' : '🔕';

  const lista = state.filtroPedidos === 'ativos' ? ativos : encerrados;

  $('lista-pedidos').innerHTML = lista.length
    ? lista.map((pedido) => {
        const status = statusDe(pedido) || {
          rotulo: pedido.status || '—',
          cor: 'bg-gray-100 text-gray-600'
        };

        const encerrado = ENCERRADOS.includes(pedido.status);

        const itensHTML = itensDe(pedido).map((item) => {
          return `<li>${quantidadeDoItem(item)}x ${esc(item.nome)}</li>`;
        }).join('');

        return `
          <div class="bg-white border rounded-xl p-3 space-y-2">
            <div class="flex justify-between items-start gap-2">
              <div class="min-w-0">
                <p class="font-bold text-sm truncate">${esc(pedido.cliente_nome)}</p>
                <p class="text-xs text-gray-500">
                  ${esc(hora(dataDoPedido(pedido)))}
                  ${encerrado ? '' : ` · há ${minutosDesde(dataDoPedido(pedido))} min`}
                  · #${esc(codigo(pedido))}
                </p>
              </div>
              <span class="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full ${status.cor}">
                ${esc(status.rotulo)}
              </span>
            </div>

            <ul class="text-sm">${itensHTML}</ul>

            <p class="text-xs text-gray-600">
              📍 ${esc(nomeBairroPedido(pedido))} — ${esc(pedido.endereco_completo)}
            </p>

            <div class="flex justify-between text-sm">
              <span class="text-xs text-gray-500">
                ${esc(rotuloPagamento(pedido))}
                · entrega ${brl.format(Number(pedido.taxa_entrega) || 0)}
              </span>
              <strong>${brl.format(Number(pedido.total) || 0)}</strong>
            </div>

            <div class="flex gap-2">
              ${
                status.prox
                  ? `<button data-avancar="${esc(pedido.id)}" class="flex-1 bg-green-600 text-white text-xs font-bold py-2 rounded-lg">${esc(status.acao)}</button>`
                  : '<span class="flex-1"></span>'
              }
              <button data-zap="${esc(pedido.id)}" class="px-3 py-2 text-xs font-bold rounded-lg border bg-green-50 text-green-700 border-green-200" aria-label="WhatsApp">WhatsApp</button>
              <button data-imprimir="${esc(pedido.id)}" class="px-3 py-2 text-xs rounded-lg border bg-white" aria-label="Imprimir comanda">🖨️</button>
              ${
                encerrado
                  ? ''
                  : `<button data-cancelar="${esc(pedido.id)}" class="px-3 py-2 text-xs font-bold rounded-lg border bg-red-50 text-red-600 border-red-200">Cancelar</button>`
              }
            </div>
          </div>
        `;
      }).join('')
    : `<p class="text-sm text-gray-500">${
        state.filtroPedidos === 'ativos'
          ? 'Nenhum pedido ativo no momento.'
          : 'Nenhum pedido encerrado ainda.'
      }</p>`;
}

function foneZap(pedido) {
  let numero = telefoneDoPedido(pedido);
  if (!numero) return null;

  if (!numero.startsWith('55') && numero.length <= 11) {
    numero = `55${numero}`;
  }

  return numero;
}

function textoZap(pedido) {
  const nome = String(pedido.cliente_nome || '').split(' ')[0];
  const valor = brl.format(Number(pedido.total) || 0);

  const mensagens = {
    pendente_pagamento: pagaNaEntrega(pedido)
      ? `Recebemos seu pedido de ${valor}! Já vamos confirmar e começar o preparo. O pagamento é na entrega (${rotuloPagamento(pedido).toLowerCase()}).`
      : `Recebemos seu pedido de ${valor}! Falta só o pagamento via Pix para confirmarmos.`,
    pago: 'Pagamento confirmado ✅ Já vamos preparar seu pedido!',
    preparando: 'Seu pedido está em preparo 👨‍🍳',
    saiu_entrega: 'Seu pedido saiu para entrega 🛵',
    entregue: 'Obrigado pela preferência! 🙏',
    cancelado: 'Seu pedido foi cancelado. Qualquer dúvida, é só responder aqui.'
  };

  return `Olá ${nome}! ${state.rest.nome}: ${mensagens[pedido.status] || 'Sobre o seu pedido:'}`;
}

function imprimirComanda(pedido) {
  const linhas = itensDe(pedido).map((item) => {
    const quantidade = quantidadeDoItem(item);
    const preco = Number(item.preco ?? item.preco_unitario) || 0;
    const subtotalItem = Number(item.subtotal) || preco * quantidade;

    return `
      <div class="item">
        <span>${quantidade}x ${esc(item.nome)}</span>
        <span>${brl.format(subtotalItem)}</span>
      </div>
      ${item.observacao ? `<div class="obs">Obs.: ${esc(item.observacao)}</div>` : ''}
    `;
  }).join('');

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font: 13px monospace; width: 58mm; margin: 0; padding: 4px; }
          h1 { font-size: 15px; margin: 0 0 4px; }
          hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
          .item { display: flex; justify-content: space-between; gap: 5px; padding: 2px 0; }
          .obs { font-size: 11px; padding-bottom: 3px; }
          .total { font-weight: bold; font-size: 15px; }
        </style>
      </head>
      <body>
        <h1>${esc(state.rest.nome)}</h1>
        <div>Pedido #${esc(codigo(pedido))} · ${esc(hora(dataDoPedido(pedido)))}</div>
        <hr>
        <div><b>Cliente:</b> ${esc(pedido.cliente_nome)}</div>
        <div><b>WhatsApp:</b> ${esc(telefoneDoPedido(pedido) || 'Não informado')}</div>
        <div><b>Bairro:</b> ${esc(nomeBairroPedido(pedido))}</div>
        <div><b>Endereço:</b> ${esc(pedido.endereco_completo)}</div>
        <hr>
        <b>ITENS DO PEDIDO</b>
        ${linhas}
        <hr>
        <div class="item"><span>Subtotal:</span><span>${brl.format(Number(pedido.subtotal) || 0)}</span></div>
        <div class="item"><span>Entrega:</span><span>${brl.format(Number(pedido.taxa_entrega) || 0)}</span></div>
        <hr>
        <div class="item total"><span>TOTAL:</span><span>${brl.format(Number(pedido.total) || 0)}</span></div>
        <div>Pagamento: ${esc(rotuloPagamento(pedido) || 'Não informado')}</div>
        <div>Status: ${esc(statusDe(pedido)?.rotulo || pedido.status || '')}</div>
        ${pedido.observacao ? `<hr><b>Observação:</b><div>${esc(pedido.observacao)}</div>` : ''}
      </body>
    </html>
  `;

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);

  iframe.onload = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (error) {
      console.error('Erro ao imprimir comanda:', error);
      aviso('Não foi possível abrir a impressão.');
    } finally {
      setTimeout(() => iframe.remove(), 2000);
    }
  };

  iframe.srcdoc = html;
}

async function mudarStatus(pedido, novoStatus, mensagem) {
  const resultado = await atualizar(
    'pedidos',
    pedido.id,
    { status: novoStatus },
    mensagem
  );

  if (resultado) {
    pedido.status = resultado.status;
    renderPedidos();
  }
}

function configurarEventos() {
  document.addEventListener('click', desbloquearAudio, { once: true });
  document.addEventListener('touchstart', desbloquearAudio, { once: true });

  $('lista-pedidos').addEventListener('click', async (evento) => {
    const encontrarPedido = (atributo) => {
      const botao = evento.target.closest(`[${atributo}]`);
      return botao
        ? achar(state.pedidos, botao.getAttribute(atributo))
        : null;
    };

    let pedido;

    if ((pedido = encontrarPedido('data-avancar'))) {
      const status = statusDe(pedido);
      if (status?.prox) {
        await mudarStatus(
          pedido,
          status.prox,
          STATUS[status.prox]?.rotulo || 'Status atualizado'
        );
      }
      return;
    }

    if ((pedido = encontrarPedido('data-cancelar'))) {
      if (confirm(`Cancelar o pedido de ${pedido.cliente_nome || 'cliente'}?`)) {
        await mudarStatus(pedido, 'cancelado', 'Pedido cancelado');
      }
      return;
    }

    if ((pedido = encontrarPedido('data-zap'))) {
      const numero = foneZap(pedido);
      if (!numero) return aviso('Pedido sem telefone');

      window.open(
        `https://wa.me/${numero}?text=${encodeURIComponent(textoZap(pedido))}`,
        '_blank',
        'noopener,noreferrer'
      );
      return;
    }

    if ((pedido = encontrarPedido('data-imprimir'))) {
      imprimirComanda(pedido);
    }
  });

  $('aba-pedidos').addEventListener('click', (evento) => {
    const filtro = evento.target.closest('[data-filtro]');

    if (filtro) {
      state.filtroPedidos = filtro.dataset.filtro;
      renderPedidos();
    }

    if (evento.target.closest('#btn-som')) {
      state.somLigado = !state.somLigado;
      desbloquearAudio();
      renderPedidos();
      if (state.somLigado) beep();
    }
  });
}

let eventosConfigurados = false;

export function inicializarPedidos() {
  if (eventosConfigurados) return;
  configurarEventos();
  eventosConfigurados = true;
}
