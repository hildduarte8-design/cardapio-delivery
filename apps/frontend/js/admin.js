import { sb, configurado } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, aviso, tratarErro } from './admin-utils.js';
import { carregarPedidos, iniciarPedidos, pararPedidos, inicializarPedidos } from './admin-pedidos.js';
import { carregarProdutos, inicializarProdutos } from './admin-produtos.js';
import { abrirAbaPainel, fecharAbaPainel, inicializarAbaPainel } from './admin-painel.js';
import { carregarBairros, preencherRestaurante, inicializarEntrega } from './admin-entrega.js';

let inicializacaoEmAndamento = false;

function mostrarAba(nome) {
  ['painel', 'pedidos', 'produtos', 'entrega', 'config'].forEach((aba) => {
    $(`aba-${aba}`).classList.toggle('hidden', aba !== nome);

    const botao = document.querySelector(`[data-aba="${aba}"]`);
    if (botao) {
      botao.classList.toggle('ativa', aba === nome);
      if (aba === nome) botao.setAttribute('aria-current', 'page');
      else botao.removeAttribute('aria-current');
    }
  });

  // O painel só busca números enquanto está aberto
  if (nome === 'painel') abrirAbaPainel();
  else fecharAbaPainel();
}

function configurarNavegacao() {
  $('abas').addEventListener('click', (evento) => {
    const botao = evento.target.closest('[data-aba]');
    if (botao) mostrarAba(botao.dataset.aba);
  });
}

function mostrarSemAcesso() {
  $('sem-acesso').classList.remove('hidden');
  $('abas').classList.add('hidden');

  ['pedidos', 'produtos', 'entrega', 'config'].forEach((aba) => {
    $(`aba-${aba}`).classList.add('hidden');
  });
}

function esconderSemAcesso() {
  $('sem-acesso').classList.add('hidden');
  $('abas').classList.remove('hidden');
}

async function iniciarPainel() {
  if (!sb || inicializacaoEmAndamento) return;

  inicializacaoEmAndamento = true;

  try {
    const { data, error } = await sb
      .from('restaurante_usuarios')
      .select('restaurantes(*)')
      .limit(1);

    if (error) {
      tratarErro(error, 'Não foi possível carregar seu restaurante.');
      return;
    }

    if (!data?.length || !data[0].restaurantes) {
      mostrarSemAcesso();
      return;
    }

    state.rest = data[0].restaurantes;
    esconderSemAcesso();

    $('rest-nome').innerText = state.rest.nome;
    const linkCardapio = `index.html?r=${encodeURIComponent(state.rest.slug)}`;
    const elLink = $('rest-link');
    elLink.href = linkCardapio;
    elLink.innerText = `Cardápio: index.html?r=${state.rest.slug}`;

    preencherRestaurante();
    mostrarAba('pedidos');

    await Promise.all([
      carregarPedidos(),
      carregarProdutos(),
      carregarBairros()
    ]);

    iniciarPedidos();
  } finally {
    inicializacaoEmAndamento = false;
  }
}

async function checarSessao() {
  if (!configurado || !sb) {
    $('aviso-config').classList.remove('hidden');
    $('aviso-config').innerText =
      'Configuração do Supabase ausente ou biblioteca não carregada.';
    return;
  }

  const { data, error } = await sb.auth.getSession();

  if (error) {
    tratarErro(error, 'Erro ao verificar sessão.');
    return;
  }

  const sessao = data?.session;

  $('tela-login').classList.toggle('hidden', Boolean(sessao));
  $('tela-admin').classList.toggle('hidden', !sessao);

  if (sessao) {
    await iniciarPainel();
  } else {
    pararPedidos();
    fecharAbaPainel();
    state.rest = null;
  }
}

function configurarLogin() {
  $('form-login').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (!sb) return;

    const botao = $('btn-login');
    botao.disabled = true;
    botao.innerText = 'Entrando...';

    const { error } = await sb.auth.signInWithPassword({
      email: $('login-email').value.trim(),
      password: $('login-senha').value
    });

    botao.disabled = false;
    botao.innerText = 'Entrar';

    if (error) {
      alert('E-mail ou senha incorretos.');
      return;
    }

    $('login-senha').value = '';
    await checarSessao();
  });

  $('btn-sair').addEventListener('click', async () => {
    if (!sb) return;

    await sb.auth.signOut();
    pararPedidos();
    fecharAbaPainel();
    state.rest = null;
    await checarSessao();
  });
}

function configurarConta() {
  $('form-senha').addEventListener('submit', async (evento) => {
    evento.preventDefault();

    const novaSenha = $('nova-senha').value;
    const confirmaSenha = $('confirma-senha').value;

    if (novaSenha.length < 6) {
      aviso('A nova senha deve ter no mínimo 6 caracteres.');
      return;
    }

    if (novaSenha !== confirmaSenha) {
      aviso('As senhas digitadas não coincidem.');
      return;
    }

    const botao = $('btn-alterar-senha');
    botao.disabled = true;
    botao.innerText = 'Alterando...';

    const { error } = await sb.auth.updateUser({ password: novaSenha });

    botao.disabled = false;
    botao.innerText = 'Alterar Senha';

    if (error) {
      tratarErro(error, 'Erro ao alterar a senha.');
      return;
    }

    $('form-senha').reset();
    aviso('Senha alterada com sucesso!');
  });
}

function inicializar() {
  inicializarPedidos();
  inicializarProdutos();
  inicializarEntrega();
  inicializarAbaPainel();
  configurarNavegacao();
  configurarLogin();
  configurarConta();

  window.addEventListener('admin:session-expired', async () => {
    if (sb) await sb.auth.signOut();
    pararPedidos();
    fecharAbaPainel();
    state.rest = null;
    await checarSessao();
  });

  checarSessao();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inicializar, { once: true });
} else {
  inicializar();
}
