
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

let mesAtual = chaveMesAtual();
let periodos = [];
let lancamentos = [];
let pedidos = [];
let carregando = false;

function chaveMesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function intervaloMes(mes) {
  const [ano, numero] = mes.split('-').map(Number);
  return {
    inicio: new Date(ano, numero - 1, 1),
    fim: new Date(ano, numero, 1),
    competencia: `${mes}-01`
  };
}

function categoriaNome(valor) {
  return CATEGORIAS.find(([id]) => id === valor)?.[1] || valor;
}

function dinheiro(valor) {
  return brl.format(Number(valor) || 0);
}

function forma(p) {
  return String(p.forma_pagamento || '').trim().toLowerCase();
}

function pagaNaEntrega(p) {
  return p.status === 'pendente_pagamento' &&
    ['dinheiro', 'cartao', 'cartão'].includes(forma(p));
}

function ehVenda(p) {
  return p.status !== 'cancelado' &&
    (p.status !== 'pendente_pagamento' || pagaNaEntrega(p));
}

function opcoesCategorias(selecionada = '') {
  return CATEGORIAS.map(([id, nome]) =>
    `<option value="${id}" ${id === selecionada ? 'selected' : ''}>${nome}</option>`
  ).join('');
}

function renderizar() {
  const inicio = intervaloMes(mesAtual).inicio;
  const fim = intervaloMes(mesAtual).fim;

  const vendas = pedidos.filter(ehVenda);

  const vendasProdutos = vendas.reduce((soma, p) =>
    soma + Math.max(0, (Number(p.subtotal) || 0) - (Number(p.desconto) || 0)), 0);

  const taxasEntrega = vendas.reduce((soma, p) =>
    soma + (Number(p.taxa_entrega) || 0), 0);

  const totalPedidos = vendas.reduce((soma, p) =>
    soma + (Number(p.total) || 0), 0);

  const totalDespesas = periodos.reduce((soma, periodo) => {
    if (periodo.modo === 'consolidado') {
      return soma + (Number(periodo.valor_consolidado) || 0);
    }

    return soma + lancamentos
      .filter(item => item.periodo_id === periodo.id)
      .reduce((subtotal, item) => subtotal + Number(item.valor || 0), 0);
  }, 0);

  const resultado = vendasProdutos - totalDespesas;

  $('custos-conteudo').innerHTML = `
    <div class="dash-topo">
      <div>
        <h2>Custos e Resultado</h2>
        <span class="dash-d">Acompanhamento financeiro da loja</span>
      </div>
      <button type="button" class="dash-btn" data-custos-atualizar>
        Atualizar
      </button>
    </div>

    <section class="secao-admin">
      <h3 class="secao-titulo">Competência</h3>
      <div class="grid-2">
        <button type="button" class="dash-btn" data-custos-mes="-1">◀ Mês anterior</button>
        <input
          id="custos-mes"
          class="input-padrao"
          type="month"
          value="${mesAtual}"
          max="${chaveMesAtual()}"
          aria-label="Selecionar mês"
        />
      </div>
    </section>

    <div class="dash-grade">
      <div class="dash-k">
        <span class="dash-l">Vendas de produtos</span>
        <span class="dash-n">${dinheiro(vendasProdutos)}</span>
      </div>
      <div class="dash-k">
        <span class="dash-l">Taxas de entrega</span>
        <span class="dash-n">${dinheiro(taxasEntrega)}</span>
      </div>
      <div class="dash-k">
        <span class="dash-l">Total dos pedidos</span>
        <span class="dash-n">${dinheiro(totalPedidos)}</span>
      </div>
      <div class="dash-k">
        <span class="dash-l">Despesas lançadas</span>
        <span class="dash-n">${dinheiro(totalDespesas)}</span>
      </div>
      <div class="dash-k ${resultado < 0 ? 'k-vermelho' : 'k-verde'}">
        <span class="dash-l">Resultado estimado</span>
        <span class="dash-n">${dinheiro(resultado)}</span>
      </div>
    </div>

    <p class="dash-vazio" style="margin:8px 0 14px">
      O resultado é calculado pelas vendas de produtos menos as despesas registradas.
      As taxas de entrega aparecem separadamente e não entram nesse cálculo.
    </p>

    <section class="secao-admin">
      <h3 class="secao-titulo">Registrar despesa individual</h3>
      <p class="secao-desc">
        Use para registrar compras e contas separadamente.
      </p>

      <form id="form-custo-individual">
        <div class="form-grupo">
          <label for="custo-categoria">Categoria</label>
          <select id="custo-categoria" class="input-padrao" required>
            ${opcoesCategorias()}
          </select>
        </div>

        <div class="form-grupo">
          <label for="custo-descricao">Descrição da despesa</label>
          <input
            id="custo-descricao"
            class="input-padrao"
            maxlength="100"
            placeholder="Ex.: Compra de mussarela"
            required
          />
        </div>

        <div class="grid-2">
          <div class="form-grupo">
            <label for="custo-valor">Valor (R$)</label>
            <input
              id="custo-valor"
              class="input-padrao"
              type="number"
              min="0.01"
              max="9999999999"
              step="0.01"
              inputmode="decimal"
              required
            />
          </div>
          <div class="form-grupo">
            <label for="custo-data">Data da despesa</label>
            <input
              id="custo-data"
              class="input-padrao"
              type="date"
              value="${mesAtual}-01"
              required
            />
          </div>
        </div>

        <div class="form-grupo">
          <label for="custo-observacao">Observação (opcional)</label>
          <input
            id="custo-observacao"
            class="input-padrao"
            maxlength="500"
            placeholder="Detalhes adicionais"
          />
        </div>

        <button id="btn-custo-salvar" class="btn-destaque" type="submit">
          Registrar despesa
        </button>
      </form>
    </section>

    <section class="secao-admin">
      <h3 class="secao-titulo">Registrar total mensal consolidado</h3>
      <p class="secao-desc">
        Use quando preferir informar apenas o total da categoria no mês,
        sem cadastrar cada compra. Não misture os dois formatos na mesma categoria e mês.
      </p>

      <form id="form-custo-consolidado">
        <div class="form-grupo">
          <label for="custo-consolidado-categoria">Categoria</label>
          <select id="custo-consolidado-categoria" class="input-padrao" required>
            ${opcoesCategorias()}
          </select>
        </div>

        <div class="form-grupo">
          <label for="custo-consolidado-descricao">Descrição do total</label>
          <input
            id="custo-consolidado-descricao"
            class="input-padrao"
            maxlength="100"
            placeholder="Ex.: Total de ingredientes do mês"
            required
          />
        </div>

        <div class="form-grupo">
          <label for="custo-consolidado-valor">Valor total (R$)</label>
          <input
            id="custo-consolidado-valor"
            class="input-padrao"
            type="number"
            min="0.01"
            max="9999999999"
            step="0.01"
            inputmode="decimal"
            required
          />
        </div>

        <div class="form-grupo">
          <label for="custo-consolidado-observacao">Observação (opcional)</label>
          <input
            id="custo-consolidado-observacao"
            class="input-padrao"
            maxlength="500"
            placeholder="Detalhes adicionais"
          />
        </div>

        <button id="btn-custo-consolidado" class="btn-destaque laranja" type="submit">
          Salvar total mensal
        </button>
      </form>
    </section>

    <section class="secao-admin">
      <h3 class="secao-titulo">Despesas de ${new Intl.DateTimeFormat('pt-BR', {
        month: 'long', year: 'numeric'
      }).format(inicio)}</h3>

      <div id="lista-custos">
        ${renderizarListaDespesas()}
      </div>
    </section>
  `;

  configurarEventos();
}

