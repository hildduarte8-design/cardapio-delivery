import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, num, aviso, tratarErro } from './admin-utils.js';
import { enviarImagem, removerImagem } from './admin-upload-imagem.js';

const BUCKET_FOTOS = 'imagens-restaurantes';

const ESTILO_MINIATURA =
  'width:56px;height:56px;flex:none;border-radius:12px;overflow:hidden;border:1px solid #3a3a3a;' +
  'background:#2a2a2a;color:#9a9a9a;padding:0;display:flex;align-items:center;' +
  'justify-content:center;font-size:22px;cursor:pointer;';

let adicionais = [];
let enviandoFoto = false;
let adicionalDaFoto = null;
let inputFoto = null;
let urlPrevia = null;
let eventosConfigurados = false;

const acharAdicional = (id) => adicionais.find((item) => item.id === id);
export function listarAdicionais() {
  return adicionais;
}

/* ===== Carregar e desenhar ===== */

export async function carregarAdicionais() {
  if (!state.rest || !sb) return;

  const { data, error } = await sb
    .from('adicionais')
    .select('*')
    .eq('restaurante_id', state.rest.id)
    .order('nome');

  if (error) {
    adicionais = [];
    renderAdicionais();
    tratarErro(error, 'Erro ao carregar adicionais.');
    return;
  }

  adicionais = data || [];
  renderAdicionais();
}

function renderAdicionais() {
  const lista = $('lista-adicionais');
  if (!lista) return;

  lista.innerHTML = adicionais.length
    ? adicionais.map((item) => `
      <div class="p-3 border rounded-xl ${item.ativo ? 'bg-white' : 'bg-gray-50 border-gray-300'}">
        <div class="flex justify-between items-start gap-2">
          <div class="flex items-start gap-3 min-w-0">
            <button
              type="button"
              data-ad-foto="${esc(item.id)}"
              style="${ESTILO_MINIATURA}"
              title="${item.imagem_url ? 'Trocar foto' : 'Adicionar foto'}"
              aria-label="${item.imagem_url ? 'Trocar foto de' : 'Adicionar foto a'} ${esc(item.nome)}"
            >
              ${
                item.imagem_url
                  ? `<img src="${esc(item.imagem_url)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block" />`
                  : '📷'
              }
            </button>

            <div class="min-w-0 ${item.ativo ? '' : 'opacity-60'}">
              <h3 class="font-bold text-sm">${esc(item.nome)}</h3>
              <p class="text-xs text-gray-500">${Number(item.preco) > 0 ? '+ ' + brl.format(Number(item.preco)) : 'Grátis'}</p>
              ${
                item.imagem_url
                  ? `<button type="button" data-ad-foto-remover="${esc(item.id)}" class="text-xs text-gray-500" style="text-decoration:underline;background:none;border:0;padding:0;margin-top:4px;cursor:pointer">Remover foto</button>`
                  : ''
              }
            </div>
          </div>

          <span class="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full ${
            item.ativo ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
          }">
            ${item.ativo ? 'Ativo' : 'Pausado'}
          </span>
        </div>

        <div class="flex items-center gap-2 mt-3">
          <label class="flex items-center border rounded-lg px-2 bg-gray-50">
            <span class="text-xs text-gray-500">R$</span>
            <input
              data-ad-preco="${esc(item.id)}"
              type="number"
              step="0.01"
              min="0"
              inputmode="decimal"
              value="${Number(item.preco).toFixed(2)}"
              aria-label="Preço de ${esc(item.nome)}"
              class="w-20 p-2 bg-transparent text-sm font-semibold outline-none"
            />
          </label>

          <button
            data-ad-toggle="${esc(item.id)}"
            class="flex-1 px-3 py-2 text-xs font-bold rounded-lg border ${
              item.ativo
                ? 'bg-yellow-50 text-yellow-700 border-yellow-200'
                : 'bg-green-50 text-green-700 border-green-200'
            }"
          >
            ${item.ativo ? 'Pausar' : 'Ativar'}
          </button>

          <button
            data-ad-del="${esc(item.id)}"
            class="px-3 py-2 text-xs font-bold rounded-lg border bg-red-50 text-red-600 border-red-200"
          >
            Excluir
          </button>
        </div>
      </div>
    `).join('')
       : '<p class="text-sm text-gray-500">Nenhum adicional cadastrado ainda.</p>';

  document.dispatchEvent(new CustomEvent('admin:adicionais-renderizados'));
}

/* ===== Alterações ===== */

async function atualizarAdicional(id, alteracao, mensagem) {
  const { data, error } = await sb
    .from('adicionais')
    .update(alteracao)
    .eq('id', id)
    .select();

  if (error || !data?.length) {
    tratarErro(error, 'Não foi possível salvar.');
    return null;
  }

  if (mensagem) aviso(mensagem);
  return data[0];
}

