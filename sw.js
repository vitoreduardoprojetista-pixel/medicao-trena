/* Cache do app para funcionar sem internet depois da 1ª abertura */
const CACHE = 'medicao-trena-v26';
const SHELL = ['./', 'index.html', 'medicao.html', 'tuya.js', 'app.js', 'parse.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // arquivos do app: sempre busca a versão nova na rede (sem usar o cache do navegador),
    // guarda uma cópia e cai pro cache só quando está sem internet
    e.respondWith(fetch(req, { cache: 'no-store' }).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return r; })
      .catch(() => caches.match(req).then(r => r || (url.pathname.endsWith('/') ? caches.match('index.html') : Response.error()))));
  } else {
    // bibliotecas e dados do leitor (CDN): cache primeiro
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok || r.type === 'opaque') { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
      return r;
    })));
  }
});
