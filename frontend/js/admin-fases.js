// Fases dos pedidos: marca contador zerado e aba "Ação" com pedido esperando

const IDS = ['todos', 'acao', 'preparo', 'entrega', 'encerrados'];

function atualizar(id) {
  const el = document.getElementById('chip-num-' + id);
  if (!el) return;
  const n = parseInt(el.textContent, 10) || 0;
  el.classList.toggle('zerado', n === 0);
  if (id === 'acao') {
    const chip = el.closest('.filtro-chip');
    if (chip) chip.classList.toggle('tem-acao', n > 0);
  }
}

IDS.forEach((id) => {
  const el = document.getElementById('chip-num-' + id);
  if (!el) return;
  new MutationObserver(() => atualizar(id)).observe(el, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  atualizar(id);
});
