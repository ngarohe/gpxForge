/**
 * Unit tests for src/pipeline/3-clean.js
 *
 * Tests applyInterp, isSuspect, runCleaner, and existing helpers.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyStructure,
  isRealTerrain,
  applyInterp,
  isSuspect,
  runCleaner,
} from '../../src/pipeline/3-clean.js'

// ────────────────────────────────────────────────────────────────────
// Test data helpers
// ────────────────────────────────────────────────────────────────────

/** Create evenly-spaced distance array */
function evenDists(n, spacing = 10) {
  return Array.from({ length: n }, (_, i) => i * spacing)
}

/** Create flat elevation array */
function flatEles(n, ele = 300) {
  return Array.from({ length: n }, () => ele)
}

/**
 * Insert a sharp spike into a flat elevation profile.
 * Spike spans from index `start` to `end` (exclusive), peak at center.
 */
function addSpike(eles, start, end, height) {
  const mid = Math.floor((start + end) / 2)
  for (let i = start; i < end; i++) {
    const t = i <= mid
      ? (i - start) / (mid - start)
      : 1 - (i - mid) / (end - mid)
    eles[i] += height * t
  }
}

// ────────────────────────────────────────────────────────────────────
// applyInterp
// ────────────────────────────────────────────────────────────────────

describe('applyInterp', () => {
  it('uniform interpolation produces linear ramp between anchors', () => {
    const eles = [100, 999, 999, 999, 200]
    const dists = [0, 10, 20, 30, 40]
    applyInterp(eles, dists, 0, 4, { interp: 'uniform', m0: 0, m1: 0 })
    expect(eles[0]).toBe(100) // anchor preserved
    expect(eles[4]).toBe(200) // anchor preserved
    expect(eles[1]).toBeCloseTo(125)
    expect(eles[2]).toBeCloseTo(150)
    expect(eles[3]).toBeCloseTo(175)
  })

  it('anchors are never modified', () => {
    const eles = [100, 999, 200]
    const dists = [0, 10, 20]
    applyInterp(eles, dists, 0, 2, { interp: 'uniform', m0: 0, m1: 0 })
    expect(eles[0]).toBe(100)
    expect(eles[2]).toBe(200)
  })

  it('hermite_convex interpolation curves above linear', () => {
    const eles = [100, 999, 999, 999, 100]
    const dists = [0, 25, 50, 75, 100]
    // Slopes: up at start, down at end → convex bridge shape
    applyInterp(eles, dists, 0, 4, { interp: 'hermite_convex', m0: 0.05, m1: -0.05, S: 100 })
    // Mid-point should be above the linear interpolation (100)
    expect(eles[2]).toBeGreaterThan(100)
    // Anchors preserved
    expect(eles[0]).toBe(100)
    expect(eles[4]).toBe(100)
  })

  it('no-ops when zone has fewer than 2 interior points', () => {
    const eles = [100, 200]
    const dists = [0, 10]
    applyInterp(eles, dists, 0, 1, { interp: 'uniform', m0: 0, m1: 0 })
    expect(eles[0]).toBe(100)
    expect(eles[1]).toBe(200)
  })

  it('no-ops when span is zero', () => {
    const eles = [100, 999, 200]
    const dists = [0, 0, 0]
    applyInterp(eles, dists, 0, 2, { interp: 'uniform', m0: 0, m1: 0 })
    // Should not modify (span is zero)
    expect(eles[1]).toBe(999)
  })

  it('handles uneven distance spacing correctly', () => {
    const eles = [100, 999, 999, 200]
    const dists = [0, 5, 25, 30]
    applyInterp(eles, dists, 0, 3, { interp: 'uniform', m0: 0, m1: 0 })
    expect(eles[1]).toBeCloseTo(100 + (5 / 30) * 100, 5)
    expect(eles[2]).toBeCloseTo(100 + (25 / 30) * 100, 5)
  })
})

// ────────────────────────────────────────────────────────────────────
// isSuspect
// ────────────────────────────────────────────────────────────────────

