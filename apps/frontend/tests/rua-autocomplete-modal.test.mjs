/* Testes do autocomplete de rua + troca de bairro com confirmação.
   Rodar nesta pasta: npm install && npm test
   Usa o HTML REAL do index.html (seção de endereço + botão Enviar) e o JS REAL de js/rua-autocomplete.js
   num navegador simulado (jsdom). NÃO substitui o teste em navegador de verdade nem no celular. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.join(aqui, '..', 'index.html'), 'utf8');
const SCRIPT = readFileSync(path.join(aqui, '..', 'js', 'rua-autocomplete.js'), 'utf8');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

// Cadastro da loja (o que o index.html carrega da tabela bairros)
const BAIRROS = [
  { id: 'b-centro', nome: 'Centro', taxa: '8.50' },
  { id: 'b-bela', nome: 'Bela Vista', taxa: '11.00' },
  { id: 'b-betel', nome: 'Vila Betel', taxa: '8.00' },
  { id: 'b-nan', nome: 'Bairro Sem Taxa', taxa: 'null' }
];

// Respostas da busca. O campo "taxa: 999" é lixo de propósito: a tela NUNCA pode usá-lo.
const RUAS = {
  chile: [{ rua: 'Rua Chile', bairro_exibicao: 'Bela Vista', bairro_id: 'b-bela', preenche: true, taxa: 999 }],
  getulio: [
    { rua: 'Avenida Getulio Vargas', bairro_exibicao: 'Centro IBGE', bairro_id: 'b-centro', preenche: true, taxa: 999 },
    { rua: 'Avenida Getulio Vargas', bairro_exibicao: 'Fátima', bairro_id: null, preenche: false }
  ],
  betel: [{ rua: 'Rua Betel', bairro_exibicao: 'Vila Betel', bairro_id: 'b-betel', preenche: true }],
  olavo: [{ rua: 'Rua Olavo Bilac', bairro_exibicao: 'Barreiros', bairro_id: null, preenche: false }],
  semtaxa: [{ rua: 'Rua Sem Taxa', bairro_exibicao: 'Bairro Sem Taxa', bairro_id: 'b-nan', preenche: true }]
};

function montar(opcoes = {}) {
  const secao = INDEX.match(/<section class="bloco" id="sec-endereco">[\s\S]*?<\/section>/);
  assert.ok(secao, 'seção #sec-endereco não encontrada no index.html');
  assert.ok(/id="btn-enviar"/.test(INDEX), 'botão #btn-enviar não encontrado no index.html');

  const html = '<!doctype html><html><body>' +
    '<div id="toast" class="toast hidden"></div>' + secao[0] +
    '<button id="btn-enviar" type="button">Enviar Pedido</button></body></html>';
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const d = w.document;

  // opções do select, no mesmo formato do carregarBairros() do index.html
  $sel(d).innerHTML = '<option value="">Selecione seu bairro...</option>' +
    BAIRROS.map((b) => `<option value="${b.id}" data-taxa="${b.taxa}" data-tempo="30 min">${b.nome}</option>`).join('');

  // globais que a página real oferece
  w.restauranteInfo = { id: 'r1' };
  w.API_BACKEND_URL = 'http://api.teste';
  w.brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  w.modoEntrega = 'entrega';
  w.avisos = [];
  w.avisar = (msg) => { w.avisos.push(msg); };
  w.atualizarTaxa = function () {
    const op = $sel(d).options[$sel(d).selectedIndex];
    d.getElementById('val-taxa').textContent = op && op.value ? w.brl.format(parseFloat(op.dataset.taxa) || 0) : w.brl.format(0);
  };
  $sel(d).addEventListener('change', w.atualizarTaxa); // igual ao index.html
  w.atualizarTaxa();

  w.fetchChamadas = 0;
  w.fetch = async (url, opts) => {
    w.fetchChamadas += 1;
    const q = JSON.parse(opts.body).q.toLowerCase();
    const chave = Object.keys(RUAS).find((k) => q.includes(k));
    return { ok: true, json: async () => ({ sucesso: true, sugestoes: chave ? RUAS[chave] : [] }) };
  };

  // quantas vezes o clique CHEGOU ao botão (o handler real do index chama finalizarPedido)
  w.envios = 0;
  d.getElementById('btn-enviar').addEventListener('click', () => { w.envios += 1; });

  // captura avisos do console (o script avisa se o vigia do select não puder ser instalado)
  w.avisosConsole = [];
  w.console.warn = (...a) => { w.avisosConsole.push(a.map(String).join(' ')); };

  if (opcoes.antes) opcoes.antes(w, d);   // ganchos usados só pelos testes de falha do vigia
  w.eval(SCRIPT);
  if (opcoes.depois) opcoes.depois(w, d);
  return { w, d };
}

function $sel(d) { return d.getElementById('select-bairro'); }

async function digitarEEscolher(h, q, indice = 0) {
  const campo = h.d.getElementById('cli-rua');
  campo.focus();
  campo.value = q;
  campo.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  await esperar(360);
  const itens = h.d.querySelectorAll('#rua-lista li');
  assert.ok(itens.length > indice, `sugestão ${indice} não apareceu para "${q}"`);
  itens[indice].dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
}

const modalVisivel = (h) => { const m = h.d.getElementById('rua-modal'); return !!m && !m.hidden; };
const taxaNaTela = (h) => norm(h.d.getElementById('val-taxa').textContent);
const clicarEnviar = (h) => h.d.getElementById('btn-enviar').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true, cancelable: true }));
const textoModal = (h) => norm(h.d.getElementById('rua-modal').textContent);
const avisoRua = (h) => norm(h.d.getElementById('rua-aviso').textContent);
const escolhaManual = (h, valor) => { $sel(h.d).value = valor; $sel(h.d).dispatchEvent(new h.w.Event('change', { bubbles: true })); };
const clicar = (h, id) => h.d.getElementById(id).dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
const botaoComTexto = (h, trecho) => Array.from(h.d.querySelectorAll('#rua-aviso button')).find((b) => b.textContent.includes(trecho));

/* ---------- 1. bairro vazio ---------- */
test('1. vazio + rua segura: preenche bairro e taxa, sem modal, foco no número', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  assert.equal($sel(h.d).value, 'b-bela');
  assert.equal(taxaNaTela(h), 'R$ 11,00');
  assert.equal(modalVisivel(h), false);
  assert.equal(h.d.activeElement.id, 'cli-numero');
});

