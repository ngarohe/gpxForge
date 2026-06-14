/**
 * Build a routable node/leg GRAPH from a set of OSM ways (Course Builder's area mode).
 *
 * The same authoritative-data move that makes junction detection work: an OSM way's vertices are
 * EXACT shared coordinates, so where two ways cross they list the *same* vertex. We split every
 * way at the vertices it shares with another way (and at its own endpoints) — each inter-node span
 * becomes a segment, each shared vertex becomes ONE node. The result is the standard
 * `{ nodes, segments, route }` graph that `compileRouteGraph` and the course-assembly state machine
 * already consume; `route` starts empty (nothing picked yet — the user builds the course by clicking).
 *
 * Pure — no DOM, no ST, no network.
 */

/** Exact-coordinate key for an OSM vertex (6 dp ≈ 0.1 m; matches Overpass `out geom` precision). */
const nodeKey = (lat, lon) => lat.toFixed(6) + ',' + lon.toFixed(6)

const M_PER_DEG_LAT = 111320

/** Equirectangular metric distance (m) — cheap, fine at street scale. */
function distM(aLat, aLon, bLat, bLon) {
  const midLat = (aLat + bLat) / 2
  const dy = (aLat - bLat) * M_PER_DEG_LAT
  const dx = (aLon - bLon) * M_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180)
  return Math.hypot(dx, dy)
}

/**
 * Foot of the perpendicular from point P onto segment A→B, in local metres. Returns the squared
 * distance (m²) and the clamped parameter t∈[0,1] of the foot along A→B.
 */
function projOnSeg(plat, plon, alat, alon, blat, blon) {
  const midLat = (alat + blat) / 2
  const kx = M_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180), ky = M_PER_DEG_LAT
  const ax = alon * kx, ay = alat * ky, bx = blon * kx, by = blat * ky, px = plon * kx, py = plat * ky
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const fx = ax + t * dx, fy = ay + t * dy
  return { d2: (px - fx) ** 2 + (py - fy) ** 2, t }
}

/**
 * Map-match an imported track onto a network graph by NEAREST SEGMENT → an ordered course
 * `[{segment, dir}]` that is a PATH through the network. This is the deterministic replacement for
 * topology-from-noisy-GPS: each track point is assigned to the road it's on (nearest segment, with a
 * stickiness bias so it doesn't flicker onto a parallel road), the ridden segments fall out as runs,
 * and the run's direction comes from how the foot-of-perpendicular advances along the segment. Because
 * nearest-segment is stable under GPS jitter (unlike a proximity threshold), the SAME crossing yields
 * the SAME course every recording. Reuse is free — a road ridden N times is the same segment N runs.
 *
 * Consecutive runs that don't already share a node are bridged by a bounded BFS through the network
 * (a direct link is one hop; a skipped short connector or an intersection the matcher flickered past is
 * a few hops) so the emitted course is CONNECTED and compiles. An un-bridgeable jump (a real off-network
 * gap, or a far flicker onto a parallel road) drops that arc rather than leaving a disconnect — this is
 * what fixes the "route[i] starts at X but previous arc ended at Y (disconnected)" compile error.
 *
 * @param {{ nodes:Object, segments:Object }} graph
 * @param {{ lats:number[], lons:number[] }} track
 * @param {{ snapM?:number, stickyM?:number, minRunPts?:number, maxHops?:number }} [opts]
 *   snapM (25) max point→segment distance to match; stickyM (8) keep the current segment if it's within
 *   bestDist+stickyM (anti-parallel-road flicker); minRunPts (2) drop runs shorter than this (noise);
 *   maxHops (8) BFS depth when bridging a gap between consecutive runs.
 * @returns {Array<{segment:string, dir:'forward'|'reverse'}>}
 */
