/**
 * Step panel UI — populates step-toolbar controls and info panel output.
 *
 * Each builder receives a controls container (toolbar) and an output
 * container (info panel), fills them with compact inline params/buttons
 * (controls) and log/results/stats (output in info panel).
 *
 * No pipeline logic here — buttons log to console or stay disabled.
 */

// ────────────────────────────────────────────────────────────────────
// DOM helpers
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
// Compact inline factories (for step-controls area)
// ────────────────────────────────────────────────────────────────────

/** Group container with optional label and vertical divider */
function makeTbGroup(label) {
  const g = el('div', 'tb-group')
  if (label) g.appendChild(el('span', 'tb-group-label', { text: label }))
  return g
}

/** Inline param: Label [input] */
function makeTbParam(label, titleText, o) {
  const wrap = el('div', 'tb-param')
  wrap.appendChild(el('span', 'tb-param-label', { text: label, title: titleText }))
  const input = el('input', 'tb-param-input', {
    type: 'number', value: String(o.value),
    min: String(o.min), max: String(o.max), step: String(o.step),
  })
  wrap.appendChild(input)
  return { wrap, input }
}

/** Inline toggle: [checkbox] Label */
function makeTbToggle(label, titleText, opts = {}) {
  const wrap = el('div', 'tb-toggle')
  const input = el('input', null, { type: 'checkbox' })
  if (opts.checked) input.checked = true
  const lbl = el('span', 'tb-toggle-label', { text: label, title: titleText })
  wrap.appendChild(input)
  wrap.appendChild(lbl)
  return { wrap, input }
}

/** Inline action button */
function makeTbBtn(text, variant, opts = {}) {
  const btn = el('button', `tb-btn tb-btn-${variant}`, { text, type: 'button' })
  if (opts.disabled) btn.disabled = true
  return btn
}

/** Inline select dropdown */
function makeTbSelect(label, titleText, options) {
  const wrap = el('div', 'tb-param')
  wrap.appendChild(el('span', 'tb-param-label', { text: label, title: titleText }))
  const select = el('select', 'tb-param-select')
  for (const [val, text] of options) {
    select.appendChild(el('option', null, { value: val, text }))
  }
  wrap.appendChild(select)
  return { wrap, select }
}

// ────────────────────────────────────────────────────────────────────
// Output-area factories (for step-output area)
// ────────────────────────────────────────────────────────────────────

/** Progress bar */
function makeProgress() {
  const bar = el('div', 'progress')
  const fill = el('div', 'progress-fill')
  bar.appendChild(fill)
  return {
    bar, fill,
    set(pct) {
      fill.style.width = Math.min(100, Math.max(0, pct)) + '%'
      if (pct > 0) bar.classList.add('vis')
    },
  }
}

/** Scrollable monospace log area */
function makeLog() {
  const log = el('div', 'log-area')
  return {
    log,
    append(msg, cls) {
      const line = el('div', cls || null, { text: msg })
      log.appendChild(line)
      log.scrollTop = log.scrollHeight
    },
    clear() { log.innerHTML = '' },
  }
}

/** Stats panel */
function makeStats(rows) {
  const container = el('div', 'sstats')
  const valEls = {}
  for (const r of rows) {
    const row = el('div', 'sstat-row')
    row.appendChild(el('span', 'sstat-label', { text: r.label }))
    const val = el('span', 'sstat-val', { text: '\u2014' })
    valEls[r.id] = val
    row.appendChild(val)
    container.appendChild(row)
  }
  return {
    el: container,
    set(id, val) { if (valEls[id]) valEls[id].textContent = val },
    show() { container.classList.add('vis') },
    hide() { container.classList.remove('vis') },
  }
}

/** No-op — info panel visibility is managed by shell.setInfoStep() */
function showOutput(_outputEl) {}
function hideOutput(_outputEl) {}

// ────────────────────────────────────────────────────────────────────
// Panel builders
// ────────────────────────────────────────────────────────────────────