test('1b. vazio + rua ambígua/sem correspondência: não preenche e pede escolha manual', async () => {
  const h = montar();
  await digitarEEscolher(h, 'olavo');
  assert.equal($sel(h.d).value, '');
  assert.match(avisoRua(h), /Escolha o seu bairro/);
  assert.equal(modalVisivel(h), false);
});

test('1c. bairro sem taxa válida no cadastro nunca é preenchido', async () => {
  const h = montar();
  await digitarEEscolher(h, 'semtaxa');
  assert.equal($sel(h.d).value, '');
  assert.match(avisoRua(h), /Escolha o seu bairro/);
});

/* ---------- 2. bairro automático + outra rua com outro bairro seguro ---------- */
test('2. auto + outro bairro seguro: abre modal com bairro atual, novo e taxas DO CADASTRO', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');          // auto: Bela Vista R$ 11,00
  await digitarEEscolher(h, 'getulio', 0);     // Centro R$ 8,50
  assert.equal(modalVisivel(h), true);
  const t = textoModal(h);
  assert.match(t, /Bela Vista/);
  assert.match(t, /R\$ 11,00/);
  assert.match(t, /Centro/);
  assert.match(t, /R\$ 8,50/);
  assert.doesNotMatch(t, /999/, 'a taxa do backend (lixo) não pode aparecer');
  assert.doesNotMatch(t, /IBGE/, 'o nome do bairro vem do cadastro da loja, não da base geográfica');
  // nada muda enquanto o cliente não decide
  assert.equal($sel(h.d).value, 'b-bela');
  assert.equal(taxaNaTela(h), 'R$ 11,00');
  assert.match(h.d.getElementById('rua-modal-sim').textContent, /Trocar para Centro/);
  assert.match(h.d.getElementById('rua-modal-nao').textContent, /Manter Bela Vista/);
});

test('2a. confirmar: bairro e taxa mudam juntos, modal fecha, Enviar liberado', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-sim');
  assert.equal($sel(h.d).value, 'b-centro');
  assert.equal(taxaNaTela(h), 'R$ 8,50');
  assert.equal(modalVisivel(h), false);
  assert.equal(h.d.activeElement.id, 'cli-numero');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('2b. cancelar: mantém bairro e taxa anteriores e EXIGE conferir antes de enviar', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
  assert.equal(taxaNaTela(h), 'R$ 11,00');
  assert.match(avisoRua(h), /Confira o endereço antes de enviar/);
  clicarEnviar(h);
  assert.equal(h.w.envios, 0, 'Enviar tem de ficar bloqueado');
  assert.ok(h.w.avisos.some((m) => /Confira o endereço/.test(m)));
});

test('2c. depois de cancelar, "Está certo: manter" libera o Enviar e o bairro passa a ser do cliente', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');
  botaoComTexto(h, 'Está certo').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
  // agora é escolha do cliente: outra rua não troca nem abre modal, só avisa
  await digitarEEscolher(h, 'betel');
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
  assert.match(avisoRua(h), /mas você escolheu outro/);
});

test('2d. depois de cancelar, "Rever a troca" abre o modal de novo', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');
  botaoComTexto(h, 'Rever a troca').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(modalVisivel(h), true);
  clicar(h, 'rua-modal-sim');
  assert.equal($sel(h.d).value, 'b-centro');
  assert.equal(taxaNaTela(h), 'R$ 8,50');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('2e. depois de cancelar, o cliente escolher o bairro na mão também libera o Enviar', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');
  escolhaManual(h, 'b-betel');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
  assert.equal(taxaNaTela(h), 'R$ 8,00');
});

test('2f. Esc no modal conta como cancelar', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  h.d.getElementById('rua-modal').dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('2g. com o modal aberto, Enviar não funciona; o scroll da página fica travado e volta depois', async () => {
  const h = montar();
  h.d.body.style.overflow = 'auto';
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(h.d.body.style.overflow, 'hidden');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
  clicar(h, 'rua-modal-nao');
  assert.equal(h.d.body.style.overflow, 'auto');
});

test('2h. aviso de localização aparece no modal só quando o GPS está ativo', async () => {
  const h = montar();
  h.w.freteGps = { payload: () => ({ cliente_lat: -17.9, cliente_lon: -41.5 }) };
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(h.d.getElementById('rua-modal-gps').hidden, false);
  clicar(h, 'rua-modal-nao');

  const h2 = montar();
  h2.w.freteGps = { payload: () => ({}) };
  await digitarEEscolher(h2, 'chile');
  await digitarEEscolher(h2, 'getulio', 0);
  assert.equal(h2.d.getElementById('rua-modal-gps').hidden, true);
});

/* ---------- 3. bairro automático + rua ambígua/sem correspondência ---------- */
test('3. auto + rua ambígua: limpa o bairro automático, zera a taxa, sem modal', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'olavo');
  assert.equal($sel(h.d).value, '');
  assert.equal(taxaNaTela(h), 'R$ 0,00');
  assert.equal(modalVisivel(h), false);
  assert.match(avisoRua(h), /Escolha o seu bairro/);
});

test('3b. auto + sugestão sem vínculo (preenche:false) do mesmo nome de rua: também limpa', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 1); // Fátima, sem vínculo
  assert.equal($sel(h.d).value, '');
  assert.equal(modalVisivel(h), false);
});

