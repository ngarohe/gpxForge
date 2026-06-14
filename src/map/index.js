/**
 * Map orchestrator — initializes Leaflet, subscribes to sync events,
 * wires mouse interactions, and provides drawMap / mapFit entry points.
 *
 * Follows the same pattern as src/chart/index.js.
 */

import L from 'leaflet'
import { ST } from '../state.js'
import { subscribe, setCursor, clearCursor, setView, getViewRange } from '../sync.js'
import { visibleRange } from '../chart/shared.js'
import { nearestPointIndex } from '../utils/geometry.js'
import { createMap } from './setup.js'
import { updateRoute, updateHover, updateCorrections, updateBrunnels, updateTrimMarkers, updateSnapRoute, updateRouteBuilderLayer, updateEditSelection, updateTopologyLayer, updateCourseLayer } from './layers.js'
import { isBuilderActive, isBuilderPending } from '../modes/route-builder.js'
import { isTopologyActive, getTopologyBaseRoute } from '../modes/topology-editor.js'
import { isCourseActive, isCoursePending, isDrawArmed, getDrawShape } from '../modes/course-builder.js'

// ────────────────────────────────────────────────────────────────────
// Module state
// ────────────────────────────────────────────────────────────────────

let _map = null
let _refs = null         // { map, snapOriginalLine, routeLine, corrLayer, osmLayer, startMarker, endMarker, hoverMarker, tileLayers }
let _actions = {}
let _resizeTimer = null
let _fitted = false      // whether mapFit has been called at least once

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Redraw all map layers. Call after data changes (new GPX, corrections, etc.)
 */
export function drawMap() {
  if (!_map) return
  updateRouteBuilderLayer(_refs, _actions)
  updateTopologyLayer(_refs, _actions)
  updateCourseLayer(_refs, _actions)
  if (!ST.gpx) return
  updateRoute(_refs)
  updateHover(_refs)
  updateCorrections(_refs, _actions.selectCorr || noop)
  updateBrunnels(_refs)
  updateTrimMarkers(_refs)
  updateSnapRoute(_refs, _actions)
  updateEditSelection(_refs)
}

/**
 * Fit map bounds to the full route with padding.
 */
export function mapFit() {
  if (!ST.gpx || !_map) return
  const { lats, lons } = ST.gpx
  const N = lats.length
  if (N === 0) return

  const bounds = L.latLngBounds(lats.map((la, i) => [la, lons[i]]))
  _map.fitBounds(bounds, { padding: [24, 24] })
  _fitted = true
}

/**
 * Center map on a specific coordinate.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [zoom=12]
 */
export function mapGoTo(lat, lon, zoom = 12) {
  if (!_map) return
  const maxZ = _map.getMaxZoom ? _map.getMaxZoom() : 18
  _map.flyTo([lat, lon], Math.min(zoom, maxZ), { animate: true, duration: 0.6 })
  _fitted = true
}

/**
 * Fit map to a bounding box.
 * @param {number} south
 * @param {number} west
 * @param {number} north
 * @param {number} east
 */
export function mapFitBounds(south, west, north, east) {
  if (!_map) return
  const bounds = L.latLngBounds([[south, west], [north, east]])
  const maxZ = _map.getMaxZoom ? _map.getMaxZoom() : 18
  // Cap at maxZoom-1 to keep tiles visible (address-precision bboxes from
  // Nominatim are often tiny and otherwise fitBounds zooms past tile coverage)
  _map.fitBounds(bounds, { padding: [24, 24], animate: true, maxZoom: Math.max(1, maxZ - 1) })
  _fitted = true
}

/**
 * Initialize the map system.
 *
 * @param {HTMLElement} container — DOM element to mount map in
 * @param {object} [externalActions] — callbacks from UI layer
 * @param {Function} [externalActions.selectCorr] — (ci) correction selected
 * @param {Function} [externalActions.trimClick] — (idx) trim marker placed
 * @param {Function} [externalActions.snapAddWp] — (lat, lon, segIdx) add waypoint on segment
 * @param {Function} [externalActions.snapDeleteWp] — (wpIdx) delete waypoint and merge segments
 */
