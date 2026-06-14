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
import { nearestGpxIndexForward, mergeSegments, transferElevations, autoSnap, mapWaypointsToDensified, blendSpliceJunctions, detectSnapDeviations, detectHeadUnitNoise, detectSnapKinks } from './pipeline/1-snap.js'
import { valhallaMulti } from './api/valhalla.js'
import { getRouteWayIds } from './api/way-matching.js'
import { fetchRing } from './api/overpass-ring.js'
import { fetchJunctionWays } from './api/overpass-junctions.js'
import { detectRoundabouts } from './utils/roundabout.js'
import { locateBrunnels, buildBrunnelCorrections, buildBrunnelMask } from './pipeline/2-brunnels.js'
import { runCleaner, applyInterp, classifyStructure } from './pipeline/3-clean.js'
import { filterVegetation, vegetationReport } from './pipeline/3.5-vegetation.js'
import { runSourceAwareDipSmoothing } from './pipeline/3.6-source-dip-smooth.js'
import { runSmoothing, runSimplify, runElevationOnlySmoothing, isLowResSource } from './pipeline/4-smooth.js'
import { analyzeRoute, generateSplits, generateSplitsByDistance } from './pipeline/5-split.js'
import { reverseTrack, rotateLoopTrack, sliceTrack, isLoop, mergeTracks, blendSeam, offsetElevationSection } from './utils/track-edit.js'
import { laneSplit, offsetSection, separateOverlap, offsetPolyline, unifyOverlap } from './utils/lane-split.js'
import { reconcileReusedRoads, hasReusedSegments, authorityForEditedRange } from './utils/reuse-reconcile.js'
import { compileRouteGraph, validateRouteGraph, applySegmentElevations } from './utils/route-graph.js'
import { buildGPXString, downloadGPX, parseGPX } from './utils/gpx.js'
import { buildDownloadFilename } from './utils/download-name.js'
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
import * as topology from './modes/topology-editor.js'
import * as course from './modes/course-builder.js'
import { initChart, drawAll, buildColors, zoomToCorr, zoomToBrunnel, zoomToSnapSuspect, zoomToSnapKink } from './chart/index.js'
import { initMap, drawMap, mapFit, mapGoTo, mapFitBounds, finishCourseDraw, cancelCourseDraw, courseDrawVertexCount } from './map/index.js'
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
    // Clear snap waypoints when leaving snap step
    if (stepId !== 'snap') {
      ST.routeWaypoints = []
      ST.routeSegments = []
      ST.nudgeMode = false
      ST.nudgeDragState = null
      panels.snap.setNudgeActive(false)
      panels.snap.setNudgeRange('')
      const mapEl2 = shell.getMapEl()
      if (mapEl2) mapEl2.style.cursor = ''
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
  onBuildCourse() {
    if (course.isCourseActive()) {
      doExitCourseBuilder()
    } else {
      doEnterCourseBuilder()
    }
  },
  async onLidar() {
    if (!ST.gpx) return
    // Elevation work begins — switch to chart-featured 3-panel layout.
    shell.showViews()
    toolbar.setLidarBusy(true)
    try {
      // A compiled course fetches LIDAR per UNIQUE segment (Z into the graph); a recorded ride fetches
      // the whole flat track.
      if (ST.courseGraph) await runCourseLidarFetch()
      else await runLidarFetch()
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
  // bbox = [south, west, north, east]. Treat tiny or degenerate boxes as a point
  // (Nominatim returns near-zero bboxes for peaks, addresses, single nodes —
  // fitBounds on those zooms past tile coverage and shows a blank map).
  const MIN_BBOX_DEG = 0.005 // ~500m
  const bbox = place.bbox
  const hasUsefulBbox =
    bbox &&
    Math.abs(bbox[2] - bbox[0]) > MIN_BBOX_DEG &&
    Math.abs(bbox[3] - bbox[1]) > MIN_BBOX_DEG
  if (hasUsefulBbox) {
    mapFitBounds(bbox[0], bbox[1], bbox[2], bbox[3])
  } else {
    mapGoTo(place.lat, place.lon, 15)
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

// ── Pending LIDAR refresh panel (Nudge tool) ──
const snapInfoEl = shell.getInfoPanel('snap')
const _pendingWrap = document.createElement('div')
_pendingWrap.className = 'pending-lidar-wrap'
_pendingWrap.style.cssText = 'padding: 8px 10px; margin-top: 8px; border-top: 1px solid rgba(0,0,0,0.08); font-family: var(--font-mono, monospace); font-size: 12px;'
_pendingWrap.style.display = 'none'
const _pendingHeader = document.createElement('div')
_pendingHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;'
const _pendingTitle = document.createElement('div')
_pendingTitle.style.cssText = 'font-weight: 600; color: #b06000;'
_pendingTitle.textContent = 'LIDAR refresh pending'
const _pendingDiscard = document.createElement('button')
_pendingDiscard.className = 'tb-btn ghost'
_pendingDiscard.style.cssText = 'padding: 2px 8px; font-size: 11px;'
_pendingDiscard.textContent = '✕ Discard'
_pendingDiscard.title = 'Drop pending ranges without refreshing'
_pendingHeader.appendChild(_pendingTitle)
_pendingHeader.appendChild(_pendingDiscard)
const _pendingSummary = document.createElement('div')
_pendingSummary.style.cssText = 'margin-bottom: 6px; font-size: 11.5px; color: rgba(0,0,0,0.7);'
const _pendingRefresh = document.createElement('button')
_pendingRefresh.className = 'tool-btn'
_pendingRefresh.style.cssText = 'width: 100%; padding: 6px 10px; background: #b06000; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;'
_pendingRefresh.textContent = 'Refresh LIDAR'
const _pendingStatus = document.createElement('div')
_pendingStatus.style.cssText = 'margin-top: 6px; padding: 6px 8px; border-radius: 4px; background: rgba(176,96,0,0.08); color: #804500; font-size: 11.5px; line-height: 1.4; display: none;'
_pendingWrap.appendChild(_pendingHeader)
_pendingWrap.appendChild(_pendingSummary)
_pendingWrap.appendChild(_pendingRefresh)
_pendingWrap.appendChild(_pendingStatus)
if (snapInfoEl) snapInfoEl.appendChild(_pendingWrap)

function setPendingStatus(html, busy = false) {
  if (!html) { _pendingStatus.style.display = 'none'; return }
  _pendingStatus.style.display = ''
  _pendingStatus.innerHTML = (busy ? '<span class="inline-spinner"></span>' : '') + html
}

function refreshPendingLidarInfo() {
  const list = ST.pendingLidarRanges || []
  if (!list.length) {
    _pendingWrap.style.display = 'none'
    return
  }
  _pendingWrap.style.display = ''
  if (typeof shell.showInfoPanel === 'function') shell.showInfoPanel()
  let totalM = 0
  for (const r of list) totalM += (ST.dists[r.hi] || 0) - (ST.dists[r.lo] || 0)
  const km = (totalM / 1000).toFixed(2)
  const nudgeN = list.filter(r => r.origin === 'nudge').length
  const parts = []
  if (nudgeN) parts.push(`${nudgeN} nudge${nudgeN > 1 ? 's' : ''}`)
  _pendingSummary.innerHTML = `<b>${list.length}</b> pending range${list.length > 1 ? 's' : ''} (<b>${km} km</b>) — ${parts.join(' + ')}`
}

/** Merge overlapping/close ranges (within 5m) to reduce LIDAR calls. */
function mergePendingRanges(ranges) {
  if (!ranges.length) return []
  const sorted = ranges.slice().sort((a, b) => a.lo - b.lo)
  const merged = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]
    const cur = sorted[i]
    // Merge if cur.lo is within ~5m of prev.hi (in route distance)
    if (cur.lo - prev.hi <= 5 || ST.dists[cur.lo] - ST.dists[prev.hi] <= 5) {
      prev.hi = Math.max(prev.hi, cur.hi)
    } else {
      merged.push(cur)
    }
  }
  return merged
}

_pendingDiscard.addEventListener('click', () => {
  if (!ST.pendingLidarRanges || !ST.pendingLidarRanges.length) return
  if (!confirm(`Discard ${ST.pendingLidarRanges.length} pending LIDAR range(s)? Elevations will be inaccurate at modified points.`)) return
  ST.pendingLidarRanges = []
  refreshPendingLidarInfo()
})

_pendingRefresh.addEventListener('click', async () => {
  const ranges = (ST.pendingLidarRanges || []).slice()
  if (!ranges.length) return

  _pendingRefresh.disabled = true
  _pendingRefresh.classList.add('tool-btn', 'busy')

  // Take a snapshot so the user can undo the LIDAR refresh too
  ST.snapDragHistory.push({
    gpx: { ...ST.gpx, lats: [...ST.gpx.lats], lons: [...ST.gpx.lons], eles: [...ST.gpx.eles] },
    dists: ST.dists instanceof Float64Array ? new Float64Array(ST.dists) : [...ST.dists],
    grOrig: ST.grOrig ? [...ST.grOrig] : null,
    eleClean: ST.eleClean ? [...ST.eleClean] : null,
    grClean: ST.grClean ? [...ST.grClean] : null,
    routeSegments: ST.routeSegments.map(s => s.map(p => [...p])),
    snapWaypoints: ST.snapWaypoints ? ST.snapWaypoints.map(w => ({ ...w })) : [],
  })
  panels.snap.enableUndo(true)

  // Merge close ranges. Process end-to-start so splices don't shift indices.
  const merged = mergePendingRanges(ranges).sort((a, b) => b.lo - a.lo)
  let ok = 0
  let totalPts = 0
  try {
    for (let i = 0; i < merged.length; i++) {
      const r = merged[i]
      setPendingStatus(`Fetching LIDAR — range ${i + 1}/${merged.length}`, true)
      try {
        const pts = await runPartialLidarFetch(r.lo, r.hi, 10)
        if (typeof pts === 'number') totalPts += pts
        ok++
      } catch (err) {
        console.error(`[GPXForge] Refresh LIDAR ${i + 1} failed:`, err)
      }
    }
    if (ok === merged.length) {
      setPendingStatus(`<b>✓ LIDAR refreshed</b> — ${merged.length} range${merged.length > 1 ? 's' : ''}, ${totalPts} pts at native resolution`, false)
      showToast(`LIDAR refreshed for ${merged.length} range(s)`, 'ok')
    } else {
      setPendingStatus(`<b>⚠ ${ok}/${merged.length} ranges refreshed</b>`, false)
      showToast(`LIDAR: ${ok}/${merged.length} ranges refreshed`, 'warn')
    }
    ST.pendingLidarRanges = []
    refreshPendingLidarInfo()
    drawAll()
  } finally {
    _pendingRefresh.disabled = false
    _pendingRefresh.classList.remove('busy')
  }
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
      ST.sourceSegments = entry.sourceSegments || []
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
      const usedNames = new Set()
      for (const entry of done) {
        const eles = entry.eleClean || entry.gpx.eles
        const lats = entry.gpx.lats
        const lons = entry.gpx.lons
        const gpxStr = buildGPXString(lats, lons, eles, entry.filename)
        let name
        try {
          const midIdx = Math.floor(lats.length / 2)
          name = await buildDownloadFilename({
            startLat: lats[0], startLon: lons[0],
            endLat: lats[lats.length - 1], endLon: lons[lons.length - 1],
            midLat: lats[midIdx], midLon: lons[midIdx],
            fallbackBaseName: entry.filename.replace(/\.gpx$/i, ''),
          })
        } catch (_) {
          name = entry.filename.replace(/\.gpx$/i, '.gpx')
        }
        while (usedNames.has(name)) name = name.replace(/\.gpx$/i, '_2.gpx')
        usedNames.add(name)
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
      nudgeStart: onNudgeStart,
      nudgeMove: onNudgeMove,
      nudgeWheel: onNudgeWheel,
      nudgeEnd: onNudgeEnd,
      editPivotClick: onEditPivotClick,
      editRangeClick: onEditRangeClick,
      topoNodeClick: (frac) => topology.addNodeAtFrac(frac),
      topoSegClick: (segId, dir) => { if (topology.isBuildingCourse()) topology.appendToCourse(segId, dir); else topology.toggleSegmentSelection(segId); refreshTopologyPanel() },
      topoNodeSelect: (nodeId) => { topology.toggleNodeSelection(nodeId); refreshTopologyPanel() },
      courseNodeClick: (nodeId) => { onCourseNodeClick(nodeId) },
      courseSegClick: (segId, latlng) => { onCourseSegClick(segId, latlng) },
      courseRegionDraw: (region) => { onCourseRegionDraw(region) },
      courseDrawProgress: (n, shape) => { panels.course.setDrawProgress(n, shape) },
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

  // If currently reviewing another entry, flush its state back to the queue
  // before swapping so unsaved edits aren't silently lost.
  if (_currentBatchId && _currentBatchId !== id && ST.gpx) {
    saveBackFull(_currentBatchId, snapshotST())
  }

  restoreST(entry.snapshot)
  // Keep the entry in the queue and mark it as the active review target.
  // Park-in-place (via convertToParked) preserves position when the user
  // re-parks, and the active highlight in the panel updates automatically.
  _currentBatchId = id
  markReviewing(id)

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
      editRangeSelect: onEditRangeSelect,
      editPivotClick: onEditPivotClick,
      zNudgeStart: onZNudgeStart,
      zNudgeMove: onZNudgeMove,
      zNudgeWheel: onZNudgeWheel,
      zNudgeEnd: onZNudgeEnd,
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
      nudgeStart: onNudgeStart,
      nudgeMove: onNudgeMove,
      nudgeWheel: onNudgeWheel,
      nudgeEnd: onNudgeEnd,
      editPivotClick: onEditPivotClick,
      editRangeClick: onEditRangeClick,
      topoNodeClick: (frac) => topology.addNodeAtFrac(frac),
      topoSegClick: (segId, dir) => { if (topology.isBuildingCourse()) topology.appendToCourse(segId, dir); else topology.toggleSegmentSelection(segId); refreshTopologyPanel() },
      topoNodeSelect: (nodeId) => { topology.toggleNodeSelection(nodeId); refreshTopologyPanel() },
      courseNodeClick: (nodeId) => { onCourseNodeClick(nodeId) },
      courseSegClick: (segId, latlng) => { onCourseSegClick(segId, latlng) },
      courseRegionDraw: (region) => { onCourseRegionDraw(region) },
      courseDrawProgress: (n, shape) => { panels.course.setDrawProgress(n, shape) },
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
  // Simple mode auto-runs the pipeline (LIDAR + brunnels + clean) in the worker.
  // Expert mode enqueues files as raw parked entries — the user edits each,
  // re-parks, then clicks "Process All" to fetch LIDAR for everything at once.
  const autoProcess = ST.mode === 'simple'
  addFiles(files, parseGPX, { autoProcess })
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
      editRangeSelect: onEditRangeSelect,
      editPivotClick: onEditPivotClick,
      zNudgeStart: onZNudgeStart,
      zNudgeMove: onZNudgeMove,
      zNudgeWheel: onZNudgeWheel,
      zNudgeEnd: onZNudgeEnd,
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
      nudgeStart: onNudgeStart,
      nudgeMove: onNudgeMove,
      nudgeWheel: onNudgeWheel,
      nudgeEnd: onNudgeEnd,
      editPivotClick: onEditPivotClick,
      editRangeClick: onEditRangeClick,
      topoNodeClick: (frac) => topology.addNodeAtFrac(frac),
      topoSegClick: (segId, dir) => { if (topology.isBuildingCourse()) topology.appendToCourse(segId, dir); else topology.toggleSegmentSelection(segId); refreshTopologyPanel() },
      topoNodeSelect: (nodeId) => { topology.toggleNodeSelection(nodeId); refreshTopologyPanel() },
      courseNodeClick: (nodeId) => { onCourseNodeClick(nodeId) },
      courseSegClick: (segId, latlng) => { onCourseSegClick(segId, latlng) },
      courseRegionDraw: (region) => { onCourseRegionDraw(region) },
      courseDrawProgress: (n, shape) => { panels.course.setDrawProgress(n, shape) },
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
  // If Course Builder is active, a main-uploader file is an IMPORT into the course (decompose the
  // exact track for editing) — not a new pipeline route. Capture the parsed track, clear the
  // pipeline route (the course owns the geometry until Done), and decompose.
  if (course.isCourseActive() && ST.gpx && ST.gpx.lats && ST.gpx.lats.length >= 2) {
    const track = { lats: ST.gpx.lats.slice(), lons: ST.gpx.lons.slice(), eles: (ST.gpx.eles || []).slice() }
    ST.gpx = null
    ST.dists = null
    doImportTrackIntoCourse(track)
    return
  }

  // A freshly loaded recorded ride is NOT a course — drop any stale course graph/provenance from a
  // previous Course Builder session (otherwise the LIDAR step + skipPositionSmooth would misfire).
  ST.courseArcs = null
  ST.courseGraph = null
  ST.segAuthority = {}
  ST.reuseUnified = false

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
      editRangeSelect: onEditRangeSelect,
      editPivotClick: onEditPivotClick,
      zNudgeStart: onZNudgeStart,
      zNudgeMove: onZNudgeMove,
      zNudgeWheel: onZNudgeWheel,
      zNudgeEnd: onZNudgeEnd,
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
      nudgeStart: onNudgeStart,
      nudgeMove: onNudgeMove,
      nudgeWheel: onNudgeWheel,
      nudgeEnd: onNudgeEnd,
      editPivotClick: onEditPivotClick,
      editRangeClick: onEditRangeClick,
      topoNodeClick: (frac) => topology.addNodeAtFrac(frac),
      topoSegClick: (segId, dir) => { if (topology.isBuildingCourse()) topology.appendToCourse(segId, dir); else topology.toggleSegmentSelection(segId); refreshTopologyPanel() },
      topoNodeSelect: (nodeId) => { topology.toggleNodeSelection(nodeId); refreshTopologyPanel() },
      courseNodeClick: (nodeId) => { onCourseNodeClick(nodeId) },
      courseSegClick: (segId, latlng) => { onCourseSegClick(segId, latlng) },
      courseRegionDraw: (region) => { onCourseRegionDraw(region) },
      courseDrawProgress: (n, shape) => { panels.course.setDrawProgress(n, shape) },
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
  ST.routeWayIds = null
  ST.routeWayIdsSource = ''
  ST.routeRoundaboutFlags = null
  ST.snapWaypoints = []
  ST.snapPreState = null
  ST.snapDragHistory = []
  ST.smoothedRoute = null
  ST.lidarSource = ''
  ST.lidarSources = {}
  ST.sourceSegments = []

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
  updateEditButtons()
  // Lock Simple toggle whenever Expert is active and a route is loaded.
  // Park/clear releases the lock by emptying ST.gpx.
  shell.setSimpleLocked(ST.mode === 'expert' && !!ST.gpx)
}

/**
 * Enable/disable the Split-step edit-track buttons based on current state.
 */
function updateEditButtons() {
  const e = panels.split.els
  if (!e.btnReverse) return
  const hasRoute = !!ST.gpx
  e.btnReverse.disabled = !hasRoute
  e.btnMoveStart.disabled = !hasRoute
  e.btnSplitDist.disabled = !hasRoute
  e.btnSelectRange.disabled = !hasRoute
  e.btnCrop.disabled = !hasRoute || !ST.editSelection
  e.btnExportSel.disabled = !hasRoute || !ST.editSelection
  e.btnAppend.disabled = !hasRoute
  e.btnLaneSplit.disabled = !hasRoute
  if (e.btnZNudge) e.btnZNudge.disabled = !hasRoute
  e.btnOffsetSel.disabled = !hasRoute   // no selection → nudges the whole route
  e.btnSepOverlap.disabled = !hasRoute || !ST.editSelection
  if (e.btnUnifyOverlap) e.btnUnifyOverlap.disabled = !hasRoute || !ST.editSelection
  // Unify reused — only for compiled courses whose graph knows a road is reused (≥2 passes).
  if (e.btnUnifyReused) {
    const reusable = hasReusedSegments(ST.courseArcs)
    e.btnUnifyReused.style.display = reusable ? '' : 'none'
    e.btnUnifyReused.disabled = !hasRoute || !reusable
  }
  if (e.btnTopoEnter && !topology.isTopologyActive()) e.btnTopoEnter.disabled = !hasRoute
  e.btnUndoEdit.disabled = !(ST.editHistory && ST.editHistory.length)
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
      nudgeStart: onNudgeStart,
      nudgeMove: onNudgeMove,
      nudgeWheel: onNudgeWheel,
      nudgeEnd: onNudgeEnd,
      editPivotClick: onEditPivotClick,
      editRangeClick: onEditRangeClick,
      topoNodeClick: (frac) => topology.addNodeAtFrac(frac),
      topoSegClick: (segId, dir) => { if (topology.isBuildingCourse()) topology.appendToCourse(segId, dir); else topology.toggleSegmentSelection(segId); refreshTopologyPanel() },
      topoNodeSelect: (nodeId) => { topology.toggleNodeSelection(nodeId); refreshTopologyPanel() },
      courseNodeClick: (nodeId) => { onCourseNodeClick(nodeId) },
      courseSegClick: (segId, latlng) => { onCourseSegClick(segId, latlng) },
      courseRegionDraw: (region) => { onCourseRegionDraw(region) },
      courseDrawProgress: (n, shape) => { panels.course.setDrawProgress(n, shape) },
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
  const { gpxText, summary, source, sources, sourceSegments } = await fetchLidarElevations(gpxString, ST.filename || 'route.gpx')

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

  applyFetchedTrackToST(newLats, newLons, newEles, { source, sources, sourceSegments, summary })
}

/**
 * Replace ST.gpx geometry+elevation with a freshly fetched/recompiled flat track and reset the
 * downstream pipeline. Shared by the whole-track LIDAR fetch (runLidarFetch) and the per-segment
 * course LIDAR fetch (runCourseLidarFetch).
 */
function applyFetchedTrackToST(newLats, newLons, newEles, meta = {}) {
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
  ST.lidarSource = meta.source || ''
  ST.lidarSources = meta.sources || {}
  ST.sourceSegments = meta.sourceSegments || []
  ST.reuseUnified = false  // geometry changed — reused passes need re-checking (no-op if already identical)

  for (const step of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split']) {
    sidebar.setStepStatus(step, 'none', null)
  }
  panels.clean.clearLog()
  panels.smooth.hideStats()
  panels.smooth.enableRevert(false)
  panels.smooth.enableSimplify(false)
  panels.split.hideResults()

  if (meta.summary) console.log(`[GPXForge] LIDAR elevation applied: ${meta.summary}`)
  if (ST.lidarSource) console.log(`[GPXForge] LIDAR source: ${ST.lidarSource}`)
}

/**
 * Course LIDAR: fetch each UNIQUE segment ONCE (a road ridden N times is sampled once), write Z onto
 * the graph's segments + nodes, then recompile — so every pass of a reused road is vertex-identical in
 * XY+Z by construction (reconcile not needed). Falls back to nothing here; the caller branches.
 */
async function runCourseLidarFetch() {
  const graph = ST.courseGraph
  const segIds = [...new Set((graph.route || []).map((a) => a.segment))]

  // Fetch one unique segment → its densified XY + sampled Z.
  const fetchSeg = async (segId) => {
    const seg = graph.segments[segId]
    const sLats = seg.points.map((p) => p.lat), sLons = seg.points.map((p) => p.lon)
    const sDists = cumulativeDistances(sLats, sLons)
    const targetRes = getTargetResolution(sLats, sLons)
    const dens = densifyForLidar(sLats, sLons, sDists, targetRes)
    const fLats = dens.wasDensified ? dens.lats : sLats
    const fLons = dens.wasDensified ? dens.lons : sLons
    const gpxString = buildGPXString(fLats, fLons, new Array(fLats.length).fill(0), `${ST.filename || 'course'}-${segId}`)
    const { gpxText, source } = await fetchLidarElevations(gpxString, `${ST.filename || 'course'}-${segId}.gpx`)
    const doc = new DOMParser().parseFromString(gpxText, 'text/xml')
    const pts = doc.querySelectorAll('trkpt')
    if (!pts.length) throw new Error(`LIDAR returned no points for segment ${segId}`)
    const lats = [], lons = [], eles = []
    for (const pt of pts) {
      lats.push(parseFloat(pt.getAttribute('lat')))
      lons.push(parseFloat(pt.getAttribute('lon')))
      const e = pt.querySelector('ele'); eles.push(e ? parseFloat(e.textContent) : 0)
    }
    return { segId, geo: { lats, lons, eles }, source }
  }

  // Bounded concurrency so a many-road course doesn't open dozens of parallel requests.
  const eleBySegId = {}
  let source = ''
  const POOL = 4
  for (let i = 0; i < segIds.length; i += POOL) {
    const batch = await Promise.all(segIds.slice(i, i + POOL).map(fetchSeg))
    for (const r of batch) { eleBySegId[r.segId] = r.geo; if (!source && r.source) source = r.source }
  }

  const { track, graph: zGraph } = applySegmentElevations(graph, eleBySegId)
  ST.courseGraph = zGraph  // graph now owns Z
  applyFetchedTrackToST(track.lats, track.lons, track.eles, { source, summary: `${segIds.length} unique segment(s)` })
}

/**
 * Partial LIDAR fetch \u2014 only re-fetch elevations for [lo..hi] + bufferM each side.
 * Densifies the slice to native LIDAR resolution, sends only that slice to the
 * server, then splices the result back into ST.gpx (point count may change).
 * Rebuilds ST.dists / gradients for the full route.
 *
 * Used after nudge to avoid re-fetching elevations for the entire route.
 */
async function runPartialLidarFetch(lo, hi, bufferM = 10) {
  if (!ST.gpx || !ST.dists) throw new Error('No route loaded')
  const N = ST.gpx.lats.length
  lo = Math.max(0, Math.min(N - 1, lo))
  hi = Math.max(0, Math.min(N - 1, hi))
  if (hi < lo) [lo, hi] = [hi, lo]

  // Expand by bufferM on each side using cumulative distances
  const dLo = ST.dists[lo] - bufferM
  const dHi = ST.dists[hi] + bufferM
  let expLo = lo, expHi = hi
  while (expLo > 0 && ST.dists[expLo - 1] >= dLo) expLo--
  while (expHi < N - 1 && ST.dists[expHi + 1] <= dHi) expHi++

  // Densify the slice to native LIDAR resolution before sending. Server samples
  // elevation AT the points we send; it does not add intermediate points.
  const sliceLats = ST.gpx.lats.slice(expLo, expHi + 1)
  const sliceLons = ST.gpx.lons.slice(expLo, expHi + 1)
  const sliceDists = new Float64Array(sliceLats.length)
  for (let i = 0; i < sliceLats.length; i++) sliceDists[i] = ST.dists[expLo + i] - ST.dists[expLo]

  const targetRes = getTargetResolution(sliceLats, sliceLons)
  const dens = densifyForLidar(sliceLats, sliceLons, sliceDists, targetRes)
  const fetchLats = dens.wasDensified ? dens.lats : sliceLats
  const fetchLons = dens.wasDensified ? dens.lons : sliceLons
  const fetchEles = new Array(fetchLats.length).fill(0)

  if (dens.wasDensified) {
    console.log(`[GPXForge] Partial LIDAR: densified slice [${expLo}..${expHi}] ${sliceLats.length} → ${fetchLats.length} pts @ ${targetRes}m`)
  } else {
    console.log(`[GPXForge] Partial LIDAR: sending ${sliceLats.length} pts (no densification needed)`)
  }

  const gpxString = buildGPXString(fetchLats, fetchLons, fetchEles, `${ST.filename || 'route'}-partial`)
  const { gpxText, summary, source } = await fetchLidarElevations(gpxString, `${ST.filename || 'route'}-partial.gpx`)

  // Parse response
  const parser = new DOMParser()
  const doc = parser.parseFromString(gpxText, 'text/xml')
  const trkpts = doc.querySelectorAll('trkpt')
  if (!trkpts.length) throw new Error('Partial LIDAR response contains no track points')
  const newSliceLats = [], newSliceLons = [], newSliceEles = []
  let zeroCount = 0
  for (const pt of trkpts) {
    newSliceLats.push(parseFloat(pt.getAttribute('lat')))
    newSliceLons.push(parseFloat(pt.getAttribute('lon')))
    const eleEl = pt.querySelector('ele')
    const ele = eleEl ? parseFloat(eleEl.textContent) : 0
    if (ele === 0 || !Number.isFinite(ele)) zeroCount++
    newSliceEles.push(ele)
  }
  console.log(`[GPXForge] Partial LIDAR: received ${trkpts.length} pts, ${zeroCount} with zero/missing elevation`)
  if (zeroCount === trkpts.length) {
    throw new Error('LIDAR returned all-zero elevations for slice')
  }

  // Splice the new slice (with elevations) back into the full route
  const newLats = [
    ...ST.gpx.lats.slice(0, expLo),
    ...newSliceLats,
    ...ST.gpx.lats.slice(expHi + 1),
  ]
  const newLons = [
    ...ST.gpx.lons.slice(0, expLo),
    ...newSliceLons,
    ...ST.gpx.lons.slice(expHi + 1),
  ]
  const newEles = [
    ...ST.gpx.eles.slice(0, expLo),
    ...newSliceEles,
    ...ST.gpx.eles.slice(expHi + 1),
  ]

  // Rebuild distances + gradients
  const rebuilt = rebuildRoute(newLats, newLons, newEles, newEles)
  ST.gpx.lats = newLats
  ST.gpx.lons = newLons
  ST.gpx.eles = newEles
  ST.eleClean = [...newEles]
  ST.dists = rebuilt.dists instanceof Float64Array ? rebuilt.dists : new Float64Array(rebuilt.dists)
  ST.grOrig = rebuilt.grOrig
  ST.grClean = rebuilt.grClean

  // Invalidate downstream (the route geometry changed)
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.smoothedRoute = null
  ST.corrections = []
  ST.selectedCorr = -1
  ST.splitAnalysis = null
  ST.splitSegments = null

  // Update lidarSource for the new slice (may differ if cross-border)
  if (source) ST.lidarSource = source

  // Reset downstream step status
  for (const step of ['brunnels', 'clean', 'smooth', 'split']) {
    sidebar.setStepStatus(step, 'none', null)
  }
  panels.clean.clearLog()
  panels.smooth.hideStats()
  panels.smooth.enableRevert(false)
  panels.smooth.enableSimplify(false)
  panels.split.hideResults()

  console.log(`[GPXForge] Partial LIDAR applied to [${expLo}..${expHi}] (${expHi - expLo + 1} pts \u2192 ${newSliceLats.length} pts): ${summary}`)
  return newSliceLats.length
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
  ST.routeWayIds = null
  ST.routeWayIdsSource = ''
  ST.routeRoundaboutFlags = null
  ST.routeJunctionNodes = null
  ST.courseArcs = null    // a Route-Builder route is a flat track, not a course graph
  ST.courseGraph = null
  ST.segAuthority = {}
  ST.reuseUnified = false
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
      editRangeSelect: onEditRangeSelect,
      editPivotClick: onEditPivotClick,
      zNudgeStart: onZNudgeStart,
      zNudgeMove: onZNudgeMove,
      zNudgeWheel: onZNudgeWheel,
      zNudgeEnd: onZNudgeEnd,
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

// ────────────────────────────────────────────────────────────────────
// Course Builder mode (front-entry "Build" — draw an area, pick a course)
// ────────────────────────────────────────────────────────────────────

function doEnterCourseBuilder() {
  // Map is initialised at boot (rAF), so mapInited is normally already true.
  shell.showViews('map')
  shell.showStepToolbar()
  shell.setInfoStep('course')
  document.body.classList.add('course-active')
  sidebar.setCourseActive(true)
  toolbar.setBuildCourseActive(true)

  const map = document.getElementById('mapPanel')
  if (map) map.style.cursor = 'crosshair'

  course.enterCourseBuilder({
    onUpdate: onCourseUpdate,
    onStatus: (msg) => panels.course.setStatus(msg),
  })

  panels.course.setMethod('area')
  panels.course.setProfile('car')
  panels.course.setDrawArmed(true)
  panels.course.setNetwork(0, 0)
  panels.course.setStats(0, 0)
  panels.course.setUndoEnabled(false)

  // If a route is already loaded, switching INTO Course Builder decomposes it for editing
  // (the exact track), rather than starting an empty area draw.
  if (ST.gpx && ST.gpx.lats && ST.gpx.lats.length >= 2) {
    const track = { lats: ST.gpx.lats.slice(), lons: ST.gpx.lons.slice(), eles: (ST.gpx.eles || []).slice() }
    ST.gpx = null
    ST.dists = null
    doImportTrackIntoCourse(track)
  }

  drawMap()
}

function doExitCourseBuilder() {
  const arcs = course.getCourseArcs()
  if (arcs.length >= 1) {
    if (!confirm('Exit Course Builder? Your picked course will be lost.')) return
  }
  course.exitCourseBuilder()
  document.body.classList.remove('course-active')

  const map = document.getElementById('mapPanel')
  if (map) map.style.cursor = ''
  sidebar.setCourseActive(false)
  toolbar.setBuildCourseActive(false)

  if (!ST.gpx) {
    shell.showLanding()
    shell.setInfoStep(null)
  } else {
    const step = ST.activeStep
    shell.showViews(step === 'clean' || step === 'smooth' || step === 'split' ? undefined : 'map')
    shell.setInfoStep(step || null)
  }
  drawMap()
}

/**
 * Decompose a GPX track into the Course Builder as its exact geometry (edit mode). Used by both the
 * course panel's ⬆ Import GPX and the main uploader when Course Builder is active.
 */
async function doImportTrackIntoCourse(track) {
  if (!track || !track.lats || track.lats.length < 2) { panels.course.setStatus('That GPX has no track points.'); return }
  panels.course.setMethod('import')
  // Fit the map up front so the "decomposing…" state is visible over the right area.
  mapFitBounds(Math.min(...track.lats), Math.min(...track.lons), Math.max(...track.lats), Math.max(...track.lons))
  onCourseUpdate()
  const res = await course.importTrack(track)
  if (res.ok) onCourseUpdate()
}

/** Route a map node click: edit mode → select-for-edit; else pick the next course node. */
function onCourseNodeClick(nodeId) {
  if (course.isEditMode()) course.clickNodeForEdit(nodeId)
  else course.clickNode(nodeId)
}

/** Route a map leg click: split-armed → split at the clicked point; edit → select; else pick. */
function onCourseSegClick(segId, latlng) {
  if (course.isSplitArmed() && course.getSelectedSegs()[0] === segId && latlng) {
    course.splitAt(segId, latlng.lat, latlng.lng)
    return
  }
  if (course.isEditMode()) { course.clickSegmentForEdit(segId); return }
  course.appendArc(segId)
}

/** A drawn region either ADDS roads to an imported network (unify) or is a fresh additive region. */
function onCourseRegionDraw(region) {
  if (course.isImported()) course.addRoadsFromRegion(region)
  else course.addRegion(region)
}

function onCourseUpdate() {
  const g = course.getCourseGraph()
  panels.course.setNetwork(
    g ? Object.keys(g.nodes).length : 0,
    g ? Object.keys(g.segments).length : 0,
  )
  panels.course.setStats(course.getCourseArcs().length, course.getCourseDistance())
  panels.course.setUndoEnabled(course.getCourseArcs().length > 0 || !!course.getCourseStartNode())
  panels.course.setDrawArmed(course.isDrawArmed())
  panels.course.setShape(course.getDrawShape())
  panels.course.setRegions(course.getCourseRegions(), (i) => course.removeRegion(i))
  panels.course.setTraceRideEnabled(course.canTraceRide())
  panels.course.setRetryVisible(course.hasFetchGaps())
  // Disconnects the OSM network couldn't bridge (straight-line connectors) — clickable, zoom to fix.
  panels.course.setGaps(course.getImportGaps(), (gap) => mapGoTo(gap.lat, gap.lon, 18))
  // Edit-mode UI state.
  panels.course.setEditAvailable(course.courseHasNetwork())
  panels.course.setEditActive(course.isEditMode())
  panels.course.setSplitArmed(course.isSplitArmed())
  panels.course.setSelection(course.getSelectedSegs().length, course.getSelectedNodes().length)
  panels.course.setUndoEditEnabled(course.canUndoEdit())
  drawMap()
}

function doFinishCourseBuilder() {
  const result = course.finishCourseBuilder()
  if (!result) return

  const { lats, lons, eles, dists, courseArcs, graph } = result

  // Populate ST.gpx with the compiled course (mirror doFinishRouteBuilder's handoff).
  ST.gpx = { lats, lons, eles: [...eles], dists, doc: null, ns: '', pts: [], rawXml: '' }
  ST.dists = dists
  ST.filename = 'course.gpx'
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
  ST.routeWayIds = null
  ST.routeWayIdsSource = ''
  ST.routeRoundaboutFlags = null
  ST.routeJunctionNodes = null
  // Reuse-reconciliation provenance: lets the pipeline force every pass of a reused road to be
  // vertex-identical XY+Z (the segment owns one canonical line; LIDAR/clean/edits stamp via authority).
  ST.courseArcs = courseArcs || null
  ST.courseGraph = graph || null  // kept alive so LIDAR fetches each unique segment once → Z in the graph
  ST.segAuthority = {}
  ST.origAvgSpacing = dists.length > 1 ? dists[dists.length - 1] / (dists.length - 1) : 1

  // UI cleanup
  const map = document.getElementById('mapPanel')
  if (map) map.style.cursor = ''
  document.body.classList.remove('course-active')
  sidebar.setCourseActive(false)
  toolbar.setBuildCourseActive(false)

  // Course geometry is already on the OSM network — enter the pipeline at Clean (snap not needed).
  shell.showViews('map')
  const isSimple = ST.mode === 'simple'
  shell.showStepToolbar()
  sidebar.setActiveStep('clean')
  shell.setInfoStep('clean')

  if (!chartInited) {
    const els = shell.getChartEls()
    initChart(els, {
      commitDrag: handleCommitDrag,
      commitDraw: handleCommitDraw,
      removeCorr: handleRemoveCorr,
      selectCorr: handleSelectCorr,
      trimClick: handleTrimClick,
      editRangeSelect: onEditRangeSelect,
      editPivotClick: onEditPivotClick,
      zNudgeStart: onZNudgeStart,
      zNudgeMove: onZNudgeMove,
      zNudgeWheel: onZNudgeWheel,
      zNudgeEnd: onZNudgeEnd,
      getShapeParams: () => panels.clean.getShapeParams(),
    })
    chartInited = true
  }

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

  if (isSimple) {
    runSimplePipeline().catch(err => console.error('[GPXForge] Simple pipeline failed:', err))
  }
}

// ── Wire course panel buttons ──
;(function wireCoursePanel() {
  const cp = panels.course.els
  cp.methodSelect.addEventListener('change', () => {
    const m = cp.methodSelect.value
    if (m === 'draw') {
      // Fold Route Builder in as the "Draw" method: leave Course Builder, enter the waypoint builder.
      cp.methodSelect.value = 'area' // reset so re-entering course defaults to Area
      panels.course.setMethod('area')
      doExitCourseBuilder()
      if (!ST.gpx && !isBuilderActive()) doEnterBuilderMode()
      return
    }
    panels.course.setMethod(m)
    if (m === 'area') {
      course.setDrawArmed(true)
    } else {
      course.setDrawArmed(false) // import: no map draw
      panels.course.setStatus('Import ride: click ⬆ Import GPX. The streets around your ride are fetched automatically (a corridor) and your ride is pre-traced — no need to draw an area.')
    }
  })
  cp.btnImport.addEventListener('click', () => { cp.importInput.value = ''; cp.importInput.click() })
  cp.btnTraceRide.addEventListener('click', () => course.traceImportedRide())
  cp.btnRetryFetch.addEventListener('click', async () => { const res = await course.retryImportFetch(); if (res.ok) onCourseUpdate() })
  cp.importInput.addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      let parsed
      try { parsed = parseGPX(String(reader.result)) } catch { panels.course.setStatus('Could not read that GPX file.'); return }
      if (!parsed.lats || parsed.lats.length < 2) { panels.course.setStatus('That GPX has no track points.'); return }
      doImportTrackIntoCourse({ lats: parsed.lats, lons: parsed.lons, eles: parsed.eles })
    }
    reader.readAsText(file)
  })
  cp.profileSelect.addEventListener('change', () => course.setCourseProfile(cp.profileSelect.value))
  cp.shapeSelect.addEventListener('change', () => course.setDrawShape(cp.shapeSelect.value))
  cp.btnDraw.addEventListener('click', () => course.setDrawArmed(!course.isDrawArmed()))
  cp.btnFinishDraw.addEventListener('click', () => finishCourseDraw())
  cp.btnCancelDraw.addEventListener('click', () => { cancelCourseDraw() })
  cp.btnReverse.addEventListener('click', () => course.reverseCourse())
  // Esc cancels an in-progress polygon/corridor draw.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && course.isCourseActive() && courseDrawVertexCount() > 0) cancelCourseDraw()
  })
  cp.btnUndo.addEventListener('click', () => course.undoCourseStep())
  cp.btnClear.addEventListener('click', () => {
    if (course.getCourseArcs().length === 0) return
    if (confirm('Clear the picked course?')) course.clearCourse()
  })
  cp.btnDone.addEventListener('click', () => doFinishCourseBuilder())
  // Edit tools.
  cp.btnEdit.addEventListener('click', () => course.setEditMode(!course.isEditMode()))
  cp.btnSplit.addEventListener('click', () => course.armSplit())
  cp.btnMerge.addEventListener('click', () => course.mergeSelected())
  cp.btnSnap.addEventListener('click', () => course.snapSelectedNodes())
  cp.btnMoveStart.addEventListener('click', () => course.moveStartToSelected())
  cp.btnCrop.addEventListener('click', () => course.cropToSelected())
  cp.btnOffset.addEventListener('click', () => course.offsetSelectedSegment(panels.course.getOffsetGap(), panels.course.getOffsetSide()))
  cp.btnAddRoads.addEventListener('click', () => {
    if (!course.isEditMode()) course.setEditMode(true)
    course.setDrawShape('bbox')
    course.setDrawArmed(true)
    panels.course.setStatus('Add roads: drag a box on the map to fetch & splice streets into the network.')
  })
  cp.btnAppendGpx.addEventListener('click', () => { cp.appendInput.value = ''; cp.appendInput.click() })
  cp.appendInput.addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      let parsed
      try { parsed = parseGPX(String(reader.result)) } catch { panels.course.setStatus('Could not read that GPX file.'); return }
      if (!parsed.lats || parsed.lats.length < 2) { panels.course.setStatus('That GPX has no track points.'); return }
      course.appendImportedGpx({ lats: parsed.lats, lons: parsed.lons, eles: parsed.eles })
    }
    reader.readAsText(file)
  })
  cp.btnUndoEdit.addEventListener('click', () => course.undoEdit())
  cp.placeInput.addEventListener('input', () => queueCoursePlaceSuggest())
  cp.placeInput.addEventListener('blur', () => {
    setTimeout(() => panels.course.hidePlaceSuggestions(), 150)
  })
})()

