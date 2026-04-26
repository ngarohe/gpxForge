import { describe, it, expect } from 'vitest'
import {
  detectOverlaps,
  clusterOverlaps,
  determineDirection,
  snapOverlapSegment,
  snapOverlaps,
} from '../../src/pipeline/1.5-overlap.js'

// ── Test data helpers ──

const DLAT_PER_M = 1 / 111320
const DLON_PER_M_46 = 1 / (111320 * Math.cos(46 * Math.PI / 180))

/**
 * Build an out-and-back route: east N points, then west N points.
 * Return leg offset 1m north (realistic GPS/snap divergence).
 */
function makeOutAndBack(ptsPerLeg = 200, spacingM = 25) {
  const lats = [], lons = []
  // Outbound: east
  for (let i = 0; i < ptsPerLeg; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * spacingM * DLON_PER_M_46)
  }
  // Return: west, 1m north
  const offset = 1 * DLAT_PER_M
  for (let i = ptsPerLeg - 1; i >= 0; i--) {
    lats.push(46.0 + offset)
    lons.push(14.0 + i * spacingM * DLON_PER_M_46)
  }
  return { lats, lons }
}

/**
 * Build a one-way straight route (no overlaps).
 */
function makeStraight(n = 200, spacingM = 25) {
  const lats = [], lons = []
  for (let i = 0; i < n; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * spacingM * DLON_PER_M_46)
  }
  return { lats, lons }
}

/**
 * Build two parallel lines separated by offsetM metres.
 */
function makeParallel(n = 200, spacingM = 25, offsetM = 15) {
  const lats = [], lons = []
  // First line
  for (let i = 0; i < n; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * spacingM * DLON_PER_M_46)
  }
  // Second line, offsetM north
  const offset = offsetM * DLAT_PER_M
  for (let i = 0; i < n; i++) {
    lats.push(46.0 + offset)
    lons.push(14.0 + i * spacingM * DLON_PER_M_46)
  }
  return { lats, lons }
}

/**
 * Build a lollipop route: shared stem + loop.
 * Stem goes east, loop goes north-east-south-west, then stem returns west.
 */
function makeLollipop(stemPts = 100, loopPts = 100, spacingM = 25) {
  const lats = [], lons = []
  // Stem out: east
  for (let i = 0; i < stemPts; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * spacingM * DLON_PER_M_46)
  }
  // Loop: circle-ish (north, continue east, south, back west)
  const loopR = loopPts * spacingM / (2 * Math.PI)
  const cx = 14.0 + stemPts * spacingM * DLON_PER_M_46
  const cy = 46.0
  for (let i = 0; i < loopPts; i++) {
    const angle = (2 * Math.PI * i) / loopPts
    lats.push(cy + loopR * Math.sin(angle) * DLAT_PER_M)
    lons.push(cx + loopR * Math.cos(angle) * DLON_PER_M_46)
  }
  // Stem return: west (1m offset north)
  const offset = 1 * DLAT_PER_M
  for (let i = stemPts - 1; i >= 0; i--) {
    lats.push(46.0 + offset)
    lons.push(14.0 + i * spacingM * DLON_PER_M_46)
  }
  return { lats, lons }
}

// ── Tests ──

describe('detectOverlaps', () => {
  it('detects overlapping pairs in out-and-back route', () => {
    const { lats, lons } = makeOutAndBack()
    const pairs = detectOverlaps(lats, lons, 8, 100)
    expect(pairs.length).toBeGreaterThan(0)
    // All pairs should have firstIdx < secondIdx
    for (const p of pairs) {
      expect(p.firstIdx).toBeLessThan(p.secondIdx)
      expect(p.distance).toBeLessThanOrEqual(8)
    }
  })

  it('returns no pairs for one-way route', () => {
    const { lats, lons } = makeStraight()
    const pairs = detectOverlaps(lats, lons, 8, 100)
    expect(pairs.length).toBe(0)
  })

  it('ignores parallel roads beyond threshold', () => {
    const { lats, lons } = makeParallel(200, 25, 15)
    const pairs = detectOverlaps(lats, lons, 8, 100)
    expect(pairs.length).toBe(0)
  })
})

describe('clusterOverlaps', () => {
  it('groups consecutive pairs into segments', () => {
    const pairs = [
      { firstIdx: 10, secondIdx: 390, distance: 1 },
      { firstIdx: 11, secondIdx: 389, distance: 1 },
      { firstIdx: 12, secondIdx: 388, distance: 1 },
      // gap
      { firstIdx: 50, secondIdx: 350, distance: 1 },
      { firstIdx: 51, secondIdx: 349, distance: 1 },
    ]
    const segments = clusterOverlaps(pairs, 3)
    expect(segments.length).toBe(2)
    expect(segments[0].pairs.length).toBe(3)
    expect(segments[1].pairs.length).toBe(2)
  })

  it('returns empty for no pairs', () => {
    expect(clusterOverlaps([])).toEqual([])
  })
})

