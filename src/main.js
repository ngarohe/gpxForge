/**
 * GPXForge — main entry point
 *
 * Boots the application: builds UI shell, wires sidebar + toolbar,
 * waits for GPX file load, then initialises chart + map.
 *
 * Phase 8d-2: wires Clean, Smooth, Split, Brunnels.
 */

import { ST } from './state.js'
import { pushHistory, performUndo, performRedo,
  pushSimplifyState, undoSimplify, redoSimplify,
  canUndoSimplify, canRedoSimplify, clearSimplifyHistory } from './state.js'
import { grads, cumulativeDistances, bsearchDists, densifyRoute } from './utils/math.js'
import { fmtTimeLong } from './utils/format.js'
import { detectTrimType, executeTrim, rebuildRoute, trimGapDistance, trimSnapshot } from './pipeline/0-trim.js'
import { nearestGpxIndexForward, mergeSegments, transferElevations, autoSnap, mapWaypointsToDensified } from './pipeline/1-snap.js'
import { valhallaMulti } from './api/valhalla.js'
import { locateBrunnels, buildBrunnelCorrections } from './pipeline/2-brunnels.js'
import { runCleaner, applyInterp, classifyStructure } from './pipeline/3-clean.js'
import { filterVegetation, vegetationReport } from './pipeline/3.5-vegetation.js'
import { runSourceAwareDipSmoothing } from './pipeline/3.6-source-dip-smooth.js'
import { runSmoothing, runSimplify } from './pipeline/4-smooth.js'
import { analyzeRoute, generateSplits } from './pipeline/5-split.js'
import { buildGPXString, downloadGPX } from './utils/gpx.js'
import { showToast } from './ui/toast.js'
import { fetchLidarElevations } from './api/lidar.js'
import { searchPlace, searchPlaceSuggestions } from './api/place-search.js'
import { getTargetResolution, densifyForLidar, detectPrimaryCountry } from './utils/resolution.js'
import { detectStartEndOverlap } from './utils/geometry.js'
import {
  enterBuilderMode, exitBuilderMode,
  isBuilderActive, builderCanUndo, builderUndo, builderClear,
  onBuilderMapClick, onBuilderWaypointDrag, onBuilderDeleteWaypoint, onBuilderInsertWaypoint,
  finishRouteBuilder, setBuilderMode, setBuilderProfile,
  getBuilderWaypoints, getBuilderDistance,
} from './modes/route-builder.js'
import { initChart, drawAll, buildColors, zoomToCorr, zoomToBrunnel } from './chart/index.js'
import { initMap, drawMap, mapFit, mapGoTo, mapFitBounds } from './map/index.js'
import { initShell } from './ui/shell.js'
import { initSidebar } from './ui/sidebar.js'
import { initToolbar } from './ui/toolbar.js'
import { initPanels } from './ui/panels.js'
import { initCorrections } from './ui/corrections.js'

console.log('[GPXForge] v0.2.0 ready')

// ── Build UI shell ──
const shell = initShell(onFileLoaded)

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
    shell.setInfoStep(stepId)
    // Update trim status text when switching to trim step
    if (stepId === 'trim' && ST.gpx) updateTrimUI()
    // Clear snap waypoints when leaving snap step (waypoints only visible on snap tab)
    if (stepId !== 'snap') {
      ST.routeWaypoints = []
      ST.routeSegments = []
      if (ST.gpx) drawMap()
    }
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
    toolbar.setLidarBusy(true)
    try {
      // Preserve original spacing BEFORE any densification (used by smoother)
      if (ST.dists && ST.dists.length > 1) {
        ST.origAvgSpacing = ST.dists[ST.dists.length - 1] / (ST.dists.length - 1)
      }

      // Densify to provider's native resolution if current spacing is coarser
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

      // Parse the full route from the returned GPX — server may return a
      // different point count (e.g. 1m resample for local LIDAR providers).
      // Always replace lat/lon/ele entirely rather than overlaying elevations.
      const parser = new DOMParser()
      const doc = parser.parseFromString(gpxText, 'text/xml')
      const trkpts = doc.querySelectorAll('trkpt')
      if (!trkpts.length) {
        throw new Error('LIDAR response contains no track points')
      }
      const newLats = [], newLons = [], newEles = []
      for (const pt of trkpts) {
        newLats.push(parseFloat(pt.getAttribute('lat')))
        newLons.push(parseFloat(pt.getAttribute('lon')))
        const eleEl = pt.querySelector('ele')
        newEles.push(eleEl ? parseFloat(eleEl.textContent) : 0)
      }

      // Replace entire route — resampled point count may differ from input
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

      // Reset pipeline status badges
      for (const step of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split']) {
        sidebar.setStepStatus(step, 'none', null)
      }
      panels.clean.clearLog()
      panels.smooth.hideStats()
      panels.smooth.enableRevert(false)
      panels.smooth.enableSimplify(false)
      panels.split.hideResults()

      refresh()
      toolbar.updateButtons()
      console.log(`[GPXForge] LIDAR elevation applied: ${summary}`)
      if (ST.lidarSource) {
        console.log(`[GPXForge] LIDAR source: ${ST.lidarSource}`)
      }
    } catch (err) {
      // Show user-facing error
      const msg = err.message || String(err)
      showToast(`LIDAR elevation failed: ${msg}`, { type: 'error' })
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
})

