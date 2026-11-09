/* ===== Vitrine: detalhes do produto + adicionais =====
   Carregado DEPOIS do script principal do index.html.
   Assume o controle do carrinho (linhas com adicionais). */

const VT_ADICIONAIS_ATIVOS = false;  // mude para true quando o backend estiver pronto
const VT_BACKEND_PRONTO = false;     // mude para true junto, depois do backend

// Para testar sem afetar clientes: abra o cardápio com &adicionais=teste no final do link
const VT_ATIVOS = VT_ADICIONAIS_ATIVOS ||
  new URLSearchParams(window.location.search).get('adicionais') === 'teste';

let vtAdicionais = {};       // produto_id -> lista de adicionais
let vtProdutoAberto = null;
let vtMarcados = new Set();
let vtQtd = 1;

const vtAdicionaisDe = (id) => vtAdicionais[id] || [];

/* ---------- Estilo ---------- */
(function vtEstilo() {
  const s = document.createElement('style');
  s.textContent = `
    .card { cursor: pointer; }
    .dt-fundo { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; padding: 16px; }
    .dt-folha { position: relative; display: flex; flex-direction: column; width: 100%; max-width: 440px; max-height: 90vh; background: var(--fundo); color: var(--texto); border-radius: 20px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,.35); }
    .dt-rolagem { overflow-y: auto; flex: 1; }
    .dt-foto { display: block; width: 100%; height: auto; max-height: 48vh; object-fit: contain; background: var(--borda); }
    .dt-corpo { padding: 16px; }
    .dt-corpo h2 { font: 700 21px/1.2 Fraunces, Georgia, serif; }
    .dt-corpo .dt-desc { font-size: 14px; color: var(--suave); margin-top: 6px; white-space: pre-line; }
    .dt-corpo .dt-preco { font-size: 18px; font-weight: 800; margin-top: 10px; }
    .dt-fechar { position: absolute; top: 10px; right: 10px; z-index: 2; width: 44px; height: 44px; border: 0; border-radius: 50%; background: rgba(22,23,26,.75); color: #fff; font-size: 20px; }
    .dt-titulo-ad { font: 700 16px Fraunces, Georgia, serif; margin: 18px 0 8px; }
    .dt-ad { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 12px; margin-bottom: 8px; background: #fff; border: 1px solid #E4DCCB; border-radius: 12px; cursor: pointer; }
    .dt-ad input { width: 22px; height: 22px; flex: none; accent-color: var(--cor); }
    .dt-ad img { width: 40px; height: 40px; flex: none; border-radius: 8px; object-fit: cover; }
    .dt-ad-nome { flex: 1; font-size: 14.5px; font-weight: 600; color: var(--texto); }
    .dt-ad-preco { font-size: 13px; font-weight: 700; color: var(--suave); white-space: nowrap; }
    .dt-ad:has(input:checked) { border-color: var(--cor); box-shadow: 0 0 0 1px var(--cor); }
    .dt-rodape { display: flex; align-items: center; gap: 12px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--borda); background: var(--fundo); }
    .dt-add { flex: 1; height: 52px; border: 0; border-radius: 14px; background: var(--cor); color: var(--cor-texto); font-size: 16px; font-weight: 800; }
  `;
  document.head.appendChild(s);
})();

/* ---------- Carregar adicionais (só se ativo) ---------- */
async function vtCarregarAdicionais() {
  vtAdicionais = {};
  if (!VT_ATIVOS || !restauranteInfo) return;
  try {
    const [ad, vi] = await Promise.all([
      supabaseClient.from('adicionais').select('id, nome, preco, imagem_url')
        .eq('restaurante_id', restauranteInfo.id).eq('ativo', true).order('nome'),
      supabaseClient.from('produto_adicionais').select('produto_id, adicional_id')
        .eq('restaurante_id', restauranteInfo.id)
    ]);
    if (ad.error || vi.error || !ad.data || !vi.data) return;
    const porId = new Map(ad.data.map((a) => [String(a.id), a]));
    for (const v of vi.data) {
      const a = porId.get(String(v.adicional_id));
      if (!a) continue;
      if (!vtAdicionais[v.produto_id]) vtAdicionais[v.produto_id] = [];
      vtAdicionais[v.produto_id].push(a);
    }
  } catch (e) { /* sem adicionais: a vitrine segue normal */ }
}

// Envolve o carregamento de produtos para trazer os adicionais junto
const vtCarregarProdutosOriginal = carregarProdutos;
carregarProdutos = async function () {
  const ok = await vtCarregarProdutosOriginal();
  if (ok) {
    await vtCarregarAdicionais();
    if (carrinho.length) sincronizarCarrinho();
  }
  return ok;
};

