/* SpaceGen Racing service worker: cache-first shell so a return visit starts
   instantly and an installed PWA opens offline. Versioned cache name, so a new
   deploy replaces the old shell rather than serving a stale bundle forever. */
const CACHE = 'spacegen-v1'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './favicon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Hashed build assets are immutable: serve from cache, fall back to network.
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
        }
        return res
      }).catch(() => caches.match('./index.html'))
    }),
  )
})
