// Aba Conta: identidade visual do cardápio (logo, banner e cores).
// - Cores: prévia ao vivo, avisos de legibilidade e travas iguais às do cardápio.
// - Imagens: reduzidas no navegador (WebP) e enviadas para a pasta do próprio restaurante no Storage.
import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, aviso, tratarErro, atualizar } from './admin-utils.js';
import { montarCartaoAvisos, atualizarAvisos } from './admin-avisos.js';

const BUCKET = 'imagens-restaurantes';
const MAX_BYTES = 2 * 1024 * 1024; // mesmo limite do bucket (sql/07)
const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
const EXTENSOES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAIOR_LADO_PX = { logo: 512, banner: 1600 };

// O cardápio só usa fundo claro (luminância acima de 0,8). O painel segue a MESMA regra,
// para nunca salvar uma cor de fundo que o cardápio vai ignorar.
export const LUMINANCIA_MIN_FUNDO = 0.8;

const COR_PRINCIPAL_PADRAO = '#C2410C';
const COR_FUNDO_PADRAO = '#FBF7F0';

const PALETAS = [
  { nome: 'Imperial (Padrão)', pri: '#C2410C', sec: '#FBF7F0' },
  { nome: 'Ouro Real', pri: '#C9A24B', sec: '#FAF8F5' },
  { nome: 'Vermelho Burguer', pri: '#DC2626', sec: '#FFFBFB' },
  { nome: 'Verde Artesanal', pri: '#059669', sec: '#F0FDF4' },
  { nome: 'Azul Delivery', pri: '#2563EB', sec: '#F8FAFC' },
  { nome: 'Carvão Moderno', pri: '#1F2937', sec: '#F9FAFB' }
];

const TEXTOS = {
  logo: {
    enviando: 'Enviando logo...',
    ok: 'Logo atualizada com sucesso!',
    removida: 'Logo removida com sucesso!',
    confirmar: 'Deseja remover a logo da loja? O cardápio voltará a exibir as iniciais.'
  },
  banner: {
    enviando: 'Enviando banner...',
    ok: 'Banner atualizado com sucesso!',
    removida: 'Banner removido com sucesso!',
    confirmar: 'Deseja remover o banner da loja?'
  }
};

// ---------- Funções puras (sem tela nem banco; fáceis de testar) ----------

// Aceita "c2410c", "#C2410C" ou "#abc"; devolve "#RRGGBB" em maiúsculas, ou null se for inválida
export function normalizarHex(texto) {
  let t = String(texto ?? '').trim();
  if (!t) return null;
  if (!t.startsWith('#')) t = '#' + t;
  if (/^#[0-9a-fA-F]{3}$/.test(t)) {
    t = '#' + t.slice(1).split('').map((c) => c + c).join('');
  }
  return /^#[0-9a-fA-F]{6}$/.test(t) ? t.toUpperCase() : null;
}

// Luminância relativa (WCAG)
export function luminancia(hex) {
  const canais = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * canais[0] + 0.7152 * canais[1] + 0.0722 * canais[2];
}

