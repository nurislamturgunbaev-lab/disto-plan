// Офлайн-работа: оболочка приложения кэшируется, модуль DWG — при первом использовании.
const CACHE = 'disto-plan-v1.8.1';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/disto.js', 'js/dxf.js', 'js/cad.js', 'js/walls.js', 'js/pdf.js', 'js/zip.js', 'js/default-plan.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // сеть в приоритете (свежая версия), кэш — без связи
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
