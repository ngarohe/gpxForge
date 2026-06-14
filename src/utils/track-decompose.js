/**
 * Decompose a RECORDED ride into an editable course graph by LABELLING each point with its OSM road
 * — the course geometry stays the recorded ride (it can never diverge), and OSM is used only for
 * topology: which road each stretch is on (→ segments + reuse) and where the junction nodes are
 * (→ deterministic, clean node coordinates).
 *
 * This is the robust alternative to map-matching. Map-matching RE-SYNTHESISES the path from OSM and so
 * must infer side/direction/laps probabilistically (it fails on roundabouts + multipass). Here we never
 * infer the path — the recorded GPS already is the path. We only attach an OSM label per point, which is
 * error-tolerant: a mislabel is a local topology blemish (a slightly-off segment boundary, one click to
 * fix), not a wrong route.
 *
 * Output is the standard `{ nodes, segments, route }` graph: segment geometry = the recorded pass
 * (endpoints pinned to the OSM junction nodes); a road ridden N× is ONE segment reused N× (reuse-
 * identical by construction); `route` is the ordered `[{segment,dir}]` the ride took.
 *
 * Pure — no DOM/ST/network.
 */

import { haversine } from './math.js'
import { buildAdjacency, shortestPath } from './graph-routing.js'

const M_PER_DEG_LAT = 111320

/**
 * @param {{ nodes:Object, segments:Object }} graph  — OSM network from buildNetworkGraph
 * @param {{ lats:number[], lons:number[], eles?:number[] }} track  — the recorded ride
 * @param {object} [opts]
 *   searchR (25)   max metres from a point to its candidate road label
 *   smoothW (3)    majority-vote window (± samples) that removes single-point label flicker
 *   minRunPts (3)  drop a labelled run shorter than this (noise)
 *   maxHops/connectorCapM — bridging a skipped short segment between consecutive runs
 * @returns {{ nodes:Object, segments:Object, route:Array<{segment:string,dir:string}>,
 *   gaps:Array<{fromNode:string,toNode:string,lat:number,lon:number,distM:number}> }}
 *   `gaps` = transitions the OSM network couldn't bridge (spliced with a straight GAP connector so the
 *   course always compiles) — surfaced in the UI as clickable, hand-fixable blemishes.
 */
