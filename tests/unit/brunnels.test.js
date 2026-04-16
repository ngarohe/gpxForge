import { describe, it, expect, vi } from 'vitest'
import {
  routeBounds,
  filterByProximity,
  projectBrunnelSpan,
  projectBrunnelSpanMulti,
  filterByBearing,
  resolveOverlaps,
  mergeAdjacent,
  classifyBrunnel,
  buildBrunnelCorrections,
} from '../../src/pipeline/2-brunnels.js'

// ── Test data helpers ──

function makeRoute(n = 50, spacingM = 100) {
  // Straight east-west route at 46°N, flat, spacingM apart
  const lats = [], lons = [], eles = [], dists = [0]
  const dlonPer100m = spacingM / (111320 * Math.cos(46 * Math.PI / 180))
  for (let i = 0; i < n; i++) {
    lats.push(46.0)
    lons.push(14.0 + i * dlonPer100m)
    eles.push(300)
    if (i > 0) dists.push(dists[i - 1] + spacingM)
  }
  return { lats, lons, eles, dists }
}

function makeRouteWithBridge(n = 50, spacingM = 100) {
  // Flat route with a dip (bridge artifact) from index 20–25
  const { lats, lons, eles, dists } = makeRoute(n, spacingM)
  // Create an 8m dip in the middle (realistic LIDAR bridge artifact)
  for (let i = 20; i <= 25; i++) {
    eles[i] = 300 - 8 * Math.sin(Math.PI * (i - 20) / 5)
  }
  return { lats, lons, eles, dists }
}

function makeRouteWithTunnel(n = 50, spacingM = 100) {
  // Flat route with a spike (tunnel artifact) from index 20–25
  const { lats, lons, eles, dists } = makeRoute(n, spacingM)
  for (let i = 20; i <= 25; i++) {
    eles[i] = 300 + 8 * Math.sin(Math.PI * (i - 20) / 5)
  }
  return { lats, lons, eles, dists }
}

/** Create a geometry that follows the route at a given offset */
function makeGeomOnRoute(lats, lons, startIdx, endIdx, offsetM = 0) {
  const geom = []
  for (let i = startIdx; i <= endIdx; i++) {
    geom.push({
      lat: lats[i] + offsetM / 111320,
      lon: lons[i],
    })
  }
  return geom
}

/** Create a perpendicular geometry (rail overpass crossing the route) */
function makeGeomPerpendicular(lats, lons, crossIdx, lengthM = 50) {
  const dLat = lengthM / 111320
  return [
    { lat: lats[crossIdx] - dLat, lon: lons[crossIdx] },
    { lat: lats[crossIdx] + dLat, lon: lons[crossIdx] },
  ]
}

// ── Tests ──

describe('routeBounds', () => {
  it('returns bounding box with padding', () => {
    const { lats, lons } = makeRoute(10)
    const bounds = routeBounds(lats, lons, 100)
    expect(bounds.minLat).toBeLessThan(46.0)
    expect(bounds.maxLat).toBeGreaterThan(46.0)
    expect(bounds.minLon).toBeLessThan(14.0)
    expect(bounds.maxLon).toBeGreaterThan(lons[9])
  })

  it('padding increases with buffer size', () => {
    const { lats, lons } = makeRoute(10)
    const small = routeBounds(lats, lons, 10)
    const large = routeBounds(lats, lons, 1000)
    expect(large.minLat).toBeLessThan(small.minLat)
    expect(large.maxLat).toBeGreaterThan(small.maxLat)
  })
})

describe('filterByProximity', () => {
  it('keeps structures on route', () => {
    const { lats, lons } = makeRoute(50)
    const onRoute = { id: 1, geometry: makeGeomOnRoute(lats, lons, 10, 15, 0), name: 'OnRoute' }
    const result = filterByProximity([onRoute], lats, lons, 50)
    expect(result.length).toBe(1)
  })

  it('rejects structures far from route', () => {
    const { lats, lons } = makeRoute(50)
    // 500m offset north — way beyond buffer
    const farAway = {
      id: 2,
      geometry: [
        { lat: 46.005, lon: 14.0 },
        { lat: 46.005, lon: 14.001 },
      ],
      name: 'FarAway',
    }
    const result = filterByProximity([farAway], lats, lons, 50)
    expect(result.length).toBe(0)
  })

  it('returns empty array for empty input', () => {
    const { lats, lons } = makeRoute(10)
    expect(filterByProximity([], lats, lons, 50)).toEqual([])
  })
})