function buildTrimPanel(controls, output) {
  // Controls: status text | Apply | Clear | Undo
  const statusGroup = makeTbGroup()
  const status = el('span', 'tb-status', { text: 'Load a file to begin trimming' })
  statusGroup.appendChild(status)
  controls.appendChild(statusGroup)

  const btnGroup = makeTbGroup()
  const btnApply = makeTbBtn('\u2702 Apply Trim', 'orange', { disabled: true })
  const btnClear = makeTbBtn('\u2715 Clear', 'ghost')
  const btnUndo = makeTbBtn('\u21BA Undo', 'ghost', { disabled: true })
  btnGroup.appendChild(btnApply)
  btnGroup.appendChild(btnClear)
  btnGroup.appendChild(btnUndo)
  controls.appendChild(btnGroup)

  // Output: marker info + trim history
  const markerInfo = el('div', null)
  markerInfo.style.display = 'none'
  const markerA = el('div', 'param-hint', { text: 'Cut start: \u2014' })
  const markerB = el('div', 'param-hint', { text: 'Cut end: \u2014' })
  const gapInfo = el('div', 'param-hint', { text: 'Gap: \u2014' })
  markerInfo.appendChild(markerA)
  markerInfo.appendChild(markerB)
  markerInfo.appendChild(gapInfo)
  output.appendChild(markerInfo)

  const trimList = el('div', 'log-area', { text: 'No trims yet' })
  trimList.style.minHeight = '30px'
  output.appendChild(trimList)

  return {
    els: { status, markerInfo, markerA, markerB, gapInfo, trimList, btnApply, btnClear, btnUndo },
    setStatus(text) { status.textContent = text },
    showMarkerInfo(a, b, gap) {
      markerA.textContent = 'Cut start: ' + a
      markerB.textContent = 'Cut end: ' + b
      gapInfo.textContent = 'Gap: ' + gap
      markerInfo.style.display = ''
      showOutput(output)
    },
    hideMarkerInfo() {
      markerInfo.style.display = 'none'
      hideOutput(output)
    },
    enableApply(v) { btnApply.disabled = !v },
    enableUndo(v) { btnUndo.disabled = !v },
  }
}

function buildSnapPanel(controls, output) {
  // Controls: Profile [Car▾] | Spacing [750]m | [Auto-Snap] | Densify [1]m
  const snapGroup = makeTbGroup()

  // Profile selector (Car / Bike)
  const profileWrap = el('div', 'tb-param')
  profileWrap.appendChild(el('span', 'tb-param-label', { text: 'Profile', title: 'Routing profile: Car has better coverage, Bike uses cycling-specific roads' }))
  const costingSelect = el('select', 'tb-param-input')
  costingSelect.style.width = '60px'
  const optCar = el('option', null, { text: 'Car', value: 'car' })
  const optBike = el('option', null, { text: 'Bike', value: 'bike' })
  costingSelect.appendChild(optCar)
  costingSelect.appendChild(optBike)
  profileWrap.appendChild(costingSelect)
  snapGroup.appendChild(profileWrap)

  const { wrap: rSpacing, input: spacingInput } = makeTbParam('Spacing', 'Distance between auto-placed waypoints (m)', { value: 750, min: 50, max: 5000, step: 50 })
  snapGroup.appendChild(rSpacing)
  const btnAutoSnap = makeTbBtn('Auto-Snap', 'snap', { disabled: true })
  snapGroup.appendChild(btnAutoSnap)
  controls.appendChild(snapGroup)

  const densifyGroup = makeTbGroup()
  const { wrap: rDensify, input: densifyInput } = makeTbParam('Densify', 'Point spacing for LIDAR (0=off, 1\u20135m typical)', { value: 1, min: 0, max: 10, step: 1 })
  densifyGroup.appendChild(rDensify)
  controls.appendChild(densifyGroup)

  // Output: snap progress + undo + revert
  const snapProgress = el('div', 'param-hint')
  snapProgress.style.display = 'none'
  output.appendChild(snapProgress)
  const undoRow = el('div', null)
  undoRow.style.cssText = 'display:flex;gap:6px;margin-top:4px'
  const btnUndo = makeTbBtn('\u21BA Undo Drag', 'ghost', { disabled: true })
  const btnRevert = makeTbBtn('Revert to Original', 'ghost')
  btnRevert.style.display = 'none'
  undoRow.appendChild(btnUndo)
  undoRow.appendChild(btnRevert)
  output.appendChild(undoRow)

  return {
    els: { costingSelect, spacingInput, btnAutoSnap, snapProgress, btnRevert, btnUndo, densifyInput },
    getCosting() { return costingSelect.value },
    getSpacing() { return +spacingInput.value },
    getDensify() { return +densifyInput.value },
    setProgress(text) {
      snapProgress.textContent = text
      snapProgress.style.display = text ? '' : 'none'
      if (text) showOutput(output)
      else hideOutput(output)
    },
    showRevert(v) {
      btnRevert.style.display = v ? '' : 'none'
      if (v) showOutput(output)
      else if (!snapProgress.textContent) hideOutput(output)
    },
    enableUndo(v) { btnUndo.disabled = !v },
  }
}

