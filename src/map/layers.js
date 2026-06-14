/**
 * Map layer update functions — route polyline, corrections, brunnels, hover.
 *
 * Pure update functions that read ST and mutate Leaflet objects.
 * No event wiring — that's handled by index.js.
 */

import L from 'leaflet'
import { ST } from '../state.js'
import { bearing } from '../utils/math.js'
import { smoothedIndexForDist } from '../chart/shared.js'
import {
  getBuilderWaypoints,
  getBuilderSegments,
  getBuilderMode,
} from '../modes/route-builder.js'
import {
  isTopologyActive,
  getTopologyGraph,
  getTopologyBaseRoute,
  getSelectedSegments,
  getSelectedNodes,
  isBuildingCourse,
  getCourseSegmentIds,
  getCourse,
  validNextSegments,
  validNextArcs,
  getRoundabouts,
} from '../modes/topology-editor.js'
import {
  isCourseActive,
  getCourseGraph,
  getCourseArcs,
  getCourseStartNode,
  courseEndNode,
  validNextNodes,
  validNextSegmentIds,
  isEditMode as isCourseEditMode,
  getSelectedSegs as getCourseSelectedSegs,
  getSelectedNodes as getCourseSelectedNodes,
} from '../modes/course-builder.js'

// ────────────────────────────────────────────────────────────────────
// Zoom-adaptive display decimation
// ────────────────────────────────────────────────────────────────────

/** Earth circumference (m) at the equator — Web Mercator. */
const EARTH_CIRC_M = 40075016.686

/**
 * Shape-preserving decimation of a route for DISPLAY, via Douglas-Peucker
 * (RDP) at a sub-pixel tolerance for the CURRENT zoom.
 *
 * A point is kept only if dropping it would move the rendered line by more
 * than ~half a screen pixel — so straight runs collapse to their endpoints
 * while curves and hairpins keep every point needed to render their shape.
 * The result is visually indistinguishable from the full line at this zoom,
 * but the vertex count (and Leaflet's per-zoom reprojection cost) drops by
 * 1–2 orders of magnitude on long ~1m routes. Re-run on zoomend (see initMap)
 * so detail refines as the user zooms in.
 *
 * Iterative (explicit stack) — never recurses, so it is safe on 85k+ points.
 *
 * @param {ArrayLike<number>} lats
 * @param {ArrayLike<number>} lons
 * @param {L.Map} map
 * @returns {Array<[number, number]>} simplified [lat, lon] pairs
 */
function decimateForZoom(lats, lons, map) {
  const n = lats.length
  const full = () => {
    const out = new Array(n)
    for (let i = 0; i < n; i++) out[i] = [lats[i], lons[i]]
    return out
  }
  if (n < 3 || !map) return full()

  const center = map.getCenter()
  const zoom = map.getZoom()
  // Web Mercator metres-per-pixel at this latitude/zoom; tolerance = ½ pixel.
  const latRad = (center.lat * Math.PI) / 180
  const mpp = EARTH_CIRC_M * Math.cos(latRad) / Math.pow(2, zoom + 8)
  const tol = mpp * 0.5
  if (!(tol > 0)) return full()
  const tol2 = tol * tol

  // Local planar projection (metres) for perpendicular-distance — accurate
  // enough over a route's extent and far cheaper than full map projection.
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos(latRad)
  const X = i => lons[i] * mPerDegLon
  const Y = i => lats[i] * mPerDegLat

  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [0, n - 1] // flat pairs to avoid per-segment array allocation
  while (stack.length) {
    const b = stack.pop()
    const a = stack.pop()
    if (b - a < 2) continue
    const ax = X(a), ay = Y(a)
    const dx = X(b) - ax, dy = Y(b) - ay
    const len2 = dx * dx + dy * dy
    let maxD2 = -1, idx = -1
    for (let i = a + 1; i < b; i++) {
      const px = X(i), py = Y(i)
      let d2
      if (len2 === 0) {
        const ex = px - ax, ey = py - ay
        d2 = ex * ex + ey * ey
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2
        if (t < 0) t = 0
        else if (t > 1) t = 1
        const ex = px - (ax + t * dx), ey = py - (ay + t * dy)
        d2 = ex * ex + ey * ey
      }
      if (d2 > maxD2) { maxD2 = d2; idx = i }
    }
    if (maxD2 > tol2) {
      keep[idx] = 1
      stack.push(a, idx, idx, b)
    }
  }

  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push([lats[i], lons[i]])
  return out
}

// ────────────────────────────────────────────────────────────────────
// Route polyline + start/end markers
// ────────────────────────────────────────────────────────────────────

