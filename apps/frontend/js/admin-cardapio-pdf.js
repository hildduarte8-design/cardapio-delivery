// Botão "Baixar cardápio em PDF" (aba Produtos).
// Usa só produtos ativos já carregados no painel. As bibliotecas só são baixadas quando o botão é tocado.
import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, aviso } from './admin-utils.js';

const HTML2PDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
const QR_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
const carregando = {};

function carregarScript(url, pronto) {
  if (pronto()) return Promise.resolve();
  if (!carregando[url]) {
    carregando[url] = new Promise((ok, falha) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = ok;
      script.onerror = () => { delete carregando[url]; falha(new Error('Falha ao carregar ' + url)); };
      document.head.appendChild(script);
    });
  }
  return carregando[url];
}

const corValida = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
const urlImagemValida = (u) => typeof u === 'string' && u.length <= 500 && /^https:\/\/[^\s"'()<>\\]+$/.test(u);

function corDoTexto(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#16171A' : '#FFFFFF';
}

function formatarFone(texto) {
  let n = String(texto || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length > 11) n = n.slice(2);
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return '';
}

// Só entram no PDF as imagens que realmente carregam (foto quebrada não trava a geração)
function imagemCarrega(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const limite = setTimeout(() => resolve(false), 6000);
    img.crossOrigin = 'anonymous';
    img.onload = () => { clearTimeout(limite); resolve(true); };
    img.onerror = () => { clearTimeout(limite); resolve(false); };
    img.src = url;
  });
}

async function gerarQr(texto) {
  try {
    await carregarScript(QR_URL, () => window.QRCode);
    const caixa = document.createElement('div');
    new window.QRCode(caixa, { text: texto, width: 160, height: 160, correctLevel: window.QRCode.CorrectLevel.M });
    const canvas = caixa.querySelector('canvas');
    return canvas ? canvas.toDataURL('image/png') : '';
  } catch (e) {
    return ''; // sem QR, o PDF sai normalmente
  }
}

function precoPromocional(p) {
  const base = Number(p.preco) || 0;
  const promo = Number(p.preco_promocional);
  return promo > 0 && promo < base ? promo : null;
}

function htmlPreco(p, tamanho) {
  const base = Number(p.preco) || 0;
  const promo = precoPromocional(p);
  if (promo === null) {
    return `<span style="font-size:${tamanho}px;font-weight:800;color:#0F172A;">${esc(brl.format(base))}</span>`;
  }
  return `<span style="font-size:${tamanho}px;font-weight:800;color:#067647;">${esc(brl.format(promo))}</span> ` +
    `<s style="font-size:12px;color:#94A3B8;">${esc(brl.format(base))}</s>`;
}

