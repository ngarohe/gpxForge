/**
 * Self-validation tests for the synthetic fillet test route.
 *
 * Verifies that the generated route has correct geometry:
 * proper turn angles, spacing, elevation range, and bounding box.
 */

import { describe, it, expect } from 'vitest'
import { buildFilletTestRoute } from '../fixtures/fillet-test-route.js'
import { haversine, turnAngleDeg } from '../../src/utils/math.js'

const route = buildFilletTestRoute()

describe('fillet test route: data integrity', () => {
  it('produces a continuous polyline with reasonable spacing', () => {
    const { lats, lons } = route
    for (let i = 1; i < lats.length; i++) {
      const d = haversine(lats[i - 1], lons[i - 1], lats[i], lons[i])
      expect(d).toBeGreaterThan(0.5)  // no duplicate points
      expect(d).toBeLessThan(20)      // no huge gaps
    }
  })

  it('has monotonically increasing distances', () => {
    for (let i = 1; i < route.dists.length; i++) {
      expect(route.dists[i]).toBeGreaterThan(route.dists[i - 1])
    }
  })

  it('elevations are in the 340–420m range', () => {
    for (const e of route.eles) {
      expect(e).toBeGreaterThan(340)
      expect(e).toBeLessThan(420)
    }
  })

  it('coordinates are in the Slovenian Alps bounding box', () => {
    for (const lat of route.lats) {
      expect(lat).toBeGreaterThan(46.0)
      expect(lat).toBeLessThan(46.1)
    }
    for (const lon of route.lons) {
      expect(lon).toBeGreaterThan(14.4)
      expect(lon).toBeLessThan(14.6)
    }
  })

  it('has 5 test sections', () => {
    expect(route.sections).toHaveLength(5)
  })

  it('total route is 800–1800m long', () => {
    const total = route.dists[route.dists.length - 1]
    expect(total).toBeGreaterThan(800)
    expect(total).toBeLessThan(1800)
  })
})

describe('fillet test route: corner angles', () => {
  function angleAt(i) {
    return turnAngleDeg(
      route.lats[i - 1], route.lons[i - 1],
      route.lats[i], route.lons[i],
      route.lats[i + 1], route.lons[i + 1],
    )
  }

  it('Section 1 (gentle): ~60° turn — should NOT be filleted', () => {
    const s = route.sections[0]
    const a = angleAt(s.vertexIdx)
    expect(a).toBeGreaterThan(50)
    expect(a).toBeLessThan(70)
    expect(s.shouldFillet).toBe(false)
  })

  it('Section 2 (hairpin): ~120° single-vertex turn', () => {
    const s = route.sections[1]
    const a = angleAt(s.vertexIdx)
    expect(a).toBeGreaterThan(110)
    expect(a).toBeLessThan(130)
    expect(s.shouldFillet).toBe(true)
  })

  it('Section 3 (S-curve): two ~110° vertices', () => {
    const s = route.sections[2]
    for (const vi of s.vertexIndices) {
      const a = angleAt(vi)
      expect(a).toBeGreaterThan(100)
      expect(a).toBeLessThan(120)
    }
  })

  it('Section 3 vertices are 20–40m apart', () => {
    const s = route.sections[2]
    const [v1, v2] = s.vertexIndices
    const d = haversine(route.lats[v1], route.lons[v1], route.lats[v2], route.lons[v2])
    expect(d).toBeGreaterThan(20)
    expect(d).toBeLessThan(40)
  })

  it('Section 4 (U-turn): ~170° turn', () => {
    const s = route.sections[3]
    const a = angleAt(s.vertexIdx)
    expect(a).toBeGreaterThan(160)
    expect(a).toBeLessThan(178)
  })

  it('Section 5 (multi-vertex): each sub-vertex ~40°, total ~120°', () => {
    const s = route.sections[4]
    let total = 0
    for (const vi of s.vertexIndices) {
      if (vi === 0 || vi >= route.lats.length - 1) continue
      const a = angleAt(vi)
      expect(a).toBeGreaterThan(25)
      expect(a).toBeLessThan(55)
      total += a
    }
    expect(total).toBeGreaterThan(100)
    expect(total).toBeLessThan(140)
  })
})
