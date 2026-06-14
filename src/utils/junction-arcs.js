/**
 * Per-movement junction arcs — round the sharp arc-joins of a compiled topology
 * course by TURN ANGLE, after the pure `compileRouteGraph` step.
 *
 * `compileRouteGraph` pins each arc's endpoints to node coords, so a built course
 * has hard corners where one leg turns onto another at a junction and a 180° fold
 * at an out-and-back turnaround. `roundJunctions` walks the interior arc-joins
 * (the `arcBounds` from the compiler — every interior bound is a node = a movement)
 * and rounds each by the local turn angle:
 *
 *   - straight-through (< shallowDeg): leave the node EXACT (a crossing pass is
 *     physically a point; rounding it would pull the route off both roads);
 *   - turn (shallowDeg..uTurnDeg): inscribe a tangent arc with `filletCorner`
 *     (geometry.js) at the node vertex — the "per-movement junction arc";
 *   - U-turn (≥ uTurnDeg): a native teardrop/bulb with `buildTurnaround`
 *     (lane-split.js) — degrades to a clean semicircle when the two legs coincide
 *     (the vertex-identical out-and-back case).
 *
 * The single turn-angle gate is the crossing-vs-turn-vs-U-turn discriminator — no
 * junction-degree classification is needed; each movement is rounded locally. Joins
 * are spliced HIGH-INDEX-FIRST so earlier indices stay valid, and a window-overlap
 * guard skips a join whose rounding region would collide with one already rounded.
 *
 * Pure — no DOM, no ST. Reuses existing geometry primitives; nothing duplicated.
 */

import { haversine } from './math.js'
import { filletCorner, circumscribedRadius3 } from './geometry.js'
import { buildTurnaround } from './lane-split.js'

const M_PER_DEG_LAT = 111320
const mPerDegLon = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)

/** Unit direction (local metres) from index a to index b. */
function dirUnit(lats, lons, a, b) {
  const mLon = mPerDegLon(lats[a])
  let dx = (lons[b] - lons[a]) * mLon
  let dy = (lats[b] - lats[a]) * M_PER_DEG_LAT
  const len = Math.hypot(dx, dy) || 1
  return [dx / len, dy / len]
}

/** Largest index i ≤ j with cumulative distance(i→j) ≥ distM (clamped to 0). */
function walkBack(lats, lons, j, distM) {
  let acc = 0
  for (let i = j; i > 0; i--) {
    acc += haversine(lats[i - 1], lons[i - 1], lats[i], lons[i])
    if (acc >= distM) return i - 1
  }
  return 0
}

/** Smallest index i ≥ j with cumulative distance(j→i) ≥ distM (clamped to N−1). */
function walkFwd(lats, lons, j, distM) {
  const N = lats.length
  let acc = 0
  for (let i = j; i < N - 1; i++) {
    acc += haversine(lats[i], lons[i], lats[i + 1], lons[i + 1])
    if (acc >= distM) return i + 1
  }
  return N - 1
}

/** Index in [lo,hi] of the route point nearest (lat,lon). */
function nearestIdxTo(lats, lons, lat, lon, lo, hi) {
  let best = lo, bd = Infinity
  for (let i = lo; i <= hi; i++) {
    const d = haversine(lats[i], lons[i], lat, lon)
    if (d < bd) { bd = d; best = i }
  }
  return best
}

/** Tightest circumscribed radius at the join itself (min over J−1, J, J+1). */
function joinRadius(lats, lons, j) {
  let min = Infinity
  for (let i = Math.max(1, j - 1); i <= Math.min(lats.length - 2, j + 1); i++) {
    const r = circumscribedRadius3(lats, lons, i)
    if (r < min) min = r
  }
  return min
}

/** Linear elevation ramp across `count` inserted points from e0 to e1 (inclusive ends). */
function rampEles(e0, e1, count) {
  const out = new Array(count)
  for (let i = 0; i < count; i++) out[i] = count > 1 ? e0 + (e1 - e0) * (i / (count - 1)) : e0
  return out
}

/**
 * Round the interior arc-joins of a compiled course by turn angle.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} eles
 * @param {number[]} arcBounds — `compileRouteGraph` arc-start indices; interior
 *   entries (i ≥ 1) are the node joins to consider.
 * @param {object} [opts]
 *   - targetRadiusM (6.5) fillet radius; minR (6) teardrop radius
 *   - shallowDeg (25) below this a join is left exact (crossing/gentle)
 *   - uTurnDeg (150) at/above this a join is teardropped instead of filleted
 *   - anchorM (10) leg length sampled for the local turn direction / fillet refs
 *   - spacingM (0.3) arc point spacing
 * @returns {{ lats:number[], lons:number[], eles:number[], rounded:number, teardrops:number }}
 */
