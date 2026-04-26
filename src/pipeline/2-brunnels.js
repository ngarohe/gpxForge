/**
 * Step 2: Brunnels — fetch OSM bridges/tunnels via Overpass API,
 * filter against route, classify shapes, build corrections for Clean.
 *
 * Pipeline: Overpass query → containment filter → route projection →
 * bearing alignment → overlap resolution → adjacent merge → classify.
 *
 * All filter functions are pure. Only `locateBrunnels` is async (API call).
 */

import { haversine, bearing, bearingDiff, grads, hermiteElevation, bsearchDists } from '../utils/math.js'
import {
  pointToRouteDistance,
  projectOntoRoute,
  projectOntoRouteLocal,
  distToIndex,
  polylineWithinBuffer,
  nearestOnSegment,
} from '../utils/geometry.js'
import { classifyStructure, applyInterp } from './3-clean.js'
import { fetchBridgesAndTunnels } from '../api/overpass.js'

// ────────────────────────────────────────────────────────────────────
// Bounding box
// ────────────────────────────────────────────────────────────────────

/**
 * Compute a bounding box around a route with padding.
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} bufferM — padding in metres
 * @returns {{ minLat: number, minLon: number, maxLat: number, maxLon: number }}
 */
export function routeBounds(lats, lons, bufferM) {
  let minLat = Infinity, maxLat = -Infinity
  let minLon = Infinity, maxLon = -Infinity
  for (let i = 0; i < lats.length; i++) {
    if (lats[i] < minLat) minLat = lats[i]
    if (lats[i] > maxLat) maxLat = lats[i]
    if (lons[i] < minLon) minLon = lons[i]
    if (lons[i] > maxLon) maxLon = lons[i]
  }
  // Convert buffer to degrees (approximate)
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

// ────────────────────────────────────────────────────────────────────
// Containment filter (median node distance)
// ────────────────────────────────────────────────────────────────────

/**
 * Filter structures by median node proximity to route.
 * @param {object[]} structures — { id, geometry: [{lat,lon}], name }
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} routeBuffer — max median distance in metres
 * @returns {object[]} structures within buffer
 */
export function filterByProximity(structures, lats, lons, routeBuffer) {
  return structures.filter(s =>
    polylineWithinBuffer(s.geometry, lats, lons, routeBuffer)
  )
}

// ────────────────────────────────────────────────────────────────────
// Route projection
// ────────────────────────────────────────────────────────────────────

/**
 * Project a brunnel onto the route, returning span indices and distances.
 * Uses the first and last geometry nodes as start/end anchors.
 *
 * Returns a single span for the nearest pass. For multi-pass detection
 * (out-and-back routes), use {@link projectBrunnelSpanMulti}.
 *
 * @param {{ geometry: {lat:number, lon:number}[] }} struct
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} dists — cumulative distance array
 * @returns {{ alo: number, ahi: number, startDist: number, endDist: number } | null}
 */
export function projectBrunnelSpan(struct, lats, lons, dists) {
  const results = projectBrunnelSpanMulti(struct, lats, lons, dists)
  return results.length > 0 ? results[0] : null
}

/**
 * Project a brunnel onto ALL passes of the route that cross it.
 *
 * On out-and-back routes the same bridge is crossed twice (or more). The old
 * single-pass projection found only the nearest match, leaving the second pass
 * without a brunnel entry — causing its LIDAR artifact to be classified as a
 * generic "artifact" instead of a "bridge" or "tunnel".
 *
 * Algorithm:
 * 1. Scan every route point and compute its distance to the brunnel polyline
 * 2. Flag route points within `proxBuf` metres of the brunnel
 * 3. Cluster consecutive flagged indices (gap > `clusterGapIdx` breaks a cluster)
 * 4. For each cluster, project the brunnel's first and last node onto that
 *    local route segment to get precise span boundaries
 * 5. Apply the standard 10m padding and return one span per cluster
 *
 * @param {{ geometry: {lat:number, lon:number}[] }} struct
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} dists — cumulative distance array
 * @param {{ proxBuf?: number, clusterGapIdx?: number }} [opts]
 * @returns {Array<{ alo: number, ahi: number, startDist: number, endDist: number }>}
 */
export function projectBrunnelSpanMulti(struct, lats, lons, dists, opts = {}) {
  const g = struct.geometry
  const proxBuf = opts.proxBuf ?? 30       // metres — how close a route point must be to the brunnel polyline
  const clusterGapIdx = opts.clusterGapIdx ?? 20  // index gap to split clusters
  const eles = opts.eles ?? null           // elevation array — when provided, rejects clusters at different elevation
  const eleThreshold = opts.eleThreshold ?? 1  // metres — max median elevation difference between passes

  // Step 1: find all route indices near the brunnel polyline
  const nearIndices = []
  for (let ri = 0; ri < lats.length; ri++) {
    let minD = Infinity
    for (let gi = 0; gi < g.length - 1; gi++) {
      const { lat, lon } = nearestOnSegment(
        lats[ri], lons[ri],
        g[gi].lat, g[gi].lon, g[gi + 1].lat, g[gi + 1].lon,
      )
      const d = haversine(lats[ri], lons[ri], lat, lon)
      if (d < minD) minD = d
    }
    // Single-node brunnels: check distance to the single point
    if (g.length === 1) {
      minD = haversine(lats[ri], lons[ri], g[0].lat, g[0].lon)
    }
    if (minD <= proxBuf) nearIndices.push(ri)
  }

  if (nearIndices.length === 0) return []

  // Step 2: cluster by index gaps
  const clusters = [[nearIndices[0]]]
  for (let i = 1; i < nearIndices.length; i++) {
    if (nearIndices[i] - nearIndices[i - 1] > clusterGapIdx) {
      clusters.push([])
    }
    clusters[clusters.length - 1].push(nearIndices[i])
  }

  // Step 2.5: elevation filter — reject clusters at a different elevation than the first
  // This catches the Lysebotn scenario: a tunnel runs underground and a road
  // crosses above it at a higher elevation. The 2D projection matches both,
  // but they're on different levels.
  let filteredClusters = clusters
  if (eles && clusters.length > 1) {
    const medianEle = (cluster) => {
      const sorted = cluster.map(i => eles[i]).sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]
    }
    const refEle = medianEle(clusters[0])
    filteredClusters = clusters.filter(c => {
      const med = medianEle(c)
      return Math.abs(med - refEle) <= eleThreshold
    })
  }

  // Step 3: for each cluster, project brunnel endpoints locally
  const totalDist = dists[dists.length - 1]
  const BRUNNEL_PADDING_M = 10
  const spans = []

  for (const cluster of filteredClusters) {
    const cLo = cluster[0]
    const cHi = cluster[cluster.length - 1]

    // Project first and last brunnel nodes within this cluster's window
    const startDist = projectOntoRouteLocal(
      g[0].lat, g[0].lon, lats, lons, dists, cLo, cHi + 1,
    )
    const endDist = projectOntoRouteLocal(
      g[g.length - 1].lat, g[g.length - 1].lon, lats, lons, dists, cLo, cHi + 1,
    )

    const d0 = Math.min(startDist, endDist)
    const d1 = Math.max(startDist, endDist)
    if (d1 - d0 < 1) continue

    const d0p = Math.max(0, d0 - BRUNNEL_PADDING_M)
    const d1p = Math.min(totalDist, d1 + BRUNNEL_PADDING_M)

    const alo = distToIndex(d0p, dists)
    const ahi = distToIndex(d1p, dists)
    if (ahi <= alo) continue

    spans.push({ alo, ahi, startDist: d0p, endDist: d1p })
  }

  return spans
}

