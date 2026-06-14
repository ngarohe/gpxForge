/**
 * Chart orchestrator — initializes canvases, subscribes
 * to sync events, and provides drawAll / zoomToCorr entry points.
 */

import { ST } from '../state.js'
import { subscribe, setView, resetView as syncResetView } from '../sync.js'
import { buildColors, clearSmoothColors } from './shared.js'
import { drawElevation, drawElevationCursor, initElevation } from './elevation.js'
import { drawGradient, initGradient } from './gradient.js'

let _cvMain = null
let _cvGrad = null
let _resizeTimer = null

// ────────────────────────────────────────────────────────────────────
// Draw all
// ────────────────────────────────────────────────────────────────────

/** Redraw chart canvases (full render — for viewport/data changes). */
export function drawAll() {
  if (_cvMain) drawElevation(_cvMain)
  if (_cvGrad) drawGradient(_cvGrad)
}

/**
 * Cursor-only redraw: blit the cached static chart + draw the hover cursor.
 * Used on cursor (hover) events — avoids re-rasterizing the whole chart and
 * skips the gradient canvas entirely (it has no cursor). This is the fix for
 * post-smooth hover lag: a pointer move no longer re-renders the big fill.
 */
function drawCursorOnly() {
  if (_cvMain) drawElevationCursor(_cvMain)
}

/**
 * Coalesce redraws to one per animation frame. A full redraw (viewport/data
 * change) always takes priority over a cursor-only redraw queued in the same
 * frame, so a zoom never gets downgraded to a stale-base blit.
 */
let _rafPending = false
let _needFull = false
function flush() {
  _rafPending = false
  const full = _needFull
  _needFull = false
  if (full) drawAll()
  else drawCursorOnly()
}
function requestFrame() {
  if (_rafPending) return
  const raf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : cb => setTimeout(cb, 16)
  _rafPending = true
  raf(flush)
}
const scheduleDraw = () => { _needFull = true; requestFrame() }
const scheduleCursor = () => { requestFrame() }

// ────────────────────────────────────────────────────────────────────
// Init
// ────────────────────────────────────────────────────────────────────

/**
 * Initialize the chart system.
 *
 * @param {object} elements — DOM elements
 * @param {HTMLCanvasElement} elements.cvMain — elevation canvas
 * @param {HTMLCanvasElement} elements.cvGrad — gradient canvas
 * @param {object} [externalActions] — callbacks from UI layer
 * @param {Function} [externalActions.commitDrag] — (corrIdx, which, newIdx)
 * @param {Function} [externalActions.commitDraw] — (alo, ahi)
 * @param {Function} [externalActions.removeCorr] — (ci)
 * @param {Function} [externalActions.selectCorr] — (ci)
 * @param {Function} [externalActions.trimClick] — (idx) trim marker placed
 * @param {Function} [externalActions.editRangeSelect] — (lo, hi) Split-step edit range drag-selected
 * @param {Function} [externalActions.editPivotClick] — (frac) Split-step move-start pivot clicked
 * @param {Function} [externalActions.getShapeParams] — () => current shape params
 */
export function initChart(elements, externalActions = {}) {
  _cvMain = elements.cvMain
  _cvGrad = elements.cvGrad

  const noop = () => {}
  const actions = {
    drawAll,
    commitDrag: externalActions.commitDrag || noop,
    commitDraw: externalActions.commitDraw || noop,
    removeCorr: externalActions.removeCorr || noop,
    selectCorr: externalActions.selectCorr || noop,
    trimClick: externalActions.trimClick || noop,
    editRangeSelect: externalActions.editRangeSelect || noop,
    editPivotClick: externalActions.editPivotClick || noop,
    zNudgeStart: externalActions.zNudgeStart || noop,
    zNudgeMove: externalActions.zNudgeMove || noop,
    zNudgeWheel: externalActions.zNudgeWheel || noop,
    zNudgeEnd: externalActions.zNudgeEnd || noop,
    getShapeParams: externalActions.getShapeParams || (() => ({ smart: true, tangWin: 8, hermDev: 0.5, bridgeDip: 1.0, tunnelSpk: 1.0 })),
  }

  // Wire up mouse events on each canvas
  initElevation(_cvMain, actions)
  if (_cvGrad) initGradient(_cvGrad, actions)

  // Subscribe to sync events (coalesced to one redraw per frame):
  //  - viewport changes need a FULL re-render (re-rasterizes the chart).
  //  - cursor (hover) changes only move the cursor — blit the cached static
  //    chart + redraw the cursor, skipping the expensive fill re-raster and
  //    the gradient canvas entirely. This is the post-smooth hover-lag fix.
  subscribe('viewport', scheduleDraw)
  subscribe('cursor', scheduleCursor)

  // ResizeObserver — redraw on container resize (60ms debounce)
  if (typeof ResizeObserver === 'undefined') return
  const ro = new ResizeObserver(() => {
    if (_resizeTimer) clearTimeout(_resizeTimer)
    _resizeTimer = setTimeout(drawAll, 60)
  })
  if (_cvMain) ro.observe(_cvMain)
  if (_cvGrad) ro.observe(_cvGrad)
}

