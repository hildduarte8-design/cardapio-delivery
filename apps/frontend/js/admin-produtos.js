import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, num, aviso, tratarErro, atualizar, achar } from './admin-utils.js';

export async function carregarProdutos() {
  if (!state.rest || !sb) return;

  const { data, error } = await sb
    .from('produtos')
    .select('*')
    .eq('restaurante_id', state.rest.id)
    .order('categoria')
    .order('nome');

  if (error) {
    tratarErro(error, 'Erro ao carregar produtos.');
    return;
  }

  state.produtos = data || [];
  renderProdutos();
}

function renderProdutos() {
  $('lista-categorias').innerHTML = [
    ...new Set(state.produtos.map((produto) => produto.categoria).filter(Boolean))
  ].map((categoria) => `<option value="${esc(categoria)}"></option>`).join('');

  $('lista-produtos').innerHTML = state.produtos.length
    ? state.produtos.map((produto) => `
      <div class="p-3 border rounded-xl ${produto.disponivel ? 'bg-white' : 'bg-gray-50 border-gray-300'}">
        <div class="flex justify-between items-start gap-2">
          <div class="min-w-0 ${produto.disponivel ? '' : 'opacity-60'}">
            <h3 class="font-bold text-sm">${esc(produto.nome)}</h3>
            <p class="text-xs text-gray-500">
              ${esc(produto.categoria || 'Geral')}
              ${produto.descricao ? ` • ${esc(produto.descricao)}` : ''}
            </p>
          </div>
          <span class="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full ${
            produto.disponivel
              ? 'bg-green-100 text-green-700'
              : 'bg-yellow-100 text-yellow-700'
          }">
            ${produto.disponivel ? 'Ativo' : 'Pausado'}
          </span>
        </div>

        <div class="flex items-center gap-2 mt-3">
          <label class="flex items-center border rounded-lg px-2 bg-gray-50">
            <span class="text-xs text-gray-500">R$</span>
            <input
              data-preco="${esc(produto.id)}"
              type="number"
              step="0.01"
              min="0.01"
              inputmode="decimal"
              value="${Number(produto.preco).toFixed(2)}"
              aria-label="Preço de ${esc(produto.nome)}"
              class="w-20 p-2 bg-transparent text-sm font-semibold outline-none"
            />
          </label>

          <button
            data-toggle="${esc(produto.id)}"
            class="flex-1 px-3 py-2 text-xs font-bold rounded-lg border ${
              produto.disponivel
                ? 'bg-yellow-50 text-yellow-700 border-yellow-200'
                : 'bg-green-50 text-green-700 border-green-200'
            }"
          >
            ${produto.disponivel ? 'Pausar' : 'Ativar'}
          </button>

          <button
            data-del="${esc(produto.id)}"
            class="px-3 py-2 text-xs font-bold rounded-lg border bg-red-50 text-red-600 border-red-200"
          >
            Excluir
          </button>
        </div>
      </div>
    `).join('')
    : '<p class="text-sm text-gray-500">Nenhum produto cadastrado ainda.</p>';
}

async function alternarDisponibilidade(id) {
  const produto = achar(state.produtos, id);
  if (!produto) return;

  const resultado = await atualizar(
    'produtos',
    produto.id,
    { disponivel: !produto.disponivel },
    produto.disponivel ? 'Item pausado' : 'Item ativado'
  );

  if (resultado) {
    produto.disponivel = resultado.disponivel;
    renderProdutos();
  }
}

async function excluirProduto(id) {
  const produto = achar(state.produtos, id);
  if (!produto || !confirm(`Excluir "${produto.nome}"?`)) return;

  const { data, error } = await sb
    .from('produtos')
    .delete()
    .eq('id', produto.id)
    .select();

  if (error || !data?.length) {
    tratarErro(error, 'Não foi possível excluir.');
    return;
  }

  state.produtos = state.produtos.filter((item) => item.id !== produto.id);
  aviso('Item excluído');
  renderProdutos();
}

async function salvarPreco(input) {
  const produto = achar(state.produtos, input.dataset.preco);
  const novoPreco = num(input.value);

  if (!produto) return;

  if (!(novoPreco > 0) || novoPreco > 10000) {
    aviso('Preço inválido');
    input.value = Number(produto.preco).toFixed(2);
    return;
  }

  if (novoPreco === Number(produto.preco)) return;

  const resultado = await atualizar(
    'produtos',
    produto.id,
    { preco: novoPreco },
    `Preço atualizado: ${brl.format(novoPreco)}`
  );

  if (resultado) {
    produto.preco = resultado.preco;
  } else {
    input.value = Number(produto.preco).toFixed(2);
  }
}

async function cadastrarProduto(evento) {
  evento.preventDefault();

  const nome = $('p-nome').value.trim();
  const preco = num($('p-preco').value);

  if (nome.length < 2) return aviso('Informe o nome');
  if (!(preco > 0) || preco > 10000) return aviso('Preço inválido');

  const botao = $('btn-cadastrar');
  botao.disabled = true;

  const { error } = await sb
    .from('produtos')
    .insert([{
      restaurante_id: state.rest.id,
      nome,
      preco,
      disponivel: true,
      categoria: $('p-categoria').value.trim() || 'Geral',
      descricao: $('p-descricao').value.trim() || null
    }]);

  botao.disabled = false;

  if (error) {
    tratarErro(error, 'Erro ao cadastrar.');
    return;
  }

  $('form-produto').reset();
  aviso('Produto cadastrado');
  await carregarProdutos();
}

function configurarEventos() {
  $('lista-produtos').addEventListener('click', async (evento) => {
    const alternar = evento.target.closest('[data-toggle]');
    const excluir = evento.target.closest('[data-del]');

    if (alternar) await alternarDisponibilidade(alternar.dataset.toggle);
    if (excluir) await excluirProduto(excluir.dataset.del);
  });

  $('lista-produtos').addEventListener('change', async (evento) => {
    if (evento.target.matches('[data-preco]')) {
      await salvarPreco(evento.target);
    }
  });

  $('form-produto').addEventListener('submit', cadastrarProduto);

  $('btn-toggle-form').addEventListener('click', () => {
    const formulario = $('form-produto');
    formulario.classList.toggle('hidden');
    $('seta-form').innerText = formulario.classList.contains('hidden') ? '▼' : '▲';
  });
}

let eventosConfigurados = false;

export function inicializarProdutos() {
  if (eventosConfigurados) return;
  configurarEventos();
  eventosConfigurados = true;
}
