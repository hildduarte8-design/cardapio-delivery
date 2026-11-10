// Tela "Financeiro" (dentro de Gestão): vendas do mês, despesas e resultado estimado.
// Tabelas: custos_periodos (uma por restaurante + categoria + mês) e custos_lancamentos
// (compras individuais). Veja sql/09_custos_despesas.sql.
//
// Regra do resultado: vendas de PRODUTOS menos despesas lançadas.
// As taxas de entrega aparecem à parte e não entram nessa conta.
import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, brl, esc, aviso, tratarErro } from './admin-utils.js';

const CATEGORIAS = [
  ['insumos', 'Ingredientes e insumos'],
  ['embalagens', 'Embalagens'],
  ['energia', 'Energia elétrica'],
  ['gas', 'Gás'],
  ['agua', 'Água'],
  ['funcionarios', 'Funcionários'],
  ['aluguel', 'Aluguel'],
  ['taxas', 'Taxas e tarifas'],
  ['marketing', 'Marketing'],
  ['outros', 'Outras despesas']
];

const TAMANHO_PAGINA = 1000; // limite de linhas por consulta do Supabase
const MAX_PAGINAS = 20;      // trava de segurança: até 20.000 pedidos no mês

let mesAtual = chaveMes(new Date());
let periodos = [];
let lancamentos = [];
let pedidos = [];
let pedidosTruncados = false;
let sequencia = 0;       // só o carregamento mais recente pode atualizar a tela
let ocupado = false;     // trava contra duplo clique nos botões de salvar/excluir
let montado = false;

// ---------- Utilidades ----------

function chaveMes(data) {
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
}

function intervaloMes(mes) {
  const [ano, numero] = mes.split('-').map(Number);
  return {
    inicio: new Date(ano, numero - 1, 1),
    fim: new Date(ano, numero, 1),
    competencia: `${mes}-01`,
    ultimoDia: `${mes}-${String(new Date(ano, numero, 0).getDate()).padStart(2, '0')}`
  };
}

const centavos = (valor) => Math.round((Number(valor) || 0) * 100);
const reais = (c) => brl.format((c || 0) / 100);

function categoriaNome(valor) {
  return CATEGORIAS.find(([id]) => id === valor)?.[1] || valor;
}

