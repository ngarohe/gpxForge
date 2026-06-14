/**
 * Topology Editor — annotate a loaded route into a directed route graph, then
 * compile it back to a flat (BikeTerra-correct) GPX.
 *
 * The user drops NODES on the loaded route (turnarounds, crossings, junctions);
 * the route auto-slices into directed SEGMENTS between consecutive nodes. Declaring
 * two segments "the same road" makes the compiler reuse one vertex set for both
 * passes — vertex-identical, so an out-and-back / lap renders as a single road
 * (validated in BikeTerra). New segments can also be drawn (route-builder style) and
 * spliced in — that wiring lands with the map UI; this module owns the graph state
 * and operations.
 *
 * Module-level state (not in ST — a temporary authoring mode, like route-builder).
 * Pure graph math lives in utils/route-graph.js; this module is the stateful glue
 * the UI drives. Rendering is delegated to the map layer.
 */

import {
  buildGraphFromRoute,
  mergeSegmentsInGraph,
  mergeNodesInGraph,
  mergeDuplicateRoads,
  analyzeSelfTopology,
  compileRouteGraph,
  validateRouteGraph,
} from '../utils/route-graph.js'
import { detectOsmJunctions, buildOsmHubGraph, junctionLegs, addJunctionLegs } from '../utils/osm-junctions.js'
import { haversine } from '../utils/math.js'
import { roundJunctions } from '../utils/junction-arcs.js'

// ────────────────────────────────────────────────────────────────────
// Module state
// ────────────────────────────────────────────────────────────────────

let _active = false
let _baseRoute = null        // { lats, lons, eles } — the route being annotated
let _nodeIdx = []            // route indices where the user placed nodes (excl. auto 0/N-1)
let _graph = null            // current derived+merged graph (route-graph format)
let _selectedSegs = []       // up to 2 segment ids selected for a merge
let _selectedNodes = []      // up to 2 node ids selected for a crossing snap
let _history = []            // undo snapshots of { nodeIdx, graph } (cap 30)
let _building = false        // course-assembly mode: clicks append to the sequence
let _course = []             // the course being built: ordered [{ segment, dir }]
let _roundabouts = []        // detected roundabouts (highlight only): [{ lo, hi, ringWayId, ringPoints }]
let _junctions = []          // last detectStructure() junctions (centre+visits) — for ◎ Complete junctions

// Callbacks registered by main.js / the UI.
let _onUpdate = null         // () => void — after any state change (re-render)
let _onStatus = null         // (msg: string) => void

// ────────────────────────────────────────────────────────────────────
// Getters (for rendering)
// ────────────────────────────────────────────────────────────────────

export function isTopologyActive() { return _active }
export function getTopologyGraph() { return _graph }
export function getTopologyBaseRoute() { return _baseRoute }
export function getSelectedSegments() { return _selectedSegs.slice() }
export function getSelectedNodes() { return _selectedNodes.slice() }
export function getNodeIndices() { return _nodeIdx.slice() }
export function canUndoTopology() { return _history.length > 0 }
export function isBuildingCourse() { return _building }
export function getCourse() { return _course.slice() }
export function getCourseSegmentIds() { return _course.map((a) => a.segment) }

/** Segment summary for the panel: id, point count, length-ish, reuse count in route. */
export function getSegmentSummaries() {
  if (!_graph) return []
  const useCount = {}
  for (const arc of _graph.route) useCount[arc.segment] = (useCount[arc.segment] || 0) + 1
  return Object.entries(_graph.segments).map(([id, s]) => ({
    id, from: s.from, to: s.to, points: s.points.length, uses: useCount[id] || 0,
    selected: _selectedSegs.includes(id),
  }))
}

// ────────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────────

export function setTopologyCallbacks({ onUpdate, onStatus } = {}) {
  if (onUpdate) _onUpdate = onUpdate
  if (onStatus) _onStatus = onStatus
}

const notify = () => { if (_onUpdate) _onUpdate() }
const status = (m) => { if (_onStatus) _onStatus(m) }

/**
 * Enter the editor on a copy of the given route.
 * @param {{lats:number[],lons:number[],eles:number[]}} route
 */
