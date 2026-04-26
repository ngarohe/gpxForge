/**
 * UI Shell — DOM skeleton, file loading, stats display.
 *
 * Builds the entire app DOM inside #app. Handles GPX file loading
 * via file input and drag-and-drop. Layout: chart on top (elevation
 * + gradient), map on bottom, both always visible.
 */

import { ST } from '../state.js'
import { isBatchPanelVisible } from './batch-ui.js'
import { getMode } from './mode.js'
import { parseGPX } from '../utils/gpx.js'
import { grads, ascDesc } from '../utils/math.js'
import { fmtDist, fmtNum } from '../utils/format.js'
import { buildColors } from '../chart/index.js'

// ────────────────────────────────────────────────────────────────────
// DOM element references (module-scoped)
// ────────────────────────────────────────────────────────────────────

let _statsEl = null
let _statEls = {}
let _contentEl = null
let _chartPanel = null
let _mapPanel = null
let _dropLabel = null
let _dropHint = null
let _dragOverlay = null
let _actionsEl = null
let _stepToolbarEl = null
let _infoPanel = null
let _infoStepWrap = null
let _infoContents = {}
let _batchContainer = null
let _modeToggleEl = null
let _onModeChange = null
let _simpleBtn = null
let _expertBtn = null
let _simpleLocked = false
let _progressEl = null
let _progressSteps = {}

// Canvas elements
let _cvMain = null
let _cvGrad = null

// External callbacks
let _onFileLoaded = null
let _onFilesLoaded = null  // multi-file batch callback
let _onBeforeSingleLoad = null  // fires before a single-file load replaces ST

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

  // Upload drop zone — accepts GPX files and ZIPs (which may contain multiple GPX).
  // Count-based routing: 1 file → single-file pipeline, 2+ → bulk queue.
  const drop = el('label', 'tb-drop')
  drop.id = 'dropZone'
  drop.title = 'Upload GPX file(s) or a ZIP. One file = step-by-step pipeline. Two or more = background queue.'
  const fileInput = el('input', null, { type: 'file', accept: '.gpx,.zip', multiple: 'multiple' })
  fileInput.id = 'fileIn'
  fileInput.style.display = 'none'
  drop.appendChild(fileInput)
  drop.appendChild(el('div', 'tb-drop-icon', { text: '\uD83D\uDCC4' })) // 📄
  const dropText = el('div', 'tb-drop-text')
  _dropLabel = el('div', 'tb-drop-label', { text: 'Upload GPX' })
  _dropHint = el('div', 'tb-drop-hint', { text: 'Drag or click \u2014 single or multiple' })
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

  // Mode toggle pill (Simple / Expert)
  _modeToggleEl = buildModeToggle()
  topbar.appendChild(_modeToggleEl)

  // Actions container (for toolbar buttons)
  _actionsEl = el('div', 'tb-actions')
  topbar.appendChild(_actionsEl)

  // Wire upload input — count determines routing after zip extraction
  fileInput.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])]
    if (!files.length) return
    handleFileSelection(files)
    e.target.value = ''
  })

  return topbar
}

function setFocus(panel) {
  if (_contentEl) _contentEl.dataset.focus = panel
}

