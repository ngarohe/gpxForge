/**
 * Geometry utilities — point-to-segment, projection, nearest-point, fillets.
 *
 * All geographic functions work in lat/lon degrees.
 * Canvas-pixel functions are prefixed with `px`.
 */

import { haversine } from './math.js'

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
    radiusM = 6,
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
 * Gaussian smoothing of lat/lon positions.
 * Pins first and last points. Uses distance-weighted kernel.
 *
 * @param {number[]} lats — input latitudes
 * @param {number[]} lons — input longitudes
 * @param {number[]} dists — cumulative distances
 * @param {number} [sigma=5] — Gaussian sigma in metres
 * @returns {{ lats: number[], lons: number[] }}
 */
export function smoothPositions(lats, lons, dists, sigma = 5) {
  const N = lats.length
  if (N < 3) return { lats: [...lats], lons: [...lons] }

  const outLats = new Array(N)
  const outLons = new Array(N)
  const twoSigma2 = 2 * sigma * sigma

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

    outLats[i] = sumW > 0 ? sumLat / sumW : lats[i]
    outLons[i] = sumW > 0 ? sumLon / sumW : lons[i]
  }

  return { lats: outLats, lons: outLons }
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
