/**
 * GPX file parsing and serialization.
 *
 * Handles reading GPX XML into arrays and writing processed data back to GPX.
 * No DOM manipulation beyond DOMParser/XMLSerializer for XML processing.
 */

import { haversine } from './math.js'

// ────────────────────────────────────────────────────────────────────
// Parsing
// ────────────────────────────────────────────────────────────────────

/**
 * Parse a GPX XML string into structured data.
 * @param {string} xml — raw GPX file content
 * @returns {{
 *   lats: number[],
 *   lons: number[],
 *   eles: number[],
 *   dists: number[],
 *   doc: Document,
 *   ns: string,
 *   pts: Element[],
 *   rawXml: string
 * }}
 */
export function parseGPX(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const ns = 'http://www.topografix.com/GPX/1/1'
  let pts = doc.getElementsByTagNameNS(ns, 'trkpt')
  if (!pts.length) pts = doc.getElementsByTagName('trkpt')
  const lats = [], lons = [], eles = []
  for (const p of pts) {
    lats.push(+p.getAttribute('lat'))
    lons.push(+p.getAttribute('lon'))
    const el = p.getElementsByTagNameNS(ns, 'ele')[0] || p.getElementsByTagName('ele')[0]
    eles.push(el ? +el.textContent : 0)
  }
  const dists = [0]
  for (let i = 1; i < lats.length; i++) {
    dists.push(dists[i - 1] + haversine(lats[i - 1], lons[i - 1], lats[i], lons[i]))
  }
  return { lats, lons, eles, dists, doc, ns, pts: Array.from(pts), rawXml: xml }
}

// ────────────────────────────────────────────────────────────────────
// Serialization
// ────────────────────────────────────────────────────────────────────

/**
 * Build a GPX XML string from coordinate and elevation arrays.
 * Used when the original DOM is unavailable (e.g., after road-snap rebuild).
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} eles
 * @param {string} [name='route'] — track name
 * @returns {string} GPX XML string
 */
export function buildGPXString(lats, lons, eles, name = 'route') {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n'
  out += '<gpx version="1.1" creator="GPXForge" xmlns="http://www.topografix.com/GPX/1/1">\n'
  out += `<trk><name>${name}</name><trkseg>\n`
  for (let i = 0; i < lats.length; i++) {
    out += `<trkpt lat="${lats[i].toFixed(8)}" lon="${lons[i].toFixed(8)}">`
    out += `<ele>${eles[i].toFixed(3)}</ele></trkpt>\n`
  }
  out += '</trkseg></trk></gpx>'
  return out
}

/**
 * Serialize processed data back to GPX XML string.
 * If the original DOM is available and point count matches, mutates in-place.
 * Otherwise builds from scratch.
 * @param {object} gpxData — parsed GPX data from parseGPX()
 * @param {number[]} eleClean — processed elevation array
 * @param {number[]} [lats] — processed latitude array (if coordinates changed)
 * @param {number[]} [lons] — processed longitude array (if coordinates changed)
 * @returns {string} GPX XML string
 */
export function serializeGPX(gpxData, eleClean, lats, lons) {
  const useLats = lats || gpxData.lats
  const useLons = lons || gpxData.lons
  const useEles = eleClean || gpxData.eles

  // If no DOM or point count changed, build from scratch
  if (!gpxData.doc || !gpxData.pts || (lats && lats.length !== gpxData.pts.length)) {
    const name = gpxData.filename?.replace(/\.gpx$/i, '') || 'route'
    return buildGPXString(useLats, useLons, useEles, name)
  }

  // Mutate existing DOM
  const ns = gpxData.ns
  gpxData.pts.forEach((pt, i) => {
    const el = pt.getElementsByTagNameNS(ns, 'ele')[0] || pt.getElementsByTagName('ele')[0]
    if (el) el.textContent = useEles[i].toFixed(3)
    if (lats) {
      pt.setAttribute('lat', useLats[i].toFixed(8))
      pt.setAttribute('lon', useLons[i].toFixed(8))
    }
  })

  return new XMLSerializer().serializeToString(gpxData.doc)
}

/**
 * Trigger a GPX file download in the browser.
 * @param {string} gpxString — GPX XML content
 * @param {string} filename — download filename
 */
export function downloadGPX(gpxString, filename) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([gpxString], { type: 'application/gpx+xml' }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
