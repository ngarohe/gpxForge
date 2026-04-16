import { describe, it, expect } from 'vitest'
import {
  terrainType,
  effectiveCdA,
  solveSpeed,
  analyzeRoute,
  generateSplits,
} from '../../src/pipeline/5-split.js'
import { fmtTime, fmtTimeLong } from '../../src/utils/format.js'

// ── Test data ──

function makeFlatRoute(n = 100, spacingM = 100) {
  // Straight east-west route at 46°N, flat, 100m apart
  const lats = [], lons = [], eles = []
  const dlonPer100m = 100 / (111320 * Math.cos(46 * Math.PI / 180))
  for (let i = 0; i < n; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * dlonPer100m)
    eles.push(300)
  }
  return { lats, lons, eles }
}

function makeClimbRoute(n = 100) {
  // Steady 5% climb over 10 km
  const lats = [], lons = [], eles = []
  const dlonPer100m = 100 / (111320 * Math.cos(46 * Math.PI / 180))
  for (let i = 0; i < n; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * dlonPer100m)
    eles.push(300 + i * 5) // 5m per 100m = 5% grade
  }
  return { lats, lons, eles }
}

// ── Tests ──

describe('terrainType', () => {
  it('classifies climb when gradient > 2%', () => {
    expect(terrainType(0.05)).toBe('climb')
    expect(terrainType(0.021)).toBe('climb')
  })

  it('classifies descent when gradient < -2%', () => {
    expect(terrainType(-0.03)).toBe('descent')
    expect(terrainType(-0.25)).toBe('descent')
  })

  it('classifies flat when gradient between -2% and 2%', () => {
    expect(terrainType(0)).toBe('flat')
    expect(terrainType(0.01)).toBe('flat')
    expect(terrainType(-0.019)).toBe('flat')
  })
})

describe('effectiveCdA', () => {
  it('returns 0.32 for solo mode', () => {
    expect(effectiveCdA(false, 0)).toBe(0.32)
    expect(effectiveCdA(false, 0.1)).toBe(0.32)
    expect(effectiveCdA(false, -0.1)).toBe(0.32)
  })

  it('returns less than 0.32 for group on flat terrain', () => {
    const cda = effectiveCdA(true, 0)
    expect(cda).toBeLessThan(0.32)
    expect(cda).toBeGreaterThan(0)
  })

  it('reduces draft benefit on climbs compared to flat', () => {
    const cdaFlat = effectiveCdA(true, 0)
    const cdaClimb = effectiveCdA(true, 0.05)
    // On climbs, CdA should be higher (less draft benefit)
    expect(cdaClimb).toBeGreaterThan(cdaFlat)
  })

  it('returns different values for different terrain types', () => {
    const climb = effectiveCdA(true, 0.05)
    const flat = effectiveCdA(true, 0)
    const descent = effectiveCdA(true, -0.05)
    // All should differ from solo
    expect(climb).toBeLessThan(0.32)
    expect(flat).toBeLessThan(0.32)
    expect(descent).toBeLessThan(0.32)
  })
})

describe('solveSpeed', () => {
  it('returns speed within valid range', () => {
    const speed = solveSpeed(200, 80, 0, 0.32)
    expect(speed).toBeGreaterThanOrEqual(1.0)
    expect(speed).toBeLessThanOrEqual(22.2)
  })

  it('returns slower speed on uphills', () => {
    const flat = solveSpeed(200, 80, 0, 0.32)
    const uphill = solveSpeed(200, 80, 0.08, 0.32)
    expect(uphill).toBeLessThan(flat)
  })

  it('returns faster speed on downhills', () => {
    const flat = solveSpeed(200, 80, 0, 0.32)
    const downhill = solveSpeed(200, 80, -0.05, 0.32)
    expect(downhill).toBeGreaterThan(flat)
  })

  it('clamps to minimum speed on very steep climbs', () => {
    const speed = solveSpeed(100, 80, 0.25, 0.32)
    expect(speed).toBeCloseTo(1.0, 5)
  })

  it('clamps to maximum speed on very steep descents', () => {
    const speed = solveSpeed(400, 60, -0.20, 0.32)
    expect(speed).toBeCloseTo(22.2, 5)
  })

  it('returns reasonable flat speed for typical rider', () => {
    // 200W, 80kg on flat should be roughly 30-35 km/h = 8.3-9.7 m/s
    const speed = solveSpeed(200, 80, 0, 0.32)
    expect(speed).toBeGreaterThan(7)
    expect(speed).toBeLessThan(11)
  })
})

