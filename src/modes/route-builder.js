/**
 * Route Builder — create-from-scratch mode.
 *
 * The user clicks waypoints on the map; Valhalla routes each A→B segment.
 * When done, exports a minimal ST.gpx and hands off to the normal pipeline.
 *
 * Module-level state (not in ST — builder is a temporary create mode).
 * Rendering is delegated to map/layers.js updateRouteBuilderLayer().
 */

import { valhallaSegment } from '../api/valhalla.js'
import { mergeSegments } from '../pipeline/1-snap.js'
import { cumulativeDistances, haversine } from '../utils/math.js'
import { resampleRoute } from '../utils/geometry.js'
import { ST } from '../state.js'

// ────────────────────────────────────────────────────────────────────
// Module state
// ────────────────────────────────────────────────────────────────────

let _active = false
let _mode = 'routed'           // 'routed' | 'manual'
let _pending = false           // blocks clicks while async routing in-flight
let _history = []              // undo stack: [{waypoints, segments}] snapshots
let _profile = 'car'           // Valhalla profile: 'car' | 'bike'

// waypoints: [{lat, lon}]
// segments:  [{type: 'routed'|'manual', points: [[lat,lon],...], dist: metres}]
let _waypoints = []
let _segments = []

// Callbacks registered by main.js
let _onUpdate = null           // () => void — called after any state change
let _onStatusChange = null     // (msg: string) => void

// ────────────────────────────────────────────────────────────────────
// Public getters (for layer rendering)
// ────────────────────────────────────────────────────────────────────

export function isBuilderActive() { return _active }
export function isBuilderPending() { return _pending }
export function getBuilderMode() { return _mode }
export function getBuilderWaypoints() { return _waypoints }
export function getBuilderSegments() { return _segments }
export function getBuilderProfile() { return _profile }

/** Total route distance in metres across all segments. */
export function getBuilderDistance() {
  return _segments.reduce((sum, s) => sum + s.dist, 0)
}

// ────────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────────

/**
 * Enter route builder mode.
 * @param {{ onUpdate: Function, onStatusChange: Function }} callbacks
 */
export function enterBuilderMode(callbacks = {}) {
  _active = true
  _mode = 'routed'
  _pending = false
  _history = []
  _waypoints = []
  _segments = []
  _onUpdate = callbacks.onUpdate || null
  _onStatusChange = callbacks.onStatusChange || null
  _notify()
}

/**
 * Exit route builder mode without exporting.
 */
export function exitBuilderMode() {
  _active = false
  _pending = false
  _waypoints = []
  _segments = []
  _history = []
  _onUpdate = null
  _onStatusChange = null
}

// ────────────────────────────────────────────────────────────────────
// Mode + profile toggles
// ────────────────────────────────────────────────────────────────────

export function setBuilderMode(mode) {
  _mode = mode
  _notify()
}

export function setBuilderProfile(profile) {
  _profile = profile
}

// ────────────────────────────────────────────────────────────────────
// Snapshot / undo
// ────────────────────────────────────────────────────────────────────

function saveSnapshot() {
  _history.push({
    waypoints: _waypoints.map(w => ({ ...w })),
    segments: _segments.map(s => ({
      ...s,
      points: s.points.map(p => [...p]),
    })),
  })
  if (_history.length > 50) _history.shift()
}

export function builderCanUndo() {
  return _history.length > 0
}

