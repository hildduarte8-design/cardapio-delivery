/* ===== Autocomplete do campo Rua (rua + bairro) =====
   Carregar DEPOIS do frete-gps.js.
   Usa POST /api/ruas/buscar. A busca é só uma ajuda de preenchimento:
   - se a busca falhar (rede, 429, 500), o formulário funciona como sempre;
   - o pedido continua mandando só bairro_id e o backend valida o bairro e calcula o frete;
   - a taxa mostrada ao cliente vem SEMPRE do cadastro da loja (data-taxa das opções do select),
     nunca da base geográfica.

   ORIGEM DO BAIRRO (controlada aqui dentro, 4 origens):
   - vazio   : select sem bairro;
   - auto    : bairro colocado por este script a partir de uma sugestão de rua (autocomplete);
   - manual  : o cliente escolheu (evento de mudança do select) ou confirmou "manter";
   - gps     : bairro preenchido pelo GPS. O frete-gps.js preenche o select por atribuição direta
               (select.value = ...), sem evento. Este script intercepta a atribuição de "value" NO
               PRÓPRIO select (ver instalarVigiaDoSelect) e registra a origem GPS no momento do
               preenchimento, mesmo que o valor seja igual ao que o autocomplete tinha posto.
               Não precisa mexer no frete-gps.js.
   Regras ao escolher uma sugestão de rua:
   - vazio  + rua segura           -> preenche, sem modal;
   - vazio  + rua ambígua/sem par  -> avisa para escolher o bairro;
   - auto   + mesmo bairro         -> não faz nada (sem modal);
   - auto   + outro bairro seguro  -> modal de confirmação (atual x novo, com taxas);
                                      confirmar troca bairro e taxa juntos; cancelar mantém o
                                      bairro e exige conferir o endereço antes de enviar;
   - auto   + ambígua/sem par      -> limpa o bairro automático (sem modal) e pede escolha manual;
   - gps    + outro bairro seguro  -> modal: confirmar vira auto; "manter" vira manual (sem trava);
   - gps    + mesmo bairro/ambígua -> nada (NUNCA apaga nem troca o bairro do GPS sozinho);
   - manual + qualquer rua         -> NUNCA troca nem limpa; só mostra o aviso de divergência.
   Rua EDITADA sem escolher sugestão (bairro auto): nada é limpo enquanto o cliente digita, mas o
   Enviar fica bloqueado até ele confirmar o bairro, escolher outro ou escolher uma sugestão.
   Digitar de novo, ou voltar ao texto original (digitando OU colando), não libera o envio.
   "Rever a troca" (depois de cancelar o modal) só vale para a MESMA rua da sugestão: se o texto da
   rua mudar sem nova sugestão, a conferência antiga é descartada e vira "rua editada" (continua
   bloqueando o Enviar, sem botão de rever), MESMO que o texto novo seja a rua original.
   Enquanto o modal está aberto, ou há conferência pendente, "Enviar Pedido" fica bloqueado
   (só na entrega; vale para clique e para teclado, que também gera clique). */
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

  // origem do bairro
  let valorAuto = null;     // id do bairro que NÓS colocamos no select (null = nenhum)
  let ruaAuto = null;       // chave da rua que justifica o bairro automático
  let valorManual = null;   // id do bairro que o CLIENTE escolheu (null = nenhum)
  let valorGps = null;      // id do bairro preenchido por código externo (GPS) por atribuição direta
  let programatico = false; // true enquanto nós mexemos no select
  let conferir = null;      // { bairroId, rua, chave, atualNome, novoNome, novoId } após cancelar uma troca
  let ruaEditada = null;    // { bairroId } rua editada sem escolher sugestão (trava até conferir)
  let modalAberto = false;

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
    #rua-aviso .rua-av-bts{display:flex;flex-direction:column;gap:8px;margin-top:10px}
    .rua-bt{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;padding:10px 16px;
      border-radius:14px;border:1px solid #E4DCCB;background:#fff;color:#25262A;font-size:15px;font-weight:800;
      line-height:1.2;text-align:center;cursor:pointer}
    .rua-bt.rua-bt-forte{background:var(--cor,#C2410C);border-color:var(--cor,#C2410C);color:var(--cor-texto,#fff)}
    .rua-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;justify-content:center;
      background:rgba(0,0,0,.5)}
    .rua-modal[hidden]{display:none}
    .rua-modal-cx{width:100%;max-width:480px;max-height:90vh;overflow-y:auto;background:#fff;color:#25262A;
      border-radius:20px 20px 0 0;padding:20px 16px calc(16px + env(safe-area-inset-bottom,0px));outline:none}
    .rua-modal-cx h3{margin:0 0 6px;font-size:18px;font-weight:800}
    .rua-modal-cx p{margin:0 0 12px;font-size:14px;line-height:1.4}
    .rua-modal-comp{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 14px}
    .rua-modal-comp div{border:1px solid #E4DCCB;border-radius:12px;padding:10px}
    .rua-modal-comp .rua-novo{border-color:var(--cor,#C2410C);background:#FFF7ED}
    .rua-modal-comp small{display:block;font-size:12px;opacity:.7}
    .rua-modal-comp strong{display:block;font-size:15px;line-height:1.2;margin:2px 0;overflow-wrap:anywhere}
    .rua-modal-comp em{display:block;font-style:normal;font-weight:800;font-size:14px}
    #rua-modal-gps{font-size:13px;color:#78350F;background:#FEF3C7;border-radius:10px;padding:8px 10px}
    #rua-modal-gps[hidden]{display:none}
    .rua-modal-bts{display:flex;flex-direction:column;gap:8px}
    @media (min-width:600px){.rua-modal{align-items:center}.rua-modal-cx{border-radius:20px}}
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

  function modoEntrega_() {
    return typeof modoEntrega === 'undefined' ? 'entrega' : modoEntrega;
  }

  function gpsAtivo() {
    try {
      return !!(window.freteGps && window.freteGps.payload().cliente_lat != null);
    } catch (e) { return false; }
  }

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

  /* ---------- origem do bairro ---------- */
  function chaveRua(t) { return letrasDoTexto(t).toLowerCase(); }

  function origemDoBairro() {
    const v = selBairro.value;
    if (!v) { zerarOrigem(); return 'vazio'; }
    if (valorGps !== null && v === valorGps) return 'gps';
    if (valorAuto !== null && v === valorAuto) return 'auto';
    if (valorManual !== null && v === valorManual) return 'manual';
    return 'gps'; // valor que ninguém registrou (ex.: option marcada por fora): trata como externo, o lado seguro
  }

  function zerarOrigem() {
    valorAuto = null;
    ruaAuto = null;
    valorManual = null;
    valorGps = null;
    conferir = null;
    ruaEditada = null;
  }

  function definirAuto(idBairro, nomeRua) {
    valorAuto = idBairro;
    ruaAuto = chaveRua(nomeRua);
    valorManual = null;
    valorGps = null;
  }

  // o cliente decidiu (escolheu ou confirmou "manter"): a rua nunca mais troca esse bairro
  function tornarManual() {
    valorManual = selBairro.value || null;
    valorAuto = null;
    valorGps = null;
    ruaAuto = null;
    conferir = null;
    ruaEditada = null;
    mostrarAviso('');
  }

  /* Vigia do select: quem fizer select.value = X (o frete-gps.js, ou o index ao esvaziar depois do
     pedido) passa por aqui. Atribuição nossa (programatico) não conta. O clique do cliente na lista
     NÃO passa por aqui (não é atribuição de código): ele chega pelo evento "change".
     A atribuição é interceptada no protótipo do <select> (a propriedade definida direto na instância
     é ignorada por <select>), mas só age quando o alvo é o select-bairro; para qualquer outro
     elemento repassa direto ao comportamento nativo.
     O vigia é só um auxiliar e NUNCA pode atrapalhar:
     - se a instalação falhar (protótipo bloqueado, ambiente endurecido, extensão), o erro é
       engolido e o resto do script segue; sobra a dedução em origemDoBairro() (valor que ninguém
       registrou = externo = GPS);
     - no setter, a atribuição NATIVA vem primeiro e fora de qualquer try; o registro da origem
       vem depois, protegido: se falhar, a atribuição já valeu e nenhum erro chega a quem atribuiu
       (o index faz select.value = '' dentro do try do pedido). */
  function instalarVigiaDoSelect() {
    try {
      if (typeof HTMLSelectElement === 'undefined') return;
      const proto = HTMLSelectElement.prototype;
      const nativo = Object.getOwnPropertyDescriptor(proto, 'value');
      if (!nativo || !nativo.get || !nativo.set || !nativo.configurable) return;
      Object.defineProperty(proto, 'value', {
        configurable: true,
        enumerable: nativo.enumerable,
        get() { return nativo.get.call(this); },
        set(v) {
          nativo.set.call(this, v); // atribuição nativa: sempre primeiro, nunca dentro do try
          try {
            if (this !== selBairro || programatico) return; // outro select, ou fomos nós
            const atual = nativo.get.call(this);
            zerarOrigem();
            if (atual) valorGps = atual; // preenchimento externo com bairro = GPS (inclusive o MESMO bairro de antes)
          } catch (e) { /* o registro falhou; a atribuição já valeu */ }
        }
      });
    } catch (e) {
      try { if (window.console && console.warn) console.warn('[rua-autocomplete] vigia do select indisponível; segue sem ele.', e); } catch (e2) { /* nada */ }
    }
  }
  instalarVigiaDoSelect();

  // texto da rua mudou depois de cancelar a troca / com bairro automático: descarta a conferência
  // antiga (ela falava de OUTRA rua) e passa a exigir conferência de "rua editada".
  // Ao descartar a conferência a trava de "rua editada" é criada SEMPRE, inclusive quando o texto
  // novo é igual à rua que justificou o bairro: colar ou digitar a rua original dá o mesmo resultado
  // (bloqueado até o cliente decidir: manter o bairro, escolher outro ou escolher uma sugestão).
  function verificarEdicaoDaRua() {
    if (conferirAtivo() && chaveRua(rua.value) !== conferir.chave) {
      const id = conferir.bairroId;
      conferir = null;
      if (origemDoBairro() === 'auto' && selBairro.value === id) ruaEditada = { bairroId: id };
    }
    if (!ruaEditada && !conferirAtivo() && origemDoBairro() === 'auto' && chaveRua(rua.value) !== ruaAuto) {
      ruaEditada = { bairroId: selBairro.value };
    }
  }

  // muda o select "por conta própria" (sem virar escolha manual) e avisa o resto da página
  function mexerNoSelect(valor) {
    programatico = true;
    try {
      selBairro.value = valor;
      selBairro.dispatchEvent(new Event('change', { bubbles: true })); // atualiza taxa e total
    } finally {
      programatico = false;
    }
  }

  // só vale como "segura" a sugestão com preenche=true cujo bairro existe no select da loja
  // (ativo) e tem taxa válida no cadastro
  function opcaoSegura(s) {
    if (!s || s.preenche !== true || !s.bairro_id) return null;
    const op = Array.from(selBairro.options).find((o) => o.value === s.bairro_id);
    if (!op) return null;
    return Number.isFinite(parseFloat(op.dataset.taxa)) ? op : null;
  }

  function taxaDoCadastro(op) {
    const t = parseFloat(op && op.dataset ? op.dataset.taxa : '');
    if (!Number.isFinite(t)) return 'a confirmar';
    if (typeof brl !== 'undefined' && brl && typeof brl.format === 'function') return brl.format(t);
    return 'R$ ' + t.toFixed(2).replace('.', ',');
  }

  function opcaoPorId(id) {
    return Array.from(selBairro.options).find((o) => o.value === id) || null;
  }

  // troca cancelada: vale enquanto o bairro continuar o mesmo
  function conferirAtivo() {
    if (conferir && selBairro.value !== conferir.bairroId) conferir = null;
    return !!conferir;
  }

  // rua editada sem sugestão: vale enquanto o bairro continuar o mesmo e automático
  function ruaEditadaAtiva() {
    if (ruaEditada && (origemDoBairro() !== 'auto' || selBairro.value !== ruaEditada.bairroId)) ruaEditada = null;
    return !!ruaEditada;
  }

  function focarNumero() {
    const num = $('cli-numero');
    const compl = $('cli-compl');
    const alvo = num && !num.disabled ? num : compl;
    if (alvo) alvo.focus();
  }

  /* ---------- modal de confirmação ---------- */
  let modal = null;
  let mSim = null;
  let mNao = null;
  let mPendente = null; // { rua, atual, novo }
  let overflowAntes = '';

  function criarModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'rua-modal';
    modal.className = 'rua-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="rua-modal-cx" role="dialog" aria-modal="true" aria-labelledby="rua-modal-tit" aria-describedby="rua-modal-txt" tabindex="-1">' +
        '<h3 id="rua-modal-tit">Essa rua fica em outro bairro</h3>' +
        '<p id="rua-modal-txt"></p>' +
        '<div class="rua-modal-comp">' +
          '<div><small>Bairro atual</small><strong id="rua-m-atual"></strong><em id="rua-m-taxa-atual"></em></div>' +
          '<div class="rua-novo"><small>Novo bairro</small><strong id="rua-m-novo"></strong><em id="rua-m-taxa-novo"></em></div>' +
        '</div>' +
        '<p id="rua-modal-gps" hidden>Com a sua localização ativa, a taxa final continua sendo calculada pela distância.</p>' +
        '<div class="rua-modal-bts">' +
          '<button type="button" id="rua-modal-sim" class="rua-bt rua-bt-forte"></button>' +
          '<button type="button" id="rua-modal-nao" class="rua-bt"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    mSim = modal.querySelector('#rua-modal-sim');
    mNao = modal.querySelector('#rua-modal-nao');

    mSim.addEventListener('click', confirmarTroca);
    mNao.addEventListener('click', cancelarTroca);
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelarTroca(); return; }
      if (e.key !== 'Tab') return;
      // o foco não sai do modal: Tab no último botão volta ao primeiro, Shift+Tab no primeiro vai ao último
      const alvos = [mSim, mNao];
      const i = alvos.indexOf(document.activeElement);
      if (e.shiftKey) {
        if (i <= 0) { e.preventDefault(); mNao.focus(); }
      } else if (i === alvos.length - 1) {
        e.preventDefault();
        mSim.focus();
      }
    });
  }

  function abrirModal(nomeRua, opAtual, opNovo, origem) {
    criarModal();
    mPendente = { rua: nomeRua, atual: opAtual, novo: opNovo, origem: origem || 'auto' };
    modal.querySelector('#rua-modal-txt').textContent =
      'Você escolheu “' + nomeRua + '”. ' +
      (mPendente.origem === 'gps' ? 'O bairro atual veio da sua localização. ' : '') +
      'Quer trocar o bairro da entrega?';
    modal.querySelector('#rua-m-atual').textContent = opAtual.text;
    modal.querySelector('#rua-m-taxa-atual').textContent = taxaDoCadastro(opAtual);
    modal.querySelector('#rua-m-novo').textContent = opNovo.text;
    modal.querySelector('#rua-m-taxa-novo').textContent = taxaDoCadastro(opNovo);
    modal.querySelector('#rua-modal-gps').hidden = !gpsAtivo();
    mSim.textContent = 'Trocar para ' + opNovo.text;
    mNao.textContent = 'Manter ' + opAtual.text;

    overflowAntes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal.hidden = false;
    modalAberto = true;
    modal.firstChild.focus();
  }

  function fecharModal() {
    if (!modal) return;
    modal.hidden = true;
    modalAberto = false;
    document.body.style.overflow = overflowAntes;
  }

  function confirmarTroca() {
    if (!mPendente) { fecharModal(); return; }
    const { novo, rua: nomeRua } = mPendente;
    mPendente = null;
    fecharModal();
    conferir = null;
    ruaEditada = null;
    mexerNoSelect(novo.value);
    definirAuto(novo.value, nomeRua); // vira "autocomplete" (veio da sugestão que ele confirmou)
    mostrarAviso('');
    focarNumero();
  }

  function cancelarTroca() {
    if (!mPendente) { fecharModal(); return; }
    const p = mPendente;
    mPendente = null;
    fecharModal();
    if (p.origem === 'gps') {
      tornarManual(); // decidiu manter o bairro do GPS: vira escolha dele, sem trava
    } else {
      conferir = { bairroId: p.atual.value, rua: p.rua, chave: chaveRua(p.rua), atualNome: p.atual.text, novoNome: p.novo.text, novoId: p.novo.value };
      mostrarConferir();
    }
    focarNumero();
  }

  function botao(texto, forte, aoClicar) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rua-bt' + (forte ? ' rua-bt-forte' : '');
    b.textContent = texto;
    b.addEventListener('click', aoClicar);
    return b;
  }

  // aviso fixo com botões: o cliente precisa decidir antes de enviar
  function mostrarConferir() {
    const c = conferir;
    aviso.textContent = '';
    if (!c) return;
    const texto = document.createElement('span');
    texto.textContent = 'Você escolheu “' + c.rua + '”, que fica em ' + c.novoNome +
      ', mas o bairro está como ' + c.atualNome + '. Confira o endereço antes de enviar.';
    const bts = document.createElement('div');
    bts.className = 'rua-av-bts';
    bts.appendChild(botao('Está certo: manter ' + c.atualNome, true, tornarManual));
    bts.appendChild(botao('Rever a troca', false, () => {
      // a decisão antiga só vale para a MESMA rua que gerou a sugestão
      if (conferir !== c || chaveRua(rua.value) !== c.chave) {
        verificarEdicaoDaRua();
        mostrarAviso('');
        return;
      }
      const atual = opcaoPorId(c.bairroId);
      const novo = opcaoPorId(c.novoId);
      if (!atual || !novo) { conferir = null; mostrarAviso(''); return; }
      abrirModal(c.rua, atual, novo, 'auto');
    }));
    aviso.appendChild(texto);
    aviso.appendChild(bts);
  }

  // rua editada sem escolher sugestão: o cliente confere o bairro ou escolhe outro
  function mostrarEdicao() {
    aviso.textContent = '';
    if (!ruaEditada) return;
    const op = opcaoPorId(ruaEditada.bairroId);
    if (!op) { ruaEditada = null; return; }
    const texto = document.createElement('span');
    texto.textContent = 'Você mudou a rua. Confira se o bairro ' + op.text + ' (' + taxaDoCadastro(op) +
      ') ainda está certo, ou escolha uma sugestão da lista.';
    const bts = document.createElement('div');
    bts.className = 'rua-av-bts';
    bts.appendChild(botao('Está certo: manter ' + op.text, true, tornarManual));
    bts.appendChild(botao('Escolher outro bairro', false, () => {
      if (selBairro.scrollIntoView) selBairro.scrollIntoView({ behavior: 'smooth', block: 'center' });
      selBairro.focus();
    }));
    aviso.appendChild(texto);
    aviso.appendChild(bts);
  }

  /* ---------- trava do botão Enviar ---------- */
  // Escuta na fase de captura, antes do clique chegar ao botão. Não precisa mexer no index.html.
  document.addEventListener('click', (e) => {
    const alvo = e.target && e.target.closest ? e.target.closest('#btn-enviar') : null;
    if (!alvo) return;

    if (modalAberto) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (modoEntrega_() !== 'entrega') return;
    verificarEdicaoDaRua(); // cobre mudança de texto que não passou por evento de digitação
    let msg = '';
    if (conferirAtivo()) msg = 'Confira o endereço: a rua e o bairro não parecem combinar.';
    else if (ruaEditadaAtiva()) {
      msg = 'Você mudou a rua. Confira o bairro ou escolha uma sugestão da lista.';
      mostrarEdicao();
    }
    if (msg) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (typeof avisar === 'function') avisar(msg);
      if (aviso.scrollIntoView) aviso.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, true);

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

    // uma nova escolha de rua começa uma avaliação nova
    conferir = null;
    ruaEditada = null;
    mostrarAviso('');

    const origem = origemDoBairro();
    const novo = opcaoSegura(s);
    let abriuModal = false;
    let texto = '';

    if (origem === 'vazio') {
      if (novo) {
        mexerNoSelect(novo.value);
        definirAuto(novo.value, s.rua);
      } else {
        texto = 'Escolha o seu bairro na lista abaixo.';
      }
    } else if (origem === 'manual') {
      // escolha do cliente: nunca troca nem limpa, só avisa se houver divergência
      if (novo && novo.value !== selBairro.value) {
        texto = 'Essa rua fica no bairro ' + s.bairro_exibicao + ', mas você escolheu outro. Confira o seu bairro abaixo.';
      }
    } else if (origem === 'gps') {
      // bairro do GPS: só o modal decide; rua ambígua ou do mesmo bairro não mexe em nada
      if (novo && novo.value !== selBairro.value) {
        const atual = opcaoPorId(selBairro.value);
        if (atual) {
          abrirModal(s.rua, atual, novo, 'gps');
          abriuModal = true;
        }
      }
    } else if (novo && novo.value === selBairro.value) {
      ruaAuto = chaveRua(s.rua); // mesmo bairro, agora justificado por esta rua
    } else if (novo) {
      const atual = opcaoPorId(selBairro.value);
      if (atual) {
        abrirModal(s.rua, atual, novo, 'auto');
        abriuModal = true;
      }
    } else {
      // bairro automático + rua ambígua ou sem correspondência segura: limpa e pede escolha manual
      mexerNoSelect('');
      zerarOrigem();
      texto = 'Não deu para identificar o bairro dessa rua com segurança. Escolha o seu bairro na lista abaixo.';
    }

    mostrarAviso(texto);
    if (!abriuModal) focarNumero();
  }

  /* ---------- eventos ---------- */
  rua.addEventListener('input', () => {
    if (silencio) return;
    mostrarAviso('');
    // rua mudou e o bairro automático foi justificado por outra rua: trava o Enviar (não limpa nada)
    verificarEdicaoDaRua();
    if (conferirAtivo()) mostrarConferir(); // (o aviso da rua editada aparece ao sair do campo ou ao tocar em Enviar)
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

  rua.addEventListener('blur', () => setTimeout(() => {
    fechar();
    // saiu do campo sem escolher sugestão e o bairro automático ficou sem conferência
    if (!modalAberto && !conferirAtivo() && ruaEditadaAtiva()) mostrarEdicao();
  }, 150));

  // tocar na lista não pode tirar o foco do campo antes do clique
  lista.addEventListener('pointerdown', (e) => e.preventDefault());

  // Qualquer mudança do select que NÃO seja nossa é escolha do cliente: vira "manual".
  selBairro.addEventListener('change', () => {
    mostrarAviso('');
    if (!programatico) {
      // escolha do cliente: vira manual e encerra qualquer conferência pendente
      valorAuto = null;
      valorGps = null;
      ruaAuto = null;
      conferir = null;
      ruaEditada = null;
      valorManual = selBairro.value || null;
    }
  });

  // O select pode ser esvaziado sem evento (depois de enviar o pedido); o index chama atualizarTaxa().
  if (typeof atualizarTaxa === 'function') {
    const taxaBase = atualizarTaxa;
    atualizarTaxa = function () {
      taxaBase();
      origemDoBairro();
      conferirAtivo();
      ruaEditadaAtiva();
    };
  }
})();
