/**
 * Shared graph routing for the Course Builder — shortest paths over a `{ nodes, segments }` graph.
 *
 * Two consumers:
 *   1. Course PICKING — click a far node → fill the shortest path of legs to it (waypoint routing
 *      constrained to the fetched roads), so you don't have to click every adjacent node.
 *   2. The HMM map-matcher (track import) — node-to-node network distance is the transition model.
 *
 * Pure (no DOM, no ST, no network). Segment weight = its real polyline length in metres.
 */

import { haversine } from './math.js'

/** Real polyline length (m) of a segment's points. Memoised onto the segment object (`_lenM`). */
export function segLengthM(seg) {
  if (seg._lenM != null) return seg._lenM
  let m = 0
  const p = seg.points
  for (let i = 1; i < p.length; i++) m += haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon)
  seg._lenM = m
  return m
}

/**
 * Adjacency list for the graph: nodeId → [{ to, segment, dir, lengthM }]. Each undirected segment
 * contributes two directed edges. Build once and reuse across many shortest-path queries.
 */
export function buildAdjacency(graph) {
  const adj = new Map()
  const push = (from, e) => { if (!adj.has(from)) adj.set(from, []); adj.get(from).push(e) }
  for (const [id, s] of Object.entries(graph.segments || {})) {
    const len = segLengthM(s)
    push(s.from, { to: s.to, segment: id, dir: 'forward', lengthM: len })
    push(s.to, { to: s.from, segment: id, dir: 'reverse', lengthM: len })
  }
  return adj
}

/**
 * Dijkstra shortest path between two nodes, weighted by segment length.
 *
 * @param {{nodes:Object,segments:Object}} graph
 * @param {string} fromNode
 * @param {string} toNode
 * @param {{ adj?:Map, maxDistM?:number }} [opts] — adj: prebuilt adjacency (reuse across calls);
 *   maxDistM: stop expanding past this distance (bounds work — returns null if `toNode` is farther).
 * @returns {{ arcs:Array<{segment:string,dir:string}>, distM:number } | null}
 */
export function shortestPath(graph, fromNode, toNode, opts = {}) {
  if (fromNode === toNode) return { arcs: [], distM: 0 }
  if (!graph.nodes?.[fromNode] || !graph.nodes?.[toNode]) return null
  const adj = opts.adj || buildAdjacency(graph)
  const maxDistM = opts.maxDistM ?? Infinity

  const dist = new Map([[fromNode, 0]])
  const prev = new Map([[fromNode, null]]) // node → { from, arc }
  // Simple binary-heap-free PQ: array scanned for the min. Graphs here are small (a corridor /
  // a drawn area), so an O(V²) Dijkstra is fine and dependency-free.
  const pq = new Set([fromNode])
  while (pq.size) {
    let cur = null, curD = Infinity
    for (const n of pq) { const d = dist.get(n); if (d < curD) { curD = d; cur = n } }
    pq.delete(cur)
    if (cur === toNode) break
    if (curD > maxDistM) continue
    for (const e of (adj.get(cur) || [])) {
      const nd = curD + e.lengthM
      if (nd > maxDistM) continue
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd)
        prev.set(e.to, { from: cur, arc: { segment: e.segment, dir: e.dir } })
        pq.add(e.to)
      }
    }
  }
  if (!prev.has(toNode)) return null
  const arcs = []
  let n = toNode
  while (prev.get(n)) { arcs.unshift(prev.get(n).arc); n = prev.get(n).from }
  return { arcs, distM: dist.get(toNode) }
}

/**
 * Bounded single-source shortest DISTANCES to every node within `maxDistM` (for the matcher's
 * transition model — many distance lookups from one candidate's node, no arc reconstruction).
 *
 * @returns {Map<string,number>} nodeId → distance (m); only nodes within maxDistM are present.
 */
export function shortestDistances(graph, fromNode, opts = {}) {
  const adj = opts.adj || buildAdjacency(graph)
  const maxDistM = opts.maxDistM ?? Infinity
  const dist = new Map([[fromNode, 0]])
  const pq = new Set([fromNode])
  while (pq.size) {
    let cur = null, curD = Infinity
    for (const n of pq) { const d = dist.get(n); if (d < curD) { curD = d; cur = n } }
    pq.delete(cur)
    if (curD > maxDistM) continue
    for (const e of (adj.get(cur) || [])) {
      const nd = curD + e.lengthM
      if (nd > maxDistM) continue
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); pq.add(e.to) }
    }
  }
  return dist
}