export function initMap(container, externalActions = {}) {
  _refs = createMap(container)
  _map = _refs.map

  const selectCorr = externalActions.selectCorr || noop
  const trimClick = externalActions.trimClick || noop
  const snapAddWp = externalActions.snapAddWp || noop
  const snapDeleteWp = externalActions.snapDeleteWp || noop
  const builderClick = externalActions.builderClick || noop
  const builderDeleteWp = externalActions.builderDeleteWp || noop
  const builderDragWp = externalActions.builderDragWp || noop
  const builderInsertOnSeg = externalActions.builderInsertOnSeg || noop
  const nudgeStart = externalActions.nudgeStart || noop
  const nudgeMove = externalActions.nudgeMove || noop
  const nudgeWheel = externalActions.nudgeWheel || noop
  const nudgeEnd = externalActions.nudgeEnd || noop
  const editPivotClick = externalActions.editPivotClick || noop
  const editRangeClick = externalActions.editRangeClick || noop
  const topoNodeClick = externalActions.topoNodeClick || noop
  const topoSegClick = externalActions.topoSegClick || noop
  const topoNodeSelect = externalActions.topoNodeSelect || noop
  const courseNodeClick = externalActions.courseNodeClick || noop
  const courseSegClick = externalActions.courseSegClick || noop
  const courseRegionDraw = externalActions.courseRegionDraw || noop
  const courseDrawProgress = externalActions.courseDrawProgress || noop
  _actions = { selectCorr, trimClick, snapAddWp, snapDeleteWp, builderClick, builderDeleteWp, builderDragWp, builderInsertOnSeg, nudgeStart, nudgeMove, nudgeWheel, nudgeEnd, editPivotClick, editRangeClick, topoNodeClick, topoSegClick, topoNodeSelect, courseNodeClick, courseSegClick, courseRegionDraw, courseDrawProgress }

  // ── Sync subscriptions ──
  subscribe('viewport', onViewportChange)
  subscribe('cursor', onCursorChange)

  // ── Leaflet event wiring ──
  _map.on('mousemove', onMapMouseMove)
  _map.on('mouseout', onMapMouseOut)
  _map.on('click', onMapClick)
  _map.on('dblclick', onMapDblClick)
  _map.on('mousedown', onMapMouseDown)
  // Re-decimate the route line to the new zoom's pixel resolution so detail
  // returns when zooming in (the line is decimated for speed — see updateRoute).
  _map.on('zoomend', onZoomEnd)
  // Wheel handler for nudge range adjustment — registered on the container
  container.addEventListener('wheel', onContainerWheel, { passive: false })

  // ── ResizeObserver — invalidate map on container resize ──
  const ro = new ResizeObserver(() => {
    if (_resizeTimer) clearTimeout(_resizeTimer)
    _resizeTimer = setTimeout(() => {
      if (_map) _map.invalidateSize()
    }, 60)
  })
  ro.observe(container)
}

// ────────────────────────────────────────────────────────────────────
// Sync callbacks
// ────────────────────────────────────────────────────────────────────

let _fitPending = false
function onViewportChange() {
  if (!ST.gpx || !_map) return
  updateHover(_refs)
  // Coalesce fitBounds to one per animation frame — scroll-zoom emits many
  // viewport events per second and each fitBounds reprojects the whole route.
  if (_fitPending) return
  const raf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : fn => setTimeout(fn, 16)
  _fitPending = true
  raf(() => { _fitPending = false; fitToViewport() })
}

function onCursorChange() {
  if (!_map || !_refs) return
  updateHover(_refs)
}

function onZoomEnd() {
  if (!ST.gpx || !_map) return
  updateRoute(_refs)
  // Re-cull snap waypoint markers for the new zoom (dense clusters separate as
  // you zoom in, stack as you zoom out — see computeVisibleWaypoints).
  updateSnapRoute(_refs, _actions)
}

// ────────────────────────────────────────────────────────────────────
// Viewport fitting — chart zoom drives map bounds
// ────────────────────────────────────────────────────────────────────

