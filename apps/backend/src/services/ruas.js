// =============================================================================
// ruas.js: busca de ruas para o autocomplete do cardápio (rua + bairro)
// =============================================================================
// Fonte: tabela public.cidade_ruas (base IBGE/CNEFE), lida só pelo backend
// (service_role). O cliente nunca acessa a tabela direto.
//
// Regras de segurança desta rota:
//  - NUNCA devolve taxa de entrega. Só rua, bairro e (se for seguro) bairro_id.
//  - O bairro da loja só é preenchido quando o nome do bairro do IBGE é IGUAL
//    ao nome de um bairro da loja (sem acento/maiúscula/pontuação), o bairro
//    está ativo e tem taxa. Sinônimos NUNCA entram na comparação.
//  - Nome igual em dois bairros da loja = ambíguo = não preenche.
//  - O pedido continua validando bairro_id e calculando o frete no backend
//    (esta rota é só uma ajuda de preenchimento).
// =============================================================================

export const CIDADE_IBGE_PADRAO = '3168606'; // Teófilo Otoni - MG

const LIMITE_SUGESTOES = 12;
const LIMITE_LINHAS_BANCO = 500;
const TTL_CONTEXTO_MS = 60_000;
const MAX_CONTEXTOS_EM_CACHE = 200;
const MIN_CHARS = 3;
const MAX_CHARS = 60;
const MAX_CHARS_BRUTO = 100;
const MAX_PALAVRAS = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sem acento, MAIÚSCULA, só letras/números/espaço, espaços colapsados. */
export function normalizarTexto(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Valida e prepara o texto digitado. Devolve { ok, palavras, texto } ou { ok:false, codigo }. */
export function prepararBusca(q) {
  if (typeof q !== 'string') return { ok: false, codigo: 'TERMO_INVALIDO' };
  if (q.length > MAX_CHARS_BRUTO) return { ok: false, codigo: 'TERMO_LONGO' };

  const texto = normalizarTexto(q);
  if (texto.length < MIN_CHARS) return { ok: false, codigo: 'TERMO_CURTO' };
  if (texto.length > MAX_CHARS) return { ok: false, codigo: 'TERMO_LONGO' };

  const palavras = texto.split(' ');
  if (palavras.length > MAX_PALAVRAS) return { ok: false, codigo: 'TERMO_LONGO' };

  return { ok: true, texto, palavras };
}

function taxaPreenchida(taxa) {
  if (taxa === null || taxa === undefined || taxa === '') return false;
  return Number.isFinite(Number(taxa));
}

/**
 * Mapa nome normalizado -> bairro da loja, só com bairros ativos e com taxa.
 * Nome normalizado repetido vira null (ambíguo: nunca preenche).
 */
export function indexarBairrosDaLoja(bairros) {
  const mapa = new Map();
  for (const b of bairros || []) {
    if (!b || b.ativo !== true || !taxaPreenchida(b.taxa) || !b.id || !b.nome) continue;
    const chave = normalizarTexto(b.nome);
    if (!chave) continue;
    mapa.set(chave, mapa.has(chave) ? null : { id: b.id, nome: b.nome });
  }
  return mapa;
}

/** 0 = começa com o texto; 1 = cada palavra começa uma palavra da rua; 2 = o resto. */
export function pontuar(logradouroNormalizado, texto, palavras) {
  if (logradouroNormalizado.startsWith(texto)) return 0;
  const palavrasRua = logradouroNormalizado.split(' ');
  const todasNoInicio = palavras.every((p) => palavrasRua.some((r) => r.startsWith(p)));
  return todasNoInicio ? 1 : 2;
}

/**
 * Monta as sugestões. `linhas` vêm de cidade_ruas; `indiceBairros` de indexarBairrosDaLoja.
 * Nada aqui devolve taxa.
 */
export function montarSugestoes({ linhas, indiceBairros, texto, palavras }) {
  const vistos = new Set();
  const itens = [];

  for (const l of linhas || []) {
    const logNorm = normalizarTexto(l.logradouro_normalizado || l.logradouro);
    const bairroNorm = normalizarTexto(l.bairro_normalizado || l.bairro);
    if (!logNorm || !palavras.every((p) => logNorm.includes(p))) continue;

    const chaveUnica = `${logNorm}|${bairroNorm}`;
    if (vistos.has(chaveUnica)) continue;
    vistos.add(chaveUnica);

    const bairroLoja = indiceBairros.get(bairroNorm) || null;

    itens.push({
      pontos: pontuar(logNorm, texto, palavras),
      logNorm,
      bairroNorm,
      sugestao: {
        rua: String(l.logradouro),
        bairro_exibicao: bairroLoja ? bairroLoja.nome : String(l.bairro),
        bairro_id: bairroLoja ? bairroLoja.id : null,
        preenche: Boolean(bairroLoja)
      }
    });
  }

  itens.sort((a, b) =>
    a.pontos - b.pontos ||
    a.logNorm.localeCompare(b.logNorm) ||
    a.bairroNorm.localeCompare(b.bairroNorm)
  );

  return itens.slice(0, LIMITE_SUGESTOES).map((i) => i.sugestao);
}

/**
 * Serviço com acesso ao banco injetado (facilita os testes).
 * db = { buscarRestaurante(id), listarBairros(id), buscarRuas({ cidadeIbge, palavras }) }
 */
export function criarServicoRuas({
  db,
  cidadeIbge = CIDADE_IBGE_PADRAO,
  agora = Date.now,
  ttlMs = TTL_CONTEXTO_MS
}) {
  const cache = new Map();

  async function contexto(restauranteId) {
    const t = agora();
    const guardado = cache.get(restauranteId);
    if (guardado && guardado.expira > t) return guardado.valor;

    const restaurante = await db.buscarRestaurante(restauranteId);
    if (!restaurante || restaurante.ativo !== true) return null; // não guarda em cache

    const bairros = await db.listarBairros(restauranteId);
    const valor = { indiceBairros: indexarBairrosDaLoja(bairros) };

    if (cache.size >= MAX_CONTEXTOS_EM_CACHE) cache.delete(cache.keys().next().value);
    cache.set(restauranteId, { valor, expira: t + ttlMs });
    return valor;
  }

  /** Devolve { status, corpo } pronto para responder. */
  async function buscar({ restauranteId, q }) {
    if (typeof restauranteId !== 'string' || !UUID_RE.test(restauranteId)) {
      return { status: 400, corpo: { sucesso: false, codigo: 'RESTAURANTE_INVALIDO' } };
    }

    const busca = prepararBusca(q);
    if (!busca.ok) {
      return { status: 400, corpo: { sucesso: false, codigo: busca.codigo } };
    }

    const ctx = await contexto(restauranteId);
    if (!ctx) {
      return { status: 404, corpo: { sucesso: false, codigo: 'RESTAURANTE_NAO_ENCONTRADO' } };
    }

    const linhas = await db.buscarRuas({ cidadeIbge, palavras: busca.palavras });
    const sugestoes = montarSugestoes({
      linhas,
      indiceBairros: ctx.indiceBairros,
      texto: busca.texto,
      palavras: busca.palavras
    });

    return { status: 200, corpo: { sucesso: true, sugestoes } };
  }

  return { buscar };
}

/** Acesso real ao Supabase (service_role). As palavras já vêm normalizadas (A-Z, 0-9). */
export function criarDbRuas(supabase) {
  return {
    async buscarRestaurante(id) {
      const { data, error } = await supabase
        .from('restaurantes')
        .select('id, ativo')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`restaurantes: ${error.message}`);
      return data;
    },

    async listarBairros(restauranteId) {
      const { data, error } = await supabase
        .from('bairros')
        .select('id, nome, ativo, taxa')
        .eq('restaurante_id', restauranteId);
      if (error) throw new Error(`bairros: ${error.message}`);
      return data || [];
    },

    async buscarRuas({ cidadeIbge, palavras }) {
      let consulta = supabase
        .from('cidade_ruas')
        .select('bairro, bairro_normalizado, logradouro, logradouro_normalizado')
        .eq('cidade_ibge', cidadeIbge);
      for (const p of palavras) consulta = consulta.ilike('logradouro_normalizado', `%${p}%`);
      const { data, error } = await consulta.limit(LIMITE_LINHAS_BANCO);
      if (error) throw new Error(`cidade_ruas: ${error.message}`);
      return data || [];
    }
  };
}

