import { describe, it, expect } from 'vitest'
import {
  nearestGpxIndexForward,
  computeCurvature,
  buildAutoSnapIndices,
  mergeSegments,
  transferElevations,
} from '../../src/pipeline/1-snap.js'
import { densifyRoute } from '../../src/utils/math.js'

// ── Test data helpers ──

function makeRoute(n = 50, spacingM = 100) {
  const lats = [], lons = [], eles = [], dists = [0]
  const dlonPer100m = spacingM / (111320 * Math.cos(46 * Math.PI / 180))
  for (let i = 0; i < n; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * dlonPer100m)
    eles.push(300 + i * 0.5)
    if (i > 0) dists.push(dists[i - 1] + spacingM)
  }
  return { lats, lons, eles, dists }
}

function makeCurvedRoute(n = 50, spacingM = 100) {
  // Route that curves — alternates lat to create zigzag
  const lats = [], lons = [], eles = [], dists = [0]
  const dlonPer100m = spacingM / (111320 * Math.cos(46 * Math.PI / 180))
  for (let i = 0; i < n; i++) {
    // Zigzag north/south every 5 points
    const offset = (Math.floor(i / 5) % 2 === 0 ? 1 : -1) * 0.001
    lats.push(46.0 + offset * (i % 5) / 5)
    lons.push(14.0 + i * dlonPer100m)
    eles.push(300)
    if (i > 0) {
      dists.push(dists[i - 1] + spacingM)
    }
  }
  return { lats, lons, eles, dists }
}

// ── Tests ──

describe('nearestGpxIndexForward', () => {
  it('finds nearest point at or after minIdx', () => {
    const { lats, lons } = makeRoute(50)
    const idx = nearestGpxIndexForward(lats[20], lons[20], lats, lons, 15)
    expect(idx).toBe(20)
  })

  it('respects minIdx constraint', () => {
    const { lats, lons } = makeRoute(50)
    // Looking for point 10, but minIdx is 15 → should find closest >= 15
    const idx = nearestGpxIndexForward(lats[10], lons[10], lats, lons, 15)
    expect(idx).toBeGreaterThanOrEqual(15)
  })

  it('returns minIdx when search is at start', () => {
    const { lats, lons } = makeRoute(50)
    const idx = nearestGpxIndexForward(lats[0], lons[0], lats, lons, 0)
    expect(idx).toBe(0)
  })

  it('finds last point when looking for end', () => {
    const { lats, lons } = makeRoute(50)
    const idx = nearestGpxIndexForward(lats[49], lons[49], lats, lons, 40)
    expect(idx).toBe(49)
  })
})

describe('computeCurvature', () => {
  it('returns zero curvature for straight line', () => {
    const { lats, lons, dists } = makeRoute(50)
    const curv = computeCurvature(lats, lons, dists)
    expect(curv.length).toBe(50)
    // Interior points should have very low curvature
    for (let i = 2; i < 48; i++) {
      expect(curv[i]).toBeLessThan(0.1)
    }
  })

  it('returns higher curvature for curved route', () => {
    const { lats, lons, dists } = makeCurvedRoute(50)
    const curv = computeCurvature(lats, lons, dists)
    expect(curv.length).toBe(50)
    // At least some interior points should have non-zero curvature
    const maxCurv = Math.max(...curv.slice(5, 45))
    expect(maxCurv).toBeGreaterThan(0)
  })

  it('endpoints are zero', () => {
    const { lats, lons, dists } = makeCurvedRoute(50)
    const curv = computeCurvature(lats, lons, dists)
    expect(curv[0]).toBe(0)
    expect(curv[49]).toBe(0)
  })
})

describe('buildAutoSnapIndices', () => {
  it('includes first and last index', () => {
    const { lats, lons, dists } = makeRoute(50)
    const indices = buildAutoSnapIndices(lats, lons, dists, 300)
    expect(indices[0]).toBe(0)
    expect(indices[indices.length - 1]).toBe(49)
  })

  it('produces reasonable count for known spacing', () => {
    const { lats, lons, dists } = makeRoute(100, 100)
    // 100 points × 100m = ~10km route
    // baseSpacing = 750m → expect ~14 waypoints (10000/750 + 1)
    const indices = buildAutoSnapIndices(lats, lons, dists, 750)
    expect(indices.length).toBeGreaterThan(5)
    expect(indices.length).toBeLessThan(30)
  })

  it('indices are strictly increasing', () => {
    const { lats, lons, dists } = makeRoute(100)
    const indices = buildAutoSnapIndices(lats, lons, dists, 500)
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1])
    }
  })

  it('handles short route', () => {
    const { lats, lons, dists } = makeRoute(3)
    const indices = buildAutoSnapIndices(lats, lons, dists, 500)
    expect(indices[0]).toBe(0)
    expect(indices[indices.length - 1]).toBe(2)
  })

  it('denser spacing with curved route', () => {
    const { lats, lons, dists } = makeCurvedRoute(100, 100)
    const straight = makeRoute(100, 100)
    const indicesCurved = buildAutoSnapIndices(lats, lons, dists, 750)
    const indicesStraight = buildAutoSnapIndices(straight.lats, straight.lons, straight.dists, 750)
    // Curved route should produce more waypoints (denser spacing)
    expect(indicesCurved.length).toBeGreaterThanOrEqual(indicesStraight.length)
  })
})

