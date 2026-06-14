/**
 * Junction finder — from the OSM road graph, not geometry.
 *
 * The topology editor's PRIMARY junction detector. Earlier attempts (proximity clustering,
 * geometric H-collapse) all failed the same way: geometry can't tell a parallel road from a
 * junction leg, so they invented nodes between nearby roads and fragmented routes into tens of
 * legs. This detector instead reads the OSM graph nodes the route actually passes through
 * (`junctionNodes` from Valhalla `/trace_attributes` `edge.end_node`), whose coordinates are the
 * EXACT OSM vertices — bit-identical on every pass. Two passes through one junction therefore
 * anchor to the same point with NO proximity threshold, and two genuinely-distinct parallel
 * roads never share a node coordinate, so they can never be merged.
 *
 * A node becomes a topology junction only where the ROUTE ITSELF branches: across all the
 * route's passes through that exact OSM vertex, count the distinct incident edge directions
 * (half-edges, angularly deduped). ≥3 ⇒ a real branch (crossing / lap-junction / used T) ⇒
 * node it. Exactly 2 ⇒ a through-point or a plain out-and-back retrace ⇒ NOT a junction (this
 * is what keeps shared-road interiors and through-passes from over-noding — no overlap mask
 * needed). Turnarounds (180° folds, including mid-road U-turns with no OSM branch) are detected
 * separately and unioned in.
 *
 * `buildOsmHubGraph` then places ONE node per junction at its exact OSM centre and connects
 * every leg to it (GPXmagic-style hub), so every turning movement — including ones the recorded
 * track never made — is routable for course-building.
 *
 * Pure — no DOM, no ST.
 */

import { haversine, bearing, cumulativeDistances } from './math.js'
import { buildGraphFromRoute, mergeNodesInGraph } from './route-graph.js'

const M_PER_DEG_LAT = 111320

/** Full angular difference between two bearings, 0–180° (180 = exact reversal). */
function headingDelta(a, b) {
  let d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

const norm360 = (a) => ((a % 360) + 360) % 360

/** Greedy-cluster a list of bearings; return one representative per cluster (within mergeDeg). */
function dedupeAngles(angles, mergeDeg) {
  const reps = []
  for (const a of angles) {
    if (!reps.some((r) => headingDelta(r, a) <= mergeDeg)) reps.push(a)
  }
  return reps
}

/** Exact-coordinate key for an OSM vertex (6 dp ≈ 0.1 m; matches Valhalla polyline6 precision). */
const nodeKey = (lat, lon) => lat.toFixed(6) + ',' + lon.toFixed(6)

const centroidOf = (members) => ({
  lat: members.reduce((s, m) => s + m.lat, 0) / members.length,
  lon: members.reduce((s, m) => s + m.lon, 0) / members.length,
})

/**
 * Cluster OSM vertices that belong to ONE physical junction (a staggered crossing, or the two
 * ends of a short connector that OSM models between two roads) into groups. Growth is bounded by
 * the running centroid (not single-link), so a chain of nodes along a road can't snowball — only
 * genuinely compact groups (within ~clusterM of their centre) merge.
 * @returns {Array<Array<{lat,lon,headings:number[]}>>}
 */
function clusterNodes(nodes, clusterM) {
  const used = new Array(nodes.length).fill(false)
  const out = []
  for (let i = 0; i < nodes.length; i++) {
    if (used[i]) continue
    used[i] = true
    const group = [nodes[i]]
    let c = { lat: nodes[i].lat, lon: nodes[i].lon }
    let grew = true
    while (grew) {
      grew = false
      for (let b = 0; b < nodes.length; b++) {
        if (used[b]) continue
        if (haversine(c.lat, c.lon, nodes[b].lat, nodes[b].lon) <= clusterM) {
          used[b] = true; group.push(nodes[b]); c = centroidOf(group); grew = true
        }
      }
    }
    out.push(group)
  }
  return out
}

/**
 * Visits of the route to a junction CLUSTER: maximal runs of indices within `radiusM` of ANY
 * member vertex (so a pass crossing a staggered junction A→connector→B is ONE visit), sub-runs
 * separated by ≤ `mergeRunPts` merged. Each visit reports the index nearest the cluster centroid
 * (the cut/hub point) and the leg headings just before/after the run (the through directions, not
 * the connector's internal direction).
 */
function computeClusterVisits(lats, lons, members, radiusM, mergeRunPts) {
  const N = lats.length
  const c = centroidOf(members)
  const inside = (i) => members.some((m) => haversine(lats[i], lons[i], m.lat, m.lon) <= radiusM)
  const runs = []
  let lo = -1
  for (let i = 0; i < N; i++) {
    const ins = inside(i)
    if (ins && lo < 0) lo = i
    else if (!ins && lo >= 0) { runs.push([lo, i - 1]); lo = -1 }
  }
  if (lo >= 0) runs.push([lo, N - 1])
  const merged = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] <= mergeRunPts) last[1] = r[1]
    else merged.push(r.slice())
  }
  return merged.map(([a, b]) => {
    let nearIdx = a, bd = Infinity
    for (let i = a; i <= b; i++) {
      const d = haversine(lats[i], lons[i], c.lat, c.lon)
      if (d < bd) { bd = d; nearIdx = i }
    }
    const inA = Math.max(0, a - 1), outB = Math.min(N - 1, b + 1)
    const headingIn = a > inA ? bearing(lats[inA], lons[inA], lats[a], lons[a]) : null
    const headingOut = outB > b ? bearing(lats[b], lons[b], lats[outB], lons[outB]) : null
    return { enterIdx: a, nearIdx, exitIdx: b, headingIn, headingOut }
  })
}

