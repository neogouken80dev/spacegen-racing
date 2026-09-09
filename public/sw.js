/* SpaceGen Racing service worker.
 *
 * WHY THIS IS NOT CACHE-FIRST FOR EVERYTHING.
 *
 * It used to be, and it meant a returning player could never receive an
 * update. The fetch handler tried the cache before the network for EVERY
 * same-origin GET, and `index.html` was in that cache. So a return visit was
 * served the old index.html, which names the old hashed bundles, which were
 * also in the cache -- a closed loop with no path back to the network. The
 * cache name was a hardcoded 'spacegen-v1' that never changed, so the activate
 * handler's "delete everything that is not the current cache" deleted nothing,
 * and the `must-revalidate` header Netlify sends on index.html never applied
 * because the request never reached the network. The file's own comment
 * claimed a versioned cache name replaced the shell on each deploy. It did
 * not. Reported from play as a fresh deploy that did not contain its changes.
 *
 * The rule now follows what the thing actually IS:
 *
 *   navigation / HTML  -> NETWORK FIRST. The document names which bundles to
 *                         load, so it must never be answered from cache while
 *                         a network exists. Cache is the offline fallback.
 *   /assets/<hashed>   -> cache first. Vite content-hashes these, so a given
 *                         URL's bytes never change and a hit is always right.
 *   everything else    -> network first, cache fallback. Manifest and icons
 *                         are small and unhashed; correctness beats a few ms.
 *
 * CACHE is stamped per build by the vite plugin in vite.config.ts, so the
 * activate handler genuinely evicts the previous build's assets instead of
 * accumulating every bundle ever shipped.
 */
const CACHE = 'spacegen-__SW_BUILD__'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './favicon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Never let one missing shell entry fail the whole install: a service
      // worker that cannot install leaves the player on the previous one.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function putCopy(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    const copy = res.clone()
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
  }
  return res
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Hashed, immutable build output. A hit is always the right bytes.
  if (url.pathname.includes('/assets/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => putCopy(req, res))),
    )
    return
  }

  // Everything else, the document above all: ask the network, keep a copy for
  // offline, and fall back to the cache only when the network fails.
  e.respondWith(
    fetch(req)
      .then((res) => putCopy(req, res))
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  )
})
