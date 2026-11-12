// Aba Conta: avisos de pedido novo neste aparelho (notificação push, mesmo com a tela bloqueada).
import { sb } from './admin-supabase.js';
import { state } from './admin-state.js';
import { $, aviso, tratarErro } from './admin-utils.js';

// Chave PÚBLICA do push (pode ficar no código). A privada fica só na Render.
const VAPID_PUBLIC_KEY = 'BKsTsvV1P_i4FYt0kz0DIRCWH6v8WH902y3nDFCVIyLgc36GvWs53mR5ELcKH-lfLkeMxjTKYXgtt6DDG9yVtqo';

const suportado = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function chaveParaBytes(base64Url) {
  const preenchimento = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + preenchimento).replace(/-/g, '+').replace(/_/g, '/');
  const bruto = atob(base64);
  return Uint8Array.from(bruto, (c) => c.charCodeAt(0));
}

async function obterRegistro() {
  await navigator.serviceWorker.register('sw.js');
  return navigator.serviceWorker.ready;
}

// Guarda este aparelho no banco (protegido: cada dono só mexe nos seus)
async function gravarAparelho(inscricao, silencioso = false) {
  const dados = inscricao.toJSON();
  if (!state.rest || !sb || !dados.endpoint || !dados.keys) return false;

  const { error } = await sb.from('push_aparelhos').upsert(
    {
      restaurante_id: state.rest.id,
      endpoint: dados.endpoint,
      p256dh: dados.keys.p256dh,
      auth: dados.keys.auth,
      user_agent: String(navigator.userAgent || '').slice(0, 250)
    },
    { onConflict: 'endpoint' }
  );

  if (error) {
    if (silencioso) console.warn('[AVISOS] Não foi possível atualizar o aparelho:', error.message);
    else tratarErro(error, 'Não foi possível salvar este aparelho.');
    return false;
  }
  return true;
}

async function ativarAvisos() {
  if (!state.rest) {
    aviso('Aguarde o painel carregar e tente de novo.');
    return;
  }

  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    aviso('Sem a permissão do navegador, os avisos não funcionam.');
    return;
  }

  const registro = await obterRegistro();
  let inscricao = await registro.pushManager.getSubscription();

  if (!inscricao) {
    inscricao = await registro.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: chaveParaBytes(VAPID_PUBLIC_KEY)
    });
  }

  if (await gravarAparelho(inscricao)) aviso('✅ Avisos ativados neste aparelho!');
}

async function desativarAvisos() {
  const registro = await navigator.serviceWorker.getRegistration();
  const inscricao = registro ? await registro.pushManager.getSubscription() : null;
  if (!inscricao) return;

  await sb.from('push_aparelhos').delete().eq('endpoint', inscricao.endpoint);
  await inscricao.unsubscribe();
  aviso('Avisos desativados neste aparelho.');
}

async function alternarAvisos() {
  const botao = $('btn-avisos');
  if (!botao || botao.disabled) return;

  botao.disabled = true;
  try {
    if (botao.dataset.ativo === '1') await desativarAvisos();
    else await ativarAvisos();
  } catch (erro) {
    console.error('[AVISOS]', erro);
    aviso('Não foi possível alterar os avisos. Tente de novo.');
  } finally {
    botao.disabled = false;
    await atualizarAvisos();
  }
}

// Atualiza o texto e o botão conforme o estado deste aparelho
export async function atualizarAvisos() {
  const texto = $('avisos-status');
  const botao = $('btn-avisos');
  if (!texto || !botao) return;

  if (!suportado()) {
    texto.textContent = 'Este navegador não suporta avisos. No celular, use o Chrome.';
    botao.classList.add('hidden');
    return;
  }

  if (Notification.permission === 'denied') {
    texto.textContent = '⛔ Os avisos estão bloqueados neste navegador. Toque no cadeado ao lado do endereço, abra as configurações do site e libere "Notificações".';
    botao.classList.add('hidden');
    return;
  }

  botao.classList.remove('hidden');

  let ativo = false;
  try {
    const registro = await navigator.serviceWorker.getRegistration();
    const inscricao = registro ? await registro.pushManager.getSubscription() : null;
    if (inscricao && Notification.permission === 'granted') {
      ativo = true;
      await gravarAparelho(inscricao, true); // garante que o aparelho está no banco
    }
  } catch (erro) {
    console.warn('[AVISOS] Não foi possível verificar este aparelho:', erro);
  }

  texto.textContent = ativo ? '✅ Avisos ativados neste aparelho.' : 'Avisos desativados neste aparelho.';
  botao.textContent = ativo ? 'Desativar avisos' : 'Ativar avisos neste aparelho';
  botao.dataset.ativo = ativo ? '1' : '0';
}

// Cria o cartão "Avisos de pedido novo" no topo da aba Conta
export function montarCartaoAvisos() {
  if ($('cartao-avisos')) return;

  const referencia = $('cartao-whatsapp') || $('cartao-chave-pix');
  if (!referencia) return;

  const cartao = document.createElement('div');
  cartao.id = 'cartao-avisos';
  cartao.className = referencia.className;
  cartao.style.marginBottom = '16px';

  const rotulo = document.createElement('span');
  rotulo.className = 'bloco-label';
  rotulo.textContent = 'Avisos de pedido novo neste aparelho';

  const status = document.createElement('p');
  status.id = 'avisos-status';
  status.style.margin = '0 0 10px';
  status.textContent = 'Verificando...';

  const botao = document.createElement('button');
  botao.type = 'button';
  botao.id = 'btn-avisos';
  botao.className = $('btn-salvar-chave-pix')?.className || '';
  botao.dataset.ativo = '0';
  botao.textContent = 'Ativar avisos neste aparelho';
  botao.addEventListener('click', alternarAvisos);

  const dica = document.createElement('p');
  dica.className = 'placeholder-texto';
  dica.style.margin = '10px 0 0';
  dica.textContent = 'Toca no celular quando chega um pedido, mesmo com a tela bloqueada ou com outro app aberto, e repete até você aceitar. Ative em cada aparelho que vai receber pedidos.';

  cartao.append(rotulo, status, botao, dica);
  referencia.before(cartao);

  atualizarAvisos();
}
