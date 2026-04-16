/**
 * UI Shell — DOM skeleton, file loading, stats display.
 *
 * Builds the entire app DOM inside #app. Handles GPX file loading
 * via file input and drag-and-drop. Layout: chart on top (elevation
 * + gradient), map on bottom, both always visible.
 */

import { ST } from '../state.js'
import { parseGPX } from '../utils/gpx.js'
import { grads, ascDesc } from '../utils/math.js'
import { fmtDist, fmtNum } from '../utils/format.js'
import { buildColors } from '../chart/index.js'

// ────────────────────────────────────────────────────────────────────
// DOM element references (module-scoped)
// ────────────────────────────────────────────────────────────────────

let _statsEl = null
let _statEls = {}
let _emptyState = null
let _contentEl = null
let _chartPanel = null
let _mapPanel = null
let _dropLabel = null
let _dropHint = null
let _dragOverlay = null
let _actionsEl = null
let _stepToolbarEl = null
let _infoPanel = null
let _infoContents = {}

// Canvas elements
let _cvMain = null
let _cvGrad = null

// External callbacks
let _onFileLoaded = null

// ────────────────────────────────────────────────────────────────────
// DOM construction
// ────────────────────────────────────────────────────────────────────

function el(tag, cls, attrs) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v
      else if (k === 'html') e.innerHTML = v
      else e.setAttribute(k, v)
    }
  }
  return e
}

function buildTopbar() {
  const topbar = el('div', 'topbar')

  // Brand
  const brand = el('div', 'tb-brand')
  const logo = el('div', 'tb-brand-logo', { html: '&#9968;' }) // ⛰
  const brandText = el('div', 'tb-brand-text')
  brandText.appendChild(el('div', 'tb-brand-name', { text: 'GPXForge' }))
  brandText.appendChild(el('div', 'tb-brand-sub', { text: 'GPX Tools' }))
  brand.appendChild(logo)
  brand.appendChild(brandText)
  topbar.appendChild(brand)

  // File drop zone
  const drop = el('label', 'tb-drop')
  drop.id = 'dropZone'
  const fileInput = el('input', null, { type: 'file', accept: '.gpx' })
  fileInput.id = 'fileIn'
  fileInput.style.display = 'none'
  drop.appendChild(fileInput)
  drop.appendChild(el('div', 'tb-drop-icon', { text: '\uD83D\uDCC2' })) // 📂
  const dropText = el('div', 'tb-drop-text')
  _dropLabel = el('div', 'tb-drop-label', { text: 'Drop GPX or click to browse' })
  _dropHint = el('div', 'tb-drop-hint', { text: 'Strava, Garmin, head unit exports' })
  dropText.appendChild(_dropLabel)
  dropText.appendChild(_dropHint)
  drop.appendChild(dropText)
  topbar.appendChild(drop)

  // Stats strip (hidden initially)
  _statsEl = el('div', 'tb-stats')
  _statsEl.id = 'hStats'
  const stats = [
    { id: 'sDist', label: 'Distance', color: 'amber' },
    { id: 'sAscOrig', label: 'Ascent', color: 'green' },
    { id: 'sAscClean', label: 'Clean \u2191', color: 'green' },
    { id: 'sPts', label: 'Points', color: '' },
    { id: 'sMaxGr', label: 'Max grade', color: 'orange' },
  ]
  for (const s of stats) {
    const stat = el('div', 'tb-stat')
    stat.appendChild(el('span', 'tb-stat-label', { text: s.label }))
    const valEl = el('span', 'tb-stat-val' + (s.color ? ' ' + s.color : ''), { text: '\u2014' })
    valEl.id = s.id
    _statEls[s.id] = valEl
    stat.appendChild(valEl)
    _statsEl.appendChild(stat)
  }
  topbar.appendChild(_statsEl)

  // Actions container (for toolbar buttons)
  _actionsEl = el('div', 'tb-actions')
  topbar.appendChild(_actionsEl)

  // Wire file input
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0])
  })

  return topbar
}

function setFocus(panel) {
  if (_contentEl) _contentEl.dataset.focus = panel
}

// ── Resize handle drag logic ──

function updateHandleTop(handle) {
  if (!_contentEl) return
  const rows = getComputedStyle(_contentEl).gridTemplateRows.split(/\s+/)
  handle.style.top = parseFloat(rows[0]) + 'px'
}

