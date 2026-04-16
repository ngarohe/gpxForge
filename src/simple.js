/**
 * GPXForge Simple — auto-pipeline orchestrator.
 *
 * Wires the simple UI to the shared pipeline, chart, and map modules.
 * Four flows: Create Route, Upload+LIDAR, Upload+CleanOnly, Download.
 */

import { ST } from './state.js'
import { pushHistory, performUndo, canUndo } from './state.js'
import { grads, cumulativeDistances, ascDesc } from './utils/math.js'
import { buildGPXString, downloadGPX } from './utils/gpx.js'
import { buildDownloadFilename } from './utils/download-name.js'
import { getTargetResolution, densifyForLidar, detectPrimaryCountry } from './utils/resolution.js'
import { detectStartEndOverlap } from './utils/geometry.js'
import { fetchLidarElevations } from './api/lidar.js'
import { searchPlace, searchPlaceSuggestions } from './api/place-search.js'
import { rebuildRoute } from './pipeline/0-trim.js'
import { applyInterp, classifyStructure, DEFAULT_SHAPE_PARAMS } from './pipeline/3-clean.js'
import { runAutoPipeline } from './modes/auto-pipeline.js'
import { runSmoothing } from './pipeline/4-smooth.js'
import {
  enterBuilderMode, exitBuilderMode, finishRouteBuilder,
  onBuilderMapClick, onBuilderWaypointDrag, onBuilderDeleteWaypoint,
  onBuilderInsertWaypoint, isBuilderActive,
  getBuilderWaypoints, getBuilderDistance,
  builderUndo, builderCanUndo, builderClear,
  setBuilderMode, setBuilderProfile,
} from './modes/route-builder.js'
import { initChart, drawAll, zoomToCorr } from './chart/index.js'
import { buildColors } from './chart/shared.js'
import { initMap, drawMap, mapFit, mapGoTo, mapFitBounds } from './map/index.js'
import { initCorrections } from './ui/corrections.js'
import { buildSimpleApp } from './ui/simple-ui.js'
import { loadGpxFile } from './ui/shell.js'

console.log('[GPXForge Simple] v0.1.0 ready')

// ────────────────────────────────────────────────────────────────────
// Build UI
// ────────────────────────────────────────────────────────────────────

const ui = buildSimpleApp()
const { landing, builder, processing, review } = ui

// ────────────────────────────────────────────────────────────────────
// Shared map — single Leaflet instance, reparented between views
// ────────────────────────────────────────────────────────────────────

let mapInited = false
let chartInited = false
let corrPanel = null

// A shared map container that lives inside whichever view needs it
const sharedMapEl = document.createElement('div')
sharedMapEl.className = 'map-panel'
sharedMapEl.id = 'mapPanel'
sharedMapEl.style.width = '100%'
sharedMapEl.style.height = '100%'

function ensureMap(container) {
  container.appendChild(sharedMapEl)
  if (!mapInited) {
    initMap(sharedMapEl, {
      selectCorr: handleSelectCorr,
      trimClick: () => {},
      snapAddWp: () => {},
      snapDeleteWp: () => {},
      builderClick: (lat, lon) => onBuilderMapClick(lat, lon),
      builderDeleteWp: (idx) => onBuilderDeleteWaypoint(idx),
      builderDragWp: (idx, lat, lon) => onBuilderWaypointDrag(idx, lat, lon),
      builderInsertOnSeg: (segIdx, lat, lon) => onBuilderInsertWaypoint(segIdx, lat, lon),
    })
    mapInited = true
  }
  // ResizeObserver in map/index.js handles invalidateSize automatically
}

function ensureChart() {
  if (chartInited) return
  initChart(review.chartEls, {
    commitDrag: handleCommitDrag,
    commitDraw: handleCommitDraw,
    removeCorr: () => {},
    selectCorr: handleSelectCorr,
    trimClick: () => {},
  })
  chartInited = true
}

function ensureCorrections() {
  if (corrPanel) return
  corrPanel = initCorrections(review.corrPanel, {
    onAccept: handleAcceptCorr,
    onReject: handleRejectCorr,
    onSelect: handleSelectCorr,
    onRemove: () => {},
  })
}

// ────────────────────────────────────────────────────────────────────
// Landing — Create Route
// ────────────────────────────────────────────────────────────────────

