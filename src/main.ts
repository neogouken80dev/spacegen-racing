import './ui/styles.css'
import { boot } from './game/main'

const start = (): void => {
  boot()
  // Register the offline shell. Never let a service worker failure stop the
  // game from starting.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
      // updateViaCache 'none' keeps the browser's HTTP cache away from sw.js
      // itself, so a new worker is actually noticed on the next visit rather
      // than after the old script's max-age expires.
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .then((reg) => { reg.update().catch(() => {}) })
        .catch(() => {})
    })
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
else start()
