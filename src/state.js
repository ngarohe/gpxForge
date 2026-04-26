/**
 * Global application state and undo/redo history.
 *
 * ST is the single source of truth. All pipeline steps and UI modules
 * import and mutate it directly. No reactive framework — UI updates
 * must be called explicitly after state changes.
 */

import { grads } from './utils/math.js'

// ────────────────────────────────────────────────────────────────────
// Global state
// ────────────────────────────────────────────────────────────────────

export const ST = {
  gpx: null,           // { lats, lons, eles, dists, doc, ns, pts, rawXml }
  dists: null,         // Float64Array — cumulative distances (metres)
  grOrig: null,        // original gradients (%)
  eleClean: null,      // cleaned elevations
  grClean: null,       // cleaned gradients
  eleSmoothed: null,   // smoothed elevations
  grSmoothed: null,    // smoothed gradients
  smoothedRoute: null,   // { lats, lons, eles, dists, gr } — processGPX result (different point count)
  brunnels: null,      // Array of located bridge/tunnel objects
  corrections: null,   // Array<{ alo, ahi, span, grade, type, interp, ... }>
  splitAnalysis: null,  // timing analysis result from analyzeRoute()
  splitSegments: null,  // generated split segments from generateSplits()
  trimMarkerA: null,    // { idx, lat, lon, dist } — first trim marker
  trimMarkerB: null,    // { idx, lat, lon, dist } — second trim marker
  trimHistory: [],      // trim undo stack: [{ gpx, dists, grOrig, eleClean, grClean }]
  trimJoins: [],        // indices where mid-trims joined — forced as snap waypoints
  routeWaypoints: [],   // [{ lat, lon }] — snap waypoint positions (for display + drag)
  routeSegments: [],    // [[lat,lon][], ...] — OSRM segment results
  snapPreState: null,   // full state snapshot for snap revert
  snapDragHistory: [],  // stack of route snapshots for polyline drag undo
  snapWaypoints: [],    // [{ lat, lon }] — persistent waypoint positions across drag operations
  origAvgSpacing: 1,   // average point spacing (m) of the loaded GPX — used for adaptive smoothing
  filename: '',        // loaded GPX filename
  hover: null,         // current hovered point index
  selectedCorr: null,  // index of selected correction
  activeStep: null,    // current pipeline step id ('trim'|'snap'|...|null)
  stepStatus: {},      // per-step status: { trim: 'none'|'done'|'warn', ... }
  dragState: null,     // active drag operation
  drawMode: false,     // freehand draw mode active
  drawAnchor1: null,   // first anchor for draw mode
  drawCursorIdx: null, // cursor index during draw
  // Viewport (fractions 0–1, synced across all views via sync.js)
  viewStart: 0,        // viewport start fraction [0, 1)
  viewEnd: 1,          // viewport end fraction (0, 1]
  // Cursor (synced across all views via sync.js)
  hoverIdx: null,      // hovered point index (or null)
  hoverDistM: null,    // hovered distance in metres (or null)
  // Internal rendering state
  _anchorHandles: [],  // elevation chart anchor hit targets
  history: [],         // undo/redo snapshots
  historyIdx: -1,      // current position in history
  simplifyStack: [],   // simplify undo: array of smoothedRoute snapshots
  simplifyIdx: -1,     // current position in simplify stack
  lidarSource: '',     // route-level source tag from backend
  lidarSources: {},    // per-source point counts from backend
  mode: 'expert',      // UI mode: 'simple' | 'expert' (see ui/mode.js)
}

// ────────────────────────────────────────────────────────────────────
// Undo / Redo
// ────────────────────────────────────────────────────────────────────

const MAX_HISTORY = 30

function snapshotState(type = 'clean') {
  return {
    type,
    eleClean: [...ST.eleClean],
    corrections: ST.corrections.map(c => ({ ...c })),
    selectedCorr: ST.selectedCorr,
  }
}

/**
 * Restore a history snapshot into ST.
 * Caller is responsible for triggering UI updates after this.
 * @param {object} snap — snapshot from snapshotState()
 * @param {object} [callbacks] — optional { onRestore } for UI refresh
 */
