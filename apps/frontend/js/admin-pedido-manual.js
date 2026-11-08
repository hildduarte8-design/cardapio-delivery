// Tela "Novo pedido": o lojista lança um pedido (balcão, telefone, WhatsApp).
// Envia para o backend (/api/pedidos/manual), que confere tudo de novo:
// preço dos produtos, taxa de entrega, desconto e vínculo do usuário com a loja.
// O resumo desta tela é só uma prévia; o valor que vale é o que o servidor devolve.
import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, aviso } from './admin-utils.js';
import { carregarPedidos } from './admin-pedidos.js';

// Mesmo endereço do backend usado no cardápio (index.html)
const API_BACKEND_URL = 'https://cardapio-delivery-backend.onrender.com';

// Limites iguais aos do backend (utils/pedidosUtils.js)
const MAX_ITENS = 30;
const MAX_QTD_POR_ITEM = 50;
const MAX_OBSERVACAO = 250;
const MAX_MOTIVO_DESCONTO = 60;

const form = {
  tipo: 'entrega',        // 'entrega' | 'retirada'
  pagamento: 'dinheiro',  // 'dinheiro' | 'pix' | 'cartao'
  itens: new Map(),       // produto_id -> quantidade
  busca: '',
  enviando: false
};

let ultimoFoco = null;
let montado = false;

// ---------- Utilidades ----------

// Aceita "12,50", "12.50" e "R$ 12,50". Vazio vira 0. Inválido vira null.
function lerValor(texto) {
  const limpo = String(texto ?? '')
    .replace(/R\$/gi, '')
    .replace(/\s/g, '')
    .replace(',', '.');

  if (limpo === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(limpo)) return null;

  return Math.round(Number(limpo) * 100);
}

const reais = (centavos) => brl.format((centavos || 0) / 100);

function bairroSelecionado() {
  const id = $('npm-bairro')?.value;
  if (!id) return null;
  return state.bairros.find((b) => String(b.id) === String(id)) || null;
}

function totaisAtuais() {
  let subtotal = 0;

  form.itens.forEach((qtd, id) => {
    const produto = state.produtos.find((p) => String(p.id) === String(id));
    if (produto) subtotal += Math.round(Number(produto.preco) * 100) * qtd;
  });

  let taxa = 0;
  if (form.tipo === 'entrega') {
    const bairro = bairroSelecionado();
    taxa = bairro ? Math.round(Number(bairro.taxa || 0) * 100) : 0;
  }

  const desconto = lerValor($('npm-desconto')?.value);
  const bruto = subtotal + taxa;

  return {
    subtotal,
    taxa,
    desconto,                         // null = valor digitado inválido
    bruto,
    total: Math.max(0, bruto - (desconto || 0))
  };
}

function totalItens() {
  let soma = 0;
  form.itens.forEach((qtd) => { soma += qtd; });
  return soma;
}

// ---------- Montagem da tela (uma vez só) ----------