function buildBrunnelsPanel(controls, output) {
  // Controls: Query [10]m  Route [3]m  Bearing [20]° | [Fetch]
  const paramsGroup = makeTbGroup()
  const { wrap: w1, input: queryBuffer } = makeTbParam('Query', 'Overpass bbox expansion (m)', { value: 10, min: 5, max: 100, step: 5 })
  const { wrap: w2, input: routeBuffer } = makeTbParam('Route', 'Max distance from route (m)', { value: 3, min: 1, max: 50, step: 1 })
  const { wrap: w3, input: bearingTol } = makeTbParam('Bearing', 'Alignment with route direction (\u00B0)', { value: 20, min: 5, max: 60, step: 5 })
  paramsGroup.appendChild(w1)
  paramsGroup.appendChild(w2)
  paramsGroup.appendChild(w3)
  controls.appendChild(paramsGroup)

  const actionGroup = makeTbGroup()
  const btnFetch = makeTbBtn('Fetch Brunnels', 'run', { disabled: true })
  actionGroup.appendChild(btnFetch)
  controls.appendChild(actionGroup)

  // Output: progress bar + results section
  const progress = makeProgress()
  output.appendChild(progress.bar)

  const resultsSec = el('div', null)
  resultsSec.style.display = 'none'
  const countBadge = el('span', 'tsec-badge', { text: '0' })
  const resultHdr = el('div', null)
  resultHdr.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px'
  resultHdr.appendChild(el('span', 'tb-status', { text: 'Located Brunnels' }))
  resultHdr.appendChild(countBadge)
  resultsSec.appendChild(resultHdr)
  const list = el('div', 'log-area')
  resultsSec.appendChild(list)
  const btnRow = el('div', null)
  btnRow.style.cssText = 'display:flex;gap:4px;margin-top:4px'
  const btnGo = makeTbBtn('Go to Cleaner \u2192', 'run')
  const btnClear = makeTbBtn('Clear', 'ghost')
  btnRow.appendChild(btnGo)
  btnRow.appendChild(btnClear)
  resultsSec.appendChild(btnRow)
  output.appendChild(resultsSec)

  return {
    els: { queryBuffer, routeBuffer, bearingTol, btnFetch, progress, resultsSec, countBadge, list, btnGo, btnClear },
    getParams() {
      return { queryBuffer: +queryBuffer.value, routeBuffer: +routeBuffer.value, bearingTol: +bearingTol.value }
    },
    showResults(count) {
      countBadge.textContent = String(count)
      resultsSec.style.display = ''
      showOutput(output)
    },
    hideResults() {
      resultsSec.style.display = 'none'
      hideOutput(output)
    },
    setList(html) { list.innerHTML = html },
    setListItems(items, onClick) {
      list.innerHTML = ''
      items.forEach((item, i) => {
        const row = document.createElement('div')
        row.innerHTML = item.html
        row.style.cssText = 'font-size:10px;padding:2px 4px;cursor:pointer;border-radius:3px;transition:background 0.1s'
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--panel2)' })
        row.addEventListener('mouseleave', () => { row.style.background = '' })
        row.addEventListener('click', () => onClick(i))
        list.appendChild(row)
      })
    },
  }
}

