/**
 * Step 2: Brunnels — fetch OSM bridges/tunnels via Overpass API,
 * filter against route, classify shapes, build corrections for Clean.
 *
 * Pipeline: Overpass query → containment filter → route projection →
 * bearing alignment → overlap resolution → adjacent merge → classify.
 *
 * All filter functions are pure. Only `locateBrunnels` is async (API call).
 */

import { haversine, bearing, bearingDiff, hermiteElevation, bsearchDists } from '../utils/math.js'
import {
  pointToRouteDistance,
  projectOntoRouteLocal,
  distToIndex,
  nearestOnSegment,
} from '../utils/geometry.js'
import { fetchBridgesAndTunnels } from '../api/overpass.js'
import { brunnelMatchesRouteWay } from '../api/way-matching.js'

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
// Containment filter (all nodes must be within buffer)
// ────────────────────────────────────────────────────────────────────

/**
 * Filter structures requiring ALL nodes to be within buffer of the route.
 * A single outlier node rejects the entire structure — this prevents
 * matching bridge-tagged ways that diverge from the route (e.g. motorway
 * ramps that share a merge point but curve away).
 * @param {object[]} structures — { id, geometry: [{lat,lon}], name }
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} routeBuffer — max distance in metres for every node
 * @returns {object[]} structures fully within buffer
 */
export function filterByProximity(structures, lats, lons, routeBuffer) {
  return structures.filter(s => {
    for (const node of s.geometry) {
      const d = pointToRouteDistance(node.lat, node.lon, lats, lons)
      if (d > routeBuffer) return false
    }
    return true
  })
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
 * 5. Return one span per cluster
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

  // Step 3: for each cluster, project ALL brunnel nodes locally and use min/max
  const totalDist = dists[dists.length - 1]
  const spans = []

  for (const cluster of filteredClusters) {
    const cLo = cluster[0]
    const cHi = cluster[cluster.length - 1]

    let d0 = Infinity, d1 = -Infinity
    for (let ni = 0; ni < g.length; ni++) {
      const pd = projectOntoRouteLocal(
        g[ni].lat, g[ni].lon, lats, lons, dists, cLo, cHi + 1,
      )
      if (pd < d0) d0 = pd
      if (pd > d1) d1 = pd
    }
    if (d1 - d0 < 1) continue

    const alo = distToIndex(d0, dists)
    const ahi = distToIndex(d1, dists)
    if (ahi <= alo) continue

    spans.push({ alo, ahi, startDist: d0, endDist: d1 })
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
      // else: same type, farther away — drop it
    } else {
      kept.push(b)
    }
  }

  // Second pass: check each kept brunnel against ALL others (not just previous).
  // The sweep above only compares adjacent pairs and can miss transitive overlaps.
  const final = []
  for (const b of kept) {
    let dominated = false
    for (const f of final) {
      if (f.type === b.type
        && !(b.startDist >= f.endDist || f.startDist >= b.endDist)
        && !(b.osmId && f.osmId && b.osmId === f.osmId)) {
        if (b.avgDist >= f.avgDist) { dominated = true; break }
        else {
          final.splice(final.indexOf(f), 1)
          break
        }
      }
    }
    if (!dominated) final.push(b)
  }

  return final
}

// ────────────────────────────────────────────────────────────────────
// Adjacent merge
// ────────────────────────────────────────────────────────────────────

/**
 * Merge same-type brunnels that are within a gap threshold.
 * @param {object[]} brunnels — sorted by startDist
 * @param {number[]} dists — cumulative distance array
 * @param {number} gapM — max gap for same-type merge (default 100)
 * @param {number} crossGapM — max gap for cross-type merge (default 20)
 * @returns {object[]} merged brunnels
 */
