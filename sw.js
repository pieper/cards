/* Service worker: offline play (airplane mode) + fresh updates when online. */
const CACHE = "cards-v1";

// App shell precached on install. The Phone deck draws in JS (no card files), so
// the shell alone is enough to play fully offline; art-deck SVGs are cached at
// runtime the first time you view them online.
const SHELL = [
  "./", "index.html", "styles.css", "solitaire.js", "manifest.webmanifest",
  "assets/icons/icon-192.png", "assets/icons/icon-512.png", "assets/icons/apple-touch-icon.png",
];
const SHELL_BASENAMES = ["index.html", "styles.css", "solitaire.js", "manifest.webmanifest"];
const isShell = p => SHELL_BASENAMES.includes(p.split("/").pop());

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Cross-origin (win photos from loremflickr/picsum): straight to network, no
  // caching — they simply won't show in airplane mode, which is fine.
  if (url.origin !== location.origin) return;

  // App shell + page navigations: network-first so online play always gets the
  // latest code; fall back to cache when offline.
  if (req.mode === "navigate" || isShell(url.pathname)) {
    e.respondWith(
      fetch(req)
        .then(res => { const c = res.clone(); caches.open(CACHE).then(k => k.put(req, c)); return res; })
        .catch(() => caches.match(req).then(r => r || caches.match("./")))
    );
    return;
  }

  // Other same-origin assets (deck SVGs, icons): cache-first + runtime cache.
  e.respondWith(
    caches.match(req).then(hit =>
      hit || fetch(req).then(res => {
        if (res.ok) { const c = res.clone(); caches.open(CACHE).then(k => k.put(req, c)); }
        return res;
      }).catch(() => hit)
    )
  );
});