// ────────────────────────────────────────────────────────────────────
// Bearing alignment filter
// ────────────────────────────────────────────────────────────────────

/**
 * Check if a brunnel is aligned with the route within tolerance.
 * Returns true if ANY brunnel segment aligns with ANY route segment in span.
 * @param {{ geometry: {lat:number, lon:number}[] }} struct
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} alo — span start index
 * @param {number} ahi — span end index
 * @param {number} tolDeg — bearing tolerance in degrees
 * @returns {boolean}
 */
export function filterByBearing(struct, lats, lons, alo, ahi, tolDeg) {
  const g = struct.geometry
  for (let bi = 0; bi < g.length - 1; bi++) {
    const bBearing = bearing(g[bi].lat, g[bi].lon, g[bi + 1].lat, g[bi + 1].lon)
    for (let ri = alo; ri < ahi; ri++) {
      const rBearing = bearing(lats[ri], lons[ri], lats[ri + 1], lons[ri + 1])
      if (bearingDiff(bBearing, rBearing) <= tolDeg) return true
    }
  }
  return false
}

// ────────────────────────────────────────────────────────────────────
// Overlap resolution
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve overlapping brunnels — keep the one closest to route.
 * Two brunnels overlap if their route spans intersect.
 * @param {object[]} candidates — { ...struct, alo, ahi, startDist, endDist, avgDist }
 * @param {number[]} lats
 * @param {number[]} lons
 * @returns {object[]} de-duplicated brunnels
 */
