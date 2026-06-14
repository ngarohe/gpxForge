/**
 * Geometry utilities — point-to-segment, projection, nearest-point, fillets.
 *
 * All geographic functions work in lat/lon degrees.
 * Canvas-pixel functions are prefixed with `px`.
 */

import { haversine, turnAngleDeg } from './math.js'

const DEG2RAD = Math.PI / 180
const R_EARTH = 6371000

// ────────────────────────────────────────────────────────────────────
// Geographic segment operations
// ────────────────────────────────────────────────────────────────────

/**
 * Nearest point on a line segment [A, B] to point P.
 * Works in degree-space (fast approximation, accurate for short segments).
 * @param {number} pLat — query point latitude
 * @param {number} pLon — query point longitude
 * @param {number} aLat — segment start latitude
 * @param {number} aLon — segment start longitude
 * @param {number} bLat — segment end latitude
 * @param {number} bLon — segment end longitude
 * @returns {{ lat: number, lon: number, t: number }} nearest point and parameter t ∈ [0,1]
 */
export function nearestOnSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  const dx = bLon - aLon, dy = bLat - aLat
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return { lat: aLat, lon: aLon, t: 0 }
  let t = ((pLon - aLon) * dx + (pLat - aLat) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return { lat: aLat + t * dy, lon: aLon + t * dx, t }
}

/**
 * Minimum distance from a point to a polyline (route).
 * @param {number} pLat — query point latitude
 * @param {number} pLon — query point longitude
 * @param {number[]} lats — route latitudes
 * @param {number[]} lons — route longitudes
 * @returns {number} minimum distance in metres
 */
export function pointToRouteDistance(pLat, pLon, lats, lons) {
  let minD = Infinity
  for (let i = 0; i < lats.length - 1; i++) {
    const { lat, lon } = nearestOnSegment(pLat, pLon, lats[i], lons[i], lats[i + 1], lons[i + 1])
    const d = haversine(pLat, pLon, lat, lon)
    if (d < minD) minD = d
  }
  return minD
}

/**
 * Project a point onto a route, returning cumulative distance along the route.
 * @param {number} pLat
 * @param {number} pLon
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} dists — cumulative distance array
 * @returns {number} projected distance in metres
 */
export function projectOntoRoute(pLat, pLon, lats, lons, dists) {
  let bestDist = Infinity, bestRouteDist = 0
  for (let i = 0; i < lats.length - 1; i++) {
    const { lat, lon, t } = nearestOnSegment(pLat, pLon, lats[i], lons[i], lats[i + 1], lons[i + 1])
    const d = haversine(pLat, pLon, lat, lon)
    if (d < bestDist) {
      bestDist = d
      bestRouteDist = dists[i] + t * (dists[i + 1] - dists[i])
    }
  }
  return bestRouteDist
}

/**
 * Project a point onto a route within a limited index range.
 * Same as projectOntoRoute but only searches segments [lo, hi).
 * Used to prevent cross-pass projection on out-and-back routes.
 * @param {number} pLat
 * @param {number} pLon
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} dists — cumulative distance array
 * @param {number} lo — start index (inclusive)
 * @param {number} hi — end index (exclusive, clamped to array length)
 * @returns {number} projected distance in metres
 */
export function projectOntoRouteLocal(pLat, pLon, lats, lons, dists, lo, hi) {
  const start = Math.max(0, lo)
  const end = Math.min(lats.length - 1, hi)
  let bestDist = Infinity, bestRouteDist = dists[start]
  for (let i = start; i < end; i++) {
    const { lat, lon, t } = nearestOnSegment(pLat, pLon, lats[i], lons[i], lats[i + 1], lons[i + 1])
    const d = haversine(pLat, pLon, lat, lon)
    if (d < bestDist) {
      bestDist = d
      bestRouteDist = dists[i] + t * (dists[i + 1] - dists[i])
    }
  }
  return bestRouteDist
}

/**
 * Minimum distance from a point to a polyline, searching only segments [lo, hi).
 * @param {number} pLat — query point latitude
 * @param {number} pLon — query point longitude
 * @param {number[]} lats — route latitudes
 * @param {number[]} lons — route longitudes
 * @param {number} lo — start segment index (inclusive)
 * @param {number} hi — end segment index (exclusive, clamped to array length - 1)
 * @returns {number} minimum distance in metres
 */
export function pointToRouteDistanceLocal(pLat, pLon, lats, lons, lo, hi) {
  const start = Math.max(0, lo)
  const end = Math.min(lats.length - 1, hi)
  let minD = Infinity
  for (let i = start; i < end; i++) {
    const { lat, lon } = nearestOnSegment(pLat, pLon, lats[i], lons[i], lats[i + 1], lons[i + 1])
    const d = haversine(pLat, pLon, lat, lon)
    if (d < minD) minD = d
  }
  return minD
}

/**
 * Find the route index nearest to a cumulative distance.
 * @param {number} targetDist — target distance in metres
 * @param {number[]} dists — cumulative distance array
 * @returns {number} nearest index
 */
export function distToIndex(targetDist, dists) {
  let best = 0
  for (let i = 1; i < dists.length; i++) {
    if (Math.abs(dists[i] - targetDist) < Math.abs(dists[best] - targetDist)) best = i
  }
  return best
}

/**
 * Find nearest GPX point index to a given lat/lon (brute force).
 * @param {number} lat
 * @param {number} lon
 * @param {number[]} lats
 * @param {number[]} lons
 * @returns {number} nearest index
 */
export function nearestPointIndex(lat, lon, lats, lons) {
  let best = 0, bestD = Infinity
  for (let i = 0; i < lats.length; i++) {
    const d = (lats[i] - lat) ** 2 + (lons[i] - lon) ** 2
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

/**
 * Check if a polyline's median node distance is within a buffer.
 * Used for brunnel-on-route detection.
 * @param {{ lat: number, lon: number }[]} geometry — brunnel nodes
 * @param {number[]} lats — route latitudes
 * @param {number[]} lons — route longitudes
 * @param {number} bufferM — max median distance in metres
 * @returns {boolean}
 */
export function polylineWithinBuffer(geometry, lats, lons, bufferM) {
  const nodeDists = geometry
    .map(({ lat, lon }) => pointToRouteDistance(lat, lon, lats, lons))
    .sort((a, b) => a - b)
  return nodeDists[Math.floor(nodeDists.length / 2)] <= bufferM
}

// ────────────────────────────────────────────────────────────────────
// Fillet-based corner rounding
// ────────────────────────────────────────────────────────────────────

/**
 * Generate a circular fillet arc at a corner defined by approach and exit
 * directions meeting at a vertex.
 *
 * Works in local Cartesian (metres) with cos(lat) correction for longitude.
 * The arc is tangent to both segments and has the specified radius.
 * Returns null if the corner is below threshold or geometry is degenerate.
 *
 * @param {number} prevLat — point before vertex (approach direction)
 * @param {number} prevLon
 * @param {number} vtxLat — vertex (corner point)
 * @param {number} vtxLon
 * @param {number} nextLat — point after vertex (exit direction)
 * @param {number} nextLon
 * @param {number} radiusM — target fillet radius in metres
 * @param {number} spacingM — point spacing along the arc in metres
 * @param {number} [maxSegFrac=0.9] — max fraction of segment consumed by tangent
 * @returns {null | { points: {lat:number,lon:number}[], tangentDist: number, actualRadius: number }}
 */
export function filletCorner(
  prevLat, prevLon, vtxLat, vtxLon, nextLat, nextLon,
  radiusM, spacingM, maxSegFrac = 0.9,
) {
  const cosLat = Math.cos(vtxLat * DEG2RAD)
  const mPerDegLat = R_EARTH * DEG2RAD
  const mPerDegLon = mPerDegLat * cosLat

  // Convert to local metres centred on vertex
  const px = (prevLon - vtxLon) * mPerDegLon
  const py = (prevLat - vtxLat) * mPerDegLat
  const qx = (nextLon - vtxLon) * mPerDegLon
  const qy = (nextLat - vtxLat) * mPerDegLat

  const pLen = Math.hypot(px, py)
  const qLen = Math.hypot(qx, qy)
  if (pLen < 0.1 || qLen < 0.1) return null

  // Unit vectors from vertex toward prev / next
  const u1x = px / pLen, u1y = py / pLen
  const u2x = qx / qLen, u2y = qy / qLen

  // Interior angle θ at vertex (0 = U-turn, π = straight)
  const dot = u1x * u2x + u1y * u2y
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)))

  // θ near π means nearly straight — no fillet needed
  if (theta > Math.PI - 0.02) return null // < ~1° turn

  // U-turns (≥160°) can't be filleted — tangentDist → ∞, bisector → 0.
  if (theta < 0.35) return null // ~160°+ turn

  const halfTheta = theta / 2
  const sinHalf = Math.sin(halfTheta)
  const tanHalf = Math.tan(halfTheta)
  if (tanHalf < 1e-10 || sinHalf < 1e-10) return null

  // Tangent distance from vertex along each segment
  let tangentDist = radiusM / tanHalf
  let R = radiusM

  // Clamp if tangent exceeds segment length
  const maxTangent = Math.min(pLen, qLen) * maxSegFrac
  if (tangentDist > maxTangent) {
    tangentDist = maxTangent
    R = tangentDist * tanHalf
  }

  // Tangent points (in local metres)
  const t1x = tangentDist * u1x, t1y = tangentDist * u1y
  const t2x = tangentDist * u2x, t2y = tangentDist * u2y

  // Arc centre: along bisector at distance R / sin(halfTheta)
  const bx = u1x + u2x, by = u1y + u2y
  const bLen = Math.hypot(bx, by)
  if (bLen < 1e-10) return null // shouldn't reach here (caught by U-turn above)
  const centreDist = R / sinHalf
  const cx = centreDist * bx / bLen
  const cy = centreDist * by / bLen

  // Arc start/end angles relative to centre
  const angleStart = Math.atan2(t1y - cy, t1x - cx)

  // Sweep direction: cross product determines turn direction
  const cross = u1x * u2y - u1y * u2x
  const sweepAngle = -Math.sign(cross) * (Math.PI - theta)

  // Generate arc points at spacingM intervals
  const arcLength = Math.abs(sweepAngle) * R
  const nSteps = Math.max(2, Math.ceil(arcLength / spacingM))

  const points = []
  for (let k = 0; k <= nSteps; k++) {
    const angle = angleStart + (k / nSteps) * sweepAngle
    const x = cx + R * Math.cos(angle)
    const y = cy + R * Math.sin(angle)
    points.push({
      lat: vtxLat + y / mPerDegLat,
      lon: vtxLon + x / mPerDegLon,
    })
  }

  return { points, tangentDist, actualRadius: R }
}