describe('projectBrunnelSpan', () => {
  it('projects on-route structure correctly', () => {
    const { lats, lons, dists } = makeRoute(50)
    const struct = { geometry: makeGeomOnRoute(lats, lons, 10, 20, 0) }
    const span = projectBrunnelSpan(struct, lats, lons, dists)
    expect(span).not.toBeNull()
    // Multi-pass projection adds 10m padding each side
    expect(span.startDist).toBeCloseTo(990, -1) // 10 * 100m - 10m padding
    expect(span.endDist).toBeCloseTo(2010, -1) // 20 * 100m + 10m padding
  })

  it('returns null for trivial span', () => {
    const { lats, lons, dists } = makeRoute(50)
    // Both points at same location
    const struct = { geometry: [{ lat: lats[10], lon: lons[10] }, { lat: lats[10], lon: lons[10] }] }
    const span = projectBrunnelSpan(struct, lats, lons, dists)
    expect(span).toBeNull()
  })

  it('handles reversed geometry direction', () => {
    const { lats, lons, dists } = makeRoute(50)
    // Normal direction, then reverse the geometry array
    const geom = makeGeomOnRoute(lats, lons, 10, 20, 0)
    geom.reverse() // Now end→start
    const struct = { geometry: geom }
    const span = projectBrunnelSpan(struct, lats, lons, dists)
    expect(span).not.toBeNull()
    // Should still have start < end
    expect(span.startDist).toBeLessThan(span.endDist)
  })

  it('out-and-back route: bridge projects to same pass, not cross-pass', () => {
    // Build an out-and-back route: east 5km, then back west 5km (same road)
    const spacingM = 25
    const ptsPerLeg = 200 // 200 * 25m = 5km
    const lats = [], lons = [], dists = [0]
    const dlonPer25m = spacingM / (111320 * Math.cos(46 * Math.PI / 180))

    // Outbound leg: east
    for (let i = 0; i < ptsPerLeg; i++) {
      lats.push(46.0)
      lons.push(14.0 + i * dlonPer25m)
      if (i > 0) dists.push(dists[dists.length - 1] + spacingM)
    }
    // Return leg: west (offset 1m north so segments are distinct)
    const offsetLat = 1 / 111320
    for (let i = ptsPerLeg - 1; i >= 0; i--) {
      lats.push(46.0 + offsetLat)
      lons.push(14.0 + i * dlonPer25m)
      dists.push(dists[dists.length - 1] + spacingM)
    }

    // Bridge at ~4.5km from start (index 180 on outbound leg)
    // 50m long bridge: 2 nodes at index 180 and 182
    const struct = {
      geometry: [
        { lat: lats[180], lon: lons[180] },
        { lat: lats[182], lon: lons[182] },
      ],
    }

    const span = projectBrunnelSpan(struct, lats, lons, dists)
    expect(span).not.toBeNull()

    // Span should be ~50m (bridge length), NOT ~5.5km (cross-pass)
    const spanM = span.endDist - span.startDist
    expect(spanM).toBeLessThan(200) // comfortably under 200m
    expect(spanM).toBeGreaterThan(10) // but not trivially small
  })
})

