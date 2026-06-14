/**
 * Course Builder — front-entry "Build" mode (area-primary).
 *
 * The user draws a bounding box on the map; we fetch the OSM street network inside it and
 * `buildNetworkGraph` splits it into a clickable node/leg graph. The user then picks a course by
 * clicking the next node to travel to (the connecting segment is appended). On Done the course
 * compiles to a GPX and hands off to the normal cleanup pipeline — exactly like Route Builder.
 *
 * Module-level state (not in ST — a temporary create mode). Pure graph math lives in
 * utils/network-graph.js + utils/route-graph.js; rendering is delegated to the map layer.
 */

import { fetchNetwork, regionAreaKm2 } from '../api/overpass-network.js'
import { buildNetworkGraph } from '../utils/network-graph.js'
import { decomposeTrackByLabels } from '../utils/track-decompose.js'
import {
  compileRouteGraph, validateRouteGraph, buildGraphFromRoute,
  mergeNodesInGraph, mergeSegmentsInGraph, segmentMergeRelation,
  splitSegmentInGraph, splitArcsInList, unifyGraphs,
} from '../utils/route-graph.js'
import { offsetPolyline } from '../utils/lane-split.js'
import { buildAdjacency, shortestPath } from '../utils/graph-routing.js'
import { cumulativeDistances, haversine } from '../utils/math.js'
import { resampleRoute, smoothPositions } from '../utils/geometry.js'

// Largest DRAWN region we'll fetch in one go (km²). Beyond this Overpass gets heavy and the network
// gets unwieldy to pick on — warn and refuse. ~4 km² ≈ a 2×2 km area (a town centre / crit circuit).
const MAX_AREA_KM2 = 4

// Track IMPORT fetches the OSM network as a chain of small overlapping BBOX TILES along the ride —
// NOT a thin corridor. A corridor (buffer around the ride) is lossy at crossings: it omits the bit of
// an intersecting/looping road the ride didn't physically touch, so a junction node fails to form and
// the decompose can't connect two pieces of the SAME self-overlapping way (the "missed T-crossing node"
// disconnect). A bbox tile fetches EVERYTHING in its rectangle, so every crossing in the tile is fully
// noded — exactly like drawing a bbox by hand. Each tile is capped at TILE_MAX_KM2 so it stays a small,
// fast Overpass query regardless of ride length; tiles overlap so the network is continuous at seams.
const TILE_MAX_KM2 = 12
const TILE_PAD_M = 60          // pad each tile so a crossing right at the edge is still fully captured
const MAX_IMPORT_TILES = 150   // ride too large to fetch (≈ a very long ride) → ask to split it
const TILE_FETCH_CONCURRENCY = 1
const TILE_RETRIES = 2
const TILE_BACKOFF_MS = 2000

// The imported ride is densified to ~IMPORT_DENSIFY_M BEFORE decompose. A sparse ride (e.g. raw Valhalla
// output at ~20 m spacing) is ON the road, but the per-segment σ=5 smoothing at finish rounds the wide
// gaps between points and pulls corners OFF the road (measured up to ~6 m on a 22 m-spaced ride → wrong
// LIDAR). Densifying to ≤ the smoother's σ removes that (≤1 m residual). A pre-dense ride (already ~1 m,
// e.g. a re-imported processed file) is unaffected. 1 m matches the pipeline's "dense" standard.
const IMPORT_DENSIFY_M = 1

/** Resample a track to ~spacingM, carrying interpolated elevations. No-op for a too-short track. */
function densifyTrack(lats, lons, eles, spacingM) {
  const n = lats.length
  const E = (eles && eles.length === n) ? eles : lats.map(() => 0)
  if (n < 2) return { lats: lats.slice(), lons: lons.slice(), eles: E.slice() }
  const d = cumulativeDistances(lats, lons)
  if (d[n - 1] < spacingM * 1.5) return { lats: lats.slice(), lons: lons.slice(), eles: E.slice() }
  const rs = resampleRoute(lats, lons, d, spacingM)
  const outE = new Array(rs.lats.length)
  let seg = 0
  for (let i = 0; i < rs.lats.length; i++) {
    const dist = rs.dists[i]
    while (seg < n - 2 && d[seg + 1] < dist) seg++
    const segLen = d[seg + 1] - d[seg]
    const t = segLen > 0 ? (dist - d[seg]) / segLen : 0
    outE[i] = E[seg] + t * (E[seg + 1] - E[seg])
  }
  return { lats: rs.lats, lons: rs.lons, eles: outE }
}

/** Approx area (km²) of a lat/lon bbox. */
function bboxAreaKm2Raw(s, w, n, e) {
  const midLat = (s + n) / 2
  const h = (n - s) * 111.32
  const wd = (e - w) * 111.32 * Math.cos(midLat * Math.PI / 180)
  return Math.abs(h * wd)
}

/**
 * Tile a ride into a chain of bbox descriptors, each ≤ TILE_MAX_KM2. Walk the points growing the
 * current tile's bbox; when the next point would push it over the cap, close the tile (padded) and
 * start a new one overlapping from the previous point — so the fetched networks join across seams.
 */
function tileRideBboxes(lats, lons) {
  const n = lats.length
  const tiles = []
  const padLat = TILE_PAD_M / 111320
  const pushTile = (s, w, no, e) => {
    const padLon = TILE_PAD_M / (111320 * Math.cos((s + no) / 2 * Math.PI / 180) || 111320)
    tiles.push({ type: 'bbox', minLat: s - padLat, minLon: w - padLon, maxLat: no + padLat, maxLon: e + padLon })
  }
  let s = lats[0], w = lons[0], no = lats[0], e = lons[0], startIdx = 0
  for (let i = 1; i < n; i++) {
    const ns = Math.min(s, lats[i]), nw = Math.min(w, lons[i]), nn = Math.max(no, lats[i]), ne = Math.max(e, lons[i])
    if (i > startIdx + 1 && bboxAreaKm2Raw(ns, nw, nn, ne) > TILE_MAX_KM2) {
      pushTile(s, w, no, e)
      startIdx = i - 1                                   // new tile starts on the shared point (overlap)
      s = Math.min(lats[i - 1], lats[i]); w = Math.min(lons[i - 1], lons[i])
      no = Math.max(lats[i - 1], lats[i]); e = Math.max(lons[i - 1], lons[i])
    } else { s = ns; w = nw; no = nn; e = ne }
  }
  pushTile(s, w, no, e)
  return tiles
}