export function enterTopology(route) {
  if (!route || !route.lats || route.lats.length < 2) { status('Load a route first.'); return false }
  _active = true
  _baseRoute = {
    lats: route.lats.slice(),
    lons: route.lons.slice(),
    eles: (route.eles || route.lats.map(() => 0)).slice(),
  }
  _nodeIdx = []
  _selectedSegs = []
  _selectedNodes = []
  _history = []
  _building = false
  _course = []
  rebuild()
  status(`Topology editor: ${_graph.segments && Object.keys(_graph.segments).length} segment(s). Click the route to drop nodes; select two segments to merge.`)
  notify()
  return true
}

export function exitTopology() {
  _active = false
  _baseRoute = null
  _graph = null
  _nodeIdx = []
  _selectedSegs = []
  _selectedNodes = []
  _history = []
  _building = false
  _course = []
  _roundabouts = []
  _junctions = []
  notify()
}

/**
 * Store detected roundabouts (Stage 1 analysis) for map highlighting.
 * @param {Array<{lo:number,hi:number,ringWayId:number,ringPoints?:Array}>} list
 */
export function setRoundabouts(list) { _roundabouts = Array.isArray(list) ? list : [] }
/** Detected roundabouts (for the map layer). */
export function getRoundabouts() { return _roundabouts }

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

function snapshot() {
  // _baseRoute is stored by reference (never mutated in place — insertion REPLACES it with
  // a new object), so a snapshot keeps the prior arrays intact for undo.
  _history.push({ nodeIdx: _nodeIdx.slice(), graph: _graph ? structuredCloneGraph(_graph) : null, baseRoute: _baseRoute })
  if (_history.length > 30) _history.shift()
}

function structuredCloneGraph(g) {
  // Shallow-ish clone preserving segment point arrays (they are large but shared-safe to copy refs;
  // merges/rebuilds replace whole arrays, never mutate in place).
  return {
    nodes: { ...g.nodes },
    segments: Object.fromEntries(Object.entries(g.segments).map(([k, s]) => [k, { ...s }])),
    route: g.route.map((a) => ({ ...a })),
    loop: g.loop,
    nodeOrder: g.nodeOrder ? g.nodeOrder.slice() : undefined,
  }
}

/** Re-derive the base graph from the current node set. Clears merges + selection +
 *  any in-progress course (its segment ids would be stale after re-slicing). */
function rebuild() {
  _graph = buildGraphFromRoute(_baseRoute, _nodeIdx)
  _selectedSegs = []
  _selectedNodes = []
  _course = []
  _junctions = []   // graph re-sliced → detected junctions (and their stubs) are stale
}

// ────────────────────────────────────────────────────────────────────
// Operations (UI-facing)
// ────────────────────────────────────────────────────────────────────

/**
 * Add a node at a route index (nearest existing route point). Re-slices the graph,
 * which clears any merges (place nodes first, then merge — v1 simplification).
 */
export function addNodeAtIndex(idx) {
  if (!_active || !_baseRoute) return
  const i = Math.round(idx)
  if (i <= 0 || i >= _baseRoute.lats.length - 1) { status('Pick a point inside the route.'); return }
  if (_nodeIdx.includes(i)) return
  const hadMerges = _graph && _graph.route.length !== Object.keys(_graph.segments).length
  snapshot()
  _nodeIdx.push(i)
  _nodeIdx.sort((a, b) => a - b)
  rebuild()
  status(hadMerges
    ? 'Node added — merges were reset (place all nodes, then merge).'
    : `Node added (${_nodeIdx.length} total, ${Object.keys(_graph.segments).length} segments).`)
  notify()
}

/** Add a node by distance fraction along the base route (chart/map click → frac). */
export function addNodeAtFrac(frac) {
  if (!_active || !_baseRoute) return
  const n = _baseRoute.lats.length
  addNodeAtIndex(Math.max(1, Math.min(n - 2, Math.round(frac * (n - 1)))))
}

/** Toggle a segment in the selection (max 2; selecting a 3rd replaces the oldest). */
export function toggleSegmentSelection(segId) {
  if (!_graph || !_graph.segments[segId]) return
  const at = _selectedSegs.indexOf(segId)
  if (at >= 0) _selectedSegs.splice(at, 1)
  else { _selectedSegs.push(segId); if (_selectedSegs.length > 2) _selectedSegs.shift() }
  notify()
}

/**
 * Merge the two selected segments into one shared road (keep the first selected,
 * drop the second). Vertex-identical reuse → one rendered road.
 */
