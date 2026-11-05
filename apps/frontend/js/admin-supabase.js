// Configuração centralizada do Supabase.
// A chave publishable/anon pode estar no frontend. Nunca coloque service_role aqui.
const SUPABASE_URL = 'https://wdxqkagwuzekzxdhxbnp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_raTvDULM2YDmTngVIOM11g_CZe6jZWj';

export const configurado =
  Boolean(SUPABASE_URL && SUPABASE_ANON_KEY) &&
  !SUPABASE_URL.includes('SUA_') &&
  !SUPABASE_ANON_KEY.includes('SUA_');

const supabaseGlobal = window.supabase;

export const sb =
  configurado && supabaseGlobal?.createClient
    ? supabaseGlobal.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