export function resolveOverlaps(candidates, lats, lons) {
  if (candidates.length <= 1) return candidates

  // Compute average distance to route for each candidate
  const withDist = candidates.map(c => {
    const dists = c.geometry.map(n => pointToRouteDistance(n.lat, n.lon, lats, lons))
    const avg = dists.reduce((s, d) => s + d, 0) / dists.length
    return { ...c, avgDist: avg }
  })

  // Sort by startDist for sweep
  withDist.sort((a, b) => a.startDist - b.startDist)

  const kept = []
  for (const b of withDist) {
    // Check overlap with last kept
    const last = kept[kept.length - 1]
    if (last && !(b.startDist >= last.endDist || last.startDist >= b.endDist)) {
      // Same OSM way on different passes — keep both (multi-pass)
      if (b.osmId && last.osmId && b.osmId === last.osmId) {
        kept.push(b)
      } else if (last.type !== b.type) {
        // Bridge+tunnel complex — different structure types at same location, keep both
        kept.push(b)
      } else if (b.avgDist < last.avgDist) {
        // Same type overlapping — keep the closer one
        kept[kept.length - 1] = b
      }
    } else {
      kept.push(b)
    }
  }

  return kept
}

// ────────────────────────────────────────────────────────────────────
// Adjacent merge
// ────────────────────────────────────────────────────────────────────

/**
 * Merge same-type brunnels that are within a gap threshold.
 * @param {object[]} brunnels — sorted by startDist
 * @param {number[]} dists — cumulative distance array
 * @param {number} gapM — max gap in metres (default 20)
 * @returns {object[]} merged brunnels
 */
export function mergeAdjacent(brunnels, dists, gapM = 50) {
  if (brunnels.length <= 1) return brunnels

  // Separate by type
  const bridges = brunnels.filter(b => b.type === 'bridge')
  const tunnels = brunnels.filter(b => b.type === 'tunnel')

  function mergeGroup(group) {
    if (group.length <= 1) return group
    group.sort((a, b) => a.startDist - b.startDist)
    const out = [{ ...group[0] }]
    for (let i = 1; i < group.length; i++) {
      const prev = out[out.length - 1]
      const cur = group[i]
      if (cur.startDist - prev.endDist <= gapM) {
        // Merge: extend the span
        prev.ahi = Math.max(prev.ahi, cur.ahi)
        prev.endDist = Math.max(prev.endDist, cur.endDist)
        prev.name = prev.name && cur.name && prev.name !== cur.name
          ? prev.name + ' / ' + cur.name
          : prev.name || cur.name
      } else {
        out.push({ ...cur })
      }
    }
    return out
  }

  const merged = [...mergeGroup(bridges), ...mergeGroup(tunnels)]
  merged.sort((a, b) => a.startDist - b.startDist)
  return merged
}

// ────────────────────────────────────────────────────────────────────
// Structure classification
// ────────────────────────────────────────────────────────────────────