describe('analyzeRoute', () => {
  it('returns cumulative arrays of correct length', () => {
    const { lats, lons, eles } = makeFlatRoute(50)
    const result = analyzeRoute(lats, lons, eles, 200, 80, false)
    expect(result.cumTime.length).toBe(50)
    expect(result.cumTimeSolo.length).toBe(50)
    expect(result.cumDist.length).toBe(50)
    expect(result.cumClimb.length).toBe(50)
  })

  it('cumulative arrays start at zero', () => {
    const { lats, lons, eles } = makeFlatRoute(30)
    const result = analyzeRoute(lats, lons, eles, 200, 80, false)
    expect(result.cumTime[0]).toBe(0)
    expect(result.cumDist[0]).toBe(0)
    expect(result.cumClimb[0]).toBe(0)
  })

  it('totalTime is positive for any route', () => {
    const { lats, lons, eles } = makeFlatRoute(20)
    const result = analyzeRoute(lats, lons, eles, 200, 80, false)
    expect(result.totalTime).toBeGreaterThan(0)
  })

  it('totalDist is close to expected for flat route', () => {
    // 50 points, 100m apart = ~4900m
    const { lats, lons, eles } = makeFlatRoute(50)
    const result = analyzeRoute(lats, lons, eles, 200, 80, false)
    expect(result.totalDist).toBeGreaterThan(4500)
    expect(result.totalDist).toBeLessThan(5500)
  })

  it('group ride is faster than solo on flat', () => {
    const { lats, lons, eles } = makeFlatRoute(50)
    const result = analyzeRoute(lats, lons, eles, 200, 80, true)
    expect(result.totalTime).toBeLessThan(result.soloTime)
  })

  it('solo time matches totalTime when group is disabled', () => {
    const { lats, lons, eles } = makeFlatRoute(50)
    const result = analyzeRoute(lats, lons, eles, 200, 80, false)
    // totalTime and soloTime should be equal when group is false
    expect(Math.abs(result.totalTime - result.soloTime)).toBeLessThan(0.01)
  })

  it('cumClimb accumulates correctly for climb route', () => {
    const { lats, lons, eles } = makeClimbRoute(50)
    const result = analyzeRoute(lats, lons, eles, 200, 80, false)
    const lastClimb = result.cumClimb[result.cumClimb.length - 1]
    // 49 segments × ~5m each = ~245m of climbing
    expect(lastClimb).toBeGreaterThan(200)
    expect(lastClimb).toBeLessThan(300)
  })

  it('stores watts and mass in result', () => {
    const { lats, lons, eles } = makeFlatRoute(20)
    const result = analyzeRoute(lats, lons, eles, 250, 75, false)
    expect(result.watts).toBe(250)
    expect(result.mass).toBe(75)
  })
})

describe('generateSplits', () => {
  it('generates correct number of splits', () => {
    const { lats, lons, eles } = makeFlatRoute(100)
    const analysis = analyzeRoute(lats, lons, eles, 200, 80, false)
    // Total time is roughly 10 km / ~30 km/h ≈ 1200s = 20 min
    const splits = generateSplits(analysis, 600) // 10 min target
    expect(splits.length).toBeGreaterThanOrEqual(1)
  })

  it('splits cover entire route', () => {
    const { lats, lons, eles } = makeFlatRoute(100)
    const analysis = analyzeRoute(lats, lons, eles, 200, 80, false)
    const splits = generateSplits(analysis, 300)
    // First split starts at 0
    expect(splits[0].startIdx).toBe(0)
    // Last split ends at N-1
    expect(splits[splits.length - 1].endIdx).toBe(99)
  })

  it('splits are contiguous (no gaps)', () => {
    const { lats, lons, eles } = makeFlatRoute(100)
    const analysis = analyzeRoute(lats, lons, eles, 200, 80, false)
    const splits = generateSplits(analysis, 300)
    for (let i = 1; i < splits.length; i++) {
      expect(splits[i].startIdx).toBe(splits[i - 1].endIdx)
    }
  })

  it('each split has positive time and distance', () => {
    const { lats, lons, eles } = makeFlatRoute(100)
    const analysis = analyzeRoute(lats, lons, eles, 200, 80, false)
    const splits = generateSplits(analysis, 300)
    for (const s of splits) {
      expect(s.time).toBeGreaterThan(0)
      expect(s.dist).toBeGreaterThan(0)
      expect(s.avgSpeed).toBeGreaterThan(0)
    }
  })

  it('handles single-segment case', () => {
    const { lats, lons, eles } = makeFlatRoute(20)
    const analysis = analyzeRoute(lats, lons, eles, 200, 80, false)
    const splits = generateSplits(analysis, 99999) // huge target → single segment
    expect(splits.length).toBe(1)
    expect(splits[0].startIdx).toBe(0)
    expect(splits[0].endIdx).toBe(19)
  })

  it('returns empty array when analysis is null', () => {
    expect(generateSplits(null, 600)).toEqual([])
  })
})

describe('fmtTime', () => {
  it('formats seconds as M:SS', () => {
    expect(fmtTime(125)).toBe('2:05')
    expect(fmtTime(3600)).toBe('60:00')
    expect(fmtTime(0)).toBe('0:00')
  })
})

describe('fmtTimeLong', () => {
  it('formats with hours when >= 1h', () => {
    expect(fmtTimeLong(3660)).toBe('1h 1m')
    expect(fmtTimeLong(7200)).toBe('2h 0m')
  })

  it('formats without hours when < 1h', () => {
    expect(fmtTimeLong(125)).toBe('2m 05s')
    expect(fmtTimeLong(600)).toBe('10m 00s')
  })
})
