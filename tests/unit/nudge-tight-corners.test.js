import { describe, it, expect } from 'vitest'
import { circumscribedRadius3, nudgeTightCorners } from '../../src/utils/geometry.js'
import { haversine } from '../../src/utils/math.js'

const DEG2RAD = Math.PI / 180
const R_EARTH = 6371000

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a straight route heading north at even spacing. */
function buildStraightRoute(nPts = 100, spacingM = 2) {
  const lat0 = 46.0
  const lon0 = 14.5
  const mPerDegLat = R_EARTH * DEG2RAD

  const lats = [], lons = [], dists = [0]
  for (let i = 0; i < nPts; i++) {
    lats.push(lat0 + (i * spacingM) / mPerDegLat)
    lons.push(lon0)
    if (i > 0) dists.push(dists[i - 1] + spacingM)
  }
  return { lats, lons, dists }
}

/**
 * Build a route with a tight hairpin (approach north → exit south).
 * Uses even spacing throughout so circumscribed radius is well-defined.
 */
function buildHairpinRoute(spacingM = 2, radiusM = 3) {
  const lat0 = 46.0
  const lon0 = 14.5
  const cosLat = Math.cos(lat0 * DEG2RAD)
  const mPerDegLat = R_EARTH * DEG2RAD
  const mPerDegLon = mPerDegLat * cosLat

  const lats = [], lons = [], dists = [0]

  // Approach: straight north for 60m
  const nApproach = Math.floor(60 / spacingM)
  for (let i = 0; i < nApproach; i++) {
    lats.push(lat0 + (i * spacingM) / mPerDegLat)
    lons.push(lon0)
    if (i > 0) dists.push(dists[i - 1] + spacingM)
  }

  // Hairpin: semicircle turning 180° at the given radius
  const centerLat = lats[lats.length - 1]
  const centerLon = lon0 + radiusM / mPerDegLon
  const nArcPts = Math.max(6, Math.ceil((Math.PI * radiusM) / spacingM))
  for (let k = 0; k <= nArcPts; k++) {
    const angle = Math.PI - (k / nArcPts) * Math.PI // π → 0
    const lat = centerLat + radiusM * Math.sin(angle) / mPerDegLat
    const lon = centerLon + radiusM * Math.cos(angle) / mPerDegLon
    lats.push(lat)
    lons.push(lon)
    const d = haversine(lats[lats.length - 2], lons[lons.length - 2], lat, lon)
    dists.push(dists[dists.length - 1] + d)
  }

  // Exit: straight south for 60m
  const lastLat = lats[lats.length - 1]
  const lastLon = lons[lons.length - 1]
  const nExit = Math.floor(60 / spacingM)
  for (let i = 1; i <= nExit; i++) {
    lats.push(lastLat - (i * spacingM) / mPerDegLat)
    lons.push(lastLon)
    dists.push(dists[dists.length - 1] + spacingM)
  }

  return { lats, lons, dists }
}

/**
 * Build a route with a 90° right turn at a small radius.
 * Approach east → exit south.
 */
function build90DegreeTurn(spacingM = 2, radiusM = 5) {
  const lat0 = 46.0
  const lon0 = 14.5
  const cosLat = Math.cos(lat0 * DEG2RAD)
  const mPerDegLat = R_EARTH * DEG2RAD
  const mPerDegLon = mPerDegLat * cosLat

  const lats = [], lons = [], dists = [0]

  // Approach: straight east for 60m
  const nApproach = Math.floor(60 / spacingM)
  for (let i = 0; i < nApproach; i++) {
    lats.push(lat0)
    lons.push(lon0 + (i * spacingM) / mPerDegLon)
    if (i > 0) dists.push(dists[i - 1] + spacingM)
  }

  // 90° arc (quarter circle) turning from east to south
  const centerLat = lats[lats.length - 1] - radiusM / mPerDegLat
  const centerLon = lons[lons.length - 1]
  const nArcPts = Math.max(4, Math.ceil((Math.PI / 2 * radiusM) / spacingM))
  for (let k = 0; k <= nArcPts; k++) {
    const angle = Math.PI / 2 - (k / nArcPts) * (Math.PI / 2) // π/2 → 0
    const lat = centerLat + radiusM * Math.sin(angle) / mPerDegLat
    const lon = centerLon + radiusM * Math.cos(angle) / mPerDegLon
    lats.push(lat)
    lons.push(lon)
    const d = haversine(lats[lats.length - 2], lons[lons.length - 2], lat, lon)
    dists.push(dists[dists.length - 1] + d)
  }

  // Exit: straight south for 60m
  const lastLat = lats[lats.length - 1]
  const lastLon = lons[lons.length - 1]
  const nExit = Math.floor(60 / spacingM)
  for (let i = 1; i <= nExit; i++) {
    lats.push(lastLat - (i * spacingM) / mPerDegLat)
    lons.push(lastLon)
    dists.push(dists[dists.length - 1] + spacingM)
  }

  return { lats, lons, dists }
}