let _courseSuggestTimer = null
let _courseSuggestAbort = null
function queueCoursePlaceSuggest() {
  if (_courseSuggestTimer) clearTimeout(_courseSuggestTimer)
  _courseSuggestTimer = setTimeout(runCoursePlaceSuggest, 220)
}
async function runCoursePlaceSuggest() {
  const query = panels.course.els.placeInput.value.trim()
  if (query.length < 2) { panels.course.hidePlaceSuggestions(); return }
  if (_courseSuggestAbort) _courseSuggestAbort.abort()
  const ac = new AbortController()
  _courseSuggestAbort = ac
  try {
    const items = await searchPlaceSuggestions(query, 5, ac.signal)
    if (panels.course.els.placeInput.value.trim() !== query) return
    panels.course.setPlaceSuggestions(items, (place) => {
      goToPlaceOnMap(place)
      panels.course.setSearchStatus(`Map moved to ${place.name}`)
    })
  } catch (err) {
    if (err?.name === 'AbortError') return
    panels.course.hidePlaceSuggestions()
    panels.course.setSearchStatus('Suggestions unavailable right now.')
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
    sourceSegments: ST.sourceSegments,
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

  const { lats, lons, eles } = ST.gpx
  const dists = ST.dists

  // Snap mode: faithful (hug the recorded track) vs head-unit cleanup (sparse
  // uniform anchors that snap to the road centreline and smooth GPS jitter,
  // stops and missed turns). Auto picks cleanup when the track looks noisy.
  let mode = panels.snap.getMode()
  if (mode === 'auto') {
    const noise = detectHeadUnitNoise(lats, lons, dists)
    mode = noise.isNoisy ? 'cleanup' : 'faithful'
    console.log(`[snap] Auto → ${mode} (noise ${noise.score.toFixed(3)}: reversals ${(noise.reversalRate * 100).toFixed(1)}%, stops ${(noise.stopFrac * 100).toFixed(1)}%)`)
  }
  const cleanup = mode === 'cleanup'
  const spacing = cleanup ? panels.snap.getHuSpacing() : panels.snap.getSpacing()

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
    const adaptiveProfile = panels.snap.getAdaptiveProfile()

    // Cleanup mode keeps the per-leg profile fallback as a LIGHTWEIGHT pass:
    // no track-densification (refineDensify:false), and a raised deviation gate
    // (legGoodDevM/refineDetectOpts) so only genuine profile failures — a big
    // car detour around a bike-only path — flip profile, not the smoothing.
    const cleanupOpts = cleanup
      ? { selfNear: false, uniform: true,
          refine: adaptiveProfile, refineDensify: false,
          legGoodDevM: 50, refineDetectOpts: { absMinM: 50, excessM: 40 } }
      : {}

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
    }, { costing, forcedIndices: ST.trimJoins, ignoreOneways, ignoreRestrictions,
         adaptiveProfile,
         // Faithful → selfNear on, uniform off; Refine toggle controls the
         // deviation re-routing (the geometry-changing pass). cleanupOpts
         // overrides these for head-unit cleanup mode.
         refine: panels.snap.getRefine(),
         ...cleanupOpts })

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

    // Post-snap deviation check — flag segments that drifted onto a different road.
    // In cleanup mode the route intentionally diverges from the noisy track, so
    // only flag LARGE deviations (a genuinely wrongly-straightened detour).
    const suspects = detectSnapDeviations(
      lats, lons, dists, finalLats, finalLons, result.waypoints, anchorNewIndices,
      cleanup ? { absMinM: 60, excessM: 40 } : {},
    )
    ST.snapSuspects = suspects
    panels.snap.setSuspects(suspects, (idx) => {
      zoomToSnapSuspect(idx)
      drawAll()
      drawMap()
    })

    // Post-snap kink check — short out-and-back spurs the snap introduced
    // (route darts into a side street and U-turns back). Flag-only with one-click
    // snip; cross-checked against the original track so real out-and-backs stay.
    const kinks = detectSnapKinks(finalLats, finalLons, ST.dists, lats, lons)
    ST.snapKinks = kinks
    panels.snap.setKinks(kinks, {
      onZoom: (idx) => { zoomToSnapKink(idx); drawAll(); drawMap() },
      onSnip: (idx) => handleSnipKink(idx),
    })

    const flagN = suspects.length + kinks.length
    const notes = []
    if (suspects.length > 0) notes.push(`${suspects.length} suspect zone(s)`)
    if (kinks.length > 0) notes.push(`${kinks.length} kink(s)`)
    const flagNote = notes.length > 0 ? ` — ${notes.join(', ')} to review` : ''
    panels.snap.setProgress(`Snapped: ${finalLats.length} points (was ${lats.length}) — drag waypoints to reroute${flagNote}`)
    panels.snap.showRevert(true)
    sidebar.setStepStatus('snap', flagN > 0 ? 'warn' : 'done',
      `${finalLats.length} pts${flagN > 0 ? `, ${flagN}?` : ''}`)

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
    // ALWAYS emit exactly one segment per waypoint gap so segment indices stay
    // 1:1 with waypoints — handleDeleteWaypoint / handleAddWaypoint rely on
    // ST.routeSegments[wpIdx] addressing. A degenerate gap (both waypoints
    // mapped to the same route point, e.g. trailing clamp) gets a 2-point stub.
    if (seg.length < 2) {
      seg.length = 0
      seg.push([routeLats[from], routeLons[from]], [routeLats[to], routeLons[to]])
    }
    segments.push(seg)
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