describe('projectBrunnelSpanMulti', () => {
  it('returns two spans for out-and-back route crossing same bridge twice', () => {
    // Build an out-and-back route: east 5km, then back west 5km
    const spacingM = 25
    const ptsPerLeg = 200
    const lats = [], lons = [], dists = [0]
    const dlonPer25m = spacingM / (111320 * Math.cos(46 * Math.PI / 180))

    // Outbound leg: east
    for (let i = 0; i < ptsPerLeg; i++) {
      lats.push(46.0)
      lons.push(14.0 + i * dlonPer25m)
      if (i > 0) dists.push(dists[dists.length - 1] + spacingM)
    }
    // Return leg: west (offset 1m north so segments are distinct)
    const offsetLat = 1 / 111320
    for (let i = ptsPerLeg - 1; i >= 0; i--) {
      lats.push(46.0 + offsetLat)
      lons.push(14.0 + i * dlonPer25m)
      dists.push(dists[dists.length - 1] + spacingM)
    }

    // Bridge at index 180 on outbound leg (also near index 219 on return)
    const struct = {
      geometry: [
        { lat: lats[180], lon: lons[180] },
        { lat: lats[182], lon: lons[182] },
      ],
    }

    const spans = projectBrunnelSpanMulti(struct, lats, lons, dists)
    expect(spans.length).toBe(2)

    // Both spans should be short (bridge-length), not cross-pass
    for (const span of spans) {
      const spanM = span.endDist - span.startDist
      expect(spanM).toBeLessThan(200)
      expect(spanM).toBeGreaterThan(10)
    }

    // Spans should be in different halves of the route
    const totalDist = dists[dists.length - 1]
    expect(spans[0].startDist).toBeLessThan(totalDist / 2)
    expect(spans[1].startDist).toBeGreaterThan(totalDist / 2)
  })

  it('returns single span for one-way route', () => {
    const { lats, lons, dists } = makeRoute(50)
    const struct = { geometry: makeGeomOnRoute(lats, lons, 10, 20, 0) }
    const spans = projectBrunnelSpanMulti(struct, lats, lons, dists)
    expect(spans.length).toBe(1)
  })

  it('rejects second pass when elevation differs (Lysebotn scenario)', () => {
    // Out-and-back route where the return leg is 50m higher (road over tunnel)
    const spacingM = 25
    const ptsPerLeg = 200
    const lats = [], lons = [], dists = [0], eles = []
    const dlonPer25m = spacingM / (111320 * Math.cos(46 * Math.PI / 180))

    // Outbound leg: east, elevation 100m (inside tunnel)
    for (let i = 0; i < ptsPerLeg; i++) {
      lats.push(46.0)
      lons.push(14.0 + i * dlonPer25m)
      eles.push(100)
      if (i > 0) dists.push(dists[dists.length - 1] + spacingM)
    }
    // Return leg: west, 1m north offset, elevation 150m (road above tunnel)
    const offsetLat = 1 / 111320
    for (let i = ptsPerLeg - 1; i >= 0; i--) {
      lats.push(46.0 + offsetLat)
      lons.push(14.0 + i * dlonPer25m)
      eles.push(150)
      dists.push(dists[dists.length - 1] + spacingM)
    }

    // Tunnel structure at index 180 on outbound leg
    const struct = {
      geometry: [
        { lat: lats[180], lon: lons[180] },
        { lat: lats[182], lon: lons[182] },
      ],
    }

    // Without elevation filter: would find 2 spans
    const spansNoEle = projectBrunnelSpanMulti(struct, lats, lons, dists)
    expect(spansNoEle.length).toBe(2)

    // With elevation filter: only 1 span (second pass rejected — 50m difference)
    const spansWithEle = projectBrunnelSpanMulti(struct, lats, lons, dists, { eles })
    expect(spansWithEle.length).toBe(1)
    // The kept span should be on the outbound leg (first half)
    const totalDist = dists[dists.length - 1]
    expect(spansWithEle[0].startDist).toBeLessThan(totalDist / 2)
  })

  it('keeps both passes when elevations match', () => {
    // Out-and-back at same elevation — both passes are valid
    const spacingM = 25
    const ptsPerLeg = 200
    const lats = [], lons = [], dists = [0], eles = []
    const dlonPer25m = spacingM / (111320 * Math.cos(46 * Math.PI / 180))

    for (let i = 0; i < ptsPerLeg; i++) {
      lats.push(46.0)
      lons.push(14.0 + i * dlonPer25m)
      eles.push(300)
      if (i > 0) dists.push(dists[dists.length - 1] + spacingM)
    }
    const offsetLat = 1 / 111320
    for (let i = ptsPerLeg - 1; i >= 0; i--) {
      lats.push(46.0 + offsetLat)
      lons.push(14.0 + i * dlonPer25m)
      eles.push(300)
      dists.push(dists[dists.length - 1] + spacingM)
    }

    const struct = {
      geometry: [
        { lat: lats[180], lon: lons[180] },
        { lat: lats[182], lon: lons[182] },
      ],
    }

    const spans = projectBrunnelSpanMulti(struct, lats, lons, dists, { eles })
    expect(spans.length).toBe(2)
  })
})

describe('filterByBearing', () => {
  it('accepts aligned structure', () => {
    const { lats, lons } = makeRoute(50)
    const struct = { geometry: makeGeomOnRoute(lats, lons, 10, 15, 0) }
    expect(filterByBearing(struct, lats, lons, 10, 15, 25)).toBe(true)
  })

  it('rejects perpendicular structure', () => {
    const { lats, lons } = makeRoute(50)
    const struct = { geometry: makeGeomPerpendicular(lats, lons, 15, 50) }
    expect(filterByBearing(struct, lats, lons, 13, 17, 25)).toBe(false)
  })

  it('accepts opposite-direction aligned structure', () => {
    const { lats, lons } = makeRoute(50)
    // Same line, reversed direction — should still be "aligned"
    const geom = makeGeomOnRoute(lats, lons, 10, 15, 0).reverse()
    const struct = { geometry: geom }
    expect(filterByBearing(struct, lats, lons, 10, 15, 25)).toBe(true)
  })
})

