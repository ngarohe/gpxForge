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
  filletAllCorners,
  resampleRoute,
  smoothPositions,
  simplifyByArea,
} from '../utils/geometry.js'
import { buildTurnaround } from '../utils/lane-split.js'

// ────────────────────────────────────────────────────────────────────
// Gradient averaging
// ────────────────────────────────────────────────────────────────────

/** Number of segments each side for gradient averaging — matches GPXmagic's "4 each side". */
const GRAD_AVG_HALF_COUNT = 4

/**
 * Native pixel resolution (metres) per LIDAR source tag.
 * Used for two purposes with different thresholds:
 * - halfCountForSource: scales gradient-averaging window for ≥3m sources
 * - isLowResSource: gates cleaner auto-apply for ≥10m sources only
 */
const SOURCE_RESOLUTION_M = {
  ES_WCS_5M: 5,
  ES_MDT05_LOCAL: 5,
  AT_DGM5_LOCAL: 5,
  HR_DTM20: 20,
  IT_BZ_WCS_25: 2.5,
  IT_ER_DTM5: 5,
  IT_VENETO_5M: 5,
  IT_LOMBARDIA_5M: 5,
  IT_PIEMONTE_5M: 5,
  IT_FVG_1M: 1,
  IT_TRENTINO_05M: 0.5,
  IT_TOSCANA_1M: 1,
  IT_TOSCANA_10M: 10,
  IT_TINITALY_10M: 10,
}

/**
 * Compute the gradient-averaging half-window for a given LIDAR source.
 * Returns the default (4) for hi-res (≤2m) or unknown sources, preserving
 * 1m behaviour. For coarser sources, scales the window to ~4 native pixels
 * each side after the 1m resample so the smoother reaches across the
 * pixel-quantization stairs.
 * @param {string|undefined} source — LIDAR source tag (e.g. 'ES_WCS_5M')
 * @returns {number} halfCount segments each side (≥ 4)
 */
export function halfCountForSource(source) {
  const native = SOURCE_RESOLUTION_M[source]
  if (!native || native <= 2) return GRAD_AVG_HALF_COUNT
  return Math.max(GRAD_AVG_HALF_COUNT, Math.round(GRAD_AVG_HALF_COUNT * native))
}

/**
 * True for LIDAR sources at ≥10m native resolution. On these, every
 * "artifact" the cleaner detects is more likely to be the real terrain
 * shape than a spike, so callers can opt out of auto-applying them.
 * @param {string|undefined} source
 */
export function isLowResSource(source) {
  const native = SOURCE_RESOLUTION_M[source]
  return !!native && native >= 10
}

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
 * @param {number|Int32Array} [halfCount=4] — segments each side, or per-segment array
 * @returns {number[]} smoothed elevations (same length as input)
 */
