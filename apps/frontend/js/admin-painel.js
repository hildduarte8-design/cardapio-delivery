// Aba "Painel": números de vendas calculados no navegador a partir da tabela pedidos.
// Só lê dados (RLS já limita ao restaurante do usuário). Não altera nada no banco.
import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, tratarErro } from './admin-utils.js';

const PERIODOS = { 1: 'Hoje', 7: '7 dias', 30: '30 dias' };
const INTERVALO_ATUALIZACAO_MS = 60000;

let periodo = 1;
let pedidos = [];
let carregando = false;
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

function rotuloDia(d, curto) {
  if (curto) return new Intl.DateTimeFormat('pt-BR', { weekday: 'short' }).format(d).replace('.', '');
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function compacto(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(1).replace('.', ',')}k` : String(Math.round(v));
}

// ---------- Dados ----------
export async function carregarPainel() {
  if (!sb || !state.rest || carregando) return;
  carregando = true;
  try {
    const desde = inicioDoDia(new Date(), Math.max(periodo, 7) - 1);
    const { data, error } = await sb
      .from('pedidos')
      .select('id, status, total, created_at, forma_pagamento, bairro_id, itens')
      .eq('restaurante_id', state.rest.id)
      .gte('created_at', desde.toISOString())
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) {
      tratarErro(error, 'Não foi possível carregar o painel.');
      $('painel-conteudo').innerHTML = '<p class="dash-vazio">Não foi possível carregar os números. Toque em "Atualizar" para tentar de novo.</p>' +
        '<p style="margin-top:12px"><button type="button" class="dash-btn" data-atualizar>Atualizar</button></p>';
      return;
    }
    pedidos = data || [];
    renderPainel();
  } finally {
    carregando = false;
  }
}

// ---------- Cálculo ----------
function calcular() {
  const inicio = inicioDoDia(new Date(), periodo - 1);
  const noPeriodo = pedidos.filter((p) => new Date(p.created_at) >= inicio);
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

  return {
    vendas, faturamento, aPix, andamento, bairros, pagamentos, produtos,
    cancelados: noPeriodo.filter((p) => p.status === 'cancelado').length,
    ticket: vendas.length ? faturamento / vendas.length : 0
  };
}

function barras(colunas) {
  const maximo = Math.max(...colunas.map((c) => c.v), 0);
  return '<div class="dash-barras">' + colunas.map((c) => {
    const altura = maximo > 0 && c.v > 0 ? Math.max(3, Math.round((c.v / maximo) * 100)) : 0;
    return `<div class="dash-col" title="${esc(c.titulo)}">
      <span>${c.v > 0 ? esc(compacto(c.v)) : ''}</span>
      <div class="dash-area"><div class="dash-barra" style="height:${altura}%"></div></div>
      <span>${esc(c.rotulo)}</span></div>`;
  }).join('') + '</div>';
}

function graficoPorDia() {
  const dias = periodo === 1 ? 7 : periodo;
  const passo = dias > 14 ? 5 : 1;
  const colunas = [];
  for (let i = dias - 1; i >= 0; i--) {
    const dia = inicioDoDia(new Date(), i);
    const total = pedidos.filter((p) => ehVenda(p) && chaveDia(new Date(p.created_at)) === chaveDia(dia))
      .reduce((s, p) => s + valor(p), 0);
    const posicao = dias - 1 - i;
    colunas.push({ v: total, titulo: `${rotuloDia(dia, false)}: ${brl.format(total)}`,
      rotulo: posicao % passo === 0 || i === 0 ? rotuloDia(dia, dias <= 7) : '' });
  }
  return barras(colunas);
}

function graficoPorHora(vendas) {
  if (!vendas.length) return '<p class="dash-vazio">Ainda não há vendas hoje.</p>';
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

const lista = (itens, vazio) => itens.length
  ? '<ul class="dash-lista">' + itens.join('') + '</ul>'
  : `<p class="dash-vazio">${vazio}</p>`;

// ---------- Tela ----------
function renderPainel() {
  const r = calcular();
  const rotuloPeriodo = periodo === 1 ? 'hoje' : `nos últimos ${periodo} dias`;
  const hoje = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  const periodos = Object.entries(PERIODOS).map(([dias, nome]) =>
    `<button type="button" class="dash-btn" data-periodo="${dias}" aria-pressed="${Number(dias) === periodo}">${nome}</button>`).join('');

  const totalPix = r.aPix.reduce((s, p) => s + valor(p), 0);

  $('painel-conteudo').innerHTML = `
    <div class="dash-topo">
      <div><h2>Painel</h2><span class="dash-d">${esc(hoje)}</span></div>
      <button type="button" class="dash-btn" data-atualizar>Atualizar</button>
    </div>
    <div class="dash-periodos">${periodos}</div>

    <div class="dash-grade">
      <div class="dash-k"><span class="dash-l">Faturamento</span><span class="dash-n">${brl.format(r.faturamento)}</span></div>
      <div class="dash-k"><span class="dash-l">Pedidos</span><span class="dash-n">${r.vendas.length}</span></div>
      <div class="dash-k"><span class="dash-l">Ticket médio</span><span class="dash-n">${brl.format(r.ticket)}</span></div>
      <button type="button" class="dash-k" data-ir-pedidos><span class="dash-l">Em andamento</span><span class="dash-n">${r.andamento.length}</span></button>
      <button type="button" class="dash-k ${r.aPix.length ? 'dash-alerta' : ''}" data-ir-pedidos><span class="dash-l">Aguardando Pix</span><span class="dash-n">${r.aPix.length ? `${r.aPix.length} · ${brl.format(totalPix)}` : '0'}</span></button>
      <div class="dash-k"><span class="dash-l">Cancelados</span><span class="dash-n">${r.cancelados}</span></div>
    </div>

    <div class="dash-bloco">
      <h3>${periodo === 1 ? 'Faturamento dos últimos 7 dias' : `Faturamento por dia (${PERIODOS[periodo]})`}</h3>
      ${graficoPorDia()}
    </div>
    ${periodo === 1 ? `<div class="dash-bloco"><h3>Vendas por hora (hoje)</h3>${graficoPorHora(r.vendas)}</div>` : ''}

    <div class="dash-bloco"><h3>Mais vendidos ${rotuloPeriodo}</h3>
      ${lista(r.produtos.map(([nome, d]) => `<li><span>${esc(nome)}</span><strong>${d.q}x</strong></li>`), 'Sem vendas no período.')}</div>
    <div class="dash-bloco"><h3>Formas de pagamento ${rotuloPeriodo}</h3>
      ${lista(r.pagamentos.map(([nome, d]) => `<li><span>${esc(nome)} · ${d.q} ${d.q === 1 ? 'pedido' : 'pedidos'}</span><strong>${brl.format(d.v)}</strong></li>`), 'Sem vendas no período.')}</div>
    <div class="dash-bloco"><h3>Bairros que mais pedem ${rotuloPeriodo}</h3>
      ${lista(r.bairros.map(([nome, d]) => `<li><span>${esc(nome)}</span><strong>${d.q} ${d.q === 1 ? 'pedido' : 'pedidos'}</strong></li>`), 'Sem vendas no período.')}</div>
    <p class="dash-vazio" style="margin-top:6px">Faturamento e pedidos não incluem cancelados nem pedidos aguardando Pix.</p>`;
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
      periodo = Number(botaoPeriodo.dataset.periodo);
      carregarPainel();
      return;
    }
    if (e.target.closest('[data-atualizar]')) { carregarPainel(); return; }
    if (e.target.closest('[data-ir-pedidos]')) {
      const aba = document.querySelector('[data-aba="pedidos"]');
      if (aba) aba.click();
    }
  });
}