/**
 * Classify a brunnel span by analyzing the LIDAR elevation shape.
 * Detects bridge dips (sagging elevation) and tunnel spikes (raised elevation).
 *
 * @param {number[]} eles — elevation array
 * @param {number[]} dists — cumulative distances
 * @param {number} alo — span start index
 * @param {number} ahi — span end index
 * @param {{ tangWin?: number, hermDev?: number, bridgeDip?: number, tunnelSpk?: number }} params
 * @returns {{ type: string, interp: string, m0: number, m1: number }}
 */
export function classifyBrunnel(eles, dists, alo, ahi, params) {
  const tw = params.tangWin || 8
  const hermDev = params.hermDev || 0.5
  const bridgeDip = params.bridgeDip ?? 1.0
  const tunnelSpk = params.tunnelSpk ?? 1.0

  // Anchor elevations and tangent slopes
  const e0 = eles[alo], e1 = eles[ahi]
  const span = dists[ahi] - dists[alo]
  if (span < 1) return { type: 'artifact', interp: 'uniform', m0: 0, m1: 0 }

  // Compute tangent slopes at anchors (from surrounding points)
  const m0 = tangentSlope(eles, dists, alo, tw)
  const m1 = tangentSlope(eles, dists, ahi, tw)

  // Anchor level = average of endpoints
  const anchorLevel = (e0 + e1) / 2

  // Find min/max in span (excluding endpoints)
  let zMin = Infinity, zMax = -Infinity
  for (let i = alo + 1; i < ahi; i++) {
    if (eles[i] < zMin) zMin = eles[i]
    if (eles[i] > zMax) zMax = eles[i]
  }

  // Hermite interpolation deviation check
  let maxDev = 0
  for (let i = alo + 1; i < ahi; i++) {
    const t = (dists[i] - dists[alo]) / span
    const hEle = hermiteElevation(t, e0, e1, m0, m1, span)
    const dev = Math.abs(eles[i] - hEle)
    if (dev > maxDev) maxDev = dev
  }

  const dipBelow = anchorLevel - zMin
  const spikeAbove = zMax - anchorLevel

  // Classify based on shape
  if (dipBelow >= bridgeDip && dipBelow > spikeAbove) {
    // Bridge dip — elevation sags below anchor line
    return { type: 'bridge', interp: 'hermite', m0, m1 }
  }
  if (spikeAbove >= tunnelSpk && spikeAbove > dipBelow) {
    // Tunnel spike — elevation rises above anchor line
    return { type: 'tunnel', interp: 'uniform', m0, m1 }
  }
  if (maxDev >= hermDev) {
    // General artifact — doesn't fit Hermite curve
    return { type: 'artifact', interp: 'hermite', m0, m1 }
  }

  // Clean zone — no significant deviation
  return { type: 'clean', interp: 'none', m0, m1 }
}

/**
 * Compute tangent slope at a point using surrounding elevation data.
 * @param {number[]} eles
 * @param {number[]} dists
 * @param {number} idx
 * @param {number} win — window size in points
 * @returns {number} slope as fraction (not %)
 */
function tangentSlope(eles, dists, idx, win) {
  const lo = Math.max(0, idx - win)
  const hi = Math.min(eles.length - 1, idx + win)
  const ds = dists[hi] - dists[lo]
  if (ds < 0.1) return 0
  return (eles[hi] - eles[lo]) / ds
}

// ────────────────────────────────────────────────────────────────────
// Full brunnel locate pipeline (async)
// ────────────────────────────────────────────────────────────────────

/**
 * Locate brunnels along a route — full pipeline from Overpass fetch to merged results.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} dists — cumulative distances
 * @param {number[]} eles — elevations
 * @param {{ queryBuffer?: number, routeBuffer?: number, bearingTol?: number }} opts
 * @param {function} [onProgress] — (pct, msg) => void
 * @returns {Promise<object[]>} array of located brunnels with { alo, ahi, type, name, ... }
 */
