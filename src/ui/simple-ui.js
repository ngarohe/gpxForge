/**
 * Simple Mode UI — builds all DOM for the simple tool.
 *
 * Four views: landing, builder, processing, review.
 * Each built once, visibility toggled via .active class.
 */

// ────────────────────────────────────────────────────────────────────
// DOM helper
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

// ────────────────────────────────────────────────────────────────────
// Flex resize handle logic
// ────────────────────────────────────────────────────────────────────

/**
 * Wire a drag handle to resize two flex siblings.
 * @param {HTMLElement} handle — the draggable handle element
 * @param {HTMLElement} container — parent flex container
 * @param {HTMLElement} panelA — first panel (before handle)
 * @param {HTMLElement} panelB — second panel (after handle)
 * @param {'row'|'col'} direction — 'row' for vertical split, 'col' for horizontal split
 */
function setupFlexResize(handle, container, panelA, panelB, direction) {
  let dragging = false
  let startPos = 0
  let startSizeA = 0
  const isRow = direction === 'row'

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    dragging = true
    startPos = isRow ? e.clientY : e.clientX
    startSizeA = isRow ? panelA.offsetHeight : panelA.offsetWidth
    document.body.style.cursor = isRow ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
  })

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const delta = (isRow ? e.clientY : e.clientX) - startPos
    const total = isRow ? container.clientHeight : container.clientWidth
    const handleSize = isRow ? handle.offsetHeight : handle.offsetWidth
    const newA = Math.max(80, Math.min(total - handleSize - 80, startSizeA + delta))
    const newB = total - handleSize - newA
    panelA.style.flex = `0 0 ${newA}px`
    panelB.style.flex = `0 0 ${newB}px`
  })

  document.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    // Convert to flex ratios for responsive behavior
    const total = isRow ? container.clientHeight : container.clientWidth
    const handleSize = isRow ? handle.offsetHeight : handle.offsetWidth
    const aSize = isRow ? panelA.offsetHeight : panelA.offsetWidth
    const bSize = total - handleSize - aSize
    panelA.style.flex = `${aSize} 0 0px`
    panelB.style.flex = `${bSize} 0 0px`
  })
}

// ────────────────────────────────────────────────────────────────────
// Processing step definitions
// ────────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 'lidar',    label: 'Fetching elevation data...',       doneLabel: 'Elevation data fetched' },
  { id: 'brunnels', label: 'Detecting bridges & tunnels...',   doneLabel: 'Bridges & tunnels detected' },
  { id: 'clean',    label: 'Cleaning elevation artifacts...',  doneLabel: 'Elevation cleaned' },
  { id: 'smooth',   label: 'Smoothing route...',               doneLabel: 'Route smoothed' },
  { id: 'simplify', label: 'Optimising points...',             doneLabel: 'Points optimised' },
]

// ────────────────────────────────────────────────────────────────────
// Build app
// ────────────────────────────────────────────────────────────────────

/**
 * Build the entire simple mode DOM inside #app.
 *
 * @returns {object} refs — element references and controls
 */
export function buildSimpleApp() {
  const app = document.getElementById('app')
  app.className = 'simple-app'

  // ── Landing view ──
  const landing = buildLanding()
  app.appendChild(landing.root)

  // ── Builder view ──
  const builder = buildBuilder()
  app.appendChild(builder.root)

  // ── Processing view ──
  const processing = buildProcessing()
  app.appendChild(processing.root)

  // ── Review view ──
  const review = buildReview()
  app.appendChild(review.root)

  // View management
  const views = { landing, builder, processing, review }
  let activeView = null

  function showView(name) {
    for (const [key, view] of Object.entries(views)) {
      view.root.classList.toggle('active', key === name)
    }
    activeView = name
  }

  // Start on landing
  showView('landing')

  return {
    views,
    showView,
    getActiveView: () => activeView,
    // Shortcuts
    landing,
    builder,
    processing,
    review,
  }
}

// ────────────────────────────────────────────────────────────────────
// Landing view
// ────────────────────────────────────────────────────────────────────