/**
 * Fit the map to show only the route section currently visible in the chart.
 */
function fitToViewport() {
  if (!ST.gpx || !ST.dists || !_map) return

  const { lats, lons } = ST.gpx
  const N = lats.length
  if (N === 0) return

  // Full viewport — fit all
  if (ST.viewStart <= 0 && ST.viewEnd >= 1) {
    if (!_fitted) mapFit()
    return
  }

  const { lo, hi } = getViewRange()
  const { iLo, iHi } = visibleRange(ST.dists, lo, hi)

  // Build bounds from visible points only
  const points = []
  for (let i = iLo; i <= iHi; i++) points.push([lats[i], lons[i]])

  if (points.length < 2) return

  const bounds = L.latLngBounds(points)
  _map.fitBounds(bounds, { padding: [24, 24], animate: false })
}

// ────────────────────────────────────────────────────────────────────
// Mouse interaction — bidirectional cursor sync
// ────────────────────────────────────────────────────────────────────

/** Pixel threshold for route hover detection (consistent across zoom levels). */
const HOVER_PX_THRESHOLD = 30

function onMapMouseMove(e) {
  if (!ST.gpx || !ST.dists || isBuilderActive() || isTopologyActive() || isCourseActive()) return
  const { lats, lons } = ST.gpx

  // Find nearest route point
  const idx = nearestPointIndex(e.latlng.lat, e.latlng.lng, lats, lons)

  // Check pixel distance for consistent threshold
  const pointLL = L.latLng(lats[idx], lons[idx])
  const pointPx = _map.latLngToContainerPoint(pointLL)
  const mousePx = _map.mouseEventToContainerPoint(e.originalEvent)
  const pxDist = pointPx.distanceTo(mousePx)

  if (pxDist < HOVER_PX_THRESHOLD) {
    setCursor(idx, ST.dists[idx])
  } else {
    clearCursor()
  }
}

function onMapMouseOut() {
  clearCursor()
}