/**
 * Detect turnaround folds — a heading reversal ≥ foldTurnDeg within a short along-track window
 * (a near-instant U-turn). Snaps the node to the sharpest single-vertex apex so the 180° fold
 * lands ON the node. Catches out-and-back turnarounds that aren't an OSM branch.
 * @returns {Array<{ center:{lat,lon,ele}, kind:'fold', visits:[{nearIdx,headingIn,headingOut}] }>}
 */
export function detectFolds(lats, lons, eles, opts = {}) {
  const N = lats.length
  if (N < 4) return []
  const foldTurnDeg = opts.foldTurnDeg ?? 140
  const foldWinM = opts.foldWinM ?? 10
  const minLegSepM = opts.minLegSepM ?? 30
  const E = eles || lats.map(() => 0)
  const dist = cumulativeDistances(lats, lons)

  const headBefore = (i) => { let j = i; for (; j > 0; j--) if (dist[i] - dist[j] >= foldWinM) break; return j < i ? bearing(lats[j], lons[j], lats[i], lons[i]) : null }
  const headAfter = (i) => { let j = i; for (; j < N - 1; j++) if (dist[j] - dist[i] >= foldWinM) break; return j > i ? bearing(lats[i], lons[i], lats[j], lons[j]) : null }
  const vertexTurn = (i) => (i > 0 && i < N - 1)
    ? headingDelta(bearing(lats[i - 1], lons[i - 1], lats[i], lons[i]), bearing(lats[i], lons[i], lats[i + 1], lons[i + 1]))
    : 0

  const folds = []
  let lastFold = -Infinity
  for (let i = 1; i < N - 1; i++) {
    const a = headBefore(i), b = headAfter(i)
    if (a == null || b == null) continue
    if (headingDelta(a, b) >= foldTurnDeg && dist[i] - lastFold > minLegSepM) {
      let apex = i, bestTurn = -1
      for (let k = i; k >= 0 && dist[i] - dist[k] <= foldWinM; k--) { const t = vertexTurn(k); if (t > bestTurn) { bestTurn = t; apex = k } }
      for (let k = i + 1; k < N && dist[k] - dist[i] <= foldWinM; k++) { const t = vertexTurn(k); if (t > bestTurn) { bestTurn = t; apex = k } }
      folds.push({
        center: { lat: lats[apex], lon: lons[apex], ele: E[apex] || 0 },
        kind: 'fold',
        visits: [{ enterIdx: apex, nearIdx: apex, exitIdx: apex, headingIn: a, headingOut: b }],
      })
      lastFold = dist[i]
    }
  }
  return folds
}

/**
 * Detect topology junctions from the OSM graph nodes the route passes through.
 *
 * Nearby OSM vertices are CLUSTERED into one junction first (a staggered crossing or a short
 * connector between two roads is several OSM nodes a few metres apart — one physical junction).
 * Clustering is what makes turn-only junctions work: when two opposing turns use DIFFERENT OSM
 * nodes (each visited once), the cluster is visited twice and every leg shares one hub, so every
 * movement — including turns the recorded track never made — becomes routable. A cluster is kept
 * only where the ROUTE itself branches: visited on ≥2 passes AND ≥3 distinct incident edge
 * directions. This drops driveways (1 pass), distinct parallel roads (different vertices, not
 * clustered, 1 pass each) and shared-road interiors / through-passes (degree 2).
 *
 * @param {{lats:number[],lons:number[],eles:number[]}} route
 * @param {Array<{lat:number,lon:number,headings?:number[]}>} junctionNodes — from way-matching
 *   (Valhalla edge.end_node). May be empty (Overpass fallback / offline) → folds only.
 * @param {object} [opts]
 *   - radiusM (12): a route point counts as visiting the cluster within this of a member vertex.
 *   - clusterM (22): OSM vertices within this of the cluster centroid are one junction.
 *   - mergeRunPts (3): visit sub-runs separated by ≤ this many indices are one visit.
 *   - mergeDirDeg (25): incident edge directions within this are the same edge.
 *   - foldTurnDeg/foldWinM/minLegSepM: forwarded to detectFolds.
 * @returns {Array<{ center:{lat,lon,ele}, kind:string, degree?:number, members?:number,
 *   headings?:number[], visits:Array<{ enterIdx,nearIdx,exitIdx,headingIn,headingOut }> }>}
 */
