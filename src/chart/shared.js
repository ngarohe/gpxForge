/**
 * Chart shared infrastructure — constants, DPR setup, coordinate
 * transforms, gradient color cache.
 *
 * Used by elevation.js and gradient.js.
 */

import { ST } from '../state.js'
import { clamp, bsearchDists } from '../utils/math.js'
import { gradColor, smoothGradForDisplay } from '../utils/format.js'
import { getViewRange } from '../sync.js'

// ────────────────────────────────────────────────────────────────────
// Padding constants
// ────────────────────────────────────────────────────────────────────

/** Main + gradient chart padding (px). */
export const PAD = { l: 52, r: 12, t: 16, b: 22 }

/** Maximum gradient clip (±25%). */
export const GRAD_CLIP = 25

// ────────────────────────────────────────────────────────────────────
// DPR-aware canvas setup
// ────────────────────────────────────────────────────────────────────

/** Cache of last-known physical pixel dimensions per canvas. */
const _cvSizes = new WeakMap()

/**
 * Prepare a canvas for rendering at the correct DPR.
 * Only resets physical pixel size when container dimensions change
 * (avoids expensive GPU buffer reallocation on every draw).
 * @param {HTMLCanvasElement} cv
 * @returns {{ ctx: CanvasRenderingContext2D, W: number, H: number }}
 */
export function setupCv(cv) {
  const W = cv.offsetWidth || cv.parentElement?.offsetWidth || 800
  const H = cv.offsetHeight || cv.parentElement?.offsetHeight || 200
  const dpr = devicePixelRatio || 1
  const pw = W * dpr, ph = H * dpr
  const prev = _cvSizes.get(cv)
  if (!prev || prev.pw !== pw || prev.ph !== ph) {
    cv.width = pw
    cv.height = ph
    _cvSizes.set(cv, { pw, ph })
  }
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  return { ctx, W, H }
}

// ────────────────────────────────────────────────────────────────────
// Axis label helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Compute a "nice" step size for axis labels.
 * Returns values like 1, 2, 5, 10, 20, 50, 100, …
 * @param {number} rough — approximate step size
 * @returns {number}
 */