function setupResizeHandle(handle) {
  let resizing = false
  let startY = 0
  let startRatio = 0.6

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    resizing = true
    startY = e.clientY
    const rows = getComputedStyle(_contentEl).gridTemplateRows.split(/\s+/)
    const topPx = parseFloat(rows[0])
    startRatio = topPx / _contentEl.clientHeight
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  })

  document.addEventListener('mousemove', (e) => {
    if (!resizing) return
    const delta = (e.clientY - startY) / _contentEl.clientHeight
    const ratio = Math.max(0.2, Math.min(0.8, startRatio + delta))
    _contentEl.style.gridTemplateRows = `${ratio}fr ${1 - ratio}fr`
    updateHandleTop(handle)
  })

  document.addEventListener('mouseup', () => {
    if (!resizing) return
    resizing = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })

  // Start observing once content is in DOM (deferred)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => updateHandleTop(handle))
    requestAnimationFrame(() => {
      ro.observe(_contentEl)
      updateHandleTop(handle)
    })
  }
}

function buildContent() {
  _contentEl = el('div', 'content')

  // Empty state (shown before file load)
  _emptyState = el('div', 'empty-state')
  _emptyState.appendChild(el('div', 'empty-state-icon', { text: '\uD83D\uDCC2' })) // 📂
  _emptyState.appendChild(el('div', 'empty-state-msg', { text: 'Drop a GPX file or click the file zone above to load your route.' }))
  _contentEl.appendChild(_emptyState)

  // Chart panel (elevation + gradient, no mini strip)
  _chartPanel = el('div', 'chart-panel')
  _chartPanel.id = 'chartPanel'
  const chartMain = el('div', 'chart-main')
  _cvMain = el('canvas')
  _cvMain.id = 'cvMain'
  chartMain.appendChild(_cvMain)
  _chartPanel.appendChild(chartMain)
  const chartGrad = el('div', 'chart-grad')
  _cvGrad = el('canvas')
  _cvGrad.id = 'cvGrad'
  chartGrad.appendChild(_cvGrad)
  _chartPanel.appendChild(chartGrad)
  // Promote button (visible only when chart is secondary)
  const chartPromote = el('button', 'panel-promote', { title: 'Focus chart', text: '\u2922' }) // ⤢
  chartPromote.addEventListener('click', () => setFocus('chart'))
  _chartPanel.appendChild(chartPromote)
  _contentEl.appendChild(_chartPanel)

  // Map panel
  _mapPanel = el('div', 'map-panel')
  _mapPanel.id = 'mapPanel'
  // Promote button (visible only when map is secondary)
  const mapPromote = el('button', 'panel-promote', { title: 'Focus map', text: '\u2922' }) // ⤢
  mapPromote.addEventListener('click', () => setFocus('map'))
  _mapPanel.appendChild(mapPromote)
  _contentEl.appendChild(_mapPanel)

  // Info panel (secondary — step results, corrections, split segments)
  _infoPanel = el('div', 'info-panel')
  _infoPanel.id = 'infoPanel'
  _infoContents = {}
  for (const stepId of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split', 'builder']) {
    const c = el('div', 'info-content')
    c.dataset.step = stepId
    c.style.display = 'none'
    _infoContents[stepId] = c
    _infoPanel.appendChild(c)
  }
  _contentEl.appendChild(_infoPanel)

  // Resize handle between top and bottom grid rows
  const resizeHandle = el('div', 'resize-handle')
  resizeHandle.appendChild(el('div', 'resize-handle-dots'))
  _contentEl.appendChild(resizeHandle)
  setupResizeHandle(resizeHandle)

  return _contentEl
}

function buildDragOverlay() {
  _dragOverlay = el('div', 'drag-overlay')
  _dragOverlay.appendChild(el('div', 'drag-overlay-text', { text: 'Drop GPX file to load' }))
  return _dragOverlay
}

// ────────────────────────────────────────────────────────────────────
// File loading
// ────────────────────────────────────────────────────────────────────

export function loadGpxFile(file, { onLoaded, onUiUpdate } = {}) {
  if (!file || !file.name.toLowerCase().endsWith('.gpx')) {
    console.warn('[GPXForge] Not a GPX file:', file?.name)
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const xml = e.target.result
      try {
        const gpxData = parseGPX(xml)
        if (!gpxData.lats.length) {
          console.error('[GPXForge] GPX file has no track points')
          resolve(false)
          return
        }

        // Populate state
        ST.gpx = gpxData
        ST.dists = gpxData.dists
        ST.grOrig = grads(gpxData.eles, gpxData.dists)
        ST.eleClean = gpxData.eles.slice()
        ST.grClean = ST.grOrig.slice()
        ST.corrections = []
        ST.filename = file.name
        ST.history = []
        ST.historyIdx = -1
        ST.selectedCorr = null
        ST.smoothedRoute = null
        ST.eleSmoothed = null
        ST.grSmoothed = null
        ST.stepStatus = {}

        // Build gradient colors
        buildColors(ST.grClean)

        if (onUiUpdate) onUiUpdate(file.name)

        console.log(`[GPXForge] Loaded: ${file.name}`)
        console.log(`[GPXForge] ${gpxData.lats.length} pts \u00B7 ${(gpxData.dists[gpxData.dists.length - 1] / 1000).toFixed(1)} km`)

        if (onLoaded) onLoaded(gpxData)
        resolve(true)
      } catch (err) {
        console.error('[GPXForge] Failed to parse GPX:', err)
        resolve(false)
      }
    }
    reader.readAsText(file)
  })
}

