/**
 * Fetch the FULL canonical geometry of a roundabout ring by OSM way ID.
 *
 * Roundabout detection (way-matching + roundabout.js) gives us the ring's way ID
 * from the points the rider actually traversed — but the rider only used an ARC of
 * the ring. To represent the roundabout as one canonical circle (so multi-lap
 * traversals can share identical vertices → BikeTerra renders ONE roundabout), we
 * pull the complete ring way from Overpass.
 *
 * Uses the SHARED hardened Overpass client (`runOverpassQuery` in overpass.js) — the same
 * mirror-fallback + per-server retries + Retry-After backoff used for bridges/tunnels — so a
 * 504/timeout on one mirror rolls over to the next instead of giving up. Results are cached
 * per way ID for the session (rings don't change mid-edit).
 */

import { runOverpassQuery } from './overpass.js'

const _cache = new Map() // wayId → { id, points:[{lat,lon}], oneway, closed }

/**
 * Fetch the full ring geometry for an OSM way ID.
 * Returns null on failure (caller degrades to the recorded arc).
 *
 * @param {number} wayId
 * @returns {Promise<{ id:number, points:Array<{lat:number,lon:number}>, oneway:boolean, closed:boolean } | null>}
 */
export async function fetchRing(wayId) {
  if (!wayId) return null
  if (_cache.has(wayId)) return _cache.get(wayId)

  // A single-way fetch is tiny and cached, so be GENTLE: one attempt per mirror (no
  // same-server retries — hammering a server that just 429/504'd only deepens the rate
  // limit) and a short timeout (a way fetch returns in ~1–2 s; a slow server → roll over).
  const query = `[out:json][timeout:15];way(${wayId});out geom tags;`
  try {
    const data = await runOverpassQuery(query, { attemptsPerServer: 1, requestTimeoutMs: 10000 })
    const ring = parseRing(data, wayId)
    _cache.set(wayId, ring)   // cache the parsed result (a clean response won't improve on retry)
    return ring
  } catch (err) {
    // Every mirror+attempt failed — leave uncached so a later edit can retry.
    console.warn(`[overpass-ring] failed to fetch ring ${wayId}:`, err?.message)
    return null
  }
}

/** Parse the single-way Overpass response into a ring object. */
function parseRing(data, wayId) {
  if (!data || !Array.isArray(data.elements)) return null
  const el = data.elements.find((e) => e.type === 'way' && e.id === wayId) || data.elements[0]
  if (!el || !el.geometry || el.geometry.length < 2) return null
  const points = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }))
  const tags = el.tags || {}
  const first = points[0], last = points[points.length - 1]
  const closed = Math.abs(first.lat - last.lat) < 1e-9 && Math.abs(first.lon - last.lon) < 1e-9
  return {
    id: wayId,
    points,
    // A junction=roundabout way is one-way by definition; honour an explicit tag too.
    oneway: tags.junction === 'roundabout' || tags.oneway === 'yes',
    closed,
  }
}

/** Test/maintenance helper — clear the session ring cache. */
export function _clearRingCache() {
  _cache.clear()
}
