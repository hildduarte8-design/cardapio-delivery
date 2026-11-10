import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, aviso, tratarErro, atualizar, achar } from './admin-utils.js';
import { montarMensagemCancelamento } from './admin-cancelamento-whatsapp.js';

// Nome do botão de WhatsApp conforme a situação do pedido
function rotuloAvisoZap(pedido) {
  if (pedido.status === 'cancelado') return 'Explicar cancelamento';
  if (ehRetirada(pedido) && pedido.status === 'preparando') return 'Avisar que está pronto';
  return 'Avisar cliente';
}

const STATUS = {
  pendente_pagamento: {
    rotulo: 'Aguardando Pix',
    classe: 'badge-amarelo',
    btnClasse: 'btn-amarelo',
    prox: 'pago',
    acao: 'Confirmar pagamento'
  },
  pago: {
    rotulo: 'Pago',
    classe: 'badge-azul',
    btnClasse: 'btn-verde',
    prox: 'preparando',
    acao: 'Iniciar preparo'
  },
  preparando: {
    rotulo: 'Em preparo',
    classe: 'badge-laranja',
    btnClasse: 'btn-roxo',
    prox: 'saiu_entrega',
    acao: 'Saiu para entrega'
  },
  saiu_entrega: {
    rotulo: 'Saiu p/ entrega',
    classe: 'badge-roxo',
    btnClasse: 'btn-verde',
    prox: 'entregue',
    acao: 'Marcar como entregue'
  },
  entregue: {
    rotulo: 'Entregue',
    classe: 'badge-verde'
  },
  cancelado: {
    rotulo: 'Cancelado',
    classe: 'badge-cinza'
  }
};

const ENCERRADOS = ['entregue', 'cancelado'];

// Pedido em dinheiro ou cartão não espera Pix antecipado:
// no banco continua 'pendente_pagamento', mas para o lojista vira "Novo pedido"
const STATUS_NOVO_NA_ENTREGA = {
  rotulo: 'Novo pedido',
  classe: 'badge-laranja-vivo',
  btnClasse: 'btn-verde',
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

function ehRetirada(pedido) {
  return pedido.tipo_atendimento === 'retirada';
}

function ehManual(pedido) {
  return pedido.origem === 'manual';
}

function descontoDe(pedido) {
  const valor = Number(pedido.desconto);
  return Number.isFinite(valor) && valor > 0 ? valor : 0;
}

// Na retirada não existe "saiu para entrega": do preparo vai direto para entregue ao cliente
const STATUS_PREPARANDO_RETIRADA = {
  rotulo: 'Em preparo',
  classe: 'badge-laranja',
  btnClasse: 'btn-verde',
  prox: 'entregue',
  acao: 'Entregue ao cliente'
};

function statusDe(pedido) {
  if (pagaNaEntrega(pedido)) return STATUS_NOVO_NA_ENTREGA;
  if (ehRetirada(pedido) && pedido.status === 'preparando') return STATUS_PREPARANDO_RETIRADA;
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
  if (ehRetirada(pedido)) return 'Retirada no balcão';
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

    carregarSom();
  } catch (error) {
    console.warn('Áudio não disponível neste navegador.', error);
  }
}

let bufferSom = null;
let carregandoSom = null;

async function carregarSom() {
  if (bufferSom || carregandoSom || !state.audioCtx) return;

  carregandoSom = fetch('/sons/novo-pedido.mp3')
    .then((resposta) => {
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      return resposta.arrayBuffer();
    })
    .then((dados) => state.audioCtx.decodeAudioData(dados))
    .then((buffer) => {
      bufferSom = buffer;
    })
    .catch((error) => {
      console.warn('Não foi possível carregar o som de pedido.', error);
    })
    .finally(() => {
      carregandoSom = null;
    });
}

