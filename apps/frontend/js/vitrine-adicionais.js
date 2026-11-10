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

/* ===== Sacola em tela separada ===== */
(function () {
  const barra = $('barra-carrinho');
  const botao = $('btn-enviar');
  const corpo = document.body;

  const s = document.createElement('style');
  s.textContent = `
    body:not(.sacola) #conteudo > .bloco, body:not(.sacola) #sac-topo { display: none; }
    body.sacola #topo, body.sacola #barra-busca, body.sacola #lista-produtos { display: none; }
    #sac-topo { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 8px; background: var(--fundo); padding: 10px 0; border-bottom: 1px solid var(--borda); }
    #sac-topo h2 { font: 700 20px Fraunces, Georgia, serif; }
    #sac-voltar { width: 44px; height: 44px; border: 0; border-radius: 50%; background: #fff; border: 1px solid var(--borda); font-size: 20px; }
  `;
  document.head.appendChild(s);

  const topo = document.createElement('div');
  topo.id = 'sac-topo';
  topo.innerHTML = '<button type="button" id="sac-voltar" aria-label="Voltar ao cardápio">←</button><h2>Minha sacola</h2>';
  $('conteudo').prepend(topo);

  function rotulo() {
    const sac = corpo.classList.contains('sacola');
    const txt = $('qtd-itens').previousSibling;
    if (txt) txt.textContent = sac ? 'Total com entrega (' : 'Seu pedido (';
    if (!botao.disabled) botao.textContent = sac ? 'Enviar Pedido' : 'Ver sacola';
  }

  function mostrar() {
    const naLoja = !$('conteudo').classList.contains('hidden');
    if (carrinho.length === 0) corpo.classList.remove('sacola');
    barra.classList.toggle('hidden', !naLoja || carrinho.length === 0);
    rotulo();
  }

  function abrirSacola() {
    corpo.classList.add('sacola');
    history.pushState({ sac: 1 }, '');
    window.scrollTo({ top: 0 });
    mostrar();
  }

  const renderOriginal = renderCarrinho;
  renderCarrinho = function () { renderOriginal(); mostrar(); };

  const telasOriginal = alternarTelas;
  alternarTelas = function (t) { corpo.classList.remove('sacola'); telasOriginal(t); mostrar(); };

  botao.addEventListener('click', (e) => {
    if (!corpo.classList.contains('sacola')) {
      e.stopImmediatePropagation();
      abrirSacola();
    }
  }, true);

  $('sac-voltar').addEventListener('click', () => history.back());
  window.addEventListener('popstate', () => {
    corpo.classList.remove('sacola');
    window.scrollTo({ top: 0 });
    mostrar();
  });

  mostrar();
})();


