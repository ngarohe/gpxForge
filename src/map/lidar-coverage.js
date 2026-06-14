/**
 * LIDAR coverage overlay — fetches provider coverage GeoJSON from
 * /api/coverage and renders country borders + regional sub-providers
 * colored by resolution.
 *
 * Green (≤1m) → lime (≤2m) → yellow (≤5m) → orange (≤10m) → red (≥20m).
 * Togglable via the Leaflet layer control as an overlay checkbox.
 */

import L from 'leaflet'

const RAW_LIDAR_BASE_URL = (import.meta.env.VITE_LIDAR_BASE_URL || '').trim()
const LIDAR_BASE_URL = RAW_LIDAR_BASE_URL.replace(/\/+$/, '')

function lidarUrl(path) {
  return LIDAR_BASE_URL ? `${LIDAR_BASE_URL}${path}` : path
}

function resColor(resM) {
  if (resM <= 1) return '#22c55e'
  if (resM <= 2) return '#84cc16'
  if (resM <= 5) return '#eab308'
  if (resM <= 10) return '#f97316'
  return '#ef4444'
}

function resLabel(resM) {
  if (resM <= 1) return '≤1m (high)'
  if (resM <= 2) return '≤2m'
  if (resM <= 5) return '≤5m'
  if (resM <= 10) return '≤10m'
  return '≥20m (low)'
}

/**
 * Style function for country-level features.
 * Full-coverage countries get a solid fill; partial-coverage get a dashed border
 * to indicate "GPXZ fallback" quality.
 */
function styleCountry(feature) {
  const { resolution_m, full_coverage } = feature.properties
  const color = resColor(resolution_m)
  return {
    color,
    weight: full_coverage ? 1.5 : 2,
    opacity: 0.7,
    fillColor: color,
    fillOpacity: full_coverage ? 0.12 : 0.06,
    dashArray: full_coverage ? null : '6 4',
  }
}

/**
 * Style for regional sub-provider overlays (Italy sub-regions, GB EA LIDAR).
 * Brighter fill + thicker border to stand out on top of country polygons.
 */
function styleRegion(feature) {
  const color = resColor(feature.properties.resolution_m)
  return {
    color,
    weight: 2,
    opacity: 0.85,
    fillColor: color,
    fillOpacity: 0.22,
  }
}

/**
 * Style for tile-provider coverage hulls (Spain MDT02, Portugal MDT2m, etc.).
 */
function styleTiles(feature) {
  const color = resColor(feature.properties.resolution_m)
  return {
    color,
    weight: 2,
    opacity: 0.8,
    fillColor: color,
    fillOpacity: 0.18,
    dashArray: '4 3',
  }
}

function tooltipText(props) {
  const { name, resolution_m, note, gpxz_only, layer } = props
  let text = `${name} — ${resolution_m}m LIDAR`
  if (gpxz_only) text += ' (GPXZ)'
  if (layer === 'tiles') text += ' (tile coverage)'
  if (note) text += `\n${note}`
  return text
}

/**
 * Build the LIDAR coverage layer group.
 * Fetches GeoJSON from /api/coverage on first map add.
 * @returns {L.LayerGroup}
 */
export function createLidarCoverageLayer() {
  const group = L.layerGroup()
  let fetched = false

  group.on('add', async () => {
    if (fetched) return
    fetched = true
    try {
      const resp = await fetch(lidarUrl('/api/coverage'))
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      _renderCoverage(group, data)
    } catch (err) {
      console.warn('[lidar-coverage] Failed to fetch coverage data:', err)
      fetched = false
    }
  })

  return group
}

function _renderCoverage(group, data) {
  const features = data.features || []

  // Render in order: countries first (bottom), then regions, then tiles (top)
  const countries = features.filter(f => f.properties.layer === 'country')
  const regions = features.filter(f => f.properties.layer === 'region')
  const tiles = features.filter(f => f.properties.layer === 'tiles')

  for (const feat of countries) {
    const layer = L.geoJSON(feat, { style: styleCountry })
    layer.bindTooltip(tooltipText(feat.properties), {
      sticky: true,
      className: 'lidar-tooltip',
    })
    layer.addTo(group)
  }

  for (const feat of regions) {
    const layer = L.geoJSON(feat, { style: styleRegion })
    layer.bindTooltip(tooltipText(feat.properties), {
      sticky: true,
      className: 'lidar-tooltip',
    })
    layer.addTo(group)
  }

  for (const feat of tiles) {
    const layer = L.geoJSON(feat, { style: styleTiles })
    layer.bindTooltip(tooltipText(feat.properties), {
      sticky: true,
      className: 'lidar-tooltip',
    })
    layer.addTo(group)
  }
}

/**
 * Build a legend control for the LIDAR coverage overlay.
 * @returns {L.Control}
 */
export function createLidarLegend() {
  const Legend = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'lidar-legend')
      div.innerHTML = `
        <strong>LIDAR resolution</strong>
        <div><span style="background:${resColor(1)}"></span> ≤1m</div>
        <div><span style="background:${resColor(2)}"></span> ≤2m</div>
        <div><span style="background:${resColor(5)}"></span> ≤5m</div>
        <div><span style="background:${resColor(10)}"></span> ≤10m</div>
        <div><span style="background:${resColor(20)}"></span> ≥20m</div>
        <div style="margin-top:4px;font-size:11px;opacity:0.7">
          <span style="border-bottom:2px dashed currentColor">┈┈</span> partial coverage
        </div>
      `
      return div
    },
  })
  return new Legend()
}
