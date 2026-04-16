/**
 * View synchronization — viewport + cursor pub/sub.
 *
 * View-agnostic: chart, map, and 3D modules all import this module
 * independently. Any view can publish zoom/pan/cursor changes, and
 * all subscribers are notified synchronously.
 *
 * Viewport state lives on ST (viewStart, viewEnd — fractions 0–1).
 * Cursor state lives on ST (hoverIdx, hoverDistM).
 */

import { ST } from './state.js'
import { clamp } from './utils/math.js'

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

export const MIN_ZOOM_FRAC = 0.002

// ────────────────────────────────────────────────────────────────────
// Subscriber registry
// ────────────────────────────────────────────────────────────────────

const subs = { viewport: [], cursor: [] }

/**
 * Subscribe to a sync channel.
 * @param {'viewport'|'cursor'} channel
 * @param {Function} fn — called after state change
 * @returns {Function} unsubscribe function
 */
export function subscribe(channel, fn) {
  subs[channel].push(fn)
  return () => {
    const idx = subs[channel].indexOf(fn)
    if (idx >= 0) subs[channel].splice(idx, 1)
  }
}

function emit(channel) {
  for (const fn of subs[channel]) fn()
}

// ────────────────────────────────────────────────────────────────────
// Viewport
// ────────────────────────────────────────────────────────────────────

/** Clamp viewStart/viewEnd to valid bounds. */
export function clampView() {
  const span = ST.viewEnd - ST.viewStart
  if (ST.viewStart < 0) {
    ST.viewStart = 0
    ST.viewEnd = Math.min(1, span)
  }
  if (ST.viewEnd > 1) {
    ST.viewEnd = 1
    ST.viewStart = Math.max(0, 1 - span)
  }
}

/**
 * Get the current viewport in metres.
 * @returns {{ lo: number, hi: number, total: number }}
 */
export function getViewRange() {
  if (!ST.dists || ST.dists.length === 0) return { lo: 0, hi: 0, total: 0 }
  const total = ST.dists[ST.dists.length - 1]
  return { lo: ST.viewStart * total, hi: ST.viewEnd * total, total }
}

/**
 * Cursor-locked zoom. The point under the cursor stays fixed on screen.
 * @param {number} cursorFrac — cursor position as fraction of viewport [0, 1]
 * @param {number} factor — >1 zooms out, <1 zooms in (e.g., 1.25 or 0.8)
 */
export function zoom(cursorFrac, factor) {
  // cursorFrac is the position within the viewport where the mouse is
  const cursorPos = ST.viewStart + clamp(cursorFrac, 0, 1) * (ST.viewEnd - ST.viewStart)
  let span = (ST.viewEnd - ST.viewStart) * factor
  span = clamp(span, MIN_ZOOM_FRAC, 1)
  ST.viewStart = cursorPos - cursorFrac * span
  ST.viewEnd = ST.viewStart + span
  clampView()
  emit('viewport')
}

/**
 * Pan the viewport by a fraction delta.
 * @param {number} deltaFrac — positive pans right
 */
export function pan(deltaFrac) {
  const span = ST.viewEnd - ST.viewStart
  ST.viewStart += deltaFrac
  ST.viewEnd = ST.viewStart + span
  clampView()
  emit('viewport')
}

/**
 * Set the viewport directly.
 * @param {number} start — fraction [0, 1)
 * @param {number} end — fraction (0, 1]
 */
export function setView(start, end) {
  ST.viewStart = clamp(start, 0, 1)
  ST.viewEnd = clamp(end, 0, 1)
  if (ST.viewEnd - ST.viewStart < MIN_ZOOM_FRAC) {
    ST.viewEnd = Math.min(1, ST.viewStart + MIN_ZOOM_FRAC)
  }
  clampView()
  emit('viewport')
}

/** Reset viewport to show the full route. */
export function resetView() {
  ST.viewStart = 0
  ST.viewEnd = 1
  emit('viewport')
}

// ────────────────────────────────────────────────────────────────────
// Cursor
// ────────────────────────────────────────────────────────────────────

/**
 * Set the cursor (hover) position.
 * @param {number} idx — index into route arrays
 * @param {number} distM — distance in metres
 */
export function setCursor(idx, distM) {
  ST.hoverIdx = idx
  ST.hoverDistM = distM
  emit('cursor')
}

/** Clear the cursor. */
export function clearCursor() {
  ST.hoverIdx = null
  ST.hoverDistM = null
  emit('cursor')
}

/**
 * Get current cursor position.
 * @returns {{ idx: number, distM: number } | null}
 */
export function getCursor() {
  if (ST.hoverIdx == null) return null
  return { idx: ST.hoverIdx, distM: ST.hoverDistM }
}