describe('resolveOverlaps', () => {
  it('keeps non-overlapping structures', () => {
    const { lats, lons } = makeRoute(50)
    const candidates = [
      { startDist: 100, endDist: 300, alo: 1, ahi: 3, geometry: makeGeomOnRoute(lats, lons, 1, 3, 0) },
      { startDist: 500, endDist: 700, alo: 5, ahi: 7, geometry: makeGeomOnRoute(lats, lons, 5, 7, 0) },
    ]
    const result = resolveOverlaps(candidates, lats, lons)
    expect(result.length).toBe(2)
  })

  it('keeps closer structure on overlap', () => {
    const { lats, lons } = makeRoute(50)
    const close = { startDist: 100, endDist: 300, alo: 1, ahi: 3, geometry: makeGeomOnRoute(lats, lons, 1, 3, 0) }
    const far = { startDist: 150, endDist: 350, alo: 1, ahi: 3, geometry: makeGeomOnRoute(lats, lons, 1, 3, 100) }
    const result = resolveOverlaps([close, far], lats, lons)
    expect(result.length).toBe(1)
  })

  it('handles empty input', () => {
    expect(resolveOverlaps([], [], [])).toEqual([])
  })

  it('passes through single item', () => {
    const { lats, lons } = makeRoute(10)
    const items = [{ startDist: 100, endDist: 200, alo: 1, ahi: 2, geometry: makeGeomOnRoute(lats, lons, 1, 2, 0) }]
    expect(resolveOverlaps(items, lats, lons).length).toBe(1)
  })

  it('keeps both entries when same osmId overlaps (multi-pass)', () => {
    const { lats, lons } = makeRoute(50)
    const geom = makeGeomOnRoute(lats, lons, 1, 3, 0)
    const items = [
      { startDist: 100, endDist: 300, alo: 1, ahi: 3, osmId: 12345, geometry: geom },
      { startDist: 150, endDist: 350, alo: 1, ahi: 3, osmId: 12345, geometry: geom },
    ]
    const result = resolveOverlaps(items, lats, lons)
    expect(result.length).toBe(2)
  })
})

describe('mergeAdjacent', () => {
  it('merges same-type within gap', () => {
    const { dists } = makeRoute(50)
    const brunnels = [
      { type: 'bridge', name: 'A', startDist: 100, endDist: 200, alo: 1, ahi: 2 },
      { type: 'bridge', name: 'B', startDist: 201, endDist: 300, alo: 2, ahi: 3 },
    ]
    const result = mergeAdjacent(brunnels, dists, 2)
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('A / B')
    expect(result[0].ahi).toBe(3)
  })

  it('does not merge when gap exceeds threshold', () => {
    const { dists } = makeRoute(50)
    const brunnels = [
      { type: 'bridge', name: 'A', startDist: 100, endDist: 200, alo: 1, ahi: 2 },
      { type: 'bridge', name: 'B', startDist: 300, endDist: 400, alo: 3, ahi: 4 },
    ]
    const result = mergeAdjacent(brunnels, dists, 2)
    expect(result.length).toBe(2)
  })

  it('returns single item unchanged', () => {
    const { dists } = makeRoute(10)
    const b = [{ type: 'bridge', name: 'X', startDist: 100, endDist: 200, alo: 1, ahi: 2 }]
    expect(mergeAdjacent(b, dists, 2).length).toBe(1)
  })
})

describe('classifyBrunnel', () => {
  it('detects bridge dip', () => {
    const { eles, dists } = makeRouteWithBridge(50)
    const result = classifyBrunnel(eles, dists, 18, 27, { tangWin: 8, hermDev: 0.5, bridgeDip: 1, tunnelSpk: 1 })
    expect(result.type).toBe('bridge')
    expect(result.interp).toBe('hermite')
  })

  it('detects tunnel spike', () => {
    const { eles, dists } = makeRouteWithTunnel(50)
    const result = classifyBrunnel(eles, dists, 18, 27, { tangWin: 8, hermDev: 0.5, bridgeDip: 1, tunnelSpk: 1 })
    expect(result.type).toBe('tunnel')
    expect(result.interp).toBe('uniform')
  })

  it('returns clean for flat zone', () => {
    const { eles, dists } = makeRoute(50)
    const result = classifyBrunnel(eles, dists, 10, 20, { tangWin: 8, hermDev: 0.5, bridgeDip: 1, tunnelSpk: 1 })
    expect(result.type).toBe('clean')
    expect(result.interp).toBe('none')
  })

  it('returns artifact for zero span', () => {
    const eles = [300, 300]
    const dists = [0, 0.5]
    const result = classifyBrunnel(eles, dists, 0, 1, { tangWin: 8, hermDev: 0.5, bridgeDip: 1, tunnelSpk: 1 })
    expect(result.type).toBe('artifact')
  })
})