/**
 * Find corner clusters — groups of adjacent high-turn vertices that form
 * a single logical corner (e.g., a hairpin spread across multiple vertices).
 *
 * Uses distance-based gap detection: vertices within maxGapM metres of each
 * other are grouped. This works correctly regardless of point spacing
 * (1m LIDAR vs 12m road snap).
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} minTurnDeg — minimum total turn for a cluster to qualify
 * @param {number} [vertexThreshDeg=3] — individual vertex turn threshold
 * @param {number} [maxGapM=50] — max distance (metres) between vertices in a cluster
 * @param {number} [minDensityDegPerM=2] — min turn density (°/m) to qualify
 *   Prevents gentle curves (R > ~29m) from being filleted even if total turn
 *   exceeds threshold. A 6m-radius hairpin has ~9.5°/m; a 30m curve has ~1.9°/m.
 * @returns {Array<{ startIdx: number, endIdx: number, totalTurn: number }>}
 */
export function findCornerClusters(lats, lons, minTurnDeg, vertexThreshDeg = 3, maxGapM = 50, minDensityDegPerM = 2) {
  const N = lats.length
  if (N < 3) return []

  // Compute turn angles at all interior points
  const turns = new Float64Array(N)
  for (let i = 1; i < N - 1; i++) {
    const ax = lats[i - 1] - lats[i], ay = lons[i - 1] - lons[i]
    const bx = lats[i + 1] - lats[i], by = lons[i + 1] - lons[i]
    const ma = Math.hypot(ax, ay), mb = Math.hypot(bx, by)
    if (ma < 1e-12 || mb < 1e-12) continue
    const cosA = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (ma * mb)))
    turns[i] = 180 - Math.acos(cosA) * 180 / Math.PI
  }

  // Find vertices above threshold
  const isVertex = new Uint8Array(N)
  for (let i = 1; i < N - 1; i++) {
    if (turns[i] >= vertexThreshDeg) isVertex[i] = 1
  }

  // Group into clusters: merge vertices within maxGapM metres of each other
  const clusters = []
  let i = 1
  while (i < N - 1) {
    if (!isVertex[i]) { i++; continue }

    let clusterStart = i
    let clusterEnd = i
    let totalTurn = turns[i]

    // Expand cluster forward
    let j = i + 1
    while (j < N - 1) {
      if (isVertex[j]) {
        // Distance-based gap check
        const gapDist = haversine(lats[clusterEnd], lons[clusterEnd], lats[j], lons[j])
        if (gapDist <= maxGapM) {
          clusterEnd = j
          totalTurn += turns[j]
          j++
        } else {
          break // gap too large — start new cluster
        }
      } else {
        j++
      }
    }

    if (totalTurn >= minTurnDeg) {
      // Density check: compute route distance within the cluster.
      // Rejects gentle curves where turn is spread over long distance
      // (e.g., 100° over 200m = 0.5°/m → gentle road curve, not a hairpin).
      // Single vertex: clusterLen=0, density=Infinity → always passes.
      let clusterLen = 0
      for (let k = clusterStart; k < clusterEnd; k++) {
        clusterLen += haversine(lats[k], lons[k], lats[k + 1], lons[k + 1])
      }
      const density = clusterLen > 0 ? totalTurn / clusterLen : Infinity
      if (density >= minDensityDegPerM) {
        clusters.push({ startIdx: clusterStart, endIdx: clusterEnd, totalTurn })
      }
    }

    i = clusterEnd + 1
  }

  return clusters
}

/**
 * Apply fillet arcs to all qualifying sharp vertices in a route.
 *
 * Per-vertex approach: each vertex with individual turn angle ≥ minTurnDeg
 * gets a fillet arc. This avoids the clustering problems where gentle curves
 * (many small turns summing to > threshold) get incorrectly filleted.
 *
 * Multi-vertex hairpins where each vertex has < minTurnDeg are left for
 * processGPX to handle — their effective radius is larger than the fillet
 * target (e.g., 3 × 40° at 5m spacing has R ≈ 7m, above the 6m target).
 *
 * Elevation at arc points is linearly interpolated from approach to exit,
 * avoiding staircase artifacts from nearest-segment projection at hairpins.
 *
 * @param {number[]} lats — input latitudes
 * @param {number[]} lons — input longitudes
 * @param {number[]} eles — input elevations
 * @param {number[]} dists — cumulative distances
 * @param {{ minTurnDeg?: number, radiusM?: number, spacingM?: number }} [opts]
 * @returns {{ lats: number[], lons: number[], eles: number[], dists: number[] }}
 */
export function applyFillets(lats, lons, eles, dists, opts = {}) {
  const {
    minTurnDeg = 100,
    radiusM = 6.5,
    spacingM = 0.3,
  } = opts

  const N = lats.length

  // Find individual vertices with turn ≥ minTurnDeg
  const vertices = []
  for (let i = 1; i < N - 1; i++) {
    const ax = lats[i - 1] - lats[i], ay = lons[i - 1] - lons[i]
    const bx = lats[i + 1] - lats[i], by = lons[i + 1] - lons[i]
    const ma = Math.hypot(ax, ay), mb = Math.hypot(bx, by)
    if (ma < 1e-12 || mb < 1e-12) continue
    const cosA = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (ma * mb)))
    const turn = 180 - Math.acos(cosA) * 180 / Math.PI
    if (turn >= minTurnDeg) vertices.push(i)
  }

  if (vertices.length === 0) {
    return { lats: [...lats], lons: [...lons], eles: [...eles], dists: [...dists] }
  }

  // Build output arrays by splicing fillet arcs at each qualifying vertex
  const outLats = []
  const outLons = []
  const outEles = []
  let prevEnd = 0 // index up to which we've copied from input

  for (const vi of vertices) {
    // Skip if this vertex was consumed by a previous fillet's exit
    if (vi <= prevEnd) continue

    const approachIdx = vi - 1
    const exitIdx = vi + 1
    if (exitIdx >= N) continue

    const fillet = filletCorner(
      lats[approachIdx], lons[approachIdx],
      lats[vi], lons[vi],
      lats[exitIdx], lons[exitIdx],
      radiusM, spacingM,
    )

    if (!fillet || fillet.points.length < 2) continue

    // Copy original points up to approachIdx (inclusive)
    for (let k = prevEnd; k <= approachIdx; k++) {
      outLats.push(lats[k])
      outLons.push(lons[k])
      outEles.push(eles[k])
    }

    // Interpolate elevation linearly along the arc from approach to exit.
    // Avoids staircase artifacts from nearest-segment projection at hairpins
    // where approach and exit segments are spatially close but at different
    // elevations. Linear interpolation gives constant grade through corner.
    const arcN = fillet.points.length
    const eleEntry = eles[approachIdx]
    const eleExit = eles[exitIdx]
    for (let k = 0; k < arcN; k++) {
      outLats.push(fillet.points[k].lat)
      outLons.push(fillet.points[k].lon)
      const f = arcN > 1 ? k / (arcN - 1) : 0.5
      outEles.push(eleEntry + f * (eleExit - eleEntry))
    }

    prevEnd = exitIdx // skip vertex, continue from exit point
  }

  // Copy remaining original points
  for (let k = prevEnd; k < N; k++) {
    outLats.push(lats[k])
    outLons.push(lons[k])
    outEles.push(eles[k])
  }

  // Recompute distances
  const outDists = [0]
  for (let i = 1; i < outLats.length; i++) {
    outDists.push(outDists[i - 1] + haversine(outLats[i - 1], outLons[i - 1], outLats[i], outLons[i]))
  }

  return { lats: outLats, lons: outLons, eles: outEles, dists: outDists }
}

