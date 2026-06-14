/**
 * Route graph — a directed-graph representation of a race course / road network,
 * and a compiler that "distills" a chosen route (a path along the graph) into a
 * flat lat/lon/ele track for GPX export.
 *
 * This is the "constructed-topology" model (see ~/.claude/plans/gpxforge-topology-graph.md):
 * instead of *detecting* shared roads / crossings from a finished line, the topology
 * is stored first, then the flat track is generated from it. Overlapping passes,
 * out-and-backs, divided carriageways, and crossroads all fall out of the model
 * exactly, with no thresholds:
 *
 *   - **Overlap / reuse:** a road ridden N times is ONE segment referenced N times.
 *     Every pass is bit-identical XYZ (a reverse pass is the same points reversed).
 *   - **Crossroads:** a crossing is a NODE. Every arc touching it is pinned to the
 *     node's exact lat/lon/ele, so all passes meet at one point ("the middle of the
 *     crossing is king"). A multilevel crossing is modelled as TWO nodes at the same
 *     XY but different ele (and different connectivity) — never merged.
 *   - **Divided road / one-way:** arc A→B uses segment S forward; arc B→A can use S
 *     reversed OR a different segment S2 (the dual carriageway / return lane).
 *   - **Roundabout:** a small directed subgraph of one-way arcs (entry → arc → exit).
 *
 * Format (hand-writable; this is djconnel's recommended first artifact):
 *   {
 *     nodes:    { A: {lat,lon,ele}, B: {...}, ... },
 *     segments: { S1: { from:'A', to:'B', points:[{lat,lon,ele}, ...] }, ... },
 *     route:    [ { segment:'S1', dir:'forward' }, { segment:'S1', dir:'reverse' }, ... ]
 *   }
 * `segment.points` is the canonical geometry ordered from→to (endpoints ≈ the node
 * coords; the compiler PINS them to the nodes so crossings/joins are exact).
 *
 * Pure — no DOM, no ST. Returns plain parallel arrays.
 */

import { haversine, bearing, bearingDiff, cumulativeDistances } from './math.js'

/**
 * Decompose a route by how it relates to ITSELF. TWO complementary passes:
 *
 *   OVERLAPS — range-based proximity: where the route runs alongside an earlier part
 *   of itself for a SUSTAINED near-parallel/antiparallel stretch (same road, e.g. an
 *   out-and-back return or a lap). Found by nearest non-local partner + run grouping.
 *
 *   CROSSINGS — geometric segment-segment INTERSECTION: every place the polyline
 *   actually crosses itself transversally. This is sampling-INDEPENDENT — it finds the
 *   true line intersection even when the nearest sample points are several metres apart
 *   (which a proximity test misses, leaving real crossings without a node). Intersections
 *   whose two points both lie inside an overlap zone are dropped (that's parallel weave,
 *   not a crossing), and a minimum crossing angle rejects near-parallel/antiparallel hits.
 *
 * This is the structural decomposer behind "Detect structure": it only DECOMPOSES
 * (reports where to cut). It does not snap or merge — that is the user's call when
 * assembling a course. Designed for SNAPPED geometry, so contact margins are tight.
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles
 * @param {{ contactM?:number, localWinM?:number, minOverlapM?:number, crossAngleDeg?:number,
 *           cellM?:number, maxGapPts?:number, minIndexSep?:number }} [opts]
 * @returns {{ overlaps: Array<{aLo,aHi,bLo,bHi,orientation,lengthM}>,
 *             crossings: Array<{idxA,idxB,lat,lon,zGapM,angleDeg}> }}
 */
