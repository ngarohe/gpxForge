/**
 * Vegetation artifact filter for LIDAR elevation profiles.
 *
 * Detects positive elevation spikes caused by misclassified canopy/shrub
 * returns in DTM data and replaces them with a polynomial fit through
 * clean neighbouring points.
 *
 * Algorithm:
 *   1. Morphological opening (erosion + dilation) with distance-based window
 *   2. Flag points where elevation − floor > spikeThresholdM
 *   3. Buffer, merge, and filter flagged regions
 *   4. Iterate until convergence (wide canopy may lift the floor estimate)
 *   5. Correct each region with polynomial fit + cosine-taper blend
 */

import { bsearchDists } from '../utils/math.js'

// ────────────────────────────────────────────────────────────────────
// Defaults
// ────────────────────────────────────────────────────────────────────

const DEFAULT_OPTS = {
  openingRadiusM: 75,       // morphological window radius — must exceed widest expected artifact
  spikeThresholdM: 1.5,     // min positive residual to flag — above LIDAR noise, below real features
  regionBufferM: 15,        // expand each flagged run by this on each side
  minArtifactWidthM: 5,     // discard regions narrower than this
  fitContextM: 100,         // clean data radius for polynomial fitting
  maxPolyDegree: 2,         // cap on polynomial degree for replacement surface
  blendM: 10,               // cosine taper blend zone at region edges
  maxIterations: 3,         // iterative refinement passes
  convergenceThreshold: 2,  // stop when fewer than this many new points flagged
}

// ────────────────────────────────────────────────────────────────────
// O(n) sliding extrema — monotonic deque
// ────────────────────────────────────────────────────────────────────

/**
 * Symmetric sliding minimum over a distance-based window of radius r.
 * Combines a forward trailing pass [dists[i]-r, dists[i]] and a backward
 * leading pass [dists[i], dists[i]+r] so the result covers [dists[i]-r, dists[i]+r].
 * O(n) total — each element enters and leaves each deque exactly once.
 *
 * @param {ArrayLike<number>} values
 * @param {ArrayLike<number>} dists — cumulative distances
 * @param {number} r — window radius in metres
 * @returns {Float64Array}
 */
function slidingMin(values, dists, r) {
  const N = values.length
  const fwd = new Float64Array(N)
  const bwd = new Float64Array(N)
  let dq = []

  // Forward pass: window [dists[i] - r, dists[i]]
  dq = []
  for (let i = 0; i < N; i++) {
    while (dq.length && dists[i] - dists[dq[0]] > r) dq.shift()
    while (dq.length && values[dq[dq.length - 1]] >= values[i]) dq.pop()
    dq.push(i)
    fwd[i] = values[dq[0]]
  }

  // Backward pass: window [dists[i], dists[i] + r]
  dq = []
  for (let i = N - 1; i >= 0; i--) {
    while (dq.length && dists[dq[0]] - dists[i] > r) dq.shift()
    while (dq.length && values[dq[dq.length - 1]] >= values[i]) dq.pop()
    dq.push(i)
    bwd[i] = values[dq[0]]
  }

  const result = new Float64Array(N)
  for (let i = 0; i < N; i++) result[i] = Math.min(fwd[i], bwd[i])
  return result
}

/**
 * Symmetric sliding maximum — same structure as slidingMin, reversed comparison.
 * @param {ArrayLike<number>} values
 * @param {ArrayLike<number>} dists
 * @param {number} r
 * @returns {Float64Array}
 */
function slidingMax(values, dists, r) {
  const N = values.length
  const fwd = new Float64Array(N)
  const bwd = new Float64Array(N)
  let dq = []

  // Forward pass
  dq = []
  for (let i = 0; i < N; i++) {
    while (dq.length && dists[i] - dists[dq[0]] > r) dq.shift()
    while (dq.length && values[dq[dq.length - 1]] <= values[i]) dq.pop()
    dq.push(i)
    fwd[i] = values[dq[0]]
  }

  // Backward pass
  dq = []
  for (let i = N - 1; i >= 0; i--) {
    while (dq.length && dists[dq[0]] - dists[i] > r) dq.shift()
    while (dq.length && values[dq[dq.length - 1]] <= values[i]) dq.pop()
    dq.push(i)
    bwd[i] = values[dq[0]]
  }

  const result = new Float64Array(N)
  for (let i = 0; i < N; i++) result[i] = Math.max(fwd[i], bwd[i])
  return result
}