function onMapClick(e) {
  // Course Builder.
  if (isCourseActive()) {
    // While armed to draw a polygon/corridor, each background click adds a vertex (bbox is a drag).
    if (isDrawArmed() && !isCoursePending() && getDrawShape() !== 'bbox') {
      onCourseVertexClick(e.latlng.lat, e.latlng.lng)
    }
    // Otherwise node/leg picks are handled by each marker/polyline's own click handler.
    return
  }

  // Topology editor: a click near the base route drops a node there. Clicks ON a
  // segment polyline are handled by that polyline's own click handler (topoSegClick),
  // which stops propagation, so we only reach here for "drop a node" clicks.
  if (isTopologyActive()) {
    const base = getTopologyBaseRoute()
    if (base && _actions.topoNodeClick) {
      const idx = nearestPointIndex(e.latlng.lat, e.latlng.lng, base.lats, base.lons)
      const aPx = _map.latLngToContainerPoint(L.latLng(base.lats[idx], base.lons[idx]))
      const cPx = _map.mouseEventToContainerPoint(e.originalEvent)
      if (aPx.distanceTo(cPx) < HOVER_PX_THRESHOLD) _actions.topoNodeClick(idx / (base.lats.length - 1))
    }
    return
  }

  // Route builder: intercept all clicks when builder is active
  if (isBuilderActive()) {
    if (!isBuilderPending() && _actions.builderClick) {
      _actions.builderClick(e.latlng.lat, e.latlng.lng)
    }
    return
  }

  if (!ST.gpx || !ST.dists) return

  // Split step: move-start pivot — click the active route to pick the new start.
  // Uses the active (smoothed or original) route since that is what's drawn.
  if (ST.activeStep === 'split' && ST.editPivotMode) {
    const ar = ST.smoothedRoute || ST.gpx
    const aDists = ST.smoothedRoute ? ST.smoothedRoute.dists : ST.dists
    const aIdx = nearestPointIndex(e.latlng.lat, e.latlng.lng, ar.lats, ar.lons)
    const aPx = _map.latLngToContainerPoint(L.latLng(ar.lats[aIdx], ar.lons[aIdx]))
    const cPx = _map.mouseEventToContainerPoint(e.originalEvent)
    if (aPx.distanceTo(cPx) >= HOVER_PX_THRESHOLD) return
    const total = aDists[aDists.length - 1] || 1
    _actions.editPivotClick(aDists[aIdx] / total)
    return
  }

  // Split step: range select — two clicks on the track define a segment.
  if (ST.activeStep === 'split' && ST.editSelectMode) {
    const ar = ST.smoothedRoute || ST.gpx
    const aDists = ST.smoothedRoute ? ST.smoothedRoute.dists : ST.dists
    const aIdx = nearestPointIndex(e.latlng.lat, e.latlng.lng, ar.lats, ar.lons)
    const aPx = _map.latLngToContainerPoint(L.latLng(ar.lats[aIdx], ar.lons[aIdx]))
    const cPx = _map.mouseEventToContainerPoint(e.originalEvent)
    if (aPx.distanceTo(cPx) >= HOVER_PX_THRESHOLD) return
    const total = aDists[aDists.length - 1] || 1
    _actions.editRangeClick(aDists[aIdx] / total)
    return
  }

  // Snap step: click anywhere on map to add a waypoint
  if (ST.activeStep === 'snap' && ST.routeSegments.length > 0 && _actions.snapAddWp) {
    const clickLat = e.latlng.lat
    const clickLon = e.latlng.lng

    // Find which segment the click is nearest to (for insertion position)
    let bestSegIdx = 0
    let bestDist = Infinity
    for (let s = 0; s < ST.routeSegments.length; s++) {
      const seg = ST.routeSegments[s]
      for (let i = 0; i < seg.length; i++) {
        const d = (seg[i][0] - clickLat) ** 2 + (seg[i][1] - clickLon) ** 2
        if (d < bestDist) { bestDist = d; bestSegIdx = s }
      }
    }

    _actions.snapAddWp(clickLat, clickLon, bestSegIdx)
    return
  }

  const { lats, lons } = ST.gpx
  const idx = nearestPointIndex(e.latlng.lat, e.latlng.lng, lats, lons)

  // Check if click is near enough to the route
  const pointLL = L.latLng(lats[idx], lons[idx])
  const pointPx = _map.latLngToContainerPoint(pointLL)
  const clickPx = _map.mouseEventToContainerPoint(e.originalEvent)
  const pxDist = pointPx.distanceTo(clickPx)

  if (pxDist >= HOVER_PX_THRESHOLD) return

  // Step-aware click dispatch
  if (ST.activeStep === 'trim') {
    _actions.trimClick(idx)
    return
  }

  setCursor(idx, ST.dists[idx])
}

function onMapDblClick(e) {
  // Course Builder: double-click finishes a polygon/corridor draw.
  if (isCourseActive()) {
    if (isDrawArmed() && getDrawShape() !== 'bbox') { L.DomEvent.stop(e); onCourseDrawFinish() }
    return
  }
  if (!ST.gpx || !ST.dists || isBuilderActive()) return
  L.DomEvent.stopPropagation(e)

  const { lats, lons } = ST.gpx
  const N = lats.length
  const total = ST.dists[N - 1]
  if (total <= 0) return

  const idx = nearestPointIndex(e.latlng.lat, e.latlng.lng, lats, lons)
  const center = ST.dists[idx] / total
  // Zoom to ~1km window (or half the route if shorter)
  const win = Math.min(0.5, 1000 / total)
  setView(Math.max(0, center - win / 2), Math.min(1, center + win / 2))
}

// ────────────────────────────────────────────────────────────────────
// Nudge mode — drag a point on the route, scroll wheel to adjust range
// ────────────────────────────────────────────────────────────────────

let _nudgeDocMove = null
let _nudgeDocUp = null

