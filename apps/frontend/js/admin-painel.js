// Aba "Painel": números de vendas calculados no navegador a partir da tabela pedidos.
// Só lê dados (RLS já limita ao restaurante do usuário). Não altera nada no banco.
import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, tratarErro } from './admin-utils.js';

const PERIODOS = { 1: 'Hoje', 7: '7 dias', 30: '30 dias', mes: 'Mês' };
const LIMITE_PEDIDOS = 1000;
const INTERVALO_ATUALIZACAO_MS = 60000;

let periodo = 1; // 1 | 7 | 30 | 'mes'
let mesEscolhido = { ano: new Date().getFullYear(), mes: new Date().getMonth() + 1 };
let pedidos = [];
let carregando = false;
let recarregar = false;
let timer = null;

// ---------- Regras de contagem ----------
const forma = (p) => String(p.forma_pagamento || '').trim().toLowerCase();
const pagaNaEntrega = (p) => p.status === 'pendente_pagamento' && ['dinheiro', 'cartao', 'cartão'].includes(forma(p));
const aguardandoPix = (p) => p.status === 'pendente_pagamento' && !pagaNaEntrega(p);
// Conta como venda: tudo que não foi cancelado e não está esperando Pix
const ehVenda = (p) => p.status !== 'cancelado' && !aguardandoPix(p);
const valor = (p) => Number(p.total) || 0;

function itensDe(p) {
  try {
    const itens = typeof p.itens === 'string' ? JSON.parse(p.itens) : p.itens;
    return Array.isArray(itens) ? itens : [];
  } catch (e) { return []; }
}

// ---------- Datas (sempre no fuso do aparelho) ----------
function inicioDoDia(base = new Date(), voltarDias = 0) {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - voltarDias);
  return d;
}
const chaveDia = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

function intervalo() {
  if (periodo === 'mes') {
    return {
      inicio: new Date(mesEscolhido.ano, mesEscolhido.mes - 1, 1),
      fim: new Date(mesEscolhido.ano, mesEscolhido.mes, 1)
    };
  }
  return { inicio: inicioDoDia(new Date(), periodo - 1), fim: null };
}

const chaveMes = (ano, mes) => `${ano}-${String(mes).padStart(2, '0')}`;
const ehMesAtual = () => {
  const n = new Date();
  return mesEscolhido.ano === n.getFullYear() && mesEscolhido.mes === n.getMonth() + 1;
};

function nomeDoMes() {
  const t = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })
    .format(new Date(mesEscolhido.ano, mesEscolhido.mes - 1, 1));
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function deslocarMes(delta) {
  const d = new Date(mesEscolhido.ano, mesEscolhido.mes - 1 + delta, 1);
  const hoje = new Date();
  if (d > new Date(hoje.getFullYear(), hoje.getMonth(), 1)) return; // sem meses futuros
  mesEscolhido = { ano: d.getFullYear(), mes: d.getMonth() + 1 };
  carregarPainel();
}

function escolherMes(texto) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(texto || ''));
  if (!m) return;
  const ano = Number(m[1]), mes = Number(m[2]);
  if (mes < 1 || mes > 12 || ano < 2020) return;
  const hoje = new Date();
  if (new Date(ano, mes - 1, 1) > new Date(hoje.getFullYear(), hoje.getMonth(), 1)) return;
  mesEscolhido = { ano, mes };
  carregarPainel();
}