function nomeDoMes(mes) {
  const { inicio } = intervaloMes(mes);
  const texto = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(inicio);
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function opcoesCategorias() {
  return CATEGORIAS.map(([id, nome]) => `<option value="${id}">${nome}</option>`).join('');
}

// Mesma regra do Painel: vale tudo que não foi cancelado e não está esperando Pix
function forma(p) {
  return String(p.forma_pagamento || '').trim().toLowerCase();
}
function pagaNaEntrega(p) {
  return p.status === 'pendente_pagamento' && ['dinheiro', 'cartao', 'cartão'].includes(forma(p));
}
function ehVenda(p) {
  return p.status !== 'cancelado' && (p.status !== 'pendente_pagamento' || pagaNaEntrega(p));
}

function valorLancamento(item) {
  return centavos(item.valor);
}

function totalDoPeriodo(periodo) {
  if (periodo.modo === 'consolidado') return centavos(periodo.valor_consolidado);

  return lancamentos
    .filter((item) => item.periodo_id === periodo.id)
    .reduce((soma, item) => soma + valorLancamento(item), 0);
}

// ---------- Cálculo ----------

// O desconto abate primeiro a taxa de entrega (é o caso do "frete grátis") e só o que
// sobrar abate os produtos. Assim "produtos + taxa líquida" sempre fecha com o total.
function calcularVendas() {
  const vendas = pedidos.filter(ehVenda);

  let produtos = 0;
  let taxas = 0;
  let total = 0;

  vendas.forEach((p) => {
    const subtotal = centavos(p.subtotal);
    const taxa = centavos(p.taxa_entrega);
    const desconto = centavos(p.desconto);

    const descontoNaTaxa = Math.min(desconto, taxa);
    const descontoNosProdutos = desconto - descontoNaTaxa;

    produtos += Math.max(0, subtotal - descontoNosProdutos);
    taxas += taxa - descontoNaTaxa;
    total += centavos(p.total);
  });

  return { quantidade: vendas.length, produtos, taxas, total };
}

// ---------- Estrutura fixa da tela (montada uma vez) ----------

function montarEstrutura() {
  if (montado) return;

  const raiz = $('custos-conteudo');
  if (!raiz) return;

  raiz.innerHTML = `
    <div class="dash-topo">
      <div>
        <h2>Financeiro</h2>
        <span class="dash-d">Vendas, despesas e resultado do mês</span>
      </div>
      <button type="button" class="dash-btn" data-custos-atualizar>Atualizar</button>
    </div>

    <section class="secao-admin">
      <h3 class="secao-titulo">Mês</h3>
      <div class="custos-mes-linha">
        <button type="button" class="dash-btn" data-custos-mes="-1" aria-label="Mês anterior">◀</button>
        <input id="custos-mes" class="input-padrao" type="month" aria-label="Selecionar mês" />
        <button type="button" class="dash-btn" data-custos-mes="1" aria-label="Próximo mês">▶</button>
      </div>
    </section>

    <div id="custos-resumo"></div>

    <section class="secao-admin">
      <h3 class="secao-titulo">Registrar despesa</h3>
      <p class="secao-desc">Para compras e contas lançadas uma a uma.</p>

      <form id="form-custo-individual" novalidate>
        <div class="form-grupo">
          <label for="custo-categoria">Categoria</label>
          <select id="custo-categoria" class="input-padrao">${opcoesCategorias()}</select>
        </div>

        <div class="form-grupo">
          <label for="custo-descricao">Descrição</label>
          <input id="custo-descricao" class="input-padrao" maxlength="100" autocomplete="off" placeholder="Ex.: Compra de mussarela" />
        </div>

        <div class="grid-2">
          <div class="form-grupo">
            <label for="custo-valor">Valor (R$)</label>
            <input id="custo-valor" class="input-padrao" type="number" min="0.01" max="9999999999" step="0.01" inputmode="decimal" />
          </div>
          <div class="form-grupo">
            <label for="custo-data">Data</label>
            <input id="custo-data" class="input-padrao" type="date" />
          </div>
        </div>

        <div class="form-grupo">
          <label for="custo-observacao">Observação (opcional)</label>
          <input id="custo-observacao" class="input-padrao" maxlength="500" autocomplete="off" placeholder="Detalhes adicionais" />
        </div>

        <button id="btn-custo-salvar" class="btn-destaque" type="submit">Registrar despesa</button>
      </form>
    </section>

    <section class="secao-admin">
      <h3 class="secao-titulo">Total do mês por categoria</h3>
      <p class="secao-desc">
        Para informar só o total da categoria no mês, sem cadastrar cada compra.
        Uma categoria usa um formato por mês: ou compras individuais, ou o total.
        Para trocar, remova o que já foi lançado nela.
      </p>

      <form id="form-custo-consolidado" novalidate>
        <div class="form-grupo">
          <label for="custo-consolidado-categoria">Categoria</label>
          <select id="custo-consolidado-categoria" class="input-padrao">${opcoesCategorias()}</select>
        </div>

        <div class="form-grupo">
          <label for="custo-consolidado-descricao">Descrição</label>
          <input id="custo-consolidado-descricao" class="input-padrao" maxlength="100" autocomplete="off" placeholder="Ex.: Total de ingredientes do mês" />
        </div>

        <div class="form-grupo">
          <label for="custo-consolidado-valor">Valor total (R$)</label>
          <input id="custo-consolidado-valor" class="input-padrao" type="number" min="0.01" max="9999999999" step="0.01" inputmode="decimal" />
        </div>

        <div class="form-grupo">
          <label for="custo-consolidado-observacao">Observação (opcional)</label>
          <input id="custo-consolidado-observacao" class="input-padrao" maxlength="500" autocomplete="off" placeholder="Detalhes adicionais" />
        </div>

        <button id="btn-custo-consolidado" class="btn-destaque laranja" type="submit">Salvar total do mês</button>
      </form>
    </section>

    <section class="secao-admin">
      <h3 class="secao-titulo" id="custos-lista-titulo">Despesas</h3>
      <div id="lista-custos"></div>
    </section>
  `;

  ligarEventos(raiz);
  montado = true;
}

// ---------- Renderização (só as partes que mudam) ----------

function ajustarCamposDoMes() {
  const { competencia, ultimoDia } = intervaloMes(mesAtual);
  const hoje = chaveMes(new Date());

  const campoMes = $('custos-mes');
  campoMes.value = mesAtual;
  campoMes.max = hoje;

  const campoData = $('custo-data');
  campoData.min = competencia;
  campoData.max = ultimoDia;

  // Mês atual: sugere hoje. Outros meses: sugere o dia 1.
  if (!campoData.value || !campoData.value.startsWith(`${mesAtual}-`)) {
    campoData.value = mesAtual === hoje
      ? `${hoje}-${String(new Date().getDate()).padStart(2, '0')}`
      : competencia;
  }

  document.querySelector('[data-custos-mes="1"]').disabled = mesAtual >= hoje;
}

function renderResumo() {
  const v = calcularVendas();
  const despesas = periodos.reduce((soma, p) => soma + totalDoPeriodo(p), 0);
  const resultado = v.produtos - despesas;

  $('custos-resumo').innerHTML = `
    <div class="dash-grade">
      <div class="dash-k">
        <span class="dash-l">Vendas de produtos</span>
        <span class="dash-n">${reais(v.produtos)}</span>
      </div>
      <div class="dash-k">
        <span class="dash-l">Despesas lançadas</span>
        <span class="dash-n">${reais(despesas)}</span>
      </div>
      <div class="dash-k ${resultado < 0 ? 'k-vermelho' : 'k-verde'}">
        <span class="dash-l">Resultado estimado</span>
        <span class="dash-n">${reais(resultado)}</span>
      </div>
      <div class="dash-k">
        <span class="dash-l">Taxas de entrega</span>
        <span class="dash-n">${reais(v.taxas)}</span>
      </div>
      <div class="dash-k">
        <span class="dash-l">Total dos pedidos</span>
        <span class="dash-n">${reais(v.total)}</span>
      </div>
      <div class="dash-k">
        <span class="dash-l">Pedidos no mês</span>
        <span class="dash-n">${v.quantidade}</span>
      </div>
    </div>

    <p class="dash-vazio" style="margin:8px 0 14px">
      Resultado = vendas de produtos − despesas lançadas. As taxas de entrega ficam fora dessa conta
      (já descontados os fretes grátis). Pedidos cancelados e Pix ainda não pagos não entram.
    </p>

    ${pedidosTruncados ? `<p class="npm-erro">Há pedidos demais neste mês e a lista foi cortada. Os valores de vendas podem estar menores que o real.</p>` : ''}
  `;
}

function renderLista() {
  $('custos-lista-titulo').innerText = `Despesas de ${nomeDoMes(mesAtual)}`;

  const alvo = $('lista-custos');

  if (!periodos.length) {
    alvo.innerHTML = '<p class="dash-vazio">Nenhuma despesa registrada neste mês.</p>';
    return;
  }

  const ordem = (p) => CATEGORIAS.findIndex(([id]) => id === p.categoria);
  const ordenados = [...periodos].sort((a, b) => ordem(a) - ordem(b));

  alvo.innerHTML = ordenados.map((periodo) => {
    const total = reais(totalDoPeriodo(periodo));

    let corpo;

    if (periodo.modo === 'consolidado') {
      corpo = `
        <div class="card-item-gestao">
          <div class="custo-linha">
            <div class="custo-info">
              <strong>${esc(periodo.descricao_consolidada)}</strong>
              <p class="secao-desc">${esc(periodo.observacao_consolidada || 'Total do mês')}</p>
            </div>
            <strong>${total}</strong>
          </div>
          <div class="custo-acoes">
            <button type="button" class="dash-btn" data-consolidado-editar="${esc(periodo.id)}">Editar</button>
            <button type="button" class="dash-btn" data-consolidado-excluir="${esc(periodo.id)}">Remover</button>
          </div>
        </div>
      `;
    } else {
      const itens = lancamentos
        .filter((item) => item.periodo_id === periodo.id)
        .sort((a, b) => String(b.data_despesa).localeCompare(String(a.data_despesa)));

      corpo = itens.length
        ? itens.map((item) => `
          <div class="card-item-gestao">
            <div class="custo-linha">
              <div class="custo-info">
                <strong>${esc(item.descricao)}</strong>
                <p class="secao-desc">${new Date(`${item.data_despesa}T12:00:00`).toLocaleDateString('pt-BR')}</p>
                ${item.observacao ? `<p class="secao-desc">${esc(item.observacao)}</p>` : ''}
              </div>
              <strong>${reais(valorLancamento(item))}</strong>
            </div>
            <div class="custo-acoes">
              <button type="button" class="dash-btn" data-custo-excluir="${esc(item.id)}">Excluir</button>
            </div>
          </div>
        `).join('')
        : '<p class="dash-vazio">Nenhum lançamento nesta categoria.</p>';
    }

    return `
      <div class="dash-bloco">
        <div class="custo-linha">
          <h4>${esc(categoriaNome(periodo.categoria))}</h4>
          <strong>${total}</strong>
        </div>
        ${corpo}
      </div>
    `;
  }).join('');
}

function renderTudo() {
  ajustarCamposDoMes();
  renderResumo();
  renderLista();
}

// ---------- Carregamento ----------

async function buscarPedidosDoMes(inicio, fim) {
  const todos = [];

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
    const de = pagina * TAMANHO_PAGINA;

    const { data, error } = await sb
      .from('pedidos')
      .select('id,status,forma_pagamento,subtotal,taxa_entrega,desconto,total,created_at')
      .eq('restaurante_id', state.rest.id)
      .gte('created_at', inicio.toISOString())
      .lt('created_at', fim.toISOString())
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(de, de + TAMANHO_PAGINA - 1);

    if (error) return { error };

    todos.push(...(data || []));

    if ((data || []).length < TAMANHO_PAGINA) return { data: todos, truncado: false };
  }

  return { data: todos, truncado: true };
}

