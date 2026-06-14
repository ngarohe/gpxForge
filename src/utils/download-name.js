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
  const place = address.village || address.town || address.city
    || address.hamlet || address.suburb || address.neighbourhood
  const road = address.road || address.pedestrian || address.footway
    || address.path || address.cycleway || address.residential
  const primary = sanitizePart(place || road || '')
  if (primary) return clip(primary)

  const display = sanitizePart(result?.displayName || '')
  if (!display) return ''
  const first = sanitizePart(display.split(',')[0] || '')
  return clip(first || display)
}

function countryFromAddress(result) {
  const address = result?.address || {}
  return sanitizePart(address.country || '')
}

async function reverseWithThrottle(lat, lon) {
  const key = cacheKey(lat, lon)
  if (_placeCache.has(key)) return _placeCache.get(key)

  const waitMs = REVERSE_DELAY_MS - (Date.now() - _lastReverseAt)
  if (waitMs > 0) await sleep(waitMs)

  _lastReverseAt = Date.now()
  const result = await reverseGeocode(lat, lon)
  const label = placeLabelFromAddress(result)
  const country = countryFromAddress(result)
  const entry = { label, country }
  _placeCache.set(key, entry)
  return entry
}

/**
 * Build a human route filename from route start/end points.
 *
 * Format: "Start - End - Country.gpx"
 * Loops:  "Start - Midpoint - Start - Country.gpx"
 *
 * @param {object} args
 * @param {number} args.startLat
 * @param {number} args.startLon
 * @param {number} args.endLat
 * @param {number} args.endLon
 * @param {string} args.fallbackBaseName
 * @param {string} [args.suffix='']
 * @param {number} [args.midLat] — midpoint lat for loop naming
 * @param {number} [args.midLon] — midpoint lon for loop naming
 * @returns {Promise<string>}
 */
export async function buildDownloadFilename({
  startLat,
  startLon,
  endLat,
  endLon,
  fallbackBaseName,
  suffix = '',
  midLat,
  midLon,
}) {
  const fallbackBase = sanitizePart(fallbackBaseName || 'route') || 'route'
  let startEntry = { label: '', country: '' }
  let endEntry = { label: '', country: '' }

  try {
    startEntry = await reverseWithThrottle(startLat, startLon)
  } catch (err) {
    console.warn('[GPXForge] Download naming: start reverse-geocode failed', err)
  }

  try {
    endEntry = await reverseWithThrottle(endLat, endLon)
  } catch (err) {
    console.warn('[GPXForge] Download naming: end reverse-geocode failed', err)
  }

  const startLabel = startEntry.label
  const endLabel = endEntry.label
  const country = startEntry.country || endEntry.country
  const countrySuffix = country ? ` - ${clip(country, 30)}` : ''

  if (startLabel && endLabel) {
    const isLoop = startLabel.toLowerCase() === endLabel.toLowerCase()
    let base
    if (isLoop) {
      let midLabel = ''
      if (midLat != null && midLon != null) {
        try {
          const midEntry = await reverseWithThrottle(midLat, midLon)
          midLabel = midEntry.label
        } catch (_) { /* ignore */ }
      }
      if (midLabel && midLabel.toLowerCase() !== startLabel.toLowerCase()) {
        base = `${clip(startLabel, 30)} - ${clip(midLabel, 30)} - ${clip(startLabel, 30)}`
      } else {
        base = `${clip(startLabel)} loop`
      }
    } else {
      base = `${clip(startLabel)} - ${clip(endLabel)}`
    }
    return `${base}${countrySuffix}${suffix}.gpx`
  }

  if (startLabel) return `${clip(startLabel)}${countrySuffix}${suffix}.gpx`
  if (endLabel) return `${clip(endLabel)}${countrySuffix}${suffix}.gpx`
  return `${fallbackBase}${suffix}.gpx`
}