function restoreSnapshot(snap, callbacks) {
  ST.eleClean = [...snap.eleClean]
  ST.corrections = snap.corrections.map(c => ({ ...c }))
  ST.selectedCorr = snap.selectedCorr
  ST.grClean = grads(ST.eleClean, ST.dists)
  // Invalidate smoothing since base data changed
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.smoothedRoute = null
  if (callbacks?.onRestore) callbacks.onRestore()
}

/**
 * Push current state onto the undo stack.
 * Call this BEFORE making changes so the user can undo back to this point.
 * @param {string} [type='clean'] — snapshot type ('clean' or 'trim')
 */
export function pushHistory(type = 'clean') {
  if (!ST.eleClean || !ST.corrections) return
  // Trim redo branch
  if (ST.historyIdx < ST.history.length - 1) {
    ST.history.splice(ST.historyIdx + 1)
  }
  ST.history.push(snapshotState(type))
  if (ST.history.length > MAX_HISTORY) ST.history.shift()
  ST.historyIdx = ST.history.length - 1
}

/**
 * Undo one step.
 * @param {object} [callbacks] — optional { onRestore } for UI refresh
 */
export function performUndo(callbacks) {
  if (ST.historyIdx <= 0) return
  ST.historyIdx--
  restoreSnapshot(ST.history[ST.historyIdx], callbacks)
}

/**
 * Redo one step.
 * @param {object} [callbacks] — optional { onRestore } for UI refresh
 */
export function performRedo(callbacks) {
  if (ST.historyIdx >= ST.history.length - 1) return
  ST.historyIdx++
  restoreSnapshot(ST.history[ST.historyIdx], callbacks)
}

/** @returns {boolean} whether undo is available */
export function canUndo() {
  return ST.historyIdx > 0
}

/** @returns {boolean} whether redo is available */
export function canRedo() {
  return ST.historyIdx < ST.history.length - 1
}

// ────────────────────────────────────────────────────────────────────
// Simplify undo / redo (separate stack for smooth step)
// ────────────────────────────────────────────────────────────────────
//
// Model: simplifyStack stores complete smoothedRoute states.
//   [0] = Process result (baseline), [1] = after 1st simplify, ...
// simplifyIdx = index of the CURRENT state in the stack.
// Undo: go to simplifyIdx - 1.  Redo: go to simplifyIdx + 1.
// canUndo: simplifyIdx > 0.  canRedo: simplifyIdx < stack.length - 1.

function snapshotSmoothed() {
  const r = ST.smoothedRoute
  return {
    smoothedRoute: {
      lats: [...r.lats],
      lons: [...r.lons],
      eles: [...r.eles],
      dists: new Float64Array(r.dists),
      gr: new Float64Array(r.gr),
      ...(r.origDists ? { origDists: new Float64Array(r.origDists) } : {}),
    },
    eleSmoothed: [...ST.eleSmoothed],
    grSmoothed: new Float64Array(ST.grSmoothed),
  }
}

function restoreSmoothed(snap, callbacks) {
  ST.smoothedRoute = {
    lats: [...snap.smoothedRoute.lats],
    lons: [...snap.smoothedRoute.lons],
    eles: [...snap.smoothedRoute.eles],
    dists: new Float64Array(snap.smoothedRoute.dists),
    gr: new Float64Array(snap.smoothedRoute.gr),
    ...(snap.smoothedRoute.origDists ? { origDists: new Float64Array(snap.smoothedRoute.origDists) } : {}),
  }
  ST.eleSmoothed = [...snap.eleSmoothed]
  ST.grSmoothed = new Float64Array(snap.grSmoothed)
  if (callbacks?.onRestore) callbacks.onRestore()
}

/**
 * Push current smoothedRoute as a new state. Call AFTER simplifying.
 * On first call, also pushes the Process baseline as entry [0].
 * @param {object} [processBaseline] — if provided, pushed as entry [0] before the new state
 */
export function pushSimplifyState(processBaseline) {
  if (!ST.smoothedRoute) return
  // First simplify: push baseline (Process result) as entry [0]
  if (ST.simplifyStack.length === 0 && processBaseline) {
    ST.simplifyStack.push(processBaseline)
  }
  // Trim redo branch (only when idx is valid — idx -1 means fresh/cleared, nothing to trim)
  if (ST.simplifyIdx >= 0 && ST.simplifyIdx < ST.simplifyStack.length - 1) {
    ST.simplifyStack.splice(ST.simplifyIdx + 1)
  }
  ST.simplifyStack.push(snapshotSmoothed())
  ST.simplifyIdx = ST.simplifyStack.length - 1
}

