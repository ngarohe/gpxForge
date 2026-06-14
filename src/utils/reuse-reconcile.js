/**
 * Reuse reconciliation — make every pass of a REUSED course segment vertex-identical in XY **and** Z.
 *
 * The Course Builder graph models reuse as "one segment referenced N times": `compileRouteGraph`
 * already emits each pass from the same `seg.points` (reversed for reverse arcs), so the *compiled*
 * track is bit-identical per pass. But the cleanup pipeline (LIDAR fill → artifact clean → smooth →
 * manual edits) runs on the FLAT track and treats each pass in its own neighbourhood — so the passes
 * drift apart (LIDAR samples the same road slightly differently each pass; cleaning/manual edits are
 * per-occurrence and can't be reproduced identically). BikeTerra then renders two ghost roads, and a
 * lap gets a different elevation each time.
 *
 * The graph knows exactly which output spans are the same segment, so we re-impose identity
 * deterministically (no geometric guessing): pick ONE authority pass per reused segment and stamp its
 * exact interior vertices (XY+Z, reversed for opposite-direction passes) onto every sibling pass. The
 * junction endpoints are left untouched (all passes already meet a junction at the same pinned node),
 * so the splice is seamless and the road BETWEEN junctions becomes one shared set of vertices.
 *
 * Authority = the pass the user last edited (edited-pass-wins), else the first pass.
 *
 * Pure — no DOM, no ST. The provenance (`courseArcs`) is captured at `finishCourseBuilder` and survives
 * the pipeline because it is described by invariant data (each arc's length + its two junction-node
 * coords), re-mapped onto whatever the current track is by cumulative distance + nearest-node refine.
 */

import { haversine, cumulativeDistances } from './math.js'

/**
 * Map each course arc to an inclusive [lo, hi] index range in the current flat track.
 *
 * Arcs TILE the track end-to-end (the course is contiguous), so boundaries are placed by cumulative
 * arc length (scaled to the current total distance — robust to the per-arc length drift that clean/
 * smooth introduce) and then refined to the nearest approach to the boundary node's coords (which pins
 * each boundary exactly on its junction, and disambiguates which pass a revisited junction belongs to,
 * because the search is sequential/monotonic along the track).
 *
 * @param {{lats:number[],lons:number[],eles:number[],dists?:number[]}} track
 * @param {Array<{segId:string,dir:string,lengthM:number,from:{lat,lon},to:{lat,lon}}>} courseArcs
 * @param {{ refineWinM?:number }} [opts]
 * @returns {Array<{lo:number,hi:number}>} one range per arc (or [] if not mappable)
 */
export function mapArcsToRanges(track, courseArcs, opts = {}) {
  const { lats, lons } = track
  const N = lats.length
  if (N < 2 || !courseArcs || courseArcs.length === 0) return []
  const dists = (track.dists && track.dists.length === N) ? track.dists : cumulativeDistances(lats, lons)
  const total = dists[N - 1] || 1
  const arcTotal = courseArcs.reduce((s, a) => s + (a.lengthM || 0), 0) || 1
  const scale = total / arcTotal
  const refineWinM = opts.refineWinM ?? 40

  // Boundary node coords (B0 = arc0.from, then each arc's .to) + their expected cumulative distance.
  const boundaries = [courseArcs[0].from, ...courseArcs.map((a) => a.to)]
  const boundaryDist = [0]
  let cum = 0
  for (const a of courseArcs) { cum += (a.lengthM || 0) * scale; boundaryDist.push(cum) }

  // Find the track index nearest `coord`, near the expected distance, searching from `from` onward.
  const idxAt = (targetDist, coord, from) => {
    let approx = Math.max(from, 0)
    while (approx < N - 1 && dists[approx] < targetDist) approx++
    const d0 = dists[approx]
    let bi = approx, bd = Infinity
    for (let i = approx; i >= from && d0 - dists[i] <= refineWinM; i--) {
      const d = haversine(lats[i], lons[i], coord.lat, coord.lon); if (d < bd) { bd = d; bi = i }
    }
    for (let i = approx + 1; i < N && dists[i] - d0 <= refineWinM; i++) {
      const d = haversine(lats[i], lons[i], coord.lat, coord.lon); if (d < bd) { bd = d; bi = i }
    }
    return bi
  }

  const bIdx = [0]
  let prev = 0
  for (let k = 1; k < boundaries.length - 1; k++) {
    let i = idxAt(boundaryDist[k], boundaries[k], prev + 1)
    if (i <= prev) i = prev + 1
    if (i >= N - 1) i = N - 2 // keep room for remaining boundaries + the final end
    bIdx.push(i); prev = i
  }
  bIdx.push(N - 1)

  const ranges = []
  for (let k = 0; k < courseArcs.length; k++) ranges.push({ lo: bIdx[k], hi: bIdx[k + 1] })
  return ranges
}