/** Morphological opening: erosion (slidingMin) then dilation (slidingMax). */
function morphOpen(values, dists, r) {
  return slidingMax(slidingMin(values, dists, r), dists, r)
}

// ────────────────────────────────────────────────────────────────────
// Polynomial fitting (least-squares, hardcoded degrees 1 and 2)
// ────────────────────────────────────────────────────────────────────

/**
 * Fit a polynomial of the given degree through (xs, ys) by least squares.
 * xs should be centred (subtract mean) for numerical stability.
 *
 * @param {number[]} xs — x values (centred)
 * @param {number[]} ys — y values
 * @param {number} degree — 1 (linear) or 2 (quadratic)
 * @returns {((x: number) => number) | null} evaluator, or null if under-determined
 */
function fitPoly(xs, ys, degree) {
  const n = xs.length
  if (n < degree + 1) return null

  if (degree === 1) {
    let sx = 0, sy = 0, sx2 = 0, sxy = 0
    for (let i = 0; i < n; i++) {
      sx += xs[i]; sy += ys[i]
      sx2 += xs[i] * xs[i]; sxy += xs[i] * ys[i]
    }
    const det = n * sx2 - sx * sx
    if (Math.abs(det) < 1e-12) return null
    const a = (sy * sx2 - sx * sxy) / det
    const b = (n * sxy - sx * sy) / det
    return (x) => a + b * x
  }

  if (degree === 2) {
    let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0
    let sy = 0, sxy = 0, sx2y = 0
    for (let i = 0; i < n; i++) {
      const xi = xs[i], yi = ys[i], xi2 = xi * xi
      sx += xi; sx2 += xi2; sx3 += xi2 * xi; sx4 += xi2 * xi2
      sy += yi; sxy += xi * yi; sx2y += xi2 * yi
    }
    // Solve [n sx sx2; sx sx2 sx3; sx2 sx3 sx4] * [a;b;c] = [sy; sxy; sx2y]
    function det3(m) {
      return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
           - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
           + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    }
    const mat = [[n, sx, sx2], [sx, sx2, sx3], [sx2, sx3, sx4]]
    const rhs = [sy, sxy, sx2y]
    const D = det3(mat)
    if (Math.abs(D) < 1e-12) return null
    const a = det3([[rhs[0], mat[0][1], mat[0][2]], [rhs[1], mat[1][1], mat[1][2]], [rhs[2], mat[2][1], mat[2][2]]]) / D
    const b = det3([[mat[0][0], rhs[0], mat[0][2]], [mat[1][0], rhs[1], mat[1][2]], [mat[2][0], rhs[2], mat[2][2]]]) / D
    const c = det3([[mat[0][0], mat[0][1], rhs[0]], [mat[1][0], mat[1][1], rhs[1]], [mat[2][0], mat[2][1], rhs[2]]]) / D
    return (x) => a + b * x + c * x * x
  }

  return null
}

// ────────────────────────────────────────────────────────────────────
// Detection
// ────────────────────────────────────────────────────────────────────

/**
 * Single detection pass.
 * @param {number[]} eles
 * @param {ArrayLike<number>} dists
 * @param {Uint8Array|null} brunnelMask — indices to skip (bridge/tunnel approaches)
 * @param {object} o — merged opts
 * @returns {{ mask: Uint8Array, regions: Array }}
 */
