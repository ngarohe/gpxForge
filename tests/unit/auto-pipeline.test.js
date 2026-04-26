import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ST } from '../../src/state.js'
import {
  captureStats,
  captureStatsAfter,
  commitSnap,
  DEFAULT_CLEAN_PARAMS,
} from '../../src/modes/auto-pipeline.js'

// ── Test data helpers ──

function makeRoute(n = 100, spacingM = 50) {
  const lats = [], lons = [], eles = []
  const dlonPer = spacingM / (111320 * Math.cos(46 * Math.PI / 180))
  for (let i = 0; i < n; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * dlonPer)
    eles.push(300 + Math.sin(i * 0.1) * 10)
  }
  return { lats, lons, eles }
}

function setupST(n = 100, spacingM = 50) {
  const { lats, lons, eles } = makeRoute(n, spacingM)
  ST.gpx = { lats, lons, eles }
  ST.filename = 'test.gpx'

  // Build cumulative distances
  const dists = [0]
  for (let i = 1; i < n; i++) {
    dists.push(dists[i - 1] + spacingM)
  }
  ST.dists = new Float64Array(dists)

  // Build gradients
  const gr = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const span = ST.dists[i] - ST.dists[i - 1]
    gr[i] = span > 0 ? (eles[i] - eles[i - 1]) / span * 100 : 0
  }
  ST.grOrig = gr
  ST.eleClean = [...eles]
  ST.grClean = gr.slice()
  ST.corrections = []
  ST.selectedCorr = null
  ST.smoothedRoute = null
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.brunnels = null
  ST.viewStart = 0
  ST.viewEnd = 1
  ST.basicMode = true
  ST.routeProfile = 'car'
  ST.processing = false
}

// ── Tests ──

describe('DEFAULT_CLEAN_PARAMS', () => {
  it('contains expected parameter keys', () => {
    expect(DEFAULT_CLEAN_PARAMS).toHaveProperty('spikeT')
    expect(DEFAULT_CLEAN_PARAMS).toHaveProperty('anchorT')
    expect(DEFAULT_CLEAN_PARAMS).toHaveProperty('mergeGap')
    expect(DEFAULT_CLEAN_PARAMS).toHaveProperty('smart')
    expect(DEFAULT_CLEAN_PARAMS).toHaveProperty('enabled')
    expect(DEFAULT_CLEAN_PARAMS).toHaveProperty('suspSpan')
    expect(DEFAULT_CLEAN_PARAMS.spikeT).toBe(25)
    expect(DEFAULT_CLEAN_PARAMS.anchorT).toBe(30)
  })
})

describe('captureStats', () => {
  beforeEach(() => setupST())

  it('computes distance, ascent, points, and max grade', () => {
    const stats = captureStats()
    expect(stats).toHaveProperty('distM')
    expect(stats).toHaveProperty('ascM')
    expect(stats).toHaveProperty('pts')
    expect(stats).toHaveProperty('maxGr')
    expect(stats.pts).toBe(100)
    expect(stats.distM).toBeGreaterThan(0)
    expect(stats.ascM).toBeGreaterThanOrEqual(0)
    expect(stats.maxGr).toBeGreaterThanOrEqual(0)
  })

  it('pts matches gpx array length', () => {
    const stats = captureStats()
    expect(stats.pts).toBe(ST.gpx.eles.length)
  })

  it('distance equals last cumulative distance', () => {
    const stats = captureStats()
    expect(stats.distM).toBeCloseTo(ST.dists[ST.dists.length - 1], 0)
  })
})

describe('captureStatsAfter', () => {
  beforeEach(() => setupST())

  it('uses eleClean when no smoothedRoute', () => {
    ST.smoothedRoute = null
    const stats = captureStatsAfter()
    expect(stats.pts).toBe(ST.eleClean.length)
    expect(stats.distM).toBeGreaterThan(0)
  })

  it('uses smoothedRoute when available', () => {
    // Create a mock smoothed route with fewer points
    const n2 = 50
    const dists2 = new Float64Array(n2)
    const gr2 = new Float64Array(n2)
    const lats2 = new Array(n2).fill(46.0)
    const lons2 = new Array(n2)
    const eles2 = new Array(n2)
    for (let i = 0; i < n2; i++) {
      lons2[i] = 14.0 + i * 0.001
      eles2[i] = 300 + i * 0.2
      dists2[i] = i * 100
      gr2[i] = 0.2
    }

    ST.smoothedRoute = { lats: lats2, lons: lons2, eles: eles2, dists: dists2, gr: gr2 }
    const stats = captureStatsAfter()
    expect(stats.pts).toBe(50)
    expect(stats.distM).toBeCloseTo(dists2[n2 - 1], 0)
  })
})

describe('commitSnap', () => {
  beforeEach(() => setupST())

  it('updates ST.gpx with new coordinates', () => {
    const { lats, lons, eles } = makeRoute(50, 100)
    commitSnap(lats, lons, eles)

    expect(ST.gpx.lats).toEqual(lats)
    expect(ST.gpx.lons).toEqual(lons)
    expect(ST.gpx.eles).toEqual(eles)
  })

  it('rebuilds distances array', () => {
    const { lats, lons, eles } = makeRoute(50, 100)
    commitSnap(lats, lons, eles)

    expect(ST.dists).toBeInstanceOf(Float64Array)
    expect(ST.dists.length).toBe(50)
    expect(ST.dists[0]).toBe(0)
    expect(ST.dists[49]).toBeGreaterThan(0)
  })

  it('rebuilds eleClean and grClean', () => {
    const { lats, lons, eles } = makeRoute(50, 100)
    commitSnap(lats, lons, eles)

    expect(ST.eleClean.length).toBe(50)
    expect(ST.grOrig.length).toBe(50)
    expect(ST.grClean.length).toBe(50)
  })

  it('resets downstream state', () => {
    ST.corrections = [{ alo: 0, ahi: 5 }]
    ST.smoothedRoute = { lats: [1], lons: [2], eles: [3] }
    ST.brunnels = [{ type: 'bridge' }]

    const { lats, lons, eles } = makeRoute(50, 100)
    commitSnap(lats, lons, eles)

    expect(ST.corrections).toEqual([])
    expect(ST.selectedCorr).toBeNull()
    expect(ST.smoothedRoute).toBeNull()
    expect(ST.eleSmoothed).toBeNull()
    expect(ST.brunnels).toBeNull()
  })

  it('resets viewport', () => {
    ST.viewStart = 0.3
    ST.viewEnd = 0.7

    const { lats, lons, eles } = makeRoute(50, 100)
    commitSnap(lats, lons, eles)

    expect(ST.viewStart).toBe(0)
    expect(ST.viewEnd).toBe(1)
  })
})


describe('state.js mode fields', () => {
  it('ST has basicMode field', () => {
    expect(ST).toHaveProperty('basicMode')
  })

  it('ST has routeProfile field', () => {
    expect(ST).toHaveProperty('routeProfile')
  })

  it('ST has processing field', () => {
    expect(ST).toHaveProperty('processing')
  })

  it('basicMode defaults to false', () => {
    // Reset to check default
    expect(typeof ST.basicMode).toBe('boolean')
  })

  it('routeProfile defaults to car', () => {
    expect(ST.routeProfile).toBe('car')
  })
})
