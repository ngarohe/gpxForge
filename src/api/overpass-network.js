/**
 * Fetch a street NETWORK for an area (bounding box) from OSM, filtered by routing profile.
 *
 * This is the Course Builder's primary data source: the user draws a bbox and we pull every
 * routable way inside it, so `buildNetworkGraph` can split them at shared OSM vertices into a
 * clickable node/leg graph and the user can pick a course directly on the real street network.
 *
 * Uses the SHARED hardened Overpass client (`runOverpassQuery`) — same mirror fallback + backoff
 * as the bridge/tunnel, ring, and junction fetchers — and a per-request session cache. Best-effort:
 * returns [] on failure so the mode degrades to an empty graph with a "servers busy" status.
 */

import { runOverpassQuery } from './overpass.js'

const _cache = new Map() // cacheKey → way[]

/**
 * OSM `highway` value whitelists per routing profile. These mirror the spirit of the Valhalla
 * costing profiles used for road snapping (car / bike / pedestrian) — what each can legally ride.
 */
export const PROFILE_HIGHWAYS = {
  car: [
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'living_street', 'service', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link',
    'tertiary_link', 'road',
  ],
  bike: [
    'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service',
    'primary_link', 'secondary_link', 'tertiary_link', 'road', 'cycleway', 'path', 'track',
    'bridleway', 'footway',
  ],
  pedestrian: [
    'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service',
    'pedestrian', 'footway', 'path', 'track', 'steps', 'cycleway', 'bridleway', 'road',
  ],
}

// 'mixed' = the UNION of all profiles. Used for track IMPORT, where the ride may use car roads,
// cycleways AND footways in one go — the map-matcher needs every path it could be on to exist in the
// graph (otherwise it drops onto a wrong loop where a road becomes a bike/foot path). The extra
// parallel candidates are fine — the HMM matcher is built to handle them.
PROFILE_HIGHWAYS.mixed = [...new Set([
  ...PROFILE_HIGHWAYS.car, ...PROFILE_HIGHWAYS.bike, ...PROFILE_HIGHWAYS.pedestrian,
])]

/** Build the Overpass `highway~"..."` regex filter for a profile (defaults to car). */
function highwayFilter(profile) {
  const list = PROFILE_HIGHWAYS[profile] || PROFILE_HIGHWAYS.car
  return `["highway"~"^(${list.join('|')})$"]`
}

/** Normalise a region argument into a `{ type, ... }` descriptor (a plain bbox object → type bbox). */
function normalizeRegion(region) {
  if (!region) return null
  if (region.type) return region
  if (Number.isFinite(region.minLat) && Number.isFinite(region.maxLat)) return { type: 'bbox', ...region }
  return null
}

/** The Overpass spatial filter clause + a stable cache key for a region descriptor. */
function regionClause(region) {
  if (region.type === 'bbox') {
    // Overpass bbox order is (south,west,north,east).
    const { minLat, minLon, maxLat, maxLon } = region
    return {
      clause: `(${minLat},${minLon},${maxLat},${maxLon})`,
      bounds: { minLat, minLon, maxLat, maxLon },
      key: `bbox:${[minLat, minLon, maxLat, maxLon].map((v) => v.toFixed(6)).join(',')}`,
    }
  }
  if (region.type === 'poly') {
    const pts = region.points || []
    const flat = pts.map((p) => `${p.lat} ${p.lon}`).join(' ')
    return {
      clause: `(poly:"${flat}")`,
      bounds: boundsOfPoints(pts),
      key: 'poly:' + pts.map((p) => p.lat.toFixed(5) + ',' + p.lon.toFixed(5)).join(';'),
    }
  }
  if (region.type === 'corridor') {
    // Overpass `around` accepts a linestring (a flat lat,lon,lat,lon… list) → a buffered corridor.
    const pts = region.points || []
    const buffer = region.bufferM || 40
    const flat = pts.map((p) => `${p.lat},${p.lon}`).join(',')
    return {
      clause: `(around:${buffer},${flat})`,
      bounds: boundsOfPoints(pts),
      key: `corr:${buffer}:` + pts.map((p) => p.lat.toFixed(5) + ',' + p.lon.toFixed(5)).join(';'),
    }
  }
  return null
}