/**
 * Round a SORTED list of corner VERTEX indices on a polyline, each to a min-radius fillet arc — the
 * shared core of `filletJunctions` (junction nodes) and `filletAllCorners` (junctions + road bends).
 * Every corner of the same sharpness gets the same `filletCorner` shape, so turn geometry is uniform
 * regardless of where the corners came from.
 *
 * The tangent points are placed at EXACTLY the fillet's tangent distance on the route (interpolated,
 * not the nearest index) with one refinement pass so the tangent distance is computed from the legs as
 * actually cut — the arc meets the straight legs near-tangent (no kink, even when a road curves within
 * the direction baseline). Holds the min radius up to ~150° turns; a near-180° fold (turn ≥
 * `turnaroundDeg`) is teardropped via the injected `makeTurnaround` callback (or left sharp if none).
 * A vertex the route runs near-straight through (turn < `minTurnDeg`) is left an exact single point.
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles @param {number[]|Float64Array} dists
 * @param {number[]} vertexIdxs — absolute corner-vertex indices (any order; deduped/sorted internally)
 * @param {{ radiusM?:number, spacingM?:number, minTurnDeg?:number, baselineM?:number,
 *   turnaroundDeg?:number, makeTurnaround?:(Ta,Tf,vtx,fwd,R)=>Array<{lat,lon}> }} [opts]
 * @returns {{ lats:number[], lons:number[], eles:number[], dists:number[] }}
 */
export function filletAtVertices(lats, lons, eles, dists, vertexIdxs, opts = {}) {
  const radiusM = opts.radiusM ?? 6
  const spacingM = opts.spacingM ?? 0.3
  const minTurnDeg = opts.minTurnDeg ?? 20
  const baselineM = opts.baselineM ?? radiusM * 3
  const turnaroundDeg = opts.turnaroundDeg ?? 150
  const makeTurnaround = opts.makeTurnaround || null
  const N = lats.length
  if (N < 3 || !vertexIdxs || vertexIdxs.length === 0) {
    return { lats: [...lats], lons: [...lons], eles: [...eles], dists: [...dists] }
  }
  const D = (dists && dists.length === N) ? dists : (() => {
    const d = [0]; for (let i = 1; i < N; i++) d.push(d[i - 1] + haversine(lats[i - 1], lons[i - 1], lats[i], lons[i])); return d
  })()

  // Exact point on the route `dist` metres from index j, going back (dir=-1) or forward (dir=+1).
  // Returns the interpolated coord + its fractional index, so the fillet's tangent point lands EXACTLY
  // where we cut the route (cutting at the nearest integer index instead leaves a small kink).
  const pointAtDist = (j, dist, dir) => {
    let acc = 0, i = j
    for (;;) {
      const ni = i + dir
      if (ni < 0 || ni >= N) return { lat: lats[i], lon: lons[i], ele: eles[i], fIdx: i }
      const seg = Math.abs(D[ni] - D[i])
      if (acc + seg >= dist) {
        const t = seg > 0 ? (dist - acc) / seg : 0
        return {
          lat: lats[i] + t * (lats[ni] - lats[i]), lon: lons[i] + t * (lons[ni] - lons[i]),
          ele: eles[i] + t * (eles[ni] - eles[i]), fIdx: i + dir * t,
        }
      }
      acc += seg; i = ni
    }
  }

  const corners = [...new Set(vertexIdxs)].filter((j) => j > 0 && j < N - 1).sort((a, b) => a - b)

  const outLats = [], outLons = [], outEles = []
  let prevEnd = 0  // next input index still to copy

  for (const j of corners) {
    if (j <= prevEnd) continue  // consumed by a previous fillet
    const backCap = D[j] - D[prevEnd]
    const fwdCap = D[N - 1] - D[j]
    const bl = Math.min(baselineM, backCap, fwdCap)
    if (bl < 1) continue

    // Direction over the baseline decides straight-through / fillet / turnaround.
    const Pa0 = pointAtDist(j, bl, -1), Pf0 = pointAtDist(j, bl, +1)
    const turn0 = turnAngleDeg(Pa0.lat, Pa0.lon, lats[j], lons[j], Pf0.lat, Pf0.lon)
    if (turn0 < minTurnDeg) continue   // straight through → exact single point

    // Near-180° fold: a fillet can't round it (tangent → ∞). Teardrop via the injected builder.
    if (turn0 >= turnaroundDeg && makeTurnaround) {
      const td = Math.min(radiusM, 0.9 * backCap, 0.9 * fwdCap)
      const Ta = pointAtDist(j, td, -1), Tf = pointAtDist(j, td, +1)
      const mLat = (Ta.lat + Tf.lat) / 2, mLon = (Ta.lon + Tf.lon) / 2
      const mPerLat = R_EARTH * DEG2RAD, mPerLon = mPerLat * Math.cos(lats[j] * DEG2RAD)
      // Forward = from the chord midpoint out through the fold tip (where the teardrop should bulge).
      let fx = (lons[j] - mLon) * mPerLon, fy = (lats[j] - mLat) * mPerLat
      const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl
      const interior = makeTurnaround(Ta, Tf, { lat: lats[j], lon: lons[j] }, [fx, fy], radiusM)
      if (interior && interior.length) {
        const aIdx = Math.max(prevEnd, Math.floor(Ta.fIdx))
        for (let k = prevEnd; k <= aIdx; k++) { outLats.push(lats[k]); outLons.push(lons[k]); outEles.push(eles[k]) }
        const arc = [{ lat: Ta.lat, lon: Ta.lon }, ...interior, { lat: Tf.lat, lon: Tf.lon }]
        for (let k = 0; k < arc.length; k++) {
          outLats.push(arc[k].lat); outLons.push(arc[k].lon)
          const f = arc.length > 1 ? k / (arc.length - 1) : 0.5
          outEles.push(Ta.ele + f * (Tf.ele - Ta.ele))
        }
        prevEnd = Math.min(N - 1, Math.ceil(Tf.fIdx))
        continue
      }
    }

    // Tangent points: place them at EXACTLY tangentDist on the route, with one refinement pass so the
    // tangent distance is computed from the legs as actually cut (not an 18 m baseline that a road
    // curve would skew → the residual kink). The arc from filletCorner is then tangent to the real legs.
    let Pa = Pa0, Pf = Pf0, Ta = Pa0, Tf = Pf0, fillet = null
    for (let pass = 0; pass < 2; pass++) {
      const turn = turnAngleDeg(Pa.lat, Pa.lon, lats[j], lons[j], Pf.lat, Pf.lon)
      if (turn < minTurnDeg) { fillet = null; break }   // straight through → no fillet
      const theta = (180 - turn) * Math.PI / 180        // interior angle at j
      let td = radiusM / Math.tan(theta / 2)
      td = Math.min(td, 0.9 * backCap, 0.9 * fwdCap)
      Ta = pointAtDist(j, td, -1)
      Tf = pointAtDist(j, td, +1)
      fillet = filletCorner(Ta.lat, Ta.lon, lats[j], lons[j], Tf.lat, Tf.lon, radiusM, spacingM, 0.999)
      Pa = Ta; Pf = Tf  // refine direction from the actual tangent chords on the next pass
    }
    if (!fillet || fillet.points.length < 2) continue

    // Copy the route up to the integer index just before the approach tangent, then the arc (its first/
    // last points ≈ Ta/Tf), then resume from the integer index just after the departure tangent.
    const aIdx = Math.max(prevEnd, Math.floor(Ta.fIdx))
    for (let k = prevEnd; k <= aIdx; k++) { outLats.push(lats[k]); outLons.push(lons[k]); outEles.push(eles[k]) }
    const arcN = fillet.points.length
    for (let k = 0; k < arcN; k++) {
      outLats.push(fillet.points[k].lat); outLons.push(fillet.points[k].lon)
      const f = arcN > 1 ? k / (arcN - 1) : 0.5
      outEles.push(Ta.ele + f * (Tf.ele - Ta.ele))
    }
    prevEnd = Math.min(N - 1, Math.ceil(Tf.fIdx))
  }
  for (let k = prevEnd; k < N; k++) { outLats.push(lats[k]); outLons.push(lons[k]); outEles.push(eles[k]) }

  const outDists = [0]
  for (let i = 1; i < outLats.length; i++) outDists.push(outDists[i - 1] + haversine(outLats[i - 1], outLons[i - 1], outLats[i], outLons[i]))
  return { lats: outLats, lons: outLons, eles: outEles, dists: outDists }
}