/** Undo one simplify pass. */
export function undoSimplify(callbacks) {
  if (ST.simplifyIdx <= 0) return
  ST.simplifyIdx--
  restoreSmoothed(ST.simplifyStack[ST.simplifyIdx], callbacks)
}

/** Redo one simplify pass. */
export function redoSimplify(callbacks) {
  if (ST.simplifyIdx >= ST.simplifyStack.length - 1) return
  ST.simplifyIdx++
  restoreSmoothed(ST.simplifyStack[ST.simplifyIdx], callbacks)
}

/** @returns {boolean} */
export function canUndoSimplify() {
  return ST.simplifyIdx > 0
}

/** @returns {boolean} */
export function canRedoSimplify() {
  return ST.simplifyIdx < ST.simplifyStack.length - 1
}

/** Clear simplify history (call on Process, Revert, or upstream undo). */
export function clearSimplifyHistory() {
  ST.simplifyStack = []
  ST.simplifyIdx = -1
}

// ────────────────────────────────────────────────────────────────────
// Full-ST snapshot / restore (park-to-queue)
// ────────────────────────────────────────────────────────────────────

function cloneSmoothedRoute(r) {
  if (!r) return null
  return {
    lats: [...r.lats],
    lons: [...r.lons],
    eles: [...r.eles],
    dists: new Float64Array(r.dists),
    gr: new Float64Array(r.gr),
    ...(r.origDists ? { origDists: new Float64Array(r.origDists) } : {}),
  }
}

function cloneGpx(g) {
  if (!g) return null
  return {
    lats: g.lats ? [...g.lats] : null,
    lons: g.lons ? [...g.lons] : null,
    eles: g.eles ? [...g.eles] : null,
    dists: clone1D(g.dists),
  }
}

// Deep-clone a 1D numeric array, preserving Float64Array vs plain Array.
// Callers in the pipeline produce both (parseGPX/grads → plain Array;
// cumulativeDistances/clean rebuilds → Float64Array), so the snapshot must
// round-trip either type without silently dropping to null.
function clone1D(arr) {
  if (arr == null) return null
  if (arr instanceof Float64Array) return new Float64Array(arr)
  if (Array.isArray(arr)) return [...arr]
  return null
}

/**
 * Capture a deep-cloned snapshot of the full pipeline-relevant ST.
 * Used by "Park to queue" to suspend single-file work in progress.
 * Interaction state (hover, drag, draw, selection, viewport) is NOT saved.
 * @returns {object}
 */
export function snapshotST() {
  return {
    gpx: cloneGpx(ST.gpx),
    dists: clone1D(ST.dists),
    grOrig: clone1D(ST.grOrig),
    eleClean: ST.eleClean ? [...ST.eleClean] : null,
    grClean: clone1D(ST.grClean),
    eleSmoothed: ST.eleSmoothed ? [...ST.eleSmoothed] : null,
    grSmoothed: clone1D(ST.grSmoothed),
    smoothedRoute: cloneSmoothedRoute(ST.smoothedRoute),
    brunnels: ST.brunnels ? ST.brunnels.map(b => ({ ...b })) : null,
    corrections: ST.corrections ? ST.corrections.map(c => ({ ...c })) : [],
    splitAnalysis: ST.splitAnalysis || null,
    splitSegments: ST.splitSegments || null,
    trimMarkerA: ST.trimMarkerA ? { ...ST.trimMarkerA } : null,
    trimMarkerB: ST.trimMarkerB ? { ...ST.trimMarkerB } : null,
    trimJoins: [...(ST.trimJoins || [])],
    routeWaypoints: (ST.routeWaypoints || []).map(w => ({ ...w })),
    routeSegments: (ST.routeSegments || []).map(s => s.map(p => [...p])),
    snapWaypoints: (ST.snapWaypoints || []).map(w => ({ ...w })),
    filename: ST.filename || '',
    activeStep: ST.activeStep || null,
    stepStatus: { ...(ST.stepStatus || {}) },
    history: [...(ST.history || [])],
    historyIdx: ST.historyIdx ?? -1,
    simplifyStack: [...(ST.simplifyStack || [])],
    simplifyIdx: ST.simplifyIdx ?? -1,
    origAvgSpacing: ST.origAvgSpacing ?? 1,
    lidarSource: ST.lidarSource || '',
    lidarSources: { ...(ST.lidarSources || {}) },
  }
}

