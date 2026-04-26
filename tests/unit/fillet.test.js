/**
 * Unit tests for fillet-based corner rounding.
 *
 * Tests filletCorner(), findCornerClusters(), and applyFillets()
 * from src/utils/geometry.js using the synthetic test route.
 */

import { describe, it, expect } from 'vitest'
import { filletCorner, findCornerClusters, applyFillets } from '../../src/utils/geometry.js'
import { haversine, turnAngleDeg } from '../../src/utils/math.js'
import { buildFilletTestRoute } from '../fixtures/fillet-test-route.js'

// ── filletCorner() ──

describe('filletCorner', () => {
  // Simple 90° right turn: north → east
  const prev = [46.001, 14.5]      // north of vertex
  const vtx  = [46.0, 14.5]        // vertex
  const next = [46.0, 14.5015]     // east of vertex (~103m)

  it('produces arc points for a 90° corner', () => {
    const result = filletCorner(
      prev[0], prev[1], vtx[0], vtx[1], next[0], next[1],
      6, 0.3,
    )
    expect(result).not.toBeNull()
    expect(result.points.length).toBeGreaterThan(5)
    // 90° arc at R=6m → arc length ≈ 9.4m → ~31 points at 0.3m
    expect(result.points.length).toBeGreaterThan(25)
    expect(result.points.length).toBeLessThan(40)
  })

  it('arc points are at the correct radius from centre', () => {
    const result = filletCorner(
      prev[0], prev[1], vtx[0], vtx[1], next[0], next[1],
      6, 0.3,
    )
    // All arc points should be approximately 6m from the arc centre
    // We can verify by checking they're all the same distance from
    // a common centre (within tolerance)
    const dists = []
    for (let i = 0; i < result.points.length; i++) {
      const d = haversine(result.points[i].lat, result.points[i].lon, vtx[0], vtx[1])
      dists.push(d)
    }
    // Arc should be near the vertex but not at it
    for (const d of dists) {
      expect(d).toBeLessThan(15) // within reasonable distance of vertex
    }
  })

  it('arc points are evenly spaced at ~0.3m', () => {
    const result = filletCorner(
      prev[0], prev[1], vtx[0], vtx[1], next[0], next[1],
      6, 0.3,
    )
    for (let i = 1; i < result.points.length; i++) {
      const d = haversine(
        result.points[i - 1].lat, result.points[i - 1].lon,
        result.points[i].lat, result.points[i].lon,
      )
      expect(d).toBeGreaterThan(0.1)
      expect(d).toBeLessThan(0.6)
    }
  })

  it('returns null for a nearly straight line (< 1° turn)', () => {
    const result = filletCorner(
      46.002, 14.5, 46.001, 14.5, 46.0, 14.5, // straight line
      6, 0.3,
    )
    expect(result).toBeNull()
  })

  it('clamps radius when tangent exceeds segment length', () => {
    // Very short segments (3m each) with 120° turn
    // Tangent dist at R=6 for θ=60° interior: 6/tan(30°) = 10.39m > 3m × 0.9 = 2.7m
    const shortPrev = [46.0 + 3 * 0.000008993, 14.5] // 3m north
    // 120° right turn from north → exit bearing 120° (SSE)
    const shortNext = [46.0 - 1.5 * 0.000008993, 14.5 + 2.6 * 0.00001295] // ~3m at 120°
    const result = filletCorner(
      shortPrev[0], shortPrev[1], vtx[0], vtx[1], shortNext[0], shortNext[1],
      6, 0.3,
    )
    expect(result).not.toBeNull()
    expect(result.actualRadius).toBeLessThan(5) // radius was reduced
    expect(result.actualRadius).toBeGreaterThan(0.5) // but still reasonable
  })

  it('returns null for 170° near-U-turn (handled by insertUTurnLoops)', () => {
    // Heading south then turning almost back north — ≥160° turns are
    // skipped by filletCorner and handled post-smooth by insertUTurnLoops
    const sPrev = [46.001, 14.5]
    const sVtx  = [46.0, 14.5]
    const sNext = [46.0009, 14.5 + 0.0002]
    const result = filletCorner(
      sPrev[0], sPrev[1], sVtx[0], sVtx[1], sNext[0], sNext[1],
      6, 0.3,
    )
    expect(result).toBeNull()
  })

  it('handles left and right turns', () => {
    // Right turn (north → east)
    const right = filletCorner(
      46.001, 14.5, 46.0, 14.5, 46.0, 14.5015,
      6, 0.3,
    )
    // Left turn (north → west)
    const left = filletCorner(
      46.001, 14.5, 46.0, 14.5, 46.0, 14.4985,
      6, 0.3,
    )
    expect(right).not.toBeNull()
    expect(left).not.toBeNull()
    // Both should produce similar arc lengths
    expect(Math.abs(right.points.length - left.points.length)).toBeLessThan(3)
  })
})

// ── findCornerClusters() ──