/**
 * Force every reused course segment's passes to share one set of interior vertices (XY+Z).
 *
 * @param {{lats:number[],lons:number[],eles:number[],dists?:number[]}} track
 * @param {Array} courseArcs — provenance (see mapArcsToRanges)
 * @param {{ authority?:Object<string,number>, refineWinM?:number }} [opts]
 *   authority: { [segId]: arcIndex } — the winning pass per segment (edited-pass-wins); default = first.
 * @returns {{ lats:number[], lons:number[], eles:number[], reused:number } | null}
 *   null when there is no reused segment (nothing to do).
 */
export function reconcileReusedRoads(track, courseArcs, opts = {}) {
  const ranges = mapArcsToRanges(track, courseArcs, opts)
  if (!ranges.length) return null
  const authorityOf = opts.authority || {}

  // Group arc indices by segId.
  const groups = new Map()
  courseArcs.forEach((a, i) => {
    if (!groups.has(a.segId)) groups.set(a.segId, [])
    groups.get(a.segId).push(i)
  })

  // Build interior-replacements for every sibling pass.
  const repl = []  // { lo, hi, interior:[{lat,lon,ele}] }
  let reused = 0
  for (const [segId, idxs] of groups) {
    if (idxs.length < 2) continue
    reused++
    const authIdx = (authorityOf[segId] != null && idxs.includes(authorityOf[segId])) ? authorityOf[segId] : idxs[0]
    const aR = ranges[authIdx]
    // Authority interior (exclude the two junction endpoints — those are already shared/pinned).
    const aInterior = []
    for (let i = aR.lo + 1; i <= aR.hi - 1; i++) aInterior.push({ lat: track.lats[i], lon: track.lons[i], ele: track.eles[i] })
    for (const mIdx of idxs) {
      if (mIdx === authIdx) continue
      const reversed = courseArcs[mIdx].dir !== courseArcs[authIdx].dir
      const interior = reversed ? aInterior.slice().reverse() : aInterior.slice()
      repl.push({ lo: ranges[mIdx].lo, hi: ranges[mIdx].hi, interior })
    }
  }
  if (!repl.length) return null

  // Apply last-to-first so earlier indices stay valid. Replace the INTERIOR (lo+1..hi-1), keeping the
  // sibling's own junction endpoints at lo and hi (identical to the authority's anyway).
  repl.sort((a, b) => b.lo - a.lo)
  let lats = track.lats.slice(), lons = track.lons.slice(), eles = track.eles.slice()
  for (const r of repl) {
    const nl = [], no = [], ne = []
    for (let i = 0; i <= r.lo; i++) { nl.push(lats[i]); no.push(lons[i]); ne.push(eles[i]) }
    for (const p of r.interior) { nl.push(p.lat); no.push(p.lon); ne.push(p.ele) }
    for (let i = r.hi; i < lats.length; i++) { nl.push(lats[i]); no.push(lons[i]); ne.push(eles[i]) }
    lats = nl; lons = no; eles = ne
  }
  return { lats, lons, eles, reused }
}

/**
 * Whether any course segment is reused (≥2 passes) — gates the "Unify reused roads" affordance.
 * @param {Array} courseArcs
 * @returns {boolean}
 */
export function hasReusedSegments(courseArcs) {
  if (!courseArcs || courseArcs.length < 2) return false
  const seen = new Set()
  for (const a of courseArcs) { if (seen.has(a.segId)) return true; seen.add(a.segId) }
  return false
}

/**
 * Which course segment ids a track index range [lo,hi] overlaps — used to set "edited-pass-wins"
 * authority: after the user edits a stretch, the arc(s) it overlaps become the winning passes.
 * @returns {Object<string,number>} { [segId]: arcIndex } for the overlapped arcs.
 */
export function authorityForEditedRange(track, courseArcs, lo, hi, opts = {}) {
  const ranges = mapArcsToRanges(track, courseArcs, opts)
  const out = {}
  const a = Math.min(lo, hi), b = Math.max(lo, hi)
  ranges.forEach((r, i) => {
    if (r.lo <= b && r.hi >= a) out[courseArcs[i].segId] = i  // overlaps the edit (last wins)
  })
  return out
}
