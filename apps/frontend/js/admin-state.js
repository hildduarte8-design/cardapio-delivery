// Estado compartilhado do painel.
// Mantemos os dados em um único lugar para evitar variáveis globais espalhadas.
export const state = {
  rest: null,
  produtos: [],
  bairros: [],
  pedidos: [],
  filtroPedidos: 'ativos',
  idsVistos: null,
  canalPedidos: null,
  timerPedidos: null,
  audioCtx: null,
  somLigado: true,
  toastTimer: null
};