async function carregarCustos() {
  if (!sb || !state.rest) return;

  montarEstrutura();
  ajustarCamposDoMes();

  const minhaVez = ++sequencia;
  const { inicio, fim, competencia } = intervaloMes(mesAtual);

  try {
    const [vendasResultado, periodosResultado] = await Promise.all([
      buscarPedidosDoMes(inicio, fim),
      sb.from('custos_periodos')
        .select('*')
        .eq('restaurante_id', state.rest.id)
        .eq('competencia', competencia)
        .order('categoria')
    ]);

    if (vendasResultado.error) {
      tratarErro(vendasResultado.error, 'Não foi possível carregar as vendas.');
      return;
    }

    if (periodosResultado.error) {
      tratarErro(periodosResultado.error, 'Não foi possível carregar as despesas.');
      return;
    }

    const novosPeriodos = periodosResultado.data || [];
    let novosLancamentos = [];

    if (novosPeriodos.length) {
      const { data, error } = await sb
        .from('custos_lancamentos')
        .select('*')
        .eq('restaurante_id', state.rest.id)
        .in('periodo_id', novosPeriodos.map((p) => p.id))
        .order('data_despesa', { ascending: false });

      if (error) {
        tratarErro(error, 'Não foi possível carregar os lançamentos.');
        return;
      }

      novosLancamentos = data || [];
    }

    // Se o usuário trocou de mês enquanto carregava, descarta esta resposta
    if (minhaVez !== sequencia) return;

    pedidos = vendasResultado.data;
    pedidosTruncados = vendasResultado.truncado;
    periodos = novosPeriodos;
    lancamentos = novosLancamentos;

    renderTudo();
  } catch (erro) {
    tratarErro(erro, 'Erro inesperado ao carregar o financeiro.');
  }
}