export function analyzeSelfTopology(lats, lons, eles, opts = {}) {
  const result = { overlaps: [], crossings: [] }
  const N = lats.length
  if (N < 4) return result
  const contactM = opts.contactM ?? 6
  const localWinM = opts.localWinM ?? 25
  const minOverlapM = opts.minOverlapM ?? 20
  const crossAngleDeg = opts.crossAngleDeg ?? 30
  const cellM = opts.cellM ?? Math.max(10, contactM * 2)
  const maxGapPts = opts.maxGapPts ?? 3
  const minIndexSep = opts.minIndexSep ?? 5

  const dist = cumulativeDistances(lats, lons)
  const lat0 = lats[Math.floor(N / 2)]
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180)
  const X = (i) => lons[i] * mLon
  const Y = (i) => lats[i] * 111320
  const headAt = (k) => bearing(lats[Math.max(0, k - 1)], lons[Math.max(0, k - 1)], lats[Math.min(N - 1, k + 1)], lons[Math.min(N - 1, k + 1)])
  const angleBetween = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

  // ── Pass 1: OVERLAPS (range-based proximity) + an overlap mask. ──
  const pgrid = new Map()
  for (let i = 0; i < N; i++) {
    const k = Math.floor(X(i) / cellM) + ':' + Math.floor(Y(i) / cellM)
    let b = pgrid.get(k); if (!b) pgrid.set(k, b = []); b.push(i)
  }
  const partner = new Int32Array(N).fill(-1)
  for (let i = 0; i < N; i++) {
    const cx = Math.floor(X(i) / cellM), cy = Math.floor(Y(i) / cellM)
    let bj = -1, bd = contactM
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = pgrid.get(gx + ':' + gy); if (!bucket) continue
        for (const j of bucket) {
          if (Math.abs(dist[i] - dist[j]) <= localWinM) continue
          const d = haversine(lats[i], lons[i], lats[j], lons[j])
          if (d < bd) { bd = d; bj = j }
        }
      }
    }
    partner[i] = bj
  }
  const overlapMask = new Uint8Array(N)
  let i = 0
  while (i < N) {
    if (partner[i] < 0 || partner[i] <= i) { i++; continue }  // group once, from the earlier side
    let i0 = i, i1 = i, gap = 0, jMin = partner[i], jMax = partner[i]
    let k = i + 1
    while (k < N) {
      if (partner[k] > k) { i1 = k; gap = 0; jMin = Math.min(jMin, partner[k]); jMax = Math.max(jMax, partner[k]) }
      else { if (++gap > maxGapPts) break }
      k++
    }
    const lengthM = dist[i1] - dist[i0]
    const delta = angleBetween(headAt((i0 + i1) >> 1), headAt((jMin + jMax) >> 1))
    if (lengthM >= minOverlapM && (delta < crossAngleDeg || delta > 180 - crossAngleDeg)) {
      result.overlaps.push({ aLo: i0, aHi: i1, bLo: jMin, bHi: jMax, orientation: delta > 90 ? 'antiparallel' : 'parallel', lengthM })
      for (let p = i0; p <= i1; p++) overlapMask[p] = 1
      for (let p = jMin; p <= jMax; p++) overlapMask[p] = 1
    }
    i = i1 + 1
  }

  // ── Pass 2: CROSSINGS (geometric segment intersection, transversal, outside overlaps). ──
  // The crossing grid cell must be ≥ the longest segment, else two intersecting segments
  // can have midpoints farther apart than the 3×3 neighbourhood (a sparse route would miss
  // crossings). On dense resampled routes segments are ~metres, so this stays small.
  let maxSegLen = 0
  for (let s = 0; s < N - 1; s++) { const d = Math.hypot(X(s + 1) - X(s), Y(s + 1) - Y(s)); if (d > maxSegLen) maxSegLen = d }
  const scell = Math.max(cellM, maxSegLen)
  const sgrid = new Map()
  for (let s = 0; s < N - 1; s++) {
    const k = Math.floor(((X(s) + X(s + 1)) / 2) / scell) + ':' + Math.floor(((Y(s) + Y(s + 1)) / 2) / scell)
    let b = sgrid.get(k); if (!b) sgrid.set(k, b = []); b.push(s)
  }
  const minSin = Math.sin((crossAngleDeg * Math.PI) / 180)
  // Returns {x,y,t,u,sin} for a transversal intersection, else null.
  const inter = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const r1x = bx - ax, r1y = by - ay, r2x = dx - cx, r2y = dy - cy
    const den = r1x * r2y - r1y * r2x
    const l1 = Math.hypot(r1x, r1y), l2 = Math.hypot(r2x, r2y)
    if (l1 < 1e-9 || l2 < 1e-9) return null
    const sin = Math.abs(den) / (l1 * l2)
    if (sin < minSin) return null                     // near-parallel/antiparallel → not a crossing
    const t = ((cx - ax) * r2y - (cy - ay) * r2x) / den
    const u = ((cx - ax) * r1y - (cy - ay) * r1x) / den
    if (t < 0 || t > 1 || u < 0 || u > 1) return null
    return { x: ax + t * r1x, y: ay + t * r1y, t, u, sin }
  }
  const seen = new Set()
  for (let s = 0; s < N - 1; s++) {
    const ax = X(s), ay = Y(s), bx = X(s + 1), by = Y(s + 1)
    const baseX = Math.floor(((ax + bx) / 2) / scell), baseY = Math.floor(((ay + by) / 2) / scell)
    for (let gx = baseX - 1; gx <= baseX + 1; gx++) {
      for (let gy = baseY - 1; gy <= baseY + 1; gy++) {
        const bucket = sgrid.get(gx + ':' + gy); if (!bucket) continue
        for (const t2 of bucket) {
          if (t2 <= s + minIndexSep) continue
          const hit = inter(ax, ay, bx, by, X(t2), Y(t2), X(t2 + 1), Y(t2 + 1))
          if (!hit) continue
          const idxA = hit.t < 0.5 ? s : s + 1
          const idxB = hit.u < 0.5 ? t2 : t2 + 1
          if (overlapMask[idxA] && overlapMask[idxB]) continue   // parallel weave inside an overlap
          const dk = Math.round(hit.x / 5) + ':' + Math.round(hit.y / 5)
          if (seen.has(dk)) continue
          seen.add(dk)
          // segA/segB = the segment (lower index) each pass crosses on, so a caller can
          // INSERT the exact intersection point there for an accurate (kink-free) node.
          result.crossings.push({
            idxA, idxB, segA: s, segB: t2, lat: hit.y / 111320, lon: hit.x / mLon,
            zGapM: Math.abs((eles[idxA] || 0) - (eles[idxB] || 0)),
            angleDeg: Math.asin(Math.min(1, hit.sin)) * 180 / Math.PI,
          })
        }
      }
    }
  }
  return result
}

