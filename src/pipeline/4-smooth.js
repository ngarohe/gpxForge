/**
 * Step 4: Smooth — Six-stage pipeline for geometry + elevation.
 *
 *   1. **Gradient averaging** — smooth the cleaned elevation profile by
 *      averaging gradients within a distance window (~4m each side).
 *
 *   1.5. **Fillet tight corners** — replace sharp vertices (≥70° turn)
 *      with smooth 6m-radius arcs. Pre-rounds hairpins and 90° corners.
 *
 *   2. **Resample** — redistribute points at uniform ~1m spacing via
 *      linear interpolation along the filleted route.
 *
 *   2.5. **Position smoothing** — Gaussian smooth (σ=5m) on lat/lon,
 *      pinning start and end points.
 *
 *   3. **processGPX** — run on the pre-processed geometry for final
 *      corner rounding, arc fitting, splines, pruning. Geometry only —
 *      processGPX elevation output is discarded.
 *
 *   4. **Elevation transfer** — map gradient-averaged elevations from
 *      the ORIGINAL route onto processGPX geometry via proportional
 *      distance interpolation. Bypasses processGPX's uniform-gradient
 *      hairpin elevation problem entirely.
 */

import { processGPX } from '../lib/processGPX/process-gpx.js'
import { grads, ascDesc, haversine } from '../utils/math.js'
import {
  applyFillets,
  resampleRoute,
  smoothPositions,
  simplifyByArea,
} from '../utils/geometry.js'

// ────────────────────────────────────────────────────────────────────
// Gradient averaging
// ────────────────────────────────────────────────────────────────────

/** Number of segments each side for gradient averaging — matches GPXmagic's "4 each side". */
const GRAD_AVG_HALF_COUNT = 4

/**
 * Smooth elevations by averaging gradients over a fixed count window,
 * then recomputing elevations from averaged gradients.
 *
 * Matches GPXmagic's "4-point average" algorithm exactly: always 4 segments
 * each side (9-segment window), regardless of point spacing. The old approach
 * used a 4m distance window which only worked at 1m spacing — at 5-25m GPS
 * spacing it covered fewer than 1 neighbor and did almost nothing.
 *
 * @param {number[]} eles — input elevations
 * @param {number[]} dists — cumulative distances (metres)
 * @param {number} [halfCount=4] — number of segments each side
 * @returns {number[]} smoothed elevations (same length as input)
 */
export function smoothElevationsByGradient(eles, dists, halfCount = GRAD_AVG_HALF_COUNT) {
  const N = eles.length
  if (N < 3) return [...eles]

  // 1. Compute per-segment gradients (N-1 values)
  const gr = new Array(N - 1)
  for (let i = 0; i < N - 1; i++) {
    const dd = dists[i + 1] - dists[i]
    gr[i] = dd > 0 ? (eles[i + 1] - eles[i]) / dd : 0
  }

  // 2. Average gradients over fixed count window (4 each side)
  const avgGr = new Array(N - 1)
  for (let i = 0; i < N - 1; i++) {
    const lo = Math.max(0, i - halfCount)
    const hi = Math.min(N - 2, i + halfCount)
    let sum = 0
    for (let j = lo; j <= hi; j++) sum += gr[j]
    avgGr[i] = sum / (hi - lo + 1)
  }

  // 3. Recompute elevations from averaged gradients
  const smooth = new Array(N)
  smooth[0] = eles[0]
  for (let i = 0; i < N - 1; i++) {
    smooth[i + 1] = smooth[i] + avgGr[i] * (dists[i + 1] - dists[i])
  }

  return smooth
}

// ────────────────────────────────────────────────────────────────────
// Full pipeline
// ────────────────────────────────────────────────────────────────────

/**
 * Run the full smoothing pipeline.
 *
 * @param {number[]} lats — latitude array
 * @param {number[]} lons — longitude array
 * @param {number[]} eles — input elevations (typically eleClean)
 * @param {number[]} dists — cumulative distances
 * @returns {{
 *   eleSmoothed: number[],
 *   grSmoothed: number[],
 *   lats: number[],
 *   lons: number[],
 *   dists: number[],
 *   stats: { ascBefore: number, ascAfter: number, maxBefore: number, maxAfter: number, ptsOrig: number, ptsAfter: number }
 * }}
 */
