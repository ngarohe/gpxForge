/**
 * Unit tests for src/ui/toolbar.js
 *
 * Tests button creation, disabled state, and keyboard shortcuts.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ST } from '../../src/state.js'

// ────────────────────────────────────────────────────────────────────
// Mock modules that toolbar.js imports
// ────────────────────────────────────────────────────────────────────

vi.mock('../../src/utils/gpx.js', () => ({
  serializeGPX: vi.fn(() => '<gpx></gpx>'),
  downloadGPX: vi.fn(),
}))

vi.mock('../../src/utils/download-name.js', () => ({
  buildDownloadFilename: vi.fn(({ fallbackBaseName, suffix }) =>
    Promise.resolve(`${fallbackBaseName}${suffix}.gpx`)
  ),
}))

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function resetState() {
  ST.gpx = null
  ST.eleClean = null
  ST.eleSmoothed = null
  ST.smoothedRoute = null
  ST.corrections = null
  ST.filename = ''
  ST.history = []
  ST.historyIdx = -1
  ST.activeStep = null
  ST.stepStatus = {}
}

function makeContainer() {
  const div = document.createElement('div')
  div.className = 'tb-actions'
  document.body.appendChild(div)
  return div
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('initToolbar', () => {
  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
  })

  it('creates undo, redo, and download buttons', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    initToolbar(container, { onUndo: vi.fn(), onRedo: vi.fn() })

    const buttons = container.querySelectorAll('button')
    // [undo, redo, lidar, createRoute, park, download]
    expect(buttons.length).toBe(6)
    expect(buttons[0].textContent).toContain('Undo')
    expect(buttons[1].textContent).toContain('Redo')
    expect(buttons[4].textContent).toContain('Park')
    expect(buttons[5].textContent).toContain('Download')
  })

  it('all buttons start disabled', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    initToolbar(container, { onUndo: vi.fn(), onRedo: vi.fn() })

    const buttons = container.querySelectorAll('button')
    expect(buttons[0].disabled).toBe(true) // undo
    expect(buttons[1].disabled).toBe(true) // redo
    expect(buttons[2].disabled).toBe(true) // download
  })

  it('updateButtons enables download when ST.gpx is set', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    const toolbar = initToolbar(container, { onUndo: vi.fn(), onRedo: vi.fn() })

    ST.gpx = { lats: [46], lons: [14], eles: [300] }
    toolbar.updateButtons()

    const dlBtn = container.querySelectorAll('button')[5]
    expect(dlBtn.disabled).toBe(false)
  })

  it('updateButtons enables undo when history available', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    const toolbar = initToolbar(container, { onUndo: vi.fn(), onRedo: vi.fn() })

    // Simulate 2 history entries, at index 1 (undo available)
    ST.gpx = { lats: [46], lons: [14], eles: [300] }
    ST.history = [{}, {}]
    ST.historyIdx = 1
    toolbar.updateButtons()

    const undoBtn = container.querySelectorAll('button')[0]
    expect(undoBtn.disabled).toBe(false)
  })

  it('clicking undo button calls onUndo', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    const onUndo = vi.fn()
    initToolbar(container, { onUndo, onRedo: vi.fn() })

    // Enable button first — disabled buttons don't fire click events
    const undoBtn = container.querySelectorAll('button')[0]
    undoBtn.disabled = false
    undoBtn.click()
    expect(onUndo).toHaveBeenCalledTimes(1)
  })

  it('clicking redo button calls onRedo', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    const onRedo = vi.fn()
    initToolbar(container, { onUndo: vi.fn(), onRedo })

    // Enable button first — disabled buttons don't fire click events
    const redoBtn = container.querySelectorAll('button')[1]
    redoBtn.disabled = false
    redoBtn.click()
    expect(onRedo).toHaveBeenCalledTimes(1)
  })

  it('fires onDownloaded callback after successful download', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const { downloadGPX } = await import('../../src/utils/gpx.js')
    const container = makeContainer()
    const onDownloaded = vi.fn()
    initToolbar(container, { onUndo: vi.fn(), onRedo: vi.fn(), onDownloaded })

    ST.gpx = { lats: [46], lons: [14], eles: [300] }
    ST.eleClean = [310]
    ST.filename = 'test.gpx'
    ST.activeStep = 'clean'

    const dlBtn = container.querySelectorAll('button')[5]
    dlBtn.disabled = false
    dlBtn.click()

    await vi.waitFor(() => expect(downloadGPX).toHaveBeenCalled())
    await vi.waitFor(() => expect(onDownloaded).toHaveBeenCalled())
    expect(onDownloaded).toHaveBeenCalledWith(expect.stringContaining('.gpx'))
  })

  it('download uses adaptive elevation based on activeStep', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const { serializeGPX, downloadGPX } = await import('../../src/utils/gpx.js')
    const container = makeContainer()
    initToolbar(container, { onUndo: vi.fn(), onRedo: vi.fn() })

    ST.gpx = { lats: [46], lons: [14], eles: [300] }
    ST.eleClean = [310]
    ST.eleSmoothed = [305]
    ST.smoothedRoute = { lats: [46.1], lons: [14.1], eles: [305], dists: new Float64Array([0]), gr: new Float64Array([0]) }
    ST.filename = 'test.gpx'
    ST.activeStep = 'smooth'

    // Click download
    const dlBtn = container.querySelectorAll('button')[5]
    dlBtn.disabled = false
    dlBtn.click()

    // doDownload is async — wait for downloadGPX to be called
    await vi.waitFor(() => expect(downloadGPX).toHaveBeenCalled())

    // Should use eleSmoothed + smoothedRoute coords for smooth step
    expect(serializeGPX).toHaveBeenCalledWith(ST.gpx, [305], [46.1], [14.1])
    expect(downloadGPX).toHaveBeenCalledWith(
      expect.any(String),
      'test_smoothed.gpx'
    )
  })
})

describe('keyboard shortcuts', () => {
  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
  })

  it('Ctrl+Z calls onUndo', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    const onUndo = vi.fn()
    initToolbar(container, { onUndo, onRedo: vi.fn() })

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true,
    }))
    expect(onUndo).toHaveBeenCalled()
  })

  it('Ctrl+Y calls onRedo', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    const onRedo = vi.fn()
    initToolbar(container, { onUndo: vi.fn(), onRedo })

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'y', ctrlKey: true, bubbles: true,
    }))
    expect(onRedo).toHaveBeenCalled()
  })

  it('Ctrl+Shift+Z calls onRedo', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    const onRedo = vi.fn()
    initToolbar(container, { onUndo: vi.fn(), onRedo })

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, shiftKey: true, bubbles: true,
    }))
    expect(onRedo).toHaveBeenCalled()
  })

  it('skips shortcuts when target is INPUT', async () => {
    const { initToolbar } = await import('../../src/ui/toolbar.js')
    const container = makeContainer()
    const onUndo = vi.fn()
    initToolbar(container, { onUndo, onRedo: vi.fn() })

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true,
    }))
    expect(onUndo).not.toHaveBeenCalled()
  })
})