export function niceStep(rough) {
  if (rough <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const f = rough / mag
  if (f < 1.5) return mag
  if (f < 3) return 2 * mag
  if (f < 7) return 5 * mag
  return 10 * mag
}

// ────────────────────────────────────────────────────────────────────
// Visible range (binary search)
// ────────────────────────────────────────────────────────────────────

/**
 * Find the index range of points visible within [lo, hi] metres.
 * Adds one extra point on each side for line continuity.
 * @param {ArrayLike<number>} dists — cumulative distances
 * @param {number} lo — viewport start in metres
 * @param {number} hi — viewport end in metres
 * @returns {{ iLo: number, iHi: number }}
 */
export function visibleRange(dists, lo, hi) {
  const N = dists.length
  const iLo = Math.max(0, bsearchDists(dists, lo) - 1)
  const iHi = Math.min(N - 1, bsearchDists(dists, hi))
  return { iLo, iHi }
}

/**
 * Map a distance on the ORIGINAL route to the nearest index in the
 * smoothed route (ST.smoothedRoute), using a binary search over the
 * monotonic origDists (or proportionally-scaled dists when origDists is
 * absent). Replaces the old O(n) linear scans that ran on every hover.
 * @param {number} distM — distance on the original route (metres)
 * @returns {number} index into ST.smoothedRoute arrays, or -1 if none
 */
export function smoothedIndexForDist(distM) {
  const sr = ST.smoothedRoute
  if (!sr) return -1
  const sd = sr.dists
  const od = sr.origDists
  let xDist, target
  if (od) {
    xDist = od
    target = distM
  } else {
    xDist = sd
    const sTotal = sd[sd.length - 1]
    const oTotal = ST.dists[ST.dists.length - 1]
    target = oTotal > 0 ? distM * sTotal / oTotal : distM
  }
  const j = bsearchDists(xDist, target)
  if (j > 0 && Math.abs(xDist[j - 1] - target) < Math.abs(xDist[j] - target)) return j - 1
  return j
}

/**
 * Reduce a dense visible index range to a compact draw list with at most
 * a few points per horizontal pixel, while preserving the min/max value
 * envelope so the rendered line/area is visually identical. Returns
 * indices in ascending order.
 *
 * For long routes (post-smooth = ~1 point/metre) this caps the per-frame
 * draw work at ~4× the canvas pixel width instead of the full point count,
 * eliminating tens of thousands of wasted sub-pixel draw operations.
 *
 * @param {number} iLo — first index (inclusive)
 * @param {number} iHi — last index (inclusive)
 * @param {(i: number) => number} xOf — index → pixel x
 * @param {(i: number) => number} vOf — index → value (min/max preserved)
 * @returns {number[]} ascending list of indices to draw
 */
export function columnSamples(iLo, iHi, xOf, vOf) {
  const out = []
  if (iHi - iLo < 2) {
    for (let i = iLo; i <= iHi; i++) out.push(i)
    return out
  }
  // Hot loop: avoid per-column array allocation / sort and cache vOf() reads.
  const push = k => { if (out.length === 0 || out[out.length - 1] !== k) out.push(k) }
  let curCol = Math.round(xOf(iLo))
  let firstI = iLo, lastI = iLo, minI = iLo, maxI = iLo
  let minV = vOf(iLo), maxV = minV
  const flush = () => {
    push(firstI)
    // firstI ≤ minI,maxI ≤ lastI within a column, so order the two extremes.
    const a = minI < maxI ? minI : maxI
    const b = minI < maxI ? maxI : minI
    if (a > firstI && a < lastI) push(a)
    if (b > firstI && b < lastI && b !== a) push(b)
    if (lastI !== firstI) push(lastI)
  }
  for (let i = iLo + 1; i <= iHi; i++) {
    const c = Math.round(xOf(i))
    if (c !== curCol) {
      flush()
      curCol = c
      firstI = lastI = minI = maxI = i
      minV = maxV = vOf(i)
    } else {
      const v = vOf(i)
      if (v < minV) { minV = v; minI = i }
      if (v > maxV) { maxV = v; maxI = i }
      lastI = i
    }
  }
  flush()
  return out
}

/**
 * Same pixel-column min/max reduction as columnSamples, but iterating an
 * ascending list of representative indices (`env`) restricted to those whose
 * value lies in [iLo, iHi]. Used to draw from a min/max LOD instead of the
 * full point array — see getEnvelopeIndices / columnSamplesCached.
 */
function columnSamplesList(env, iLo, iHi, xOf, vOf) {
  const m = env.length
  // First env entry ≥ iLo and one-past last ≤ iHi (env is strictly ascending).
  let s = 0, e = m
  { let lo = 0, hi = m; while (lo < hi) { const mid = (lo + hi) >> 1; if (env[mid] < iLo) lo = mid + 1; else hi = mid } s = lo }
  { let lo = s, hi = m; while (lo < hi) { const mid = (lo + hi) >> 1; if (env[mid] <= iHi) lo = mid + 1; else hi = mid } e = lo }
  const out = []
  if (e - s < 3) { for (let k = s; k < e; k++) out.push(env[k]); return out }
  const push = k => { if (out.length === 0 || out[out.length - 1] !== k) out.push(k) }
  let i0 = env[s]
  let curCol = Math.round(xOf(i0))
  let firstI = i0, lastI = i0, minI = i0, maxI = i0
  let minV = vOf(i0), maxV = minV
  const flush = () => {
    push(firstI)
    const a = minI < maxI ? minI : maxI
    const b = minI < maxI ? maxI : minI
    if (a > firstI && a < lastI) push(a)
    if (b > firstI && b < lastI && b !== a) push(b)
    if (lastI !== firstI) push(lastI)
  }
  for (let k = s + 1; k < e; k++) {
    const i = env[k]
    const c = Math.round(xOf(i))
    if (c !== curCol) {
      flush()
      curCol = c
      firstI = lastI = minI = maxI = i
      minV = maxV = vOf(i)
    } else {
      const v = vOf(i)
      if (v < minV) { minV = v; minI = i }
      if (v > maxV) { maxV = v; maxI = i }
      lastI = i
    }
  }
  flush()
  return out
}

/** Target number of LOD buckets; envelope holds ≤ 2× this many indices. */
const LOD_BUCKETS = 8000
/** Above this many visible points, draw from the LOD envelope, else scan raw. */
const ENVELOPE_THRESHOLD = 2 * LOD_BUCKETS

/**
 * Build (and cache, by array identity) a min/max level-of-detail index for a
 * value array: the route is split into fixed buckets of ~N/LOD_BUCKETS points
 * and the index of each bucket's min and max value is kept, in ascending order.
 *
 * Drawing from this envelope preserves the exact min/max profile (no visible
 * change) while bounding a full-view redraw to ~2·LOD_BUCKETS points instead of
 * the full ~1m point count — so cache-miss frames during a zoom gesture stay
 * cheap. Cached in a WeakMap keyed by the array, so it auto-invalidates when
 * the underlying array is replaced (every smoothedRoute/gpx change swaps refs).
 *
 * @param {ArrayLike<number>} arr
 * @returns {Int32Array} ascending representative indices
 */
const _lodCache = new WeakMap()
function getEnvelopeIndices(arr) {
  const cached = _lodCache.get(arr)
  if (cached) return cached
  const n = arr.length
  const bucket = Math.max(1, Math.ceil(n / LOD_BUCKETS))
  const tmp = []
  for (let b = 0; b < n; b += bucket) {
    const hi = Math.min(n, b + bucket)
    let mn = b, mx = b
    for (let i = b + 1; i < hi; i++) {
      if (arr[i] < arr[mn]) mn = i
      if (arr[i] > arr[mx]) mx = i
    }
    const a = mn < mx ? mn : mx
    const c = mn < mx ? mx : mn
    tmp.push(a)
    if (c !== a) tmp.push(c)
  }
  const env = Int32Array.from(tmp)
  _lodCache.set(arr, env)
  return env
}

/**
 * Viewport-keyed memo for the per-line draw samples. Two-level fast path:
 *
 *  1. **Cache** — the sample list depends only on the array, viewport, and
 *     canvas width; none change while hovering, so hover reuses the list.
 *  2. **LOD** — on a cache miss with many visible points (zoom gesture, initial
 *     draw), scan a precomputed min/max envelope instead of every raw point;
 *     when zoomed in past ENVELOPE_THRESHOLD visible points, scan raw for exact
 *     detail. Either way the work is bounded and the min/max profile is exact.
 *
 * @param {string} tag — stable per-call-site id (e.g. 'smEle')
 * @param {string} sig — viewport signature (lo/hi/width/scale)
 * @param {*} arrRef — the value array, by identity
 * @param {number} iLo
 * @param {number} iHi
 * @param {(i:number)=>number} xOf
 * @param {(i:number)=>number} vOf
 * @returns {number[]}
 */
const _csCache = new Map()
export function columnSamplesCached(tag, sig, arrRef, iLo, iHi, xOf, vOf) {
  const c = _csCache.get(tag)
  if (c && c.sig === sig && c.arrRef === arrRef && c.iLo === iLo && c.iHi === iHi) {
    return c.samples
  }
  const samples = (iHi - iLo + 1) <= ENVELOPE_THRESHOLD
    ? columnSamples(iLo, iHi, xOf, vOf)
    : columnSamplesList(getEnvelopeIndices(arrRef), iLo, iHi, xOf, vOf)
  _csCache.set(tag, { sig, arrRef, iLo, iHi, samples })
  return samples
}

// ────────────────────────────────────────────────────────────────────
// Coordinate transform factories
// ────────────────────────────────────────────────────────────────────

/**
 * Create a distance-to-pixel-X transform.
 * @param {number} lo — viewport start metres
 * @param {number} hi — viewport end metres
 * @param {number} cw — content width in pixels
 * @param {number} padL — left padding
 * @returns {(d: number) => number}
 */
export function makeXp(lo, hi, cw, padL = PAD.l) {
  const range = hi - lo || 1
  return d => padL + (d - lo) / range * cw
}

/**
 * Create an elevation-to-pixel-Y transform.
 * @param {number} minE — minimum elevation
 * @param {number} eRange — elevation range (max - min)
 * @param {number} ch — content height in pixels
 * @param {number} padT — top padding
 * @returns {(e: number) => number}
 */
export function makeYp(minE, eRange, ch, padT = PAD.t) {
  const range = eRange || 1
  return e => padT + ch - (e - minE) / range * ch
}

// ────────────────────────────────────────────────────────────────────
// Mouse → distance conversion
// ────────────────────────────────────────────────────────────────────

/**
 * Convert a mouse event on a chart canvas to a data index + distance.
 * @param {MouseEvent} ev
 * @param {HTMLCanvasElement} cv
 * @param {{ l: number, r: number }} [pad] — padding constants
 * @returns {{ xFrac: number, distM: number, idx: number } | null}
 */
export function evToDistIdx(ev, cv, pad = PAD) {
  const rect = cv.getBoundingClientRect()
  const xFrac = (ev.clientX - rect.left - pad.l) / (rect.width - pad.l - pad.r)
  if (xFrac < 0 || xFrac > 1) return null

  const { lo, hi } = getViewRange()
  const distM = lo + xFrac * (hi - lo)

  // Binary search + check neighbours for nearest index
  const j = bsearchDists(ST.dists, distM)
  const best = (j > 0 && Math.abs(ST.dists[j - 1] - distM) < Math.abs(ST.dists[j] - distM))
    ? j - 1 : j

  return { xFrac, distM, idx: best }
}

// ────────────────────────────────────────────────────────────────────
// Correction hit testing
// ────────────────────────────────────────────────────────────────────

/**
 * Find the correction at a given distance.
 * First tries exact containment, then falls back to nearest center.
 * @param {number} distM — distance in metres
 * @returns {number} correction index, or -1 if none
 */
export function hitTestCorrection(distM) {
  if (!ST.corrections || !ST.corrections.length) return -1

  let best = -1, bestD = Infinity
  for (let i = 0; i < ST.corrections.length; i++) {
    const c = ST.corrections[i]
    // Exact containment wins immediately
    if (distM >= ST.dists[c.alo] && distM <= ST.dists[c.ahi]) return i
    // Track nearest center as fallback
    const mid = (ST.dists[c.alo] + ST.dists[c.ahi]) / 2
    const d = Math.abs(distM - mid)
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

// ────────────────────────────────────────────────────────────────────
// Anchor handle hit testing
// ────────────────────────────────────────────────────────────────────

/**
 * Check if a mouse position is over an anchor triangle handle.
 * @param {number} clientX
 * @param {number} clientY
 * @param {HTMLCanvasElement} cv
 * @returns {object|null} — { corrIdx, which, idx, x, hy, hs } or null
 */
export function findAnchorHandle(clientX, clientY, cv) {
  const rect = cv.getBoundingClientRect()
  const mx = clientX - rect.left
  const my = clientY - rect.top
  if (!ST._anchorHandles) return null

  for (const h of ST._anchorHandles) {
    if (Math.abs(mx - h.x) < 10 && my >= h.hy && my <= h.hy + h.hs + 4) return h
  }
  return null
}

// ────────────────────────────────────────────────────────────────────
// Gradient color cache
// ────────────────────────────────────────────────────────────────────

let _smoothColors = null

/**
 * Pre-compute smoothed gradient colors for rendering.
 * Call after gradient data changes.
 * @param {number[]} grArr — gradient array (%)
 */
export function buildColors(grArr) {
  if (!grArr) { _smoothColors = null; return }
  const sm = smoothGradForDisplay(grArr, 9)
  _smoothColors = sm.map(gradColor)
}

/**
 * Get the cached smooth gradient colors.
 * Falls back to raw gradient colors if cache is empty.
 * @returns {string[]|null}
 */
export function getSmoothColors() {
  if (_smoothColors) return _smoothColors
  if (ST.grOrig) return ST.grOrig.map(gradColor)
  return null
}

/** Clear the gradient color cache (call on data reset). */
export function clearSmoothColors() {
  _smoothColors = null
}