/**
 * Validate a route graph's structural integrity (references resolve, arcs connect).
 * @param {object} graph
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRouteGraph(graph) {
  const errors = []
  if (!graph || typeof graph !== 'object') return { ok: false, errors: ['graph is not an object'] }
  const nodes = graph.nodes || {}
  const segments = graph.segments || {}
  const route = graph.route || []

  for (const [id, seg] of Object.entries(segments)) {
    if (!(seg.from in nodes)) errors.push(`segment ${id}: from-node "${seg.from}" not in nodes`)
    if (!(seg.to in nodes)) errors.push(`segment ${id}: to-node "${seg.to}" not in nodes`)
    if (!Array.isArray(seg.points) || seg.points.length < 2) errors.push(`segment ${id}: needs ≥2 points`)
  }

  let prevEnd = null
  route.forEach((arc, i) => {
    const seg = segments[arc.segment]
    if (!seg) { errors.push(`route[${i}]: segment "${arc.segment}" not found`); prevEnd = null; return }
    if (arc.dir !== 'forward' && arc.dir !== 'reverse') errors.push(`route[${i}]: dir must be 'forward' or 'reverse'`)
    const startNode = arc.dir === 'reverse' ? seg.to : seg.from
    const endNode = arc.dir === 'reverse' ? seg.from : seg.to
    if (prevEnd != null && startNode !== prevEnd) {
      errors.push(`route[${i}]: starts at node "${startNode}" but previous arc ended at "${prevEnd}" (disconnected)`)
    }
    prevEnd = endNode
  })

  return { ok: errors.length === 0, errors }
}

/**
 * Compile a route (path along the graph) into a flat lat/lon/ele track.
 *
 * Each arc contributes its segment's points (reversed if `dir==='reverse'`), with
 * the two endpoints PINNED to the arc's start/end node coords so that:
 *   - consecutive arcs meet exactly at their shared node (no kink, no duplicate);
 *   - every pass through a crossing node shares that node's exact lat/lon/ele;
 *   - a reverse reuse of a segment is bit-identical to the forward pass reversed.
 *
 * The duplicate join point (end node of arc i == start node of arc i+1) is dropped.
 *
 * @param {object} graph — { nodes, segments, route }
 * @param {{ strict?: boolean }} [opts] — strict (default true) throws on validation errors
 * @returns {{ lats:number[], lons:number[], eles:number[], arcBounds:number[] }}
 *   arcBounds[i] = index in the flat output where arc i's contribution begins
 *   (useful later for editor highlighting / per-segment selection).
 */
export function compileRouteGraph(graph, opts = {}) {
  const strict = opts.strict !== false
  const { ok, errors } = validateRouteGraph(graph)
  if (!ok && strict) throw new Error('Invalid route graph:\n  ' + errors.join('\n  '))

  const nodes = graph.nodes || {}
  const segments = graph.segments || {}
  const route = graph.route || []

  const lats = [], lons = [], eles = [], arcBounds = []

  for (const arc of route) {
    const seg = segments[arc.segment]
    if (!seg) continue // non-strict: skip unknown segment
    const rev = arc.dir === 'reverse'
    const pts = rev ? seg.points.slice().reverse() : seg.points.slice()
    const startNode = nodes[rev ? seg.to : seg.from]
    const endNode = nodes[rev ? seg.from : seg.to]

    // Pin endpoints to node coords (exact crossings / joins).
    const emit = pts.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele }))
    if (startNode) emit[0] = { lat: startNode.lat, lon: startNode.lon, ele: startNode.ele }
    if (endNode) emit[emit.length - 1] = { lat: endNode.lat, lon: endNode.lon, ele: endNode.ele }

    // Drop the duplicate join point (this arc's start == previous arc's end node).
    // arcBounds[i] = index of arc i's first NEW point (after the shared join).
    const from = lats.length > 0 ? 1 : 0
    arcBounds.push(lats.length)
    for (let k = from; k < emit.length; k++) {
      lats.push(emit[k].lat); lons.push(emit[k].lon); eles.push(emit[k].ele)
    }
  }

  return { lats, lons, eles, arcBounds }
}

/**
 * Replace a structure segment's interior elevations with a straight grade between its endpoints
 * (mutates `points` in place — caller already owns a clone). No-op for fewer than 3 points.
 *
 * @param {{ele:number}[]} points
 */
function straightenStructureDeck(points) {
  const n = points.length
  if (n < 3) return
  const e0 = points[0].ele, e1 = points[n - 1].ele
  for (let i = 1; i < n - 1; i++) {
    points[i] = { ...points[i], ele: e0 + (e1 - e0) * (i / (n - 1)) }
  }
}

/**
 * Ease a segment's interior elevations near each end toward the node elevations it joins
 * (mutates `points` in place — caller already owns a clone). `compileRouteGraph` pins each arc's
 * endpoint to its node's `ele`, but the segment's own next-to-endpoint points keep their raw LIDAR
 * value — if that differs from the node mean, the pinned node point creates a small kink right at
 * the junction. A cos² ramp over the first/last `rampM` metres blends the interior points toward
 * `fromEle`/`toEle` (0 at the node, full LIDAR value by `rampM` in), so the approach eases smoothly
 * into the junction instead of jumping. No-op for fewer than 2 points or a non-finite node ele.
 * Ramps are capped to half the segment length so they can't overlap on a short segment.
 *
 * @param {{lat:number,lon:number,ele:number}[]} points
 * @param {number} fromEle - elevation of the node at points[0]
 * @param {number} toEle - elevation of the node at points[points.length-1]
 * @param {number} [rampM] - ramp distance in metres
 */
function blendSegmentEndsToNodes(points, fromEle, toEle, rampM = 15) {
  const n = points.length
  if (n < 2) return
  const dists = [0]
  for (let i = 1; i < n; i++) {
    dists.push(dists[i - 1] + haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon))
  }
  const total = dists[n - 1]
  if (total <= 0) return
  const ramp = Math.min(rampM, total / 2)
  if (ramp <= 0) return

  const ease = (t) => 0.5 - 0.5 * Math.cos(t * Math.PI) // 0 at node -> 1 at ramp end

  if (Number.isFinite(fromEle)) {
    for (let i = 0; i < n; i++) {
      const d = dists[i]
      if (d >= ramp) break
      const w = ease(d / ramp)
      points[i] = { ...points[i], ele: fromEle * (1 - w) + points[i].ele * w }
    }
  }
  if (Number.isFinite(toEle)) {
    for (let i = n - 1; i >= 0; i--) {
      const d = total - dists[i]
      if (d >= ramp) break
      const w = ease(d / ramp)
      points[i] = { ...points[i], ele: toEle * (1 - w) + points[i].ele * w }
    }
  }
}