/**
 * Round ONLY the junction turns of a compiled course (thin wrapper over `filletAtVertices`).
 * `compileRouteGraph` reports `arcBounds[i]` = arc i's first NEW point (after the dropped duplicate
 * join), so the shared junction node is `arcBounds[i] − 1` (same convention as junction-arcs.js
 * `roundJunctions`). Mid-segment road curves are left untouched.
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles @param {number[]} dists
 * @param {number[]} arcBounds — per-arc start index in the flat output (from compileRouteGraph)
 * @param {object} [opts] — see `filletAtVertices`
 * @returns {{ lats:number[], lons:number[], eles:number[], dists:number[] }}
 */
export function filletJunctions(lats, lons, eles, dists, arcBounds, opts = {}) {
  const vertices = (arcBounds || []).slice(1).map((b) => b - 1)
  return filletAtVertices(lats, lons, eles, dists, vertices, opts)
}

/**
 * Corner-vertex indices where the polyline's natural radius is below `radiusM` — the apex of each
 * sub-radius window from `analyzeRadiusWindows`. Used to round mid-segment road bends to the same min
 * radius as junctions, so every turn is shaped consistently.
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]|Float64Array} dists
 * @param {{ radiusM?:number }} [opts] — radiusM (6); other opts forwarded to analyzeRadiusWindows
 * @returns {number[]} apex indices (interior, sorted ascending)
 */
export function detectCornerVertices(lats, lons, dists, opts = {}) {
  const radiusM = opts.radiusM ?? 6
  const { windows } = analyzeRadiusWindows(lats, lons, dists, { ...opts, targetRadiusM: radiusM })
  const N = lats.length
  return windows.map((w) => w.apexIdx).filter((a) => a > 0 && a < N - 1).sort((a, b) => a - b)
}

/**
 * Round EVERY turn of a polyline to one min-radius `R`, choosing the shaping by turn TYPE so identical
 * turns are shaped the same way everywhere:
 *  - **hairpin** (a real switchback, ≥135° net turn): the apex is WIDENED outward to `R`
 *    (`widenLowRadiusCorners`). An inscribed fillet here cuts 10–20 m across the inside of the turn
 *    (the legs fold back close together) — the bug the user hit.
 *  - **road-corner / routing-kink** (junction-like turns + spurious snapped U-turns) and any
 *    `arcBoundVertices` (junction nodes): INSCRIBE-filleted to `R` (`filletAtVertices`) — correctly
 *    cuts the corner, which is what you want at a junction or to remove a routing artifact.
 * Widening is point-count preserving, so corner indices stay valid for the fillet pass.
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles @param {number[]|Float64Array} dists
 * @param {{ radiusM?:number, arcBoundVertices?:number[], spacingM?:number, minTurnDeg?:number,
 *   turnaroundDeg?:number, makeTurnaround?:Function }} [opts]
 * @returns {{ lats:number[], lons:number[], eles:number[], dists:number[] }}
 */
export function filletAllCorners(lats, lons, eles, dists, opts = {}) {
  const radiusM = opts.radiusM ?? 6
  const { windows } = analyzeRadiusWindows(lats, lons, dists, { ...opts, targetRadiusM: radiusM })

  // 1. Hairpins: widen the apex OUTWARD (preserve the road), not inscribe-fillet (which cuts inside).
  //    Point-count preserving → the indices used by the fillet pass below stay valid.
  let cl = lats, cn = lons, cd = dists
  if (windows.some((w) => w.kind === 'hairpin')) {
    const w = widenLowRadiusCorners(lats, lons, dists, { ...opts, targetRadiusM: radiusM, correctKinds: ['hairpin'], fairRoutingKinks: false })
    cl = w.lats; cn = w.lons; cd = w.dists
  }

  // 2. Inscribe-fillet the rest: junction nodes (arcBoundVertices) + every non-hairpin sub-R apex
  //    (road-corners + routing-kinks). Re-detect on the widened geometry so apex indices match.
  const cornerWins = analyzeRadiusWindows(cl, cn, cd, { ...opts, targetRadiusM: radiusM }).windows
  const detected = cornerWins.filter((w) => w.kind !== 'hairpin').map((w) => w.apexIdx)
  const vertices = [...(opts.arcBoundVertices || []), ...detected]
  return filletAtVertices(cl, cn, eles, cd, vertices, { ...opts, radiusM })
}

// ────────────────────────────────────────────────────────────────────
// Nudge tight corners (legacy — available but not used in pipeline)
// ────────────────────────────────────────────────────────────────────

/**
 * Circumscribed radius of the circle through three consecutive points.
 * Uses local Cartesian (cos(lat) correction) for metre-accurate geometry.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} i — centre point index (must be interior: 0 < i < N-1)
 * @returns {number} radius in metres (Infinity for collinear/degenerate)
 */
export function circumscribedRadius3(lats, lons, i) {
  const mPerDegLat = R_EARTH * DEG2RAD
  const cosLat = Math.cos(lats[i] * DEG2RAD)
  const mPerDegLon = mPerDegLat * cosLat

  const x1 = (lons[i - 1] - lons[i]) * mPerDegLon
  const y1 = (lats[i - 1] - lats[i]) * mPerDegLat
  const x3 = (lons[i + 1] - lons[i]) * mPerDegLon
  const y3 = (lats[i + 1] - lats[i]) * mPerDegLat

  const cross = (-x1) * (y3 - y1) - (-y1) * (x3 - x1)
  const area2 = Math.abs(cross)
  if (area2 < 1e-10) return Infinity

  const a = Math.hypot(x1, y1)
  const b = Math.hypot(x3, y3)
  const c = Math.hypot(x3 - x1, y3 - y1)

  return (a * b * c) / (2 * area2)
}

/**
 * Nudge track points outward at tight corners to widen the turning radius.
 *
 * Uses a unified raised-cosine bell profile over a wide zone (anchors 20m
 * from the tight region). This creates naturally round corners without
 * jagged per-point pushes or abrupt blend boundaries.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} dists — cumulative distances (metres)
 * @param {{ targetRadius?: number, anchorDist?: number, pushGain?: number }} [opts]
 * @returns {{ lats: number[], lons: number[], dists: number[], tightCount: number, maxOffset: number }}
 */
