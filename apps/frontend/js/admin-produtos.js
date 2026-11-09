import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, num, aviso, tratarErro, atualizar, achar } from './admin-utils.js';
import { enviarImagem, removerImagem } from './admin-upload-imagem.js';

const BUCKET_FOTOS = 'imagens-restaurantes';

const ESTILO_MINIATURA =
  'width:56px;height:56px;flex:none;border-radius:12px;overflow:hidden;border:1px solid #3a3a3a;' +
  'background:#2a2a2a;color:#9a9a9a;padding:0;display:flex;align-items:center;' +
  'justify-content:center;font-size:22px;cursor:pointer;';

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
  document.dispatchEvent(new CustomEvent('admin:produtos-carregados'));
}

function renderProdutos() {
  $('lista-categorias').innerHTML = [
    ...new Set(state.produtos.map((produto) => produto.categoria).filter(Boolean))
  ].map((categoria) => `<option value="${esc(categoria)}"></option>`).join('');

  $('lista-produtos').innerHTML = state.produtos.length
    ? state.produtos.map((produto) => `
      <div class="p-3 border rounded-xl ${produto.disponivel ? 'bg-white' : 'bg-gray-50 border-gray-300'}">
        <div class="flex justify-between items-start gap-2">
          <div class="flex items-start gap-3 min-w-0">
            <button
              type="button"
              data-foto="${esc(produto.id)}"
              style="${ESTILO_MINIATURA}"
              title="${produto.imagem_url ? 'Trocar foto' : 'Adicionar foto'}"
              aria-label="${produto.imagem_url ? 'Trocar foto de' : 'Adicionar foto a'} ${esc(produto.nome)}"
            >
              ${
                produto.imagem_url
                  ? `<img src="${esc(produto.imagem_url)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block" />`
                  : '📷'
              }
            </button>

            <div class="min-w-0 ${produto.disponivel ? '' : 'opacity-60'}">
              <h3 class="font-bold text-sm">${esc(produto.nome)}</h3>
              <p class="text-xs text-gray-500">
                ${esc(produto.categoria || 'Geral')}
                ${produto.descricao ? ` • ${esc(produto.descricao)}` : ''}
              </p>
              ${
                produto.imagem_url
                  ? `<button type="button" data-foto-remover="${esc(produto.id)}" class="text-xs text-gray-500" style="text-decoration:underline;background:none;border:0;padding:0;margin-top:4px;cursor:pointer">Remover foto</button>`
                  : ''
              }
            </div>
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

        <button
          type="button"
          data-adicionais="${esc(produto.id)}"
          class="px-3 py-2 text-xs font-bold rounded-lg border"
          style="width:100%;margin-top:8px"
        >
          ➕ Adicionais
        </button>
      </div>
    `).join('')
        : '<p class="text-sm text-gray-500">Nenhum produto cadastrado ainda.</p>';

  document.dispatchEvent(new CustomEvent('admin:produtos-renderizados'));
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
  await removerImagem(sb, BUCKET_FOTOS, produto.imagem_url);
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

/* ===== Fotos ===== */

let enviandoFoto = false;
let produtoDaFoto = null;
let inputFoto = null;
let urlPrevia = null;

async function trocarFoto(produto, arquivo) {
  if (enviandoFoto) return;
  enviandoFoto = true;
  aviso('Enviando foto...');

  try {
    const novaUrl = await enviarImagem(sb, {
      bucket: BUCKET_FOTOS,
      restauranteId: state.rest.id,
      pasta: 'produtos',
      arquivo
    });

    const resultado = await atualizar(
      'produtos',
      produto.id,
      { imagem_url: novaUrl },
      'Foto atualizada'
    );

    if (!resultado) {
      await removerImagem(sb, BUCKET_FOTOS, novaUrl);
      return;
    }

    const antiga = produto.imagem_url;
    produto.imagem_url = resultado.imagem_url;
    renderProdutos();
    await removerImagem(sb, BUCKET_FOTOS, antiga);
  } catch (erro) {
    aviso(erro.message || 'Não foi possível enviar a foto.');
  } finally {
    enviandoFoto = false;
  }
}

async function removerFoto(id) {
  const produto = achar(state.produtos, id);
  if (!produto || !produto.imagem_url) return;
  if (!confirm(`Remover a foto de "${produto.nome}"?`)) return;

  const antiga = produto.imagem_url;
  const resultado = await atualizar(
    'produtos',
    produto.id,
    { imagem_url: null },
    'Foto removida'
  );

  if (resultado) {
    produto.imagem_url = null;
    renderProdutos();
    await removerImagem(sb, BUCKET_FOTOS, antiga);
  }
}

function criarInputFoto() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.hidden = true;
  input.id = 'input-foto-produto';

  input.addEventListener('change', async () => {
    const arquivo = input.files && input.files[0];
    input.value = '';
    const produto = produtoDaFoto;
    produtoDaFoto = null;
    if (arquivo && produto) await trocarFoto(produto, arquivo);
  });

  document.body.appendChild(input);
  return input;
}

