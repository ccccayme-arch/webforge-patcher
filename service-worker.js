// WebForge Patcher — Service Worker
const CACHE_NAME = 'webforge-v9';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/usb-bridge.js',
  './js/boot-image.js',
  './js/ramdisk-patcher.js',
  './js/vbmeta.js',
  './js/odin.js',
  './js/utils.js',
  './js/ai-assistant.js',
  './js/lz4.js',
  './js/md5.js',
  './js/boot-validator.js',
  './data/codes.json',
  './manifest.json',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-256.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  // CDN dependencies (pre-cache for offline use)
  'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js',
  'https://cdn.jsdelivr.net/npm/lz4js@0.3.0/dist/lz4.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')));
  } else {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        }).catch(() => cached)
      )
    );
  }
});