function renderizarListaDespesas() {
  if (!periodos.length) {
    return '<p class="dash-vazio">Nenhuma despesa registrada neste mês.</p>';
  }

  return periodos.map(periodo => {
    const itens = lancamentos.filter(item => item.periodo_id === periodo.id);

    const conteudo = periodo.modo === 'consolidado'
      ? `
        <div class="card-item-gestao">
          <strong>${esc(periodo.descricao_consolidada)}</strong>
          <p class="secao-desc">${esc(periodo.observacao_consolidada || 'Total mensal consolidado')}</p>
          <strong>${dinheiro(periodo.valor_consolidado)}</strong>
          <p class="secao-desc">Modo: total mensal</p>
        </div>
      `
      : itens.length
        ? itens.map(item => `
          <div class="card-item-gestao">
            <div style="display:flex;justify-content:space-between;gap:8px">
              <div style="min-width:0">
                <strong>${esc(item.descricao)}</strong>
                <p class="secao-desc">${new Date(`${item.data_despesa}T12:00:00`).toLocaleDateString('pt-BR')}</p>
                ${item.observacao ? `<p class="secao-desc">${esc(item.observacao)}</p>` : ''}
              </div>
              <strong>${dinheiro(item.valor)}</strong>
            </div>
            <button
              type="button"
              class="dash-btn"
              data-custo-excluir="${esc(item.id)}"
            >Excluir</button>
          </div>
        `).join('')
        : '<p class="dash-vazio">Nenhum lançamento nesta categoria.</p>';

    return `
      <div class="dash-bloco">
        <h4>${esc(categoriaNome(periodo.categoria))}</h4>
        ${conteudo}
      </div>
    `;
  }).join('');
}