/**
 * The interior junction-joint indices of a compiled track, read straight from its `arcBounds`.
 * `compileRouteGraph` records `arcBounds[i]` = arc i's first NEW point after the dropped duplicate
 * join, so the shared junction node between arc i-1 and arc i sits at `arcBounds[i] - 1`. The route
 * start (index 0) and end (last index) are terminal nodes, not interior crossings, so they're excluded.
 *
 * @param {number[]} arcBounds
 * @returns {number[]} sorted interior joint indices
 */
export function junctionJointIndices(arcBounds = []) {
  const out = []
  for (let i = 1; i < arcBounds.length; i++) out.push(arcBounds[i] - 1)
  return out
}

/**
 * Gaussian-fair a contiguous index range's XY and Z, pinning the two outer ends so it splices back
 * seamlessly (mutates the arrays in place). Distance weights use the supplied `dists` (the range is
 * small, so using the pre-smoothing distances for weights is accurate enough). XY and Z get separate
 * sigmas — Z usually wants a slightly wider window than the XY fairing.
 */
function smoothRangeXYZ(lats, lons, eles, dists, lo, hi, sigmaXY, sigmaZ) {
  if (hi - lo < 2) return
  const oLa = lats.slice(lo, hi + 1), oLo = lons.slice(lo, hi + 1), oEl = eles.slice(lo, hi + 1)
  const inv2x = 1 / (2 * sigmaXY * sigmaXY), inv2z = 1 / (2 * sigmaZ * sigmaZ)
  for (let i = lo + 1; i < hi; i++) {
    let wx = 0, la = 0, ln = 0, wz = 0, el = 0
    for (let j = lo; j <= hi; j++) {
      const dd = dists[j] - dists[i]
      const gx = Math.exp(-dd * dd * inv2x)
      la += oLa[j - lo] * gx; ln += oLo[j - lo] * gx; wx += gx
      const gz = Math.exp(-dd * dd * inv2z)
      el += oEl[j - lo] * gz; wz += gz
    }
    lats[i] = la / wx; lons[i] = ln / wx; eles[i] = el / wz
  }
}

/**
 * Unified XY+Z crossing-region "mesh" relax for a compiled course track (the flatten-crossings stage,
 * `~/.claude/plans/gpxforge-junction-z.md` #4b). At a junction joint two clean segments meet at the
 * pinned node coord forming a sharp dogleg; the Smooth step's inscribed fillet can ROUND an isolated
 * joint but CLAMPS on CLUSTERED crossings — the legs between two near-coincident nodes are too short to
 * fit the min-radius arc. The fix is the user's mesh idea: treat the crossing as a REGION (a window
 * spanning the whole cluster) and Gaussian-fair BOTH the XY and the Z across it at once, pinning only
 * the region's outer ends — the merged window is exactly the "room" the clamped fillet lacks, and the
 * unpinned interior rounds the doglegs and removes the residual Z bumpiness between the cluster's nodes.
 *
 * Per joint: a window of ±`windowM` is opened ONLY if the joint is an actual dogleg — turn between
 * `minTurnDeg` and `maxTurnDeg` (a near-straight through-crossing is left to the approach-blend; a
 * near-180° fold is a turnaround/hairpin, left to the Smooth step's turnaround/teardrop logic).
 * Overlapping windows merge, so a cluster of joints becomes one region. The track may pass one crossing
 * several times (different legs) — each pass is its own window and is faired in its own neighbourhood,
 * which is correct (a straight-through pass and a turning pass SHOULD differ at the node). Returns NEW
 * arrays; does not mutate the inputs. Reuse stays vertex-identical away from crossings (only the few
 * metres around joints move, where divergence between passes is expected).
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} eles
 * @param {number[]} jointIdxs - interior junction-joint indices (see `junctionJointIndices`)
 * @param {{windowM?:number,sigmaXY?:number,sigmaZ?:number,minTurnDeg?:number,maxTurnDeg?:number,baselineM?:number}} [opts]
 * @returns {{lats:number[],lons:number[],eles:number[]}}
 */
export function relaxCrossingRegions(lats, lons, eles, jointIdxs = [], opts = {}) {
  const windowM = opts.windowM ?? 12
  const sigmaXY = opts.sigmaXY ?? 5
  const sigmaZ = opts.sigmaZ ?? 6
  const minTurnDeg = opts.minTurnDeg ?? 8
  const maxTurnDeg = opts.maxTurnDeg ?? 150
  const baselineM = opts.baselineM ?? 5
  const n = lats.length
  const La = lats.slice(), Lo = lons.slice(), El = eles.slice()
  if (n < 3 || !jointIdxs.length) return { lats: La, lons: Lo, eles: El }

  const D = cumulativeDistances(lats, lons)
  // Walk `m` metres out from i in direction `step` (±1), clamped to the track ends.
  const walk = (i, m, step) => {
    let j = i
    while (j + step >= 0 && j + step < n && Math.abs(D[j + step] - D[i]) < m) j += step
    return j
  }

  const wins = []
  for (const ji of jointIdxs) {
    if (ji <= 0 || ji >= n - 1) continue
    const a = walk(ji, baselineM, -1), b = walk(ji, baselineM, +1)
    if (a === ji || b === ji) continue
    const turn = Math.abs(bearingDiff(bearing(La[a], Lo[a], La[ji], Lo[ji]), bearing(La[ji], Lo[ji], La[b], Lo[b])))
    if (turn < minTurnDeg || turn > maxTurnDeg) continue
    const lo = walk(ji, windowM, -1), hi = walk(ji, windowM, +1)
    if (hi - lo >= 2) wins.push([lo, hi])
  }
  if (!wins.length) return { lats: La, lons: Lo, eles: El }

  // Merge overlapping/touching windows → crossing regions (clustered joints fuse into the room a
  // single inscribed fillet lacks).
  wins.sort((x, y) => x[0] - y[0])
  const regions = [wins[0].slice()]
  for (let k = 1; k < wins.length; k++) {
    const last = regions[regions.length - 1]
    if (wins[k][0] <= last[1]) last[1] = Math.max(last[1], wins[k][1])
    else regions.push(wins[k].slice())
  }

  for (const [lo, hi] of regions) smoothRangeXYZ(La, Lo, El, D, lo, hi, sigmaXY, sigmaZ)
  return { lats: La, lons: Lo, eles: El }
}

