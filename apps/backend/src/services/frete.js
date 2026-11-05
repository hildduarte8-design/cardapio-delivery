// =============================================================================
// apps/backend/src/services/frete.js
//
// Cálculo de frete multi-restaurante, só no backend.
//
// Hierarquia (frete_tipo gravado em pedidos):
//   1. Mapbox Directions ........ 'rota_mapbox'  (rota real)
//   2. OSRM próprio/compatível .. 'rota_osrm'    (rota real, reserva)
//   3. Taxa cadastrada por bairro 'bairro'       (taxa fixa do bairro)
//   4. Haversine x fator de rua . 'estimado'     (último recurso; requer_confirmacao)
//
// Requer Node 18+ (fetch nativo e AbortSignal.timeout). Módulo ESM
// ("type": "module" no package.json do backend).
//
// Uso no server.js (Módulo 3):
//   import { configurarFrete, calcularFrete, criarLimitadorDeRequisicoes } from './services/frete.js';
//   app.set('trust proxy', 1); // Render fica atrás de proxy: sem isso req.ip é sempre o do proxy
//   configurarFrete({ buscarTaxaBairro });            // uma vez, no boot
//   const r = await calcularFrete({ restaurante, destino: { lat, lon }, bairro });
//
// IMPORTANTE: `restaurante` deve vir do banco (lido com service_role pelo
// backend a partir do slug). Nunca aceite taxa_base/valor_km/coords da loja
// vindas do cliente.
//
// Privacidade (LGPD): coordenadas do cliente nunca são logadas. Elas são
// arredondadas (4 casas, ~11 m) antes de sair para o provedor de rota.
// =============================================================================

export const FRETE_TIPO = Object.freeze({
  ROTA_MAPBOX: 'rota_mapbox',
  ROTA_OSRM: 'rota_osrm',
  BAIRRO: 'bairro',
  ESTIMADO: 'estimado',
});

const MS_MINUTO = 60_000;
const MS_DIA = 86_400_000;
const OSRM_DEMO_HOSTS = new Set(['router.project-osrm.org']);

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

/** Erro de negócio/validação. `status` sugere o HTTP a devolver. */
export class FreteError extends Error {
  constructor(code, message, status = 400, detalhes = undefined) {
    super(message);
    this.name = 'FreteError';
    this.code = code;
    this.status = status;
    if (detalhes) this.detalhes = detalhes;
  }
}

/** Falha de um provedor. A mensagem é SEMPRE só o motivo (nunca URL/token). */
class ProviderError extends Error {
  constructor(motivo) {
    super(motivo);
    this.name = 'ProviderError';
    this.motivo = motivo;
  }
}

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------

function paraNumero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d{1,3}(\.\d{1,15})?$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * Validação rigorosa de coordenadas. Aceita number ou string decimal simples.
 * Rejeita NaN/Infinity, notação científica, fora de faixa e (0,0).
 * @returns {{lat:number, lon:number} | null}
 */
