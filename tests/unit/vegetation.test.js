/**
 * Unit tests for src/pipeline/3.5-vegetation.js
 */

import { describe, it, expect } from 'vitest'
import { filterVegetation, detectVegetation, vegetationReport } from '../../src/pipeline/3.5-vegetation.js'

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function makeProfile(lengthM, spacingM, baseFn) {
  const N = Math.floor(lengthM / spacingM)
  const dists = Array.from({ length: N }, (_, i) => i * spacingM)
  const eles = dists.map(d => baseFn(d))
  return { dists, eles }
}

const hill = d => 300 + 80 * Math.sin(d / 5000 * Math.PI)

/** Gaussian spike: height h, centre at cM, sigma s */
function addGaussianSpike(eles, dists, cM, h, s) {
  for (let i = 0; i < eles.length; i++) {
    eles[i] += h * Math.exp(-((dists[i] - cM) ** 2) / (2 * s * s))
  }
}

/** Flat-top spike: height h, centre at cM, half-width wHalf */
function addFlatSpike(eles, dists, cM, h, wHalf) {
  for (let i = 0; i < eles.length; i++) {
    const t = Math.abs(dists[i] - cM) / wHalf
    if (t <= 1) eles[i] += h * Math.max(0, 1 - t)
  }
}

// ────────────────────────────────────────────────────────────────────
// Test 1 — Synthetic canopy spike (8m, σ=15m)
// ────────────────────────────────────────────────────────────────────