export function decomposeTrackByLabels(graph, track, opts = {}) {
  const searchR = opts.searchR ?? 25
  const smoothW = opts.smoothW ?? 3
  const minRunPts = opts.minRunPts ?? 3
  const connectorCapM = opts.connectorCapM ?? 600
  const segs = graph?.segments || {}
  const N = track?.lats?.length || 0
  if (!Object.keys(segs).length || N < 2) return { nodes: {}, segments: {}, route: [], gaps: [] }

  const meta = buildSegMeta(segs)
  const grid = buildGrid(segs, meta, searchR)

  // 1. Label each recorded point with its nearest OSM segment (+ metric offset along it for direction).
  const raw = new Array(N)
  for (let i = 0; i < N; i++) raw[i] = nearestSeg(segs, meta, grid, track.lats[i], track.lons[i], searchR)

  // 2. Majority-vote smoothing on the segment id removes single-point flicker between coincident roads.
  const lab = new Array(N)
  for (let i = 0; i < N; i++) {
    if (!raw[i]) { lab[i] = null; continue }
    const cnt = {}
    for (let j = Math.max(0, i - smoothW); j <= Math.min(N - 1, i + smoothW); j++) {
      const r = raw[j]; if (r) cnt[r.segId] = (cnt[r.segId] || 0) + 1
    }
    let bi = raw[i].segId, bc = 0
    for (const k in cnt) if (cnt[k] > bc) { bc = cnt[k]; bi = k }
    lab[i] = bi === raw[i].segId ? raw[i] : projectToSeg(segs[bi], meta[bi], track.lats[i], track.lons[i], bi)
  }

  // 3. Collapse consecutive same-label points into runs (one pass over a road).
  const runs = []
  for (let i = 0; i < N; i++) {
    const l = lab[i]; if (!l) continue
    const last = runs[runs.length - 1]
    if (last && last.segId === l.segId) { last.hi = i; last.offEnd = l.offsetM; last.n++ }
    else runs.push({ segId: l.segId, lo: i, hi: i, offStart: l.offsetM, offEnd: l.offsetM, n: 1 })
  }
  const sig = runs.filter((r) => r.n >= minRunPts)
  if (!sig.length) return { nodes: {}, segments: {}, route: [], gaps: [] }

  // 4. Choose a canonical pass per reused segment (the longest run) → its RECORDED geometry is the
  //    segment's geometry (endpoints pinned to the OSM nodes); every other pass reuses it.
  const canonical = {}
  for (const r of sig) if (!canonical[r.segId] || r.n > canonical[r.segId].n) canonical[r.segId] = r

  const outNodes = {}, outSegs = {}
  const ensureNode = (nid) => { if (!outNodes[nid] && graph.nodes[nid]) outNodes[nid] = { lat: graph.nodes[nid].lat, lon: graph.nodes[nid].lon, ele: 0 } }
  const buildSeg = (segId) => {
    if (outSegs[segId]) return
    const r = canonical[segId], s = segs[segId]
    const fwd = r.offEnd >= r.offStart
    const pts = []
    for (let i = r.lo; i <= r.hi; i++) pts.push({ lat: track.lats[i], lon: track.lons[i], ele: track.eles ? track.eles[i] : 0 })
    if (!fwd) pts.reverse()                       // store canonically from s.from → s.to
    ensureNode(s.from); ensureNode(s.to)
    pts[0] = { lat: graph.nodes[s.from].lat, lon: graph.nodes[s.from].lon, ele: pts[0].ele }
    pts[pts.length - 1] = { lat: graph.nodes[s.to].lat, lon: graph.nodes[s.to].lon, ele: pts[pts.length - 1].ele }
    outSegs[segId] = { from: s.from, to: s.to, points: pts, wayId: s.wayId, highway: s.highway,
      oneway: s.oneway, roundabout: s.roundabout, layer: s.layer, bridge: s.bridge, tunnel: s.tunnel }
  }
  for (const segId in canonical) buildSeg(segId)

  // 5. Route = the run sequence (dir from the recorded travel direction), bridged where two consecutive
  //    runs don't share a node (a skipped short segment) so the course compiles. A bridge segment keeps
  //    its OSM geometry (it's the bit the ride glossed over — small).
  const adj = buildAdjacency(graph)
  const route = []
  const gaps = []                    // unbridgeable transitions, flagged for the UI (clickable)
  let curEnd = null
  for (const r of sig) {
    const s = segs[r.segId]
    const fwd = r.offEnd >= r.offStart
    const arc = { segment: r.segId, dir: fwd ? 'forward' : 'reverse' }
    const startN = fwd ? s.from : s.to
    if (curEnd != null && startN !== curEnd) {
      const sp = shortestPath(graph, curEnd, startN, { adj, maxDistM: connectorCapM })
      if (sp) {
        for (const b of sp.arcs) { buildBridge(b.segment, segs, meta, graph, outSegs, ensureNode); route.push(b) }
      } else {
        // ROBUSTNESS FLOOR — never emit a disconnected route (it won't compile). The OSM network can't
        // connect these two runs within the cap: a self-overlapping way whose pieces meet without a
        // shared node, or a partial mid-segment join. Splice a straight GAP connector between the two
        // nodes so the course always compiles, and FLAG it (a hand-fixable blemish, per the decompose
        // philosophy: a topology imperfection is one click to fix, not a hard failure).
        ensureNode(curEnd); ensureNode(startN)
        const a = graph.nodes[curEnd], b = graph.nodes[startN]
        const gapId = `s_gap${gaps.length}`
        outSegs[gapId] = { from: curEnd, to: startN, gap: true, highway: 'gap',
          points: [{ lat: a.lat, lon: a.lon, ele: 0 }, { lat: b.lat, lon: b.lon, ele: 0 }] }
        route.push({ segment: gapId, dir: 'forward' })
        gaps.push({ fromNode: curEnd, toNode: startN, lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2,
          distM: haversine(a.lat, a.lon, b.lat, b.lon) })
      }
    }
    route.push(arc)
    curEnd = fwd ? s.to : s.from
  }

  // 6. Trim the GLOBAL start/end. When the ride starts/ends MID-road (the first/last OSM segment is only
  //    partially ridden), pinning its terminal end to the OSM node draws a straight stub from the node
  //    out to your real start/finish — so replace that arc with a TERMINAL segment ending exactly at the
  //    recorded endpoint (a new terminal node). But when the ride starts/ends AT an OSM junction (within
  //    termThreshM), keep that junction node — don't add a coincident terminal.
  if (route.length) {
    const termThreshM = opts.termThreshM ?? 6
    const recPt = (i) => ({ lat: track.lats[i], lon: track.lons[i], ele: track.eles ? track.eles[i] : 0 })
    const nodePt = (nid) => ({ lat: graph.nodes[nid].lat, lon: graph.nodes[nid].lon })
    const mkSeg = (from, to, pts, src) => ({ from, to, points: pts, wayId: src.wayId, highway: src.highway,
      oneway: src.oneway, roundabout: src.roundabout, layer: src.layer, bridge: src.bridge, tunnel: src.tunnel })
    const firstRun = sig[0], lastRun = sig[sig.length - 1]
    const single = firstRun === lastRun
    const arc0 = route[0], arcL = route[route.length - 1]
    const entryN = arc0.dir === 'forward' ? outSegs[arc0.segment].from : outSegs[arc0.segment].to
    const exitN = arcL.dir === 'forward' ? outSegs[arcL.segment].to : outSegs[arcL.segment].from
    const startReal = recPt(firstRun.lo), endReal = recPt(lastRun.hi)
    const needStart = haversine(startReal.lat, startReal.lon, graph.nodes[entryN].lat, graph.nodes[entryN].lon) > termThreshM
    const needEnd = haversine(endReal.lat, endReal.lon, graph.nodes[exitN].lat, graph.nodes[exitN].lon) > termThreshM

    if (single && (needStart || needEnd)) {
      // One-segment ride: terminal node(s) at the recorded end(s) that need it.
      const pts = []
      for (let i = firstRun.lo; i <= firstRun.hi; i++) pts.push(recPt(i))
      const exJ = arc0.dir === 'forward' ? outSegs[arc0.segment].to : outSegs[arc0.segment].from
      const enJ = arc0.dir === 'forward' ? outSegs[arc0.segment].from : outSegs[arc0.segment].to
      const from = needStart ? 'n_start' : enJ
      const to = needEnd ? 'n_end' : exJ
      if (needStart) outNodes['n_start'] = startReal; else { ensureNode(enJ); pts[0] = { ...nodePt(enJ), ele: pts[0].ele } }
      if (needEnd) outNodes['n_end'] = endReal; else { ensureNode(exJ); pts[pts.length - 1] = { ...nodePt(exJ), ele: pts[pts.length - 1].ele } }
      outSegs['s_term'] = mkSeg(from, to, pts, segs[firstRun.segId])
      route[0] = { segment: 's_term', dir: 'forward' }
    } else {
      if (needStart) {
        const pts = []
        for (let i = firstRun.lo; i <= firstRun.hi; i++) pts.push(recPt(i))
        const exJ = arc0.dir === 'forward' ? outSegs[arc0.segment].to : outSegs[arc0.segment].from
        ensureNode(exJ); pts[pts.length - 1] = { ...nodePt(exJ), ele: pts[pts.length - 1].ele }
        outNodes['n_start'] = startReal
        outSegs['s_start'] = mkSeg('n_start', exJ, pts, segs[firstRun.segId])
        route[0] = { segment: 's_start', dir: 'forward' }
      }
      if (needEnd) {
        const pts = []
        for (let i = lastRun.lo; i <= lastRun.hi; i++) pts.push(recPt(i))
        const enJ = arcL.dir === 'forward' ? outSegs[arcL.segment].from : outSegs[arcL.segment].to
        ensureNode(enJ); pts[0] = { ...nodePt(enJ), ele: pts[0].ele }
        outNodes['n_end'] = endReal
        outSegs['s_end'] = mkSeg(enJ, 'n_end', pts, segs[lastRun.segId])
        route[route.length - 1] = { segment: 's_end', dir: 'forward' }
      }
    }

    // Drop segments/nodes the trimmed route no longer references.
    const usedSeg = new Set(route.map((a) => a.segment))
    for (const id of Object.keys(outSegs)) if (!usedSeg.has(id)) delete outSegs[id]
    const usedNode = new Set()
    for (const s of Object.values(outSegs)) { usedNode.add(s.from); usedNode.add(s.to) }
    for (const id of Object.keys(outNodes)) if (!usedNode.has(id)) delete outNodes[id]
  }

  return { nodes: outNodes, segments: outSegs, route, gaps }
}