export function smoothElevationsByGradient(eles, dists, halfCount = GRAD_AVG_HALF_COUNT) {
  const N = eles.length
  if (N < 3) return [...eles]

  const perSeg = typeof halfCount !== 'number'

  // 1. Compute per-segment gradients (N-1 values)
  const gr = new Array(N - 1)
  for (let i = 0; i < N - 1; i++) {
    const dd = dists[i + 1] - dists[i]
    gr[i] = dd > 0 ? (eles[i + 1] - eles[i]) / dd : 0
  }

  // 2. Average gradients over fixed count window (4 each side)
  const avgGr = new Array(N - 1)
  for (let i = 0; i < N - 1; i++) {
    const hc = perSeg ? halfCount[i] : halfCount
    const lo = Math.max(0, i - hc)
    const hi = Math.min(N - 2, i + hc)
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
 * @param {{ lidarSource?: string, sourceSegments?: Array<{start: number, end: number, source: string}>, origAvgSpacing?: number }} [opts]
 *   lidarSource — used to scale the gradient-averaging window for low-res
 *   sources (≥10m); hi-res and unknown sources use the default 4-segment
 *   window so behaviour is unchanged.
 *   sourceSegments — per-zone source info for cross-border routes; overrides
 *   lidarSource when present with >1 segment.
 * @returns {{
 *   eleSmoothed: number[],
 *   grSmoothed: number[],
 *   lats: number[],
 *   lons: number[],
 *   dists: number[],
 *   stats: { ascBefore: number, ascAfter: number, maxBefore: number, maxAfter: number, ptsOrig: number, ptsAfter: number }
 * }}
 */
export function runSmoothing(lats, lons, eles, dists, opts = {}) {
  const N = lats.length
  const segments = opts.sourceSegments || []
  const defaultHalfCount = halfCountForSource(opts.lidarSource)

  // Pre-compute stats from input
  const grRaw = grads(eles, dists)
  const maxBefore = grRaw.reduce((m, g) => Math.max(m, Math.abs(g)), 0)
  const { asc: ascBefore } = ascDesc(eles)

  // Smoothing engine + min radius (one knob for every turn). Native = GPXForge fillets; processgpx =
  // the legacy arc-fitting/spline engine (kept selectable for A/B until we dismiss it).
  const engine = opts.engine === 'processgpx' ? 'processgpx' : 'native'
  const minRadiusM = opts.minRadiusM ?? 6

  // ── Stage 1: angle-based pre-fillet (≥70°) — ONLY for the processGPX engine on a recorded ride.
  // It pre-rounds sharp corners so processGPX's arc detector behaves. The native engine rounds every
  // corner AFTER the resample (filletAllCorners), and courses are σ-smoothed per-segment at finish —
  // both skip this.
  const doPreFillet = engine === 'processgpx' && !opts.skipPositionSmooth
  const filleted = doPreFillet
    ? applyFillets(lats, lons, eles, dists, { minTurnDeg: 70, radiusM: 6, spacingM: 0.3 })
    : { lats: [...lats], lons: [...lons], eles: [...eles], dists: [...dists] }

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
  // Hi-res sources: 4 segments each side = exactly GPXmagic's "4-point average".
  // Low-res sources (≥10m): window scales with native pixel size so the
  // smoother spans ~4 native pixels each side and erases the pixel-quantization
  // "stair" artefacts that a 9m window cannot reach.
  // Cross-border: per-zone halfCount mapped from original indices via distance.
  let halfCountArg = defaultHalfCount
  if (segments.length > 1) {
    const hcArr = new Int32Array(resLen - 1).fill(defaultHalfCount)
    for (const seg of segments) {
      const hc = halfCountForSource(seg.source)
      if (hc === defaultHalfCount) continue
      const dLo = seg.start < N ? dists[seg.start] : dists[N - 1]
      const dHi = seg.end < N ? dists[seg.end] : dists[N - 1]
      for (let i = 0; i < resLen - 1; i++) {
        if (resampled.dists[i] >= dLo && resampled.dists[i] <= dHi) {
          hcArr[i] = hc
        }
      }
    }
    halfCountArg = hcArr
  }
  const smoothEles = smoothElevationsByGradient(resEles, resampled.dists, halfCountArg)

  // ── Position smoothing (σ=5 m Gaussian) — recorded rides only. ──
  // Courses are σ-smoothed PER SEGMENT at finish (keeps reused passes vertex-identical); re-smoothing
  // the compiled track here would re-diverge them, so we keep their resampled XY as the basis.
  const posSmoothed = opts.skipPositionSmooth
    ? { lats: resampled.lats, lons: resampled.lons, dists: resampled.dists }
    : (() => {
        const sm = smoothPositions(resampled.lats, resampled.lons, resampled.dists, 5)
        const d = [0]
        for (let i = 1; i < sm.lats.length; i++) d.push(d[i - 1] + haversine(sm.lats[i - 1], sm.lons[i - 1], sm.lats[i], sm.lons[i]))
        return { lats: sm.lats, lons: sm.lons, dists: d }
      })()

  const origTotal = dists[N - 1]
  const finish = (oLats, oLons, oEles, oDists) => {
    const grSmoothed = grads(oEles, oDists)
    const maxAfter = grSmoothed.reduce((m, g) => Math.max(m, Math.abs(g)), 0)
    const { asc: ascAfter } = ascDesc(oEles)
    const total = oDists[oDists.length - 1]
    const origDists = Array.from(oDists, (d) => total > 0 ? (d / total) * origTotal : 0)
    return {
      eleSmoothed: oEles, grSmoothed, lats: oLats, lons: oLons, dists: oDists, origDists,
      stats: { ascBefore, ascAfter, maxBefore, maxAfter, ptsOrig: N, ptsAfter: oLats.length },
    }
  }

  // ── NATIVE engine: round EVERY turn to one min radius (junction nodes + radius-detected road bends,
  // one pass). smoothEles is per-point on the resampled track, which posSmoothed preserves 1:1, and
  // filletAllCorners carries/interpolates Z, so no separate elevation transfer is needed. ──
  if (engine === 'native') {
    const makeTurnaround = (Ta, Tf, vtx, fwd, R) => buildTurnaround(Ta, Tf, vtx, fwd, R)
    const shaped = filletAllCorners(posSmoothed.lats, posSmoothed.lons, smoothEles, posSmoothed.dists, {
      radiusM: minRadiusM, arcBoundVertices: opts.arcBoundVertices || [], makeTurnaround,
    })
    return finish(shaped.lats, shaped.lons, shaped.eles, shaped.dists)
  }

  // ── processGPX engine (legacy): arc fitting / splines for geometry, Z transferred onto its output. ──
  const coordinates = posSmoothed.lats.map((lat, i) => [posSmoothed.lons[i], lat, 0])
  const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} }
  const result = processGPX(feature, { auto: 1, zSmooth: 0, cornerCrop: 0, prune: 0, lSmooth: 2, autoSpacing: 0, spacing: 0, snap: 0 })
  const coords = result.geometry.coordinates
  const M = coords.length
  const newLats = new Array(M), newLons = new Array(M)
  for (let i = 0; i < M; i++) { newLons[i] = coords[i][0]; newLats[i] = coords[i][1] }
  const newDists = [0]
  for (let i = 1; i < M; i++) newDists.push(newDists[i - 1] + haversine(newLats[i - 1], newLons[i - 1], newLats[i], newLons[i]))

  // Transfer gradient-averaged Z onto processGPX geometry by proportional distance (both derive from
  // the same resampled route, so map by fraction rather than trusting absolute totals to match).
  const resTotal = resampled.dists[resLen - 1]
  const newTotal = newDists[M - 1]
  const eleSmoothed = new Array(M)
  let seg = 0
  for (let i = 0; i < M; i++) {
    const targetDist = newTotal > 0 ? (newDists[i] / newTotal) * resTotal : 0
    while (seg < resLen - 2 && resampled.dists[seg + 1] < targetDist) seg++
    const segLen = resampled.dists[seg + 1] - resampled.dists[seg]
    const t = segLen > 0 ? Math.max(0, Math.min(1, (targetDist - resampled.dists[seg]) / segLen)) : 0
    eleSmoothed[i] = smoothEles[seg] + t * (smoothEles[seg + 1] - smoothEles[seg])
  }
  return finish(newLats, newLons, eleSmoothed, newDists)
}

