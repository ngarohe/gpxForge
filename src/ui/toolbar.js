/**
 * Toolbar — undo/redo/download buttons + keyboard shortcuts.
 *
 * Creates button elements inside the provided container.
 * Exposes updateButtons() to sync disabled state with undo/redo availability.
 */

import { ST } from '../state.js'
import { canUndo, canRedo, canUndoSimplify, canRedoSimplify } from '../state.js'
import { serializeGPX, downloadGPX } from '../utils/gpx.js'
import { buildDownloadFilename } from '../utils/download-name.js'

// ────────────────────────────────────────────────────────────────────
// Module state
// ────────────────────────────────────────────────────────────────────

let _undoBtn = null
let _redoBtn = null
let _dlBtn = null
let _lidarBtn = null
let _createRouteBtn = null
let _parkBtn = null
let _actions = null

// ────────────────────────────────────────────────────────────────────
// DOM helpers
// ────────────────────────────────────────────────────────────────────

function btn(cls, text) {
  const b = document.createElement('button')
  b.className = cls
  b.textContent = text
  return b
}

// ────────────────────────────────────────────────────────────────────
// Download logic
// ────────────────────────────────────────────────────────────────────

const DOWNLOAD_SUFFIXES = {
  trim: '_trimmed',
  snap: '_snapped',
  brunnels: '_brunnels',
  clean: '_cleaned',
  smooth: '_smoothed',
  split: '_split',
}

/**
 * Get the best available elevation array for download based on active step.
 * Follows the three-tier fallback chain: smoothed → cleaned → original.
 */
function getDownloadEles() {
  switch (ST.activeStep) {
    case 'smooth':
    case 'split':
      return ST.eleSmoothed || ST.eleClean || ST.gpx.eles
    case 'clean':
      return ST.eleClean || ST.gpx.eles
    default:
      return ST.eleClean || ST.gpx.eles
  }
}

