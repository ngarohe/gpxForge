/**
 * Pure geometry transforms for the Split-step track editor.
 *
 * Each function takes and returns plain `{ lats, lons, eles }` triples
 * (parallel arrays of equal length). No DOM, no ST — fully unit-testable.
 * Distance/gradient arrays are NOT carried; the caller rebuilds them after
 * applying a transform (see setActiveRoute in main.js).
 */

import { haversine, cumulativeDistances } from './math.js'
import { smoothPositions } from './geometry.js'

/**
 * Reverse the route direction (swap start ↔ end).
 * @param {{lats:number[], lons:number[], eles:number[]}} route
 * @returns {{lats:number[], lons:number[], eles:number[]}}
 */
export function reverseTrack(route) {
  return {
    lats: [...route.lats].reverse(),
    lons: [...route.lons].reverse(),
    eles: [...route.eles].reverse(),
  }
}

/**
 * Offset the elevation of a section by `delta` metres — the Z analogue of the
 * lateral lane offset. Within `[lo, hi]` the delta is applied with a cos² ramp
 * over `rampM` of route distance at each end, so the raised/lowered stretch joins
 * the surrounding terrain smoothly (no vertical wall at the seam). When the
 * section spans the whole route (or `rampM <= 0`) the delta is applied flat.
 * Pure — returns a new `eles` array (input untouched).
 *
 * @param {number[]} eles
 * @param {number[]|Float64Array} dists — cumulative distances (m), same length
 * @param {number} lo @param {number} hi — inclusive section bounds
 * @param {number} delta — metres to add (positive = up, negative = down)
 * @param {number} [rampM=30] — cos² transition length at each end (m)
 * @returns {number[]}
 */
export function offsetElevationSection(eles, dists, lo, hi, delta, rampM = 30) {
  const n = eles.length
  const out = eles.slice ? eles.slice() : Array.from(eles)
  let a = Math.max(0, Math.min(lo, hi))
  let b = Math.min(n - 1, Math.max(lo, hi))
  if (b <= a) return out
  const dA = dists[a]
  const dB = dists[b]
  const span = dB - dA
  const wholeRoute = a === 0 && b === n - 1
  const ramp = wholeRoute ? 0 : Math.max(0, Math.min(rampM, span / 2))
  for (let i = a; i <= b; i++) {
    let w = 1
    if (ramp > 0) {
      const fromLo = dists[i] - dA
      const fromHi = dB - dists[i]
      if (fromLo < ramp) w = Math.sin((fromLo / ramp) * Math.PI / 2) ** 2
      if (fromHi < ramp) w = Math.min(w, Math.sin((fromHi / ramp) * Math.PI / 2) ** 2)
    }
    out[i] += delta * w
  }
  return out
}

/**
 * Whether a route is a closed loop — first and last points within thresholdM.
 * @param {{lats:number[], lons:number[]}} route
 * @param {number} [thresholdM=30]
 * @returns {boolean}
 */
export function isLoop(route, thresholdM = 30) {
  const n = route.lats.length
  if (n < 4) return false
  const d = haversine(route.lats[0], route.lons[0], route.lats[n - 1], route.lons[n - 1])
  return d <= thresholdM
}

/**
 * Rotate a looped route so index `pivot` becomes the new start/finish.
 * The route is re-closed: the duplicate closing point (if any) is dropped
 * before rotation, then a copy of the new first point is appended so the
 * result starts and ends at the pivot.
 *
 * @param {{lats:number[], lons:number[], eles:number[]}} route
 * @param {number} pivot — index in [0, n) to become the new start
 * @returns {{lats:number[], lons:number[], eles:number[]}}
 */
export function rotateLoopTrack(route, pivot) {
  const n = route.lats.length
  const rot = (arr) => {
    // Drop the duplicate closing point so the cycle has no repeat, rotate, re-close.
    const core = arr.slice(0, n - 1)
    const p = ((pivot % core.length) + core.length) % core.length
    const out = [...core.slice(p), ...core.slice(0, p)]
    out.push(out[0])
    return out
  }
  return { lats: rot(route.lats), lons: rot(route.lons), eles: rot(route.eles) }
}

/**
 * Choose how to join two tracks: evaluate all four endpoint pairings
 * (base+add, base+reverse(add), add+base, reverse(add)+base) and pick the
 * one with the smallest endpoint gap.
 *
 * @returns {{ first, second, baseSide:'first'|'second', addOriented, mode:string, gapM:number }}
 */
