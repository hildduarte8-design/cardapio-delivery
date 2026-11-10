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

export function tratarErro(error, mensagemPadrao) {
  console.error(error);

  if (error && /jwt|token|expired/i.test(error.message || '')) {
    aviso('Sessão expirada. Entre novamente.');
    window.dispatchEvent(new CustomEvent('admin:session-expired'));
    return;
  }

  aviso(
    mensagemPadrao +
    (error?.message ? ` (${error.message})` : '')
  );
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
