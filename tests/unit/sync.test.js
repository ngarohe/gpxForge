/**
 * Unit tests for src/sync.js
 *
 * Tests viewport zoom/pan, cursor pub/sub, and view range conversion.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ST } from '../../src/state.js'
import {
  subscribe, zoom, pan, setView, resetView,
  getViewRange, clampView, setCursor, clearCursor, getCursor,
  MIN_ZOOM_FRAC,
} from '../../src/sync.js'

// Helper: reset ST viewport/cursor state + set up mock dists
function resetState(totalDist = 10000) {
  ST.viewStart = 0
  ST.viewEnd = 1
  ST.hoverIdx = null
  ST.hoverDistM = null
  // Create uniform distance array
  const N = 100
  ST.dists = new Float64Array(N)
  for (let i = 0; i < N; i++) ST.dists[i] = i * totalDist / (N - 1)
}

// ────────────────────────────────────────────────────────────────────
// Viewport
// ────────────────────────────────────────────────────────────────────

describe('getViewRange', () => {
  beforeEach(() => resetState(10000))

  it('returns full range when viewport is 0–1', () => {
    const { lo, hi, total } = getViewRange()
    expect(lo).toBe(0)
    expect(hi).toBe(10000)
    expect(total).toBe(10000)
  })

  it('returns partial range for zoomed viewport', () => {
    ST.viewStart = 0.25
    ST.viewEnd = 0.75
    const { lo, hi } = getViewRange()
    expect(lo).toBeCloseTo(2500, 0)
    expect(hi).toBeCloseTo(7500, 0)
  })

  it('returns zeros when no dists', () => {
    ST.dists = null
    const { lo, hi, total } = getViewRange()
    expect(lo).toBe(0)
    expect(hi).toBe(0)
    expect(total).toBe(0)
  })
})

describe('clampView', () => {
  beforeEach(() => resetState())

  it('clamps viewStart below 0', () => {
    ST.viewStart = -0.1
    ST.viewEnd = 0.5
    clampView()
    expect(ST.viewStart).toBe(0)
    expect(ST.viewEnd).toBeCloseTo(0.6, 10)
  })

  it('clamps viewEnd above 1', () => {
    ST.viewStart = 0.7
    ST.viewEnd = 1.2
    clampView()
    expect(ST.viewEnd).toBe(1)
    expect(ST.viewStart).toBeCloseTo(0.5, 10)
  })

  it('leaves valid range untouched', () => {
    ST.viewStart = 0.2
    ST.viewEnd = 0.8
    clampView()
    expect(ST.viewStart).toBe(0.2)
    expect(ST.viewEnd).toBe(0.8)
  })
})

describe('zoom', () => {
  beforeEach(() => resetState())

  it('zooms in (factor < 1) around cursor', () => {
    zoom(0.5, 0.5) // cursor at center, halve the span
    expect(ST.viewEnd - ST.viewStart).toBeCloseTo(0.5, 5)
    // Cursor should stay near center
    const center = (ST.viewStart + ST.viewEnd) / 2
    expect(center).toBeCloseTo(0.5, 1)
  })

  it('zooms out (factor > 1)', () => {
    ST.viewStart = 0.25
    ST.viewEnd = 0.75
    zoom(0.5, 2.0) // double the span
    expect(ST.viewEnd - ST.viewStart).toBe(1) // clamped to 1
  })

  it('respects MIN_ZOOM_FRAC', () => {
    // Zoom in extremely
    for (let i = 0; i < 50; i++) zoom(0.5, 0.5)
    expect(ST.viewEnd - ST.viewStart).toBeGreaterThanOrEqual(MIN_ZOOM_FRAC)
  })

  it('notifies viewport subscribers', () => {
    let called = 0
    const unsub = subscribe('viewport', () => called++)
    zoom(0.5, 0.8)
    expect(called).toBe(1)
    unsub()
  })
})

describe('pan', () => {
  beforeEach(() => resetState())

  it('pans right', () => {
    ST.viewStart = 0.2
    ST.viewEnd = 0.5
    pan(0.1)
    expect(ST.viewStart).toBeCloseTo(0.3, 10)
    expect(ST.viewEnd).toBeCloseTo(0.6, 10)
  })

  it('clamps at right edge', () => {
    ST.viewStart = 0.7
    ST.viewEnd = 1.0
    pan(0.5)
    expect(ST.viewEnd).toBe(1)
    expect(ST.viewStart).toBeCloseTo(0.7, 10)
  })

  it('notifies subscribers', () => {
    let called = 0
    const unsub = subscribe('viewport', () => called++)
    pan(0.1)
    expect(called).toBe(1)
    unsub()
  })
})

describe('setView', () => {
  beforeEach(() => resetState())

  it('sets viewport directly', () => {
    setView(0.1, 0.9)
    expect(ST.viewStart).toBe(0.1)
    expect(ST.viewEnd).toBe(0.9)
  })

  it('clamps to valid range', () => {
    setView(-0.5, 1.5)
    expect(ST.viewStart).toBeGreaterThanOrEqual(0)
    expect(ST.viewEnd).toBeLessThanOrEqual(1)
  })

  it('enforces minimum span', () => {
    setView(0.5, 0.5)
    expect(ST.viewEnd - ST.viewStart).toBeGreaterThanOrEqual(MIN_ZOOM_FRAC)
  })
})

describe('resetView', () => {
  beforeEach(() => resetState())

  it('resets to 0–1', () => {
    ST.viewStart = 0.3
    ST.viewEnd = 0.7
    resetView()
    expect(ST.viewStart).toBe(0)
    expect(ST.viewEnd).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────
// Cursor
// ────────────────────────────────────────────────────────────────────

describe('cursor sync', () => {
  beforeEach(() => resetState())

  it('setCursor stores idx and distM', () => {
    setCursor(42, 4200)
    expect(ST.hoverIdx).toBe(42)
    expect(ST.hoverDistM).toBe(4200)
  })

  it('getCursor returns position', () => {
    setCursor(10, 1000)
    const c = getCursor()
    expect(c).toEqual({ idx: 10, distM: 1000 })
  })

  it('clearCursor clears position', () => {
    setCursor(10, 1000)
    clearCursor()
    expect(getCursor()).toBeNull()
    expect(ST.hoverIdx).toBeNull()
  })

  it('setCursor notifies subscribers', () => {
    let called = 0
    const unsub = subscribe('cursor', () => called++)
    setCursor(5, 500)
    expect(called).toBe(1)
    unsub()
  })

  it('clearCursor notifies subscribers', () => {
    let called = 0
    const unsub = subscribe('cursor', () => called++)
    clearCursor()
    expect(called).toBe(1)
    unsub()
  })

  it('multiple subscribers all called', () => {
    let a = 0, b = 0
    const unsub1 = subscribe('cursor', () => a++)
    const unsub2 = subscribe('cursor', () => b++)
    setCursor(1, 100)
    expect(a).toBe(1)
    expect(b).toBe(1)
    unsub1()
    unsub2()
  })
})