function rotuloDia(d, curto) {
  if (curto) {
    const t = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' }).format(d).replace('.', '');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function compacto(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(1).replace('.', ',')}k` : String(Math.round(v));
}

function tempoRelativo(iso) {
  const diffMin = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (diffMin < 1) return 'Agora';
  if (diffMin < 60) return `Há ${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `Há ${h}h`;
  return rotuloDia(new Date(iso), false);
}

// ---------- Dados ----------
export async function carregarPainel() {
  if (!sb || !state.rest) return;
  if (carregando) { recarregar = true; return; } // pedido de nova busca enquanto outra roda
  carregando = true;
  try {
    const { inicio, fim } = intervalo();
    const desde = periodo === 'mes' ? inicio : inicioDoDia(new Date(), Math.max(periodo, 7) - 1);
    let consulta = sb
      .from('pedidos')
      .select('id, status, total, created_at, forma_pagamento, bairro_id, itens')
      .eq('restaurante_id', state.rest.id)
      .gte('created_at', desde.toISOString());
    if (fim) consulta = consulta.lt('created_at', fim.toISOString());
    const { data, error } = await consulta
      .order('created_at', { ascending: false })
      .limit(LIMITE_PEDIDOS);

    if (error) {
      tratarErro(error, 'Não foi possível carregar o painel.');
      $('painel-conteudo').innerHTML = `
        <div class="stitch-card p-6 text-center">
          <p class="text-body-md text-on-surface-variant mb-4">Não foi possível carregar os números. Toque em "Atualizar" para tentar de novo.</p>
          <button type="button" class="stitch-btn-primary" data-atualizar>
            <span class="material-symbols-outlined text-[18px]">refresh</span>
            <span>Atualizar</span>
          </button>
        </div>`;
      return;
    }
    pedidos = data || [];
    renderPainel();
  } finally {
    carregando = false;
    if (recarregar) { recarregar = false; carregarPainel(); }
  }
}

// ---------- Cálculo ----------
function calcular() {
  const { inicio, fim } = intervalo();
  const noPeriodo = pedidos.filter((p) => {
    const d = new Date(p.created_at);
    return d >= inicio && (!fim || d < fim);
  });
  const vendas = noPeriodo.filter(ehVenda);
  const faturamento = vendas.reduce((s, p) => s + valor(p), 0);

  const aPix = noPeriodo.filter(aguardandoPix);
  const andamento = noPeriodo.filter((p) => !['entregue', 'cancelado'].includes(p.status));

  const agrupar = (lista, chave) => {
    const mapa = new Map();
    lista.forEach((x) => {
      const [k, q, v] = chave(x);
      const atual = mapa.get(k) || { q: 0, v: 0 };
      atual.q += q; atual.v += v;
      mapa.set(k, atual);
    });
    return [...mapa.entries()].sort((a, b) => b[1].q - a[1].q || b[1].v - a[1].v);
  };

  const produtos = agrupar(
    vendas.flatMap((p) => itensDe(p)),
    (i) => [String(i.nome || 'Item'), Number(i.qtd ?? i.quantidade) || 0, 0]
  ).slice(0, 5);

  const rotuloForma = (p) => ({ pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', 'cartão': 'Cartão' }[forma(p)] || 'Outros');
  const pagamentos = agrupar(vendas, (p) => [rotuloForma(p), 1, valor(p)]);

  const nomeBairro = (id) => (state.bairros.find((b) => String(b.id) === String(id)) || {}).nome || 'Outros';
  const bairros = agrupar(vendas, (p) => [nomeBairro(p.bairro_id), 1, valor(p)]).slice(0, 5);

  const cancelados = noPeriodo.filter((p) => p.status === 'cancelado').length;
  const taxaCancelamento = noPeriodo.length ? ((cancelados / noPeriodo.length) * 100).toFixed(1).replace('.', ',') : '0,0';

  return {
    noPeriodo, vendas, faturamento, aPix, andamento, bairros, pagamentos, produtos,
    cancelados, taxaCancelamento,
    ticket: vendas.length ? faturamento / vendas.length : 0
  };
}

function barras(colunas) {
  const maximo = Math.max(...colunas.map((c) => c.v), 0);
  return '<div class="flex items-end gap-1.5 h-36 pt-4">' + colunas.map((c) => {
    const altura = maximo > 0 && c.v > 0 ? Math.max(6, Math.round((c.v / maximo) * 100)) : 0;
    return `<div class="flex-1 min-w-0 h-full flex flex-col items-center justify-end gap-1" title="${esc(c.titulo)}">
      <span class="text-[10px] font-semibold text-on-surface-variant tabular-nums">${c.v > 0 ? esc(compacto(c.v)) : ''}</span>
      <div class="w-full flex-1 flex items-end">
        <div class="w-full rounded-t-md bg-tertiary-container transition-all" style="height:${altura}%"></div>
      </div>
      <span class="text-[11px] text-on-surface-variant truncate max-w-full">${esc(c.rotulo)}</span>
    </div>`;
  }).join('') + '</div>';
}

function listaDeDias() {
  if (periodo === 'mes') {
    const total = new Date(mesEscolhido.ano, mesEscolhido.mes, 0).getDate();
    return Array.from({ length: total }, (_, i) => new Date(mesEscolhido.ano, mesEscolhido.mes - 1, i + 1));
  }
  const n = periodo === 1 ? 7 : periodo;
  return Array.from({ length: n }, (_, i) => inicioDoDia(new Date(), n - 1 - i));
}

function graficoPorDia() {
  const dias = listaDeDias();
  const passo = dias.length > 14 ? 5 : 1;
  const colunas = dias.map((dia, pos) => {
    const total = pedidos
      .filter((p) => ehVenda(p) && chaveDia(new Date(p.created_at)) === chaveDia(dia))
      .reduce((soma, p) => soma + valor(p), 0);
    return {
      v: total,
      titulo: `${rotuloDia(dia, false)}: ${brl.format(total)}`,
      rotulo: pos % passo === 0 || pos === dias.length - 1 ? rotuloDia(dia, dias.length <= 7) : ''
    };
  });

  const somaGrafico = colunas.reduce((s, c) => s + c.v, 0);
  const maximo = Math.max(...colunas.map((c) => c.v), 0);

  // Para muitos dias (ex: 30 dias / mês), barras limpas são mais legíveis; para 7 dias, linha SVG suave do Stitch
  if (colunas.length > 10) {
    return { somaGrafico, html: barras(colunas) };
  }

  const largura = 700;
  const altura = 200;
  const padX = 28;
  const padTop = 24;
  const baseY = 180;
  const spanX = colunas.length > 1 ? (largura - padX * 2) / (colunas.length - 1) : 0;

  const pontos = colunas.map((c, idx) => {
    const x = Math.round(padX + idx * spanX);
    const ratio = maximo > 0 ? c.v / maximo : 0;
    const y = Math.round(baseY - ratio * (baseY - padTop));
    return { x, y, ...c };
  });

  // Curva suave Catmull-Rom simples convertida em Bezier cúbica
  let pathLinha = '';
  if (pontos.length > 0) {
    pathLinha = `M ${pontos[0].x} ${pontos[0].y}`;
    for (let i = 0; i < pontos.length - 1; i++) {
      const p0 = pontos[i];
      const p1 = pontos[i + 1];
      const cx = Math.round((p0.x + p1.x) / 2);
      pathLinha += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;
    }
  }
  const ultimo = pontos[pontos.length - 1];
  const pathArea = pontos.length
    ? `${pathLinha} L ${ultimo.x} ${baseY} L ${pontos[0].x} ${baseY} Z`
    : '';

  const circulos = pontos.map((pt, i) => {
    const ehUltimo = i === pontos.length - 1;
    return `<circle cx="${pt.x}" cy="${pt.y}" r="${ehUltimo ? 6 : 4.5}" class="${ehUltimo ? 'text-primary' : 'text-tertiary-container'}" fill="currentColor"><title>${esc(pt.titulo)}</title></circle>`;
  }).join('');

  const rotulos = colunas.map((c, i) => {
    const ehUltimo = i === colunas.length - 1;
    return `<span class="${ehUltimo ? 'text-on-surface font-bold' : ''}">${esc(c.rotulo)}${ehUltimo && periodo === 1 ? ' (Hoje)' : ''}</span>`;
  }).join('');

  const html = `
    <div class="relative w-full h-56 flex flex-col justify-end">
      <svg class="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 ${largura} ${altura}">
        <defs>
          <linearGradient id="goldAreaGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#cca830" stop-opacity="0.28"></stop>
            <stop offset="100%" stop-color="#cca830" stop-opacity="0.0"></stop>
          </linearGradient>
        </defs>
        <g class="text-surface-container-highest" stroke="currentColor" stroke-dasharray="4 4" stroke-width="1">
          <line x1="0" x2="${largura}" y1="40" y2="40"></line>
          <line x1="0" x2="${largura}" y1="110" y2="110"></line>
          <line x1="0" x2="${largura}" y1="${baseY}" y2="${baseY}"></line>
        </g>
        ${pathArea ? `<path d="${pathArea}" fill="url(#goldAreaGrad)"></path>` : ''}
        ${pathLinha ? `<path d="${pathLinha}" fill="none" stroke="#cca830" stroke-linecap="round" stroke-linejoin="round" stroke-width="3"></path>` : ''}
        ${circulos}
      </svg>
      <div class="flex items-center justify-between px-2 pt-2 font-caption text-caption text-on-surface-variant">
        ${rotulos}
      </div>
      ${somaGrafico === 0 ? '<p class="text-center font-caption text-caption text-on-surface-variant mt-2">Sem receita registrada neste período.</p>' : ''}
    </div>`;

  return { somaGrafico, html };
}

function graficoPorHora(vendas) {
  if (!vendas.length) return '<p class="text-body-md text-on-surface-variant">Ainda não há vendas hoje.</p>';
  const porHora = new Array(24).fill(0);
  vendas.forEach((p) => { porHora[new Date(p.created_at).getHours()] += valor(p); });
  const horas = porHora.map((v, h) => (v > 0 ? h : -1)).filter((h) => h >= 0);
  const de = Math.min(...horas), ate = Math.max(...horas);
  const colunas = [];
  for (let h = de; h <= ate; h++) {
    colunas.push({ v: porHora[h], titulo: `${h}h: ${brl.format(porHora[h])}`, rotulo: (ate - de > 11 && (h - de) % 2) ? '' : `${h}h` });
  }
  return barras(colunas);
}

function badgeStatusPedido(p) {
  if (p.status === 'cancelado') {
    return '<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-error-container text-on-error-container font-label-sm text-label-sm">Cancelado</span>';
  }
  if (p.status === 'entregue') {
    return '<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm"><span class="material-symbols-outlined text-[14px]">check_circle</span>Entregue</span>';
  }
  if (p.status === 'saiu_entrega' || p.status === 'pronto_retirada') {
    const label = p.status === 'pronto_retirada' ? 'Pronto p/ retirada' : 'Saiu para entrega';
    return `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant font-label-sm text-label-sm"><span class="material-symbols-outlined text-[14px]">two_wheeler</span>${label}</span>`;
  }
  if (p.status === 'preparando') {
    return '<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant font-label-sm text-label-sm"><span class="w-1.5 h-1.5 rounded-full bg-secondary"></span>Em preparo</span>';
  }
  const labelNovo = aguardandoPix(p) ? 'Aguardando Pix' : 'Novo';
  return `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary-fixed text-on-primary-fixed font-label-sm text-label-sm"><span class="w-1.5 h-1.5 rounded-full bg-primary"></span>${labelNovo}</span>`;
}

