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
import { updateRoute, updateHover, updateCorrections, updateBrunnels, updateTrimMarkers, updateSnapRoute, updateRouteBuilderLayer } from './layers.js'
import { isBuilderActive, isBuilderPending } from '../modes/route-builder.js'

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
  if (!ST.gpx) return
  updateRoute(_refs)
  updateHover(_refs)
  updateCorrections(_refs, _actions.selectCorr || noop)
  updateBrunnels(_refs)
  updateTrimMarkers(_refs)
  updateSnapRoute(_refs, _actions)
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
  _map.flyTo([lat, lon], zoom, { animate: true, duration: 0.6 })
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
  _map.fitBounds(bounds, { padding: [24, 24], animate: true })
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
  _actions = { selectCorr, trimClick, snapAddWp, snapDeleteWp, builderClick, builderDeleteWp, builderDragWp, builderInsertOnSeg }

  // ── Sync subscriptions ──
  subscribe('viewport', onViewportChange)
  subscribe('cursor', onCursorChange)

  // ── Leaflet event wiring ──
  _map.on('mousemove', onMapMouseMove)
  _map.on('mouseout', onMapMouseOut)
  _map.on('click', onMapClick)
  _map.on('dblclick', onMapDblClick)

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

function onViewportChange() {
  if (!ST.gpx || !_map) return
  updateHover(_refs)
  fitToViewport()
}

function onCursorChange() {
  if (!_map || !_refs) return
  updateHover(_refs)
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
  if (!ST.gpx || !ST.dists || isBuilderActive()) return
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
  // Route builder: intercept all clicks when builder is active
  if (isBuilderActive()) {
    if (!isBuilderPending() && _actions.builderClick) {
      _actions.builderClick(e.latlng.lat, e.latlng.lng)
    }
    return
  }

  if (!ST.gpx || !ST.dists) return

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
// Helpers
// ────────────────────────────────────────────────────────────────────

function noop() {}