export function mergeSelected() {
  if (_selectedSegs.length !== 2) { status('Select exactly two segments to merge.'); return }
  const [keepId, dropId] = _selectedSegs
  const merged = mergeSegmentsInGraph(_graph, keepId, dropId)
  if (!merged) { status('Those two segments are not the same road (endpoints don’t match).'); return }
  snapshot()
  _graph = merged
  _selectedSegs = []
  status(`Merged ${dropId} into ${keepId} — now one shared road, reused ${_graph.route.filter((a) => a.segment === keepId).length}×.`)
  notify()
}

/**
 * Detect structure (OSM-graph hub model). Junctions come from the OSM road graph nodes the
 * route passes through (`detectOsmJunctions`), keyed by their EXACT OSM vertex — so two passes
 * through one junction anchor to the same point with no threshold, and distinct parallel roads
 * (different vertices) are never merged. A node is created only where the ROUTE itself branches
 * (≥3 distinct incident edge directions across its passes) or turns around (a fold), which keeps
 * through-passes and shared-road interiors from over-noding. `buildOsmHubGraph` places one node
 * per junction at its centre and connects every leg to it (every turning movement routable); the
 * compiler pins each incident edge onto the exact OSM centre (a small on-road pull) and the round
 * pass blends the join.
 *
 * OVERLAP boundaries are added as plain nodes too (so each pass is its own segment) but overlaps
 * are NOT merged — reuse stays the user's call (manual ⋀ Merge sel). Edges keep the original
 * snapped geometry; no synthetic connector arcs, no canonical-ring substitution.
 *
 * @param {{ radiusM?:number, junctionNodes?:Array }} [opts] — junctionNodes = OSM graph nodes
 *   from way-matching (ST.routeJunctionNodes); empty/omitted → folds-only graceful fallback.
 * @returns {number} junctions + overlaps found
 */
export function detectStructure(opts = {}) {
  if (!_active || !_baseRoute) return 0
  const junctions = detectOsmJunctions(_baseRoute, opts.junctionNodes || [], opts)
  const { overlaps } = analyzeSelfTopology(_baseRoute.lats, _baseRoute.lons, _baseRoute.eles, opts)
  if (!junctions.length && !overlaps.length) { status('No junctions or overlaps found on this route.'); return 0 }

  snapshot()

  // Overlap boundaries become plain (un-merged) cuts so each pass stays mergeable — but DROP
  // any that sit right beside a junction (within clusterM): those just litter extra nodes around
  // the crossing (the user's "too many nodes"), and the junction hub already cuts there. Manual
  // nodes are always kept.
  const N = _baseRoute.lats.length
  const clusterM = opts.clusterM ?? 22
  const nearJunction = (i) => junctions.some((j) =>
    haversine(_baseRoute.lats[i], _baseRoute.lons[i], j.center.lat, j.center.lon) <= clusterM)
  const overlapCuts = []
  for (const o of overlaps) overlapCuts.push(o.aLo, o.aHi, o.bLo, o.bHi)
  const cuts = [...new Set([...overlapCuts.filter((i) => !nearJunction(i)), ..._nodeIdx])]
    .filter((i) => i > 0 && i < N - 1)

  _junctions = junctions   // kept so ◎ Complete junctions can add their OSM legs
  const built = buildOsmHubGraph(_baseRoute, junctions, { ...opts, extraCuts: cuts })
  const rawSegs = Object.keys(built.segments).length
  // Collapse duplicate passes over the same physical road (multipass / lap / out-and-back) into
  // ONE vertex-identical segment — declutters the stacked legs/arrows and renders as one road.
  _graph = opts.mergeDuplicates === false ? built : mergeDuplicateRoads(built, opts)
  _selectedSegs = []
  _selectedNodes = []
  _course = []

  const finalSegs = Object.keys(_graph.segments).length
  const dedup = rawSegs - finalSegs
  status(`Detected ${junctions.length} junction(s) + ${overlaps.length} overlap(s) → ${finalSegs} road(s)${dedup > 0 ? ` (${dedup} duplicate pass(es) merged)` : ''}. ◎ Complete junctions to add OSM turns, then ▶ Build course.`)
  notify()
  return junctions.length + overlaps.length
}

