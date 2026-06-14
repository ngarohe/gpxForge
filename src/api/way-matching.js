/**
 * OSM way ID matching for route points.
 *
 * Returns a Uint32Array where wayIds[i] is the OSM way ID at route point i.
 * Used by brunnel detection (filter parallel-road false positives) and
 * overlap detection (distinguish multilevel roads at same lat/lon).
 *
 * Strategy:
 *   1. Try Valhalla `/trace_attributes` first — authoritative, fast.
 *   2. Fall back to Overpass `way[highway]` + nearest-way matching when
 *      Valhalla is unavailable (currently down since May 2026).
 *
 * Both paths return the same shape, so callers don't need to care.
 */

import { haversine, bearing, bearingDiff } from '../utils/math.js'
import { nearestOnSegment } from '../utils/geometry.js'
import { runOverpassQuery } from './overpass.js'

// ────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve OSM way IDs for every route point.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {{ bounds?: object, onProgress?: Function }} [opts]
 * @returns {Promise<{ wayIds: Uint32Array, roundaboutFlags: Uint8Array, junctionNodes: Array, source: 'valhalla'|'overpass'|'none' }>}
 *   roundaboutFlags[i] === 1 when point i is on a way tagged junction=roundabout
 *   (Valhalla edge.use === 'roundabout', or Overpass junction tag).
 *   junctionNodes is the OSM graph junction list (Valhalla only — empty on the Overpass
 *   fallback, which has no node data; callers degrade to geometric crossings + folds).
 */
export async function getRouteWayIds(lats, lons, opts = {}) {
  const N = lats.length
  if (N === 0) return { wayIds: new Uint32Array(0), roundaboutFlags: new Uint8Array(0), junctionNodes: [], source: 'none' }

  // 1. Try Valhalla /trace_attributes
  try {
    const res = await viaValhalla(lats, lons)
    if (res && res.wayIds && res.wayIds.length === N) {
      return { ...res, source: 'valhalla' }
    }
  } catch (err) {
    console.warn('[way-matching] Valhalla unavailable, falling back to Overpass:', err.message)
  }

  // 2. Fall back to Overpass (no junction-node data available there)
  try {
    const res = await viaOverpass(lats, lons, opts)
    return { ...res, junctionNodes: [], source: 'overpass' }
  } catch (err) {
    console.warn('[way-matching] Overpass fallback failed:', err.message)
    return { wayIds: new Uint32Array(N), roundaboutFlags: new Uint8Array(N), junctionNodes: [], source: 'none' }
  }
}

// ────────────────────────────────────────────────────────────────────
// Valhalla /trace_attributes path
// ────────────────────────────────────────────────────────────────────

const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de'

// Valhalla limit: ~16k shape points. We chunk longer routes.
const VALHALLA_CHUNK = 14000
const VALHALLA_OVERLAP = 2  // overlap points so adjacent chunks join cleanly

/**
 * Decode a Valhalla-encoded polyline (precision 6) into [lat, lon] pairs.
 * Used to recover the EXACT OSM vertex coordinate at each graph node.
 * @param {string} str
 * @returns {Array<[number, number]>}
 */
function decodePolyline6(str) {
  let idx = 0, lat = 0, lon = 0
  const out = []
  while (idx < str.length) {
    let b, shift = 0, result = 0
    do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lat += (result & 1) ? ~(result >> 1) : (result >> 1)
    shift = 0; result = 0
    do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lon += (result & 1) ? ~(result >> 1) : (result >> 1)
    out.push([lat / 1e6, lon / 1e6])
  }
  return out
}

/**
 * Fetch way IDs + OSM graph junction nodes via Valhalla /trace_attributes.
 * Throws on failure (caller falls back to Overpass).
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @returns {Promise<{ wayIds: Uint32Array, roundaboutFlags: Uint8Array, junctionNodes: Array }>}
 *   junctionNodes[k] = { lat, lon, headings:number[] } — one entry per pass through an OSM
 *   graph node that has intersecting edges (a real junction). `lat/lon` is the EXACT OSM
 *   vertex (decoded from the shape), so the same junction visited on two passes yields two
 *   entries with bit-identical coords — the signal the topology editor groups on.
 */