/**
 * Update the route polyline and start/end markers from ST.gpx.
 * @param {{
 *   routeLine: L.Polyline,
 *   snapOriginalLine?: L.Polyline,
 *   startMarker: L.CircleMarker,
 *   endMarker: L.CircleMarker
 * }} refs
 */
export function updateRoute(refs) {
  if (!ST.gpx) {
    if (refs.snapOriginalLine) refs.snapOriginalLine.setLatLngs([])
    return
  }

  // Use smoothed route coordinates when available, otherwise original
  const useSmoothed = !!ST.smoothedRoute
  const lats = useSmoothed ? ST.smoothedRoute.lats : ST.gpx.lats
  const lons = useSmoothed ? ST.smoothedRoute.lons : ST.gpx.lons
  const showSnapComparison = ST.activeStep === 'snap' && !!ST.snapPreState?.gpx && !useSmoothed
  const N = lats.length
  if (N === 0) return

  // Leaflet reprojects every vertex of the polyline on each zoom; a ~1m route
  // (tens of thousands of points after smoothing) makes that ~70ms per zoom.
  // Shape-preserving simplify to the current zoom's pixel resolution: curves
  // keep their points, only sub-pixel-straight runs collapse. Refreshes on
  // zoomend (see initMap) so detail refines as you zoom in.
  const latlngs = decimateForZoom(lats, lons, refs.map)

  refs.routeLine.setLatLngs(latlngs)
  refs.routeLine.setStyle({ color: showSnapComparison ? '#e87020' : (useSmoothed ? '#1a7a3a' : '#3a7bd5') })
  if (useSmoothed) refs.routeLine.bringToFront()

  if (refs.snapOriginalLine) {
    if (showSnapComparison) {
      const pre = ST.snapPreState.gpx
      const preLatlngs = []
      const preN = Math.min(pre.lats.length, pre.lons.length)
      for (let i = 0; i < preN; i++) preLatlngs.push([pre.lats[i], pre.lons[i]])
      refs.snapOriginalLine.setLatLngs(preLatlngs)
      refs.snapOriginalLine.setStyle({ color: '#3a7bd5', weight: 3, opacity: 0.75, dashArray: '8 6' })
    } else {
      refs.snapOriginalLine.setLatLngs([])
    }
  }

  refs.startMarker.setLatLng([lats[0], lons[0]])
  refs.endMarker.setLatLng([lats[N - 1], lons[N - 1]])
}

// ────────────────────────────────────────────────────────────────────
// Hover marker
// ────────────────────────────────────────────────────────────────────

/**
 * Show/hide the hover marker based on ST.hoverIdx.
 * @param {{ hoverMarker: L.CircleMarker }} refs
 */
export function updateHover(refs) {
  if (!ST.gpx) return
  const N = ST.gpx.lats.length

  if (ST.hoverIdx == null || ST.hoverIdx < 0 || ST.hoverIdx >= N) {
    refs.hoverMarker.setOpacity(0)
    return
  }

  // The displayed route switches to the smoothed (green) geometry whenever
  // ST.smoothedRoute exists (see updateRoute). hoverIdx is an index into the
  // ORIGINAL route, so map it onto the smoothed line by the original-distance
  // axis — using origDists when present, else proportional distance scaling
  // (mirrors the chart's hover mapping; see gotcha #9). Without this the orange
  // dot tracks the old path while the route shows green.
  let lat = ST.gpx.lats[ST.hoverIdx]
  let lon = ST.gpx.lons[ST.hoverIdx]
  if (ST.smoothedRoute && ST.dists) {
    // Binary search on the monotonic origDists/dists — see smoothedIndexForDist.
    const bestJ = smoothedIndexForDist(ST.dists[ST.hoverIdx])
    if (bestJ >= 0) {
      lat = ST.smoothedRoute.lats[bestJ]
      lon = ST.smoothedRoute.lons[bestJ]
    }
  }

  refs.hoverMarker.setLatLng([lat, lon])
  refs.hoverMarker.setOpacity(1)
}

// ────────────────────────────────────────────────────────────────────
// Correction overlays
// ────────────────────────────────────────────────────────────────────

/**
 * Get the display color for a correction based on its type and source.
 * @param {object} c — correction object
 * @returns {{ color: string, weight: number }}
 */
function corrStyle(c) {
  // Rejected corrections — red
  if (c.rejected) return { color: '#d03030', weight: 9 }

  // OSM-sourced corrections
  if (c.source === 'osm') {
    return c.type === 'bridge'
      ? { color: '#00b4d8', weight: 11 }
      : { color: '#9b5de5', weight: 11 }
  }

  // Manual hand-drawn corrections — green
  if (c.source === 'manual' || c.source === 'draw') {
    return { color: '#22c55e', weight: 9 }
  }

  // Auto-detected corrections by type
  if (c.type === 'bridge') return { color: '#3c78dc', weight: 9 }
  if (c.type === 'tunnel') return { color: '#8c50c8', weight: 9 }

  // Suspect accepted — green
  if (c.accepted) return { color: '#22c55e', weight: 9 }

  // Default — grey
  return { color: '#888888', weight: 9 }
}

