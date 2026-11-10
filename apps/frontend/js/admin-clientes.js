import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, esc, aviso, tratarErro, atualizar, achar } from './admin-utils.js';

const META = 10;
let clientes = [];
let busca = '';
let carregando = false;

const digitos = (t) => String(t || '').replace(/\D/g, '');
const normalizar = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const BTN = 'min-height:44px;min-width:44px;border:1px solid #3a3a3a;border-radius:10px;background:#1f1f1f;color:#F2EFE8;font-weight:800;font-size:16px;cursor:pointer;padding:0 12px;';

function fone(t) {
  let n = digitos(t);
  if (n.startsWith('55') && n.length > 11) n = n.slice(2);
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return String(t || '—');
}

function linkZap(tel, nome) {
  let n = digitos(tel);
  if (n.length < 10) return null;
  if (!n.startsWith('55') && n.length <= 11) n = '55' + n;
  const primeiro = String(nome || '').trim().split(/\s+/)[0];
  return `https://wa.me/${n}?text=${encodeURIComponent('Oi' + (primeiro ? ' ' + primeiro : '') + ', tudo bem?')}`;
}

function ultimo(iso) {
  if (!iso) return 'sem pedidos';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const dias = Math.floor((Date.now() - d.getTime()) / 86400000);
  return `${d.toLocaleDateString('pt-BR')} (${dias <= 0 ? 'hoje' : 'há ' + dias + (dias === 1 ? ' dia' : ' dias')})`;
}

function render() {
  const raiz = $('clientes-lista');
  if (!raiz) return;
  const termo = normalizar(busca).trim();
  const num = digitos(busca);
  const lista = clientes.filter((c) => !termo ||
    normalizar(c.nome).includes(termo) || (num.length >= 3 && digitos(c.telefone).includes(num)));

  const cheios = clientes.filter((c) => (c.selos_fidelidade || 0) >= META).length;
  $('clientes-resumo').textContent =
    `${clientes.length} ${clientes.length === 1 ? 'cliente' : 'clientes'} · ${cheios} com cartão cheio (${META} selos)`;

  if (!lista.length) {
    raiz.innerHTML = `<p class="secao-desc">${clientes.length ? 'Nenhum cliente encontrado.' : 'Ainda não há clientes cadastrados.'}</p>`;
    return;
  }

  raiz.innerHTML = lista.map((c) => {
    const selos = c.selos_fidelidade || 0;
    const pct = Math.min(100, Math.round((selos / META) * 100));
    const zap = linkZap(c.telefone, c.nome);
    return `<div style="border:1px solid #3a3a3a;border-radius:14px;padding:12px;margin-bottom:10px;background:#2a2a2a;color:#F2EFE8;">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
        <div style="min-width:0;">
          <strong style="font-size:15px;">${esc(c.nome || 'Sem nome')}</strong>
          <div style="font-size:12.5px;opacity:.75;margin-top:2px;">${esc(fone(c.telefone))}</div>
          <div style="font-size:12px;opacity:.65;margin-top:2px;">Último pedido: ${esc(ultimo(c.ultimo_pedido_em))}</div>
        </div>
        ${zap ? `<a href="${esc(zap)}" target="_blank" rel="noopener noreferrer" style="${BTN}display:inline-flex;align-items:center;text-decoration:none;font-size:13px;flex:none;">WhatsApp</a>` : ''}
      </div>
      <div style="margin-top:10px;">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;"><span>Fidelidade</span><strong>${selos}/${META}</strong></div>
        <div style="height:8px;border-radius:6px;background:#1f1f1f;margin-top:4px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:#C9A24B;"></div></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
        <button type="button" data-selo="${esc(c.id)}" data-d="-1" style="${BTN}" aria-label="Tirar um selo">−</button>
        <button type="button" data-selo="${esc(c.id)}" data-d="1" style="${BTN}" aria-label="Dar um selo">+</button>
        ${selos >= META ? `<button type="button" data-resgatar="${esc(c.id)}" style="${BTN}flex:1;background:#C9A24B;color:#16171A;border-color:#C9A24B;font-size:14px;">🎁 Resgatar brinde</button>` : '<span style="flex:1"></span>'}
      </div>
    </div>`;
  }).join('');
}

async function carregar() {
  if (carregando || !state.rest || !sb) return;
  carregando = true;
  const { data, error } = await sb
    .from('clientes')
    .select('id, nome, telefone, endereco, selos_fidelidade, ultimo_pedido_em')
    .eq('restaurante_id', state.rest.id)
    .order('ultimo_pedido_em', { ascending: false, nullsFirst: false })
    .limit(1000);
  carregando = false;
  if (error) return tratarErro(error, 'Erro ao carregar clientes.');
  clientes = data || [];
  render();
}

async function mudarSelos(id, novo, msg) {
  const c = achar(clientes, id);
  if (!c) return;
  const valor = Math.max(0, Math.min(99, novo));
  if (valor === (c.selos_fidelidade || 0)) return;
  const r = await atualizar('clientes', c.id, { selos_fidelidade: valor }, msg);
  if (r) { c.selos_fidelidade = r.selos_fidelidade; render(); }
}

document.addEventListener('click', async (e) => {
  const s = e.target.closest('[data-selo]');
  if (s) {
    const c = achar(clientes, s.dataset.selo);
    if (c) await mudarSelos(c.id, (c.selos_fidelidade || 0) + Number(s.dataset.d), 'Selos atualizados');
    return;
  }
  const r = e.target.closest('[data-resgatar]');
  if (r) {
    const c = achar(clientes, r.dataset.resgatar);
    if (c && confirm(`Resgatar o brinde de ${c.nome || 'este cliente'}? Isso desconta ${META} selos.`)) {
      await mudarSelos(c.id, (c.selos_fidelidade || 0) - META, 'Brinde resgatado');
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'clientes-busca') { busca = e.target.value; render(); }
});

// Carrega sempre que a aba Clientes fica visível
const aba = $('aba-clientes');
if (aba) {
  new MutationObserver(() => { if (!aba.classList.contains('hidden')) carregar(); })
    .observe(aba, { attributes: true, attributeFilter: ['class'] });
  if (!aba.classList.contains('hidden')) carregar();
}