export function nudgeTightCorners(lats, lons, dists, opts = {}) {
  const { targetRadius = 6, anchorDist = 20, pushGain = 1.5 } = opts
  const N = lats.length
  if (N < 3) {
    return { lats: [...lats], lons: [...lons], dists: [...dists], tightCount: 0, maxOffset: 0 }
  }

  const mPerDegLat = R_EARTH * DEG2RAD

  // Step 1: Compute circumscribed radius at each interior point
  const radii = new Float64Array(N).fill(Infinity)
  for (let i = 1; i < N - 1; i++) {
    radii[i] = circumscribedRadius3(lats, lons, i)
  }

  // Step 2: Find contiguous tight regions (radius < targetRadius)
  // Merge regions separated by ≤ 3 points
  const regions = []
  let i = 1
  while (i < N - 1) {
    if (radii[i] >= targetRadius) { i++; continue }
    let start = i
    let end = i
    while (end < N - 2) {
      let nextTight = -1
      for (let k = end + 1; k <= Math.min(end + 4, N - 2); k++) {
        if (radii[k] < targetRadius) { nextTight = k; break }
      }
      if (nextTight === -1) break
      end = nextTight
    }
    regions.push({ start, end })
    i = end + 1
  }

  if (regions.length === 0) {
    return { lats: [...lats], lons: [...lons], dists: [...dists], tightCount: 0, maxOffset: 0 }
  }

  // Step 3: Apply unified bell profile for each region
  const outLats = [...lats]
  const outLons = [...lons]
  let globalMaxOffset = 0
  let totalTightCount = 0

  for (const region of regions) {
    const { start, end } = region

    // Find apex (min radius) and max deficit
    let minR = Infinity
    for (let k = start; k <= end; k++) {
      if (radii[k] < minR) minR = radii[k]
    }
    const maxPush = (targetRadius - minR) * pushGain
    if (maxPush < 0.01) continue
    if (maxPush > globalMaxOffset) globalMaxOffset = maxPush
    totalTightCount += (end - start + 1)

    // Set anchors 20m before/after the tight region
    const anchorBeforeDist = Math.max(dists[1], dists[start] - anchorDist)
    const anchorAfterDist = Math.min(dists[N - 2], dists[end] + anchorDist)

    // Find anchor indices (linear scan — points are monotonic)
    let anchorBefore = 1
    for (let k = start - 1; k >= 1; k--) {
      if (dists[k] <= anchorBeforeDist) { anchorBefore = k; break }
    }
    let anchorAfter = N - 2
    for (let k = end + 1; k <= N - 2; k++) {
      if (dists[k] >= anchorAfterDist) { anchorAfter = k; break }
    }

    // Apex distance = midpoint of tight region
    const apexDist = (dists[start] + dists[end]) / 2

    // Outward direction via majority vote of cross-product signs
    let crossSum = 0
    for (let k = start; k <= end; k++) {
      const cosLat = Math.cos(lats[k] * DEG2RAD)
      const mPerDegLon = mPerDegLat * cosLat
      const lo = Math.max(1, k - 1)
      const hi = Math.min(N - 2, k + 1)
      const ax = (lons[k] - lons[lo]) * mPerDegLon
      const ay = (lats[k] - lats[lo]) * mPerDegLat
      const bx = (lons[hi] - lons[k]) * mPerDegLon
      const by = (lats[hi] - lats[k]) * mPerDegLat
      crossSum += ax * by - ay * bx
    }
    const outwardSign = crossSum >= 0 ? 1 : -1

    // Push function
    const pushPoint = (k, offset) => {
      if (offset < 0.001) return
      const cosLat = Math.cos(lats[k] * DEG2RAD)
      const mPerDegLon = mPerDegLat * cosLat
      const lo = Math.max(0, k - 2)
      const hi = Math.min(N - 1, k + 2)
      const tx = (lons[hi] - lons[lo]) * mPerDegLon
      const ty = (lats[hi] - lats[lo]) * mPerDegLat
      const tLen = Math.hypot(tx, ty)
      if (tLen < 0.01) return
      const nx = outwardSign * ty / tLen
      const ny = -outwardSign * tx / tLen
      outLats[k] = lats[k] + (ny * offset) / mPerDegLat
      outLons[k] = lons[k] + (nx * offset) / mPerDegLon
    }

    // Apply unified raised-cosine bell from anchorBefore to anchorAfter
    const halfBefore = apexDist - dists[anchorBefore]
    const halfAfter = dists[anchorAfter] - apexDist
    for (let k = anchorBefore; k <= anchorAfter; k++) {
      const d = dists[k]
      let fraction
      if (halfBefore < 0.01 && halfAfter < 0.01) {
        fraction = 1
      } else if (d <= apexDist) {
        fraction = halfBefore > 0.01 ? (d - dists[anchorBefore]) / halfBefore : 1
      } else {
        fraction = halfAfter > 0.01 ? (dists[anchorAfter] - d) / halfAfter : 1
      }
      fraction = Math.max(0, Math.min(1, fraction))
      const push = maxPush * 0.5 * (1 - Math.cos(Math.PI * fraction))
      pushPoint(k, push)
    }
  }

  // Step 4: Recompute distances after nudging
  const outDists = [0]
  for (let k = 1; k < N; k++) {
    outDists.push(outDists[k - 1] + haversine(outLats[k - 1], outLons[k - 1], outLats[k], outLons[k]))
  }

  return { lats: outLats, lons: outLons, dists: outDists, tightCount: totalTightCount, maxOffset: globalMaxOffset }
}

// ────────────────────────────────────────────────────────────────────
// Resample + position smoothing (processGPX replacement)
// ────────────────────────────────────────────────────────────────────

/**
 * Resample a route at uniform distance intervals via linear interpolation.
 *
 * @param {number[]} lats — input latitudes
 * @param {number[]} lons — input longitudes
 * @param {number[]} dists — cumulative distances (metres)
 * @param {number} [spacingM=1] — target spacing in metres
 * @returns {{ lats: number[], lons: number[], dists: number[] }}
 */
export function resampleRoute(lats, lons, dists, spacingM = 1) {
  const N = lats.length
  if (N < 2) return { lats: [...lats], lons: [...lons], dists: [...dists] }

  const totalDist = dists[N - 1]
  const nPts = Math.max(2, Math.round(totalDist / spacingM) + 1)
  const outLats = new Array(nPts)
  const outLons = new Array(nPts)
  const outDists = new Array(nPts)

  let seg = 0
  for (let i = 0; i < nPts; i++) {
    const d = i === nPts - 1 ? totalDist : (i * totalDist) / (nPts - 1)
    outDists[i] = d

    // Advance to the segment containing d
    while (seg < N - 2 && dists[seg + 1] < d) seg++

    const segLen = dists[seg + 1] - dists[seg]
    const t = segLen > 0 ? Math.max(0, Math.min(1, (d - dists[seg]) / segLen)) : 0
    outLats[i] = lats[seg] + t * (lats[seg + 1] - lats[seg])
    outLons[i] = lons[seg] + t * (lons[seg + 1] - lons[seg])
  }

  return { lats: outLats, lons: outLons, dists: outDists }
}

/**
 * cos²-feathered membership weight of a distance `d` within a set of protected
 * ranges (each `{startM,endM}` in route metres). Returns 1 deep inside a range,
 * 0 well outside, and a smooth cosine ramp across a `featherM` band at each edge.
 * Used by smoothPositions to shield junction/node ranges from being smoothed.
 *
 * @param {number} d — query distance (m)
 * @param {Array<{startM?:number,endM?:number,start?:number,end?:number}>} ranges
 * @param {number} [featherM=6] — edge feather width (m)
 * @returns {number} weight in [0,1]
 */
function protectedDistanceWeight(d, ranges, featherM = 6) {
  if (!ranges?.length) return 0
  let weight = 0
  for (const range of ranges) {
    const start = Math.min(range.startM ?? range.start ?? 0, range.endM ?? range.end ?? 0)
    const end = Math.max(range.startM ?? range.start ?? 0, range.endM ?? range.end ?? 0)
    const span = Math.max(0, end - start)
    const feather = Math.max(0.1, Math.min(featherM, span / 3))
    const outerStart = start - feather
    const innerStart = start + feather
    const innerEnd = end - feather
    const outerEnd = end + feather
    let w = 0

    if (d >= innerStart && d <= innerEnd) {
      w = 1
    } else if (d > outerStart && d < innerStart) {
      const t = (d - outerStart) / Math.max(0.001, innerStart - outerStart)
      w = 0.5 - 0.5 * Math.cos(Math.PI * t)
    } else if (d > innerEnd && d < outerEnd) {
      const t = (outerEnd - d) / Math.max(0.001, outerEnd - innerEnd)
      w = 0.5 - 0.5 * Math.cos(Math.PI * t)
    }

    if (w > weight) weight = w
  }
  return weight
}

/**
 * Gaussian smoothing of lat/lon positions.
 * Pins first and last points. Uses distance-weighted kernel.
 *
 * Optionally shields ranges (junctions, snapped nodes) from smoothing via
 * `opts.protectedRangesM`: inside a protected range the original position is
 * kept (blended back through a cos² feather at the edges) so a smoother can run
 * route-wide without dragging precise topology nodes off their coords.
 *
 * @param {number[]} lats — input latitudes
 * @param {number[]} lons — input longitudes
 * @param {number[]} dists — cumulative distances
 * @param {number} [sigma=5] — Gaussian sigma in metres
 * @param {{ protectedRangesM?: Array<{startM:number,endM:number}>, protectionFeatherM?: number }} [opts]
 * @returns {{ lats: number[], lons: number[] }}
 */