test('3c. depois de limpar, a próxima rua segura preenche de novo, sem modal', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'olavo');
  await digitarEEscolher(h, 'betel');
  assert.equal($sel(h.d).value, 'b-betel');
  assert.equal(modalVisivel(h), false);
});

/* ---------- 4. bairro escolhido manualmente ---------- */
test('4. manual + rua de outro bairro seguro: não troca, não abre modal, mostra o aviso já existente', async () => {
  const h = montar();
  escolhaManual(h, 'b-centro');
  await digitarEEscolher(h, 'chile');
  assert.equal($sel(h.d).value, 'b-centro');
  assert.equal(taxaNaTela(h), 'R$ 8,50');
  assert.equal(modalVisivel(h), false);
  assert.match(avisoRua(h), /Essa rua fica no bairro Bela Vista, mas você escolheu outro\. Confira o seu bairro abaixo\./);
  clicarEnviar(h);
  assert.equal(h.w.envios, 1, 'aviso de divergência não bloqueia o envio (comportamento de antes)');
});

test('4b. manual + rua ambígua: NÃO limpa o bairro do cliente', async () => {
  const h = montar();
  escolhaManual(h, 'b-centro');
  await digitarEEscolher(h, 'olavo');
  assert.equal($sel(h.d).value, 'b-centro');
  assert.equal(taxaNaTela(h), 'R$ 8,50');
  assert.equal(modalVisivel(h), false);
});

test('4c. se o cliente mexe no bairro depois do automático, vira manual (nunca mais trocado)', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');   // auto
  escolhaManual(h, 'b-betel');          // cliente muda
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-betel');
});

test('4d. o cliente escolher na mão o MESMO bairro que o automático também vale como manual', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');   // auto: Bela Vista
  escolhaManual(h, 'b-bela');           // confirma na mão
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
});

/* ---------- 5. mesma rua / mesmo bairro ---------- */
test('5. auto + rua do mesmo bairro: não abre modal e nada muda', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'chile');
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
  assert.equal(taxaNaTela(h), 'R$ 11,00');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

/* ---------- 6. controle da origem ---------- */
test('6. depois de enviar o pedido, a origem é reiniciada: bairro preenchido por fora volta a valer como GPS', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');           // auto = b-bela
  $sel(h.d).value = '';                         // o index faz isso ao concluir o pedido
  h.w.atualizarTaxa();                          // e chama atualizarTaxa()
  $sel(h.d).value = 'b-bela';                   // o GPS preenche o MESMO bairro, sem evento
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true, 'não é mais "automático": é GPS, e o GPS só troca com confirmação');
  assert.equal($sel(h.d).value, 'b-bela');
});

test('6b. bairro vazio de novo (cliente escolheu "Selecione...") volta a poder ser preenchido', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  escolhaManual(h, '');
  await digitarEEscolher(h, 'betel');
  assert.equal($sel(h.d).value, 'b-betel');
  assert.equal(modalVisivel(h), false);
});

/* ---------- 7. retirada e trava ---------- */
test('7. na retirada a trava de conferência não impede o envio', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');
  h.w.modoEntrega = 'retirada';
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('7b. nova escolha de rua zera a conferência anterior', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');                   // conferência pendente
  await digitarEEscolher(h, 'chile');           // volta para a rua do bairro atual
  assert.equal(modalVisivel(h), false);
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('7c. se o bairro mudar por fora da conferência pendente, a trava cai', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');
  $sel(h.d).value = '';                         // sem evento (como depois de um pedido)
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

/* ---------- 8. dados e IDs ---------- */
test('8. a tela não mexe em montarEndereco/IDs: campos existentes continuam lá', () => {
  const h = montar();
  for (const id of ['cli-rua', 'cli-numero', 'cli-sem-numero', 'cli-compl', 'cli-endereco', 'select-bairro', 'val-taxa', 'val-tempo', 'gps-slot', 'bloco-endereco']) {
    assert.ok(h.d.getElementById(id), `#${id} sumiu`);
  }
});

/* =====================================================================
   NOVOS: rua editada sem sugestão, GPS como origem própria, teclado
   ===================================================================== */

// edita o texto da rua como se o cliente digitasse, SEM escolher sugestão
function editarRua(h, texto) {
  const campo = h.d.getElementById('cli-rua');
  campo.focus();
  campo.value = texto;
  campo.dispatchEvent(new h.w.Event('input', { bubbles: true }));
}
// imita o preencherLugar do frete-gps.js: bairro SEM evento, depois a rua (se vazia) com evento input
function gpsPreenche(h, idBairro, ruaTexto) {
  $sel(h.d).value = idBairro;
  h.w.atualizarTaxa(); // na página real o fluxo do GPS também atualiza a taxa mostrada
  const campo = h.d.getElementById('cli-rua');
  if (ruaTexto && campo.value.trim() === '') {
    campo.value = ruaTexto;
    campo.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  }
}
async function sairDoCampo(h) {
  h.d.getElementById('cli-rua').dispatchEvent(new h.w.Event('blur'));
  await esperar(200);
}
const botaoAviso = (h, trecho) => botaoComTexto(h, trecho);
const apertar = (h, el, tecla) => el.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: tecla, bubbles: true, cancelable: true }));

/* ---------- 9. rua editada sem escolher sugestão (bairro automático) ---------- */
test('9. edição parcial: tirar uma letra bloqueia o Enviar e NÃO limpa o bairro nem a taxa', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');        // auto: Bela Vista
  editarRua(h, 'Rua Chil');
  assert.equal($sel(h.d).value, 'b-bela', 'não pode limpar enquanto digita');
  assert.equal(taxaNaTela(h), 'R$ 11,00');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
  assert.ok(h.w.avisos.some((m) => /Você mudou a rua/.test(m)));
  assert.match(avisoRua(h), /Você mudou a rua\. Confira se o bairro Bela Vista \(R\$ 11,00\) ainda está certo/);
});

