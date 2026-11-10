import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, esc, aviso, tratarErro } from './admin-utils.js';
import { carregarProdutos } from './admin-produtos.js';

let ordemCats = [];
const fechadas = new Set();
let ocupado = false;

const catDe = (p) => p.categoria || 'Geral';
const BTN = 'width:44px;height:44px;flex:none;border:1px solid #3a3a3a;background:#1f1f1f;color:#F2EFE8;border-radius:10px;font-size:15px;cursor:pointer;';
const CAB = 'display:flex;align-items:center;gap:8px;margin:16px 0 8px;padding:8px 8px 8px 12px;background:#2a2a2a;color:#F2EFE8;border:1px solid #3a3a3a;border-radius:12px;';

function agrupar() {
  const mapa = new Map();
  for (const p of state.produtos || []) {
    const c = catDe(p);
    if (!mapa.has(c)) mapa.set(c, []);
    mapa.get(c).push(p);
  }
  const nomes = [...mapa.keys()].sort((a, b) => {
    const ia = ordemCats.indexOf(a), ib = ordemCats.indexOf(b);
    return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib) || a.localeCompare(b, 'pt-BR');
  });
  return nomes.map((nome) => ({
    nome,
    itens: mapa.get(nome).sort((a, b) =>
      (a.ordem || 0) - (b.ordem || 0) || String(a.nome).localeCompare(String(b.nome), 'pt-BR'))
  }));
}

function organizar() {
  const lista = $('lista-produtos');
  if (!lista || !state.produtos || !state.produtos.length) return;

  lista.querySelectorAll('.ord-cab').forEach((e) => e.remove());
  const cartoes = new Map();
  [...lista.children].forEach((el) => {
    const b = el.querySelector && el.querySelector('[data-toggle]');
    if (b) cartoes.set(String(b.dataset.toggle), el);
  });

  const grupos = agrupar();
  grupos.forEach((g, gi) => {
    const ativos = g.itens.filter((p) => p.disponivel).length;
    const aberta = !fechadas.has(g.nome);
    const cab = document.createElement('div');
    cab.className = 'ord-cab';
    cab.style.cssText = CAB;
    cab.innerHTML =
      `<button type="button" data-ord-abrir="${esc(g.nome)}" style="flex:1;min-height:44px;text-align:left;background:none;border:0;color:inherit;cursor:pointer;">` +
      `<strong>${aberta ? '▾' : '▸'} ${esc(g.nome)}</strong><br>` +
      `<small style="opacity:.7">${g.itens.length} ${g.itens.length === 1 ? 'item' : 'itens'} · ${ativos} ${ativos === 1 ? 'ativo' : 'ativos'}</small></button>` +
      `<button type="button" data-ord-cat="${esc(g.nome)}" data-dir="-1" style="${BTN}${gi === 0 ? 'opacity:.35;' : ''}" aria-label="Subir categoria">▲</button>` +
      `<button type="button" data-ord-cat="${esc(g.nome)}" data-dir="1" style="${BTN}${gi === grupos.length - 1 ? 'opacity:.35;' : ''}" aria-label="Descer categoria">▼</button>`;
    lista.appendChild(cab);

    g.itens.forEach((p, i) => {
      const el = cartoes.get(String(p.id));
      if (!el) return;
      el.style.display = aberta ? '' : 'none';
      el.style.marginBottom = '8px';
      el.querySelectorAll('.ord-setas').forEach((x) => x.remove());
      const barra = document.createElement('div');
      barra.className = 'ord-setas';
      barra.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:8px;';
      barra.innerHTML =
        `<button type="button" data-ord-prod="${esc(p.id)}" data-dir="-1" style="${BTN}${i === 0 ? 'opacity:.35;' : ''}" aria-label="Subir item">▲</button>` +
        `<button type="button" data-ord-prod="${esc(p.id)}" data-dir="1" style="${BTN}${i === g.itens.length - 1 ? 'opacity:.35;' : ''}" aria-label="Descer item">▼</button>`;
      el.appendChild(barra);
      lista.appendChild(el);
    });
  });
}

async function buscarOrdemCategorias() {
  if (!state.rest || !sb) return;
  const { data, error } = await sb.from('restaurantes').select('ordem_categorias').eq('id', state.rest.id).maybeSingle();
  if (!error && data && Array.isArray(data.ordem_categorias)) ordemCats = data.ordem_categorias;
  organizar();
}

async function moverCategoria(nome, dir) {
  if (ocupado) return;
  const nomes = agrupar().map((g) => g.nome);
  const i = nomes.indexOf(nome), j = i + dir;
  if (i < 0 || j < 0 || j >= nomes.length) return;
  [nomes[i], nomes[j]] = [nomes[j], nomes[i]];

  ocupado = true;
  const { data, error } = await sb.from('restaurantes')
    .update({ ordem_categorias: nomes }).eq('id', state.rest.id).select('ordem_categorias');
  ocupado = false;

  if (error || !data || !data.length) return tratarErro(error, 'Não foi possível salvar a ordem das categorias.');
  ordemCats = nomes;
  organizar();
}

async function moverProduto(id, dir) {
  if (ocupado) return;
  const p = (state.produtos || []).find((x) => String(x.id) === String(id));
  if (!p) return;
  const g = agrupar().find((x) => x.nome === catDe(p));
  const i = g.itens.indexOf(p), j = i + dir;
  if (j < 0 || j >= g.itens.length) return;

  const novos = [...g.itens];
  [novos[i], novos[j]] = [novos[j], novos[i]];
  const mudancas = novos.map((x, k) => ({ x, ordem: (k + 1) * 10 })).filter((m) => (m.x.ordem || 0) !== m.ordem);

  ocupado = true;
  const res = await Promise.all(mudancas.map((m) =>
    sb.from('produtos').update({ ordem: m.ordem }).eq('id', m.x.id).select('id')));
  ocupado = false;

  if (res.some((r) => r.error || !r.data || !r.data.length)) {
    tratarErro((res.find((r) => r.error) || {}).error, 'Não foi possível salvar a ordem dos itens.');
    await carregarProdutos();
    return;
  }
  mudancas.forEach((m) => { m.x.ordem = m.ordem; });
  organizar();
}

document.addEventListener('click', (e) => {
  const ab = e.target.closest('[data-ord-abrir]');
  if (ab) {
    const n = ab.dataset.ordAbrir;
    if (fechadas.has(n)) fechadas.delete(n); else fechadas.add(n);
    return organizar();
  }
  const c = e.target.closest('[data-ord-cat]');
  if (c) return moverCategoria(c.dataset.ordCat, Number(c.dataset.dir));
  const p = e.target.closest('[data-ord-prod]');
  if (p) return moverProduto(p.dataset.ordProd, Number(p.dataset.dir));
});

document.addEventListener('admin:produtos-renderizados', organizar);
document.addEventListener('admin:produtos-carregados', buscarOrdemCategorias);
if (state.produtos && state.produtos.length) buscarOrdemCategorias();
