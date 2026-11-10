import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { esc, aviso, tratarErro, achar } from './admin-utils.js';
import { carregarProdutos } from './admin-produtos.js';
import { carregarAdicionais, listarAdicionais } from './admin-adicionais.js';

/* ===== Contraste: texto escuro nos cartões claros ===== */

function injetarEstilo() {
  if (document.getElementById('estilo-editar')) return;
  const estilo = document.createElement('style');
  estilo.id = 'estilo-editar';
  estilo.textContent = `
    #lista-produtos > div,
    #lista-adicionais > div { color: #1a1a1a; }
    #lista-produtos h3,
    #lista-adicionais h3 { color: #1a1a1a !important; }
  `;
  document.head.appendChild(estilo);
}

/* ===== Modal simples de edição ===== */

const ESTILO_CAMPO =
  'width:100%;padding:10px;border:1px solid #ccc;border-radius:10px;' +
  'background:#fff;color:#1a1a1a;font-size:16px;box-sizing:border-box;font-family:inherit;';

function fecharModal() {
  document.getElementById('modal-editar')?.remove();
}

function abrirModal({ titulo, campos, aoSalvar }) {
  fecharModal();

  const fundo = document.createElement('div');
  fundo.id = 'modal-editar';
  fundo.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);' +
    'display:flex;align-items:center;justify-content:center;padding:16px;';

  const camposHtml = campos.map((c) => {
    const atributos =
      `name="${c.nome}" id="ed-${c.nome}" maxlength="${c.max || 100}" ` +
      `${c.lista ? `list="${c.lista}"` : ''} style="${ESTILO_CAMPO}" autocomplete="off"`;
    const controle = c.tipo === 'textarea'
      ? `<textarea ${atributos} rows="3">${esc(c.valor || '')}</textarea>`
      : `<input type="text" ${atributos} value="${esc(c.valor || '')}" />`;
    return `
      <div style="margin-bottom:12px">
        <label for="ed-${c.nome}" style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:#555">${esc(c.rotulo)}</label>
        ${controle}
      </div>`;
  }).join('');

  fundo.innerHTML = `
    <form id="form-editar" style="background:#fff;color:#1a1a1a;border-radius:16px;padding:16px;width:100%;max-width:420px;max-height:90vh;overflow:auto">
      <h3 style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1a1a1a">${esc(titulo)}</h3>
      ${camposHtml}
      <div style="display:flex;gap:8px;margin-top:4px">
        <button type="submit" id="ed-salvar" style="flex:1;padding:12px;border:0;border-radius:10px;font-weight:700;font-size:14px;background:var(--dourado,#d4a437);color:#1a1a1a;cursor:pointer">Salvar</button>
        <button type="button" id="ed-cancelar" style="flex:1;padding:12px;border:1px solid #ccc;border-radius:10px;font-weight:700;font-size:14px;background:#fff;color:#1a1a1a;cursor:pointer">Cancelar</button>
      </div>
    </form>`;

  document.body.appendChild(fundo);

  const form = fundo.querySelector('#form-editar');
  const botao = fundo.querySelector('#ed-salvar');

  fundo.addEventListener('click', (e) => { if (e.target === fundo) fecharModal(); });
  fundo.querySelector('#ed-cancelar').addEventListener('click', fecharModal);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const valores = {};
    campos.forEach((c) => { valores[c.nome] = form.elements[c.nome].value; });
    botao.disabled = true;
    const ok = await aoSalvar(valores);
    botao.disabled = false;
    if (ok) fecharModal();
  });

  form.elements[campos[0].nome].focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') fecharModal();
});

/* ===== Editar produto ===== */

function editarProduto(id) {
  const produto = achar(state.produtos, id);
  if (!produto) return;

  abrirModal({
    titulo: 'Editar produto',
    campos: [
      { nome: 'nome', rotulo: 'Nome', valor: produto.nome, max: 80 },
      { nome: 'categoria', rotulo: 'Categoria', valor: produto.categoria || '', max: 40, lista: 'lista-categorias' },
      { nome: 'descricao', rotulo: 'Descrição (opcional)', valor: produto.descricao || '', max: 200, tipo: 'textarea' }
    ],
    aoSalvar: async (v) => {
      const nome = v.nome.trim();
      if (nome.length < 2) { aviso('Informe o nome'); return false; }

      const { data, error } = await sb
        .from('produtos')
        .update({
          nome,
          categoria: v.categoria.trim() || 'Geral',
          descricao: v.descricao.trim() || null
        })
        .eq('id', produto.id)
        .select();

      if (error || !data?.length) {
        tratarErro(error, 'Não foi possível salvar.');
        return false;
      }

      aviso('Produto atualizado');
      await carregarProdutos();
      return true;
    }
  });
}

/* ===== Editar adicional ===== */

function editarAdicional(id) {
  const item = listarAdicionais().find((a) => a.id === id);
  if (!item) return;

  abrirModal({
    titulo: 'Editar adicional',
    campos: [{ nome: 'nome', rotulo: 'Nome', valor: item.nome, max: 60 }],
    aoSalvar: async (v) => {
      const nome = v.nome.trim();
      if (nome.length < 1 || nome.length > 60) { aviso('Informe o nome (até 60 letras)'); return false; }

      const { data, error } = await sb
        .from('adicionais')
        .update({ nome })
        .eq('id', item.id)
        .select();

      if (error || !data?.length) {
        tratarErro(error, 'Não foi possível salvar.');
        return false;
      }

      aviso('Adicional atualizado');
      await carregarAdicionais();
      return true;
    }
  });
}

/* ===== Botão Editar nos cartões de adicionais ===== */

function incluirBotoesAdicionais() {
  document.querySelectorAll('#lista-adicionais [data-ad-del]').forEach((excluir) => {
    if (excluir.parentElement.querySelector('[data-ad-editar]')) return;
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.dataset.adEditar = excluir.dataset.adDel;
    botao.className = 'px-3 py-2 text-xs font-bold rounded-lg border';
    botao.textContent = '✏️ Editar';
    excluir.before(botao);
  });
}

/* ===== Ligações ===== */

document.addEventListener('click', (e) => {
  const adicional = e.target.closest('#lista-adicionais [data-ad-editar]');
  if (adicional) return editarAdicional(adicional.dataset.adEditar);
});

document.addEventListener('admin:adicionais-renderizados', incluirBotoesAdicionais);

injetarEstilo();
incluirBotoesAdicionais();