function loadFile(file) {
  return loadGpxFile(file, {
    onUiUpdate(filename) {
      _dropLabel.textContent = filename
      _dropHint.textContent = 'Click to change file'
    },
    onLoaded() {
      if (_onFileLoaded) _onFileLoaded()
    },
  })
}

// ────────────────────────────────────────────────────────────────────
// Drag-and-drop (full page)
// ────────────────────────────────────────────────────────────────────

let _dragCounter = 0
let _dragDropSetup = false

function setupDragDrop() {
  // Only set up once — event listeners persist across initShell calls
  if (_dragDropSetup) return
  _dragDropSetup = true

  document.addEventListener('dragenter', (e) => {
    e.preventDefault()
    _dragCounter++
    if (_dragCounter === 1) _dragOverlay.classList.add('active')
  })

  document.addEventListener('dragleave', (e) => {
    e.preventDefault()
    _dragCounter--
    if (_dragCounter <= 0) {
      _dragCounter = 0
      _dragOverlay.classList.remove('active')
    }
  })

  document.addEventListener('dragover', (e) => {
    e.preventDefault()
  })

  document.addEventListener('drop', (e) => {
    e.preventDefault()
    _dragCounter = 0
    _dragOverlay.classList.remove('active')
    const file = e.dataTransfer?.files[0]
    if (file) loadFile(file)
  })
}

// ────────────────────────────────────────────────────────────────────
// Stats display
// ────────────────────────────────────────────────────────────────────

function updateStats() {
  if (!ST.gpx || !ST.dists) return

  const N = ST.gpx.eles.length
  const totalDist = ST.dists[N - 1]
  const { asc: ascOrig } = ascDesc(ST.gpx.eles)
  const { asc: ascClean } = ascDesc(ST.eleClean)
  const maxGr = ST.grClean
    ? ST.grClean.reduce((mx, g) => Math.max(mx, Math.abs(g)), 0)
    : 0

  _statEls.sDist.textContent = fmtDist(totalDist)
  _statEls.sAscOrig.textContent = ascOrig + 'm'
  _statEls.sAscClean.textContent = ascClean + 'm'
  _statEls.sPts.textContent = fmtNum(N)
  _statEls.sMaxGr.textContent = maxGr.toFixed(1) + '%'

  _statsEl.classList.add('visible')
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Initialize the UI shell. Builds all DOM inside #app.
 * @param {Function} onFileLoaded — called after GPX file is parsed and ST populated
 * @returns {{ showViews, updateStats, getChartEls, getMapEl, getActionsEl }}
 */
export function initShell(onFileLoaded) {
  _onFileLoaded = onFileLoaded

  const app = document.getElementById('app')
  if (!app) throw new Error('[GPXForge] #app element not found')

  // Clear any existing content
  app.innerHTML = ''
  app.className = 'app'

  // Build DOM
  app.appendChild(buildTopbar())

  // Step toolbar (hidden until file loaded)
  _stepToolbarEl = el('div', 'step-toolbar')
  app.appendChild(_stepToolbarEl)

  // Content area (direct child of .app)
  app.appendChild(buildContent())

  app.appendChild(buildDragOverlay())

  // Setup drag-and-drop
  setupDragDrop()

  console.log('[GPXForge] UI shell initialised')

  return {
    /** Show chart + map panels, hide empty state. Sets default focus to chart. */
    showViews() {
      _emptyState.style.display = 'none'
      if (!_contentEl.dataset.focus) _contentEl.dataset.focus = 'chart'
    },

    /** Update stats in topbar from current ST */
    updateStats,

    /** Get chart canvas elements (cvMini is null — no mini strip) */
    getChartEls() {
      return { cvMain: _cvMain, cvGrad: _cvGrad, cvMini: null }
    },

    /** Get map container element */
    getMapEl() {
      return _mapPanel
    },

    /** Get toolbar actions container */
    getActionsEl() {
      return _actionsEl
    },

    /** Get step toolbar container element */
    getStepToolbarEl() {
      return _stepToolbarEl
    },

    /** Show step toolbar (add visible class) */
    showStepToolbar() {
      _stepToolbarEl.classList.add('visible')
    },

    /** Get info panel container for a specific step */
    getInfoPanel(stepId) {
      return _infoContents[stepId] || null
    },

    /** Show/hide info panel based on active step */
    setInfoStep(stepId) {
      if (stepId && _infoContents[stepId]) {
        _contentEl.dataset.info = ''
      } else {
        delete _contentEl.dataset.info
      }
      for (const [id, container] of Object.entries(_infoContents)) {
        container.style.display = id === stepId ? '' : 'none'
      }
    },
  }
}