/** A bridge segment the ride skipped — keep the OSM geometry (the recorded points didn't cover it). */
function buildBridge(segId, segs, meta, graph, outSegs, ensureNode) {
  if (outSegs[segId]) return
  const s = segs[segId]
  ensureNode(s.from); ensureNode(s.to)
  outSegs[segId] = { from: s.from, to: s.to, points: s.points.map((p) => ({ lat: p.lat, lon: p.lon, ele: 0 })),
    wayId: s.wayId, highway: s.highway, oneway: s.oneway, roundabout: s.roundabout, layer: s.layer, bridge: s.bridge, tunnel: s.tunnel }
}

// ──────────────────────────────────────────────────────────────────────
// Nearest-segment labelling (grid-accelerated)
// ──────────────────────────────────────────────────────────────────────

function buildSegMeta(segs) {
  const meta = {}
  for (const [id, s] of Object.entries(segs)) {
    const p = s.points, cum = [0]
    for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon))
    meta[id] = { cum, len: cum[cum.length - 1] }
  }
  return meta
}

function buildGrid(segs, meta, cellM) {
  const first = Object.values(segs)[0]
  const lat0 = first?.points?.[0]?.lat ?? 0
  const mLon = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180) || M_PER_DEG_LAT
  const dLat = cellM / M_PER_DEG_LAT, dLon = cellM / mLon
  const grid = new Map()
  const key = (lat, lon) => Math.floor(lat / dLat) + ',' + Math.floor(lon / dLon)
  const stamp = (lat, lon, id) => { const k = key(lat, lon); let s = grid.get(k); if (!s) { s = new Set(); grid.set(k, s) } s.add(id) }
  for (const [id, s] of Object.entries(segs)) {
    const p = s.points
    for (let i = 1; i < p.length; i++) {
      const segLen = meta[id].cum[i] - meta[id].cum[i - 1]
      const steps = Math.max(1, Math.ceil(segLen / cellM))
      for (let t = 0; t <= steps; t++) {
        const f = t / steps
        stamp(p[i - 1].lat + (p[i].lat - p[i - 1].lat) * f, p[i - 1].lon + (p[i].lon - p[i - 1].lon) * f, id)
      }
    }
  }
  return { grid, dLat, dLon }
}