/**
 * Run processGPX's geometry polish (arc fitting, splines) on ONE polyline (lat/lon only).
 * Used by the Course Builder to polish each unique segment independently — reuse-safe (every pass
 * shares the result) and junction-safe (junctions are built at compile, after the segments). Returns
 * the polished lat/lon; elevation is the caller's concern. Falls back to the input on any failure or
 * when there are too few points for processGPX to do anything useful.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @returns {{ lats: number[], lons: number[] }}
 */
export function polishPolyline(lats, lons) {
  if (!lats || lats.length < 8) return { lats: [...lats], lons: [...lons] }
  try {
    const coordinates = lats.map((lat, i) => [lons[i], lat, 0])
    const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} }
    const result = processGPX(feature, { auto: 1, zSmooth: 0, cornerCrop: 0, prune: 0, lSmooth: 2, autoSpacing: 0, spacing: 0, snap: 0 })
    const coords = result.geometry.coordinates
    if (!coords || coords.length < 2) return { lats: [...lats], lons: [...lons] }
    return { lats: coords.map((c) => c[1]), lons: coords.map((c) => c[0]) }
  } catch {
    return { lats: [...lats], lons: [...lons] }
  }
}

/**
 * Apply one elevation-only smoothing pass on an already smoothed route.
 * Geometry (lat/lon/dists) stays unchanged; only Z profile is smoothed.
 *
 * Used for repeated "Smooth" clicks after the initial full process pass.
 *
 * @param {{ lats: number[], lons: number[], eles: number[],
 *           dists: Float64Array|number[], gr?: Float64Array|number[],
 *           origDists?: Float64Array|number[] }} route
 * @param {number} [halfCount=4] - number of segments each side for averaging
 * @returns {{
 *   route: { lats, lons, eles, dists, gr, origDists? },
 *   stats: { ascBefore: number, ascAfter: number, maxBefore: number, maxAfter: number, ptsOrig: number, ptsAfter: number }
 * }}
 */
export function runElevationOnlySmoothing(route, halfCount = 4) {
  if (!route || !route.eles || !route.dists || route.eles.length < 2) {
    throw new Error('Elevation-only smoothing requires an existing smoothed route')
  }

  const pts = route.eles.length
  const dists = route.dists instanceof Float64Array ? route.dists : new Float64Array(route.dists)
  const eleBefore = [...route.eles]
  const grBefore = route.gr && route.gr.length
    ? Array.from(route.gr)
    : grads(eleBefore, dists)

  const { asc: ascBefore } = ascDesc(eleBefore)
  const maxBefore = grBefore.reduce((m, g) => Math.max(m, Math.abs(g)), 0)

  const eleAfter = smoothElevationsByGradient(eleBefore, dists, halfCount)
  const grAfter = grads(eleAfter, dists)
  const { asc: ascAfter } = ascDesc(eleAfter)
  const maxAfter = grAfter.reduce((m, g) => Math.max(m, Math.abs(g)), 0)

  return {
    route: {
      ...route,
      lats: [...route.lats],
      lons: [...route.lons],
      eles: eleAfter,
      dists: new Float64Array(dists),
      gr: new Float64Array(grAfter),
      ...(route.origDists
        ? {
            origDists: route.origDists instanceof Float64Array
              ? new Float64Array(route.origDists)
              : new Float64Array(route.origDists),
          }
        : {}),
    },
    stats: {
      ascBefore,
      ascAfter,
      maxBefore,
      maxAfter,
      ptsOrig: pts,
      ptsAfter: pts,
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
