// Service worker: rede primeiro, cache só como reserva offline.
// Nunca guarda chamadas ao Supabase (outro domínio) nem requisições que não sejam GET.
const CACHE = 'cardapio-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});

// ---------- Avisos push (pedido novo para o lojista) ----------
self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch (erro) {
    dados = { corpo: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(dados.titulo || '🔔 Novo pedido!', {
      body: dados.corpo || 'Toque para abrir o painel.',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: dados.tag || 'pedido-novo',   // mesma tag: o aviso novo substitui o anterior
      renotify: true,                     // e toca/vibra de novo
      requireInteraction: true,
      vibrate: [300, 120, 300, 120, 300],
      data: { url: dados.url || 'admin.html' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = new URL(
    (event.notification.data && event.notification.data.url) || 'admin.html',
    self.registration.scope
  ).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if (new URL(janela.url).pathname.includes('admin') && 'focus' in janela) return janela.focus();
      }
      return self.clients.openWindow(destino);
    })
  );
});