export function smoothPositions(lats, lons, dists, sigma = 5, opts = {}) {
  const N = lats.length
  if (N < 3) return { lats: [...lats], lons: [...lons] }

  const outLats = new Array(N)
  const outLons = new Array(N)
  const twoSigma2 = 2 * sigma * sigma
  const protectedRangesM = opts.protectedRangesM || []
  const protectionFeatherM = opts.protectionFeatherM ?? 6

  // Pin endpoints
  outLats[0] = lats[0]; outLons[0] = lons[0]
  outLats[N - 1] = lats[N - 1]; outLons[N - 1] = lons[N - 1]

  for (let i = 1; i < N - 1; i++) {
    let sumLat = 0, sumLon = 0, sumW = 0
    const di = dists[i]

    // Scan backward
    for (let j = i; j >= 0; j--) {
      const dd = di - dists[j]
      if (dd > 3 * sigma) break
      const w = Math.exp(-(dd * dd) / twoSigma2)
      sumLat += w * lats[j]
      sumLon += w * lons[j]
      sumW += w
    }
    // Scan forward (skip center — already counted)
    for (let j = i + 1; j < N; j++) {
      const dd = dists[j] - di
      if (dd > 3 * sigma) break
      const w = Math.exp(-(dd * dd) / twoSigma2)
      sumLat += w * lats[j]
      sumLon += w * lons[j]
      sumW += w
    }

    const smoothedLat = sumW > 0 ? sumLat / sumW : lats[i]
    const smoothedLon = sumW > 0 ? sumLon / sumW : lons[i]
    const protect = protectedDistanceWeight(di, protectedRangesM, protectionFeatherM)
    outLats[i] = smoothedLat + (lats[i] - smoothedLat) * protect
    outLons[i] = smoothedLon + (lons[i] - smoothedLon) * protect
  }

  return { lats: outLats, lons: outLons }
}

// ────────────────────────────────────────────────────────────────────
// Radius-aware corner analysis + widening
// ────────────────────────────────────────────────────────────────────
//
// A controllable, diagnosable alternative/complement to processGPX's opaque
// corner handling. `analyzeRadiusWindows` finds every region tighter than a
// target radius and CLASSIFIES it (hairpin / road-corner / routing-kink) from
// turn geometry; `widenLowRadiusCorners` then fixes each kind appropriately —
// hairpins/road-corners get a bounded outward apex push (cos² taper) toward the
// target radius, while short Valhalla zigzag "routing-kinks" are faired toward
// their chord. Point count is preserved and every move is capped, so the pass
// is safe to run as a post-step on already-good geometry. Pure functions.

/** Last index whose cumulative distance is ≤ target. */
function distIndexAtOrBefore(dists, target) {
  let best = 0
  for (let i = 1; i < dists.length; i++) {
    if (dists[i] > target) break
    best = i
  }
  return best
}

/** First index whose cumulative distance is ≥ target. */
function distIndexAtOrAfter(dists, target) {
  for (let i = 0; i < dists.length; i++) {
    if (dists[i] >= target) return i
  }
  return dists.length - 1
}

/** Bearing (rad) of the segment from index a to index b, local equirectangular. */
function segmentAngle(lats, lons, a, b) {
  if (a === b) return 0
  const refLat = (lats[a] + lats[b]) * 0.5
  const mPerDegLat = R_EARTH * DEG2RAD
  const mPerDegLon = mPerDegLat * Math.cos(refLat * DEG2RAD)
  const dx = (lons[b] - lons[a]) * mPerDegLon
  const dy = (lats[b] - lats[a]) * mPerDegLat
  return Math.atan2(dy, dx)
}

