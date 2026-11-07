/**
 * EduBridge service worker: just enough for the screens that work offline to open without a connection.
 *
 * - Offline pages are fetched from the network first and kept, so a page opened (or saved for offline)
 *   while connected opens again offline: class registers (/s/{school}/attendance and
 *   /s/{school}/attendance/{class}), score sheets (/s/{school}/assessment/{class}/subjects/{subject}) and
 *   student registration (/s/{school}/students/register).
 * - Built assets (/_next/static, content-hashed) are kept once loaded.
 * - Nothing else is cached: no other pages, no API, no documents. The page cache is cleared on sign-out.
 * Marks taken offline are not handled here; the register page keeps them on the device (IndexedDB) and
 * sends them when the connection returns.
 */
const PAGES = "edubridge-pages-v1";
const ASSETS = "edubridge-assets-v1";
const OFFLINE_PAGES = [
  /^\/s\/[^/]+\/attendance(?:\/[0-9a-f-]{36})?\/?$/,
  /^\/s\/[^/]+\/assessment\/[0-9a-f-]{36}\/subjects\/[0-9a-f-]{36}\/?$/,
  /^\/s\/[^/]+\/students\/register\/?$/,
];
const offlinePage = (pathname) => OFFLINE_PAGES.some((pattern) => pattern.test(pathname));

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (![PAGES, ASSETS].includes(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

const keepable = (response) => response && response.ok && response.type === "basic" && !response.redirected;

async function pageFromNetwork(request) {
  try {
    const response = await fetch(request);
    if (keepable(response)) await (await caches.open(PAGES)).put(request, response.clone());
    return response;
  } catch {
    const cached = await (await caches.open(PAGES)).match(request);
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>' +
        '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1b1a17">' +
        '<h1 style="font-weight:500">You are offline</h1><p>This page was not saved on this device. Open it once while connected and it will open offline afterwards.</p>',
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

async function assetFromCache(request) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (keepable(response)) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(assetFromCache(request));
    return;
  }
  // Only full page loads of register pages; in-app (RSC) navigations go to the network and, offline, the
  // router falls back to a full page load, which is answered from the cache.
  if (request.mode === "navigate" && offlinePage(url.pathname)) event.respondWith(pageFromNetwork(request));
});

/** Saves register pages, and the assets they load, so they open offline later. */
async function savePages(urls) {
  const pages = await caches.open(PAGES);
  const assets = await caches.open(ASSETS);
  for (const href of urls) {
    const url = new URL(href, self.location.origin);
    if (url.origin !== self.location.origin || !offlinePage(url.pathname)) continue;
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!keepable(response)) continue;
      const html = await response.clone().text();
      await pages.put(url, response);
      const found = new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) ?? []);
      for (const asset of found)
        if (!(await assets.match(asset))) {
          const a = await fetch(asset);
          if (keepable(a)) await assets.put(asset, a);
        }
    } catch {
      // Offline or failed: try again next time.
    }
  }
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  // The page is told when the copies are saved (so it can say the register opens offline).
  if (data.type === "save-pages" && Array.isArray(data.urls))
    event.waitUntil(savePages(data.urls).then(() => event.ports[0]?.postMessage({ saved: true })));
  if (data.type === "clear") event.waitUntil(caches.delete(PAGES));
});
