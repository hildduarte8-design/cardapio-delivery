import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';

export const $ = (id) => document.getElementById(id);

export const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});

export const esc = (valor) =>
  String(valor ?? '').replace(/[&<>"']/g, (caractere) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[caractere]));

export const num = (valor) => {
  if (valor === '' || valor === null || valor === undefined) return null;
  const resultado = Number(valor);
  return Number.isFinite(resultado) ? resultado : null;
};

export function aviso(mensagem) {
  const elemento = $('toast');
  if (!elemento) return;

  elemento.innerText = mensagem;
  elemento.classList.remove('hidden');

  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    elemento.classList.add('hidden');
  }, 2500);
}

// Traduz erros técnicos do banco para um texto curto e amigável.
// O texto técnico original continua no Console (F12) para investigação.
function mensagemAmigavel(error, mensagemPadrao) {
  const texto = String(error?.message || '');
  const codigo = String(error?.code || '');

  if (codigo === '23505' || /duplicate key|unique constraint/i.test(texto)) {
    return 'Esse cadastro já existe.';
  }
  if (codigo === '23502' || /null value in column|not-null/i.test(texto)) {
    return 'Faltou preencher um campo.';
  }
  if (codigo === '23514' || /check constraint/i.test(texto)) {
    return 'Algum valor está fora do permitido. Confira os campos.';
  }
  if (codigo === '23503' || /foreign key/i.test(texto)) {
    return 'Isso está ligado a outro cadastro e não pode ser alterado.';
  }
  if (codigo === '42501' || /row-level security|permission denied/i.test(texto)) {
    return 'Você não tem permissão para fazer isso.';
  }
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(texto)) {
    return 'Sem conexão no momento. Tente de novo.';
  }

  return mensagemPadrao || 'Não deu certo. Tente de novo.';
}

export function tratarErro(error, mensagemPadrao) {
  console.error(error);

  if (error && /jwt|token|expired/i.test(error.message || '')) {
    aviso('Sessão expirada. Entre novamente.');
    window.dispatchEvent(new CustomEvent('admin:session-expired'));
    return;
  }

  aviso(mensagemAmigavel(error, mensagemPadrao));
}

export async function atualizar(tabela, id, campos, mensagemSucesso) {
  if (!sb) {
    aviso('Conexão com o banco indisponível.');
    return null;
  }

  const { data, error } = await sb
    .from(tabela)
    .update(campos)
    .eq('id', id)
    .select();

  if (error || !data?.length) {
    tratarErro(error, 'Não foi possível salvar.');
    return null;
  }

  aviso(mensagemSucesso);
  return data[0];
}

export const achar = (lista, id) =>
  lista.find((item) => String(item.id) === String(id));