// Campo de foto no formulário de cadastro (inserido acima do botão)
function prepararCampoFoto() {
  const botao = $('btn-cadastrar');
  if (!botao || $('p-foto')) return;

  botao.insertAdjacentHTML('beforebegin', `
    <div style="margin-bottom:12px">
      <label for="p-foto" class="text-xs text-gray-500" style="display:block;margin-bottom:6px;font-weight:600">Foto (opcional)</label>
      <input id="p-foto" type="file" accept="image/*" class="text-xs" style="width:100%" />
      <img id="p-foto-previa" alt="Prévia da foto" style="display:none;width:96px;height:96px;object-fit:cover;border-radius:12px;margin-top:8px" />
    </div>
  `);
}

function limparPrevia() {
  const img = $('p-foto-previa');
  if (urlPrevia) {
    URL.revokeObjectURL(urlPrevia);
    urlPrevia = null;
  }
  if (img) {
    img.removeAttribute('src');
    img.style.display = 'none';
  }
}

function mostrarPrevia(arquivo) {
  limparPrevia();
  const img = $('p-foto-previa');
  if (!img || !arquivo) return;
  urlPrevia = URL.createObjectURL(arquivo);
  img.src = urlPrevia;
  img.style.display = 'block';
}

/* ===== Cadastro ===== */

async function cadastrarProduto(evento) {
  evento.preventDefault();

  const nome = $('p-nome').value.trim();
  const preco = num($('p-preco').value);

  if (nome.length < 2) return aviso('Informe o nome');
  if (!(preco > 0) || preco > 10000) return aviso('Preço inválido');

  const botao = $('btn-cadastrar');
  botao.disabled = true;

  // Envia a foto primeiro (se houver)
  const arquivo = $('p-foto')?.files?.[0] || null;
  let imagemUrl = null;

  if (arquivo) {
    try {
      aviso('Enviando foto...');
      imagemUrl = await enviarImagem(sb, {
        bucket: BUCKET_FOTOS,
        restauranteId: state.rest.id,
        pasta: 'produtos',
        arquivo
      });
    } catch (erro) {
      botao.disabled = false;
      return aviso(erro.message || 'Não foi possível enviar a foto.');
    }
  }

  const { error } = await sb
    .from('produtos')
    .insert([{
      restaurante_id: state.rest.id,
      nome,
      preco,
      disponivel: true,
      categoria: $('p-categoria').value.trim() || 'Geral',
      descricao: $('p-descricao').value.trim() || null,
      imagem_url: imagemUrl
    }]);

  botao.disabled = false;

  if (error) {
    if (imagemUrl) await removerImagem(sb, BUCKET_FOTOS, imagemUrl);
    tratarErro(error, 'Erro ao cadastrar.');
    return;
  }

  $('form-produto').reset();
  limparPrevia();
  aviso('Produto cadastrado');
  await carregarProdutos();
}

function configurarEventos() {
  prepararCampoFoto();
  inputFoto = criarInputFoto();

  $('lista-produtos').addEventListener('click', async (evento) => {
    const alternar = evento.target.closest('[data-toggle]');
    const excluir = evento.target.closest('[data-del]');
    const foto = evento.target.closest('[data-foto]');
    const fotoRemover = evento.target.closest('[data-foto-remover]');

    if (alternar) await alternarDisponibilidade(alternar.dataset.toggle);
    if (excluir) await excluirProduto(excluir.dataset.del);
    if (fotoRemover) await removerFoto(fotoRemover.dataset.fotoRemover);

    if (foto) {
      const produto = achar(state.produtos, foto.dataset.foto);
      if (produto) {
        produtoDaFoto = produto;
        inputFoto.click();
      }
    }
  });

  $('lista-produtos').addEventListener('change', async (evento) => {
    if (evento.target.matches('[data-preco]')) {
      await salvarPreco(evento.target);
    }
  });

  $('form-produto').addEventListener('change', (evento) => {
    if (evento.target.id === 'p-foto') {
      mostrarPrevia(evento.target.files && evento.target.files[0]);
    }
  });

  $('form-produto').addEventListener('reset', limparPrevia);

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
