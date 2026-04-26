/**
 * GPXForge — main entry point
 *
 * Boots the application: builds UI shell, wires sidebar + toolbar,
 * waits for GPX file load, then initialises chart + map.
 *
 * Phase 8d-2: wires Clean, Smooth, Split, Brunnels.
 */

import { ST, snapshotST, restoreST, clearST } from './state.js'
import { pushHistory, performUndo, performRedo,
  pushSimplifyState, undoSimplify, redoSimplify,
  canUndoSimplify, canRedoSimplify, clearSimplifyHistory } from './state.js'
import { grads, cumulativeDistances, bsearchDists, densifyRoute } from './utils/math.js'
import { fmtTimeLong } from './utils/format.js'
import { detectTrimType, executeTrim, rebuildRoute, trimGapDistance, trimSnapshot } from './pipeline/0-trim.js'
import { nearestGpxIndexForward, mergeSegments, transferElevations, autoSnap, mapWaypointsToDensified } from './pipeline/1-snap.js'
import { valhallaMulti } from './api/valhalla.js'
import { locateBrunnels, buildBrunnelCorrections, buildBrunnelMask } from './pipeline/2-brunnels.js'
import { runCleaner, applyInterp, classifyStructure } from './pipeline/3-clean.js'
import { filterVegetation, vegetationReport } from './pipeline/3.5-vegetation.js'
import { runSourceAwareDipSmoothing } from './pipeline/3.6-source-dip-smooth.js'
import { runSmoothing, runSimplify, runElevationOnlySmoothing } from './pipeline/4-smooth.js'
import { analyzeRoute, generateSplits } from './pipeline/5-split.js'
import { buildGPXString, downloadGPX, parseGPX } from './utils/gpx.js'
import { fetchLidarElevations } from './api/lidar.js'
import { searchPlaceSuggestions } from './api/place-search.js'
import { getTargetResolution, densifyForLidar, detectPrimaryCountry } from './utils/resolution.js'
import { detectStartEndOverlap } from './utils/geometry.js'
import {
  enterBuilderMode, exitBuilderMode,
  isBuilderActive, builderCanUndo, builderUndo, builderClear,
  onBuilderMapClick, onBuilderWaypointDrag, onBuilderDeleteWaypoint, onBuilderInsertWaypoint,
  finishRouteBuilder, setBuilderMode, setBuilderProfile, setBuilderRoutingFlags,
  getBuilderWaypoints, getBuilderDistance,
} from './modes/route-builder.js'
import { initChart, drawAll, buildColors, zoomToCorr, zoomToBrunnel } from './chart/index.js'
import { initMap, drawMap, mapFit, mapGoTo, mapFitBounds } from './map/index.js'
import { initShell } from './ui/shell.js'
import { initMode, setMode } from './ui/mode.js'
import { initSidebar } from './ui/sidebar.js'
import { initToolbar } from './ui/toolbar.js'
import { initPanels } from './ui/panels.js'
import { initCorrections } from './ui/corrections.js'
import { initBatchQueue, addFiles, loadEntry, saveBackFull, markReviewing, parkEntry, convertToParked, removeEntry, getQueue } from './modes/batch-pipeline.js'
import { runAutoPipeline } from './modes/auto-pipeline.js'
import { buildBatchPanel, refreshBatchPanel } from './ui/batch-ui.js'
import { showToast } from './ui/toast.js'

console.log('[GPXForge] v0.2.0 ready')

// ── Resolve UI mode before building shell ──
initMode()

// ── Build UI shell ──
const shell = initShell(onFileLoaded, onFilesLoaded, {
  onModeChange(mode) {
    setMode(mode)
    // Switching to expert with a file loaded: restore step toolbar + controls
    if (mode === 'expert' && ST.gpx) {
      shell.showStepToolbar()
      const step = ST.activeStep || 'trim'
      sidebar.setActiveStep(step)
      shell.setInfoStep(step)
      toolbar.updateButtons()
    }
    // Sync the Simple-toggle lock immediately (don't wait for next refresh)
    shell.setSimpleLocked(mode === 'expert' && !!ST.gpx)
  },
  onBeforeSingleLoad() {
    // A new single-file load is about to replace ST. Preserve any unsaved
    // work so it isn't silently destroyed.
    if (!ST.gpx) return
    const prevName = ST.filename || 'previous route'
    if (_currentBatchId) {
      // Reviewing a queue entry — save full snapshot back to it.
      saveBackFull(_currentBatchId, snapshotST())
      _currentBatchId = null
      showToast(`Saved edits to "${prevName}" in the queue`, { type: 'info' })
      refreshBatchPanel()
    } else {
      // Free-standing single-file work — auto-park it.
      doParkCurrentRoute()
      showToast(`Parked "${prevName}" — resume it from the queue panel anytime`, { type: 'info' })
    }
  },
})

// ── Wire sidebar ──
const sidebar = initSidebar(shell.getStepToolbarEl(), {
  onStepChange(stepId) {
    // Exit draw mode on step change
    ST.drawMode = false
    ST.drawAnchor1 = null
    ST.drawCursorIdx = null
    const drawBtn = panels.clean.els.btnDraw
    drawBtn.style.background = ''
    drawBtn.style.color = ''
    toolbar.updateButtons()
    // Switch to chart-featured 3-panel when entering elevation/analysis steps.
    // Trim/snap/brunnels stay in whatever focus they were in (map-featured after builder).
    if (stepId === 'clean' || stepId === 'smooth' || stepId === 'split') {
      shell.showViews()
    }
    shell.setInfoStep(stepId)
    // Update trim status text when switching to trim step
    if (stepId === 'trim' && ST.gpx) updateTrimUI()
    // Clear snap waypoints when leaving snap step (waypoints only visible on snap tab)
    if (stepId !== 'snap') {
      ST.routeWaypoints = []
      ST.routeSegments = []
      if (ST.gpx) drawMap()
    }
    if (ST.gpx) drawAll()
    console.log(`[GPXForge] Active step: ${stepId}`)
  },
})

// ── Wire toolbar ──
const toolbar = initToolbar(shell.getActionsEl(), {
  onCreateRoute() {
    if (isBuilderActive()) {
      doExitBuilderMode()
    } else {
      doEnterBuilderMode()
    }
  },
  async onLidar() {
    if (!ST.gpx) return
    // Elevation work begins — switch to chart-featured 3-panel layout.
    shell.showViews()
    toolbar.setLidarBusy(true)
    try {
      await runLidarFetch()
      refresh()
      toolbar.updateButtons()
    } catch (err) {
      const msg = err.message || String(err)
      alert(`LIDAR elevation failed:\n\n${msg}`)
      console.error('[GPXForge] LIDAR error:', err)
    } finally {
      toolbar.setLidarBusy(false)
    }
  },
  onUndo() {
    if (ST.activeStep === 'smooth' && canUndoSimplify()) {
      undoSimplify({ onRestore: onSimplifyRestore })
    } else {
      performUndo({ onRestore: onHistoryRestore })
    }
    toolbar.updateButtons()
  },
  onRedo() {
    if (ST.activeStep === 'smooth' && canRedoSimplify()) {
      redoSimplify({ onRestore: onSimplifyRestore })
    } else {
      performRedo({ onRestore: onHistoryRestore })
    }
    toolbar.updateButtons()
  },
  canPark() {
    // Park is available whenever there's a loaded route and we're not building.
    // For queue-reviewed routes, park converts the entry to parked status
    // (preserving full pipeline state).
    return !!ST.gpx && !isBuilderActive()
  },
  onPark() {
    doParkCurrentRoute()
  },
  onDownloaded() {
    // If the downloaded route came from the queue, auto-dismiss the entry —
    // the user has a copy on disk, no reason to keep holding it in memory.
    if (!_currentBatchId) return
    const id = _currentBatchId
    _currentBatchId = null
    removeEntry(id)
    refreshBatchPanel()
    toolbar.updateButtons()
    console.log(`[GPXForge] Auto-dismissed queue entry after download (id=${id})`)
  },
})

// ── Build step panels (controls in toolbar, output in info panel) ──
const panels = initPanels(sidebar, shell)

// ── Restore + persist routing-behaviour toggles (shared by snap + builder) ──
;(function initRoutingToggles() {
  const savedOW  = localStorage.getItem('gpxforge_ignoreOneways')
  const savedRES = localStorage.getItem('gpxforge_ignoreRestrictions')
  const initOW  = savedOW  === null ? true : savedOW  === '1'
  const initRES = savedRES === null ? true : savedRES === '1'

  // Sync the four input elements (snap + builder) so they stay consistent
  // both within a session and across reloads via localStorage.
  const owInputs  = [panels.snap.els.ignoreOnewaysInput,      panels.builder.els.ignoreOnewaysInput]
  const resInputs = [panels.snap.els.ignoreRestrictionsInput, panels.builder.els.ignoreRestrictionsInput]

  owInputs.forEach(i => { i.checked = initOW })
  resInputs.forEach(i => { i.checked = initRES })
  setBuilderRoutingFlags({ ignoreOneways: initOW, ignoreRestrictions: initRES })

  owInputs.forEach(input => {
    input.addEventListener('change', e => {
      const v = e.target.checked
      localStorage.setItem('gpxforge_ignoreOneways', v ? '1' : '0')
      // Keep the sibling input in lockstep
      owInputs.forEach(other => { if (other !== input) other.checked = v })
      setBuilderRoutingFlags({ ignoreOneways: v })
    })
  })
  resInputs.forEach(input => {
    input.addEventListener('change', e => {
      const v = e.target.checked
      localStorage.setItem('gpxforge_ignoreRestrictions', v ? '1' : '0')
      resInputs.forEach(other => { if (other !== input) other.checked = v })
      setBuilderRoutingFlags({ ignoreRestrictions: v })
    })
  })
})()

// ── Wire builder panel buttons ──
;(function wireBuilderPanel() {
  const bp = panels.builder.els
  bp.btnRoutedMode.addEventListener('click', () => {
    setBuilderMode('routed')
    panels.builder.setMode('routed')
  })
  bp.btnManualMode.addEventListener('click', () => {
    setBuilderMode('manual')
    panels.builder.setMode('manual')
  })
  bp.profileSelect.addEventListener('change', () => {
    setBuilderProfile(bp.profileSelect.value)
  })
  bp.btnUndo.addEventListener('click', () => {
    builderUndo()
  })
  bp.btnClear.addEventListener('click', () => {
    if (_waypoints().length === 0) return
    if (confirm('Clear all waypoints?')) builderClear()
  })
  bp.btnDone.addEventListener('click', () => {
    doFinishRouteBuilder()
  })
  bp.placeInput.addEventListener('input', () => {
    queueBuilderPlaceSuggest()
  })
  bp.placeInput.addEventListener('blur', () => {
    // Delay so mousedown on a suggestion item fires before we hide it
    setTimeout(() => panels.builder.hidePlaceSuggestions(), 150)
  })
})()

function _waypoints() { return getBuilderWaypoints() }

let _builderSuggestTimer = null
let _builderSuggestAbort = null

function goToPlaceOnMap(place) {
  if (!place) return
  if (place.bbox) {
    mapFitBounds(place.bbox[0], place.bbox[1], place.bbox[2], place.bbox[3])
  } else {
    mapGoTo(place.lat, place.lon, 12)
  }
}

function queueBuilderPlaceSuggest() {
  if (_builderSuggestTimer) clearTimeout(_builderSuggestTimer)
  _builderSuggestTimer = setTimeout(runBuilderPlaceSuggest, 220)
}

async function runBuilderPlaceSuggest() {
  const query = panels.builder.els.placeInput.value.trim()
  if (query.length < 2) {
    panels.builder.hidePlaceSuggestions()
    return
  }

  if (_builderSuggestAbort) _builderSuggestAbort.abort()
  const ac = new AbortController()
  _builderSuggestAbort = ac

  try {
    const items = await searchPlaceSuggestions(query, 5, ac.signal)
    if (panels.builder.els.placeInput.value.trim() !== query) return
    panels.builder.setPlaceSuggestions(items, (place) => {
      goToPlaceOnMap(place)
      panels.builder.setSearchStatus(`Map moved to ${place.name}`)
    })
  } catch (err) {
    if (err?.name === 'AbortError') return
    panels.builder.hidePlaceSuggestions()
    panels.builder.setSearchStatus('Suggestions unavailable right now.')
  }
}


// ── Corrections panel (info panel — bottom-right secondary) ──
const corrPanel = initCorrections(shell.getInfoPanel('clean'), {
  onAccept: handleAcceptCorr,
  onReject: handleRejectCorr,
  onSelect: handleSelectCorr,
  onRemove: handleRemoveCorr,
})

// ── Batch queue panel (right of corrections panel in clean step) ──
let _currentBatchId = null