/* ===== Sacola estilo app (itens, observação, sugestões, resumo, pagamento) ===== */
(function () {
  const corpo = document.body;
  const botao = $('btn-enviar');

  const s = document.createElement('style');
  s.textContent = `
    #sac-topo h2{flex:1;text-align:center;font-size:17px}
    #sac-limpar{min-width:60px;height:44px;border:0;background:none;color:var(--cor);font-weight:800;font-size:14px}
    .it{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--borda)}
    .it:last-child{border-bottom:0}
    .it img{width:52px;height:52px;border-radius:10px;object-fit:cover;flex:none;background:var(--borda)}
    .it-info{flex:1;min-width:0}
    .it-info strong{display:block;font-size:14.5px}
    .it-info small{display:block;font-size:12px;color:var(--suave)}
    .it-pr{font-weight:800;font-size:14px;margin-top:2px}
    .it .qtd button{width:36px;height:36px}
    .obs-topo{display:flex;justify-content:space-between;align-items:center}
    #obs-btn{border:0;background:none;color:var(--cor);font-weight:800;min-height:44px;padding:0 4px}
    #obs-geral{margin-top:8px}
    .sug-lista{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;padding-bottom:4px}
    .sug-lista::-webkit-scrollbar{display:none}
    .sug-c{flex:none;width:120px;position:relative}
    .sug-c img,.sug-c .sem{width:120px;height:90px;border-radius:12px;object-fit:cover;background:var(--borda);display:block}
    .sug-c b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;margin-top:6px;line-height:1.2}
    .sug-c span{font-size:13px;font-weight:800}
    .sug-c button{position:absolute;top:48px;right:6px;width:36px;height:36px;border-radius:50%;border:0;background:var(--cor);color:var(--cor-texto);font-size:20px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.25)}
    .res-l{display:flex;justify-content:space-between;padding:5px 0;font-size:14px;color:var(--suave)}
    .res-l.tot{color:var(--texto);font-weight:800;font-size:17px;border-top:1px solid var(--borda);margin-top:6px;padding-top:10px}
    #pg-trocar{border:0;background:none;color:var(--cor);font-weight:800;min-height:44px;padding:0 4px}
    body.sacola #barra-carrinho .wrap > div:first-child{display:none}
    body.sacola #btn-enviar{width:100%}
  `;
  document.head.appendChild(s);

  /* 1. Cabeçalho da sacola: ← Título Limpar */
  const limpar = document.createElement('button');
  limpar.type = 'button'; limpar.id = 'sac-limpar'; limpar.textContent = 'Limpar';
  $('sac-topo').appendChild(limpar);
  limpar.addEventListener('click', () => {
    if (confirm('Esvaziar a sacola?')) { carrinho = []; renderCarrinho(); }
  });
  $('secao-carrinho').querySelector('h2').textContent = 'Itens do pedido';

  /* 3. Observação */
  const obs = document.createElement('section');
  obs.className = 'bloco'; obs.id = 'obs-bloco';
  obs.innerHTML = '<div class="obs-topo"><strong>Alguma observação?</strong><button type="button" id="obs-btn">Adicionar</button></div>' +
    '<textarea id="obs-geral" class="entrada hidden" rows="2" maxlength="200" placeholder="Ex.: sem cebola, não buzinar"></textarea>';

  /* 7. Combine com seu pedido */
  const sug = document.createElement('section');
  sug.className = 'bloco sug hidden'; sug.id = 'sug';
  sug.innerHTML = '<h2>Combine com seu pedido</h2><div class="sug-lista" id="sug-lista"></div>';

  $('secao-carrinho').after(sug);
  $('secao-carrinho').after(obs);

  $('obs-btn').addEventListener('click', () => {
    const t = $('obs-geral');
    const abrir = t.classList.contains('hidden');
    t.classList.toggle('hidden', !abrir);
    $('obs-btn').textContent = abrir ? 'Ocultar' : 'Adicionar';
    if (abrir) t.focus();
  });

  function limparObs() {
    $('obs-geral').value = '';
    $('obs-geral').classList.add('hidden');
    $('obs-btn').textContent = 'Adicionar';
  }

  /* 4. Resumo de valores */
  const res = document.createElement('section');
  res.className = 'bloco'; res.id = 'resumo';
  res.innerHTML = '<h2>Resumo de valores</h2>' +
    '<div class="res-l"><span>Subtotal</span><span id="res-sub"></span></div>' +
    '<div class="res-l"><span>Taxa de entrega</span><span id="res-taxa"></span></div>' +
    '<div class="res-l tot"><span>Total</span><span id="res-total"></span></div>';
  $('conteudo').appendChild(res);

  const totalGeral = () => calcularSubtotal() + (carrinho.length ? taxaAtual : 0);

  function atualizarResumo() {
    $('res-sub').textContent = brl.format(calcularSubtotal());
    $('res-taxa').textContent = !$('select-bairro').value ? 'Escolha o bairro' : (taxaAtual > 0 ? brl.format(taxaAtual) : 'Grátis');
    $('res-total').textContent = brl.format(totalGeral());
  }

  /* 5. Pagamento com "Trocar" */
  const pg = document.createElement('div');
  pg.id = 'pg-resumo'; pg.className = 'opcao hidden';
  pg.innerHTML = '<span style="flex:1"><strong id="pg-nome"></strong><small id="pg-sub"></small></span><button type="button" id="pg-trocar">Trocar</button>';
  $('opcoes-pagto').before(pg);
  let pgAberto = true;

  function syncPagto() {
    const f = formaSelecionada();
    if (!f) pgAberto = true;
    const resumir = !!f && !pgAberto;
    pg.classList.toggle('hidden', !resumir);
    $('opcoes-pagto').classList.toggle('hidden', resumir);
    if (resumir) {
      const lab = document.querySelector('input[name="pagto"]:checked').closest('label');
      $('pg-nome').textContent = lab.querySelector('strong').textContent;
      $('pg-sub').textContent = lab.querySelector('small').textContent;
    }
  }
  $('opcoes-pagto').addEventListener('change', () => { pgAberto = false; syncPagto(); });
  $('pg-trocar').addEventListener('click', () => { pgAberto = true; syncPagto(); });

  /* 2. Itens com foto */
  function desenharItens() {
    $('lista-carrinho').innerHTML = carrinho.map((i) => {
      const p = produtos.find((x) => String(x.id) === String(i.id));
      const foto = p && urlImagemValida(p.imagem_url) ? `<img src="${esc(p.imagem_url)}" alt="" loading="lazy">` : '';
      return `<div class="it">${foto}
        <div class="it-info">
          <strong>${esc(i.nome)}</strong>
          ${i.adicionais && i.adicionais.length ? `<small>+ ${i.adicionais.map((a) => esc(a.nome)).join(', ')}</small>` : ''}
          <div class="it-pr">${brl.format(i.preco * i.qtd)}</div>
        </div>
        <div class="qtd">
          <button type="button" data-menos="${esc(i.chave || i.id)}" aria-label="Diminuir ${esc(i.nome)}">−</button>
          <span>${i.qtd}</span>
          <button type="button" data-mais="${esc(i.chave || i.id)}" aria-label="Aumentar ${esc(i.nome)}">+</button>
        </div></div>`;
    }).join('');
  }

  function desenharSugestoes() {
    const noCarrinho = new Set(carrinho.map((i) => String(i.id)));
    const cats = new Set(carrinho.map((i) => {
      const p = produtos.find((x) => String(x.id) === String(i.id));
      return p ? (p.categoria || 'Geral') : '';
    }));
    const pref = /bebida|suco|refri|sobremesa|doce|acompanh|por[çc]/i;
    const lista = produtos
      .filter((p) => !noCarrinho.has(String(p.id)) && !cats.has(p.categoria || 'Geral'))
      .sort((a, b) => pref.test(b.categoria || '') - pref.test(a.categoria || ''))
      .slice(0, 8);
    $('sug').classList.toggle('hidden', lista.length === 0);
    $('sug-lista').innerHTML = lista.map((p) => `
      <div class="sug-c">
        ${urlImagemValida(p.imagem_url) ? `<img src="${esc(p.imagem_url)}" alt="" loading="lazy">` : '<div class="sem"></div>'}
        <b>${esc(p.nome)}</b><span>${brl.format(parseFloat(p.preco) || 0)}</span>
        <button type="button" data-sug="${esc(p.id)}" aria-label="Adicionar ${esc(p.nome)}">+</button>
      </div>`).join('');
  }
  $('sug').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sug]');
    if (b) adicionarCarrinho(b.dataset.sug);
  });

  /* 6. Botão fixo: Enviar pedido · R$ */
  function ajustarBotao() {
    if (botao.disabled) return;
    const d = corpo.classList.contains('sacola') ? 'Enviar pedido · ' + brl.format(totalGeral()) : 'Ver sacola';
    if (botao.textContent !== d) botao.textContent = d;
  }
  new MutationObserver(ajustarBotao).observe(botao, { childList: true, characterData: true, subtree: true });

  /* Ligações */
  const r0 = renderCarrinho;
  renderCarrinho = function () { r0(); desenharItens(); desenharSugestoes(); syncPagto(); ajustarBotao(); };

  const t0 = atualizarTotal;
  atualizarTotal = function () { t0(); atualizarResumo(); ajustarBotao(); };

  const l0 = limparPagamento;
  limparPagamento = function () { l0(); syncPagto(); };

  const a0 = alternarTelas;
  alternarTelas = function (t) { if (t === 'sucesso') limparObs(); a0(t); ajustarBotao(); };

  syncPagto();
  atualizarResumo();
})();