function chooseOrientation(base, add) {
  const a = base, b = add
  const aN = a.lats.length, bN = b.lats.length
  const aStart = [a.lats[0], a.lons[0]]
  const aEnd = [a.lats[aN - 1], a.lons[aN - 1]]
  const bStart = [b.lats[0], b.lons[0]]
  const bEnd = [b.lats[bN - 1], b.lons[bN - 1]]
  const d = (p, q) => haversine(p[0], p[1], q[0], q[1])
  const rev = reverseTrack(b)

  const candidates = [
    { mode: 'append',       gapM: d(aEnd, bStart),   first: a,   second: b,   baseSide: 'first',  addOriented: b },
    { mode: 'append-flip',  gapM: d(aEnd, bEnd),     first: a,   second: rev, baseSide: 'first',  addOriented: rev },
    { mode: 'prepend',      gapM: d(bEnd, aStart),   first: b,   second: a,   baseSide: 'second', addOriented: b },
    { mode: 'prepend-flip', gapM: d(bStart, aStart), first: rev, second: a,   baseSide: 'second', addOriented: rev },
  ]
  candidates.sort((x, y) => x.gapM - y.gapM)
  return candidates[0]
}

/** Distance (m) from point P to segment A–B, local equirectangular projection. */
function pointSegDistM(plat, plon, alat, alon, blat, blon) {
  const R = 6371000, toRad = Math.PI / 180
  const k = Math.cos((alat + blat) * 0.5 * toRad)
  const px = plon * k, py = plat
  const ax = alon * k, ay = alat
  const bx = blon * k, by = blat
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const ddx = px - (ax + t * dx), ddy = py - (ay + t * dy)
  return Math.sqrt(ddx * ddx + ddy * ddy) * toRad * R
}

/** Min distance (m) from point P to a polyline. */
function pointToPolylineDistM(plat, plon, lats, lons) {
  let min = Infinity
  for (let i = 0; i < lats.length - 1; i++) {
    const dd = pointSegDistM(plat, plon, lats[i], lons[i], lats[i + 1], lons[i + 1])
    if (dd < min) min = dd
    if (min === 0) break
  }
  return min
}

/**
 * Blend the seam of a freshly-merged route so position and gradient don't kink
 * at the join. XY is Gaussian-smoothed over a small radius (window ends pinned);
 * Z uses a pinned gradient average (matching the Smooth step's 4-point method),
 * so the rest of the route is untouched.
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles
 * @param {number} seamIdx — index of the first point of the second track
 * @param {{ xyRadiusM?:number, zHalfCount?:number }} [opts]
 * @returns {{ lats:number[], lons:number[], eles:number[] }}
 */
export function blendSeam(lats, lons, eles, seamIdx, opts = {}) {
  const xyRadiusM = opts.xyRadiusM ?? 3
  const zHalfCount = opts.zHalfCount ?? 4
  const N = lats.length
  if (N < 5 || seamIdx <= 1 || seamIdx >= N - 1) return { lats: [...lats], lons: [...lons], eles: [...eles] }

  const oLats = [...lats], oLons = [...lons], oEles = [...eles]
  let dists = cumulativeDistances(oLats, oLons)
  const Dseam = dists[seamIdx]

  // ── XY: localized Gaussian on a ±3σ window around the seam ──
  if (xyRadiusM > 0) {
    const halfWinM = Math.max(3 * xyRadiusM, 9)
    let pLo = seamIdx, pHi = seamIdx
    while (pLo > 0 && Dseam - dists[pLo - 1] <= halfWinM) pLo--
    while (pHi < N - 1 && dists[pHi + 1] - Dseam <= halfWinM) pHi++
    if (pHi - pLo >= 2) {
      const sl = smoothPositions(oLats.slice(pLo, pHi + 1), oLons.slice(pLo, pHi + 1), dists.slice(pLo, pHi + 1), xyRadiusM)
      for (let i = 1; i < sl.lats.length - 1; i++) { oLats[pLo + i] = sl.lats[i]; oLons[pLo + i] = sl.lons[i] }
      dists = cumulativeDistances(oLats, oLons) // positions moved
    }
  }

  // ── Z: pinned gradient average (±zHalfCount segments) around the seam ──
  if (zHalfCount > 0) {
    const lo = Math.max(0, seamIdx - 1 - 2 * zHalfCount)
    const hi = Math.min(N - 1, seamIdx + 2 * zHalfCount)
    if (hi - lo >= 2) {
      const gr = []
      for (let i = lo; i < hi; i++) { const dd = dists[i + 1] - dists[i]; gr.push(dd > 0 ? (oEles[i + 1] - oEles[i]) / dd : 0) }
      const avg = new Array(gr.length)
      for (let i = 0; i < gr.length; i++) {
        const a = Math.max(0, i - zHalfCount), b = Math.min(gr.length - 1, i + zHalfCount)
        let s = 0; for (let j = a; j <= b; j++) s += gr[j]; avg[i] = s / (b - a + 1)
      }
      // Re-integrate from the window start, then de-trend so both ends stay pinned.
      const prov = new Array(hi - lo + 1); prov[0] = oEles[lo]
      for (let i = 0; i < gr.length; i++) prov[i + 1] = prov[i] + avg[i] * (dists[lo + i + 1] - dists[lo + i])
      const span = dists[hi] - dists[lo] || 1
      const mismatch = oEles[hi] - prov[prov.length - 1]
      for (let i = 1; i < prov.length - 1; i++) {
        const frac = (dists[lo + i] - dists[lo]) / span
        oEles[lo + i] = prov[i] + mismatch * frac
      }
    }
  }

  return { lats: oLats, lons: oLons, eles: oEles }
}