// ---------- Gravação ----------

async function obterPeriodo(categoria, modo) {
  const existente = periodos.find((p) => p.categoria === categoria);

  if (existente) {
    if (existente.modo !== modo) {
      aviso(
        existente.modo === 'consolidado'
          ? 'Esta categoria já tem um total do mês. Remova o total para lançar compras individuais.'
          : 'Esta categoria já tem compras individuais. Exclua todas para usar o total do mês.'
      );
      return null;
    }

    return { periodo: existente, criadoAgora: false };
  }

  const { data, error } = await sb
    .from('custos_periodos')
    .insert([{
      restaurante_id: state.rest.id,
      categoria,
      competencia: intervaloMes(mesAtual).competencia,
      modo
    }])
    .select()
    .single();

  if (error) {
    tratarErro(error, 'Não foi possível criar a categoria.');
    return null;
  }

  return { periodo: data, criadoAgora: true };
}

function lerValor(id) {
  const numero = Number($(id).value);
  return Number.isFinite(numero) && numero > 0 ? Math.round(numero * 100) / 100 : null;
}

async function salvarIndividual() {
  const categoria = $('custo-categoria').value;
  const descricao = $('custo-descricao').value.trim();
  const valor = lerValor('custo-valor');
  const data = $('custo-data').value;
  const observacao = $('custo-observacao').value.trim();

  if (!descricao || descricao.length > 100) return aviso('Informe uma descrição de até 100 caracteres.');
  if (valor === null) return aviso('Informe um valor maior que zero.');
  if (!data || !data.startsWith(`${mesAtual}-`)) return aviso('A data precisa estar dentro do mês selecionado.');

  const obtido = await obterPeriodo(categoria, 'individual');
  if (!obtido) return;

  const { error } = await sb.from('custos_lancamentos').insert([{
    periodo_id: obtido.periodo.id,
    restaurante_id: state.rest.id,
    descricao,
    valor,
    data_despesa: data,
    observacao: observacao || null
  }]);

  if (error) {
    // Não deixa uma categoria vazia travada no modo individual
    if (obtido.criadoAgora) {
      await sb.from('custos_periodos').delete().eq('id', obtido.periodo.id);
    }
    tratarErro(error, 'Não foi possível registrar a despesa.');
    return;
  }

  ['custo-descricao', 'custo-valor', 'custo-observacao'].forEach((id) => { $(id).value = ''; });
  aviso('Despesa registrada!');
  await carregarCustos();
}

