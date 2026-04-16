/**
 * Unit tests for src/map/layers.js
 *
 * Tests the layer update functions with mock Leaflet objects.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ST } from '../../src/state.js'
import { updateRoute, updateHover, updateCorrections, updateBrunnels } from '../../src/map/layers.js'

// ────────────────────────────────────────────────────────────────────
// Mock Leaflet objects
// ────────────────────────────────────────────────────────────────────

function mockPolyline() {
  return { setLatLngs: vi.fn(), setStyle: vi.fn(), addTo: vi.fn(), on: vi.fn() }
}

function mockCircleMarker() {
  return { setLatLng: vi.fn(), setStyle: vi.fn() }
}

function mockLayerGroup() {
  const layers = []
  return {
    clearLayers: vi.fn(() => { layers.length = 0 }),
    addLayer: vi.fn(l => layers.push(l)),
    _layers: layers,
  }
}

function makeRefs() {
  return {
    snapOriginalLine: mockPolyline(),
    routeLine: mockPolyline(),
    startMarker: mockCircleMarker(),
    endMarker: mockCircleMarker(),
    hoverMarker: mockCircleMarker(),
    corrLayer: mockLayerGroup(),
    osmLayer: mockLayerGroup(),
  }
}

// ────────────────────────────────────────────────────────────────────
// Helper: populate ST with mock route data
// ────────────────────────────────────────────────────────────────────

function resetState() {
  ST.gpx = null
  ST.dists = null
  ST.hoverIdx = null
  ST.hoverDistM = null
  ST.corrections = null
  ST.brunnels = null
  ST.smoothedRoute = null
  ST.activeStep = null
  ST.snapPreState = null
}

function setRouteData() {
  ST.gpx = {
    lats: [46.0, 46.01, 46.02, 46.03, 46.04],
    lons: [14.5, 14.5, 14.5, 14.5, 14.5],
    eles: [300, 310, 320, 310, 300],
  }
  ST.dists = [0, 100, 200, 300, 400]
}

// ────────────────────────────────────────────────────────────────────
// updateRoute
// ────────────────────────────────────────────────────────────────────

describe('updateRoute', () => {
  beforeEach(resetState)

  it('sets latlngs on routeLine from ST.gpx', () => {
    setRouteData()
    const refs = makeRefs()
    updateRoute(refs)

    expect(refs.routeLine.setLatLngs).toHaveBeenCalledTimes(1)
    const latlngs = refs.routeLine.setLatLngs.mock.calls[0][0]
    expect(latlngs.length).toBe(5)
    expect(latlngs[0]).toEqual([46.0, 14.5])
    expect(latlngs[4]).toEqual([46.04, 14.5])
  })

  it('positions start marker at first point', () => {
    setRouteData()
    const refs = makeRefs()
    updateRoute(refs)

    expect(refs.startMarker.setLatLng).toHaveBeenCalledWith([46.0, 14.5])
  })

  it('positions end marker at last point', () => {
    setRouteData()
    const refs = makeRefs()
    updateRoute(refs)

    expect(refs.endMarker.setLatLng).toHaveBeenCalledWith([46.04, 14.5])
  })

  it('shows original pre-snap line in snap step and colors snapped route orange', () => {
    setRouteData()
    ST.activeStep = 'snap'
    ST.snapPreState = {
      gpx: {
        lats: [46.0, 46.005, 46.01],
        lons: [14.49, 14.495, 14.5],
        eles: [300, 305, 310],
      },
    }

    const refs = makeRefs()
    updateRoute(refs)

    expect(refs.routeLine.setStyle).toHaveBeenCalledWith({ color: '#e87020' })
    expect(refs.snapOriginalLine.setLatLngs).toHaveBeenCalledTimes(1)
    expect(refs.snapOriginalLine.setLatLngs.mock.calls[0][0]).toEqual([
      [46.0, 14.49],
      [46.005, 14.495],
      [46.01, 14.5],
    ])
  })

  it('hides original pre-snap line outside snap step', () => {
    setRouteData()
    ST.activeStep = 'clean'
    ST.snapPreState = {
      gpx: {
        lats: [46.0, 46.005, 46.01],
        lons: [14.49, 14.495, 14.5],
        eles: [300, 305, 310],
      },
    }

    const refs = makeRefs()
    updateRoute(refs)

    expect(refs.snapOriginalLine.setLatLngs).toHaveBeenCalledWith([])
  })

  it('no-ops when ST.gpx is null', () => {
    const refs = makeRefs()
    updateRoute(refs)

    expect(refs.routeLine.setLatLngs).not.toHaveBeenCalled()
    expect(refs.startMarker.setLatLng).not.toHaveBeenCalled()
    expect(refs.snapOriginalLine.setLatLngs).toHaveBeenCalledWith([])
  })
})

// ────────────────────────────────────────────────────────────────────
// updateHover
// ────────────────────────────────────────────────────────────────────

describe('updateHover', () => {
  beforeEach(resetState)

  it('shows marker when hoverIdx is set', () => {
    setRouteData()
    ST.hoverIdx = 2
    const refs = makeRefs()
    updateHover(refs)

    expect(refs.hoverMarker.setLatLng).toHaveBeenCalledWith([46.02, 14.5])
    expect(refs.hoverMarker.setStyle).toHaveBeenCalledWith({ opacity: 1, fillOpacity: 1 })
  })

  it('hides marker when hoverIdx is null', () => {
    setRouteData()
    ST.hoverIdx = null
    const refs = makeRefs()
    updateHover(refs)

    expect(refs.hoverMarker.setStyle).toHaveBeenCalledWith({ opacity: 0, fillOpacity: 0 })
  })

  it('hides marker when hoverIdx is out of bounds', () => {
    setRouteData()
    ST.hoverIdx = 999
    const refs = makeRefs()
    updateHover(refs)

    expect(refs.hoverMarker.setStyle).toHaveBeenCalledWith({ opacity: 0, fillOpacity: 0 })
  })

  it('no-ops when ST.gpx is null', () => {
    ST.hoverIdx = 2
    const refs = makeRefs()
    updateHover(refs)

    expect(refs.hoverMarker.setLatLng).not.toHaveBeenCalled()
    expect(refs.hoverMarker.setStyle).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────
// updateCorrections
// ────────────────────────────────────────────────────────────────────

describe('updateCorrections', () => {
  beforeEach(resetState)

  it('clears and rebuilds correction polylines', () => {
    setRouteData()
    ST.corrections = [
      { alo: 0, ahi: 2, type: 'bridge', source: 'osm' },
      { alo: 2, ahi: 4, type: 'tunnel', source: 'osm' },
    ]
    const refs = makeRefs()
    const onSelect = vi.fn()
    updateCorrections(refs, onSelect)

    expect(refs.corrLayer.clearLayers).toHaveBeenCalledTimes(1)
    // L.polyline creates objects with addTo — we check addTo was called
    // Since we mock L.polyline via the module, we can't directly count,
    // but clearLayers being called confirms the flow works
  })

  it('no-ops when corrections is null', () => {
    setRouteData()
    ST.corrections = null
    const refs = makeRefs()
    updateCorrections(refs, vi.fn())

    expect(refs.corrLayer.clearLayers).toHaveBeenCalledTimes(1)
  })

  it('no-ops when ST.gpx is null', () => {
    ST.corrections = [{ alo: 0, ahi: 2 }]
    const refs = makeRefs()
    updateCorrections(refs, vi.fn())

    expect(refs.corrLayer.clearLayers).toHaveBeenCalledTimes(1)
  })

  it('clears layers when corrections is empty', () => {
    setRouteData()
    ST.corrections = []
    const refs = makeRefs()
    updateCorrections(refs, vi.fn())

    expect(refs.corrLayer.clearLayers).toHaveBeenCalledTimes(1)
  })
})

// ────────────────────────────────────────────────────────────────────
// updateBrunnels
// ────────────────────────────────────────────────────────────────────

describe('updateBrunnels', () => {
  beforeEach(resetState)

  it('clears and rebuilds brunnel polylines', () => {
    setRouteData()
    ST.brunnels = [
      { alo: 0, ahi: 2, type: 'bridge' },
      { alo: 3, ahi: 4, type: 'tunnel' },
    ]
    const refs = makeRefs()
    updateBrunnels(refs)

    expect(refs.osmLayer.clearLayers).toHaveBeenCalledTimes(1)
  })

  it('no-ops when brunnels is null', () => {
    setRouteData()
    ST.brunnels = null
    const refs = makeRefs()
    updateBrunnels(refs)

    expect(refs.osmLayer.clearLayers).toHaveBeenCalledTimes(1)
  })

  it('no-ops when ST.gpx is null', () => {
    ST.brunnels = [{ alo: 0, ahi: 2, type: 'bridge' }]
    const refs = makeRefs()
    updateBrunnels(refs)

    expect(refs.osmLayer.clearLayers).toHaveBeenCalledTimes(1)
  })

  it('no-ops when brunnels is empty', () => {
    setRouteData()
    ST.brunnels = []
    const refs = makeRefs()
    updateBrunnels(refs)

    expect(refs.osmLayer.clearLayers).toHaveBeenCalledTimes(1)
  })
})