describe('determineDirection', () => {
  it('detects opposite direction for out-and-back', () => {
    const { lats, lons } = makeOutAndBack()
    // Segment covers outbound [10..50] and return [350..390]
    const segment = { firstStart: 10, firstEnd: 50, secondStart: 350, secondEnd: 390 }
    const dir = determineDirection(segment, lats, lons)
    expect(dir).toBe('opposite')
  })

  it('detects same direction for parallel same-way traverse', () => {
    // Both legs going east
    const lats = [], lons = []
    for (let i = 0; i < 200; i++) {
      lats.push(46.0)
      lons.push(14.0 + i * 25 * DLON_PER_M_46)
    }
    for (let i = 0; i < 200; i++) {
      lats.push(46.0 + DLAT_PER_M)
      lons.push(14.0 + i * 25 * DLON_PER_M_46)
    }
    const segment = { firstStart: 10, firstEnd: 50, secondStart: 210, secondEnd: 250 }
    const dir = determineDirection(segment, lats, lons)
    expect(dir).toBe('same')
  })
})

describe('snapOverlapSegment', () => {
  it('snaps second-pass points to first-pass coordinates', () => {
    const { lats, lons } = makeOutAndBack()
    const segment = {
      firstStart: 50, firstEnd: 150,
      secondStart: 250, secondEnd: 350,
    }
    const snaps = snapOverlapSegment(segment, lats, lons, 'opposite')
    expect(snaps.length).toBeGreaterThan(0)
    for (const s of snaps) {
      expect(s.distance).toBeLessThanOrEqual(15)
    }
  })
})

describe('snapOverlaps', () => {
  it('snaps out-and-back route and returns segment metadata', () => {
    const { lats, lons } = makeOutAndBack(200, 25)
    const result = snapOverlaps(lats, lons)
    expect(result.snapped).toBeGreaterThan(0)
    expect(result.segments.length).toBeGreaterThanOrEqual(1)
    for (const seg of result.segments) {
      expect(seg.direction).toBe('opposite')
      expect(seg.snapCount).toBeGreaterThan(0)
      expect(seg.firstRange).toHaveLength(2)
      expect(seg.secondRange).toHaveLength(2)
    }
  })

  it('produces identical coordinates on overlapping points after snap', () => {
    const { lats, lons } = makeOutAndBack(200, 25)
    const result = snapOverlaps(lats, lons)
    expect(result.snapped).toBeGreaterThan(0)

    // Verify that snapped second-pass points now exactly match some first-pass point
    // Check a sample of second-pass points from the first segment
    if (result.segments.length > 0) {
      const seg = result.segments[0]
      const [s2start, s2end] = seg.secondRange
      let matchCount = 0
      for (let i = s2start; i <= s2end; i++) {
        // Check if this point exactly matches any first-pass point
        const [f1start, f1end] = seg.firstRange
        for (let j = f1start; j <= f1end; j++) {
          if (lats[i] === lats[j] && lons[i] === lons[j]) {
            matchCount++
            break
          }
        }
      }
      expect(matchCount).toBeGreaterThan(0)
    }
  })

  it('returns zero snaps for one-way route', () => {
    const { lats, lons } = makeStraight()
    const result = snapOverlaps(lats, lons)
    expect(result.snapped).toBe(0)
    expect(result.segments).toEqual([])
  })

  it('preserves point count', () => {
    const { lats, lons } = makeOutAndBack()
    const originalLength = lats.length
    snapOverlaps(lats, lons)
    expect(lats.length).toBe(originalLength)
    expect(lons.length).toBe(originalLength)
  })

  it('ignores parallel roads beyond threshold', () => {
    const { lats, lons } = makeParallel(200, 25, 15)
    const result = snapOverlaps(lats, lons)
    expect(result.snapped).toBe(0)
  })

  it('snaps only the stem in a lollipop route', () => {
    const { lats, lons } = makeLollipop(100, 100, 25)
    const result = snapOverlaps(lats, lons)
    // Should find overlap in the stem portion only
    if (result.segments.length > 0) {
      for (const seg of result.segments) {
        // First range should be in stem (indices 0-99)
        expect(seg.firstRange[0]).toBeLessThan(100)
        expect(seg.firstRange[1]).toBeLessThan(100)
      }
    }
  })

  it('handles figure-8 crossing without false segment', () => {
    // Build a figure-8: two loops joined at a single crossing point
    const lats = [], lons = []
    const n = 200
    // First loop (north)
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * i) / n
      lats.push(46.001 + 0.002 * Math.sin(angle))
      lons.push(14.0 + 0.003 * Math.cos(angle))
    }
    // Second loop (south)
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * i) / n
      lats.push(45.999 + 0.002 * Math.sin(angle))
      lons.push(14.0 + 0.003 * Math.cos(angle))
    }
    const result = snapOverlaps(lats, lons)
    // Single-point crossing should be filtered by minSegmentPairs
    // Any detected segments should be very short (crossing area only)
    for (const seg of result.segments) {
      expect(seg.snapCount).toBeLessThan(20)
    }
  })
})
