// Aviso de cancelamento por WhatsApp (link wa.me, o lojista confirma o envio)

function somenteDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

// Aceita (33) 99999-8888, 33999998888, +55 33 99999-8888 etc.
export function normalizarTelefoneBR(valor) {
  let d = somenteDigitos(valor);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return null; // inválido
}

export function montarMensagemCancelamento(pedido, opcoes = {}) {
  const loja = opcoes.loja || 'Pastel e Batata Imperial';
  const nomeCompleto = String(pedido.cliente_nome || pedido.nome || '').trim();
  const primeiroNome = nomeCompleto.split(/\s+/)[0];
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}! Tudo bem? 😊` : 'Olá! Tudo bem? 😊';
  const numero = pedido.numero || pedido.codigo || '';
  const refPedido = numero ? `o seu pedido #${numero}` : 'o seu pedido';
  const motivo = String(opcoes.motivo || '').trim();

  const linhas = [
    saudacao,
    '',
    `Aqui é do ${loja}. Infelizmente precisamos cancelar ${refPedido}.`,
  ];
  if (motivo) linhas.push(`Motivo: ${motivo}.`);
  linhas.push(
    '',
    'Pedimos mil desculpas pelo transtorno. Se você já tinha pago, é só nos avisar por aqui que resolvemos o reembolso rapidinho.',
    '',
    'Quando quiser, é só fazer um novo pedido. Vamos adorar te atender! 💛'
  );
  return linhas.join('\n');
}

// Retorna a URL do WhatsApp ou null se o telefone for inválido
export function linkWhatsappCancelamento(pedido, opcoes = {}) {
  const tel = normalizarTelefoneBR(
    pedido.cliente_telefone || pedido.telefone || pedido.cliente_whatsapp || pedido.whatsapp
  );
  if (!tel) return null;
  const texto = montarMensagemCancelamento(pedido, opcoes);
  return `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;
}
