import { state } from './admin-state.js';
import { $, esc, num, aviso, atualizar, achar } from './admin-utils.js';
import { carregarProdutos } from './admin-produtos.js';

let salvando = false;
let eventosConfigurados = false;

const ROTULO =
  'display:block;font-size:12px;font-weight:600;color:#9a9a9a;margin:12px 0 6px';

function teclaEsc(evento) {
  if (evento.key === 'Escape') fechar();
}

function fechar() {
  const janela = $('sheet-editar-produto');
  if (janela) janela.remove();
  document.removeEventListener('keydown', teclaEsc);
}

function abrir(produto) {
  fechar();

  const janela = document.createElement('div');
  janela.id = 'sheet-editar-produto';
  janela.setAttribute('role', 'dialog');
  janela.setAttribute('aria-modal', 'true');
  janela.setAttribute('aria-label', `Editar ${produto.nome}`);
  janela.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.65);display:flex;align-items:flex-end;justify-content:center;';

  janela.innerHTML = `
    <form id="form-editar-produto" novalidate
      style="width:100%;max-width:560px;max-height:92vh;overflow:auto;background:#1d1d20;color:#f1f1f1;border-radius:20px 20px 0 0;border:1px solid #2e2e32;padding:16px 16px 20px">
      <h2 style="font-size:16px;font-weight:700;margin:0">Editar produto</h2>

      <label for="ed-nome" style="${ROTULO}">Nome</label>
      <input id="ed-nome" class="input-padrao" type="text" maxlength="80" autocomplete="off"
        value="${esc(produto.nome)}" style="width:100%" />

      <label for="ed-categoria" style="${ROTULO}">Categoria</label>
      <input id="ed-categoria" class="input-padrao" type="text" list="lista-categorias" maxlength="40" autocomplete="off"
        value="${esc(produto.categoria || '')}" style="width:100%" />

      <label for="ed-descricao" style="${ROTULO}">Descrição (opcional)</label>
      <textarea id="ed-descricao" class="input-padrao" rows="3" maxlength="300"
        style="width:100%;resize:vertical">${esc(produto.descricao || '')}</textarea>

      <label for="ed-preco" style="${ROTULO}">Preço (R$)</label>
      <input id="ed-preco" class="input-padrao" type="number" step="0.01" min="0.01" inputmode="decimal"
        value="${Number(produto.preco).toFixed(2)}" style="width:100%" />

      <p style="font-size:12px;color:#9a9a9a;margin:12px 0 0">Para trocar a foto, toque na miniatura do produto na lista.</p>

      <div style="display:flex;gap:8px;margin-top:16px">
        <button type="button" id="ed-cancelar" class="px-3 py-2 text-xs font-bold rounded-lg border"
          style="flex:1;color:#f1f1f1;cursor:pointer">Cancelar</button>
        <button type="submit" id="ed-salvar" class="px-3 py-2 text-xs font-bold rounded-lg"
          style="flex:1;background:var(--dourado,#d4a437);color:#1a1a1a;border:0;cursor:pointer">Salvar</button>
      </div>
    </form>`;

  janela.addEventListener('click', (evento) => {
    if (evento.target === janela) fechar();
  });

  document.body.appendChild(janela);
  document.addEventListener('keydown', teclaEsc);

  $('ed-cancelar').addEventListener('click', fechar);
  $('form-editar-produto').addEventListener('submit', (evento) => {
    evento.preventDefault();
    salvar(produto);
  });
}

async function salvar(produto) {
  if (salvando) return;

  const nome = $('ed-nome').value.trim();
  const categoria = $('ed-categoria').value.trim() || 'Geral';
  const descricao = $('ed-descricao').value.trim() || null;
  const preco = num($('ed-preco').value);

  if (nome.length < 2) return aviso('Informe o nome');
  if (!(preco > 0) || preco > 10000) return aviso('Preço inválido');

  const mudou =
    nome !== produto.nome ||
    categoria !== (produto.categoria || 'Geral') ||
    descricao !== (produto.descricao || null) ||
    preco !== Number(produto.preco);

  if (!mudou) {
    fechar();
    return;
  }

  salvando = true;
  const botao = $('ed-salvar');
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  const resultado = await atualizar(
    'produtos',
    produto.id,
    { nome, categoria, descricao, preco },
    'Produto atualizado'
  );

  salvando = false;

  if (!resultado) {
    botao.disabled = false;
    botao.textContent = 'Salvar';
    return;
  }

  fechar();
  await carregarProdutos();
}

export function inicializarEdicaoProduto() {
  if (eventosConfigurados) return;

  const lista = $('lista-produtos');
  if (!lista) return;

  lista.addEventListener('click', (evento) => {
    const botao = evento.target.closest('[data-editar]');
    if (!botao) return;
    const produto = achar(state.produtos, botao.dataset.editar);
    if (produto) abrir(produto);
  });

  eventosConfigurados = true;
}