export async function locateBrunnels(lats, lons, dists, eles, opts = {}, onProgress) {
  const queryBuffer = opts.queryBuffer || 10
  const routeBuffer = opts.routeBuffer || 3
  const bearingTol = opts.bearingTol || 20

  // Stage 1: Overpass query
  onProgress?.(5, 'Computing bounds...')
  const bounds = routeBounds(lats, lons, queryBuffer)

  onProgress?.(10, 'Fetching from Overpass...')
  const { bridges, tunnels } = await fetchBridgesAndTunnels(bounds, onProgress)
  const totalRaw = bridges.length + tunnels.length
  onProgress?.(50, `Fetched ${bridges.length} bridges, ${tunnels.length} tunnels`)

  // Tag with type
  const all = [
    ...bridges.map(b => ({ ...b, type: 'bridge' })),
    ...tunnels.map(t => ({ ...t, type: 'tunnel' })),
  ]

  if (all.length === 0) {
    onProgress?.(100, 'No structures found in area')
    return []
  }

  // Stage 2: Containment filter (median node distance)
  onProgress?.(55, 'Filtering by proximity...')
  const near = filterByProximity(all, lats, lons, routeBuffer)
  onProgress?.(65, `${near.length}/${totalRaw} within ${routeBuffer}m of route`)

  if (near.length === 0) {
    onProgress?.(100, 'No structures near route')
    return []
  }

  // Stage 3: Project onto route (multi-pass aware, elevation-filtered)
  onProgress?.(70, 'Projecting onto route...')
  const projected = []
  for (const s of near) {
    const spans = projectBrunnelSpanMulti(s, lats, lons, dists, { eles })
    for (const span of spans) {
      projected.push({ ...s, ...span, osmId: s.id })
    }
  }
  onProgress?.(75, `${projected.length} projected onto route`)

  if (projected.length === 0) {
    onProgress?.(100, 'No structures project onto route')
    return []
  }

  // Stage 4: Bearing alignment filter
  onProgress?.(80, 'Checking alignment...')
  const aligned = projected.filter(s =>
    filterByBearing(s, lats, lons, s.alo, s.ahi, bearingTol)
  )
  onProgress?.(85, `${aligned.length} aligned with route (±${bearingTol}°)`)

  if (aligned.length === 0) {
    onProgress?.(100, 'No aligned structures found')
    return []
  }

  // Stage 5: Overlap resolution
  onProgress?.(90, 'Resolving overlaps...')
  const resolved = resolveOverlaps(aligned, lats, lons)

  // Stage 6: Merge adjacent same-type
  onProgress?.(95, 'Merging adjacent...')
  const merged = mergeAdjacent(resolved, dists, opts.mergeGapM ?? 50)

  onProgress?.(100, `Located ${merged.length} brunnels`)
  return merged
}

// ────────────────────────────────────────────────────────────────────
// Build corrections from brunnels (pre-seeds the Cleaner)
// ────────────────────────────────────────────────────────────────────

/**
 * Build correction objects from located brunnels.
 * Each brunnel zone is classified and interpolated, producing
 * corrections that can be merged into the Clean step.
 *
 * Anchor search uses raw gradients — critical for handling short-fall
 * (OSM boundary inside artifact: gradient is steep → walks outward)
 * and over-extension (OSM boundary past artifact: gradient clean → stops).
 *
 * @param {object[]} brunnels — located brunnels with { alo, ahi, type, name, id }
 * @param {number[]} eles — raw elevations
 * @param {number[]} dists — cumulative distances
 * @param {{ tangWin?: number, hermDev?: number, bridgeDip?: number, tunnelSpk?: number }} shapeParams
 * @param {number} [anchorT=25] — gradient threshold (%) for anchor expansion
 * @returns {{ corrections: object[], eleClean: number[] }}
 */