function buildModeToggle() {
  const wrap = el('div', 'tb-mode')
  _simpleBtn = el('button', 'tb-mode-btn', { text: 'Simple', type: 'button', title: 'Minimal one-click pipeline' })
  _expertBtn = el('button', 'tb-mode-btn', { text: 'Expert', type: 'button', title: 'Full step-by-step pipeline controls' })
  const apply = () => {
    const m = getMode()
    _simpleBtn.classList.toggle('active', m === 'simple')
    _expertBtn.classList.toggle('active', m === 'expert')
  }
  _simpleBtn.addEventListener('click', () => {
    if (_simpleLocked) return
    if (_onModeChange) _onModeChange('simple')
    apply()
  })
  _expertBtn.addEventListener('click', () => {
    if (_onModeChange) _onModeChange('expert')
    apply()
  })
  wrap.appendChild(_simpleBtn)
  wrap.appendChild(_expertBtn)
  apply()
  return wrap
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
  _contentEl.dataset.focus = 'landing'

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

  // Step content wrapper (flex: 1) — holds the per-step info divs
  _infoStepWrap = el('div', 'info-step-wrap')
  _infoContents = {}
  for (const stepId of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split', 'builder']) {
    const c = el('div', 'info-content')
    c.dataset.step = stepId
    c.style.display = 'none'
    _infoContents[stepId] = c
    _infoStepWrap.appendChild(c)
  }
  _infoPanel.appendChild(_infoStepWrap)

  // Persistent batch queue container — sits right of step content, always visible when panel is shown
  _batchContainer = el('div', 'batch-container')
  _batchContainer.id = 'batchPanelContainer'
  _infoPanel.appendChild(_batchContainer)

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

/**
 * Reset the upload button label back to its initial state. Call after the
 * queue empties (bulk download, clear) so the label doesn't claim files are
 * still processing.
 */
export function resetUploadLabel() {
  if (!_dropLabel || !_dropHint) return
  _dropLabel.textContent = 'Upload GPX'
  _dropHint.textContent = 'Drag or click \u2014 single or multiple'
}

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

/**
 * Route file selection based on count after zip extraction.
 * 1 file  → single-file pipeline (manual, lands on Trim)
 * 2+ files → bulk queue (background brunnels → LIDAR → clean)
 *
 * @param {File[]} files  Raw files from input or drag-drop (may include zips)
 */
async function handleFileSelection(files) {
  // Expand any zips; collect GPX files
  const gpxFiles = []
  for (const file of files) {
    const name = file.name.toLowerCase()
    if (name.endsWith('.zip')) {
      try {
        const { default: JSZip } = await import('jszip')
        const zip = await JSZip.loadAsync(file)
        for (const [path, entry] of Object.entries(zip.files)) {
          if (entry.dir || !path.toLowerCase().endsWith('.gpx')) continue
          const blob = await entry.async('blob')
          gpxFiles.push(new File([blob], path.split('/').pop(), { type: 'text/xml' }))
        }
      } catch (err) {
        console.warn('[GPXForge] Could not read zip:', err)
      }
    } else if (name.endsWith('.gpx')) {
      gpxFiles.push(file)
    }
  }

  if (!gpxFiles.length) return

  if (gpxFiles.length === 1) {
    // Single file → step-by-step pipeline (Trim in expert, auto in simple — Phase 5)
    // If the user already has unsaved work open, let main.js auto-park it
    // into the queue so it isn't silently destroyed.
    if (_onBeforeSingleLoad) _onBeforeSingleLoad()
    loadFile(gpxFiles[0])
  } else {
    // Multiple files → background queue
    _dropLabel.textContent = `${gpxFiles.length} files queued`
    _dropHint.textContent = 'Processing in background\u2026'
    if (_onFilesLoaded) _onFilesLoaded(gpxFiles)
  }
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
    const files = [...(e.dataTransfer?.files || [])]
    if (files.length) handleFileSelection(files)
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
 * @param {Function} onFilesLoaded — called with File[] for bulk/batch uploads
 * @param {{ onModeChange?: Function }} [opts]
 * @returns {{ showViews, updateStats, getChartEls, getMapEl, getActionsEl }}
 */
export function initShell(onFileLoaded, onFilesLoaded, opts = {}) {
  _onFileLoaded = onFileLoaded
  _onFilesLoaded = onFilesLoaded || null
  _onModeChange = opts.onModeChange || null
  _onBeforeSingleLoad = opts.onBeforeSingleLoad || null

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
    /**
     * Transition from landing to the active pipeline layout.
     * @param {'chart'|'map'} [focus='chart'] — which panel to feature on top
     */
    showViews(focus = 'chart') {
      _contentEl.dataset.focus = focus
    },

    /** Return to the map-first landing state (no file loaded). */
    showLanding() {
      _contentEl.dataset.focus = 'landing'
      _stepToolbarEl.classList.remove('visible')
    },

    /** Update stats in topbar from current ST */
    updateStats,

    /** Reset the upload button label (call when queue empties) */
    resetUploadLabel,

    /**
     * Lock or unlock the Simple half of the mode toggle. While locked,
     * clicks on Simple do nothing and the button shows a "not allowed"
     * cursor. Used to prevent Expert→Simple switching once a route is
     * loaded in Expert mode (avoids UI weirdness from missing controls).
     */
    setSimpleLocked(locked) {
      _simpleLocked = !!locked
      if (!_simpleBtn) return
      _simpleBtn.classList.toggle('locked', _simpleLocked)
      _simpleBtn.title = _simpleLocked
        ? 'Park or clear the current route to switch to Simple mode'
        : 'Minimal one-click pipeline'
      _simpleBtn.setAttribute('aria-disabled', _simpleLocked ? 'true' : 'false')
    },

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

    /** Get persistent batch queue panel container (always visible alongside step content) */
    getBatchContainer() {
      return _batchContainer
    },

    /** Show/hide info panel based on active step. Keeps panel visible if batch queue is active. */
    setInfoStep(stepId) {
      if ((stepId && _infoContents[stepId]) || isBatchPanelVisible()) {
        _contentEl.dataset.info = ''
      } else {
        delete _contentEl.dataset.info
      }
      for (const [id, container] of Object.entries(_infoContents)) {
        container.style.display = id === stepId ? '' : 'none'
      }
    },

    /** Force the info panel visible (e.g. when batch queue becomes active). */
    showInfoPanel() {
      _contentEl.dataset.info = ''
    },

    showProgress,
    updateProgress,
    hideProgress,
  }
}

// ────────────────────────────────────────────────────────────────────
// Simple-mode progress overlay
// ────────────────────────────────────────────────────────────────────

const PROGRESS_STEPS = [
  { id: 'lidar',    label: 'LIDAR elevation' },
  { id: 'brunnels', label: 'Bridges & tunnels' },
  { id: 'clean',    label: 'Clean elevation' },
  { id: 'smooth',   label: 'Smooth route' },
]

function buildProgressOverlay() {
  const overlay = el('div', 'progress-overlay')
  const card = el('div', 'progress-card')
  card.appendChild(el('div', 'progress-title', { text: 'Processing route\u2026' }))
  const list = el('ul', 'progress-list')
  _progressSteps = {}
  for (const s of PROGRESS_STEPS) {
    const li = el('li', 'progress-step', { 'data-step': s.id })
    const icon = el('span', 'progress-icon', { text: '\u25CB' }) // ○
    const label = el('span', 'progress-label', { text: s.label })
    const msg = el('span', 'progress-msg')
    li.appendChild(icon)
    li.appendChild(label)
    li.appendChild(msg)
    list.appendChild(li)
    _progressSteps[s.id] = { li, icon, msg }
  }
  card.appendChild(list)
  overlay.appendChild(card)
  return overlay
}

function showProgress() {
  if (!_progressEl) {
    _progressEl = buildProgressOverlay()
    document.body.appendChild(_progressEl)
  }
  // Reset all steps to pending
  for (const { li, icon, msg } of Object.values(_progressSteps)) {
    li.dataset.state = 'pending'
    icon.textContent = '\u25CB'
    msg.textContent = ''
  }
  _progressEl.classList.add('visible')
}

function updateProgress(stepId, state, message) {
  if (!_progressEl || !_progressSteps[stepId]) return
  const { li, icon, msg } = _progressSteps[stepId]
  li.dataset.state = state
  if (state === 'active') icon.textContent = '\u25D0'      // ◐ running
  else if (state === 'done') icon.textContent = '\u2713'   // ✓
  else if (state === 'error') icon.textContent = '\u2717'  // ✗
  else icon.textContent = '\u25CB'
  if (message !== undefined) msg.textContent = message
}

function hideProgress() {
  if (!_progressEl) return
  _progressEl.classList.remove('visible')
}