buildBatchPanel(shell.getBatchContainer(), {
  onLoad(id) {
    // Save current review state back before switching — use a full snapshot
    // so snap/trim/smooth/split edits persist across Load switches.
    if (_currentBatchId && _currentBatchId !== id && ST.gpx) {
      saveBackFull(_currentBatchId, snapshotST())
    }
    const entry = loadEntry(id)
    if (!entry) return
    _currentBatchId = id
    markReviewing(id)

    // Prefer a full snapshot (set by a prior saveBackFull); fall back to the
    // summary fields from the initial background-processed entry.
    if (entry.snapshot) {
      restoreST(entry.snapshot)
    } else {
      ST.gpx = { ...entry.gpx }
      ST.dists = entry.dists
      ST.grOrig = entry.grOrig
      ST.eleClean = entry.eleClean ? [...entry.eleClean] : entry.gpx.eles.slice()
      ST.grClean = entry.grClean || grads(ST.eleClean, ST.dists)
      ST.corrections = entry.corrections ? [...entry.corrections] : []
      ST.brunnels = entry.brunnels || []
      ST.lidarSource = entry.lidarSource || ''
      ST.filename = entry.filename
      ST.smoothedRoute = null
      ST.eleSmoothed = null
      ST.grSmoothed = null
      ST.selectedCorr = null
      ST.history = []
      ST.historyIdx = -1
      ST.stepStatus = {}
    }

    // Compute average spacing for adaptive smoothing (same as onFileLoaded)
    if (ST.dists && ST.dists.length > 1) {
      ST.origAvgSpacing = ST.dists[ST.dists.length - 1] / (ST.dists.length - 1)
    } else {
      ST.origAvgSpacing = 1
    }

    // Enable pipeline controls (these start disabled and are only enabled in onFileLoaded normally)
    panels.snap.els.btnAutoSnap.disabled = false
    panels.brunnels.els.btnFetch.disabled = false
    panels.clean.els.btnRun.disabled = false
    panels.clean.els.btnDraw.disabled = false
    panels.smooth.els.btnApply.disabled = false
    panels.split.els.btnAnalyze.disabled = false

    buildColors(ST.grClean)
    corrPanel.rebuild()
    refreshBatchPanel()
    refresh()
    toolbar.updateButtons()
    sidebar.setActiveStep('clean')
    shell.setInfoStep('clean')
  },
  onClear() {
    _currentBatchId = null
    refreshBatchPanel()
    toolbar.updateButtons()
  },
  onResume(id) {
    doResumeParkedEntry(id)
  },
  async onDownloadAll() {
    // Flush any pending edits on the currently-reviewed entry so the zip
    // reflects the latest state.
    if (_currentBatchId && ST.gpx) {
      saveBackFull(_currentBatchId, snapshotST())
    }
    const queue = getQueue()
    // Include bulk entries that finished processing AND parked entries
    // (they were worked on — user expects them bundled).
    const done = queue.filter(e => {
      if (e.origin === 'parked') return !!e.gpx
      return e.status === 'done' || e.status === 'reviewing' || e.status === 'ready'
    })
    if (!done.length) {
      const pending = queue.filter(e => e.origin !== 'parked' && e.status !== 'done' && e.status !== 'reviewing' && e.status !== 'ready').length
      alert(pending
        ? `No processed files yet — ${pending} still in the pipeline. Try again in a moment.`
        : 'No files to download.')
      return
    }
    try {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      for (const entry of done) {
        const eles = entry.eleClean || entry.gpx.eles
        const gpxStr = buildGPXString(entry.gpx.lats, entry.gpx.lons, eles, entry.filename)
        const name = entry.filename.replace(/\.gpx$/i, '_clean.gpx')
        zip.file(name, gpxStr)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'gpxforge_batch.zip'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)

      // Auto-dismiss the zipped entries. If the currently-loaded entry is
      // among them, also clear _currentBatchId so the user isn't still
      // "reviewing" a queue entry that no longer exists.
      const dismissedIds = done.map(e => e.id)
      if (dismissedIds.includes(_currentBatchId)) _currentBatchId = null
      for (const id of dismissedIds) removeEntry(id)
      refreshBatchPanel()
      toolbar.updateButtons()
      console.log(`[GPXForge] Auto-dismissed ${dismissedIds.length} queue entries after bulk download`)
    } catch (err) {
      alert('Zip download failed: ' + err.message)
    }
  },
  isLoadBlocked() {
    return !_currentBatchId && !!ST.gpx
  },
  getActiveId() {
    return _currentBatchId
  },
  onProcessAll() {
    // Show batch panel reflects new statuses; upload label updates as worker runs
    refreshBatchPanel()
  },
})

initBatchQueue(() => {
  refreshBatchPanel()
  const queue = getQueue()
  const bulkCount = queue.filter(e => e.origin !== 'parked').length
  const parkedCount = queue.filter(e => e.origin === 'parked').length
  if (bulkCount >= 2 || parkedCount >= 1) shell.showInfoPanel()
  // Reset the upload button when the queue has no pending/processing work
  // so the "Processing in background…" hint doesn't linger after download.
  const stillProcessing = queue.some(e => e.origin !== 'parked' &&
    (e.status === 'pending' || e.status === 'brunnels' || e.status === 'lidar' || e.status === 'cleaning'))
  if (!stillProcessing) shell.resetUploadLabel()
})

// ── Boot-time map init for map-first landing ──
// Deferred one frame so the map container has layout dimensions from the browser.
// All handler functions below are hoisted declarations — safe to reference here.
requestAnimationFrame(() => {
  if (!mapInited) {
    initMap(shell.getMapEl(), {
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      snapAddWp: handleAddWaypoint,
      snapDeleteWp: handleDeleteWaypoint,
      builderClick: (lat, lon) => { onBuilderMapClick(lat, lon) },
      builderDeleteWp: (idx) => { onBuilderDeleteWaypoint(idx) },
      builderDragWp: (idx, lat, lon) => { onBuilderWaypointDrag(idx, lat, lon) },
      builderInsertOnSeg: (segIdx, lat, lon) => { onBuilderInsertWaypoint(segIdx, lat, lon) },
    })
    mapInited = true
  }
})

// ────────────────────────────────────────────────────────────────────
// Park / Resume
// ────────────────────────────────────────────────────────────────────

/**
 * Park the current single-file route into the queue and clear the working area
 * so the user can start another file or resume a different parked entry.
 */
function doParkCurrentRoute() {
  if (!ST.gpx) return
  const snap = snapshotST()
  const filename = ST.filename || 'untitled.gpx'
  const parkedAtStep = ST.activeStep || null
  const reviewedId = _currentBatchId
  // Clear ST first so the notify() call fires with ST.gpx=null,
  // which makes isLoadBlocked()=false and renders Resume buttons as enabled.
  _currentBatchId = null
  clearST()
  if (reviewedId) {
    // Convert the queue entry the user was reviewing — no duplicate entry
    convertToParked(reviewedId, snap, parkedAtStep)
  } else {
    // Rough size hint — we don't have the original file blob anymore. 32 bytes/pt
    // gives a believable "400 KB" range for typical 10k-point routes.
    const fileSizeBytes = (snap.gpx?.lats?.length || 0) * 32
    parkEntry(filename, snap, parkedAtStep, fileSizeBytes)
  }
  corrPanel.rebuild()
  buildColors(null)
  refresh()
  sidebar.setActiveStep(null)
  shell.setInfoStep(null)
  refreshBatchPanel()
  shell.showInfoPanel()
  toolbar.updateButtons()

  // Disable file-dependent panel controls
  panels.snap.els.btnAutoSnap.disabled = true
  panels.brunnels.els.btnFetch.disabled = true
  panels.clean.els.btnRun.disabled = true
  panels.clean.els.btnDraw.disabled = true
  panels.smooth.els.btnApply.disabled = true
  panels.split.els.btnAnalyze.disabled = true

  console.log(`[GPXForge] Parked "${filename}" at step "${parkedAtStep || 'none'}"`)
}

/**
 * Restore a parked entry into ST verbatim and navigate back to where it was parked.
 */
function doResumeParkedEntry(id) {
  const entry = loadEntry(id)
  if (!entry || entry.status !== 'parked' || !entry.snapshot) return

  restoreST(entry.snapshot)
  _currentBatchId = null  // parked entries aren't queue-reviews — they own ST now

  // Remove the parked entry from the queue now that its snapshot is live
  // (fresh park on exit is how the user re-queues).
  const queue = getQueue()
  const idx = queue.findIndex(e => e.id === id)
  if (idx !== -1) queue.splice(idx, 1)

  // Make sure views are up so the restored route is visible
  shell.showViews()
  shell.showStepToolbar()
  if (!chartInited) {
    const els = shell.getChartEls()
    initChart(els, {
      commitDrag: handleCommitDrag,
      commitDraw: handleCommitDraw,
      removeCorr: handleRemoveCorr,
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      getShapeParams: () => panels.clean.getShapeParams(),
    })
    chartInited = true
  }
  if (!mapInited) {
    initMap(shell.getMapEl(), {
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      snapAddWp: handleAddWaypoint,
      snapDeleteWp: handleDeleteWaypoint,
      builderClick: (lat, lon) => { onBuilderMapClick(lat, lon) },
      builderDeleteWp: (idx2) => { onBuilderDeleteWaypoint(idx2) },
      builderDragWp: (idx2, lat, lon) => { onBuilderWaypointDrag(idx2, lat, lon) },
      builderInsertOnSeg: (segIdx, lat, lon) => { onBuilderInsertWaypoint(segIdx, lat, lon) },
    })
    mapInited = true
  }

  // Re-enable file-dependent panel controls
  panels.snap.els.btnAutoSnap.disabled = false
  panels.brunnels.els.btnFetch.disabled = false
  panels.clean.els.btnRun.disabled = false
  panels.clean.els.btnDraw.disabled = false
  panels.smooth.els.btnApply.disabled = false
  panels.split.els.btnAnalyze.disabled = false

  const step = entry.parkedAtStep || 'trim'
  buildColors(ST.grClean)
  corrPanel.rebuild()
  refresh()
  mapFit()
  sidebar.setActiveStep(step)
  shell.setInfoStep(step)
  toolbar.updateButtons()
  refreshBatchPanel()
  console.log(`[GPXForge] Resumed "${ST.filename}" at step "${step}"`)
}

// ── State ──
let chartInited = false
let mapInited = false

// ────────────────────────────────────────────────────────────────────
// File loaded
// ────────────────────────────────────────────────────────────────────

/**
 * Called by shell.js when multiple GPX files are dropped or selected.
 * Hands them to the batch queue instead of the single-file flow.
 * @param {File[]} files
 */
function onFilesLoaded(files) {
  addFiles(files, parseGPX)
  // Show the app UI so the batch panel is visible
  shell.showViews()
  shell.showStepToolbar()
  if (!chartInited) {
    const els = shell.getChartEls()
    initChart(els, {
      commitDrag: handleCommitDrag,
      commitDraw: handleCommitDraw,
      removeCorr: handleRemoveCorr,
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      getShapeParams: () => panels.clean.getShapeParams(),
    })
    chartInited = true
  }
  if (!mapInited) {
    initMap(shell.getMapEl(), {
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      snapAddWp: handleAddWaypoint,
      snapDeleteWp: handleDeleteWaypoint,
      builderClick: (lat, lon) => { onBuilderMapClick(lat, lon) },
      builderDeleteWp: (idx) => { onBuilderDeleteWaypoint(idx) },
      builderDragWp: (idx, lat, lon) => { onBuilderWaypointDrag(idx, lat, lon) },
      builderInsertOnSeg: (segIdx, lat, lon) => { onBuilderInsertWaypoint(segIdx, lat, lon) },
    })
    mapInited = true
  }
  sidebar.setActiveStep('clean')
  shell.setInfoStep('clean')
  refreshBatchPanel()
}

/**
 * Called by shell.js after a GPX file is parsed and ST is populated.
 */
function onFileLoaded() {
  // Transition from landing to chart+map layout
  shell.showViews()

  // Clear stale trim markers before activating the trim step so the map
  // never renders a leftover marker from a previous file session.
  ST.trimMarkerA = null
  ST.trimMarkerB = null

  // Initialise chart system (first load only)
  if (!chartInited) {
    const els = shell.getChartEls()
    initChart(els, {
      commitDrag: handleCommitDrag,
      commitDraw: handleCommitDraw,
      removeCorr: handleRemoveCorr,
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      getShapeParams: () => panels.clean.getShapeParams(),
    })
    chartInited = true
  }

  // Map is already initialised at boot — guard kept for safety
  if (!mapInited) {
    initMap(shell.getMapEl(), {
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      snapAddWp: handleAddWaypoint,
      snapDeleteWp: handleDeleteWaypoint,
      builderClick: (lat, lon) => { onBuilderMapClick(lat, lon) },
      builderDeleteWp: (idx) => { onBuilderDeleteWaypoint(idx) },
      builderDragWp: (idx, lat, lon) => { onBuilderWaypointDrag(idx, lat, lon) },
      builderInsertOnSeg: (segIdx, lat, lon) => { onBuilderInsertWaypoint(segIdx, lat, lon) },
    })
    mapInited = true
  }

  // Reset pipeline state for new file
  ST.brunnels = null
  ST.splitAnalysis = null
  ST.splitSegments = null
  ST.trimMarkerA = null
  ST.trimMarkerB = null
  ST.trimHistory = []
  ST.trimJoins = []
  ST.routeWaypoints = []
  ST.routeSegments = []
  ST.snapWaypoints = []
  ST.snapPreState = null
  ST.snapDragHistory = []
  ST.smoothedRoute = null
  ST.lidarSource = ''
  ST.lidarSources = {}

  // Compute original file's average point spacing for adaptive smoothing
  if (ST.dists && ST.dists.length > 1) {
    ST.origAvgSpacing = ST.dists[ST.dists.length - 1] / (ST.dists.length - 1)
  } else {
    ST.origAvgSpacing = 1
  }

  // Enable file-dependent panel controls
  panels.snap.els.btnAutoSnap.disabled = false
  panels.brunnels.els.btnFetch.disabled = false
  panels.clean.els.btnRun.disabled = false
  panels.clean.els.btnDraw.disabled = false
  panels.smooth.els.btnApply.disabled = false
  panels.split.els.btnAnalyze.disabled = false

  _currentBatchId = null
  refresh()
  mapFit()
  toolbar.updateButtons()
  refreshBatchPanel()

  if (ST.mode === 'simple') {
    // Simple mode: auto-run full pipeline immediately
    runSimplePipeline().catch(err => console.error('[GPXForge] Simple pipeline failed:', err))
  } else {
    // Expert mode: step-by-step manual pipeline starting at Trim
    shell.showStepToolbar()
    sidebar.setActiveStep('trim')
    shell.setInfoStep('trim')
  }
}