/**
 * Rebuild correction overlay polylines on the map.
 * Each polyline is clickable — click calls onSelectCorr(ci).
 *
 * @param {{ corrLayer: L.LayerGroup }} refs
 * @param {Function} onSelectCorr — callback(corrIdx)
 */
export function updateCorrections(refs, onSelectCorr) {
  refs.corrLayer.clearLayers()
  if (!ST.corrections || !ST.gpx) return

  const { lats, lons } = ST.gpx
  const N = lats.length

  for (let ci = 0; ci < ST.corrections.length; ci++) {
    const c = ST.corrections[ci]

    // Build latlng array for this correction span
    const pts = []
    const hi = Math.min(c.ahi, N - 1)
    for (let i = c.alo; i <= hi; i++) pts.push([lats[i], lons[i]])
    if (pts.length === 0) continue

    const { color, weight } = corrStyle(c)
    const line = L.polyline(pts, { color, weight, opacity: 0.55 })

    // Clickable — select this correction
    const corrIdx = ci
    line.on('click', e => {
      L.DomEvent.stopPropagation(e)
      onSelectCorr(corrIdx)
    })

    line.addTo(refs.corrLayer)
  }
}

/**
 * Highlight the Split-step edit selection on the map: the committed selected
 * stretch of the active route (green), plus a marker at the first click of an
 * in-progress two-click range selection.
 * @param {{ editLayer: L.LayerGroup }} refs
 */
export function updateEditSelection(refs) {
  if (!refs.editLayer) return
  refs.editLayer.clearLayers()
  if (ST.activeStep !== 'split' || !ST.gpx) return

  const ar = ST.smoothedRoute || ST.gpx
  const dists = ST.smoothedRoute ? ST.smoothedRoute.dists : ST.dists
  if (!ar.lats || !dists || !dists.length) return
  const total = dists[dists.length - 1] || 1

  // Committed selection band (green) over the active route.
  if (ST.editSelection) {
    const dLo = ST.editSelection.fLo * total, dHi = ST.editSelection.fHi * total
    const pts = []
    for (let i = 0; i < ar.lats.length; i++) {
      if (dists[i] >= dLo && dists[i] <= dHi) pts.push([ar.lats[i], ar.lons[i]])
    }
    if (pts.length >= 2) {
      L.polyline(pts, { color: '#12a85a', weight: 7, opacity: 0.55, interactive: false }).addTo(refs.editLayer)
    }
  }

  // First-click marker during a two-click range select.
  if (ST.editSelClickFrac != null) {
    const d0 = ST.editSelClickFrac * total
    let idx = 0
    for (let i = 1; i < dists.length; i++) { if (Math.abs(dists[i] - d0) < Math.abs(dists[idx] - d0)) idx = i }
    L.circleMarker([ar.lats[idx], ar.lons[idx]], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#12a85a', fillOpacity: 1, interactive: false,
    }).addTo(refs.editLayer)
  }
}

// ────────────────────────────────────────────────────────────────────
// Topology editor overlay (nodes + directed segments)
// ────────────────────────────────────────────────────────────────────

const TOPO_COLORS = ['#3a7bd5', '#e8a020', '#9b59b6', '#16a085', '#d03060', '#2c9c4a', '#c0651a', '#7d5fff']

/**
 * Render the topology editor: each segment as a coloured polyline (selected =
 * thick green, reused = matching colour for both passes), node markers (clickable),
 * and a direction arrow per segment. Reads the live graph from topology-editor.js.
 * @param {{ topologyLayer: L.LayerGroup }} refs
 * @param {{ topoSegClick?:Function }} [actions] — segId click → toggle selection
 */