function ordenar(produtos, ordemCategorias) {
  const cats = Array.isArray(ordemCategorias) ? ordemCategorias : [];
  const pos = (c) => { const i = cats.indexOf(c || 'Geral'); return i === -1 ? 9999 : i; };
  return [...produtos].sort((a, b) =>
    pos(a.categoria) - pos(b.categoria) ||
    String(a.categoria || 'Geral').localeCompare(String(b.categoria || 'Geral'), 'pt-BR') ||
    (a.ordem || 0) - (b.ordem || 0) ||
    String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
}

// Monta o HTML do cardápio (função pura, fácil de testar)
export function montarCardapio({ nome, cor, link, data, produtos, imagensOk, whatsapp, logoUrl, bannerUrl, qr, ordemCategorias }) {
  const destaque = corValida(cor) ? cor : '#C2410C';
  const textoDestaque = corDoTexto(destaque);
  const ok = imagensOk || new Set();
  const lista = ordenar(produtos, ordemCategorias);
  const fone = formatarFone(whatsapp);

  const grupos = new Map();
  lista.forEach((p) => {
    const categoria = p.categoria || 'Geral';
    if (!grupos.has(categoria)) grupos.set(categoria, []);
    grupos.get(categoria).push(p);
  });

  // Capa
  const banner = ok.has(bannerUrl)
    ? `background:${destaque} url('${esc(bannerUrl)}') center/cover no-repeat;`
    : `background:${destaque};`;
  const logo = ok.has(logoUrl)
    ? `<div style="width:88px;height:88px;margin:-44px auto 0;position:relative;z-index:1;border-radius:50%;border:4px solid #FFFFFF;background:#FFFFFF url('${esc(logoUrl)}') center/cover no-repeat;"></div>`
    : '<div style="height:16px;"></div>';
  const capa = `<div style="margin-bottom:14px;">
    <div style="height:${ok.has(bannerUrl) ? 170 : 70}px;border-radius:14px;${banner}"></div>
    ${ok.has(bannerUrl) ? logo : ''}
    <div style="text-align:center;padding-top:${ok.has(bannerUrl) ? 8 : 12}px;">
      <h1 style="margin:0;font-size:28px;color:#0F172A;">${esc(nome)}</h1>
      <p style="margin:5px 0 0;font-size:13px;color:#64748B;">Cardápio · atualizado em ${esc(data)}${fone ? ' · WhatsApp ' + esc(fone) : ''}</p>
    </div>
  </div>`;

  // Destaques
  const dest = lista.filter((p) => p.destaque).slice(0, 6);
  const blocoDestaques = dest.length ? `<div class="pdf-item" style="margin-bottom:18px;">
    <h3 style="margin:0 0 10px;padding:8px 12px;border-radius:8px;background:${destaque};color:${textoDestaque};font-size:17px;text-transform:uppercase;">Destaques</h3>
    <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;">
      ${dest.map((p) => `<div style="width:216px;">
        <div style="height:140px;border-radius:12px;background:#E2E8F0${ok.has(p.imagem_url) ? ` url('${esc(p.imagem_url)}') center/cover no-repeat` : ''};"></div>
        <div style="margin-top:6px;font-size:14px;line-height:1.25;color:#0F172A;"><strong>${esc(p.nome)}</strong></div>
        <div style="margin-top:3px;">${htmlPreco(p, 15)}</div>
      </div>`).join('')}
    </div>
  </div>` : '';

  // Categorias e produtos
  const blocos = [...grupos.entries()].map(([categoria, itensDaCategoria]) => {
    const itens = itensDaCategoria.map((p) => {
      const foto = ok.has(p.imagem_url)
        ? `<img src="${esc(p.imagem_url)}" crossorigin="anonymous" style="width:80px;height:80px;border-radius:10px;object-fit:cover;flex-shrink:0;" alt="">`
        : '';
      return `<div class="pdf-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px dashed #CBD5E1;">
        <div style="display:flex;align-items:flex-start;gap:12px;flex:1;min-width:0;">
          ${foto}
          <div style="min-width:0;">
            <strong style="display:block;font-size:16px;color:#0F172A;line-height:1.25;">${esc(p.nome)}</strong>
            ${p.descricao ? `<span style="display:block;margin-top:3px;font-size:13px;color:#475569;line-height:1.4;">${esc(p.descricao)}</span>` : ''}
          </div>
        </div>
        <div style="text-align:right;white-space:nowrap;">${htmlPreco(p, 17)}</div>
      </div>`;
    }).join('');

    return `<div style="margin-bottom:16px;">
      <h3 style="margin:16px 0 4px;padding:8px 12px;border-radius:8px;background:${destaque};color:${textoDestaque};font-size:17px;text-transform:uppercase;">${esc(categoria)}</h3>
      ${itens}
    </div>`;
  }).join('');

  // Rodapé com QR Code
  const rodape = `<div class="pdf-item" style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:18px;padding-top:12px;border-top:3px solid #E2E8F0;">
    ${qr ? `<img src="${qr}" style="width:84px;height:84px;" alt="QR Code">` : ''}
    <div style="font-size:13px;color:#475569;line-height:1.5;">
      <strong style="font-size:15px;color:#0F172A;">Faça seu pedido</strong><br>
      ${esc(link)}${fone ? `<br>WhatsApp ${esc(fone)}` : ''}
    </div>
  </div>`;

  return `<div style="width:480px;padding:8px;background:#FFFFFF;color:#1E293B;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;">
    ${capa}
    ${blocoDestaques}
    ${blocos}
    ${rodape}
  </div>`;
}

async function gerarPdf() {
  const botao = $('btn-pdf-cardapio');
  const produtos = (state.produtos || []).filter((p) => p.disponivel);

  if (!state.rest) return;
  if (produtos.length === 0) return aviso('Nenhum produto ativo para colocar no PDF.');

  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Gerando PDF...';

  try {
    // Dados da loja (logo, banner, WhatsApp, ordem das categorias), sempre os mais recentes
    let rest = state.rest;
    try {
      const { data } = await sb.from('restaurantes').select('*').eq('id', state.rest.id).maybeSingle();
      if (data) rest = { ...state.rest, ...data };
    } catch (e) { /* segue com os dados já carregados */ }

    const logoUrl = urlImagemValida(rest.logo_url) ? rest.logo_url : null;
    const bannerUrl = urlImagemValida(rest.banner_url) ? rest.banner_url : null;

    const urls = [...new Set([...produtos.map((p) => p.imagem_url), logoUrl, bannerUrl].filter(urlImagemValida))];
    const resultados = await Promise.all(urls.map(async (u) => [u, await imagemCarrega(u)]));
    const imagensOk = new Set(resultados.filter(([, ok]) => ok).map(([u]) => u));

    const base = new URL('.', location.href).href;
    const link = `${base}?r=${encodeURIComponent(rest.slug)}`;
    const qr = '';

    const html = montarCardapio({
      nome: rest.nome,
      cor: rest.cor_primaria,
      link,
      data: new Date().toLocaleDateString('pt-BR'),
      produtos,
      imagensOk,
      whatsapp: rest.whatsapp,
      logoUrl,
      bannerUrl,
      qr,
      ordemCategorias: rest.ordem_categorias
    });

    const pagina = document.createElement('div');
    pagina.innerHTML = html;

    await carregarScript(HTML2PDF_URL, () => window.html2pdf);
    await window.html2pdf().set({
      margin: [4, 4, 4, 4],
      filename: `Cardapio_${rest.slug}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: [100, 177.8], orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['.pdf-item', 'h3'] }
    }).from(pagina.firstElementChild).save();

    aviso('PDF do cardápio baixado!');
  } catch (erro) {
    console.error('Erro ao gerar PDF do cardápio:', erro);
    aviso('Não foi possível gerar o PDF. Confira a internet e tente de novo.');
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

export function inicializarCardapioPdf() {
  const botao = $('btn-pdf-cardapio');
  if (botao) botao.addEventListener('click', gerarPdf);
}