async function salvarConsolidado() {
  const categoria = $('custo-consolidado-categoria').value;
  const descricao = $('custo-consolidado-descricao').value.trim();
  const valor = lerValor('custo-consolidado-valor');
  const observacao = $('custo-consolidado-observacao').value.trim();

  if (!descricao || descricao.length > 100) return aviso('Informe uma descrição de até 100 caracteres.');
  if (valor === null) return aviso('Informe um valor maior que zero.');

  const campos = {
    valor_consolidado: valor,
    descricao_consolidada: descricao,
    observacao_consolidada: observacao || null
  };

  const existente = periodos.find((p) => p.categoria === categoria);

  if (existente) {
    if (existente.modo !== 'consolidado') {
      aviso('Esta categoria já tem compras individuais. Exclua todas para usar o total do mês.');
      return;
    }

    const { error } = await sb.from('custos_periodos').update(campos).eq('id', existente.id);

    if (error) {
      tratarErro(error, 'Não foi possível atualizar o total.');
      return;
    }
  } else {
    const { error } = await sb.from('custos_periodos').insert([{
      restaurante_id: state.rest.id,
      categoria,
      competencia: intervaloMes(mesAtual).competencia,
      modo: 'consolidado',
      ...campos
    }]);

    if (error) {
      tratarErro(error, 'Não foi possível salvar o total do mês.');
      return;
    }
  }

  ['custo-consolidado-descricao', 'custo-consolidado-valor', 'custo-consolidado-observacao']
    .forEach((id) => { $(id).value = ''; });

  aviso('Total do mês salvo!');
  await carregarCustos();
}

async function excluirLancamento(id) {
  const item = lancamentos.find((x) => String(x.id) === String(id));
  if (!item) return;

  if (!confirm(`Excluir a despesa "${item.descricao}"?`)) return;

  const { data, error } = await sb
    .from('custos_lancamentos')
    .delete()
    .eq('id', item.id)
    .select();

  if (error || !data?.length) {
    tratarErro(error, 'Não foi possível excluir a despesa.');
    return;
  }

  // Se era o último lançamento, libera a categoria para o formato "total do mês"
  const restantes = lancamentos.filter(
    (x) => x.periodo_id === item.periodo_id && String(x.id) !== String(item.id)
  );

  if (!restantes.length) {
    await sb.from('custos_periodos').delete().eq('id', item.periodo_id);
  }

  aviso('Despesa excluída.');
  await carregarCustos();
}

