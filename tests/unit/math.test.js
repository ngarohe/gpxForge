/**
 * Unit tests for src/utils/math.js
 *
 * These test the core mathematical functions that everything else depends on.
 * All values verified against known geographic calculations.
 */

import { describe, it, expect } from 'vitest'
import {
  haversine,
  cumulativeDistances,
  bearing,
  bearingDiff,
  grads,
  ascDesc,
  hermiteElevation,
  lerp,
  clamp,
  maxTurnDeg,
  turnAngleDeg,
  distGaussSmooth,
  integrateGradient,
  densifyRoute,
} from '../../src/utils/math.js'

// ────────────────────────────────────────────────────────────────────
// Haversine
// ────────────────────────────────────────────────────────────────────

describe('haversine', () => {
  it('returns 0 for identical points', () => {
    expect(haversine(46.0, 14.5, 46.0, 14.5)).toBe(0)
  })

  it('calculates known distance (Ljubljana to Maribor ~104km straight line)', () => {
    const d = haversine(46.0569, 14.5058, 46.5547, 15.6459)
    expect(d).toBeGreaterThan(100000)
    expect(d).toBeLessThan(110000)
  })

  it('calculates short distance accurately', () => {
    // ~111m for 0.001° latitude at equator
    const d = haversine(0, 0, 0.001, 0)
    expect(d).toBeGreaterThan(100)
    expect(d).toBeLessThan(120)
  })
})

// ────────────────────────────────────────────────────────────────────
// Cumulative distances
// ────────────────────────────────────────────────────────────────────

describe('cumulativeDistances', () => {
  it('starts at zero', () => {
    const dists = cumulativeDistances([46, 46.001], [14, 14])
    expect(dists[0]).toBe(0)
    expect(dists.length).toBe(2)
  })

  it('is monotonically increasing', () => {
    const lats = [46.0, 46.001, 46.002, 46.003]
    const lons = [14.0, 14.0, 14.0, 14.0]
    const dists = cumulativeDistances(lats, lons)
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i]).toBeGreaterThan(dists[i - 1])
    }
  })
})

// ────────────────────────────────────────────────────────────────────
// Bearing
// ────────────────────────────────────────────────────────────────────

describe('bearing', () => {
  it('north is ~0°', () => {
    const b = bearing(46.0, 14.0, 47.0, 14.0)
    expect(b).toBeLessThan(1)
  })

  it('east is ~90°', () => {
    const b = bearing(46.0, 14.0, 46.0, 15.0)
    expect(b).toBeGreaterThan(85)
    expect(b).toBeLessThan(95)
  })
})

describe('bearingDiff', () => {
  it('same direction is 0', () => {
    expect(bearingDiff(90, 90)).toBe(0)
  })

  it('opposite directions return 0 (treats as aligned)', () => {
    expect(bearingDiff(0, 180)).toBe(0)
  })

  it('perpendicular is 90', () => {
    expect(bearingDiff(0, 90)).toBe(90)
  })
})

// ────────────────────────────────────────────────────────────────────
// Gradients
// ────────────────────────────────────────────────────────────────────

describe('grads', () => {
  it('returns 0% for flat terrain', () => {
    const g = grads([100, 100, 100], [0, 100, 200])
    expect(g[0]).toBe(0)
    expect(g[1]).toBe(0)
  })

  it('calculates correct gradient', () => {
    // 10m rise over 100m = 10%
    const g = grads([100, 110], [0, 100])
    expect(g[0]).toBeCloseTo(10, 5)
  })

  it('output length matches input length', () => {
    const g = grads([100, 110, 120], [0, 100, 200])
    expect(g.length).toBe(3)
  })
})