export function runSmoothing(lats, lons, eles, dists) {
  const N = lats.length

  // Pre-compute stats from input
  const grRaw = grads(eles, dists)
  const maxBefore = grRaw.reduce((m, g) => Math.max(m, Math.abs(g)), 0)
  const { asc: ascBefore } = ascDesc(eles)

  // ── Stage 1: Fillet tight corners (≥70° turn) ──
  const filleted = applyFillets(lats, lons, eles, dists, {
    minTurnDeg: 70,
    radiusM: 6,
    spacingM: 0.3,
  })

  // ── Stage 2: Resample at uniform ~1m spacing ──
  const resampled = resampleRoute(
    filleted.lats, filleted.lons, filleted.dists, 1,
  )

  // Interpolate elevations from filleted route onto 1m-resampled distances.
  // resampleRoute doesn't carry eles, so we do it here before gradient averaging.
  const filLen = filleted.lats.length
  const resLen = resampled.lats.length
  const resEles = new Array(resLen)
  let filSeg = 0
  for (let i = 0; i < resLen; i++) {
    const d = resampled.dists[i]
    while (filSeg < filLen - 2 && filleted.dists[filSeg + 1] < d) filSeg++
    const segLen = filleted.dists[filSeg + 1] - filleted.dists[filSeg]
    const t = segLen > 0 ? Math.max(0, Math.min(1, (d - filleted.dists[filSeg]) / segLen)) : 0
    resEles[i] = filleted.eles[filSeg] + t * (filleted.eles[filSeg + 1] - filleted.eles[filSeg])
  }

  // ── Stage 2.5: Gradient averaging on 1m-resampled elevations ──
  // Now at ~1m spacing, 4 segments each side = exactly GPXmagic's "4-point average".
  const smoothEles = smoothElevationsByGradient(resEles, resampled.dists)

  // ── Stage 3a: Position smoothing (σ=5m Gaussian) ──
  const smoothed = smoothPositions(
    resampled.lats, resampled.lons, resampled.dists, 5,
  )

  // Recompute distances from position-smoothed coordinates
  const smLen = smoothed.lats.length
  const smDists = [0]
  for (let i = 1; i < smLen; i++) {
    smDists.push(smDists[i - 1] + haversine(
      smoothed.lats[i - 1], smoothed.lons[i - 1],
      smoothed.lats[i], smoothed.lons[i],
    ))
  }

  // ── Stage 3b: processGPX for final geometry polish ──
  // Feed the pre-processed geometry (filleted, resampled, smoothed).
  // processGPX adds arc fitting, splines, corner rounding, pruning.
  // We discard its elevation — only use lat/lon output.
  const coordinates = smoothed.lats.map((lat, i) => [smoothed.lons[i], lat, 0])
  const feature = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: {},
  }

  const result = processGPX(feature, { auto: 1, zSmooth: 0, cornerCrop: 0, prune: 0, lSmooth: 2, autoSpacing: 0, spacing: 0, snap: 0 })

  // Extract processGPX lat/lon (discard elevation)
  const coords = result.geometry.coordinates
  const M = coords.length
  const newLats = new Array(M)
  const newLons = new Array(M)
  for (let i = 0; i < M; i++) {
    newLons[i] = coords[i][0]
    newLats[i] = coords[i][1]
  }

  // Recompute distances from processGPX output
  const newDists = [0]
  for (let i = 1; i < M; i++) {
    newDists.push(newDists[i - 1] + haversine(newLats[i - 1], newLons[i - 1], newLats[i], newLons[i]))
  }

  // ── Stage 4: Transfer gradient-averaged elevations onto processGPX geometry ──
  // Source: smoothEles at 1m spacing (resampled.dists). Both smoothEles and
  // processGPX geometry derive from the same filleted route, so we map by
  // proportional distance rather than trusting absolute totals to match exactly.
  const resTotal = resampled.dists[resLen - 1]
  const newTotal = newDists[M - 1]
  const eleSmoothed = new Array(M)

  let seg = 0
  for (let i = 0; i < M; i++) {
    const targetDist = newTotal > 0 ? (newDists[i] / newTotal) * resTotal : 0

    // Advance monotonically through 1m-resampled source
    while (seg < resLen - 2 && resampled.dists[seg + 1] < targetDist) seg++

    // Interpolate elevation within the matched segment
    const segLen = resampled.dists[seg + 1] - resampled.dists[seg]
    const t = segLen > 0 ? Math.max(0, Math.min(1, (targetDist - resampled.dists[seg]) / segLen)) : 0
    eleSmoothed[i] = smoothEles[seg] + t * (smoothEles[seg + 1] - smoothEles[seg])
  }

  // Final gradient for display
  const grSmoothed = grads(eleSmoothed, newDists)

  // Post-processing stats
  const maxAfter = grSmoothed.reduce((m, g) => Math.max(m, Math.abs(g)), 0)
  const { asc: ascAfter } = ascDesc(eleSmoothed)

  // origDists: map each smoothed point to original-route distance for chart X alignment.
  // Proportional scaling: processGPX dist / processGPX total × original total.
  const origTotal = dists[N - 1]
  const origDists = newDists.map(d => newTotal > 0 ? (d / newTotal) * origTotal : 0)

  return {
    eleSmoothed,
    grSmoothed,
    lats: newLats,
    lons: newLons,
    dists: newDists,
    origDists,
    stats: {
      ascBefore,
      ascAfter,
      maxBefore,
      maxAfter,
      ptsOrig: N,
      ptsAfter: M,
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// Triangle-area simplification (post-processing)
// ────────────────────────────────────────────────────────────────────

/**
 * Run one simplification pass on a smoothed route.
 *
 * @param {{ lats: number[], lons: number[], eles: number[],
 *           dists: Float64Array|number[], gr: Float64Array|number[] }} route
 * @returns {{ route: { lats, lons, eles, dists, gr }, removedCount: number }}
 */
export function runSimplify(route) {
  const result = simplifyByArea(
    [...route.lats], [...route.lons], [...route.eles], [...route.dists],
  )
  return {
    route: {
      lats: result.lats,
      lons: result.lons,
      eles: result.eles,
      dists: new Float64Array(result.dists),
      gr: new Float64Array(result.gr),
    },
    removedCount: result.removedCount,
  }
}