async function doDownload() {
  if (!ST.gpx) return

  // Warn about unreviewed suspects
  const pending = (ST.corrections || []).filter(c =>
    c.type === 'suspect' && !c.accepted && !c.rejected
  )
  if (pending.length) {
    console.warn(`[GPXForge] \u26A0 ${pending.length} unreviewed suspect(s) in export`)
  }

  const eles = getDownloadEles()
  const suffix = DOWNLOAD_SUFFIXES[ST.activeStep] || '_cleaned'
  // Use smoothed route's coordinates when downloading from smooth/split steps
  const useSmoothed = (ST.activeStep === 'smooth' || ST.activeStep === 'split') && ST.smoothedRoute
  const lats = useSmoothed ? ST.smoothedRoute.lats : ST.gpx.lats
  const lons = useSmoothed ? ST.smoothedRoute.lons : ST.gpx.lons
  const gpxString = serializeGPX(ST.gpx, eles, lats, lons)

  try {
    if (_dlBtn) {
      _dlBtn.disabled = true
      _dlBtn.textContent = '⏳ Naming…'
    }
    const fallbackBaseName = ST.filename.replace(/\.gpx$/i, '') || 'route'
    const filename = await buildDownloadFilename({
      startLat: lats[0],
      startLon: lons[0],
      endLat: lats[lats.length - 1],
      endLon: lons[lons.length - 1],
      fallbackBaseName,
      suffix,
    })

    downloadGPX(gpxString, filename)
    console.log(`[GPXForge] Downloaded: ${filename}`)
    if (_actions?.onDownloaded) _actions.onDownloaded(filename)
  } finally {
    if (_dlBtn) {
      _dlBtn.textContent = '⬇ Download'
      updateButtons()
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Button state
// ────────────────────────────────────────────────────────────────────

function updateButtons() {
  if (!_undoBtn) return

  const onSmooth = ST.activeStep === 'smooth'
  const sUndoAvail = onSmooth && canUndoSimplify()
  const sRedoAvail = onSmooth && canRedoSimplify()
  const undoAvail = sUndoAvail || canUndo()
  const redoAvail = sRedoAvail || canRedo()

  _undoBtn.disabled = !undoAvail
  _redoBtn.disabled = !redoAvail
  _dlBtn.disabled = !ST.gpx
  if (_lidarBtn && !_lidarBtn._busy) _lidarBtn.disabled = !ST.gpx
  if (_parkBtn) {
    const canPark = _actions?.canPark ? _actions.canPark() : false
    _parkBtn.style.display = canPark ? '' : 'none'
  }

  // Update download button title based on active step
  const suffix = DOWNLOAD_SUFFIXES[ST.activeStep] || '_cleaned'
  _dlBtn.title = `Download ${suffix.replace('_', '')} GPX`

  // Update titles — simplify undo takes precedence when on smooth step
  if (sUndoAvail) {
    const steps = ST.simplifyIdx
    _undoBtn.title = `Undo simplify (${steps} pass${steps !== 1 ? 'es' : ''}) \u00B7 Ctrl+Z`
  } else {
    const undoSteps = ST.historyIdx
    _undoBtn.title = canUndo()
      ? `Undo clean edit (${undoSteps} step${undoSteps !== 1 ? 's' : ''}) \u00B7 Ctrl+Z`
      : 'Undo clean edit \u00B7 Ctrl+Z'
  }
  if (sRedoAvail) {
    const steps = ST.simplifyStack.length - 1 - ST.simplifyIdx
    _redoBtn.title = `Redo simplify (${steps} pass${steps !== 1 ? 'es' : ''}) \u00B7 Ctrl+Y`
  } else {
    const redoSteps = ST.history.length - 1 - ST.historyIdx
    _redoBtn.title = canRedo()
      ? `Redo clean edit (${redoSteps} step${redoSteps !== 1 ? 's' : ''}) \u00B7 Ctrl+Y`
      : 'Redo clean edit \u00B7 Ctrl+Y'
  }
}

// ────────────────────────────────────────────────────────────────────
// Keyboard shortcuts
// ────────────────────────────────────────────────────────────────────

function setupKeyboard(actions) {
  document.addEventListener('keydown', (ev) => {
    // Skip when focus is in an input field
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return

    const mod = ev.ctrlKey || ev.metaKey

    // Ctrl+Z / Cmd+Z — undo
    if (mod && ev.key === 'z' && !ev.shiftKey) {
      ev.preventDefault()
      actions.onUndo()
      return
    }

    // Ctrl+Y / Cmd+Y or Ctrl+Shift+Z / Cmd+Shift+Z — redo
    if (mod && (ev.key === 'y' || (ev.key === 'z' && ev.shiftKey) || (ev.key === 'Z'))) {
      ev.preventDefault()
      actions.onRedo()
      return
    }

    // S — open Google Street View at hovered point (works from chart or map)
    if ((ev.key === 's' || ev.key === 'S') && !mod) {
      openStreetView()
      return
    }
  })
}

// ────────────────────────────────────────────────────────────────────
// Google Street View
// ────────────────────────────────────────────────────────────────────

/**
 * Open Google Street View at the currently hovered point.
 * Works from both the elevation chart and the map — both set ST.hoverIdx.
 */
function openStreetView() {
  if (!ST.gpx || ST.hoverIdx == null) return
  const lat = ST.gpx.lats[ST.hoverIdx]
  const lon = ST.gpx.lons[ST.hoverIdx]
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`
  window.open(url, '_blank')
  console.log(`[GPXForge] Street View: ${lat.toFixed(6)}, ${lon.toFixed(6)}`)
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Initialize the toolbar inside the given container.
 * @param {HTMLElement} container — the .tb-actions element from shell
 * @param {{ onUndo: Function, onRedo: Function, onDownload?: Function }} actions
 * @returns {{ updateButtons: Function }}
 */
export function initToolbar(container, actions) {
  _actions = actions

  // Create buttons
  _undoBtn = btn('tool-btn tool-btn--undo', '\u21A9 Undo')
  _undoBtn.title = 'Undo clean edit \u00B7 Ctrl+Z'
  _undoBtn.disabled = true
  _undoBtn.addEventListener('click', () => actions.onUndo())

  _redoBtn = btn('tool-btn tool-btn--redo', '\u21AA Redo')
  _redoBtn.title = 'Redo clean edit \u00B7 Ctrl+Y'
  _redoBtn.disabled = true
  _redoBtn.addEventListener('click', () => actions.onRedo())

  _dlBtn = btn('btn-download', '\u2B07 Download')
  _dlBtn.title = 'Download cleaned GPX'
  _dlBtn.disabled = true
  _dlBtn.addEventListener('click', () => {
    if (actions.onDownload) actions.onDownload()
    else doDownload()
  })

  _lidarBtn = btn('tool-btn tool-btn--lidar', '\uD83D\uDEF0 LIDAR')
  _lidarBtn.title = 'Fetch hi-res LIDAR elevation from the configured GPXForge server'
  _lidarBtn.disabled = true
  _lidarBtn.addEventListener('click', () => {
    if (actions.onLidar) actions.onLidar()
  })

  _createRouteBtn = btn('tool-btn tool-btn--create-route', '\u270F Create Route')
  _createRouteBtn.title = 'Create a new route from scratch by clicking waypoints on the map'
  _createRouteBtn.addEventListener('click', () => {
    if (actions.onCreateRoute) actions.onCreateRoute()
  })

  _parkBtn = btn('tool-btn tool-btn--park', '\uD83C\uDD7F Park')
  _parkBtn.title = 'Park this route to the queue so you can start another. Resume from the queue panel anytime.'
  _parkBtn.style.display = 'none'
  _parkBtn.addEventListener('click', () => {
    if (actions.onPark) actions.onPark()
  })

  container.appendChild(_undoBtn)
  container.appendChild(_redoBtn)
  container.appendChild(_lidarBtn)
  container.appendChild(_createRouteBtn)
  container.appendChild(_parkBtn)
  container.appendChild(_dlBtn)

  // Wire keyboard shortcuts
  setupKeyboard(actions)

  return {
    updateButtons,
    setLidarBusy(busy) {
      if (!_lidarBtn) return
      _lidarBtn._busy = busy
      _lidarBtn.disabled = busy
      _lidarBtn.classList.toggle('busy', busy)
      _lidarBtn.textContent = busy ? 'LIDAR\u2026' : '\uD83D\uDEF0 LIDAR'
    },
    setCreateRouteActive(active) {
      if (!_createRouteBtn) return
      _createRouteBtn.textContent = active ? '\u2715 Exit Builder' : '\u270F Create Route'
      _createRouteBtn.classList.toggle('tool-btn--active', active)
    },
  }
}
