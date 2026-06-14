/**
 * HMM / Viterbi map-matcher — trace a recorded GPS ride onto a fixed road network as a CONNECTED,
 * direction-aware course `[{segment, dir}]`.
 *
 * This is the proper, sequence-aware replacement for nearest-segment matching (which is memoryless and
 * so can't follow direction, jumps onto parallel roads, and can't disambiguate laps). The model
 * (Newson–Krumm 2009, the standard used by Valhalla Meili / OSRM map-matching) is:
 *
 *   • EMISSION  — a track sample is likely on a road in proportion to how close it is (GPS-noise model).
 *   • TRANSITION — moving between two consecutive samples should cost the same on the GPS (straight-line
 *     step) as on the ROAD NETWORK (shortest path between the two candidate road positions). Teleporting
 *     to a parallel road needs a long network out-and-back that doesn't match the short GPS step → it's
 *     heavily penalised. Progressing along the actual road → cheap. THIS is what gives direction
 *     awareness, parallel-road robustness, and per-lap reuse (each lap is a distinct temporal pass).
 *   • VITERBI   — the single most-likely connected sequence of candidates over the whole track.
 *
 * Pure (no DOM/ST/network). Deterministic — a function of the fixed graph + track. Output goes through
 * the shared `arcsFromMatched` stage (run-collapse + bounded-BFS bridge) so it's guaranteed connected.
 */

import { haversine } from './math.js'
import { buildAdjacency, shortestDistances, shortestPath } from './graph-routing.js'

const M_PER_DEG_LAT = 111320

/**
 * Map-match a track onto a network graph.
 *
 * @param {{ nodes:Object, segments:Object }} graph
 * @param {{ lats:number[], lons:number[] }} track
 * @param {object} [opts]
 *   sampleM (15)        decimate the track to ~this spacing before matching (Viterbi cost ∝ N·K²).
 *   searchR (30)        max metres from a sample to a candidate road.
 *   maxCandidates (6)   candidates kept per sample (nearest first).
 *   emitSigmaM (4)      positional-noise σ for the emission cost. CALIBRATED to the input: Course
 *                       Builder import receives a road-centerline-quality track (snapped/planned, not
 *                       raw GPS), so the true track↔OSM disagreement is ~1–2 m. A tight σ makes
 *                       "closest to the recorded track" dominate, so the matcher hugs the actual road
 *                       and won't wander onto a parallel cycleway 10–15 m away (no hysteresis fudge
 *                       needed). Raw GPS would want a looser σ (~8 m) — not this workflow.
 *   transBetaM (7)      scale of the |gpsΔ − netΔ| transition penalty.
 *   nodeDistCapM (250)  bound for the per-node Dijkstra used in transitions.
 *   minRunPts, maxHops  passed to arcsFromMatched.
 * @returns {Array<{segment:string, dir:'forward'|'reverse'}>}
 */