export function validarCoordenadas(lat, lon) {
  const la = paraNumero(lat);
  const lo = paraNumero(lon);
  if (la === null || lo === null) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  if (la === 0 && lo === 0) return null; // "Null Island": quase sempre é dado ausente
  return { lat: la, lon: lo };
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const arredondar2 = (n) => Number(n.toFixed(2));
const coord4 = (n) => Number(n.toFixed(4)); // ~11 m
const fmt = (n) => n.toFixed(4);

function dinheiro(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : null;
}

// ---------------------------------------------------------------------------
// Configuração (variáveis de ambiente)
// ---------------------------------------------------------------------------

export function lerConfigDoAmbiente(env = process.env) {
  const avisos = [];
  const inteiro = (nome, padrao, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const bruto = env[nome];
    if (bruto === undefined || bruto === '') return padrao;
    const n = Number(bruto);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    avisos.push(`${nome} inválida (esperado inteiro ${min}..${max}); usando ${padrao}`);
    return padrao;
  };
  const decimal = (nome, padrao, min, max) => {
    const bruto = env[nome];
    if (bruto === undefined || bruto === '') return padrao;
    const n = Number(bruto);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    avisos.push(`${nome} inválida (esperado ${min}..${max}); usando ${padrao}`);
    return padrao;
  };

  return {
    nodeEnv: env.NODE_ENV || 'development',
    mapboxToken: (env.MAPBOX_TOKEN || '').trim() || null,
    mapboxTimeoutMs: inteiro('MAPBOX_TIMEOUT_MS', 2500, 200, 15_000),
    mapboxMaxPorMinuto: inteiro('MAPBOX_MAX_CHAMADAS_MIN', 60),
    mapboxMaxPorDia: inteiro('MAPBOX_MAX_CHAMADAS_DIA', 3000),
    osrmBaseUrl: (env.OSRM_BASE_URL || '').trim() || null,
    osrmProfile: (env.OSRM_PROFILE || 'driving').trim(),
    osrmTimeoutMs: inteiro('OSRM_TIMEOUT_MS', 3000, 200, 15_000),
    osrmMaxPorMinuto: inteiro('OSRM_MAX_CHAMADAS_MIN', 300),
    fatorRua: decimal('FRETE_FATOR_RUA', 1.3, 1, 3),
    maxKmHard: decimal('FRETE_MAX_KM_HARD', 60, 1, 500),
    cacheTtlMs: inteiro('FRETE_CACHE_TTL_MS', MS_DIA, 1000),
    cacheMax: inteiro('FRETE_CACHE_MAX', 5000, 10, 200_000),
    circuitoFalhas: inteiro('FRETE_CB_FALHAS', 5, 1, 100),
    circuitoPausaMs: inteiro('FRETE_CB_PAUSA_MS', MS_MINUTO, 1000),
    avisos,
  };
}

// ---------------------------------------------------------------------------
// Logger com sanitização (defesa em profundidade; os campos já são controlados)
// ---------------------------------------------------------------------------

function criarLogger(base, segredos) {
  const redigir = (texto) => {
    let s = String(texto)
      .replace(/access_token=[^&\s"']+/gi, 'access_token=[REDACTED]')
      .replace(/\b(?:pk|sk|tk)\.[A-Za-z0-9._-]{10,}/g, '[REDACTED_TOKEN]');
    for (const seg of segredos) if (seg) s = s.split(seg).join('[REDACTED]');
    return s;
  };
  const emitir = (nivel) => (evento, campos = {}) => {
    const fn = typeof base?.[nivel] === 'function' ? base[nivel].bind(base) : () => {};
    fn(redigir(`[frete] ${JSON.stringify({ evento, ...campos })}`));
  };
  return { info: emitir('info'), warn: emitir('warn'), error: emitir('error') };
}

// ---------------------------------------------------------------------------
// Cache LRU + TTL, circuit breaker e orçamento de chamadas
// ---------------------------------------------------------------------------

function criarCache({ max, ttlMs, agora }) {
  const m = new Map();
  return {
    get(chave) {
      const e = m.get(chave);
      if (!e) return undefined;
      if (e.exp <= agora()) {
        m.delete(chave);
        return undefined;
      }
      m.delete(chave); // reinsere = mais recente (LRU)
      m.set(chave, e);
      return e.valor;
    },
    set(chave, valor) {
      m.delete(chave);
      m.set(chave, { valor, exp: agora() + ttlMs });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    get tamanho() {
      return m.size;
    },
  };
}

function criarCircuito({ falhas, pausaMs, agora }) {
  let consecutivas = 0;
  let abertoAte = 0;
  return {
    permitido: () => agora() >= abertoAte,
    aberto: () => agora() < abertoAte,
    sucesso() {
      consecutivas = 0;
      abertoAte = 0;
    },
    falha() {
      consecutivas += 1;
      if (consecutivas >= falhas) {
        abertoAte = agora() + pausaMs;
        consecutivas = falhas - 1; // meio-aberto: uma falha na tentativa seguinte reabre
      }
    },
  };
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
    usoHoje: () => noDia,
  };
}

// ---------------------------------------------------------------------------
// Fábrica do serviço
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {ReturnType<typeof lerConfigDoAmbiente>} opts.config
 * @param {object} [opts.deps]
 * @param {typeof fetch} [opts.deps.fetchImpl]
 * @param {() => number} [opts.deps.agora]
 * @param {Console} [opts.deps.logger]
 * @param {(a:{restauranteId:string, bairro:string}) => Promise<{id?:any,nome?:string,taxa:number}|null>} [opts.deps.buscarTaxaBairro]
 */
export function criarServicoFrete({ config, deps = {} }) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const agora = deps.agora ?? Date.now;
  const buscarTaxaBairro = deps.buscarTaxaBairro ?? null;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch nativo indisponível: use Node 18 ou superior.');
  }

  const cfg = config;
  const log = criarLogger(deps.logger ?? console, [cfg.mapboxToken]);
  for (const a of cfg.avisos ?? []) log.warn('config_invalida', { detalhe: a });

  // ---- Provedores ----------------------------------------------------------
  const provedores = [];

  async function buscarDistanciaKm(url, timeoutMs) {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const corpoErro = await res.json().catch(() => null);
        if (corpoErro && (corpoErro.code === 'NoRoute' || corpoErro.code === 'NoSegment')) {
          throw new ProviderError('sem_rota');
        }
        throw new ProviderError(`http_${res.status}`);
      }
      const corpo = await res.json();
      if (corpo?.code === 'NoRoute' || corpo?.code === 'NoSegment') throw new ProviderError('sem_rota');
      const metros = corpo?.routes?.[0]?.distance;
      if (corpo?.code !== 'Ok' || typeof metros !== 'number' || !Number.isFinite(metros) || metros < 0) {
        throw new ProviderError('resposta_invalida');
      }
      return arredondar2(metros / 1000);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new ProviderError('timeout');
      if (err instanceof SyntaxError) throw new ProviderError('resposta_invalida');
      throw new ProviderError('rede'); // nunca propaga err.message (pode conter URL/token)
    }
  }

  const circuito = () => criarCircuito({ falhas: cfg.circuitoFalhas, pausaMs: cfg.circuitoPausaMs, agora });

  // Mapbox
  if (cfg.mapboxToken) {
    if (!/^(pk|sk|tk)\.[A-Za-z0-9._-]{20,}$/.test(cfg.mapboxToken)) {
      log.warn('mapbox_desativado', { motivo: 'MAPBOX_TOKEN_formato_invalido' });
    } else {
      const token = encodeURIComponent(cfg.mapboxToken);
      provedores.push({
        nome: 'mapbox',
        tipo: FRETE_TIPO.ROTA_MAPBOX,
        circuito: circuito(),
        orcamento: criarOrcamento({ porMinuto: cfg.mapboxMaxPorMinuto, porDia: cfg.mapboxMaxPorDia, agora }),
        stats: { chamadas: 0, ok: 0, falhas: 0 },
        buscar: (o, d) =>
          buscarDistanciaKm(
            `https://api.mapbox.com/directions/v5/mapbox/driving/${fmt(o.lon)},${fmt(o.lat)};${fmt(d.lon)},${fmt(d.lat)}` +
              `?overview=false&alternatives=false&steps=false&access_token=${token}`,
            cfg.mapboxTimeoutMs,
          ),
      });
    }
  } else {
    log.warn('mapbox_desativado', { motivo: 'MAPBOX_TOKEN_ausente' });
  }

  // OSRM (próprio ou compatível). O servidor demo público NÃO é aceito em produção.
  const osrmBase = normalizarOsrm(cfg, log);
  if (osrmBase) {
    const perfil = /^[a-z0-9_-]{1,20}$/i.test(cfg.osrmProfile) ? cfg.osrmProfile : 'driving';
    provedores.push({
      nome: 'osrm',
      tipo: FRETE_TIPO.ROTA_OSRM,
      circuito: circuito(),
      orcamento: criarOrcamento({ porMinuto: cfg.osrmMaxPorMinuto, porDia: Infinity, agora }),
      stats: { chamadas: 0, ok: 0, falhas: 0 },
      buscar: (o, d) =>
        buscarDistanciaKm(
          `${osrmBase}/route/v1/${perfil}/${fmt(o.lon)},${fmt(o.lat)};${fmt(d.lon)},${fmt(d.lat)}` +
            `?overview=false&alternatives=false&steps=false`,
          cfg.osrmTimeoutMs,
        ),
    });
  }

  log.info('frete_iniciado', { provedores: provedores.map((p) => p.nome) });

  // ---- Cache + deduplicação de chamadas em voo ------------------------------
  const cache = criarCache({ max: cfg.cacheMax, ttlMs: cfg.cacheTtlMs, agora });
  const emVoo = new Map();
  const contadores = { cacheHits: 0, cacheMiss: 0, porTipo: {} };
  const contar = (tipo) => { contadores.porTipo[tipo] = (contadores.porTipo[tipo] ?? 0) + 1; };

  async function executarCadeia(origem, destino, chave) {
    const tentativas = [];
    for (const p of provedores) {
      if (!p.circuito.permitido()) {
        tentativas.push({ provedor: p.nome, resultado: 'circuito_aberto' });
        continue;
      }
      if (!p.orcamento.consumir()) {
        tentativas.push({ provedor: p.nome, resultado: 'orcamento_esgotado' });
        log.warn('orcamento_esgotado', { provedor: p.nome });
        continue;
      }
      const t0 = agora();
      p.stats.chamadas += 1;
      try {
        const km = await p.buscar(origem, destino);
        p.circuito.sucesso();
        p.stats.ok += 1;
        tentativas.push({ provedor: p.nome, resultado: 'ok', ms: agora() - t0 });
        const rota = { km, provedor: p.nome, frete_tipo: p.tipo };
        cache.set(chave, rota);
        return { rota, tentativas };
      } catch (err) {
        const motivo = err instanceof ProviderError ? err.motivo : 'erro_interno';
        // "sem rota" e 422 não indicam provedor doente: não contam para o circuito
        if (motivo !== 'sem_rota' && motivo !== 'http_422') p.circuito.falha();
        p.stats.falhas += 1;
        tentativas.push({ provedor: p.nome, resultado: motivo, ms: agora() - t0 });
        log.warn('provedor_falhou', { provedor: p.nome, motivo, ms: agora() - t0 });
      }
    }
    return { rota: null, tentativas };
  }

  async function resolverRota(origem, destino) {
    const chave = `${fmt(origem.lat)},${fmt(origem.lon)}>${fmt(destino.lat)},${fmt(destino.lon)}`;
    const hit = cache.get(chave);
    if (hit) {
      contadores.cacheHits += 1;
      return { rota: hit, tentativas: [{ provedor: hit.provedor, resultado: 'cache' }], cache: true };
    }
    contadores.cacheMiss += 1;
    let promessa = emVoo.get(chave);
    if (!promessa) {
      promessa = executarCadeia(origem, destino, chave).finally(() => emVoo.delete(chave));
      emVoo.set(chave, promessa);
    }
    return { ...(await promessa), cache: false };
  }

  // ---- Regras de negócio ----------------------------------------------------
  function validarRestaurante(r) {
    if (!r || typeof r !== 'object' || r.id === undefined || r.id === null || r.id === '') {
      throw new FreteError('RESTAURANTE_INVALIDO', 'Restaurante ausente ou sem id.', 500);
    }
    if (r.ativo === false) {
      throw new FreteError('RESTAURANTE_INATIVO', 'Restaurante inativo.', 403);
    }
    const base = dinheiro(r.taxa_base);
    const porKm = dinheiro(r.valor_km);
    if (base === null || porKm === null) {
      throw new FreteError('RESTAURANTE_INVALIDO', 'taxa_base/valor_km do restaurante inválidos.', 500);
    }
    let raio = null;
    if (r.raio_max_km !== null && r.raio_max_km !== undefined) {
      const n = typeof r.raio_max_km === 'string' ? Number(r.raio_max_km) : r.raio_max_km;
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
        throw new FreteError('RESTAURANTE_INVALIDO', 'raio_max_km do restaurante inválido.', 500);
      }
      raio = n;
    }
    return {
      id: String(r.id),
      baseCents: Math.round(base * 100),
      porKmCents: Math.round(porKm * 100),
      raioKm: raio,
      loja: validarCoordenadas(r.loja_lat, r.loja_lon),
    };
  }

  function normalizarBairro(b) {
    if (typeof b !== 'string') return null;
    const t = b.trim().replace(/\s+/g, ' ');
    return t.length >= 3 && t.length <= 80 ? t : null;
  }

  const centavosPorKm = (r, km) => r.baseCents + Math.round(km * r.porKmCents);
  const emReais = (c) => c / 100;

  /**
   * @param {{restaurante:object, destino?:{lat:any,lon:any}|null, bairro?:string|null}} entrada
   */
  async function calcularFrete(entrada) {
    const { restaurante, destino = null, bairro = null } = entrada ?? {};
    const r = validarRestaurante(restaurante);

    let alvo = null;
    if (destino !== null && destino !== undefined) {
      alvo = typeof destino === 'object' ? validarCoordenadas(destino.lat, destino.lon) : null;
      if (!alvo) {
        throw new FreteError('COORDENADAS_INVALIDAS', 'Latitude/longitude do destino inválidas.', 400);
      }
      alvo = { lat: coord4(alvo.lat), lon: coord4(alvo.lon) };
    }
    const bairroTxt = normalizarBairro(bairro);
    const origem = r.loja ? { lat: coord4(r.loja.lat), lon: coord4(r.loja.lon) } : null;
    const limiteKm = Math.min(r.raioKm ?? Infinity, cfg.maxKmHard);

    const tentativas = [];
    const base = (extra) => ({
      distancia_km: null,
      estimado: false,
      requer_confirmacao: false,
      bairro: null,
      cache: false,
      tentativas,
      ...extra,
    });

    // Pré-checagem barata: a rota nunca é (muito) menor que a linha reta.
    let linhaReta = null;
    if (alvo && origem) {
      linhaReta = haversineKm(origem.lat, origem.lon, alvo.lat, alvo.lon);
      if (linhaReta > limiteKm) {
        throw new FreteError('FORA_DA_AREA', 'Endereço fora da área de entrega.', 422, { limite_km: limiteKm });
      }
    } else if (alvo && !origem) {
      tentativas.push({ provedor: 'rota', resultado: 'loja_sem_coordenadas' });
      log.warn('loja_sem_coordenadas', { restaurante_id: r.id });
    }

    // 1 e 2: rota real (Mapbox, depois OSRM)
    if (alvo && origem) {
      const { rota, tentativas: t, cache: doCache } = await resolverRota(origem, alvo);
      tentativas.push(...t);
      if (rota) {
        if (rota.km > limiteKm) {
          throw new FreteError('FORA_DA_AREA', 'Endereço fora da área de entrega.', 422, { limite_km: limiteKm });
        }
        contar(rota.frete_tipo);
        const centavos = centavosPorKm(r, rota.km);
        return base({
          taxa: emReais(centavos),
          taxa_centavos: centavos,
          frete_tipo: rota.frete_tipo,
          distancia_km: rota.km,
          cache: doCache,
        });
      }
    }

    // 3: taxa cadastrada por bairro
    if (bairroTxt && buscarTaxaBairro) {
      try {
        const achado = await buscarTaxaBairro({ restauranteId: r.id, bairro: bairroTxt });
        const taxa = achado ? dinheiro(achado.taxa) : null;
        if (taxa !== null) {
          tentativas.push({ provedor: 'bairro', resultado: 'ok' });
          contar(FRETE_TIPO.BAIRRO);
          const centavos = Math.round(taxa * 100);
          return base({
            taxa: emReais(centavos),
            taxa_centavos: centavos,
            frete_tipo: FRETE_TIPO.BAIRRO,
            bairro: { id: achado.id ?? null, nome: achado.nome ?? null },
          });
        }
        tentativas.push({ provedor: 'bairro', resultado: 'nao_encontrado' });
      } catch {
        tentativas.push({ provedor: 'bairro', resultado: 'erro' });
        log.warn('bairro_falhou', { restaurante_id: r.id });
      }
    } else if (bairroTxt && !buscarTaxaBairro) {
      tentativas.push({ provedor: 'bairro', resultado: 'nao_configurado' });
    }

    // 4: Haversine x fator de rua — estimativa, pede confirmação humana
    if (alvo && origem) {
      const km = arredondar2(linhaReta * cfg.fatorRua);
      const centavos = centavosPorKm(r, km);
      tentativas.push({ provedor: 'haversine', resultado: 'ok' });
      contar(FRETE_TIPO.ESTIMADO);
      log.warn('frete_estimado', { restaurante_id: r.id });
      return base({
        taxa: emReais(centavos),
        taxa_centavos: centavos,
        frete_tipo: FRETE_TIPO.ESTIMADO,
        distancia_km: km,
        estimado: true,
        requer_confirmacao: true,
      });
    }

    throw new FreteError(
      'SEM_DADOS_PARA_FRETE',
      'Não foi possível calcular o frete: informe a localização ou um bairro válido.',
      422,
      { tentativas },
    );
  }

  function metricas() {
    return {
      cache: { tamanho: cache.tamanho, hits: contadores.cacheHits, misses: contadores.cacheMiss },
      resultados: { ...contadores.porTipo },
      provedores: provedores.map((p) => ({
        nome: p.nome,
        ...p.stats,
        circuito_aberto: p.circuito.aberto(),
        uso_hoje: p.orcamento.usoHoje(),
      })),
    };
  }

  return { calcularFrete, metricas };
}