function beep() {
  if (!state.somLigado || !state.audioCtx) return;

  if (!bufferSom) {
    carregarSom();
    beepSintetico();
    return;
  }

  try {
    const origem = state.audioCtx.createBufferSource();
    const ganho = state.audioCtx.createGain();

    origem.buffer = bufferSom;
    ganho.gain.value = 1;
    origem.connect(ganho);
    ganho.connect(state.audioCtx.destination);
    origem.start();

    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch (error) {
    console.warn('Falha ao tocar o som.', error);
    beepSintetico();
  }
}

function beepSintetico() {
  if (!state.somLigado || !state.audioCtx) return;

  try {
    const ctx = state.audioCtx;
    const inicio = ctx.currentTime;

    // Campainha: 4 toques alternando duas notas
    const notas = [
      { freq: 988, atraso: 0 },
      { freq: 784, atraso: 0.3 },
      { freq: 988, atraso: 0.6 },
      { freq: 784, atraso: 0.9 }
    ];

    notas.forEach(({ freq, atraso }) => {
      const oscilador = ctx.createOscillator();
      const ganho = ctx.createGain();

      oscilador.type = 'square';
      oscilador.frequency.value = freq;
      ganho.gain.setValueAtTime(0.6, inicio + atraso);
      ganho.gain.exponentialRampToValueAtTime(0.001, inicio + atraso + 0.28);

      oscilador.connect(ganho);
      ganho.connect(ctx.destination);
      oscilador.start(inicio + atraso);
      oscilador.stop(inicio + atraso + 0.3);
    });

    // Vibração, nos celulares que permitem
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch (error) {
    console.warn('Falha ao reproduzir aviso sonoro.', error);
  }
}

export async function carregarPedidos() {
  if (!state.rest || !sb) return;

  // Os 100 pedidos MAIS RECENTES (sem a ordenação, o banco devolveria 100 quaisquer)
  const { data, error } = await sb
    .from('pedidos')
    .select('*')
    .eq('restaurante_id', state.rest.id)
    .order('created_at', { ascending: false })
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
    aviso('🔔 Novo pedido recebido!');
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

// Ordem de prioridade para a cozinha/gestor:
// 1º Pedidos aguardando ação (Novos ou Pix pendente)
// 2º Em preparo (os mais antigos primeiro)
// 3º Em entrega
function pesoPrioridade(pedido) {
  if (pedido.status === 'pendente_pagamento') return 1;
  if (pedido.status === 'pago') return 2;
  if (pedido.status === 'preparando') return 3;
  if (pedido.status === 'saiu_entrega') return 4;
  return 5;
}

export function renderPedidos() {
  // Preserva a rolagem da tela durante atualizações automáticas
  const scrollAtual = window.scrollY;

  const ativos = state.pedidos.filter((p) => !ENCERRADOS.includes(p.status));
  const encerrados = state.pedidos.filter((p) => ENCERRADOS.includes(p.status));

  // Contadores por etapa
  const contAcao = ativos.filter((p) => p.status === 'pendente_pagamento' || p.status === 'pago').length;
  const contPreparo = ativos.filter((p) => p.status === 'preparando').length;
  const contEntrega = ativos.filter((p) => p.status === 'saiu_entrega').length;
  const contEncerrados = encerrados.length;
  const contTodosAtivos = ativos.length;

  // Atualiza badge geral de pedidos
  const badge = $('badge-pedidos');
  if (badge) {
    badge.innerText = contTodosAtivos;
    badge.classList.toggle('hidden', contTodosAtivos === 0);
  }

  // Atualiza números nos chips de filtro
  const chipNum = (id, n) => {
    const el = $(id);
    if (el) el.innerText = n;
  };
  chipNum('chip-num-todos', contTodosAtivos);
  chipNum('chip-num-acao', contAcao);
  chipNum('chip-num-preparo', contPreparo);
  chipNum('chip-num-entrega', contEntrega);
  chipNum('chip-num-encerrados', contEncerrados);

  // Destaca o chip ativo (e informa o estado para leitores de tela)
  document.querySelectorAll('[data-status-filtro]').forEach((btn) => {
    const ativo = btn.dataset.statusFiltro === state.filtroStatus;
    btn.classList.toggle('ativo', ativo);
    btn.setAttribute('aria-pressed', ativo ? 'true' : 'false');
  });

 // Atualiza ícone do som (só o ícone; o texto fica na dica e no leitor de tela)
  if ($('btn-som')) {
    const btnSom = $('btn-som');
    const rotuloSom = state.somLigado
      ? 'Som de novo pedido ligado (toque para silenciar)'
      : 'Som mudo (toque para ligar)';
    btnSom.innerText = state.somLigado ? '🔔' : '🔕';
    btnSom.title = rotuloSom;
    btnSom.setAttribute('aria-label', rotuloSom);
    btnSom.classList.toggle('mudo', !state.somLigado);
  }
  // Filtra e ordena a lista
  let lista = [];
  if (state.filtroStatus === 'encerrados') {
    lista = [...encerrados].sort((a, b) => new Date(dataDoPedido(b) || 0) - new Date(dataDoPedido(a) || 0));
  } else {
    let filtrados = ativos;
    if (state.filtroStatus === 'acao') {
      filtrados = ativos.filter((p) => p.status === 'pendente_pagamento' || p.status === 'pago');
    } else if (state.filtroStatus === 'preparando') {
      filtrados = ativos.filter((p) => p.status === 'preparando');
    } else if (state.filtroStatus === 'saiu_entrega') {
      filtrados = ativos.filter((p) => p.status === 'saiu_entrega');
    }

    // Ordenação inteligente: pedidos que exigem ação primeiro, depois mais antigos
    lista = [...filtrados].sort((a, b) => {
      const pesoA = pesoPrioridade(a);
      const pesoB = pesoPrioridade(b);
      if (pesoA !== pesoB) return pesoA - pesoB;
      return new Date(dataDoPedido(a) || 0) - new Date(dataDoPedido(b) || 0);
    });
  }

  const container = $('lista-pedidos');
  if (!container) return;

  if (!lista.length) {
    let mensagemVazia = 'Nenhum pedido ativo no momento.';
    if (state.filtroStatus === 'acao') mensagemVazia = 'Nenhum pedido aguardando ação. Tudo em dia! 👏';
    else if (state.filtroStatus === 'preparando') mensagemVazia = 'Nenhum pedido na cozinha no momento.';
    else if (state.filtroStatus === 'saiu_entrega') mensagemVazia = 'Nenhum pedido na rota de entrega agora.';
    else if (state.filtroStatus === 'encerrados') mensagemVazia = 'Nenhum pedido encerrado ainda.';

    container.innerHTML = `
      <div class="painel-vazio">
        <p class="vazio-texto">${esc(mensagemVazia)}</p>
      </div>
    `;
    window.scrollTo({ top: scrollAtual, behavior: 'instant' });
    return;
  }

  container.innerHTML = lista.map((pedido) => {
    const status = statusDe(pedido) || {
      rotulo: pedido.status || '—',
      classe: 'badge-cinza',
      btnClasse: 'btn-verde'
    };

    const encerrado = ENCERRADOS.includes(pedido.status);
    const minutos = minutosDesde(dataDoPedido(pedido));

    // Destaque visual para pedidos demorando
    let classeAtraso = '';
    let badgeTempoHTML = '';
    if (!encerrado) {
      if (minutos >= 45) {
        classeAtraso = 'card-atraso-critico';
        badgeTempoHTML = `<span class="tag-tempo atraso-critico">⚠️ ${minutos} min</span>`;
      } else if (minutos >= 30) {
        classeAtraso = 'card-atraso-alerta';
        badgeTempoHTML = `<span class="tag-tempo atraso-alerta">⏰ ${minutos} min</span>`;
      } else {
        badgeTempoHTML = `<span class="tag-tempo">há ${minutos} min</span>`;
      }
    }

    const itensHTML = itensDe(pedido).map((item) => {
      const obs = item.observacao ? `<div class="item-obs">Obs: ${esc(item.observacao)}</div>` : '';
      return `
        <li class="item-linha">
          <span class="item-qtd">${quantidadeDoItem(item)}x</span>
          <span class="item-nome">${esc(item.nome)}</span>
          ${obs}
        </li>
      `;
    }).join('');

    const estaProcessando = String(state.processandoPedidoId) === String(pedido.id);

    return `
      <div class="card-pedido ${classeAtraso}" id="card-ped-${esc(pedido.id)}">
        <div class="card-topo">
          <div class="card-cliente">
            <h3 class="cliente-nome">${esc(pedido.cliente_nome)}</h3>
            <div class="cliente-meta">
              ${ehManual(pedido) ? '<span class="tag-origem">Manual</span>' : ''}
              <span class="pedido-hora">${esc(hora(dataDoPedido(pedido)))}</span>
              ${badgeTempoHTML}
              <span class="pedido-cod">#${esc(codigo(pedido))}</span>
            </div>
          </div>
          <span class="badge-status ${status.classe}">
            ${esc(status.rotulo)}
          </span>
        </div>

        <ul class="lista-itens">${itensHTML}</ul>

        <div class="card-endereco">
          ${
            ehRetirada(pedido)
              ? `<span class="end-icone">🏪</span>
                 <span class="end-texto"><strong>Retirada no balcão</strong></span>`
              : `<span class="end-icone">📍</span>
                 <span class="end-texto">
                   <strong>${esc(nomeBairroPedido(pedido))}</strong> — ${esc(pedido.endereco_completo)}
                 </span>`
          }
        </div>

        ${pedido.observacao ? `
          <div class="card-obs-geral">
            <strong>Observação:</strong> ${esc(pedido.observacao)}
          </div>
        ` : ''}

        <div class="card-financeiro">
          <div class="pagto-info">
            <span class="pagto-forma">${esc(rotuloPagamento(pedido))}</span>
            <span class="pagto-taxa">${
              ehRetirada(pedido)
                ? 'sem entrega'
                : `entrega ${brl.format(Number(pedido.taxa_entrega) || 0)}`
            }${
              descontoDe(pedido) > 0
                ? ` · desconto −${brl.format(descontoDe(pedido))}${pedido.desconto_motivo ? ` (${esc(pedido.desconto_motivo)})` : ''}`
                : ''
            }</span>
          </div>
          <strong class="pagto-total">${brl.format(Number(pedido.total) || 0)}</strong>
        </div>

        <div class="card-acoes">
          ${
            status.prox
              ? `
                <button
                  data-avancar="${esc(pedido.id)}"
                  class="btn-acao-principal ${status.btnClasse}"
                  ${estaProcessando ? 'disabled' : ''}
                >
                  ${estaProcessando ? 'Salvando...' : esc(status.acao)}
                </button>
              `
              : '<span class="espaco-acao"></span>'
          }
                    <button data-zap="${esc(pedido.id)}" class="btn-acao-sec btn-zap" title="Avisar o cliente pelo WhatsApp">
            💬 ${rotuloAvisoZap(pedido)}
          </button>
          <button data-imprimir="${esc(pedido.id)}" class="btn-acao-sec btn-comanda" title="Imprimir comanda térmica" aria-label="Imprimir comanda">
            🖨️
          </button>
          ${
            encerrado
              ? ''
              : `
                <button
                  data-cancelar="${esc(pedido.id)}"
                  class="btn-acao-sec btn-cancelar"
                  ${estaProcessando ? 'disabled' : ''}
                  title="Cancelar pedido"
                >
                  Cancelar
                </button>
              `
          }
        </div>
      </div>
    `;
  }).join('');

  // Restaura a posição da tela exatamente de onde estava
  window.scrollTo({ top: scrollAtual, behavior: 'instant' });
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
      ? `Recebemos seu pedido de ${valor}! Já vamos confirmar e começar o preparo. O pagamento é na entrega (${rotuloPagamento(pedido)}).`
      : `Recebemos seu pedido de ${valor}! Falta só o pagamento via Pix para confirmarmos.`,
    pago: 'Pagamento confirmado ✅ Já vamos preparar seu pedido!',
    preparando: 'Seu pedido está em preparo 👨‍🍳',
    saiu_entrega: 'Seu pedido saiu para entrega 🛵',
    entregue: 'Obrigado pela preferência! 🙏',
    cancelado: 'Seu pedido foi cancelado. Qualquer dúvida, é só responder aqui.'
  };

  // Cancelado: mensagem amigável com o motivo (se houver)
  if (pedido.status === 'cancelado') {
    return montarMensagemCancelamento(pedido, {
      nome,
      loja: state.rest.nome,
      motivo: pedido.cancelamento_motivo,
    });
  }

  // Retirada: avisa que está pronto (o pedido fica em preparo até a retirada)
  if (ehRetirada(pedido) && pedido.status === 'preparando') {
    return `Olá ${nome}! ${state.rest.nome}: Seu pedido de ${valor} está pronto, pode retirar no balcão! 🙌`;
  }

  return `Olá ${nome}! ${state.rest.nome}: ${mensagens[pedido.status] || 'Sobre o seu pedido:'}`;
}

// Impressão da comanda 58mm idêntica à versão validada
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
        <div>Pedido #${esc(codigo(pedido))} · ${esc(hora(dataDoPedido(pedido)))}${ehManual(pedido) ? ' · Manual' : ''}</div>
        <hr>
        <div><b>Cliente:</b> ${esc(pedido.cliente_nome)}</div>
        <div><b>WhatsApp:</b> ${esc(telefoneDoPedido(pedido) || 'Não informado')}</div>
        ${
          ehRetirada(pedido)
            ? '<div><b>RETIRADA NO BALCÃO</b></div>'
            : `<div><b>Bairro:</b> ${esc(nomeBairroPedido(pedido))}</div>
               <div><b>Endereço:</b> ${esc(pedido.endereco_completo)}</div>`
        }
        <hr>
        <b>ITENS DO PEDIDO</b>
        ${linhas}
        <hr>
        <div class="item"><span>Subtotal:</span><span>${brl.format(Number(pedido.subtotal) || 0)}</span></div>
        ${
          ehRetirada(pedido)
            ? ''
            : `<div class="item"><span>Entrega:</span><span>${brl.format(Number(pedido.taxa_entrega) || 0)}</span></div>`
        }
        ${
          descontoDe(pedido) > 0
            ? `<div class="item"><span>Desconto:</span><span>-${brl.format(descontoDe(pedido))}</span></div>
               ${pedido.desconto_motivo ? `<div class="obs">${esc(pedido.desconto_motivo)}</div>` : ''}`
            : ''
        }
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

// Mudança de status com proteção contra clique duplo
async function mudarStatus(pedido, novoStatus, mensagem) {
  if (state.processandoPedidoId) return;

  state.processandoPedidoId = pedido.id;
  renderPedidos();

  try {
    const resultado = await atualizar(
      'pedidos',
      pedido.id,
      { status: novoStatus },
      mensagem
    );

    if (resultado) {
      pedido.status = resultado.status;
    }
  } finally {
    state.processandoPedidoId = null;
    renderPedidos();
  }
}

function configurarEventos() {
  document.addEventListener('click', desbloquearAudio, { once: true });
  document.addEventListener('touchstart', desbloquearAudio, { once: true });

  const listaEl = $('lista-pedidos');
  if (listaEl) {
    listaEl.addEventListener('click', async (evento) => {
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
        const nomeCli = pedido.cliente_nome ? `de ${pedido.cliente_nome}` : '';
        const codPed = codigo(pedido);
        if (confirm(`Tem certeza que deseja cancelar o pedido #${codPed} ${nomeCli}?\n\nEsta ação não poderá ser desfeita.`)) {
          await mudarStatus(pedido, 'cancelado', 'Pedido cancelado');
        }
        return;
      }

      if ((pedido = encontrarPedido('data-zap'))) {
        const numero = foneZap(pedido);
        if (!numero) return aviso('Pedido sem telefone cadastrado.');

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
  }

  const abaPedidos = $('aba-pedidos');
  if (abaPedidos) {
    abaPedidos.addEventListener('click', (evento) => {
      const filtro = evento.target.closest('[data-status-filtro]');
      if (filtro) {
        state.filtroStatus = filtro.dataset.statusFiltro;
        renderPedidos();
        return;
      }

      if (evento.target.closest('#btn-som')) {
        state.somLigado = !state.somLigado;
        desbloquearAudio();
        renderPedidos();
        if (state.somLigado) beep();
      }
    });
  }
}

let eventosConfigurados = false;

export function inicializarPedidos() {
  if (eventosConfigurados) return;
  configurarEventos();
  eventosConfigurados = true;
}