/* ---------- Carrinho com linhas (produto + adicionais) ---------- */
function vtAdicionarLinha(p, extras, qtd) {
  const ids = extras.map((a) => String(a.id)).sort();
  const chave = String(p.id) + (ids.length ? '|' + ids.join(',') : '');
  const base = parseFloat(p.preco) || 0;
  const soma = extras.reduce((s, a) => s + (Number(a.preco) || 0), 0);
  const preco = Math.round((base + soma) * 100) / 100;
  const existente = carrinho.find((i) => i.chave === chave);

  if (existente) {
    if (existente.qtd + qtd > 50) { avisar('O limite é de 50 unidades por produto.'); return false; }
    existente.qtd += qtd;
  } else {
    carrinho.push({
      id: p.id, chave, nome: p.nome, preco, precoBase: base, qtd,
      adicionais: extras.map((a) => ({ id: a.id, nome: a.nome, preco: Number(a.preco) || 0 }))
    });
  }
  renderCarrinho();
  return true;
}

function adicionarCarrinho(id) {
  const p = produtos.find((x) => String(x.id) === String(id));
  if (!p) return;
  if (vtAdicionaisDe(p.id).length) vtAbrir(p);   // tem adicionais: abre o modal
  else vtAdicionarLinha(p, [], 1);               // sem adicionais: adiciona direto
}

function alterarQtd(chave, delta) {
  const item = carrinho.find((i) => i.chave === String(chave));
  if (!item) return;
  if (delta > 0 && item.qtd >= 50) return avisar('O limite é de 50 unidades por produto.');
  item.qtd += delta;
  if (item.qtd <= 0) carrinho = carrinho.filter((i) => i !== item);
  renderCarrinho();
}

function renderCarrinho() {
  $('secao-carrinho').classList.toggle('hidden', carrinho.length === 0);
  $('lista-carrinho').innerHTML = carrinho.map((i) => `
    <div class="linha-item">
      <div>
        <strong>${esc(i.nome)}</strong>
        ${i.adicionais && i.adicionais.length ? `<small>+ ${i.adicionais.map((a) => esc(a.nome)).join(', ')}</small>` : ''}
        <small>${brl.format(i.preco)} cada</small>
      </div>
      <div class="qtd">
        <button type="button" data-menos="${esc(i.chave)}" aria-label="Diminuir ${esc(i.nome)}">−</button>
        <span>${i.qtd}</span>
        <button type="button" data-mais="${esc(i.chave)}" aria-label="Aumentar ${esc(i.nome)}">+</button>
      </div>
    </div>`).join('');
  atualizarBadges();
  atualizarTotal();
}

function atualizarBadges() {
  document.querySelectorAll('[data-badge]').forEach((el) => {
    const total = carrinho
      .filter((i) => String(i.id) === String(el.dataset.badge))
      .reduce((s, i) => s + i.qtd, 0);
    el.textContent = total || '';
    el.classList.toggle('hidden', !total);
  });
}

function sincronizarCarrinho() {
  const removidos = [];
  let precoMudou = false;
  carrinho = carrinho.filter((i) => {
    const p = produtos.find((x) => String(x.id) === String(i.id));
    if (!p) { removidos.push(i.nome); return false; }
    const base = parseFloat(p.preco) || 0;
    const disponiveis = new Map(vtAdicionaisDe(p.id).map((a) => [String(a.id), a]));
    i.adicionais = (i.adicionais || [])
      .filter((a) => disponiveis.has(String(a.id)))
      .map((a) => {
        const atual = disponiveis.get(String(a.id));
        return { id: atual.id, nome: atual.nome, preco: Number(atual.preco) || 0 };
      });
    const novo = Math.round((base + i.adicionais.reduce((s, a) => s + a.preco, 0)) * 100) / 100;
    if (novo !== i.preco) precoMudou = true;
    i.preco = novo;
    i.precoBase = base;
    return true;
  });
  renderCarrinho();
  return { removidos, precoMudou };
}

/* ---------- Modal de detalhes ---------- */
function vtFechar() {
  document.getElementById('vt-modal')?.remove();
  document.body.style.overflow = '';
  vtProdutoAberto = null;
}

function vtTotalModal() {
  const p = vtProdutoAberto;
  const soma = vtAdicionaisDe(p.id)
    .filter((a) => vtMarcados.has(String(a.id)))
    .reduce((s, a) => s + (Number(a.preco) || 0), 0);
  return ((parseFloat(p.preco) || 0) + soma) * vtQtd;
}