export function updateTopologyLayer(refs, actions = {}) {
  if (!refs.topologyLayer) return
  refs.topologyLayer.clearLayers()
  if (!isTopologyActive()) return
  const g = getTopologyGraph()
  const base = getTopologyBaseRoute()
  if (!g || !base) return
  const selected = new Set(getSelectedSegments())
  const building = isBuildingCourse()
  const inCourse = building ? new Set(getCourseSegmentIds()) : null
  const validNext = building ? validNextSegments() : null
  const validArcs = building ? validNextArcs() : null
  const courseArcs = building ? new Set(getCourse().map((a) => a.segment + ':' + a.dir)) : null

  // Stable colour per segment id (so the two passes of a merged segment match).
  const segIds = Object.keys(g.segments)
  const colorOf = (id) => TOPO_COLORS[segIds.indexOf(id) % TOPO_COLORS.length]

  for (const id of segIds) {
    const seg = g.segments[id]
    if (!seg.points || seg.points.length < 2) continue
    const pts = seg.points.map((p) => [p.lat, p.lon])
    const isSel = selected.has(id)
    // Build mode: course segments = solid blue, valid-next = amber, rest = faint grey.
    // Edit mode: selected = green, else per-id colour.
    // Stub legs (OSM cross-streets the route never drove, added by ◎ Complete junctions) are
    // dashed and, in edit mode, drawn in a distinct violet so they read as "added turns".
    const isStub = !!seg.stub
    let color, weight, opacity, dashArray = isStub ? '6,6' : null
    if (building) {
      if (inCourse.has(id)) { color = '#1565d8'; weight = 7; opacity = 0.95 }
      else if (validNext.has(id)) { color = '#e8a020'; weight = 5; opacity = 0.9 }
      else { color = '#888'; weight = 3; opacity = 0.5 }
    } else {
      color = isSel ? '#12a85a' : (isStub ? '#8a5cf0' : colorOf(id))
      weight = isSel ? 7 : 4
      opacity = isSel ? 0.9 : 0.8
    }
    const line = L.polyline(pts, { color, weight, opacity, dashArray, interactive: !!actions.topoSegClick })
    if (actions.topoSegClick) {
      line.on('click', (e) => { L.DomEvent.stopPropagation(e); actions.topoSegClick(id) })
    }
    line.addTo(refs.topologyLayer)

    // TWO direction arrows per segment — one each way — as big, clickable pick targets.
    // Clicking an arrow picks that DIRECTION (so out-and-back = pick the opposite arrow).
    // forward = heading from→to (drawn nearer the `to` end); reverse = to→from (nearer `from`).
    const np = seg.points.length
    const drawArrow = (atIdx, dir) => {
      const p = seg.points[atIdx]
      const before = dir === 'forward'
        ? seg.points[Math.max(0, atIdx - 1)]
        : seg.points[Math.min(np - 1, atIdx + 1)]
      const deg = bearing(before.lat, before.lon, p.lat, p.lon)
      const key = id + ':' + dir
      let ac, asz
      if (building) {
        if (courseArcs.has(key)) { ac = '#1565d8'; asz = 34 }       // already in the course
        else if (validArcs.has(key)) { ac = '#e8a020'; asz = 34 }   // a valid next pick
        else { ac = '#9aa0a6'; asz = 18 }                            // not pickable from here
      } else {
        ac = isSel ? '#12a85a' : colorOf(id); asz = 24
      }
      const c = asz / 2
      const m = L.marker([p.lat, p.lon], {
        interactive: !!actions.topoSegClick,
        icon: L.divIcon({
          className: '',
          html: `<svg width="${asz}" height="${asz}" viewBox="0 0 ${asz} ${asz}">`
            + `<circle cx="${c}" cy="${c}" r="${c - 2}" fill="${ac}" stroke="#fff" stroke-width="2" opacity="0.95"/>`
            + `<polygon points="${c},${c - asz * 0.28} ${c + asz * 0.22},${c + asz * 0.16} ${c - asz * 0.22},${c + asz * 0.16}" fill="#fff" transform="rotate(${deg},${c},${c})"/>`
            + `</svg>`,
          iconSize: [asz, asz], iconAnchor: [c, c],
        }),
      })
      if (actions.topoSegClick) {
        m.on('click', (e) => { L.DomEvent.stopPropagation(e); actions.topoSegClick(id, dir) })
      }
      m.addTo(refs.topologyLayer)
    }
    const fwdIdx = Math.min(np - 1, Math.max(1, Math.round(np * 0.64)))
    const revIdx = Math.min(np - 1, Math.max(1, Math.round(np * 0.36)))
    drawArrow(fwdIdx, 'forward')
    drawArrow(revIdx, 'reverse')
  }

  // Node markers (white-ringed dots) at each node — clickable for crossing-snap.
  const selNodes = new Set(getSelectedNodes())
  for (const [nid, node] of Object.entries(g.nodes)) {
    const sel = selNodes.has(nid)
    // Leaf nodes (dead-end ends of added OSM stub legs) render HOLLOW to distinguish them from
    // real junction/route nodes.
    const isLeaf = !!node.leaf
    const marker = L.circleMarker([node.lat, node.lon], {
      radius: sel ? 9 : (isLeaf ? 5 : 6),
      color: isLeaf ? '#8a5cf0' : '#fff',
      weight: 2,
      fillColor: sel ? '#12a85a' : (isLeaf ? '#fff' : '#222'),
      fillOpacity: isLeaf ? 0.9 : 1,
      interactive: !!actions.topoNodeSelect,
    })
    if (actions.topoNodeSelect) {
      marker.on('click', (e) => { L.DomEvent.stopPropagation(e); actions.topoNodeSelect(nid) })
    }
    marker.addTo(refs.topologyLayer)
  }

  // Detected roundabouts (highlight only): the on-ring span the rider
  // traversed (magenta, thick) + the full canonical ring from OSM (magenta, dashed).
  for (const r of getRoundabouts()) {
    if (r.ringPoints && r.ringPoints.length >= 2) {
      L.polyline(r.ringPoints.map((p) => [p.lat, p.lon]), {
        color: '#d61fb5', weight: 3, opacity: 0.85, dashArray: '6 6', interactive: false,
      }).addTo(refs.topologyLayer)
    }
    if (base && r.hi < base.lats.length) {
      const span = []
      for (let i = r.lo; i <= r.hi; i++) span.push([base.lats[i], base.lons[i]])
      L.polyline(span, { color: '#d61fb5', weight: 8, opacity: 0.55, interactive: false }).addTo(refs.topologyLayer)
    }
  }
}

