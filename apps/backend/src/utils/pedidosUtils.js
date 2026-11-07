// Funções utilitárias compartilhadas entre pedidosController.js e pedidosManualController.js.
// Mover aqui evita duplicação e permite importar sem dependência circular.

export const MAX_ITENS = 30;
export const MAX_QTD_POR_ITEM = 50;
export const MAX_OBSERVACAO = 250;

export function sanitizarTexto(valor, min = 0, max = 255) {
  if (typeof valor !== 'string') return null;

  const texto = valor.trim();

  if (texto.length < min || texto.length > max) return null;

  return texto;
}

export function paraCentavos(valor) {
  const numero = Number(valor);

  if (!Number.isFinite(numero) || numero < 0) return null;

  return Math.round((numero + Number.EPSILON) * 100);
}

export function deCentavos(valor) {
  return valor / 100;
}

export function normalizarTelefone(valor) {
  if (typeof valor !== 'string' && typeof valor !== 'number') return '';

  return String(valor).replace(/\D/g, '');
}

export function coordenadasValidas(lat, lon) {
  if (lat === undefined || lon === undefined || lat === null || lon === null) {
    return false;
  }

  const latitude = Number(lat);
  const longitude = Number(lon);

  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function respostaErro(res, status, erro, codigo) {
  return res.status(status).json({
    erro,
    ...(codigo ? { codigo } : {})
  });
}
