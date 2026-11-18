// Geocodificação reversa (coordenadas -> rua e bairro) via Mapbox v6.
// Orçamento PRÓPRIO: não usa o orçamento do frete (é outra API, com outra cota).
// Não grava nem loga coordenadas nem endereços (LGPD).

const MS_MINUTO = 60_000;
const MS_DIA = 86_400_000;

function inteiro(bruto, padrao) {
  const n = Number(bruto);
  return Number.isInteger(n) && n >= 1 ? n : padrao;
}

function criarOrcamento({ porMinuto, porDia, agora }) {
  let minuto = -1;
  let noMinuto = 0;
  let dia = -1;
  let noDia = 0;
  return {
    consumir() {
      const t = agora();
      const m = Math.floor(t / MS_MINUTO);
      const d = Math.floor(t / MS_DIA);
      if (m !== minuto) { minuto = m; noMinuto = 0; }
      if (d !== dia) { dia = d; noDia = 0; }
      if (noMinuto >= porMinuto || noDia >= porDia) return false;
      noMinuto += 1;
      noDia += 1;
      return true;
    },
  };
}

function textoLimpo(valor) {
  if (typeof valor !== 'string') return null;
  const t = valor.replace(/\s+/g, ' ').trim();
  return t.length >= 2 && t.length <= 120 ? t : null;
}

// Extrai rua e bairro da resposta da Mapbox v6, sem assumir que tudo existe.
export function extrairLugar(corpo) {
  const f = corpo?.features?.[0];
  const p = f?.properties;
  if (!p) return null;
  const ctx = p.context || {};
  const rua = textoLimpo(ctx.street?.name) || (p.feature_type === 'street' ? textoLimpo(p.name) : null);
  const bairro = textoLimpo(ctx.neighborhood?.name) || textoLimpo(ctx.locality?.name);
  const cidade = textoLimpo(ctx.place?.name);
  if (!rua) return null; // sem nome de rua, a confirmação não confirma nada
  return { rua, bairro, cidade };
}

export function criarServicoGeocodificacao({
  token,
  fetchFn = fetch,
  agora = Date.now,
  log = {},
  env = process.env,
} = {}) {
  const tokenOk = typeof token === 'string' && /^(pk|sk|tk)\.[A-Za-z0-9._-]{20,}$/.test(token.trim());
  const orcamento = criarOrcamento({
    porMinuto: inteiro(env.GEOCODE_MAX_CHAMADAS_MIN, 30),
    porDia: inteiro(env.GEOCODE_MAX_CHAMADAS_DIA, 500),
    agora,
  });
  const timeoutMs = inteiro(env.GEOCODE_TIMEOUT_MS, 2500);

  // Devolve { rua, bairro, cidade } ou null (qualquer falha vira null, nunca erro).
  async function reverso(lat, lon) {
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    if (!tokenOk) return null;
    if (!orcamento.consumir()) {
      log.warn?.('[geocodificacao] orcamento_esgotado');
      return null;
    }
    const url =
      'https://api.mapbox.com/search/geocode/v6/reverse' +
      `?longitude=${la === lo ? lo : lo.toFixed(6)}&latitude=${la.toFixed(6)}` +
      `&language=pt&country=br&limit=1&access_token=${encodeURIComponent(token.trim())}`;
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        log.warn?.(`[geocodificacao] http_${res.status}`);
        return null;
      }
      return extrairLugar(await res.json());
    } catch {
      log.warn?.('[geocodificacao] falha_de_rede'); // nunca repassa err.message
      return null;
    }
  }

  return { reverso };
}