/**
 * Render the Course Builder network: every leg as a clickable polyline (course legs blue, the rest
 * faint grey), and every node as a clickable dot (start/end = blue, reachable-next = amber, others
 * dark). Picking is click-next-node — the node markers carry the click handler.
 * @param {{ courseLayer: L.LayerGroup }} refs
 * @param {{ courseNodeClick?:Function, courseSegClick?:Function }} [actions]
 */
export function updateCourseLayer(refs, actions = {}) {
  if (!refs.courseLayer) return
  refs.courseLayer.clearLayers()
  if (!isCourseActive()) return
  const g = getCourseGraph()
  if (!g) return

  const inCourse = new Set(getCourseArcs().map((a) => a.segment))
  const startNode = getCourseStartNode()
  const endNode = courseEndNode()
  const nextNodes = validNextNodes()
  const nextSegs = validNextSegmentIds()
  const editing = isCourseEditMode()
  const selSegs = editing ? new Set(getCourseSelectedSegs()) : new Set()
  const selNodes = editing ? new Set(getCourseSelectedNodes()) : new Set()

  // Legs. In EDIT mode a selected leg is green + thick. Otherwise: a leg that CONTINUES from the
  // current end is amber + thicker (the multigraph case — two parallel legs to the same node both
  // light up so the user clicks the exact one). Course legs are blue, the rest grey.
  for (const [id, seg] of Object.entries(g.segments)) {
    if (!seg.points || seg.points.length < 2) continue
    const pts = seg.points.map((p) => [p.lat, p.lon])
    const on = inCourse.has(id)
    const isNext = !on && nextSegs.has(id)
    let color = '#7a8088', weight = 2.5, opacity = 0.6, dashArray = null
    if (seg.gap) { color = '#e01030'; weight = 4; opacity = 0.95; dashArray = '6 6' }  // bridged disconnect
    else if (selSegs.has(id)) { color = '#1fb04a'; weight = 7; opacity = 1 }
    else if (on) { color = '#1565d8'; weight = 6; opacity = 0.95 }
    else if (isNext) { color = '#e8a020'; weight = 4.5; opacity = 0.9 }
    const line = L.polyline(pts, { color, weight, opacity, dashArray, interactive: !!actions.courseSegClick })
    if (actions.courseSegClick) {
      line.on('click', (e) => { L.DomEvent.stopPropagation(e); actions.courseSegClick(id, e.latlng) })
    }
    line.addTo(refs.courseLayer)
  }

  // Amber direction-arrows on EVERY valid-next leg, drawn on top of the legs. A valid-next leg that
  // overlaps an already-traced BLUE leg (an out-and-back return, or a road offered for reuse) is hidden
  // under the blue line — only its end node peeked through. These arrows keep the routing option (and
  // its travel direction, away from the current end node) visible and clickable where it overlaps.
  if (!editing) {
    for (const id of nextSegs) {
      const seg = g.segments[id]
      if (!seg || !seg.points || seg.points.length < 2) continue
      // Orient the leg in the travel direction: away from the current end node.
      let pts = seg.points
      if (seg.to === endNode) pts = seg.points.slice().reverse()
      const n = pts.length
      const count = Math.min(5, Math.max(1, Math.floor(n / 8)))
      for (let a = 1; a <= count; a++) {
        const idx = Math.max(1, Math.min(n - 1, Math.round((n - 1) * a / (count + 1))))
        const p = pts[idx], q = pts[idx - 1]
        const deg = bearing(q.lat, q.lon, p.lat, p.lon)
        const m = L.marker([p.lat, p.lon], {
          interactive: !!actions.courseSegClick,
          icon: L.divIcon({
            className: 'course-next-arrow', iconSize: [16, 16], iconAnchor: [8, 8],
            html: '<svg width="16" height="16" viewBox="0 0 16 16" style="overflow:visible">'
              + `<polygon points="8,1 13,12 3,12" fill="#e8a020" stroke="#fff" stroke-width="1.2" transform="rotate(${deg},8,8)"/></svg>`,
          }),
        })
        if (actions.courseSegClick) {
          m.on('click', (e) => { L.DomEvent.stopPropagation(e); actions.courseSegClick(id, e.latlng) })
        }
        m.addTo(refs.courseLayer)
      }
    }
  }

  // Nodes. In EDIT mode a selected node is green + larger.
  for (const [nid, node] of Object.entries(g.nodes)) {
    const isEnd = nid === endNode
    const isStart = nid === startNode
    const isNext = nextNodes.has(nid)
    let fill = '#222', radius = 4
    if (selNodes.has(nid)) { fill = '#1fb04a'; radius = 8 }
    else if (isEnd) { fill = '#1565d8'; radius = 7 }
    else if (isStart) { fill = '#1565d8'; radius = 6 }
    else if (isNext) { fill = '#e8a020'; radius = 6 }
    const marker = L.circleMarker([node.lat, node.lon], {
      radius, color: '#fff', weight: 2, fillColor: fill, fillOpacity: 1,
      interactive: !!actions.courseNodeClick,
    })
    if (actions.courseNodeClick) {
      marker.on('click', (e) => { L.DomEvent.stopPropagation(e); actions.courseNodeClick(nid) })
    }
    marker.addTo(refs.courseLayer)
  }
}