// ---------- Tela ----------
function renderPainel() {
  const r = calcular();
  const rotuloPeriodo = periodo === 1 ? 'hoje' : periodo === 'mes' ? `em ${nomeDoMes()}` : `nos últimos ${periodo} dias`;
  const hoje = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  const periodos = Object.entries(PERIODOS).map(([dias, nome]) => {
    const ativo = String(dias) === String(periodo);
    const cls = ativo
      ? 'px-3.5 py-1.5 rounded-md bg-surface-container-lowest text-on-surface font-label-sm text-label-sm shadow-sm transition-all'
      : 'px-3.5 py-1.5 rounded-md text-on-surface-variant hover:text-on-surface font-label-sm text-label-sm transition-all';
    return `<button type="button" class="${cls}" data-periodo="${dias}" aria-pressed="${ativo}">${nome}</button>`;
  }).join('');

  const totalPix = r.aPix.reduce((s, p) => s + valor(p), 0);
  const emPreparo = r.andamento.filter((p) => p.status === 'preparando').length;
  const emRota = r.andamento.filter((p) => p.status === 'saiu_entrega' || p.status === 'pronto_retirada').length;
  const novosAtivos = r.andamento.filter((p) => p.status === 'pendente_pagamento' || p.status === 'pago').length;
  const grafico = graficoPorDia();

  const nomeBairro = (id) => (state.bairros.find((b) => String(b.id) === String(id)) || {}).nome || 'Retirada / Outros';
  const recentes = r.noPeriodo.slice(0, 6);

  const produtosHtml = r.produtos.length
    ? r.produtos.map(([nome, d], idx) => `
        <div class="flex items-center gap-3 bg-surface-container-lowest p-3 rounded-xl shadow-stitch-sm">
          <div class="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-primary shrink-0">
            <span class="material-symbols-outlined text-[20px]">restaurant</span>
          </div>
          <div class="min-w-0 flex-1">
            <p class="font-title-md text-title-md text-on-surface truncate">${esc(nome)}</p>
            <p class="font-caption text-caption text-on-surface-variant tabular-nums">${d.q} ${d.q === 1 ? 'unidade vendida' : 'unidades vendidas'}</p>
          </div>
          <span class="font-label-sm text-label-sm ${idx === 0 ? 'text-tertiary bg-tertiary-fixed' : 'text-on-surface-variant bg-surface-container-high'} px-2.5 py-1 rounded-md shrink-0">#${idx + 1}</span>
        </div>`).join('')
    : '<p class="text-body-md text-on-surface-variant bg-surface-container-lowest p-4 rounded-xl">Sem vendas registradas neste período.</p>';

  const listaSimples = (itens, vazio, sufixoFn) => itens.length
    ? `<ul class="divide-y divide-surface-container">${itens.map(([nome, d]) => `
        <li class="flex items-center justify-between gap-3 py-2.5 text-body-md">
          <span class="text-on-surface font-medium truncate">${esc(nome)}${sufixoFn ? ` <span class="text-on-surface-variant text-caption">(${d.q}x)</span>` : ''}</span>
          <strong class="text-on-surface font-semibold tabular-nums shrink-0">${sufixoFn ? sufixoFn(d) : `${d.q} ${d.q === 1 ? 'pedido' : 'pedidos'}`}</strong>
        </li>`).join('')}</ul>`
    : `<p class="text-body-md text-on-surface-variant">${vazio}</p>`;

  const linhasRecentes = recentes.map((p) => {
    const itens = itensDe(p);
    const resumoItens = itens.length
      ? itens.slice(0, 2).map((i) => `${Number(i.qtd ?? i.quantidade) || 1}x ${i.nome || 'Item'}`).join(', ') + (itens.length > 2 ? ` +${itens.length - 2}` : '')
      : '—';
    const formaTxt = ({ pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', 'cartão': 'Cartão' }[forma(p)] || '—');
    const idCurto = String(p.id || '').slice(0, 6).toUpperCase();
    return `
      <tr class="hover:bg-surface-container-low/60 transition-colors border-b border-surface-container last:border-0">
        <td class="py-3.5 px-4 font-title-md text-title-md text-on-surface tabular-nums">#${esc(idCurto)}</td>
        <td class="py-3.5 px-4">
          <div class="font-label-lg text-label-lg text-on-surface">${esc(nomeBairro(p.bairro_id))}</div>
          <div class="font-caption text-caption text-on-surface-variant">${esc(formaTxt)}</div>
        </td>
        <td class="py-3.5 px-4 text-on-surface-variant max-w-[260px] truncate">${esc(resumoItens)}</td>
        <td class="py-3.5 px-4 font-title-md text-title-md text-on-surface tabular-nums">${brl.format(valor(p))}</td>
        <td class="py-3.5 px-4">${badgeStatusPedido(p)}</td>
        <td class="py-3.5 px-4 text-right font-caption text-caption text-on-surface-variant tabular-nums">${esc(tempoRelativo(p.created_at))}</td>
      </tr>`;
  }).join('');

  $('painel-conteudo').innerHTML = `
    <div class="flex flex-col gap-6">
      <!-- Cabeçalho -->
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="font-label-sm text-label-sm uppercase tracking-widest text-primary">Visão Geral · Operacional</span>
            <span class="w-1.5 h-1.5 rounded-full bg-tertiary-container"></span>
            <span class="font-caption text-caption text-on-surface-variant capitalize">${esc(hoje)}</span>
          </div>
          <h2 class="font-display text-headline-lg text-on-surface tracking-tight">Desempenho da Loja</h2>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center bg-surface-container-high rounded-lg p-1 shadow-sm">
            ${periodos}
          </div>
          <button type="button" class="stitch-btn-primary" data-atualizar>
            <span class="material-symbols-outlined text-[18px]">refresh</span>
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      ${periodo === 'mes' ? `
        <div class="flex items-center justify-center gap-3">
          <button type="button" class="stitch-btn-ghost px-3 py-2" data-mes-delta="-1" aria-label="Mês anterior">
            <span class="material-symbols-outlined text-[18px]">chevron_left</span>
          </button>
          <label class="relative inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-container-lowest border border-outline-variant text-on-surface font-label-lg cursor-pointer">
            <span class="material-symbols-outlined text-[18px] text-primary">calendar_month</span>
            <span>${esc(nomeDoMes())}</span>
            <input type="month" value="${chaveMes(mesEscolhido.ano, mesEscolhido.mes)}" max="${chaveMes(new Date().getFullYear(), new Date().getMonth() + 1)}" data-mes-input aria-label="Escolher mês" class="absolute inset-0 opacity-0 cursor-pointer" />
          </label>
          <button type="button" class="stitch-btn-ghost px-3 py-2 disabled:opacity-40" data-mes-delta="1" aria-label="Próximo mês" ${ehMesAtual() ? 'disabled' : ''}>
            <span class="material-symbols-outlined text-[18px]">chevron_right</span>
          </button>
        </div>` : ''}

      ${pedidos.length >= LIMITE_PEDIDOS ? `
        <div class="p-3.5 rounded-lg bg-secondary-fixed text-on-secondary-fixed font-body-md text-body-md flex items-center gap-2">
          <span class="material-symbols-outlined text-[20px]">warning</span>
          <span>Há muitos pedidos no período: o painel considera os 1.000 mais recentes.</span>
        </div>` : ''}

      ${r.aPix.length ? `
        <button type="button" data-ir-pedidos class="w-full text-left p-4 rounded-xl bg-error-container text-on-error-container flex items-center justify-between gap-3 hover:opacity-95 transition-opacity">
          <div class="flex items-center gap-3">
            <span class="material-symbols-outlined">qr_code_2</span>
            <div>
              <p class="font-label-lg text-label-lg">${r.aPix.length} ${r.aPix.length === 1 ? 'pedido aguardando' : 'pedidos aguardando'} confirmação de Pix</p>
              <p class="font-caption text-caption opacity-90">Total pendente: ${brl.format(totalPix)} · Toque para conferir na aba Pedidos</p>
            </div>
          </div>
          <span class="material-symbols-outlined">arrow_forward</span>
        </button>` : ''}

      <!-- 4 KPI Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="stitch-card p-5 flex flex-col justify-between gap-4 relative overflow-hidden">
          <div class="absolute -right-6 -top-6 w-24 h-24 rounded-full bg-tertiary-fixed/40 blur-xl pointer-events-none"></div>
          <div class="flex items-center justify-between">
            <span class="font-label-sm text-label-sm text-on-surface-variant">Faturamento (${esc(PERIODOS[periodo])})</span>
            <div class="w-9 h-9 rounded-lg bg-tertiary-fixed flex items-center justify-center text-on-tertiary-fixed">
              <span class="material-symbols-outlined text-[20px]">payments</span>
            </div>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-display text-headline-md text-on-surface tabular-nums">${brl.format(r.faturamento)}</span>
            <span class="inline-flex items-center px-2 py-0.5 rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant font-label-sm text-label-sm tabular-nums">
              ${r.vendas.length} ${r.vendas.length === 1 ? 'venda' : 'vendas'}
            </span>
          </div>
          <div class="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div class="h-full bg-tertiary-container rounded-full" style="width:${r.vendas.length ? '100%' : '0%'}"></div>
          </div>
        </div>

        <button type="button" data-ir-pedidos class="stitch-card p-5 flex flex-col justify-between gap-4 relative overflow-hidden text-left hover:shadow-stitch-md transition-all">
          <div class="absolute -right-6 -top-6 w-24 h-24 rounded-full bg-secondary-fixed/50 blur-xl pointer-events-none"></div>
          <div class="flex items-center justify-between w-full">
            <span class="font-label-sm text-label-sm text-on-surface-variant">Pedidos Ativos</span>
            <div class="w-9 h-9 rounded-lg bg-secondary-fixed flex items-center justify-center text-on-secondary-fixed">
              <span class="material-symbols-outlined text-[20px]">skillet</span>
            </div>
          </div>
          <div class="flex items-baseline justify-between gap-2 w-full">
            <span class="font-display text-headline-md text-on-surface tabular-nums">${r.andamento.length}</span>
            <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant font-label-sm text-label-sm">
              <span class="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse"></span>
              Em andamento
            </span>
          </div>
          <div class="flex items-center justify-between w-full font-caption text-caption text-on-surface-variant tabular-nums">
            <span>${novosAtivos} novos · ${emPreparo} preparo</span>
            <span>${emRota} em rota</span>
          </div>
        </button>

        <div class="stitch-card p-5 flex flex-col justify-between gap-4">
          <div class="flex items-center justify-between">
            <span class="font-label-sm text-label-sm text-on-surface-variant">Ticket Médio</span>
            <div class="w-9 h-9 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface">
              <span class="material-symbols-outlined text-[20px]">receipt_long</span>
            </div>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-display text-headline-md text-on-surface tabular-nums">${brl.format(r.ticket)}</span>
            <span class="font-caption text-caption text-on-surface-variant tabular-nums">Base: ${r.vendas.length}</span>
          </div>
          <div class="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div class="h-full bg-primary rounded-full" style="width:${r.ticket > 0 ? '100%' : '0%'}"></div>
          </div>
        </div>

        <div class="stitch-card p-5 flex flex-col justify-between gap-4">
          <div class="flex items-center justify-between">
            <span class="font-label-sm text-label-sm text-on-surface-variant">Cancelamentos</span>
            <div class="w-9 h-9 rounded-lg bg-error-container flex items-center justify-center text-on-error-container">
              <span class="material-symbols-outlined text-[20px]">cancel</span>
            </div>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-display text-headline-md text-error tabular-nums">${r.taxaCancelamento}%</span>
            <span class="inline-flex items-center px-2 py-0.5 rounded-full bg-error-container text-on-error-container font-label-sm text-label-sm tabular-nums">
              ${r.cancelados} ${r.cancelados === 1 ? 'pedido' : 'pedidos'}
            </span>
          </div>
          <div class="font-caption text-caption text-on-surface-variant">
            Sobre ${r.noPeriodo.length} ${r.noPeriodo.length === 1 ? 'pedido' : 'pedidos'} no período
          </div>
        </div>
      </div>

      <!-- Gráfico + Destaques do Cardápio -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div class="lg:col-span-8 stitch-card p-6 flex flex-col justify-between gap-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <span class="font-label-sm text-label-sm uppercase tracking-wider text-tertiary">Receita Bruta</span>
              <h3 class="font-display text-headline-sm text-on-surface">${periodo === 1 ? 'Faturamento dos Últimos 7 Dias' : periodo === 'mes' ? `Faturamento por Dia (${esc(nomeDoMes())})` : `Faturamento por Dia (${PERIODOS[periodo]})`}</h3>
            </div>
            <div class="flex items-center gap-3">
              <div class="flex items-center gap-1.5">
                <span class="w-2.5 h-2.5 rounded-full bg-tertiary-container"></span>
                <span class="font-caption text-caption text-on-surface-variant">Receita Diária</span>
              </div>
              <span class="font-title-md text-title-md text-on-surface tabular-nums">${brl.format(grafico.somaGrafico)}</span>
            </div>
          </div>
          ${grafico.html}
          ${periodo === 1 ? `
            <div class="pt-4 border-t border-surface-container">
              <h4 class="font-label-lg text-label-lg text-on-surface mb-1">Vendas por hora (hoje)</h4>
              ${graficoPorHora(r.vendas)}
            </div>` : ''}
        </div>

        <div class="lg:col-span-4 bg-surface-container rounded-xl p-6 flex flex-col justify-between gap-4">
          <div>
            <span class="font-label-sm text-label-sm uppercase tracking-wider text-primary">Destaques do Cardápio</span>
            <h3 class="font-display text-headline-sm text-on-surface">Mais Vendidos ${esc(rotuloPeriodo)}</h3>
          </div>
          <div class="flex flex-col gap-3">
            ${produtosHtml}
          </div>
          <button type="button" data-aba="produtos" class="inline-flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-surface-container-highest text-on-surface font-label-lg text-label-lg hover:bg-surface-dim transition-colors">
            <span>Ver Cardápio Completo</span>
            <span class="material-symbols-outlined text-[18px]">arrow_forward</span>
          </button>
        </div>
      </div>

      <!-- Formas de Pagamento + Bairros -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="stitch-card p-6">
          <span class="font-label-sm text-label-sm uppercase tracking-wider text-primary">Recebimentos</span>
          <h3 class="font-display text-headline-sm text-on-surface mb-3">Formas de pagamento ${esc(rotuloPeriodo)}</h3>
          ${listaSimples(r.pagamentos, 'Sem vendas no período.', (d) => brl.format(d.v))}
        </div>
        <div class="stitch-card p-6">
          <span class="font-label-sm text-label-sm uppercase tracking-wider text-primary">Regiões</span>
          <h3 class="font-display text-headline-sm text-on-surface mb-3">Bairros que mais pedem ${esc(rotuloPeriodo)}</h3>
          ${listaSimples(r.bairros, 'Sem vendas no período.')}
        </div>
      </div>

      <!-- Tabela Pedidos Recentes -->
      <div class="stitch-card p-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <span class="font-label-sm text-label-sm uppercase tracking-wider text-primary">Fluxo em Tempo Real</span>
            <h3 class="font-display text-headline-sm text-on-surface">Pedidos Recentes (${esc(PERIODOS[periodo])})</h3>
          </div>
          <button type="button" data-ir-pedidos class="stitch-btn-ghost text-label-sm px-3.5 py-2">
            <span>Abrir Pedidos</span>
            <span class="material-symbols-outlined text-[16px]">arrow_forward</span>
          </button>
        </div>

        ${recentes.length ? `
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="text-on-surface-variant font-label-sm text-label-sm bg-surface-container-low">
                  <th class="py-3 px-4 rounded-l-lg">Pedido</th>
                  <th class="py-3 px-4">Local / Pagto</th>
                  <th class="py-3 px-4">Itens</th>
                  <th class="py-3 px-4">Total</th>
                  <th class="py-3 px-4">Status</th>
                  <th class="py-3 px-4 rounded-r-lg text-right">Tempo</th>
                </tr>
              </thead>
              <tbody class="font-body-md text-body-md">
                ${linhasRecentes}
              </tbody>
            </table>
          </div>` : '<p class="text-body-md text-on-surface-variant py-4">Nenhum pedido registrado neste período.</p>'}
      </div>

      <p class="font-caption text-caption text-on-surface-variant text-center">
        Faturamento e pedidos válidos não incluem cancelados nem pedidos aguardando confirmação de Pix.
      </p>
    </div>`;
}

// ---------- Abrir / fechar a aba ----------
export function abrirAbaPainel() {
  carregarPainel();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) carregarPainel(); }, INTERVALO_ATUALIZACAO_MS);
}

export function fecharAbaPainel() {
  clearInterval(timer);
  timer = null;
}

export function inicializarAbaPainel() {
  $('painel-conteudo').addEventListener('click', (e) => {
    const botaoPeriodo = e.target.closest('[data-periodo]');
    if (botaoPeriodo) {
      const escolhido = botaoPeriodo.dataset.periodo;
      periodo = escolhido === 'mes' ? 'mes' : Number(escolhido);
      carregarPainel();
      return;
    }
    const delta = e.target.closest('[data-mes-delta]');
    if (delta) { if (!delta.disabled) deslocarMes(Number(delta.dataset.mesDelta)); return; }
    if (e.target.matches('[data-mes-input]')) {
      try { if (e.target.showPicker) e.target.showPicker(); } catch (erro) { /* navegador sem suporte */ }
      return;
    }
    if (e.target.closest('[data-atualizar]')) { carregarPainel(); return; }
    if (e.target.closest('[data-ir-pedidos]')) {
      const aba = document.querySelector('[data-aba="pedidos"]');
      if (aba) aba.click();
    }
  });

  $('painel-conteudo').addEventListener('change', (e) => {
    if (e.target.matches('[data-mes-input]')) escolherMes(e.target.value);
  });
}
