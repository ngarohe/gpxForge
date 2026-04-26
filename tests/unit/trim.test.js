import { describe, it, expect } from 'vitest'
import {
  detectTrimType,
  executeTrim,
  fixBoundaryElevations,
  rebuildRoute,
  trimGapDistance,
  trimSnapshot,
} from '../../src/pipeline/0-trim.js'

// ── Test data ──

function makeRoute(n = 50, spacingM = 100) {
  const lats = [], lons = [], eles = []
  const dlonPer100m = spacingM / (111320 * Math.cos(46 * Math.PI / 180))
  for (let i = 0; i < n; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * dlonPer100m)
    eles.push(300 + i * 0.5) // gentle climb
  }
  return { lats, lons, eles }
}

function makeDists(n = 50, spacingM = 100) {
  const dists = []
  for (let i = 0; i < n; i++) dists.push(i * spacingM)
  return dists
}

// ── Tests ──

describe('detectTrimType', () => {
  it('detects start trim when idxA is near beginning', () => {
    expect(detectTrimType(0, 30, 100)).toBe('start')
    expect(detectTrimType(5, 30, 100)).toBe('start')
    expect(detectTrimType(10, 30, 100)).toBe('start')
  })

  it('detects end trim when idxB is near end', () => {
    expect(detectTrimType(20, 99, 100)).toBe('end')
    expect(detectTrimType(20, 95, 100)).toBe('end')
    expect(detectTrimType(20, 90, 100)).toBe('end')
  })

  it('detects mid trim for interior cuts', () => {
    expect(detectTrimType(20, 40, 100)).toBe('mid')
    expect(detectTrimType(30, 60, 100)).toBe('mid')
  })

  it('start trim takes precedence over end trim when both near edges', () => {
    // idxA near start → start trim
    expect(detectTrimType(5, 95, 100)).toBe('start')
  })
})

describe('fixBoundaryElevations', () => {
  it('copies neighbor elevations to endpoints', () => {
    const eles = [100, 200, 300, 400, 500]
    fixBoundaryElevations(eles)
    expect(eles[0]).toBe(200)
    expect(eles[4]).toBe(400)
    // Interior unchanged
    expect(eles[2]).toBe(300)
  })

  it('handles two-element array', () => {
    const eles = [100, 200]
    fixBoundaryElevations(eles)
    expect(eles[0]).toBe(200)
    expect(eles[1]).toBe(200) // copies from eles[0] which is now 200
  })

  it('handles single element (no crash)', () => {
    const eles = [100]
    fixBoundaryElevations(eles) // should not throw
    expect(eles[0]).toBe(100) // unchanged, length < 2
  })
})

describe('executeTrim', () => {
  it('start trim keeps from idxB onward', async () => {
    const gpx = makeRoute(50)
    const eleClean = gpx.eles.slice()
    const result = await executeTrim(gpx, eleClean, 0, 20, 'start')
    expect(result.lats.length).toBe(30) // 50 - 20
    expect(result.lons.length).toBe(30)
    expect(result.eles.length).toBe(30)
    expect(result.eleClean.length).toBe(30)
  })

  it('end trim keeps up to idxA', async () => {
    const gpx = makeRoute(50)
    const eleClean = gpx.eles.slice()
    const result = await executeTrim(gpx, eleClean, 30, 49, 'end')
    expect(result.lats.length).toBe(31) // 0 to 30 inclusive
    expect(result.lons.length).toBe(31)
  })

  it('mid trim joins both ends', async () => {
    const gpx = makeRoute(50)
    const eleClean = gpx.eles.slice()
    const result = await executeTrim(gpx, eleClean, 20, 30, 'mid')
    // [0..20] + [30..49] = 21 + 20 = 41
    expect(result.lats.length).toBe(41)
    expect(result.lons.length).toBe(41)
    expect(result.eles.length).toBe(41)
  })

  it('boundary elevations are fixed after trim', async () => {
    const gpx = makeRoute(50)
    const eleClean = gpx.eles.slice()
    const result = await executeTrim(gpx, eleClean, 0, 10, 'start')
    // First element should equal second element
    expect(result.eles[0]).toBe(result.eles[1])
    // Last element should equal second-to-last
    const N = result.eles.length
    expect(result.eles[N - 1]).toBe(result.eles[N - 2])
  })
})

describe('rebuildRoute', () => {
  it('produces correct-length arrays', () => {
    const gpx = makeRoute(30)
    const { dists, grOrig, grClean } = rebuildRoute(gpx.lats, gpx.lons, gpx.eles, gpx.eles.slice())
    expect(dists.length).toBe(30)
    expect(grOrig.length).toBe(30)
    expect(grClean.length).toBe(30)
  })

  it('distances start at zero', () => {
    const gpx = makeRoute(20)
    const { dists } = rebuildRoute(gpx.lats, gpx.lons, gpx.eles, gpx.eles.slice())
    expect(dists[0]).toBe(0)
  })

  it('distances are monotonically increasing', () => {
    const gpx = makeRoute(30)
    const { dists } = rebuildRoute(gpx.lats, gpx.lons, gpx.eles, gpx.eles.slice())
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i]).toBeGreaterThan(dists[i - 1])
    }
  })
})

describe('trimGapDistance', () => {
  it('returns positive distance between two points', () => {
    const gpx = makeRoute(50)
    const gap = trimGapDistance(gpx.lats, gpx.lons, 10, 30)
    expect(gap).toBeGreaterThan(0)
  })

  it('returns zero for same point', () => {
    const gpx = makeRoute(50)
    const gap = trimGapDistance(gpx.lats, gpx.lons, 10, 10)
    expect(gap).toBe(0)
  })

  it('returns approximately correct distance for known spacing', () => {
    const gpx = makeRoute(50, 100) // 100m spacing
    const gap = trimGapDistance(gpx.lats, gpx.lons, 10, 20)
    // 10 segments × 100m ≈ 1000m
    expect(gap).toBeGreaterThan(900)
    expect(gap).toBeLessThan(1100)
  })
})

describe('trimSnapshot', () => {
  it('creates independent copy of arrays', () => {
    const gpx = makeRoute(20)
    const dists = makeDists(20)
    const snap = trimSnapshot(gpx, dists, null, gpx.eles.slice(), null)

    // Modify original
    gpx.lats[0] = 999
    dists[0] = 999

    // Snapshot should be unchanged
    expect(snap.gpx.lats[0]).toBe(46.0)
    expect(snap.dists[0]).toBe(0)
  })

  it('handles Float64Array dists', () => {
    const gpx = makeRoute(10)
    const dists = new Float64Array(makeDists(10))
    const snap = trimSnapshot(gpx, dists, null, null, null)
    expect(snap.dists).toBeInstanceOf(Float64Array)
    expect(snap.dists.length).toBe(10)
  })

  it('handles null eleClean and grClean', () => {
    const gpx = makeRoute(10)
    const dists = makeDists(10)
    const snap = trimSnapshot(gpx, dists, null, null, null)
    expect(snap.eleClean).toBeNull()
    expect(snap.grClean).toBeNull()
  })
})