landing.btnCreate.addEventListener('click', () => {
  ui.showView('builder')
  ensureMap(builder.mapContainer)

  // Set map cursor to crosshair
  sharedMapEl.style.cursor = 'crosshair'

  enterBuilderMode({
    onUpdate: onBuilderUpdate,
    onStatusChange: (msg) => builder.setStatus(msg),
  })
  drawMap()
})

landing.btnUpload.addEventListener('click', () => {
  landing.fileInput.click()
})

landing.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  const loaded = await loadGpxFile(file)
  if (!loaded) return
  await runFullPipeline(true)
})

builder.btnBack.addEventListener('click', () => {
  if (isBuilderActive()) exitBuilderMode()
  sharedMapEl.style.cursor = ''
  ui.showView('landing')
  drawMap()
})

builder.btnUndo.addEventListener('click', () => {
  builderUndo()
})

builder.btnRouted.addEventListener('click', () => {
  setBuilderMode('routed')
  builder.setMode('routed')
})

builder.btnManual.addEventListener('click', () => {
  setBuilderMode('manual')
  builder.setMode('manual')
})

builder.profileSelect.addEventListener('change', () => {
  setBuilderProfile(builder.profileSelect.value)
})

builder.btnPlaceSearch.addEventListener('click', () => {
  runSimpleBuilderPlaceSearch()
})

builder.placeSearchInput.addEventListener('input', () => {
  queueSimpleBuilderPlaceSuggest()
})

builder.placeSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    runSimpleBuilderPlaceSearch()
  }
})

document.addEventListener('click', (e) => {
  if (e.target === builder.placeSearchInput) return
  if (e.target?.classList?.contains('builder-place-suggest-item')) return
  builder.hidePlaceSuggestions()
})

builder.btnClear.addEventListener('click', () => {
  if (confirm('Clear all waypoints?')) builderClear()
})