export function razaoContraste(hex1, hex2) {
  const l1 = luminancia(hex1) + 0.05;
  const l2 = luminancia(hex2) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

// Texto branco ou grafite, o que tiver mais contraste sobre a cor (igual ao cardápio)
export function corTextoContraste(hexFundo) {
  const branco = razaoContraste(hexFundo, '#FFFFFF');
  const grafite = razaoContraste(hexFundo, '#16171A');
  return branco >= grafite ? '#FFFFFF' : '#16171A';
}

// Avalia o par de cores. "erro" impede salvar; "avisos" só orientam.
export function avaliarCores(pri, sec) {
  if (!pri) return { erro: 'Cor principal inválida. Use o formato #RRGGBB.' };
  if (!sec) return { erro: 'Cor de fundo inválida. Use o formato #RRGGBB.' };

  if (luminancia(sec) < LUMINANCIA_MIN_FUNDO) {
    return {
      erro: 'Cor de fundo escura demais: o cardápio só usa fundos claros. Escolha uma cor mais clara.'
    };
  }

  const textoBotao = corTextoContraste(pri);
  const razaoTexto = razaoContraste(pri, textoBotao);
  const razaoFundo = razaoContraste(pri, sec);
  const avisos = [];

  avisos.push(razaoTexto >= 4.5
    ? { nivel: 'ok', texto: `Texto do botão legível (${razaoTexto.toFixed(1)}:1).` }
    : { nivel: 'atencao', texto: `Texto do botão com leitura difícil (${razaoTexto.toFixed(1)}:1). Prefira uma cor mais clara ou mais escura.` });

  avisos.push(razaoFundo >= 3
    ? { nivel: 'ok', texto: `Botão bem visível sobre o fundo (${razaoFundo.toFixed(1)}:1).` }
    : { nivel: 'atencao', texto: `O botão pode ficar pouco visível sobre o fundo (${razaoFundo.toFixed(1)}:1). Prefira uma cor principal mais escura ou mais forte.` });

  return { erro: null, textoBotao, razaoTexto, razaoFundo, avisos };
}

// Reduz o maior lado até o limite, mantendo a proporção (nunca amplia)
export function calcularTamanho(largura, altura, maximo) {
  const maior = Math.max(largura, altura);
  if (!(maior > maximo)) return { largura, altura };
  const fator = maximo / maior;
  return {
    largura: Math.max(1, Math.round(largura * fator)),
    altura: Math.max(1, Math.round(altura * fator))
  };
}

const urlImagemValida = (u) =>
  typeof u === 'string' && u.length <= 500 && /^https:\/\/[^\s"'()<>\\]+$/.test(u);

// Se o endereço é de um arquivo DESTE restaurante no nosso bucket, devolve o caminho dele; senão null.
export function caminhoDoBucket(url, restauranteId) {
  if (typeof url !== 'string' || !restauranteId) return null;

  const marca = `/storage/v1/object/public/${BUCKET}/`;
  const posicao = url.indexOf(marca);
  if (posicao === -1) return null;

  let caminho;
  try {
    caminho = decodeURIComponent(url.slice(posicao + marca.length).split('?')[0]);
  } catch (erro) {
    return null;
  }

  if (caminho.includes('..') || !caminho.startsWith(`${restauranteId}/`)) return null;
  return caminho;
}

function iniciais(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter((p) => p.length > 2);
  return ((partes[0] || nome || '?')[0] + (partes[1] ? partes[1][0] : '')).toUpperCase();
}

// ---------- Redução da imagem no navegador ----------
function carregarImagem(arquivo) {
  return new Promise((resolve, reject) => {
    const endereco = URL.createObjectURL(arquivo);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(endereco); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(endereco); reject(new Error('Não foi possível ler a imagem.')); };
    img.src = endereco;
  });
}

const canvasParaBlob = (canvas, tipo, qualidade) =>
  new Promise((resolve) => canvas.toBlob(resolve, tipo, qualidade));

export async function redimensionarImagem(arquivo, tipo) {
  const img = await carregarImagem(arquivo);
  const { largura, altura } = calcularTamanho(img.naturalWidth, img.naturalHeight, MAIOR_LADO_PX[tipo] || 1200);

  const canvas = document.createElement('canvas');
  canvas.width = largura;
  canvas.height = altura;
  const contexto = canvas.getContext('2d');
  if (!contexto) throw new Error('Seu navegador não conseguiu processar a imagem.');
  contexto.drawImage(img, 0, 0, largura, altura);

  const webp = await canvasParaBlob(canvas, 'image/webp', 0.85);
  if (webp && webp.type === 'image/webp') return webp;

  // Navegador sem suporte a WebP: usa JPEG (que não tem transparência, então fundo branco)
  const alternativo = document.createElement('canvas');
  alternativo.width = largura;
  alternativo.height = altura;
  const ctx2 = alternativo.getContext('2d');
  ctx2.fillStyle = '#FFFFFF';
  ctx2.fillRect(0, 0, largura, altura);
  ctx2.drawImage(img, 0, 0, largura, altura);
  const jpeg = await canvasParaBlob(alternativo, 'image/jpeg', 0.88);
  if (!jpeg) throw new Error('Não foi possível preparar a imagem.');
  return jpeg;
}

async function removerDoBucket(caminho) {
  if (!caminho || !sb) return;
  try {
    await sb.storage.from(BUCKET).remove([caminho]);
  } catch (erro) {
    console.warn('Não foi possível apagar o arquivo antigo do Storage:', erro);
  }
}

// Reduz, valida e envia. Devolve { url, caminho } ou null.
export async function enviarImagem(arquivo, tipo, redimensionar = redimensionarImagem) {
  if (!arquivo) return null;

  if (!state.rest || !sb) {
    aviso('Sessão expirada. Entre novamente.');
    return null;
  }

  if (!TIPOS_PERMITIDOS.includes(arquivo.type)) {
    aviso('Formato não aceito. Envie uma imagem JPG, PNG ou WEBP.');
    return null;
  }

  let blob = arquivo;
  try {
    blob = await redimensionar(arquivo, tipo);
  } catch (erro) {
    // Se não deu para reduzir, tenta com o original (vale se ele couber nos 2 MB)
    console.warn('Não foi possível reduzir a imagem; usando o arquivo original.', erro);
  }

  if (blob.size > MAX_BYTES) {
    aviso('A imagem continua acima de 2 MB. Escolha uma imagem menor.');
    return null;
  }

  const tipoFinal = blob.type;
  if (!TIPOS_PERMITIDOS.includes(tipoFinal)) {
    aviso('Formato não aceito. Envie uma imagem JPG, PNG ou WEBP.');
    return null;
  }

  // O nome nunca vem do arquivo do usuário: a extensão sai do tipo da imagem
  const caminho = `${state.rest.id}/${tipo}-${Date.now()}.${EXTENSOES[tipoFinal]}`;

  aviso(TEXTOS[tipo].enviando);

  const { error } = await sb.storage.from(BUCKET).upload(caminho, blob, {
    cacheControl: '31536000', // o nome é único, então o navegador pode guardar por muito tempo
    contentType: tipoFinal,
    upsert: false
  });

  if (error) {
    tratarErro(error, 'Erro no envio da imagem.');
    return null;
  }

  const { data } = sb.storage.from(BUCKET).getPublicUrl(caminho);
  const url = data?.publicUrl || null;

  if (!urlImagemValida(url)) {
    await removerDoBucket(caminho);
    aviso('Não foi possível gerar o endereço da imagem.');
    return null;
  }

  return { url, caminho };
}

// ---------- Tela ----------
function mostrarImagem(imgId, placeholderId, removerId, url) {
  const img = $(imgId);
  const placeholder = $(placeholderId);
  const remover = $(removerId);
  const temImagem = urlImagemValida(url);

  if (img) {
    if (temImagem) img.src = url;
    else img.removeAttribute('src');
    img.classList.toggle('hidden', !temImagem);
  }
  if (placeholder) placeholder.classList.toggle('hidden', temImagem);
  if (remover) remover.classList.toggle('hidden', !temImagem);
}

function lerCores() {
  return {
    pri: normalizarHex($('cor-primaria-hex')?.value),
    sec: normalizarHex($('cor-secundaria-hex')?.value)
  };
}

function atualizarPrevia() {
  const { pri, sec } = lerCores();
  const avaliacao = avaliarCores(pri, sec);

  // A prévia mostra o que o cardápio realmente vai fazer
  const corBotao = pri || COR_PRINCIPAL_PADRAO;
  const corFundo = sec && luminancia(sec) >= LUMINANCIA_MIN_FUNDO ? sec : COR_FUNDO_PADRAO;
  const corTexto = corTextoContraste(corBotao);

  const caixa = $('previa-cardapio');
  if (caixa) caixa.style.backgroundColor = corFundo;

  for (const id of ['previa-btn', 'previa-chip']) {
    const el = $(id);
    if (el) {
      el.style.backgroundColor = corBotao;
      el.style.color = corTexto;
    }
  }

  const avisos = $('aviso-contraste');
  if (avisos) {
    avisos.replaceChildren();
    const linhas = avaliacao.erro
      ? [{ nivel: 'erro', texto: avaliacao.erro }]
      : avaliacao.avisos;

    for (const linha of linhas) {
      const p = document.createElement('p');
      p.className = `ident-${linha.nivel}`;
      p.textContent = (linha.nivel === 'ok' ? '✓ ' : '⚠ ') + linha.texto;
      avisos.appendChild(p);
    }
  }

  mostrarImagem('logo-previa-img', 'logo-placeholder', 'btn-remover-logo', state.rest?.logo_url);
  mostrarImagem('banner-previa-img', 'banner-placeholder', 'btn-remover-banner', state.rest?.banner_url);
}

export function preencherIdentidade() {
  if (!state.rest) return;
  preencherChavePix();
  preencherWhatsapp();
  atualizarAvisos();

  const pri = normalizarHex(state.rest.cor_primaria) || COR_PRINCIPAL_PADRAO;
  const sec = normalizarHex(state.rest.cor_secundaria) || COR_FUNDO_PADRAO;

  if ($('cor-primaria')) $('cor-primaria').value = pri;
  if ($('cor-primaria-hex')) $('cor-primaria-hex').value = pri;
  if ($('cor-secundaria')) $('cor-secundaria').value = sec;
  if ($('cor-secundaria-hex')) $('cor-secundaria-hex').value = sec;

  const ini = iniciais(state.rest.nome);
  for (const id of ['logo-placeholder', 'previa-logo']) {
    if ($(id)) $(id).textContent = ini;
  }
  if ($('previa-nome')) $('previa-nome').textContent = state.rest.nome || 'Sua lanchonete';

  atualizarPrevia();
}

// ---------- Ações ----------
let ocupado = false;

async function trocarImagem(tipo, arquivo, campo) {
  if (!arquivo || ocupado) return;
  ocupado = true;
  campo.disabled = true;

  try {
    const coluna = tipo === 'logo' ? 'logo_url' : 'banner_url';
    const anterior = state.rest?.[coluna];

    const enviado = await enviarImagem(arquivo, tipo);
    if (!enviado) return;

    const resultado = await atualizar('restaurantes', state.rest.id, { [coluna]: enviado.url }, TEXTOS[tipo].ok);

    if (!resultado) {
      await removerDoBucket(enviado.caminho); // não deixa arquivo órfão
      return;
    }

    state.rest[coluna] = resultado[coluna];
    atualizarPrevia();

    // Apaga a imagem anterior (só se for deste restaurante e do nosso bucket)
    const antigo = caminhoDoBucket(anterior, state.rest.id);
    if (antigo && antigo !== enviado.caminho) await removerDoBucket(antigo);
  } finally {
    campo.value = '';
    campo.disabled = false;
    ocupado = false;
  }
}

async function removerImagem(tipo) {
  if (ocupado || !state.rest) return;
  if (!confirm(TEXTOS[tipo].confirmar)) return;

  ocupado = true;
  try {
    const coluna = tipo === 'logo' ? 'logo_url' : 'banner_url';
    const anterior = state.rest[coluna];

    const resultado = await atualizar('restaurantes', state.rest.id, { [coluna]: null }, TEXTOS[tipo].removida);
    if (!resultado) return;

    state.rest[coluna] = null;
    atualizarPrevia();
    await removerDoBucket(caminhoDoBucket(anterior, state.rest.id));
  } finally {
    ocupado = false;
  }
}

async function salvarCores() {
  const { pri, sec } = lerCores();
  const avaliacao = avaliarCores(pri, sec);
  if (avaliacao.erro) return aviso(avaliacao.erro);

  const botao = $('btn-salvar-cores');
  botao.disabled = true;
  botao.innerText = 'Salvando cores...';

  const resultado = await atualizar(
    'restaurantes',
    state.rest.id,
    { cor_primaria: pri, cor_secundaria: sec },
    'Cores do cardápio atualizadas!'
  );

  botao.disabled = false;
  botao.innerText = 'Salvar cores do cardápio';

  if (resultado) {
    state.rest.cor_primaria = resultado.cor_primaria;
    state.rest.cor_secundaria = resultado.cor_secundaria;
    atualizarPrevia();
  }
}

function sincronizarCor(idSeletor, idHex) {
  $(idSeletor)?.addEventListener('input', (evento) => {
    $(idHex).value = evento.target.value.toUpperCase();
    atualizarPrevia();
  });

  $(idHex)?.addEventListener('input', (evento) => {
    const hex = normalizarHex(evento.target.value);
    if (hex) $(idSeletor).value = hex;
    atualizarPrevia();
  });
}

// ---------- Chave Pix (aparece para o cliente na tela de pagamento) ----------
const chavePixValida = (c) =>
  typeof c === 'string' && c.trim().length > 0 && c.trim().length <= 100 && !/[\u0000-\u001f<>]/.test(c);

function preencherChavePix() {
  const campo = $('input-chave-pix');
  if (campo && state.rest) campo.value = state.rest.chave_pix || '';
}

async function salvarChavePix() {
  if (!state.rest) return;

  const campo = $('input-chave-pix');
  const botao = $('btn-salvar-chave-pix');
  const valor = campo.value.trim();

  if (valor && !chavePixValida(valor)) {
    return aviso('Chave Pix inválida. Use até 100 caracteres, sem os símbolos < ou >.');
  }

  botao.disabled = true;
  botao.textContent = 'Salvando...';

  const resultado = await atualizar(
    'restaurantes',
    state.rest.id,
    { chave_pix: valor || null },
    valor ? 'Chave Pix salva!' : 'Chave Pix removida.'
  );

  botao.disabled = false;
  botao.textContent = 'Salvar chave Pix';

  if (resultado) {
    state.rest.chave_pix = resultado.chave_pix ?? (valor || null);
    campo.value = state.rest.chave_pix || '';
  }
}

// Cria o cartão "Chave Pix da loja" acima do bloco de identidade visual
function montarCartaoChavePix() {
  if ($('cartao-chave-pix')) return;

  const botaoCores = $('btn-salvar-cores');
  if (!botaoCores) return;

  // Acha o bloco da aba Conta que contém as cores, para o novo cartão ter o mesmo visual
  const aba = botaoCores.closest('[id^="aba-"]');
  let bloco = botaoCores.parentElement;
  if (aba) {
    bloco = botaoCores;
    while (bloco.parentElement && bloco.parentElement !== aba) bloco = bloco.parentElement;
  }

  const cartao = document.createElement('div');
  cartao.id = 'cartao-chave-pix';
  cartao.className = bloco.className;
  cartao.style.marginBottom = '16px';

  const rotulo = document.createElement('label');
  rotulo.className = 'bloco-label';
  rotulo.htmlFor = 'input-chave-pix';
  rotulo.textContent = 'Chave Pix da loja';

  const campo = document.createElement('input');
  campo.id = 'input-chave-pix';
  campo.type = 'text';
  campo.maxLength = 100;
  campo.autocomplete = 'off';
  campo.placeholder = 'CPF/CNPJ, e-mail, telefone ou chave aleatória';
  campo.className = ($('cor-primaria-hex')?.className || '').replace('input-hex', '').trim();

  const dica = document.createElement('p');
  dica.className = 'placeholder-texto';
  dica.style.margin = '6px 0 12px';
  dica.textContent = 'Esta chave aparece para o cliente na tela de pagamento. Confira antes de salvar. Deixe em branco se não quiser receber por chave Pix.';

  const salvar = document.createElement('button');
  salvar.type = 'button';
  salvar.id = 'btn-salvar-chave-pix';
  salvar.className = botaoCores.className;
  salvar.textContent = 'Salvar chave Pix';
  salvar.addEventListener('click', salvarChavePix);

  cartao.append(rotulo, campo, dica, salvar);
  bloco.before(cartao);

  preencherChavePix();
}

// ---------- WhatsApp da loja (usado nos botões de WhatsApp do cardápio) ----------
// Guarda só os números, com DDD e sem o 55 (o cardápio acrescenta o 55 sozinho)
function normalizarWhatsapp(texto) {
  let n = String(texto ?? '').replace(/\D/g, '');
  if ((n.length === 12 || n.length === 13) && n.startsWith('55')) n = n.slice(2);
  return n;
}

function formatarWhatsapp(n) {
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return n;
}

function preencherWhatsapp() {
  const campo = $('input-whatsapp-loja');
  if (!campo || !state.rest) return;
  const n = normalizarWhatsapp(state.rest.whatsapp);
  campo.value = n ? formatarWhatsapp(n) : '';
}

async function salvarWhatsapp() {
  if (!state.rest) return;

  const campo = $('input-whatsapp-loja');
  const botao = $('btn-salvar-whatsapp');
  const numero = normalizarWhatsapp(campo.value);

  if (numero.length !== 10 && numero.length !== 11) {
    return aviso('WhatsApp inválido. Informe o DDD e o número, por exemplo (33) 99999-9999.');
  }

  botao.disabled = true;
  botao.textContent = 'Salvando...';

  const resultado = await atualizar(
    'restaurantes',
    state.rest.id,
    { whatsapp: numero },
    'WhatsApp da loja salvo!'
  );

  botao.disabled = false;
  botao.textContent = 'Salvar WhatsApp';

  if (resultado) {
    state.rest.whatsapp = resultado.whatsapp ?? numero;
    preencherWhatsapp();
  }
}

// Cria o cartão "WhatsApp da loja" acima do cartão da chave Pix
function montarCartaoWhatsapp() {
  if ($('cartao-whatsapp')) return;

  const cartaoPix = $('cartao-chave-pix');
  if (!cartaoPix) return;

  const cartao = document.createElement('div');
  cartao.id = 'cartao-whatsapp';
  cartao.className = cartaoPix.className;
  cartao.style.marginBottom = '16px';

  const rotulo = document.createElement('label');
  rotulo.className = 'bloco-label';
  rotulo.htmlFor = 'input-whatsapp-loja';
  rotulo.textContent = 'WhatsApp da loja';

  const campo = document.createElement('input');
  campo.id = 'input-whatsapp-loja';
  campo.type = 'tel';
  campo.inputMode = 'tel';
  campo.maxLength = 20;
  campo.autocomplete = 'off';
  campo.placeholder = '(33) 99999-9999';
  campo.className = $('input-chave-pix')?.className || '';

  const dica = document.createElement('p');
  dica.className = 'placeholder-texto';
  dica.style.margin = '6px 0 12px';
  dica.textContent = 'Número com DDD que recebe os pedidos e os comprovantes. Os clientes veem este número nos botões de WhatsApp do cardápio.';

  const salvar = document.createElement('button');
  salvar.type = 'button';
  salvar.id = 'btn-salvar-whatsapp';
  salvar.className = $('btn-salvar-chave-pix')?.className || '';
  salvar.textContent = 'Salvar WhatsApp';
  salvar.addEventListener('click', salvarWhatsapp);

  cartao.append(rotulo, campo, dica, salvar);
  cartaoPix.before(cartao);

  preencherWhatsapp();
}

let eventosConfigurados = false;

export function inicializarIdentidade() {
  if (eventosConfigurados) return;
  eventosConfigurados = true;
  montarCartaoChavePix();
  montarCartaoWhatsapp();
  montarCartaoAvisos();

  const paletas = $('paletas-sugestoes');
  if (paletas) {
    paletas.innerHTML = PALETAS.map((p) => `
      <button type="button" class="btn-paleta" data-pri="${p.pri}" data-sec="${p.sec}" title="${p.nome}">
        <span class="paleta-circulo" style="background:${p.pri}"></span>
        <span>${p.nome}</span>
      </button>`).join('');

    paletas.addEventListener('click', (evento) => {
      const botao = evento.target.closest('[data-pri]');
      if (!botao) return;
      $('cor-primaria').value = botao.dataset.pri;
      $('cor-primaria-hex').value = botao.dataset.pri;
      $('cor-secundaria').value = botao.dataset.sec;
      $('cor-secundaria-hex').value = botao.dataset.sec;
      atualizarPrevia();
    });
  }

  sincronizarCor('cor-primaria', 'cor-primaria-hex');
  sincronizarCor('cor-secundaria', 'cor-secundaria-hex');

  $('btn-salvar-cores')?.addEventListener('click', salvarCores);

  $('input-upload-logo')?.addEventListener('change', (e) => trocarImagem('logo', e.target.files?.[0], e.target));
  $('input-upload-banner')?.addEventListener('change', (e) => trocarImagem('banner', e.target.files?.[0], e.target));
  $('btn-remover-logo')?.addEventListener('click', () => removerImagem('logo'));
  $('btn-remover-banner')?.addEventListener('click', () => removerImagem('banner'));

  // Imagem que não carregar some da prévia (o espaço volta ao texto padrão)
  for (const id of ['logo-previa-img', 'banner-previa-img']) {
    $(id)?.addEventListener('error', (e) => e.target.classList.add('hidden'));
  }
}
