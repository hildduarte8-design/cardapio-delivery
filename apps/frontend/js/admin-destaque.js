import { state } from './admin-state.js';
import { $, brl, esc, num, aviso, atualizar, achar } from './admin-utils.js';

const LIMITE = 6;
const BTN = 'min-height:44px;border:1px solid #3a3a3a;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;padding:0 12px;flex:1;';
const estiloBtn = (on) => BTN + (on ? 'background:#C9A24B;color:#16171A;border-color:#C9A24B;' : 'background:transparent;color:inherit;');
const total = () => (state.produtos || []).filter((p) => p.destaque).length;
const txtPromo = (p) => (p.preco_promocional ? Number(p.preco_promocional).toFixed(2) : '');

function contador() {
  let el = $('dest-contador');
  if (!el) {
    el = document.createElement('p');
    el.id = 'dest-contador';
    el.style.cssText = 'font-size:13px;font-weight:700;margin:8px 0;';
    $('lista-produtos').before(el);
  }
  el.textContent = `⭐ Destaques: ${total()}/${LIMITE}`;
}

function montar() {
  const lista = $('lista-produtos');
  if (!lista || !state.produtos) return;
  lista.querySelectorAll('.dest-linha').forEach((e) => e.remove());
  [...lista.children].forEach((card) => {
    const b = card.querySelector && card.querySelector('[data-toggle]');
    const p = b && achar(state.produtos, b.dataset.toggle);
    if (!p) return;
    const linha = document.createElement('div');
    linha.className = 'dest-linha';
    linha.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
    linha.innerHTML =
      `<button type="button" data-dest="${esc(p.id)}" style="${estiloBtn(p.destaque)}">${p.destaque ? '⭐ Em destaque' : '☆ Destaque'}</button>` +
      `<label style="display:flex;align-items:center;gap:4px;flex:1;border:1px solid #3a3a3a;border-radius:10px;padding:0 8px;min-height:44px;">` +
      `<span style="font-size:12px;opacity:.7">Promo R$</span>` +
      `<input data-promo="${esc(p.id)}" type="number" step="0.01" min="0.01" inputmode="decimal" value="${txtPromo(p)}" placeholder="—" aria-label="Preço promocional de ${esc(p.nome)}" style="width:100%;background:transparent;color:inherit;border:0;outline:none;font-weight:600;" /></label>`;
    card.appendChild(linha);
  });
  contador();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-dest]');
  if (!b) return;
  const p = achar(state.produtos, b.dataset.dest);
  if (!p) return;
  const ligar = !p.destaque;
  if (ligar && total() >= LIMITE) return aviso(`Limite de ${LIMITE} destaques. Tire um para marcar outro.`);
  b.disabled = true;
  const r = await atualizar('produtos', p.id, { destaque: ligar }, ligar ? 'Item em destaque' : 'Destaque removido');
  b.disabled = false;
  if (!r) return;
  p.destaque = r.destaque;
  b.style.cssText = estiloBtn(p.destaque);
  b.textContent = p.destaque ? '⭐ Em destaque' : '☆ Destaque';
  contador();
});

document.addEventListener('change', async (e) => {
  const inp = e.target.closest('[data-promo]');
  if (!inp) return;
  const p = achar(state.produtos, inp.dataset.promo);
  if (!p) return;
  const texto = inp.value.trim();
  const valor = texto === '' ? null : num(texto);
  if (valor !== null && (!(valor > 0) || valor >= Number(p.preco))) {
    aviso('A promoção deve ser menor que o preço normal');
    inp.value = txtPromo(p);
    return;
  }
  const r = await atualizar('produtos', p.id, { preco_promocional: valor },
    valor === null ? 'Promoção removida' : `Promoção: ${brl.format(valor)}`);
  if (r) p.preco_promocional = r.preco_promocional;
  else inp.value = txtPromo(p);
});

document.addEventListener('admin:produtos-renderizados', montar);
if (state.produtos && state.produtos.length) montar();
