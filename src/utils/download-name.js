import { reverseGeocode } from '../api/place-search.js'

const REVERSE_DELAY_MS = 2000
let _lastReverseAt = 0
const _placeCache = new Map()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cacheKey(lat, lon) {
  const a = Number(lat).toFixed(5)
  const b = Number(lon).toFixed(5)
  return `${a},${b}`
}

function sanitizePart(v) {
  return String(v || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(v, max = 48) {
  if (v.length <= max) return v
  return v.slice(0, max).trim()
}

function placeLabelFromAddress(result) {
  const address = result?.address || {}
  const road = address.road || address.pedestrian || address.footway || address.path || address.cycleway || address.residential
  const area = address.neighbourhood || address.suburb || address.hamlet || address.village || address.town || address.city
  const primary = sanitizePart(road || area || '')
  if (primary) return clip(primary)

  const display = sanitizePart(result?.displayName || '')
  if (!display) return ''
  const first = sanitizePart(display.split(',')[0] || '')
  return clip(first || display)
}

async function reverseWithThrottle(lat, lon) {
  const key = cacheKey(lat, lon)
  if (_placeCache.has(key)) return _placeCache.get(key)

  const waitMs = REVERSE_DELAY_MS - (Date.now() - _lastReverseAt)
  if (waitMs > 0) await sleep(waitMs)

  _lastReverseAt = Date.now()
  const place = await reverseGeocode(lat, lon)
  const label = placeLabelFromAddress(place)
  _placeCache.set(key, label)
  return label
}

/**
 * Build a human route filename from route start/end points.
 *
 * Falls back to source filename if reverse geocoding fails.
 *
 * @param {object} args
 * @param {number} args.startLat
 * @param {number} args.startLon
 * @param {number} args.endLat
 * @param {number} args.endLon
 * @param {string} args.fallbackBaseName
 * @param {string} [args.suffix='']
 * @returns {Promise<string>}
 */
export async function buildDownloadFilename({
  startLat,
  startLon,
  endLat,
  endLon,
  fallbackBaseName,
  suffix = '',
}) {
  const fallbackBase = sanitizePart(fallbackBaseName || 'route') || 'route'
  let startPart = ''
  let endPart = ''

  try {
    startPart = sanitizePart(await reverseWithThrottle(startLat, startLon))
  } catch (err) {
    console.warn('[GPXForge] Download naming: start reverse-geocode failed', err)
  }

  try {
    endPart = sanitizePart(await reverseWithThrottle(endLat, endLon))
  } catch (err) {
    console.warn('[GPXForge] Download naming: end reverse-geocode failed', err)
  }

  if (startPart && endPart) {
    const same = startPart.toLowerCase() === endPart.toLowerCase()
    const base = same ? `${clip(startPart)}-loop` : `${clip(startPart)}-${clip(endPart)}`
    return `${base}${suffix}.gpx`
  }

  if (startPart) return `${clip(startPart)}${suffix}.gpx`
  if (endPart) return `${clip(endPart)}${suffix}.gpx`
  return `${fallbackBase}${suffix}.gpx`
}

