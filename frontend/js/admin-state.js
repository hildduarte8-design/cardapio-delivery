// Estado compartilhado do painel.
// Mantemos os dados em um único lugar para evitar variáveis globais espalhadas.
export const state = {
  rest: null,
  produtos: [],
  bairros: [],
  pedidos: [],
  filtroPedidos: 'ativos',       // 'ativos' | 'encerrados'
  filtroStatus: 'todos',         // 'todos' | 'acao' | 'preparando' | 'saiu_entrega' | 'encerrados'
  processandoPedidoId: null,     // ID do pedido em atualização (protege contra clique duplo)
  idsVistos: null,
  canalPedidos: null,
  timerPedidos: null,
  audioCtx: null,
  somLigado: true,
  toastTimer: null
};
