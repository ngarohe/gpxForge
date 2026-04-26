/**
 * Unit tests for src/chart/shared.js
 *
 * Tests the pure-function helpers used by all chart canvases.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ST } from '../../src/state.js'
import {
  setupCv,
  niceStep, visibleRange, makeXp, makeYp,
  hitTestCorrection, buildColors, getSmoothColors, clearSmoothColors,
} from '../../src/chart/shared.js'

// ────────────────────────────────────────────────────────────────────
// setupCv — dimension caching
// ────────────────────────────────────────────────────────────────────

describe('setupCv', () => {
  function makeCanvas(w, h) {
    const cv = document.createElement('canvas')
    // jsdom doesn't compute offsetWidth/offsetHeight from CSS,
    // so we override them with Object.defineProperty
    Object.defineProperty(cv, 'offsetWidth', { get: () => w, configurable: true })
    Object.defineProperty(cv, 'offsetHeight', { get: () => h, configurable: true })
    // jsdom doesn't implement getContext without the canvas package,
    // so mock it with a minimal stub
    cv.getContext = () => ({ setTransform() {}, clearRect() {} })
    return cv
  }

  it('returns ctx, W, H', () => {
    const cv = makeCanvas(800, 200)
    const result = setupCv(cv)
    expect(result.ctx).toBeTruthy()
    expect(result.W).toBe(800)
    expect(result.H).toBe(200)
  })

  it('sets physical pixel dimensions on first call', () => {
    const cv = makeCanvas(400, 100)
    setupCv(cv)
    const dpr = devicePixelRatio || 1
    expect(cv.width).toBe(400 * dpr)
    expect(cv.height).toBe(100 * dpr)
  })

  it('does not re-set canvas dimensions on same-size call', () => {
    const cv = makeCanvas(400, 100)
    setupCv(cv) // first call — sets dimensions

    // Track whether width setter is called again
    let widthSet = false
    const origWidth = cv.width
    Object.defineProperty(cv, 'width', {
      get: () => origWidth,
      set: () => { widthSet = true },
      configurable: true,
    })

    setupCv(cv) // second call — same size, should skip
    expect(widthSet).toBe(false)
  })

  it('re-sets canvas dimensions when size changes', () => {
    let w = 400
    const cv = document.createElement('canvas')
    Object.defineProperty(cv, 'offsetWidth', { get: () => w, configurable: true })
    Object.defineProperty(cv, 'offsetHeight', { get: () => 100, configurable: true })
    cv.getContext = () => ({ setTransform() {}, clearRect() {} })

    setupCv(cv) // 400×100
    const dpr = devicePixelRatio || 1
    expect(cv.width).toBe(400 * dpr)

    w = 600
    setupCv(cv) // 600×100 — should resize
    expect(cv.width).toBe(600 * dpr)
  })
})

// ────────────────────────────────────────────────────────────────────
// niceStep
// ────────────────────────────────────────────────────────────────────

describe('niceStep', () => {
  it('returns 1 for rough=1', () => {
    expect(niceStep(1)).toBe(1)
  })

  it('returns 2 for rough=2.5', () => {
    expect(niceStep(2.5)).toBe(2)
  })

  it('returns 5 for rough=4', () => {
    expect(niceStep(4)).toBe(5)
  })

  it('returns 10 for rough=8', () => {
    expect(niceStep(8)).toBe(10)
  })

  it('returns 100 for rough=120', () => {
    expect(niceStep(120)).toBe(100)
  })

  it('returns 200 for rough=250', () => {
    expect(niceStep(250)).toBe(200)
  })

  it('returns 500 for rough=450', () => {
    expect(niceStep(450)).toBe(500)
  })

  it('returns 1000 for rough=800', () => {
    expect(niceStep(800)).toBe(1000)
  })

  it('handles very small values', () => {
    // 0.003 → mag=0.001, f=3 → 5*mag = 0.005
    expect(niceStep(0.003)).toBeCloseTo(0.005, 10)
  })

  it('returns 1 for zero', () => {
    expect(niceStep(0)).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────
// visibleRange
// ────────────────────────────────────────────────────────────────────

describe('visibleRange', () => {
  const dists = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]

  it('returns full range for full viewport', () => {
    const { iLo, iHi } = visibleRange(dists, 0, 1000)
    expect(iLo).toBe(0)
    expect(iHi).toBe(10)
  })

  it('finds correct range for middle section', () => {
    const { iLo, iHi } = visibleRange(dists, 300, 700)
    expect(iLo).toBeLessThanOrEqual(3) // index of 300m, possibly -1
    expect(iHi).toBeGreaterThanOrEqual(7) // index of 700m, possibly +1
  })

  it('handles start of route', () => {
    const { iLo } = visibleRange(dists, 0, 200)
    expect(iLo).toBe(0)
  })

  it('handles end of route', () => {
    const { iHi } = visibleRange(dists, 800, 1000)
    expect(iHi).toBe(10)
  })
})

// ────────────────────────────────────────────────────────────────────
// Coordinate transforms
// ────────────────────────────────────────────────────────────────────

describe('makeXp', () => {
  it('maps lo to padL', () => {
    const xp = makeXp(0, 1000, 500, 50)
    expect(xp(0)).toBe(50) // padL
  })

  it('maps hi to padL + cw', () => {
    const xp = makeXp(0, 1000, 500, 50)
    expect(xp(1000)).toBe(550) // padL + cw
  })

  it('maps midpoint correctly', () => {
    const xp = makeXp(0, 1000, 500, 50)
    expect(xp(500)).toBe(300) // padL + cw/2
  })
})

describe('makeYp', () => {
  it('maps minE to padT + ch (bottom)', () => {
    const yp = makeYp(100, 200, 300, 20)
    expect(yp(100)).toBe(320) // padT + ch
  })

  it('maps maxE to padT (top)', () => {
    const yp = makeYp(100, 200, 300, 20)
    expect(yp(300)).toBe(20) // padT
  })

  it('maps midpoint correctly', () => {
    const yp = makeYp(100, 200, 300, 20)
    expect(yp(200)).toBe(170) // padT + ch/2
  })
})

// ────────────────────────────────────────────────────────────────────
// hitTestCorrection
// ────────────────────────────────────────────────────────────────────

describe('hitTestCorrection', () => {
  beforeEach(() => {
    ST.dists = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    ST.corrections = [
      { alo: 2, ahi: 4 },  // 200–400m
      { alo: 7, ahi: 9 },  // 700–900m
    ]
  })

  it('finds exact containment', () => {
    expect(hitTestCorrection(300)).toBe(0)
    expect(hitTestCorrection(800)).toBe(1)
  })

  it('returns nearest center when outside all corrections', () => {
    const ci = hitTestCorrection(550)
    expect(ci).toBeGreaterThanOrEqual(0)
  })

  it('returns -1 for no corrections', () => {
    ST.corrections = []
    expect(hitTestCorrection(500)).toBe(-1)
  })

  it('returns -1 for null corrections', () => {
    ST.corrections = null
    expect(hitTestCorrection(500)).toBe(-1)
  })
})

// ────────────────────────────────────────────────────────────────────
// Gradient color cache
// ────────────────────────────────────────────────────────────────────

describe('gradient color cache', () => {
  beforeEach(() => {
    clearSmoothColors()
    ST.grOrig = null
  })

  it('buildColors creates cached colors', () => {
    buildColors([0, 5, 10, -5, -10])
    const colors = getSmoothColors()
    expect(colors).not.toBeNull()
    expect(colors.length).toBe(5)
    // Each color should be an rgb() string
    colors.forEach(c => expect(c).toMatch(/^rgb\(/))
  })

  it('clearSmoothColors clears the cache', () => {
    buildColors([0, 5])
    clearSmoothColors()
    // Without grOrig, should return null
    ST.grOrig = null
    expect(getSmoothColors()).toBeNull()
  })

  it('getSmoothColors falls back to grOrig', () => {
    ST.grOrig = [0, 10, 20]
    const colors = getSmoothColors()
    expect(colors).not.toBeNull()
    expect(colors.length).toBe(3)
  })
})