function vtAtualizarModal() {
  const qtd = document.getElementById('vt-qtd');
  const add = document.getElementById('vt-add');
  if (qtd) qtd.textContent = vtQtd;
  if (add) add.textContent = 'Adicionar · ' + brl.format(vtTotalModal());
}

function vtAbrir(p) {
  vtFechar();
  vtProdutoAberto = p;
  vtMarcados = new Set();
  vtQtd = 1;

  const extras = vtAdicionaisDe(p.id);
  const foto = urlImagemValida(p.imagem_url)
    ? `<img class="dt-foto" src="${esc(p.imagem_url)}" alt="" decoding="async">` : '';

  const extrasHtml = extras.length ? `
    <h3 class="dt-titulo-ad">Quer adicionar?</h3>
    ${extras.map((a) => `
      <label class="dt-ad">
        <input type="checkbox" data-vt-ad="${esc(a.id)}" />
        ${urlImagemValida(a.imagem_url) ? `<img src="${esc(a.imagem_url)}" alt="" loading="lazy" />` : ''}
        <span class="dt-ad-nome">${esc(a.nome)}</span>
        <span class="dt-ad-preco">${Number(a.preco) > 0 ? '+ ' + brl.format(Number(a.preco)) : 'Grátis'}</span>
      </label>`).join('')}` : '';

  const fundo = document.createElement('div');
  fundo.id = 'vt-modal';
  fundo.className = 'dt-fundo';
  fundo.innerHTML = `
    <div class="dt-folha" role="dialog" aria-modal="true" aria-label="${esc(p.nome)}">
      <button type="button" class="dt-fechar" data-vt-fechar aria-label="Fechar">✕</button>
      <div class="dt-rolagem">
        ${foto}
        <div class="dt-corpo">
          <h2>${esc(p.nome)}</h2>
          ${p.descricao ? `<p class="dt-desc">${esc(p.descricao)}</p>` : ''}
          <p class="dt-preco">${brl.format(parseFloat(p.preco) || 0)}</p>
          ${extrasHtml}
        </div>
      </div>
      <div class="dt-rodape">
        <div class="qtd">
          <button type="button" data-vt-menos aria-label="Diminuir">−</button>
          <span id="vt-qtd">1</span>
          <button type="button" data-vt-mais aria-label="Aumentar">+</button>
        </div>
        <button type="button" class="dt-add" id="vt-add" data-vt-confirmar></button>
      </div>
    </div>`;

  fundo.addEventListener('click', (e) => {
    if (e.target === fundo || e.target.closest('[data-vt-fechar]')) return vtFechar();
    if (e.target.closest('[data-vt-menos]')) { if (vtQtd > 1) vtQtd--; return vtAtualizarModal(); }
    if (e.target.closest('[data-vt-mais]')) { if (vtQtd < 50) vtQtd++; return vtAtualizarModal(); }
    if (e.target.closest('[data-vt-confirmar]')) {
      const escolhidos = extras.filter((a) => vtMarcados.has(String(a.id)));
      if (vtAdicionarLinha(p, escolhidos, vtQtd)) vtFechar();
    }
  });
  fundo.addEventListener('change', (e) => {
    const marca = e.target.closest('[data-vt-ad]');
    if (!marca) return;
    if (marca.checked) vtMarcados.add(marca.dataset.vtAd);
    else vtMarcados.delete(marca.dataset.vtAd);
    vtAtualizarModal();
  });

  document.body.appendChild(fundo);
  document.body.style.overflow = 'hidden';
  vtAtualizarModal();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') vtFechar(); });

// Toque no cartão do produto (fora do botão +) abre os detalhes
$('lista-produtos').addEventListener('click', (e) => {
  if (e.target.closest('[data-add]')) return;
  const card = e.target.closest('.card');
  const botao = card && card.querySelector('[data-add]');
  if (!botao) return;
  const p = produtos.find((x) => String(x.id) === String(botao.dataset.add));
  if (p) vtAbrir(p);
});

// Trava de segurança: enquanto o backend não aceitar adicionais, não deixa enviar pedido com eles
$('btn-enviar').addEventListener('click', (e) => {
  if (VT_ATIVOS && !VT_BACKEND_PRONTO && carrinho.some((i) => i.adicionais && i.adicionais.length)) {
    e.stopImmediatePropagation();
    avisar('Modo teste: o envio de pedidos com adicionais ainda não está liberado.', 'info');
  }
}, true);
