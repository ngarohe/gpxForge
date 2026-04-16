/**
 * Unit tests for src/ui/shell.js
 *
 * Tests DOM construction, file loading flow, stats display,
 * panel focus rotation, and drag-and-drop.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ST } from '../../src/state.js'

// ────────────────────────────────────────────────────────────────────
// Mock modules that shell.js imports
// ────────────────────────────────────────────────────────────────────

vi.mock('../../src/utils/gpx.js', () => ({
  parseGPX: vi.fn(() => ({
    lats: [46.0, 46.01, 46.02],
    lons: [14.5, 14.5, 14.5],
    eles: [300, 310, 305],
    dists: [0, 1000, 2000],
    doc: null,
    ns: '',
    pts: [],
    rawXml: '<gpx></gpx>',
  })),
}))

vi.mock('../../src/chart/index.js', () => ({
  buildColors: vi.fn(),
  initChart: vi.fn(),
  drawAll: vi.fn(),
}))

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function resetState() {
  ST.gpx = null
  ST.dists = null
  ST.grOrig = null
  ST.eleClean = null
  ST.grClean = null
  ST.corrections = null
  ST.filename = ''
  ST.history = []
  ST.historyIdx = -1
  ST.selectedCorr = null
  ST.smoothedRoute = null
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.activeStep = null
  ST.stepStatus = {}
}

function setupApp() {
  document.body.innerHTML = '<div id="app"></div>'
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('initShell', () => {
  beforeEach(() => {
    resetState()
    setupApp()
  })

  it('builds expected DOM structure inside #app', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    const app = document.getElementById('app')
    expect(app.classList.contains('app')).toBe(true)

    // Topbar exists
    const topbar = app.querySelector('.topbar')
    expect(topbar).toBeTruthy()

    // Brand exists
    expect(topbar.querySelector('.tb-brand')).toBeTruthy()
    expect(topbar.querySelector('.tb-brand-name').textContent).toBe('GPXForge')

    // Drop zone exists
    expect(topbar.querySelector('.tb-drop')).toBeTruthy()
    expect(topbar.querySelector('#fileIn')).toBeTruthy()

    // Stats strip exists (hidden)
    const stats = topbar.querySelector('.tb-stats')
    expect(stats).toBeTruthy()
    expect(stats.classList.contains('visible')).toBe(false)

    // Actions container
    expect(topbar.querySelector('.tb-actions')).toBeTruthy()

    // Content area — CSS grid container
    const content = app.querySelector('.content')
    expect(content).toBeTruthy()

    // Empty state visible
    expect(content.querySelector('.empty-state')).toBeTruthy()

    // Chart panel is direct child of .content
    const chartPanel = content.querySelector('.chart-panel')
    expect(chartPanel).toBeTruthy()
    expect(chartPanel.parentElement).toBe(content)

    // Chart canvases exist
    expect(chartPanel.querySelector('#cvMain')).toBeTruthy()
    expect(chartPanel.querySelector('#cvGrad')).toBeTruthy()

    // Chart panel has promote button
    expect(chartPanel.querySelector('.panel-promote')).toBeTruthy()

    // Map panel is direct child of .content
    const mapPanel = content.querySelector('.map-panel')
    expect(mapPanel).toBeTruthy()
    expect(mapPanel.parentElement).toBe(content)

    // Map panel has promote button
    expect(mapPanel.querySelector('.panel-promote')).toBeTruthy()

    // No data-focus before file load (panels hidden)
    expect(content.dataset.focus).toBeUndefined()

    // Drag overlay
    expect(app.querySelector('.drag-overlay')).toBeTruthy()
  })

  it('returns expected API methods', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    expect(typeof shell.showViews).toBe('function')
    expect(typeof shell.updateStats).toBe('function')
    expect(typeof shell.getChartEls).toBe('function')
    expect(typeof shell.getMapEl).toBe('function')
    expect(typeof shell.getActionsEl).toBe('function')
    expect(typeof shell.getStepToolbarEl).toBe('function')
    expect(typeof shell.showStepToolbar).toBe('function')
  })

  it('showViews hides empty state and sets data-focus to chart', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    shell.showViews()

    const app = document.getElementById('app')
    expect(app.querySelector('.empty-state').style.display).toBe('none')
    expect(app.querySelector('.content').dataset.focus).toBe('chart')
  })

  it('showViews preserves existing focus', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    // Set focus to map first
    const content = document.querySelector('.content')
    content.dataset.focus = 'map'

    // showViews should not override
    shell.showViews()
    expect(content.dataset.focus).toBe('map')
  })

  it('getChartEls returns canvas elements with cvMini null', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())
    const els = shell.getChartEls()

    expect(els.cvMain).toBeTruthy()
    expect(els.cvMain.tagName).toBe('CANVAS')
    expect(els.cvGrad).toBeTruthy()
    expect(els.cvGrad.tagName).toBe('CANVAS')
    expect(els.cvMini).toBeNull()
  })

  it('getMapEl returns map container', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    expect(shell.getMapEl()).toBeTruthy()
    expect(shell.getMapEl().id).toBe('mapPanel')
  })

  it('getActionsEl returns toolbar container', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    expect(shell.getActionsEl()).toBeTruthy()
    expect(shell.getActionsEl().classList.contains('tb-actions')).toBe(true)
  })

  it('has step-toolbar and content as direct children of .app', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    initShell(vi.fn())

    const app = document.getElementById('app')
    const toolbar = app.querySelector('.step-toolbar')
    expect(toolbar).toBeTruthy()
    expect(toolbar.parentElement).toBe(app)
    const content = app.querySelector('.content')
    expect(content.parentElement).toBe(app)
  })

  it('getStepToolbarEl returns step-toolbar container', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    const toolbar = shell.getStepToolbarEl()
    expect(toolbar).toBeTruthy()
    expect(toolbar.classList.contains('step-toolbar')).toBe(true)
  })

  it('showStepToolbar adds visible class', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    const toolbar = shell.getStepToolbarEl()
    expect(toolbar.classList.contains('visible')).toBe(false)
    shell.showStepToolbar()
    expect(toolbar.classList.contains('visible')).toBe(true)
  })
})

describe('panel focus rotation', () => {
  beforeEach(() => {
    resetState()
    setupApp()
  })

  it('clicking map promote button sets focus to map', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    initShell(vi.fn())

    const app = document.getElementById('app')
    const content = app.querySelector('.content')
    content.dataset.focus = 'chart' // start with chart focused

    // Click map's promote button
    const mapPromote = app.querySelector('.map-panel .panel-promote')
    mapPromote.click()

    expect(content.dataset.focus).toBe('map')
  })

  it('clicking chart promote button sets focus to chart', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    initShell(vi.fn())

    const app = document.getElementById('app')
    const content = app.querySelector('.content')
    content.dataset.focus = 'map' // start with map focused

    // Click chart's promote button
    const chartPromote = app.querySelector('.chart-panel .panel-promote')
    chartPromote.click()

    expect(content.dataset.focus).toBe('chart')
  })
})

describe('updateStats', () => {
  beforeEach(() => {
    resetState()
    setupApp()
  })

  it('populates stat values from ST', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    // Set up state as if a file was loaded
    ST.gpx = {
      lats: [46.0, 46.01, 46.02, 46.03],
      lons: [14.5, 14.5, 14.5, 14.5],
      eles: [300, 350, 320, 400],
    }
    ST.dists = [0, 5000, 10000, 15000]
    ST.eleClean = [300, 340, 315, 390]
    ST.grClean = [0, 0.8, -0.5, 1.5]

    shell.updateStats()

    const app = document.getElementById('app')
    // Stats should be visible
    expect(app.querySelector('.tb-stats').classList.contains('visible')).toBe(true)

    // Distance
    expect(app.querySelector('#sDist').textContent).toBe('15.0 km')

    // Points
    expect(app.querySelector('#sPts').textContent).toContain('4')
  })

  it('no-ops when ST.gpx is null', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    // Should not throw
    shell.updateStats()

    const app = document.getElementById('app')
    expect(app.querySelector('.tb-stats').classList.contains('visible')).toBe(false)
  })
})

describe('info panel', () => {
  beforeEach(() => {
    resetState()
    setupApp()
  })

  it('info panel exists in DOM', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    initShell(vi.fn())

    const content = document.querySelector('.content')
    const infoPanel = content.querySelector('.info-panel')
    expect(infoPanel).toBeTruthy()
    expect(infoPanel.id).toBe('infoPanel')
    expect(infoPanel.parentElement).toBe(content)
  })

  it('has per-step content containers for all 6 steps', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    initShell(vi.fn())

    const infoPanel = document.querySelector('.info-panel')
    for (const id of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split']) {
      const content = infoPanel.querySelector(`.info-content[data-step="${id}"]`)
      expect(content).toBeTruthy()
    }
  })

  it('getInfoPanel returns container for valid step', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    const clean = shell.getInfoPanel('clean')
    expect(clean).toBeTruthy()
    expect(clean.dataset.step).toBe('clean')

    const split = shell.getInfoPanel('split')
    expect(split).toBeTruthy()
    expect(split.dataset.step).toBe('split')
  })

  it('getInfoPanel returns container for all 6 steps', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    for (const id of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split']) {
      const panel = shell.getInfoPanel(id)
      expect(panel).toBeTruthy()
      expect(panel.dataset.step).toBe(id)
    }
  })

  it('setInfoStep sets data-info for clean/split steps', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    const content = document.querySelector('.content')

    shell.setInfoStep('clean')
    expect('info' in content.dataset).toBe(true)

    shell.setInfoStep('split')
    expect('info' in content.dataset).toBe(true)
  })

  it('setInfoStep sets data-info for all valid steps', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    const content = document.querySelector('.content')

    for (const id of ['trim', 'snap', 'brunnels', 'clean', 'smooth', 'split']) {
      shell.setInfoStep(id)
      expect('info' in content.dataset).toBe(true)
    }

    // Invalid step removes data-info
    shell.setInfoStep('unknown')
    expect('info' in content.dataset).toBe(false)
  })

  it('setInfoStep shows correct content container', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    shell.setInfoStep('clean')
    expect(shell.getInfoPanel('clean').style.display).toBe('')
    expect(shell.getInfoPanel('split').style.display).toBe('none')
    expect(shell.getInfoPanel('trim').style.display).toBe('none')

    shell.setInfoStep('trim')
    expect(shell.getInfoPanel('trim').style.display).toBe('')
    expect(shell.getInfoPanel('clean').style.display).toBe('none')
    expect(shell.getInfoPanel('split').style.display).toBe('none')

    shell.setInfoStep('smooth')
    expect(shell.getInfoPanel('smooth').style.display).toBe('')
    expect(shell.getInfoPanel('clean').style.display).toBe('none')
  })

  it('returns getInfoPanel and setInfoStep in API', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    const shell = initShell(vi.fn())

    expect(typeof shell.getInfoPanel).toBe('function')
    expect(typeof shell.setInfoStep).toBe('function')
  })
})

describe('drag-and-drop', () => {
  beforeEach(() => {
    resetState()
    setupApp()
  })

  it('drag overlay element exists in DOM', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    initShell(vi.fn())

    const app = document.getElementById('app')
    const overlay = app.querySelector('.drag-overlay')
    expect(overlay).toBeTruthy()
    expect(overlay.querySelector('.drag-overlay-text')).toBeTruthy()
  })

  it('drag overlay starts without active class', async () => {
    const { initShell } = await import('../../src/ui/shell.js')
    initShell(vi.fn())

    const app = document.getElementById('app')
    const overlay = app.querySelector('.drag-overlay')
    expect(overlay.classList.contains('active')).toBe(false)
  })
})