function nearestSeg(segs, meta, gridInfo, plat, plon, searchR) {
  const { grid, dLat, dLon } = gridInfo
  const ci = Math.floor(plat / dLat), cj = Math.floor(plon / dLon)
  const seen = new Set()
  let best = null, bestD = searchR
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const set = grid.get((ci + di) + ',' + (cj + dj))
      if (!set) continue
      for (const id of set) {
        if (seen.has(id)) continue
        seen.add(id)
        const r = projectToSeg(segs[id], meta[id], plat, plon, id)
        if (r.distM < bestD) { bestD = r.distM; best = r }
      }
    }
  }
  return best
}

function projectToSeg(seg, segMeta, plat, plon, segId) {
  const p = seg.points
  const mLat = M_PER_DEG_LAT, mLon = M_PER_DEG_LAT * Math.cos(plat * Math.PI / 180)
  const px = plon * mLon, py = plat * mLat
  let bestD2 = Infinity, bestOff = 0
  for (let k = 0; k < p.length - 1; k++) {
    const ax = p[k].lon * mLon, ay = p[k].lat * mLat, bx = p[k + 1].lon * mLon, by = p[k + 1].lat * mLat
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const fx = ax + t * dx, fy = ay + t * dy
    const d2 = (px - fx) ** 2 + (py - fy) ** 2
    if (d2 < bestD2) { bestD2 = d2; bestOff = segMeta.cum[k] + t * (segMeta.cum[k + 1] - segMeta.cum[k]) }
  }
  return { segId, distM: Math.sqrt(bestD2), offsetM: bestOff }
}