export function matchTrackToNetwork(graph, track, opts = {}) {
  const snapM = opts.snapM ?? 25
  const stickyM = opts.stickyM ?? 8
  const minRunPts = opts.minRunPts ?? 2
  const maxHops = opts.maxHops ?? 8
  const segs = graph?.segments || {}
  const segIds = Object.keys(segs)
  const N = track?.lats?.length || 0
  if (!segIds.length || N < 2) return []

  // Per-track-point: nearest segment + foot parameter, with stickiness to the previous match.
  const snap2 = snapM * snapM, sticky2Extra = stickyM * stickyM
  let prev = null
  const matched = [] // { seg, t } | null
  for (let i = 0; i < N; i++) {
    const plat = track.lats[i], plon = track.lons[i]
    let best = null, bestD2 = snap2, bestT = 0
    for (const id of segIds) {
      const pts = segs[id].points
      let segD2 = Infinity, segT = 0
      for (let k = 0; k < pts.length - 1; k++) {
        const r = projOnSeg(plat, plon, pts[k].lat, pts[k].lon, pts[k + 1].lat, pts[k + 1].lon)
        if (r.d2 < segD2) { segD2 = r.d2; segT = (k + r.t) / (pts.length - 1) }
      }
      if (segD2 < bestD2) { bestD2 = segD2; best = id; bestT = segT }
    }
    // Stickiness: keep the previous segment if it's still essentially as close (parallel-road guard).
    if (prev && best !== prev) {
      const pp = segs[prev].points
      let pD2 = Infinity, pT = 0
      for (let k = 0; k < pp.length - 1; k++) {
        const r = projOnSeg(plat, plon, pp[k].lat, pp[k].lon, pp[k + 1].lat, pp[k + 1].lon)
        if (r.d2 < pD2) { pD2 = r.d2; pT = (k + r.t) / (pp.length - 1) }
      }
      if (pD2 <= snap2 && pD2 <= bestD2 + sticky2Extra) { best = prev; bestT = pT }
    }
    matched.push(best ? { seg: best, t: bestT } : null)
    if (best) prev = best
  }

  return arcsFromMatched(segs, matched, { minRunPts, maxHops })
}

/**
 * Turn a per-sample segment assignment into a CONNECTED course `[{segment, dir}]`.
 *
 * Shared output stage for both matchers (nearest-segment and the HMM): collapse consecutive
 * same-segment samples into runs (direction from how the along-segment parameter `t` advances), drop
 * noise runs, then bridge any gap between consecutive runs with a bounded BFS through the network so
 * the result is always connected (an un-bridgeable jump drops that run rather than emit a disconnect).
 *
 * @param {Object} segs — graph.segments
 * @param {Array<{seg:string, t:number}|null>} matched — one entry per track sample (null = unmatched)
 * @param {{ minRunPts?:number, maxHops?:number }} [opts]
 * @returns {Array<{segment:string, dir:'forward'|'reverse'}>}
 */
export function arcsFromMatched(segs, matched, opts = {}) {
  const minRunPts = opts.minRunPts ?? 2
  const maxHops = opts.maxHops ?? 8
  const segIds = Object.keys(segs)

  // Collapse consecutive same-segment matches into runs (ignoring unmatched gaps within a run).
  const runs = []
  for (const m of matched) {
    if (!m) continue
    const last = runs[runs.length - 1]
    if (last && last.seg === m.seg) { last.tEnd = m.t; last.n++ }
    else runs.push({ seg: m.seg, tStart: m.t, tEnd: m.t, n: 1 })
  }

  // Drop noise runs, then emit one arc per run (direction from how t advanced).
  const arcs = []
  for (const r of runs) {
    if (r.n < minRunPts) continue
    const dir = r.tEnd >= r.tStart ? 'forward' : 'reverse'
    const a = arcs[arcs.length - 1]
    if (a && a.segment === r.seg && a.dir === dir) continue // merge a split run on the same pass
    arcs.push({ segment: r.seg, dir })
  }

  // Bridge consecutive arcs that don't meet at a shared node via a bounded BFS through the network
  // (direct link = 1 hop; a skipped short connector = a few hops). An un-bridgeable jump drops the arc
  // so the output is always CONNECTED (and compiles) — never a disconnect.
  const endNode = (arc) => arc.dir === 'forward' ? segs[arc.segment].to : segs[arc.segment].from
  const startNode = (arc) => arc.dir === 'forward' ? segs[arc.segment].from : segs[arc.segment].to
  const adj = new Map()
  for (const id of segIds) {
    const s = segs[id]
    if (!adj.has(s.from)) adj.set(s.from, [])
    if (!adj.has(s.to)) adj.set(s.to, [])
    adj.get(s.from).push({ to: s.to, segment: id, dir: 'forward' })
    adj.get(s.to).push({ to: s.from, segment: id, dir: 'reverse' })
  }
  const bfsBridge = (a, b) => {
    if (a === b) return []
    const prev = new Map([[a, null]])
    const depth = new Map([[a, 0]])
    const queue = [a]
    while (queue.length) {
      const cur = queue.shift()
      if (depth.get(cur) >= maxHops) continue
      for (const e of (adj.get(cur) || [])) {
        if (prev.has(e.to)) continue
        prev.set(e.to, { from: cur, arc: { segment: e.segment, dir: e.dir } })
        depth.set(e.to, depth.get(cur) + 1)
        if (e.to === b) {
          const path = []
          let n = b
          while (prev.get(n)) { path.unshift(prev.get(n).arc); n = prev.get(n).from }
          return path
        }
        queue.push(e.to)
      }
    }
    return null
  }
  const out = []
  let curEnd = null
  for (const arc of arcs) {
    if (!out.length) { out.push(arc); curEnd = endNode(arc); continue }
    const want = startNode(arc)
    if (want === curEnd) { out.push(arc); curEnd = endNode(arc); continue }
    const bridge = bfsBridge(curEnd, want)
    if (bridge) { for (const b of bridge) out.push(b); out.push(arc); curEnd = endNode(arc) }
    // else: un-bridgeable jump (off-network / far flicker) → drop this arc, keep the connected path.
  }
  return out
}

