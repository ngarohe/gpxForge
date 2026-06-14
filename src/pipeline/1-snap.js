/**
 * Step 1: Road Snap — Valhalla routing with adaptive waypoint placement.
 *
 * Manual mode: click waypoints along reference track, routes each segment.
 * Auto-snap: adaptive spacing with curvature detection, batch Valhalla routing.
 *
 * After finalizing, elevations are transferred from the original route via
 * distance-based interpolation.
 */

import { haversine, bearing, cumulativeDistances, grads } from '../utils/math.js'
import { valhallaSegment, valhallaBatchRoute } from '../api/valhalla.js'
import { snapOverlaps, detectOverlaps } from './1.5-overlap.js'

// ────────────────────────────────────────────────────────────────────
// Forward-only nearest point
// ────────────────────────────────────────────────────────────────────

/**
 * Find the nearest GPX point index that is strictly at or after minIdx.
 * Limited search window prevents wrapping on out-and-back routes.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} minIdx — minimum index (inclusive)
 * @returns {number} — index of nearest point
 */
export function nearestGpxIndexForward(lat, lon, lats, lons, minIdx) {
  const N = lats.length
  const maxSearch = Math.max(200, Math.floor(N * 0.3))
  const endIdx = Math.min(N, minIdx + maxSearch)

  let bestIdx = minIdx
  let bestDist = Infinity

  for (let i = minIdx; i < endIdx; i++) {
    const d = haversine(lat, lon, lats[i], lons[i])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

// ────────────────────────────────────────────────────────────────────
// Curvature scoring
// ────────────────────────────────────────────────────────────────────

/**
 * Compute per-point curvature score [0, 1] based on turning angles
 * in a ~100 m window around each point.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]|Float64Array} dists — cumulative distances
 * @returns {number[]} — curvature scores (0 = straight, 1 = very twisty)
 */
export function computeCurvature(lats, lons, dists) {
  const N = lats.length
  const curv = new Array(N).fill(0)
  const WINDOW = 100 // metres

  for (let i = 1; i < N - 1; i++) {
    let sumAngle = 0
    let cnt = 0

    // Walk forward from i within WINDOW
    for (let k = i; k < N - 1; k++) {
      if (dists[k] - dists[i] > WINDOW) break
      const b1 = bearing(lats[k], lons[k], lats[k + 1], lons[k + 1])
      if (k > i) {
        const b0 = bearing(lats[k - 1], lons[k - 1], lats[k], lons[k])
        let diff = Math.abs(b1 - b0)
        if (diff > 180) diff = 360 - diff
        sumAngle += diff * (Math.PI / 180)
        cnt++
      }
    }

    // Walk backward from i within WINDOW
    for (let k = i; k > 0; k--) {
      if (dists[i] - dists[k] > WINDOW) break
      const b1 = bearing(lats[k - 1], lons[k - 1], lats[k], lons[k])
      if (k < i) {
        const b0 = bearing(lats[k], lons[k], lats[k + 1], lons[k + 1])
        let diff = Math.abs(b1 - b0)
        if (diff > 180) diff = 360 - diff
        sumAngle += diff * (Math.PI / 180)
        cnt++
      }
    }

    curv[i] = cnt > 0 ? Math.min(sumAngle / cnt / (Math.PI / 4), 1.0) : 0
  }

  return curv
}

// ────────────────────────────────────────────────────────────────────
// Head-unit noise detection
// ────────────────────────────────────────────────────────────────────

/**
 * Heuristic detector for noisy head-unit GPS tracks — the kind where snapping
 * *faithfully* to the track is wrong because the track itself is wrong (GPS
 * scatter, stop-sign jitter, missed-turn doublebacks). Such tracks are better
 * served by sparse uniform anchors that let Valhalla clean them up.
 *
 * Two signals, both scale-aware so real road shape doesn't trip them:
 *   - reversalRate: fraction of SHORT (<shortSegM) consecutive segment pairs
 *     that double back >90°. Real roads (even hairpins, which turn over tens of
 *     metres) rarely reverse between two <12 m steps; GPS jitter does it often.
 *     A clean dense (1 m) track is straight/smooth at that scale → ~0.
 *   - stopFrac: fraction of `stopWin`-point windows that advance < `stopNetM`
 *     net — i.e. many points piling up while barely moving (a stop, where head
 *     units scatter jittery points). A clean track always makes net progress,
 *     so this stays ~0 regardless of logging density.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]|Float64Array} dists — cumulative distances
 * @param {{ shortSegM?: number, stopWin?: number, stopNetM?: number, noisyThresh?: number }} [opts]
 * @returns {{ score: number, isNoisy: boolean, reversalRate: number, stopFrac: number }}
 */
export function detectHeadUnitNoise(lats, lons, dists, opts = {}) {
  const N = lats.length
  if (N < 20) return { score: 0, isNoisy: false, reversalRate: 0, stopFrac: 0 }

  const shortSegM = opts.shortSegM ?? 12
  const stopWin = opts.stopWin ?? 10
  const stopNetM = opts.stopNetM ?? 3
  const noisyThresh = opts.noisyThresh ?? 0.06

  // Short-scale direction reversals (jitter, not real turns).
  let reversals = 0, reversalDen = 0
  for (let i = 1; i < N - 1; i++) {
    const d1 = dists[i] - dists[i - 1]
    const d2 = dists[i + 1] - dists[i]
    if (d1 > 0 && d2 > 0 && d1 < shortSegM && d2 < shortSegM) {
      const b1 = bearing(lats[i - 1], lons[i - 1], lats[i], lons[i])
      const b2 = bearing(lats[i], lons[i], lats[i + 1], lons[i + 1])
      let diff = Math.abs(b1 - b2)
      if (diff > 180) diff = 360 - diff
      reversalDen++
      if (diff > 90) reversals++
    }
  }
  const reversalRate = reversalDen > 0 ? reversals / reversalDen : 0

  // Stops: windows that barely advance despite spanning stopWin points.
  let stopWindows = 0, stopDen = 0
  const mPerDegLat = 111320
  for (let i = 0; i + stopWin < N; i++) {
    stopDen++
    const mPerDegLon = mPerDegLat * Math.cos(lats[i] * Math.PI / 180)
    const net = Math.hypot(
      (lats[i + stopWin] - lats[i]) * mPerDegLat,
      (lons[i + stopWin] - lons[i]) * mPerDegLon,
    )
    if (net < stopNetM) stopWindows++
  }
  const stopFrac = stopDen > 0 ? stopWindows / stopDen : 0

  const score = reversalRate + 0.5 * stopFrac
  return { score, isNoisy: score >= noisyThresh, reversalRate, stopFrac }
}

// ────────────────────────────────────────────────────────────────────
// Auto-snap waypoint placement
// ────────────────────────────────────────────────────────────────────

/**
 * Build adaptive waypoint indices based on curvature scoring.
 * Straight sections get wider spacing, twisty sections get denser.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]|Float64Array} dists — cumulative distances
 * @param {number} baseSpacing — base spacing in metres (e.g., 750)
 * @param {number[]} [forcedIndices=[]] — indices that must appear as waypoints
 * @param {boolean} [uniform=false] — when true, ignore curvature and space
 *   waypoints uniformly at baseSpacing. Used by head-unit cleanup mode, where
 *   sparse uniform anchors let Valhalla route the road centreline and smooth
 *   over GPS jitter (Valhalla still follows the actual road shape between them).
 * @returns {number[]} — indices into the route arrays
 */
export function buildAutoSnapIndices(lats, lons, dists, baseSpacing, forcedIndices = [], uniform = false) {
  const N = lats.length
  if (N < 2) return [0]

  const curv = uniform ? null : computeCurvature(lats, lons, dists)
  const indices = [0]

  // Sort forced indices (trim joins) and prepare for insertion
  const forced = [...new Set(forcedIndices)].filter(i => i > 0 && i < N - 1).sort((a, b) => a - b)
  let fi = 0 // pointer into forced array

  let pos = 0 // current distance along route

  while (true) {
    const lastIdx = indices[indices.length - 1]

    // Check if a forced index should come next (before the next natural waypoint)
    if (fi < forced.length && forced[fi] <= lastIdx) {
      fi++ // already past this forced index
      continue
    }

    const score = uniform ? 0 : curv[lastIdx]
    const localSpacing = baseSpacing * (1 - 0.65 * score)
    const nextPos = pos + localSpacing

    // If a forced index falls before the next natural waypoint, insert it first
    if (fi < forced.length && dists[forced[fi]] < nextPos) {
      indices.push(forced[fi])
      pos = dists[forced[fi]]
      fi++
      continue
    }

    // Find GPX point nearest to nextPos
    let bestIdx = -1
    let bestDiff = Infinity
    for (let i = lastIdx + 1; i < N; i++) {
      const diff = Math.abs(dists[i] - nextPos)
      if (diff < bestDiff) {
        bestDiff = diff
        bestIdx = i
      }
      // Past the target — stop searching
      if (dists[i] > nextPos + localSpacing * 0.5) break
    }

    if (bestIdx < 0 || bestIdx >= N - 1) break
    indices.push(bestIdx)
    pos = dists[bestIdx]
  }

  // Always include last point
  if (indices[indices.length - 1] !== N - 1) {
    indices.push(N - 1)
  }

  return indices
}

function nearestIndexAtDistance(dists, target) {
  const N = dists.length
  if (N === 0) return 0
  if (target <= dists[0]) return 0
  if (target >= dists[N - 1]) return N - 1
  let lo = 0
  let hi = N - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (dists[mid] < target) lo = mid
    else hi = mid
  }
  return Math.abs(dists[lo] - target) <= Math.abs(dists[hi] - target) ? lo : hi
}

/**
 * Add route-lock anchors around places where the source track passes near
 * itself. Sparse 750m routing can choose the wrong city street between anchors;
 * these anchors keep risky overlap/crossing zones locally constrained without
 * forcing the whole route to 50m spacing.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]|Float64Array} dists
 * @param {{ thresholdM?: number, minRouteGapM?: number, anchorEveryM?: number, padM?: number, maxAnchors?: number }} [opts]
 * @returns {number[]} additional waypoint indices
 */
export function buildSelfNearSnapIndices(lats, lons, dists, opts = {}) {
  const N = lats.length
  if (N < 3 || !dists || dists.length !== N) return []

  const thresholdM = opts.thresholdM ?? 18
  const minRouteGapM = opts.minRouteGapM ?? 120
  const anchorEveryM = opts.anchorEveryM ?? 50
  const padM = opts.padM ?? 35
  const maxAnchors = opts.maxAnchors ?? 600
  const total = dists[N - 1] || 0
  const avgSpacing = total > 0 && N > 1 ? total / (N - 1) : 1
  const minGapPts = Math.max(10, Math.round(minRouteGapM / Math.max(avgSpacing, 0.1)))

  const pairs = detectOverlaps(lats, lons, thresholdM, minGapPts)
  if (pairs.length === 0) return []

  const marks = new Set()
  for (const p of pairs) {
    if (Math.abs(dists[p.secondIdx] - dists[p.firstIdx]) < minRouteGapM) continue
    marks.add(p.firstIdx)
    marks.add(p.secondIdx)
  }
  if (marks.size === 0) return []

  const sorted = [...marks].sort((a, b) => a - b)
  const clusters = []
  let curStart = sorted[0]
  let curEnd = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const idx = sorted[i]
    if (dists[idx] - dists[curEnd] <= Math.max(anchorEveryM, thresholdM * 2)) {
      curEnd = idx
    } else {
      clusters.push([curStart, curEnd])
      curStart = idx
      curEnd = idx
    }
  }
  clusters.push([curStart, curEnd])

  const anchors = new Set()
  for (const [startIdx, endIdx] of clusters) {
    const startD = Math.max(0, dists[startIdx] - padM)
    const endD = Math.min(total, dists[endIdx] + padM)
    for (let d = startD; d <= endD + 0.1; d += anchorEveryM) {
      anchors.add(nearestIndexAtDistance(dists, d))
    }
    anchors.add(nearestIndexAtDistance(dists, endD))
  }

  return [...anchors]
    .filter(i => i > 0 && i < N - 1)
    .sort((a, b) => a - b)
    .slice(0, maxAnchors)
}