// ────────────────────────────────────────────────────────────────────
// Brunnel overlays (OSM bridge/tunnel spans)
// ────────────────────────────────────────────────────────────────────

/**
 * Rebuild brunnel dashed overlay polylines.
 * @param {{ osmLayer: L.LayerGroup }} refs
 */
export function updateBrunnels(refs) {
  refs.osmLayer.clearLayers()
  if (!ST.brunnels || !ST.gpx) return

  const { lats, lons } = ST.gpx
  const N = lats.length

  for (const b of ST.brunnels) {
    const pts = []
    const hi = Math.min(b.ahi, N - 1)
    for (let i = b.alo; i <= hi; i++) pts.push([lats[i], lons[i]])
    if (pts.length === 0) continue

    const color = b.type === 'bridge' ? '#00b4d8' : '#9b5de5'
    L.polyline(pts, {
      color,
      weight: 8,
      opacity: 0.8,
      dashArray: '10 6',
    }).addTo(refs.osmLayer)
  }
}

// ────────────────────────────────────────────────────────────────────
// Trim markers
// ────────────────────────────────────────────────────────────────────

/**
 * Rebuild trim marker overlays showing cut zone A→B.
 * - Red polyline for the section being cut
 * - Orange dashed connector line A→B (the join after trim)
 * - Labeled markers at A and B
 * @param {{ trimLayer: L.LayerGroup }} refs
 */
export function updateTrimMarkers(refs) {
  refs.trimLayer.clearLayers()
  if (!ST.gpx) return

  const { lats, lons } = ST.gpx
  const N = lats.length

  const a = ST.trimMarkerA
  const b = ST.trimMarkerB

  // Helper: create a labeled div marker
  function labelMarker(lat, lon, label, color) {
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.4)">${label}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    })
    return L.marker([lat, lon], { icon, interactive: false })
  }

  if (a) {
    labelMarker(a.lat, a.lon, 'A', '#e87020').addTo(refs.trimLayer)
  }

  if (b) {
    labelMarker(b.lat, b.lon, 'B', '#c02020').addTo(refs.trimLayer)
  }

  // When both markers are set, show the cut zone and connector
  if (a && b) {
    const lo = Math.min(a.idx, b.idx)
    const hi = Math.max(a.idx, b.idx)

    // Red polyline for the section being removed
    const cutPts = []
    for (let i = lo; i <= Math.min(hi, N - 1); i++) cutPts.push([lats[i], lons[i]])
    if (cutPts.length > 0) {
      L.polyline(cutPts, {
        color: '#d03030',
        weight: 9,
        opacity: 0.55,
      }).addTo(refs.trimLayer)
    }

    // Orange dashed connector (shows the join after trim)
    L.polyline(
      [[lats[lo], lons[lo]], [lats[Math.min(hi, N - 1)], lons[Math.min(hi, N - 1)]]],
      { color: '#e87020', weight: 2.5, dashArray: '6 4', opacity: 0.8 },
    ).addTo(refs.trimLayer)
  }
}

