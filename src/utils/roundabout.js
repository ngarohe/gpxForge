/**
 * Roundabout DETECTION (highlight only).
 *
 * A roundabout ring is a single OSM way tagged `junction=roundabout`. The brunnel
 * / way-matching step tags each route point with a way ID and a `roundabout` flag
 * (Valhalla `edge.roundabout === true`, or the Overpass `junction` tag). This
 * module turns those per-point flags into structured roundabout TRAVERSALS — each
 * a run of consecutive roundabout-flagged points on one ring way, with the entry
 * and exit indices where the route joins and leaves the ring.
 *
 * It DETECTS only. The earlier canonical-ring unify / directed ring-cycle subgraph
 * stages were removed in the GPXmagic-style rework: substituting canonical-ring
 * geometry pulled the snapped edges off-line (kinks) and the per-pair ring cycle
 * fragmented the roundabout into many tiny segments. In the new model a roundabout
 * is just the real snapped arcs between its real entry/exit nodes (found via the
 * generic crossing/overlap decomposition), traversed N times.
 *
 * Pure — no DOM, no network, no ST.
 */


/**
 * Detect roundabout traversals from per-point roundabout flags + way IDs.
 *
 * A traversal is a maximal run of consecutive points with `roundaboutFlags[i] === 1`.
 * Each run is attributed to a ring way ID (the dominant non-zero way ID within the
 * run — robust to a stray edge-match at the entry/exit point). Runs shorter than
 * `minPoints` are dropped (noise). The entry/exit are the points just OUTSIDE the
 * run (the approach/exit road), clamped to the route ends.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {Uint8Array|number[]} roundaboutFlags — 1 = point is on a roundabout ring
 * @param {Uint32Array|number[]} [wayIds] — OSM way ID per point (for ringWayId)
 * @param {{ minPoints?: number }} [opts]
 * @returns {Array<{ lo:number, hi:number, entryIdx:number, exitIdx:number, ringWayId:number, points:number }>}
 *   lo..hi = inclusive run of on-ring points; entryIdx/exitIdx = the approach/exit
 *   point just outside the run; ringWayId = the ring's OSM way ID (0 if unknown).
 */
export function detectRoundabouts(lats, lons, roundaboutFlags, wayIds = null, opts = {}) {
  const minPoints = opts.minPoints ?? 2
  const N = lats.length
  const out = []
  if (!roundaboutFlags || roundaboutFlags.length !== N || N === 0) return out

  let i = 0
  while (i < N) {
    if (!roundaboutFlags[i]) { i++; continue }
    let j = i
    while (j + 1 < N && roundaboutFlags[j + 1]) j++

    if (j - i + 1 >= minPoints) {
      out.push({
        lo: i,
        hi: j,
        entryIdx: Math.max(0, i - 1),
        exitIdx: Math.min(N - 1, j + 1),
        ringWayId: dominantWayId(wayIds, i, j),
        points: j - i + 1,
      })
    }
    i = j + 1
  }
  return out
}

/** Most-frequent non-zero way ID over [lo,hi]; 0 if none/unknown. */
function dominantWayId(wayIds, lo, hi) {
  if (!wayIds) return 0
  const counts = new Map()
  for (let i = lo; i <= hi; i++) {
    const w = wayIds[i]
    if (!w) continue
    counts.set(w, (counts.get(w) || 0) + 1)
  }
  let best = 0, bestN = 0
  for (const [w, n] of counts) if (n > bestN) { bestN = n; best = w }
  return best
}

/**
 * Group detected traversals by ring way ID — multiple passes over the SAME
 * roundabout (a multi-lap course) share a ring and should later reuse one
 * canonical ring (vertex-identity).
 *
 * @param {ReturnType<typeof detectRoundabouts>} traversals
 * @returns {Map<number, Array>} ringWayId → traversals (way ID 0 = ungrouped/unknown,
 *   each such traversal kept separate under a unique negative synthetic key).
 */
export function groupByRing(traversals) {
  const groups = new Map()
  let synthetic = -1
  for (const t of traversals) {
    const key = t.ringWayId || synthetic--
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }
  return groups
}