function buildCleanPanel(controls, output) {
  // Row 1: DETECT: Spike [25]% Anchor [30] MergeGap [30] MergeDist [10]m | [RUN] [RESET]
  const detectGroup = makeTbGroup('Detect')
  const { wrap: w1, input: spikeT } = makeTbParam('Spike', 'Flag |gradient| above this (%)', { value: 25, min: 5, max: 50, step: 1 })
  const { wrap: w2, input: anchorT } = makeTbParam('Anchor', 'Max |gradient| at anchor point', { value: 30, min: 2, max: 50, step: 1 })
  const { wrap: w3, input: mergeGap } = makeTbParam('MergeGap', 'Merge spike runs \u2264 N points', { value: 30, min: 1, max: 100, step: 1 })
  const { wrap: w4, input: mergeDist } = makeTbParam('MergeDist', 'Chain nearby corrections (m)', { value: 10, min: 0, max: 2000, step: 10 })
  detectGroup.appendChild(w1)
  detectGroup.appendChild(w2)
  detectGroup.appendChild(w3)
  detectGroup.appendChild(w4)
  controls.appendChild(detectGroup)

  const actionGroup = makeTbGroup()
  const btnRun = makeTbBtn('\u25B6 Run', 'run', { disabled: true })
  const btnReset = makeTbBtn('\u21BA Reset', 'ghost', { disabled: true })
  const btnDraw = makeTbBtn('\u270F Draw', 'ghost', { disabled: true, title: 'Draw manual correction zone (D)' })
  actionGroup.appendChild(btnRun)
  actionGroup.appendChild(btnReset)
  actionGroup.appendChild(btnDraw)
  controls.appendChild(actionGroup)

  // Row 2 (flex-wrap): SHAPE: [✓Smart] Tan [8] Herm [0.5] BrDip [1.0] TuSpk [1.0]
  const shapeGroup = makeTbGroup('Shape')
  const { wrap: smartWrap, input: smartToggle } = makeTbToggle('Smart', 'Classify structures by shape', { checked: true })
  shapeGroup.appendChild(smartWrap)
  const smartParams = el('span', null)
  smartParams.style.display = 'inline-flex'
  smartParams.style.gap = '6px'
  const { wrap: w5, input: tangWin } = makeTbParam('Tan', 'Tangent window (pts)', { value: 8, min: 3, max: 30, step: 1 })
  const { wrap: w6, input: hermDev } = makeTbParam('Herm', 'Hermite min deviation (m)', { value: 0.5, min: 0.1, max: 5, step: 0.1 })
  const { wrap: w7, input: bridgeDip } = makeTbParam('BrDip', 'Bridge dip threshold (m)', { value: 1.0, min: 0.2, max: 10, step: 0.1 })
  const { wrap: w8, input: tunnelSpk } = makeTbParam('TuSpk', 'Tunnel spike threshold (m)', { value: 1.0, min: 0.2, max: 10, step: 0.1 })
  smartParams.appendChild(w5)
  smartParams.appendChild(w6)
  smartParams.appendChild(w7)
  smartParams.appendChild(w8)
  shapeGroup.appendChild(smartParams)
  smartToggle.addEventListener('change', () => {
    smartParams.style.display = smartToggle.checked ? 'inline-flex' : 'none'
  })
  controls.appendChild(shapeGroup)

  // SUSPECT: [✓] Span [200]m Rev [5]% Grade [8]%
  const suspectGroup = makeTbGroup('Suspect')
  const { wrap: suspWrap, input: suspectToggle } = makeTbToggle('On', 'Flag potential false positives', { checked: true })
  suspectGroup.appendChild(suspWrap)
  const suspectParams = el('span', null)
  suspectParams.style.display = 'inline-flex'
  suspectParams.style.gap = '6px'
  const { wrap: w9, input: suspSpan } = makeTbParam('Span', 'Only check spans longer than this (m)', { value: 200, min: 50, max: 2000, step: 50 })
  const { wrap: w10, input: suspRev } = makeTbParam('Rev', 'Gradient reversal rate limit (%)', { value: 5, min: 1, max: 30, step: 1 })
  const { wrap: w11, input: suspGrade } = makeTbParam('Grade', 'Mean gradient threshold (%)', { value: 8, min: 3, max: 20, step: 1 })
  suspectParams.appendChild(w9)
  suspectParams.appendChild(w10)
  suspectParams.appendChild(w11)
  suspectGroup.appendChild(suspectParams)
  suspectToggle.addEventListener('change', () => {
    suspectParams.style.display = suspectToggle.checked ? 'inline-flex' : 'none'
  })
  controls.appendChild(suspectGroup)

  // VEG FILTER: [✓ Enabled] Sensitivity [1.5]m | [Run Veg Filter]
  const vegGroup = makeTbGroup('Veg Filter')
  const { wrap: vegWrap, input: vegToggle } = makeTbToggle(
    'Enabled',
    'Remove vegetation/foliage LIDAR artifacts (positive elevation spikes)',
    { checked: true }
  )
  vegGroup.appendChild(vegWrap)
  const { wrap: vegSensWrap, input: vegSensInput } = makeTbParam(
    'Sensitivity',
    'Min spike height to flag (m) — lower = more aggressive',
    { value: 1.5, min: 0.5, max: 5.0, step: 0.1 }
  )
  vegGroup.appendChild(vegSensWrap)
  const btnRunVeg = makeTbBtn('Run Veg Filter', 'run', { disabled: true })
  vegGroup.appendChild(btnRunVeg)
  controls.appendChild(vegGroup)

  // Output: progress bar + log
  const progress = makeProgress()
  output.appendChild(progress.bar)
  const log = makeLog()
  output.appendChild(log.log)

  return {
    els: {
      spikeT, anchorT, mergeGap, mergeDist,
      smartToggle, smartParams, tangWin, hermDev, bridgeDip, tunnelSpk,
      suspectToggle, suspectParams, suspSpan, suspRev, suspGrade,
      vegToggle, vegSensInput, btnRunVeg,
      btnRun, btnReset, btnDraw, progress,
    },
    getDetectionParams() {
      return { spikeT: +spikeT.value, anchorT: +anchorT.value, mergeGap: +mergeGap.value, mergeDist: +mergeDist.value }
    },
    getShapeParams() {
      return { smart: smartToggle.checked, tangWin: +tangWin.value, hermDev: +hermDev.value, bridgeDip: +bridgeDip.value, tunnelSpk: +tunnelSpk.value }
    },
    getSuspectParams() {
      return { enabled: suspectToggle.checked, suspSpan: +suspSpan.value, suspRev: +suspRev.value, suspGrade: +suspGrade.value }
    },
    getVegParams() {
      return { enabled: vegToggle.checked, spikeThresholdM: +vegSensInput.value }
    },
    enableRunVeg(v) { btnRunVeg.disabled = !v },
    appendLog(msg, cls) {
      log.append(msg, cls)
      showOutput(output)
    },
    clearLog() {
      log.clear()
      hideOutput(output)
    },
    setProgress: progress.set,
  }
}