// ────────────────────────────────────────────────────────────────────
// Snap route overlays (OSRM segments + waypoint markers)
// ────────────────────────────────────────────────────────────────────

/**
 * Rebuild snap overlay — orange segment polylines and numbered waypoint markers.
 * Polylines are click-to-drag: mousedown creates a temp draggable marker,
 * dragend fires `actions.snapPolylineDrag(newLat, newLon, routeIdx)`.
 *
 * @param {{ snapLayer: L.LayerGroup }} refs
 * @param {{ snapPolylineDrag?: (newLat: number, newLon: number, routeIdx: number) => void }} [actions]
 */
/**
 * Decide which waypoint markers to render at the current zoom so dense clusters
 * don't stack into un-clickable piles. A waypoint is hidden if its screen
 * position falls within `minPx` of an already-kept waypoint. Endpoints are
 * always kept. All waypoints remain in ST — this is display-only.
 *
 * @param {Array<{lat:number,lon:number}>} waypoints
 * @param {L.Map} map
 * @param {number} minPx — minimum on-screen separation in pixels
 * @returns {boolean[]} per-waypoint visibility
 */
function computeVisibleWaypoints(waypoints, map, minPx = 24) {
  const n = waypoints.length
  const show = new Array(n).fill(true)
  if (!map || n <= 2) return show

  // Grid bucket of kept screen points for O(n) neighbour checks.
  const kept = new Map() // "gx,gy" -> [{x,y}, ...]
  const cell = minPx
  const tooClose = (x, y) => {
    const gx = Math.floor(x / cell)
    const gy = Math.floor(y / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = kept.get(`${gx + dx},${gy + dy}`)
        if (!arr) continue
        for (const p of arr) {
          if (Math.hypot(p.x - x, p.y - y) < minPx) return true
        }
      }
    }
    return false
  }
  const add = (x, y) => {
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`
    if (!kept.has(key)) kept.set(key, [])
    kept.get(key).push({ x, y })
  }

  for (let i = 0; i < n; i++) {
    const isEnd = i === 0 || i === n - 1
    let pt
    try {
      pt = map.latLngToContainerPoint([waypoints[i].lat, waypoints[i].lon])
    } catch {
      continue // map not ready — leave shown
    }
    if (isEnd) { add(pt.x, pt.y); continue }
    if (tooClose(pt.x, pt.y)) show[i] = false
    else add(pt.x, pt.y)
  }
  return show
}

export function updateSnapRoute(refs, actions) {
  refs.snapLayer.clearLayers()

  const waypoints = ST.routeWaypoints
  const segments = ST.routeSegments
  if (!waypoints || waypoints.length === 0) return

  // Draw segment polylines (display only — map click handles add-waypoint)
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]
    if (seg.length < 2) continue

    L.polyline(seg, {
      color: '#e87020',
      weight: 6,
      opacity: 0.8,
      interactive: false,
    }).addTo(refs.snapLayer)
  }

  // Draw numbered waypoint markers — clickable to delete (need at least 2 remaining)
  const canDeleteWp = !!(actions && actions.snapDeleteWp)

  // Zoom-adaptive culling: refinement + self-near anchors pack many waypoints
  // within metres of each other in cities/out-and-backs, so at a given zoom
  // several markers stack onto the same pixel and become un-clickable piles.
  // Hide any marker that would render within MIN_PX of an already-shown one;
  // all waypoints stay in ST (route structure intact) and reappear as you zoom
  // in. Endpoints are always shown. Re-runs on zoomend (see map/index.js).
  const show = computeVisibleWaypoints(waypoints, refs.map, 24)

  for (let i = 0; i < waypoints.length; i++) {
    if (!show[i]) continue
    const wp = waypoints[i]
    const clickable = canDeleteWp && waypoints.length > 2

    // Direction arrow: bearing to next waypoint (last uses prev→current)
    let arrowDeg = 0
    if (waypoints.length >= 2) {
      if (i < waypoints.length - 1) {
        arrowDeg = bearing(wp.lat, wp.lon, waypoints[i + 1].lat, waypoints[i + 1].lon)
      } else {
        arrowDeg = bearing(waypoints[i - 1].lat, waypoints[i - 1].lon, wp.lat, wp.lon)
      }
    }

    // Only the visible 20px circle is a click target — the 40px container and
    // the arrow are pointer-events:none. Otherwise the transparent 10px margins
    // of densely-packed city waypoints overlap and clicks hit the wrong marker
    // (or seem to do nothing), which broke delete-on-click in dense areas.
    const icon = L.divIcon({
      className: '',
      html: `<div style="position:relative;width:40px;height:40px;pointer-events:none">`
        + `<div style="position:absolute;left:10px;top:10px;width:20px;height:20px;border-radius:50%;background:#e87020;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.4);border:2px solid #fff;cursor:${clickable ? 'pointer' : 'default'};pointer-events:${clickable ? 'auto' : 'none'};z-index:1">${i + 1}</div>`
        + `<svg width="40" height="40" viewBox="0 0 40 40" style="position:absolute;left:0;top:0;z-index:2;pointer-events:none">`
        + `<polygon points="20,0 25,9 15,9" fill="#e87020" stroke="#fff" stroke-width="1" transform="rotate(${arrowDeg}, 20, 20)"/>`
        + `</svg></div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    })

    const marker = L.marker([wp.lat, wp.lon], { icon, interactive: clickable })

    if (clickable) {
      const wpIdx = i
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e)
        actions.snapDeleteWp(wpIdx)
      })
    }

    marker.addTo(refs.snapLayer)
  }
}

