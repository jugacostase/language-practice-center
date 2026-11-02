// Offline support: the app shell (HTML, SQLite engine, icons) is cached on install and
// served from cache first. Google Fonts are cached the first time they load.
// Bump VERSION whenever any file changes so phones pick up the update.
const VERSION = "kanji-srs-v4";
const FONT_CACHE = "kanji-srs-fonts";
const SHELL = [
  "./", "./index.html", "./db-worker.js", "./manifest.webmanifest",
  "./sqlite/sqlite3.mjs", "./sqlite/sqlite3.wasm",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
  "./icons/maskable-192.png", "./icons/maskable-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONT_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req); if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === "navigate" ? await c.match("./index.html") : null);
    if (hit) return hit;
    return fetch(req);
  })());
});