// ────────────────────────────────────────────────────────────────────
// Segment merging
// ────────────────────────────────────────────────────────────────────

/**
 * Merge Valhalla segments into a single coordinate array.
 * Skips the first point of each segment (except the first) to avoid
 * junction duplication.
 *
 * @param {Array<[number, number][]>} segments — array of [[lat,lon], ...] per segment
 * @returns {{ lats: number[], lons: number[] }}
 */
export function mergeSegments(segments) {
  const lats = []
  const lons = []
  const wpIndices = [0] // first waypoint is at index 0

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]
    const start = s === 0 ? 0 : 1 // skip first point (duplicate junction)
    for (let i = start; i < seg.length; i++) {
      lats.push(seg[i][0])
      lons.push(seg[i][1])
    }
    // Each segment end = a waypoint junction in the merged array
    wpIndices.push(lats.length - 1)
  }

  return { lats, lons, wpIndices }
}

/**
 * Smooth the geometry at splice boundaries where a replacement segment
 * was inserted into an existing route.
 * Blends lat/lon over blendM metres on each side of each junction using a
 * cosine taper toward the straight line between anchor points.
 *
 * Mutates lats/lons in place.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} junctions — indices where splice boundaries occur
 * @param {number} [blendM=30] — blend radius in metres on each side
 */