/** Centres of the last-detected junctions — main.js fetches their OSM ways with these. */
export function getJunctionCenters() { return _junctions.map((j) => ({ lat: j.center.lat, lon: j.center.lon })) }

/**
 * Complete each detected junction with its OSM legs: add the UNTRAVERSED cross-streets as stub
 * segments to leaf nodes, so a course can turn onto roads the recorded track never drove. The
 * multilevel-correct shared-node test (in junctionLegs) excludes any bridge-over / tunnel-under.
 * @param {Array} ways — from fetchJunctionWays (Overpass); empty → no-op (offline-safe)
 * @returns {number} legs added
 */
export function completeJunctions(ways) {
  if (!_active || !_graph) { status('Run ⊕ Detect structure first.'); return 0 }
  if (!_junctions.length) { status('No junctions detected — run ⊕ Detect structure first.'); return 0 }
  if (!ways || !ways.length) { status('Overpass returned no ways (servers overloaded right now) — click ◎ Complete junctions again to retry.'); return 0 }
  const legsByJunction = _junctions.map((j) => junctionLegs(j, ways).legs)
  const missing = legsByJunction.reduce((s, l) => s + l.filter((x) => !x.traversed).length, 0)
  if (!missing) { status('All junction legs were already driven — nothing to add.'); return 0 }
  snapshot()
  const { graph, added } = addJunctionLegs(_graph, _junctions, legsByJunction)
  _graph = graph
  _selectedSegs = []
  _selectedNodes = []
  _course = []
  status(`Completed junctions: ${added} OSM turn(s) added as stub legs. ▶ Build course — cross-street turns are now available.`)
  notify()
  return added
}

/** Toggle a node in the node selection (max 2; selecting a 3rd drops the oldest). */
export function toggleNodeSelection(nodeId) {
  if (!_graph || !_graph.nodes[nodeId]) return
  const at = _selectedNodes.indexOf(nodeId)
  if (at >= 0) _selectedNodes.splice(at, 1)
  else { _selectedNodes.push(nodeId); if (_selectedNodes.length > 2) _selectedNodes.shift() }
  notify()
}

/**
 * Snap a same-level crossing: merge the two selected nodes (the two visits to one
 * junction) into one shared node, so every leg through it meets at one exact XY/Z.
 * Rejects nodes too far apart to be the same crossing.
 */
export function snapCrossing() {
  if (_selectedNodes.length !== 2) { status('Select exactly two nodes (one on each pass through the crossing).'); return }
  const [keepId, dropId] = _selectedNodes
  const merged = mergeNodesInGraph(_graph, keepId, dropId)
  if (!merged) { status('Those two nodes are too far apart to be one crossing.'); return }
  snapshot()
  _graph = merged
  _selectedNodes = []
  status(`Crossing snapped: ${dropId} merged into ${keepId} — one shared, flat junction point.`)
  notify()
}

export function undoTopology() {
  if (!_history.length) return
  const prev = _history.pop()
  _nodeIdx = prev.nodeIdx
  _graph = prev.graph
  if (prev.baseRoute) _baseRoute = prev.baseRoute
  _selectedSegs = []
  _selectedNodes = []
  _course = []
  status('Undone.')
  notify()
}

// ────────────────────────────────────────────────────────────────────
// Course assembly — build a NEW route by picking segments in sequence
// ────────────────────────────────────────────────────────────────────

/** The node id at the end of the course so far (where the next arc must connect), or null. */
function courseEndNode() {
  if (!_course.length) return null
  const last = _course[_course.length - 1]
  const s = _graph.segments[last.segment]
  return last.dir === 'forward' ? s.to : s.from
}

/** Set of segment ids that may be appended next (connected to the current end). When the
 *  course is EMPTY this is empty — nothing is "lit" as next; any segment is still clickable
 *  to START the course (the map keeps every segment clickable). Lighting the whole track was
 *  the "suddenly all selected" confusion. */
export function validNextSegments() {
  if (!_graph || !_course.length) return new Set()
  const end = courseEndNode()
  const set = new Set()
  for (const [id, s] of Object.entries(_graph.segments)) if (s.from === end || s.to === end) set.add(id)
  return set
}

/** Set of "segId:dir" arc keys that may be appended next (the specific DIRECTIONS that
 *  continue from the current end). Empty course → empty (nothing lit yet). Drives the
 *  two-arrows-per-segment direction picker. */