function montarTela() {
  if (montado) return;

  const tela = $('tela-novo-pedido');
  if (!tela) return;

  tela.innerHTML = `
    <div class="npm-painel" role="dialog" aria-modal="true" aria-labelledby="npm-titulo">
      <header class="npm-topo">
        <h2 id="npm-titulo" class="npm-titulo">Novo pedido</h2>
        <button type="button" id="npm-fechar" class="npm-fechar" aria-label="Fechar sem lançar">✕ Fechar</button>
      </header>

      <div class="npm-corpo">
        <section class="npm-secao" aria-labelledby="npm-t-tipo">
          <h3 id="npm-t-tipo" class="npm-t">Como o cliente vai receber?</h3>
          <div class="npm-seg" role="group" aria-label="Tipo de atendimento">
            <button type="button" class="npm-seg-btn" data-tipo="entrega" aria-pressed="true">🛵 Entrega</button>
            <button type="button" class="npm-seg-btn" data-tipo="retirada" aria-pressed="false">🏪 Retirada no balcão</button>
          </div>
        </section>

        <section class="npm-secao" aria-labelledby="npm-t-cliente">
          <h3 id="npm-t-cliente" class="npm-t">Cliente</h3>
          <label class="npm-label" for="npm-nome">Nome</label>
          <input id="npm-nome" class="input-padrao" maxlength="80" autocomplete="off" placeholder="Nome do cliente" />

          <label class="npm-label" for="npm-whatsapp">WhatsApp com DDD <span class="npm-opc">(opcional)</span></label>
          <input id="npm-whatsapp" class="input-padrao" type="tel" inputmode="numeric" maxlength="16" autocomplete="off" placeholder="(33) 99999-9999" />

          <div id="npm-bloco-entrega">
            <label class="npm-label" for="npm-bairro">Bairro</label>
            <select id="npm-bairro" class="input-padrao"></select>

            <label class="npm-label" for="npm-endereco">Endereço completo</label>
            <input id="npm-endereco" class="input-padrao" maxlength="200" autocomplete="off" placeholder="Rua, número, complemento" />
          </div>
        </section>

        <section class="npm-secao" aria-labelledby="npm-t-itens">
          <h3 id="npm-t-itens" class="npm-t">Itens <span id="npm-contagem" class="npm-opc"></span></h3>
          <label class="npm-label sr-only" for="npm-busca">Buscar produto</label>
          <input id="npm-busca" class="input-padrao" type="search" autocomplete="off" placeholder="🔎 Buscar produto" />
          <div id="npm-lista-produtos" class="npm-produtos"></div>
        </section>

        <section class="npm-secao" aria-labelledby="npm-t-pgto">
          <h3 id="npm-t-pgto" class="npm-t">Pagamento</h3>
          <div class="npm-seg npm-seg-3" role="group" aria-label="Forma de pagamento">
            <button type="button" class="npm-seg-btn" data-pgto="dinheiro" aria-pressed="true">💵 Dinheiro</button>
            <button type="button" class="npm-seg-btn" data-pgto="pix" aria-pressed="false">Pix</button>
            <button type="button" class="npm-seg-btn" data-pgto="cartao" aria-pressed="false">💳 Cartão</button>
          </div>
          <div id="npm-bloco-troco">
            <label class="npm-label" for="npm-troco">Troco para quanto? <span class="npm-opc">(opcional)</span></label>
            <input id="npm-troco" class="input-padrao" inputmode="decimal" autocomplete="off" placeholder="Ex.: 50,00" />
          </div>
          <p id="npm-dica-pix" class="npm-dica hidden">Pedido em Pix fica como "Aguardando Pix" até você confirmar o pagamento.</p>
        </section>

        <section class="npm-secao" aria-labelledby="npm-t-desc">
          <h3 id="npm-t-desc" class="npm-t">Desconto <span class="npm-opc">(opcional)</span></h3>
          <label class="npm-label" for="npm-desconto">Valor do desconto (R$)</label>
          <div class="npm-linha">
            <input id="npm-desconto" class="input-padrao" inputmode="decimal" autocomplete="off" placeholder="0,00" />
            <button type="button" id="npm-frete-gratis" class="npm-btn-sec">Frete grátis</button>
          </div>
          <label class="npm-label" for="npm-desconto-motivo">Motivo</label>
          <input id="npm-desconto-motivo" class="input-padrao" maxlength="${MAX_MOTIVO_DESCONTO}" autocomplete="off" placeholder="Ex.: cliente antigo" />
          <p id="npm-erro-desconto" class="npm-erro-campo hidden" role="alert"></p>
        </section>

        <section class="npm-secao" aria-labelledby="npm-t-obs">
          <h3 id="npm-t-obs" class="npm-t">Observação <span class="npm-opc">(opcional)</span></h3>
          <label class="npm-label sr-only" for="npm-obs">Observação do pedido</label>
          <textarea id="npm-obs" class="input-padrao npm-textarea" maxlength="${MAX_OBSERVACAO}" placeholder="Ex.: sem cebola, tocar a campainha"></textarea>
        </section>

        <section class="npm-resumo" aria-live="polite" aria-label="Resumo do pedido">
          <div class="npm-res-linha"><span>Itens</span><span id="npm-r-subtotal">R$ 0,00</span></div>
          <div class="npm-res-linha" id="npm-r-linha-taxa"><span>Entrega</span><span id="npm-r-taxa">R$ 0,00</span></div>
          <div class="npm-res-linha npm-res-desc hidden" id="npm-r-linha-desc"><span>Desconto</span><span id="npm-r-desc">− R$ 0,00</span></div>
          <div class="npm-res-linha npm-res-total"><span>Total</span><span id="npm-r-total">R$ 0,00</span></div>
          <p class="npm-dica">Prévia. O valor final é calculado pelo sistema ao lançar.</p>
        </section>

        <p id="npm-erro" class="npm-erro hidden" role="alert"></p>
      </div>

      <footer class="npm-rodape">
        <button type="button" id="npm-enviar" class="npm-enviar">Lançar pedido</button>
      </footer>
    </div>
  `;

  ligarEventos(tela);
  montado = true;
}

