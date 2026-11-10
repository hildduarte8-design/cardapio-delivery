import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, esc, tratarErro } from './admin-utils.js';

const BTN = 'min-height:44px;border:1px solid #3a3a3a;border-radius:10px;background:#1f1f1f;color:#F2EFE8;font-weight:700;font-size:14px;cursor:pointer;padding:0 14px;';
let dias = 30;
let carregando = false;

function dataHora(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function quem(id) {
  return id ? 'usuário …' + String(id).slice(-6) : '—';
}

function garantirBotao() {
  const resumo = $('clientes-resumo');
  if (!resumo || $('btn-selos-relatorio')) return;
  resumo.insertAdjacentHTML('afterend',
    `<button type="button" id="btn-selos-relatorio" style="${BTN}margin:8px 0;">📋 Ajustes de selos</button>`);
}

function painel() {
  let p = $('selos-relatorio');
  if (p) return p;
  p = document.createElement('div');
  p.id = 'selos-relatorio';
  p.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:flex;align-items:flex-end;justify-content:center;';
  p.innerHTML = `<div style="background:#16171A;color:#F2EFE8;width:100%;max-width:640px;max-height:90vh;overflow:auto;border-radius:16px 16px 0 0;padding:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <strong style="font-size:16px;">Ajustes de selos</strong>
      <button type="button" data-fechar-selos style="${BTN}">Fechar</button>
    </div>
    <div style="margin:10px 0;">
      <select id="selos-rel-dias" style="${BTN}">
        <option value="7">Últimos 7 dias</option>
        <option value="30" selected>Últimos 30 dias</option>
        <option value="90">Últimos 90 dias</option>
      </select>
    </div>
    <div id="selos-rel-corpo"></div>
  </div>`;
  document.body.appendChild(p);
  return p;
}

async function carregar() {
  const corpo = $('selos-rel-corpo');
  if (!corpo || carregando || !state.rest || !sb) return;
  carregando = true;
  corpo.innerHTML = '<p style="opacity:.7;">Carregando…</p>';

  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const { data, error } = await sb
    .from('selos_historico')
    .select('id, delta, saldo_depois, tipo, motivo, usuario_id, created_at, clientes!inner(nome, restaurante_id)')
    .in('tipo', ['manual', 'resgate'])
    .eq('clientes.restaurante_id', state.rest.id)
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .limit(200);
  carregando = false;
  if (error) { corpo.innerHTML = ''; return tratarErro(error, 'Erro ao carregar o relatório.'); }

  const lista = data || [];
  const dados = lista.filter((l) => l.tipo === 'manual' && l.delta > 0).reduce((s, l) => s + l.delta, 0);
  const tirados = lista.filter((l) => l.tipo === 'manual' && l.delta < 0).reduce((s, l) => s - l.delta, 0);
  const resgates = lista.filter((l) => l.tipo === 'resgate').length;

  const resumo = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;font-size:13px;">
    <span style="background:#2a2a2a;border-radius:10px;padding:8px 10px;">➕ Dados na mão: <strong>${dados}</strong></span>
    <span style="background:#2a2a2a;border-radius:10px;padding:8px 10px;">➖ Tirados: <strong>${tirados}</strong></span>
    <span style="background:#2a2a2a;border-radius:10px;padding:8px 10px;">🎁 Brindes resgatados: <strong>${resgates}</strong></span>
  </div>`;

  if (!lista.length) {
    corpo.innerHTML = resumo + '<p style="opacity:.7;">Nenhum ajuste manual neste período.</p>';
    return;
  }

  corpo.innerHTML = resumo + lista.map((l) => {
    const resg = l.tipo === 'resgate';
    const cor = resg ? '#C9A24B' : (l.delta > 0 ? '#E5736B' : '#8FC98F');
    const sinal = l.delta > 0 ? '+' + l.delta : String(l.delta);
    return `<div style="border:1px solid #3a3a3a;border-radius:12px;padding:10px;margin-bottom:8px;background:#2a2a2a;">
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <strong style="font-size:14px;">${esc(l.clientes?.nome || 'Cliente')}</strong>
        <strong style="color:${cor};">${resg ? '🎁 ' : ''}${esc(sinal)} selo${Math.abs(l.delta) === 1 ? '' : 's'}</strong>
      </div>
      <div style="font-size:13px;margin-top:4px;">Motivo: ${esc(l.motivo || '—')}</div>
      <div style="font-size:12px;opacity:.65;margin-top:4px;">${esc(dataHora(l.created_at))} · ${esc(quem(l.usuario_id))} · ficou com ${esc(l.saldo_depois)}</div>
    </div>`;
  }).join('');
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#btn-selos-relatorio')) {
    painel().style.display = 'flex';
    carregar();
    return;
  }
  const p = $('selos-relatorio');
  if (p && (e.target.closest('[data-fechar-selos]') || e.target === p)) p.style.display = 'none';
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'selos-rel-dias') { dias = Number(e.target.value) || 30; carregar(); }
});

garantirBotao();