/** Build a gentle curve with large radius (~50m). */
function buildGentleCurve(radiusM = 50, spacingM = 2) {
  const lat0 = 46.0
  const lon0 = 14.5
  const cosLat = Math.cos(lat0 * DEG2RAD)
  const mPerDegLat = R_EARTH * DEG2RAD
  const mPerDegLon = mPerDegLat * cosLat

  const lats = [], lons = [], dists = [0]

  // 90° arc at large radius
  const nPts = Math.ceil((Math.PI / 2 * radiusM) / spacingM)
  for (let k = 0; k <= nPts; k++) {
    const angle = (k / nPts) * (Math.PI / 2)
    lats.push(lat0 + radiusM * Math.sin(angle) / mPerDegLat)
    lons.push(lon0 + radiusM * (1 - Math.cos(angle)) / mPerDegLon)
    if (k > 0) {
      const d = haversine(lats[k - 1], lons[k - 1], lats[k], lons[k])
      dists.push(dists[k - 1] + d)
    }
  }

  return { lats, lons, dists }
}

// ── circumscribedRadius3 ───────────────────────────────────────────

describe('circumscribedRadius3', () => {
  it('returns Infinity for collinear points', () => {
    const { lats, lons } = buildStraightRoute(5, 10)
    const r = circumscribedRadius3(lats, lons, 2)
    expect(r).toBe(Infinity)
  })

  it('returns correct radius for known circle (R=10m)', () => {
    const R = 10
    const lat0 = 46.0
    const lon0 = 14.5
    const cosLat = Math.cos(lat0 * DEG2RAD)
    const mPerDegLat = R_EARTH * DEG2RAD
    const mPerDegLon = mPerDegLat * cosLat

    const angles = [-30, 0, 30].map(a => a * DEG2RAD)
    const lats = angles.map(a => lat0 + R * Math.cos(a) / mPerDegLat)
    const lons = angles.map(a => lon0 + R * Math.sin(a) / mPerDegLon)

    const r = circumscribedRadius3(lats, lons, 1)
    expect(r).toBeCloseTo(R, 0) // within 1m
  })

  it('returns correct radius for tight circle (R=3m)', () => {
    const R = 3
    const lat0 = 46.0
    const lon0 = 14.5
    const cosLat = Math.cos(lat0 * DEG2RAD)
    const mPerDegLat = R_EARTH * DEG2RAD
    const mPerDegLon = mPerDegLat * cosLat

    const angles = [-60, 0, 60].map(a => a * DEG2RAD)
    const lats = angles.map(a => lat0 + R * Math.cos(a) / mPerDegLat)
    const lons = angles.map(a => lon0 + R * Math.sin(a) / mPerDegLon)

    const r = circumscribedRadius3(lats, lons, 1)
    expect(r).toBeCloseTo(R, 0)
  })
})

// ── nudgeTightCorners ──────────────────────────────────────────────