export function validNextArcs() {
  const set = new Set()
  if (!_graph || !_course.length) return set
  const end = courseEndNode()
  for (const [id, s] of Object.entries(_graph.segments)) {
    if (s.from === end) set.add(id + ':forward')   // leave the end node heading from→to
    if (s.to === end) set.add(id + ':reverse')     // leave the end node heading to→from
  }
  return set
}

/** Enter course-assembly mode with an empty sequence. */
export function startCourse() {
  if (!_graph) return
  _building = true
  _course = []
  _selectedSegs = []
  _selectedNodes = []
  status('Building course: click a segment to start (⇄ Flip start to reverse it), then click an AMBER connected segment to continue. Click the same segment again to turn around (out-and-back).')
  notify()
}

/** Leave course-assembly mode (keeps the sequence so it can still be compiled). */
export function stopCourse() {
  _building = false
  notify()
}

/**
 * Append a segment to the course. The first pick may be any segment (added forward);
 * later picks must connect to the current end node — direction is chosen so the arc
 * continues from there. Reuse is allowed (pick the same segment again). Rejected (with a
 * message) when the segment doesn't touch the current end.
 */
export function appendToCourse(segId, dir = null) {
  if (!_graph || !_graph.segments[segId]) return
  const s = _graph.segments[segId]
  if (!_course.length) {
    _course.push({ segment: segId, dir: dir || 'forward' })
    status(`Course: 1 arc (${segId}). Click an amber arrow to continue (or the same segment again to turn around).`)
    notify()
    return
  }
  const end = courseEndNode()
  // Explicit dir from a clicked arrow is validated against connectivity; otherwise infer.
  let useDir = dir
  if (!useDir) useDir = s.from === end ? 'forward' : (s.to === end ? 'reverse' : null)
  const startNode = useDir === 'forward' ? s.from : s.to
  if (!useDir || startNode !== end) { status('That direction doesn’t continue from the current end — pick an amber arrow.'); return }
  _course.push({ segment: segId, dir: useDir })
  status(`Course: ${_course.length} arcs.`)
  notify()
}

/** Remove the last arc from the course. */
export function undoCourseStep() {
  if (!_course.length) return
  _course.pop()
  status(`Course: ${_course.length} arc(s).`)
  notify()
}

/** Flip the direction of the FIRST arc (only meaningful before a second arc is added). */
export function flipCourseStart() {
  if (_course.length === 1) {
    _course[0].dir = _course[0].dir === 'forward' ? 'reverse' : 'forward'
    notify()
  }
}

/**
 * Compile to a flat route. While building a non-empty course, compile THAT sequence;
 * otherwise compile the decomposed graph's own route (the imported order, cleaned).
 * @returns {{lats:number[],lons:number[],eles:number[]} | null}
 */
export function compileTopology() {
  if (!_graph) return null
  const useCourse = _building && _course.length > 0
  const g = useCourse ? { ..._graph, route: _course } : _graph
  const v = validateRouteGraph(g)
  if (!v.ok) { status(`Cannot compile: ${v.errors[0]}`); return null }
  const out = compileRouteGraph(g)
  status(`Compiled ${g.route.length} arc(s)${useCourse ? ' (built course)' : ''} → ${out.lats.length} points.`)
  return { lats: out.lats, lons: out.lons, eles: out.eles, arcBounds: out.arcBounds }
}

/**
 * Compile the course AND round its junction joins by turn angle (per-movement
 * tangent arcs for turns, native teardrops for U-turns; crossings left exact).
 * `compileTopology` stays pure — this is the separate rounding pass over its output.
 *
 * @param {object} [opts] — forwarded to `roundJunctions` (targetRadiusM, minR, …)
 * @returns {{ lats:number[], lons:number[], eles:number[] } | null}
 */
export function compileTopologyRounded(opts = {}) {
  const out = compileTopology()
  if (!out) return null
  const r = roundJunctions(out.lats, out.lons, out.eles, out.arcBounds || [], opts)
  if (r.rounded || r.teardrops) {
    status(`Rounded ${r.rounded} turn(s), ${r.teardrops} turnaround(s) → ${r.lats.length} points.`)
  }
  return { lats: r.lats, lons: r.lons, eles: r.eles }
}