/**
 * Snip a detected kink: remove the out-and-back spur interior and connect its
 * (near-coincident) endpoints directly. Undoable via the snap drag history.
 * @param {number} idx — index into ST.snapKinks
 */
function handleSnipKink(idx) {
  const kink = ST.snapKinks && ST.snapKinks[idx]
  if (!kink || !ST.gpx) return
  const { alo, ahi } = kink
  const N = ST.gpx.lats.length
  if (alo < 0 || ahi >= N || ahi - alo < 2) return

  // Staleness guard: the kink was detected on the route as it was at snap time.
  // If the geometry changed since (e.g. a LIDAR refetch resampled the route),
  // the indices are stale and snipping would cut the wrong points. The spur's
  // endpoints must still be near-coincident — abort if not.
  const chordNow = haversineMeters(ST.gpx.lats[alo], ST.gpx.lons[alo], ST.gpx.lats[ahi], ST.gpx.lons[ahi])
  if (chordNow > 30) {
    panels.snap.setProgress('Kink list is stale (route changed since snap) — re-run Auto-Snap')
    return
  }

  // Undo snapshot
  ST.snapDragHistory.push({
    gpx: { ...ST.gpx, lats: [...ST.gpx.lats], lons: [...ST.gpx.lons], eles: [...ST.gpx.eles] },
    dists: ST.dists instanceof Float64Array ? new Float64Array(ST.dists) : [...ST.dists],
    grOrig: ST.grOrig ? [...ST.grOrig] : null,
    eleClean: ST.eleClean ? [...ST.eleClean] : null,
    grClean: ST.grClean ? [...ST.grClean] : null,
    routeSegments: ST.routeSegments.map(s => s.map(p => [...p])),
    snapWaypoints: ST.snapWaypoints.map(w => ({ ...w })),
  })
  panels.snap.enableUndo(true)

  // Splice out the spur interior (keep alo and ahi — they are ~coincident, so
  // the connecting chord is < selfReturnM). removed = interior point count.
  const removed = ahi - alo - 1
  const keepLats = [...ST.gpx.lats.slice(0, alo + 1), ...ST.gpx.lats.slice(ahi)]
  const keepLons = [...ST.gpx.lons.slice(0, alo + 1), ...ST.gpx.lons.slice(ahi)]
  const keepEles = [...ST.gpx.eles.slice(0, alo + 1), ...ST.gpx.eles.slice(ahi)]

  // Commit
  ST.gpx = { ...ST.gpx, lats: keepLats, lons: keepLons, eles: keepEles }
  const rebuilt = rebuildRoute(keepLats, keepLons, keepEles, keepEles)
  ST.dists = rebuilt.dists instanceof Float64Array ? rebuilt.dists : new Float64Array(rebuilt.dists)
  ST.grOrig = rebuilt.grOrig
  ST.eleClean = [...keepEles]
  ST.grClean = rebuilt.grClean
  ST.routeSegments = rebuildSnapSegments(ST.snapWaypoints, keepLats, keepLons)
  ST.routeWaypoints = [...ST.snapWaypoints]

  invalidateFrom('snap')

  // Re-detect kinks; shift suspect spans that sit after the cut, drop overlaps
  const origG = ST.snapPreState && ST.snapPreState.gpx
  ST.snapKinks = origG ? detectSnapKinks(keepLats, keepLons, ST.dists, origG.lats, origG.lons) : []
  panels.snap.setKinks(ST.snapKinks, {
    onZoom: (i) => { zoomToSnapKink(i); drawAll(); drawMap() },
    onSnip: (i) => handleSnipKink(i),
  })
  ST.snapSuspects = (ST.snapSuspects || [])
    .filter(s => s.ahi <= alo || s.alo >= ahi)
    .map(s => s.alo >= ahi
      ? { ...s, alo: s.alo - removed, ahi: s.ahi - removed, peakIdx: (s.peakIdx ?? s.alo) - removed }
      : s)
  panels.snap.setSuspects(ST.snapSuspects, (i) => { zoomToSnapSuspect(i); drawAll(); drawMap() })

  panels.snap.setProgress(`Snipped kink at ${(kink.atM / 1000).toFixed(2)} km — ${keepLats.length} points`)
  refresh()
  drawMap()
  console.log(`[GPXForge] Snap: snipped kink at ${(kink.atM / 1000).toFixed(2)}km (removed ${removed} pts)`)
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
  ST.snapSuspects = []
  ST.snapKinks = []
  panels.snap.setSuspects([])
  panels.snap.setKinks([])

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

// ────────────────────────────────────────────────────────────────────
// Nudge tool — drag points on map, scroll wheel resizes affected range
// ────────────────────────────────────────────────────────────────────

const NUDGE_DEFAULT_RANGE = 30  // metres each side from drag center
const NUDGE_MIN_RANGE = 5
const NUDGE_MAX_RANGE = 300
const NUDGE_SCROLL_FACTOR = 1.2
// Mouse-move damping: the route moves this fraction of the cursor travel, so a
// given mouse movement nudges less per pixel (easier fine control). Scroll/range
// sensitivity is unaffected. Applies to both the XY nudge and the Z nudge.
const NUDGE_SENSITIVITY = 0.4

panels.snap.els.btnNudge.addEventListener('click', () => {
  ST.nudgeMode = !ST.nudgeMode
  if (ST.nudgeMode) {
    panels.snap.setNudgeRange(`Hold left button on route, drag to align, scroll to resize (${NUDGE_DEFAULT_RANGE}m)`)
  } else {
    ST.nudgeDragState = null
    panels.snap.setNudgeRange('')
  }
  panels.snap.setNudgeActive(ST.nudgeMode)
  // Update map cursor: crosshair when nudge active
  const mapEl = shell.getMapEl()
  if (mapEl) mapEl.style.cursor = ST.nudgeMode ? 'crosshair' : ''
  drawMap()
  drawAll()
})

function onNudgeStart(idx, lat, lon) {
  if (!ST.gpx || !ST.dists) return
  // Snapshot original positions for the drag so live preview can recompute cleanly
  ST.nudgeDragState = {
    centerIdx: idx,
    rangeM: NUDGE_DEFAULT_RANGE,
    origCenterLat: ST.gpx.lats[idx],
    origCenterLon: ST.gpx.lons[idx],
    cursorLat: lat,
    cursorLon: lon,
    // Snapshot all original lats/lons so we can repeatedly apply offsets from
    // the same baseline (no drift across many small mousemoves).
    origLats: [...ST.gpx.lats],
    origLons: [...ST.gpx.lons],
  }
  panels.snap.setNudgeRange(`±${NUDGE_DEFAULT_RANGE}m — drag to align, scroll to resize`)
  applyNudgePreview()
}

function onNudgeMove(lat, lon) {
  if (!ST.nudgeDragState) return
  ST.nudgeDragState.cursorLat = lat
  ST.nudgeDragState.cursorLon = lon
  applyNudgePreview()
}

function onNudgeWheel(dir) {
  if (!ST.nudgeDragState) return
  const s = ST.nudgeDragState
  if (dir === 'grow') s.rangeM = Math.min(NUDGE_MAX_RANGE, s.rangeM * NUDGE_SCROLL_FACTOR)
  else s.rangeM = Math.max(NUDGE_MIN_RANGE, s.rangeM / NUDGE_SCROLL_FACTOR)
  panels.snap.setNudgeRange(`±${Math.round(s.rangeM)}m — drag to align, scroll to resize`)
  applyNudgePreview()
}

function onNudgeEnd(lat, lon) {
  if (!ST.nudgeDragState) return
  ST.nudgeDragState.cursorLat = lat
  ST.nudgeDragState.cursorLon = lon

  // Compute final range in route indices
  const s = ST.nudgeDragState
  const centerDist = ST.dists[s.centerIdx]
  const dLo = centerDist - s.rangeM
  const dHi = centerDist + s.rangeM
  let lo = s.centerIdx, hi = s.centerIdx
  while (lo > 0 && ST.dists[lo - 1] >= dLo) lo--
  while (hi < ST.dists.length - 1 && ST.dists[hi + 1] <= dHi) hi++

  // Snapshot for undo (use snapDragHistory — existing Undo button handles it)
  // We stored snapshot of original lats/lons in nudgeDragState; build a full
  // snapshot of the pre-nudge state.
  const preLats = [...s.origLats]
  const preLons = [...s.origLons]
  ST.snapDragHistory.push({
    gpx: { ...ST.gpx, lats: preLats, lons: preLons, eles: [...ST.gpx.eles] },
    dists: ST.dists instanceof Float64Array ? new Float64Array(ST.dists) : [...ST.dists],
    grOrig: ST.grOrig ? [...ST.grOrig] : null,
    eleClean: ST.eleClean ? [...ST.eleClean] : null,
    grClean: ST.grClean ? [...ST.grClean] : null,
    routeSegments: ST.routeSegments.map(s2 => s2.map(p => [...p])),
    snapWaypoints: ST.snapWaypoints ? ST.snapWaypoints.map(w => ({ ...w })) : [],
  })
  panels.snap.enableUndo(true)

  // Apply final deformation (already done via applyNudgePreview, but ensure consistent)
  applyNudgePreview()

  // Rebuild distances/gradients for the route
  const { dists, grOrig, grClean } = rebuildRoute(ST.gpx.lats, ST.gpx.lons, ST.gpx.eles, ST.eleClean || ST.gpx.eles)
  ST.dists = dists instanceof Float64Array ? dists : new Float64Array(dists)
  ST.grOrig = grOrig
  ST.grClean = grClean

  // Queue range for LIDAR refresh (manual)
  if (!ST.pendingLidarRanges) ST.pendingLidarRanges = []
  ST.pendingLidarRanges.push({ lo, hi, origin: 'nudge' })
  refreshPendingLidarInfo()

  // Compute distance moved for the summary
  const newCenterLat = ST.gpx.lats[s.centerIdx]
  const newCenterLon = ST.gpx.lons[s.centerIdx]
  const movedM = haversineMeters(s.origCenterLat, s.origCenterLon, newCenterLat, newCenterLon)
  panels.snap.setNudgeRange(`Moved ${movedM.toFixed(1)}m (range ±${Math.round(s.rangeM)}m). Drag again or exit.`)
  sidebar.setStepStatus('snap', 'done', `${ST.gpx.lats.length} pts`)

  // Clear drag state, keep nudge mode on for the next drag
  ST.nudgeDragState = null

  drawMap()
  drawAll()
}

/**
 * Apply Gaussian-weighted offset to lats/lons within ±rangeM of centerIdx.
 * Uses origLats/origLons as baseline (so repeated mousemoves don't drift).
 */
function applyNudgePreview() {
  const s = ST.nudgeDragState
  if (!s || !ST.dists) return
  const N = ST.gpx.lats.length
  const centerDist = ST.dists[s.centerIdx]
  const dLat = (s.cursorLat - s.origCenterLat) * NUDGE_SENSITIVITY
  const dLon = (s.cursorLon - s.origCenterLon) * NUDGE_SENSITIVITY

  // Apply offset with cos² falloff. Points outside ±rangeM are unchanged.
  for (let i = 0; i < N; i++) {
    const d = ST.dists[i] - centerDist
    if (Math.abs(d) > s.rangeM) {
      ST.gpx.lats[i] = s.origLats[i]
      ST.gpx.lons[i] = s.origLons[i]
      continue
    }
    // t = -1..1 with 0 at center
    const t = d / s.rangeM
    // cos² weight: 1 at center, 0 at edges, smooth
    const w = Math.cos(t * Math.PI / 2) ** 2
    ST.gpx.lats[i] = s.origLats[i] + dLat * w
    ST.gpx.lons[i] = s.origLons[i] + dLon * w
  }
  // Only rebuild dists/gradients on END (final commit) for performance;
  // for live preview, only the visual positions need to update.
  drawMap()
}

// Simple haversine for the move-distance display
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const dφ = (lat2 - lat1) * Math.PI / 180
  const dλ = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

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
    const osmResult = buildBrunnelCorrections(ST.brunnels, ST.gpx.eles, ST.dists, shape)
    eleWork = osmResult.eleClean
    osmCorrs = osmResult.corrections
    panels.clean.appendLog(`${osmCorrs.length} brunnel corrections applied`, 'i')
  }

  panels.clean.appendLog('Running spike detection...', 'i')
  const autoApplyArtifacts = !isLowResSource(ST.lidarSource)
  const result = runCleaner(eleWork, ST.dists, params, ST.brunnels || [],
    { autoApplyArtifacts })
  if (!autoApplyArtifacts) {
    panels.clean.appendLog('Low-res source — artifacts left unchecked for review', 'i')
  }

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

  // Smoothing engine + min radius (one knob for every turn). Native fillets (default) round junctions
  // AND road bends to the same radius; processGPX is the legacy arc-fitting engine (selectable for A/B).
  // A compiled COURSE skips position-smoothing (σ done per-segment at finish) but still gets corner-
  // shaping — the native engine rounds its sharp junctions + bends to the chosen radius.
  const result = runSmoothing(ST.gpx.lats, ST.gpx.lons, baseEles, ST.dists, {
    origAvgSpacing: ST.origAvgSpacing,
    lidarSource: ST.lidarSource,
    sourceSegments: ST.sourceSegments,
    skipPositionSmooth: !!ST.courseArcs,
    engine: panels.smooth.getEngine(),
    minRadiusM: panels.smooth.getMinRadiusM(),
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

  // Draw mode stays active so the user can draw multiple sections in a row
  // (toggled off via the Draw button / 'D' key) — don't reset the button here.

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
  // Trim or snap change the route geometry — invalidate cached OSM way IDs
  // so the next brunnel run refetches against the new route.
  if (idx <= 1) {
    ST.routeWayIds = null
    ST.routeWayIdsSource = ''
    ST.routeRoundaboutFlags = null
    ST.routeJunctionNodes = null
  }
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
    panels.clean.appendLog('Draw mode ON — click two points per section; stays on for multiple. Click Draw (or D) to finish.', 'i')
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
    // Lazy-fetch OSM way IDs for the route — used as a filter to reject
    // brunnels on parallel roads. If routeWayIds is null (route changed since
    // last fetch) try to populate it. Failure is non-fatal — the brunnel
    // pipeline falls back to its existing logic.
    if (!ST.routeWayIds || ST.routeWayIds.length !== ST.gpx.lats.length) {
      try {
        panels.brunnels.els.progress.set(2)
        const { wayIds, roundaboutFlags, source } = await getRouteWayIds(ST.gpx.lats, ST.gpx.lons)
        ST.routeWayIds = wayIds
        ST.routeRoundaboutFlags = roundaboutFlags
        ST.routeWayIdsSource = source
        console.log(`[GPXForge] Way IDs resolved via ${source} (${wayIds.length} points)`)
      } catch (err) {
        console.warn('[GPXForge] Way matching failed, brunnels will skip way filter:', err.message)
        ST.routeWayIds = null
        ST.routeWayIdsSource = 'none'
      }
    }

    const result = await locateBrunnels(
      ST.gpx.lats, ST.gpx.lons, ST.dists, ST.gpx.eles,
      { ...params, routeWayIds: ST.routeWayIds },
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
  const result = buildBrunnelCorrections(ST.brunnels, ST.gpx.eles, ST.dists, shapeParams)

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

  // Before timing/export, make every pass of a reused road vertex-identical (XY+Z). Idempotent —
  // only runs when the course has a reused segment and an edit since the last unify un-set the flag.
  if (hasReusedSegments(ST.courseArcs) && !ST.reuseUnified) applyReuseReconcile({ commit: true })

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
  renderSplitSegments(generateSplits(ST.splitAnalysis, targetSec))
}

/**
 * Render a list of split segments into the info panel (shared by time- and
 * distance-based splitting).
 */
function renderSplitSegments(splits) {
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

// ────────────────────────────────────────────────────────────────────
// Split: Track editing (reverse / move-start / split-by-distance / crop / export)
// ────────────────────────────────────────────────────────────────────

/**
 * Read the active (finished) route as a {lats, lons, eles} triple, picking
 * the smoothed route when present, else the original gpx + cleaned elevations.
 * @returns {{ lats:number[], lons:number[], eles:number[], dists:Float64Array|number[], smoothed:boolean }}
 */
function getActiveRoute() {
  if (ST.smoothedRoute) {
    return {
      lats: ST.smoothedRoute.lats,
      lons: ST.smoothedRoute.lons,
      eles: ST.smoothedRoute.eles,
      dists: ST.smoothedRoute.dists,
      smoothed: true,
    }
  }
  return {
    lats: ST.gpx.lats,
    lons: ST.gpx.lons,
    eles: ST.eleClean || ST.gpx.eles,
    dists: ST.dists,
    smoothed: false,
  }
}

/**
 * The pre-smooth (snapped) route, ignoring any smoothed overlay. Topology must
 * read this: smoothing rounds away crossings/folds and changes the point count,
 * which degrades node placement and way-ID alignment. Smoothing is applied AFTER
 * the topology course is compiled, not before it's built.
 */
function getSnappedRoute() {
  return {
    lats: ST.gpx.lats,
    lons: ST.gpx.lons,
    eles: ST.eleClean || ST.gpx.eles,
  }
}

/**
 * Write a transformed {lats, lons, eles} triple back to the active route's
 * domain, rebuild derived arrays, invalidate split analysis, and refresh.
 */
function setActiveRoute(lats, lons, eles) {
  if (ST.smoothedRoute) {
    const dists = new Float64Array(cumulativeDistances(lats, lons))
    const total = dists[dists.length - 1] || 1
    // Keep origDists proportional to the original distance span (chart X mapping).
    const prev = ST.smoothedRoute
    const prevTotal = (prev.dists && prev.dists.length) ? prev.dists[prev.dists.length - 1] : total
    const prevOrigTotal = (prev.origDists && prev.origDists.length)
      ? prev.origDists[prev.origDists.length - 1] : prevTotal
    const origScale = prevOrigTotal / (prevTotal || 1)
    const origDists = new Float64Array(dists.length)
    for (let i = 0; i < dists.length; i++) origDists[i] = dists[i] * origScale
    const gr = grads(eles, dists)
    ST.smoothedRoute = { lats, lons, eles, dists, gr, origDists }
    ST.eleSmoothed = [...eles]
    ST.grSmoothed = gr instanceof Float64Array ? gr : new Float64Array(gr)
  } else {
    ST.gpx.lats = lats
    ST.gpx.lons = lons
    ST.gpx.eles = eles
    ST.eleClean = [...eles]
    const rebuilt = rebuildRoute(lats, lons, eles, ST.eleClean)
    ST.dists = rebuilt.dists
    ST.grOrig = rebuilt.grOrig
    ST.grClean = rebuilt.grClean
    // Geometry changed upstream of smooth — drop any smoothed overlay.
    ST.smoothedRoute = null
    ST.eleSmoothed = null
    ST.grSmoothed = null
  }
  // Any geometry edit invalidates timing analysis and selection — and un-unifies reused roads (the
  // edited pass now differs from its siblings until the next Unify/Analyze).
  ST.splitAnalysis = null
  ST.splitSegments = null
  ST.editSelection = null
  ST.reuseUnified = false
  panels.split.hideResults()
  refresh()
}

/** Push a whole-state snapshot so the edit can be undone. */
function pushEditHistory() {
  ST.editHistory.push(snapshotST())
  if (ST.editHistory.length > 20) ST.editHistory.shift()
}

/** Disarm both edit selection modes and reset the cursor/preview. */
function disarmEditModes() {
  ST.editSelectMode = false
  ST.editPivotMode = false
  ST.editSelStart = null
  ST.editSelEnd = null
  ST.editSelClickFrac = null
  ST.zNudgeMode = false
  ST.zNudgeDrag = null
}

// Reverse direction
panels.split.els.btnReverse.addEventListener('click', () => {
  if (!ST.gpx) return
  pushEditHistory()
  const r = getActiveRoute()
  const out = reverseTrack(r)
  setActiveRoute(out.lats, out.lons, out.eles)
  panels.split.setEditStatus('Route reversed. Re-run Analyze for timing.')
})

// Move start/finish (loops) — arm pivot click
panels.split.els.btnMoveStart.addEventListener('click', () => {
  if (!ST.gpx) return
  const r = getActiveRoute()
  if (!isLoop(r)) {
    panels.split.setEditStatus('Not a loop — start and end are far apart. Move-start needs a closed route.')
    return
  }
  disarmEditModes()
  ST.editPivotMode = true
  panels.split.setEditStatus('Click a point on the chart or map to set it as the new start/finish.')
  drawAll()
})

function onEditPivotClick(frac) {
  if (!ST.editPivotMode || !ST.gpx) return
  const r = getActiveRoute()
  if (!isLoop(r)) { disarmEditModes(); panels.split.setEditStatus('Not a loop.'); drawAll(); return }
  const pivot = Math.max(0, Math.min(r.lats.length - 1, Math.round(frac * (r.lats.length - 1))))
  ST.editPivotMode = false
  pushEditHistory()
  const out = rotateLoopTrack(r, pivot)
  setActiveRoute(out.lats, out.lons, out.eles)
  panels.split.setEditStatus('Start/finish moved. Re-run Analyze for timing.')
}

// Split by distance
panels.split.els.btnSplitDist.addEventListener('click', () => {
  if (!ST.gpx) return
  const km = parseFloat(panels.split.els.byDistInput.value)
  if (!(km > 0)) return
  // Analyze-if-needed so we have cumDist/cumTime/cumClimb to partition.
  if (!ST.splitAnalysis) {
    const { power, mass, groupRide } = panels.split.getParams()
    const r = getActiveRoute()
    ST.splitAnalysis = analyzeRoute(r.lats, r.lons, r.eles, power, mass, groupRide)
  }
  renderSplitSegments(generateSplitsByDistance(ST.splitAnalysis, km * 1000))
})

// Select range — arm drag-select
panels.split.els.btnSelectRange.addEventListener('click', () => {
  if (!ST.gpx) return
  disarmEditModes()
  ST.editSelectMode = true
  ST.editSelClickFrac = null
  panels.split.setEditStatus('Drag across the chart, or click the segment’s start then end on the map.')
  drawAll()
})

function onEditRangeSelect(lo, hi) {
  // lo/hi are indices in the ST.dists (original) domain — store as fractions
  // so the selection survives a domain switch (smoothed vs original).
  if (!ST.dists || !ST.dists.length) return
  const total = ST.dists[ST.dists.length - 1] || 1
  const fLo = ST.dists[lo] / total
  const fHi = ST.dists[hi] / total
  ST.editSelection = { fLo: Math.min(fLo, fHi), fHi: Math.max(fLo, fHi) }
  ST.editSelectMode = false
  const r = getActiveRoute()
  const span = (r.dists[r.dists.length - 1] || 0) * (ST.editSelection.fHi - ST.editSelection.fLo)
  panels.split.setEditStatus(`Selection: ${(span / 1000).toFixed(1)} km. Crop or Export.`)
  updateEditButtons()
  drawAll()
}

/**
 * Two-click range selection on the map: first click sets one end, second commits.
 * @param {number} frac — clicked point's distance fraction along the active route
 */
function onEditRangeClick(frac) {
  if (!ST.editSelectMode) return
  if (ST.editSelClickFrac == null) {
    ST.editSelClickFrac = frac
    panels.split.setEditStatus('Now click the other end of the segment on the map.')
    drawMap()
    return
  }
  const fLo = Math.min(ST.editSelClickFrac, frac), fHi = Math.max(ST.editSelClickFrac, frac)
  ST.editSelClickFrac = null
  ST.editSelectMode = false
  if (fHi - fLo > 0.001) {
    ST.editSelection = { fLo, fHi }
    const r = getActiveRoute()
    const span = (r.dists[r.dists.length - 1] || 0) * (fHi - fLo)
    panels.split.setEditStatus(`Selection: ${(span / 1000).toFixed(1)} km. Crop / Export / Offset / Split overlap.`)
  } else {
    panels.split.setEditStatus('Segment too short — try again.')
  }
  updateEditButtons()
  drawAll()
  drawMap()
}

// ── Z nudge: drag a point up/down on the elevation chart (cos² falloff) ──
const Z_NUDGE_DEFAULT_RANGE = 20  // metres each side (smaller than XY — fine elevation tweaks)

panels.split.els.btnZNudge.addEventListener('click', () => {
  if (!ST.gpx) return
  disarmEditModes()
  ST.zNudgeMode = !ST.zNudgeMode
  panels.split.setEditStatus(ST.zNudgeMode
    ? 'Z nudge: hold on the elevation line, drag up/down, scroll to resize.'
    : '')
  updateEditButtons()
  drawAll()
})

function onZNudgeStart(distM, startClientY, mPerPx) {
  if (!ST.zNudgeMode || !ST.gpx) return
  const r = getActiveRoute()
  const total = ST.dists[ST.dists.length - 1] || 1
  const aTotal = r.dists[r.dists.length - 1] || 1
  const centerIdx = bsearchDists(r.dists, (distM / total) * aTotal)
  pushEditHistory()
  ST.zNudgeDrag = {
    centerIdx, rangeM: Z_NUDGE_DEFAULT_RANGE,
    origEles: [...r.eles], startClientY, lastClientY: startClientY, mPerPx, moved: 0,
  }
  applyZNudgePreview(startClientY)
}

function onZNudgeMove(clientY) {
  if (ST.zNudgeDrag) applyZNudgePreview(clientY)
}

function onZNudgeWheel(dir) {
  const s = ST.zNudgeDrag
  if (!s) return
  if (dir === 'grow') s.rangeM = Math.min(NUDGE_MAX_RANGE, s.rangeM * NUDGE_SCROLL_FACTOR)
  else s.rangeM = Math.max(NUDGE_MIN_RANGE, s.rangeM / NUDGE_SCROLL_FACTOR)
  applyZNudgePreview(s.lastClientY)
}

function applyZNudgePreview(clientY) {
  const s = ST.zNudgeDrag
  if (!s) return
  s.lastClientY = clientY
  const r = getActiveRoute()
  const eles = r.eles, dists = r.dists
  const centerDist = dists[s.centerIdx]
  const deltaEle = (s.startClientY - clientY) * s.mPerPx * NUDGE_SENSITIVITY  // up = raise
  s.moved = deltaEle
  for (let i = 0; i < eles.length; i++) {
    const d = dists[i] - centerDist
    if (Math.abs(d) > s.rangeM) { eles[i] = s.origEles[i]; continue }
    const w = Math.cos((d / s.rangeM) * Math.PI / 2) ** 2
    eles[i] = s.origEles[i] + deltaEle * w
  }
  drawAll()
}

function onZNudgeEnd(clientY) {
  if (!ST.zNudgeDrag) return
  applyZNudgePreview(clientY)
  const s = ST.zNudgeDrag
  ST.zNudgeDrag = null
  if (Math.abs(s.moved) < 0.01) {
    // No real change — discard the snapshot we pushed at grab time.
    if (ST.editHistory.length) ST.editHistory.pop()
    updateEditButtons()
    return
  }
  const r = getActiveRoute()
  setActiveRoute(r.lats, r.lons, [...r.eles])  // rebuild gradients; eles already mutated
  // Edited-pass-wins: the pass under this nudge becomes the authority for its segment.
  const cd = r.dists[s.centerIdx]
  let lo = s.centerIdx, hi = s.centerIdx
  while (lo > 0 && cd - r.dists[lo - 1] <= s.rangeM) lo--
  while (hi < r.dists.length - 1 && r.dists[hi + 1] - cd <= s.rangeM) hi++
  markReuseAuthority(lo, hi)
  panels.split.setEditStatus(`Elevation nudged ${s.moved >= 0 ? '+' : ''}${s.moved.toFixed(1)} m (±${Math.round(s.rangeM)} m). Drag again or exit.`)
}

/** Resolve the committed fraction selection to indices in the active route. */
function resolveSelectionIndices() {
  const r = getActiveRoute()
  const total = r.dists[r.dists.length - 1] || 1
  const alo = bsearchDists(r.dists, ST.editSelection.fLo * total)
  const ahi = bsearchDists(r.dists, ST.editSelection.fHi * total)
  return { r, alo: Math.min(alo, ahi), ahi: Math.max(alo, ahi) }
}

// Crop to selection (mutates active route)
panels.split.els.btnCrop.addEventListener('click', () => {
  if (!ST.gpx || !ST.editSelection) return
  const { r, alo, ahi } = resolveSelectionIndices()
  if (ahi - alo < 2) { panels.split.setEditStatus('Selection too short to crop.'); return }
  pushEditHistory()
  const out = sliceTrack(r, alo, ahi)
  setActiveRoute(out.lats, out.lons, out.eles)
  panels.split.setEditStatus('Cropped to selection. Re-run Analyze for timing.')
})

// Export selection as GPX (route unchanged)
panels.split.els.btnExportSel.addEventListener('click', () => {
  if (!ST.gpx || !ST.editSelection) return
  const { r, alo, ahi } = resolveSelectionIndices()
  const lats = r.lats.slice(alo, ahi + 1)
  const lons = r.lons.slice(alo, ahi + 1)
  const eles = r.eles.slice(alo, ahi + 1)
  const base = ST.filename.replace(/\.gpx$/i, '') || 'route'
  const gpxStr = buildGPXString(lats, lons, eles, `${base}_segment`)
  downloadGPX(gpxStr, `${base}_segment.gpx`)
})

// Append GPX — load a second track and join it to the active route
panels.split.els.btnAppend.addEventListener('click', () => {
  if (!ST.gpx) return
  panels.split.els.appendFileInput.value = '' // allow re-selecting the same file
  panels.split.els.appendFileInput.click()
})

panels.split.els.appendFileInput.addEventListener('change', (ev) => {
  const file = ev.target.files && ev.target.files[0]
  if (!file || !ST.gpx) return
  const reader = new FileReader()
  reader.onload = () => {
    let parsed
    try {
      parsed = parseGPX(String(reader.result))
    } catch (e) {
      panels.split.setEditStatus('Could not read that GPX file.')
      return
    }
    if (!parsed.lats || parsed.lats.length < 2) {
      panels.split.setEditStatus('Appended GPX has no track points.')
      return
    }
    pushEditHistory()
    const base = getActiveRoute()
    const add = { lats: parsed.lats, lons: parsed.lons, eles: parsed.eles }
    const seam = panels.split.getSeamOpts()
    const out = mergeTracks(base, add, {
      overlap: true,
      blend: seam.blend ? { xyRadiusM: seam.xyRadiusM, zHalfCount: seam.zHalfCount } : null,
    })
    setActiveRoute(out.lats, out.lons, out.eles)
    const dirWord = out.mode.startsWith('prepend') ? 'before' : 'after'
    const flipped = out.mode.endsWith('flip') ? ', reversed to fit' : ''
    const trimNote = out.baseTrimmed > 0 ? `, trimmed ${out.baseTrimmed} overlapping pts` : ''
    panels.split.setEditStatus(
      `Appended ${parsed.lats.length} pts ${dirWord} route (join gap ${Math.round(out.gapM)} m${flipped}${trimNote}). Re-run Analyze for timing.`)
  }
  reader.onerror = () => panels.split.setEditStatus('Could not read that GPX file.')
  reader.readAsText(file)
})

// Lane split — dual-lane out-and-back
panels.split.els.btnLaneSplit.addEventListener('click', () => {
  if (!ST.gpx) return
  const r = getActiveRoute()
  if (r.lats.length < 3) { panels.split.setEditStatus('Route too short to lane-split.'); return }
  if (isLoop(r)) { panels.split.setEditStatus('Lane split needs a one-way (non-loop) route.'); return }
  const { gapM, side } = panels.split.getLaneSplitOpts()
  pushEditHistory()
  const out = laneSplit({ lats: r.lats, lons: r.lons, eles: r.eles }, { gapM, side, minRadiusM: 6, turnaroundMinRadiusM: 6 })
  setActiveRoute(out.lats, out.lons, out.eles)
  panels.split.setEditStatus(
    `Lane split: ${gapM} m gap, out leg on ${side}, turnaround R≈${out.turnRadiusM.toFixed(1)} m. Re-run Analyze for timing.`)
})

// Offset: same tool for XY (lateral) or Z (elevation). Axis toggle picks the
// dimension; side toggle picks the direction (right/left for XY, up/down for Z).
// With a selection → shift just that section; without → the whole route.
panels.split.els.btnOffsetSel.addEventListener('click', () => {
  if (!ST.gpx) return
  const { gapM, side, axis } = panels.split.getLaneSplitOpts()

  // ── Z axis: raise/lower elevation by the gap (up by default, down when 'left'). ──
  if (axis === 'z') {
    const sgnZ = side === 'left' ? -1 : 1
    const dir = sgnZ > 0 ? 'up' : 'down'
    if (!ST.editSelection) {
      const r = getActiveRoute()
      pushEditHistory()
      const eles = r.eles.map(e => e + sgnZ * gapM)
      setActiveRoute(r.lats, r.lons, eles)
      panels.split.setEditStatus(`Whole route raised ${dir} ${gapM} m. Re-run Analyze for timing.`)
      return
    }
    const { r, alo, ahi } = resolveSelectionIndices()
    if (ahi - alo < 2) { panels.split.setEditStatus('Selection too short to offset.'); return }
    pushEditHistory()
    const eles = offsetElevationSection(r.eles, r.dists, alo, ahi, sgnZ * gapM)
    setActiveRoute(r.lats, r.lons, eles)
    markReuseAuthority(alo, ahi)
    panels.split.setEditStatus(`Section moved ${dir} ${gapM} m (ramped joins). Re-run Analyze for timing.`)
    return
  }

  // ── XY axis: lateral offset (left/right). ──
  const sgn = side === 'right' ? -1 : 1

  // No selection → nudge the whole active route laterally by the gap.
  if (!ST.editSelection) {
    const r = getActiveRoute()
    pushEditHistory()
    const off = offsetPolyline(r.lats, r.lons, sgn * gapM)
    setActiveRoute(off.lats, off.lons, [...r.eles])
    panels.split.setEditStatus(`Whole route nudged ${gapM} m to ${side}. Re-run Analyze for timing.`)
    return
  }

  const { r, alo, ahi } = resolveSelectionIndices()
  if (ahi - alo < 2) { panels.split.setEditStatus('Selection too short to offset.'); return }
  const seam = panels.split.getSeamOpts()
  pushEditHistory()
  let out = offsetSection(r.lats, r.lons, r.eles, alo, ahi, sgn * gapM)
  if (seam.blend) {
    // Blend both joints (later index first so the earlier index stays valid).
    for (const idx of [out.seamHi, out.seamLo].filter(i => i > 1 && i < out.lats.length - 1)) {
      out = { ...out, ...blendSeam(out.lats, out.lons, out.eles, idx, { xyRadiusM: seam.xyRadiusM, zHalfCount: seam.zHalfCount }) }
    }
  }
  setActiveRoute(out.lats, out.lons, out.eles)
  markReuseAuthority(alo, ahi)
  panels.split.setEditStatus(`Offset section by ${gapM} m to ${side}. Re-run Analyze for timing.`)
})

// Separate an existing out/back overlap into two lanes within the selection
panels.split.els.btnSepOverlap.addEventListener('click', () => {
  if (!ST.gpx || !ST.editSelection) return
  const { r, alo, ahi } = resolveSelectionIndices()
  const { gapM, side } = panels.split.getLaneSplitOpts()
  const seam = panels.split.getSeamOpts()
  pushEditHistory()
  let out = separateOverlap(r.lats, r.lons, r.eles, alo, ahi, gapM, side)
  if (!out) {
    ST.editHistory.pop() // nothing changed — discard the snapshot
    panels.split.setEditStatus('No matching opposite pass found for this selection — select the overlapping stretch on one pass.')
    updateEditButtons()
    return
  }
  if (seam.blend) {
    for (const idx of [...out.seams].sort((a, b) => b - a).filter(i => i > 1 && i < out.lats.length - 1)) {
      out = { ...out, ...blendSeam(out.lats, out.lons, out.eles, idx, { xyRadiusM: seam.xyRadiusM, zHalfCount: seam.zHalfCount }) }
    }
  }
  setActiveRoute(out.lats, out.lons, out.eles)
  const extra = out.loopClosed ? ', closed into a loop' : (out.apexMerged ? ', teardrop turnaround added' : '')
  panels.split.setEditStatus(`Overlap separated (lanes ~${out.sepM.toFixed(1)} m apart${extra}). Re-run Analyze for timing.`)
})

// Unify an out/back (or lap) overlap: force the matched opposite pass onto the
// selected one (identical XY + Z) so BikeTerra renders a single shared road.
panels.split.els.btnUnifyOverlap.addEventListener('click', () => {
  if (!ST.gpx || !ST.editSelection) return
  const { r, alo, ahi } = resolveSelectionIndices()
  pushEditHistory()
  const out = unifyOverlap(r.lats, r.lons, r.eles, alo, ahi)
  if (!out) {
    ST.editHistory.pop() // nothing changed — discard the snapshot
    panels.split.setEditStatus('No matching opposite pass found for this selection — select the overlapping stretch on one pass.')
    updateEditButtons()
    return
  }
  setActiveRoute(out.lats, out.lons, out.eles)
  panels.split.setEditStatus(
    `Overlap unified: the ${out.reversed ? 'return' : 'repeat'} pass now shares the selected road exactly (one rendered road). Re-run Analyze for timing.`)
})

// ── Unify reused roads — graph-known reuse: stamp the (edited) authority pass onto every sibling. ──
panels.split.els.btnUnifyReused.addEventListener('click', () => {
  const done = applyReuseReconcile({ commit: true })
  if (!done) panels.split.setEditStatus('No reused roads to unify (the course has no repeated segment).')
})

/**
 * Force every pass of a reused course road to be vertex-identical (XY+Z), using the graph provenance
 * (`ST.courseArcs`) and the edited-pass-wins authority (`ST.segAuthority`). With `commit`, pushes an
 * undo snapshot + writes back via setActiveRoute; without, returns the reconciled arrays (for export).
 * @returns {{lats,lons,eles}|true|null} reconciled arrays (no-commit), true (committed), or null (no-op).
 */
function applyReuseReconcile({ commit } = {}) {
  if (!hasReusedSegments(ST.courseArcs) || !ST.gpx) return null
  const r = getActiveRoute()
  const out = reconcileReusedRoads(
    { lats: r.lats, lons: r.lons, eles: r.eles, dists: r.dists },
    ST.courseArcs,
    { authority: ST.segAuthority || {} },
  )
  if (!out) return null
  if (!commit) return { lats: out.lats, lons: out.lons, eles: out.eles }
  pushEditHistory()
  setActiveRoute(out.lats, out.lons, out.eles)   // clears ST.reuseUnified
  ST.reuseUnified = true                          // …then mark unified (idempotence guard)
  panels.split.setEditStatus(`Reused roads unified: ${out.reused} segment(s) now have identical XY+Z on every pass (the edited pass wins). Re-run Analyze for timing.`)
  return true
}

/**
 * Record edited-pass-wins authority: the arcs overlapping a just-edited track range [lo,hi] become the
 * winning passes for their segments. Called from the geometry/elevation edit commit paths so a manual
 * fix on one pass propagates to its reused siblings on the next Unify/download.
 */
function markReuseAuthority(lo, hi) {
  if (!hasReusedSegments(ST.courseArcs) || !ST.gpx) return
  const r = getActiveRoute()
  const auth = authorityForEditedRange({ lats: r.lats, lons: r.lons, eles: r.eles, dists: r.dists }, ST.courseArcs, lo, hi)
  ST.segAuthority = { ...(ST.segAuthority || {}), ...auth }
}

// ── Topology: compile a hand-authored route-graph JSON → flat GPX (directed-graph model). ──

/** Compile a parsed route-graph object and download the resulting flat GPX. */
function compileGraphAndDownload(graph, baseName = 'route-graph') {
  const v = validateRouteGraph(graph)
  if (!v.ok) {
    panels.split.setEditStatus(`Graph invalid: ${v.errors[0]}${v.errors.length > 1 ? ` (+${v.errors.length - 1} more)` : ''}`)
    console.warn('[route-graph] validation errors:\n  ' + v.errors.join('\n  '))
    return null
  }
  const out = compileRouteGraph(graph)
  const gpxStr = buildGPXString(out.lats, out.lons, out.eles, baseName)
  downloadGPX(gpxStr, `${baseName}.gpx`)
  panels.split.setEditStatus(`Compiled ${graph.route.length} arc(s) → ${out.lats.length} points, downloaded ${baseName}.gpx`)
  return out
}

// Console hook for hand-built graphs (djconnel's "create the data structure by hand as a test").
// Usage: gpxforgeCompileGraph(graphObject) → downloads the GPX and returns {lats,lons,eles,arcBounds}.
if (typeof window !== 'undefined') window.gpxforgeCompileGraph = (g, name) => compileGraphAndDownload(g, name)

panels.split.els.btnGraphCompile.addEventListener('click', () => panels.split.els.graphFileInput.click())
panels.split.els.graphFileInput.addEventListener('change', (ev) => {
  const file = ev.target.files && ev.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    let graph
    try { graph = JSON.parse(reader.result) }
    catch (e) { panels.split.setEditStatus('Graph JSON parse error: ' + e.message); return }
    const base = file.name.replace(/\.json$/i, '') || 'route-graph'
    compileGraphAndDownload(graph, base)
  }
  reader.readAsText(file)
  ev.target.value = '' // allow re-loading the same file
})

// Undo edit
panels.split.els.btnUndoEdit.addEventListener('click', () => {
  if (!ST.editHistory.length) return
  restoreST(ST.editHistory.pop())
  ST.activeStep = 'split'
  disarmEditModes()
  panels.split.hideResults()
  panels.split.setEditStatus('Edit undone.')
  refresh()
})

// ── Topology editor (annotate the active route into a directed graph) ──

/** Re-render the topology segment list, course sequence, + button states. */
function refreshTopologyPanel() {
  const active = topology.isTopologyActive()
  const building = topology.isBuildingCourse()
  panels.split.setTopoActive(active, building)
  panels.split.renderTopoCourse(building ? topology.getCourse() : null)
  panels.split.renderTopoSegments(active ? topology.getSegmentSummaries() : null, (segId) => {
    // Clicking a segment row: append to the course while building, else select for merge.
    if (topology.isBuildingCourse()) topology.appendToCourse(segId)
    else topology.toggleSegmentSelection(segId)
    refreshTopologyPanel()
  })
}

topology.setTopologyCallbacks({
  onUpdate: () => { drawMap(); refreshTopologyPanel() },
  onStatus: (msg) => panels.split.setEditStatus(msg),
})

panels.split.els.btnTopoEnter.addEventListener('click', () => {
  if (!ST.gpx) return
  // Always annotate the pre-smooth (snapped) route — never the smoothed overlay.
  const r = getSnappedRoute()
  if (!topology.enterTopology(r)) return
  document.body.classList.add('topology-active')
  disarmEditModes()
  refreshTopologyPanel()
  drawMap()
  if (ST.smoothedRoute) {
    panels.split.setEditStatus('Topology editor opened on the snapped route (the smoothed overlay is ignored — smoothing applies after Compile→route).')
  }
})

panels.split.els.btnTopoDetect.addEventListener('click', async () => {
  const base = topology.getTopologyBaseRoute()
  if (!base) return
  const btn = panels.split.els.btnTopoDetect
  btn.disabled = true
  panels.split.setEditStatus('Detecting structure (resolving OSM junctions)…')
  try {
    // Reuse the cached OSM junction nodes when they line up with the route being edited;
    // otherwise resolve way IDs + junction nodes once (same path the roundabout detect uses).
    let nodes = ST.routeJunctionNodes
    if (!nodes || (ST.routeWayIds && ST.routeWayIds.length !== base.lats.length)) {
      const r = await getRouteWayIds(base.lats, base.lons)
      nodes = r.junctionNodes
      if (ST.gpx && base.lats.length === ST.gpx.lats.length) {
        ST.routeWayIds = r.wayIds; ST.routeRoundaboutFlags = r.roundaboutFlags
        ST.routeJunctionNodes = r.junctionNodes; ST.routeWayIdsSource = r.source
      }
    }
    topology.detectStructure({ junctionNodes: nodes || [] })
    drawMap()
  } catch (err) {
    console.warn('[GPXForge] structure detection failed:', err)
    // Graceful fallback: geometric folds only (no OSM node data).
    topology.detectStructure({ junctionNodes: [] })
    drawMap()
  } finally {
    btn.disabled = false
  }
})

panels.split.els.btnTopoComplete.addEventListener('click', async () => {
  const centers = topology.getJunctionCenters()
  if (!centers.length) { panels.split.setEditStatus('Run ⊕ Detect structure first.'); return }
  const btn = panels.split.els.btnTopoComplete
  btn.disabled = true
  panels.split.setEditStatus('Fetching junction cross-streets from OSM…')
  try {
    const ways = await fetchJunctionWays(centers)
    topology.completeJunctions(ways)
    drawMap()
  } catch (err) {
    console.warn('[GPXForge] complete junctions failed:', err)
    panels.split.setEditStatus('Could not fetch OSM ways (Overpass offline) — junctions left as recorded.')
  } finally {
    btn.disabled = false
  }
})

panels.split.els.btnTopoRoundabouts.addEventListener('click', async () => {
  const base = topology.getTopologyBaseRoute()
  if (!base) return
  const btn = panels.split.els.btnTopoRoundabouts
  btn.disabled = true
  panels.split.setEditStatus('Detecting roundabouts (resolving OSM way IDs)…')
  try {
    // Reuse the brunnel-step cache when it lines up with the route being edited;
    // otherwise resolve way IDs + roundabout flags once for this route.
    let flags = ST.routeRoundaboutFlags, ways = ST.routeWayIds
    if (!flags || flags.length !== base.lats.length) {
      const r = await getRouteWayIds(base.lats, base.lons)
      flags = r.roundaboutFlags; ways = r.wayIds
      if (ST.gpx && base.lats.length === ST.gpx.lats.length) {
        ST.routeWayIds = ways; ST.routeRoundaboutFlags = flags; ST.routeWayIdsSource = r.source
      }
    }
    const traversals = detectRoundabouts(base.lats, base.lons, flags, ways)
    if (!traversals.length) {
      topology.setRoundabouts([]); drawMap()
      panels.split.setEditStatus('No roundabouts found on this route (OSM way data shows none).')
      return
    }
    // Highlight the detected on-ring spans IMMEDIATELY (fast — from Valhalla flags).
    const list = traversals.map((t) => ({ ...t, ringPoints: null }))
    topology.setRoundabouts(list)
    drawMap()
    const ringCount = new Set(traversals.map((t) => t.ringWayId).filter(Boolean)).size
    panels.split.setEditStatus(`${traversals.length} roundabout traversal(s) across ${ringCount || '?'} ring(s) — highlighted (magenta). Fetching canonical rings…`)

    // Then pull each unique ring's full canonical geometry from OSM (best-effort,
    // cached). Don't block the highlight on it — Overpass can be slow/down.
    let gotRing = false
    const seen = new Set()
    for (const t of traversals) {
      if (!t.ringWayId || seen.has(t.ringWayId)) continue
      seen.add(t.ringWayId)
      const ring = await fetchRing(t.ringWayId)
      if (ring && ring.points) {
        gotRing = true
        for (const item of list) if (item.ringWayId === t.ringWayId) item.ringPoints = ring.points
        topology.setRoundabouts(list); drawMap()
      }
    }
    panels.split.setEditStatus(`${traversals.length} roundabout traversal(s) across ${ringCount || '?'} ring(s) — highlighted (magenta)${gotRing ? ' + canonical ring (dashed)' : ' (canonical ring unavailable — OSM offline)'}.`)
  } catch (err) {
    console.warn('[GPXForge] roundabout detection failed:', err)
    panels.split.setEditStatus('Roundabout detection failed (OSM way data unavailable).')
  } finally {
    btn.disabled = false
  }
})
panels.split.els.btnTopoMerge.addEventListener('click', () => { topology.mergeSelected() })
panels.split.els.btnTopoSnap.addEventListener('click', () => { topology.snapCrossing() })
panels.split.els.btnTopoUndo.addEventListener('click', () => { topology.undoTopology() })
panels.split.els.btnTopoBuild.addEventListener('click', () => {
  if (topology.isBuildingCourse()) topology.stopCourse()
  else topology.startCourse()
})
panels.split.els.btnTopoStepBack.addEventListener('click', () => { topology.undoCourseStep() })
panels.split.els.btnTopoFlip.addEventListener('click', () => { topology.flipCourseStart() })

const compileTopologyOut = () =>
  panels.split.els.topoRoundToggle.checked
    ? topology.compileTopologyRounded()
    : topology.compileTopology()

panels.split.els.btnTopoCompile.addEventListener('click', () => {
  const out = compileTopologyOut()
  if (!out) return
  const base = (ST.filename || 'route').replace(/\.gpx$/i, '')
  downloadGPX(buildGPXString(out.lats, out.lons, out.eles, `${base}_topology`), `${base}_topology.gpx`)
})

panels.split.els.btnTopoApply.addEventListener('click', () => {
  const out = compileTopologyOut()
  if (!out) return
  topology.exitTopology()
  document.body.classList.remove('topology-active')
  pushEditHistory()
  // The compiled course is in snapped (pre-smooth) geometry, so it must become the
  // BASE route. Drop any stale smoothed overlay so setActiveRoute writes the original
  // domain and the user re-runs Smooth on the compiled course.
  ST.smoothedRoute = null
  ST.eleSmoothed = null
  ST.grSmoothed = null
  setActiveRoute(out.lats, out.lons, out.eles)
  refreshTopologyPanel()
  panels.split.setEditStatus('Topology compiled into the active route (smoothed overlay cleared — re-run Smooth, then Analyze).')
})

panels.split.els.btnTopoExit.addEventListener('click', () => {
  topology.exitTopology()
  document.body.classList.remove('topology-active')
  refreshTopologyPanel()
  drawMap()
})

