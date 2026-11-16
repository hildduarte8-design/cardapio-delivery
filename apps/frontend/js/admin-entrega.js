import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, esc, num, aviso, tratarErro, atualizar, achar } from './admin-utils.js';
import { renderPedidos } from './admin-pedidos.js';

export function preencherRestaurante() {
  if (!state.rest) return;

  $('r-nome').value = state.rest.nome || '';
  $('r-whatsapp').value = state.rest.whatsapp || '';
  $('r-chave-pix').value = state.rest.chave_pix || '';
  $('r-taxa-base').value = state.rest.taxa_base ?? '';
  $('r-valor-km').value = state.rest.valor_km ?? '';
  $('r-lat').value = state.rest.loja_lat ?? '';
  $('r-lon').value = state.rest.loja_lon ?? '';
  $('r-raio-max').value = state.rest.raio_max_km ?? '';
  $('r-frete-distancia').checked = state.rest.frete_por_distancia === true;
}

async function salvarRestaurante() {
  const nome = $('r-nome').value.trim();
  const taxaBase = num($('r-taxa-base').value);
  const valorKm = num($('r-valor-km').value);
  const latitude = num($('r-lat').value);
  const longitude = num($('r-lon').value);

  const raioBruto = $('r-raio-max').value.trim();
  const raioMax = raioBruto === '' ? null : num(raioBruto);
  const fretePorDistancia = $('r-frete-distancia').checked;

  const chavePix = $('r-chave-pix').value.trim();

  if (nome.length < 2) return aviso('Informe o nome');
  if (chavePix.length > 100 || /[\u0000-\u001f<>]/.test(chavePix)) {
    return aviso('Chave Pix inválida: use até 100 caracteres, sem < ou >.');
  }
  if (!(taxaBase >= 0) || !(valorKm >= 0)) {
    return aviso('Taxa base e valor por km são obrigatórios');
  }

  if (
    (latitude !== null && Math.abs(latitude) > 90) ||
    (longitude !== null && Math.abs(longitude) > 180)
  ) {
    return aviso('Coordenadas inválidas');
  }

  if (raioBruto !== '' && !(raioMax > 0 && raioMax <= 200)) {
    return aviso('Raio máximo inválido: use um valor entre 0,1 e 200 km, ou deixe vazio.');
  }

  if (fretePorDistancia && (latitude === null || longitude === null)) {
    return aviso('Para ligar o frete por distância, informe a latitude e a longitude da loja.');
  }

  const botao = $('btn-salvar-rest');
  botao.disabled = true;

  const resultado = await atualizar(
    'restaurantes',
    state.rest.id,
    {
      nome,
      taxa_base: taxaBase,
      valor_km: valorKm,
      loja_lat: latitude,
      loja_lon: longitude,
      raio_max_km: raioMax,
      frete_por_distancia: fretePorDistancia,
      whatsapp: $('r-whatsapp').value.replace(/\D/g, '') || null,
      chave_pix: chavePix || null
    },
    'Dados salvos'
  );

  botao.disabled = false;

  if (resultado) {
    state.rest = resultado;
    $('rest-nome').innerText = state.rest.nome;
  }
}

export async function carregarBairros() {
  if (!state.rest || !sb) return;

  const { data, error } = await sb
    .from('bairros')
    .select('*')
    .eq('restaurante_id', state.rest.id)
    .order('nome');

  if (error) {
    tratarErro(error, 'Erro ao carregar bairros.');
    return;
  }

  state.bairros = data || [];
  renderBairros();
  renderPedidos();

  // Entregadores carregam junto com os bairros (mesma tela, mesma loja)
  carregarEntregadores();
}

function renderBairros() {
  $('lista-bairros').innerHTML = state.bairros.length
    ? state.bairros.map((bairro) => `
      <div class="flex items-center gap-2 p-2 border rounded-lg ${
        bairro.ativo ? 'bg-white' : 'bg-gray-50 opacity-60'
      }">
        <span class="flex-1 min-w-0 text-sm font-semibold truncate">
          ${esc(bairro.nome)}
        </span>

        <input
          data-btaxa="${esc(bairro.id)}"
          type="number"
          step="0.01"
          min="0"
          inputmode="decimal"
          value="${Number(bairro.taxa ?? 0).toFixed(2)}"
          aria-label="Taxa de ${esc(bairro.nome)}"
          class="w-20 p-2 border rounded-lg bg-gray-50 text-sm"
        />

        <input
          data-btempo="${esc(bairro.id)}"
          maxlength="20"
          value="${esc(bairro.tempo_estimado || '')}"
          aria-label="Tempo de ${esc(bairro.nome)}"
          class="w-24 p-2 border rounded-lg bg-gray-50 text-xs"
        />

        <button
          data-bativo="${esc(bairro.id)}"
          class="px-2 py-2 text-xs font-bold rounded-lg border ${
            bairro.ativo
              ? 'bg-yellow-50 text-yellow-700 border-yellow-200'
              : 'bg-green-50 text-green-700 border-green-200'
          }"
        >
          ${bairro.ativo ? 'Pausar' : 'Ativar'}
        </button>
      </div>
    `).join('')
    : '<p class="text-sm text-gray-500">Nenhum bairro cadastrado.</p>';
}