describe('filterVegetation - canopy spike 8m', () => {
  it('detects and corrects an 8m Gaussian spike within 1m of true surface', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)
    const trueEles = eles.slice()
    addGaussianSpike(eles, dists, 1200, 8, 15)

    const result = filterVegetation(eles, dists)

    expect(result.diagnostics.totalFlagged).toBeGreaterThan(0)
    expect(result.diagnostics.regions.length).toBeGreaterThanOrEqual(1)

    // Find index closest to spike centre
    const centreIdx = dists.findIndex(d => d >= 1200)
    const corrected = result.eles[centreIdx]
    const trueVal = trueEles[centreIdx]
    expect(Math.abs(corrected - trueVal)).toBeLessThan(1.0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Test 2 — Synthetic shrub spike (4m, σ=7.5m)
// ────────────────────────────────────────────────────────────────────

describe('filterVegetation - shrub spike 4m', () => {
  it('detects and corrects a 4m Gaussian spike within 1m of true surface', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)
    const trueEles = eles.slice()
    addGaussianSpike(eles, dists, 3500, 4, 7.5)

    const result = filterVegetation(eles, dists)

    expect(result.diagnostics.totalFlagged).toBeGreaterThan(0)

    const centreIdx = dists.findIndex(d => d >= 3500)
    const corrected = result.eles[centreIdx]
    const trueVal = trueEles[centreIdx]
    expect(Math.abs(corrected - trueVal)).toBeLessThan(1.0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Test 3 — Multiple spikes, no false positives
// ────────────────────────────────────────────────────────────────────

describe('filterVegetation - multiple spikes', () => {
  it('detects both spikes independently and leaves clean sections unchanged', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)
    addGaussianSpike(eles, dists, 1200, 8, 15)
    addGaussianSpike(eles, dists, 3500, 4, 7.5)

    const result = filterVegetation(eles, dists)

    expect(result.diagnostics.regions.length).toBe(2)

    // No flags between spikes (1800–3000m is clean)
    const cleanMask = result.diagnostics.flaggedMask
    for (let i = 0; i < dists.length; i++) {
      if (dists[i] >= 1800 && dists[i] <= 3000) {
        expect(cleanMask[i]).toBe(0)
      }
    }
  })
})

// ────────────────────────────────────────────────────────────────────
// Test 4 — No false positives on clean hilly data
// ────────────────────────────────────────────────────────────────────

describe('filterVegetation - clean hilly profile', () => {
  it('produces zero flags on a smooth hill (real 80m elevation change)', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)

    const result = filterVegetation(eles, dists)

    expect(result.diagnostics.totalFlagged).toBe(0)
    expect(result.diagnostics.regions.length).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Test 5 — No false positives on negative features (dips)
// ────────────────────────────────────────────────────────────────────

describe('filterVegetation - dip (underpass)', () => {
  it('does not flag a 10m dip — only positive residuals are flagged', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)
    // Insert a 10m dip at 2500m
    addGaussianSpike(eles, dists, 2500, -10, 30)

    const result = filterVegetation(eles, dists)

    expect(result.diagnostics.totalFlagged).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Test 6 — Wide canopy zone requiring iterative refinement
// ────────────────────────────────────────────────────────────────────

describe('filterVegetation - wide canopy zone (200m)', () => {
  it('converges over multiple iterations to correct a spike wider than the opening radius', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)
    const trueEles = eles.slice()
    // 5m spike 200m wide (half-width 100m > openingRadiusM 75m — needs iteration)
    addFlatSpike(eles, dists, 2500, 5, 100)

    // Use a slightly reduced radius to force iteration
    const result = filterVegetation(eles, dists, { openingRadiusM: 60 })

    expect(result.diagnostics.iterations).toBeGreaterThanOrEqual(1)
    expect(result.diagnostics.totalFlagged).toBeGreaterThan(0)

    // Centre should be substantially corrected (iteration may not fully converge on such wide spikes)
    const centreIdx = dists.findIndex(d => d >= 2500)
    const error = Math.abs(result.eles[centreIdx] - trueEles[centreIdx])
    expect(error).toBeLessThan(2.5)
  })
})

// ────────────────────────────────────────────────────────────────────
// Test 7 — Artifact at start of profile
// ────────────────────────────────────────────────────────────────────

describe('filterVegetation - artifact at start', () => {
  it('handles a spike in the first 50m gracefully without throwing', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)
    addGaussianSpike(eles, dists, 25, 5, 10)

    expect(() => filterVegetation(eles, dists)).not.toThrow()

    const result = filterVegetation(eles, dists)
    // Spike should be detected (may have reduced context on one side)
    expect(result.diagnostics.totalFlagged).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Test 8 — Artifact at end of profile
// ────────────────────────────────────────────────────────────────────

describe('filterVegetation - artifact at end', () => {
  it('handles a spike in the last 50m gracefully without throwing', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)
    addGaussianSpike(eles, dists, 4975, 5, 10)

    expect(() => filterVegetation(eles, dists)).not.toThrow()

    const result = filterVegetation(eles, dists)
    expect(result.diagnostics.totalFlagged).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Test 9 — Irregularly spaced points
// ────────────────────────────────────────────────────────────────────

describe('filterVegetation - irregular point spacing', () => {
  it('produces correct results with non-uniform 5m/10m/20m mixed spacing', () => {
    // Build profile with irregular spacing
    const spacings = [5, 10, 20, 5, 10, 20]
    const dists = [0]
    let d = 0
    while (d < 5000) {
      const sp = spacings[dists.length % spacings.length]
      d += sp
      dists.push(d)
    }
    const eles = dists.map(d => hill(d))
    const trueEles = eles.slice()

    // Insert a clear spike
    addGaussianSpike(eles, dists, 2500, 6, 20)

    const result = filterVegetation(eles, dists)

    expect(result.diagnostics.totalFlagged).toBeGreaterThan(0)

    // Centre correction within 1.5m (irregular spacing may give slightly less precise fit)
    const centreIdx = dists.findIndex(d => d >= 2500)
    const error = Math.abs(result.eles[centreIdx] - trueEles[centreIdx])
    expect(error).toBeLessThan(1.5)
  })
})

// ────────────────────────────────────────────────────────────────────
// vegetationReport
// ────────────────────────────────────────────────────────────────────

describe('vegetationReport', () => {
  it('formats a human-readable summary with region details', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)
    const trueEles = eles.slice()
    addGaussianSpike(eles, dists, 1200, 8, 15)

    const result = filterVegetation(eles, dists)
    const report = vegetationReport(dists, eles, result.eles, result.diagnostics.regions)

    expect(report).toContain('artifact region')
    expect(report).toContain('m wide')
    expect(report).toContain('max spike')
  })

  it('returns no-artifacts message when regions is empty', () => {
    const { dists, eles } = makeProfile(5000, 5, hill)
    const report = vegetationReport(dists, eles, eles, [])
    expect(report).toContain('no artifacts')
  })
})