// ────────────────────────────────────────────────────────────────────
// Refresh
// ────────────────────────────────────────────────────────────────────

/**
 * Refresh all views from current state.
 * Called after file load, undo/redo, or any pipeline change.
 */
function refresh() {
  buildColors(ST.grClean)
  drawAll()
  drawMap()
  shell.updateStats()
  // Lock Simple toggle whenever Expert is active and a route is loaded.
  // Park/clear releases the lock by emptying ST.gpx.
  shell.setSimpleLocked(ST.mode === 'expert' && !!ST.gpx)
}

// ────────────────────────────────────────────────────────────────────
// Route builder mode
// ────────────────────────────────────────────────────────────────────

function doEnterBuilderMode() {
  // Ensure map is initialised (user may enter builder before loading a file)
  if (!mapInited) {
    initMap(shell.getMapEl(), {
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      snapAddWp: handleAddWaypoint,
      snapDeleteWp: handleDeleteWaypoint,
      builderClick: (lat, lon) => { onBuilderMapClick(lat, lon) },
      builderDeleteWp: (idx) => { onBuilderDeleteWaypoint(idx) },
      builderDragWp: (idx, lat, lon) => { onBuilderWaypointDrag(idx, lat, lon) },
      builderInsertOnSeg: (segIdx, lat, lon) => { onBuilderInsertWaypoint(segIdx, lat, lon) },
    })
    mapInited = true
  }

  shell.showViews('map')
  shell.showStepToolbar()
  shell.setInfoStep('builder')
  document.body.classList.add('builder-active')

  sidebar.setBuilderActive(true)
  toolbar.setCreateRouteActive(true)

  const map = document.getElementById('mapPanel')
  if (map) map.style.cursor = 'crosshair'

  enterBuilderMode({
    onUpdate: onBuilderUpdate,
    onStatusChange: (msg) => panels.builder.setStatus(msg),
  })

  panels.builder.setMode('routed')
  panels.builder.setStats(0, 0)
  panels.builder.setUndoEnabled(false)

  drawMap()
}

function doExitBuilderMode() {
  // Warn if the user has started placing waypoints — exit will discard the route.
  const wps = getBuilderWaypoints()
  if (wps.length >= 2) {
    if (!confirm('Exit route builder? Your current route will be lost.')) return
  }

  exitBuilderMode()
  document.body.classList.remove('builder-active')

  const map = document.getElementById('mapPanel')
  if (map) map.style.cursor = ''

  sidebar.setBuilderActive(false)
  toolbar.setCreateRouteActive(false)

  if (!ST.gpx) {
    // No file loaded — return to map-first landing
    shell.showLanding()
    shell.setInfoStep(null)
  } else {
    // Restore focus: chart-featured for elevation/analysis steps, map-featured otherwise.
    const step = ST.activeStep
    if (step === 'clean' || step === 'smooth' || step === 'split') {
      shell.showViews()
    } else {
      shell.showViews('map')
    }
    shell.setInfoStep(step || null)
  }

  drawMap()
}

function onBuilderUpdate() {
  const wps = getBuilderWaypoints()
  const dist = getBuilderDistance()
  panels.builder.setStats(wps.length, dist)
  panels.builder.setUndoEnabled(builderCanUndo())
  drawMap()
}

/**
 * Fetch LIDAR elevation and replace ST.gpx elevation/positions in place.
 * Used by the LIDAR toolbar button and the simple-mode auto-pipeline.
 * Throws on failure. Does NOT call refresh() — caller decides.
 */
async function runLidarFetch() {
  if (ST.dists && ST.dists.length > 1) {
    ST.origAvgSpacing = ST.dists[ST.dists.length - 1] / (ST.dists.length - 1)
  }

  const targetRes = getTargetResolution(ST.gpx.lats, ST.gpx.lons)
  const densified = densifyForLidar(ST.gpx.lats, ST.gpx.lons, ST.dists, targetRes)

  const fetchLats = densified.wasDensified ? densified.lats : ST.gpx.lats
  const fetchLons = densified.wasDensified ? densified.lons : ST.gpx.lons
  const fetchEles = densified.wasDensified
    ? new Array(densified.lats.length).fill(0)
    : ST.gpx.eles

  if (densified.wasDensified) {
    const cc = detectPrimaryCountry(ST.gpx.lats, ST.gpx.lons)
    console.log(`[GPXForge] Densified ${densified.originalCount} \u2192 ${densified.newCount} pts for ${cc || '?'} @ ${targetRes}m`)
  }

  const gpxString = buildGPXString(fetchLats, fetchLons, fetchEles, ST.filename || 'route')
  const { gpxText, summary, source, sources } = await fetchLidarElevations(gpxString, ST.filename || 'route.gpx')

  const parser = new DOMParser()
  const doc = parser.parseFromString(gpxText, 'text/xml')
  const trkpts = doc.querySelectorAll('trkpt')
  if (!trkpts.length) throw new Error('LIDAR response contains no track points')
  const newLats = [], newLons = [], newEles = []
  for (const pt of trkpts) {
    newLats.push(parseFloat(pt.getAttribute('lat')))
    newLons.push(parseFloat(pt.getAttribute('lon')))
    const eleEl = pt.querySelector('ele')
    newEles.push(eleEl ? parseFloat(eleEl.textContent) : 0)
  }

  const rebuilt = rebuildRoute(newLats, newLons, newEles, newEles)
  ST.gpx.lats = newLats
  ST.gpx.lons = newLons
  ST.gpx.eles = newEles
  ST.eleClean = [...newEles]
  ST.dists = rebuilt.dists instanceof Float64Array ? rebuilt.dists : new Float64Array(rebuilt.dists)
  ST.grOrig = rebuilt.grOrig
  ST.grClean = rebuilt.grClean
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.smoothedRoute = null
  ST.corrections = []
  ST.selectedCorr = -1
  ST.splitAnalysis = null
  ST.splitSegments = null
  ST.lidarSource = source || ''
  ST.lidarSources = sources || {}

  for (const step of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split']) {
    sidebar.setStepStatus(step, 'none', null)
  }
  panels.clean.clearLog()
  panels.smooth.hideStats()
  panels.smooth.enableRevert(false)
  panels.smooth.enableSimplify(false)
  panels.split.hideResults()

  console.log(`[GPXForge] LIDAR elevation applied: ${summary}`)
  if (ST.lidarSource) console.log(`[GPXForge] LIDAR source: ${ST.lidarSource}`)
}

/**
 * Simple-mode one-shot pipeline run after Create\u2192Done.
 * LIDAR \u2192 auto-pipeline (brunnels \u2192 clean \u2192 smooth \u2192 simplify\u00d72), skipping snap.
 * Shows/updates/hides the progress overlay. Lands on the smooth step.
 */
async function runSimplePipeline() {
  // Elevation work is about to start — switch to chart-featured 3-panel now.
  shell.showViews()
  shell.showProgress()
  try {
    shell.updateProgress('lidar', 'active', 'Fetching elevation\u2026')
    try {
      await runLidarFetch()
      shell.updateProgress('lidar', 'done', ST.lidarSource || 'OK')
    } catch (err) {
      shell.updateProgress('lidar', 'error', err.message || String(err))
      console.warn('[GPXForge] LIDAR failed in simple pipeline, continuing:', err)
    }

    await runAutoPipeline((stepId, pct, msg) => {
      if (stepId === 'snap' || stepId === 'simplify') return
      if (stepId === 'brunnels') {
        shell.updateProgress('brunnels', pct >= 45 ? 'done' : 'active', msg)
      } else if (stepId === 'clean') {
        shell.updateProgress('clean', pct >= 60 ? 'done' : 'active', msg)
      } else if (stepId === 'smooth') {
        shell.updateProgress('smooth', pct >= 80 ? 'done' : 'active', msg)
      } else if (stepId === 'done') {
        shell.updateProgress('smooth', 'done', 'Complete')
      }
    }, { skipSnap: true })

    sidebar.setActiveStep('smooth')
    shell.setInfoStep('smooth')
    refresh()
    toolbar.updateButtons()
  } finally {
    setTimeout(() => shell.hideProgress(), 600)
  }
}

function doFinishRouteBuilder() {
  const result = finishRouteBuilder()
  if (!result) return

  const { lats, lons, eles, dists } = result

  // Populate ST.gpx with the new route
  ST.gpx = {
    lats,
    lons,
    eles: [...eles],
    dists,
    doc: null,
    ns: '',
    pts: [],
    rawXml: '',
  }
  ST.dists = dists
  ST.filename = 'created_route.gpx'
  ST.eleClean = [...eles]
  ST.grClean = null
  ST.grOrig = null
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.smoothedRoute = null
  ST.corrections = []
  ST.selectedCorr = -1
  ST.brunnels = null
  ST.splitAnalysis = null
  ST.splitSegments = null
  ST.trimMarkerA = null
  ST.trimMarkerB = null
  ST.trimHistory = []
  ST.trimJoins = []
  ST.routeWaypoints = []
  ST.routeSegments = []
  ST.origAvgSpacing = dists.length > 1 ? dists[dists.length - 1] / (dists.length - 1) : 1

  // UI cleanup
  const map = document.getElementById('mapPanel')
  if (map) map.style.cursor = ''
  document.body.classList.remove('builder-active')
  sidebar.setBuilderActive(false)
  toolbar.setCreateRouteActive(false)

  // Keep map full-screen after Done — user still needs the map for trim/snap.
  // Simple mode: runSimplePipeline() will switch to chart-featured when pipeline starts.
  // Expert mode: switching to clean/smooth/split step will switch to chart-featured.
  shell.showViews('map')
  const isSimple = ST.mode === 'simple'
  if (!isSimple) {
    shell.showStepToolbar()
    sidebar.setActiveStep('trim')
    shell.setInfoStep('trim')
  } else {
    sidebar.setActiveStep('smooth')
    shell.setInfoStep('smooth')
  }

  // Initialise chart if not yet done
  if (!chartInited) {
    const els = shell.getChartEls()
    initChart(els, {
      commitDrag: handleCommitDrag,
      commitDraw: handleCommitDraw,
      removeCorr: handleRemoveCorr,
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      getShapeParams: () => panels.clean.getShapeParams(),
    })
    chartInited = true
  }

  // Enable pipeline controls
  panels.snap.els.btnAutoSnap.disabled = false
  panels.brunnels.els.btnFetch.disabled = false
  panels.clean.els.btnRun.disabled = false
  panels.clean.els.btnDraw.disabled = false
  panels.smooth.els.btnApply.disabled = false
  panels.split.els.btnAnalyze.disabled = false

  _currentBatchId = null
  refresh()
  mapFit()
  toolbar.updateButtons()
  refreshBatchPanel()

  // Simple mode: auto-run pipeline after Done
  if (isSimple) {
    runSimplePipeline().catch(err => console.error('[GPXForge] Simple pipeline failed:', err))
  }
}

// M key — toggle builder mode (routed/manual) when builder is active
document.addEventListener('keydown', (ev) => {
  if (!isBuilderActive()) return
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return
  if (ev.key === 'm' || ev.key === 'M') {
    const current = panels.builder.els.btnRoutedMode.classList.contains('tb-btn-primary') ? 'routed' : 'manual'
    const next = current === 'routed' ? 'manual' : 'routed'
    setBuilderMode(next)
    panels.builder.setMode(next)
  }
})

/**
 * Called after undo/redo restores a snapshot.
 * Rebuilds corrections panel and refreshes views.
 */
function onHistoryRestore() {
  corrPanel.rebuild()
  updateCleanStatus()
  updateSmoothStatus()
  refresh()
}

/** Called after simplify undo/redo restores a smoothedRoute snapshot. */
function onSimplifyRestore() {
  updateSmoothStatus()
  updateSimplifyUI()
  refresh()
}

// Simplify pass log for info panel display
const simplifyLog = [] // [{ before, after, removed }]

function updateSimplifyUI() {
  const pts = ST.smoothedRoute ? ST.smoothedRoute.lats.length : 0
  // Trim log to match current simplifyIdx (undo may have gone back)
  const passCount = ST.simplifyIdx  // idx 0 = baseline, 1 = after pass 1, etc.
  simplifyLog.length = Math.max(0, passCount)
  panels.smooth.showSimplifyLog(simplifyLog)
  panels.smooth.enableSimplify(!!ST.smoothedRoute)
  if (ST.smoothedRoute) {
    sidebar.setStepStatus('smooth', 'done',
      passCount > 0 ? `${pts} pts (${passCount} simplif.)` : `${pts} pts`)
  }
}

