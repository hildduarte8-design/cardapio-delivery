// Registra o cliente e o selo de fidelidade após um pedido criado.
// Nunca derruba o pedido: se falhar, só registra no log.
export async function registrarClienteESelo(db, {
  restauranteId,
  nome,
  telefone,
  endereco,
  total,
  retirada
}) {
  try {
    if (!db || typeof db.rpc !== 'function') return;

    const { error } = await db.rpc('registrar_pedido_cliente', {
      p_restaurante_id: restauranteId,
      p_nome: nome,
      p_telefone: telefone,
      p_endereco: endereco,
      p_total: total,
      p_retirada: Boolean(retirada)
    });

    if (error) {
      console.error('[CLIENTE/SELO] Falha ao registrar:', error.message);
    }
  } catch (erro) {
    console.error('[CLIENTE/SELO] Erro inesperado:', erro.message);
  }
}
