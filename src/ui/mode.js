/**
 * UI mode (Simple / Expert) — persistence + body.dataset.mode wiring.
 *
 * Simple = minimal controls, auto-pipeline on bulk/create.
 * Expert = step tabs + per-step panels, manual pipeline.
 *
 * Source of truth: ST.mode. Persisted to localStorage. URL ?mode= overrides
 * the stored value for the current session.
 */

import { ST } from '../state.js'

const KEY = 'gpxforge.mode'
const VALID = new Set(['simple', 'expert'])

function readStoredMode() {
  try {
    const v = localStorage.getItem(KEY)
    return VALID.has(v) ? v : null
  } catch {
    return null
  }
}

function writeStoredMode(mode) {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // ignore (private mode, quota, etc.) — session still works
  }
}

function readUrlMode() {
  try {
    const v = new URLSearchParams(location.search).get('mode')
    return VALID.has(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Resolve the initial mode: URL override → stored preference → 'expert'.
 * Writes the result to ST.mode and body.dataset.mode.
 */
export function initMode() {
  const mode = readUrlMode() || readStoredMode() || 'expert'
  ST.mode = mode
  if (typeof document !== 'undefined' && document.body) {
    document.body.dataset.mode = mode
  }
  return mode
}

/**
 * Switch modes. Persists to localStorage and updates body.dataset.mode.
 * Callers are responsible for re-rendering UI affected by mode.
 */
export function setMode(mode) {
  if (!VALID.has(mode)) return ST.mode
  ST.mode = mode
  writeStoredMode(mode)
  if (typeof document !== 'undefined' && document.body) {
    document.body.dataset.mode = mode
  }
  return mode
}

export function getMode() {
  return ST.mode
}