function detectOnce(eles, dists, brunnelMask, o) {
  const N = eles.length
  const floor = morphOpen(eles, dists, o.openingRadiusM)

  // Flag positive spikes, honouring brunnel exclusions
  const flagged = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (brunnelMask && brunnelMask[i]) continue
    if (eles[i] - floor[i] > o.spikeThresholdM) flagged[i] = 1
  }

  // Group consecutive flagged indices into runs
  const runs = []
  let runStart = -1
  for (let i = 0; i < N; i++) {
    if (flagged[i] && runStart === -1) { runStart = i }
    else if (!flagged[i] && runStart !== -1) { runs.push([runStart, i - 1]); runStart = -1 }
  }
  if (runStart !== -1) runs.push([runStart, N - 1])

  if (runs.length === 0) return { mask: new Uint8Array(N), regions: [] }

  // Expand each run by regionBufferM and record max spike
  const expanded = runs.map(([lo, hi]) => {
    const loM = dists[lo]
    const hiM = dists[hi]
    const loExp = bsearchDists(dists, loM - o.regionBufferM)
    const hiExp = Math.min(N - 1, bsearchDists(dists, hiM + o.regionBufferM + 1) - 1)
    let maxSpike = 0
    for (let j = lo; j <= hi; j++) {
      const spike = eles[j] - floor[j]
      if (spike > maxSpike) maxSpike = spike
    }
    return { lo: loExp, hi: hiExp, loM: dists[loExp], hiM: dists[hiExp], maxSpike }
  })

  // Merge overlapping expanded runs
  const merged = []
  for (const r of expanded) {
    if (merged.length && r.lo <= merged[merged.length - 1].hi) {
      const prev = merged[merged.length - 1]
      if (r.hi > prev.hi) { prev.hi = r.hi; prev.hiM = dists[r.hi] }
      if (r.maxSpike > prev.maxSpike) prev.maxSpike = r.maxSpike
    } else {
      merged.push({ ...r })
    }
  }

  // Discard regions narrower than minArtifactWidthM
  const regions = merged.filter(r => r.hiM - r.loM >= o.minArtifactWidthM)

  // Build mask from final regions
  const mask = new Uint8Array(N)
  for (const r of regions) {
    for (let j = r.lo; j <= r.hi; j++) mask[j] = 1
  }

  return { mask, regions }
}

// ────────────────────────────────────────────────────────────────────
// Correction
// ────────────────────────────────────────────────────────────────────

/**
 * Correct a single artifact region in place by polynomial fit through
 * clean neighbours, with cosine-taper blending at the edges.
 *
 * @param {number[]} eles — mutated in place
 * @param {ArrayLike<number>} dists
 * @param {{ lo, hi, loM, hiM }} region
 * @param {object} o — merged opts
 */