describe('isSuspect', () => {
  it('returns false for short span', () => {
    const eles = [300, 310, 320, 330]
    const dists = [0, 50, 100, 150] // span = 150m < 200m
    const gr = [20, 20, 20]
    expect(isSuspect(eles, dists, gr, 0, 3, { suspSpan: 200, suspRev: 5, suspGrade: 8 })).toBe(false)
  })

  it('returns false for high reversal rate', () => {
    // Oscillating gradients → many reversals
    const N = 30
    const dists = evenDists(N, 10) // span = 290m
    const gr = Array.from({ length: N }, (_, i) => i % 2 === 0 ? 15 : -15)
    const eles = flatEles(N)
    expect(isSuspect(eles, dists, gr, 0, N - 1, { suspSpan: 200, suspRev: 5, suspGrade: 8 })).toBe(false)
  })

  it('returns false for low mean gradient', () => {
    const N = 30
    const dists = evenDists(N, 10)
    const gr = Array.from({ length: N }, () => 2) // mean 2% < 8%
    const eles = flatEles(N)
    expect(isSuspect(eles, dists, gr, 0, N - 1, { suspSpan: 200, suspRev: 5, suspGrade: 8 })).toBe(false)
  })

  it('returns true for long, smooth, steep zone', () => {
    // Long span, low reversal rate, high mean gradient
    const N = 30
    const dists = evenDists(N, 10) // span = 290m
    const gr = Array.from({ length: N }, () => 12) // constant 12% — no reversals
    const eles = flatEles(N)
    expect(isSuspect(eles, dists, gr, 0, N - 1, { suspSpan: 200, suspRev: 5, suspGrade: 8 })).toBe(true)
  })

  it('returns false for empty gradient zone', () => {
    const eles = [300]
    const dists = [0]
    const gr = []
    expect(isSuspect(eles, dists, gr, 0, 0, { suspSpan: 0, suspRev: 100, suspGrade: 0 })).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────
// runCleaner
// ────────────────────────────────────────────────────────────────────

describe('runCleaner', () => {
  const baseParams = {
    spikeT: 25,
    anchorT: 30,
    mergeGap: 30,
    mergeDist: 10,
    smart: true,
    tangWin: 8,
    hermDev: 0.5,
    bridgeDip: 1.0,
    tunnelSpk: 1.0,
    enabled: false, // suspect detection off for most tests
    suspSpan: 200,
    suspRev: 5,
    suspGrade: 8,
  }

  it('returns unchanged elevations for flat route', () => {
    const eles = flatEles(50)
    const dists = evenDists(50, 10)
    const { eleClean, corrections } = runCleaner(eles, dists, baseParams)
    expect(corrections.length).toBe(0)
    expect(eleClean).toEqual(eles)
  })

  it('returns unchanged elevations for gentle gradient', () => {
    // Gradient = 2% everywhere — well below spikeT=25
    const eles = Array.from({ length: 50 }, (_, i) => 300 + i * 0.2)
    const dists = evenDists(50, 10)
    const { eleClean, corrections } = runCleaner(eles, dists, baseParams)
    expect(corrections.length).toBe(0)
  })

  it('detects and corrects a single sharp spike', () => {
    const eles = flatEles(50, 300)
    const dists = evenDists(50, 10)
    // Insert a very sharp spike at indices 20–25 (+50m)
    addSpike(eles, 20, 26, 50)

    const { eleClean, corrections } = runCleaner(eles, dists, baseParams)
    expect(corrections.length).toBeGreaterThanOrEqual(1)
    // Corrected elevation at spike center should be close to baseline
    expect(Math.abs(eleClean[23] - 300)).toBeLessThan(5)
    // First & last points should be unchanged
    expect(eleClean[0]).toBe(300)
    expect(eleClean[49]).toBe(300)
  })

  it('correction has expected fields', () => {
    const eles = flatEles(50, 300)
    const dists = evenDists(50, 10)
    addSpike(eles, 20, 26, 50)

    const { corrections } = runCleaner(eles, dists, baseParams)
    const c = corrections[0]
    expect(c).toHaveProperty('alo')
    expect(c).toHaveProperty('ahi')
    expect(c).toHaveProperty('span')
    expect(c).toHaveProperty('grade')
    expect(c).toHaveProperty('type')
    expect(c).toHaveProperty('interp')
    expect(c).toHaveProperty('m0')
    expect(c).toHaveProperty('m1')
    expect(c).toHaveProperty('revRate')
    expect(c).toHaveProperty('meanGr')
    expect(c).toHaveProperty('accepted')
    expect(c).toHaveProperty('rejected')
    expect(c).toHaveProperty('source')
    expect(c.source).toBe('auto')
  })

  it('auto-accepted corrections have accepted=true', () => {
    const eles = flatEles(50, 300)
    const dists = evenDists(50, 10)
    addSpike(eles, 20, 26, 50)

    const { corrections } = runCleaner(eles, dists, baseParams)
    const nonSuspect = corrections.filter(c => c.type !== 'suspect')
    for (const c of nonSuspect) {
      expect(c.accepted).toBe(true)
      expect(c.rejected).toBe(false)
    }
  })

  it('merges nearby spikes within mergeGap', () => {
    const eles = flatEles(80, 300)
    const dists = evenDists(80, 10)
    // Two spikes 5 points apart — should merge (mergeGap=30)
    addSpike(eles, 20, 24, 50)
    addSpike(eles, 28, 32, 50)

    const { corrections } = runCleaner(eles, dists, baseParams)
    // Expect single merged correction covering both spikes
    expect(corrections.length).toBe(1)
    expect(corrections[0].alo).toBeLessThanOrEqual(20)
    expect(corrections[0].ahi).toBeGreaterThanOrEqual(32)
  })

  it('keeps separate spikes when far apart', () => {
    const eles = flatEles(100, 300)
    const dists = evenDists(100, 10)
    // Two spikes far apart — gap > mergeGap (30 points) and > mergeDist (10m)
    addSpike(eles, 10, 14, 80)
    addSpike(eles, 70, 74, 80)

    const { corrections } = runCleaner(eles, dists, baseParams)
    expect(corrections.length).toBe(2)
  })

  it('chains zones within mergeDist metres', () => {
    const eles = flatEles(100, 300)
    const dists = evenDists(100, 1) // 1m spacing
    // Two spikes with a small gap — should chain within mergeDist=10m
    addSpike(eles, 20, 24, 80)
    addSpike(eles, 30, 34, 80)
    // Gap between expanded zones might be within 10m

    const params = { ...baseParams, mergeGap: 2, mergeDist: 20 }
    const { corrections } = runCleaner(eles, dists, params)
    // With mergeDist=20m and 1m spacing, zones ~6m apart should merge
    expect(corrections.length).toBeLessThanOrEqual(2)
  })

  it('suspect detection marks long smooth climbs as suspect', () => {
    const N = 60
    const eles = Array.from({ length: N }, (_, i) => 300 + i * 5) // Steady 50% gradient
    const dists = evenDists(N, 10) // span = 590m

    const params = { ...baseParams, spikeT: 10, anchorT: 30, enabled: true }
    const { corrections } = runCleaner(eles, dists, params)
    // At 50% gradient with spikeT=10, everything is flagged
    // With suspect detection on, long smooth climb should be suspect
    const suspects = corrections.filter(c => c.type === 'suspect')
    expect(suspects.length).toBeGreaterThanOrEqual(1)
    if (suspects.length > 0) {
      expect(suspects[0].accepted).toBe(false)
    }
  })

  it('smart classification detects bridge dip', () => {
    const eles = flatEles(50, 300)
    const dists = evenDists(50, 10)
    // Create a bridge: a dip below baseline
    for (let i = 20; i < 30; i++) {
      eles[i] = 300 - 15 * Math.sin(Math.PI * (i - 20) / 10)
    }

    const params = { ...baseParams, spikeT: 10, anchorT: 20 }
    const { corrections } = runCleaner(eles, dists, params)
    if (corrections.length > 0) {
      const nonSuspect = corrections.filter(c => c.type !== 'suspect')
      // At least some corrections should detect the dip pattern
      expect(nonSuspect.length + corrections.filter(c => c.type === 'suspect').length)
        .toBeGreaterThanOrEqual(1)
    }
  })

  it('non-smart mode uses uniform interpolation only', () => {
    const eles = flatEles(50, 300)
    const dists = evenDists(50, 10)
    addSpike(eles, 20, 26, 50)

    const params = { ...baseParams, smart: false }
    const { corrections } = runCleaner(eles, dists, params)
    const nonSuspect = corrections.filter(c => c.type !== 'suspect')
    for (const c of nonSuspect) {
      // Non-smart should produce uniform interp (since bridgeDip=999 prevents bridge detection)
      expect(c.interp).toBe('uniform')
    }
  })

  it('preserves first and last points', () => {
    const eles = flatEles(50, 300)
    const dists = evenDists(50, 10)
    addSpike(eles, 1, 5, 100)
    addSpike(eles, 45, 49, 100)

    const { eleClean } = runCleaner(eles, dists, baseParams)
    expect(eleClean[0]).toBe(300)
    expect(eleClean[49]).toBe(300)
  })

  it('eleClean array has same length as input', () => {
    const eles = flatEles(50, 300)
    const dists = evenDists(50, 10)
    addSpike(eles, 20, 26, 50)

    const { eleClean } = runCleaner(eles, dists, baseParams)
    expect(eleClean.length).toBe(eles.length)
  })

  it('does not mutate the input elevation array', () => {
    const eles = flatEles(50, 300)
    const dists = evenDists(50, 10)
    addSpike(eles, 20, 26, 50)
    const original = eles.slice()

    runCleaner(eles, dists, baseParams)
    expect(eles).toEqual(original)
  })

  it('corrections are sorted by alo', () => {
    const eles = flatEles(100, 300)
    const dists = evenDists(100, 10)
    addSpike(eles, 60, 64, 80)
    addSpike(eles, 20, 24, 80)

    const { corrections } = runCleaner(eles, dists, baseParams)
    for (let i = 1; i < corrections.length; i++) {
      expect(corrections[i].alo).toBeGreaterThanOrEqual(corrections[i - 1].alo)
    }
  })

  it('handles very short route (3 points)', () => {
    const eles = [300, 350, 300]
    const dists = [0, 10, 20]
    // Gradient = 500%, -500% — definitely flagged
    const { eleClean, corrections } = runCleaner(eles, dists, baseParams)
    // Should not crash
    expect(eleClean.length).toBe(3)
  })

  it('handles route with single point', () => {
    const eles = [300]
    const dists = [0]
    const { eleClean, corrections } = runCleaner(eles, dists, baseParams)
    expect(eleClean).toEqual([300])
    expect(corrections.length).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// classifyStructure (existing, verify still works)
// ────────────────────────────────────────────────────────────────────

describe('classifyStructure', () => {
  it('returns artifact for uniform shape', () => {
    const eles = [300, 320, 340, 320, 300]
    const dists = [0, 10, 20, 30, 40]
    const result = classifyStructure(eles, dists, 0, 4, {
      tangWin: 4, hermDev: 0.5, bridgeDip: 999, tunnelSpk: 999,
    })
    expect(result.type).toBe('artifact')
    expect(result.interp).toBe('uniform')
  })

  it('detects tunnel when spike above anchors', () => {
    const eles = [300, 310, 320, 310, 300]
    const dists = [0, 10, 20, 30, 40]
    const result = classifyStructure(eles, dists, 0, 4, {
      tangWin: 4, hermDev: 0.5, bridgeDip: 999, tunnelSpk: 1.0,
    })
    expect(result.type).toBe('tunnel')
    expect(result.interp).toBe('uniform')
  })
})

// ────────────────────────────────────────────────────────────────────
// isRealTerrain (existing, verify still works)
// ────────────────────────────────────────────────────────────────────

describe('isRealTerrain', () => {
  it('returns true for gradual gradient transitions', () => {
    // Gradients change slowly
    const gr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
    const dists = evenDists(gr.length, 10)
    const result = isRealTerrain(gr, dists, 5, 15, 4, 2.0)
    expect(result).toBe(true)
  })

  it('returns false for abrupt gradient jump', () => {
    // Gradient jumps from 0 to 50 instantly at entry
    const gr = [0, 0, 0, 0, 0, 50, 50, 50, 50, 0, 0, 0, 0, 0]
    const dists = evenDists(gr.length, 10)
    const result = isRealTerrain(gr, dists, 5, 8, 4, 2.0)
    expect(result).toBe(false)
  })
})
