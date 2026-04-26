/**
 * Routing API clients — OSRM (bike) + Valhalla (car/bike fallback).
 *
 * OSRM bike on routing.openstreetmap.de is fastest (~0.07s) but lacks
 * coverage on remote roads. Valhalla on valhalla1.openstreetmap.de has
 * full global coverage but is slower (~1–2s).
 *
 * Profiles:
 *   'car'   → Valhalla auto — DEFAULT, full global coverage
 *   'bike'  → Valhalla bicycle — cycling-specific routing
 *   'auto'  → OSRM bike first, Valhalla car fallback if snap > 1km
 */

const OSRM_BASE = 'https://routing.openstreetmap.de/routed-bike/route/v1/cycling/'
let VALHALLA_BASE = 'https://valhalla1.openstreetmap.de'

// Fetch config from server (non-blocking — uses fallback until resolved)
fetch('/api/config')
  .then(r => r.json())
  .then(c => { if (c.valhalla_url) VALHALLA_BASE = c.valhalla_url })
  .catch(() => {}) // silently use fallback

// ────────────────────────────────────────────────────────────────────
// Polyline6 decoder (Valhalla shape format)
// ────────────────────────────────────────────────────────────────────

/**
 * Decode a Google-style encoded polyline with precision 6 (Valhalla default).
 * @param {string} encoded — encoded polyline string
 * @returns {Array<[number, number]>} — [[lat, lon], ...]
 */