async function viaValhalla(lats, lons) {
  const N = lats.length
  const wayIds = new Uint32Array(N)
  const roundaboutFlags = new Uint8Array(N)
  const junctionNodes = []

  for (let chunkStart = 0; chunkStart < N; chunkStart += VALHALLA_CHUNK - VALHALLA_OVERLAP) {
    const chunkEnd = Math.min(N, chunkStart + VALHALLA_CHUNK)
    const shape = []
    for (let i = chunkStart; i < chunkEnd; i++) {
      shape.push({
        lat: lats[i],
        lon: lons[i],
        type: (i === chunkStart || i === chunkEnd - 1) ? 'break' : 'via',
      })
    }

    const body = {
      shape,
      shape_match: 'map_snap',
      costing: 'auto',
      filters: {
        // edge.roundabout is the boolean ring flag (edge.use stays 'road' on a
        // roundabout, so it is NOT the signal — verified against the live server).
        // node.* + shape recover OSM graph junctions: junction data is nested as
        // edge.end_node.intersecting_edges (there is NO top-level nodes array), and the
        // node coordinate is shape[next edge.begin_shape_index] (exact OSM vertex).
        attributes: [
          'edge.way_id', 'edge.roundabout', 'edge.begin_shape_index',
          'node.type', 'node.intersecting_edge.begin_heading', 'node.intersecting_edge.road_class',
          'shape', 'matched.point', 'matched.edge_index',
        ],
        action: 'include',
      },
    }

    const resp = await fetch(`${VALHALLA_BASE}/trace_attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })

    if (!resp.ok) throw new Error(`Valhalla HTTP ${resp.status}`)
    const data = await resp.json()

    const edges = data.edges || []
    const matched = data.matched_points || []
    if (edges.length === 0 || matched.length === 0) {
      throw new Error('Valhalla returned no edges/matches')
    }

    // For each matched point, look up its edge_index, then edge.way_id / edge.use
    for (let i = 0; i < matched.length; i++) {
      const ei = matched[i].edge_index
      if (typeof ei === 'number' && edges[ei]) {
        const wayId = edges[ei].way_id
        if (wayId) wayIds[chunkStart + i] = wayId
        if (edges[ei].roundabout) roundaboutFlags[chunkStart + i] = 1
      }
    }

    // OSM graph junction nodes: each edge.end_node with intersecting edges is a real
    // junction. Its coordinate is the shared shape point at the start of the NEXT edge
    // (the exact OSM vertex — identical on every pass), recovered from the decoded shape.
    const shapePts = data.shape ? decodePolyline6(data.shape) : []
    for (let e = 0; e < edges.length; e++) {
      const en = edges[e].end_node
      const ie = en && en.intersecting_edges
      if (!ie || !ie.length) continue
      const sIdx = (e + 1 < edges.length) ? edges[e + 1].begin_shape_index : shapePts.length - 1
      const c = shapePts[sIdx]
      if (!c) continue
      junctionNodes.push({ lat: c[0], lon: c[1], headings: ie.map((x) => x.begin_heading).filter((h) => typeof h === 'number') })
    }

    if (chunkEnd >= N) break
  }

  return { wayIds, roundaboutFlags, junctionNodes }
}

// ────────────────────────────────────────────────────────────────────
// Overpass fallback path
// ────────────────────────────────────────────────────────────────────

/**
 * Fetch all highway ways in route bbox via Overpass, then assign each
 * route point to its nearest way.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {{ bufferM?: number }} [opts]
 * @returns {Promise<{ wayIds: Uint32Array, roundaboutFlags: Uint8Array }>}
 */
async function viaOverpass(lats, lons, opts = {}) {
  const N = lats.length
  const wayIds = new Uint32Array(N)
  const roundaboutFlags = new Uint8Array(N)
  const bufferM = opts.bufferM ?? 20  // metres around route

  const bounds = computeBounds(lats, lons, bufferM)
  const ways = await fetchHighwayWays(bounds)
  if (ways.length === 0) return { wayIds, roundaboutFlags }

  // For each route point, find the nearest way (within a max distance)
  const maxDistM = 30
  for (let i = 0; i < N; i++) {
    const w = nearestWay(lats[i], lons[i], ways, maxDistM)
    if (w) {
      wayIds[i] = w.id || 0
      if (w.roundabout) roundaboutFlags[i] = 1
    }
  }

  return { wayIds, roundaboutFlags }
}

/**
 * Compute padded bounding box for route.
 */
function computeBounds(lats, lons, bufferM) {
  let minLat = Infinity, maxLat = -Infinity
  let minLon = Infinity, maxLon = -Infinity
  for (let i = 0; i < lats.length; i++) {
    if (lats[i] < minLat) minLat = lats[i]
    if (lats[i] > maxLat) maxLat = lats[i]
    if (lons[i] < minLon) minLon = lons[i]
    if (lons[i] > maxLon) maxLon = lons[i]
  }
  const dLat = bufferM / 111320
  const midLat = (minLat + maxLat) / 2
  const dLon = bufferM / (111320 * Math.cos(midLat * Math.PI / 180))
  return {
    minLat: minLat - dLat,
    minLon: minLon - dLon,
    maxLat: maxLat + dLat,
    maxLon: maxLon + dLon,
  }
}

/**
 * Fetch all highway ways with full geometry in the given bbox via the SHARED hardened
 * Overpass client (`runOverpassQuery`) — same mirror fallback + Retry-After backoff as
 * the bridge/tunnel and ring fetchers, instead of a separate unhardened loop. A bbox
 * `way[highway]` fetch is moderately heavy, so allow up to 2 same-server attempts (a
 * transient 504 often clears on retry) — but no more, to stay gentle on rate limits.
 * `bounds` enables the regional mirror where relevant. Throws on total failure (the
 * caller falls back to source 'none').
 */
async function fetchHighwayWays(bounds) {
  const { minLat, minLon, maxLat, maxLon } = bounds
  const query = `[out:json][timeout:60][bbox:${minLat},${minLon},${maxLat},${maxLon}];
way[highway];
out geom qt;`
  const data = await runOverpassQuery(query, { bounds, attemptsPerServer: 2 })
  return parseWays(data)
}

/**
 * Parse Overpass JSON into { id, geometry, roundabout } way objects.
 * `out geom` includes tags by default, so junction=roundabout is available.
 */
function parseWays(data) {
  const ways = []
  if (!data || !Array.isArray(data.elements)) return ways
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
    ways.push({ id: el.id, geometry: el.geometry, roundabout: el.tags?.junction === 'roundabout' })
  }
  return ways
}

/**
 * Find the nearest highway way to a given lat/lon, within maxDistM metres.
 * Returns the way object ({ id, roundabout }) or null if none within range.
 */
function nearestWay(lat, lon, ways, maxDistM) {
  let best = null
  let bestD = maxDistM
  for (const w of ways) {
    const g = w.geometry
    // Quick bbox check
    let inBbox = false
    let minLat = Infinity, maxLat = -Infinity
    let minLon = Infinity, maxLon = -Infinity
    for (const n of g) {
      if (n.lat < minLat) minLat = n.lat
      if (n.lat > maxLat) maxLat = n.lat
      if (n.lon < minLon) minLon = n.lon
      if (n.lon > maxLon) maxLon = n.lon
    }
    // Loose bbox check: ~0.0005 deg ≈ 50m
    if (lat < minLat - 0.0005 || lat > maxLat + 0.0005
        || lon < minLon - 0.0005 || lon > maxLon + 0.0005) continue

    // Detailed: find min distance to any segment of this way
    for (let i = 0; i < g.length - 1; i++) {
      const np = nearestOnSegment(lat, lon, g[i].lat, g[i].lon, g[i + 1].lat, g[i + 1].lon)
      const d = haversine(lat, lon, np.lat, np.lon)
      if (d < bestD) {
        bestD = d
        best = w
      }
    }
  }
  return best
}

// ────────────────────────────────────────────────────────────────────
// Filter helper used by brunnel pipeline
// ────────────────────────────────────────────────────────────────────

/**
 * Check whether a brunnel's OSM way ID appears anywhere in the route's
 * way IDs within the brunnel's span.
 *
 * Returns true if there's any match (= brunnel is on the same way as the
 * route at this position), false otherwise (= likely parallel road).
 *
 * If routeWayIds is null/empty or contains all zeros, returns true
 * (fail-open: don't reject when we have no way ID data).
 *
 * @param {number} brunnelOsmId
 * @param {Uint32Array} routeWayIds
 * @param {number} alo — span start index
 * @param {number} ahi — span end index
 * @param {number} [pad=2] — extend search ±pad points beyond span
 * @returns {boolean}
 */
export function brunnelMatchesRouteWay(brunnelOsmId, routeWayIds, alo, ahi, pad = 2) {
  if (!routeWayIds || routeWayIds.length === 0) return true
  if (!brunnelOsmId) return true  // unknown brunnel ID — can't filter

  const lo = Math.max(0, alo - pad)
  const hi = Math.min(routeWayIds.length - 1, ahi + pad)

  // Check if any route point in the span has way IDs at all (avoid rejecting on missing data)
  let anyKnown = false
  for (let i = lo; i <= hi; i++) {
    if (routeWayIds[i] !== 0) {
      anyKnown = true
      if (routeWayIds[i] === brunnelOsmId) return true
    }
  }

  // If we have NO way data in this span, fail open
  if (!anyKnown) return true

  return false
}