/**
 * Restore ST from a snapshot captured by snapshotST().
 * Interaction state is reset to defaults (not restored).
 */
export function restoreST(snap) {
  ST.gpx = cloneGpx(snap.gpx)
  ST.dists = clone1D(snap.dists)
  ST.grOrig = clone1D(snap.grOrig)
  ST.eleClean = snap.eleClean ? [...snap.eleClean] : null
  ST.grClean = clone1D(snap.grClean)
  ST.eleSmoothed = snap.eleSmoothed ? [...snap.eleSmoothed] : null
  ST.grSmoothed = clone1D(snap.grSmoothed)
  ST.smoothedRoute = cloneSmoothedRoute(snap.smoothedRoute)
  ST.brunnels = snap.brunnels ? snap.brunnels.map(b => ({ ...b })) : null
  ST.corrections = snap.corrections ? snap.corrections.map(c => ({ ...c })) : []
  ST.splitAnalysis = snap.splitAnalysis || null
  ST.splitSegments = snap.splitSegments || null
  ST.trimMarkerA = snap.trimMarkerA ? { ...snap.trimMarkerA } : null
  ST.trimMarkerB = snap.trimMarkerB ? { ...snap.trimMarkerB } : null
  ST.trimJoins = [...(snap.trimJoins || [])]
  ST.routeWaypoints = (snap.routeWaypoints || []).map(w => ({ ...w }))
  ST.routeSegments = (snap.routeSegments || []).map(s => s.map(p => [...p]))
  ST.snapWaypoints = (snap.snapWaypoints || []).map(w => ({ ...w }))
  ST.filename = snap.filename || ''
  ST.activeStep = snap.activeStep || null
  ST.stepStatus = { ...(snap.stepStatus || {}) }
  ST.history = [...(snap.history || [])]
  ST.historyIdx = snap.historyIdx ?? -1
  ST.simplifyStack = [...(snap.simplifyStack || [])]
  ST.simplifyIdx = snap.simplifyIdx ?? -1
  ST.origAvgSpacing = snap.origAvgSpacing ?? 1
  ST.lidarSource = snap.lidarSource || ''
  ST.lidarSources = { ...(snap.lidarSources || {}) }
  // Reset transient interaction state — never restored
  ST.selectedCorr = null
  ST.hoverIdx = null
  ST.hoverDistM = null
  ST.drawMode = false
  ST.drawAnchor1 = null
  ST.drawCursorIdx = null
  ST.dragState = null
  ST.viewStart = 0
  ST.viewEnd = 1
  ST._anchorHandles = []
}

/**
 * Reset ST to an empty/unloaded state (as if no GPX had been loaded).
 * Keeps user preferences (mode). Used after parking to clear the working area.
 */
export function clearST() {
  ST.gpx = null
  ST.dists = null
  ST.grOrig = null
  ST.eleClean = null
  ST.grClean = null
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.smoothedRoute = null
  ST.brunnels = null
  ST.corrections = null
  ST.splitAnalysis = null
  ST.splitSegments = null
  ST.trimMarkerA = null
  ST.trimMarkerB = null
  ST.trimHistory = []
  ST.trimJoins = []
  ST.routeWaypoints = []
  ST.routeSegments = []
  ST.snapPreState = null
  ST.snapDragHistory = []
  ST.snapWaypoints = []
  ST.origAvgSpacing = 1
  ST.filename = ''
  ST.selectedCorr = null
  ST.activeStep = null
  ST.stepStatus = {}
  ST.dragState = null
  ST.drawMode = false
  ST.drawAnchor1 = null
  ST.drawCursorIdx = null
  ST.viewStart = 0
  ST.viewEnd = 1
  ST.hoverIdx = null
  ST.hoverDistM = null
  ST._anchorHandles = []
  ST.history = []
  ST.historyIdx = -1
  ST.simplifyStack = []
  ST.simplifyIdx = -1
  ST.lidarSource = ''
  ST.lidarSources = {}
}
