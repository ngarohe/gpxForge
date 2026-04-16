/**
 * Minimal non-blocking toast notification.
 * Replaces browser-blocking alert() for user-facing errors.
 *
 * @param {string} message
 * @param {{ type?: 'info'|'error', duration?: number }} [opts]
 */
export function showToast(message, { type = 'info', duration = 5000 } = {}) {
  const el = document.createElement('div')
  el.className = `gpxforge-toast gpxforge-toast--${type}`
  el.textContent = message

  document.body.appendChild(el)
  // Trigger CSS transition
  requestAnimationFrame(() => el.classList.add('gpxforge-toast--visible'))

  setTimeout(() => {
    el.classList.remove('gpxforge-toast--visible')
    el.addEventListener('transitionend', () => el.remove(), { once: true })
  }, duration)
}
