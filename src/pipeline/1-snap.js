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
import { snapOverlaps } from './1.5-overlap.js'

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
 * @returns {number[]} — indices into the route arrays
 */
export function buildAutoSnapIndices(lats, lons, dists, baseSpacing, forcedIndices = []) {
  const N = lats.length
  if (N < 2) return [0]

  const curv = computeCurvature(lats, lons, dists)
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

    const score = curv[lastIdx]
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
 * @param {{ costing?: string, ignoreOneways?: boolean, ignoreRestrictions?: boolean }} [opts]
 * @returns {Promise<{ lats: number[], lons: number[], eles: number[], waypoints: number[] }>}
 */
export async function autoSnap(lats, lons, eles, dists, spacing, onProgress, opts = {}) {
  const { costing = 'car', forcedIndices = [],
          ignoreOneways = true, ignoreRestrictions = true } = opts

  const indices = buildAutoSnapIndices(lats, lons, dists, spacing, forcedIndices)
  const total = indices.length - 1

  // Build waypoint array for batch routing
  const waypoints = indices.map(idx => ({ lat: lats[idx], lon: lons[idx] }))

  // Map profile to Valhalla costing string
  const valhallaCost = costing === 'bike' ? 'bicycle'
    : costing === 'pedestrian' ? 'pedestrian'
    : 'auto'

  let costingOpts = { ignore_oneways: ignoreOneways, ignore_restrictions: ignoreRestrictions }
  if (costing === 'pedestrian') {
    // max_distance raised to 100km — Valhalla's default cap is too low for hiking routes
    costingOpts = { ...costingOpts, walking_speed: 5.1, max_distance: 100000 }
  }

  // Batch route all waypoints (max 20 per request)
  const segments = await valhallaBatchRoute(waypoints, valhallaCost, (done, totalSegs) => {
    onProgress(done, totalSegs, null)
  }, costingOpts)

  // Final progress update with completed segments
  onProgress(total, total, segments)

  // Merge segments (skip junction duplicates)
  const merged = mergeSegments(segments)

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