// ────────────────────────────────────────────────────────────────────
// Vegetation filter helpers
// ────────────────────────────────────────────────────────────────────

function applySourceAwareDipSmoothing(stageLabel = 'clean') {
  if (!ST.eleClean || !ST.dists) return null
  const brunnelMask = ST.brunnels && ST.brunnels.length
    ? buildBrunnelMask(ST.brunnels, ST.dists)
    : null
  const result = runSourceAwareDipSmoothing(ST.eleClean, ST.dists, {
    source: ST.lidarSource,
    brunnelMask,
  })
  if (!result || !result.diagnostics?.applied) return result
  ST.eleClean = result.eles
  ST.grClean = grads(ST.eleClean, ST.dists)
  const d = result.diagnostics
  panels.clean.appendLog(
    `Source dip smoothing (${stageLabel}, ${d.profile}): ${d.windows} windows, ${d.pointsAdjusted} points`,
    'i',
  )
  console.log(
    `[GPXForge] Source dip smoothing (${stageLabel}): ${d.profile}, ${d.windows} windows, ${d.pointsAdjusted} points`,
  )
  return result
}

// ────────────────────────────────────────────────────────────────────
// Status helpers
// ────────────────────────────────────────────────────────────────────

function updateCleanStatus() {
  if (!ST.corrections || ST.corrections.length === 0) {
    sidebar.setStepStatus('clean', 'none', null)
    return
  }
  const suspects = ST.corrections.filter(c => c.type === 'suspect' && !c.accepted && !c.rejected)
  if (suspects.length > 0) {
    sidebar.setStepStatus('clean', 'warn', `${suspects.length} pending`)
  } else {
    sidebar.setStepStatus('clean', 'done', `${ST.corrections.length} fixes`)
  }
}

function updateSmoothStatus() {
  if (ST.smoothedRoute) {
    sidebar.setStepStatus('smooth', 'done', 'applied')
  } else {
    sidebar.setStepStatus('smooth', 'none', null)
  }
}

// ────────────────────────────────────────────────────────────────────
// Trim: Click / Apply / Clear / Undo
// ────────────────────────────────────────────────────────────────────

// Suppress trim clicks for a short window after the file picker opens.
// Double-clicking the drop-zone label fires the picker on click 1; click 2
// lands on the chart canvas after the dialog closes and would place a marker.
let _suppressTrimClick = false
document.getElementById('dropZone')?.addEventListener('click', () => {
  _suppressTrimClick = true
  setTimeout(() => { _suppressTrimClick = false }, 1000)
})

/**
 * Handle a trim click from map or chart.
 * First click sets marker A, second sets marker B.
 * Third click resets and starts over.
 */
function handleTrimClick(idx) {
  if (!ST.gpx || !ST.dists) return
  if (ST.activeStep !== 'trim') return
  if (_suppressTrimClick) return

  const { lats, lons } = ST.gpx
  const marker = { idx, lat: lats[idx], lon: lons[idx], dist: ST.dists[idx] }

  if (!ST.trimMarkerA) {
    ST.trimMarkerA = marker
    updateTrimUI()
  } else if (!ST.trimMarkerB) {
    ST.trimMarkerB = marker
    // Auto-sort: A should be the earlier point
    if (ST.trimMarkerA.idx > ST.trimMarkerB.idx) {
      [ST.trimMarkerA, ST.trimMarkerB] = [ST.trimMarkerB, ST.trimMarkerA]
    }
    updateTrimUI()
  } else {
    // Third click — reset and place new A
    ST.trimMarkerA = marker
    ST.trimMarkerB = null
    updateTrimUI()
  }

  drawAll()
  drawMap()
}

function updateTrimUI() {
  const a = ST.trimMarkerA
  const b = ST.trimMarkerB

  if (a && b) {
    const gap = trimGapDistance(ST.gpx.lats, ST.gpx.lons, a.idx, b.idx)
    panels.trim.showMarkerInfo(
      `${(a.dist / 1000).toFixed(3)} km`,
      `${(b.dist / 1000).toFixed(3)} km`,
      `${gap.toFixed(0)}m${gap > 30 ? ' ⚠' : ' ✓'}`,
    )
    panels.trim.enableApply(true)
    panels.trim.setStatus('Ready — click ✂ Apply Trim')
  } else if (a) {
    panels.trim.setStatus(`Marker A set at ${(a.dist / 1000).toFixed(3)} km — click to set B`)
    panels.trim.enableApply(false)
    panels.trim.hideMarkerInfo()
  } else {
    panels.trim.setStatus('Click the map or chart to place trim markers')
    panels.trim.enableApply(false)
    panels.trim.hideMarkerInfo()
  }

  panels.trim.enableUndo(ST.trimHistory.length > 0)
}

panels.trim.els.btnApply.addEventListener('click', async () => {
  if (!ST.gpx || !ST.trimMarkerA || !ST.trimMarkerB) return

  const idxA = ST.trimMarkerA.idx
  const idxB = ST.trimMarkerB.idx
  const N = ST.gpx.lats.length

  const trimType = detectTrimType(idxA, idxB, N)

  // Mid-trim with downstream work: warn before discarding everything
  const hasDownstream = ST.brunnels || (ST.corrections && ST.corrections.length > 0) ||
    ST.smoothedRoute || ST.eleSmoothed
  if (trimType === 'mid' && hasDownstream) {
    const ok = window.confirm(
      'Mid-track trim will discard all pipeline work (brunnels, clean corrections, smoothed route).\n\nContinue?'
    )
    if (!ok) return
  }

  // Save snapshot for undo (captures old dists too for remap on undo)
  ST.trimHistory.push(trimSnapshot(ST.gpx, ST.dists, ST.grOrig, ST.eleClean, ST.grClean))

  panels.trim.setStatus(`Applying ${trimType} trim...`)
  panels.trim.enableApply(false)

  try {
    const eleClean = ST.eleClean || ST.gpx.eles

    // Capture old dists before commit — needed for proportional remap
    const oldDists = ST.dists

    const result = await executeTrim(ST.gpx, eleClean, idxA, idxB, trimType)

    // Rebuild route
    const rebuilt = rebuildRoute(result.lats, result.lons, result.eles, result.eleClean)

    // Commit to state
    ST.gpx = { ...ST.gpx, lats: result.lats, lons: result.lons, eles: result.eles }
    ST.dists = rebuilt.dists instanceof Float64Array ? rebuilt.dists : new Float64Array(rebuilt.dists)
    ST.grOrig = rebuilt.grOrig
    ST.eleClean = result.eleClean
    ST.grClean = rebuilt.grClean

    // Track mid-trim join points for snap waypoint anchoring
    if (trimType === 'mid') {
      // After mid-trim, idxA is the join point in the new array.
      // For start trims, indices shift — recalculate from trimJoins.
      // Store raw join index; snap will use it as a forced waypoint.
      ST.trimJoins.push(idxA)
    }

    // Reset viewport
    ST.viewStart = 0
    ST.viewEnd = 1

    // Clear markers
    ST.trimMarkerA = null
    ST.trimMarkerB = null

    // Start/end trims: remap downstream pipeline state to new index space.
    // Mid trims: full wipe (geometry breaks at the seam).
    if (trimType !== 'mid' && hasDownstream) {
      remapDownstreamAfterTrim(trimType, idxA, idxB, oldDists)
    } else {
      invalidateFrom('trim')
    }

    // Update status
    const trimCount = ST.trimHistory.length
    sidebar.setStepStatus('trim', 'done', `${trimCount} trim${trimCount > 1 ? 's' : ''}`)
    panels.trim.setStatus(`${trimType} trim applied`)

    refresh()
    mapFit()
    toolbar.updateButtons()
    updateTrimUI()

    console.log(`[GPXForge] Trim: ${trimType} [${idxA}–${idxB}], ${result.lats.length} points remaining`)
  } catch (err) {
    panels.trim.setStatus(`Trim failed: ${err.message}`)
    console.error('[GPXForge] Trim error:', err)
    // Remove the snapshot we just pushed since trim failed
    ST.trimHistory.pop()
    updateTrimUI()
  }
})

panels.trim.els.btnClear.addEventListener('click', () => {
  ST.trimMarkerA = null
  ST.trimMarkerB = null
  updateTrimUI()
  drawAll()
  drawMap()
})

panels.trim.els.btnUndo.addEventListener('click', () => {
  if (ST.trimHistory.length === 0) return

  const snap = ST.trimHistory.pop()
  ST.gpx = snap.gpx
  ST.dists = snap.dists
  ST.grOrig = snap.grOrig
  ST.eleClean = snap.eleClean
  ST.grClean = snap.grClean
  ST.trimMarkerA = null
  ST.trimMarkerB = null
  ST.trimJoins.pop()  // remove the join added by this trim

  // Reset viewport
  ST.viewStart = 0
  ST.viewEnd = 1

  // Invalidate downstream
  invalidateFrom('trim')

  const trimCount = ST.trimHistory.length
  if (trimCount > 0) {
    sidebar.setStepStatus('trim', 'done', `${trimCount} trim${trimCount > 1 ? 's' : ''}`)
  } else {
    sidebar.setStepStatus('trim', 'none', null)
  }

  refresh()
  mapFit()
  toolbar.updateButtons()
  updateTrimUI()
  console.log('[GPXForge] Trim: undone')
})

// ────────────────────────────────────────────────────────────────────
// Snap: Auto-Snap, Drag-to-Reroute, Revert
// ────────────────────────────────────────────────────────────────────

// Auto-snap
panels.snap.els.btnAutoSnap.addEventListener('click', async () => {
  if (!ST.gpx || !ST.dists) return

  const spacing = panels.snap.getSpacing()
  const { lats, lons, eles } = ST.gpx
  const dists = ST.dists

  // Clear any existing waypoints
  ST.routeWaypoints = []
  ST.routeSegments = []
  ST.snapWaypoints = []

  panels.snap.els.btnAutoSnap.disabled = true

  // Save pre-snap state for revert BEFORE routing starts
  ST.snapPreState = {
    gpx: { ...ST.gpx, lats: [...lats], lons: [...lons], eles: [...eles] },
    dists: ST.dists instanceof Float64Array ? new Float64Array(ST.dists) : [...ST.dists],
    grOrig: ST.grOrig ? (ST.grOrig instanceof Float64Array ? new Float64Array(ST.grOrig) : [...ST.grOrig]) : null,
    eleClean: ST.eleClean ? [...ST.eleClean] : null,
    grClean: ST.grClean ? (ST.grClean instanceof Float64Array ? new Float64Array(ST.grClean) : [...ST.grClean]) : null,
  }

  try {
    const costing = panels.snap.getCosting()
    const ignoreOneways = panels.snap.getIgnoreOneways()
    const ignoreRestrictions = panels.snap.getIgnoreRestrictions()
    const result = await autoSnap(lats, lons, eles, dists, spacing, (current, total, segments) => {
      panels.snap.setProgress(`Routing ${current} / ${total} segments...`)

      // Progressive map drawing: show intermediate segments on map
      if (segments && segments.length > 0) {
        // Build temporary waypoints from segment endpoints for display
        const tempWps = [{ lat: segments[0][0][0], lon: segments[0][0][1] }]
        for (const seg of segments) {
          tempWps.push({ lat: seg[seg.length - 1][0], lon: seg[seg.length - 1][1] })
        }
        ST.routeWaypoints = tempWps
        ST.routeSegments = segments
        drawMap()
      }
    }, { costing, forcedIndices: ST.trimJoins, ignoreOneways, ignoreRestrictions })

    // Densify FIRST (geometry only), then transfer elevation to each dense point.
    // This preserves LIDAR elevation detail — densifying after transfer would
    // linearly interpolate between sparse Valhalla points, smoothing out the profile.
    let finalLats = result.lats
    let finalLons = result.lons
    let anchorNewIndices = result.wpIndices // waypoint indices in merged route
    const densifyM = panels.snap.getDensify()
    if (densifyM > 0) {
      panels.snap.setProgress('Densifying route...')
      const dense = densifyRoute(result.lats, result.lons, result.eles, densifyM)
      // Map waypoint indices from pre-densified to densified array.
      // Densify preserves original points (adds interpolated ones between them),
      // so we find each waypoint's lat/lon in the densified array.
      anchorNewIndices = mapWaypointsToDensified(result.wpIndices, result.lats, result.lons, dense.lats, dense.lons)
      finalLats = dense.lats
      finalLons = dense.lons
    }
    panels.snap.setProgress('Transferring elevations...')
    const finalEles = transferElevations(lats, lons, eles, dists, finalLats, finalLons, {
      origIndices: result.waypoints,
      newIndices: anchorNewIndices,
    })

    // Save waypoint positions and original indices for drag-to-reroute
    const wpPositions = result.waypoints.map(idx => ({
      lat: lats[idx], lon: lons[idx],
    }))
    ST.snapWaypoints = wpPositions
    ST.snapOrigIndices = result.waypoints

    // Commit to state (rebuilds route arrays, invalidates downstream)
    commitSnapRoute(finalLats, finalLons, finalEles)

    // Re-populate waypoints for display after commit (commit clears them)
    ST.routeWaypoints = [...ST.snapWaypoints]

    // Rebuild segments from waypoint pairs using the committed route
    ST.routeSegments = rebuildSnapSegments(ST.snapWaypoints, finalLats, finalLons)

    panels.snap.setProgress(`Snapped: ${finalLats.length} points (was ${lats.length}) — drag waypoints to reroute`)
    panels.snap.showRevert(true)
    sidebar.setStepStatus('snap', 'done', `${finalLats.length} pts`)

    // Redraw to show draggable waypoints
    drawMap()

    console.log(`[GPXForge] Auto-snap: ${spacing}m spacing, ${result.waypoints.length} waypoints → ${finalLats.length} points`)

  } catch (err) {
    panels.snap.setProgress(`Auto-snap failed: ${err.message}`)
    console.error('[GPXForge] Auto-snap error:', err)
    // Clear pre-snap state since snap failed
    ST.snapPreState = null
  }

  panels.snap.els.btnAutoSnap.disabled = false
})