export function mergeAdjacent(brunnels, dists, gapM = 100, crossGapM = 20) {
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

  let merged = [...mergeGroup(bridges), ...mergeGroup(tunnels)]
  merged.sort((a, b) => a.startDist - b.startDist)

  // Cross-type merge for very close structures (highway interchanges)
  if (crossGapM > 0 && merged.length > 1) {
    const out = [{ ...merged[0] }]
    for (let i = 1; i < merged.length; i++) {
      const prev = out[out.length - 1]
      const cur = merged[i]
      if (cur.startDist - prev.endDist <= crossGapM) {
        prev.ahi = Math.max(prev.ahi, cur.ahi)
        prev.endDist = Math.max(prev.endDist, cur.endDist)
        prev.type = 'structure'
        prev.name = prev.name && cur.name && prev.name !== cur.name
          ? prev.name + ' / ' + cur.name
          : prev.name || cur.name
      } else {
        out.push({ ...cur })
      }
    }
    merged = out
  }

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
// Crossing tunnel detection
// ────────────────────────────────────────────────────────────────────

/**
 * Detect tunnels that cross under the route perpendicularly.
 *
 * These tunnels fail both proximity (nodes extend beyond route) and bearing
 * filters, but their LIDAR void creates a dip artifact on the route surface.
 *
 * Algorithm:
 * 1. For each tunnel segment, find where it comes closest to ANY route segment
 * 2. Keep only crossings within `crossBuf` metres
 * 3. Verify bearing is perpendicular (> 45° from route)
 * 4. Check LIDAR profile for a dip at the crossing point
 *
 * This detector is the main false-positive surface for brunnels: unlike the aligned
 * brunnels it runs on ALL tunnels and BYPASSES the OSM way-ID rejection (a crossing
 * tunnel is, by design, a different perpendicular way), so its only guards are geometry
 * + a LIDAR dip. A coincidental ~1 m dip under any nearby perpendicular tunnel would
 * place a correction. So the dip bar is LAYER-AWARE: a tunnel OSM-tagged `layer < 0`
 * (genuinely underground — strong prior that it can void the surface LIDAR) keeps the
 * normal `dipThresh`; a tunnel with no/≥0 layer (ambiguous — could be at grade, or just
 * a 2-D crossing that shouldn't touch the route) must clear the higher `strongDipThresh`
 * before it's accepted. Uses the candidate's already-parsed `layer` tag — no extra fetch.
 *
 * @param {object[]} tunnels — tunnel structures with geometry (and `layer`)
 * @param {number[]} lats — route lats
 * @param {number[]} lons — route lons
 * @param {number[]} dists — cumulative distances
 * @param {number[]} eles — elevations
 * @param {{ crossBuf?: number, dipThresh?: number, strongDipThresh?: number, dipWin?: number }} opts
 * @returns {object[]} crossing tunnel brunnels with { alo, ahi, type, ... }
 */
export function detectCrossingTunnels(tunnels, lats, lons, dists, eles, opts = {}) {
  const crossBuf = opts.crossBuf ?? 15
  const dipThresh = opts.dipThresh ?? 1.0
  const strongDipThresh = opts.strongDipThresh ?? 2.0
  const dipWin = opts.dipWin ?? 10
  const bearingMin = opts.bearingMin ?? 20
  const N = lats.length
  const results = []

  for (const tun of tunnels) {
    const g = tun.geometry
    if (g.length < 2) continue

    // Find closest approach between any tunnel segment and any route segment
    let bestDist = Infinity
    let bestRI = -1
    let bestTunBearing = 0

    for (let ti = 0; ti < g.length - 1; ti++) {
      const tBearing = bearing(g[ti].lat, g[ti].lon, g[ti + 1].lat, g[ti + 1].lon)

      for (let ri = 0; ri < N - 1; ri++) {
        // Check both directions: tunnel node closest to route, route node closest to tunnel
        const { lat: nLat, lon: nLon } = nearestOnSegment(
          g[ti].lat, g[ti].lon,
          lats[ri], lons[ri], lats[ri + 1], lons[ri + 1],
        )
        const d1 = haversine(g[ti].lat, g[ti].lon, nLat, nLon)

        const { lat: nLat2, lon: nLon2 } = nearestOnSegment(
          g[ti + 1].lat, g[ti + 1].lon,
          lats[ri], lons[ri], lats[ri + 1], lons[ri + 1],
        )
        const d2 = haversine(g[ti + 1].lat, g[ti + 1].lon, nLat2, nLon2)

        const d = Math.min(d1, d2)
        if (d < bestDist) {
          bestDist = d
          bestRI = ri
          bestTunBearing = tBearing
        }
      }
    }

    if (bestDist > crossBuf || bestRI < 0) continue

    // Check perpendicularity
    const rBearing = bearing(lats[bestRI], lons[bestRI], lats[bestRI + 1], lons[bestRI + 1])
    const bDiff = bearingDiff(bestTunBearing, rBearing)
    if (bDiff < bearingMin) continue

    // Check for LIDAR dip at crossing point
    const lo = Math.max(0, bestRI - dipWin)
    const hi = Math.min(N - 1, bestRI + dipWin)

    // Baseline: average elevation at window edges
    const edgeLo = eles[lo]
    const edgeHi = eles[hi]
    const baseline = (d) => {
      const t = (d - dists[lo]) / (dists[hi] - dists[lo] || 1)
      return edgeLo + t * (edgeHi - edgeLo)
    }

    // Layer-aware evidence bar: an OSM-underground tunnel (layer < 0) keeps the normal
    // dip threshold; an ambiguous one (no/≥0 layer) must clear the stronger bar.
    const effDipThresh = ((tun.layer ?? 0) < 0) ? dipThresh : strongDipThresh

    // Find max dip below baseline
    let maxDip = 0
    let dipIdx = bestRI
    for (let i = lo; i <= hi; i++) {
      const dip = baseline(dists[i]) - eles[i]
      if (dip > maxDip) {
        maxDip = dip
        dipIdx = i
      }
    }

    if (maxDip < effDipThresh) continue

    // Find dip extent: walk outward from dipIdx until elevation recovers
    let alo = dipIdx, ahi = dipIdx
    const halfThresh = effDipThresh * 0.5
    while (alo > lo && baseline(dists[alo - 1]) - eles[alo - 1] > halfThresh) alo--
    while (ahi < hi && baseline(dists[ahi + 1]) - eles[ahi + 1] > halfThresh) ahi++

    if (ahi <= alo) continue

    results.push({
      ...tun,
      osmId: tun.id,
      type: 'tunnel_crossing',
      alo,
      ahi,
      startDist: dists[alo],
      endDist: dists[ahi],
    })
  }

  return results
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
 * @param {{ queryBuffer?: number, routeBuffer?: number, bearingTol?: number, routeWayIds?: Uint32Array }} opts
 *   routeWayIds — OSM way IDs per route point (from way-matching). When provided,
 *   brunnels whose osmId does not match the route's way IDs in their span are rejected
 *   (eliminates parallel-road false positives).
 * @param {function} [onProgress] — (pct, msg) => void
 * @returns {Promise<object[]>} array of located brunnels with { alo, ahi, type, name, ... }
 */
export async function locateBrunnels(lats, lons, dists, eles, opts = {}, onProgress) {
  const queryBuffer = opts.queryBuffer || 10
  const routeBuffer = opts.routeBuffer || 3
  const bearingTol = opts.bearingTol || 20
  const routeWayIds = opts.routeWayIds || null

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

  // Stage 3.5: OSM way-ID match filter (when way IDs available)
  // Rejects brunnels whose osmId doesn't appear in the route's way IDs within
  // the brunnel span — eliminates parallel-road false positives (the route runs
  // alongside a road that has its own bridge, but never crosses that bridge).
  let wayMatched = projected
  if (routeWayIds && routeWayIds.length === lats.length) {
    onProgress?.(77, 'Filtering by OSM way ID...')
    wayMatched = projected.filter(s =>
      brunnelMatchesRouteWay(s.osmId, routeWayIds, s.alo, s.ahi),
    )
    onProgress?.(78, `${wayMatched.length}/${projected.length} match route's OSM way`)
    if (wayMatched.length === 0) {
      onProgress?.(100, 'No structures match route\'s OSM way')
      return []
    }
  }

  // Stage 4: Bearing alignment filter
  onProgress?.(80, 'Checking alignment...')
  const aligned = wayMatched.filter(s =>
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

  // Stage 6: Detect crossing tunnels (perpendicular tunnels causing LIDAR dips)
  const allTunnels = all.filter(s => s.type === 'tunnel')
  const crossingTunnels = detectCrossingTunnels(allTunnels, lats, lons, dists, eles)

  // Remove crossings that overlap with any aligned brunnel (already handled)
  const nonOverlapping = crossingTunnels.filter(ct =>
    !resolved.some(r => !(ct.endDist <= r.startDist || ct.startDist >= r.endDist)),
  )

  const withCrossings = [...resolved, ...nonOverlapping]
  withCrossings.sort((a, b) => a.startDist - b.startDist)

  // Stage 7: Merge adjacent same-type
  onProgress?.(95, 'Merging adjacent...')
  const merged = mergeAdjacent(withCrossings, dists, opts.mergeGapM ?? 100)

  const crossCount = nonOverlapping.length
  onProgress?.(100, `Located ${merged.length} brunnels${crossCount ? ` (${crossCount} crossing)` : ''}`)
  return merged
}

// ────────────────────────────────────────────────────────────────────
// Build corrections from brunnels (pre-seeds the Cleaner)
// ────────────────────────────────────────────────────────────────────

/**
 * Find contextual anchor for one side of a brunnel.
 *
 * 1. Skip tunnel portal plateaus (flat segments ≤15m at OSM boundary)
 * 2. Establish ambient road grade from a 50m lookout window
 * 3. Walk inward from lookout edge to find where LIDAR deviates from projected road
 *
 * @param {number[]} eles — elevations
 * @param {number[]} dists — cumulative distances
 * @param {number} osmIdx — OSM boundary index
 * @param {number} dir — -1 for lo side, +1 for hi side
 * @param {string} type — 'bridge' or 'tunnel'
 * @param {number} [lookoutM=50] — lookout window in metres
 * @param {number} [devThreshM=1.0] — elevation deviation threshold in metres
 * @returns {number} anchor index
 */
export function findContextualAnchor(eles, dists, osmIdx, dir, type,
  lookoutM = 50, devThreshM = 1.0) {
  const N = eles.length

  // Step 1: Skip tunnel portal (flat segment ≤15m at boundary)
  let scanStart = osmIdx
  if (type === 'tunnel') {
    for (let i = osmIdx + dir; i >= 0 && i < N; i += dir) {
      if (Math.abs(dists[i] - dists[osmIdx]) > 15) break
      const segLo = dir === -1 ? i : i - 1
      if (segLo < 0 || segLo + 1 >= N) break
      const ds = dists[segLo + 1] - dists[segLo]
      const gr = ds > 0.01 ? Math.abs(100 * (eles[segLo + 1] - eles[segLo]) / ds) : 0
      if (gr < 2.0) {
        scanStart = i
      } else {
        break
      }
    }
  }

  // Step 2: Lookout window — extend outward from scanStart by lookoutM
  let lookoutEdge = scanStart
  for (let i = scanStart + dir; i >= 0 && i < N; i += dir) {
    lookoutEdge = i
    if (Math.abs(dists[i] - dists[scanStart]) >= lookoutM) break
  }

  const lookoutDist = Math.abs(dists[lookoutEdge] - dists[scanStart])
  if (lookoutDist < 10) return osmIdx

  // Step 3: Ambient grade — median of segment grades in lookout window
  const lo = Math.min(scanStart, lookoutEdge)
  const hi = Math.max(scanStart, lookoutEdge)
  const segGrades = []
  for (let i = lo; i < hi; i++) {
    const ds = dists[i + 1] - dists[i]
    if (ds > 0.01) segGrades.push((eles[i + 1] - eles[i]) / ds)
  }
  if (segGrades.length === 0) return osmIdx

  segGrades.sort((a, b) => a - b)
  const mid = Math.floor(segGrades.length / 2)
  const ambientGr = segGrades.length % 2 === 1
    ? segGrades[mid]
    : (segGrades[mid - 1] + segGrades[mid]) / 2

  // Step 4: Walk inward from lookout edge toward brunnel, find divergence
  const refEle = eles[lookoutEdge]
  const refDist = dists[lookoutEdge]
  const inDir = -dir

  let anchor = scanStart
  for (let i = lookoutEdge; i >= 0 && i < N; i += inDir) {
    if (dir === -1 && i > osmIdx) break
    if (dir === 1 && i < osmIdx) break

    const projEle = refEle + ambientGr * (dists[i] - refDist)
    if (Math.abs(eles[i] - projEle) > devThreshM) {
      anchor = i - inDir
      break
    }
    anchor = i
  }

  // Step 5: Clamp — anchor can't go beyond lookout edge
  if ((dir === -1 && anchor < lookoutEdge) || (dir === 1 && anchor > lookoutEdge)) {
    anchor = osmIdx
  }

  return anchor
}

/**
 * Build correction objects from located brunnels using single-span Hermite.
 *
 * Anchors sit on clean terrain beyond the OSM span (blend distance = span^0.75).
 * Slopes from scanInwardSlope() read the actual road shape approaching each
 * bridge/tunnel. Hermite interpolation runs anchor-to-anchor; artifact
 * verification skips corrections where LIDAR already matches the expected surface.
 *
 * Brunnels are processed in route order. Each modifies the working array,
 * so close structures (bridge-tunnel-bridge) blend into each other naturally.
 *
 * @param {object[]} brunnels — located brunnels with { alo, ahi, type, name, id }
 * @param {number[]} eles — raw elevations
 * @param {number[]} dists — cumulative distances
 * @param {{ tangWin?: number }} shapeParams
 * @returns {{ corrections: object[], eleClean: number[] }}
 */

/**
 * Scan inward from an anchor toward the bridge center, computing the average
 * slope of the clean terrain. Stops when elevation deviates from the running
 * projection (artifact edge detected). This captures the actual road shape
 * approaching the bridge — the same visual cue a human uses when placing anchors.
 *
 * @param {number[]} eleClean — elevation array
 * @param {Float64Array} dists — cumulative distances
 * @param {number} anchor — index on clean terrain (blend edge)
 * @param {number} limit — scan limit (toward bridge center, exclusive)
 * @param {number} maxPts — max gradients to sample
 * @param {number} devThresh — deviation threshold (metres) to detect artifact edge
 * @returns {number} average slope (m/m) of the clean segment
 */
function scanInwardSlope(eleClean, dists, anchor, limit, maxPts = 8, devThresh = 0.5) {
  const e0 = eleClean[anchor]
  const d0 = dists[anchor]
  const fwd = limit > anchor

  let sum = 0, cnt = 0

  if (fwd) {
    const hi = Math.min(anchor + maxPts, limit, eleClean.length - 1)
    for (let j = anchor; j < hi; j++) {
      const ds = dists[j + 1] - dists[j]
      if (ds < 0.01) continue
      if (cnt >= 3) {
        const proj = e0 + (sum / cnt) * (dists[j + 1] - d0)
        if (Math.abs(eleClean[j + 1] - proj) > devThresh) break
      }
      sum += (eleClean[j + 1] - eleClean[j]) / ds
      cnt++
    }
  } else {
    const lo = Math.max(anchor - maxPts, limit, 0)
    for (let j = anchor - 1; j >= lo; j--) {
      const ds = dists[j + 1] - dists[j]
      if (ds < 0.01) continue
      if (cnt >= 3) {
        const proj = e0 + (sum / cnt) * (dists[j] - d0)
        if (Math.abs(eleClean[j] - proj) > devThresh) break
      }
      sum += (eleClean[j + 1] - eleClean[j]) / ds
      cnt++
    }
  }

  return cnt > 0 ? sum / cnt : 0
}

export function buildBrunnelCorrections(brunnels, eles, dists, shapeParams) {
  const eleClean = [...eles]
  const corrections = []
  const N = eles.length
  const { tangWin = 8 } = shapeParams || {}

  for (const b of brunnels) {
    if (b.alo >= b.ahi || b.ahi >= N) continue

    // Crossing tunnels: linear interpolation with short blend
    if (b.type === 'tunnel_crossing') {
      const blendM = 10
      const alo = Math.max(0, bsearchDists(dists, dists[b.alo] - blendM))
      const ahi = Math.min(N - 1, bsearchDists(dists, dists[b.ahi] + blendM))
      if (ahi <= alo) continue

      const e0 = eleClean[alo], e1 = eleClean[ahi]
      const span = dists[ahi] - dists[alo]
      if (span <= 0) continue

      for (let i = alo; i <= ahi; i++) {
        const t = (dists[i] - dists[alo]) / span
        eleClean[i] = e0 + t * (e1 - e0)
      }

      corrections.push({
        alo, ahi, span,
        grade: span > 0 ? (e1 - e0) / span * 100 : 0,
        type: 'tunnel_crossing',
        interp: 'linear',
        m0: 0, m1: 0,
        revRate: 0, meanGr: 0,
        accepted: true,
        rejected: false,
        osmId: b.id,
        osmName: b.name,
        source: 'osm',
      })
      continue
    }

    const osmLoD = dists[b.alo]
    const osmHiD = dists[b.ahi]
    const osmSpan = osmHiD - osmLoD
    const blendM = Math.min(100, Math.max(5, Math.pow(osmSpan, 0.75) * 1.5))

    // Outer blend edges (clamped to route bounds)
    const alo = Math.max(0, bsearchDists(dists, osmLoD - blendM))
    const ahi = Math.min(N - 1, bsearchDists(dists, osmHiD + blendM))
    if (ahi <= alo) continue

    // Road slopes: scan inward from anchor toward the bridge center.
    // Uses the clean terrain between anchor and artifact edge to determine
    // the actual road shape approaching the bridge.
    const midIdx = Math.floor((alo + ahi) / 2)
    const m0 = scanInwardSlope(eleClean, dists, alo, midIdx, tangWin)
    const m1 = scanInwardSlope(eleClean, dists, ahi, midIdx, tangWin)

    const e0 = eleClean[alo], e1 = eleClean[ahi]
    const fullSpan = dists[ahi] - dists[alo]
    if (fullSpan <= 0) continue

    // Artifact verification: check if LIDAR deviates from expected road surface.
    // A tunnel directly below the road has correct LIDAR — skip the correction.
    let maxDev = 0
    for (let i = b.alo; i <= b.ahi; i++) {
      const t = (dists[i] - dists[alo]) / fullSpan
      const expected = hermiteElevation(t, e0, e1, m0, m1, fullSpan)
      const dev = Math.abs(eleClean[i] - expected)
      if (dev > maxDev) maxDev = dev
    }
    // Underground tunnels (layer < 0) need bigger deviation to correct
    const baseThresh = shapeParams?.artifactThresh ?? 0.5
    const artifactThresh = (b.type === 'tunnel' && (b.layer ?? 0) < 0) ? Math.max(baseThresh, 2) : baseThresh
    if (maxDev < artifactThresh) continue

    // Hermite interpolation across entire correction zone (anchors preserved)
    for (let i = alo + 1; i < ahi; i++) {
      const t = (dists[i] - dists[alo]) / fullSpan
      eleClean[i] = hermiteElevation(t, e0, e1, m0, m1, fullSpan)
    }

    const grade = fullSpan > 0 ? (e1 - e0) / fullSpan * 100 : 0

    corrections.push({
      alo, ahi, span: fullSpan, grade,
      type: b.type === 'structure' ? 'structure' : b.type === 'tunnel' ? 'tunnel' : 'bridge',
      interp: 'hermite',
      m0, m1,
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