function onMapMouseDown(e) {
  // Course Builder bbox draw: drag a rectangle to fetch its street network.
  // (Polygon/corridor are click-to-add-vertex gestures, handled in onMapClick.)
  if (isCourseActive() && isDrawArmed() && !isCoursePending() && getDrawShape() === 'bbox') {
    if (e.originalEvent && e.originalEvent.button !== 0) return
    onCourseDrawStart(e)
    return
  }
  if (!ST.nudgeMode || !ST.gpx || !ST.dists) return
  if (ST.activeStep !== 'snap') return
  if (e.originalEvent && e.originalEvent.button !== 0) return

  const { lats, lons } = ST.gpx
  const idx = nearestPointIndex(e.latlng.lat, e.latlng.lng, lats, lons)
  const pointLL = L.latLng(lats[idx], lons[idx])
  const pointPx = _map.latLngToContainerPoint(pointLL)
  const downPx = _map.mouseEventToContainerPoint(e.originalEvent)
  if (pointPx.distanceTo(downPx) > HOVER_PX_THRESHOLD) return

  // Capture drag — block map pan AND scroll-wheel zoom for the drag's duration
  if (e.originalEvent) {
    e.originalEvent.preventDefault()
    e.originalEvent.stopPropagation()
  }
  _map.dragging.disable()
  if (_map.scrollWheelZoom && _map.scrollWheelZoom.enabled()) _map.scrollWheelZoom.disable()

  _actions.nudgeStart(idx, e.latlng.lat, e.latlng.lng)

  // Listen on document so dragging works even off the map
  _nudgeDocMove = (ev) => {
    const ll = _map.mouseEventToLatLng(ev)
    _actions.nudgeMove(ll.lat, ll.lng)
    ev.preventDefault()
  }
  _nudgeDocUp = (ev) => {
    document.removeEventListener('mousemove', _nudgeDocMove)
    document.removeEventListener('mouseup', _nudgeDocUp)
    _nudgeDocMove = null
    _nudgeDocUp = null
    _map.dragging.enable()
    if (_map.scrollWheelZoom) _map.scrollWheelZoom.enable()
    const ll = _map.mouseEventToLatLng(ev)
    _actions.nudgeEnd(ll.lat, ll.lng)
  }
  document.addEventListener('mousemove', _nudgeDocMove)
  document.addEventListener('mouseup', _nudgeDocUp)
}

// ────────────────────────────────────────────────────────────────────
// Course Builder — bbox draw gesture
// ────────────────────────────────────────────────────────────────────

let _courseRect = null
let _courseDrawStart = null
let _courseDocMove = null
let _courseDocUp = null

function onCourseDrawStart(e) {
  if (e.originalEvent) { e.originalEvent.preventDefault(); e.originalEvent.stopPropagation() }
  _map.dragging.disable()
  _courseDrawStart = e.latlng
  _courseRect = L.rectangle(L.latLngBounds(e.latlng, e.latlng), {
    color: '#1565d8', weight: 2, dashArray: '6,4', fillOpacity: 0.08, interactive: false,
  }).addTo(_map)

  _courseDocMove = (ev) => {
    const ll = _map.mouseEventToLatLng(ev)
    _courseRect.setBounds(L.latLngBounds(_courseDrawStart, ll))
    ev.preventDefault()
  }
  _courseDocUp = (ev) => {
    document.removeEventListener('mousemove', _courseDocMove)
    document.removeEventListener('mouseup', _courseDocUp)
    _courseDocMove = null; _courseDocUp = null
    _map.dragging.enable()
    const end = _map.mouseEventToLatLng(ev)
    const b = L.latLngBounds(_courseDrawStart, end)
    if (_courseRect) { _map.removeLayer(_courseRect); _courseRect = null }
    _courseDrawStart = null
    const bounds = {
      type: 'bbox',
      minLat: b.getSouth(), minLon: b.getWest(), maxLat: b.getNorth(), maxLon: b.getEast(),
    }
    // Ignore a tiny click-drag (a stray click, not a box).
    if ((bounds.maxLat - bounds.minLat) > 1e-5 && (bounds.maxLon - bounds.minLon) > 1e-5) {
      _actions.courseRegionDraw(bounds)
    }
  }
  document.addEventListener('mousemove', _courseDocMove)
  document.addEventListener('mouseup', _courseDocUp)
}