describe('mergeSegments', () => {
  it('merges single segment unchanged', () => {
    const segments = [[[46.0, 14.0], [46.1, 14.1], [46.2, 14.2]]]
    const { lats, lons } = mergeSegments(segments)
    expect(lats).toEqual([46.0, 46.1, 46.2])
    expect(lons).toEqual([14.0, 14.1, 14.2])
  })

  it('deduplicates junction points', () => {
    const segments = [
      [[46.0, 14.0], [46.1, 14.1]],
      [[46.1, 14.1], [46.2, 14.2]],
      [[46.2, 14.2], [46.3, 14.3]],
    ]
    const { lats, lons } = mergeSegments(segments)
    // Should be 4 points (not 6) — junction points appear once
    expect(lats.length).toBe(4)
    expect(lats).toEqual([46.0, 46.1, 46.2, 46.3])
  })

  it('handles empty segments array', () => {
    const { lats, lons } = mergeSegments([])
    expect(lats).toEqual([])
    expect(lons).toEqual([])
  })

  it('handles segment with single point', () => {
    const segments = [[[46.0, 14.0]]]
    const { lats, lons } = mergeSegments(segments)
    expect(lats).toEqual([46.0])
  })
})

describe('transferElevations', () => {
  it('preserves endpoint elevations approximately', () => {
    const { lats, lons, eles, dists } = makeRoute(20)
    // New route same as original
    const newEles = transferElevations(lats, lons, eles, dists, lats, lons)
    expect(newEles[0]).toBeCloseTo(eles[0], 1)
    expect(newEles[newEles.length - 1]).toBeCloseTo(eles[eles.length - 1], 1)
  })

  it('produces correct length output', () => {
    const { lats, lons, eles, dists } = makeRoute(20)
    // Different-length new route
    const newLats = lats.slice(0, 10)
    const newLons = lons.slice(0, 10)
    const newEles = transferElevations(lats, lons, eles, dists, newLats, newLons)
    expect(newEles.length).toBe(10)
  })

  it('handles empty new route', () => {
    const { lats, lons, eles, dists } = makeRoute(20)
    const newEles = transferElevations(lats, lons, eles, dists, [], [])
    expect(newEles).toEqual([])
  })

  it('elevations are monotonically increasing for gentle climb', () => {
    const { lats, lons, eles, dists } = makeRoute(50) // gentle climb
    const newEles = transferElevations(lats, lons, eles, dists, lats, lons)
    for (let i = 1; i < newEles.length; i++) {
      expect(newEles[i]).toBeGreaterThanOrEqual(newEles[i - 1] - 0.01) // allow tiny float errors
    }
  })

  it('geographic matching picks up nearby original elevations', () => {
    // Original: 20 points, 100m apart along a line, gentle climb
    const { lats, lons, eles, dists } = makeRoute(20, 100)

    // Snapped route: offset 3m north (simulating road snap offset)
    const offsetLat = 3 / 111320 // ~3m north
    const sLats = lats.map(l => l + offsetLat)

    const newEles = transferElevations(lats, lons, eles, dists, sLats, lons)
    expect(newEles.length).toBe(20)

    // Each snapped point is only 3m from its original — should get very close elevation
    for (let i = 0; i < 20; i++) {
      expect(newEles[i]).toBeCloseTo(eles[i], 0)
    }
  })
})

describe('densifyRoute', () => {
  it('returns unchanged route when spacing is 0', () => {
    const { lats, lons, eles } = makeRoute(10)
    const result = densifyRoute(lats, lons, eles, 0)
    expect(result.lats.length).toBe(10)
  })

  it('adds interpolated points between original points', () => {
    const { lats, lons, eles } = makeRoute(3, 100) // 3 points, 100m apart
    const result = densifyRoute(lats, lons, eles, 30) // 30m spacing
    // Each 100m segment should get ~3 additional points
    expect(result.lats.length).toBeGreaterThan(3)
  })

  it('preserves original points', () => {
    const { lats, lons, eles } = makeRoute(5, 100)
    const result = densifyRoute(lats, lons, eles, 30)
    // First and last points should be exactly preserved
    expect(result.lats[0]).toBe(lats[0])
    expect(result.lats[result.lats.length - 1]).toBe(lats[lats.length - 1])
  })

  it('interpolated elevations are between neighbors', () => {
    const { lats, lons, eles } = makeRoute(5, 100) // gentle climb
    const result = densifyRoute(lats, lons, eles, 30)
    // All interpolated elevations should be between min and max original
    const minEle = Math.min(...eles)
    const maxEle = Math.max(...eles)
    for (const e of result.eles) {
      expect(e).toBeGreaterThanOrEqual(minEle - 0.01)
      expect(e).toBeLessThanOrEqual(maxEle + 0.01)
    }
  })

  it('handles single-point route', () => {
    const result = densifyRoute([46], [14], [300], 10)
    expect(result.lats.length).toBe(1)
  })
})
