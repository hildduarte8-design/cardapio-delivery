// Botão "Baixar cardápio em PDF" (aba Produtos).
// Usa só produtos ativos já carregados no painel. A biblioteca de PDF só é baixada quando o botão é tocado.
import { state } from './admin-state.js';
import { $, brl, esc, aviso } from './admin-utils.js';

const HTML2PDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
let carregandoBiblioteca = null;

function carregarBiblioteca() {
  if (window.html2pdf) return Promise.resolve();
  if (!carregandoBiblioteca) {
    carregandoBiblioteca = new Promise((ok, falha) => {
      const script = document.createElement('script');
      script.src = HTML2PDF_URL;
      script.onload = ok;
      script.onerror = () => { carregandoBiblioteca = null; falha(new Error('Falha ao carregar a biblioteca de PDF')); };
      document.head.appendChild(script);
    });
  }
  return carregandoBiblioteca;
}

const corValida = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
const urlImagemValida = (u) => typeof u === 'string' && u.length <= 500 && /^https:\/\/[^\s"'()<>\\]+$/.test(u);

// Só entram no PDF as fotos que realmente carregam (foto quebrada não trava a geração)
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

// Monta o HTML do cardápio (função pura, fácil de testar)
export function montarCardapio({ nome, cor, link, data, produtos, imagensOk }) {
  const destaque = corValida(cor) ? cor : '#C2410C';
  const grupos = new Map();
  produtos.forEach((p) => {
    const categoria = p.categoria || 'Geral';
    if (!grupos.has(categoria)) grupos.set(categoria, []);
    grupos.get(categoria).push(p);
  });

  const blocos = [...grupos.entries()].map(([categoria, lista]) => {
    const itens = lista.map((p) => {
      const foto = imagensOk.has(p.imagem_url)
        ? `<img src="${esc(p.imagem_url)}" crossorigin="anonymous" style="width:72px;height:72px;border-radius:8px;object-fit:cover;flex-shrink:0;" alt="">`
        : '';
      return `<div class="pdf-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px dashed #CBD5E1;">
        <div style="display:flex;align-items:flex-start;gap:12px;flex:1;min-width:0;">
          ${foto}
          <div style="min-width:0;">
            <strong style="display:block;font-size:16px;color:#0F172A;line-height:1.25;">${esc(p.nome)}</strong>
            ${p.descricao ? `<span style="display:block;margin-top:3px;font-size:13px;color:#475569;line-height:1.4;">${esc(p.descricao)}</span>` : ''}
          </div>
        </div>
        <div style="font-size:17px;font-weight:800;color:#0F172A;white-space:nowrap;">${esc(brl.format(Number(p.preco) || 0))}</div>
      </div>`;
    }).join('');

    return `<div style="margin-bottom:18px;">
      <h3 style="margin:16px 0 8px;padding-bottom:5px;border-bottom:3px solid ${destaque};font-size:19px;color:${destaque};text-transform:uppercase;">${esc(categoria)}</h3>
      ${itens}
    </div>`;
  }).join('');

  return `<div style="width:720px;padding:8px;background:#FFFFFF;color:#1E293B;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;">
    <div style="text-align:center;margin-bottom:14px;padding-bottom:10px;border-bottom:3px solid #E2E8F0;">
      <h1 style="margin:0;font-size:26px;color:#0F172A;">${esc(nome)}</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#64748B;">Cardápio · atualizado em ${esc(data)}</p>
    </div>
    ${blocos}
    <p style="margin:18px 0 0;text-align:center;font-size:13px;color:#475569;">Faça seu pedido: <strong>${esc(link)}</strong></p>
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
    const urls = [...new Set(produtos.map((p) => p.imagem_url).filter(urlImagemValida))];
    const resultados = await Promise.all(urls.map(async (u) => [u, await imagemCarrega(u)]));
    const imagensOk = new Set(resultados.filter(([, ok]) => ok).map(([u]) => u));

    const base = new URL('.', location.href).href;
    const html = montarCardapio({
      nome: state.rest.nome,
      cor: state.rest.cor_primaria,
      link: `${base}?r=${encodeURIComponent(state.rest.slug)}`,
      data: new Date().toLocaleDateString('pt-BR'),
      produtos,
      imagensOk
    });

    const pagina = document.createElement('div');
    pagina.innerHTML = html;

    await carregarBiblioteca();
    await window.html2pdf().set({
      margin: [8, 8, 8, 8],
      filename: `Cardapio_${state.rest.slug}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
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