function buildLanding() {
  const root = el('div', 'simple-view landing')

  // Hero
  const hero = el('div', 'landing-hero')

  const brand = el('div', 'landing-brand')
  brand.appendChild(el('div', 'landing-logo', { html: '&#9968;' }))
  brand.appendChild(el('div', 'landing-title', { text: 'GPXForge' }))
  hero.appendChild(brand)

  hero.appendChild(el('div', 'landing-tagline', { text: 'Perfect elevation for virtual cycling' }))
  root.appendChild(hero)

  // Buttons
  const buttons = el('div', 'landing-buttons')

  const btnCreate = el('button', 'landing-btn')
  btnCreate.appendChild(el('div', 'landing-btn-icon', { text: '\u270F\uFE0F' }))
  btnCreate.appendChild(el('div', 'landing-btn-label', { text: 'Create Route' }))
  btnCreate.appendChild(el('div', 'landing-btn-hint', { text: 'Draw on the map' }))
  buttons.appendChild(btnCreate)

  const btnUpload = el('button', 'landing-btn')
  btnUpload.appendChild(el('div', 'landing-btn-icon', { text: '\uD83D\uDCC2' }))
  btnUpload.appendChild(el('div', 'landing-btn-label', { text: 'Upload GPX' }))
  btnUpload.appendChild(el('div', 'landing-btn-hint', { text: 'Use an existing route' }))
  buttons.appendChild(btnUpload)

  const fileInput = el('input', null, { type: 'file', accept: '.gpx' })
  fileInput.style.display = 'none'
  root.appendChild(fileInput)

  root.appendChild(buttons)

  // Coverage
  root.appendChild(el('div', 'landing-coverage', { text: '23 countries \u00b7 1m LIDAR resolution' }))

  // Footer
  const footer = el('div', 'landing-footer')
  const expertLink = el('a', null, { text: 'Expert mode \u2192', href: '/expert' })
  footer.appendChild(expertLink)
  root.appendChild(footer)

  return {
    root,
    btnCreate,
    btnUpload,
    fileInput,
  }
}

// ────────────────────────────────────────────────────────────────────
// Builder view
// ────────────────────────────────────────────────────────────────────