export function decodePolyline6(encoded) {
  const coords = []
  let lat = 0
  let lon = 0
  let i = 0

  while (i < encoded.length) {
    let shift = 0
    let result = 0
    let byte
    do {
      byte = encoded.charCodeAt(i++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lat += (result & 1) ? ~(result >> 1) : (result >> 1)

    shift = 0
    result = 0
    do {
      byte = encoded.charCodeAt(i++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lon += (result & 1) ? ~(result >> 1) : (result >> 1)

    coords.push([lat / 1e6, lon / 1e6])
  }

  return coords
}

// ────────────────────────────────────────────────────────────────────
// OSRM (bike only)
// ────────────────────────────────────────────────────────────────────

/**
 * Route via OSRM cycling profile.
 * @returns {Promise<{ coords: [number, number][], dist: number }>}
 */
async function osrmRoute(fromLat, fromLon, toLat, toLon) {
  const url = OSRM_BASE
    + `${fromLon},${fromLat};${toLon},${toLat}`
    + '?overview=full&geometries=geojson'

  const r = await fetch(url)
  if (!r.ok) throw new Error(`OSRM HTTP ${r.status}`)
  const j = await r.json()
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error('OSRM: no route')

  return {
    coords: j.routes[0].geometry.coordinates.map(([lo, la]) => [la, lo]),
    dist: j.routes[0].distance,
    waypoints: j.waypoints,
  }
}

// ────────────────────────────────────────────────────────────────────
// Valhalla (car or bike)
// ────────────────────────────────────────────────────────────────────

/**
 * Route via Valhalla.
 * @param {string} costing — 'auto' (car) or 'bicycle'
 * @param {object} [costingOpts] — extra costing_options fields (e.g. ignore_oneways)
 * @returns {Promise<{ coords: [number, number][], dist: number }>}
 */
async function valhallaRoute(fromLat, fromLon, toLat, toLon, costing = 'auto', costingOpts = {}) {
  const MAX_RETRIES = 4
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let r
    try {
      const body = { locations: [{ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }], costing }
      if (Object.keys(costingOpts).length > 0) body.costing_options = { [costing]: costingOpts }
      r = await fetch(`${VALHALLA_BASE}/route`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    } catch (fetchErr) {
      // CORS-blocked 429 shows as TypeError: Failed to fetch
      // Treat any fetch failure as a rate limit and back off
      const delay = 1000 * Math.pow(2, attempt)
      console.warn(`[Valhalla] fetch failed (likely 429), retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
      continue
    }

    if (r.status === 429) {
      const delay = 1000 * Math.pow(2, attempt)
      console.warn(`[Valhalla] 429 rate limited, retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
      continue
    }

    if (!r.ok) throw new Error(`Valhalla HTTP ${r.status}`)
    const j = await r.json()

    const leg = j.trip?.legs?.[0]
    if (!leg?.shape) throw new Error('Valhalla: no route')

    return {
      coords: decodePolyline6(leg.shape),
      dist: (leg.summary?.length ?? 0) * 1000,
    }
  }
  throw new Error('Valhalla: rate limited after retries')
}

// ────────────────────────────────────────────────────────────────────
// Multi-waypoint batch routing
// ────────────────────────────────────────────────────────────────────

/** Valhalla max locations per request */
const VALHALLA_MAX_LOCATIONS = 20

/**
 * Route via Valhalla multi-waypoint request.
 * Returns one segment (coord array) per leg.
 * @param {Array<{ lat: number, lon: number }>} waypoints — 2+ waypoints
 * @param {string} costing — 'auto' or 'bicycle'
 * @param {object} [costingOpts] — extra costing_options fields (e.g. ignore_oneways)
 * @returns {Promise<Array<[number, number][]>>} — array of segments, each [[lat,lon],...]
 */
export async function valhallaMulti(waypoints, costing = 'auto', costingOpts = {}) {
  const MAX_RETRIES = 4
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let r
    try {
      const body = { locations: waypoints.map(w => ({ lat: w.lat, lon: w.lon })), costing }
      if (Object.keys(costingOpts).length > 0) body.costing_options = { [costing]: costingOpts }
      r = await fetch(`${VALHALLA_BASE}/route`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    } catch {
      const delay = 1000 * Math.pow(2, attempt)
      console.warn(`[Valhalla] fetch failed, retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
      continue
    }

    if (r.status === 429) {
      const delay = 1000 * Math.pow(2, attempt)
      console.warn(`[Valhalla] 429 rate limited, retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
      continue
    }

    if (!r.ok) throw new Error(`Valhalla HTTP ${r.status}`)
    const j = await r.json()

    const legs = j.trip?.legs
    if (!legs || legs.length === 0) throw new Error('Valhalla: no route')

    return legs.map(leg => decodePolyline6(leg.shape))
  }
  throw new Error('Valhalla: rate limited after retries')
}

/**
 * Route all waypoints via Valhalla in batches of 20 (server limit).
 * Overlapping endpoints ensure continuous coverage.
 *
 * @param {Array<{ lat: number, lon: number }>} waypoints — all waypoints
 * @param {string} [costing='auto'] — 'auto' or 'bicycle'
 * @param {Function} [onProgress] — (batchIdx, totalBatches) progress callback
 * @param {object} [costingOpts] — extra costing_options fields (e.g. ignore_oneways)
 * @returns {Promise<Array<[number, number][]>>} — one segment per waypoint pair
 */
export async function valhallaBatchRoute(waypoints, costing = 'auto', onProgress, costingOpts = {}) {
  if (waypoints.length < 2) return []

  const allSegments = []
  const batchSize = VALHALLA_MAX_LOCATIONS
  const totalBatches = Math.ceil((waypoints.length - 1) / (batchSize - 1))

  for (let b = 0; b < waypoints.length - 1; b += batchSize - 1) {
    const batch = waypoints.slice(b, b + batchSize)
    if (batch.length < 2) break

    if (onProgress) onProgress(allSegments.length, waypoints.length - 1, totalBatches)

    // Throttle between batches to avoid 429
    if (allSegments.length > 0) await new Promise(r => setTimeout(r, 1000))

    try {
      const segments = await valhallaMulti(batch, costing, costingOpts)
      allSegments.push(...segments)
    } catch (err) {
      // Batch failed — retry each pair individually so only truly
      // unroutable pairs get straight lines, not the whole batch
      console.warn(`[Valhalla] Batch failed, retrying pairs individually:`, err.message)
      for (let i = 0; i < batch.length - 1; i++) {
        try {
          const pair = [batch[i], batch[i + 1]]
          const [seg] = await valhallaMulti(pair, costing, costingOpts)
          allSegments.push(seg)
        } catch {
          console.warn(`[Valhalla] Pair ${i} failed, straight line: ${batch[i].lat.toFixed(4)},${batch[i].lon.toFixed(4)} → ${batch[i+1].lat.toFixed(4)},${batch[i+1].lon.toFixed(4)}`)
          allSegments.push([[batch[i].lat, batch[i].lon], [batch[i + 1].lat, batch[i + 1].lon]])
        }
        // Throttle between individual retries
        if (i < batch.length - 2) await new Promise(r => setTimeout(r, 500))
      }
    }
  }

  return allSegments
}

// ────────────────────────────────────────────────────────────────────
// Single-segment routing (for drag-to-reroute)
// ────────────────────────────────────────────────────────────────────

/** Max snap distance (m) before considering OSRM result invalid */
const SNAP_DISTANCE_LIMIT = 1000

/**
 * Route a single segment between two points.
 * Used for drag-to-reroute (1-2 segments at a time).
 *
 * @param {number} fromLat
 * @param {number} fromLon
 * @param {number} toLat
 * @param {number} toLon
 * @param {string} [profile='car'] — 'car' (default), 'bike', 'pedestrian', or 'auto'
 * @param {{ ignoreOneways?: boolean, ignoreRestrictions?: boolean }} [opts]
 * @returns {Promise<{ coords: [number, number][], dist: number }>}
 *   coords as [lat, lon] pairs, dist in metres
 */
export async function valhallaSegment(fromLat, fromLon, toLat, toLon, profile = 'car', opts = {}) {
  const ignoreOneways      = opts.ignoreOneways      ?? true
  const ignoreRestrictions = opts.ignoreRestrictions ?? true
  const costingOpts = { ignore_oneways: ignoreOneways, ignore_restrictions: ignoreRestrictions }

  if (profile === 'car') {
    return await valhallaRoute(fromLat, fromLon, toLat, toLon, 'auto', costingOpts)
  }

  if (profile === 'bike') {
    return await valhallaRoute(fromLat, fromLon, toLat, toLon, 'bicycle', costingOpts)
  }

  if (profile === 'pedestrian') {
    // max_distance raised to 100km — Valhalla's default cap is too low for hiking routes
    const pedestrianOpts = { ...costingOpts, walking_speed: 5.1, max_distance: 100000 }
    return await valhallaRoute(fromLat, fromLon, toLat, toLon, 'pedestrian', pedestrianOpts)
  }

  // 'auto' mode: try OSRM bike first, fallback to Valhalla car
  try {
    const result = await osrmRoute(fromLat, fromLon, toLat, toLon)
    const wps = result.waypoints
    if (wps) {
      const maxSnap = Math.max(...wps.map(w => w.distance || 0))
      if (maxSnap > SNAP_DISTANCE_LIMIT) {
        return await valhallaRoute(fromLat, fromLon, toLat, toLon, 'auto', costingOpts)
      }
    }
    return { coords: result.coords, dist: result.dist }
  } catch {
    return await valhallaRoute(fromLat, fromLon, toLat, toLon, 'auto', costingOpts)
  }
}