export function buildBrunnelCorrections(brunnels, eles, dists, shapeParams, anchorT = 25) {
  const eleClean = [...eles]
  const corrections = []
  const N = eles.length

  // Raw gradients — approach road is always clean regardless of what
  // the LIDAR shows inside the brunnel span. grRaw[i] = gradient from
  // point i to point i+1.
  const grRaw = grads(eles, dists)

  for (const b of brunnels) {
    if (b.alo >= b.ahi || b.ahi >= N) continue

    // Outward search from OSM boundaries on raw gradient.
    // When OSM boundary falls inside the artifact (short-fall), raw gradient
    // at the boundary is steep → search walks outward to clean approach road.
    // When OSM boundary is past the artifact (over-extension), raw gradient
    // is already clean → search stops immediately.
    let alo = b.alo
    for (let i = b.alo - 1; i >= 0; i--) {
      if (Math.abs(grRaw[i]) < anchorT) { alo = i; break }
    }
    let ahi = b.ahi
    for (let i = b.ahi; i < grRaw.length; i++) {
      if (Math.abs(grRaw[i]) < anchorT) { ahi = i + 1; break }
    }

    if (ahi <= alo) continue

    const span = dists[ahi] - dists[alo]
    if (span <= 0) continue
    const grade = (eles[ahi] - eles[alo]) / span * 100

    // Bias classifyStructure toward the OSM-declared type, but let it
    // read the actual LIDAR dip/spike shape within the zone.
    // classifyStructure (not classifyBrunnel) is used because its bridge
    // detection takes priority over tunnel — critical when bridgeDip=0
    // forces bridge classification regardless of spike noise.
    const { smart = true, tangWin = 8, hermDev = 0.5, bridgeDip = 1.0, tunnelSpk = 1.0 } = shapeParams
    const structParams = smart
      ? { tangWin, hermDev,
          bridgeDip: b.type === 'bridge' ? 0.0 : bridgeDip,
          tunnelSpk: b.type === 'tunnel' ? 0.0 : tunnelSpk }
      : { tangWin, hermDev, bridgeDip: 999, tunnelSpk: 999 }

    const struct = smart
      ? classifyStructure(eles, dists, alo, ahi, structParams)
      : { type: b.type === 'tunnel' ? 'tunnel' : 'bridge',
          interp: b.type === 'tunnel' ? 'uniform' : 'hermite_convex', m0: 0, m1: 0 }

    // OSM-declared bridges: force Hermite even when classifyStructure fell
    // back to uniform (both approach slopes same sign on monotonic terrain).
    // The m0/m1 slopes are still meaningful — Hermite with same-sign slopes
    // correctly produces the road's natural convex/concave shape.
    if (b.type === 'bridge' && struct.interp === 'uniform' && struct.type !== 'tunnel') {
      struct.interp = 'hermite_convex'
      struct.type = 'bridge'
    }

    // Apply interpolation using the same applyInterp as the LIDAR cleaner
    applyInterp(eleClean, dists, alo, ahi, struct)

    // Keep OSM tunnel labeling stable in UI: shape classifier may return
    // 'ramp' on monotonic terrain, but OSM-declared tunnels should still
    // appear as tunnels in the corrections panel.
    const correctionType = b.type === 'tunnel' ? 'tunnel' : struct.type

    corrections.push({
      alo, ahi, span, grade,
      type: correctionType,
      interp: struct.interp,
      m0: struct.m0,
      m1: struct.m1,
      revRate: 0, meanGr: 0,
      accepted: true,
      rejected: false,
      osmId: b.id,
      osmName: b.name,
      source: 'osm',
    })
  }

  return { corrections, eleClean }
}

/**
 * Build a Uint8Array mask where 1 = inside (or within 10m of) a brunnel span.
 * Used by dip-smoothing to skip points inside bridge/tunnel geometry.
 * @param {object[]} brunnels
 * @param {Float64Array} dists
 * @returns {Uint8Array}
 */
export function buildBrunnelMask(brunnels, dists) {
  const mask = new Uint8Array(dists.length)
  for (const b of brunnels) {
    const lo = bsearchDists(dists, b.startDist - 10)
    const hi = Math.min(dists.length - 1, bsearchDists(dists, b.endDist + 11) - 1)
    for (let k = lo; k <= hi; k++) mask[k] = 1
  }
  return mask
}