// Polygon / corridor draw — click to add vertices; finish by double-click, the ✓ Finish button,
// or (polygon) clicking back on the first point. Cancel via ✕ Cancel or Esc.
let _courseVerts = []
let _coursePoly = null
let _courseVertDots = []

function renderCourseDraw() {
  const latlngs = _courseVerts.map((v) => [v.lat, v.lon])
  const isPoly = getDrawShape() === 'poly'
  if (!_coursePoly && latlngs.length) {
    // Light, low-opacity preview so it reads as a pending selection, not committed geometry.
    _coursePoly = (isPoly
      ? L.polygon(latlngs, { color: '#1565d8', weight: 2, opacity: 0.6, dashArray: '5,5', fillColor: '#1565d8', fillOpacity: 0.06, interactive: false })
      : L.polyline(latlngs, { color: '#1565d8', weight: 3, opacity: 0.6, dashArray: '5,5', interactive: false })).addTo(_map)
  } else if (_coursePoly) {
    _coursePoly.setLatLngs(latlngs)
  }
  // Vertex dots — the first one larger/hollow so "click here to close" reads (polygon).
  _courseVertDots.forEach((d) => _map.removeLayer(d))
  _courseVertDots = _courseVerts.map((v, i) => L.circleMarker([v.lat, v.lon], {
    radius: i === 0 ? 7 : 4, color: '#fff', weight: 2,
    fillColor: i === 0 ? '#e8a020' : '#1565d8', fillOpacity: 1, interactive: false,
  }).addTo(_map))
}

function onCourseVertexClick(lat, lon) {
  // Polygon: a click near the first vertex closes the loop (intuitive finish).
  if (getDrawShape() === 'poly' && _courseVerts.length >= 3) {
    const p0 = _map.latLngToContainerPoint(L.latLng(_courseVerts[0].lat, _courseVerts[0].lon))
    const pc = _map.latLngToContainerPoint(L.latLng(lat, lon))
    if (p0.distanceTo(pc) < 12) { onCourseDrawFinish(); return }
  }
  _courseVerts.push({ lat, lon })
  renderCourseDraw()
  if (_actions.courseDrawProgress) _actions.courseDrawProgress(_courseVerts.length, getDrawShape())
}

/** Public: finish/cancel the in-progress polygon/corridor draw (panel buttons / Esc). */
export function finishCourseDraw() { onCourseDrawFinish() }
export function cancelCourseDraw() {
  if (_coursePoly) { _map.removeLayer(_coursePoly); _coursePoly = null }
  _courseVertDots.forEach((d) => _map.removeLayer(d)); _courseVertDots = []
  _courseVerts = []
  if (_actions.courseDrawProgress) _actions.courseDrawProgress(0, getDrawShape())
}
export function courseDrawVertexCount() { return _courseVerts.length }

function onCourseDrawFinish() {
  const shape = getDrawShape()
  const verts = _courseVerts.slice()
  if (_coursePoly) { _map.removeLayer(_coursePoly); _coursePoly = null }
  _courseVertDots.forEach((d) => _map.removeLayer(d)); _courseVertDots = []
  _courseVerts = []
  if (_actions.courseDrawProgress) _actions.courseDrawProgress(0, shape)
  const minPts = shape === 'poly' ? 3 : 2
  if (verts.length < minPts) return
  if (shape === 'poly') _actions.courseRegionDraw({ type: 'poly', points: verts })
  else _actions.courseRegionDraw({ type: 'corridor', points: verts, bufferM: 40 })
}

function onContainerWheel(ev) {
  if (!ST.nudgeMode || !ST.nudgeDragState) return
  ev.preventDefault()
  ev.stopPropagation()
  // wheel UP (deltaY<0) = grow range; wheel DOWN (deltaY>0) = shrink
  _actions.nudgeWheel(ev.deltaY < 0 ? 'grow' : 'shrink')
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function noop() {}