function buildSmoothPanel(controls, output) {
  // Controls: [▶ Process] [↺ Revert] | [✂ Simplify]
  const actionGroup = makeTbGroup()
  const btnApply = makeTbBtn('\u25B6 Process', 'green', { disabled: true })
  const btnRevert = makeTbBtn('\u21BA Revert', 'ghost')
  btnRevert.style.display = 'none'
  actionGroup.appendChild(btnApply)
  actionGroup.appendChild(btnRevert)
  controls.appendChild(actionGroup)

  const simplifyGroup = makeTbGroup()
  const btnSimplify = makeTbBtn('\u2702 Simplify', 'ghost', { disabled: true })
  btnSimplify.title = 'Remove redundant points (triangle-area method)'
  simplifyGroup.appendChild(btnSimplify)
  controls.appendChild(simplifyGroup)

  // Output: stats panel
  const stats = makeStats([
    { label: 'Points before', id: 'ptsBefore' },
    { label: 'Points after', id: 'ptsAfter' },
    { label: 'Ascent before', id: 'ascBefore' },
    { label: 'Ascent after', id: 'ascAfter' },
    { label: 'Max grade before', id: 'maxBefore' },
    { label: 'Max grade after', id: 'maxAfter' },
  ])
  output.appendChild(stats.el)

  // Simplify log (below process stats)
  const simplifyLog = el('div', 'sstat-container')
  simplifyLog.style.display = 'none'
  output.appendChild(simplifyLog)

  return {
    els: { btnApply, btnRevert, btnSimplify },
    showStats(data) {
      stats.set('ptsBefore', String(data.ptsOrig))
      stats.set('ptsAfter', String(data.ptsAfter))
      stats.set('ascBefore', Math.round(data.ascBefore) + 'm')
      stats.set('ascAfter', Math.round(data.ascAfter) + 'm')
      stats.set('maxBefore', data.maxBefore.toFixed(1) + '%')
      stats.set('maxAfter', data.maxAfter.toFixed(1) + '%')
      stats.show()
      showOutput(output)
    },
    hideStats() {
      stats.hide()
      hideOutput(output)
    },
    showSimplifyLog(entries) {
      // entries: [{ before, after, removed }]
      simplifyLog.innerHTML = ''
      if (!entries.length) {
        simplifyLog.style.display = 'none'
        return
      }
      const header = el('div', 'sstat-row')
      header.innerHTML = '<span style="font-weight:600">Simplify</span>'
      simplifyLog.appendChild(header)
      entries.forEach((e, i) => {
        const row = el('div', 'sstat-row')
        row.innerHTML = `<span>Pass ${i + 1}</span><span>${e.before} \u2192 ${e.after} (\u2212${e.removed})</span>`
        simplifyLog.appendChild(row)
      })
      simplifyLog.style.display = ''
      showOutput(output)
    },
    hideSimplifyLog() {
      simplifyLog.innerHTML = ''
      simplifyLog.style.display = 'none'
    },
    enableApply(v) { btnApply.disabled = !v },
    enableRevert(v) { btnRevert.style.display = v ? '' : 'none' },
    enableSimplify(v) { btnSimplify.disabled = !v },
  }
}