/**
 * Map-match an imported track onto a network graph → an ordered, CONNECTED course `[{segment, dir}]`.
 *
 * Pure. The track is map-matched in two robustness passes so a real (offset, noisy) GPS ride is
 * actually traced, not left empty:
 *   1. Each track point snaps to its nearest graph node within `snapM`; the deduplicated sequence of
 *      visited nodes is the ridden node order. `snapM` is generous (GPS sits a lane-width off the OSM
 *      node, and intersection nodes are sparse).
 *   2. Consecutive visited nodes are connected: a DIRECT segment if one exists, else a **bounded BFS**
 *      (≤`maxHops`) finds the short network path between them — this fills the gaps where the ride
 *      skipped an intersection's snap or wove between lanes, yielding a connected course instead of
 *      isolated arcs. A pair with no path within `maxHops` is left as a gap (the user fills it).
 *
 * @param {{ nodes:Object, segments:Object }} graph
 * @param {{ lats:number[], lons:number[] }} track
 * @param {{ snapM?:number, maxHops?:number }} [opts] — snapM (35) max node-snap; maxHops (5) BFS depth.
 * @returns {Array<{segment:string, dir:'forward'|'reverse'}>}
 */
export function pretraceTrack(graph, track, opts = {}) {
  const snapM = opts.snapM ?? 35
  const maxHops = opts.maxHops ?? 5
  const nodes = graph.nodes || {}
  const nodeIds = Object.keys(nodes)
  if (!nodeIds.length || !track || !track.lats || track.lats.length < 2) return []

  const nearestNode = (lat, lon) => {
    let best = null, bestD = snapM
    for (const id of nodeIds) {
      const d = distM(lat, lon, nodes[id].lat, nodes[id].lon)
      if (d < bestD) { bestD = d; best = id }
    }
    return best
  }
  const visited = []
  for (let i = 0; i < track.lats.length; i++) {
    const n = nearestNode(track.lats[i], track.lons[i])
    if (n && (visited.length === 0 || visited[visited.length - 1] !== n)) visited.push(n)
  }
  if (visited.length < 2) return []

  // Direct-segment lookup + an adjacency list for BFS gap-filling. Arc shape is {segment, dir}
  // (what compileRouteGraph consumes — NOT {id, dir}).
  const segByEnds = new Map() // "a|b" → { segment, dir }
  const adj = new Map()       // nodeId → [{ to, id, dir }]
  const pushAdj = (from, entry) => { if (!adj.has(from)) adj.set(from, []); adj.get(from).push(entry) }
  for (const [id, s] of Object.entries(graph.segments)) {
    segByEnds.set(s.from + '|' + s.to, { segment: id, dir: 'forward' })
    segByEnds.set(s.to + '|' + s.from, { segment: id, dir: 'reverse' })
    pushAdj(s.from, { to: s.to, id, dir: 'forward' })
    pushAdj(s.to, { to: s.from, id, dir: 'reverse' })
  }

  // BFS the shortest arc path a→b within maxHops (avoids immediately re-using the arc we arrived on).
  const bfsPath = (a, b) => {
    if (a === b) return []
    const queue = [a]
    const prev = new Map([[a, null]]) // node → { from, arc } | null
    let depth = new Map([[a, 0]])
    while (queue.length) {
      const cur = queue.shift()
      if (depth.get(cur) >= maxHops) continue
      for (const e of (adj.get(cur) || [])) {
        if (prev.has(e.to)) continue
        prev.set(e.to, { from: cur, arc: { segment: e.id, dir: e.dir } })
        depth.set(e.to, depth.get(cur) + 1)
        if (e.to === b) {
          const arcs = []
          let n = b
          while (prev.get(n)) { arcs.unshift(prev.get(n).arc); n = prev.get(n).from }
          return arcs
        }
        queue.push(e.to)
      }
    }
    return null
  }

  const course = []
  for (let k = 1; k < visited.length; k++) {
    const a = visited[k - 1], b = visited[k]
    const direct = segByEnds.get(a + '|' + b)
    if (direct) { course.push(direct); continue }
    const path = bfsPath(a, b)
    if (path && path.length) for (const arc of path) course.push(arc)
    // else: no path within maxHops → leave a gap for the user to fill.
  }
  return course
}

