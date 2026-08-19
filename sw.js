const CACHE_NAME = 'jrinvent-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data-service.js',
  './firebase-config.js',
  './excel_cleaner.js',
  './manifest.json',
  './icon.png',
  './Logo_nova-removebg-preview.png',
  './Captura_de_tela_2025-11-18_114317-removebg-preview.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('Alguns assets não puderam ser pré-cacheados:', err);
      });
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
  const url = event.request.url;
  
  // Ignora chamadas ao Firestore / Google APIs no SW cache manual (o Firestore SDK já gerencia seu próprio cache persistente com IndexedDB)
  if (url.includes('firestore.googleapis.com') || url.includes('gstatic.com/firebasejs')) {
    return;
  }

  const isNetworkFirst =
    event.request.mode === 'navigate' ||
    url.includes('.js') ||
    url.includes('.css') ||
    url.includes('.html') ||
    url.includes('manifest.json');

  if (isNetworkFirst) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Imagens e assets estáticos: Cache First
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