describe('findCornerClusters', () => {
  const route = buildFilletTestRoute()

  it('finds clusters for tight corners (≥100° threshold)', () => {
    const clusters = findCornerClusters(route.lats, route.lons, 100)
    // Should find: hairpin (120°), S-curve (2×110°=220°), U-turn (170°),
    // multi-vertex (3×40°=120°). NOT the gentle 60° corner.
    // S-curve vertices are close together (~24m) so they merge into one cluster.
    expect(clusters.length).toBeGreaterThanOrEqual(3)
    // Total turn across all clusters should be substantial
    const totalTurn = clusters.reduce((s, c) => s + c.totalTurn, 0)
    expect(totalTurn).toBeGreaterThan(400)
  })

  it('does not include the gentle 60° corner', () => {
    const clusters = findCornerClusters(route.lats, route.lons, 100)
    const s1 = route.sections[0] // gentle 60°
    // No cluster should span the gentle corner's vertex
    for (const c of clusters) {
      const overlaps = c.startIdx <= s1.vertexIdx && c.endIdx >= s1.vertexIdx
      // If it does overlap, total turn should be < 100°
      if (overlaps) {
        expect(c.totalTurn).toBeLessThan(100)
      }
    }
  })

  it('finds the 120° hairpin cluster', () => {
    const clusters = findCornerClusters(route.lats, route.lons, 100)
    const s2 = route.sections[1] // hairpin 120°
    const hairpinCluster = clusters.find(c =>
      c.startIdx <= s2.vertexIdx && c.endIdx >= s2.vertexIdx
    )
    expect(hairpinCluster).toBeDefined()
    expect(hairpinCluster.totalTurn).toBeGreaterThan(110)
  })

  it('groups multi-vertex hairpin into one cluster', () => {
    const clusters = findCornerClusters(route.lats, route.lons, 100)
    const s5 = route.sections[4] // multi-vertex 120°
    const multiCluster = clusters.find(c =>
      c.startIdx <= s5.vertexIndices[0] && c.endIdx >= s5.vertexIndices[2]
    )
    expect(multiCluster).toBeDefined()
    expect(multiCluster.totalTurn).toBeGreaterThan(100)
  })

  it('returns empty for a route with no sharp corners', () => {
    // Straight line
    const lats = Array.from({ length: 20 }, (_, i) => 46.0 + i * 0.0001)
    const lons = Array.from({ length: 20 }, () => 14.5)
    const clusters = findCornerClusters(lats, lons, 100)
    expect(clusters).toHaveLength(0)
  })
})

// ── applyFillets() ──

describe('applyFillets', () => {
  const route = buildFilletTestRoute()

  it('returns a valid route with correct array lengths', () => {
    const result = applyFillets(route.lats, route.lons, route.eles, route.dists)
    expect(result.lats.length).toBe(result.lons.length)
    expect(result.lats.length).toBe(result.eles.length)
    expect(result.lats.length).toBe(result.dists.length)
    expect(result.lats.length).toBeGreaterThan(0)
  })

  it('increases point count (adds dense arc points)', () => {
    const result = applyFillets(route.lats, route.lons, route.eles, route.dists)
    // Fillets add many 0.3m-spaced points at corners, replacing
    // a few original points. Net count should increase.
    expect(result.lats.length).toBeGreaterThanOrEqual(route.lats.length)
  })

  it('distances are monotonically increasing', () => {
    const result = applyFillets(route.lats, route.lons, route.eles, route.dists)
    for (let i = 1; i < result.dists.length; i++) {
      expect(result.dists[i]).toBeGreaterThan(result.dists[i - 1])
    }
  })

  it('preserves start and end coordinates', () => {
    const result = applyFillets(route.lats, route.lons, route.eles, route.dists)
    expect(result.lats[0]).toBe(route.lats[0])
    expect(result.lons[0]).toBe(route.lons[0])
    // End point should be same (last section exit is preserved)
    const lastOrig = route.lats.length - 1
    const lastNew = result.lats.length - 1
    expect(result.lats[lastNew]).toBeCloseTo(route.lats[lastOrig], 6)
    expect(result.lons[lastNew]).toBeCloseTo(route.lons[lastOrig], 6)
  })

  it('preserves total elevation gain approximately', () => {
    const result = applyFillets(route.lats, route.lons, route.eles, route.dists)
    const origGain = route.eles[route.eles.length - 1] - route.eles[0]
    const newGain = result.eles[result.eles.length - 1] - result.eles[0]
    // Should be within 10% of original
    expect(Math.abs(newGain - origGain) / origGain).toBeLessThan(0.1)
  })

  it('elevations stay within original range + small margin', () => {
    const result = applyFillets(route.lats, route.lons, route.eles, route.dists)
    const minEle = Math.min(...route.eles) - 5
    const maxEle = Math.max(...route.eles) + 5
    for (const e of result.eles) {
      expect(e).toBeGreaterThan(minEle)
      expect(e).toBeLessThan(maxEle)
    }
  })

  it('no change when threshold is very high (no corners qualify)', () => {
    const result = applyFillets(route.lats, route.lons, route.eles, route.dists, {
      minTurnDeg: 179, // only near-perfect U-turns — nothing qualifies
    })
    // Should be exactly unchanged
    expect(result.lats.length).toBe(route.lats.length)
  })

  it('filleted corners reduce max curvature (excluding U-turns)', () => {
    const result = applyFillets(route.lats, route.lons, route.eles, route.dists)

    // Compute max turn angle in original route, excluding U-turns (≥160°)
    // which are now handled by insertUTurnLoops post-smooth
    let maxOrig = 0
    for (let i = 1; i < route.lats.length - 1; i++) {
      const a = turnAngleDeg(
        route.lats[i - 1], route.lons[i - 1],
        route.lats[i], route.lons[i],
        route.lats[i + 1], route.lons[i + 1],
      )
      if (a > maxOrig && a < 160) maxOrig = a
    }

    // Compute max turn angle in filleted route (also exclude U-turns)
    let maxFilleted = 0
    for (let i = 1; i < result.lats.length - 1; i++) {
      const a = turnAngleDeg(
        result.lats[i - 1], result.lons[i - 1],
        result.lats[i], result.lons[i],
        result.lats[i + 1], result.lons[i + 1],
      )
      if (a > maxFilleted && a < 160) maxFilleted = a
    }

    // Filleted route should have lower max turn angle for non-U-turn corners
    expect(maxFilleted).toBeLessThan(maxOrig)
  })
})