export function detectOsmJunctions(route, junctionNodes, opts = {}) {
  const { lats, lons } = route
  const N = lats.length
  const E = route.eles || lats.map(() => 0)
  if (N < 4) return []
  const radiusM = opts.radiusM ?? 12
  const clusterM = opts.clusterM ?? 22
  const mergeRunPts = opts.mergeRunPts ?? 3
  const mergeDirDeg = opts.mergeDirDeg ?? 25

  const junctions = []

  if (junctionNodes && junctionNodes.length) {
    // Unique OSM vertices, merging the intersecting-edge headings seen across passes.
    const byKey = new Map()
    for (const jn of junctionNodes) {
      if (typeof jn.lat !== 'number' || typeof jn.lon !== 'number') continue
      const k = nodeKey(jn.lat, jn.lon)
      let e = byKey.get(k)
      if (!e) byKey.set(k, e = { lat: jn.lat, lon: jn.lon, headings: [] })
      if (jn.headings) for (const h of jn.headings) e.headings.push(h)
    }

    // Cluster compact groups of vertices into one physical junction, then test each cluster.
    for (const members of clusterNodes([...byKey.values()], clusterM)) {
      const visits = computeClusterVisits(lats, lons, members, radiusM, mergeRunPts)
      if (visits.length < 2) continue   // the route only passes once → mid-segment, not a branch
      // Distinct incident edge directions across ALL passes (half-edges pointing away from node).
      const dirs = []
      for (const v of visits) {
        if (v.headingIn != null) dirs.push(norm360(v.headingIn + 180))
        if (v.headingOut != null) dirs.push(norm360(v.headingOut))
      }
      const distinct = dedupeAngles(dirs, mergeDirDeg)
      if (distinct.length < 3) continue  // through-pass or plain retrace overlap, not a branch
      const center = centroidOf(members)
      const ele = visits.reduce((s, v) => s + (E[v.nearIdx] || 0), 0) / visits.length
      const allHeadings = dedupeAngles([].concat(...members.map((m) => m.headings)), mergeDirDeg)
      junctions.push({ center: { lat: center.lat, lon: center.lon, ele }, kind: 'osm', degree: distinct.length, members: members.length, headings: allHeadings, visits })
    }
  }

  // Union turnaround folds not already covered by an OSM branch.
  for (const f of detectFolds(lats, lons, E, opts)) {
    if (junctions.some((j) => haversine(j.center.lat, j.center.lon, f.center.lat, f.center.lon) <= Math.max(radiusM, clusterM))) continue
    junctions.push(f)
  }

  return junctions
}

/**
 * Resolve a junction's OSM legs from its connected ways, classifying each as TRAVERSED (the route
 * used it) or UNTRAVERSED (a cross-street it never drove → the missing turns).
 *
 * Multilevel-correct by the SHARED-NODE test: the junction vertex is the coordinate near the centre
 * that is shared by the MOST ways (the real OSM junction node). A bridge-over / tunnel-under is a
 * different way whose vertices are NOT that shared node, so it contributes no leg — no illegal
 * cross-level turn. Each way through the shared vertex yields up to two outgoing legs (toward its
 * previous and next vertex); leg geometry runs from the vertex outward (for building a stub).
 *
 * @param {{ center:{lat,lon,ele}, visits:Array }} junction — from detectOsmJunctions
 * @param {Array} ways — from fetchJunctionWays (parsed; may include ways for OTHER junctions)
 * @param {{ vertexMatchM?:number, legMatchDeg?:number, mergeDirDeg?:number }} [opts]
 * @returns {{ vertex:{lat,lon}|null, legs:Array<{ heading:number, traversed:boolean, wayId:number,
 *   oneway:boolean, layer:number, bridge:boolean, tunnel:boolean, points:Array<{lat,lon}> }> }}
 */