/**
 * Write per-UNIQUE-segment elevations onto a course graph, then recompile the flat track.
 *
 * `eleBySegId[segId] = { lats, lons, eles }` is the LIDAR-sampled (densified) geometry for one unique
 * segment. Each named segment's `points` are REPLACED by that XY+Z, so every pass of a reused road
 * emits the same points → vertex-identical XY+Z by construction (no reconcile needed). Each node's
 * `ele` is set to the mean of the segment endpoints meeting there (compileRouteGraph pins arc
 * endpoints to `node.ele`, so without this junctions would compile to ele 0 — a spike).
 *
 * Operates on a deep clone — the input graph is not mutated. Returns the recompiled track AND the
 * updated (Z-bearing) graph so the caller can keep the graph as the source of truth.
 *
 * @param {{nodes:object,segments:object,route:object[]}} graph
 * @param {Object<string,{lats:number[],lons:number[],eles:number[]}>} eleBySegId
 * @returns {{ track:{lats,lons,eles,arcBounds}, graph:object }}
 */
export function applySegmentElevations(graph, eleBySegId) {
  const g = JSON.parse(JSON.stringify(graph))

  // Replace each unique segment's points with its LIDAR'd densified XY+Z.
  for (const [segId, geo] of Object.entries(eleBySegId || {})) {
    const seg = g.segments[segId]
    if (!seg || !geo || !geo.lats || !geo.lats.length) continue
    seg.points = geo.lats.map((la, i) => ({ lat: la, lon: geo.lons[i], ele: geo.eles[i] }))
    // A bridge deck or tunnel ceiling isn't in the LIDAR DTM — the interior samples are the
    // ground/water below (or terrain above), not the structure. The endpoints sit on solid
    // ground at the abutments and are trustworthy, so replace the interior with a straight
    // grade between them rather than the void dip/spike.
    if (seg.bridge || seg.tunnel) straightenStructureDeck(seg.points)
  }

  // Node Z = mean of the segment endpoints that meet at the node (they sample ~the same coord, so they
  // agree; the mean is robust to tiny server-resample drift). Pins real junction elevation at recompile.
  const acc = {}
  for (const seg of Object.values(g.segments)) {
    if (!seg.points || seg.points.length < 1) continue
    const a = seg.points[0], b = seg.points[seg.points.length - 1]
    if (seg.from != null && a) { (acc[seg.from] || (acc[seg.from] = [])).push(a.ele) }
    if (seg.to != null && b) { (acc[seg.to] || (acc[seg.to] = [])).push(b.ele) }
  }
  for (const [id, eles] of Object.entries(acc)) {
    const vals = eles.filter((e) => Number.isFinite(e))
    if (g.nodes[id] && vals.length) g.nodes[id].ele = vals.reduce((s, e) => s + e, 0) / vals.length
  }

  // Ease each segment's approach into its end nodes, now that node.ele is final — removes the small
  // kink where a segment's own LIDAR value differs from the (pinned) node mean.
  for (const seg of Object.values(g.segments)) {
    if (!seg.points || seg.points.length < 2) continue
    const fromEle = g.nodes[seg.from]?.ele
    const toEle = g.nodes[seg.to]?.ele
    blendSegmentEndsToNodes(seg.points, fromEle, toEle)
  }

  const track = compileRouteGraph(g, { strict: false })

  // Crossing-region mesh: fair the XY doglegs and smooth the residual Z bumpiness where segments meet
  // at (clustered) junctions — the flatten-crossings stage. Operates on the compiled track using the
  // exact arc-boundary joints; segment interiors away from crossings are untouched, so reuse stays
  // vertex-identical there.
  const joints = junctionJointIndices(track.arcBounds)
  const relaxed = relaxCrossingRegions(track.lats, track.lons, track.eles, joints)

  return { track: { ...track, ...relaxed }, graph: g }
}

/**
 * Build a route graph from a single flat route by cutting it at node indices.
 *
 * The "annotate a loaded route" foundation: the linear route becomes a chain of
 * directed segments (node[k] → node[k+1]) in route order, all `forward`. Start (0)
 * and end (N-1) are always nodes. If the route is a closed loop (start ≈ end within
 * `loopThreshM`), the final node is folded back into the start node so the chain
 * closes on one node.
 *
 * Reuse/overlap is NOT applied here — every span is its own segment. Call
 * `mergeSegmentsInGraph` afterward to declare two spans the same road (which is what
 * collapses an out-and-back / lap to vertex-identical shared geometry).
 *
 * @param {{lats:number[],lons:number[],eles:number[]}} route
 * @param {number[]} nodeIndices — indices on the route where nodes sit (any order)
 * @param {{ loopThreshM?:number }} [opts]
 * @returns {{ nodes:object, segments:object, route:object[], loop:boolean, nodeOrder:string[] }}
 */