async function alterarCampoBairro(elemento) {
  const id = elemento.dataset.btaxa || elemento.dataset.btempo;
  const bairro = achar(state.bairros, id);
  if (!bairro) return;

  if (elemento.matches('[data-btaxa]')) {
    const taxa = num(elemento.value);

    if (!(taxa >= 0) || taxa > 1000) {
      aviso('Taxa inválida');
      elemento.value = Number(bairro.taxa).toFixed(2);
      return;
    }

    const resultado = await atualizar(
      'bairros',
      bairro.id,
      { taxa },
      `Taxa de ${bairro.nome} atualizada`
    );

    if (resultado) bairro.taxa = resultado.taxa;
    else elemento.value = Number(bairro.taxa).toFixed(2);

    return;
  }

  if (elemento.matches('[data-btempo]')) {
    const tempo = elemento.value.trim() || null;

    const resultado = await atualizar(
      'bairros',
      bairro.id,
      { tempo_estimado: tempo },
      'Tempo atualizado'
    );

    if (resultado) bairro.tempo_estimado = resultado.tempo_estimado;
    else elemento.value = bairro.tempo_estimado || '';
  }
}

async function alternarBairro(id) {
  const bairro = achar(state.bairros, id);
  if (!bairro) return;

  const resultado = await atualizar(
    'bairros',
    bairro.id,
    { ativo: !bairro.ativo },
    bairro.ativo ? 'Bairro pausado' : 'Bairro ativado'
  );

  if (resultado) {
    bairro.ativo = resultado.ativo;
    renderBairros();
  }
}

async function cadastrarBairro(evento) {
  evento.preventDefault();

  const nome = $('b-nome').value.trim();
  const taxa = num($('b-taxa').value);

  if (nome.length < 2) return aviso('Informe o bairro');
  if (!(taxa >= 0) || taxa > 1000) return aviso('Taxa inválida');

  const { error } = await sb
    .from('bairros')
    .insert([{
      restaurante_id: state.rest.id,
      nome,
      taxa,
      tempo_estimado: $('b-tempo').value.trim() || null,
      ativo: true
    }]);

  if (error) {
    tratarErro(
      error,
      /duplicate|unique/i.test(error.message || '')
        ? 'Esse bairro já existe.'
        : 'Erro ao cadastrar.'
    );
    return;
  }

  $('form-bairro').reset();
  aviso('Bairro cadastrado');
  await carregarBairros();
}

/* ================= ENTREGADORES ================= */

// Guarda sempre com o 55 na frente (ex.: 5533999998888), pronto para o wa.me
function normalizarZapEntregador(valor) {
  let digitos = String(valor || '').replace(/\D/g, '');
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
  return /^55\d{10,11}$/.test(digitos) ? digitos : null;
}

// Mostra no formato (33) 99999-8888
function formatarZapEntregador(valor) {
  const n = String(valor || '').replace(/^55/, '');
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return n;
}

export async function carregarEntregadores() {
  if (!state.rest || !sb) return;

  const { data, error } = await sb
    .from('entregadores')
    .select('*')
    .eq('restaurante_id', state.rest.id)
    .order('nome');

  if (error) {
    tratarErro(error, 'Erro ao carregar entregadores.');
    return;
  }

  state.entregadores = data || [];
  renderEntregadores();
}

function renderEntregadores() {
  const lista = $('lista-entregadores');
  if (!lista) return;

  const entregadores = state.entregadores || [];

  lista.innerHTML = entregadores.length
    ? entregadores.map((entregador) => `
      <div class="flex flex-wrap items-center gap-2 p-2 border rounded-lg ${
        entregador.ativo ? 'bg-white' : 'bg-gray-50 opacity-60'
      }">
        <input
          data-enome="${esc(entregador.id)}"
          maxlength="60"
          value="${esc(entregador.nome)}"
          aria-label="Nome do entregador"
          style="flex:1; min-width:8rem"
          class="p-2 border rounded-lg bg-gray-50 text-sm font-semibold"
        />

        <input
          data-ezap="${esc(entregador.id)}"
          inputmode="numeric"
          maxlength="20"
          value="${esc(formatarZapEntregador(entregador.whatsapp))}"
          aria-label="WhatsApp de ${esc(entregador.nome)}"
          style="width:9.5rem"
          class="p-2 border rounded-lg bg-gray-50 text-xs"
        />

        <button
          data-eativo="${esc(entregador.id)}"
          class="px-2 py-2 text-xs font-bold rounded-lg border ${
            entregador.ativo
              ? 'bg-yellow-50 text-yellow-700 border-yellow-200'
              : 'bg-green-50 text-green-700 border-green-200'
          }"
        >
          ${entregador.ativo ? 'Pausar' : 'Ativar'}
        </button>

        <button
          data-eremover="${esc(entregador.id)}"
          aria-label="Remover ${esc(entregador.nome)}"
          class="px-2 py-2 text-xs font-bold rounded-lg border bg-red-50 text-red-700 border-red-200"
        >
          Remover
        </button>
      </div>
    `).join('')
    : '<p class="text-sm text-gray-500">Nenhum entregador cadastrado.</p>';
}

