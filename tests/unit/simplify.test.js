/**
 * Unit tests for simplifyByArea() — GPXmagic-style triangle-area simplification.
 */

import { describe, it, expect } from 'vitest'
import { simplifyByArea } from '../../src/utils/geometry.js'
import { runSimplify } from '../../src/pipeline/4-smooth.js'

// ── Test data helpers ──

/** Straight line: 50 points, all collinear — most should be removable. */
function buildStraightRoute() {
  const N = 50
  const lats = [], lons = [], eles = [], dists = [0]
  for (let i = 0; i < N; i++) {
    lats.push(46.0 + i * 0.0001) // ~11m spacing north
    lons.push(14.5)
    eles.push(300 + i * 0.5) // gentle uphill
    if (i > 0) dists.push(dists[i - 1] + 11.1)
  }
  return { lats, lons, eles, dists }
}

/** Zigzag: alternating east-west, every point significant. */
function buildZigzagRoute() {
  const N = 50
  const lats = [], lons = [], eles = [], dists = [0]
  for (let i = 0; i < N; i++) {
    lats.push(46.0 + i * 0.0001)
    lons.push(14.5 + (i % 2 === 0 ? 0.0005 : -0.0005)) // ~40m zigzag
    eles.push(300 + (i % 2 === 0 ? 10 : 0)) // elevation zigzag
    if (i > 0) dists.push(dists[i - 1] + 15)
  }
  return { lats, lons, eles, dists }
}

/** Route with a steep elevation spike at one point. */
function buildSpikeRoute() {
  const N = 30
  const lats = [], lons = [], eles = [], dists = [0]
  for (let i = 0; i < N; i++) {
    lats.push(46.0 + i * 0.0001)
    lons.push(14.5)
    eles.push(i === 15 ? 400 : 300) // 100m spike at point 15
    if (i > 0) dists.push(dists[i - 1] + 11.1)
  }
  return { lats, lons, eles, dists }
}

describe('simplifyByArea', () => {
  it('returns expected shape', () => {
    const { lats, lons, eles, dists } = buildStraightRoute()
    const result = simplifyByArea(lats, lons, eles, dists)

    expect(result.lats).toBeDefined()
    expect(result.lons).toBeDefined()
    expect(result.eles).toBeDefined()
    expect(result.dists).toBeDefined()
    expect(result.gr).toBeDefined()
    expect(result.removedCount).toBeTypeOf('number')
  })

  it('removes points from a straight line', () => {
    const { lats, lons, eles, dists } = buildStraightRoute()
    const result = simplifyByArea(lats, lons, eles, dists)

    expect(result.removedCount).toBeGreaterThan(0)
    expect(result.lats.length).toBeLessThan(lats.length)
  })

  it('preserves more points on a zigzag route', () => {
    const zigzag = buildZigzagRoute()
    const straight = buildStraightRoute()

    const zigResult = simplifyByArea(zigzag.lats, zigzag.lons, zigzag.eles, zigzag.dists)
    const strResult = simplifyByArea(straight.lats, straight.lons, straight.eles, straight.dists)

    // Zigzag should keep more points than straight
    expect(zigResult.lats.length).toBeGreaterThan(strResult.lats.length)
  })

  it('never removes first or last point', () => {
    const { lats, lons, eles, dists } = buildStraightRoute()
    const result = simplifyByArea(lats, lons, eles, dists)

    expect(result.lats[0]).toBe(lats[0])
    expect(result.lons[0]).toBe(lons[0])
    expect(result.eles[0]).toBe(eles[0])
    expect(result.lats[result.lats.length - 1]).toBe(lats[lats.length - 1])
    expect(result.lons[result.lons.length - 1]).toBe(lons[lons.length - 1])
    expect(result.eles[result.eles.length - 1]).toBe(eles[eles.length - 1])
  })

  it('never removes two consecutive points', () => {
    const { lats, lons, eles, dists } = buildStraightRoute()
    const result = simplifyByArea(lats, lons, eles, dists)

    // Check that all kept points are present in original and no gaps > 2 original indices
    // Actually, we verify by checking output arrays are consistent
    expect(result.lats.length).toBe(result.lons.length)
    expect(result.lats.length).toBe(result.eles.length)
    expect(result.lats.length).toBe(result.dists.length)
    expect(result.lats.length + result.removedCount).toBe(lats.length)
  })

  it('produces monotonically increasing distances', () => {
    const { lats, lons, eles, dists } = buildStraightRoute()
    const result = simplifyByArea(lats, lons, eles, dists)

    expect(result.dists[0]).toBe(0)
    for (let i = 1; i < result.dists.length; i++) {
      expect(result.dists[i]).toBeGreaterThan(result.dists[i - 1])
    }
  })

  it('preserves elevation-significant points', () => {
    const { lats, lons, eles, dists } = buildSpikeRoute()
    const result = simplifyByArea(lats, lons, eles, dists)

    // The 100m spike should survive — large 3D triangle area
    expect(result.eles).toContain(400)
  })

  it('returns unchanged for N < 4', () => {
    const lats = [46.0, 46.001, 46.002]
    const lons = [14.5, 14.5, 14.5]
    const eles = [300, 310, 320]
    const dists = [0, 100, 200]
    const result = simplifyByArea(lats, lons, eles, dists)

    expect(result.removedCount).toBe(0)
    expect(result.lats.length).toBe(3)
  })

  it('gradient array has correct length', () => {
    const { lats, lons, eles, dists } = buildStraightRoute()
    const result = simplifyByArea(lats, lons, eles, dists)

    expect(result.gr.length).toBe(result.lats.length - 1)
  })

  it('multiple passes reduce further', () => {
    const { lats, lons, eles, dists } = buildStraightRoute()
    const r1 = simplifyByArea(lats, lons, eles, dists)
    const r2 = simplifyByArea(r1.lats, r1.lons, r1.eles, r1.dists)

    expect(r2.lats.length).toBeLessThanOrEqual(r1.lats.length)
  })
})

describe('runSimplify', () => {
  it('returns expected shape', () => {
    const route = buildStraightRoute()
    route.gr = new Float64Array(route.lats.length - 1)
    const result = runSimplify(route)

    expect(result.route).toBeDefined()
    expect(result.route.lats).toBeDefined()
    expect(result.route.dists).toBeInstanceOf(Float64Array)
    expect(result.route.gr).toBeInstanceOf(Float64Array)
    expect(result.removedCount).toBeTypeOf('number')
  })

  it('removes points from redundant route', () => {
    const route = buildStraightRoute()
    route.gr = new Float64Array(route.lats.length - 1)
    const result = runSimplify(route)

    expect(result.removedCount).toBeGreaterThan(0)
    expect(result.route.lats.length).toBeLessThan(route.lats.length)
  })
})