export function buildGraphFromRoute(route, nodeIndices = [], opts = {}) {
  const { lats, lons, eles } = route
  const N = lats.length
  const loopThreshM = opts.loopThreshM ?? 30
  const loop = N > 3 && haversine(lats[0], lons[0], lats[N - 1], lons[N - 1]) <= loopThreshM

  // Normalise: include endpoints, clamp, unique, sorted.
  const idx = Array.from(new Set([0, ...nodeIndices.map((i) => Math.round(i)), N - 1]))
    .filter((i) => i >= 0 && i < N)
    .sort((a, b) => a - b)

  const nodes = {}, segments = {}, routeArr = [], nodeOrder = []
  idx.forEach((i, k) => {
    const id = 'n' + k
    nodes[id] = { lat: lats[i], lon: lons[i], ele: eles[i], idx: i }
    nodeOrder.push(id)
  })

  // Fold the closing node into n0 for a loop (so the chain returns to start).
  let lastNodeId = nodeOrder[nodeOrder.length - 1]
  if (loop && nodeOrder.length > 1) {
    delete nodes[lastNodeId]
    nodeOrder[nodeOrder.length - 1] = 'n0'
    lastNodeId = 'n0'
  }

  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = idx[k + 1]
    const points = []
    for (let i = a; i <= b; i++) points.push({ lat: lats[i], lon: lons[i], ele: eles[i] })
    const id = 's' + k
    // srcLo/srcHi = the true route index range this segment was sliced from. Kept so
    // callers can match a segment by its source span even after loop-folding rewrites
    // the to-node back to n0 (which would otherwise lose the real end index).
    segments[id] = { from: nodeOrder[k], to: nodeOrder[k + 1], points, srcLo: a, srcHi: b }
    routeArr.push({ segment: id, dir: 'forward' })
  }

  return { nodes, segments, route: routeArr, loop, nodeOrder }
}

/**
 * Declare two segments the SAME road: drop `dropId` and repoint every route arc that
 * used it to `keepId`, flipping direction when the dropped span runs opposite to the
 * kept one. After compile, both spans then use `keepId`'s EXACT vertices — i.e. the
 * vertex-identical reuse that renders as one road in BikeTerra (the same guarantee as
 * `unifyOverlap`, but expressed in the graph). Orientation is decided by comparing the
 * two segments' physical endpoint coords (via their nodes), not node ids.
 *
 * @param {object} graph — from buildGraphFromRoute (mutated copy returned)
 * @param {string} keepId @param {string} dropId
 * @param {{ matchM?:number }} [opts]
 * @returns {object|null} new graph, or null if the two segments don't share endpoints
 *   (not actually the same road) or ids are invalid.
 */
/**
 * Orientation of `dropId` relative to `keepId` if they're the same road (endpoints coincide within
 * `matchM`): 'forward' (same direction), 'reverse' (opposite), or null (different road / bad ids).
 * Exported so a caller can re-map a separately-held arc list (e.g. a picked course) the same way
 * `mergeSegmentsInGraph` re-maps `graph.route`.
 */
export function segmentMergeRelation(graph, keepId, dropId, opts = {}) {
  if (keepId === dropId) return null
  const matchM = opts.matchM ?? 25
  const keep = graph.segments[keepId], drop = graph.segments[dropId]
  if (!keep || !drop) return null
  const n = graph.nodes
  const same = (a, b) => a && b && haversine(a.lat, a.lon, b.lat, b.lon) <= matchM
  const kf = n[keep.from], kt = n[keep.to], df = n[drop.from], dt = n[drop.to]
  if (same(df, kf) && same(dt, kt)) return 'forward'
  if (same(df, kt) && same(dt, kf)) return 'reverse'
  return null
}

export function mergeSegmentsInGraph(graph, keepId, dropId, opts = {}) {
  const rel = segmentMergeRelation(graph, keepId, dropId, opts)
  if (!rel) return null // endpoints don't match → not the same road (or bad ids)
  const flip = (d) => (d === 'forward' ? 'reverse' : 'forward')
  const segments = { ...graph.segments }
  delete segments[dropId]
  const routeArr = graph.route.map((arc) =>
    arc.segment === dropId
      ? { segment: keepId, dir: rel === 'forward' ? arc.dir : flip(arc.dir) }
      : { ...arc })

  return { ...graph, segments, route: routeArr }
}

/**
 * Merge graph `b` INTO graph `a`, unifying by shared OSM-vertex coordinate. Every `b` node that
 * lands within `tolM` of an existing `a` node is folded onto it (the shared junction); the rest get
 * fresh node ids. Every `b` segment is re-added with fresh ids and its endpoints remapped to the
 * unified nodes — so drawn/imported roads CONNECT to the existing network exactly where they touch
 * a shared vertex (the "draw additional roads onto an imported track" case). `a.route` is preserved
 * (the picked course); `b.route` is ignored (b contributes geometry to pick from, not a course).
 *
 * @param {object} a — base graph (kept) @param {object} b — graph to splice in
 * @param {{ tolM?:number }} [opts] — tolM (1.5 m): shared-vertex match radius (OSM coords are exact).
 * @returns {object} unified graph
 */
export function unifyGraphs(a, b, opts = {}) {
  const tolM = opts.tolM ?? 1.5
  const nodes = { ...a.nodes }
  const segments = { ...a.segments }
  const aIds = Object.keys(a.nodes)
  const findNear = (lat, lon) => {
    let best = null, bd = tolM
    for (const id of aIds) { const n = nodes[id]; const d = haversine(lat, lon, n.lat, n.lon); if (d <= bd) { bd = d; best = id } }
    return best
  }
  const map = {}
  for (const [bid, bn] of Object.entries(b.nodes || {})) {
    const near = findNear(bn.lat, bn.lon)
    if (near) { map[bid] = near; continue }
    const nid = freshId(nodes, 'n')
    nodes[nid] = { ...bn }
    map[bid] = nid
  }
  for (const [, bs] of Object.entries(b.segments || {})) {
    const sid = freshId(segments, 's')
    segments[sid] = { ...bs, from: map[bs.from] || bs.from, to: map[bs.to] || bs.to }
  }
  return { ...a, nodes, segments, route: (a.route || []).slice() }
}

