const CACHE_NAME = 'jrinvent-v4';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.png',
  './Logo_nova-removebg-preview.png',
  './Captura_de_tela_2025-11-18_114317-removebg-preview.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('Clearing old PWA cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Always fetch fresh code/markup/data from network first for instant updates.
  // (Adicionado .css e navegação de página/raiz, que antes ficavam presos no cache antigo.)
  const url = event.request.url;
  const isNetworkFirst =
    event.request.mode === 'navigate' ||
    url.includes('.js') ||
    url.includes('.css') ||
    url.includes('.html') ||
    url.includes('manifest.json') ||
    url.includes('/api/');

  if (isNetworkFirst) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Apenas imagens/ícones ficam cache-first (não mudam com frequência)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
