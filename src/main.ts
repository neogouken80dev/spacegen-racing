import './ui/styles.css'
import { boot } from './game/main'

const start = (): void => {
  boot()
  // Register the offline shell. Never let a service worker failure stop the
  // game from starting.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {})
    })
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
else start()