/** Fetch one bbox tile with a few gentle retries (Overpass often clears a 504/429 on a later attempt). */
async function fetchTileWithRetry(tile, single) {
  for (let attempt = 0; attempt <= (single ? 0 : TILE_RETRIES); attempt++) {
    const ways = (await fetchNetwork(tile, 'mixed')) || []
    if (ways.length) return ways
    if (attempt < TILE_RETRIES && !single) await new Promise((r) => setTimeout(r, TILE_BACKOFF_MS * (attempt + 1)))
  }
  return []
}

/**
 * Fetch every bbox tile (bounded concurrency, gentle per-tile retries) and merge ways by OSM id.
 * Returns `{ ways, tiles, failed }` so the caller can warn when some tiles failed (a partial network).
 */
async function fetchTiledWays(tiles) {
  if (tiles.length <= 1) {
    // Single tile (short ride): fail fast — the user clicks ↻ Retry fetch if Overpass was busy.
    const ways = (await fetchNetwork(tiles[0], 'mixed')) || []
    return { ways, tiles: 1, failed: ways.length ? 0 : 1 }
  }
  const results = new Array(tiles.length)
  let next = 0, failed = 0, done = 0
  const worker = async () => {
    while (next < tiles.length) {
      const my = next++
      const ways = await fetchTileWithRetry(tiles[my], false)
      if (!ways.length) failed++
      results[my] = ways
      done++
      _status(`Importing — fetched ${done}/${tiles.length} sections of the OSM road network…`)
      _notify()
    }
  }
  const pool = []
  for (let wkr = 0; wkr < Math.min(TILE_FETCH_CONCURRENCY, tiles.length); wkr++) pool.push(worker())
  await Promise.all(pool)
  const byId = new Map()
  for (const ways of results) for (const wy of (ways || [])) if (!byId.has(wy.id)) byId.set(wy.id, wy)
  return { ways: [...byId.values()], tiles: tiles.length, failed }
}

// ────────────────────────────────────────────────────────────────────
// Module state
// ────────────────────────────────────────────────────────────────────

let _active = false
let _pending = false            // fetch in-flight (blocks interactions)
let _profile = 'car'            // current region fetch filter: 'car' | 'bike' | 'pedestrian'
let _drawShape = 'bbox'         // region shape to draw next: 'bbox' | 'poly' | 'corridor'
let _regions = []               // [{ shape, profile, ways:[...] }] — every fetched region (additive)
let _graph = null               // network graph built from ALL regions' ways
let _course = []                // ordered [{ segment, dir }]
let _startNode = null           // first node clicked when the course is empty (the start anchor)
let _drawArmed = false          // draw gesture armed (map drag/clicks draw a region to fetch)
let _imported = false           // graph came from an imported track (edit mode), not OSM area
let _importBase = null          // { lats, lons, eles } — the imported track, for re-slicing on edits
let _importRoute = []           // the full decomposed ride as arcs — for ▸ Trace ride
let _importGaps = []            // decompose disconnects bridged with a straight GAP connector (UI list)
let _fetchGaps = false          // last import had failed OSM tiles (▻ show the Retry-fetch button)
let _junctions = []             // OSM junctions detected on the imported track (for completion)

// Edit mode — graph-native editing of the decomposed network (split/merge/snap/offset/crop/append).
// While on, leg/node clicks SELECT (for an edit) instead of picking the course. All edits are
// immutable (replace _graph with a new object), so an _editHistory snapshot can hold prior refs.
let _editMode = false
let _splitArmed = false         // next leg click selects it, then a point click splits it there
let _selectedSegs = []          // ≤2 selected segment ids (green)
let _selectedNodes = []         // ≤2 selected node ids (green)
let _editHistory = []           // snapshots: { graph, course, importRoute, startNode }

let _onUpdate = null            // () => void
let _onStatus = null            // (msg) => void

// ────────────────────────────────────────────────────────────────────
// Getters (for rendering)
// ────────────────────────────────────────────────────────────────────

export function isCourseActive() { return _active }
export function isCoursePending() { return _pending }
export function getCourseGraph() { return _graph }
export function getCourseProfile() { return _profile }
export function getCourseArcs() { return _course.slice() }
export function getCourseStartNode() { return _startNode }
/** Region list for the panel: each region's shape, profile, and way count. */
export function getCourseRegions() {
  return _regions.map((r) => ({ shape: r.shape, profile: r.profile, ways: r.ways.length }))
}
export function courseHasNetwork() { return !!_graph && Object.keys(_graph.segments || {}).length > 0 }
export function isDrawArmed() { return _drawArmed }
export function getDrawShape() { return _drawShape }

/** Choose the region shape the next draw produces ('bbox' | 'poly' | 'corridor'). */
export function setDrawShape(shape) {
  if (shape === 'bbox' || shape === 'poly' || shape === 'corridor') _drawShape = shape
  _notify()
}

/** Arm/disarm the draw gesture (a map drag/clicks draw a region to fetch). */
export function setDrawArmed(on) {
  _drawArmed = !!on
  _status(_drawArmed ? `Draw a ${_drawShape} on the map to fetch its streets.` : 'Draw cancelled.')
  _notify()
}

/** Total course distance in metres (sum of arc segment chord-ish lengths). */
export function getCourseDistance() {
  if (!_graph) return 0
  let m = 0
  for (const arc of _course) {
    const s = _graph.segments[arc.segment]
    if (!s) continue
    const d = cumulativeDistances(s.points.map((p) => p.lat), s.points.map((p) => p.lon))
    m += d[d.length - 1]
  }
  return m
}

// ────────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────────

