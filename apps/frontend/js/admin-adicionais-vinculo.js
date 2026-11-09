import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, aviso, tratarErro, achar } from './admin-utils.js';
import { listarAdicionais } from './admin-adicionais.js';

// produto_id -> conjunto de adicional_id
const vinculos = new Map();
let salvando = false;
let eventosConfigurados = false;

export async function carregarVinculos() {
  if (!state.rest || !sb) return;

  const { data, error } = await sb
    .from('produto_adicionais')
    .select('produto_id, adicional_id')
    .eq('restaurante_id', state.rest.id);

  if (error) {
    tratarErro(error, 'Erro ao carregar os adicionais dos produtos.');
    return;
  }

  vinculos.clear();
  (data || []).forEach(({ produto_id, adicional_id }) => {
    if (!vinculos.has(produto_id)) vinculos.set(produto_id, new Set());
    vinculos.get(produto_id).add(adicional_id);
  });

  atualizarContadores();
}

// Escreve "Adicionais (n)" em cada botão de produto
function atualizarContadores() {
  const existentes = new Set(listarAdicionais().map((item) => item.id));

  document.querySelectorAll('[data-adicionais]').forEach((botao) => {
    const ids = vinculos.get(botao.dataset.adicionais);
    let quantidade = 0;
    if (ids) ids.forEach((id) => { if (existentes.has(id)) quantidade++; });
    botao.textContent = quantidade > 0 ? `➕ Adicionais (${quantidade})` : '➕ Adicionais';
  });
}

/* ===== Janela de escolha ===== */

function teclaEsc(evento) {
  if (evento.key === 'Escape') fecharJanela();
}

function fecharJanela() {
  const janela = $('sheet-adicionais');
  if (janela) janela.remove();
  document.removeEventListener('keydown', teclaEsc);
}

function linhaAdicional(item, marcado) {
  const preco = Number(item.preco) > 0 ? `+ ${brl.format(Number(item.preco))}` : 'Grátis';
  const foto = item.imagem_url
    ? `<img src="${esc(item.imagem_url)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block" />`
    : '🍴';

  return `
    <label style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #2e2e32;cursor:pointer">
      <span style="width:44px;height:44px;flex:none;border-radius:10px;overflow:hidden;background:#2a2a2a;display:flex;align-items:center;justify-content:center;font-size:18px">${foto}</span>
      <span style="flex:1;min-width:0">
        <strong style="display:block;font-size:14px">${esc(item.nome)}${item.ativo ? '' : ' (pausado)'}</strong>
        <span style="font-size:12px;color:#9a9a9a">${preco}</span>
      </span>
      <input type="checkbox" data-vinc-check="${esc(item.id)}" ${marcado ? 'checked' : ''} style="width:22px;height:22px;flex:none;accent-color:#d4a437" />
    </label>`;
}