/** Signed angular difference b−a wrapped to (−π, π]. */
function angleDeltaRad(a, b) {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

/**
 * Classify a low-radius window from its turn geometry.
 * @returns {'hairpin'|'road-corner'|'routing-kink'}
 */
function classifyRadiusWindow(metrics, opts) {
  const hairpinTurnDeg = opts.hairpinTurnDeg ?? 135
  const roadCornerTurnDeg = opts.roadCornerTurnDeg ?? 45
  const minRoadCornerCoreM = opts.minRoadCornerCoreM ?? 5
  const minRoadCornerPathM = opts.minRoadCornerPathM ?? 16
  const maxKinkCoreM = opts.maxKinkCoreM ?? 4

  if (metrics.netTurnDeg >= hairpinTurnDeg && metrics.straightness <= 0.82) return 'hairpin'
  if (metrics.coreLengthM <= maxKinkCoreM && metrics.points <= 3) return 'routing-kink'
  if (
    metrics.netTurnDeg >= roadCornerTurnDeg &&
    metrics.coreLengthM >= minRoadCornerCoreM &&
    metrics.pathM >= minRoadCornerPathM
  ) {
    return 'road-corner'
  }
  return 'routing-kink'
}

/** Compact, sorted summary of windows for diagnostics/logging. */
function summarizeRadiusWindows(windows, dists, limit = 5) {
  return [...windows]
    .sort((a, b) => a.minRadiusM - b.minRadiusM)
    .slice(0, limit)
    .map(w => ({
      kind: w.kind,
      distM: dists[w.apexIdx] ?? 0,
      radiusM: w.minRadiusM,
      netTurnDeg: w.netTurnDeg,
      coreLengthM: w.coreLengthM,
      pathM: w.pathM,
      straightness: w.straightness,
    }))
}

/**
 * Find and classify every region of the route tighter than `targetRadiusM`.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]|Float64Array} dists — cumulative distances (m)
 * @param {object} [opts] — targetRadiusM (6.5), mergeGapM (4), contextM (14) + classify thresholds
 * @returns {{ minRadiusM: number, windows: Array<{startIdx,endIdx,apexIdx,minRadiusM,netTurnDeg,totalTurnDeg,coreLengthM,pathM,straightness,points,kind}> }}
 */
export function analyzeRadiusWindows(lats, lons, dists, opts = {}) {
  const targetRadiusM = opts.targetRadiusM ?? 6.5
  const mergeGapM = opts.mergeGapM ?? 4
  const contextM = opts.contextM ?? 14
  const N = lats.length
  if (N < 3) return { minRadiusM: Infinity, windows: [] }

  const distArr = Array.from(dists)
  const radii = new Float64Array(N).fill(Infinity)
  let globalMinRadius = Infinity
  for (let i = 1; i < N - 1; i++) {
    const r = circumscribedRadius3(lats, lons, i)
    radii[i] = r
    if (r < globalMinRadius) globalMinRadius = r
  }

  const regions = []
  let i = 1
  while (i < N - 1) {
    if (!(radii[i] < targetRadiusM)) {
      i++
      continue
    }

    let start = i
    let end = i
    let apex = i
    let minR = radii[i]
    let j = i + 1
    while (j < N - 1) {
      if (radii[j] < targetRadiusM) {
        end = j
        if (radii[j] < minR) {
          minR = radii[j]
          apex = j
        }
        j++
        continue
      }
      if (distArr[j] - distArr[end] <= mergeGapM) {
        j++
        continue
      }
      break
    }

    regions.push({ start, end, apex, minR })
    i = Math.max(j, end + 1)
  }

  const windows = []
  for (const region of regions) {
    const lo = Math.max(0, distIndexAtOrBefore(distArr, distArr[region.start] - contextM))
    const hi = Math.min(N - 1, distIndexAtOrAfter(distArr, distArr[region.end] + contextM))
    if (hi - lo < 2) continue

    const entryAngle = segmentAngle(lats, lons, lo, region.start)
    const exitAngle = segmentAngle(lats, lons, region.end, hi)
    const netTurnDeg = Math.abs(angleDeltaRad(entryAngle, exitAngle)) * 180 / Math.PI

    let totalTurnDeg = 0
    let prevAngle = segmentAngle(lats, lons, lo, lo + 1)
    for (let k = lo + 1; k < hi; k++) {
      const a = segmentAngle(lats, lons, k, k + 1)
      totalTurnDeg += Math.abs(angleDeltaRad(prevAngle, a)) * 180 / Math.PI
      prevAngle = a
    }

    const pathM = Math.max(0, distArr[hi] - distArr[lo])
    const coreLengthM = Math.max(0, distArr[region.end] - distArr[region.start])
    const chordM = haversine(lats[lo], lons[lo], lats[hi], lons[hi])
    const straightness = pathM > 0 ? chordM / pathM : 1
    const metrics = {
      startIdx: region.start,
      endIdx: region.end,
      apexIdx: region.apex,
      minRadiusM: region.minR,
      netTurnDeg,
      totalTurnDeg,
      coreLengthM,
      pathM,
      straightness,
      points: region.end - region.start + 1,
    }
    windows.push({ ...metrics, kind: classifyRadiusWindow(metrics, opts) })
  }

  return { minRadiusM: globalMinRadius, windows }
}

/**
 * Widen corners tighter than `targetRadiusM` by pushing the apex outward (bounded,
 * cos²-tapered) and fairing short routing-kinks toward their chord. Point count is
 * preserved; only interior points within each window's anchor span move. U-turns are
 * NOT looped here — that stays with processGPX's makeLoop / a dedicated teardrop step.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]|Float64Array} dists
 * @param {object} [opts] — targetRadiusM (6.5), anchorDistM (18), pushGain (0.75),
 *   maxHairpinPushM (4), maxRoadCornerPushM (2.5), fairRoutingKinks (true),
 *   maxRoutingKinkMoveM (2.5), routingKinkAnchorDistM (12) + analyzeRadiusWindows opts
 * @returns {{ lats:number[], lons:number[], dists:number[], stats:object }}
 */
export function widenLowRadiusCorners(lats, lons, dists, opts = {}) {
  const targetRadiusM = opts.targetRadiusM ?? 6.5
  const anchorDistM = opts.anchorDistM ?? 18
  const pushGain = opts.pushGain ?? 0.75
  const maxHairpinPushM = opts.maxHairpinPushM ?? 4
  const maxRoadCornerPushM = opts.maxRoadCornerPushM ?? 2.5
  const fairRoutingKinks = opts.fairRoutingKinks ?? true
  const maxRoutingKinkMoveM = opts.maxRoutingKinkMoveM ?? 2.5
  const routingKinkAnchorDistM = opts.routingKinkAnchorDistM ?? 12
  // Which window kinds to widen by pushing the apex outward (default hairpin + road-corner). The native
  // fillet engine restricts this to ['hairpin'] so it widens only switchbacks and inscribe-fillets the
  // rest.
  const correctKinds = opts.correctKinds || ['hairpin', 'road-corner']
  const distArr = Array.from(dists)
  const analysis = analyzeRadiusWindows(lats, lons, dists, { ...opts, targetRadiusM })
  const correctable = analysis.windows.filter(w => correctKinds.includes(w.kind))
  const routingKinks = analysis.windows.filter(w => w.kind === 'routing-kink')
  const skippedWindowDetails = summarizeRadiusWindows(routingKinks, distArr)
  const skippedKinks = routingKinks.length
  const minCorrectableBeforeM = correctable.length
    ? correctable.reduce((min, w) => Math.min(min, w.minRadiusM), Infinity)
    : Infinity
  const N = lats.length

  if ((!correctable.length && (!fairRoutingKinks || !routingKinks.length)) || N < 3) {
    return {
      lats: [...lats],
      lons: [...lons],
      dists: Array.from(dists),
      stats: {
        minRadiusBeforeM: analysis.minRadiusM,
        minRadiusAfterM: analysis.minRadiusM,
        minCorrectableBeforeM,
        minCorrectableAfterM: minCorrectableBeforeM,
        windows: analysis.windows.length,
        correctedHairpins: 0,
        correctedRoadCorners: 0,
        fairedKinks: 0,
        skippedKinks,
        cappedWindows: 0,
        cappedWindowDetails: [],
        remainingActionableWindows: summarizeRadiusWindows(correctable, distArr),
        skippedWindowDetails,
        changedPoints: 0,
        maxOffsetM: 0,
      },
    }
  }

  const outLats = [...lats]
  const outLons = [...lons]
  const changed = new Set()
  let maxOffsetM = 0
  let correctedHairpins = 0
  let correctedRoadCorners = 0
  let cappedWindows = 0
  const cappedWindowDetails = []
  const mPerDegLat = R_EARTH * DEG2RAD
  let fairedKinks = 0

  for (const win of correctable) {
    if (win.kind === 'hairpin') correctedHairpins++
    if (win.kind === 'road-corner') correctedRoadCorners++

    const anchorBefore = Math.max(1, distIndexAtOrBefore(distArr, distArr[win.startIdx] - anchorDistM))
    const anchorAfter = Math.min(N - 2, distIndexAtOrAfter(distArr, distArr[win.endIdx] + anchorDistM))
    if (anchorAfter - anchorBefore < 3) continue

    const rawPush = Math.max(0, targetRadiusM - win.minRadiusM) * pushGain
    const maxPush = Math.min(rawPush, win.kind === 'hairpin' ? maxHairpinPushM : maxRoadCornerPushM)
    if (maxPush + 0.001 < rawPush) {
      cappedWindows++
      cappedWindowDetails.push(summarizeRadiusWindows([win], distArr, 1)[0])
    }
    if (maxPush < 0.05) continue

    let crossSum = 0
    for (let k = win.startIdx; k <= win.endIdx; k++) {
      const cosLat = Math.cos(lats[k] * DEG2RAD)
      const mPerDegLon = mPerDegLat * cosLat
      const lo = Math.max(1, k - 1)
      const hi = Math.min(N - 2, k + 1)
      const ax = (lons[k] - lons[lo]) * mPerDegLon
      const ay = (lats[k] - lats[lo]) * mPerDegLat
      const bx = (lons[hi] - lons[k]) * mPerDegLon
      const by = (lats[hi] - lats[k]) * mPerDegLat
      crossSum += ax * by - ay * bx
    }
    const outwardSign = crossSum >= 0 ? 1 : -1
    const apexDist = distArr[win.apexIdx]
    const halfBefore = Math.max(0.01, apexDist - distArr[anchorBefore])
    const halfAfter = Math.max(0.01, distArr[anchorAfter] - apexDist)

    for (let k = anchorBefore; k <= anchorAfter; k++) {
      const d = distArr[k]
      const f = d <= apexDist
        ? (d - distArr[anchorBefore]) / halfBefore
        : (distArr[anchorAfter] - d) / halfAfter
      const fraction = Math.max(0, Math.min(1, f))
      const offset = maxPush * 0.5 * (1 - Math.cos(Math.PI * fraction))
      if (offset < 0.001) continue

      const cosLat = Math.cos(lats[k] * DEG2RAD)
      const mPerDegLon = mPerDegLat * cosLat
      const lo = Math.max(0, k - 2)
      const hi = Math.min(N - 1, k + 2)
      const tx = (lons[hi] - lons[lo]) * mPerDegLon
      const ty = (lats[hi] - lats[lo]) * mPerDegLat
      const len = Math.hypot(tx, ty)
      if (len < 0.01) continue

      const nx = outwardSign * ty / len
      const ny = -outwardSign * tx / len
      outLats[k] = lats[k] + (ny * offset) / mPerDegLat
      outLons[k] = lons[k] + (nx * offset) / mPerDegLon
      changed.add(k)
      if (offset > maxOffsetM) maxOffsetM = offset
    }
  }

  if (fairRoutingKinks) {
    for (const win of routingKinks) {
      const anchorBefore = Math.max(0, distIndexAtOrBefore(distArr, distArr[win.startIdx] - routingKinkAnchorDistM))
      const anchorAfter = Math.min(N - 1, distIndexAtOrAfter(distArr, distArr[win.endIdx] + routingKinkAnchorDistM))
      if (anchorAfter - anchorBefore < 2) continue

      const baseLat = outLats[anchorBefore]
      const baseLon = outLons[anchorBefore]
      const cosLat = Math.cos(baseLat * DEG2RAD)
      const mPerDegLon = mPerDegLat * cosLat
      const ax = 0
      const ay = 0
      const bx = (outLons[anchorAfter] - baseLon) * mPerDegLon
      const by = (outLats[anchorAfter] - baseLat) * mPerDegLat
      const vx = bx - ax
      const vy = by - ay
      const vLen2 = vx * vx + vy * vy
      if (vLen2 < 0.01) continue

      let movedWindow = false
      const lo = anchorBefore + 1
      const hi = anchorAfter - 1
      const apexDist = distArr[win.apexIdx]
      const halfBefore = Math.max(0.01, apexDist - distArr[anchorBefore])
      const halfAfter = Math.max(0.01, distArr[anchorAfter] - apexDist)
      for (let k = lo; k <= hi; k++) {
        const px = (outLons[k] - baseLon) * mPerDegLon
        const py = (outLats[k] - baseLat) * mPerDegLat
        const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / vLen2))
        const qx = ax + vx * t
        const qy = ay + vy * t
        let dx = qx - px
        let dy = qy - py
        const move = Math.hypot(dx, dy)
        if (move < 0.01) continue
        const d = distArr[k]
        const taper = d <= apexDist
          ? (d - distArr[anchorBefore]) / halfBefore
          : (distArr[anchorAfter] - d) / halfAfter
        const fraction = Math.max(0, Math.min(1, taper))
        const weight = 0.5 - 0.5 * Math.cos(Math.PI * fraction)
        if (weight < 0.001) continue
        const limitedMove = Math.min(move * weight, maxRoutingKinkMoveM * weight)
        const scale = limitedMove / move
        dx *= scale
        dy *= scale

        outLats[k] += dy / mPerDegLat
        outLons[k] += dx / mPerDegLon
        changed.add(k)
        movedWindow = true
        if (limitedMove > maxOffsetM) maxOffsetM = limitedMove
      }
      if (movedWindow) fairedKinks++
    }
  }

  const outDists = [0]
  for (let k = 1; k < N; k++) {
    outDists.push(outDists[k - 1] + haversine(outLats[k - 1], outLons[k - 1], outLats[k], outLons[k]))
  }

  const after = analyzeRadiusWindows(outLats, outLons, outDists, { ...opts, targetRadiusM })
  const correctableAfter = after.windows.filter(w => w.kind === 'hairpin' || w.kind === 'road-corner')
  const skippedAfter = after.windows.filter(w => w.kind === 'routing-kink')
  const minCorrectableAfterM = correctableAfter.length
    ? correctableAfter.reduce((min, w) => Math.min(min, w.minRadiusM), Infinity)
    : Infinity
  return {
    lats: outLats,
    lons: outLons,
    dists: outDists,
    stats: {
      minRadiusBeforeM: analysis.minRadiusM,
      minRadiusAfterM: after.minRadiusM,
      minCorrectableBeforeM,
      minCorrectableAfterM,
      windows: analysis.windows.length,
      correctedHairpins,
      correctedRoadCorners,
      fairedKinks,
      skippedKinks: skippedAfter.length,
      cappedWindows,
      cappedWindowDetails,
      remainingActionableWindows: summarizeRadiusWindows(correctableAfter, outDists),
      skippedWindowDetails: summarizeRadiusWindows(skippedAfter, outDists),
      changedPoints: changed.size,
      maxOffsetM,
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// Triangle-area simplification (GPXmagic algorithm)
// ────────────────────────────────────────────────────────────────────

/**
 * Simplify a route by removing points with smallest 3D triangle area.
 *
 * GPXmagic's algorithm: for each interior point, compute the area of the
 * triangle formed by [prev, point, next] in 3D local Cartesian coordinates.
 * Points forming the smallest triangles are the most redundant. Select
 * smallest 20% as removal candidates, then apply an adjacency filter that
 * prevents removing two consecutive points.
 *
 * Points on tight curves (circumscribed radius < minRadiusM) are protected
 * from removal to prevent chord-cutting at hairpins and sharp turns.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} eles — elevations in metres
 * @param {number[]|Float64Array} dists — cumulative distances in metres
 * @param {{ minRadiusM?: number }} [opts] — minRadiusM: protect points on curves tighter than this (default 20m)
 * @returns {{ lats: number[], lons: number[], eles: number[], dists: number[],
 *             gr: number[], removedCount: number }}
 */
export function simplifyByArea(lats, lons, eles, dists, opts = {}) {
  const minRadiusM = opts.minRadiusM ?? 20
  const N = lats.length
  if (N < 4) {
    const gr = new Array(Math.max(0, N - 1))
    for (let i = 0; i < gr.length; i++) {
      const dd = dists[i + 1] - dists[i]
      gr[i] = dd > 0 ? ((eles[i + 1] - eles[i]) / dd) * 100 : 0
    }
    return { lats: [...lats], lons: [...lons], eles: [...eles], dists: [...dists], gr, removedCount: 0 }
  }

  // 1. Compute 3D triangle area for each interior point
  const areas = [] // { idx, area }
  const cosLat = Math.cos(lats[Math.floor(N / 2)] * DEG2RAD)
  const mPerDegLat = R_EARTH * DEG2RAD
  const mPerDegLon = R_EARTH * DEG2RAD * cosLat

  for (let i = 1; i < N - 1; i++) {
    // Convert to local 3D metres
    const ax = lons[i - 1] * mPerDegLon, ay = lats[i - 1] * mPerDegLat, az = eles[i - 1]
    const bx = lons[i] * mPerDegLon, by = lats[i] * mPerDegLat, bz = eles[i]
    const cx = lons[i + 1] * mPerDegLon, cy = lats[i + 1] * mPerDegLat, cz = eles[i + 1]

    // Triangle area = 0.5 * |cross(B-A, C-A)|
    const abx = bx - ax, aby = by - ay, abz = bz - az
    const acx = cx - ax, acy = cy - ay, acz = cz - az
    const crossX = aby * acz - abz * acy
    const crossY = abz * acx - abx * acz
    const crossZ = abx * acy - aby * acx
    const area = 0.5 * Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ)

    areas.push({ idx: i, area })
  }

  // 2. Protect points on tight curves from removal
  const protectedSet = new Set()
  for (let i = 1; i < N - 1; i++) {
    const r = circumscribedRadius3(lats, lons, i)
    if (r < minRadiusM) protectedSet.add(i)
  }

  // 3. Sort by area ascending, select smallest 20%
  areas.sort((a, b) => a.area - b.area)
  const candidateCount = Math.floor(areas.length / 5)

  // 4. Adjacency filter + curvature guard — never remove consecutive or protected points
  const removeSet = new Set()
  for (let i = 0; i < candidateCount; i++) {
    const idx = areas[i].idx
    if (protectedSet.has(idx)) continue
    if (!removeSet.has(idx - 1) && !removeSet.has(idx + 1)) {
      removeSet.add(idx)
    }
  }

  // 5. Build output arrays excluding removed points
  const outLats = [], outLons = [], outEles = [], outDists = [0]
  const extraOut = (opts.extraArrays || []).map(() => [])
  const extraIn = opts.extraArrays || []
  for (let i = 0; i < N; i++) {
    if (removeSet.has(i)) continue
    outLats.push(lats[i])
    outLons.push(lons[i])
    outEles.push(eles[i])
    for (let e = 0; e < extraIn.length; e++) extraOut[e].push(extraIn[e][i])
    if (outLats.length > 1) {
      const j = outLats.length - 1
      outDists.push(outDists[j - 1] + haversine(outLats[j - 1], outLons[j - 1], outLats[j], outLons[j]))
    }
  }

  // 6. Compute gradients
  const M = outEles.length
  const gr = new Array(Math.max(0, M - 1))
  for (let i = 0; i < M - 1; i++) {
    const dd = outDists[i + 1] - outDists[i]
    gr[i] = dd > 0 ? ((outEles[i + 1] - outEles[i]) / dd) * 100 : 0
  }

  return { lats: outLats, lons: outLons, eles: outEles, dists: outDists, gr, removedCount: removeSet.size, extraArrays: extraOut }
}

// ────────────────────────────────────────────────────────────────────
// Canvas pixel helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Point-to-segment distance in canvas pixels (for hit testing).
 * @param {number} px — point x
 * @param {number} py — point y
 * @param {number} ax — segment start x
 * @param {number} ay — segment start y
 * @param {number} bx — segment end x
 * @param {number} by — segment end y
 * @returns {number} distance in pixels
 */
export function pxPointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// ────────────────────────────────────────────────────────────────────
// Route overlap detection
// ────────────────────────────────────────────────────────────────────

/**
 * Detect overlapping start/end segments in a route.
 *
 * Walks backward from the last point checking if each tail point is
 * within `thresholdM` metres of any point in the route head (first 20%,
 * capped at 200 points). Consecutive tail points that all match form the
 * overlap region.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} [thresholdM=10] — distance threshold in metres
 * @returns {{ overlapStartIdx: number, overlapCount: number } | null}
 */
export function detectStartEndOverlap(lats, lons, thresholdM = 10) {
  const N = lats.length
  if (N < 20) return null

  const headEnd = Math.min(Math.floor(N * 0.2), 200)
  let overlapStart = N

  for (let i = N - 1; i > headEnd; i--) {
    let minDist = Infinity
    for (let j = 0; j < headEnd; j++) {
      const d = haversine(lats[i], lons[i], lats[j], lons[j])
      if (d < minDist) minDist = d
      if (d <= thresholdM) break // early exit — this point matches
    }
    if (minDist <= thresholdM) {
      overlapStart = i
    } else {
      break
    }
  }

  if (overlapStart >= N) return null
  const overlapCount = N - overlapStart
  if (overlapCount < 3) return null

  return { overlapStartIdx: overlapStart, overlapCount }
}