/** @param {{ onUpdate?:Function, onStatus?:Function }} callbacks */
export function enterCourseBuilder(callbacks = {}) {
  _active = true
  _pending = false
  _profile = 'car'
  _drawShape = 'bbox'
  _graph = null
  _course = []
  _startNode = null
  _regions = []
  _drawArmed = true   // first action is to draw an area
  _imported = false
  _importBase = null
  _importRoute = []
  _importGaps = []
  _junctions = []
  _editMode = false
  _splitArmed = false
  _selectedSegs = []
  _selectedNodes = []
  _editHistory = []
  _onUpdate = callbacks.onUpdate || null
  _onStatus = callbacks.onStatus || null
  _status('Course Builder: draw a box on the map to fetch the street network, then click nodes to pick a course.')
  _notify()
}

export function exitCourseBuilder() {
  _active = false
  _pending = false
  _drawShape = 'bbox'
  _graph = null
  _course = []
  _startNode = null
  _regions = []
  _drawArmed = false
  _imported = false
  _importBase = null
  _importRoute = []
  _importGaps = []
  _junctions = []
  _editMode = false
  _splitArmed = false
  _selectedSegs = []
  _selectedNodes = []
  _editHistory = []
  _onUpdate = null
  _onStatus = null
}

export function setCourseProfile(profile) {
  if (profile === 'car' || profile === 'bike' || profile === 'pedestrian') _profile = profile
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Region fetch (additive)
// ────────────────────────────────────────────────────────────────────

/** Approximate area of a region (bbox/poly/corridor) in km². */
export function bboxAreaKm2(region) { return regionAreaKm2(region) }

/** Rebuild the network graph from every region's ways; resets the in-progress course. */
function rebuildGraph() {
  const all = []
  for (const r of _regions) for (const w of r.ways) all.push(w)
  _graph = all.length ? buildNetworkGraph(all) : null
  _course = []
  _startNode = null
}

/**
 * Fetch the street network for a drawn region and merge it into the graph (additive: shared OSM
 * vertices auto-connect across regions). Rebuilds the graph from ALL regions' ways, so a course
 * in progress is cleared (segment ids change). Best-effort: an Overpass outage leaves the graph
 * unchanged with a "servers busy" status.
 *
 * @param {object} region — bbox object, or `{ type:'bbox'|'poly'|'corridor', … }`.
 * @param {string} [profile] — defaults to the current profile.
 */
export async function addRegion(region, profile = _profile) {
  if (!_active || _pending) return
  const shape = region.type || 'bbox'
  const area = regionAreaKm2(region)
  if (area > MAX_AREA_KM2) {
    _status(`That area is ${area.toFixed(1)} km² — too big (max ${MAX_AREA_KM2} km²). Draw a smaller region.`)
    _notify()
    return
  }
  _pending = true
  _status(`Fetching ${profile} network for ${area.toFixed(2)} km²…`)
  _notify()
  let ways = []
  try {
    ways = await fetchNetwork(region, profile)
  } catch (err) {
    console.warn('[CourseBuilder] network fetch failed:', err?.message || err)
  }
  _pending = false
  if (!ways.length) {
    _status('No roads returned (Overpass may be overloaded) — try again or draw a different region.')
    _notify()
    return
  }
  _regions.push({ shape, region, profile, ways })
  rebuildGraph()
  _drawArmed = false   // got a network → switch to picking (re-arm to add another region)
  const nNodes = Object.keys(_graph.nodes).length
  const nSegs = Object.keys(_graph.segments).length
  _status(`Network: ${nNodes} nodes, ${nSegs} legs (${_regions.length} region${_regions.length === 1 ? '' : 's'}). Click a node to start your course.`)
  _notify()
}

/** Remove a fetched region by index and rebuild the graph from the rest. */
export function removeRegion(index) {
  if (index < 0 || index >= _regions.length) return
  _regions.splice(index, 1)
  rebuildGraph()
  _status(_regions.length
    ? `Region removed — ${_regions.length} region(s) left.`
    : 'All regions removed — draw a new area.')
  if (!_regions.length) _drawArmed = true
  _notify()
}

/** Re-fetch a region (e.g. after an Overpass outage cleared) with its original shape + profile. */
export async function refetchRegion(index) {
  if (_pending || index < 0 || index >= _regions.length) return
  const r = _regions[index]
  _pending = true
  _status('Re-fetching region…')
  _notify()
  let ways = []
  try { ways = await fetchNetwork(r.region, r.profile) } catch { /* keep old */ }
  _pending = false
  if (ways.length) { r.ways = ways; rebuildGraph() }
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Import a recorded/authored track — decompose the EXACT geometry (no OSM)
// ────────────────────────────────────────────────────────────────────

/**
 * Import a GPX track into the course as its OWN decomposed graph — faithful to the recorded
 * geometry and sequence (NOT map-matched to OSM). The track *is* the course: every segment follows
 * the exact track, in order, with nodes placed at structurally meaningful points (self-crossings +
 * overlap boundaries) so the user can split/reverse/move-start and reuse a road for multiple passes.
 *
 * This is the right model when you upload a file to EDIT it (vs. authoring from scratch on the OSM
 * network in Area mode).
 *
 * **The OSM network is the source of truth.** We fetch the OSM road network around the ride
 * (Overpass bbox), build the standard node/leg graph (`buildNetworkGraph` — identical to Area mode),
 * and **map-match the ride onto it by nearest segment** (`matchTrackToNetwork`). The course is then a
 * PATH through that graph: nodes + geometry come from OSM (clean, and bit-identical for the same
 * crossing every recording), and reuse is free — a road ridden N times is the same segment N times.
 *
 * This is deterministic by construction: nearest-segment assignment is stable under GPS jitter, unlike
 * the proximity/overlap thresholds the old exact-track decompose used (which gave different nodes for
 * different recordings of the same crossing). The grey network is fully pickable, so you can deviate
 * onto any nearby road; ▸ Trace ride loads the matched ride as the course.
 *
 * @param {{ lats:number[], lons:number[], eles?:number[] }} track
 * @returns {Promise<{ ok:boolean, segments:number, junctions:number }>}
 */
export async function importTrack(track) {
  if (!_active || _pending || !track || !track.lats || track.lats.length < 2) return { ok: false, segments: 0, junctions: 0 }
  // Densify to ~1 m FIRST (see IMPORT_DENSIFY_M): the decompose keeps the recorded geometry, and the
  // finish-step σ=5 smoothing pulls a SPARSE ride's corners off the road → wrong LIDAR. A dense ride is
  // unchanged. This is the only geometry transform on import; everything downstream keeps these points.
  const dense = densifyTrack(track.lats, track.lons, track.eles, IMPORT_DENSIFY_M)
  const lats = dense.lats
  const lons = dense.lons
  const eles = dense.eles
  const route = { lats, lons, eles }
  _importBase = route
  _imported = true

  // Fetch the OSM road network as a chain of small overlapping BBOX TILES along the ride (see the
  // tileRideBboxes comment). A bbox tile is COMPLETE locally — every crossing it contains is fully
  // noded — so the decompose can always connect the ride's pieces (no "missed T-crossing node"
  // disconnects), unlike a thin corridor which omits the un-ridden bit of an intersecting/looping road.
  // Each tile is capped at TILE_MAX_KM2, so cost stays bounded per tile for any ride length.
  const tiles = tileRideBboxes(lats, lons)
  let ways = []
  let fetchNote = ''
  if (tiles.length <= MAX_IMPORT_TILES) {
    _pending = true
    _status('Importing — fetching the OSM road network along your ride…')
    _notify()
    // 'mixed' = car ∪ bike ∪ foot (so cycleways/footways the ride used are in the graph), tiled so a
    // long ride doesn't time out as one giant Overpass request.
    try {
      const res = await fetchTiledWays(tiles)
      ways = res.ways
      _fetchGaps = res.failed > 0
      if (res.failed && res.tiles > 1) fetchNote = ` (${res.failed}/${res.tiles} sections couldn't be fetched — ↻ Retry fetch to fill the gaps)`
    } catch (err) { console.warn('[CourseBuilder] Overpass network fetch failed:', err?.message) }
    _pending = false
  } else {
    _imported = false
    _importBase = null
    _importRoute = []
    _graph = null
    _course = []
    _status(`This ride needs ${tiles.length} network tiles — too large to fetch in one go (max ${MAX_IMPORT_TILES}). Split the ride or import a shorter section.`)
    _notify()
    return { ok: false, segments: 0, junctions: 0 }
  }

  if (ways.length) {
    // Decompose the ride by LABELLING each recorded point with its OSM road — the course KEEPS the
    // recorded geometry (it can never diverge), OSM supplies only the topology (segments + reuse +
    // deterministic junction nodes). A road ridden N× is one segment reused N×. The grey graph is the
    // ridden roads; the course starts EMPTY (pickable), ▸ Trace ride loads the whole decomposed ride.
    const osmNet = buildNetworkGraph(ways)
    const dec = decomposeTrackByLabels(osmNet, route)
    _graph = { nodes: dec.nodes, segments: dec.segments, route: dec.route }
    _importRoute = _graph.route.slice()
    _importGaps = dec.gaps || []
    _course = []
    _startNode = null
    _drawArmed = false
    _regions = []
    _junctions = []
    const nSegs = Object.keys(_graph.segments).length
    const nNodes = Object.keys(_graph.nodes).length
    const traced = _importRoute.length
      ? `Your ride is traced onto them — ▸ Trace ride to load it, or click nodes to pick a course.`
      : `Couldn't match the ride to the roads (it may be off-network) — pick a course by clicking nodes.`
    // A gap = a transition the OSM network couldn't connect (e.g. a self-overlapping road whose pieces
    // meet without a shared node). We bridge it with a straight connector so the course always compiles,
    // and flag it so the user can jump to it and fix it by hand.
    const gapNote = _importGaps.length
      ? ` ⚠ ${_importGaps.length} disconnect(s) bridged with a straight line — see the list to inspect/fix.`
      : ''
    _status(`Imported: ${nNodes} junction(s) / ${nSegs} road(s) from the OSM map${fetchNote}. ${traced}${gapNote}`)
    _notify()
    return { ok: true, segments: nSegs, junctions: nNodes, gaps: _importGaps.length }
  }

  // No network (Overpass busy/down). We need the OSM graph to build a deterministic course, so ask the
  // user to retry rather than hand back a geometry-only decompose.
  _imported = false
  _importBase = null
  _importRoute = []
  _importGaps = []
  _graph = null
  _course = []
  _status('Could not fetch the OSM road network (the Overpass servers are busy or down). Please try the import again in a minute.')
  _notify()
  return { ok: false, segments: 0, junctions: 0 }
}

/** Load the full imported ride as the course (the "▸ Trace ride" button). */
export function traceImportedRide() {
  if (!_imported || !_importRoute.length) return
  _course = _importRoute.slice()
  _startNode = null
  _status(`Loaded the whole ride (${_course.length} legs). Reverse, edit, or ✓ Done — or Clear to pick a different course.`)
  _notify()
}

/** Whether a "▸ Trace ride" is available (imported, with a saved ride route). */
export function canTraceRide() { return _imported && _importRoute.length > 0 }

/** Whether the last import left OSM-fetch gaps (some tiles 504/429'd) → offer ↻ Retry fetch. */
export function hasFetchGaps() { return _fetchGaps }

/** Decompose disconnects bridged with a straight GAP connector — `[{fromNode,toNode,lat,lon,distM}]`
 *  (a hand-fixable blemish; the UI lists them and zooms to each on click). */
export function getImportGaps() { return _importGaps.slice() }

/**
 * Re-run the import fetch for the same ride. Tiles that succeeded are served from the session cache
 * (instant); only the failed ones go back to Overpass — so this fills the gaps without re-uploading.
 */
export async function retryImportFetch() {
  if (!_active || _pending || !_importBase) return { ok: false, segments: 0, junctions: 0 }
  return importTrack({
    lats: _importBase.lats.slice(), lons: _importBase.lons.slice(),
    eles: (_importBase.eles || []).slice(),
  })
}

/** Reverse the whole course (swap start↔finish; flip each arc's direction and order). */
export function reverseCourse() {
  if (!_course.length) return
  _course = _course.slice().reverse().map((a) => ({
    segment: a.segment, dir: a.dir === 'forward' ? 'reverse' : 'forward',
  }))
  _startNode = null
  _status('Course reversed.')
  _notify()
}

export function isImported() { return _imported }

// ────────────────────────────────────────────────────────────────────
// Edit mode — graph-native editing of the decomposed network
//
// These act on the {nodes,segments,route} GRAPH *before* compile (split/merge/snap/offset/crop/
// append). Elevation edits (Z-offset/Z-nudge) and the continuous-track lane tools (lane-split,
// separate/unify overlap) intentionally stay in the Split step: course elevation is zeroed at
// finish and re-filled by LIDAR, and those tools need a single continuous post-compile track.
// ────────────────────────────────────────────────────────────────────

export function isEditMode() { return _editMode }
export function isSplitArmed() { return _splitArmed }
export function getSelectedSegs() { return _selectedSegs.slice() }
export function getSelectedNodes() { return _selectedNodes.slice() }
export function canUndoEdit() { return _editHistory.length > 0 }

/** Toggle edit mode. While ON, leg/node clicks SELECT (green) instead of building the course. */
export function setEditMode(on) {
  _editMode = !!on
  if (!_editMode) { _splitArmed = false; _selectedSegs = []; _selectedNodes = [] }
  _status(_editMode
    ? 'Edit mode: click a leg or node to select it, then use the edit tools.'
    : 'Pick mode: click nodes / amber legs to build the course.')
  _notify()
}

/** Snapshot prior state for Undo edit (all edits are immutable, so references are safe). */
function _snapshotEdit() {
  _editHistory.push({ graph: _graph, course: _course.slice(), importRoute: _importRoute.slice(), startNode: _startNode })
  if (_editHistory.length > 30) _editHistory.shift()
}

export function undoEdit() {
  if (!_editHistory.length) return
  const s = _editHistory.pop()
  _graph = s.graph
  _course = s.course.slice()
  _importRoute = s.importRoute.slice()
  _startNode = s.startNode
  _selectedSegs = []
  _selectedNodes = []
  _splitArmed = false
  _status('Edit undone.')
  _notify()
}

/** Click a leg in edit mode: arm-pending → select it for split; else toggle selection (≤2). */
export function clickSegmentForEdit(segId) {
  if (!_graph || !_graph.segments[segId]) return
  if (_splitArmed) {
    _selectedSegs = [segId]
    _status('Now click the point on the highlighted leg where it should split.')
    _notify()
    return
  }
  const i = _selectedSegs.indexOf(segId)
  if (i >= 0) _selectedSegs.splice(i, 1)
  else { _selectedSegs.push(segId); if (_selectedSegs.length > 2) _selectedSegs.shift() }
  _status(`${_selectedSegs.length} leg(s) selected.`)
  _notify()
}

/** Click a node in edit mode: toggle selection (≤2, for snap / move-start). */
export function clickNodeForEdit(nodeId) {
  if (!_graph || !_graph.nodes[nodeId]) return
  const i = _selectedNodes.indexOf(nodeId)
  if (i >= 0) _selectedNodes.splice(i, 1)
  else { _selectedNodes.push(nodeId); if (_selectedNodes.length > 2) _selectedNodes.shift() }
  _status(`${_selectedNodes.length} node(s) selected.`)
  _notify()
}

/** Arm split: the next leg click selects it, then a point click on it splits there. */
export function armSplit() {
  if (!_editMode) setEditMode(true)
  _splitArmed = true
  _selectedSegs = []
  _selectedNodes = []
  _status('Split: click the leg to split, then click the point on it.')
  _notify()
}

/**
 * Split the leg `segId` at the point on it nearest to (lat,lon) — into two legs joined by a new
 * node. The picked course and the imported ride are re-mapped so each traversal of the old leg now
 * runs its two halves in order (split is targeted surgery, not a rebuild).
 */
export function splitAt(segId, lat, lon) {
  const seg = _graph && _graph.segments[segId]
  if (!seg) return
  let bi = -1, bd = Infinity
  for (let i = 1; i < seg.points.length - 1; i++) {
    const d = haversine(lat, lon, seg.points[i].lat, seg.points[i].lon)
    if (d < bd) { bd = d; bi = i }
  }
  if (bi < 1) { _status('Pick a point in the middle of the leg to split it.'); return }
  const res = splitSegmentInGraph(_graph, segId, bi)
  if (!res) { _status('Could not split there — try nearer the middle.'); return }
  _snapshotEdit()
  _graph = res.graph
  _course = splitArcsInList(_course, segId, res.segIds[0], res.segIds[1])
  _importRoute = splitArcsInList(_importRoute, segId, res.segIds[0], res.segIds[1])
  _splitArmed = false
  _selectedSegs = []
  _status('Leg split into two.')
  _notify()
}

/**
 * Declare the two selected legs the SAME road (reuse one for multiple passes): drop one, repoint
 * every course / ride arc to the kept leg (flipping direction when they run opposite). The two must
 * share endpoints (be the same physical road) — else rejected.
 */
export function mergeSelected() {
  if (_selectedSegs.length !== 2) { _status('Select exactly two legs to merge (reuse one road for both passes).'); return }
  const [keepId, dropId] = _selectedSegs
  const rel = segmentMergeRelation(_graph, keepId, dropId)
  const res = rel && mergeSegmentsInGraph(_graph, keepId, dropId)
  if (!res) { _status('Those two legs are not the same road (their endpoints differ).'); return }
  _snapshotEdit()
  _graph = res
  const flip = (d) => (d === 'forward' ? 'reverse' : 'forward')
  const remap = (arcs) => arcs.map((a) => a.segment === dropId
    ? { segment: keepId, dir: rel === 'forward' ? a.dir : flip(a.dir) }
    : { ...a })
  _course = remap(_course)
  _importRoute = remap(_importRoute)
  _selectedSegs = []
  _status('Legs merged into one reused road.')
  _notify()
}

/**
 * Snap the two selected nodes into ONE junction (fixes a real crossing the decompose split into two
 * near-coincident nodes — every direction then meets at one point). A degenerate connector that
 * collapses (from===to) is dropped from the graph and from the course/ride.
 */
export function snapSelectedNodes() {
  if (_selectedNodes.length !== 2) { _status('Select two nodes to snap into one junction.'); return }
  const res = mergeNodesInGraph(_graph, _selectedNodes[0], _selectedNodes[1], { matchM: 40 })
  if (!res) { _status('Those nodes are too far apart to be the same junction.'); return }
  _snapshotEdit()
  const kept = new Set(Object.keys(res.segments))
  _graph = res
  _course = _course.filter((a) => kept.has(a.segment))
  _importRoute = _importRoute.filter((a) => kept.has(a.segment))
  _selectedNodes = []
  _status('Nodes snapped into one junction.')
  _notify()
}

/** Start node of an arc (the node it begins at), honouring direction. */
function _arcStart(arc) { const s = _graph.segments[arc.segment]; return arc.dir === 'forward' ? s.from : s.to }
/** End node of an arc. */
function _arcEnd(arc) { const s = _graph.segments[arc.segment]; return arc.dir === 'forward' ? s.to : s.from }

/**
 * Rotate a CLOSED-LOOP course so it begins (and ends) at `nodeId`. Only valid when the course
 * returns to its start; otherwise rejected (a point-to-point course has a fixed start/finish —
 * use ⇄ Reverse to swap them).
 */
export function moveCourseStart(nodeId) {
  if (_course.length < 2) { _status('Pick a course first.'); return }
  if (_arcStart(_course[0]) !== _arcEnd(_course[_course.length - 1])) {
    _status('Move start needs a closed-loop course (it must return to its start).'); return
  }
  const i = _course.findIndex((a) => _arcStart(a) === nodeId)
  if (i < 0) { _status('Pick a node the course passes through.'); return }
  if (i === 0) { _status('Course already starts there.'); return }
  _snapshotEdit()
  _course = [..._course.slice(i), ..._course.slice(0, i)]
  _startNode = nodeId
  _selectedNodes = []
  _status('Start moved.')
  _notify()
}

/** Move start to the (single) selected node. */
export function moveStartToSelected() {
  if (_selectedNodes.length !== 1) { _status('Select one node to make the new start.'); return }
  moveCourseStart(_selectedNodes[0])
}

/**
 * Crop the course to the arc range between the two selected legs (inclusive): keep only the arcs
 * from the first selected occurrence to the last, dropping the rest. With one leg selected, crops
 * everything before/after that single arc away (keeps just it). Graph-native — no track slicing.
 */
export function cropToSelected() {
  if (!_course.length) { _status('Pick a course to crop.'); return }
  if (_selectedSegs.length < 1) { _status('Select one or two course legs to crop between.'); return }
  const sel = new Set(_selectedSegs)
  let lo = -1, hi = -1
  for (let i = 0; i < _course.length; i++) {
    if (sel.has(_course[i].segment)) { if (lo < 0) lo = i; hi = i }
  }
  if (lo < 0) { _status('Those legs are not in the picked course.'); return }
  if (lo === 0 && hi === _course.length - 1) { _status('Nothing to crop — selection spans the whole course.'); return }
  _snapshotEdit()
  _course = _course.slice(lo, hi + 1)
  _startNode = null
  _selectedSegs = []
  _status(`Cropped to ${_course.length} leg(s).`)
  _notify()
}

/** Replace one segment's geometry (immutable graph update). */
function _replaceSegmentPoints(segId, points) {
  const seg = _graph.segments[segId]
  _graph = { ..._graph, segments: { ..._graph.segments, [segId]: { ...seg, points } } }
}

/**
 * Offset the selected leg sideways by `gapM` metres (side = 'left'|'right' of travel). Endpoints
 * stay pinned to their nodes (a cos² ramp tapers the offset to zero at both ends), so the junction
 * stays intact and only the road's middle bows out — the LIDAR then samples the new line.
 */
export function offsetSelectedSegment(gapM, side = 'right') {
  if (_selectedSegs.length !== 1) { _status('Select one leg to offset.'); return }
  const segId = _selectedSegs[0]
  const seg = _graph.segments[segId]
  if (!seg || seg.points.length < 3) { _status('That leg is too short to offset.'); return }
  const signed = (side === 'left' ? 1 : -1) * Math.abs(gapM)
  const lats = seg.points.map((p) => p.lat)
  const lons = seg.points.map((p) => p.lon)
  const off = offsetPolyline(lats, lons, signed)
  const n = seg.points.length
  const rampN = Math.max(1, Math.floor(n * 0.25))
  const points = seg.points.map((p, i) => {
    let f = 1
    if (i < rampN) f = 0.5 - 0.5 * Math.cos((Math.PI * i) / rampN)
    else if (i > n - 1 - rampN) f = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / rampN)
    return { lat: p.lat + (off.lats[i] - p.lat) * f, lon: p.lon + (off.lons[i] - p.lon) * f, ele: p.ele }
  })
  _snapshotEdit()
  _replaceSegmentPoints(segId, points)
  _status(`Leg offset ${Math.abs(gapM)} m ${side}.`)
  _notify()
}

/**
 * Merge a second graph into the network, unifying by shared OSM-vertex coordinate — the drawn /
 * imported roads connect to the existing network exactly where they touch a shared junction. Used
 * by "add roads" (a drawn OSM area) and "append GPX" (decompose a 2nd track). The picked course is
 * preserved; the new roads render grey & pickable.
 */
function _spliceGraph(graphB) {
  if (!graphB || !Object.keys(graphB.segments || {}).length) return false
  _snapshotEdit()
  _graph = _graph ? unifyGraphs(_graph, graphB) : graphB
  _selectedSegs = []
  _selectedNodes = []
  return true
}

/** Add the streets of a drawn region to the existing network (unify by shared OSM vertex). */
export async function addRoadsFromRegion(region, profile = _profile) {
  if (!_active || _pending) return
  const area = regionAreaKm2(region)
  if (area > MAX_AREA_KM2) { _status(`That area is ${area.toFixed(1)} km² — too big (max ${MAX_AREA_KM2}).`); _notify(); return }
  _pending = true
  _status(`Fetching ${profile} roads to add (${area.toFixed(2)} km²)…`)
  _notify()
  let ways = []
  try { ways = await fetchNetwork(region, profile) } catch (err) { console.warn('[CourseBuilder] add-roads fetch failed:', err?.message) }
  _pending = false
  if (!ways.length) { _status('No roads returned (Overpass may be busy) — try again.'); _notify(); return }
  const added = _spliceGraph(buildNetworkGraph(ways))
  _drawArmed = false
  const nSegs = Object.keys(_graph.segments).length
  _status(added ? `Roads added — network now ${nSegs} legs. Click grey legs to extend your course.` : 'Nothing to add.')
  _notify()
}

/**
 * Append another GPX track to the network: decompose it (exact geometry) and unify into the graph
 * by shared OSM-vertex coordinate so it connects where it touches the existing roads.
 */
export function appendImportedGpx(track) {
  if (!_active || !track || !track.lats || track.lats.length < 2) { _status('That GPX has no track points.'); return }
  const lats = track.lats.slice(), lons = track.lons.slice()
  const eles = (track.eles && track.eles.length === lats.length ? track.eles : lats.map(() => 0)).slice()
  const gB = buildGraphFromRoute({ lats, lons, eles })
  const added = _spliceGraph(gB)
  const nSegs = Object.keys(_graph.segments).length
  _status(added ? `Track added — network now ${nSegs} legs. Click grey legs to include them.` : 'Nothing to add.')
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Course assembly — click next node
// ────────────────────────────────────────────────────────────────────

/** Node id at the end of the course so far (or the start anchor / null if empty). */
export function courseEndNode() {
  if (_course.length) {
    const last = _course[_course.length - 1]
    const s = _graph.segments[last.segment]
    return last.dir === 'forward' ? s.to : s.from
  }
  return _startNode
}

/** Length (m) of a segment's polyline. */
function segLengthM(s) {
  const d = cumulativeDistances(s.points.map((p) => p.lat), s.points.map((p) => p.lon))
  return d[d.length - 1] || 0
}

/**
 * Find a segment directly connecting `a`→`b` (either orientation); returns { id, dir } or null.
 * When TWO parallel segments connect them (e.g. a direct leg + a no-node loop), the SHORTEST is
 * returned — so a node click takes the direct route; the user clicks the specific (amber) segment
 * to take the longer loop instead.
 */
// Adjacency cache for graph routing (picking + future matcher). Rebuilt whenever _graph is replaced
// (edits/imports are immutable — they swap _graph for a new object — so a ref check is sufficient).
let _adj = null
let _adjGraph = null
function courseAdjacency() {
  if (_adjGraph !== _graph) { _adj = _graph ? buildAdjacency(_graph) : null; _adjGraph = _graph }
  return _adj
}

/** Set of node ids reachable from the current end via one segment (for highlighting). */
export function validNextNodes() {
  const set = new Set()
  if (!_graph) return set
  const end = courseEndNode()
  if (end == null) return set   // nothing picked yet → every node is a valid START (not "next")
  for (const s of Object.values(_graph.segments)) {
    if (s.from === end) set.add(s.to)
    if (s.to === end) set.add(s.from)
  }
  return set
}

/**
 * Set of SEGMENT ids that continue from the current end node. Crucial for the multigraph case where
 * TWO parallel segments connect the current end to the SAME node (e.g. a direct leg and a no-node
 * loop) — clicking the target node can only pick one, so the user clicks the specific highlighted
 * segment instead. Empty when nothing is picked yet (any segment can start the course).
 */
export function validNextSegmentIds() {
  const set = new Set()
  if (!_graph) return set
  const end = courseEndNode()
  if (end == null) return set
  for (const [id, s] of Object.entries(_graph.segments)) {
    if (s.from === end || s.to === end) set.add(id)
  }
  return set
}

/**
 * Click a node. Empty course + no anchor → set the start anchor. Otherwise append the segment
 * connecting the current end to the clicked node (out-and-back = click back where you came from).
 * Rejected (with a message) if no direct segment connects them.
 */
export function clickNode(nodeId) {
  if (!_active || _pending || !_graph || !_graph.nodes[nodeId]) return
  const end = courseEndNode()
  if (end == null) {
    _startNode = nodeId
    _status('Start set. Click any node to route there along the roads.')
    _notify()
    return
  }
  if (nodeId === end) return   // clicking the current end is a no-op
  // Fill the SHORTEST PATH of legs from the current end to the clicked node (waypoint routing on the
  // fetched roads). An adjacent node resolves to a single leg; a far node is auto-routed — click
  // intermediate nodes to shape a deliberate detour (a course that goes the long way). This never
  // touches an imported track's matched ride; it's the manual-authoring picker.
  const path = shortestPath(_graph, end, nodeId, { adj: courseAdjacency() })
  if (!path || !path.arcs.length) {
    _status('No route to that node on the fetched roads — click a closer node, or add more area.')
    return
  }
  for (const a of path.arcs) _course.push(a)
  const via = path.arcs.length > 1 ? ` (+${path.arcs.length} legs via shortest path)` : ''
  _status(`Course: ${_course.length} leg(s)${via}.`)
  _notify()
}

/** Append a specific segment+direction (segment click alternative to click-next-node). */
export function appendArc(segId, dir = null) {
  if (!_active || !_graph || !_graph.segments[segId]) return
  const s = _graph.segments[segId]
  if (courseEndNode() == null) {
    // First pick: anchor the start at this segment's from (or to if dir reverse) and add it.
    const useDir = dir || 'forward'
    _startNode = useDir === 'forward' ? s.from : s.to
    _course.push({ segment: segId, dir: useDir })
    _notify()
    return
  }
  const end = courseEndNode()
  let useDir = dir
  if (!useDir) useDir = s.from === end ? 'forward' : (s.to === end ? 'reverse' : null)
  const startNode = useDir === 'forward' ? s.from : s.to
  if (!useDir || startNode !== end) { _status('That leg does not continue from the current end.'); return }
  _course.push({ segment: segId, dir: useDir })
  _notify()
}

export function undoCourseStep() {
  if (_course.length) { _course.pop(); _status(`Course: ${_course.length} leg(s).`) }
  else if (_startNode) { _startNode = null; _status('Start cleared.') }
  _notify()
}

export function clearCourse() {
  _course = []
  _startNode = null
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Finish — compile + export to pipeline
// ────────────────────────────────────────────────────────────────────

/**
 * Compile the picked course and build a minimal route object for the pipeline (resampled to 3 m
 * uniform spacing, zero elevation — LIDAR fills it in). Calls exitCourseBuilder(); the caller then
 * populates ST.gpx and navigates to Clean.
 *
 * @returns {{ lats:number[], lons:number[], eles:number[], dists:Float64Array } | null}
 */
export function finishCourseBuilder() {
  if (!_active || !_graph || _course.length === 0) return null
  const v = validateRouteGraph({ ..._graph, route: _course })
  if (!v.ok) { _status(`Cannot compile: ${v.errors[0]}`); return null }

  // 1. Resample each UNIQUE segment to ~3 m, KEEPING its endpoints (the junction nodes). A reused
  //    segment is resampled once (shared id), so every pass emits identical points — and because the
  //    node endpoints are preserved, crossings stay exact (the old global resample averaged them away
  //    and phase-shifted each pass, which is what distorted the junctions).
  for (const id of new Set(_course.map((a) => a.segment))) {
    const s = _graph.segments[id]
    if (!s || s.points.length < 3) continue
    // Imported recorded rides carry raw GPS noise — the linear pipeline's Smooth step would normally
    // remove it, but courses SKIP position-smoothing there (it re-diverges reused passes). So smooth
    // here instead, per UNIQUE segment (every pass shares the result → reuse stays vertex-identical),
    // with endpoints PINNED to the junction nodes (junctions stay exact; fillets round the corners).
    // Authored-from-OSM segments are clean centerlines — left untouched.
    if (_imported) s.points = smoothSegmentPoints(s.points, 5)
    s.points = resampleSegmentPoints(s.points, 3)
  }

  // 2. Provenance for reuse reconciliation: each arc's segment id + direction + junction-node coords +
  //    length. Captured here (the graph is about to be discarded). Length/coords are resample-invariant.
  const courseArcs = _course.map((arc) => {
    const s = _graph.segments[arc.segment]
    const fromNode = _graph.nodes[arc.dir === 'forward' ? s.from : s.to]
    const toNode = _graph.nodes[arc.dir === 'forward' ? s.to : s.from]
    return {
      segId: arc.segment, dir: arc.dir, lengthM: segLengthM(s),
      from: { lat: fromNode.lat, lon: fromNode.lon },
      to: { lat: toNode.lat, lon: toNode.lon },
    }
  })

  // 3. Compile (no global resample) → a flat track with SHARP junctions. Corner-shaping is NOT done
  //    here: the Smooth step's native engine rounds EVERY turn (junction nodes + radius-detected road
  //    bends) to one user-set min radius, so a junction turn and a road bend of the same sharpness are
  //    shaped identically — and the radius stays adjustable/re-runnable (it isn't baked at finish).
  const graph = { ..._graph, route: _course }
  const compiled = compileRouteGraph(graph, { strict: false })
  if (!compiled.lats.length) return null

  const lats = compiled.lats
  const lons = compiled.lons
  const eles = new Array(lats.length).fill(0) // LIDAR fills at Clean (per UNIQUE segment, via the graph)
  const dists = new Float64Array(cumulativeDistances(lats, lons))

  // Keep the graph alive (deep-cloned, detached from module state) so LIDAR can fetch each UNIQUE
  // segment once and write Z onto its points, then recompile — segments own their elevation.
  const graphClone = JSON.parse(JSON.stringify(graph))

  exitCourseBuilder()
  return { lats, lons, eles, dists, courseArcs, graph: graphClone }
}

/**
 * Position-smooth ONE segment's geometry (σ=5 m Gaussian, endpoints pinned) — the R-INDEPENDENT noise
 * removal that an imported recorded ride needs, applied per UNIQUE segment so reused passes stay
 * vertex-identical and the junction-node endpoints stay put. Corner-shaping (the R-dependent part) is
 * NOT done here — the Smooth step's native engine rounds every turn to the user-set min radius, so it
 * stays adjustable. Densifies to ~1 m first so the σ window matches the pipeline regardless of the
 * recorded GPS spacing. Returns same-shape {lat,lon,ele} points (ele carried through unchanged).
 */
function smoothSegmentPoints(points, sigmaM) {
  if (points.length < 4) return points.map((p) => ({ ...p }))
  const dense = resampleSegmentPoints(points, 1)
  if (dense.length < 4) return dense
  const lats = dense.map((p) => p.lat), lons = dense.map((p) => p.lon)
  const eles = dense.map((p) => p.ele ?? 0)
  const d = cumulativeDistances(lats, lons)
  const sm = smoothPositions(lats, lons, d, sigmaM) // σ=5 m Gaussian, pins start + end
  return sm.lats.map((la, i) => ({ lat: la, lon: sm.lons[i], ele: eles[i] }))
}

/** Resample one segment's points to ~`spacingM`, preserving its endpoints and interpolating ele. */
function resampleSegmentPoints(points, spacingM) {
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon)
  const eles = points.map((p) => p.ele ?? 0)
  const d = cumulativeDistances(lats, lons)
  if (d[d.length - 1] < spacingM * 1.5) return points.map((p) => ({ ...p })) // too short to resample
  const rs = resampleRoute(lats, lons, d, spacingM)
  const out = []
  let seg = 0
  for (let i = 0; i < rs.lats.length; i++) {
    const dist = rs.dists[i]
    while (seg < d.length - 2 && d[seg + 1] < dist) seg++
    const segLen = d[seg + 1] - d[seg]
    const t = segLen > 0 ? (dist - d[seg]) / segLen : 0
    out.push({ lat: rs.lats[i], lon: rs.lons[i], ele: eles[seg] + t * (eles[seg + 1] - eles[seg]) })
  }
  return out
}

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

function _notify() { if (_onUpdate) _onUpdate() }
function _status(m) { if (_onStatus) _onStatus(m || '') }