/** Mint a fresh id `<prefix><n>` not present as a key in `obj` (and not in `extra`). */
function freshId(obj, prefix, extra = null) {
  let n = 0
  for (const k of Object.keys(obj)) {
    const m = new RegExp('^' + prefix + '(\\d+)$').exec(k)
    if (m) n = Math.max(n, +m[1] + 1)
  }
  let id = prefix + n
  while (obj[id] || (extra && extra[id])) { n++; id = prefix + n }
  return id
}

/**
 * Split one segment at an interior point into TWO segments joined by a new node, and re-map every
 * route arc that traversed it. This is the graph-native "split a segment" for the Course Builder:
 * targeted surgery — only the touched arcs change, the rest of the picked course is preserved.
 *
 *   - `seg` (from→to, points[0..L]) splits at `ptIdx` (0 < ptIdx < L) into
 *       s1: from → newNode, points[0..ptIdx]   and   s2: newNode → to, points[ptIdx..L]
 *     A new node sits at points[ptIdx]. Way tags (wayId/highway/oneway/…) carry to both halves;
 *     srcLo/srcHi (if present) are recomputed for each half.
 *   - Every route arc `{segment, dir}` using the split segment becomes TWO arcs:
 *       forward → [s1 fwd, s2 fwd]   ;   reverse → [s2 rev, s1 rev]
 *     so the traversal order/geometry is identical.
 *
 * @param {object} graph @param {string} segId @param {number} ptIdx — interior point index
 * @returns {{ graph:object, segIds:[string,string], nodeId:string } | null}
 *   null if the segment is missing or ptIdx is not interior.
 */
export function splitSegmentInGraph(graph, segId, ptIdx) {
  const seg = graph.segments[segId]
  if (!seg || !Array.isArray(seg.points)) return null
  const L = seg.points.length - 1
  const i = Math.round(ptIdx)
  if (i <= 0 || i >= L) return null   // must produce two non-empty halves

  const nodeId = freshId(graph.nodes, 'n')
  const s1Id = freshId(graph.segments, 's')
  const s2Id = freshId(graph.segments, 's', { [s1Id]: 1 })
  const mid = seg.points[i]

  const nodes = { ...graph.nodes, [nodeId]: { lat: mid.lat, lon: mid.lon, ele: mid.ele } }

  // Carry every tag except the ones we recompute (from/to/points/srcLo/srcHi).
  const { from, to, points, srcLo, srcHi, ...tags } = seg
  const s1 = { ...tags, from: seg.from, to: nodeId, points: seg.points.slice(0, i + 1) }
  const s2 = { ...tags, from: nodeId, to: seg.to, points: seg.points.slice(i) }
  if (typeof srcLo === 'number') { s1.srcLo = srcLo; s1.srcHi = srcLo + i }
  if (typeof srcHi === 'number') { s2.srcLo = srcLo + i; s2.srcHi = srcHi }

  const segments = { ...graph.segments }
  delete segments[segId]
  segments[s1Id] = s1
  segments[s2Id] = s2

  return { graph: { ...graph, nodes, segments, route: splitArcsInList(graph.route || [], segId, s1Id, s2Id) }, segIds: [s1Id, s2Id], nodeId }
}

/**
 * Re-map an arc list after a segment split: replace each arc using `segId` with the two
 * halves in traversal order. Forward → [s1, s2]; reverse → [s2, s1] (each reversed).
 * Exported so callers (Course Builder) can apply the same split to a separately-held course /
 * imported-ride arc list.
 */
export function splitArcsInList(arcs, segId, s1Id, s2Id) {
  const out = []
  for (const arc of arcs) {
    if (arc.segment !== segId) { out.push({ ...arc }); continue }
    if (arc.dir === 'reverse') out.push({ segment: s2Id, dir: 'reverse' }, { segment: s1Id, dir: 'reverse' })
    else out.push({ segment: s1Id, dir: 'forward' }, { segment: s2Id, dir: 'forward' })
  }
  return out
}

/** Mean point-to-point distance (m) between two point lists, sampled proportionally. */
function geometryMeanDistM(pa, pb, samples = 8) {
  const at = (pts, t) => pts[Math.min(pts.length - 1, Math.max(0, Math.round(t * (pts.length - 1))))]
  let sum = 0
  for (let k = 0; k <= samples; k++) {
    const a = at(pa, k / samples), b = at(pb, k / samples)
    sum += haversine(a.lat, a.lon, b.lat, b.lon)
  }
  return sum / (samples + 1)
}

/**
 * Auto-merge DUPLICATE ROADS — segments that share both endpoint nodes (forward or reversed)
 * AND whose geometry is near-identical are the same physical road retraced (a multipass / lap /
 * out-and-back). Collapsing them to one vertex-identical segment is what a multipass route needs:
 * it renders as ONE road in BikeTerra and declutters the editor (no stack of overlapping legs /
 * direction arrows at a junction), while course reuse is preserved (the merged segment can still
 * be traversed N times). Two same-endpoint segments with DIFFERENT geometry (a divided
 * carriageway, or two distinct roads between the same junctions) are left separate.
 *
 * Safe by construction: the match is exact endpoint-node identity + a small geometry tolerance,
 * not a proximity/overlap threshold guess.
 *
 * @param {object} graph
 * @param {{ tolM?:number }} [opts] — tolM (6): max mean point distance to call two the same road.
 * @returns {object} new graph (fewer segments; route arcs repointed)
 */