/**
 * Split OSM ways at shared vertices into a node/leg graph.
 *
 * @param {Array<{ id:number, points:Array<{lat,lon}>, highway?:string, oneway?:boolean,
 *   roundabout?:boolean, layer?:number, bridge?:boolean, tunnel?:boolean }>} ways
 * @param {{}} [opts]
 * @returns {{ nodes:Object, segments:Object, route:Array }}
 */
export function buildNetworkGraph(ways, opts = {}) {
  const graph = { nodes: {}, segments: {}, route: [] }
  if (!Array.isArray(ways) || ways.length === 0) return graph

  // Pass 1 — count how often each vertex coordinate is referenced, and which are way endpoints.
  // A vertex is a graph NODE iff it is an endpoint of some way OR it is shared (referenced ≥2× —
  // by two different ways at a crossing/T, or twice within one self-touching way). Interior
  // vertices used by exactly one way are NOT nodes, so an isolated road stays one segment.
  const incidence = new Map() // key → total occurrences across all ways
  const endpointKeys = new Set()
  for (const w of ways) {
    const pts = w.points
    if (!pts || pts.length < 2) continue
    for (const p of pts) {
      const k = nodeKey(p.lat, p.lon)
      incidence.set(k, (incidence.get(k) || 0) + 1)
    }
    endpointKeys.add(nodeKey(pts[0].lat, pts[0].lon))
    endpointKeys.add(nodeKey(pts[pts.length - 1].lat, pts[pts.length - 1].lon))
  }
  const isNode = (k) => endpointKeys.has(k) || (incidence.get(k) || 0) >= 2

  // Node-id allocation: one id per distinct node-key, deterministic by first encounter.
  const nodeIdByKey = new Map()
  let nodeSeq = 0
  const nodeIdFor = (lat, lon) => {
    const k = nodeKey(lat, lon)
    let id = nodeIdByKey.get(k)
    if (id == null) {
      id = 'n' + nodeSeq++
      nodeIdByKey.set(k, id)
      graph.nodes[id] = { lat, lon, ele: 0 }
    }
    return id
  }

  // Pass 2 — split each way at node vertices into segments.
  let segSeq = 0
  for (const w of ways) {
    const pts = w.points
    if (!pts || pts.length < 2) continue
    const tags = {
      highway: w.highway || '',
      oneway: !!w.oneway,
      roundabout: !!w.roundabout,
      layer: Number.isFinite(w.layer) ? w.layer : 0,
      bridge: !!w.bridge,
      tunnel: !!w.tunnel,
    }
    let startI = 0
    for (let i = 1; i < pts.length; i++) {
      const k = nodeKey(pts[i].lat, pts[i].lon)
      const atEnd = i === pts.length - 1
      if (!isNode(k) && !atEnd) continue
      // Close a segment from pts[startI] (a node) to pts[i] (a node).
      const fromId = nodeIdFor(pts[startI].lat, pts[startI].lon)
      const toId = nodeIdFor(pts[i].lat, pts[i].lon)
      const slice = []
      for (let j = startI; j <= i; j++) slice.push({ lat: pts[j].lat, lon: pts[j].lon, ele: 0 })
      // Skip degenerate zero-length segments (e.g. a duplicated coordinate).
      if (slice.length >= 2 && !(fromId === toId && slice.length === 2 &&
            slice[0].lat === slice[1].lat && slice[0].lon === slice[1].lon)) {
        graph.segments['s' + segSeq++] = {
          from: fromId, to: toId, points: slice, wayId: w.id, ...tags,
        }
      }
      startI = i
    }
  }

  return graph
}