describe('ascDesc', () => {
  it('calculates ascent and descent', () => {
    const { asc, desc } = ascDesc([100, 200, 150, 250])
    expect(asc).toBe(200) // +100 +100 = 200
    expect(desc).toBe(50)  // -50
  })

  it('returns 0 for flat', () => {
    const { asc, desc } = ascDesc([100, 100, 100])
    expect(asc).toBe(0)
    expect(desc).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Interpolation
// ────────────────────────────────────────────────────────────────────

describe('lerp', () => {
  it('returns start at t=0', () => {
    expect(lerp(10, 20, 0)).toBe(10)
  })

  it('returns end at t=1', () => {
    expect(lerp(10, 20, 1)).toBe(20)
  })

  it('returns midpoint at t=0.5', () => {
    expect(lerp(10, 20, 0.5)).toBe(15)
  })
})

describe('clamp', () => {
  it('clamps below min', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
  })

  it('clamps above max', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })

  it('passes through values in range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })
})

describe('hermiteElevation', () => {
  it('returns e0 at t=0', () => {
    expect(hermiteElevation(0, 100, 200, 0.1, -0.1, 1000)).toBe(100)
  })

  it('returns e1 at t=1', () => {
    expect(hermiteElevation(1, 100, 200, 0.1, -0.1, 1000)).toBe(200)
  })
})

// ────────────────────────────────────────────────────────────────────
// Turn angles
// ────────────────────────────────────────────────────────────────────

describe('maxTurnDeg', () => {
  it('returns 0 for straight line', () => {
    const lats = [46.0, 46.001, 46.002]
    const lons = [14.0, 14.0, 14.0]
    expect(maxTurnDeg(lats, lons)).toBeCloseTo(0, 1)
  })

  it('detects 90° turn', () => {
    const lats = [46.0, 46.001, 46.001]
    const lons = [14.0, 14.0, 14.001]
    const turn = maxTurnDeg(lats, lons)
    expect(turn).toBeGreaterThan(80)
    expect(turn).toBeLessThan(100)
  })
})

// ────────────────────────────────────────────────────────────────────
// Gaussian smoothing (processGPX port)
// ────────────────────────────────────────────────────────────────────

describe('distGaussSmooth', () => {
  it('returns copy for sigma < 0.5', () => {
    const arr = [1, 2, 3]
    const dists = [0, 1, 2]
    const result = distGaussSmooth(arr, dists, 0.1)
    expect(result).toEqual([1, 2, 3])
    expect(result).not.toBe(arr) // should be a copy
  })

  it('smooths a spike', () => {
    const arr = [0, 0, 10, 0, 0]
    const dists = [0, 1, 2, 3, 4]
    const result = distGaussSmooth(arr, dists, 1)
    // Peak should be reduced
    expect(result[2]).toBeLessThan(10)
    // Neighbours should increase
    expect(result[1]).toBeGreaterThan(0)
    expect(result[3]).toBeGreaterThan(0)
  })

  it('preserves constant array', () => {
    const arr = [5, 5, 5, 5, 5]
    const dists = [0, 10, 20, 30, 40]
    const result = distGaussSmooth(arr, dists, 10)
    result.forEach(v => expect(v).toBeCloseTo(5, 5))
  })
})

// ────────────────────────────────────────────────────────────────────
// Gradient integration (processGPX port)
// ────────────────────────────────────────────────────────────────────

describe('integrateGradient', () => {
  it('matches endpoints exactly', () => {
    const grPct = [10, 10, 10, 10]
    const dists = [0, 100, 200, 300]
    const eles = [100, 110, 120, 130]
    const result = integrateGradient(grPct, dists, eles)
    expect(result[0]).toBe(100)
    expect(result[result.length - 1]).toBeCloseTo(130, 5)
  })

  it('handles flat gradient', () => {
    const grPct = [0, 0, 0]
    const dists = [0, 100, 200]
    const eles = [100, 100, 100]
    const result = integrateGradient(grPct, dists, eles)
    result.forEach(v => expect(v).toBeCloseTo(100, 5))
  })
})

// ────────────────────────────────────────────────────────────────────
// Densification
// ────────────────────────────────────────────────────────────────────

describe('densifyRoute', () => {
  it('increases point count for sparse route', () => {
    const lats = [46.0, 46.01]
    const lons = [14.0, 14.0]
    const eles = [100, 200]
    const result = densifyRoute(lats, lons, eles, 100)
    expect(result.lats.length).toBeGreaterThan(2)
  })

  it('preserves original endpoints', () => {
    const lats = [46.0, 46.01]
    const lons = [14.0, 14.0]
    const eles = [100, 200]
    const result = densifyRoute(lats, lons, eles, 100)
    expect(result.lats[0]).toBe(46.0)
    expect(result.lats[result.lats.length - 1]).toBe(46.01)
    expect(result.eles[0]).toBe(100)
    expect(result.eles[result.eles.length - 1]).toBe(200)
  })
})
