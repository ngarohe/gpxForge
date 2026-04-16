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
  // Trim redo branch
  if (ST.simplifyIdx < ST.simplifyStack.length - 1) {
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