export function junctionLegs(junction, ways, opts = {}) {
  const vertexMatchM = opts.vertexMatchM ?? 4
  const legMatchDeg = opts.legMatchDeg ?? 30
  const mergeDirDeg = opts.mergeDirDeg ?? 25
  const c = junction.center
  if (!ways || !ways.length) return { vertex: null, legs: [] }

  // Candidate junction vertices: way-vertices within vertexMatchM of the centre, grouped by exact
  // coord. The shared OSM node is the coord referenced by the MOST distinct ways.
  const groups = new Map() // coordKey → { lat, lon, ways:Set }
  ways.forEach((w, wi) => {
    for (const p of w.points) {
      if (haversine(p.lat, p.lon, c.lat, c.lon) > vertexMatchM) continue
      const k = nodeKey(p.lat, p.lon)
      let g = groups.get(k)
      if (!g) groups.set(k, g = { lat: p.lat, lon: p.lon, ways: new Set() })
      g.ways.add(wi)
    }
  })
  if (!groups.size) return { vertex: null, legs: [] }
  let sv = null
  for (const g of groups.values()) if (!sv || g.ways.size > sv.ways.size) sv = g

  // Directions the ROUTE used at this junction (came-from + left-on).
  const routeDirs = []
  for (const v of junction.visits || []) {
    if (v.headingIn != null) routeDirs.push(norm360(v.headingIn + 180))
    if (v.headingOut != null) routeDirs.push(norm360(v.headingOut))
  }

  // Each way through the shared vertex → up to two outgoing legs.
  const raw = []
  for (const w of ways) {
    let vi = -1
    for (let i = 0; i < w.points.length; i++) {
      if (haversine(w.points[i].lat, w.points[i].lon, sv.lat, sv.lon) <= 1) { vi = i; break }
    }
    if (vi < 0) continue
    for (const step of [1, -1]) {
      const ni = vi + step
      if (ni < 0 || ni >= w.points.length) continue
      const heading = bearing(sv.lat, sv.lon, w.points[ni].lat, w.points[ni].lon)
      const points = []
      for (let k = vi; k >= 0 && k < w.points.length; k += step) points.push(w.points[k])
      raw.push({
        heading, traversed: routeDirs.some((d) => headingDelta(d, heading) <= legMatchDeg),
        wayId: w.id, oneway: w.oneway, layer: w.layer, bridge: w.bridge, tunnel: w.tunnel, points,
      })
    }
  }

  // Dedupe legs pointing the same way (overlapping ways share a leg); a leg is traversed if ANY
  // contributor was. Keep the longest geometry for the kept leg.
  const legs = []
  for (const leg of raw) {
    const hit = legs.find((l) => headingDelta(l.heading, leg.heading) <= mergeDirDeg)
    if (!hit) { legs.push({ ...leg, heading: Math.round(leg.heading) }); continue }
    hit.traversed = hit.traversed || leg.traversed
    if (leg.points.length > hit.points.length) hit.points = leg.points
  }

  return { vertex: { lat: sv.lat, lon: sv.lon }, legs }
}

/**
 * Build a hub graph from a route + its detected junctions (GPXmagic node/edge model).
 *
 * Each junction becomes ONE node at its EXACT OSM centre; the route is split at every visit's
 * nearest index and all of a junction's visit-splits are merged into that one hub node, so every
 * leg reaching the junction connects to it and every turning movement is routable. Because the
 * centre is the true OSM vertex and each pass snapped near it, the pin is a SMALL on-road move
 * (no corner-cutting). Overlap boundaries are added as plain `extraCuts` (un-merged) so each pass
 * stays its own user-mergeable segment.
 *
 * @param {{lats:number[],lons:number[],eles:number[]}} route
 * @param {Array} junctions — from detectOsmJunctions
 * @param {{ loopThreshM?:number, radiusM?:number, extraCuts?:number[] }} [opts]
 * @returns {object} route graph
 */
export function buildOsmHubGraph(route, junctions, opts = {}) {
  const cuts = []
  const idxToJunction = new Map()
  junctions.forEach((jn, ji) => {
    for (const v of jn.visits) { cuts.push(v.nearIdx); idxToJunction.set(v.nearIdx, ji) }
  })
  for (const ec of (opts.extraCuts || [])) if (!idxToJunction.has(ec)) cuts.push(ec)

  let g = buildGraphFromRoute(route, cuts, opts)

  const idsOf = (ji) => Object.entries(g.nodes)
    .filter(([, n]) => n.idx != null && idxToJunction.get(n.idx) === ji)
    .map(([id]) => id)

  junctions.forEach((jn, ji) => {
    const ids = idsOf(ji)
    if (!ids.length) return
    const keep = ids[0]
    const dropMax = (opts.radiusM ?? 12) * 3   // drop only tiny connectors; keep real laps
    for (let k = 1; k < ids.length; k++) {
      const r = mergeNodesInGraph(g, keep, ids[k], { matchM: 1e6, dropSelfLoopMaxM: dropMax })
      if (r) g = r
    }
    const node = g.nodes[keep]
    if (node) g.nodes[keep] = { ...node, lat: jn.center.lat, lon: jn.center.lon, ele: jn.center.ele }
  })

  return g
}