async function alternarAtivo(id) {
  const item = acharAdicional(id);
  if (!item) return;

  const resultado = await atualizarAdicional(
    id,
    { ativo: !item.ativo },
    item.ativo ? 'Adicional pausado' : 'Adicional ativado'
  );

  if (resultado) {
    item.ativo = resultado.ativo;
    renderAdicionais();
  }
}

async function salvarPreco(input) {
  const item = acharAdicional(input.dataset.adPreco);
  const novoPreco = num(input.value);
  if (!item) return;

  if (!(novoPreco >= 0) || novoPreco > 1000) {
    aviso('Preço inválido');
    input.value = Number(item.preco).toFixed(2);
    return;
  }

  if (novoPreco === Number(item.preco)) return;

  const resultado = await atualizarAdicional(
    item.id,
    { preco: novoPreco },
    `Preço atualizado: ${brl.format(novoPreco)}`
  );

  if (resultado) {
    item.preco = resultado.preco;
    renderAdicionais();
  } else {
    input.value = Number(item.preco).toFixed(2);
  }
}

async function excluirAdicional(id) {
  const item = acharAdicional(id);
  if (!item || !confirm(`Excluir o adicional "${item.nome}"?`)) return;

  const { data, error } = await sb
    .from('adicionais')
    .delete()
    .eq('id', item.id)
    .select();

  if (error || !data?.length) {
    tratarErro(error, 'Não foi possível excluir.');
    return;
  }

  adicionais = adicionais.filter((outro) => outro.id !== item.id);
  aviso('Adicional excluído');
  renderAdicionais();
  await removerImagem(sb, BUCKET_FOTOS, item.imagem_url);
}

/* ===== Fotos ===== */

async function trocarFoto(item, arquivo) {
  if (enviandoFoto) return;
  enviandoFoto = true;
  aviso('Enviando foto...');

  try {
    const novaUrl = await enviarImagem(sb, {
      bucket: BUCKET_FOTOS,
      restauranteId: state.rest.id,
      pasta: 'adicionais',
      arquivo
    });

    const resultado = await atualizarAdicional(item.id, { imagem_url: novaUrl }, 'Foto atualizada');

    if (!resultado) {
      await removerImagem(sb, BUCKET_FOTOS, novaUrl);
      return;
    }

    const antiga = item.imagem_url;
    item.imagem_url = resultado.imagem_url;
    renderAdicionais();
    await removerImagem(sb, BUCKET_FOTOS, antiga);
  } catch (erro) {
    aviso(erro.message || 'Não foi possível enviar a foto.');
  } finally {
    enviandoFoto = false;
  }
}

async function removerFoto(id) {
  const item = acharAdicional(id);
  if (!item || !item.imagem_url) return;
  if (!confirm(`Remover a foto de "${item.nome}"?`)) return;

  const antiga = item.imagem_url;
  const resultado = await atualizarAdicional(id, { imagem_url: null }, 'Foto removida');

  if (resultado) {
    item.imagem_url = null;
    renderAdicionais();
    await removerImagem(sb, BUCKET_FOTOS, antiga);
  }
}

function criarInputFoto() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.hidden = true;
  input.id = 'input-foto-adicional';

  input.addEventListener('change', async () => {
    const arquivo = input.files && input.files[0];
    input.value = '';
    const item = adicionalDaFoto;
    adicionalDaFoto = null;
    if (arquivo && item) await trocarFoto(item, arquivo);
  });

  document.body.appendChild(input);
  return input;
}

function limparPrevia() {
  const img = $('ad-foto-previa');
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
  const img = $('ad-foto-previa');
  if (!img || !arquivo) return;
  urlPrevia = URL.createObjectURL(arquivo);
  img.src = urlPrevia;
  img.style.display = 'block';
}

/* ===== Cadastro ===== */

function fecharFormulario() {
  const form = $('form-adicional');
  if (!form) return;
  form.reset();
  limparPrevia();
  form.style.display = 'none';
}

async function cadastrarAdicional(evento) {
  evento.preventDefault();

  const nome = $('ad-nome').value.trim();
  const preco = num($('ad-preco').value);

  if (nome.length < 1 || nome.length > 60) return aviso('Informe o nome (até 60 letras)');
  if (!(preco >= 0) || preco > 1000) return aviso('Preço inválido (use 0 para grátis)');

  const botao = $('btn-salvar-adicional');
  botao.disabled = true;

  const arquivo = $('ad-foto')?.files?.[0] || null;
  let imagemUrl = null;

  if (arquivo) {
    try {
      aviso('Enviando foto...');
      imagemUrl = await enviarImagem(sb, {
        bucket: BUCKET_FOTOS,
        restauranteId: state.rest.id,
        pasta: 'adicionais',
        arquivo
      });
    } catch (erro) {
      botao.disabled = false;
      return aviso(erro.message || 'Não foi possível enviar a foto.');
    }
  }

  const { error } = await sb
    .from('adicionais')
    .insert([{
      restaurante_id: state.rest.id,
      nome,
      preco,
      imagem_url: imagemUrl,
      ativo: true
    }]);

  botao.disabled = false;

  if (error) {
    if (imagemUrl) await removerImagem(sb, BUCKET_FOTOS, imagemUrl);
    tratarErro(error, 'Erro ao cadastrar o adicional.');
    return;
  }

  fecharFormulario();
  aviso('Adicional cadastrado');
  await carregarAdicionais();
}

