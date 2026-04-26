/**
 * Map setup — Leaflet map creation, tile layers, layer groups, markers.
 *
 * Returns all created objects as a plain object. No module-level state.
 */

import L from 'leaflet'

// ────────────────────────────────────────────────────────────────────
// Tile layer URLs
// ────────────────────────────────────────────────────────────────────

const STREETS_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

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
  })

  // Tile layers — streets added by default
  const streets = L.tileLayer(STREETS_URL, {
    maxZoom: 22,
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map)

  const satellite = L.tileLayer(SATELLITE_URL, {
    maxZoom: 19,
  })

  // Satellite + street labels hybrid layer
  const hybridSat = L.tileLayer(SATELLITE_URL, { maxZoom: 19 })
  const hybridLabels = L.tileLayer(STREETS_URL, {
    maxZoom: 22,
    subdomains: 'abc',
    opacity: 0.4,
  })
  const hybrid = L.layerGroup([hybridSat, hybridLabels])

  // Leaflet layer control (top-right)
  L.control.layers(
    { 'Streets': streets, 'Satellite': satellite, 'Hybrid': hybrid },
    null,
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
  }).addTo(map)

  const osmLayer = L.layerGroup().addTo(map)
  const trimLayer = L.layerGroup().addTo(map)
  const snapLayer = L.layerGroup().addTo(map)
  const builderLayer = L.layerGroup().addTo(map)

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

  const hoverMarker = L.circleMarker([0, 0], {
    radius: 6,
    color: '#fff',
    fillColor: '#e8a020',
    fillOpacity: 0,
    weight: 2,
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
    startMarker,
    endMarker,
    hoverMarker,
    tileLayers: { streets, satellite, hybrid },
  }
}