test('9b. apagar a rua inteira bloqueia o Enviar e mantém o bairro', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, '');
  assert.equal($sel(h.d).value, 'b-bela');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('9c. substituir por outra rua digitada (sem sugestão) bloqueia o Enviar', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Totalmente Outra');
  assert.equal($sel(h.d).value, 'b-bela');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('9d. digitar de novo (ou voltar ao texto original) NÃO libera o envio', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  editarRua(h, 'Rua Outra Coisa');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
  editarRua(h, 'Rua Chile');                 // voltou ao texto original
  clicarEnviar(h);
  assert.equal(h.w.envios, 0, 'voltar ao texto original não é conferência');
});

test('9e. mexer só em maiúsculas, espaços ou pontuação não conta como mudar a rua', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, '  RUA   chile. ');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('9f. ao sair do campo sem escolher sugestão aparece o aviso com os dois caminhos', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  assert.equal(avisoRua(h), '', 'enquanto digita não aparece aviso (não atrapalha quem vai escolher da lista)');
  await sairDoCampo(h);
  assert.match(avisoRua(h), /Você mudou a rua/);
  assert.ok(botaoAviso(h, 'Está certo: manter Bela Vista'));
  assert.ok(botaoAviso(h, 'Escolher outro bairro'));
});

test('9g. "Está certo: manter" libera o Enviar e o bairro vira manual', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  await sairDoCampo(h);
  botaoAviso(h, 'Está certo: manter').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
  assert.equal($sel(h.d).value, 'b-bela');
  await digitarEEscolher(h, 'betel');        // manual: nunca troca, só avisa
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
});

test('9h. escolher outro bairro no select libera o Enviar', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  await sairDoCampo(h);
  botaoAviso(h, 'Escolher outro bairro').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(h.d.activeElement.id, 'select-bairro');
  escolhaManual(h, 'b-betel');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
  assert.equal(taxaNaTela(h), 'R$ 8,00');
});

test('9i. escolher uma sugestão do MESMO bairro libera o Enviar', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  await digitarEEscolher(h, 'chile');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
  assert.equal($sel(h.d).value, 'b-bela');
});

test('9j. escolher sugestão de OUTRO bairro abre o modal (Enviar segue bloqueado até decidir)', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true);
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
  clicar(h, 'rua-modal-sim');
  assert.equal($sel(h.d).value, 'b-centro');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('9k. escolher sugestão ambígua limpa o bairro automático; sem bairro, a trava de edição cai', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  await digitarEEscolher(h, 'olavo');
  assert.equal($sel(h.d).value, '');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1, 'a trava só cuida do bairro automático; o bairro vazio é barrado pela validação do index');
});

