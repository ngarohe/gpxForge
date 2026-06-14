/**
 * Map setup — Leaflet map creation, tile layers, layer groups, markers.
 *
 * Returns all created objects as a plain object. No module-level state.
 */

import L from 'leaflet'
import { createLidarCoverageLayer, createLidarLegend } from './lidar-coverage.js'

// ────────────────────────────────────────────────────────────────────
// Tile layer URLs
// ────────────────────────────────────────────────────────────────────

const STREETS_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
// Topographic — OpenTopoMap renders hillshade + contour lines, so hilly
// terrain is visible at a glance (useful for finding/building climby routes).
const TOPO_URL = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'

// ────────────────────────────────────────────────────────────────────
// createMap
// ────────────────────────────────────────────────────────────────────

/**
 * Create a Leaflet map inside a container element.
 *
 * @param {HTMLElement} container — DOM element to mount the map in
 * @returns {{
 *   map: L.Map,
 *   snapOriginalLine: L.Polyline,
 *   routeLine: L.Polyline,
 *   corrLayer: L.LayerGroup,
 *   osmLayer: L.LayerGroup,
 *   startMarker: L.CircleMarker,
 *   endMarker: L.CircleMarker,
 *   hoverMarker: L.CircleMarker,
 *   tileLayers: { streets: L.TileLayer, satellite: L.TileLayer, hybrid: L.LayerGroup }
 * }}
 */
export function createMap(container) {
  const map = L.map(container, {
    zoomControl: false,
    // NOTE: do NOT enable preferCanvas. Leaflet's canvas renderer hit-tests
    // every interactive path in JavaScript on each pointer move (walking the
    // polyline's points), firing synthetic over/out events — on a long route
    // that costs >1s per mouse move and tanks FPS. SVG uses native browser
    // hit-testing (instant). The route line is RDP-decimated for display
    // (see layers.js decimateForZoom) so the SVG path stays small and fast.
  })

  // Tile layers — streets added by default
  const streets = L.tileLayer(STREETS_URL, {
    maxZoom: 22,
    // OSM tiles only exist to z19 — upscale them past that instead of going
    // blank, so the road shape stays visible for precise nudging at max zoom.
    maxNativeZoom: 19,
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map)

  const satellite = L.tileLayer(SATELLITE_URL, {
    maxZoom: 22,
    maxNativeZoom: 19,
  })

  // Topographic layer (hillshade + contours) — OpenTopoMap tiles only exist to
  // z17; upscale past that so it stays usable at high zoom.
  const topo = L.tileLayer(TOPO_URL, {
    maxZoom: 22,
    maxNativeZoom: 17,
    subdomains: 'abc',
    attribution: 'map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
  })

  // Satellite + street labels hybrid layer
  const hybridSat = L.tileLayer(SATELLITE_URL, { maxZoom: 22, maxNativeZoom: 19 })
  const hybridLabels = L.tileLayer(STREETS_URL, {
    maxZoom: 22,
    maxNativeZoom: 19,
    subdomains: 'abc',
    opacity: 0.4,
  })
  const hybrid = L.layerGroup([hybridSat, hybridLabels])

  // LIDAR coverage overlay (off by default)
  const lidarCoverage = createLidarCoverageLayer()
  const lidarLegend = createLidarLegend()

  // Show/hide legend when overlay is toggled
  map.on('overlayadd', (e) => {
    if (e.layer === lidarCoverage) lidarLegend.addTo(map)
  })
  map.on('overlayremove', (e) => {
    if (e.layer === lidarCoverage) lidarLegend.remove()
  })

  // Leaflet layer control (top-right)
  L.control.layers(
    { 'Streets': streets, 'Topographic': topo, 'Satellite': satellite, 'Hybrid': hybrid },
    { 'LIDAR coverage': lidarCoverage },
    { position: 'topright', collapsed: true },
  ).addTo(map)

  // Layer groups (order: bottom → top)
  const corrLayer = L.layerGroup().addTo(map)

  const snapOriginalLine = L.polyline([], {
    color: '#3a7bd5',
    weight: 3,
    opacity: 0.75,
    dashArray: '8 6',
    interactive: false,
  }).addTo(map)

  const routeLine = L.polyline([], {
    color: '#3a7bd5',
    weight: 4,
    opacity: 0.9,
    // Keep Leaflet's default 1px simplification tolerance — full fidelity
    // (higher values visibly straighten curves on long routes). Speed comes
    // from the canvas renderer, not from dropping detail.
    smoothFactor: 1.0,
  }).addTo(map)

  const osmLayer = L.layerGroup().addTo(map)
  const trimLayer = L.layerGroup().addTo(map)
  const snapLayer = L.layerGroup().addTo(map)
  const builderLayer = L.layerGroup().addTo(map)
  const editLayer = L.layerGroup().addTo(map)  // Split-step selection highlight
  const topologyLayer = L.layerGroup().addTo(map)  // Topology editor: nodes + segments
  const courseLayer = L.layerGroup().addTo(map)    // Course Builder: network graph + bbox draw

  // Persistent markers
  const startMarker = L.circleMarker([0, 0], {
    radius: 7,
    color: '#fff',
    fillColor: '#2ea84a',
    fillOpacity: 1,
    weight: 2,
  }).addTo(map)

  const endMarker = L.circleMarker([0, 0], {
    radius: 7,
    color: '#fff',
    fillColor: '#d03030',
    fillOpacity: 1,
    weight: 2,
  }).addTo(map)

  // Hover dot: an HTML divIcon marker (markerPane), NOT an SVG circleMarker.
  // The hover dot moves on every pointer move (chart↔map cursor sync). An SVG
  // circleMarker shares the overlayPane <svg> with the route polyline, so
  // moving it forces the browser to re-rasterize that whole SVG layer —
  // including the complex post-smooth route path — every frame, tanking FPS
  // while the main thread sits idle. An HTML marker lives in its own pane and
  // moves via a compositor transform, never touching the route's raster.
  const hoverMarker = L.marker([0, 0], {
    icon: L.divIcon({
      className: 'hover-dot',
      html: '<span class="hover-dot__inner"></span>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    }),
    interactive: false,
    keyboard: false,
    opacity: 0,
  }).addTo(map)

  // Set a default view so the map tiles load even before data arrives
  map.setView([46.05, 14.5], 10)

  return {
    map,
    snapOriginalLine,
    routeLine,
    corrLayer,
    osmLayer,
    trimLayer,
    snapLayer,
    builderLayer,
    editLayer,
    topologyLayer,
    courseLayer,
    startMarker,
    endMarker,
    hoverMarker,
    tileLayers: { streets, topo, satellite, hybrid },
  }
}