export function builderUndo() {
  if (!_history.length) return
  const snap = _history.pop()
  _waypoints = snap.waypoints
  _segments = snap.segments
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Clear all
// ────────────────────────────────────────────────────────────────────

export function builderClear() {
  saveSnapshot()
  _waypoints = []
  _segments = []
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Add waypoint (map click)
// ────────────────────────────────────────────────────────────────────

/**
 * Handle a map click in builder mode.
 * Adds a waypoint and routes to it from the previous waypoint.
 */
export async function onBuilderMapClick(lat, lon) {
  if (!_active || _pending) return

  saveSnapshot()

  const prev = _waypoints.length > 0 ? _waypoints[_waypoints.length - 1] : null
  _waypoints.push({ lat, lon })

  if (prev) {
    if (_mode === 'routed') {
      _pending = true
      _setStatus('Routing\u2026')
      _notify()
      try {
        const result = await valhallaSegment(prev.lat, prev.lon, lat, lon, _profile)
        _segments.push({ type: 'routed', points: result.coords, dist: result.dist })
      } catch (err) {
        console.warn('[RouteBuilder] Routing failed, using straight segment:', err?.message || err)
        // Fallback to manual segment on routing failure
        const dist = haversine(prev.lat, prev.lon, lat, lon)
        _segments.push({ type: 'manual', points: [[prev.lat, prev.lon], [lat, lon]], dist })
        _setStatus('Routing failed — added straight segment')
      }
      _pending = false
    } else {
      // Manual mode — straight line
      const dist = haversine(prev.lat, prev.lon, lat, lon)
      _segments.push({ type: 'manual', points: [[prev.lat, prev.lon], [lat, lon]], dist })
    }
  }

  _setStatus(null)
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Drag waypoint
// ────────────────────────────────────────────────────────────────────

/**
 * Reroute after a waypoint has been dragged to a new position.
 * @param {number} wpIdx — index of dragged waypoint
 * @param {number} lat
 * @param {number} lon
 */
export async function onBuilderWaypointDrag(wpIdx, lat, lon) {
  if (!_active || _pending) return

  saveSnapshot()
  _waypoints[wpIdx] = { lat, lon }

  _pending = true
  _setStatus('Routing\u2026')
  _notify()

  try {
    // Reroute segment BEFORE dragged waypoint
    if (wpIdx > 0) {
      const prev = _waypoints[wpIdx - 1]
      const segBefore = _segments[wpIdx - 1]
      if (segBefore.type === 'routed') {
        try {
          const r = await valhallaSegment(prev.lat, prev.lon, lat, lon, _profile)
          _segments[wpIdx - 1] = { type: 'routed', points: r.coords, dist: r.dist }
        } catch {
          const dist = haversine(prev.lat, prev.lon, lat, lon)
          _segments[wpIdx - 1] = { type: 'manual', points: [[prev.lat, prev.lon], [lat, lon]], dist }
        }
      } else {
        // Manual — update straight line
        const dist = haversine(prev.lat, prev.lon, lat, lon)
        _segments[wpIdx - 1] = { type: 'manual', points: [[prev.lat, prev.lon], [lat, lon]], dist }
      }
    }

    // Reroute segment AFTER dragged waypoint
    if (wpIdx < _waypoints.length - 1) {
      const next = _waypoints[wpIdx + 1]
      const segAfter = _segments[wpIdx]
      if (segAfter.type === 'routed') {
        try {
          const r = await valhallaSegment(lat, lon, next.lat, next.lon, _profile)
          _segments[wpIdx] = { type: 'routed', points: r.coords, dist: r.dist }
        } catch {
          const dist = haversine(lat, lon, next.lat, next.lon)
          _segments[wpIdx] = { type: 'manual', points: [[lat, lon], [next.lat, next.lon]], dist }
        }
      } else {
        const dist = haversine(lat, lon, next.lat, next.lon)
        _segments[wpIdx] = { type: 'manual', points: [[lat, lon], [next.lat, next.lon]], dist }
      }
    }
  } finally {
    _pending = false
  }

  _setStatus(null)
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Delete waypoint (right-click)
// ────────────────────────────────────────────────────────────────────

/**
 * Delete a waypoint and merge/reroute the surrounding segments.
 * @param {number} wpIdx
 */
export async function onBuilderDeleteWaypoint(wpIdx) {
  if (!_active || _pending || _waypoints.length === 0) return

  saveSnapshot()

  if (_waypoints.length === 1) {
    // Only one waypoint — just remove it
    _waypoints = []
    _segments = []
    _notify()
    return
  }

  const isFirst = wpIdx === 0
  const isLast = wpIdx === _waypoints.length - 1

  if (isFirst) {
    _waypoints.splice(0, 1)
    _segments.splice(0, 1)
    _notify()
    return
  }

  if (isLast) {
    _waypoints.splice(wpIdx, 1)
    _segments.splice(wpIdx - 1, 1)
    _notify()
    return
  }

  // Middle waypoint — remove both adjacent segments, insert merged segment
  const before = _segments[wpIdx - 1]
  const after = _segments[wpIdx]

  // Merged type: if either adjacent was manual → manual; else routed
  const mergedType = (before.type === 'manual' || after.type === 'manual') ? 'manual' : 'routed'

  _waypoints.splice(wpIdx, 1)
  _segments.splice(wpIdx - 1, 2)  // remove both adjacent segments

  const prevWp = _waypoints[wpIdx - 1]
  const nextWp = _waypoints[wpIdx]  // shifted after splice

  if (mergedType === 'routed') {
    _pending = true
    _setStatus('Routing\u2026')
    _notify()
    try {
      const r = await valhallaSegment(prevWp.lat, prevWp.lon, nextWp.lat, nextWp.lon, _profile)
      _segments.splice(wpIdx - 1, 0, { type: 'routed', points: r.coords, dist: r.dist })
    } catch {
      const dist = haversine(prevWp.lat, prevWp.lon, nextWp.lat, nextWp.lon)
      _segments.splice(wpIdx - 1, 0, { type: 'manual', points: [[prevWp.lat, prevWp.lon], [nextWp.lat, nextWp.lon]], dist })
    }
    _pending = false
  } else {
    const dist = haversine(prevWp.lat, prevWp.lon, nextWp.lat, nextWp.lon)
    _segments.splice(wpIdx - 1, 0, { type: 'manual', points: [[prevWp.lat, prevWp.lon], [nextWp.lat, nextWp.lon]], dist })
  }

  _setStatus(null)
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Insert waypoint on segment (polyline click)
// ────────────────────────────────────────────────────────────────────

/**
 * Insert a new waypoint into an existing segment at a clicked position.
 * @param {number} segIdx — segment index that was clicked
 * @param {number} lat
 * @param {number} lon
 */
export async function onBuilderInsertWaypoint(segIdx, lat, lon) {
  if (!_active || _pending) return

  saveSnapshot()

  const origSeg = _segments[segIdx]
  const prevWp = _waypoints[segIdx]
  const nextWp = _waypoints[segIdx + 1]

  // Insert waypoint
  _waypoints.splice(segIdx + 1, 0, { lat, lon })
  // Remove the clicked segment — we'll replace it with two
  _segments.splice(segIdx, 1)

  if (origSeg.type === 'routed') {
    _pending = true
    _setStatus('Routing\u2026')
    _notify()
    try {
      const [r1, r2] = await Promise.all([
        valhallaSegment(prevWp.lat, prevWp.lon, lat, lon, _profile),
        valhallaSegment(lat, lon, nextWp.lat, nextWp.lon, _profile),
      ])
      _segments.splice(segIdx, 0,
        { type: 'routed', points: r1.coords, dist: r1.dist },
        { type: 'routed', points: r2.coords, dist: r2.dist },
      )
    } catch {
      const d1 = haversine(prevWp.lat, prevWp.lon, lat, lon)
      const d2 = haversine(lat, lon, nextWp.lat, nextWp.lon)
      _segments.splice(segIdx, 0,
        { type: 'manual', points: [[prevWp.lat, prevWp.lon], [lat, lon]], dist: d1 },
        { type: 'manual', points: [[lat, lon], [nextWp.lat, nextWp.lon]], dist: d2 },
      )
    }
    _pending = false
  } else {
    const d1 = haversine(prevWp.lat, prevWp.lon, lat, lon)
    const d2 = haversine(lat, lon, nextWp.lat, nextWp.lon)
    _segments.splice(segIdx, 0,
      { type: 'manual', points: [[prevWp.lat, prevWp.lon], [lat, lon]], dist: d1 },
      { type: 'manual', points: [[lat, lon], [nextWp.lat, nextWp.lon]], dist: d2 },
    )
  }

  _setStatus(null)
  _notify()
}

// ────────────────────────────────────────────────────────────────────
// Finish — export to pipeline
// ────────────────────────────────────────────────────────────────────

/**
 * Merge all segments and build a minimal ST.gpx object for the pipeline.
 * Calls exitBuilderMode() — caller should then navigate to the desired step.
 *
 * @returns {{ lats: number[], lons: number[], eles: number[], dists: Float64Array } | null}
 */
export function finishRouteBuilder() {
  if (!_active || _segments.length === 0) return null

  // Concatenate all segment points, deduplicating junctions
  const merged = mergeSegments(_segments.map(s => s.points))
  const rawDists = cumulativeDistances(merged.lats, merged.lons)

  // Resample to 3m uniform spacing so LIDAR gets consistent density
  // regardless of what Valhalla returned (5–30m variable spacing).
  const resampled = resampleRoute(merged.lats, merged.lons, rawDists, 3)
  const lats = resampled.lats
  const lons = resampled.lons
  const eles = new Array(lats.length).fill(0)
  const distsF64 = new Float64Array(resampled.dists)

  exitBuilderMode()

  return { lats, lons, eles, dists: distsF64 }
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

function _notify() {
  if (_onUpdate) _onUpdate()
}

function _setStatus(msg) {
  if (_onStatusChange) _onStatusChange(msg || '')
}