/* ===== Entrega / Retirada ===== */
let modoEntrega = 'entrega';
(function () {
  const s = document.createElement('style');
  s.textContent = `
    #abas-ent{display:flex;gap:8px;margin-bottom:14px}
    #abas-ent button{flex:1;height:44px;border-radius:999px;border:1px solid #E4DCCB;background:#fff;font-weight:800;font-size:15px}
    #abas-ent button[aria-pressed="true"]{background:var(--cor);border-color:var(--cor);color:var(--cor-texto)}
    #ret-info{font-size:14px;color:var(--suave);background:var(--fundo);border-radius:12px;padding:12px}
    body:not(.retirada) #ret-info{display:none}
    body.retirada label[for="select-bairro"], body.retirada #select-bairro, body.retirada #select-bairro ~ .meta,
    body.retirada label[for="cli-endereco"], body.retirada #cli-endereco{display:none}
  `;
  document.head.appendChild(s);

  const sec = $('select-bairro').closest('.bloco');
  const titulo = sec.querySelector('h2');
  titulo.textContent = 'Como receber?';

  const abas = document.createElement('div');
  abas.id = 'abas-ent';
  abas.innerHTML = '<button type="button" data-modo="entrega" aria-pressed="true">Entrega</button>' +
                   '<button type="button" data-modo="retirada" aria-pressed="false">Retirada</button>';
  const info = document.createElement('p');
  info.id = 'ret-info';
  info.textContent = 'Você retira o pedido no balcão da loja. Sem taxa de entrega.';
  titulo.after(abas);
  abas.after(info);

  const taxa0 = atualizarTaxa;
  atualizarTaxa = function () {
    taxa0();
    if (modoEntrega === 'retirada') {
      taxaAtual = 0;
      $('val-taxa').innerText = brl.format(0);
      atualizarTotal();
    }
  };

  const total0 = atualizarTotal;
  atualizarTotal = function () {
    total0();
    const r = document.getElementById('res-taxa');
    if (modoEntrega === 'retirada' && r) r.textContent = 'Grátis';
  };

  abas.addEventListener('click', (e) => {
    const b = e.target.closest('[data-modo]');
    if (!b) return;
    modoEntrega = b.dataset.modo;
    document.body.classList.toggle('retirada', modoEntrega === 'retirada');
    abas.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    atualizarTaxa();
  });
})();