export function mergeDuplicateRoads(graph, opts = {}) {
  const tolM = opts.tolM ?? 6
  let g = graph
  let changed = true
  while (changed) {
    changed = false
    const ids = Object.keys(g.segments)
    for (let i = 0; i < ids.length && !changed; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = g.segments[ids[i]], b = g.segments[ids[j]]
        if (!a || !b) continue
        const fwd = a.from === b.from && a.to === b.to
        const rev = a.from === b.to && a.to === b.from
        if (!fwd && !rev) continue
        const bPts = rev ? b.points.slice().reverse() : b.points
        if (geometryMeanDistM(a.points, bPts) > tolM) continue   // same endpoints, different road
        const res = mergeSegmentsInGraph(g, ids[i], ids[j])
        if (res) { g = res; changed = true; break }
      }
    }
  }
  return g
}

/**
 * Snap a same-level crossing: merge two nodes that sit at the same physical place
 * (the two visits to one junction) into ONE shared node. Every segment endpoint that
 * referenced either node now references the kept node, so the compiler pins all legs
 * through the crossing to one exact XY/Z — the crossing is a single flat point, not
 * two near-coincident ones. The shared elevation defaults to the mean of the two
 * (a same-level crossing has one elevation).
 *
 * For a MULTILEVEL crossing (overpass), do NOT call this — keep the two nodes separate
 * so each level retains its own Z.
 *
 * @param {object} graph @param {string} keepId @param {string} dropId
 * @param {{ matchM?:number, ele?:number, dropSelfLoopMaxM?:number }} [opts]
 *   - dropSelfLoopMaxM (Infinity): a segment that becomes `from===to` after the merge is a
 *     self-loop; drop it only when its geometry is shorter than this (a tiny H-connector).
 *     Default Infinity drops every self-loop (the H→X collapse). The hub builder passes a
 *     finite value so a real LAP between two visits to one junction is KEPT as a self-loop arc.
 * @returns {object|null} new graph, or null if ids invalid or the nodes are too far
 *   apart to be the same crossing (> matchM).
 */
export function mergeNodesInGraph(graph, keepId, dropId, opts = {}) {
  if (keepId === dropId) return null
  const keep = graph.nodes[keepId], drop = graph.nodes[dropId]
  if (!keep || !drop) return null
  const matchM = opts.matchM ?? 30
  if (haversine(keep.lat, keep.lon, drop.lat, drop.lon) > matchM) return null
  const dropSelfLoopMaxM = opts.dropSelfLoopMaxM ?? Infinity

  const ele = opts.ele != null ? opts.ele : (keep.ele + drop.ele) / 2
  const nodes = { ...graph.nodes }
  delete nodes[dropId]
  nodes[keepId] = { ...keep, ele }

  const segLengthM = (pts) => {
    let s = 0
    for (let k = 1; k < pts.length; k++) s += haversine(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon)
    return s
  }
  const segments = {}
  const degenerate = new Set()
  for (const [id, s] of Object.entries(graph.segments)) {
    const ns = { ...s }
    if (ns.from === dropId) ns.from = keepId
    if (ns.to === dropId) ns.to = keepId
    // A segment that now starts and ends at the same node is a self-loop. A SHORT one is a
    // collapsed connector (e.g. an H-junction snapped to an X) — drop it and its route arcs.
    // A LONG one is a real lap between two visits to this junction — keep it.
    if (ns.from === ns.to && segLengthM(ns.points) <= dropSelfLoopMaxM) { degenerate.add(id); continue }
    segments[id] = ns
  }
  const route = (graph.route || []).filter((arc) => !degenerate.has(arc.segment))
  const nodeOrder = graph.nodeOrder ? graph.nodeOrder.map((n) => (n === dropId ? keepId : n)) : undefined
  return { ...graph, nodes, segments, route, nodeOrder }
}

/**
 * Snap coincident same-level crossing nodes into single shared junctions (GPXmagic-style
 * clustering). A self-crossing / multi-pass route places a near-coincident node on every
 * visit to one physical junction; this greedily clusters nodes that sit at the same place
 * AND the same level (elevation gap ≤ `sameLevelM`) and folds each cluster of ≥2 into ONE
 * node via repeated `mergeNodesInGraph` (which already drops any degenerate `from===to`
 * connector — the H→X collapse). Multilevel pairs (overpass) exceed the level gate and stay
 * separate so each level keeps its own Z. No leg enumeration, no synthetic geometry — the
 * node stays on the real (inserted-intersection) vertex, so the compiler's endpoint pin is
 * a no-op and no edge is pulled.
 *
 * @param {object} graph
 * @param {{ matchM?:number, sameLevelM?:number }} [opts]
 * @returns {{ graph:object, merged:number }} merged = number of junctions collapsed.
 */
export function snapCoincidentCrossings(graph, opts = {}) {
  const matchM = opts.matchM ?? 6
  const sameLevelM = opts.sameLevelM ?? 2
  const entries = Object.entries(graph.nodes || {})
  const claimed = new Set()
  let g = graph
  let merged = 0
  for (let i = 0; i < entries.length; i++) {
    const [idA, a] = entries[i]
    if (claimed.has(idA)) continue
    const group = [idA]
    claimed.add(idA)
    for (let j = i + 1; j < entries.length; j++) {
      const [idB, b] = entries[j]
      if (claimed.has(idB)) continue
      if (haversine(a.lat, a.lon, b.lat, b.lon) <= matchM && Math.abs((a.ele || 0) - (b.ele || 0)) <= sameLevelM) {
        group.push(idB); claimed.add(idB)
      }
    }
    if (group.length < 2) continue
    const keep = group[0]
    for (let k = 1; k < group.length; k++) {
      const r = mergeNodesInGraph(g, keep, group[k], { matchM: matchM * 3 })
      if (r) g = r
    }
    merged++
  }
  return { graph: g, merged }
}