/**
 * Map waypoint positions onto a route using monotonic forward matching.
 * This keeps anchors ordered on out-and-back and stacked-road geometry.
 */
function mapWaypointIndicesOnRoute(waypoints, routeLats, routeLons) {
  if (!waypoints || waypoints.length === 0 || !routeLats || routeLats.length === 0) return []

  const wpIndices = []
  let searchStart = 0
  const lastRouteIdx = routeLats.length - 1

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i]
    const startIdx = Math.min(searchStart, lastRouteIdx)
    const idx = nearestGpxIndexForward(wp.lat, wp.lon, routeLats, routeLons, startIdx)
    wpIndices.push(idx)
    searchStart = Math.min(idx + 1, lastRouteIdx)
  }

  return wpIndices
}

/**
 * Build visual segments between waypoints from the committed route.
 * Each segment is the slice of the route between consecutive waypoints.
 */
function rebuildSnapSegments(waypoints, routeLats, routeLons) {
  if (waypoints.length < 2) return []
  const segments = []

  // Use monotonic forward search — each waypoint must be AFTER the previous one.
  // Without this, switchback waypoints match the wrong level of the road.
  const wpIndices = mapWaypointIndicesOnRoute(waypoints, routeLats, routeLons)

  for (let i = 0; i < wpIndices.length - 1; i++) {
    const from = wpIndices[i]
    const to = wpIndices[i + 1]
    const seg = []
    for (let j = from; j <= to; j++) {
      seg.push([routeLats[j], routeLons[j]])
    }
    if (seg.length >= 2) segments.push(seg)
  }

  return segments
}

/**
 * Handle click-to-add waypoint on a snap route segment.
 * Inserts a new waypoint at the clicked position, reroutes the two
 * adjacent segments (prevWP → newWP and newWP → nextWP) via Valhalla.
 *
 * @param {number} lat — clicked position latitude
 * @param {number} lon — clicked position longitude
 * @param {number} segIdx — index of the segment that was clicked
 */
async function handleAddWaypoint(lat, lon, segIdx) {
  if (!ST.gpx || !ST.snapWaypoints || ST.snapWaypoints.length < 2) return
  if (segIdx < 0 || segIdx >= ST.routeSegments.length) return

  const wps = ST.snapWaypoints
  const costing = panels.snap.getCosting()
  const valhallaCost = costing === 'bike' ? 'bicycle' : costing === 'pedestrian' ? 'pedestrian' : 'auto'
  const snapCostingOpts = {
    ignore_oneways: panels.snap.getIgnoreOneways(),
    ignore_restrictions: panels.snap.getIgnoreRestrictions(),
    ...(costing === 'pedestrian' ? { walking_speed: 5.1, max_distance: 100000 } : {}),
  }

  // Save snapshot for undo
  ST.snapDragHistory.push({
    gpx: { ...ST.gpx, lats: [...ST.gpx.lats], lons: [...ST.gpx.lons], eles: [...ST.gpx.eles] },
    dists: ST.dists instanceof Float64Array ? new Float64Array(ST.dists) : [...ST.dists],
    grOrig: ST.grOrig ? [...ST.grOrig] : null,
    eleClean: ST.eleClean ? [...ST.eleClean] : null,
    grClean: ST.grClean ? [...ST.grClean] : null,
    routeSegments: ST.routeSegments.map(s => s.map(p => [...p])),
    snapWaypoints: wps.map(w => ({ ...w })),
  })
  panels.snap.enableUndo(true)

  panels.snap.setProgress('Adding waypoint...')

  // The clicked segment is between waypoints[segIdx] and waypoints[segIdx + 1]
  const wpBefore = wps[segIdx]
  const wpAfter = wps[segIdx + 1]
  const newWp = { lat, lon }

  try {
    // Route two new segments: wpBefore → newWp and newWp → wpAfter
    const newLegs = await valhallaMulti(
      [wpBefore, newWp, wpAfter],
      valhallaCost,
      snapCostingOpts,
    )

    // Insert waypoint into the list
    ST.snapWaypoints = [...wps.slice(0, segIdx + 1), newWp, ...wps.slice(segIdx + 1)]

    // Replace the old single segment with the two new ones
    const allSegments = [...ST.routeSegments]
    allSegments.splice(segIdx, 1, newLegs[0], newLegs[1])

    // Merge all segments into route
    const merged = mergeSegments(allSegments)

    // Densify + transfer elevation
    const origState = ST.snapPreState
    if (!origState) return
    const origAnchorIndices = mapWaypointIndicesOnRoute(ST.snapWaypoints, origState.gpx.lats, origState.gpx.lons)
    let newAnchorIndices = mapWaypointIndicesOnRoute(ST.snapWaypoints, merged.lats, merged.lons)

    let routeLats = merged.lats
    let routeLons = merged.lons
    const densifyM = panels.snap.getDensify()
    if (densifyM > 0) {
      const dense = densifyRoute(merged.lats, merged.lons, new Array(merged.lats.length).fill(0), densifyM)
      newAnchorIndices = mapWaypointsToDensified(newAnchorIndices, merged.lats, merged.lons, dense.lats, dense.lons)
      routeLats = dense.lats
      routeLons = dense.lons
    }

    const anchors = origAnchorIndices.length >= 2 && newAnchorIndices.length >= 2
      ? { origIndices: origAnchorIndices, newIndices: newAnchorIndices }
      : undefined

    const finalEles = transferElevations(
      origState.gpx.lats, origState.gpx.lons, origState.gpx.eles,
      origState.dists, routeLats, routeLons,
      anchors,
    )
    ST.snapOrigIndices = origAnchorIndices

    // Commit
    ST.gpx = { ...ST.gpx, lats: routeLats, lons: routeLons, eles: finalEles }
    const rebuilt = rebuildRoute(routeLats, routeLons, finalEles, finalEles)
    ST.dists = rebuilt.dists instanceof Float64Array ? rebuilt.dists : new Float64Array(rebuilt.dists)
    ST.grOrig = rebuilt.grOrig
    ST.eleClean = [...finalEles]
    ST.grClean = rebuilt.grClean

    // Rebuild segments from committed route with monotonic search
    ST.routeSegments = rebuildSnapSegments(ST.snapWaypoints, routeLats, routeLons)
    ST.routeWaypoints = [...ST.snapWaypoints]

    invalidateFrom('snap')

    panels.snap.setProgress(`Added waypoint: ${ST.snapWaypoints.length} waypoints, ${routeLats.length} points`)
    sidebar.setStepStatus('snap', 'done', `${routeLats.length} pts`)

    refresh()
    drawMap()

    console.log(`[GPXForge] Snap: added waypoint at segment ${segIdx}, ${ST.snapWaypoints.length} total`)
  } catch (err) {
    console.warn(`[Snap] Add waypoint failed:`, err.message)
    panels.snap.setProgress(`Add waypoint failed: ${err.message}`)
    // Revert undo snapshot
    ST.snapDragHistory.pop()
    panels.snap.enableUndo(ST.snapDragHistory.length > 0)
  }
}

/**
 * Handle waypoint deletion — remove a waypoint and merge adjacent segments.
 * No re-routing needed — existing road geometry is preserved.
 *
 * @param {number} wpIdx — index of the waypoint to delete
 */
async function handleDeleteWaypoint(wpIdx) {
  if (!ST.gpx || !ST.snapWaypoints || ST.snapWaypoints.length < 3) return
  if (wpIdx < 0 || wpIdx >= ST.snapWaypoints.length) return

  const wps = ST.snapWaypoints

  // Save snapshot for undo
  ST.snapDragHistory.push({
    gpx: { ...ST.gpx, lats: [...ST.gpx.lats], lons: [...ST.gpx.lons], eles: [...ST.gpx.eles] },
    dists: ST.dists instanceof Float64Array ? new Float64Array(ST.dists) : [...ST.dists],
    grOrig: ST.grOrig ? [...ST.grOrig] : null,
    eleClean: ST.eleClean ? [...ST.eleClean] : null,
    grClean: ST.grClean ? [...ST.grClean] : null,
    routeSegments: ST.routeSegments.map(s => s.map(p => [...p])),
    snapWaypoints: wps.map(w => ({ ...w })),
  })
  panels.snap.enableUndo(true)

  panels.snap.setProgress(`Deleting waypoint ${wpIdx + 1}...`)

  try {
    // Merge adjacent segments — no re-routing needed.
    // The road geometry is already correct in existing segments.
    const allSegments = [...ST.routeSegments]

    if (wpIdx === 0) {
      // Deleting first waypoint: just remove the first segment
      allSegments.splice(0, 1)
    } else if (wpIdx === wps.length - 1) {
      // Deleting last waypoint: just remove the last segment
      allSegments.splice(allSegments.length - 1, 1)
    } else {
      // Middle waypoint: merge two segments into one
      const segBefore = ST.routeSegments[wpIdx - 1]
      const segAfter = ST.routeSegments[wpIdx]
      const mergedSeg = [...segBefore, ...segAfter.slice(1)] // skip junction duplicate
      allSegments.splice(wpIdx - 1, 2, mergedSeg)
    }

    // Remove the waypoint
    ST.snapWaypoints = [...wps.slice(0, wpIdx), ...wps.slice(wpIdx + 1)]

    // Merge all segments into route
    const merged = mergeSegments(allSegments)

    // Densify + transfer elevation
    const origState = ST.snapPreState
    if (!origState) return
    const origAnchorIndices = mapWaypointIndicesOnRoute(ST.snapWaypoints, origState.gpx.lats, origState.gpx.lons)
    let newAnchorIndices = mapWaypointIndicesOnRoute(ST.snapWaypoints, merged.lats, merged.lons)

    let routeLats = merged.lats
    let routeLons = merged.lons
    const densifyM = panels.snap.getDensify()
    if (densifyM > 0) {
      const dense = densifyRoute(merged.lats, merged.lons, new Array(merged.lats.length).fill(0), densifyM)
      newAnchorIndices = mapWaypointsToDensified(newAnchorIndices, merged.lats, merged.lons, dense.lats, dense.lons)
      routeLats = dense.lats
      routeLons = dense.lons
    }

    const anchors = origAnchorIndices.length >= 2 && newAnchorIndices.length >= 2
      ? { origIndices: origAnchorIndices, newIndices: newAnchorIndices }
      : undefined

    const finalEles = transferElevations(
      origState.gpx.lats, origState.gpx.lons, origState.gpx.eles,
      origState.dists, routeLats, routeLons,
      anchors,
    )
    ST.snapOrigIndices = origAnchorIndices

    // Commit
    ST.gpx = { ...ST.gpx, lats: routeLats, lons: routeLons, eles: finalEles }
    const rebuilt = rebuildRoute(routeLats, routeLons, finalEles, finalEles)
    ST.dists = rebuilt.dists instanceof Float64Array ? rebuilt.dists : new Float64Array(rebuilt.dists)
    ST.grOrig = rebuilt.grOrig
    ST.eleClean = [...finalEles]
    ST.grClean = rebuilt.grClean

    // Rebuild segments from the committed densified route — must use monotonic
    // forward search so switchback waypoints don't match the wrong road level.
    ST.routeSegments = rebuildSnapSegments(ST.snapWaypoints, routeLats, routeLons)
    ST.routeWaypoints = [...ST.snapWaypoints]

    invalidateFrom('snap')

    panels.snap.setProgress(`Deleted waypoint: ${routeLats.length} points — click route to reroute`)
    sidebar.setStepStatus('snap', 'done', `${routeLats.length} pts`)

    refresh()
    drawMap()

    console.log(`[GPXForge] Snap: deleted waypoint ${wpIdx + 1}, ${ST.snapWaypoints.length} remaining`)
  } catch (err) {
    console.warn(`[Snap] Waypoint delete reroute failed:`, err.message)
    panels.snap.setProgress(`Delete failed: ${err.message}`)
    ST.snapDragHistory.pop() // revert the snapshot we just saved
    panels.snap.enableUndo(ST.snapDragHistory.length > 0)
  }
}

