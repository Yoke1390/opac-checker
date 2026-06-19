const CACHE = 'opac-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-maskable.svg',
];
const CDN_URL = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
const API_HOSTS = new Set(['api.openbd.jp', 'www.googleapis.com', 'm.media-amazon.com']);

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      await cache.addAll(SHELL);
      try { await cache.add(CDN_URL); } catch (_) {}
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const { hostname } = new URL(e.request.url);

  // API・外部リソース：ネットワーク優先、失敗時にキャッシュへフォールバック
  if (API_HOSTS.has(hostname)) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // アプリシェル：キャッシュ優先、バックグラウンドで更新
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const fresh = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        });
        return cached ?? fresh;
      })
    )
  );
});