function abrirJanela(produto) {
  fecharJanela();

  const todos = listarAdicionais();
  const marcados = vinculos.get(produto.id) || new Set();
  const categoria = produto.categoria || 'Geral';
  const mesmaCategoria = state.produtos.filter((p) => (p.categoria || 'Geral') === categoria);

  const lista = todos.length
    ? todos.map((item) => linhaAdicional(item, marcados.has(item.id))).join('')
    : '<p style="font-size:13px;color:#9a9a9a;padding:12px 0">Você ainda não cadastrou adicionais. Use a seção “Adicionais” mais abaixo para criar o primeiro.</p>';

  const aplicarCategoria = mesmaCategoria.length > 1
    ? `<label style="display:flex;gap:10px;align-items:flex-start;font-size:12px;color:#cfcfcf;margin-bottom:12px;cursor:pointer">
        <input type="checkbox" id="sheet-ad-categoria" style="width:18px;height:18px;flex:none;accent-color:#d4a437;margin-top:1px" />
        <span>Aplicar esta escolha a todos os ${mesmaCategoria.length} produtos de “${esc(categoria)}” (substitui a escolha que eles já têm)</span>
      </label>`
    : '';

  const janela = document.createElement('div');
  janela.id = 'sheet-adicionais';
  janela.setAttribute('role', 'dialog');
  janela.setAttribute('aria-modal', 'true');
  janela.setAttribute('aria-label', `Adicionais de ${produto.nome}`);
  janela.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.65);display:flex;align-items:flex-end;justify-content:center;';

  janela.innerHTML = `
    <div style="width:100%;max-width:560px;max-height:88vh;display:flex;flex-direction:column;background:#1d1d20;color:#f1f1f1;border-radius:20px 20px 0 0;border:1px solid #2e2e32">
      <div style="padding:16px 16px 8px">
        <h2 style="font-size:16px;font-weight:700;margin:0">Adicionais de ${esc(produto.nome)}</h2>
        <p style="font-size:12px;color:#9a9a9a;margin:4px 0 0">Marque o que o cliente poderá acrescentar a este produto.</p>
      </div>
      <div style="overflow:auto;padding:0 16px;flex:1">${lista}</div>
      <div style="padding:12px 16px 16px;border-top:1px solid #2e2e32">
        ${aplicarCategoria}
        <div style="display:flex;gap:8px">
          <button type="button" id="sheet-ad-cancelar" class="px-3 py-2 text-xs font-bold rounded-lg border" style="flex:1;color:#f1f1f1;cursor:pointer">Cancelar</button>
          <button type="button" id="sheet-ad-salvar" class="px-3 py-2 text-xs font-bold rounded-lg" style="flex:1;background:var(--dourado,#d4a437);color:#1a1a1a;border:0;cursor:pointer">Salvar</button>
        </div>
      </div>
    </div>`;

  janela.addEventListener('click', (evento) => {
    if (evento.target === janela) fecharJanela();
  });

  document.body.appendChild(janela);
  document.addEventListener('keydown', teclaEsc);

  $('sheet-ad-cancelar').addEventListener('click', fecharJanela);
  $('sheet-ad-salvar').addEventListener('click', () => salvar(produto));
}

/* ===== Salvar ===== */

async function salvar(produto) {
  if (salvando) return;

  const caixas = [...document.querySelectorAll('[data-vinc-check]')];
  const escolhidos = caixas.filter((c) => c.checked).map((c) => c.dataset.vincCheck);
  const naoEscolhidos = caixas.filter((c) => !c.checked).map((c) => c.dataset.vincCheck);

  const categoria = produto.categoria || 'Geral';
  const paraCategoria = Boolean($('sheet-ad-categoria') && $('sheet-ad-categoria').checked);
  const alvos = paraCategoria
    ? state.produtos.filter((p) => (p.categoria || 'Geral') === categoria)
    : [produto];

  salvando = true;
  const botao = $('sheet-ad-salvar');
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  try {
    if (escolhidos.length) {
      const linhas = alvos.flatMap((p) => escolhidos.map((adicionalId) => ({
        produto_id: p.id,
        adicional_id: adicionalId,
        restaurante_id: state.rest.id
      })));

      const { error } = await sb
        .from('produto_adicionais')
        .upsert(linhas, { onConflict: 'produto_id,adicional_id', ignoreDuplicates: true });
      if (error) throw error;
    }

    if (naoEscolhidos.length) {
      const { error } = await sb
        .from('produto_adicionais')
        .delete()
        .in('produto_id', alvos.map((p) => p.id))
        .in('adicional_id', naoEscolhidos);
      if (error) throw error;
    }

    await carregarVinculos();
    fecharJanela();
    aviso(paraCategoria ? `Adicionais aplicados à categoria “${categoria}”` : 'Adicionais salvos');
  } catch (erro) {
    tratarErro(erro, 'Não foi possível salvar os adicionais.');
    botao.disabled = false;
    botao.textContent = 'Salvar';
  } finally {
    salvando = false;
  }
}

/* ===== Inicialização ===== */

export function inicializarVinculoAdicionais() {
  if (eventosConfigurados) return;

  const lista = $('lista-produtos');
  if (!lista) return;

  lista.addEventListener('click', (evento) => {
    const botao = evento.target.closest('[data-adicionais]');
    if (!botao) return;
    const produto = achar(state.produtos, botao.dataset.adicionais);
    if (produto) abrirJanela(produto);
  });

  document.addEventListener('admin:produtos-carregados', carregarVinculos);
  document.addEventListener('admin:produtos-renderizados', atualizarContadores);
  document.addEventListener('admin:adicionais-renderizados', atualizarContadores);

  eventosConfigurados = true;
}
