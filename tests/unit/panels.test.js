/**
 * Unit tests for src/ui/panels.js
 *
 * Tests all 6 panel builders in the step-toolbar layout.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { initSidebar } from '../../src/ui/sidebar.js'
import { initPanels } from '../../src/ui/panels.js'
import { ST } from '../../src/state.js'

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function resetState() {
  ST.activeStep = null
  ST.stepStatus = {}
}

let sidebar, panels, mockShell

function setup() {
  resetState()
  document.body.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'step-toolbar'
  document.body.appendChild(container)
  sidebar = initSidebar(container)

  // Create mock shell with info panel containers for all steps (including builder)
  const infoContents = {}
  for (const id of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split', 'builder']) {
    const div = document.createElement('div')
    div.className = 'info-content'
    div.dataset.step = id
    document.body.appendChild(div)
    infoContents[id] = div
  }
  mockShell = {
    getInfoPanel(stepId) { return infoContents[stepId] || null },
  }

  panels = initPanels(sidebar, mockShell)
}

// ────────────────────────────────────────────────────────────────────
// initPanels
// ────────────────────────────────────────────────────────────────────

describe('initPanels', () => {
  beforeEach(setup)

  it('returns object with 6 panel APIs', () => {
    expect(panels).toBeTruthy()
    expect(panels.trim).toBeTruthy()
    expect(panels.snap).toBeTruthy()
    expect(panels.brunnels).toBeTruthy()
    expect(panels.clean).toBeTruthy()
    expect(panels.smooth).toBeTruthy()
    expect(panels.split).toBeTruthy()
  })

  it('populates all 6 controls panels with content', () => {
    for (const id of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split']) {
      const panel = sidebar.getToolPanel(id)
      expect(panel.children.length).toBeGreaterThan(0)
    }
  })

  it('populates all 6 info panels with output content', () => {
    for (const id of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split']) {
      const panel = mockShell.getInfoPanel(id)
      expect(panel.children.length).toBeGreaterThan(0)
    }
  })
})

// ────────────────────────────────────────────────────────────────────
// Trim panel
// ────────────────────────────────────────────────────────────────────

describe('buildTrimPanel', () => {
  beforeEach(setup)

  it('creates 2 groups in controls', () => {
    const panel = sidebar.getToolPanel('trim')
    const groups = panel.querySelectorAll('.tb-group')
    expect(groups.length).toBe(2)
  })

  it('has status text', () => {
    expect(panels.trim.els.status).toBeTruthy()
    expect(panels.trim.els.status.textContent).toContain('Load a file')
  })

  it('has 3 buttons: Apply, Clear, Undo', () => {
    const { btnApply, btnClear, btnUndo } = panels.trim.els
    expect(btnApply).toBeTruthy()
    expect(btnClear).toBeTruthy()
    expect(btnUndo).toBeTruthy()
  })

  it('Apply and Undo start disabled', () => {
    expect(panels.trim.els.btnApply.disabled).toBe(true)
    expect(panels.trim.els.btnUndo.disabled).toBe(true)
  })

  it('has trim history list in output', () => {
    expect(panels.trim.els.trimList).toBeTruthy()
    expect(panels.trim.els.trimList.textContent).toBe('No trims yet')
  })

  it('setStatus updates text', () => {
    panels.trim.setStatus('Ready')
    expect(panels.trim.els.status.textContent).toBe('Ready')
  })

  it('showMarkerInfo/hideMarkerInfo toggles visibility', () => {
    panels.trim.showMarkerInfo('A', 'B', '10m')
    expect(panels.trim.els.markerInfo.style.display).toBe('')
    panels.trim.hideMarkerInfo()
    expect(panels.trim.els.markerInfo.style.display).toBe('none')
  })
})

// ────────────────────────────────────────────────────────────────────
// Snap panel
// ────────────────────────────────────────────────────────────────────

describe('buildSnapPanel', () => {
  beforeEach(setup)

  it('creates 2 groups in controls (spacing, densify)', () => {
    const panel = sidebar.getToolPanel('snap')
    const groups = panel.querySelectorAll('.tb-group')
    expect(groups.length).toBe(2)
  })

  it('has costing select with default car', () => {
    expect(panels.snap.getCosting()).toBe('car')
  })

  it('has spacing input with default 750', () => {
    expect(panels.snap.getSpacing()).toBe(750)
  })

  it('Auto-Snap button starts disabled', () => {
    expect(panels.snap.els.btnAutoSnap.disabled).toBe(true)
  })

  it('has densify input with default 1', () => {
    expect(panels.snap.getDensify()).toBe(1)
  })

  it('Revert button starts hidden', () => {
    expect(panels.snap.els.btnRevert.style.display).toBe('none')
  })

  it('showRevert toggles revert button', () => {
    panels.snap.showRevert(true)
    expect(panels.snap.els.btnRevert.style.display).toBe('')
    panels.snap.showRevert(false)
    expect(panels.snap.els.btnRevert.style.display).toBe('none')
  })
})

// ────────────────────────────────────────────────────────────────────
// Brunnels panel
// ────────────────────────────────────────────────────────────────────

describe('buildBrunnelsPanel', () => {
  beforeEach(setup)

  it('creates 2 groups in controls', () => {
    const panel = sidebar.getToolPanel('brunnels')
    const groups = panel.querySelectorAll('.tb-group')
    expect(groups.length).toBe(2)
  })

  it('has 3 parameter inputs with correct defaults (10, 3, 20)', () => {
    const p = panels.brunnels.getParams()
    expect(p.queryBuffer).toBe(10)
    expect(p.routeBuffer).toBe(3)
    expect(p.bearingTol).toBe(20)
  })

  it('Fetch button starts disabled', () => {
    expect(panels.brunnels.els.btnFetch.disabled).toBe(true)
  })

  it('has progress bar', () => {
    expect(panels.brunnels.els.progress).toBeTruthy()
    expect(panels.brunnels.els.progress.bar).toBeTruthy()
  })

  it('results section starts hidden', () => {
    expect(panels.brunnels.els.resultsSec.style.display).toBe('none')
  })

  it('showResults makes results visible and updates count', () => {
    panels.brunnels.showResults(5)
    expect(panels.brunnels.els.resultsSec.style.display).toBe('')
    expect(panels.brunnels.els.countBadge.textContent).toBe('5')
  })

  it('hideResults hides results section', () => {
    panels.brunnels.showResults(3)
    panels.brunnels.hideResults()
    expect(panels.brunnels.els.resultsSec.style.display).toBe('none')
  })
})

// ────────────────────────────────────────────────────────────────────
// Clean panel
// ────────────────────────────────────────────────────────────────────

describe('buildCleanPanel', () => {
  beforeEach(setup)

  it('creates 5 groups in controls', () => {
    const panel = sidebar.getToolPanel('clean')
    const groups = panel.querySelectorAll('.tb-group')
    expect(groups.length).toBe(5)
  })

  it('detection params have correct defaults', () => {
    const p = panels.clean.getDetectionParams()
    expect(p.spikeT).toBe(25)
    expect(p.anchorT).toBe(30)
    expect(p.mergeGap).toBe(30)
    expect(p.mergeDist).toBe(10)
  })

  it('shape section has smart toggle and 4 params', () => {
    const p = panels.clean.getShapeParams()
    expect(p.smart).toBe(true)
    expect(p.tangWin).toBe(8)
    expect(p.hermDev).toBe(0.5)
    expect(p.bridgeDip).toBe(1.0)
    expect(p.tunnelSpk).toBe(1.0)
  })

  it('smart toggle hides/shows smartParams', () => {
    const { smartToggle, smartParams } = panels.clean.els
    expect(smartParams.style.display).toBe('inline-flex')
    smartToggle.checked = false
    smartToggle.dispatchEvent(new Event('change'))
    expect(smartParams.style.display).toBe('none')
    smartToggle.checked = true
    smartToggle.dispatchEvent(new Event('change'))
    expect(smartParams.style.display).toBe('inline-flex')
  })

  it('suspect section has toggle and 3 params with correct defaults', () => {
    const p = panels.clean.getSuspectParams()
    expect(p.enabled).toBe(true)
    expect(p.suspSpan).toBe(200)
    expect(p.suspRev).toBe(5)
    expect(p.suspGrade).toBe(8)
  })

  it('suspect toggle hides/shows suspectParams', () => {
    const { suspectToggle, suspectParams } = panels.clean.els
    suspectToggle.checked = false
    suspectToggle.dispatchEvent(new Event('change'))
    expect(suspectParams.style.display).toBe('none')
    suspectToggle.checked = true
    suspectToggle.dispatchEvent(new Event('change'))
    expect(suspectParams.style.display).toBe('inline-flex')
  })

  it('Run starts disabled, Reset starts disabled', () => {
    expect(panels.clean.els.btnRun.disabled).toBe(true)
    expect(panels.clean.els.btnReset.disabled).toBe(true)
  })

  it('has log area with append and clear', () => {
    panels.clean.appendLog('test message', 'i')
    const output = mockShell.getInfoPanel('clean')
    const log = output.querySelector('.log-area')
    expect(log.children.length).toBe(1)
    expect(log.textContent).toBe('test message')
    panels.clean.clearLog()
    expect(log.children.length).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Smooth panel
// ────────────────────────────────────────────────────────────────────

describe('buildSmoothPanel', () => {
  beforeEach(setup)

  it('creates 2 groups: Process+Revert and Simplify', () => {
    const panel = sidebar.getToolPanel('smooth')
    const groups = panel.querySelectorAll('.tb-group')
    expect(groups.length).toBe(2)
    // No sigma param inputs — processGPX handles everything auto
    const params = panel.querySelectorAll('.tb-param')
    expect(params.length).toBe(0)
  })

  it('no getParams method (auto pipeline)', () => {
    expect(panels.smooth.getParams).toBeUndefined()
  })

  it('Process button starts disabled', () => {
    expect(panels.smooth.els.btnApply.disabled).toBe(true)
  })

  it('Revert starts hidden', () => {
    expect(panels.smooth.els.btnRevert.style.display).toBe('none')
  })

  it('enableApply/enableRevert toggle button state', () => {
    panels.smooth.enableApply(true)
    expect(panels.smooth.els.btnApply.disabled).toBe(false)
    panels.smooth.enableRevert(true)
    expect(panels.smooth.els.btnRevert.style.display).toBe('')
    panels.smooth.enableRevert(false)
    expect(panels.smooth.els.btnRevert.style.display).toBe('none')
  })

  it('has stats panel in info panel (hidden initially)', () => {
    const output = mockShell.getInfoPanel('smooth')
    const stats = output.querySelector('.sstats')
    expect(stats).toBeTruthy()
    expect(stats.classList.contains('vis')).toBe(false)
  })

  it('showStats populates and shows stats with point counts', () => {
    panels.smooth.showStats({ ptsOrig: 100, ptsAfter: 95, ascBefore: 100, ascAfter: 90, maxBefore: 15.5, maxAfter: 12.3 })
    const output = mockShell.getInfoPanel('smooth')
    const stats = output.querySelector('.sstats')
    expect(stats.classList.contains('vis')).toBe(true)
    expect(stats.textContent).toContain('100')
    expect(stats.textContent).toContain('95')
    expect(stats.textContent).toContain('90m')
    expect(stats.textContent).toContain('12.3%')
  })
})

// ────────────────────────────────────────────────────────────────────
// Split panel
// ────────────────────────────────────────────────────────────────────

describe('buildSplitPanel', () => {
  beforeEach(setup)

  it('creates rider group with 2 param inputs', () => {
    const panel = sidebar.getToolPanel('split')
    const params = panel.querySelectorAll('.tb-param')
    expect(params.length).toBeGreaterThanOrEqual(2)
  })

  it('power default 200, mass default 80', () => {
    const p = panels.split.getParams()
    expect(p.power).toBe(200)
    expect(p.mass).toBe(80)
  })

  it('has W/kg display showing 2.50', () => {
    expect(panels.split.els.wkgDisplay.textContent).toContain('2.50')
  })

  it('W/kg updates on input change', () => {
    panels.split.els.powerInput.value = '300'
    panels.split.els.powerInput.dispatchEvent(new Event('input'))
    expect(panels.split.els.wkgDisplay.textContent).toContain('3.75')
  })

  it('has group ride toggle', () => {
    expect(panels.split.els.groupToggle).toBeTruthy()
    expect(panels.split.getParams().groupRide).toBe(false)
  })

  it('Analyze button starts disabled', () => {
    expect(panels.split.els.btnAnalyze.disabled).toBe(true)
  })

  it('time summary starts hidden', () => {
    expect(panels.split.els.timeSummary.style.display).toBe('none')
  })

  it('split duration starts hidden', () => {
    expect(panels.split.els.splitDuration.style.display).toBe('none')
  })

  it('results section starts hidden', () => {
    expect(panels.split.els.splitResults.style.display).toBe('none')
  })

  it('has preset buttons (30, 45, 60, 90, 120 min)', () => {
    const btns = panels.split.els.presetsGrid.querySelectorAll('button')
    expect(btns.length).toBe(5)
    const texts = Array.from(btns).map(b => b.textContent)
    expect(texts).toContain('30 min')
    expect(texts).toContain('60 min')
    expect(texts).toContain('120 min')
  })

  it('showTimeSummary makes section visible', () => {
    panels.split.showTimeSummary('3h 45m')
    expect(panels.split.els.timeSummary.style.display).toBe('')
    expect(panels.split.els.summaryContent.textContent).toBe('3h 45m')
  })

  it('hideResults hides all result sections', () => {
    panels.split.showTimeSummary('test')
    panels.split.showSplitDuration('total')
    panels.split.showResults()
    panels.split.hideResults()
    expect(panels.split.els.timeSummary.style.display).toBe('none')
    expect(panels.split.els.splitDuration.style.display).toBe('none')
    expect(panels.split.els.splitResults.style.display).toBe('none')
  })
})