/** Bounding box of a point list (for regional-mirror selection). */
function boundsOfPoints(pts) {
  if (!pts || !pts.length) return null
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon
  }
  return { minLat, minLon, maxLat, maxLon }
}

/**
 * Fetch the routable street network inside a region (bbox, polygon, or corridor).
 *
 * @param {object} region — `{ type:'bbox', minLat,minLon,maxLat,maxLon }`
 *   | `{ type:'poly', points:[{lat,lon}] }` | `{ type:'corridor', points:[{lat,lon}], bufferM }`.
 *   A plain bbox object (no `type`) is accepted and treated as a bbox.
 * @param {string} [profile] — 'car' | 'bike' | 'pedestrian' (default 'car').
 * @returns {Promise<Array<{ id:number, points:Array<{lat,lon}>, highway:string, oneway:boolean,
 *   roundabout:boolean, layer:number, bridge:boolean, tunnel:boolean }>>}
 */
export async function fetchNetwork(region, profile = 'car') {
  const r = normalizeRegion(region)
  if (!r) return []
  const rc = regionClause(r)
  if (!rc) return []
  const key = rc.key + '@' + profile
  if (_cache.has(key)) return _cache.get(key)

  const query = `[out:json][timeout:60];\nway${highwayFilter(profile)}${rc.clause};\nout geom tags;`
  try {
    // An area fetch is heavier than a single way, but still: GENTLE retry policy — one attempt
    // per mirror (a 504/429 means overloaded; roll to the next mirror rather than hammer it),
    // generous timeout for a merely-slow mirror. `bounds` lets the client pick a regional mirror.
    const data = await runOverpassQuery(query, { bounds: rc.bounds, attemptsPerServer: 1, requestTimeoutMs: 55000 })
    const ways = parseNetworkWays(data)
    _cache.set(key, ways)
    return ways
  } catch (err) {
    console.warn('[overpass-network] fetch failed (Overpass overloaded — retry shortly):', err?.message)
    return []   // leave uncached so a later retry can succeed
  }
}

/** Parse an Overpass `out geom tags` response into way objects with the tags we need. */
export function parseNetworkWays(data) {
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

const M_PER_DEG_LAT = 111320

/** Haversine-free approximate length (m) of a polyline (equirectangular). */
function polylineLengthM(pts) {
  let m = 0
  for (let i = 1; i < pts.length; i++) {
    const midLat = (pts[i].lat + pts[i - 1].lat) / 2
    const dy = (pts[i].lat - pts[i - 1].lat) * M_PER_DEG_LAT
    const dx = (pts[i].lon - pts[i - 1].lon) * M_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180)
    m += Math.hypot(dx, dy)
  }
  return m
}

/**
 * Approximate area of a region in km² (for the size cap). bbox = w·h; poly = shoelace;
 * corridor = length · (2·buffer).
 */
export function regionAreaKm2(region) {
  const r = normalizeRegion(region)
  if (!r) return 0
  if (r.type === 'bbox') {
    const midLat = (r.minLat + r.maxLat) / 2
    const hM = (r.maxLat - r.minLat) * M_PER_DEG_LAT
    const wM = (r.maxLon - r.minLon) * M_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180)
    return Math.abs(hM * wM) / 1e6
  }
  if (r.type === 'poly') {
    const pts = r.points || []
    if (pts.length < 3) return 0
    const midLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length
    const kx = M_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180), ky = M_PER_DEG_LAT
    let a = 0
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += (pts[j].lon * kx) * (pts[i].lat * ky) - (pts[i].lon * kx) * (pts[j].lat * ky)
    }
    return Math.abs(a / 2) / 1e6
  }
  if (r.type === 'corridor') {
    return polylineLengthM(r.points || []) * (2 * (r.bufferM || 40)) / 1e6
  }
  return 0
}

/** Test/maintenance helper — clear the session cache. */
export function _clearNetworkCache() { _cache.clear() }