export function hmmMatchTrack(graph, track, opts = {}) {
  const sampleM = opts.sampleM ?? 15
  const searchR = opts.searchR ?? 30
  const maxCandidates = opts.maxCandidates ?? 6
  const emitSigmaM = opts.emitSigmaM ?? 4
  const transBetaM = opts.transBetaM ?? 7
  const nodeDistCapM = opts.nodeDistCapM ?? 250

  const segs = graph?.segments || {}
  const segIds = Object.keys(segs)
  const N = track?.lats?.length || 0
  if (!segIds.length || N < 2) return []

  const meta = buildSegMeta(segs)
  const grid = buildGrid(segs, meta, searchR)

  // 1. Decimate the track to ~sampleM; keep only samples that have at least one candidate road.
  const samples = decimate(track, sampleM)
  const cols = []
  for (const s of samples) {
    const cands = candidatesForPoint(segs, meta, grid, s.lat, s.lon, searchR, maxCandidates)
    if (cands.length) cols.push({ lat: s.lat, lon: s.lon, cands })
  }
  if (cols.length < 2) return cols.length ? [{ segment: cols[0].cands[0].segId, dir: 'forward' }] : []

  // Per-node bounded shortest-distance memo (transition network distances reuse exit nodes heavily).
  const adj = buildAdjacency(graph)
  const distMemo = new Map()
  const distFrom = (node) => {
    let d = distMemo.get(node)
    if (!d) { d = shortestDistances(graph, node, { adj, maxDistM: nodeDistCapM }); distMemo.set(node, d) }
    return d
  }
  // Network distance between two candidate road positions (foot-of-perpendicular along their segments).
  const netDist = (u, v) => {
    if (u.segId === v.segId) return Math.abs(v.offsetM - u.offsetM)
    const a = segs[u.segId], b = segs[v.segId]
    const uExits = [{ node: a.to, cost: meta[u.segId].len - u.offsetM }, { node: a.from, cost: u.offsetM }]
    const vEnters = [{ node: b.from, cost: v.offsetM }, { node: b.to, cost: meta[v.segId].len - v.offsetM }]
    let best = Infinity
    for (const ux of uExits) {
      const dm = distFrom(ux.node)
      for (const ve of vEnters) {
        const nd = ux.node === ve.node ? 0 : dm.get(ve.node)
        if (nd == null) continue
        const tot = ux.cost + nd + ve.cost
        if (tot < best) best = tot
      }
    }
    return best
  }

  // 2. Viterbi over the candidate trellis.
  const sig2 = emitSigmaM * emitSigmaM
  const emit = (c) => 0.5 * (c.distM * c.distM) / sig2
  let prev = cols[0].cands.map((c) => ({ score: emit(c), from: -1 }))
  const back = [prev.map(() => -1)]
  for (let i = 1; i < cols.length; i++) {
    const gpsD = haversine(cols[i - 1].lat, cols[i - 1].lon, cols[i].lat, cols[i].lon)
    const cur = cols[i].cands
    const row = new Array(cur.length)
    const bp = new Array(cur.length)
    for (let k = 0; k < cur.length; k++) {
      let bestScore = Infinity, bestJ = -1
      for (let j = 0; j < cols[i - 1].cands.length; j++) {
        if (!Number.isFinite(prev[j].score)) continue
        const nd = netDist(cols[i - 1].cands[j], cur[k])
        if (!Number.isFinite(nd)) continue
        const tcost = Math.abs(gpsD - nd) / transBetaM
        const sc = prev[j].score + tcost
        if (sc < bestScore) { bestScore = sc; bestJ = j }
      }
      if (bestJ === -1) { row[k] = emit(cur[k]); bp[k] = -1 }   // break → restart the chain here
      else { row[k] = bestScore + emit(cur[k]); bp[k] = bestJ }
    }
    back.push(bp)
    prev = row.map((score) => ({ score }))
  }

  // 3. Backtrack the best terminal candidate.
  let bestK = 0, bestScore = Infinity
  for (let k = 0; k < prev.length; k++) if (prev[k].score < bestScore) { bestScore = prev[k].score; bestK = k }
  const chosen = new Array(cols.length)
  let k = bestK
  for (let i = cols.length - 1; i >= 0; i--) {
    chosen[i] = cols[i].cands[k]
    k = back[i][k]
    if (k === -1 && i > 0) {
      // chain restart: pick the best candidate of the previous column independently.
      let bj = 0, bs = Infinity
      // (back-pointer was a restart; choose the previous column's min-emission candidate)
      const pcs = cols[i - 1].cands
      for (let j = 0; j < pcs.length; j++) { const e = emit(pcs[j]); if (e < bs) { bs = e; bj = j } }
      k = bj
    }
  }

  // 4. Reconstruct the arc path FROM the chosen candidates — the distance-weighted shortest network
  // path between each CONSECUTIVE sample. This is the principled HMM output: consecutive samples are
  // ~sampleM (15 m) apart, so each hop is short and on-track — it walks a roundabout AROUND rather than
  // chording it, and fills a skipped short segment with the on-track link (a hop-count bridge over a
  // long gap could detour or cut). De-blip first: drop a single-sample excursion onto another segment
  // (a junction-arm jitter) so it doesn't inject a spurious out-and-back.
  const seq = []
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i]
    // Drop a single-sample excursion onto a segment different from its neighbour(s) — junction-arm
    // jitter, a momentary parallel-road touch, or an endpoint-tie flicker where the first/last point
    // sits on a node shared by two segments (without this the whole shared segment gets emitted as a
    // spurious leg). Safe: the reconstruction connects the survivors with the shortest network path,
    // re-inserting any GENUINE intermediate segment but skipping a spurious detour. A real traversal
    // spans ≥2 samples.
    if (chosen.length > 2) {
      const dp = i > 0 && c.segId !== chosen[i - 1].segId
      const dn = i < chosen.length - 1 && c.segId !== chosen[i + 1].segId
      if (i === 0 && dn) continue
      else if (i === chosen.length - 1 && dp) continue
      else if (i > 0 && i < chosen.length - 1 && dp && dn) continue
    }
    const last = seq[seq.length - 1]
    if (last && last.seg === c.segId) { last.off = c.offsetM; continue } // collapse same-seg run end
    seq.push({ seg: c.segId, off: c.offsetM })
  }
  return reconstructArcs(graph, segs, meta, adj, seq, opts.connectorCapM ?? 400)
}

/**
 * Build whole-segment arcs `[{segment,dir}]` from a sequence of matched road positions by walking the
 * distance-weighted shortest path between each consecutive position. Each segment is traversed in its
 * travel direction; the connector between two non-adjacent positions is the on-track shortest path.
 */