// ────────────────────────────────────────────────────────────────────
// Route Builder layer
// ────────────────────────────────────────────────────────────────────

/**
 * Rebuild the route builder overlay — routed/manual segment polylines and
 * draggable, right-click-deletable numbered waypoint markers.
 *
 * @param {{ builderLayer: L.LayerGroup }} refs
 * @param {{
 *   builderDeleteWp?: (wpIdx: number) => void,
 *   builderDragWp?: (wpIdx: number, lat: number, lon: number) => void,
 *   builderInsertOnSeg?: (segIdx: number, lat: number, lon: number) => void,
 * }} [actions]
 */
export function updateRouteBuilderLayer(refs, actions = {}) {
  refs.builderLayer.clearLayers()

  const waypoints = getBuilderWaypoints()
  const segments = getBuilderSegments()
  const mode = getBuilderMode()

  // Draw segment polylines
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]
    if (seg.points.length < 2) continue

    const isManual = seg.type === 'manual'
    const line = L.polyline(seg.points, {
      color: isManual ? '#e87020' : '#3a7bd5',
      weight: 4,
      opacity: 0.85,
      dashArray: isManual ? '8 6' : null,
      interactive: !!actions.builderInsertOnSeg,
    })

    if (actions.builderInsertOnSeg) {
      const segIdx = s
      line.on('click', (e) => {
        L.DomEvent.stopPropagation(e)
        actions.builderInsertOnSeg(segIdx, e.latlng.lat, e.latlng.lng)
      })
    }

    line.addTo(refs.builderLayer)
  }

  if (waypoints.length === 0) return

  // Draw numbered waypoint markers — draggable, right-click to delete
  const canDelete = !!(actions.builderDeleteWp)
  const canDrag = !!(actions.builderDragWp)

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i]

    // Arrow bearing
    let arrowDeg = 0
    if (waypoints.length >= 2) {
      if (i < waypoints.length - 1) {
        arrowDeg = bearing(wp.lat, wp.lon, waypoints[i + 1].lat, waypoints[i + 1].lon)
      } else {
        arrowDeg = bearing(waypoints[i - 1].lat, waypoints[i - 1].lon, wp.lat, wp.lon)
      }
    }

    // Color matches segment type: first segment determines color (first wp uses next seg)
    const segForColor = i < segments.length ? segments[i] : (segments[i - 1] || null)
    const markerColor = (segForColor && segForColor.type === 'manual') ? '#e87020' : '#3a7bd5'

    const icon = L.divIcon({
      className: '',
      html: `<div style="position:relative;width:40px;height:40px">`
        + `<div style="position:absolute;left:10px;top:10px;width:20px;height:20px;border-radius:50%;background:${markerColor};color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.4);border:2px solid #fff;cursor:${canDrag ? 'grab' : 'default'};z-index:1">${i + 1}</div>`
        + `<svg width="40" height="40" viewBox="0 0 40 40" style="position:absolute;left:0;top:0;z-index:2;pointer-events:none">`
        + `<polygon points="20,0 25,9 15,9" fill="${markerColor}" stroke="#fff" stroke-width="1" transform="rotate(${arrowDeg}, 20, 20)"/>`
        + `</svg></div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    })

    const marker = L.marker([wp.lat, wp.lon], { icon, draggable: canDrag, interactive: true })

    if (canDelete) {
      const wpIdx = i
      marker.on('contextmenu', (e) => {
        L.DomEvent.stopPropagation(e)
        actions.builderDeleteWp(wpIdx)
      })
    }

    if (canDrag) {
      const wpIdx = i
      marker.on('dragend', (e) => {
        const ll = e.target.getLatLng()
        actions.builderDragWp(wpIdx, ll.lat, ll.lng)
      })
    }

    marker.addTo(refs.builderLayer)
  }
}
