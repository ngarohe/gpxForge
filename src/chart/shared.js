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