/** Find the graph node id sitting at a coordinate (within tolM), or null. */
function nodeIdAt(graph, lat, lon, tolM = 4) {
  for (const [id, n] of Object.entries(graph.nodes)) {
    if (haversine(n.lat, n.lon, lat, lon) <= tolM) return id
  }
  return null
}

/** Walk a leg's points outward from the hub, capped at stubMaxM; returns the stub point list. */
function buildStubPoints(points, hubEle, stubMaxM) {
  const out = [{ lat: points[0].lat, lon: points[0].lon, ele: hubEle }]
  let acc = 0
  for (let i = 1; i < points.length; i++) {
    const seg = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon)
    if (acc + seg >= stubMaxM) {
      const t = (stubMaxM - acc) / (seg || 1)
      out.push({
        lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * t,
        lon: points[i - 1].lon + (points[i].lon - points[i - 1].lon) * t,
        ele: hubEle,
      })
      return out
    }
    acc += seg
    out.push({ lat: points[i].lat, lon: points[i].lon, ele: hubEle })
  }
  return out
}

/**
 * Add the UNTRAVERSED legs of each junction to the graph as stub segments ending at a dead-end
 * leaf node — so a course can turn onto a cross-street the recorded track never drove. Stubs run
 * along the real OSM geometry, capped at `stubMaxM` (~60 m). They carry `stub:true` plus the OSM
 * `oneway`/`layer`/`bridge`/`tunnel` tags (for course rules + future Z), and are NOT added to the
 * graph's recorded route (available for course-building only, like roundabout untraversed arcs).
 *
 * @param {object} graph — from buildOsmHubGraph
 * @param {Array} junctions — from detectOsmJunctions (same order as legsByJunction)
 * @param {Array<Array>} legsByJunction — legsByJunction[ji] = junctionLegs(junctions[ji], …).legs
 * @param {{ stubMaxM?:number, hubTolM?:number, dupDeg?:number }} [opts]
 * @returns {{ graph:object, added:number }}
 */
export function addJunctionLegs(graph, junctions, legsByJunction, opts = {}) {
  const stubMaxM = opts.stubMaxM ?? 60
  const hubTolM = opts.hubTolM ?? 4
  const dupDeg = opts.dupDeg ?? 25
  let g = { ...graph, nodes: { ...graph.nodes }, segments: { ...graph.segments }, route: graph.route.slice() }
  let leafN = 0, added = 0

  junctions.forEach((jn, ji) => {
    const legs = legsByJunction[ji] || []
    const hubId = nodeIdAt(g, jn.center.lat, jn.center.lon, hubTolM)
    if (!hubId) return
    // Headings already leaving this hub (recorded roads + stubs) — don't duplicate a leg.
    const existing = []
    for (const s of Object.values(g.segments)) {
      if (s.from === hubId) existing.push(bearing(jn.center.lat, jn.center.lon, (s.points[1] || s.points[0]).lat, (s.points[1] || s.points[0]).lon))
      if (s.to === hubId) { const p = s.points[s.points.length - 2] || s.points[s.points.length - 1]; existing.push(bearing(jn.center.lat, jn.center.lon, p.lat, p.lon)) }
    }
    for (const leg of legs) {
      if (leg.traversed) continue
      if (existing.some((h) => headingDelta(h, leg.heading) <= dupDeg)) continue
      if (!leg.points || leg.points.length < 2) continue
      const pts = buildStubPoints(leg.points, jn.center.ele, stubMaxM)
      if (pts.length < 2) continue
      const leafId = 'leaf' + (leafN++)
      const tail = pts[pts.length - 1]
      g.nodes[leafId] = { lat: tail.lat, lon: tail.lon, ele: tail.ele, leaf: true }
      g.segments['stub' + leafId] = {
        from: hubId, to: leafId, points: pts, stub: true,
        oneway: !!leg.oneway, layer: leg.layer || 0, bridge: !!leg.bridge, tunnel: !!leg.tunnel,
      }
      existing.push(leg.heading)
      added++
    }
  })

  return { graph: g, added }
}
