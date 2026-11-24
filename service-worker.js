// Só o "casco" do app fica em cache (abre rápido e sem rede). Nenhuma chamada ao relay é guardada aqui.
const CACHE = 'dudoo-lite-web-v25';
const CASCO = ['./', 'index.html', 'styles.css', 'app.js', 'notificacoes.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CASCO)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});

// Notificações push (24/11/2026): o aviso chega como {titulo, texto, aba, tag}. No iOS TODO push tem que mostrar uma notificação (userVisibleOnly).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { titulo: 'Dudoo Lite', texto: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Dudoo Lite', {
    body: d.texto || '', tag: d.tag || undefined, icon: 'icon-192.png', badge: 'icon-192.png', data: { aba: d.aba || 'hoje' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const aba = (e.notification.data || {}).aba || 'hoje';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
    for (const j of janelas) if ('focus' in j) { j.postMessage({ tipo: 'abrir-aba', aba }); return j.focus(); }
    return self.clients.openWindow('./?aba=' + encodeURIComponent(aba));
  }));
});