// ---------- Renderização ----------

function renderBairros() {
  const select = $('npm-bairro');
  const ativos = state.bairros.filter((b) => b.ativo);
  const atual = select.value;

  select.innerHTML = ativos.length
    ? `<option value="">Escolha o bairro</option>` +
      ativos.map((b) =>
        `<option value="${esc(b.id)}">${esc(b.nome)} — ${esc(brl.format(Number(b.taxa || 0)))}</option>`
      ).join('')
    : `<option value="">Nenhum bairro ativo (cadastre na aba Entrega)</option>`;

  if (atual && ativos.some((b) => String(b.id) === String(atual))) select.value = atual;
}

function renderProdutos() {
  const termo = form.busca.trim().toLowerCase();

  const disponiveis = state.produtos.filter((p) => p.disponivel);
  const lista = termo
    ? disponiveis.filter((p) =>
        `${p.nome} ${p.categoria || ''}`.toLowerCase().includes(termo)
      )
    : disponiveis;

  const alvo = $('npm-lista-produtos');

  if (!disponiveis.length) {
    alvo.innerHTML = `<p class="npm-vazio">Nenhum produto ativo. Ative produtos na aba Cardápio.</p>`;
    return;
  }

  if (!lista.length) {
    alvo.innerHTML = `<p class="npm-vazio">Nenhum produto encontrado para "${esc(form.busca.trim())}".</p>`;
    return;
  }

  alvo.innerHTML = lista.map((produto) => {
    const qtd = form.itens.get(String(produto.id)) || 0;

    return `
      <div class="npm-produto ${qtd ? 'npm-produto-sel' : ''}">
        <div class="npm-produto-info">
          <span class="npm-produto-nome">${esc(produto.nome)}</span>
          <span class="npm-produto-meta">${esc(produto.categoria || 'Geral')} · ${esc(brl.format(Number(produto.preco) || 0))}</span>
        </div>
        <div class="npm-qtd" role="group" aria-label="Quantidade de ${esc(produto.nome)}">
          <button type="button" class="npm-qtd-btn" data-menos="${esc(produto.id)}" aria-label="Diminuir ${esc(produto.nome)}" ${qtd ? '' : 'disabled'}>−</button>
          <span class="npm-qtd-num" aria-live="polite">${qtd}</span>
          <button type="button" class="npm-qtd-btn" data-mais="${esc(produto.id)}" aria-label="Aumentar ${esc(produto.nome)}">+</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderResumo() {
  const t = totaisAtuais();
  const ehEntrega = form.tipo === 'entrega';
  const descontoValido = t.desconto !== null;
  const descontoUsado = descontoValido ? t.desconto : 0;

  $('npm-r-subtotal').innerText = reais(t.subtotal);
  $('npm-r-taxa').innerText = reais(t.taxa);
  $('npm-r-linha-taxa').classList.toggle('hidden', !ehEntrega);

  $('npm-r-desc').innerText = `− ${reais(descontoUsado)}`;
  $('npm-r-linha-desc').classList.toggle('hidden', descontoUsado === 0);

  $('npm-r-total').innerText = reais(t.total);

  const qtdTotal = totalItens();
  $('npm-contagem').innerText = qtdTotal ? `(${qtdTotal} ${qtdTotal === 1 ? 'unidade' : 'unidades'})` : '';

  // Mensagem de erro do desconto, em tempo real
  const erro = $('npm-erro-desconto');
  let msg = '';

  if (!descontoValido) msg = 'Digite o desconto em reais, por exemplo 5,00.';
  else if (descontoUsado > t.bruto) msg = 'O desconto não pode ser maior que os itens somados à entrega.';

  erro.innerText = msg;
  erro.classList.toggle('hidden', !msg);
}

function renderTipoEPagamento() {
  const ehEntrega = form.tipo === 'entrega';

  document.querySelectorAll('#tela-novo-pedido [data-tipo]').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.tipo === form.tipo ? 'true' : 'false');
  });

  document.querySelectorAll('#tela-novo-pedido [data-pgto]').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.pgto === form.pagamento ? 'true' : 'false');
  });

  $('npm-bloco-entrega').classList.toggle('hidden', !ehEntrega);
  $('npm-frete-gratis').classList.toggle('hidden', !ehEntrega);
  $('npm-bloco-troco').classList.toggle('hidden', form.pagamento !== 'dinheiro');
  $('npm-dica-pix').classList.toggle('hidden', form.pagamento !== 'pix');
}

function renderTudo() {
  renderTipoEPagamento();
  renderProdutos();
  renderResumo();
}

function mostrarErro(mensagem) {
  const el = $('npm-erro');
  el.innerText = mensagem || '';
  el.classList.toggle('hidden', !mensagem);

  if (mensagem) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------- Abrir e fechar ----------

function limparFormulario() {
  form.tipo = 'entrega';
  form.pagamento = 'dinheiro';
  form.itens = new Map();
  form.busca = '';
  form.enviando = false;

  ['npm-nome', 'npm-whatsapp', 'npm-endereco', 'npm-busca', 'npm-troco',
    'npm-desconto', 'npm-desconto-motivo', 'npm-obs'
  ].forEach((id) => { $(id).value = ''; });

  $('npm-bairro').value = '';
  $('npm-enviar').disabled = false;
  $('npm-enviar').innerText = 'Lançar pedido';
  mostrarErro('');
}

function abrir() {
  if (!state.rest) return;

  montarTela();
  limparFormulario();
  renderBairros();
  renderTudo();

  ultimoFoco = document.activeElement;

  $('tela-novo-pedido').classList.remove('hidden');
  document.body.classList.add('npm-aberto');
  $('npm-nome').focus();
}

function fechar({ pedirConfirmacao = true } = {}) {
  const temDados =
    form.itens.size > 0 || $('npm-nome').value.trim() !== '';

  if (
    pedirConfirmacao &&
    temDados &&
    !confirm('Descartar este pedido? O que você preencheu será perdido.')
  ) {
    return;
  }

  $('tela-novo-pedido').classList.add('hidden');
  document.body.classList.remove('npm-aberto');

  if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
}

// ---------- Envio ----------

function validar() {
  const nome = $('npm-nome').value.trim();
  const ehEntrega = form.tipo === 'entrega';

  if (nome.length < 2) return { erro: 'Informe o nome do cliente.', campo: 'npm-nome' };

  const fone = $('npm-whatsapp').value.replace(/\D/g, '');
  if (fone && (fone.length < 10 || fone.length > 13)) {
    return { erro: 'WhatsApp inválido. Digite com DDD ou deixe em branco.', campo: 'npm-whatsapp' };
  }

  if (ehEntrega) {
    if (!$('npm-bairro').value) return { erro: 'Escolha o bairro de entrega.', campo: 'npm-bairro' };

    if ($('npm-endereco').value.trim().length < 5) {
      return { erro: 'Informe o endereço completo (mínimo 5 caracteres).', campo: 'npm-endereco' };
    }
  }

  if (!form.itens.size) return { erro: 'Adicione pelo menos um item.', campo: 'npm-busca' };

  const t = totaisAtuais();

  if (t.desconto === null) return { erro: 'Desconto inválido. Digite em reais, por exemplo 5,00.', campo: 'npm-desconto' };

  if (t.desconto > t.bruto) {
    return { erro: 'O desconto não pode ser maior que os itens somados à entrega.', campo: 'npm-desconto' };
  }

  if (form.pagamento === 'dinheiro') {
    const troco = lerValor($('npm-troco').value);

    if (troco === null) return { erro: 'Troco inválido. Digite em reais, por exemplo 50,00.', campo: 'npm-troco' };

    if (troco > 0 && troco < t.total) {
      return { erro: `O troco deve ser igual ou maior que o total (${reais(t.total)}).`, campo: 'npm-troco' };
    }
  }

  return { ok: true, totais: t };
}

function montarPayload(totais) {
  const ehEntrega = form.tipo === 'entrega';

  const payload = {
    restaurante_id: state.rest.id,
    tipo_atendimento: form.tipo,
    cliente_nome: $('npm-nome').value.trim(),
    cliente_whatsapp: $('npm-whatsapp').value.replace(/\D/g, ''),
    itens: [...form.itens.entries()].map(([produto_id, quantidade]) => ({ produto_id, quantidade })),
    forma_pagamento: form.pagamento,
    observacao: $('npm-obs').value.trim()
  };

  if (ehEntrega) {
    payload.bairro_id = $('npm-bairro').value;
    payload.endereco_completo = $('npm-endereco').value.trim();
  }

  if (totais.desconto > 0) {
    payload.desconto = totais.desconto / 100;
    payload.desconto_motivo = $('npm-desconto-motivo').value.trim();
  }

  if (form.pagamento === 'dinheiro') {
    const troco = lerValor($('npm-troco').value);
    if (troco > 0) payload.troco_para = troco / 100;
  }

  return payload;
}

async function enviar() {
  if (form.enviando) return;

  mostrarErro('');

  const resultado = validar();

  if (!resultado.ok) {
    mostrarErro(resultado.erro);
    $(resultado.campo)?.focus();
    return;
  }

  if (!sb) {
    mostrarErro('Conexão com o banco indisponível.');
    return;
  }

  const { data: sessaoData } = await sb.auth.getSession();
  const token = sessaoData?.session?.access_token;

  if (!token) {
    aviso('Sessão expirada. Entre novamente.');
    window.dispatchEvent(new CustomEvent('admin:session-expired'));
    return;
  }

  form.enviando = true;
  const botao = $('npm-enviar');
  botao.disabled = true;
  botao.innerText = 'Lançando...';

  try {
    // O Render gratuito pode demorar para acordar: damos até 45 s antes de desistir
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), 45000);

    let resposta;
    try {
      resposta = await fetch(`${API_BACKEND_URL}/api/pedidos/manual`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(montarPayload(resultado.totais)),
        signal: controle.signal
      });
    } finally {
      clearTimeout(limite);
    }

    let corpo = null;
    try { corpo = await resposta.json(); } catch { corpo = null; }

    if (resposta.status === 401) {
      aviso('Sessão expirada. Entre novamente.');
      window.dispatchEvent(new CustomEvent('admin:session-expired'));
      return;
    }

    if (!resposta.ok || !corpo?.sucesso) {
      mostrarErro(corpo?.erro || 'Não foi possível lançar o pedido. Tente de novo.');
      return;
    }

    // Deu certo: o pedido novo não deve tocar o alerta de "novo pedido recebido"
    const idNovo = String(corpo.pedido.id);
    if (state.idsVistos) state.idsVistos.add(idNovo);

    state.filtroStatus = 'todos';

    fechar({ pedirConfirmacao: false });
    aviso(`✅ Pedido lançado · ${brl.format(Number(corpo.pedido.total) || 0)}`);

    await carregarPedidos();
  } catch (erro) {
    console.error('Falha ao lançar pedido manual:', erro);

    // Sem resposta: o servidor pode ter criado o pedido mesmo assim
    mostrarErro(
      erro?.name === 'AbortError'
        ? 'O servidor demorou para responder. Confira a lista de pedidos antes de tentar de novo, para não lançar em duplicidade.'
        : 'Sem conexão com o servidor. Confira a lista de pedidos antes de tentar de novo, para não lançar em duplicidade.'
    );
  } finally {
    form.enviando = false;
    botao.disabled = false;
    botao.innerText = 'Lançar pedido';
  }
}

// ---------- Eventos ----------

function ligarEventos(tela) {
  $('npm-fechar').addEventListener('click', () => fechar());
  $('npm-enviar').addEventListener('click', enviar);

  tela.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape') fechar();
  });

  tela.addEventListener('click', (evento) => {
    const tipo = evento.target.closest('[data-tipo]');
    if (tipo) {
      form.tipo = tipo.dataset.tipo;
      renderTipoEPagamento();
      renderResumo();
      return;
    }

    const pgto = evento.target.closest('[data-pgto]');
    if (pgto) {
      form.pagamento = pgto.dataset.pgto;
      renderTipoEPagamento();
      return;
    }

    const mais = evento.target.closest('[data-mais]');
    if (mais) {
      const id = mais.dataset.mais;
      const atual = form.itens.get(id) || 0;

      if (!atual && form.itens.size >= MAX_ITENS) {
        mostrarErro(`O pedido pode ter no máximo ${MAX_ITENS} produtos diferentes.`);
        return;
      }

      if (atual >= MAX_QTD_POR_ITEM) {
        mostrarErro(`O máximo é ${MAX_QTD_POR_ITEM} unidades por produto.`);
        return;
      }

      mostrarErro('');
      form.itens.set(id, atual + 1);
      renderProdutos();
      renderResumo();
      return;
    }

    const menos = evento.target.closest('[data-menos]');
    if (menos) {
      const id = menos.dataset.menos;
      const atual = form.itens.get(id) || 0;

      if (atual <= 1) form.itens.delete(id);
      else form.itens.set(id, atual - 1);

      renderProdutos();
      renderResumo();
    }
  });

  $('npm-busca').addEventListener('input', (evento) => {
    form.busca = evento.target.value;
    renderProdutos();
  });

  $('npm-bairro').addEventListener('change', renderResumo);
  $('npm-desconto').addEventListener('input', renderResumo);

  // Frete grátis: desconto igual à taxa. A taxa em si nunca é alterada.
  $('npm-frete-gratis').addEventListener('click', () => {
    const bairro = bairroSelecionado();

    if (!bairro) {
      mostrarErro('Escolha o bairro primeiro para dar frete grátis.');
      $('npm-bairro').focus();
      return;
    }

    const taxa = Math.round(Number(bairro.taxa || 0) * 100);

    if (taxa <= 0) {
      mostrarErro('Este bairro já não tem taxa de entrega.');
      return;
    }

    mostrarErro('');
    $('npm-desconto').value = (taxa / 100).toFixed(2).replace('.', ',');

    if (!$('npm-desconto-motivo').value.trim()) {
      $('npm-desconto-motivo').value = 'Frete grátis';
    }

    renderResumo();
  });
}

export function inicializarPedidoManual() {
  const botao = $('btn-novo-pedido');
  if (!botao) return;

  botao.addEventListener('click', abrir);
}