/**
 * Locate junctions on an imported track using OSM INTERSECTION vertices — a Valhalla-FREE junction
 * source (Valhalla `/trace_attributes` is frequently overloaded, which leaves the geometric decompose
 * with duplicate nodes at crossings). The exact recorded geometry is kept; we only decide WHERE to cut
 * and which cuts are the SAME junction.
 *
 * For each network node that is a real intersection (degree ≥ `minDegree`), find every place the route
 * passes within `maxM` of it — each separate close approach = one pass through that junction. All those
 * route indices belong to ONE junction (the exact OSM vertex), so a multipass ride that revisits a
 * junction gets a single shared node there with every direction it took: the OSM-junction model,
 * without Valhalla.
 *
 * @param {{lats:number[],lons:number[]}} route
 * @param {{nodes:Object,segments:Object}} net — from buildNetworkGraph(ways)
 * @param {{ maxM?:number, minDegree?:number }} [opts]
 * @returns {Array<{ lat:number, lon:number, indices:number[] }>} one entry per intersection the route
 *   uses; `indices` = the route index of each pass's nearest approach to it.
 */
export function junctionsFromNetwork(route, net, opts = {}) {
  const maxM = opts.maxM ?? 10
  const minDegree = opts.minDegree ?? 3
  const clusterM = opts.clusterM ?? 20      // OSM nodes within this = ONE physical junction
  const { lats, lons } = route
  const N = lats?.length || 0
  if (N < 2 || !net || !net.nodes) return []

  // Degree of each network node (segment endpoints touching it).
  const deg = {}
  for (const s of Object.values(net.segments || {})) {
    deg[s.from] = (deg[s.from] || 0) + 1
    deg[s.to] = (deg[s.to] || 0) + 1
  }
  const intersections = []
  for (const [id, n] of Object.entries(net.nodes)) if ((deg[id] || 0) >= minDegree) intersections.push(n)
  if (!intersections.length) return []

  // Cluster intersection POINTS within clusterM into ONE physical junction (a real crossing is often
  // modelled as several OSM nodes a few metres apart — medians, staggered ways). Cutting the route at
  // each separately leaves a tiny segment between them → a kink at compile; the Valhalla decompose path
  // clusters the same way (clusterNodes, 22 m).
  const clusters = []
  for (const ix of intersections) {
    let host = null
    for (const c of clusters) { if (distM(c.lat, c.lon, ix.lat, ix.lon) <= clusterM) { host = c; break } }
    if (host) {
      host.pts.push(ix)
      host.lat = host.pts.reduce((s, p) => s + p.lat, 0) / host.pts.length
      host.lon = host.pts.reduce((s, p) => s + p.lon, 0) / host.pts.length
    } else {
      clusters.push({ lat: ix.lat, lon: ix.lon, pts: [ix] })
    }
  }

  // One visit index per PASS: a contiguous run where the route is within maxM of ANY cluster member is
  // one pass through that junction (record the point nearest the cluster centroid). Because the members'
  // maxM circles overlap (they're within clusterM ≤ 2·maxM), a pass that threads several of them is one
  // run → one visit — no fragile index-gap heuristic, and distinct passes stay separate.
  const merged = []
  for (const c of clusters) {
    const near = (i) => c.pts.some((p) => distM(lats[i], lons[i], p.lat, p.lon) <= maxM)
    const visits = []
    let i = 0
    while (i < N) {
      if (near(i)) {
        let bj = i, bd = Infinity, j = i
        while (j < N && near(j)) { const d = distM(lats[j], lons[j], c.lat, c.lon); if (d < bd) { bd = d; bj = j } j++ }
        visits.push(bj); i = j
      } else i++
    }
    if (visits.length) merged.push({ lat: c.lat, lon: c.lon, indices: visits })
  }
  return merged
}
