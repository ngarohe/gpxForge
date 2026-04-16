/**
 * Chart orchestrator — initializes canvases, subscribes
 * to sync events, and provides drawAll / zoomToCorr entry points.
 */

import { ST } from '../state.js'
import { subscribe, setView, resetView as syncResetView } from '../sync.js'
import { buildColors, clearSmoothColors } from './shared.js'
import { drawElevation, initElevation } from './elevation.js'
import { drawGradient, initGradient } from './gradient.js'

let _cvMain = null
let _cvGrad = null
let _resizeTimer = null

// ────────────────────────────────────────────────────────────────────
// Draw all
// ────────────────────────────────────────────────────────────────────

/** Redraw chart canvases. */
export function drawAll() {
  if (_cvMain) drawElevation(_cvMain)
  if (_cvGrad) drawGradient(_cvGrad)
}

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
  }

  // Wire up mouse events on each canvas
  initElevation(_cvMain, actions)
  if (_cvGrad) initGradient(_cvGrad, actions)

  // Subscribe to sync events — redraw on viewport/cursor changes
  subscribe('viewport', drawAll)
  subscribe('cursor', drawAll)

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

/** Zoom viewport to show a span {alo, ahi} with 80% padding. */
function zoomToSpan(item) {
  if (!item || !ST.dists) return
  const total = ST.dists[ST.dists.length - 1]
  if (total <= 0) return
  const pad = Math.max(
    (ST.dists[item.ahi] - ST.dists[item.alo]) * 0.8,
    total * 0.01,
  )
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

/** Reset viewport to show the full route. */
export function resetView() {
  syncResetView()
}

// Re-export color cache functions for pipeline use
export { buildColors, clearSmoothColors }
