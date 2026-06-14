/**
 * Fetch the OSM ways CONNECTED at each detected junction.
 *
 * `detectOsmJunctions` finds where the route branches, but the graph only contains the roads the
 * route physically drove. To make every legal turn routable (and to handle roundabouts + future
 * multilevel/Z correctly), we pull each junction's connected ways from OSM: the cross-streets the
 * track never used become selectable legs, and the shared-node test (done in `junctionLegs`)
 * naturally excludes a bridge-over / tunnel-under (a different way that shares no vertex).
 *
 * Uses the SHARED hardened Overpass client (`runOverpassQuery`) — same mirror fallback + backoff as
 * the bridge/tunnel and ring fetchers — and a per-request session cache. Best-effort: returns []
 * on failure so the editor degrades to the recorded-only graph.
 */

import { runOverpassQuery } from './overpass.js'

const _cache = new Map() // cacheKey → way[]

/**
 * Fetch all highway ways near the given junction centres (one batched query).
 * @param {Array<{lat:number,lon:number}>} centers
 * @param {{ radiusM?:number }} [opts] — radiusM (20): catch ways with a node this near a centre.
 * @returns {Promise<Array<{ id:number, points:Array<{lat,lon}>, highway:string, oneway:boolean,
 *   roundabout:boolean, layer:number, bridge:boolean, tunnel:boolean }>>}
 */
export async function fetchJunctionWays(centers, opts = {}) {
  if (!centers || !centers.length) return []
  const radiusM = opts.radiusM ?? 20
  const key = centers.map((c) => `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`).sort().join(';') + '@' + radiusM
  if (_cache.has(key)) return _cache.get(key)

  const around = centers.map((c) => `  way(around:${radiusM},${c.lat},${c.lon})[highway];`).join('\n')
  const query = `[out:json][timeout:25];\n(\n${around}\n);\nout geom tags;`
  // Bounding box of the junctions → lets the shared client pick a regional mirror.
  const lats = centers.map((c) => c.lat), lons = centers.map((c) => c.lon)
  const bounds = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) }
  try {
    // GENTLE: one attempt per mirror (retrying a tiny query against a server that just 504/429'd
    // only deepens rate-limiting — roll to the next mirror instead), but a generous per-attempt
    // timeout so a merely-SLOW mirror still succeeds. `bounds` enables the regional mirror.
    const data = await runOverpassQuery(query, { bounds, attemptsPerServer: 1, requestTimeoutMs: 25000 })
    const ways = parseJunctionWays(data)
    _cache.set(key, ways)
    return ways
  } catch (err) {
    console.warn('[overpass-junctions] fetch failed (Overpass overloaded — retry shortly):', err?.message)
    return []   // leave uncached so a later action can retry
  }
}

/** Parse an Overpass `out geom tags` response into way objects with the tags we need. */
export function parseJunctionWays(data) {
  if (!data || !Array.isArray(data.elements)) return []
  const out = []
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
    const t = el.tags || {}
    const layer = t.layer != null ? parseInt(t.layer, 10) : 0
    out.push({
      id: el.id,
      points: el.geometry.map((g) => ({ lat: g.lat, lon: g.lon })),
      highway: t.highway || '',
      oneway: t.oneway === 'yes' || t.junction === 'roundabout',
      roundabout: t.junction === 'roundabout',
      layer: Number.isFinite(layer) ? layer : 0,
      bridge: t.bridge != null && t.bridge !== 'no',
      tunnel: t.tunnel != null && t.tunnel !== 'no',
    })
  }
  return out
}

/** Test/maintenance helper — clear the session cache. */
export function _clearJunctionWaysCache() { _cache.clear() }