async function carregarCustos() {
  if (!sb || !state.rest || carregando) return;

  carregando = true;

  try {
    const { inicio, fim, competencia } = intervaloMes(mesAtual);

    const [pedidosResult, periodosResult] = await Promise.all([
      sb.from('pedidos')
        .select('id,status,forma_pagamento,subtotal,taxa_entrega,total,desconto,created_at')
        .eq('restaurante_id', state.rest.id)
        .gte('created_at', inicio.toISOString())
        .lt('created_at', fim.toISOString())
        .order('created_at', { ascending: false })
        .limit(1000),

      sb.from('custos_periodos')
        .select('*')
        .eq('restaurante_id', state.rest.id)
        .eq('competencia', competencia)
        .order('categoria')
    ]);

    if (pedidosResult.error) {
      tratarErro(pedidosResult.error, 'Não foi possível carregar as vendas.');
      return;
    }

    if (periodosResult.error) {
      tratarErro(periodosResult.error, 'Não foi possível carregar as despesas.');
      return;
    }

    pedidos = pedidosResult.data || [];
    periodos = periodosResult.data || [];

    if (periodos.length) {
      const ids = periodos.map(p => p.id);

      const { data, error } = await sb
        .from('custos_lancamentos')
        .select('*')
        .eq('restaurante_id', state.rest.id)
        .in('periodo_id', ids)
        .order('data_despesa', { ascending: false });

      if (error) {
        tratarErro(error, 'Não foi possível carregar os lançamentos.');
        return;
      }

      lancamentos = data || [];
    } else {
      lancamentos = [];
    }

    renderizar();
  } catch (error) {
    tratarErro(error, 'Erro inesperado ao carregar custos.');
  } finally {
    carregando = false;
  }
}

async function obterPeriodo(categoria, modo) {
  const competencia = intervaloMes(mesAtual).competencia;

  let periodo = periodos.find(p => p.categoria === categoria);

  if (periodo) {
    if (periodo.modo !== modo) {
      aviso('Esta categoria já utiliza outro formato neste mês.');
      return null;
    }
    return periodo;
  }

  const { data, error } = await sb
    .from('custos_periodos')
    .insert([{
      restaurante_id: state.rest.id,
      categoria,
      competencia,
      modo
    }])
    .select()
    .single();

  if (error) {
    tratarErro(error, 'Não foi possível criar a categoria.');
    return null;
  }

  return data;
}

async function salvarIndividual(evento) {
  evento.preventDefault();

  const categoria = $('custo-categoria').value;
  const descricao = $('custo-descricao').value.trim();
  const valor = Number($('custo-valor').value);
  const data = $('custo-data').value;
  const observacao = $('custo-observacao').value.trim();

  if (!descricao || descricao.length > 100) {
    aviso('Informe uma descrição válida.');
    return;
  }

  if (!(valor > 0) || !Number.isFinite(valor)) {
    aviso('Informe um valor válido.');
    return;
  }

  if (!data || !data.startsWith(`${mesAtual}-`)) {
    aviso('A data precisa pertencer ao mês selecionado.');
    return;
  }

  const botao = $('btn-custo-salvar');
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  try {
    const periodo = await obterPeriodo(categoria, 'individual');
    if (!periodo) return;

    const { error } = await sb
      .from('custos_lancamentos')
      .insert([{
        periodo_id: periodo.id,
        restaurante_id: state.rest.id,
        descricao,
        valor,
        data_despesa: data,
        observacao: observacao || null
      }]);

    if (error) {
      tratarErro(error, 'Não foi possível registrar a despesa.');
      return;
    }

    aviso('Despesa registrada!');
    await carregarCustos();
  } finally {
    botao.disabled = false;
    botao.textContent = 'Registrar despesa';
  }
}