export function roundJunctions(lats, lons, eles, arcBounds = [], opts = {}) {
  const targetRadiusM = opts.targetRadiusM ?? 6.5
  const minR = opts.minR ?? 6
  const shallowDeg = opts.shallowDeg ?? 25
  const uTurnDeg = opts.uTurnDeg ?? 150
  const anchorM = opts.anchorM ?? 10
  const spacingM = opts.spacingM ?? 0.3

  const oLats = [...lats], oLons = [...lons], oEles = [...eles]
  if (oLats.length < 3 || arcBounds.length < 2) {
    return { lats: oLats, lons: oLons, eles: oEles, rounded: 0, teardrops: 0 }
  }

  // Interior joins only (skip arc 0's start — it's the route start, not a join).
  // `compileRouteGraph` drops the duplicate join, so the node sits at the LAST
  // point of the previous arc = arcBounds[i] − 1 (arcBounds[i] is the first NEW
  // point after the join). Processed high-index-first so earlier indices stay
  // valid during splicing.
  const joins = arcBounds.slice(1).map((b) => b - 1).filter((j) => j > 1 && j < oLats.length - 2)
  joins.sort((a, b) => b - a)

  let rounded = 0, teardrops = 0
  let floor = oLats.length // lowest already-rounded index; guards window overlap

  const gateM = opts.gateM ?? 3

  for (const J of joins) {
    if (J <= 1 || J >= oLats.length - 2) continue

    const prevIdx = walkBack(oLats, oLons, J, anchorM)
    const nextIdx = walkFwd(oLats, oLons, J, anchorM)
    if (prevIdx >= J || nextIdx <= J) continue

    // GATE on the SINGLE-VERTEX turn at the node (immediate neighbours), not a
    // multi-point turn. A built-course node butt turns its full angle at the one
    // node point (straight legs meet there); an already-smooth road bend on a
    // decomposed/faithful route eases its turn across many points, so its
    // per-vertex turn is small → skipped. This is what distinguishes a genuine
    // butt (round it) from an eased corner the snap step already handled (leave
    // it — filleting curved legs would only ADD a seam kink). Long anchors below
    // are kept only for the fillet's leg DIRECTION, where a stable tangent helps.
    const [gix, giy] = dirUnit(oLats, oLons, J - 1, J)
    const [gox, goy] = dirUnit(oLats, oLons, J, J + 1)
    const gDot = Math.max(-1, Math.min(1, gix * gox + giy * goy))
    const turnDeg = (Math.acos(gDot) * 180) / Math.PI

    if (turnDeg < shallowDeg) continue // crossing / smooth continuation — keep exact

    const isUTurn = turnDeg >= uTurnDeg
    // A vertex-identical fold has COINCIDENT legs (J−1 ≈ J+1) → a degenerate
    // triangle, so circumscribedRadius3 returns Infinity. A collinear 180°
    // reversal is maximally sharp (radius 0), so map that case to 0 for U-turns.
    let existingR = joinRadius(oLats, oLons, J)
    if (isUTurn && existingR === Infinity) existingR = 0
    if (existingR >= (isUTurn ? minR : targetRadiusM)) continue

    let insertLats, insertLons, ei, xi
    // A near-antiparallel join (legs almost reversed) can't take an inscribed fillet —
    // filletCorner returns null. That's an offset turnaround (e.g. an UNMERGED out-and-back
    // a few metres wide): the single-vertex turn reads < uTurnDeg but the legs are reversed.
    // Fall back to a teardrop so the apex still blends instead of being left as a kink.
    let f = null
    if (!isUTurn) {
      f = filletCorner(
        oLats[prevIdx], oLons[prevIdx], oLats[J], oLons[J], oLats[nextIdx], oLons[nextIdx],
        targetRadiusM, spacingM,
      )
    }
    const teardrop = isUTurn || !f || !f.points || f.points.length < 2
    if (!teardrop) {
      // ── Per-movement junction arc: inscribed fillet at the node vertex ──
      // The gate guarantees straight legs at the node, so the arc's tangent
      // points sit on the route at f.tangentDist along each leg → clean seam.
      ei = walkBack(oLats, oLons, J, f.tangentDist)
      xi = walkFwd(oLats, oLons, J, f.tangentDist)
      insertLats = f.points.map((p) => p.lat)
      insertLons = f.points.map((p) => p.lon)
    } else {
      // ── Teardrop: native bulb connecting the trimmed leg ends ──
      const trimM = Math.max(minR, opts.turnTrimM ?? minR)
      ei = walkBack(oLats, oLons, J, trimM)
      xi = walkFwd(oLats, oLons, J, trimM)
      const eOut = { lat: oLats[ei], lon: oLons[ei] }
      const eBack = { lat: oLats[xi], lon: oLons[xi] }
      const pEnd = { lat: oLats[J], lon: oLons[J] }
      const fwd = dirUnit(oLats, oLons, ei, J) // inbound, toward the apex
      const bulb = buildTurnaround(eOut, eBack, pEnd, fwd, minR)
      if (!bulb || !bulb.length) continue
      insertLats = bulb.map((p) => p.lat)
      insertLons = bulb.map((p) => p.lon)
    }

    if (ei < 0 || xi >= floor || ei >= xi) continue // overlap guard / degenerate

    // Splice: keep ei and xi as anchors, replace the interior (ei+1 .. xi-1) with
    // the rounded geometry, elevation ramped across it from eles[ei] to eles[xi].
    const delCount = xi - ei - 1
    const insEles = rampEles(oEles[ei], oEles[xi], insertLats.length)
    oLats.splice(ei + 1, delCount, ...insertLats)
    oLons.splice(ei + 1, delCount, ...insertLons)
    oEles.splice(ei + 1, delCount, ...insEles)

    floor = ei
    if (teardrop) teardrops++; else rounded++
  }

  return { lats: oLats, lons: oLons, eles: oEles, rounded, teardrops }
}