test('9l. editar a rua com bairro MANUAL não bloqueia nada', async () => {
  const h = montar();
  escolhaManual(h, 'b-centro');
  editarRua(h, 'Qualquer Rua');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('9m. na retirada a trava de rua editada não impede o envio', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  h.w.modoEntrega = 'retirada';
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('9n. depois de enviar o pedido (select esvaziado sem evento) a trava de edição cai', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  $sel(h.d).value = '';
  h.w.atualizarTaxa();
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('9o. rua editada depois de "cancelar a troca": a conferência antiga é descartada e o Enviar segue bloqueado', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');                // conferência pendente
  assert.ok(botaoAviso(h, 'Rever a troca'));
  editarRua(h, 'Avenida Getulio Varg');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
  assert.doesNotMatch(avisoRua(h), /Confira o endereço antes de enviar/, 'o aviso da troca antiga não vale mais');
  assert.match(avisoRua(h), /Você mudou a rua/);
  assert.equal(botaoAviso(h, 'Rever a troca'), undefined, 'sem botão de rever: a decisão antiga era de outra rua');
});

/* ---------- 10. GPS como origem própria ---------- */
test('10. GPS + sugestão de OUTRO bairro: abre o modal (não troca sozinho) e menciona a localização', async () => {
  const h = montar();
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true);
  assert.equal($sel(h.d).value, 'b-bela', 'nada muda antes da decisão');
  const t = textoModal(h);
  assert.match(t, /veio da sua localização/);
  assert.match(t, /Bela Vista/);
  assert.match(t, /R\$ 11,00/);
  assert.match(t, /Centro/);
  assert.match(t, /R\$ 8,50/);
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('10a. GPS + confirmar a troca: bairro e taxa mudam juntos e a origem passa a ser autocomplete', async () => {
  const h = montar();
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-sim');
  assert.equal($sel(h.d).value, 'b-centro');
  assert.equal(taxaNaTela(h), 'R$ 8,50');
  // prova de que virou autocomplete: editar a rua agora trava o Enviar (regra do bairro automático)
  editarRua(h, 'Avenida Getulio Varg');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
  // e outra rua de outro bairro, com cancelar, exige conferência (comportamento do automático)
  await digitarEEscolher(h, 'betel');
  assert.equal(modalVisivel(h), true);
  clicar(h, 'rua-modal-nao');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('10b. GPS + manter: o bairro do GPS fica, vira manual e o Enviar NÃO fica travado', async () => {
  const h = montar();
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
  assert.equal(taxaNaTela(h), 'R$ 11,00');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
  // agora é manual: outra rua só avisa
  await digitarEEscolher(h, 'betel');
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
  assert.match(avisoRua(h), /mas você escolheu outro/);
});

test('10c. GPS + Esc no modal equivale a manter (vira manual)', async () => {
  const h = montar();
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  await digitarEEscolher(h, 'getulio', 0);
  h.d.getElementById('rua-modal').dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($sel(h.d).value, 'b-bela');
  await digitarEEscolher(h, 'betel');
  assert.equal(modalVisivel(h), false);
});

test('10d. GPS + rua ambígua: NÃO apaga o bairro do GPS, sem modal', async () => {
  const h = montar();
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  await digitarEEscolher(h, 'olavo');
  assert.equal($sel(h.d).value, 'b-bela');
  assert.equal(taxaNaTela(h), 'R$ 11,00');
  assert.equal(modalVisivel(h), false);
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('10e. GPS + sugestão do MESMO bairro: nada acontece', async () => {
  const h = montar();
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  await digitarEEscolher(h, 'chile');
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
});

test('10f. GPS + cliente escolhe outro bairro direto: vira manual (rua nunca mais troca)', async () => {
  const h = montar();
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  escolhaManual(h, 'b-betel');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-betel');
});

test('10g. GPS + editar a rua digitando: NÃO trava (o bairro veio da localização, não da rua)', async () => {
  const h = montar();
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  editarRua(h, 'Rua do GPS 2');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
  assert.equal($sel(h.d).value, 'b-bela');
});

test('10h. com o GPS ativo o modal avisa que a taxa final segue a distância', async () => {
  const h = montar();
  h.w.freteGps = { payload: () => ({ cliente_lat: -17.9, cliente_lon: -41.5 }) };
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(h.d.getElementById('rua-modal-gps').hidden, false);
});

test('10i. as 4 origens: vazio preenche (auto), auto pede modal, GPS pede modal, manual só avisa', async () => {
  // vazio -> auto sem modal
  let h = montar();
  await digitarEEscolher(h, 'chile');
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
  // auto -> modal
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true);
  // gps -> modal
  h = montar();
  gpsPreenche(h, 'b-bela', 'Rua GPS');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true);
  // manual -> só aviso
  h = montar();
  escolhaManual(h, 'b-bela');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), false);
  assert.match(avisoRua(h), /mas você escolheu outro/);
});

/* ---------- 11. envio por teclado ---------- */
test('11. não existe <form> nem tratamento de Enter que envie o pedido (premissa da trava)', () => {
  assert.ok(!/<form[\s>]/i.test(INDEX), 'apareceu um <form> no index.html: o Enter poderia enviar sem passar pelo botão');
  assert.ok(/<button id="btn-enviar" type="button">/.test(INDEX), '#btn-enviar tem de ser type="button"');
});

test('11b. Enter e Espaço no botão focado (que geram clique) ficam bloqueados com conferência pendente', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  const btn = h.d.getElementById('btn-enviar');
  btn.focus();
  apertar(h, btn, 'Enter');
  btn.click();                                // é o que o navegador faz ao ativar o botão pelo teclado
  apertar(h, btn, ' ');
  btn.click();
  assert.equal(h.w.envios, 0);
});

test('11c. com o modal aberto, ativar o botão pelo teclado também não envia', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  const btn = h.d.getElementById('btn-enviar');
  btn.focus();
  apertar(h, btn, 'Enter');
  btn.click();
  assert.equal(h.w.envios, 0);
});

test('11d. Enter nos campos de endereço não envia o pedido', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  for (const id of ['cli-rua', 'cli-numero', 'cli-compl']) {
    h.d.getElementById(id).focus();
    apertar(h, h.d.getElementById(id), 'Enter');
  }
  assert.equal(h.w.envios, 0);
});

test('11e. depois de resolver a pendência, o mesmo botão pelo teclado envia', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');
  const btn = h.d.getElementById('btn-enviar');
  btn.click();
  assert.equal(h.w.envios, 0);
  escolhaManual(h, 'b-betel');
  btn.click();
  assert.equal(h.w.envios, 1);
});

/* =====================================================================
   CORREÇÃO 1: GPS reconhecido de forma explícita (inclusive o MESMO bairro do autocomplete)
   ===================================================================== */
// autocomplete põe o bairro; DEPOIS algo preenche por fora o mesmo bairro, sem esvaziar antes,
// sem evento change e sem atualizarTaxa (é o caso que a dedução antiga classificava como "auto")
async function autoDepoisGpsMesmoBairro(h) {
  await digitarEEscolher(h, 'chile');        // autocomplete: b-bela
  $sel(h.d).value = 'b-bela';                // preenchimento externo (GPS), mesmo valor, sem evento
}

test('12. autocomplete + GPS preenche o MESMO bairro: vira GPS e outra rua de outro bairro abre modal de GPS', async () => {
  const h = montar();
  await autoDepoisGpsMesmoBairro(h);
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true);
  assert.match(textoModal(h), /veio da sua localização/, 'tem de tratar como GPS, não como autocomplete');
  assert.equal($sel(h.d).value, 'b-bela');
});

test('12a. nesse caso, "manter" vira manual e NÃO exige conferência (regra do GPS)', async () => {
  const h = montar();
  await autoDepoisGpsMesmoBairro(h);
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-nao');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1, 'se fosse autocomplete, cancelar travaria o Enviar');
  assert.equal($sel(h.d).value, 'b-bela');
});