async function salvarConsolidado(evento) {
  evento.preventDefault();

  const categoria = $('custo-consolidado-categoria').value;
  const descricao = $('custo-consolidado-descricao').value.trim();
  const valor = Number($('custo-consolidado-valor').value);
  const observacao = $('custo-consolidado-observacao').value.trim();

  if (!descricao || descricao.length > 100) {
    aviso('Informe uma descrição válida.');
    return;
  }

  if (!(valor > 0) || !Number.isFinite(valor)) {
    aviso('Informe um valor válido.');
    return;
  }

  const botao = $('btn-custo-consolidado');
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  try {
    let periodo = periodos.find(p => p.categoria === categoria);

    if (periodo && periodo.modo !== 'consolidado') {
      aviso('Esta categoria já possui lançamentos individuais neste mês.');
      return;
    }

    const campos = {
      valor_consolidado: valor,
      descricao_consolidada: descricao,
      observacao_consolidada: observacao || null
    };

    if (periodo) {
      const { error } = await sb
        .from('custos_periodos')
        .update(campos)
        .eq('id', periodo.id);

      if (error) {
        tratarErro(error, 'Não foi possível atualizar o total.');
        return;
      }
    } else {
      const { error } = await sb
        .from('custos_periodos')
        .insert([{
          restaurante_id: state.rest.id,
          categoria,
          competencia: intervaloMes(mesAtual).competencia,
          modo: 'consolidado',
          ...campos
        }]);

      if (error) {
        tratarErro(error, 'Não foi possível salvar o total mensal.');
        return;
      }
    }

    aviso('Total mensal salvo!');
    await carregarCustos();
  } finally {
    botao.disabled = false;
    botao.textContent = 'Salvar total mensal';
  }
}

async function excluirLancamento(id) {
  const item = lancamentos.find(x => String(x.id) === String(id));
  if (!item) return;

  if (!confirm(`Excluir a despesa "${item.descricao}"?`)) return;

  const { data, error } = await sb
    .from('custos_lancamentos')
    .delete()
    .eq('id', id)
    .select();

  if (error || !data?.length) {
    tratarErro(error, 'Não foi possível excluir a despesa.');
    return;
  }

  aviso('Despesa excluída.');
  await carregarCustos();
}

function configurarEventos() {
  $('form-custo-individual').addEventListener('submit', salvarIndividual);
  $('form-custo-consolidado').addEventListener('submit', salvarConsolidado);

  $('custos-mes').addEventListener('change', evento => {
    if (!evento.target.value || evento.target.value > chaveMesAtual()) {
      evento.target.value = mesAtual;
      return;
    }

    mesAtual = evento.target.value;
    carregarCustos();
  });

  document.querySelectorAll('[data-custos-mes]').forEach(botao => {
    botao.addEventListener('click', () => {
      const [ano, mes] = mesAtual.split('-').map(Number);
      const novaData = new Date(ano, mes - 1 + Number(botao.dataset.custosMes), 1);
      const hoje = new Date();

      if (novaData > new Date(hoje.getFullYear(), hoje.getMonth(), 1)) return;

      mesAtual = `${novaData.getFullYear()}-${String(novaData.getMonth() + 1).padStart(2, '0')}`;
      carregarCustos();
    });
  });

  $('custos-conteudo').addEventListener('click', evento => {
    const atualizar = evento.target.closest('[data-custos-atualizar]');
    if (atualizar) carregarCustos();

    const excluir = evento.target.closest('[data-custo-excluir]');
    if (excluir) excluirLancamento(excluir.dataset.custoExcluir);
  });

  $('custo-data').addEventListener('change', evento => {
    if (evento.target.value && !evento.target.value.startsWith(`${mesAtual}-`)) {
      aviso('Escolha uma data dentro do mês selecionado.');
      evento.target.value = `${mesAtual}-01`;
    }
  });
}

export function abrirAbaCustos() {
  carregarCustos();
}

export function inicializarCustos() {
  $('custos-conteudo').addEventListener('focusin', () => {});
}