// Undo last polyline drag
panels.snap.els.btnUndo.addEventListener('click', () => {
  if (ST.snapDragHistory.length === 0) return

  const snap = ST.snapDragHistory.pop()
  ST.gpx = snap.gpx
  ST.dists = snap.dists instanceof Float64Array ? snap.dists : new Float64Array(snap.dists)
  ST.grOrig = snap.grOrig
  ST.eleClean = snap.eleClean
  ST.grClean = snap.grClean
  ST.routeSegments = snap.routeSegments
  if (snap.snapWaypoints) {
    ST.snapWaypoints = snap.snapWaypoints
    ST.routeWaypoints = [...snap.snapWaypoints]
  }

  // Invalidate downstream
  invalidateFrom('snap')

  panels.snap.enableUndo(ST.snapDragHistory.length > 0)
  panels.snap.setProgress(`Undo drag (${ST.snapDragHistory.length} remaining)`)
  sidebar.setStepStatus('snap', 'done', `${ST.gpx.lats.length} pts`)

  refresh()
  drawMap()
  console.log(`[GPXForge] Snap: undo drag, ${ST.snapDragHistory.length} history entries left`)
})

// Revert to pre-snap state
panels.snap.els.btnRevert.addEventListener('click', () => {
  if (!ST.snapPreState) return

  ST.gpx = ST.snapPreState.gpx
  ST.dists = ST.snapPreState.dists
  ST.grOrig = ST.snapPreState.grOrig
  ST.eleClean = ST.snapPreState.eleClean
  ST.grClean = ST.snapPreState.grClean
  ST.snapPreState = null
  ST.snapDragHistory = []

  // Clear route state
  ST.routeWaypoints = []
  ST.routeSegments = []
  ST.snapWaypoints = []

  // Invalidate downstream
  invalidateFrom('snap')

  panels.snap.setProgress('Reverted to original route')
  panels.snap.showRevert(false)
  panels.snap.enableUndo(false)
  sidebar.setStepStatus('snap', 'none', null)

  refresh()
  mapFit()
  toolbar.updateButtons()
  console.log('[GPXForge] Snap: reverted to pre-snap state')
})

/**
 * Commit a snapped route to ST and rebuild derived arrays.
 */
function commitSnapRoute(newLats, newLons, newEles) {
  ST.gpx = { ...ST.gpx, lats: newLats, lons: newLons, eles: newEles }

  // Rebuild distances + gradients
  const { dists, grOrig, grClean } = rebuildRoute(newLats, newLons, newEles, newEles)
  ST.dists = dists instanceof Float64Array ? dists : new Float64Array(dists)
  ST.grOrig = grOrig
  ST.eleClean = [...newEles]
  ST.grClean = grClean

  // Reset viewport
  ST.viewStart = 0
  ST.viewEnd = 1

  // Clear route overlays (caller may re-populate for drag-to-reroute)
  ST.routeWaypoints = []
  ST.routeSegments = []

  // Invalidate downstream
  invalidateFrom('snap')

  refresh()
  mapFit()
  toolbar.updateButtons()
}

// ────────────────────────────────────────────────────────────────────
// Clean: Run / Reset
// ────────────────────────────────────────────────────────────────────

panels.clean.els.btnRun.addEventListener('click', () => {
  if (!ST.gpx) return

  // Warn if manual corrections exist — Run replaces all corrections
  if (ST.corrections && ST.corrections.some(c => c.source === 'manual')) {
    const n = ST.corrections.filter(c => c.source === 'manual').length
    if (!window.confirm(
      `${n} manual correction${n > 1 ? 's' : ''} will be replaced by auto-detect. Continue?`
    )) return
  }

  pushHistory('clean')

  // Gather params from all 3 Clean panel sections
  const det = panels.clean.getDetectionParams()
  const shape = panels.clean.getShapeParams()
  const suspect = panels.clean.getSuspectParams()
  const params = { ...det, ...shape, ...suspect }

  panels.clean.clearLog()

  // Pre-pass: if brunnels exist, clean brunnel zones first
  let osmCorrs = []
  let eleWork = ST.gpx.eles
  if (ST.brunnels && ST.brunnels.length > 0) {
    panels.clean.appendLog(`Pre-cleaning ${ST.brunnels.length} brunnel zones...`, 'i')
    const osmResult = buildBrunnelCorrections(ST.brunnels, ST.gpx.eles, ST.dists, shape, det.anchorT)
    eleWork = osmResult.eleClean
    osmCorrs = osmResult.corrections
    panels.clean.appendLog(`${osmCorrs.length} brunnel corrections applied`, 'i')
  }

  panels.clean.appendLog('Running spike detection...', 'i')
  const result = runCleaner(eleWork, ST.dists, params, ST.brunnels || [])

  // Filter out LIDAR corrections that overlap OSM zones
  let lidarCorrs = result.corrections
  if (osmCorrs.length > 0) {
    lidarCorrs = lidarCorrs.filter(c =>
      !osmCorrs.some(o => !(c.ahi <= o.alo || c.alo >= o.ahi))
    )
  }

  // Combine: OSM corrections first, then LIDAR
  const allCorrs = [...osmCorrs, ...lidarCorrs]
  allCorrs.sort((a, b) => a.alo - b.alo)

  // Update state — use the LIDAR-cleaned eleClean directly.
  // Brunnel zones are already smooth from the pre-pass, so the LIDAR cleaner
  // preserves them (no spikes to detect). No second brunnel pass needed —
  // re-running on LIDAR-cleaned gradients would find wrong anchors (prototype
  // commit 83204ee confirmed this fails for long tunnels).
  ST.eleClean = result.eleClean
  applySourceAwareDipSmoothing('clean')
  ST.corrections = allCorrs
  ST.grClean = grads(ST.eleClean, ST.dists)
  ST.selectedCorr = null

  // Invalidate downstream
  const hadSmooth = !!ST.smoothedRoute
  ST.smoothedRoute = null
  ST.eleSmoothed = null
  ST.grSmoothed = null

  // Log results
  const nSuspect = allCorrs.filter(c => c.type === 'suspect').length
  const nOsm = osmCorrs.length
  const nBrunnel = lidarCorrs.filter(c => c.type === 'bridge' || c.type === 'tunnel').length
  const nArtifact = lidarCorrs.filter(c => c.type !== 'suspect' && c.type !== 'bridge' && c.type !== 'tunnel').length
  const parts = [`Found ${allCorrs.length} corrections`]
  if (nOsm > 0) parts.push(`${nOsm} OSM brunnels`)
  if (nBrunnel > 0) parts.push(`${nBrunnel} brunnel-matched`)
  if (nArtifact > 0) parts.push(`${nArtifact} artifacts`)
  if (nSuspect > 0) parts.push(`${nSuspect} suspect`)
  panels.clean.appendLog(parts.join(', '), 's')

  // Enable reset and vegetation filter
  panels.clean.els.btnReset.disabled = false
  panels.clean.enableRunVeg(true)

  // Rebuild corrections list
  corrPanel.rebuild()
  updateCleanStatus()

  // Mark smooth as stale if it was applied
  if (hadSmooth) {
    sidebar.setStepStatus('smooth', 'warn', 'stale')
    panels.smooth.enableRevert(false)
  }

  refresh()
  toolbar.updateButtons()
  console.log(`[GPXForge] Clean: ${allCorrs.length} corrections (${nOsm} OSM, ${nBrunnel + nOsm} brunnels, ${nArtifact} artifacts)`)
})

panels.clean.els.btnReset.addEventListener('click', () => {
  if (!ST.gpx) return
  pushHistory('clean')

  // Reset to raw elevations
  ST.eleClean = ST.gpx.eles.slice()
  ST.corrections = []
  ST.grClean = grads(ST.eleClean, ST.dists)
  ST.selectedCorr = null

  // Invalidate downstream
  const hadSmooth = !!ST.smoothedRoute
  ST.smoothedRoute = null
  ST.eleSmoothed = null
  ST.grSmoothed = null

  panels.clean.clearLog()
  panels.clean.appendLog('Reset to raw elevations', 'i')
  panels.clean.els.btnReset.disabled = true
  panels.clean.enableRunVeg(false)

  corrPanel.rebuild()
  sidebar.setStepStatus('clean', 'none', null)

  if (hadSmooth) {
    sidebar.setStepStatus('smooth', 'warn', 'stale')
    panels.smooth.enableRevert(false)
  }

  refresh()
  toolbar.updateButtons()
  console.log('[GPXForge] Clean: reset')
})

// ────────────────────────────────────────────────────────────────────
// Vegetation filter: Run Veg Filter button
// ────────────────────────────────────────────────────────────────────

panels.clean.els.btnRunVeg.addEventListener('click', () => {
  if (!ST.eleClean) return

  const vegParams = panels.clean.getVegParams()
  if (!vegParams.enabled) {
    panels.clean.appendLog('Vegetation filter is disabled.', 'i')
    return
  }

  const brunnelMask = ST.brunnels && ST.brunnels.length
    ? buildBrunnelMask(ST.brunnels, ST.dists)
    : null

  const origEles = ST.eleClean.slice()

  const vegResult = filterVegetation(ST.eleClean, ST.dists, {
    spikeThresholdM: vegParams.spikeThresholdM,
  }, brunnelMask)

  if (vegResult.diagnostics.totalFlagged > 0) {
    ST.eleClean = vegResult.eles
    applySourceAwareDipSmoothing('veg')
    ST.grClean = grads(ST.eleClean, ST.dists)
    ST.smoothedRoute = null
    ST.eleSmoothed = null
    ST.grSmoothed = null

    const report = vegetationReport(ST.dists, origEles, ST.eleClean, vegResult.diagnostics.regions)
    panels.clean.appendLog(report, 's')

    sidebar.setStepStatus('smooth', ST.smoothedRoute ? 'warn' : 'none', ST.smoothedRoute ? 'stale' : null)
    corrPanel.rebuild()
    updateCleanStatus()
    refresh()
    toolbar.updateButtons()
    console.log('[GPXForge] Veg filter:', vegResult.diagnostics.regions.length, 'regions,', vegResult.diagnostics.totalFlagged, 'pts')
  } else {
    panels.clean.appendLog('Vegetation filter: no artifacts detected.', 'i')
  }
})

// ────────────────────────────────────────────────────────────────────
// Smooth: Apply / Revert
// ────────────────────────────────────────────────────────────────────

panels.smooth.els.btnApply.addEventListener('click', () => {
  if (!ST.gpx) return

  // Re-apply after initial process: extra Z-only smoothing pass (no XY changes).
  if (ST.smoothedRoute) {
    const extra = runElevationOnlySmoothing(ST.smoothedRoute, 4)
    ST.smoothedRoute = extra.route
    ST.eleSmoothed = extra.route.eles
    ST.grSmoothed = new Float64Array(extra.route.gr)

    // Split depends on gradient profile — mark stale.
    ST.splitAnalysis = null
    ST.splitSegments = null
    panels.split.hideResults()
    sidebar.setStepStatus('split', 'none', null)

    // New baseline for simplify history.
    clearSimplifyHistory()
    simplifyLog.length = 0
    panels.smooth.hideSimplifyLog()

    panels.smooth.showStats(extra.stats)
    panels.smooth.enableRevert(true)
    panels.smooth.enableSimplify(true)
    sidebar.setStepStatus('smooth', 'done', `${extra.stats.ptsAfter} pts (Z-only)`)

    refresh()
    toolbar.updateButtons()
    console.log('[GPXForge] Process: applied additional Z-only smoothing pass')
    return
  }

  // Safety net: auto-trim start/end overlap before smoothing.
  // Catches overlap from snap, drag-reroute, or any other source.
  const overlap = detectStartEndOverlap(ST.gpx.lats, ST.gpx.lons)
  if (overlap) {
    console.log(`[GPXForge] Auto-trimmed ${overlap.overlapCount} overlapping points at start/finish`)
    ST.gpx.lats = ST.gpx.lats.slice(0, overlap.overlapStartIdx)
    ST.gpx.lons = ST.gpx.lons.slice(0, overlap.overlapStartIdx)
    ST.gpx.eles = ST.gpx.eles.slice(0, overlap.overlapStartIdx)
    if (ST.eleClean) ST.eleClean = ST.eleClean.slice(0, overlap.overlapStartIdx)
    ST.dists = new Float64Array(cumulativeDistances(ST.gpx.lats, ST.gpx.lons))
    ST.grOrig = grads(ST.gpx.eles, ST.dists)
    ST.grClean = ST.eleClean ? grads(ST.eleClean, ST.dists) : ST.grOrig
  }

  const baseEles = ST.eleClean || ST.gpx.eles

  // Run full processGPX pipeline
  const result = runSmoothing(ST.gpx.lats, ST.gpx.lons, baseEles, ST.dists, {
    origAvgSpacing: ST.origAvgSpacing,
  })

  // Store as overlay — DON'T replace active route, DON'T clear corrections/history
  ST.smoothedRoute = {
    lats: result.lats,
    lons: result.lons,
    eles: result.eleSmoothed,
    dists: new Float64Array(result.dists),
    gr: new Float64Array(result.grSmoothed),
    origDists: new Float64Array(result.origDists),
  }
  ST.eleSmoothed = result.eleSmoothed
  ST.grSmoothed = new Float64Array(result.grSmoothed)

  // Invalidate split (indices no longer match)
  ST.splitAnalysis = null
  ST.splitSegments = null
  panels.split.hideResults()
  sidebar.setStepStatus('split', 'none', null)

  // Clear any previous simplify history and log
  clearSimplifyHistory()
  simplifyLog.length = 0
  panels.smooth.hideSimplifyLog()

  panels.smooth.showStats(result.stats)
  panels.smooth.enableRevert(true)
  panels.smooth.enableSimplify(true)
  sidebar.setStepStatus('smooth', 'done', `${result.stats.ptsOrig}\u2192${result.stats.ptsAfter} pts`)

  refresh()
  toolbar.updateButtons()
  console.log(`[GPXForge] Process: ${result.stats.ptsOrig}\u2192${result.stats.ptsAfter} points`)
})