function reconstructArcs(graph, segs, meta, adj, seq, connectorCapM) {
  const arcs = []
  const push = (segment, dir) => {
    const l = arcs[arcs.length - 1]
    if (l && l.segment === segment && l.dir === dir) return
    arcs.push({ segment, dir })
  }
  if (!seq.length) return arcs
  let cur = seq[0]
  for (let i = 1; i < seq.length; i++) {
    const v = seq[i]
    if (v.seg === cur.seg) { push(cur.seg, v.off >= cur.off ? 'forward' : 'reverse'); cur = v; continue }
    const a = segs[cur.seg], b = segs[v.seg]
    const aLen = meta[cur.seg].len, bLen = meta[v.seg].len
    const exits = [{ node: a.to, cost: aLen - cur.off, dir: 'forward' }, { node: a.from, cost: cur.off, dir: 'reverse' }]
    const enters = [{ node: b.from, cost: v.off, dir: 'forward' }, { node: b.to, cost: bLen - v.off, dir: 'reverse' }]
    let best = null
    for (const ex of exits) {
      for (const en of enters) {
        const sp = ex.node === en.node ? { arcs: [], distM: 0 } : shortestPath(graph, ex.node, en.node, { adj, maxDistM: connectorCapM })
        if (!sp) continue
        const tot = ex.cost + sp.distM + en.cost
        if (!best || tot < best.tot) best = { tot, ex, en, sp }
      }
    }
    if (!best) { cur = v; continue }   // unreachable within cap → skip (keep the path connected)
    push(cur.seg, best.ex.dir)
    for (const arc of best.sp.arcs) push(arc.segment, arc.dir)
    push(v.seg, best.en.dir)
    cur = v
  }
  if (!arcs.length) push(seq[0].seg, 'forward')
  return arcs
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** Per-segment cumulative point distances + total length (for metric offsets). */
function buildSegMeta(segs) {
  const meta = {}
  for (const [id, s] of Object.entries(segs)) {
    const p = s.points
    const cum = [0]
    for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon))
    meta[id] = { cum, len: cum[cum.length - 1] }
  }
  return meta
}

/** Spatial grid: cellKey → Set(segId), stamping each segment along its polyline at ~cellM steps. */
function buildGrid(segs, meta, cellM) {
  // Use a representative cos(lat) from the first segment's first point.
  const first = Object.values(segs)[0]
  const lat0 = first?.points?.[0]?.lat ?? 0
  const mLon = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180) || M_PER_DEG_LAT
  const dLat = cellM / M_PER_DEG_LAT, dLon = cellM / mLon
  const grid = new Map()
  const key = (lat, lon) => Math.floor(lat / dLat) + ',' + Math.floor(lon / dLon)
  const stamp = (lat, lon, id) => { const kk = key(lat, lon); let set = grid.get(kk); if (!set) { set = new Set(); grid.set(kk, set) } set.add(id) }
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

/** Candidate roads for a point: nearby segments (3×3 grid cells), projected, within searchR, top-K. */
function candidatesForPoint(segs, meta, gridInfo, plat, plon, searchR, K) {
  const { grid, dLat, dLon } = gridInfo
  const ci = Math.floor(plat / dLat), cj = Math.floor(plon / dLon)
  const seen = new Set()
  const out = []
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const set = grid.get((ci + di) + ',' + (cj + dj))
      if (!set) continue
      for (const id of set) {
        if (seen.has(id)) continue
        seen.add(id)
        const proj = projectOntoSegment(segs[id], meta[id], plat, plon)
        if (proj.distM <= searchR) out.push({ segId: id, offsetM: proj.offsetM, distM: proj.distM })
      }
    }
  }
  out.sort((a, b) => a.distM - b.distM)
  return out.slice(0, K)
}

/** Foot-of-perpendicular of (plat,plon) onto a segment → { distM, offsetM (metric along seg) }. */
function projectOntoSegment(seg, segMeta, plat, plon) {
  const p = seg.points
  const mLat = M_PER_DEG_LAT, mLon = M_PER_DEG_LAT * Math.cos(plat * Math.PI / 180)
  const px = plon * mLon, py = plat * mLat
  let bestD2 = Infinity, bestOff = 0
  for (let k = 0; k < p.length - 1; k++) {
    const ax = p[k].lon * mLon, ay = p[k].lat * mLat
    const bx = p[k + 1].lon * mLon, by = p[k + 1].lat * mLat
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const fx = ax + t * dx, fy = ay + t * dy
    const d2 = (px - fx) ** 2 + (py - fy) ** 2
    if (d2 < bestD2) {
      bestD2 = d2
      bestOff = segMeta.cum[k] + t * (segMeta.cum[k + 1] - segMeta.cum[k])
    }
  }
  return { distM: Math.sqrt(bestD2), offsetM: bestOff }
}

/** Decimate a track to ~spacingM, keeping endpoints. */
function decimate(track, spacingM) {
  const { lats, lons } = track
  const n = lats.length
  const out = [{ lat: lats[0], lon: lons[0] }]
  let acc = 0
  for (let i = 1; i < n; i++) {
    acc += haversine(lats[i - 1], lons[i - 1], lats[i], lons[i])
    if (acc >= spacingM) { out.push({ lat: lats[i], lon: lons[i] }); acc = 0 }
  }
  const last = { lat: lats[n - 1], lon: lons[n - 1] }
  const tail = out[out.length - 1]
  if (tail.lat !== last.lat || tail.lon !== last.lon) out.push(last)
  return out
}
