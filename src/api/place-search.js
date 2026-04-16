/**
 * Place search API client (Nominatim).
 *
 * Supports optional base override via VITE_GEOCODE_BASE_URL.
 * Falls back to the public OpenStreetMap Nominatim endpoint.
 */

const RAW_GEOCODE_BASE_URL = (import.meta.env.VITE_GEOCODE_BASE_URL || '').trim()
const GEOCODE_BASE_URL = (RAW_GEOCODE_BASE_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '')

function buildSearchUrl(query, limit) {
  const u = new URL(`${GEOCODE_BASE_URL}/search`)
  u.searchParams.set('q', String(query || '').trim())
  u.searchParams.set('format', 'jsonv2')
  u.searchParams.set('limit', String(limit || 1))
  return u
}

function buildReverseUrl(lat, lon) {
  const u = new URL(`${GEOCODE_BASE_URL}/reverse`)
  u.searchParams.set('lat', String(lat))
  u.searchParams.set('lon', String(lon))
  u.searchParams.set('format', 'jsonv2')
  u.searchParams.set('addressdetails', '1')
  return u
}

function toPlaceResult(item, fallbackName) {
  const lat = Number(item.lat)
  const lon = Number(item.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  const name = String(item.display_name || fallbackName || '')

  let bbox = null
  if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
    const south = Number(item.boundingbox[0])
    const north = Number(item.boundingbox[1])
    const west = Number(item.boundingbox[2])
    const east = Number(item.boundingbox[3])
    if ([south, north, west, east].every(Number.isFinite)) {
      bbox = [south, west, north, east]
    }
  }

  return { lat, lon, name, bbox }
}

/**
 * Search a place name and return the best match.
 *
 * @param {string} query - place/city text
 * @returns {Promise<{
 *   lat: number,
 *   lon: number,
 *   name: string,
 *   bbox: [number, number, number, number] | null
 * } | null>}
 */
export async function searchPlace(query) {
  const q = String(query || '').trim()
  if (!q) return null

  const res = await fetch(buildSearchUrl(q, 1).toString(), {
    signal: AbortSignal.timeout(8000),
    headers: { 'Accept-Language': globalThis?.navigator?.language || 'en' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const results = await res.json()
  if (!Array.isArray(results) || results.length === 0) return null
  return toPlaceResult(results[0], q)
}

/**
 * Get place suggestions for autocomplete dropdown.
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{
 *   lat: number,
 *   lon: number,
 *   name: string,
 *   bbox: [number, number, number, number] | null
 * }>>}
 */
export async function searchPlaceSuggestions(query, limit = 5, signal) {
  const q = String(query || '').trim()
  if (q.length < 2) return []

  const safeLimit = Math.max(1, Math.min(8, Math.floor(limit)))
  const res = await fetch(buildSearchUrl(q, safeLimit).toString(), {
    signal,
    headers: { 'Accept-Language': globalThis?.navigator?.language || 'en' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const rows = await res.json()
  if (!Array.isArray(rows)) return []
  return rows
    .map((r) => toPlaceResult(r, q))
    .filter(Boolean)
}

/**
 * Reverse geocode a coordinate to a place object.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{ displayName: string, address: Record<string, string> } | null>}
 */
export async function reverseGeocode(lat, lon) {
  const nLat = Number(lat)
  const nLon = Number(lon)
  if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) return null

  const res = await fetch(buildReverseUrl(nLat, nLon).toString(), {
    signal: AbortSignal.timeout(8000),
    headers: { 'Accept-Language': globalThis?.navigator?.language || 'en' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const row = await res.json()
  if (!row || typeof row !== 'object') return null
  return {
    displayName: String(row.display_name || '').trim(),
    address: (row.address && typeof row.address === 'object') ? row.address : {},
  }
}
