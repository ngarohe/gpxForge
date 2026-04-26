/**
 * Map layer update functions — route polyline, corrections, brunnels, hover.
 *
 * Pure update functions that read ST and mutate Leaflet objects.
 * No event wiring — that's handled by index.js.
 */

import L from 'leaflet'
import { ST } from '../state.js'
import { bearing } from '../utils/math.js'
import {
  getBuilderWaypoints,
  getBuilderSegments,
  getBuilderMode,
} from '../modes/route-builder.js'

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

  const latlngs = []
  for (let i = 0; i < N; i++) latlngs.push([lats[i], lons[i]])

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
  const { lats, lons } = ST.gpx
  const N = lats.length

  if (ST.hoverIdx != null && ST.hoverIdx >= 0 && ST.hoverIdx < N) {
    refs.hoverMarker.setLatLng([lats[ST.hoverIdx], lons[ST.hoverIdx]])
    refs.hoverMarker.setStyle({ opacity: 1, fillOpacity: 1 })
  } else {
    refs.hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 })
  }
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

  for (let i = 0; i < waypoints.length; i++) {
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

    const icon = L.divIcon({
      className: '',
      html: `<div style="position:relative;width:40px;height:40px">`
        + `<div style="position:absolute;left:10px;top:10px;width:20px;height:20px;border-radius:50%;background:#e87020;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.4);border:2px solid #fff;cursor:${clickable ? 'pointer' : 'default'};z-index:1">${i + 1}</div>`
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