function normalizarOsrm(cfg, log) {
  if (!cfg.osrmBaseUrl) {
    log.info('osrm_desativado', { motivo: 'OSRM_BASE_URL_ausente' });
    return null;
  }
  let u;
  try {
    u = new URL(cfg.osrmBaseUrl);
  } catch {
    log.warn('osrm_desativado', { motivo: 'url_invalida' });
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    log.warn('osrm_desativado', { motivo: 'protocolo_invalido' });
    return null;
  }
  if (u.username || u.password) {
    log.warn('osrm_desativado', { motivo: 'credenciais_na_url_nao_permitidas' });
    return null;
  }
  if (u.search || u.hash) {
    log.warn('osrm_desativado', { motivo: 'url_com_query_ou_hash' });
    return null;
  }
  if (OSRM_DEMO_HOSTS.has(u.hostname) && cfg.nodeEnv === 'production') {
    log.warn('osrm_demo_bloqueado_em_producao', { host: u.hostname });
    return null;
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

// ---------------------------------------------------------------------------
// Limitador de requisições (sem dependências; janela fixa em memória)
//
// Use em duas camadas, por exemplo:
//   por IP:           criarLimitadorDeRequisicoes({ max: 20, janelaMs: 60_000 })
//   por restaurante:  criarLimitadorDeRequisicoes({ max: 200, janelaMs: 60_000,
//                       chave: (req) => `r:${req.body?.slug ?? 'x'}` })
// Instância única do backend. Com várias instâncias, troque por Redis.
// ---------------------------------------------------------------------------

export function criarLimitadorDeRequisicoes({
  janelaMs = 60_000,
  max = 20,
  chave = (req) => req.ip,
  agora = Date.now,
  maxChaves = 50_000,
} = {}) {
  const baldes = new Map();
  const timer = setInterval(() => {
    const t = agora();
    for (const [k, b] of baldes) if (t - b.inicio >= janelaMs) baldes.delete(k);
  }, janelaMs);
  timer.unref?.();

  function limitador(req, res, next) {
    const k = String(chave(req) ?? 'desconhecido');
    const t = agora();
    let b = baldes.get(k);
    if (!b || t - b.inicio >= janelaMs) {
      if (!b && baldes.size >= maxChaves) baldes.delete(baldes.keys().next().value); // anti-estouro de memória
      b = { inicio: t, n: 0 };
      baldes.set(k, b);
    }
    b.n += 1;
    const restante = Math.max(0, max - b.n);
    const retryS = Math.max(1, Math.ceil((b.inicio + janelaMs - t) / 1000));
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(restante));
    if (b.n > max) {
      res.setHeader('Retry-After', String(retryS));
      return res.status(429).json({ erro: 'MUITAS_REQUISICOES', retry_after_s: retryS });
    }
    return next();
  }
  limitador.encerrar = () => clearInterval(timer);
  return limitador;
}

// ---------------------------------------------------------------------------
// Instância padrão (lê o ambiente na primeira chamada ou em configurarFrete)
// ---------------------------------------------------------------------------

let instancia = null;

export function configurarFrete(deps = {}, env = process.env) {
  instancia = criarServicoFrete({ config: lerConfigDoAmbiente(env), deps });
  return instancia;
}

export function calcularFrete(entrada) {
  if (!instancia) configurarFrete();
  return instancia.calcularFrete(entrada);
}

export function metricasFrete() {
  if (!instancia) configurarFrete();
  return instancia.metricas();
}