/* ===== Montagem da seção e eventos ===== */

function montarSecao() {
  if ($('secao-adicionais')) return true;
  const ancora = $('lista-produtos');
  if (!ancora) return false;

  ancora.insertAdjacentHTML('afterend', `
    <section id="secao-adicionais" style="margin-top:28px">
      <div class="flex justify-between items-center gap-2" style="margin-bottom:6px">
        <h2 class="font-bold text-base">Adicionais</h2>
        <button type="button" id="btn-novo-adicional" class="px-3 py-2 text-xs font-bold rounded-lg border">＋ Novo adicional</button>
      </div>
      <p class="text-xs text-gray-500" style="margin-bottom:12px">Extras que o cliente pode acrescentar ao pedido (ex.: bacon, catupiry), com preço e foto.</p>

      <form id="form-adicional" class="p-3 border rounded-xl" style="display:none;margin-bottom:12px">
        <div style="display:flex;flex-direction:column;gap:10px">
          <input id="ad-nome" type="text" maxlength="60" placeholder="Nome do adicional" autocomplete="off" class="input-padrao" />
          <input id="ad-preco" type="number" step="0.01" min="0" inputmode="decimal" placeholder="Preço (0 = grátis)" class="input-padrao" />
          <div>
            <label for="ad-foto" class="text-xs text-gray-500" style="display:block;margin-bottom:6px;font-weight:600">Foto (opcional)</label>
            <input id="ad-foto" type="file" accept="image/*" class="text-xs" style="width:100%" />
            <img id="ad-foto-previa" alt="Prévia da foto" style="display:none;width:96px;height:96px;object-fit:cover;border-radius:12px;margin-top:8px" />
          </div>
          <div style="display:flex;gap:8px">
            <button type="submit" id="btn-salvar-adicional" class="px-3 py-2 text-xs font-bold rounded-lg" style="flex:1;background:var(--dourado,#d4a437);color:#1a1a1a;border:0;cursor:pointer">Salvar adicional</button>
            <button type="button" id="btn-cancelar-adicional" class="px-3 py-2 text-xs font-bold rounded-lg border">Cancelar</button>
          </div>
        </div>
      </form>

      <div id="lista-adicionais" style="display:flex;flex-direction:column;gap:8px"></div>
    </section>
  `);
  return true;
}

function configurarEventos() {
  if (!montarSecao()) return;
  inputFoto = criarInputFoto();

  $('btn-novo-adicional').addEventListener('click', () => {
    const form = $('form-adicional');
    const abrir = form.style.display === 'none';
    form.style.display = abrir ? 'block' : 'none';
    if (abrir) $('ad-nome').focus();
  });

  $('btn-cancelar-adicional').addEventListener('click', fecharFormulario);
  $('form-adicional').addEventListener('submit', cadastrarAdicional);
  $('form-adicional').addEventListener('reset', limparPrevia);

  $('form-adicional').addEventListener('change', (evento) => {
    if (evento.target.id === 'ad-foto') {
      mostrarPrevia(evento.target.files && evento.target.files[0]);
    }
  });

  $('lista-adicionais').addEventListener('click', async (evento) => {
    const foto = evento.target.closest('[data-ad-foto]');
    const fotoRemover = evento.target.closest('[data-ad-foto-remover]');
    const alternar = evento.target.closest('[data-ad-toggle]');
    const excluir = evento.target.closest('[data-ad-del]');

    if (fotoRemover) return removerFoto(fotoRemover.dataset.adFotoRemover);
    if (alternar) return alternarAtivo(alternar.dataset.adToggle);
    if (excluir) return excluirAdicional(excluir.dataset.adDel);

    if (foto) {
      const item = acharAdicional(foto.dataset.adFoto);
      if (item) {
        adicionalDaFoto = item;
        inputFoto.click();
      }
    }
  });

  $('lista-adicionais').addEventListener('change', async (evento) => {
    if (evento.target.matches('[data-ad-preco]')) {
      await salvarPreco(evento.target);
    }
  });

  // Recarrega sempre que os produtos forem carregados (login, troca de restaurante)
  document.addEventListener('admin:produtos-carregados', carregarAdicionais);
}

export function inicializarAdicionais() {
  if (eventosConfigurados) return;
  configurarEventos();
  eventosConfigurados = true;
}