// ────────────────────────────────────────────────────────────────────
// Viewport helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Zoom viewport to show a span {alo, ahi}.
 * Pad defaults to max(80% of span, 1% of route) — fine for larger features.
 * Pass `{ padM }` for an absolute pad in metres (tight zoom on short spans of
 * long routes, where the 1%-of-route floor would otherwise blow the window out).
 */
function zoomToSpan(item, opts = {}) {
  if (!item || !ST.dists) return
  const total = ST.dists[ST.dists.length - 1]
  if (total <= 0) return
  const spanM = ST.dists[item.ahi] - ST.dists[item.alo]
  const pad = opts.padM != null
    ? opts.padM
    : Math.max(spanM * 0.8, total * 0.01)
  setView(
    Math.max(0, (ST.dists[item.alo] - pad) / total),
    Math.min(1, (ST.dists[item.ahi] + pad) / total),
  )
}

/** Zoom to a correction by index. */
export function zoomToCorr(ci) {
  zoomToSpan(ST.corrections?.[ci])
}

/** Zoom to a brunnel by index. */
export function zoomToBrunnel(bi) {
  zoomToSpan(ST.brunnels?.[bi])
}

/**
 * Zoom to a post-snap deviation suspect by index.
 * Tight, span-relative pad with a hard cap — long spans centre on the deviation
 * peak at the cap width rather than zooming out to show the whole (general) span.
 */
export function zoomToSnapSuspect(si) {
  const s = ST.snapSuspects?.[si]
  if (!s || !ST.dists) return
  const total = ST.dists[ST.dists.length - 1]
  if (total <= 0) return

  const loD = ST.dists[s.alo]
  const hiD = ST.dists[s.ahi]
  const pad = Math.min(Math.max((hiD - loD) * 0.3, 40), 150)
  let aD = loD - pad
  let bD = hiD + pad

  // Never zoom out past MAX_WIN — focus on the peak deviation instead.
  const MAX_WIN = 600
  if (bD - aD > MAX_WIN) {
    const peakD = ST.dists[s.peakIdx != null ? s.peakIdx : Math.floor((s.alo + s.ahi) / 2)]
    aD = peakD - MAX_WIN / 2
    bD = peakD + MAX_WIN / 2
  }

  setView(Math.max(0, aD / total), Math.min(1, bD / total))
}

/** Zoom to a kink (out-and-back spur) by index — fixed tight window on the spur. */
export function zoomToSnapKink(ki) {
  const k = ST.snapKinks?.[ki]
  if (!k || !ST.dists) return
  const total = ST.dists[ST.dists.length - 1]
  if (total <= 0) return
  const mid = ST.dists[k.peakIdx != null ? k.peakIdx : Math.floor((k.alo + k.ahi) / 2)]
  const half = Math.max(k.lengthM, 80) // spur length + context
  setView(Math.max(0, (mid - half) / total), Math.min(1, (mid + half) / total))
}

/** Reset viewport to show the full route. */
export function resetView() {
  syncResetView()
}

// Re-export color cache functions for pipeline use
export { buildColors, clearSmoothColors }