builder.btnDone.addEventListener('click', async () => {
  const result = finishRouteBuilder()
  if (!result) return

  sharedMapEl.style.cursor = ''
  populateSTFromBuilder(result)
  await runFullPipeline(true) // withLidar = true
})

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Builder mode: Ctrl+Z — undo last waypoint
  if (isBuilderActive()) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      if (builderCanUndo()) builderUndo()
    }
    return
  }

  // Review mode: S key — open Google Street View at hovered point
  if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (ST.hoverIdx != null && ST.gpx) {
      const lat = ST.gpx.lats[ST.hoverIdx]
      const lon = ST.gpx.lons[ST.hoverIdx]
      window.open(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`, '_blank')
    }
  }
})

function onBuilderUpdate() {
  const wps = getBuilderWaypoints()
  const dist = getBuilderDistance()
  builder.setStats(wps.length, dist)
  builder.setUndoEnabled(builderCanUndo())
  drawMap()
}

let _simpleSuggestTimer = null
let _simpleSuggestAbort = null

function goToPlaceOnMap(place) {
  if (!place) return
  if (place.bbox) {
    mapFitBounds(place.bbox[0], place.bbox[1], place.bbox[2], place.bbox[3])
  } else {
    mapGoTo(place.lat, place.lon, 12)
  }
}

function queueSimpleBuilderPlaceSuggest() {
  if (_simpleSuggestTimer) clearTimeout(_simpleSuggestTimer)
  _simpleSuggestTimer = setTimeout(runSimpleBuilderPlaceSuggest, 220)
}

async function runSimpleBuilderPlaceSuggest() {
  const query = builder.placeSearchInput.value.trim()
  if (query.length < 2) {
    builder.hidePlaceSuggestions()
    return
  }

  if (_simpleSuggestAbort) _simpleSuggestAbort.abort()
  const ac = new AbortController()
  _simpleSuggestAbort = ac

  try {
    const items = await searchPlaceSuggestions(query, 5, ac.signal)
    if (builder.placeSearchInput.value.trim() !== query) return
    builder.setPlaceSuggestions(items)
  } catch (err) {
    if (err?.name === 'AbortError') return
    builder.hidePlaceSuggestions()
    builder.setStatus('Suggestions unavailable right now. You can still press Go.')
  }
}

async function runSimpleBuilderPlaceSearch() {
  const query = builder.placeSearchInput.value.trim()
  if (!query) {
    builder.setStatus('Type a place first (for example: London)')
    return
  }

  builder.hidePlaceSuggestions()
  builder.setSearchBusy(true)
  builder.setStatus(`Searching "${query}"...`)
  try {
    const place = await searchPlace(query)
    if (!place) {
      builder.setStatus(`No match found for "${query}"`)
      return
    }

    goToPlaceOnMap(place)

    builder.setStatus(`Map moved to ${place.name}`)
  } catch (err) {
    builder.setStatus(`Search failed: ${err.message || 'unknown error'}`)
  } finally {
    builder.setSearchBusy(false)
  }
}

function populateSTFromBuilder({ lats, lons, eles, dists }) {
  ST.gpx = { lats, lons, eles: [...eles], dists, doc: null, ns: '', pts: [], rawXml: '' }
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
  ST.lidarSource = ''
  ST.lidarSources = {}
  ST.origAvgSpacing = dists.length > 1 ? dists[dists.length - 1] / (dists.length - 1) : 1
}


// ────────────────────────────────────────────────────────────────────
// Processing pipeline
// ────────────────────────────────────────────────────────────────────

async function runFullPipeline(withLidar) {
  ui.showView('processing')
  processing.resetSteps()

  try {
    // ── LIDAR elevation fetch ──
    if (withLidar) {
      processing.updateStep('lidar', 'active')
      processing.setProgress(5)

      // Densify to provider resolution
      const targetRes = getTargetResolution(ST.gpx.lats, ST.gpx.lons)
      const densified = densifyForLidar(ST.gpx.lats, ST.gpx.lons, ST.dists, targetRes)

      const fetchLats = densified.wasDensified ? densified.lats : ST.gpx.lats
      const fetchLons = densified.wasDensified ? densified.lons : ST.gpx.lons
      const fetchEles = densified.wasDensified
        ? new Array(densified.lats.length).fill(0)
        : ST.gpx.eles

      if (densified.wasDensified) {
        const cc = detectPrimaryCountry(ST.gpx.lats, ST.gpx.lons)
        console.log(`[Simple] Densified ${densified.originalCount} -> ${densified.newCount} pts for ${cc || '?'} @ ${targetRes}m`)
      }

      processing.setProgress(10)

      const gpxString = buildGPXString(fetchLats, fetchLons, fetchEles, ST.filename || 'route')
      const { gpxText, summary, source, sources } = await fetchLidarElevations(gpxString, ST.filename || 'route.gpx')

      // Parse returned GPX
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

      // Commit LIDAR data to state
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
      ST.origAvgSpacing = ST.dists.length > 1 ? ST.dists[ST.dists.length - 1] / (ST.dists.length - 1) : 1
      ST.lidarSource = source || ''
      ST.lidarSources = sources || {}

      processing.updateStep('lidar', 'done', `Elevation fetched (${summary})`)
      processing.setProgress(20)
      console.log(`[Simple] LIDAR elevation applied: ${summary}`)
      if (ST.lidarSource) {
        console.log(`[Simple] LIDAR source: ${ST.lidarSource}`)
      }
    } else {
      // Skip LIDAR — mark as done
      ST.lidarSource = ''
      ST.lidarSources = {}
      processing.updateStep('lidar', 'done', 'Using existing elevation')
      processing.setProgress(20)
    }

    // ── Auto-trim start/end overlap before pipeline ──
    // Prevents duplicate points confusing the smoother's findLoops()
    const overlap = detectStartEndOverlap(ST.gpx.lats, ST.gpx.lons)
    if (overlap) {
      const idx = overlap.overlapStartIdx
      console.log(`[Simple] Auto-trimmed ${overlap.overlapCount} overlapping points`)
      ST.gpx.lats = ST.gpx.lats.slice(0, idx)
      ST.gpx.lons = ST.gpx.lons.slice(0, idx)
      ST.gpx.eles = ST.gpx.eles.slice(0, idx)
      ST.eleClean = ST.eleClean.slice(0, idx)
      const dists = cumulativeDistances(ST.gpx.lats, ST.gpx.lons)
      ST.dists = new Float64Array(dists)
      ST.grOrig = grads(ST.gpx.eles, ST.dists)
      ST.grClean = grads(ST.eleClean, ST.dists)
    }

    // ── Auto-pipeline: snap → brunnels → clean → smooth → simplify ──
    let lastStepId = null
    const result = await runAutoPipeline((stepId, pct, msg) => {
      // Map auto-pipeline progress (0-100) to our bar (20-100)
      const mappedPct = 20 + pct * 0.8

      // Update step states
      if (stepId !== lastStepId && lastStepId) {
        processing.updateStep(lastStepId, 'done')
      }
      if (stepId !== 'done') {
        processing.updateStep(stepId, 'active', msg)
      }
      lastStepId = stepId

      processing.setProgress(mappedPct)
    }, { skipSnap: true })

    // Mark final step done
    if (lastStepId && lastStepId !== 'done') {
      processing.updateStep(lastStepId, 'done')
    }
    processing.setProgress(100)

    // Log warnings
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.warn(`[Simple] ${w}`)
      }
    }

    // Transition to review
    setTimeout(() => showReview(), 400)

  } catch (err) {
    console.error('[Simple] Pipeline error:', err)
    processing.showError(friendlyError(err))
  }
}

// ────────────────────────────────────────────────────────────────────
// Review view
// ────────────────────────────────────────────────────────────────────

function showReview() {
  ui.showView('review')

  // Init chart + corrections (first time only)
  ensureChart()
  ensureCorrections()

  // Reparent map to review panel
  ensureMap(review.mapPanel)

  // Update stats
  const eles = ST.smoothedRoute ? ST.smoothedRoute.eles : ST.eleClean
  const dists = ST.smoothedRoute ? ST.smoothedRoute.dists : ST.dists
  const { asc, desc } = ascDesc(eles)
  const totalDist = dists[dists.length - 1]
  const pts = ST.smoothedRoute ? ST.smoothedRoute.lats.length : ST.gpx.lats.length
  review.setStats(totalDist, asc, desc, pts)

  // Draw everything
  buildColors(ST.grClean)
  drawAll()
  drawMap()

  // Leaflet needs a frame to recalc after reparent + view switch
  setTimeout(() => {
    mapFit()
  }, 100)

  // Build corrections list
  if (corrPanel) corrPanel.rebuild()
  review.setUndoEnabled(canUndo())
}

// ────────────────────────────────────────────────────────────────────
// Download
// ────────────────────────────────────────────────────────────────────

review.btnDownload.addEventListener('click', async () => {
  if (!ST.gpx) return

  // Re-smooth silently if corrections were modified since last smooth
  if (ST.correctionsDirty) {
    const smoothResult = runSmoothing(ST.gpx.lats, ST.gpx.lons, ST.eleClean, ST.dists, {
      origAvgSpacing: ST.origAvgSpacing,
    })
    ST.smoothedRoute = {
      lats: smoothResult.lats,
      lons: smoothResult.lons,
      eles: smoothResult.eleSmoothed,
      dists: new Float64Array(smoothResult.dists),
      gr: new Float64Array(smoothResult.grSmoothed),
    }
    ST.eleSmoothed = smoothResult.eleSmoothed
    ST.grSmoothed = new Float64Array(smoothResult.grSmoothed)
    ST.correctionsDirty = false
  }

  let lats, lons, eles

  if (ST.smoothedRoute) {
    lats = [...ST.smoothedRoute.lats]
    lons = [...ST.smoothedRoute.lons]
    eles = [...ST.smoothedRoute.eles]
  } else {
    lats = [...ST.gpx.lats]
    lons = [...ST.gpx.lons]
    eles = [...(ST.eleClean || ST.gpx.eles)]
  }

  // Safety trim — remove any start/end overlap introduced by rerouting
  const overlap = detectStartEndOverlap(lats, lons)
  if (overlap) {
    console.log(`[Simple] Download: trimmed ${overlap.overlapCount} overlapping points`)
    lats = lats.slice(0, overlap.overlapStartIdx)
    lons = lons.slice(0, overlap.overlapStartIdx)
    eles = eles.slice(0, overlap.overlapStartIdx)
  }

  const fallbackBaseName = (ST.filename || 'route').replace(/\.gpx$/i, '')
  const gpxString = buildGPXString(lats, lons, eles, fallbackBaseName)

  try {
    review.btnDownload.disabled = true
    review.btnDownload.textContent = '⏳ Naming…'
    const filename = await buildDownloadFilename({
      startLat: lats[0],
      startLon: lons[0],
      endLat: lats[lats.length - 1],
      endLon: lons[lons.length - 1],
      fallbackBaseName,
      suffix: '_gpxforge',
    })
    downloadGPX(gpxString, filename)
  } finally {
    review.btnDownload.disabled = false
    review.btnDownload.textContent = '⬇ Download GPX'
  }
})

// ────────────────────────────────────────────────────────────────────
// Review — back to landing
// ────────────────────────────────────────────────────────────────────

review.btnBack.addEventListener('click', () => {
  // Exit draw mode on navigation
  ST.drawMode = false
  ST.drawAnchor1 = null
  ST.drawCursorIdx = null
  review.btnDraw.classList.remove('active')
  resetState()
  ui.showView('landing')
})

review.btnDraw.addEventListener('click', () => {
  if (!ST.gpx) return
  ST.drawMode = !ST.drawMode
  ST.drawAnchor1 = null
  ST.drawCursorIdx = null
  review.btnDraw.classList.toggle('active', ST.drawMode)
  drawAll()
})

review.btnUndo.addEventListener('click', () => {
  if (!canUndo()) return
  performUndo({
    onRestore: () => {
      invalidateSmooth()
      if (corrPanel) corrPanel.rebuild()
      if (corrPanel && ST.selectedCorr != null && ST.selectedCorr >= 0) corrPanel.setSelected(ST.selectedCorr)
      refreshReview()
    },
  })
})

function resetState() {
  ST.gpx = null
  ST.eleClean = null
  ST.grClean = null
  ST.grOrig = null
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.smoothedRoute = null
  ST.corrections = []
  ST.selectedCorr = -1
  ST.brunnels = null
  ST.dists = null
  ST.lidarSource = ''
  ST.lidarSources = {}
}

// ────────────────────────────────────────────────────────────────────
// Processing — error back button
// ────────────────────────────────────────────────────────────────────

processing.errorBack.addEventListener('click', () => {
  resetState()
  ui.showView('landing')
})

// ────────────────────────────────────────────────────────────────────
// Correction handlers (simplified from main.js)
// ────────────────────────────────────────────────────────────────────

function handleSelectCorr(ci) {
  ST.selectedCorr = ci
  if (corrPanel) corrPanel.setSelected(ci)
  zoomToCorr(ci)
  drawAll()
  drawMap()
}

function handleAcceptCorr(ci) {
  if (!ST.corrections || ci < 0 || ci >= ST.corrections.length) return
  pushHistory('clean')

  const c = ST.corrections[ci]
  if (c.accepted) {
    c.accepted = false
    restoreRawElevation(c)
  } else {
    c.accepted = true
    c.rejected = false
    if (c.type === 'suspect' && c.interp === 'none') c.interp = 'uniform'
    applyInterp(ST.eleClean, ST.dists, c.alo, c.ahi, c)
  }

  ST.grClean = grads(ST.eleClean, ST.dists)
  invalidateSmooth()
  if (corrPanel) corrPanel.rebuild()
  if (corrPanel) corrPanel.setSelected(ci)
  refreshReview()
}

function handleRejectCorr(ci) {
  if (!ST.corrections || ci < 0 || ci >= ST.corrections.length) return
  pushHistory('clean')

  const c = ST.corrections[ci]
  if (c.rejected) {
    c.rejected = false
    if (c.accepted) applyInterp(ST.eleClean, ST.dists, c.alo, c.ahi, c)
  } else {
    c.rejected = true
    c.accepted = false
    restoreRawElevation(c)
  }

  ST.grClean = grads(ST.eleClean, ST.dists)
  invalidateSmooth()
  if (corrPanel) corrPanel.rebuild()
  if (corrPanel) corrPanel.setSelected(ci)
  refreshReview()
}

function handleCommitDrag(corrIdx, which, newIdx) {
  if (!ST.corrections || corrIdx < 0 || corrIdx >= ST.corrections.length) return
  pushHistory('clean')

  const c = ST.corrections[corrIdx]
  if (which === 'lo') c.alo = newIdx
  else c.ahi = newIdx

  if (c.alo >= c.ahi) {
    if (which === 'lo') c.alo = c.ahi - 1
    else c.ahi = c.alo + 1
  }

  c.span = ST.dists[c.ahi] - ST.dists[c.alo]
  c.grade = c.span > 0 ? (ST.gpx.eles[c.ahi] - ST.gpx.eles[c.alo]) / c.span * 100 : 0

  if (c.type !== 'suspect') {
    const shape = DEFAULT_SHAPE_PARAMS
    const struct = classifyStructure(ST.gpx.eles, ST.dists, c.alo, c.ahi, shape)
    c.type = struct.type
    c.interp = struct.interp
    c.m0 = struct.m0
    c.m1 = struct.m1
  }

  if (c.accepted) {
    restoreRawElevation(c)
    applyInterp(ST.eleClean, ST.dists, c.alo, c.ahi, c)
  }

  ST.grClean = grads(ST.eleClean, ST.dists)
  invalidateSmooth()
  if (corrPanel) corrPanel.rebuild()
  if (corrPanel) corrPanel.setSelected(corrIdx)
  refreshReview()
}

function handleCommitDraw(alo, ahi) {
  if (!ST.gpx || !ST.eleClean || !ST.corrections) return
  pushHistory('clean')

  if (alo > ahi) [alo, ahi] = [ahi, alo]

  const shape = DEFAULT_SHAPE_PARAMS
  const struct = classifyStructure(ST.gpx.eles, ST.dists, alo, ahi, shape)

  const span = ST.dists[ahi] - ST.dists[alo]
  const grade = span > 0 ? (ST.gpx.eles[ahi] - ST.gpx.eles[alo]) / span * 100 : 0

  applyInterp(ST.eleClean, ST.dists, alo, ahi, struct)

  ST.corrections.push({
    alo, ahi, span, grade,
    type: struct.type, interp: struct.interp,
    m0: struct.m0, m1: struct.m1,
    revRate: 0, meanGr: 0,
    accepted: true, rejected: false, source: 'manual',
  })

  ST.grClean = grads(ST.eleClean, ST.dists)
  invalidateSmooth()

  // Exit draw mode and reset button style
  ST.drawMode = false
  ST.drawAnchor1 = null
  ST.drawCursorIdx = null
  review.btnDraw.classList.remove('active')

  if (corrPanel) corrPanel.rebuild()
  refreshReview()
}

function restoreRawElevation(c) {
  if (!ST.gpx) return
  for (let i = c.alo; i <= c.ahi; i++) {
    ST.eleClean[i] = ST.gpx.eles[i]
  }
}

function invalidateSmooth() {
  ST.smoothedRoute = null
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.correctionsDirty = true
}

function refreshReview() {
  buildColors(ST.grClean)
  drawAll()
  drawMap()
  review.setUndoEnabled(canUndo())

  // Update stats
  const eles = ST.eleClean || ST.gpx.eles
  const { asc, desc } = ascDesc(eles)
  const totalDist = ST.dists[ST.dists.length - 1]
  review.setStats(totalDist, asc, desc, ST.gpx.lats.length)
}

// ────────────────────────────────────────────────────────────────────
// Error messages — plain language
// ────────────────────────────────────────────────────────────────────

function friendlyError(err) {
  const msg = err.message || String(err)

  // Unsupported country (422 from server)
  if (msg.includes('422') || msg.includes('unsupported') || msg.includes('not supported')) {
    return 'High-resolution elevation data is not available for this country yet. Try a route in a supported country (most of Europe, UK, USA, Australia, New Zealand).'
  }

  // Rate limit
  if (msg.includes('429') || msg.includes('rate') || msg.includes('limit') || msg.includes('quota')) {
    return 'Daily request limit reached. Try again tomorrow, or add your own GPXZ API key in the expert mode settings.'
  }

  // Connection error
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')) {
    return 'Cannot connect to the elevation server. Make sure the GPXForge server is running and the frontend can reach /api/elevation.'
  }

  // Network error
  if (msg.includes('network') || msg.includes('Network')) {
    return 'Network error. Check your internet connection and try again.'
  }

  // Fallback
  return 'Something went wrong: ' + msg
}