panels.smooth.els.btnRevert.addEventListener('click', () => {
  if (!ST.smoothedRoute) return

  // Clear smoothed overlay — active route is unchanged
  ST.smoothedRoute = null
  ST.eleSmoothed = null
  ST.grSmoothed = null

  // Invalidate split (indices no longer match)
  ST.splitAnalysis = null
  ST.splitSegments = null
  panels.split.hideResults()
  sidebar.setStepStatus('split', 'none', null)

  // Clear simplify history and log
  clearSimplifyHistory()
  simplifyLog.length = 0

  panels.smooth.hideStats()
  panels.smooth.hideSimplifyLog()
  panels.smooth.enableRevert(false)
  panels.smooth.enableSimplify(false)
  sidebar.setStepStatus('smooth', 'none', null)

  refresh()
  toolbar.updateButtons()
  console.log('[GPXForge] Process: reverted')
})

// ── Simplify button ──

panels.smooth.els.btnSimplify.addEventListener('click', () => {
  if (!ST.smoothedRoute) return

  // On first simplify, snapshot the Process baseline
  const baseline = ST.simplifyStack.length === 0
    ? {
        smoothedRoute: {
          lats: [...ST.smoothedRoute.lats],
          lons: [...ST.smoothedRoute.lons],
          eles: [...ST.smoothedRoute.eles],
          dists: new Float64Array(ST.smoothedRoute.dists),
          gr: new Float64Array(ST.smoothedRoute.gr),
          ...(ST.smoothedRoute.origDists ? { origDists: new Float64Array(ST.smoothedRoute.origDists) } : {}),
        },
        eleSmoothed: [...ST.eleSmoothed],
        grSmoothed: new Float64Array(ST.grSmoothed),
      }
    : null

  const before = ST.smoothedRoute.lats.length
  const result = runSimplify(ST.smoothedRoute)

  // Update state
  ST.smoothedRoute = result.route
  ST.eleSmoothed = result.route.eles
  ST.grSmoothed = result.route.gr

  // Push to undo stack (baseline + new state)
  pushSimplifyState(baseline)

  // Track in log
  simplifyLog.push({ before, after: result.route.lats.length, removed: result.removedCount })
  updateSimplifyUI()

  refresh()
  toolbar.updateButtons()
  console.log(`[GPXForge] Simplify: ${before}\u2192${result.route.lats.length} (\u2212${result.removedCount})`)
})

// ────────────────────────────────────────────────────────────────────
// Corrections: Accept / Reject / Select / Remove
// ────────────────────────────────────────────────────────────────────

function handleSelectCorr(ci) {
  ST.selectedCorr = ci
  corrPanel.setSelected(ci)
  zoomToCorr(ci)
  drawAll()
  drawMap()
}

function handleAcceptCorr(ci) {
  if (!ST.corrections || ci < 0 || ci >= ST.corrections.length) return
  pushHistory('clean')

  const c = ST.corrections[ci]

  if (c.accepted) {
    // Undo accept → restore raw LIDAR elevation
    c.accepted = false
    restoreRawElevation(c)
  } else {
    // Accept → apply interpolation
    c.accepted = true
    c.rejected = false

    // For suspects, use uniform (linear) interpolation
    if (c.type === 'suspect' && c.interp === 'none') {
      c.interp = 'uniform'
    }

    applyInterp(ST.eleClean, ST.dists, c.alo, c.ahi, c)
  }

  ST.grClean = grads(ST.eleClean, ST.dists)
  invalidateSmooth()
  corrPanel.rebuild()
  corrPanel.setSelected(ci)
  updateCleanStatus()
  refresh()
  toolbar.updateButtons()
}

function handleRejectCorr(ci) {
  if (!ST.corrections || ci < 0 || ci >= ST.corrections.length) return
  pushHistory('clean')

  const c = ST.corrections[ci]

  if (c.rejected) {
    // Undo reject → re-apply interpolation
    c.rejected = false
    if (c.accepted) {
      applyInterp(ST.eleClean, ST.dists, c.alo, c.ahi, c)
    }
  } else {
    // Reject → restore raw LIDAR elevation
    c.rejected = true
    c.accepted = false
    restoreRawElevation(c)
  }

  ST.grClean = grads(ST.eleClean, ST.dists)
  invalidateSmooth()
  corrPanel.rebuild()
  corrPanel.setSelected(ci)
  updateCleanStatus()
  refresh()
  toolbar.updateButtons()
}

function handleRemoveCorr(ci) {
  if (!ST.corrections || ci < 0 || ci >= ST.corrections.length) return
  pushHistory('clean')

  const c = ST.corrections[ci]
  restoreRawElevation(c)

  // Remove from array
  ST.corrections.splice(ci, 1)

  // Fix selected index
  if (ST.selectedCorr === ci) ST.selectedCorr = null
  else if (ST.selectedCorr > ci) ST.selectedCorr--

  ST.grClean = grads(ST.eleClean, ST.dists)
  invalidateSmooth()
  corrPanel.rebuild()
  updateCleanStatus()
  refresh()
  toolbar.updateButtons()
}

// ────────────────────────────────────────────────────────────────────
// Chart external actions: drag anchor, draw correction
// ────────────────────────────────────────────────────────────────────

/**
 * Handle anchor drag committed from chart.
 * @param {number} corrIdx — correction index
 * @param {string} which — 'lo' or 'hi' (which anchor was dragged)
 * @param {number} newIdx — new point index for the anchor
 */
function handleCommitDrag(corrIdx, which, newIdx) {
  if (!ST.corrections || corrIdx < 0 || corrIdx >= ST.corrections.length) return
  pushHistory('clean')

  const c = ST.corrections[corrIdx]
  const oldAlo = c.alo
  const oldAhi = c.ahi

  if (which === 'lo') c.alo = newIdx
  else c.ahi = newIdx

  // Ensure alo < ahi
  if (c.alo >= c.ahi) {
    if (which === 'lo') c.alo = c.ahi - 1
    else c.ahi = c.alo + 1
  }

  // Recalculate span and grade
  c.span = ST.dists[c.ahi] - ST.dists[c.alo]
  c.grade = c.span > 0 ? (ST.gpx.eles[c.ahi] - ST.gpx.eles[c.alo]) / c.span * 100 : 0

  // Re-classify if smart mode and not suspect
  if (c.type !== 'suspect') {
    const shape = panels.clean.getShapeParams()
    const struct = classifyStructure(ST.gpx.eles, ST.dists, c.alo, c.ahi, shape)
    c.type = struct.type
    c.interp = struct.interp
    c.m0 = struct.m0
    c.m1 = struct.m1
  }

  // Re-apply interpolation if accepted
  if (c.accepted) {
    restoreRawElevationRange(Math.min(oldAlo, c.alo), Math.max(oldAhi, c.ahi))
    applyInterp(ST.eleClean, ST.dists, c.alo, c.ahi, c)
  }

  ST.grClean = grads(ST.eleClean, ST.dists)
  invalidateSmooth()
  corrPanel.rebuild()
  corrPanel.setSelected(corrIdx)
  updateCleanStatus()
  refresh()
  toolbar.updateButtons()
}

/**
 * Handle draw-mode correction created from chart.
 * @param {number} alo — zone start index
 * @param {number} ahi — zone end index
 */
function handleCommitDraw(alo, ahi) {
  if (!ST.gpx || !ST.eleClean || !ST.corrections) return

  // Reset draw button style (draw mode ended on second click)
  const btn = panels.clean.els.btnDraw
  btn.style.background = ''
  btn.style.color = ''

  pushHistory('clean')

  // Ensure alo < ahi
  if (alo > ahi) [alo, ahi] = [ahi, alo]

  // Classify the drawn zone
  const shape = panels.clean.getShapeParams()
  const struct = classifyStructure(ST.gpx.eles, ST.dists, alo, ahi, shape)

  const span = ST.dists[ahi] - ST.dists[alo]
  const grade = span > 0 ? (ST.gpx.eles[ahi] - ST.gpx.eles[alo]) / span * 100 : 0

  // Apply interpolation
  applyInterp(ST.eleClean, ST.dists, alo, ahi, struct)

  // Build correction record
  const correction = {
    alo, ahi, span, grade,
    type: struct.type, interp: struct.interp,
    m0: struct.m0, m1: struct.m1,
    revRate: 0, meanGr: 0,
    accepted: true, rejected: false, source: 'manual',
  }

  // Insert sorted by alo
  let insertIdx = ST.corrections.findIndex(c => c.alo > alo)
  if (insertIdx < 0) insertIdx = ST.corrections.length
  ST.corrections.splice(insertIdx, 0, correction)

  ST.selectedCorr = insertIdx
  ST.grClean = grads(ST.eleClean, ST.dists)
  invalidateSmooth()
  corrPanel.rebuild()
  corrPanel.setSelected(insertIdx)
  updateCleanStatus()
  refresh()
  toolbar.updateButtons()
  console.log(`[GPXForge] Manual correction at [${alo}–${ahi}]`)
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Restore raw LIDAR elevations within a correction zone.
 */
function restoreRawElevation(c) {
  restoreRawElevationRange(c.alo, c.ahi)
}

/**
 * Restore raw LIDAR elevations for an explicit inclusive index range.
 */
function restoreRawElevationRange(alo, ahi) {
  if (!ST.gpx || !ST.eleClean) return
  const lo = Math.max(0, Math.min(alo, ahi))
  const hi = Math.min(ST.gpx.eles.length - 1, Math.max(alo, ahi))
  for (let i = lo; i <= hi; i++) {
    ST.eleClean[i] = ST.gpx.eles[i]
  }
}

/**
 * Remap downstream pipeline state (corrections, brunnels, smoothedRoute) after a
 * start or end trim — preserving pipeline work instead of discarding it.
 *
 * Must be called AFTER ST.gpx / ST.dists / ST.eleClean have been committed
 * to the new trimmed values, but uses oldDists to compute proportions.
 *
 * @param {'start'|'end'} trimType
 * @param {number} idxA — trim marker A (lower, in old route)
 * @param {number} idxB — trim marker B (higher, in old route)
 * @param {Float64Array} oldDists — cumulative distances BEFORE trim
 */
function remapDownstreamAfterTrim(trimType, idxA, idxB, oldDists) {
  const oldTotal = oldDists[oldDists.length - 1]
  const shift = trimType === 'start' ? idxB : 0
  const keepLo = trimType === 'start' ? oldDists[idxB] : 0
  const keepHi = trimType === 'end' ? oldDists[idxA] : oldTotal
  const newN = ST.gpx.lats.length

  // ── Corrections ──
  if (ST.corrections && ST.corrections.length > 0) {
    ST.corrections = ST.corrections
      .filter(c => trimType === 'start' ? c.ahi > idxB : c.alo < idxA)
      .map(c => ({
        ...c,
        alo: Math.max(0, c.alo - shift),
        ahi: Math.min(newN - 1, c.ahi - shift),
      }))
      .filter(c => c.ahi > c.alo)
    corrPanel.rebuild()
  }

  // ── Brunnels ──
  if (ST.brunnels && ST.brunnels.length > 0) {
    const newTotal = ST.dists[ST.dists.length - 1]
    ST.brunnels = ST.brunnels
      .filter(b => b.startDist < keepHi && b.endDist > keepLo)
      .map(b => ({
        ...b,
        alo: Math.max(0, b.alo - shift),
        ahi: Math.min(newN - 1, b.ahi - shift),
        startDist: Math.max(0, b.startDist - keepLo),
        endDist: Math.min(newTotal, b.endDist - keepLo),
      }))
      .filter(b => b.ahi > b.alo)
    sidebar.setStepStatus('brunnels', 'done', `${ST.brunnels.length} structures`)
  }

  // ── Smoothed route ──
  if (ST.smoothedRoute) {
    const sr = ST.smoothedRoute
    const M = sr.lats.length
    const smoothTotal = sr.dists[M - 1]
    const smoothLo = keepLo / oldTotal * smoothTotal
    const smoothHi = keepHi / oldTotal * smoothTotal

    const loIdx = bsearchDists(sr.dists, smoothLo)
    const hiIdx = Math.min(M - 1, bsearchDists(sr.dists, smoothHi))

    if (hiIdx > loIdx) {
      const distOffset = sr.dists[loIdx]
      const origOffset = sr.origDists ? sr.origDists[loIdx] : 0

      ST.smoothedRoute = {
        lats: sr.lats.slice(loIdx, hiIdx + 1),
        lons: sr.lons.slice(loIdx, hiIdx + 1),
        eles: sr.eles.slice(loIdx, hiIdx + 1),
        dists: new Float64Array(Array.from(sr.dists.slice(loIdx, hiIdx + 1)).map(d => d - distOffset)),
        gr: new Float64Array(sr.gr.slice(loIdx, hiIdx + 1)),
        origDists: sr.origDists
          ? new Float64Array(Array.from(sr.origDists.slice(loIdx, hiIdx + 1)).map(d => d - origOffset))
          : null,
      }
      ST.eleSmoothed = ST.smoothedRoute.eles
      ST.grSmoothed = ST.smoothedRoute.gr
    } else {
      invalidateSmooth()
    }
  }

  // Split is always stale after any trim
  if (ST.splitAnalysis) {
    ST.splitAnalysis = null
    ST.splitSegments = null
    panels.split.hideResults()
    sidebar.setStepStatus('split', 'none', null)
  }
}

/**
 * Invalidate all pipeline results from a given step downstream.
 * Call after Trim or Snap modifies the route.
 */
function invalidateFrom(step) {
  const order = ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split']
  const idx = order.indexOf(step)
  if (idx < 0) return
  if (idx <= 2) {
    ST.brunnels = null
    panels.brunnels.hideResults()
    sidebar.setStepStatus('brunnels', 'warn', 'stale')
  }
  if (idx <= 3) {
    ST.corrections = []
    ST.selectedCorr = null
    if (ST.gpx) {
      ST.eleClean = ST.gpx.eles.slice()
      ST.grClean = grads(ST.eleClean, ST.dists)
    }
    corrPanel.rebuild()
    sidebar.setStepStatus('clean', 'none', null)
    panels.clean.els.btnReset.disabled = true
    panels.clean.clearLog()
  }
  if (idx <= 4) {
    invalidateSmooth()
  }
  if (idx <= 5 && ST.splitAnalysis) {
    ST.splitAnalysis = null
    ST.splitSegments = null
    panels.split.hideResults()
    sidebar.setStepStatus('split', 'none', null)
  }
}

/**
 * Invalidate smooth results and mark as stale if was active.
 */
function invalidateSmooth() {
  if (ST.smoothedRoute || ST.eleSmoothed) {
    ST.smoothedRoute = null
    ST.eleSmoothed = null
    ST.grSmoothed = null
    sidebar.setStepStatus('smooth', 'warn', 'stale')
    panels.smooth.enableRevert(false)
    panels.smooth.hideStats()
  }
}

// ────────────────────────────────────────────────────────────────────
// Draw mode keyboard shortcut
// ────────────────────────────────────────────────────────────────────

function toggleDrawMode() {
  if (ST.activeStep !== 'clean') return
  if (!ST.gpx) return

  // Auto-init eleClean if not yet run
  if (!ST.eleClean) {
    ST.eleClean = ST.gpx.eles.slice()
    ST.grClean = grads(ST.eleClean, ST.dists)
    ST.corrections = []
  }

  ST.drawMode = !ST.drawMode
  ST.drawAnchor1 = null
  ST.drawCursorIdx = null

  // Update button style
  const btn = panels.clean.els.btnDraw
  if (ST.drawMode) {
    btn.style.background = 'var(--amber)'
    btn.style.color = '#fff'
    panels.clean.appendLog('Draw mode ON — click two points on chart', 'i')
  } else {
    btn.style.background = ''
    btn.style.color = ''
    panels.clean.appendLog('Draw mode OFF', 'i')
  }

  drawAll()
}

panels.clean.els.btnDraw.addEventListener('click', toggleDrawMode)

document.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return

  if (ev.key === 'd' || ev.key === 'D') {
    toggleDrawMode()
  }
})

