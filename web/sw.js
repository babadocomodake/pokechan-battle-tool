// Service Worker: オフライン起動と高速化のためのキャッシュ。
// 方針: アプリシェル（HTML/CSS/JS/アイコン）は cache-first。
//       data/*.json は stale-while-revalidate（まずキャッシュを返し、裏で更新）。
// キャッシュ名のバージョンを上げると古いキャッシュは activate で破棄される。
const VERSION = "v22";
const SHELL_CACHE = `pokechan-shell-${VERSION}`;
const DATA_CACHE = `pokechan-data-${VERSION}`;
const FONT_CACHE = `pokechan-font-${VERSION}`;

// 事前キャッシュするアプリシェル（相対パス＝Pagesサブパスでも動く）
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/starter-252.png",
  "./icons/starter-255.png",
  "./icons/starter-258.png",
  "./js/app.js",
  "./js/data.js",
  "./js/favorites.js",
  "./js/calc/stats.js",
  "./js/calc/damage.js",
  "./js/calc/modifiers.js",
  "./js/calc/speed.js",
  "./js/calc/stages.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE && k !== FONT_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Googleフォント（別オリジン）: 初回取得後はキャッシュ優先でオフラインでもドット表示を維持
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // 同一オリジンのみ扱う（外部リンクは素通し）
  if (url.origin !== self.location.origin) return;

  // データJSON: stale-while-revalidate
  if (url.pathname.includes("/data/") && url.pathname.endsWith(".json")) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // それ以外（アプリシェル）: cache-first ＋ 取得できたら更新
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) caches.open(SHELL_CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