function correctRegion(eles, dists, region, o) {
  const { lo, hi, loM, hiM } = region
  const N = eles.length
  const widthM = hiM - loM
  const midM = (loM + hiM) / 2
  const degree = widthM < 50 ? 1 : Math.min(2, o.maxPolyDegree)

  // Gather clean context points on both sides
  const ctxXs = []
  const ctxYs = []
  const ctxLo = loM - o.fitContextM
  const ctxHi = hiM + o.fitContextM
  for (let j = 0; j < N; j++) {
    const d = dists[j]
    if (d >= ctxLo && d < loM) { ctxXs.push(d - midM); ctxYs.push(eles[j]) }
    else if (d > hiM && d <= ctxHi) { ctxXs.push(d - midM); ctxYs.push(eles[j]) }
  }

  // Build evaluator: polynomial if enough context, else linear between boundaries
  let evalFn
  const poly = fitPoly(ctxXs, ctxYs, degree)
  if (poly) {
    evalFn = (d) => poly(d - midM)
  } else {
    // Fall back to linear interpolation between the nearest clean boundary points
    const loAnchorIdx = Math.max(0, lo - 1)
    const hiAnchorIdx = Math.min(N - 1, hi + 1)
    const e0 = eles[loAnchorIdx], d0 = dists[loAnchorIdx]
    const e1 = eles[hiAnchorIdx], d1 = dists[hiAnchorIdx]
    if (d1 > d0) {
      evalFn = (d) => e0 + (e1 - e0) * (d - d0) / (d1 - d0)
    } else {
      evalFn = (_d) => e0
    }
  }

  // Compute blend zone widths in indices
  const leftBlendEnd = Math.min(hi, bsearchDists(dists, loM + o.blendM))
  const rightBlendStart = Math.max(lo, bsearchDists(dists, hiM - o.blendM))

  const leftBlendN = Math.max(1, leftBlendEnd - lo)
  const rightBlendN = Math.max(1, hi - rightBlendStart)

  // Apply correction with cosine-taper blending
  for (let i = lo; i <= hi; i++) {
    const newVal = evalFn(dists[i])
    let blend = 1.0  // fully new value in the interior

    if (i <= leftBlendEnd && i < rightBlendStart) {
      // Left taper: 0 at edge, 1 at interior
      const k = i - lo
      blend = (1 - Math.cos(Math.PI * k / leftBlendN)) / 2
    } else if (i >= rightBlendStart && i > leftBlendEnd) {
      // Right taper: 1 at interior, 0 at edge
      const k = hi - i
      blend = (1 - Math.cos(Math.PI * k / rightBlendN)) / 2
    }

    eles[i] = (1 - blend) * eles[i] + blend * newVal
  }
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Detection only — returns boolean mask of flagged points.
 *
 * @param {number[]} eles — elevations in metres
 * @param {ArrayLike<number>} dists — cumulative distances in metres
 * @param {object} [opts] — override DEFAULT_OPTS
 * @param {Uint8Array|null} [brunnelMask] — points to exclude from detection
 * @returns {{ mask: Uint8Array, regions: object[] }}
 */
export function detectVegetation(eles, dists, opts = {}, brunnelMask = null) {
  const o = { ...DEFAULT_OPTS, ...opts }
  return detectOnce(eles, dists, brunnelMask, o)
}

/**
 * Detect and correct vegetation artifacts in elevation profile.
 *
 * @param {number[]} eles — elevations in metres
 * @param {ArrayLike<number>} dists — cumulative distances in metres
 * @param {object} [opts] — override DEFAULT_OPTS
 * @param {Uint8Array|null} [brunnelMask] — points to exclude from detection
 * @returns {{ eles: number[], diagnostics: { flaggedMask: Uint8Array, regions: object[], totalFlagged: number, iterations: number } }}
 */
export function filterVegetation(eles, dists, opts = {}, brunnelMask = null) {
  const o = { ...DEFAULT_OPTS, ...opts }
  const corrected = eles.slice()
  let prevCount = 0
  let firstMask = new Uint8Array(eles.length)
  let firstRegions = []
  let iterations = 0

  for (let pass = 0; pass < o.maxIterations; pass++) {
    const { mask, regions } = detectOnce(corrected, dists, brunnelMask, o)
    const newCount = mask.reduce((s, v) => s + v, 0)

    iterations = pass + 1

    // Diagnostics always reflect the first-pass detection (what was originally found)
    if (pass === 0) {
      firstMask = mask
      firstRegions = regions
    }

    if (regions.length === 0) break

    // Apply corrections for this pass
    for (const region of regions) {
      correctRegion(corrected, dists, region, o)
    }

    // Converged when the number of flagged points barely changes
    if (Math.abs(newCount - prevCount) < o.convergenceThreshold) break
    prevCount = newCount
  }

  return {
    eles: corrected,
    diagnostics: {
      flaggedMask: firstMask,
      regions: firstRegions,
      totalFlagged: firstMask.reduce((s, v) => s + v, 0),
      iterations,
    },
  }
}

/**
 * Human-readable summary of vegetation filter results.
 *
 * @param {ArrayLike<number>} dists
 * @param {number[]} original — elevations before correction
 * @param {number[]} corrected — elevations after correction
 * @param {object[]} regions
 * @returns {string}
 */
export function vegetationReport(dists, original, corrected, regions) {
  if (!regions || regions.length === 0) return 'Vegetation filter: no artifacts detected.'

  let totalCorrected = 0
  for (let i = 0; i < original.length; i++) {
    if (Math.abs(original[i] - corrected[i]) > 0.01) totalCorrected++
  }

  let report = `Vegetation filter: ${regions.length} artifact region(s), ${totalCorrected} points corrected.`
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]
    const loM = Math.round(r.loM)
    const hiM = Math.round(r.hiM)
    report += `\n  Region ${i + 1}: ${loM}–${hiM}m (${hiM - loM}m wide, max spike ${r.maxSpike.toFixed(1)}m)`
  }
  return report
}