// ── Build step panels (controls in toolbar, output in info panel) ──
const panels = initPanels(sidebar, shell)

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
  bp.btnPlaceSearch.addEventListener('click', () => {
    runBuilderPlaceSearch()
  })
  bp.placeInput.addEventListener('input', () => {
    queueBuilderPlaceSuggest()
  })
  bp.placeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      runBuilderPlaceSearch()
    }
  })
  document.addEventListener('click', (e) => {
    if (e.target === bp.placeInput) return
    if (e.target?.classList?.contains('tb-suggest-item')) return
    panels.builder.hidePlaceSuggestions()
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
    panels.builder.setPlaceSuggestions(items)
  } catch (err) {
    if (err?.name === 'AbortError') return
    panels.builder.hidePlaceSuggestions()
    panels.builder.setSearchStatus('Suggestions unavailable right now. You can still press Go.')
  }
}

async function runBuilderPlaceSearch() {
  const query = panels.builder.els.placeInput.value.trim()
  if (!query) {
    panels.builder.setSearchStatus('Type a place first (for example: London)')
    return
  }

  panels.builder.hidePlaceSuggestions()
  panels.builder.setSearchBusy(true)
  panels.builder.setSearchStatus(`Searching "${query}"...`)
  try {
    const place = await searchPlace(query)
    if (!place) {
      panels.builder.setSearchStatus(`No match found for "${query}"`)
      return
    }

    goToPlaceOnMap(place)
    panels.builder.setSearchStatus(`Map moved to ${place.name}`)
  } catch (err) {
    panels.builder.setSearchStatus(`Search failed: ${err.message || 'unknown error'}`)
  } finally {
    panels.builder.setSearchBusy(false)
  }
}

// ── Corrections panel (info panel — bottom-right secondary) ──
const corrPanel = initCorrections(shell.getInfoPanel('clean'), {
  onAccept: handleAcceptCorr,
  onReject: handleRejectCorr,
  onSelect: handleSelectCorr,
  onRemove: handleRemoveCorr,
})

// ── State ──
let chartInited = false
let mapInited = false

// ────────────────────────────────────────────────────────────────────
// File loaded
// ────────────────────────────────────────────────────────────────────

/**
 * Called by shell.js after a GPX file is parsed and ST is populated.
 */
function onFileLoaded() {
  // Show panels FIRST so containers get dimensions from the grid
  shell.showViews()

  // Show step toolbar and default to Clean step
  shell.showStepToolbar()
  sidebar.setActiveStep('clean')
  shell.setInfoStep('clean')

  // Initialise chart system (first load only)
  if (!chartInited) {
    const els = shell.getChartEls()
    initChart(els, {
      commitDrag: handleCommitDrag,
      commitDraw: handleCommitDraw,
      removeCorr: handleRemoveCorr,
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
    })
    chartInited = true
  }

  // Initialise map system (first load only — needs visible container)
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

  // Draw everything
  refresh()
  mapFit()
  toolbar.updateButtons()
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

  shell.showViews()
  shell.showStepToolbar()
  shell.setInfoStep('builder')

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
  exitBuilderMode()

  const map = document.getElementById('mapPanel')
  if (map) map.style.cursor = ''

  sidebar.setBuilderActive(false)
  toolbar.setCreateRouteActive(false)

  // Restore previous step info panel (or hide if no file loaded)
  if (ST.gpx && ST.activeStep) {
    shell.setInfoStep(ST.activeStep)
  } else {
    shell.setInfoStep(null)
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
  sidebar.setBuilderActive(false)
  toolbar.setCreateRouteActive(false)

  // Show pipeline and navigate to clean step
  shell.showViews()
  shell.showStepToolbar()
  sidebar.setActiveStep('clean')
  shell.setInfoStep('clean')

  // Initialise chart if not yet done
  if (!chartInited) {
    const els = shell.getChartEls()
    initChart(els, {
      commitDrag: handleCommitDrag,
      commitDraw: handleCommitDraw,
      removeCorr: handleRemoveCorr,
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
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

  refresh()
  mapFit()
  toolbar.updateButtons()
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

/**
 * Build a Uint8Array mask marking brunnel (bridge/tunnel) index ranges.
 * Points within 10m of a brunnel boundary are also masked to avoid
 * flagging real elevation changes at bridge approaches.
 */
function buildBrunnelMask(brunnels, dists) {
  const mask = new Uint8Array(dists.length)
  for (const b of brunnels) {
    const lo = bsearchDists(dists, b.startDist - 10)
    const hi = Math.min(dists.length - 1, bsearchDists(dists, b.endDist + 10 + 1) - 1)
    for (let k = lo; k <= hi; k++) mask[k] = 1
  }
  return mask
}

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

/**
 * Handle a trim click from map or chart.
 * First click sets marker A, second sets marker B.
 * Third click resets and starts over.
 */
function handleTrimClick(idx) {
  if (!ST.gpx || !ST.dists) return
  if (ST.activeStep !== 'trim') return

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

  // Save snapshot for undo
  ST.trimHistory.push(trimSnapshot(ST.gpx, ST.dists, ST.grOrig, ST.eleClean, ST.grClean))

  const trimType = detectTrimType(idxA, idxB, N)
  panels.trim.setStatus(`Applying ${trimType} trim...`)
  panels.trim.enableApply(false)

  try {
    const eleClean = ST.eleClean || ST.gpx.eles
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

    // Invalidate downstream from trim
    invalidateFrom('trim')

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
    }, { costing, forcedIndices: ST.trimJoins })

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
  const valhallaCost = costing === 'bike' ? 'bicycle' : 'auto'

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
    restoreRawElevation(c)
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
  if (!ST.gpx) return
  for (let i = c.alo; i <= c.ahi; i++) {
    ST.eleClean[i] = ST.gpx.eles[i]
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

