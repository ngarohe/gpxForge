import { describe, it, expect } from 'vitest'
import { runSourceAwareDipSmoothing } from '../../src/pipeline/3.6-source-dip-smooth.js'

function buildSyntheticDip() {
  const dists = []
  const eles = []
  for (let i = 0; i <= 40; i++) {
    dists.push(i)
    eles.push(100 + i * 0.02)
  }
  for (let i = 15; i <= 25; i++) {
    const t = (i - 15) / 10
    const shape = 1 - Math.abs(2 * t - 1) // triangle: 0 -> 1 -> 0
    eles[i] -= 2.2 * shape
  }
  return { dists, eles }
}

describe('runSourceAwareDipSmoothing', () => {
  it('skips unsupported source tags', () => {
    const { dists, eles } = buildSyntheticDip()
    const out = runSourceAwareDipSmoothing(eles, dists, {
      enabled: true,
      source: 'FR_WCS',
    })
    expect(out.diagnostics.applied).toBe(false)
    expect(out.diagnostics.reason).toBe('unsupported_source')
    expect(out.eles).toEqual(eles)
  })

  it('smooths synthetic MDT02 dip candidates', () => {
    const { dists, eles } = buildSyntheticDip()
    const beforeMin = Math.min(...eles.slice(15, 26))
    const out = runSourceAwareDipSmoothing(eles, dists, {
      enabled: true,
      source: 'ES_MDT02_LOCAL',
    })
    const afterMin = Math.min(...out.eles.slice(15, 26))
    expect(out.diagnostics.applied).toBe(true)
    expect(out.diagnostics.profile).toBe('MDT02')
    expect(out.diagnostics.pointsAdjusted).toBeGreaterThan(0)
    expect(afterMin).toBeGreaterThan(beforeMin)
  })

  it('respects brunnel mask exclusions', () => {
    const { dists, eles } = buildSyntheticDip()
    const mask = new Uint8Array(eles.length)
    for (let i = 14; i <= 26; i++) mask[i] = 1
    const out = runSourceAwareDipSmoothing(eles, dists, {
      enabled: true,
      source: 'ES_MDT02_LOCAL',
      brunnelMask: mask,
    })
    expect(out.diagnostics.applied).toBe(false)
    expect(out.diagnostics.reason).toBe('no_candidates')
    expect(out.eles).toEqual(eles)
  })
})