async function cadastrarEntregador(evento) {
  evento.preventDefault();

  const nome = $('e-nome').value.trim();
  const whatsapp = normalizarZapEntregador($('e-whatsapp').value);

  if (nome.length < 2 || nome.length > 60) return aviso('Informe o nome do entregador');
  if (!whatsapp) return aviso('WhatsApp inválido: digite com DDD, por exemplo (33) 99999-8888');

  const { error } = await sb
    .from('entregadores')
    .insert([{
      restaurante_id: state.rest.id,
      nome,
      whatsapp,
      ativo: true
    }]);

  if (error) {
    tratarErro(
      error,
      /duplicate|unique/i.test(error.message || '')
        ? 'Esse número já está cadastrado.'
        : 'Erro ao cadastrar entregador.'
    );
    return;
  }

  $('form-entregador').reset();
  aviso('Entregador cadastrado');
  await carregarEntregadores();
}

async function alterarCampoEntregador(elemento) {
  const id = elemento.dataset.enome || elemento.dataset.ezap;
  const entregador = achar(state.entregadores || [], id);
  if (!entregador) return;

  if (elemento.matches('[data-enome]')) {
    const nome = elemento.value.trim();

    if (nome.length < 2 || nome.length > 60) {
      aviso('Nome inválido');
      elemento.value = entregador.nome;
      return;
    }

    const resultado = await atualizar(
      'entregadores',
      entregador.id,
      { nome },
      'Nome atualizado'
    );

    if (resultado) entregador.nome = resultado.nome;
    else elemento.value = entregador.nome;

    return;
  }

  if (elemento.matches('[data-ezap]')) {
    const whatsapp = normalizarZapEntregador(elemento.value);

    if (!whatsapp) {
      aviso('WhatsApp inválido: digite com DDD');
      elemento.value = formatarZapEntregador(entregador.whatsapp);
      return;
    }

    const resultado = await atualizar(
      'entregadores',
      entregador.id,
      { whatsapp },
      'WhatsApp atualizado'
    );

    if (resultado) entregador.whatsapp = resultado.whatsapp;

    elemento.value = formatarZapEntregador(entregador.whatsapp);
  }
}

async function alternarEntregador(id) {
  const entregador = achar(state.entregadores || [], id);
  if (!entregador) return;

  const resultado = await atualizar(
    'entregadores',
    entregador.id,
    { ativo: !entregador.ativo },
    entregador.ativo ? 'Entregador pausado' : 'Entregador ativado'
  );

  if (resultado) {
    entregador.ativo = resultado.ativo;
    renderEntregadores();
  }
}

async function removerEntregador(id) {
  const entregador = achar(state.entregadores || [], id);
  if (!entregador) return;

  if (!confirm(`Remover o entregador ${entregador.nome}?\n\nSe for só uma pausa, use o botão Pausar.`)) return;

  const { error } = await sb
    .from('entregadores')
    .delete()
    .eq('id', entregador.id);

  if (error) {
    tratarErro(error, 'Erro ao remover entregador.');
    return;
  }

  state.entregadores = (state.entregadores || []).filter((item) => item.id !== entregador.id);
  renderEntregadores();
  aviso('Entregador removido');
}

function configurarEventosEntregadores() {
  const formulario = $('form-entregador');
  const lista = $('lista-entregadores');

  // Se o HTML da aba ainda não tem a seção de entregadores, não derruba o resto da tela
  if (!formulario || !lista) return;

  formulario.addEventListener('submit', cadastrarEntregador);

  lista.addEventListener('change', (evento) => {
    if (evento.target.matches('[data-enome]') || evento.target.matches('[data-ezap]')) {
      alterarCampoEntregador(evento.target);
    }
  });

  lista.addEventListener('click', (evento) => {
    const ativar = evento.target.closest('[data-eativo]');
    if (ativar) {
      alternarEntregador(ativar.dataset.eativo);
      return;
    }

    const remover = evento.target.closest('[data-eremover]');
    if (remover) removerEntregador(remover.dataset.eremover);
  });
}

function configurarEventos() {
  $('btn-salvar-rest').addEventListener('click', salvarRestaurante);

  $('lista-bairros').addEventListener('change', (evento) => {
    if (
      evento.target.matches('[data-btaxa]') ||
      evento.target.matches('[data-btempo]')
    ) {
      alterarCampoBairro(evento.target);
    }
  });

  $('lista-bairros').addEventListener('click', (evento) => {
    const botao = evento.target.closest('[data-bativo]');
    if (botao) alternarBairro(botao.dataset.bativo);
  });

  $('form-bairro').addEventListener('submit', cadastrarBairro);

  configurarEventosEntregadores();
}

let eventosConfigurados = false;

export function inicializarEntrega() {
  if (eventosConfigurados) return;
  configurarEventos();
  eventosConfigurados = true;
}