/**
 * Middlewares da rota POST /api/ruas/buscar, na ordem:
 * limitador próprio -> leitura do JSON (limite pequeno) -> busca -> erro de JSON inválido (400).
 */
export function middlewaresBuscaRuas({ servico, limitador, parserJson, log = console }) {
  async function tratar(req, res) {
    const { restaurante_id: restauranteId, q } = req.body || {};
    try {
      const { status, corpo } = await servico.buscar({ restauranteId, q });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(status).json(corpo);
    } catch (erro) {
      log.error('[ERRO BUSCA RUAS]:', erro.message);
      return res.status(500).json({ sucesso: false, codigo: 'ERRO_BUSCA' });
    }
  }

  // eslint-disable-next-line no-unused-vars
  function erroDeJson(erro, _req, res, _next) {
    if (erro && (erro.type === 'entity.parse.failed' || erro instanceof SyntaxError)) {
      return res.status(400).json({ sucesso: false, codigo: 'JSON_INVALIDO' });
    }
    if (erro && erro.type === 'entity.too.large') {
      return res.status(413).json({ sucesso: false, codigo: 'CORPO_GRANDE' });
    }
    log.error('[ERRO BUSCA RUAS]:', erro?.message);
    return res.status(500).json({ sucesso: false, codigo: 'ERRO_BUSCA' });
  }

  return [limitador, parserJson, tratar, erroDeJson];
}
