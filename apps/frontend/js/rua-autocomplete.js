/* ===== Autocomplete do campo Rua (rua + bairro) =====
   Carregar DEPOIS do frete-gps.js.
   Usa POST /api/ruas/buscar. A busca é só uma ajuda de preenchimento:
   - se a busca falhar (rede, 429, 500), o formulário funciona como sempre;
   - o pedido continua mandando só bairro_id e o backend valida o bairro e calcula o frete;
   - o bairro só é selecionado quando a sugestão traz bairro_id E o select está vazio;
   - NUNCA troca um bairro que o cliente já escolheu (só mostra um aviso). */
(function () {
  const $ = (id) => document.getElementById(id);
  const rua = $('cli-rua');
  const selBairro = $('select-bairro');
  if (!rua || !selBairro) return;

  const ESPERA_MS = 300;
  const MIN_LETRAS = 3;
  const MAX_CACHE = 30;

  let sugestoes = [];
  let ativo = -1;
  let aberta = false;
  let seq = 0;
  let timer = null;
  let controle = null;
  let silencio = false; // true quando nós mesmos disparamos o evento input
  const cache = new Map();

  /* ---------- estilo ---------- */
  const css = document.createElement('style');
  css.textContent = `
    .rua-ac{position:relative}
    #rua-lista{position:absolute;left:0;right:0;top:100%;z-index:30;margin:4px 0 0;padding:4px;list-style:none;
      background:#fff;border:1px solid #E4DCCB;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.12);
      max-height:260px;overflow-y:auto}
    #rua-lista[hidden]{display:none}
    #rua-lista li{padding:10px;border-radius:8px;cursor:pointer;line-height:1.25}
    #rua-lista li[aria-selected="true"],#rua-lista li:hover{background:#FEF3C7}
    #rua-lista .rua-nome{display:block;font-weight:700;font-size:15px}
    #rua-lista .rua-bairro{display:block;font-size:13px;opacity:.75}
    #rua-aviso{font-size:13px;color:#78350F;margin:6px 2px 0}
    #rua-aviso:empty{display:none}
  `;
  document.head.appendChild(css);

  /* ---------- elementos ---------- */
  const caixa = document.createElement('div');
  caixa.className = 'rua-ac';
  rua.parentNode.insertBefore(caixa, rua);
  caixa.appendChild(rua);

  const lista = document.createElement('ul');
  lista.id = 'rua-lista';
  lista.setAttribute('role', 'listbox');
  lista.hidden = true;
  caixa.appendChild(lista);

  const aviso = document.createElement('div');
  aviso.id = 'rua-aviso';
  aviso.setAttribute('role', 'status');
  aviso.setAttribute('aria-live', 'polite');
  caixa.insertAdjacentElement('afterend', aviso);

  // O autopreenchimento do navegador cobriria a nossa lista.
  rua.setAttribute('autocomplete', 'off');
  rua.setAttribute('role', 'combobox');
  rua.setAttribute('aria-autocomplete', 'list');
  rua.setAttribute('aria-controls', 'rua-lista');
  rua.setAttribute('aria-expanded', 'false');

  /* ---------- utilidades ---------- */
  function idRestaurante() {
    return (typeof restauranteInfo !== 'undefined' && restauranteInfo && restauranteInfo.id) || null;
  }

  function letrasDoTexto(t) {
    return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '');
  }

  function mostrarAviso(texto) { aviso.textContent = texto || ''; }

  function fechar() {
    aberta = false;
    ativo = -1;
    lista.hidden = true;
    rua.setAttribute('aria-expanded', 'false');
    rua.removeAttribute('aria-activedescendant');
  }

  function marcarAtivo(i) {
    const itens = lista.children;
    if (!itens.length) return;
    ativo = (i + itens.length) % itens.length;
    for (let k = 0; k < itens.length; k += 1) {
      itens[k].setAttribute('aria-selected', k === ativo ? 'true' : 'false');
    }
    rua.setAttribute('aria-activedescendant', itens[ativo].id);
    if (itens[ativo].scrollIntoView) itens[ativo].scrollIntoView({ block: 'nearest' });
  }

  function desenhar() {
    lista.textContent = '';
    if (!sugestoes.length) { fechar(); return; }

    sugestoes.forEach((s, i) => {
      const li = document.createElement('li');
      li.id = 'rua-op-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');

      const nome = document.createElement('span');
      nome.className = 'rua-nome';
      nome.textContent = s.rua;
      const bairro = document.createElement('span');
      bairro.className = 'rua-bairro';
      bairro.textContent = s.bairro_exibicao;

      li.appendChild(nome);
      li.appendChild(bairro);
      li.addEventListener('click', () => escolher(i));
      lista.appendChild(li);
    });

    aberta = true;
    ativo = -1;
    lista.hidden = false;
    rua.setAttribute('aria-expanded', 'true');
  }

  /* ---------- busca ---------- */
  async function buscar(q) {
    const id = idRestaurante();
    if (!id) return;

    const chave = id + '|' + q.toLowerCase();
    const minha = ++seq;

    if (controle) controle.abort();

    if (cache.has(chave)) {
      sugestoes = cache.get(chave);
      if (document.activeElement === rua) desenhar();
      return;
    }

    controle = new AbortController();
    try {
      const resp = await fetch(`${API_BACKEND_URL}/api/ruas/buscar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurante_id: id, q }),
        signal: controle.signal
      });
      if (!resp.ok) throw new Error('busca ' + resp.status);
      const dados = await resp.json();
      if (!dados || dados.sucesso !== true || !Array.isArray(dados.sugestoes)) throw new Error('resposta inesperada');
      if (minha !== seq) return; // chegou atrasada

      const limpas = dados.sugestoes.filter((s) =>
        s && typeof s.rua === 'string' && typeof s.bairro_exibicao === 'string');

      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(chave, limpas);

      sugestoes = limpas;
      if (document.activeElement === rua) desenhar();
    } catch (erro) {
      if (erro && erro.name === 'AbortError') return;
      if (minha !== seq) return;
      sugestoes = []; // falhou: segue o formulário normal, sem mensagem de erro
      fechar();
    }
  }

  /* ---------- escolha ---------- */
  function escolher(i) {
    const s = sugestoes[i];
    if (!s) return;

    // preenche a Rua usando o mesmo caminho do teclado (monta o endereço e salva os dados)
    rua.value = s.rua;
    silencio = true;
    rua.dispatchEvent(new Event('input', { bubbles: true }));
    silencio = false;
    fechar();
    sugestoes = [];

    let texto = '';
    const jaEscolhido = selBairro.value;
    const opcaoExiste = !!s.bairro_id && Array.from(selBairro.options).some((o) => o.value === s.bairro_id);

    if (s.preenche === true && opcaoExiste) {
      if (!jaEscolhido) {
        selBairro.value = s.bairro_id;
        selBairro.dispatchEvent(new Event('change', { bubbles: true })); // atualiza taxa e total
      } else if (jaEscolhido !== s.bairro_id) {
        texto = 'Essa rua fica no bairro ' + s.bairro_exibicao + ', mas você escolheu outro. Confira o seu bairro acima.';
      }
    } else if (!jaEscolhido) {
      texto = 'Escolha o seu bairro na lista acima.';
    }

    mostrarAviso(texto);

    const num = $('cli-numero');
    const compl = $('cli-compl');
    const alvo = num && !num.disabled ? num : compl;
    if (alvo) alvo.focus();
  }

  /* ---------- eventos ---------- */
  rua.addEventListener('input', () => {
    if (silencio) return;
    mostrarAviso('');
    clearTimeout(timer);

    const q = rua.value.trim().replace(/\s+/g, ' ');
    if (letrasDoTexto(q).length < MIN_LETRAS || q.length > 100) {
      seq += 1;
      if (controle) controle.abort();
      sugestoes = [];
      fechar();
      return;
    }
    timer = setTimeout(() => buscar(q), ESPERA_MS);
  });

  rua.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      if (!aberta && sugestoes.length) { desenhar(); }
      if (aberta) { e.preventDefault(); marcarAtivo(ativo + 1); }
    } else if (e.key === 'ArrowUp') {
      if (aberta) { e.preventDefault(); marcarAtivo(ativo - 1); }
    } else if (e.key === 'Enter') {
      if (aberta && ativo >= 0) { e.preventDefault(); escolher(ativo); }
    } else if (e.key === 'Escape') {
      if (aberta) { e.preventDefault(); fechar(); }
    } else if (e.key === 'Tab') {
      fechar();
    }
  });

  rua.addEventListener('blur', () => setTimeout(fechar, 150));

  // tocar na lista não pode tirar o foco do campo antes do clique
  lista.addEventListener('pointerdown', (e) => e.preventDefault());

  selBairro.addEventListener('change', () => mostrarAviso(''));
})();