export function blendSpliceJunctions(lats, lons, junctions, blendM = 30) {
  const N = lats.length
  for (const jIdx of junctions) {
    if (jIdx <= 0 || jIdx >= N - 1) continue

    // Find anchor: blendM before junction
    let loIdx = jIdx
    for (let i = jIdx - 1; i >= 0; i--) {
      loIdx = i
      if (haversine(lats[i], lons[i], lats[jIdx], lons[jIdx]) >= blendM) break
    }

    // Find anchor: blendM after junction
    let hiIdx = jIdx
    for (let i = jIdx + 1; i < N; i++) {
      hiIdx = i
      if (haversine(lats[i], lons[i], lats[jIdx], lons[jIdx]) >= blendM) break
    }

    if (jIdx - loIdx < 2 || hiIdx - jIdx < 2) continue

    // Anchor positions (stay fixed)
    const lat0 = lats[loIdx], lon0 = lons[loIdx]
    const lat1 = lats[hiIdx], lon1 = lons[hiIdx]

    // Cumulative distances within the blend window
    const winDists = [0]
    for (let i = loIdx + 1; i <= hiIdx; i++) {
      winDists.push(winDists[winDists.length - 1] + haversine(lats[i - 1], lons[i - 1], lats[i], lons[i]))
    }
    const totalDist = winDists[winDists.length - 1]
    if (totalDist < 1) continue

    // Cosine-weighted blend toward the straight line between anchors
    for (let i = loIdx + 1; i < hiIdx; i++) {
      const k = i - loIdx
      const t = winDists[k] / totalDist

      const linearLat = lat0 + (lat1 - lat0) * t
      const linearLon = lon0 + (lon1 - lon0) * t

      // Blend weight: 0 at anchors, peaks at junction center
      const w = (1 - Math.cos(Math.PI * Math.min(t, 1 - t) * 2)) / 2

      lats[i] = lats[i] + (linearLat - lats[i]) * w
      lons[i] = lons[i] + (linearLon - lons[i]) * w
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Elevation transfer
// ────────────────────────────────────────────────────────────────────

/**
 * Transfer elevations from the original route to a new (snapped) route
 * using proportional distance mapping.
 *
 * When `anchors` are provided (waypoint indices on both routes), mapping
 * is done per-segment between anchors — drift is bounded to one segment
 * (~250m) instead of accumulating over the full route length.
 *
 * Without anchors, falls back to whole-route proportional mapping.
 *
 * IMPORTANT: For accurate results, densify the new route BEFORE calling
 * this function. Densifying after transfer creates linearly interpolated
 * elevations between sparse Valhalla points, destroying elevation detail.
 *
 * @param {number[]} origLats
 * @param {number[]} origLons
 * @param {number[]} origEles
 * @param {number[]|Float64Array} origDists — cumulative distances for original
 * @param {number[]} newLats
 * @param {number[]} newLons
 * @param {{ origIndices?: number[], newIndices?: number[] }} [anchors] — waypoint anchors on both routes
 * @returns {number[]} — interpolated elevations for the new route
 */
export function transferElevations(origLats, origLons, origEles, origDists, newLats, newLons, anchors) {
  const N = origLats.length
  const M = newLats.length
  if (M === 0) return []
  if (N === 0) return new Array(M).fill(0)

  // Build cumulative distances for new route
  const nDists = [0]
  for (let i = 1; i < M; i++) {
    nDists.push(nDists[i - 1] + haversine(newLats[i - 1], newLons[i - 1], newLats[i], newLons[i]))
  }

  const out = new Array(M)

  // Without anchors, fall back to whole-route proportional
  if (!anchors || !anchors.origIndices || !anchors.newIndices
      || anchors.origIndices.length < 2 || anchors.newIndices.length < 2) {
    const oTotal = origDists[N - 1] || 1
    const nTotal = nDists[M - 1] || 1
    let j = 0
    for (let i = 0; i < M; i++) {
      const s = (nDists[i] / nTotal) * oTotal
      while (j < N - 2 && origDists[j + 1] < s) j++
      const span = origDists[j + 1] - origDists[j]
      if (span > 0) {
        const t = (s - origDists[j]) / span
        out[i] = origEles[j] + t * (origEles[j + 1] - origEles[j])
      } else {
        out[i] = origEles[j]
      }
    }
    return out
  }

  // Per-segment proportional mapping between waypoint anchors
  const { origIndices, newIndices } = anchors
  const numAnchors = Math.min(origIndices.length, newIndices.length)

  for (let a = 0; a < numAnchors - 1; a++) {
    const oStart = origIndices[a]
    const oEnd = origIndices[a + 1]
    const nStart = newIndices[a]
    const nEnd = newIndices[a + 1]

    const oSegStart = origDists[oStart]
    const oSegLen = origDists[oEnd] - oSegStart || 1
    const nSegStart = nDists[nStart]
    const nSegLen = nDists[nEnd] - nSegStart || 1

    let j = oStart
    for (let i = nStart; i <= nEnd; i++) {
      const frac = (nDists[i] - nSegStart) / nSegLen
      const s = oSegStart + frac * oSegLen

      while (j < oEnd - 1 && origDists[j + 1] < s) j++

      const span = origDists[j + 1] - origDists[j]
      if (span > 0) {
        const t = (s - origDists[j]) / span
        out[i] = origEles[j] + t * (origEles[j + 1] - origEles[j])
      } else {
        out[i] = origEles[j]
      }
    }
  }

  return out
}

// ────────────────────────────────────────────────────────────────────
// Post-snap deviation detection ("suspects")
// ────────────────────────────────────────────────────────────────────

/**
 * Perpendicular distance (m) from a point to the polyline segment lo..hi,
 * using a local equirectangular projection centred on the query point.
 * Cheap and accurate enough at the scales involved (<1 km segments).
 */
function pointToPolylineDist(plat, plon, lats, lons, lo, hi) {
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos(plat * Math.PI / 180)
  const px = 0, py = 0 // query point is the origin
  let best = Infinity
  for (let i = lo; i < hi; i++) {
    const ax = (lons[i] - plon) * mPerDegLon
    const ay = (lats[i] - plat) * mPerDegLat
    const bx = (lons[i + 1] - plon) * mPerDegLon
    const by = (lats[i + 1] - plat) * mPerDegLat
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
    if (t < 0) t = 0
    else if (t > 1) t = 1
    const cx = ax + t * dx, cy = ay + t * dy
    const d = Math.hypot(px - cx, py - cy)
    if (d < best) best = d
  }
  return best
}

/** Median of a numeric array (non-mutating). */
function median(arr) {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Detect snapped-route segments that drifted onto a different road.
 *
 * For each snapped point we measure perpendicular distance to the ORIGINAL
 * track within its anchor segment (the original path between the two
 * waypoints that bracket the point). A roughly-constant offset (road
 * centring vs. off-road GPS) is fine; the failure we hunt is a deviation
 * "bubble" — distance spikes well above the baseline offset and returns —
 * which means the router took a parallel street and merged back.
 *
 * The threshold is `max(absMinM, baseline + excessM)` where baseline is the
 * median deviation, so a uniformly-offset route is not flagged regardless of
 * how large the constant offset is.
 *
 * @param {number[]} origLats
 * @param {number[]} origLons
 * @param {number[]|Float64Array} origDists — original cumulative distances
 * @param {number[]} snapLats — final (densified, committed) snapped route
 * @param {number[]} snapLons
 * @param {number[]} origAnchors — waypoint indices into the ORIGINAL route
 * @param {number[]} snapAnchors — matching waypoint indices into the SNAPPED route
 * @param {{ absMinM?: number, excessM?: number, gapM?: number, minLenM?: number, maxSuspects?: number }} [opts]
 * @returns {Array<{ alo: number, ahi: number, maxDev: number, peakIdx: number, lengthM: number }>}
 *   spans use SNAPPED-route indices (alo/ahi) so they feed zoomToSpan directly.
 */
export function detectSnapDeviations(origLats, origLons, origDists, snapLats, snapLons, origAnchors, snapAnchors, opts = {}) {
  const M = snapLats.length
  if (M < 3 || !origAnchors || !snapAnchors || origAnchors.length < 2) return []
  const numAnchors = Math.min(origAnchors.length, snapAnchors.length)

  const absMinM = opts.absMinM ?? 22
  const excessM = opts.excessM ?? 15
  const gapM = opts.gapM ?? 40
  const minLenM = opts.minLenM ?? 12
  const maxSuspects = opts.maxSuspects ?? 40

  // Snapped cumulative distances (for run-length / gap measured in metres)
  const sDists = new Float64Array(M)
  for (let i = 1; i < M; i++) {
    sDists[i] = sDists[i - 1] + haversine(snapLats[i - 1], snapLons[i - 1], snapLats[i], snapLons[i])
  }

  // Per-snapped-point deviation from the original sub-path of its anchor segment.
  const dev = new Float64Array(M).fill(0)
  for (let a = 0; a < numAnchors - 1; a++) {
    const oLo = origAnchors[a], oHi = origAnchors[a + 1]
    const nLo = snapAnchors[a], nHi = snapAnchors[a + 1]
    if (oHi <= oLo || nHi <= nLo) continue
    for (let i = nLo; i <= nHi && i < M; i++) {
      dev[i] = pointToPolylineDist(snapLats[i], snapLons[i], origLats, origLons, oLo, oHi)
    }
  }

  const baseline = median(Array.from(dev))
  const threshold = Math.max(absMinM, baseline + excessM)

  // Group contiguous over-threshold runs; merge runs separated by < gapM.
  const suspects = []
  let runLo = -1, runMax = 0, runPeak = -1
  const flush = (endIdx) => {
    if (runLo < 0) return
    const lenM = sDists[endIdx] - sDists[runLo]
    if (lenM >= minLenM) {
      suspects.push({ alo: runLo, ahi: endIdx, maxDev: runMax, peakIdx: runPeak, lengthM: lenM, atM: sDists[runLo] })
    }
    runLo = -1; runMax = 0; runPeak = -1
  }
  let lastOver = -1
  for (let i = 0; i < M; i++) {
    if (dev[i] > threshold) {
      if (runLo < 0) runLo = i
      else if (lastOver >= 0 && sDists[i] - sDists[lastOver] > gapM) {
        flush(lastOver)
        runLo = i
      }
      if (dev[i] > runMax) { runMax = dev[i]; runPeak = i }
      lastOver = i
    }
  }
  if (lastOver >= 0) flush(lastOver)

  return suspects
    .sort((a, b) => b.maxDev - a.maxDev)
    .slice(0, maxSuspects)
}

/**
 * Anchor-segment indices `a` whose merged-route span [newIndices[a],
 * newIndices[a+1]] intersects the suspect span [alo, ahi].
 * @returns {number[]}
 */
export function anchorSegmentsForSpan(alo, ahi, newIndices) {
  const segs = []
  for (let a = 0; a < newIndices.length - 1; a++) {
    if (newIndices[a + 1] >= alo && newIndices[a] <= ahi) segs.push(a)
  }
  return segs
}

/**
 * For each flagged suspect, densify the ORIGINAL track inside the anchor
 * segment(s) it overlaps, sampling at `spacingM`. These original indices,
 * added to the waypoint set and re-routed, pin Valhalla back onto the actual
 * ridden road where it drifted onto a parallel street.
 *
 * @param {Array<{ alo: number, ahi: number }>} suspects — spans in MERGED indices
 * @param {number[]} origIndices — current waypoint indices into the ORIGINAL route
 * @param {number[]} newIndices — matching waypoint indices into the MERGED route
 * @param {number[]|Float64Array} origDists — original cumulative distances
 * @param {number} spacingM — sample spacing along the original track
 * @returns {number[]} new original indices to add to the waypoint set
 */
export function collectRefinementIndices(suspects, origIndices, newIndices, origDists, spacingM) {
  const add = new Set()
  const segsToRefine = new Set()
  for (const s of suspects) {
    for (const a of anchorSegmentsForSpan(s.alo, s.ahi, newIndices)) segsToRefine.add(a)
  }
  for (const a of segsToRefine) {
    const oStart = origIndices[a]
    const oEnd = origIndices[a + 1]
    if (oEnd - oStart < 2) continue // already as dense as the source track
    const dStart = origDists[oStart]
    const dEnd = origDists[oEnd]
    for (let d = dStart + spacingM; d < dEnd - spacingM * 0.5; d += spacingM) {
      const idx = nearestIndexAtDistance(origDists, d)
      if (idx > oStart && idx < oEnd) add.add(idx)
    }
  }
  return [...add].sort((a, b) => a - b)
}

/**
 * Sample new ORIGINAL-track indices to insert inside one anchor leg, at ~spacingM.
 * Returns [] when the leg is shorter than the spacing (nothing to add).
 */
function sampleLegInterior(oStart, oEnd, origDists, spacingM) {
  if (oEnd - oStart < 2) return []
  const interior = []
  const dStart = origDists[oStart]
  const dEnd = origDists[oEnd]
  for (let d = dStart + spacingM; d < dEnd - spacingM * 0.5; d += spacingM) {
    const idx = nearestIndexAtDistance(origDists, d)
    if (idx > oStart && idx < oEnd && (interior.length === 0 || idx > interior[interior.length - 1])) {
      interior.push(idx)
    }
  }
  return interior
}

/**
 * Like collectRefinementIndices, but grouped per anchor leg so each flagged
 * leg can be re-routed and spliced individually (cheap) instead of re-routing
 * the whole route.
 *
 * @param {boolean} [includeEmpty=false] — also return flagged legs that are
 *   already too dense to subdivide (interior: []). Used so the adaptive-profile
 *   pass can still try alternate profiles on those legs (the deviation there is
 *   a routing/profile problem, not a density one) — e.g. a bike-only path inside
 *   a self-near zone that got flooded with 50 m anchors.
 * @returns {Array<{ a: number, interior: number[] }>} sorted ascending by leg.
 */
export function collectRefinementByLeg(suspects, origIndices, newIndices, origDists, spacingM, includeEmpty = false) {
  const legs = new Set()
  for (const s of suspects) {
    for (const a of anchorSegmentsForSpan(s.alo, s.ahi, newIndices)) legs.add(a)
  }
  const out = []
  for (const a of [...legs].sort((x, y) => x - y)) {
    const interior = sampleLegInterior(origIndices[a], origIndices[a + 1], origDists, spacingM)
    if (interior.length > 0 || includeEmpty) out.push({ a, interior })
  }
  return out
}

/**
 * Max perpendicular distance (m) of a candidate leg's points to the original
 * track sub-polyline [oLo, oHi]. Used to score how well a routed leg follows
 * the recorded track — the arbiter for adaptive-profile fallback.
 */
function legMaxDeviation(cLats, cLons, oLats, oLons, oLo, oHi) {
  let mx = 0
  for (let i = 0; i < cLats.length; i++) {
    const d = pointToPolylineDist(cLats[i], cLons[i], oLats, oLons, oLo, oHi)
    if (d > mx) mx = d
  }
  return mx
}

// ────────────────────────────────────────────────────────────────────
// Kink detection (short out-and-back spurs)
// ────────────────────────────────────────────────────────────────────

/** Max perpendicular distance (m) of points lo..hi from the chord lo→hi, with its index. */
function maxDepthFromChord(lats, lons, lo, hi) {
  const mPerDegLat = 111320
  const mPerDegLon = mPerDegLat * Math.cos(lats[lo] * Math.PI / 180)
  const ax = lons[lo] * mPerDegLon, ay = lats[lo] * mPerDegLat
  const bx = lons[hi] * mPerDegLon, by = lats[hi] * mPerDegLat
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  let best = 0, bestIdx = lo
  for (let i = lo + 1; i < hi; i++) {
    const px = lons[i] * mPerDegLon, py = lats[i] * mPerDegLat
    let d
    if (len2 > 0) {
      let t = ((px - ax) * dx + (py - ay) * dy) / len2
      if (t < 0) t = 0; else if (t > 1) t = 1
      d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    } else {
      d = Math.hypot(px - ax, py - ay)
    }
    if (d > best) { best = d; bestIdx = i }
  }
  return { depth: best, idx: bestIdx }
}

/** Nearest distance (m) from (lat, lon) to any point of the original track. */
function minDistToTrack(lat, lon, oLats, oLons) {
  let best = Infinity
  for (let i = 0; i < oLats.length; i++) {
    const d = haversine(lat, lon, oLats[i], oLons[i])
    if (d < best) best = d
  }
  return best
}

/**
 * Detect short out-and-back "kink" spurs the snap introduced — the route darts
 * a few metres off and U-turns straight back, then resumes. These sit below the
 * routing-suspect deviation floor, so they need their own detector.
 *
 * Trigger: a FOLD — the travel direction reverses ≥ `foldTurnDeg` within a tiny
 * `foldWinM` window. No real road folds ~180° in a few metres (even a tight
 * hairpin spreads its 180° over an arc, ~10–30° per metre), so a near-
 * instantaneous reversal is a routing artifact. This is inherently immune to the
 * hairpin-apex false positive a self-proximity test suffers (a hairpin apex is
 * "near itself" but never reverses 180° over a few metres).
 *
 * Around each fold tip the snip span [alo, ahi] is grown out to the rejoin (the
 * near-coincident junction where the out- and back-legs meet). Then:
 *   - rejoin chord ≤ `selfReturnM` (it truly returns to a junction)
 *   - excursion depth ≥ `minDepthM` (not noise)
 *   - total length ≤ `unconditionalLenM` → always an artifact (no course has an
 *     out-and-back that short); longer ones get the original-track cross-check
 *     (skipped on overlapping courses, where it is unreliable).
 *
 * @returns {Array<{ alo, ahi, chordM, lengthM, depthM, peakIdx, atM }>}
 */
export function detectSnapKinks(lats, lons, dists, origLats, origLons, opts = {}) {
  const N = lats.length
  if (N < 5) return []
  const foldWinM = opts.foldWinM ?? 4
  // 140° within 4 m: catches the awkward near-doubleback sharp turns (wrong-way
  // roundabout / off-side routing) while still excluding real hairpins, which
  // spread their 180° over an arc (a hairpin would need radius < ~1.6 m to turn
  // 140° in 4 m — below any real road).
  const foldTurnDeg = opts.foldTurnDeg ?? 140
  const selfReturnM = opts.selfReturnM ?? 20
  const minDepthM = opts.minDepthM ?? 6
  const maxLenM = opts.maxLenM ?? 600
  const unconditionalLenM = opts.unconditionalLenM ?? 200
  const origClearM = opts.origClearM ?? 15
  const maxKinks = opts.maxKinks ?? 60

  const half = foldWinM / 2
  const idxBefore = (i, w) => { let a = i; for (let k = i - 1; k >= 0; k--) { a = k; if (dists[i] - dists[k] >= w) break } return a }
  const idxAfter = (i, w) => { let b = i; for (let k = i + 1; k < N; k++) { b = k; if (dists[k] - dists[i] >= w) break } return b }

  // 1. Fold tips: travel direction reverses ≥ foldTurnDeg within ±half metres.
  const fold = new Array(N).fill(false)
  for (let i = 1; i < N - 1; i++) {
    const a = idxBefore(i, half), b = idxAfter(i, half)
    if (a >= i || b <= i) continue
    const bIn = bearing(lats[a], lons[a], lats[i], lons[i])
    const bOut = bearing(lats[i], lons[i], lats[b], lons[b])
    let turn = Math.abs(bIn - bOut)
    if (turn > 180) turn = 360 - turn
    if (turn >= foldTurnDeg) fold[i] = true
  }

  // 2. Each fold (cluster) → spur span, grown out to where the legs rejoin.
  const kinks = []
  let i = 1
  while (i < N - 1) {
    if (!fold[i]) { i++; continue }
    let t0 = i, t1 = i
    while (t1 + 1 < N && fold[t1 + 1]) t1++
    const tip = (t0 + t1) >> 1

    // The out- and back-legs run antiparallel and close (same narrow road), so
    // their chord stays small along the spur and starts GROWING once the legs
    // pass the junction onto the (diverging) main road — stop there. That pins
    // [alo, ahi] to the junction even when the main road runs straight through.
    let alo = t0, ahi = t1, a = t0, b = t1
    let chord = haversine(lats[t0], lons[t0], lats[t1], lons[t1])
    while (a > 0 && b < N - 1
           && dists[t0] - dists[a - 1] <= maxLenM / 2
           && dists[b + 1] - dists[t1] <= maxLenM / 2) {
      const ch = haversine(lats[a - 1], lons[a - 1], lats[b + 1], lons[b + 1])
      if (ch > chord + 0.5) break // legs diverging — past the junction
      a--; b++; alo = a; ahi = b; chord = ch
    }
    const lengthM = dists[ahi] - dists[alo]
    const { depth } = maxDepthFromChord(lats, lons, alo, ahi)
    const isArtifact = chord <= selfReturnM && depth >= minDepthM
      && (lengthM <= unconditionalLenM
        || minDistToTrack(lats[tip], lons[tip], origLats, origLons) > origClearM)
    if (isArtifact) {
      kinks.push({ alo, ahi, chordM: chord, lengthM, depthM: depth, peakIdx: tip, atM: dists[alo] })
    }
    i = t1 + 1
  }
  return kinks.slice(0, maxKinks)
}

// ────────────────────────────────────────────────────────────────────
// Densify route
// ────────────────────────────────────────────────────────────────────

/**
 * Map waypoint indices from pre-densified to densified array.
 * Densify preserves original vertices and inserts interpolated points between them.
 * We scan the densified array for exact matches of each original vertex.
 *
 * @param {number[]} wpIndices — waypoint indices in the pre-densified route
 * @param {number[]} preLats — pre-densified lats
 * @param {number[]} preLons — pre-densified lons
 * @param {number[]} denseLats — densified lats
 * @param {number[]} denseLons — densified lons
 * @returns {number[]} — waypoint indices in the densified array
 */
export function mapWaypointsToDensified(wpIndices, preLats, preLons, denseLats, denseLons) {
  // Build mapping: for each original index i, find it in the densified array.
  // Densify emits: vertex 0, then for each segment [interpolated...], vertex i+1.
  // Original vertices are preserved exactly, so we can match by coordinate.
  const N = preLats.length
  const indexMap = new Array(N)
  indexMap[0] = 0
  let dIdx = 0

  for (let i = 1; i < N; i++) {
    dIdx++
    while (dIdx < denseLats.length &&
           (Math.abs(denseLats[dIdx] - preLats[i]) > 1e-10 ||
            Math.abs(denseLons[dIdx] - preLons[i]) > 1e-10)) {
      dIdx++
    }
    indexMap[i] = Math.min(dIdx, denseLats.length - 1)
  }

  return wpIndices.map(wi => indexMap[Math.min(wi, N - 1)])
}

// ────────────────────────────────────────────────────────────────────
// Auto-snap orchestrator
// ────────────────────────────────────────────────────────────────────

/**
 * Run the full auto-snap pipeline: compute waypoints, batch-route via
 * Valhalla, merge results, and transfer elevations.
 *
 * @param {number[]} lats — original route lats
 * @param {number[]} lons — original route lons
 * @param {number[]} eles — original route eles
 * @param {number[]|Float64Array} dists — original cumulative distances
 * @param {number} spacing — base spacing in metres
 * @param {Function} onProgress — (current, total, segments) progress callback
 * @param {{ costing?: string, ignoreOneways?: boolean, ignoreRestrictions?: boolean, refine?: boolean, refineSpacings?: number[], adaptiveProfile?: boolean }} [opts]
 *   adaptiveProfile (default true): on legs the primary profile can't follow
 *   (e.g. car over a bike-only path), try bike/foot and keep whichever tracks
 *   the original best. Only ever applied to flagged legs, never route-wide.
 * @returns {Promise<{ lats: number[], lons: number[], eles: number[], waypoints: number[] }>}
 */
export async function autoSnap(lats, lons, eles, dists, spacing, onProgress, opts = {}) {
  const { costing = 'car', forcedIndices = [],
          ignoreOneways = true, ignoreRestrictions = true,
          refine = true, refineSpacings = [160, 80],
          adaptiveProfile = true,
          selfNear = true, uniform = false,
          refineDensify = true, legGoodDevM = 18, refineDetectOpts = {} } = opts

  // Head-unit cleanup mode passes selfNear:false, uniform:true, refine:false —
  // sparse uniform anchors let Valhalla snap to the road centreline and smooth
  // over GPS jitter instead of faithfully reproducing a noisy track.
  const selfNearIndices = selfNear ? buildSelfNearSnapIndices(lats, lons, dists) : []
  const routeLockIndices = [...forcedIndices, ...selfNearIndices]
  let indices = buildAutoSnapIndices(lats, lons, dists, spacing, routeLockIndices, uniform)
  if (selfNearIndices.length > 0) {
    console.log(`[snap] Added ${selfNearIndices.length} self-near route-lock waypoint(s)`)
  }
  if (uniform) console.log(`[snap] Head-unit cleanup mode: uniform ${spacing}m anchors, refinement off`)

  // Map profile to Valhalla costing string
  const valhallaCost = costing === 'bike' ? 'bicycle'
    : costing === 'pedestrian' ? 'pedestrian'
    : 'auto'

  // Build costing_options for any Valhalla profile (pedestrian needs the higher cap).
  const costingOptsFor = (cost) => {
    const o = { ignore_oneways: ignoreOneways, ignore_restrictions: ignoreRestrictions }
    return cost === 'pedestrian' ? { ...o, walking_speed: 5.1, max_distance: 100000 } : o
  }
  const costingOpts = costingOptsFor(valhallaCost)

  // Adaptive-profile fallback set: alternate profiles tried ONLY on legs the
  // primary profile can't follow (e.g. a car route over a bike-only path). They
  // are never used route-wide, so they can't pull the route onto a parallel bike
  // path where the primary profile already followed the road correctly.
  const altProfiles = !adaptiveProfile ? []
    : valhallaCost === 'auto' ? ['bicycle', 'pedestrian']
    : valhallaCost === 'bicycle' ? ['pedestrian']
    : []
  const GOOD_DEV_M = legGoodDevM // a leg this close to the track needs no alternate
  const SWAP_MARGIN_M = 8        // swap to an alternate only if it's this much closer

  // Route one flagged leg through its interior waypoints, trying the primary
  // profile first and alternates only if it still drifts off the track. Keeps
  // whichever profile tracks the original most closely (lowest max deviation),
  // with a small margin so we don't swap on noise. Logs every comparison.
  const routeLegAdaptive = async (subWps, oLo, oHi, atM, existingPrimaryLegs) => {
    // For a dense leg (no new interior waypoints) the existing committed
    // geometry IS the primary result — measure it instead of re-routing.
    const primaryLegs = existingPrimaryLegs || await valhallaBatchRoute(subWps, valhallaCost, null, costingOpts)
    const pm = mergeSegments(primaryLegs)
    let best = { legs: primaryLegs, dev: legMaxDeviation(pm.lats, pm.lons, lats, lons, oLo, oHi), cost: valhallaCost }
    if (best.dev <= GOOD_DEV_M || altProfiles.length === 0) return best

    const log = [`${valhallaCost}=${best.dev.toFixed(0)}m`]
    for (const alt of altProfiles) {
      let altLegs
      try { altLegs = await valhallaBatchRoute(subWps, alt, null, costingOptsFor(alt)) } catch (e) { log.push(`${alt}=ERR`); continue }
      const am = mergeSegments(altLegs)
      const dev = legMaxDeviation(am.lats, am.lons, lats, lons, oLo, oHi)
      log.push(`${alt}=${dev.toFixed(0)}m`)
      if (dev < best.dev - SWAP_MARGIN_M) best = { legs: altLegs, dev, cost: alt }
    }
    console.log(`[snap]   leg @${(atM / 1000).toFixed(2)}km  ${log.join('  ')}  → ${best.cost}`)
    return best
  }

  // Full route: one segment (leg) per consecutive waypoint pair.
  let segments = await valhallaBatchRoute(indices.map(idx => ({ lat: lats[idx], lon: lons[idx] })),
    valhallaCost, (done, totalSegs) => onProgress(done, totalSegs, null), costingOpts)
  let merged = mergeSegments(segments)
  onProgress(indices.length - 1, indices.length - 1, segments)

  // Deviation-driven refinement: re-route ONLY the legs whose snapped geometry
  // drifted off the original track, splicing the denser result back in. The
  // unchanged ~95% of the route is never re-routed. Each pass tightens the
  // sampling (refineSpacings). Legs are spliced last-to-first so earlier leg
  // indices stay valid as new waypoints are inserted.
  // refineDensify=false (head-unit cleanup + adaptive profile): no waypoint
  // densification at all — only retry clearly-failed legs with alternate
  // profiles on the existing sparse anchors. legGoodDevM is raised by the caller
  // so only genuine profile failures (big detours / bike-only paths) trigger it,
  // not the intentional smoothing of a noisy track.
  if (refine && refineSpacings.length > 0 && (refineDensify || altProfiles.length > 0)) {
    for (let pass = 0; pass < refineSpacings.length; pass++) {
      const suspects = detectSnapDeviations(lats, lons, dists, merged.lats, merged.lons, indices, merged.wpIndices, refineDetectOpts)
      if (suspects.length > 0) {
        console.log(`[snap] Pass ${pass + 1} suspects: ` +
          suspects.map(s => `${(s.atM / 1000).toFixed(2)}km(${s.maxDev.toFixed(0)}m)`).join(', '))
      }
      if (suspects.length === 0) { console.log(`[snap] Pass ${pass + 1}: no deviation suspects — done`); break }

      let byLeg
      if (refineDensify) {
        // includeEmpty so already-dense flagged legs (self-near zones) still get
        // adaptive-profile re-routing — that's where bike-only paths hide.
        byLeg = collectRefinementByLeg(suspects, indices, merged.wpIndices, dists, refineSpacings[pass], altProfiles.length > 0)
      } else {
        // Profile-only: every flagged leg, no interior waypoints added.
        const legSet = new Set()
        for (const s of suspects) for (const a of anchorSegmentsForSpan(s.alo, s.ahi, merged.wpIndices)) legSet.add(a)
        byLeg = [...legSet].sort((x, y) => x - y).map(a => ({ a, interior: [] }))
      }
      if (byLeg.length === 0) { console.log(`[snap] Pass ${pass + 1}: nothing left to refine — converged`); break }

      const added = byLeg.reduce((n, l) => n + l.interior.length, 0)
      const dense = byLeg.filter(l => l.interior.length === 0).length
      console.log(`[snap] ${refineDensify ? 'Refine' : 'Profile'} pass ${pass + 1}: re-routing ${byLeg.length} leg(s) (+${added} waypoint(s), ${dense} no-densify)` +
        (refineDensify ? ` @ ${refineSpacings[pass]}m` : '') +
        (altProfiles.length ? ` (adaptive: ${valhallaCost}→${altProfiles.join('/')})` : ' (adaptive OFF)'))
      onProgress(0, byLeg.length, null)

      let doneLegs = 0
      for (const { a, interior } of byLeg.sort((x, y) => y.a - x.a)) {
        // Re-route this leg through its new interior waypoints (endpoints
        // unchanged, so the splice connects seamlessly at the same junctions).
        // Adaptive profile: if the primary profile can't follow the leg, try
        // alternates (bike/foot) and keep whichever tracks the original best.
        // For a no-densify leg (no interior) we keep the committed geometry as
        // the primary and only fan out to alternate profiles.
        const subWps = [indices[a], ...interior, indices[a + 1]].map(i => ({ lat: lats[i], lon: lons[i] }))
        const existing = interior.length === 0 ? [segments[a]] : undefined
        const { legs: subLegs } = await routeLegAdaptive(subWps, indices[a], indices[a + 1], dists[indices[a]], existing)
        segments.splice(a, 1, ...subLegs)
        indices.splice(a + 1, 0, ...interior)
        onProgress(++doneLegs, byLeg.length, null)
      }
      merged = mergeSegments(segments)

      // No densification → indices unchanged → a second pass would just re-test
      // the same (unfixable) legs. One pass is enough.
      if (!refineDensify) break
    }
  }

  const total = indices.length - 1
  onProgress(total, total, segments)

  // Overlap snap — align coordinates where route revisits the same road
  // (out-and-back, lollipop, figure-8). Must run before elevation assignment
  // so identical XY produces identical Z from LIDAR.
  const overlapResult = snapOverlaps(merged.lats, merged.lons)
  if (overlapResult.snapped > 0) {
    console.log(`[overlap] Snapped ${overlapResult.snapped} points across ${overlapResult.segments.length} segments`)
  }

  // Transfer elevations using per-segment proportional distance mapping
  // anchored at waypoint positions on both routes
  const newEles = transferElevations(lats, lons, eles, dists, merged.lats, merged.lons, {
    origIndices: indices,
    newIndices: merged.wpIndices,
  })

  return {
    lats: merged.lats,
    lons: merged.lons,
    eles: newEles,
    waypoints: indices,
    wpIndices: merged.wpIndices,
  }
}
