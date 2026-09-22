/*
 * Service Worker: hace posible que la app funcione sin conexión a internet.
 * Estrategia: "cache first" para los archivos propios de la app (siempre
 * los sirve desde el celular si ya los descargó una vez), y "network first
 * con respaldo en caché" para recursos externos como las fuentes de Google,
 * para que funcionen offline después del primer uso online.
 */

const CACHE_NAME = "libreta-stock-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const esRecursoPropio = url.origin === self.location.origin;

  if (esRecursoPropio) {
    // Cache first para el propio app shell
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copia = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
        return res;
      }).catch(() => caches.match("./index.html")))
    );
  } else {
    // Network first con respaldo en caché para recursos externos (fuentes)
    event.respondWith(
      fetch(req).then((res) => {
        const copia = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