// ────────────────────────────────────────────────────────────────────
// Brunnels: Fetch / Go to Cleaner / Clear
// ────────────────────────────────────────────────────────────────────

panels.brunnels.els.btnFetch.addEventListener('click', async () => {
  if (!ST.gpx) return

  const params = panels.brunnels.getParams()
  panels.brunnels.els.btnFetch.disabled = true
  panels.brunnels.els.progress.set(5)

  try {
    const result = await locateBrunnels(
      ST.gpx.lats, ST.gpx.lons, ST.dists, ST.gpx.eles,
      params,
      (pct, msg) => {
        panels.brunnels.els.progress.set(pct)
      },
    )

    ST.brunnels = result

    // Render list
    if (result.length > 0) {
      const items = result.map((b) => {
        const span = ((b.endDist - b.startDist) || 0).toFixed(0)
        const icon = b.type === 'bridge' ? '🌉' : '🚇'
        return { html: `${icon} <b>${b.name || b.type}</b> — ${span}m [${b.alo}–${b.ahi}]` }
      })
      panels.brunnels.setListItems(items, (idx) => {
        zoomToBrunnel(idx)
        drawAll()
      })
      panels.brunnels.showResults(result.length)
      sidebar.setStepStatus('brunnels', 'done', `${result.length} found`)
    } else {
      panels.brunnels.setList('<div style="font-size:10px;color:var(--muted)">No structures found</div>')
      panels.brunnels.showResults(0)
      sidebar.setStepStatus('brunnels', 'done', '0 found')
    }

    // Update map overlays
    drawMap()
    console.log(`[GPXForge] Brunnels: located ${result.length}`)
  } catch (err) {
    panels.brunnels.setList(`<div style="font-size:10px;color:#d03030">Error: ${err.message}</div>`)
    panels.brunnels.showResults(0)
    sidebar.setStepStatus('brunnels', 'warn', 'error')
    console.error('[GPXForge] Brunnels error:', err)
  } finally {
    panels.brunnels.els.btnFetch.disabled = false
    panels.brunnels.els.progress.set(0)
  }
})

panels.brunnels.els.btnGo.addEventListener('click', () => {
  if (!ST.brunnels || ST.brunnels.length === 0) {
    sidebar.setActiveStep('clean')
    shell.setInfoStep('clean')
    return
  }

  // Build corrections from brunnels and pre-seed the cleaner
  pushHistory('clean')

  const shapeParams = panels.clean.getShapeParams()
  const detParams = panels.clean.getDetectionParams()
  const result = buildBrunnelCorrections(ST.brunnels, ST.gpx.eles, ST.dists, shapeParams, detParams.anchorT)

  // Replace eleClean with brunnel-cleaned elevations
  ST.eleClean = result.eleClean
  ST.grClean = grads(ST.eleClean, ST.dists)

  // Merge brunnel corrections with any existing corrections
  // Filter out existing corrections that overlap with brunnel zones
  const existing = (ST.corrections || []).filter(c =>
    !result.corrections.some(o => !(c.ahi <= o.alo || c.alo >= o.ahi))
  )
  ST.corrections = [...result.corrections, ...existing]
  ST.corrections.sort((a, b) => a.alo - b.alo)
  ST.selectedCorr = null

  // Invalidate smooth
  invalidateSmooth()

  // Switch to Clean step
  sidebar.setActiveStep('clean')
  shell.setInfoStep('clean')

  corrPanel.rebuild()
  updateCleanStatus()
  refresh()
  toolbar.updateButtons()
  console.log(`[GPXForge] Brunnels: pre-seeded ${result.corrections.length} corrections`)
})

panels.brunnels.els.btnClear.addEventListener('click', () => {
  ST.brunnels = null
  panels.brunnels.hideResults()
  sidebar.setStepStatus('brunnels', 'none', null)
  drawMap()
  console.log('[GPXForge] Brunnels: cleared')
})

// ────────────────────────────────────────────────────────────────────
// Split: Analyze / Presets / Custom / Download
// ────────────────────────────────────────────────────────────────────

panels.split.els.btnAnalyze.addEventListener('click', () => {
  if (!ST.gpx) return

  const { power, mass, groupRide } = panels.split.getParams()
  const useSmoothed = !!ST.smoothedRoute
  const lats = useSmoothed ? ST.smoothedRoute.lats : ST.gpx.lats
  const lons = useSmoothed ? ST.smoothedRoute.lons : ST.gpx.lons
  const eles = useSmoothed ? ST.smoothedRoute.eles : (ST.eleClean || ST.gpx.eles)

  const result = analyzeRoute(lats, lons, eles, power, mass, groupRide)
  ST.splitAnalysis = result
  ST.splitSegments = null

  // Summary text
  const avgSpeedSolo = (result.totalDist / 1000) / (result.soloTime / 3600)
  const avgSpeedGroup = (result.totalDist / 1000) / (result.totalTime / 3600)
  const saved = result.soloTime - result.totalTime
  const pctFaster = result.soloTime > 0 ? (saved / result.soloTime) * 100 : 0

  let summary = `Solo: ${fmtTimeLong(result.soloTime)} (${avgSpeedSolo.toFixed(1)} km/h)`
  if (groupRide) {
    summary += ` | Group: ${fmtTimeLong(result.totalTime)} (${avgSpeedGroup.toFixed(1)} km/h, ${pctFaster.toFixed(1)}% faster)`
  }

  panels.split.showTimeSummary(summary)
  panels.split.showSplitDuration(`Total: ${fmtTimeLong(result.totalTime)} · ${(result.totalDist / 1000).toFixed(1)} km`)
  sidebar.setStepStatus('split', 'done', fmtTimeLong(result.totalTime))

  // Render analysis summary into the split info panel
  const totalDist = (result.totalDist / 1000).toFixed(1)
  const totalClimb = Math.round(result.totalClimb || 0)
  let analysisHtml = `<div style="font-weight:600;font-size:12px;margin-bottom:6px;font-family:var(--font-sans)">Route Analysis</div>`
  analysisHtml += `<div>Distance: ${totalDist} km</div>`
  analysisHtml += `<div>Climbing: ${totalClimb} m</div>`
  analysisHtml += `<div>Solo: ${fmtTimeLong(result.soloTime)} (${avgSpeedSolo.toFixed(1)} km/h)</div>`
  if (groupRide) {
    analysisHtml += `<div>Group: ${fmtTimeLong(result.totalTime)} (${avgSpeedGroup.toFixed(1)} km/h)</div>`
    analysisHtml += `<div>Draft saving: ${pctFaster.toFixed(1)}%</div>`
  }
  analysisHtml += `<div style="margin-top:8px;color:var(--muted);font-size:10px">Select a duration preset or enter custom minutes to generate splits</div>`
  panels.split.showAnalysis(analysisHtml)

  console.log(`[GPXForge] Split analysis: ${fmtTimeLong(result.totalTime)} (${power}W, ${mass}kg)`)
})

// Preset split buttons (30, 45, 60, 90, 120 min)
const presetBtns = panels.split.els.presetsGrid.querySelectorAll('button')
presetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!ST.splitAnalysis) return
    const mins = parseInt(btn.textContent)
    if (!mins) return
    applySplit(mins * 60)
  })
})

// Custom split button
panels.split.els.btnCustomSplit.addEventListener('click', () => {
  if (!ST.splitAnalysis) return
  const mins = parseInt(panels.split.els.customMinInput.value)
  if (!mins || mins < 1) return
  applySplit(mins * 60)
})

// Download All GPX button
panels.split.els.btnDownloadAll.addEventListener('click', downloadAllSplits)

/**
 * Apply split at target seconds, render results in info panel.
 */
function applySplit(targetSec) {
  const splits = generateSplits(ST.splitAnalysis, targetSec)
  ST.splitSegments = splits

  // Hide analysis summary when showing segments
  panels.split.clearAnalysis()

  // Populate the panel builder's splitsList
  const listEl = panels.split.els.splitsList
  listEl.innerHTML = ''
  splits.forEach((s, i) => {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border);font-size:10px;font-family:var(--font-mono)'
    const num = `${i + 1}`.padStart(2, '0')
    const time = fmtTimeLong(s.time)
    const dist = (s.dist / 1000).toFixed(1) + ' km'
    const climb = Math.round(s.climb) + ' m\u2191'
    const speed = (s.avgSpeed * 3.6).toFixed(1) + ' km/h'
    row.innerHTML = `<span style="color:var(--muted)">#${num}</span> <span>${time}</span> <span>${dist}</span> <span>${climb}</span> <span style="color:var(--muted)">${speed}</span>`
    const dlBtn = document.createElement('button')
    dlBtn.className = 'tb-btn tb-btn-ghost'
    dlBtn.textContent = '\u2193'
    dlBtn.title = `Download segment ${i + 1}`
    dlBtn.style.cssText = 'margin-left:auto;font-size:9px;padding:1px 6px;min-width:auto'
    dlBtn.addEventListener('click', () => downloadSplit(i))
    row.appendChild(dlBtn)
    listEl.appendChild(row)
  })

  // Update header count and show results section
  panels.split.els.splitResults.querySelector('.tb-status').textContent = `${splits.length} Segments`
  panels.split.showResults()
}

/**
 * Download a single split segment as GPX.
 */
function downloadSplit(idx) {
  if (!ST.splitSegments || !ST.gpx) return
  const s = ST.splitSegments[idx]
  const useSmoothed = !!ST.smoothedRoute
  const srcLats = useSmoothed ? ST.smoothedRoute.lats : ST.gpx.lats
  const srcLons = useSmoothed ? ST.smoothedRoute.lons : ST.gpx.lons
  const srcEles = useSmoothed ? ST.smoothedRoute.eles : (ST.eleClean || ST.gpx.eles)
  const lats = srcLats.slice(s.startIdx, s.endIdx + 1)
  const lons = srcLons.slice(s.startIdx, s.endIdx + 1)
  const eles = srcEles.slice(s.startIdx, s.endIdx + 1)
  const base = ST.filename.replace(/\.gpx$/i, '') || 'route'
  const gpxStr = buildGPXString(lats, lons, eles, `${base}_split${idx + 1}`)
  downloadGPX(gpxStr, `${base}_split${idx + 1}.gpx`)
}

/**
 * Download all split segments as individual GPX files.
 */
function downloadAllSplits() {
  if (!ST.splitSegments) return
  for (let i = 0; i < ST.splitSegments.length; i++) {
    downloadSplit(i)
  }
}

