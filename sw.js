/* Undercurrent — service worker
   - Precaches the app shell so the installed app can still open offline.
   - NETWORK-FIRST for shell + static deps (fonts): every launch pulls the
     latest HTML/logic; the cache is used only when the network is slow
     (past NET_TIMEOUT) or down. A redeploy therefore takes effect on the
     very next open — no stale-logic session.
   - Live data is NEVER cached: all POSTs go straight to the network, and GETs
     to the market/on-chain API hosts bypass the cache so you never read stale
     prices, funding, or flows. */

const CACHE = 'undercurrent-v1';
const SHELL = ['./index.html', './manifest.webmanifest'];

// hosts whose responses must always be live (never cached)
const LIVE_HOSTS = new Set(['api.hyperliquid.xyz', 'api.etherscan.io']);

// how long to wait on the network before falling back to cache (ms)
const NET_TIMEOUT = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // tolerate any single asset failing so install still succeeds
    await Promise.all(SHELL.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // POSTs (the Hyperliquid info API) and other non-GET verbs: never intercept.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Live data hosts: straight to the network, no cache read or write.
  if (LIVE_HOSTS.has(url.hostname)) return;

  // Everything else (app shell, manifest, fonts): NETWORK-FIRST.
  // Serve fresh from network; fall back to cache only if the network is slow
  // (NET_TIMEOUT) or fails. The cache is still refreshed whenever the network
  // eventually responds, so a slow open doesn't leave the cache stale.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // network fetch that also refreshes the cache on success
    const netP = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    });
    // keep it alive past the response so the cache updates even after a
    // timeout fallback (next open is then current)
    e.waitUntil(netP.catch(() => {}));

    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NET_TIMEOUT); });

    try {
      const winner = await Promise.race([netP, timeout]);
      clearTimeout(timer);
      if (winner) return winner;                 // network returned in time -> fresh

      // slow network: serve cache if we have it, else wait the network out
      const cached = await cache.match(req);
      if (cached) return cached;
      return await netP;
    } catch (_) {
      // network failed: serve cache, with a navigation fallback to the shell
      clearTimeout(timer);
      const cached = await cache.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        return (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               Response.error();
      }
      return Response.error();
    }
  })());
});