describe('buildBrunnelCorrections', () => {
  it('produces corrections from bridge brunnels', () => {
    const { eles, dists } = makeRouteWithBridge(50)
    const brunnels = [
      { id: 1, type: 'bridge', name: 'Test Bridge', alo: 20, ahi: 25, startDist: 2000, endDist: 2500 },
    ]
    const result = buildBrunnelCorrections(brunnels, eles, dists, { tangWin: 8, hermDev: 0.5, bridgeDip: 0, tunnelSpk: 1 })
    expect(result.corrections.length).toBe(1)
    expect(result.corrections[0].source).toBe('osm')
    expect(result.corrections[0].accepted).toBe(true)
    expect(result.corrections[0].type).toBe('bridge')
  })

  it('produces corrections from tunnel brunnels', () => {
    const { eles, dists } = makeRouteWithTunnel(50)
    const brunnels = [
      { id: 2, type: 'tunnel', name: 'Test Tunnel', alo: 20, ahi: 25, startDist: 2000, endDist: 2500 },
    ]
    const result = buildBrunnelCorrections(brunnels, eles, dists, { tangWin: 8, hermDev: 0.5, bridgeDip: 1, tunnelSpk: 0 })
    expect(result.corrections.length).toBe(1)
    expect(result.corrections[0].source).toBe('osm')
    expect(result.corrections[0].type).toBe('tunnel')
  })

  it('keeps OSM tunnel label even when shape classifier prefers ramp/bridge', () => {
    // Use a bridge-like dip profile but OSM says tunnel; UI label should stay tunnel.
    const { eles, dists } = makeRouteWithBridge(50)
    const brunnels = [
      { id: 3, type: 'tunnel', name: 'Portal Tunnel', alo: 20, ahi: 25, startDist: 2000, endDist: 2500 },
    ]
    const result = buildBrunnelCorrections(brunnels, eles, dists, {
      tangWin: 8, hermDev: 0.5, bridgeDip: 1, tunnelSpk: 1,
    })
    expect(result.corrections.length).toBe(1)
    expect(result.corrections[0].source).toBe('osm')
    expect(result.corrections[0].type).toBe('tunnel')
  })

  it('returns modified eleClean array', () => {
    const { eles, dists } = makeRouteWithBridge(50)
    const brunnels = [
      { id: 1, type: 'bridge', name: 'B', alo: 20, ahi: 25, startDist: 2000, endDist: 2500 },
    ]
    const result = buildBrunnelCorrections(brunnels, eles, dists, { tangWin: 8, hermDev: 0.5, bridgeDip: 0, tunnelSpk: 1 })
    // eleClean should differ from raw in the bridge zone
    let differs = false
    for (let i = 20; i <= 25; i++) {
      if (Math.abs(result.eleClean[i] - eles[i]) > 0.01) differs = true
    }
    expect(differs).toBe(true)
    // Outside the zone should be unchanged
    expect(result.eleClean[5]).toBe(eles[5])
    expect(result.eleClean[40]).toBe(eles[40])
  })

  it('handles empty brunnels array', () => {
    const { eles, dists } = makeRoute(50)
    const result = buildBrunnelCorrections([], eles, dists, { tangWin: 8 })
    expect(result.corrections).toEqual([])
    expect(result.eleClean).toEqual(eles)
  })

  it('correction has osmId and osmName', () => {
    const { eles, dists } = makeRouteWithBridge(50)
    const brunnels = [
      { id: 42, type: 'bridge', name: 'Main Bridge', alo: 20, ahi: 25, startDist: 2000, endDist: 2500 },
    ]
    const result = buildBrunnelCorrections(brunnels, eles, dists, { tangWin: 8, bridgeDip: 0 })
    expect(result.corrections[0].osmId).toBe(42)
    expect(result.corrections[0].osmName).toBe('Main Bridge')
  })
})
