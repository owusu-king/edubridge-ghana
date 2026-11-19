/**
 * EduBridge service worker: just enough for the screens that work offline to open without a connection.
 *
 * - Offline pages are fetched from the network first and kept, so a page opened (or saved for offline)
 *   while connected opens again offline: class registers (/s/{school}/attendance and
 *   /s/{school}/attendance/{class}), lesson registers (/s/{school}/attendance/{class}/lessons/{period}), score sheets (/s/{school}/assessment/{class}/subjects/{subject}) and
 *   student registration (/s/{school}/students/register).
 * - The parent view (PRT-07, PRT-03): the family home, each child's page and school news, and receipts and
 *   statements once downloaded, are kept from the network so they open offline (the page shows the time
 *   they are from). Limited to the most recent copies, and deleted when the sign-in page opens (sign-out,
 *   or a session that ended), so another person on the phone does not see them after sign-out.
 * - Built assets (/_next/static, content-hashed) are kept once loaded.
 * - Nothing else is cached: no other pages, no API. The page caches are cleared on sign-out.
 * Marks taken offline are not handled here; the register page keeps them on the device (IndexedDB) and
 * sends them when the connection returns.
 */
const PAGES = "edubridge-pages-v1";
const ASSETS = "edubridge-assets-v1";
const PARENT = "edubridge-parent-v1";
const PARENT_PAGES = [/^\/p\/?$/, /^\/p\/[^/]+\/[0-9a-f-]{36}\/?$/, /^\/p\/[^/]+\/news\/?$/];
const PARENT_FILES = [
  /^\/p\/[^/]+\/receipts\/[0-9a-f-]{36}\/pdf$/,
  /^\/p\/[^/]+\/[0-9a-f-]{36}\/statement$/,
  /^\/p\/[^/]+\/family-statement$/,
];
/** At most this many parent copies (pages and files) are kept; the oldest go first. */
const PARENT_MAX = 40;
const parentPage = (pathname) => PARENT_PAGES.some((pattern) => pattern.test(pathname));
const parentFile = (url) => !url.search && PARENT_FILES.some((pattern) => pattern.test(url.pathname));
const OFFLINE_PAGES = [
  /^\/s\/[^/]+\/attendance(?:\/[0-9a-f-]{36})?\/?$/,
  /^\/s\/[^/]+\/attendance\/[0-9a-f-]{36}\/lessons\/[0-9a-f-]{36}\/?$/,
  /^\/s\/[^/]+\/assessment\/[0-9a-f-]{36}\/subjects\/[0-9a-f-]{36}\/?$/,
  /^\/s\/[^/]+\/students\/register\/?$/,
  /^\/s\/[^/]+\/fees\/offline-payments\/?$/,
];
const offlinePage = (pathname) => OFFLINE_PAGES.some((pattern) => pattern.test(pathname));

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (![PAGES, ASSETS, PARENT].includes(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

const keepable = (response) => response && response.ok && response.type === "basic" && !response.redirected;

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key);
}

async function pageFromNetwork(request, cacheName = PAGES) {
  try {
    const response = await fetch(request);
    if (keepable(response)) {
      const cache = await caches.open(cacheName);
      // Re-adding moves the copy to the end, so trimming removes the least recently opened.
      await cache.delete(request);
      await cache.put(request, response.clone());
      if (cacheName === PARENT) await trim(PARENT, PARENT_MAX);
    }
    return response;
  } catch {
    const cached = await (await caches.open(cacheName)).match(request);
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
  // Opening the parent sign-in page means nobody is signed in on this phone: remove the family's copies.
  if (request.mode === "navigate" && url.pathname.startsWith("/p/login"))
    event.waitUntil(caches.delete(PARENT));
  if (request.mode === "navigate" && parentPage(url.pathname))
    event.respondWith(pageFromNetwork(request, PARENT));
  if (parentFile(url)) event.respondWith(pageFromNetwork(request, PARENT));
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
  if (data.type === "clear-parent") event.waitUntil(caches.delete(PARENT));
});

/**
 * Web push (R3-2). A push says only that a school has something new (no names, amounts or text); tapping it
 * opens the page in the parent view, where the parent must be signed in. Only parent-view paths are opened.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 80) : "EduBridge";
  const body = typeof data.body === "string" ? data.body.slice(0, 160) : "Something new from your school.";
  const url = typeof data.url === "string" && /^\/p(\/|$)/.test(data.url) ? data.url : "/p";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: url,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/p", self.location.origin);
  // Only this site's parent view (/p) and school pages (/s, staff notifications) are opened.
  if (url.origin !== self.location.origin || !/^\/(p|s)(\/|$)/.test(url.pathname)) return;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = open.find((c) => new URL(c.url).pathname === url.pathname);
      if (same) return same.focus();
      return self.clients.openWindow(url.href);
    })(),
  );
});