async function excluirConsolidado(id) {
  const periodo = periodos.find((p) => String(p.id) === String(id));
  if (!periodo) return;

  if (!confirm(`Remover o total de "${categoriaNome(periodo.categoria)}" deste mês?`)) return;

  const { data, error } = await sb
    .from('custos_periodos')
    .delete()
    .eq('id', periodo.id)
    .select();

  if (error || !data?.length) {
    tratarErro(error, 'Não foi possível remover o total.');
    return;
  }

  aviso('Total removido.');
  await carregarCustos();
}

function editarConsolidado(id) {
  const periodo = periodos.find((p) => String(p.id) === String(id));
  if (!periodo) return;

  $('custo-consolidado-categoria').value = periodo.categoria;
  $('custo-consolidado-descricao').value = periodo.descricao_consolidada || '';
  $('custo-consolidado-valor').value = Number(periodo.valor_consolidado).toFixed(2);
  $('custo-consolidado-observacao').value = periodo.observacao_consolidada || '';

  $('form-custo-consolidado').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('custo-consolidado-valor').focus();
}

// Roda uma ação de gravação com o botão travado (evita lançar em duplicidade)
async function executar(botaoId, textoOcupado, acao) {
  if (ocupado) return;

  const botao = botaoId ? $(botaoId) : null;
  const textoOriginal = botao?.innerText;

  ocupado = true;
  if (botao) {
    botao.disabled = true;
    botao.innerText = textoOcupado;
  }

  try {
    await acao();
  } catch (erro) {
    tratarErro(erro, 'Erro inesperado.');
  } finally {
    ocupado = false;
    if (botao) {
      botao.disabled = false;
      botao.innerText = textoOriginal;
    }
  }
}

function mudarMes(novoMes) {
  const hoje = chaveMes(new Date());

  if (!novoMes || novoMes > hoje) {
    $('custos-mes').value = mesAtual;
    return;
  }

  mesAtual = novoMes;
  $('custo-data').value = '';
  carregarCustos();
}

// ---------- Eventos (ligados uma única vez) ----------

function ligarEventos(raiz) {
  raiz.addEventListener('submit', (evento) => {
    evento.preventDefault();

    if (evento.target.id === 'form-custo-individual') {
      executar('btn-custo-salvar', 'Salvando...', salvarIndividual);
    } else if (evento.target.id === 'form-custo-consolidado') {
      executar('btn-custo-consolidado', 'Salvando...', salvarConsolidado);
    }
  });

  raiz.addEventListener('change', (evento) => {
    if (evento.target.id === 'custos-mes') mudarMes(evento.target.value);
  });

  raiz.addEventListener('click', (evento) => {
    const alvo = evento.target;

    if (alvo.closest('[data-custos-atualizar]')) {
      carregarCustos();
      return;
    }

    const botaoMes = alvo.closest('[data-custos-mes]');
    if (botaoMes) {
      const [ano, mes] = mesAtual.split('-').map(Number);
      mudarMes(chaveMes(new Date(ano, mes - 1 + Number(botaoMes.dataset.custosMes), 1)));
      return;
    }

    const excluir = alvo.closest('[data-custo-excluir]');
    if (excluir) {
      executar(null, '', () => excluirLancamento(excluir.dataset.custoExcluir));
      return;
    }

    const removerTotal = alvo.closest('[data-consolidado-excluir]');
    if (removerTotal) {
      executar(null, '', () => excluirConsolidado(removerTotal.dataset.consolidadoExcluir));
      return;
    }

    const editar = alvo.closest('[data-consolidado-editar]');
    if (editar) editarConsolidado(editar.dataset.consolidadoEditar);
  });
}

// ---------- API do módulo ----------

export function abrirAbaCustos() {
  carregarCustos();
}

export function inicializarCustos() {
  // Nada a ligar antes do login: a tela é montada na primeira abertura
}