function buildSplitPanel(controls, output) {
  // Controls: Power [200]W  Mass [80]kg  (2.50 W/kg) | [✓ Group] | [Analyze]
  const riderGroup = makeTbGroup()
  const { wrap: w1, input: powerInput } = makeTbParam('Power', '70\u201380% of FTP typical (W)', { value: 200, min: 80, max: 500, step: 5 })
  const { wrap: w2, input: massInput } = makeTbParam('Mass', 'Total system weight (kg)', { value: 80, min: 40, max: 150, step: 1 })
  riderGroup.appendChild(w1)
  riderGroup.appendChild(w2)
  const wkgDisplay = el('span', 'tb-status', { text: '2.50 W/kg' })
  wkgDisplay.style.fontFamily = 'var(--font-mono)'
  riderGroup.appendChild(wkgDisplay)
  controls.appendChild(riderGroup)

  function updateWkg() {
    const w = +powerInput.value || 200
    const m = +massInput.value || 80
    wkgDisplay.textContent = (w / m).toFixed(2) + ' W/kg'
  }
  powerInput.addEventListener('input', updateWkg)
  massInput.addEventListener('input', updateWkg)

  const optGroup = makeTbGroup()
  const { wrap: groupRow, input: groupToggle } = makeTbToggle('Group', 'Roaming bots drafting model (Blocken 2018)')
  optGroup.appendChild(groupRow)
  const btnAnalyze = makeTbBtn('\u25B6 Analyze', 'run', { disabled: true })
  optGroup.appendChild(btnAnalyze)
  controls.appendChild(optGroup)

  // Output: time summary + split duration + results
  const timeSummary = el('div', null)
  timeSummary.style.display = 'none'
  const summaryContent = el('div', 'param-hint', { text: '\u2014' })
  timeSummary.appendChild(summaryContent)
  output.appendChild(timeSummary)

  const splitDuration = el('div', null)
  splitDuration.style.display = 'none'
  const totalInfo = el('div', 'param-hint', { text: '' })
  splitDuration.appendChild(totalInfo)
  const presetsGrid = el('div', null)
  presetsGrid.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin:4px 0'
  for (const mins of [30, 45, 60, 90, 120]) {
    const btn = el('button', 'tb-btn tb-btn-ghost', { text: mins + ' min', type: 'button' })
    btn.style.cssText = 'width:auto;flex:1;min-width:40px;padding:3px 4px;font-size:9px'
    presetsGrid.appendChild(btn)
  }
  splitDuration.appendChild(presetsGrid)
  const customRow = el('div', null)
  customRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:4px'
  customRow.appendChild(el('span', 'tb-param-label', { text: 'Custom:' }))
  const customMinInput = el('input', 'tb-param-input', { type: 'number', value: '60', min: '10', max: '480', step: '5' })
  customRow.appendChild(customMinInput)
  customRow.appendChild(el('span', 'tb-param-label', { text: 'min' }))
  const btnCustomSplit = makeTbBtn('Split', 'ghost')
  customRow.appendChild(btnCustomSplit)
  splitDuration.appendChild(customRow)
  output.appendChild(splitDuration)

  const splitResults = el('div', null)
  splitResults.style.display = 'none'
  const resultHdr = el('div', null)
  resultHdr.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px'
  resultHdr.appendChild(el('span', 'tb-status', { text: 'Segments' }))
  const btnDownloadAll = makeTbBtn('Download All GPX', 'green')
  resultHdr.appendChild(btnDownloadAll)
  splitResults.appendChild(resultHdr)
  const splitsList = el('div', 'log-area')
  splitResults.appendChild(splitsList)
  output.appendChild(splitResults)

  // Analysis summary (rendered by main.js after Analyze)
  const analysisSummary = el('div', null)
  analysisSummary.style.display = 'none'
  output.appendChild(analysisSummary)

  return {
    els: {
      powerInput, massInput, wkgDisplay, groupToggle, btnAnalyze,
      timeSummary, summaryContent,
      splitDuration, totalInfo, presetsGrid, customMinInput, btnCustomSplit,
      splitResults, splitsList, btnDownloadAll,
      analysisSummary,
    },
    getParams() {
      return { power: +powerInput.value, mass: +massInput.value, groupRide: groupToggle.checked }
    },
    updateWkg,
    showTimeSummary(text) {
      summaryContent.textContent = text
      timeSummary.style.display = ''
      showOutput(output)
    },
    showSplitDuration(totalText) {
      totalInfo.textContent = totalText
      splitDuration.style.display = ''
      showOutput(output)
    },
    showResults() {
      splitResults.style.display = ''
      showOutput(output)
    },
    hideResults() {
      timeSummary.style.display = 'none'
      splitDuration.style.display = 'none'
      splitResults.style.display = 'none'
      analysisSummary.style.display = 'none'
      hideOutput(output)
    },
    showAnalysis(html) {
      analysisSummary.innerHTML = html
      analysisSummary.style.display = ''
    },
    clearAnalysis() {
      analysisSummary.innerHTML = ''
      analysisSummary.style.display = 'none'
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// Route Builder panel
// ────────────────────────────────────────────────────────────────────

/**
 * Build the route builder controls + output panels.
 * @param {HTMLElement} controls — container in step-toolbar
 * @param {HTMLElement} output — container in info panel
 * @returns {object} panel API
 */
function buildRouteBuilderPanel(controls, output) {
  // Mode group
  const modeGroup = makeTbGroup('Mode')
  const btnRoutedMode = makeTbBtn('\uD83D\uDEE3 Routed', 'primary')
  const btnManualMode = makeTbBtn('\u270B Manual', 'ghost')
  modeGroup.appendChild(btnRoutedMode)
  modeGroup.appendChild(btnManualMode)
  controls.appendChild(modeGroup)

  // Profile group
  const profileGroup = makeTbGroup('Profile')
  const { wrap: profileWrap, select: profileSelect } = makeTbSelect('', 'Routing profile', [
    ['car', 'Car'],
    ['bike', 'Bike'],
  ])
  profileGroup.appendChild(profileWrap)
  controls.appendChild(profileGroup)

  // Place search group
  const placeGroup = makeTbGroup('Place')
  const placeWrap = el('div', 'tb-autocomplete')
  const placeListId = 'builder-place-list'
  const placeInput = el('input', 'tb-param-input tb-place-input', {
    type: 'text',
    placeholder: 'Search places',
    title: 'Search city or place and move map there',
    list: placeListId,
  })
  const btnPlaceSearch = makeTbBtn('Go', 'snap')
  const placeSuggest = el('datalist', null, { id: placeListId })
  placeWrap.appendChild(placeInput)
  placeWrap.appendChild(placeSuggest)
  placeGroup.appendChild(placeWrap)
  placeGroup.appendChild(btnPlaceSearch)
  controls.appendChild(placeGroup)

  // Actions group
  const actGroup = makeTbGroup()
  const btnUndo = makeTbBtn('\u21A9 Undo', 'ghost', { disabled: true })
  const btnClear = makeTbBtn('\uD83D\uDDD1 Clear', 'ghost', { disabled: true })
  const btnDone = makeTbBtn('\u2713 Done', 'orange', { disabled: true })
  actGroup.appendChild(btnUndo)
  actGroup.appendChild(btnClear)
  actGroup.appendChild(btnDone)
  controls.appendChild(actGroup)

  // Status line
  const statusEl = el('span', 'tb-status', { text: 'Click the map to place waypoints' })
  controls.appendChild(statusEl)

  // Output: stats
  const statsWrap = el('div', 'sstats vis')
  const wpRow = el('div', 'sstat-row')
  wpRow.appendChild(el('span', 'sstat-label', { text: 'Waypoints' }))
  const wpVal = el('span', 'sstat-val', { text: '0' })
  wpRow.appendChild(wpVal)
  statsWrap.appendChild(wpRow)

  const distRow = el('div', 'sstat-row')
  distRow.appendChild(el('span', 'sstat-label', { text: 'Distance' }))
  const distVal = el('span', 'sstat-val', { text: '\u2014' })
  distRow.appendChild(distVal)
  statsWrap.appendChild(distRow)

  output.appendChild(statsWrap)

  const outputStatus = el('div', 'param-hint', { text: '' })
  output.appendChild(outputStatus)

  const searchStatus = el('div', 'param-hint', { text: '' })
  output.appendChild(searchStatus)

  return {
    els: {
      btnRoutedMode, btnManualMode, profileSelect, btnUndo, btnClear, btnDone,
      placeInput, btnPlaceSearch, statusEl, wpVal, distVal, outputStatus,
    },

    setMode(mode) {
      btnRoutedMode.classList.toggle('tb-btn-primary', mode === 'routed')
      btnRoutedMode.classList.toggle('tb-btn-ghost', mode !== 'routed')
      btnManualMode.classList.toggle('tb-btn-primary', mode === 'manual')
      btnManualMode.classList.toggle('tb-btn-ghost', mode !== 'manual')
    },

    setStats(waypoints, distanceM) {
      wpVal.textContent = String(waypoints)
      distVal.textContent = distanceM > 0 ? (distanceM / 1000).toFixed(1) + ' km' : '\u2014'
      btnDone.disabled = waypoints < 2
      btnClear.disabled = waypoints === 0
    },

    setUndoEnabled(enabled) {
      btnUndo.disabled = !enabled
    },

    setStatus(msg) {
      statusEl.textContent = msg || 'Click the map to place waypoints'
      outputStatus.textContent = msg || ''
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

    setSearchStatus(msg) {
      searchStatus.textContent = msg || ''
    },

    setSearchBusy(busy) {
      placeInput.disabled = !!busy
      btnPlaceSearch.disabled = !!busy
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Build all step panel UI shells.
 * Controls go into the step toolbar; output/results go into the info panel.
 * @param {{ getToolPanel: (id: string) => HTMLElement }} sidebar
 * @param {{ getInfoPanel: (id: string) => HTMLElement }} shell
 * @returns {{ trim, snap, brunnels, clean, smooth, split, builder }}
 */
export function initPanels(sidebar, shell) {
  return {
    trim: buildTrimPanel(sidebar.getToolPanel('trim'), shell.getInfoPanel('trim')),
    snap: buildSnapPanel(sidebar.getToolPanel('snap'), shell.getInfoPanel('snap')),
    brunnels: buildBrunnelsPanel(sidebar.getToolPanel('brunnels'), shell.getInfoPanel('brunnels')),
    clean: buildCleanPanel(sidebar.getToolPanel('clean'), shell.getInfoPanel('clean')),
    smooth: buildSmoothPanel(sidebar.getToolPanel('smooth'), shell.getInfoPanel('smooth')),
    split: buildSplitPanel(sidebar.getToolPanel('split'), shell.getInfoPanel('split')),
    builder: buildRouteBuilderPanel(sidebar.getBuilderPanel(), shell.getInfoPanel('builder')),
  }
}
