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

/**
 * Render a list of clickable rows into `listEl`. Shared by the brunnels and
 * snap-suspects panels — both show `{ html }` rows that zoom the chart/map on
 * click via an `onClick(index)` callback.
 * @param {HTMLElement} listEl
 * @param {Array<{ html: string }>} items
 * @param {(index: number) => void} [onClick]
 */
function renderClickableList(listEl, items, onClick) {
  listEl.innerHTML = ''
  items.forEach((item, i) => {
    const row = el('div', null, { html: item.html })
    row.style.cssText = 'font-size:10px;padding:2px 4px;cursor:pointer;border-radius:3px;transition:background 0.1s'
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--panel2)' })
    row.addEventListener('mouseleave', () => { row.style.background = '' })
    if (onClick) row.addEventListener('click', () => onClick(i))
    listEl.appendChild(row)
  })
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
    },
    hideMarkerInfo() {
      markerInfo.style.display = 'none'
    },
    enableApply(v) { btnApply.disabled = !v },
    enableUndo(v) { btnUndo.disabled = !v },
  }
}

function buildSnapPanel(controls, output) {
  // Controls: Profile [Car▾] | Spacing [750]m | [Auto-Snap] | Densify [1]m
  const snapGroup = makeTbGroup()

  // Profile selector (Car / Bike / Pedestrian)
  const profileWrap = el('div', 'tb-param')
  profileWrap.appendChild(el('span', 'tb-param-label', { text: 'Profile', title: 'Routing profile: Car has best coverage; Bike uses cycling roads; Pedestrian/Hiking uses footpaths and trails' }))
  const costingSelect = el('select', 'tb-param-input')
  costingSelect.style.width = '130px'
  costingSelect.appendChild(el('option', null, { text: 'Car', value: 'car' }))
  costingSelect.appendChild(el('option', null, { text: 'Bike', value: 'bike' }))
  costingSelect.appendChild(el('option', null, { text: 'Pedestrian / Hiking', value: 'pedestrian' }))
  profileWrap.appendChild(costingSelect)
  snapGroup.appendChild(profileWrap)

  // Mode: Auto (detect HU noise) / Faithful (hug the track) / Head-unit cleanup
  const modeWrap = el('div', 'tb-param')
  modeWrap.appendChild(el('span', 'tb-param-label', { text: 'Mode', title: 'Faithful: follow the recorded track exactly (accurate GPS / planned routes). Head-unit cleanup: sparse uniform anchors snap to the road centreline and smooth GPS jitter / stops / missed turns. Auto: detect noisy head-unit tracks and pick cleanup automatically.' }))
  const modeSelect = el('select', 'tb-param-input')
  modeSelect.style.width = '120px'
  modeSelect.appendChild(el('option', null, { text: 'Auto', value: 'auto' }))
  modeSelect.appendChild(el('option', null, { text: 'Faithful', value: 'faithful' }))
  modeSelect.appendChild(el('option', null, { text: 'Head-unit cleanup', value: 'cleanup' }))
  modeWrap.appendChild(modeSelect)
  snapGroup.appendChild(modeWrap)

  const { wrap: rSpacing, input: spacingInput } = makeTbParam('Spacing', 'Faithful-mode base spacing between auto-placed waypoints (m)', { value: 750, min: 50, max: 5000, step: 50 })
  snapGroup.appendChild(rSpacing)
  const { wrap: rHuSpacing, input: huSpacingInput } = makeTbParam('HU dist', 'Head-unit cleanup uniform anchor spacing (m) — larger = more aggressive smoothing', { value: 100, min: 30, max: 500, step: 10 })
  snapGroup.appendChild(rHuSpacing)
  const btnAutoSnap = makeTbBtn('Auto-Snap', 'snap', { disabled: true })
  snapGroup.appendChild(btnAutoSnap)
  controls.appendChild(snapGroup)

  const densifyGroup = makeTbGroup()
  const { wrap: rDensify, input: densifyInput } = makeTbParam('Densify', 'Point spacing for LIDAR (0=off, 1\u20135m typical)', { value: 1, min: 0, max: 10, step: 1 })
  densifyGroup.appendChild(rDensify)
  controls.appendChild(densifyGroup)

  const routingGroup = makeTbGroup('Routing')
  const { wrap: wOW, input: ignoreOnewaysInput } = makeTbToggle(
    'One-ways',
    'Follow track through one-way streets (ON by default — snaps recorded GPS tracks correctly). Turn OFF only if planning a new route that must respect one-way rules.',
    { checked: true },
  )
  const { wrap: wRES, input: ignoreRestrictionsInput } = makeTbToggle(
    'Restrictions',
    'Follow track through turn restrictions (ON by default — snaps recorded GPS tracks correctly). Turn OFF to validate whether your route respects OSM turn restrictions.',
    { checked: true },
  )
  const { wrap: wAP, input: adaptiveProfileInput } = makeTbToggle(
    'Per-leg profile',
    'Auto-switch profile per segment where the chosen one can’t follow the track (e.g. Car over a bike-only path → try Bike/Foot). Works in both Faithful and Head-unit cleanup mode. Turn OFF for a single global profile everywhere.',
    { checked: true },
  )
  const { wrap: wRF, input: refineInput } = makeTbToggle(
    'Refine',
    'Re-route segments that drift off-track through extra waypoints sampled from the original track (Faithful mode). Pins the snap back onto the recorded road — but on a noisy source track the dense waypoints can introduce small spurs/kinks. Turn OFF for the plain sparse snap.',
    { checked: true },
  )
  routingGroup.appendChild(wOW)
  routingGroup.appendChild(wRES)
  routingGroup.appendChild(wAP)
  routingGroup.appendChild(wRF)
  controls.appendChild(routingGroup)

  // Manual nudge — drag a point on the map, scroll to adjust range
  const nudgeGroup = makeTbGroup('Nudge')
  const btnNudge = makeTbBtn('Nudge', 'ghost')
  btnNudge.title = 'Drag points on map to align with satellite imagery (scroll wheel adjusts range)'
  const nudgeRangeLabel = el('span', 'param-hint', { text: '' })
  nudgeRangeLabel.style.cssText = 'font-size:11px;white-space:nowrap'
  nudgeGroup.appendChild(btnNudge)
  nudgeGroup.appendChild(nudgeRangeLabel)
  controls.appendChild(nudgeGroup)

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

  // Suspects: segments where snapping may have drifted onto a different road
  const suspectsSec = el('div', null)
  suspectsSec.style.display = 'none'
  suspectsSec.style.marginTop = '6px'
  const suspectBadge = el('span', 'tsec-badge', { text: '0' })
  const suspectHdr = el('div', null)
  suspectHdr.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px'
  suspectHdr.appendChild(el('span', 'tb-status', { text: '⚠ Routing Suspects' }))
  suspectHdr.appendChild(suspectBadge)
  suspectsSec.appendChild(suspectHdr)
  suspectHdr.appendChild(el('span', 'param-hint', { text: 'click to zoom — check vs. blue original track' }))
  const suspectList = el('div', 'log-area')
  suspectsSec.appendChild(suspectList)
  output.appendChild(suspectsSec)

  // Kinks: short out-and-back spurs the snap introduced (click to zoom, ✂ to snip)
  const kinksSec = el('div', null)
  kinksSec.style.display = 'none'
  kinksSec.style.marginTop = '6px'
  const kinkBadge = el('span', 'tsec-badge', { text: '0' })
  const kinkHdr = el('div', null)
  kinkHdr.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px'
  kinkHdr.appendChild(el('span', 'tb-status', { text: '⟲ Kinks (out-and-back spurs)' }))
  kinkHdr.appendChild(kinkBadge)
  kinkHdr.appendChild(el('span', 'param-hint', { text: 'click to zoom • ✂ to snip' }))
  kinksSec.appendChild(kinkHdr)
  const kinkList = el('div', 'log-area')
  kinksSec.appendChild(kinkList)
  output.appendChild(kinksSec)

  return {
    els: { costingSelect, spacingInput, modeSelect, huSpacingInput, adaptiveProfileInput, refineInput, btnAutoSnap, snapProgress, btnRevert, btnUndo, densifyInput, ignoreOnewaysInput, ignoreRestrictionsInput, nudgeGroup, btnNudge, nudgeRangeLabel, suspectsSec, suspectBadge, suspectList, kinksSec, kinkBadge, kinkList },
    getCosting() { return costingSelect.value },
    getSpacing() { return +spacingInput.value },
    getMode() { return modeSelect.value },
    getHuSpacing() { return +huSpacingInput.value },
    getAdaptiveProfile() { return adaptiveProfileInput.checked },
    getRefine() { return refineInput.checked },
    getDensify() { return +densifyInput.value },
    getIgnoreOneways() { return ignoreOnewaysInput.checked },
    getIgnoreRestrictions() { return ignoreRestrictionsInput.checked },
    setProgress(text) {
      snapProgress.textContent = text
      snapProgress.style.display = text ? '' : 'none'
    },
    showRevert(v) {
      btnRevert.style.display = v ? '' : 'none'
    },
    enableUndo(v) { btnUndo.disabled = !v },
    setNudgeActive(v) {
      btnNudge.classList.toggle('tb-btn-active', v)
      btnNudge.textContent = v ? 'Exit Nudge' : 'Nudge'
    },
    setNudgeRange(text) { nudgeRangeLabel.textContent = text },
    setSuspects(suspects, onClick) {
      suspectList.innerHTML = ''
      if (!suspects || suspects.length === 0) {
        suspectsSec.style.display = 'none'
        return
      }
      suspectBadge.textContent = String(suspects.length)
      suspects.forEach((s, i) => {
        const row = el('div', null)
        row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:10px;padding:2px 4px;border-radius:3px;transition:background 0.1s'
        const info = el('span', null, {
          html: `📍 <b>${(s.atM / 1000).toFixed(2)} km</b> — peak ${s.maxDev.toFixed(0)}m off track, ${s.lengthM.toFixed(0)}m long`,
        })
        info.style.cssText = 'flex:1;cursor:pointer'
        info.addEventListener('click', () => onClick && onClick(i))
        row.appendChild(info)
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--panel2)' })
        row.addEventListener('mouseleave', () => { row.style.background = '' })
        suspectList.appendChild(row)
      })
      suspectsSec.style.display = ''
    },
    setKinks(kinks, handlers = {}) {
      kinkList.innerHTML = ''
      if (!kinks || kinks.length === 0) {
        kinksSec.style.display = 'none'
        return
      }
      kinkBadge.textContent = String(kinks.length)
      kinks.forEach((k, i) => {
        const row = el('div', null)
        row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:10px;padding:2px 4px;border-radius:3px;transition:background 0.1s'
        const info = el('span', null, {
          html: `📍 <b>${(k.atM / 1000).toFixed(2)} km</b> — ${k.lengthM.toFixed(0)}m spur, ${k.depthM.toFixed(0)}m deep`,
        })
        info.style.cssText = 'flex:1;cursor:pointer'
        info.addEventListener('click', () => handlers.onZoom && handlers.onZoom(i))
        const snip = makeTbBtn('✂ Snip', 'ghost')
        snip.style.cssText = 'font-size:9px;padding:1px 5px'
        snip.addEventListener('click', (e) => { e.stopPropagation(); handlers.onSnip && handlers.onSnip(i) })
        row.appendChild(info)
        row.appendChild(snip)
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--panel2)' })
        row.addEventListener('mouseleave', () => { row.style.background = '' })
        kinkList.appendChild(row)
      })
      kinksSec.style.display = ''
    },
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
    },
    hideResults() {
      resultsSec.style.display = 'none'
    },
    setList(html) { list.innerHTML = html },
    setListItems(items, onClick) { renderClickableList(list, items, onClick) },
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
    },
    clearLog() {
      log.clear()
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

  // Smoothing engine + min turn radius \u2014 one radius for every turn (junctions + road bends). Native =
  // GPXForge fillets (default); processGPX = legacy arc-fitting (A/B). Persisted across sessions.
  const engineGroup = makeTbGroup()
  const { wrap: engineWrap, select: engineSelect } = makeTbSelect('Engine',
    'Native = GPXForge fillets (consistent min radius); processGPX = legacy arc-fitting/splines',
    [['native', 'Native'], ['processgpx', 'processGPX']])
  const { wrap: radiusWrap, input: radiusInput } = makeTbParam('Min radius m',
    'Minimum turn radius for every corner (looser for TrainingPeaks Virtual)', { value: 6, min: 1, max: 50, step: 0.5 })
  engineGroup.appendChild(engineWrap)
  engineGroup.appendChild(radiusWrap)
  controls.appendChild(engineGroup)

  // Restore persisted values.
  try {
    const e = localStorage.getItem('gpxforge.smoothEngine')
    if (e === 'native' || e === 'processgpx') engineSelect.value = e
    const r = parseFloat(localStorage.getItem('gpxforge.minRadiusM'))
    if (Number.isFinite(r) && r > 0) radiusInput.value = String(r)
  } catch { /* localStorage unavailable */ }
  const persist = (k, v) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } }
  engineSelect.addEventListener('change', () => persist('gpxforge.smoothEngine', engineSelect.value))
  radiusInput.addEventListener('change', () => persist('gpxforge.minRadiusM', radiusInput.value))

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
    els: { btnApply, btnRevert, btnSimplify, engineSelect, radiusInput },
    getEngine() { return engineSelect.value === 'processgpx' ? 'processgpx' : 'native' },
    getMinRadiusM() { const r = parseFloat(radiusInput.value); return Number.isFinite(r) && r > 0 ? r : 6 },
    showStats(data) {
      stats.set('ptsBefore', String(data.ptsOrig))
      stats.set('ptsAfter', String(data.ptsAfter))
      stats.set('ascBefore', Math.round(data.ascBefore) + 'm')
      stats.set('ascAfter', Math.round(data.ascAfter) + 'm')
      stats.set('maxBefore', data.maxBefore.toFixed(1) + '%')
      stats.set('maxAfter', data.maxAfter.toFixed(1) + '%')
      stats.show()
    },
    hideStats() {
      stats.hide()
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

  // Edit-track group: reverse / move-start / split-by-distance / select+crop/export / undo
  const editGroup = makeTbGroup()
  editGroup.appendChild(el('span', 'tb-param-label', { text: 'Edit:' }))
  const btnReverse = makeTbBtn('\u21C4 Reverse', 'ghost', { disabled: true })
  btnReverse.title = 'Reverse route direction (swap start \u2194 end)'
  editGroup.appendChild(btnReverse)
  const btnMoveStart = makeTbBtn('\u25C9 Move start', 'ghost', { disabled: true })
  btnMoveStart.title = 'Loops only: click a point on the chart to set it as the new start/finish'
  editGroup.appendChild(btnMoveStart)
  const { wrap: wDist, input: byDistInput } = makeTbParam('Split km', 'Distance per segment (km)', { value: 20, min: 1, max: 300, step: 1 })
  editGroup.appendChild(wDist)
  const btnSplitDist = makeTbBtn('Split by dist', 'ghost', { disabled: true })
  editGroup.appendChild(btnSplitDist)
  const btnSelectRange = makeTbBtn('\u25AD Select', 'ghost', { disabled: true })
  btnSelectRange.title = 'Drag-select a distance range on the chart'
  editGroup.appendChild(btnSelectRange)
  const btnCrop = makeTbBtn('\u2702 Crop to sel', 'ghost', { disabled: true })
  btnCrop.title = 'Keep only the selected range'
  editGroup.appendChild(btnCrop)
  const btnExportSel = makeTbBtn('\u2193 Export sel', 'ghost', { disabled: true })
  btnExportSel.title = 'Download the selected range as GPX (route unchanged)'
  editGroup.appendChild(btnExportSel)
  const btnZNudge = makeTbBtn('\u2b0d Z nudge', 'ghost', { disabled: true })
  btnZNudge.title = 'Drag a point up/down on the elevation chart to raise/lower it (scroll to resize, cos\u00b2 falloff)'
  editGroup.appendChild(btnZNudge)
  const btnAppend = makeTbBtn('\uFF0B Append GPX', 'ghost', { disabled: true })
  btnAppend.title = 'Load a second GPX and join it to this route (auto-oriented, overlap-trimmed)'
  editGroup.appendChild(btnAppend)
  const appendFileInput = el('input', null, { type: 'file' })
  appendFileInput.accept = '.gpx'
  appendFileInput.style.display = 'none'
  editGroup.appendChild(appendFileInput)
  // Seam-blend settings for Append (overlap "redone wins" + XY/Z smoothing)
  const { wrap: seamRow, input: seamToggle } = makeTbToggle('Seam blend', 'Smooth the join (XY position + Z gradient) when appending')
  seamToggle.checked = true
  editGroup.appendChild(seamRow)
  const { wrap: wXy, input: seamXyInput } = makeTbParam('XY m', 'Seam position smoothing radius (m)', { value: 3, min: 0, max: 30, step: 1 })
  editGroup.appendChild(wXy)
  const { wrap: wZ, input: seamZInput } = makeTbParam('Z pts', 'Seam gradient-average window (points each side)', { value: 4, min: 0, max: 20, step: 1 })
  editGroup.appendChild(wZ)
  // Lane split: dual-lane out-and-back
  editGroup.appendChild(el('span', 'tb-param-label', { text: 'Lane:' }))
  const { wrap: wGap, input: laneGapInput } = makeTbParam('Gap m', 'Lane separation, 0.1\u201310 m', { value: 4, min: 0.1, max: 10, step: 0.1 })
  editGroup.appendChild(wGap)
  const { wrap: laneSideRow, input: laneSideToggle } = makeTbToggle('Out left', 'Out leg on the left of travel (default: right). For Offset in Z mode: down instead of up')
  editGroup.appendChild(laneSideRow)
  const { wrap: axisRow, input: axisToggle } = makeTbToggle('Z axis', 'Offset operates on elevation (up/down) instead of position (left/right)')
  editGroup.appendChild(axisRow)
  const btnLaneSplit = makeTbBtn('\u21C4 Lane split', 'ghost', { disabled: true })
  btnLaneSplit.title = 'Make a dual-lane out-and-back: offset both legs, U-turn at the far end, inner corners \u22656 m'
  editGroup.appendChild(btnLaneSplit)
  const btnOffsetSel = makeTbBtn('\u21C9 Offset sel', 'ghost', { disabled: true })
  btnOffsetSel.title = 'Offset by the gap. Axis toggle picks XY (left/right) or Z (up/down); side toggle picks the direction. No selection: whole route; with a selection: just that stretch (ramped/blended joins)'
  editGroup.appendChild(btnOffsetSel)
  const btnSepOverlap = makeTbBtn('\u291C Split overlap', 'ghost', { disabled: true })
  btnSepOverlap.title = 'Pull an out/back overlap apart into two lanes within the selected range'
  editGroup.appendChild(btnSepOverlap)
  const btnUnifyOverlap = makeTbBtn('\u2A53 Unify overlap', 'ghost', { disabled: true })
  btnUnifyOverlap.title = 'BikeTerra fix: make the matching opposite pass IDENTICAL to the selected one (same XY + Z) so an out-and-back / lap renders as one road, not two layered traces'
  editGroup.appendChild(btnUnifyOverlap)
  // Reuse reconciliation \u2014 for compiled Course Builder courses where the graph KNOWS the reuse.
  const btnUnifyReused = makeTbBtn('\u232F Unify reused', 'ghost', { disabled: true })
  btnUnifyReused.title = 'Make every pass of a reused course road vertex-identical (XY + Z), using the graph\u2019s known reuse. The pass you last edited wins. Runs automatically on download.'
  btnUnifyReused.style.display = 'none'
  editGroup.appendChild(btnUnifyReused)
  // Topology: compile a hand-authored route-graph JSON to a flat GPX (directed-graph model)
  const btnGraphCompile = makeTbBtn('\u2B21 Graph\u2192GPX', 'ghost')
  btnGraphCompile.title = 'Load a route-graph JSON (nodes + segments + route) and download the compiled flat GPX. Shared roads/crossings become one canonical geometry.'
  editGroup.appendChild(btnGraphCompile)
  const graphFileInput = el('input', null, { type: 'file' })
  graphFileInput.accept = '.json,application/json'
  graphFileInput.style.display = 'none'
  editGroup.appendChild(graphFileInput)
  const btnUndoEdit = makeTbBtn('\u21B6 Undo edit', 'ghost', { disabled: true })
  editGroup.appendChild(btnUndoEdit)
  controls.appendChild(editGroup)

  // Topology editor group \u2014 annotate the active route into a directed graph.
  const topoGroup = makeTbGroup()
  topoGroup.appendChild(el('span', 'tb-param-label', { text: 'Topology:' }))
  const btnTopoEnter = makeTbBtn('\u2B21 Topology editor', 'ghost', { disabled: true })
  btnTopoEnter.title = 'Annotate the active route: drop nodes, declare shared roads, compile a BikeTerra-correct GPX (one road for out-and-backs / laps)'
  topoGroup.appendChild(btnTopoEnter)
  const btnTopoDetect = makeTbBtn('\u2295 Detect structure', 'ghost', { disabled: true })
  btnTopoDetect.title = 'Auto-decompose: snap same-level crossings (overpasses kept separate by elevation) and merge overlapping passes into one shared road'
  topoGroup.appendChild(btnTopoDetect)
  const btnTopoComplete = makeTbBtn('\u25ce Complete junctions', 'ghost', { disabled: true })
  btnTopoComplete.title = 'Fetch each junction\u2019s OSM cross-streets and add the turns the route never drove as stub legs (multilevel-aware \u2014 excludes bridges/tunnels over the junction)'
  topoGroup.appendChild(btnTopoComplete)
  const btnTopoRoundabouts = makeTbBtn('\u25ef Roundabouts', 'ghost', { disabled: true })
  btnTopoRoundabouts.title = 'Detect roundabouts on the route via OSM (junction=roundabout) and highlight them on the map'
  topoGroup.appendChild(btnTopoRoundabouts)
  const btnTopoMerge = makeTbBtn('\u22C0 Merge sel', 'ghost', { disabled: true })
  btnTopoMerge.title = 'Declare the two selected segments the SAME road (vertex-identical reuse \u2192 one rendered road)'
  topoGroup.appendChild(btnTopoMerge)
  const btnTopoSnap = makeTbBtn('\u2316 Snap crossing', 'ghost', { disabled: true })
  btnTopoSnap.title = 'Merge the two selected NODES into one shared, flat junction point (same-level crossing)'
  topoGroup.appendChild(btnTopoSnap)
  const btnTopoUndo = makeTbBtn('\u21B6 Undo', 'ghost', { disabled: true })
  topoGroup.appendChild(btnTopoUndo)
  const btnTopoBuild = makeTbBtn('\u25B6 Build course', 'ghost', { disabled: true })
  btnTopoBuild.title = 'Assemble a NEW course: click a segment to start, then click connected (highlighted) segments to continue. Click a segment again to reuse it.'
  topoGroup.appendChild(btnTopoBuild)
  const btnTopoStepBack = makeTbBtn('\u21B6 Step', 'ghost', { disabled: true })
  btnTopoStepBack.title = 'Remove the last arc from the course being built'
  topoGroup.appendChild(btnTopoStepBack)
  const btnTopoFlip = makeTbBtn('\u21C4 Flip start', 'ghost', { disabled: true })
  btnTopoFlip.title = 'Flip the direction of the first arc (sets which way the course starts)'
  topoGroup.appendChild(btnTopoFlip)
  const { wrap: topoRoundRow, input: topoRoundToggle } = makeTbToggle('Round', 'Round junction turns into tangent arcs and out-and-back folds into teardrops on compile (crossings stay exact)')
  topoRoundToggle.checked = true
  topoGroup.appendChild(topoRoundRow)
  const btnTopoCompile = makeTbBtn('Compile\u2192GPX', 'green', { disabled: true })
  btnTopoCompile.title = 'Compile the graph and download the flat GPX'
  topoGroup.appendChild(btnTopoCompile)
  const btnTopoApply = makeTbBtn('Compile\u2192route', 'ghost', { disabled: true })
  btnTopoApply.title = 'Compile the graph and replace the active route with the result'
  topoGroup.appendChild(btnTopoApply)
  const btnTopoExit = makeTbBtn('Exit', 'ghost', { disabled: true })
  topoGroup.appendChild(btnTopoExit)
  // RETIRED (Stage 5): the Split-step topology editor is superseded by the front-entry Course
  // Builder mode (⬢ Build course). The group + buttons are still constructed so existing handlers
  // in main.js keep valid references (harmless — they wire to a detached node), but the group is
  // NOT appended to the Split panel, so it no longer clutters Split. Split keeps the genuine
  // partition/crop/export/Download-All jobs + the general geometry edit tools.
  // controls.appendChild(topoGroup)  // ← intentionally not added; see Course Builder.

  // Course sequence list (shown while building a course)
  const topoCourseList = el('div', 'log-area')
  topoCourseList.style.display = 'none'
  output.appendChild(topoCourseList)

  // Segment list (shown in the info panel while the topology editor is active)
  const topoSegList = el('div', 'log-area')
  topoSegList.style.display = 'none'
  output.appendChild(topoSegList)

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

  // Edit-track status line (selection / hint feedback)
  const editStatus = el('div', 'param-hint', { text: '' })
  editStatus.style.display = 'none'
  output.appendChild(editStatus)

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
      btnReverse, btnMoveStart, byDistInput, btnSplitDist,
      btnSelectRange, btnCrop, btnExportSel, btnZNudge, btnAppend, appendFileInput,
      seamToggle, seamXyInput, seamZInput,
      laneGapInput, laneSideToggle, axisToggle, btnLaneSplit, btnOffsetSel, btnSepOverlap, btnUnifyOverlap, btnUnifyReused,
      btnGraphCompile, graphFileInput, btnUndoEdit, editStatus,
      btnTopoEnter, btnTopoDetect, btnTopoComplete, btnTopoRoundabouts, btnTopoMerge, btnTopoSnap, btnTopoUndo,
      btnTopoBuild, btnTopoStepBack, btnTopoFlip, topoRoundToggle, btnTopoCompile, btnTopoApply, btnTopoExit, topoSegList, topoCourseList,
    },
    getSeamOpts() {
      return {
        blend: seamToggle.checked,
        xyRadiusM: Math.max(0, +seamXyInput.value || 0),
        zHalfCount: Math.max(0, Math.round(+seamZInput.value || 0)),
      }
    },
    getLaneSplitOpts() {
      return {
        gapM: Math.min(10, Math.max(0.1, +laneGapInput.value || 4)),
        side: laneSideToggle.checked ? 'left' : 'right',
        axis: axisToggle.checked ? 'z' : 'xy',
      }
    },
    setEditStatus(text) {
      if (!text) { editStatus.style.display = 'none'; editStatus.textContent = ''; return }
      editStatus.textContent = text
      editStatus.style.display = ''
    },
    /**
     * Render the topology segment list. Pass `null`/`[]` to hide it.
     * @param {Array<{id,from,to,points,uses,selected}>} summaries
     * @param {(id:string)=>void} onClick
     */
    renderTopoSegments(summaries, onClick) {
      topoSegList.innerHTML = ''
      if (!summaries || !summaries.length) { topoSegList.style.display = 'none'; return }
      topoSegList.style.display = ''
      for (const s of summaries) {
        const row = el('div', 'log-line', {
          text: `${s.id}: ${s.from}→${s.to} · ${s.points} pts${s.uses > 1 ? ` · reused ${s.uses}×` : ''}`,
        })
        row.style.cssText = `cursor:pointer;padding:2px 4px;${s.selected ? 'background:rgba(18,168,90,.25);font-weight:700' : ''}`
        row.addEventListener('click', () => onClick && onClick(s.id))
        topoSegList.appendChild(row)
      }
    },
    /**
     * Render the course sequence (numbered arcs). Pass `null`/`[]` to hide it.
     * @param {Array<{segment:string,dir:string}>} course
     */
    renderTopoCourse(course) {
      topoCourseList.innerHTML = ''
      if (!course || !course.length) { topoCourseList.style.display = 'none'; return }
      topoCourseList.style.display = ''
      const hdr = el('div', 'log-line', { text: `Course — ${course.length} arc(s):` })
      hdr.style.cssText = 'font-weight:700;padding:2px 4px'
      topoCourseList.appendChild(hdr)
      course.forEach((a, i) => {
        const row = el('div', 'log-line', { text: `${i + 1}. ${a.segment} ${a.dir === 'reverse' ? '⤺ rev' : '→ fwd'}` })
        row.style.cssText = 'padding:1px 8px'
        topoCourseList.appendChild(row)
      })
    },
    /** Enable/disable the topology buttons. `building` toggles the build-mode controls. */
    setTopoActive(active, building = false) {
      btnTopoDetect.disabled = !active || building
      btnTopoComplete.disabled = !active || building
      btnTopoRoundabouts.disabled = !active || building
      btnTopoMerge.disabled = !active || building
      btnTopoSnap.disabled = !active || building
      btnTopoUndo.disabled = !active || building
      btnTopoCompile.disabled = !active
      btnTopoApply.disabled = !active
      btnTopoExit.disabled = !active
      btnTopoBuild.disabled = !active
      btnTopoBuild.textContent = building ? '■ Stop building' : '▶ Build course'
      btnTopoStepBack.disabled = !active || !building
      btnTopoFlip.disabled = !active || !building
      btnTopoEnter.disabled = active // can't re-enter while active
    },
    getParams() {
      return { power: +powerInput.value, mass: +massInput.value, groupRide: groupToggle.checked }
    },
    updateWkg,
    showTimeSummary(text) {
      summaryContent.textContent = text
      timeSummary.style.display = ''
    },
    showSplitDuration(totalText) {
      totalInfo.textContent = totalText
      splitDuration.style.display = ''
    },
    showResults() {
      splitResults.style.display = ''
    },
    hideResults() {
      timeSummary.style.display = 'none'
      splitDuration.style.display = 'none'
      splitResults.style.display = 'none'
      analysisSummary.style.display = 'none'
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
    ['pedestrian', 'Pedestrian / Hiking'],
  ])
  profileGroup.appendChild(profileWrap)
  controls.appendChild(profileGroup)

  // Place search group
  const placeGroup = makeTbGroup('Place')
  const placeWrap = el('div', 'tb-autocomplete')
  const placeInput = el('input', 'tb-param-input tb-place-input', {
    type: 'text',
    placeholder: 'Search places…',
    title: 'Search city or place and move map there',
  })
  const placeSuggest = el('div', 'tb-suggest')
  placeWrap.appendChild(placeInput)
  placeWrap.appendChild(placeSuggest)
  placeGroup.appendChild(placeWrap)
  controls.appendChild(placeGroup)

  // Routing flags — same defaults & semantics as the snap step
  const routingGroup = makeTbGroup('Routing')
  const { wrap: wOW, input: ignoreOnewaysInput } = makeTbToggle(
    'One-ways',
    'Allow routing through one-way streets (ON by default — useful when retracing recorded tracks). Turn OFF to plan a new route that respects one-way rules.',
    { checked: true },
  )
  const { wrap: wRES, input: ignoreRestrictionsInput } = makeTbToggle(
    'Restrictions',
    'Allow routing through OSM turn restrictions (ON by default). Turn OFF to validate a route against turn restrictions.',
    { checked: true },
  )
  routingGroup.appendChild(wOW)
  routingGroup.appendChild(wRES)
  controls.appendChild(routingGroup)

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
      placeInput, statusEl, wpVal, distVal, outputStatus,
      ignoreOnewaysInput, ignoreRestrictionsInput,
    },
    getIgnoreOneways() { return ignoreOnewaysInput.checked },
    getIgnoreRestrictions() { return ignoreRestrictionsInput.checked },

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
        placeSuggest.style.display = 'none'
        return
      }
      items.forEach((item) => {
        const btn = el('button', 'tb-suggest-item', { text: item.name, type: 'button' })
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault() // prevent input blur before click fires
          placeInput.value = item.name
          placeSuggest.style.display = 'none'
          if (onPick) onPick(item)
        })
        placeSuggest.appendChild(btn)
      })
      placeSuggest.style.display = 'block'
    },

    hidePlaceSuggestions() {
      placeSuggest.style.display = 'none'
    },

    setSearchStatus(msg) {
      searchStatus.textContent = msg || ''
    },

    setSearchBusy(busy) {
      placeInput.disabled = !!busy
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// Course Builder panel — draw an area → pick a course on the OSM network
// ────────────────────────────────────────────────────────────────────

function buildCoursePanel(controls, output) {
  // Method group — how to seed the course: draw an Area, Import a ride, or free-Draw waypoints.
  const methodGroup = makeTbGroup('Method')
  const { wrap: methodWrap, select: methodSelect } = makeTbSelect('', 'How to build the course', [
    ['area', 'Area'],
    ['import', 'Import ride'],
    ['draw', 'Draw'],
  ])
  const btnImport = makeTbBtn('⬆ Import GPX', 'ghost')
  btnImport.style.display = 'none'
  const btnTraceRide = makeTbBtn('▸ Trace ride', 'ghost')
  btnTraceRide.title = 'Load the whole imported ride as the course (or click nodes to build a different one)'
  btnTraceRide.style.display = 'none'
  const btnRetryFetch = makeTbBtn('↻ Retry fetch', 'ghost')
  btnRetryFetch.title = 'Re-fetch the OSM sections that failed (Overpass was busy) — already-fetched sections are instant'
  btnRetryFetch.style.display = 'none'
  const importInput = el('input', '', { type: 'file', accept: '.gpx' })
  importInput.style.display = 'none'
  methodGroup.appendChild(methodWrap)
  methodGroup.appendChild(btnImport)
  methodGroup.appendChild(btnTraceRide)
  methodGroup.appendChild(btnRetryFetch)
  methodGroup.appendChild(importInput)
  controls.appendChild(methodGroup)

  // Profile (street-filter) group — same routing profiles as Road Snap.
  const profileGroup = makeTbGroup('Roads')
  const { wrap: profileWrap, select: profileSelect } = makeTbSelect('', 'Which roads to fetch', [
    ['car', 'Car'],
    ['bike', 'Bike'],
    ['pedestrian', 'Pedestrian / Hiking'],
  ])
  profileGroup.appendChild(profileWrap)
  controls.appendChild(profileGroup)

  // Place search group (reuses the autocomplete pattern from the route builder).
  const placeGroup = makeTbGroup('Place')
  const placeWrap = el('div', 'tb-autocomplete')
  const placeInput = el('input', 'tb-param-input tb-place-input', {
    type: 'text', placeholder: 'Search places…', title: 'Search a place and move the map there',
  })
  const placeSuggest = el('div', 'tb-suggest')
  placeWrap.appendChild(placeInput)
  placeWrap.appendChild(placeSuggest)
  placeGroup.appendChild(placeWrap)
  controls.appendChild(placeGroup)

  // Area group — shape selector + draw button
  const areaGroup = makeTbGroup('Area')
  const { wrap: shapeWrap, select: shapeSelect } = makeTbSelect('', 'Region shape to draw', [
    ['bbox', 'Box'],
    ['poly', 'Polygon'],
    ['corridor', 'Corridor'],
  ])
  const btnDraw = makeTbBtn('▭ Draw area', 'primary')
  const btnFinishDraw = makeTbBtn('✓ Finish', 'green')
  btnFinishDraw.title = 'Finish the polygon/corridor (or double-click the map, or click the first point to close a polygon)'
  btnFinishDraw.style.display = 'none'
  const btnCancelDraw = makeTbBtn('✕ Cancel', 'ghost')
  btnCancelDraw.style.display = 'none'
  areaGroup.appendChild(shapeWrap)
  areaGroup.appendChild(btnDraw)
  areaGroup.appendChild(btnFinishDraw)
  areaGroup.appendChild(btnCancelDraw)
  controls.appendChild(areaGroup)

  // Course actions
  const actGroup = makeTbGroup('Course')
  const btnReverse = makeTbBtn('⇄ Reverse', 'ghost', { disabled: true })
  btnReverse.title = 'Reverse the whole course (swap start ↔ finish)'
  const btnUndo = makeTbBtn('↩ Undo', 'ghost', { disabled: true })
  const btnClear = makeTbBtn('🗑 Clear', 'ghost', { disabled: true })
  const btnDone = makeTbBtn('✓ Done', 'orange', { disabled: true })
  actGroup.appendChild(btnReverse)
  actGroup.appendChild(btnUndo)
  actGroup.appendChild(btnClear)
  actGroup.appendChild(btnDone)
  controls.appendChild(actGroup)

  // Edit group — graph-native editing of the decomposed network (shown once a network exists).
  // Elevation edits + the continuous-track lane tools live in the Split step (post-LIDAR), so they
  // are deliberately NOT here.
  const editGroup = makeTbGroup('Edit')
  const btnEdit = makeTbBtn('✎ Edit', 'ghost')
  btnEdit.title = 'Toggle edit mode — click legs/nodes to select, then use the tools'
  const btnSplit = makeTbBtn('▣ Split', 'ghost')
  btnSplit.title = 'Split a leg: click the leg, then click the point on it'
  const btnMerge = makeTbBtn('⋀ Merge', 'ghost', { disabled: true })
  btnMerge.title = 'Reuse one road for two passes: select two legs that are the same road'
  const btnSnap = makeTbBtn('⌖ Snap', 'ghost', { disabled: true })
  btnSnap.title = 'Snap two selected nodes into one junction'
  const btnMoveStart = makeTbBtn('⊙ Move start', 'ghost', { disabled: true })
  btnMoveStart.title = 'Rotate a loop course to start at the selected node'
  const btnCrop = makeTbBtn('✂ Crop', 'ghost', { disabled: true })
  btnCrop.title = 'Crop the course to the selected leg(s)'
  const btnOffset = makeTbBtn('⇉ Offset', 'ghost', { disabled: true })
  btnOffset.title = 'Bow the selected leg sideways by the gap'
  const { wrap: gapWrap, input: gapInput } = makeTbParam('Gap m', 'Offset distance (m)', { value: 4, min: 0.1, max: 30, step: 0.5 })
  const { wrap: sideWrap, select: sideSelect } = makeTbSelect('', 'Offset side', [['right', 'Right'], ['left', 'Left']])
  const btnAddRoads = makeTbBtn('＋ Add roads', 'ghost')
  btnAddRoads.title = 'Draw a box to fetch & splice extra streets into the network'
  const btnAppendGpx = makeTbBtn('＋ Append GPX', 'ghost')
  btnAppendGpx.title = 'Add another GPX track to the network (unified at shared vertices)'
  const appendInput = el('input', '', { type: 'file', accept: '.gpx' })
  appendInput.style.display = 'none'
  const btnUndoEdit = makeTbBtn('↩ Undo edit', 'ghost', { disabled: true })
  editGroup.appendChild(btnEdit)
  editGroup.appendChild(btnSplit)
  editGroup.appendChild(btnMerge)
  editGroup.appendChild(btnSnap)
  editGroup.appendChild(btnMoveStart)
  editGroup.appendChild(btnCrop)
  editGroup.appendChild(btnOffset)
  editGroup.appendChild(gapWrap)
  editGroup.appendChild(sideWrap)
  editGroup.appendChild(btnAddRoads)
  editGroup.appendChild(btnAppendGpx)
  editGroup.appendChild(appendInput)
  editGroup.appendChild(btnUndoEdit)
  editGroup.style.display = 'none'
  controls.appendChild(editGroup)

  const statusEl = el('span', 'tb-status', { text: 'Draw a box on the map to fetch its streets' })
  controls.appendChild(statusEl)

  // Output: stats
  const statsWrap = el('div', 'sstats vis')
  const netRow = el('div', 'sstat-row')
  netRow.appendChild(el('span', 'sstat-label', { text: 'Network' }))
  const netVal = el('span', 'sstat-val', { text: '—' })
  netRow.appendChild(netVal)
  statsWrap.appendChild(netRow)

  const legRow = el('div', 'sstat-row')
  legRow.appendChild(el('span', 'sstat-label', { text: 'Course' }))
  const legVal = el('span', 'sstat-val', { text: '0 legs' })
  legRow.appendChild(legVal)
  statsWrap.appendChild(legRow)

  const distRow = el('div', 'sstat-row')
  distRow.appendChild(el('span', 'sstat-label', { text: 'Distance' }))
  const distVal = el('span', 'sstat-val', { text: '—' })
  distRow.appendChild(distVal)
  statsWrap.appendChild(distRow)

  // Prominent status/notice line in the info panel (errors like "area too big", progress, etc.).
  const outputStatus = el('div', 'course-notice', { text: '' })
  output.appendChild(outputStatus)

  output.appendChild(statsWrap)

  // Region list (additive fetched regions, each removable).
  const regionsWrap = el('div', 'corr-list')
  output.appendChild(regionsWrap)

  // Disconnect list — transitions the OSM network couldn't bridge (straight-line connectors). Each row
  // zooms to the spot so the user can fix it by hand (split/snap/draw a connecting road).
  const gapsWrap = el('div', 'corr-list')
  output.appendChild(gapsWrap)

  const searchStatus = el('div', 'param-hint', { text: '' })
  output.appendChild(searchStatus)

  return {
    els: { methodSelect, btnImport, btnTraceRide, btnRetryFetch, importInput, profileSelect, placeInput, shapeSelect, btnDraw, btnFinishDraw, btnCancelDraw, btnReverse, btnUndo, btnClear, btnDone, statusEl, netVal, legVal, distVal, areaGroup,
      editGroup, btnEdit, btnSplit, btnMerge, btnSnap, btnMoveStart, btnCrop, btnOffset, gapInput, sideSelect, btnAddRoads, btnAppendGpx, appendInput, btnUndoEdit },

    getOffsetGap() { return Math.max(0.1, parseFloat(gapInput.value) || 4) },
    getOffsetSide() { return sideSelect.value === 'left' ? 'left' : 'right' },
    /** Show the Edit group once a network exists. */
    setEditAvailable(on) { editGroup.style.display = on ? '' : 'none' },
    /** Reflect edit-mode on/off on the ✎ Edit button. */
    setEditActive(on) {
      btnEdit.classList.toggle('tb-btn-primary', on)
      btnEdit.classList.toggle('tb-btn-ghost', !on)
      btnEdit.textContent = on ? '✎ Editing' : '✎ Edit'
    },
    setSplitArmed(on) {
      btnSplit.classList.toggle('tb-btn-primary', on)
      btnSplit.classList.toggle('tb-btn-ghost', !on)
    },
    /** Enable selection-dependent buttons from current selection counts. */
    setSelection(nSegs, nNodes) {
      btnMerge.disabled = nSegs !== 2
      btnSnap.disabled = nNodes !== 2
      btnMoveStart.disabled = nNodes !== 1
      btnCrop.disabled = nSegs < 1
      btnOffset.disabled = nSegs !== 1
    },
    setUndoEditEnabled(on) { btnUndoEdit.disabled = !on },

    setProfile(p) { profileSelect.value = p },
    setShape(s) { shapeSelect.value = s },
    /** Live feedback while drawing a polygon/corridor: show point count + Finish/Cancel. */
    setDrawProgress(n, shape) {
      const drawing = n > 0 && shape !== 'bbox'
      btnFinishDraw.style.display = drawing ? '' : 'none'
      btnCancelDraw.style.display = drawing ? '' : 'none'
      const minPts = shape === 'poly' ? 3 : 2
      btnFinishDraw.disabled = n < minPts
      if (drawing) {
        const hint = shape === 'poly'
          ? `Polygon: ${n} point(s). Click more, then ✓ Finish, double-click, or click the first (amber) point to close.`
          : `Corridor: ${n} point(s). Click along the route, then ✓ Finish or double-click to end.`
        statusEl.textContent = hint
        outputStatus.textContent = hint
      }
    },
    setMethod(m) {
      methodSelect.value = m
      // Area uses the draw controls; Import uses the upload + trace buttons.
      btnImport.style.display = m === 'import' ? '' : 'none'
      btnTraceRide.style.display = m === 'import' ? '' : 'none'
      if (m !== 'import') btnRetryFetch.style.display = 'none'
      areaGroup.style.display = m === 'area' ? '' : 'none'
    },
    /** Show the ↻ Retry fetch button when some OSM tiles failed (Overpass was busy). */
    setRetryVisible(on) { btnRetryFetch.style.display = on ? '' : 'none' },
    setTraceRideEnabled(on) { btnTraceRide.disabled = !on },
    setDrawArmed(armed) {
      btnDraw.classList.toggle('tb-btn-primary', armed)
      btnDraw.classList.toggle('tb-btn-ghost', !armed)
      btnDraw.textContent = armed ? '▭ Drawing…' : '▭ Draw area'
    },
    setRegions(regions, onRemove) {
      regionsWrap.innerHTML = ''
      regions.forEach((r, i) => {
        const row = el('div', 'corr-item')
        row.appendChild(el('span', 'corr-item__label', { text: `${i + 1}. ${r.shape} · ${r.profile} · ${r.ways} ways` }))
        const rm = el('button', 'tb-btn tb-btn-ghost', { text: '✕', type: 'button', title: 'Remove this region' })
        rm.addEventListener('click', () => { if (onRemove) onRemove(i) })
        row.appendChild(rm)
        regionsWrap.appendChild(row)
      })
    },
    setNetwork(nodes, legs) {
      netVal.textContent = (nodes || legs) ? `${nodes} nodes, ${legs} legs` : '—'
    },
    setStats(legs, distanceM) {
      legVal.textContent = `${legs} leg${legs === 1 ? '' : 's'}`
      distVal.textContent = distanceM > 0 ? (distanceM / 1000).toFixed(2) + ' km' : '—'
      btnDone.disabled = legs < 1
      btnClear.disabled = legs === 0
      btnReverse.disabled = legs < 1
    },
    setUndoEnabled(on) { btnUndo.disabled = !on },
    /** List the bridged disconnects; clicking a row calls onZoom(gap) to fly there on the map. */
    setGaps(gaps, onZoom) {
      gapsWrap.innerHTML = ''
      if (!gaps || !gaps.length) return
      const hdr = el('div', 'corr-item__label', { text: `⚠ ${gaps.length} disconnect(s) — bridged with a straight line, click to fix:` })
      hdr.style.fontWeight = '600'
      gapsWrap.appendChild(hdr)
      gaps.forEach((g, i) => {
        const row = el('div', 'corr-item')
        const m = Math.round(g.distM || 0)
        const b = el('button', 'tb-btn tb-btn-ghost', { text: `↪ Disconnect ${i + 1} · ${m} m gap`, type: 'button', title: 'Zoom to this disconnect' })
        b.style.flex = '1'
        b.addEventListener('click', () => { if (onZoom) onZoom(g) })
        row.appendChild(b)
        gapsWrap.appendChild(row)
      })
    },
    setStatus(msg) {
      statusEl.textContent = msg || 'Draw a box on the map to fetch its streets'
      outputStatus.textContent = msg || ''
    },
    setPlaceSuggestions(items, onPick) {
      placeSuggest.innerHTML = ''
      if (!items || items.length === 0) { placeSuggest.style.display = 'none'; return }
      items.forEach((item) => {
        const b = el('button', 'tb-suggest-item', { text: item.name, type: 'button' })
        b.addEventListener('mousedown', (e) => {
          e.preventDefault()
          placeInput.value = item.name
          placeSuggest.style.display = 'none'
          if (onPick) onPick(item)
        })
        placeSuggest.appendChild(b)
      })
      placeSuggest.style.display = 'block'
    },
    hidePlaceSuggestions() { placeSuggest.style.display = 'none' },
    setSearchStatus(msg) { searchStatus.textContent = msg || '' },
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
 * @returns {{ trim, snap, brunnels, clean, smooth, split, builder, course }}
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
    course: buildCoursePanel(sidebar.getCoursePanel(), shell.getInfoPanel('course')),
  }
}