describe('nudgeTightCorners', () => {
  it('returns unchanged arrays for straight route', () => {
    const { lats, lons, dists } = buildStraightRoute()
    const result = nudgeTightCorners(lats, lons, dists)

    expect(result.tightCount).toBe(0)
    expect(result.maxOffset).toBe(0)
    expect(result.lats).toEqual(lats)
    expect(result.lons).toEqual(lons)
  })

  it('returns unchanged arrays for gentle curve (radius >> 6m)', () => {
    const { lats, lons, dists } = buildGentleCurve(50)
    const result = nudgeTightCorners(lats, lons, dists)

    expect(result.tightCount).toBe(0)
    for (let i = 0; i < lats.length; i++) {
      expect(result.lats[i]).toBe(lats[i])
      expect(result.lons[i]).toBe(lons[i])
    }
  })

  it('preserves array length', () => {
    const { lats, lons, dists } = buildHairpinRoute()
    const result = nudgeTightCorners(lats, lons, dists)

    expect(result.lats).toHaveLength(lats.length)
    expect(result.lons).toHaveLength(lons.length)
    expect(result.dists).toHaveLength(dists.length)
  })

  it('preserves start and end points', () => {
    const { lats, lons, dists } = buildHairpinRoute()
    const result = nudgeTightCorners(lats, lons, dists)

    expect(result.lats[0]).toBe(lats[0])
    expect(result.lons[0]).toBe(lons[0])
    expect(result.lats[result.lats.length - 1]).toBe(lats[lats.length - 1])
    expect(result.lons[result.lons.length - 1]).toBe(lons[lons.length - 1])
  })

  it('detects tight corners and pushes points outward', () => {
    const { lats, lons, dists } = buildHairpinRoute(2, 3) // R=3m hairpin
    const result = nudgeTightCorners(lats, lons, dists)

    expect(result.tightCount).toBeGreaterThan(0)
    expect(result.maxOffset).toBeGreaterThan(1)

    // Check that at least some hairpin points moved
    let movedCount = 0
    for (let i = 1; i < lats.length - 1; i++) {
      const d = haversine(lats[i], lons[i], result.lats[i], result.lons[i])
      if (d > 0.1) movedCount++
    }
    expect(movedCount).toBeGreaterThan(3)
  })

  it('does not modify points far from tight corners', () => {
    const { lats, lons, dists } = buildHairpinRoute(2, 3)
    const result = nudgeTightCorners(lats, lons, dists)

    // Hairpin approach is 60m. Anchor zone starts at ~(60 - 20) = 40m.
    // First 5 points (0–8m) are well outside the anchor zone.
    for (let i = 0; i < 5; i++) {
      expect(result.lats[i]).toBe(lats[i])
      expect(result.lons[i]).toBe(lons[i])
    }

    // Last 5 points on the exit are also far from the anchor zone.
    const N = lats.length
    for (let i = N - 5; i < N; i++) {
      expect(result.lats[i]).toBe(lats[i])
      expect(result.lons[i]).toBe(lons[i])
    }
  })

  it('post-nudge widens the hairpin apex', () => {
    const { lats, lons, dists } = buildHairpinRoute(2, 3)
    const result = nudgeTightCorners(lats, lons, dists)

    // The apex of the hairpin is the point with maximum displacement.
    // After nudging, the distance between approach and exit arms at the
    // apex should be wider than the original (2 × radius = 6m).
    let maxDisplacement = 0
    for (let i = 1; i < lats.length - 1; i++) {
      const d = haversine(lats[i], lons[i], result.lats[i], result.lons[i])
      if (d > maxDisplacement) maxDisplacement = d
    }

    // Apex should be pushed outward by a significant amount (deficit ≈ 3m)
    expect(maxDisplacement).toBeGreaterThan(1)
  })

  it('produces monotonic distances starting at 0', () => {
    const { lats, lons, dists } = buildHairpinRoute(2, 3)
    const result = nudgeTightCorners(lats, lons, dists)

    expect(result.dists[0]).toBe(0)
    for (let i = 1; i < result.dists.length; i++) {
      expect(result.dists[i]).toBeGreaterThan(result.dists[i - 1])
    }
  })

  it('distances match haversine between consecutive points', () => {
    const { lats, lons, dists } = buildHairpinRoute(2, 3)
    const result = nudgeTightCorners(lats, lons, dists)

    for (let i = 1; i < result.dists.length; i++) {
      const seg = haversine(result.lats[i - 1], result.lons[i - 1], result.lats[i], result.lons[i])
      const diff = result.dists[i] - result.dists[i - 1]
      expect(diff).toBeCloseTo(seg, 4)
    }
  })

  it('handles short arrays gracefully', () => {
    const result = nudgeTightCorners([46, 46.001], [14, 14], [0, 100])
    expect(result.tightCount).toBe(0)
    expect(result.lats).toHaveLength(2)
  })

  it('custom targetRadius=10 nudges more than default', () => {
    const { lats, lons, dists } = buildHairpinRoute(2, 3)
    const result6 = nudgeTightCorners(lats, lons, dists, { targetRadius: 6 })
    const result10 = nudgeTightCorners(lats, lons, dists, { targetRadius: 10 })

    expect(result10.maxOffset).toBeGreaterThan(result6.maxOffset)
  })

  // ── pushGain tests ─────────────────────────────────────────────────

  it('pushGain > 1 pushes further than pushGain = 1', () => {
    const { lats, lons, dists } = buildHairpinRoute(2, 3) // R=3m hairpin
    const result1 = nudgeTightCorners(lats, lons, dists, { pushGain: 1 })
    const result15 = nudgeTightCorners(lats, lons, dists, { pushGain: 1.5 })

    // Higher gain should push apex further
    let maxDisp1 = 0, maxDisp15 = 0
    for (let i = 1; i < lats.length - 1; i++) {
      const d1 = haversine(lats[i], lons[i], result1.lats[i], result1.lons[i])
      const d15 = haversine(lats[i], lons[i], result15.lats[i], result15.lons[i])
      if (d1 > maxDisp1) maxDisp1 = d1
      if (d15 > maxDisp15) maxDisp15 = d15
    }
    expect(maxDisp15).toBeGreaterThan(maxDisp1)
  })

  it('default pushGain=1.5 pushes apex by more than 1× deficit', () => {
    const { lats, lons, dists } = buildHairpinRoute(2, 3) // R=3m, deficit ≈ 3m
    const result = nudgeTightCorners(lats, lons, dists) // default pushGain=1.5

    // Find max displacement — should be > 3m (the raw deficit)
    let maxDisp = 0
    for (let i = 1; i < lats.length - 1; i++) {
      const d = haversine(lats[i], lons[i], result.lats[i], result.lons[i])
      if (d > maxDisp) maxDisp = d
    }
    // With pushGain=1.5, the apex push should be ≈ 1.5 × 3 = 4.5m
    expect(maxDisp).toBeGreaterThan(3)
  })

  it('gentle curve (R=20m) stays untouched', () => {
    const { lats, lons, dists } = buildGentleCurve(20)
    const result = nudgeTightCorners(lats, lons, dists)

    // R=20m > targetRadius (6m) → no tight regions found
    expect(result.tightCount).toBe(0)
    for (let i = 0; i < lats.length; i++) {
      expect(result.lats[i]).toBe(lats[i])
      expect(result.lons[i]).toBe(lons[i])
    }
  })
})