test('12b. nesse caso, rua ambígua NÃO apaga o bairro do GPS', async () => {
  const h = montar();
  await autoDepoisGpsMesmoBairro(h);
  await digitarEEscolher(h, 'olavo');
  assert.equal($sel(h.d).value, 'b-bela', 'se fosse autocomplete, o bairro seria apagado');
  assert.equal(taxaNaTela(h), 'R$ 11,00');
  assert.equal(modalVisivel(h), false);
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('12c. nesse caso, editar a rua digitando NÃO trava o Enviar (o bairro é do GPS)', async () => {
  const h = montar();
  await autoDepoisGpsMesmoBairro(h);
  editarRua(h, 'Rua Qualquer');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('12d. nesse caso, sugestão do mesmo bairro não faz nada', async () => {
  const h = montar();
  await autoDepoisGpsMesmoBairro(h);
  await digitarEEscolher(h, 'chile');
  assert.equal(modalVisivel(h), false);
  assert.equal($sel(h.d).value, 'b-bela');
});

test('12e. nesse caso, confirmar a troca vira autocomplete (editar a rua passa a travar)', async () => {
  const h = montar();
  await autoDepoisGpsMesmoBairro(h);
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-sim');
  assert.equal($sel(h.d).value, 'b-centro');
  editarRua(h, 'Avenida Getulio Varg');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('12f. preenchimento externo com valor DIFERENTE do autocomplete também vira GPS', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');        // auto: b-bela
  $sel(h.d).value = 'b-betel';               // GPS troca por fora
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true);
  assert.match(textoModal(h), /veio da sua localização/);
  assert.equal($sel(h.d).value, 'b-betel');
});

test('12g. esvaziar por fora derruba a trava de rua editada e a conferência pendente', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chil');                  // rua editada pendente
  $sel(h.d).value = '';                      // esvaziou por fora (sem atualizarTaxa)
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('12h. o vigia só age no select-bairro: outro <select> continua normal e não mexe na origem', async () => {
  const h = montar();
  const outro = h.d.createElement('select');
  outro.innerHTML = '<option value="">-</option><option value="z">z</option>';
  h.d.body.appendChild(outro);
  await digitarEEscolher(h, 'chile');        // auto: b-bela
  outro.value = 'z';
  assert.equal(outro.value, 'z', 'o outro select funciona normalmente');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true);
  assert.doesNotMatch(textoModal(h), /veio da sua localização/, 'a origem continua autocomplete');
});

test('12i. nossas próprias trocas (preencher, limpar, confirmar) não são confundidas com GPS', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);
  clicar(h, 'rua-modal-sim');                // troca nossa -> b-centro (auto)
  await digitarEEscolher(h, 'betel');        // outro bairro seguro -> modal de AUTO
  assert.equal(modalVisivel(h), true);
  assert.doesNotMatch(textoModal(h), /veio da sua localização/);
  clicar(h, 'rua-modal-nao');
  await digitarEEscolher(h, 'olavo');        // ambígua com auto: nós limpamos
  assert.equal($sel(h.d).value, '');
  await digitarEEscolher(h, 'chile');        // e preenche de novo, ainda como auto
  assert.equal($sel(h.d).value, 'b-bela');
  await digitarEEscolher(h, 'getulio', 0);
  assert.doesNotMatch(textoModal(h), /veio da sua localização/);
});

/* =====================================================================
   CORREÇÃO 2: "Rever a troca" não pode reaproveitar decisão de OUTRA rua
   ===================================================================== */
async function cancelarTroca2(h) {
  await digitarEEscolher(h, 'chile');
  await digitarEEscolher(h, 'getulio', 0);   // sugestão: Avenida Getulio Vargas -> Centro
  clicar(h, 'rua-modal-nao');                // cancelou: bairro segue Bela Vista
}

test('13. cancelar, editar a rua sem sugestão: o botão "Rever a troca" some e o Enviar segue bloqueado', async () => {
  const h = montar();
  await cancelarTroca2(h);
  editarRua(h, 'Rua Totalmente Outra');
  await sairDoCampo(h);
  assert.equal(botaoAviso(h, 'Rever a troca'), undefined);
  assert.ok(botaoAviso(h, 'Está certo: manter Bela Vista'));
  assert.match(avisoRua(h), /Você mudou a rua/);
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('13b. botão "Rever a troca" antigo (guardado antes da edição) não abre modal com a rua nova', async () => {
  const h = montar();
  await cancelarTroca2(h);
  const antigo = botaoAviso(h, 'Rever a troca');
  editarRua(h, 'Rua Totalmente Outra');
  antigo.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(modalVisivel(h), false, 'não pode associar o bairro da sugestão antiga a outra rua');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('13c. mesmo que o texto mude SEM evento de digitação, "Rever a troca" confere a rua antes de abrir', async () => {
  const h = montar();
  await cancelarTroca2(h);
  const antigo = botaoAviso(h, 'Rever a troca');
  h.d.getElementById('cli-rua').value = 'Rua Trocada Por Fora';   // sem evento input
  antigo.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(modalVisivel(h), false);
  clicarEnviar(h);
  assert.equal(h.w.envios, 0, 'a rua mudou: segue exigindo conferência');
});

test('13d. só maiúscula, espaço ou pontuação NÃO invalida: "Rever a troca" ainda reabre o modal da rua certa', async () => {
  const h = montar();
  await cancelarTroca2(h);
  editarRua(h, '  AVENIDA getulio   vargas. ');
  const rever = botaoAviso(h, 'Rever a troca');
  assert.ok(rever, 'a conferência continua válida');
  rever.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(modalVisivel(h), true);
  assert.match(textoModal(h), /Avenida Getulio Vargas/);
  assert.match(textoModal(h), /Centro/);
});

test('13e. editar e voltar ao texto original NÃO ressuscita o "Rever a troca" nem libera o envio', async () => {
  const h = montar();
  await cancelarTroca2(h);
  editarRua(h, 'Avenida Getulio Varg');
  editarRua(h, 'Avenida Getulio Vargas');    // voltou ao texto da sugestão
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
  assert.equal(botaoAviso(h, 'Rever a troca'), undefined);
  assert.match(avisoRua(h), /Você mudou a rua/);
});

test('13f. depois de editar, escolher NOVA sugestão de outro bairro abre modal com a rua NOVA (nunca a antiga)', async () => {
  const h = montar();
  await cancelarTroca2(h);
  editarRua(h, 'Rua Totalmente Outra');
  await digitarEEscolher(h, 'betel');        // Rua Betel -> Vila Betel
  assert.equal(modalVisivel(h), true);
  const t = textoModal(h);
  assert.match(t, /Rua Betel/);
  assert.match(t, /Vila Betel/);
  assert.doesNotMatch(t, /Getulio/);
  assert.doesNotMatch(t, /Centro/);
  clicar(h, 'rua-modal-sim');
  assert.equal($sel(h.d).value, 'b-betel');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('13g. depois de editar, "Está certo: manter" libera e vira manual', async () => {
  const h = montar();
  await cancelarTroca2(h);
  editarRua(h, 'Rua Totalmente Outra');
  await sairDoCampo(h);
  botaoAviso(h, 'Está certo: manter').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
  assert.equal($sel(h.d).value, 'b-bela');
});

test('13h. depois de editar, escolher outro bairro no select libera', async () => {
  const h = montar();
  await cancelarTroca2(h);
  editarRua(h, 'Rua Totalmente Outra');
  escolhaManual(h, 'b-betel');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

test('13i. depois de editar, escolher sugestão do mesmo bairro atual libera', async () => {
  const h = montar();
  await cancelarTroca2(h);
  editarRua(h, 'Rua Totalmente Outra');
  await digitarEEscolher(h, 'chile');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

/* =====================================================================
   AJUSTE 1: rua original (colar OU digitar) dá o MESMO resultado: bloqueado até nova decisão
   ===================================================================== */
const colarOriginal = (h) => editarRua(h, 'Rua Chile');                 // um único evento de input
const digitarOriginal = (h) => {                                        // apaga e digita letra a letra
  editarRua(h, '');
  const texto = 'Rua Chile';
  for (let i = 1; i <= texto.length; i += 1) editarRua(h, texto.slice(0, i));
};
const FLUXOS_ORIGINAL = [['colando', colarOriginal], ['digitando', digitarOriginal]];

async function resultadoDepoisDeVoltar(fluxo) {
  const h = montar();
  await cancelarTroca2(h);                   // auto: Bela Vista (rua original "Rua Chile"); troca cancelada
  fluxo(h);
  assert.equal(h.d.getElementById('cli-rua').value, 'Rua Chile');
  clicarEnviar(h);
  await sairDoCampo(h);
  return {
    envios: h.w.envios,
    bairro: $sel(h.d).value,
    taxa: taxaNaTela(h),
    aviso: avisoRua(h),
    rever: !!botaoAviso(h, 'Rever a troca'),
    manter: !!botaoAviso(h, 'Está certo: manter Bela Vista'),
    outro: !!botaoAviso(h, 'Escolher outro bairro'),
    modal: modalVisivel(h)
  };
}

test('14. voltar à rua original colando e digitando produzem EXATAMENTE o mesmo resultado (bloqueado)', async () => {
  const colando = await resultadoDepoisDeVoltar(colarOriginal);
  const digitando = await resultadoDepoisDeVoltar(digitarOriginal);
  assert.deepEqual(colando, digitando);
  assert.equal(colando.envios, 0, 'Enviar bloqueado');
  assert.equal(colando.bairro, 'b-bela', 'não limpa o bairro');
  assert.equal(colando.taxa, 'R$ 11,00');
  assert.match(colando.aviso, /Você mudou a rua/);
  assert.equal(colando.rever, false, 'sem botão de rever: a decisão antiga era de outra rua');
  assert.equal(colando.manter, true);
  assert.equal(colando.outro, true);
  assert.equal(colando.modal, false);
});

for (const [nome, fluxo] of FLUXOS_ORIGINAL) {
  test(`14a. (${nome}) "Está certo: manter" libera e o bairro vira manual`, async () => {
    const h = montar();
    await cancelarTroca2(h);
    fluxo(h);
    clicarEnviar(h);
    assert.equal(h.w.envios, 0);
    await sairDoCampo(h);
    botaoAviso(h, 'Está certo: manter').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
    clicarEnviar(h);
    assert.equal(h.w.envios, 1);
    await digitarEEscolher(h, 'betel');      // manual: outra rua só avisa
    assert.equal(modalVisivel(h), false);
    assert.equal($sel(h.d).value, 'b-bela');
  });

  test(`14b. (${nome}) escolher outro bairro no select libera`, async () => {
    const h = montar();
    await cancelarTroca2(h);
    fluxo(h);
    clicarEnviar(h);
    assert.equal(h.w.envios, 0);
    escolhaManual(h, 'b-betel');
    clicarEnviar(h);
    assert.equal(h.w.envios, 1);
    assert.equal(taxaNaTela(h), 'R$ 8,00');
  });

  test(`14c. (${nome}) escolher uma nova sugestão (mesmo bairro) libera`, async () => {
    const h = montar();
    await cancelarTroca2(h);
    fluxo(h);
    clicarEnviar(h);
    assert.equal(h.w.envios, 0);
    await digitarEEscolher(h, 'chile');
    clicarEnviar(h);
    assert.equal(h.w.envios, 1);
    assert.equal($sel(h.d).value, 'b-bela');
  });

  test(`14d. (${nome}) escolher uma nova sugestão de OUTRO bairro abre o modal e, ao decidir, libera`, async () => {
    const h = montar();
    await cancelarTroca2(h);
    fluxo(h);
    await digitarEEscolher(h, 'betel');
    assert.equal(modalVisivel(h), true);
    clicarEnviar(h);
    assert.equal(h.w.envios, 0);
    clicar(h, 'rua-modal-sim');
    clicarEnviar(h);
    assert.equal(h.w.envios, 1);
    assert.equal($sel(h.d).value, 'b-betel');
  });
}

test('14e. texto trocado SEM evento de digitação e depois "voltado" ao original: o Enviar já cria a trava', async () => {
  const h = montar();
  await cancelarTroca2(h);
  const campo = h.d.getElementById('cli-rua');
  campo.value = 'Rua Chile';                // direto, sem evento: é o texto da rua original
  clicarEnviar(h);
  assert.equal(h.w.envios, 0, 'a conferência antiga era de outra rua: vira trava de rua editada');
  assert.match(avisoRua(h), /Você mudou a rua/);
  campo.value = 'Rua Chile';
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('14f. repetir o mesmo texto da sugestão (sem mudar a rua) NÃO descarta a conferência', async () => {
  const h = montar();
  await cancelarTroca2(h);
  editarRua(h, 'Avenida Getulio Vargas');   // mesmo texto: não é edição
  assert.ok(botaoAviso(h, 'Rever a troca'), 'a conferência continua válida');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0);
});

test('14g. sem troca cancelada, colar o texto idêntico à rua do bairro não cria trava nenhuma', async () => {
  const h = montar();
  await digitarEEscolher(h, 'chile');
  editarRua(h, 'Rua Chile');                // idêntico: nada mudou
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
});

/* =====================================================================
   AJUSTE 2: o vigia do select nunca pode derrubar o resto do script nem a atribuição nativa
   ===================================================================== */
async function conferirScriptVivo(h) {
  // autocomplete, modal e trava do Enviar seguem funcionando
  await digitarEEscolher(h, 'chile');
  assert.equal($sel(h.d).value, 'b-bela');
  assert.equal(taxaNaTela(h), 'R$ 11,00');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true);
  clicar(h, 'rua-modal-nao');
  clicarEnviar(h);
  assert.equal(h.w.envios, 0, 'trava do Enviar ativa');
  botaoAviso(h, 'Está certo').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  clicarEnviar(h);
  assert.equal(h.w.envios, 1);
}

test('15. instalação do vigia falha (defineProperty lança): o resto do script segue e avisa no console', async () => {
  let original;
  const h = montar({
    antes: (w) => { original = w.Object.defineProperty; w.Object.defineProperty = () => { throw new Error('bloqueado'); }; },
    depois: (w) => { w.Object.defineProperty = original; }
  });
  assert.equal(h.w.avisosConsole.length, 1);
  assert.match(h.w.avisosConsole[0], /vigia do select indisponível/);
  await conferirScriptVivo(h);
});

test('15a. sem o vigia, preenchimento externo com valor diferente ainda é tratado como GPS (dedução)', async () => {
  let original;
  const h = montar({
    antes: (w) => { original = w.Object.defineProperty; w.Object.defineProperty = () => { throw new Error('bloqueado'); }; },
    depois: (w) => { w.Object.defineProperty = original; }
  });
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true);
  assert.match(textoModal(h), /veio da sua localização/);
  assert.equal($sel(h.d).value, 'b-bela');
  clicar(h, 'rua-modal-nao');
  clicarEnviar(h);
  assert.equal(h.w.envios, 1, 'GPS + manter: sem trava, como com o vigia');
});

test('15b. propriedade value não configurável (ambiente bloqueado): o script segue sem o vigia', async () => {
  const h = montar({
    antes: (w) => {
      const proto = w.HTMLSelectElement.prototype;
      const d0 = Object.getOwnPropertyDescriptor(proto, 'value');
      Object.defineProperty(proto, 'value', { ...d0, configurable: false });
    }
  });
  await conferirScriptVivo(h);
});

test('15c. falha DEPOIS da atribuição nativa: nenhum erro chega a quem atribuiu e o valor foi aplicado', async () => {
  const h = montar({
    antes: (w) => {
      // simula outro script/extensão cujo getter passa a lançar: o setter do vigia lê o valor depois de atribuir
      const proto = w.HTMLSelectElement.prototype;
      const d0 = Object.getOwnPropertyDescriptor(proto, 'value');
      w.__getterQuebra = false;
      Object.defineProperty(proto, 'value', {
        configurable: true,
        enumerable: d0.enumerable,
        get() { if (w.__getterQuebra) throw new Error('getter quebrou'); return d0.get.call(this); },
        set(v) { d0.set.call(this, v); }
      });
    }
  });
  const sel = $sel(h.d);
  const indiceAntes = sel.selectedIndex;
  h.w.__getterQuebra = true;
  assert.doesNotThrow(() => { sel.value = 'b-bela'; }, 'a atribuição não pode lançar por falha do registro');
  const indiceDepois = sel.selectedIndex;   // não usa o getter de value
  h.w.__getterQuebra = false;
  assert.notEqual(indiceDepois, indiceAntes, 'a atribuição nativa foi aplicada');
  assert.equal(sel.options[indiceDepois].value, 'b-bela');
  // e o resto do script continua funcionando depois disso
  await digitarEEscolher(h, 'getulio', 0);
  assert.equal(modalVisivel(h), true, 'valor externo não registrado cai na dedução: GPS');
});

test('15d. o esvaziamento do index depois do pedido (select.value = "") não lança mesmo com o registro falhando', async () => {
  const h = montar({
    antes: (w) => {
      const proto = w.HTMLSelectElement.prototype;
      const d0 = Object.getOwnPropertyDescriptor(proto, 'value');
      w.__getterQuebra = false;
      Object.defineProperty(proto, 'value', {
        configurable: true,
        enumerable: d0.enumerable,
        get() { if (w.__getterQuebra) throw new Error('getter quebrou'); return d0.get.call(this); },
        set(v) { d0.set.call(this, v); }
      });
    }
  });
  await digitarEEscolher(h, 'chile');
  const sel = $sel(h.d);
  h.w.__getterQuebra = true;
  assert.doesNotThrow(() => { sel.value = ''; });
  const idx = sel.selectedIndex;
  h.w.__getterQuebra = false;
  assert.equal(idx, 0, 'select esvaziado (opção "Selecione")');
  assert.doesNotThrow(() => h.w.atualizarTaxa());
});

test('15e. caminho normal: o vigia continua instalado e sem aviso de console', async () => {
  const h = montar();
  assert.equal(h.w.avisosConsole.length, 0);
  gpsPreenche(h, 'b-bela', 'Rua do GPS');
  await digitarEEscolher(h, 'getulio', 0);
  assert.match(textoModal(h), /veio da sua localização/);
});