/**
 * Merge a second track into a base track. Auto-orients (nearest endpoints meet),
 * optionally trims the overlapping stretch ("redone wins" — the base is cut back
 * to where the appended track diverges), and optionally blends the seam.
 *
 * @param {{lats:number[], lons:number[], eles:number[]}} base
 * @param {{lats:number[], lons:number[], eles:number[]}} add
 * @param {{ overlap?:boolean, overlapThreshM?:number, blend?:{xyRadiusM?:number, zHalfCount?:number}|null }} [opts]
 * @returns {{ lats:number[], lons:number[], eles:number[], gapM:number, mode:string,
 *             seamIdx:number, baseTrimmed:number }}
 */
export function mergeTracks(base, add, opts = {}) {
  const overlap = opts.overlap !== false
  const overlapThreshM = opts.overlapThreshM ?? 15
  const o = chooseOrientation(base, add)

  let first = o.first, second = o.second
  let baseTrimmed = 0

  if (overlap) {
    const addPoly = o.addOriented
    if (o.baseSide === 'first') {
      // base is `first`, joins at its tail → trim base points near the add polyline.
      let cut = first.lats.length
      while (cut > 2 && pointToPolylineDistM(first.lats[cut - 1], first.lons[cut - 1], addPoly.lats, addPoly.lons) <= overlapThreshM) cut--
      baseTrimmed = first.lats.length - cut
      if (baseTrimmed > 0) first = sliceTrack(first, 0, cut - 1)
    } else {
      // base is `second`, joins at its head → trim base points near the add polyline.
      let start = 0
      while (start < second.lats.length - 2 && pointToPolylineDistM(second.lats[start], second.lons[start], addPoly.lats, addPoly.lons) <= overlapThreshM) start++
      baseTrimmed = start
      if (baseTrimmed > 0) second = sliceTrack(second, start, second.lats.length - 1)
    }
  }

  // Recompute the actual join gap after any trim.
  const fN = first.lats.length
  const gapM = haversine(first.lats[fN - 1], first.lons[fN - 1], second.lats[0], second.lons[0])

  // Drop a duplicate seam point when the join is near-coincident.
  const dropFirst = gapM < 0.5 ? 1 : 0
  let lats = [...first.lats.slice(0, fN - dropFirst), ...second.lats]
  let lons = [...first.lons.slice(0, fN - dropFirst), ...second.lons]
  let eles = [...first.eles.slice(0, fN - dropFirst), ...second.eles]
  const seamIdx = fN - dropFirst

  if (opts.blend) {
    const blended = blendSeam(lats, lons, eles, seamIdx, opts.blend)
    lats = blended.lats; lons = blended.lons; eles = blended.eles
  }

  return { lats, lons, eles, gapM, mode: o.mode, seamIdx, baseTrimmed }
}

/**
 * Append a second track to a base track, auto-orienting so the two closest
 * endpoints meet (no overlap trim, no seam blend). Thin wrapper over
 * {@link mergeTracks} preserved for callers that just want a plain concat.
 *
 * @param {{lats:number[], lons:number[], eles:number[]}} base
 * @param {{lats:number[], lons:number[], eles:number[]}} add
 * @returns {{ lats:number[], lons:number[], eles:number[], gapM:number, mode:string }}
 */
export function appendTrack(base, add) {
  const { lats, lons, eles, gapM, mode } = mergeTracks(base, add, { overlap: false, blend: null })
  return { lats, lons, eles, gapM, mode }
}

/**
 * Slice a sub-range of the route (inclusive of both endpoints).
 * @param {{lats:number[], lons:number[], eles:number[]}} route
 * @param {number} alo — start index (inclusive)
 * @param {number} ahi — end index (inclusive)
 * @returns {{lats:number[], lons:number[], eles:number[]}}
 */
export function sliceTrack(route, alo, ahi) {
  const lo = Math.max(0, Math.min(alo, ahi))
  const hi = Math.min(route.lats.length - 1, Math.max(alo, ahi))
  return {
    lats: route.lats.slice(lo, hi + 1),
    lons: route.lons.slice(lo, hi + 1),
    eles: route.eles.slice(lo, hi + 1),
  }
}