function buildBuilder() {
  const root = el('div', 'simple-view builder')

  // Topbar
  const topbar = el('div', 'builder-topbar')

  const btnBack = el('button', 'builder-back', { text: '\u2190 Back' })
  topbar.appendChild(btnBack)

  // Mode group
  const modeGroup = el('div', 'builder-mode-group')
  modeGroup.appendChild(el('span', 'builder-ctrl-label', { text: 'MODE' }))
  const btnRouted = el('button', 'builder-mode-btn active', { text: '\uD83D\uDEE3\uFE0F Routed' })
  const btnManual = el('button', 'builder-mode-btn', { text: '\u270B Manual' })
  modeGroup.appendChild(btnRouted)
  modeGroup.appendChild(btnManual)
  topbar.appendChild(modeGroup)

  // Profile group
  const profileGroup = el('div', 'builder-mode-group')
  profileGroup.appendChild(el('span', 'builder-ctrl-label', { text: 'PROFILE' }))
  const profileSelect = el('select', 'builder-profile-select')
  const optCar = el('option', null, { value: 'car', text: 'Car' })
  const optBike = el('option', null, { value: 'bike', text: 'Bike' })
  profileSelect.appendChild(optCar)
  profileSelect.appendChild(optBike)
  profileGroup.appendChild(profileSelect)
  topbar.appendChild(profileGroup)

  const placeGroup = el('div', 'builder-mode-group')
  placeGroup.appendChild(el('span', 'builder-ctrl-label', { text: 'PLACE' }))
  const placeWrap = el('div', 'builder-place-wrap')
  const placeListId = 'simple-builder-place-list'
  const placeSearchInput = el('input', 'builder-place-input', {
    type: 'text',
    placeholder: 'Search places',
    title: 'Search city or place and move map there',
    list: placeListId,
  })
  const placeSuggest = el('datalist', null, { id: placeListId })
  const btnPlaceSearch = el('button', 'builder-place-go', { text: 'Go' })
  placeWrap.appendChild(placeSearchInput)
  placeWrap.appendChild(placeSuggest)
  placeGroup.appendChild(placeWrap)
  placeGroup.appendChild(btnPlaceSearch)
  topbar.appendChild(placeGroup)

  const stats = el('div', 'builder-stats')
  const distLabel = el('span', null, { text: 'Distance: ' })
  const distVal = el('span', 'builder-stat-val', { text: '0 km' })
  distLabel.appendChild(distVal)
  stats.appendChild(distLabel)

  const wpLabel = el('span', null, { text: 'Points: ' })
  const wpVal = el('span', 'builder-stat-val', { text: '0' })
  wpLabel.appendChild(wpVal)
  stats.appendChild(wpLabel)

  const statusEl = el('span', 'builder-status')
  stats.appendChild(statusEl)
  topbar.appendChild(stats)

  const btnUndo = el('button', 'builder-undo', { text: '\u21A9', title: 'Undo (Ctrl+Z)' })
  btnUndo.disabled = true
  topbar.appendChild(btnUndo)

  const btnClear = el('button', 'builder-clear', { text: '\uD83D\uDDD1\uFE0F Clear', title: 'Clear all waypoints' })
  topbar.appendChild(btnClear)

  const btnDone = el('button', 'builder-done', { text: '\u2713 Done' })
  btnDone.disabled = true
  topbar.appendChild(btnDone)

  root.appendChild(topbar)

  // Map container
  const mapContainer = el('div', 'builder-map map-panel')
  mapContainer.id = 'builderMap'
  root.appendChild(mapContainer)

  return {
    root,
    btnBack,
    btnDone,
    btnUndo,
    btnClear,
    btnRouted,
    btnManual,
    profileSelect,
    placeSearchInput,
    btnPlaceSearch,
    mapContainer,
    statusEl,
    setMode(mode) {
      btnRouted.classList.toggle('active', mode === 'routed')
      btnManual.classList.toggle('active', mode === 'manual')
    },
    setStats(waypoints, distM) {
      distVal.textContent = (distM / 1000).toFixed(1) + ' km'
      wpVal.textContent = String(waypoints)
      btnDone.disabled = waypoints < 2
    },
    setUndoEnabled(enabled) {
      btnUndo.disabled = !enabled
    },
    setStatus(msg) {
      statusEl.textContent = msg || ''
    },
    setPlaceSuggestions(items, onPick) {
      placeSuggest.innerHTML = ''
      if (!items || items.length === 0) {
        return
      }
      items.forEach((item) => {
        const opt = el('option', null, { value: item.name })
        placeSuggest.appendChild(opt)
      })
    },
    hidePlaceSuggestions() {
      placeSuggest.innerHTML = ''
    },
    setSearchBusy(busy) {
      placeSearchInput.disabled = !!busy
      btnPlaceSearch.disabled = !!busy
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// Processing view
// ────────────────────────────────────────────────────────────────────

function buildProcessing() {
  const root = el('div', 'simple-view processing')

  const card = el('div', 'processing-card')
  card.appendChild(el('div', 'processing-title', { text: 'Processing your route...' }))

  // Step list
  const stepsContainer = el('div', 'processing-steps')
  const stepEls = {}

  for (const step of STEPS) {
    const row = el('div', 'processing-step')
    row.dataset.step = step.id

    const icon = el('div', 'processing-step-icon', { text: '\u25CB' }) // ○
    row.appendChild(icon)
    row.appendChild(el('span', null, { text: step.label }))

    stepsContainer.appendChild(row)
    stepEls[step.id] = { row, icon, label: row.querySelector('span') }
  }

  card.appendChild(stepsContainer)

  // Progress bar
  const bar = el('div', 'processing-bar')
  const barFill = el('div', 'processing-bar-fill')
  bar.appendChild(barFill)
  card.appendChild(bar)

  const pctEl = el('div', 'processing-pct', { text: '0%' })
  card.appendChild(pctEl)

  // Error display
  const errorEl = el('div', 'processing-error')
  const errorText = el('div')
  errorEl.appendChild(errorText)
  const errorBack = el('button', 'processing-error-back', { text: '\u2190 Back to start' })
  errorEl.appendChild(errorBack)
  card.appendChild(errorEl)

  root.appendChild(card)

  return {
    root,
    errorBack,
    resetSteps() {
      for (const step of STEPS) {
        const s = stepEls[step.id]
        s.row.className = 'processing-step'
        s.icon.textContent = '\u25CB'
        s.label.textContent = step.label
      }
      barFill.style.width = '0'
      pctEl.textContent = '0%'
      errorEl.classList.remove('active')
    },
    updateStep(stepId, state, message) {
      const s = stepEls[stepId]
      if (!s) return

      if (state === 'active') {
        s.row.className = 'processing-step active'
        s.icon.textContent = '\u25CB'
      } else if (state === 'done') {
        s.row.className = 'processing-step done'
        s.icon.textContent = '\u2713'
        const def = STEPS.find(st => st.id === stepId)
        s.label.textContent = message || (def ? def.doneLabel : 'Done')
      } else if (state === 'error') {
        s.row.className = 'processing-step error'
        s.icon.textContent = '\u2717'
        if (message) s.label.textContent = message
      }
    },
    setProgress(pct) {
      barFill.style.width = pct + '%'
      pctEl.textContent = Math.round(pct) + '%'
    },
    showError(message) {
      errorText.textContent = message
      errorEl.classList.add('active')
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// Review view
// ────────────────────────────────────────────────────────────────────

function buildReview() {
  const root = el('div', 'simple-view review')

  // Topbar
  const topbar = el('div', 'review-topbar')

  const btnBack = el('button', 'review-back', { text: '\u2190 New route' })
  topbar.appendChild(btnBack)

  const stats = el('div', 'review-stats')

  const mkStat = (label) => {
    const stat = el('div', 'review-stat')
    const val = el('span', 'review-stat-val', { text: '\u2014' })
    stat.appendChild(val)
    stat.appendChild(el('span', 'review-stat-label', { text: ' ' + label }))
    stats.appendChild(stat)
    return val
  }

  const distVal = mkStat('km')
  const ascVal = mkStat('\u2191 ascent')
  const descVal = mkStat('\u2193 descent')
  const ptsVal = mkStat('points')

  topbar.appendChild(stats)

  const btnDraw = el('button', 'review-draw', { text: '\u270F Draw', title: 'Draw manual correction zone — click two points on chart' })
  topbar.appendChild(btnDraw)

  const btnUndo = el('button', 'review-undo', { text: '\u21A9 Undo', title: 'Undo last edit' })
  btnUndo.disabled = true
  topbar.appendChild(btnUndo)

  const btnDownload = el('button', 'review-download', { text: '\u2B07 Download GPX' })
  topbar.appendChild(btnDownload)

  root.appendChild(topbar)

  // Content area
  const content = el('div', 'review-content')

  // Chart (elevation + gradient — shows before/after comparison)
  const chartPanel = el('div', 'review-chart chart-panel')
  const cvMainWrap = el('div', 'chart-main')
  const cvMain = el('canvas')
  cvMainWrap.appendChild(cvMain)
  chartPanel.appendChild(cvMainWrap)

  const cvGradWrap = el('div', 'chart-grad')
  const cvGrad = el('canvas')
  cvGradWrap.appendChild(cvGrad)
  chartPanel.appendChild(cvGradWrap)

  content.appendChild(chartPanel)

  // Horizontal resize handle (chart ↔ bottom)
  const hResize = el('div', 'review-resize-h')
  hResize.appendChild(el('div', 'review-resize-dots'))
  content.appendChild(hResize)

  // Bottom: map + corrections
  const bottom = el('div', 'review-bottom')

  const mapPanel = el('div', 'review-map map-panel')
  mapPanel.id = 'reviewMap'
  bottom.appendChild(mapPanel)

  // Vertical resize handle (map ↔ corrections)
  const vResize = el('div', 'review-resize-v')
  vResize.appendChild(el('div', 'review-resize-dots-v'))
  bottom.appendChild(vResize)

  const corrPanel = el('div', 'review-corrections')
  bottom.appendChild(corrPanel)

  content.appendChild(bottom)

  // Wire resize handles
  setupFlexResize(hResize, content, chartPanel, bottom, 'row')
  setupFlexResize(vResize, bottom, mapPanel, corrPanel, 'col')
  root.appendChild(content)

  return {
    root,
    btnBack,
    btnDraw,
    btnUndo,
    btnDownload,
    mapPanel,
    corrPanel,
    chartEls: { cvMain, cvGrad, cvMini: null },
    setStats(distM, ascM, descM, pts) {
      distVal.textContent = (distM / 1000).toFixed(1)
      ascVal.textContent = Math.round(ascM) + 'm'
      descVal.textContent = Math.round(descM) + 'm'
      ptsVal.textContent = pts.toLocaleString()
    },
    setUndoEnabled(enabled) {
      btnUndo.disabled = !enabled
    },
  }
}
