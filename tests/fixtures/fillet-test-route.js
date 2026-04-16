/**
 * Synthetic test route for fillet-based corner rounding.
 *
 * Generates a single continuous polyline in the Slovenian Alps with 5 test
 * sections connected end-to-end, each exercising a different corner scenario.
 *
 * Sections:
 *   1. Gentle 60° corner (CONTROL — should NOT be filleted at 100° threshold)
 *   2. Tight 120° hairpin (single vertex — should be filleted)
 *   3. S-curve: two ~110° corners in opposite directions, 24m apart
 *   4. Near-U-turn: 170° turn (extreme case)
 *   5. Multi-vertex hairpin: 120° spread across 3 vertices at 5m spacing
 *
 * Corner geometry: the vertex IS the last point of the approach arm.
 * The exit arm starts from the same position in a new direction.
 * Turn angle is measured at the vertex between approach and exit vectors.
 *
 * Coordinate system (lat 46°):
 *   1m north ≈ 0.000008993° lat
 *   1m east  ≈ 0.00001295° lon
 *   Point spacing: 12m (typical OSRM road snap output)
 *   Elevations: 350–410m range, 2–7% grades
 */

import { cumulativeDistances } from '../../src/utils/math.js'

const DLAT_PER_M = 0.000008993
const DLON_PER_M = 0.00001295
const DEG2RAD = Math.PI / 180
const SPACING = 12 // metres

// ── Helpers ──

/** Advance lat/lon along a compass bearing by distM metres. */
function advance(lat, lon, bearingDeg, distM) {
  const rad = bearingDeg * DEG2RAD
  return [
    lat + Math.cos(rad) * distM * DLAT_PER_M,
    lon + Math.sin(rad) * distM * DLON_PER_M,
  ]
}

// ── Route builder ──

/**
 * Build the complete 5-section fillet test route.
 *
 * @returns {{
 *   lats: number[], lons: number[], eles: number[], dists: number[],
 *   sections: Array<{
 *     name: string, startIdx: number, endIdx: number,
 *     turnAngle: number, shouldFillet: boolean,
 *     vertexIdx?: number, vertexIndices?: number[]
 *   }>
 * }}
 */
export function buildFilletTestRoute() {
  const lats = []
  const lons = []
  const eles = []
  const sections = []

  let curLat = 46.05, curLon = 14.50, curEle = 350, curBearing = 0

  function pushPt() {
    lats.push(curLat)
    lons.push(curLon)
    eles.push(curEle)
  }

  /** Append nPoints along current bearing. Returns index of last point added. */
  function appendArm(nPoints, stepM, grade) {
    for (let i = 0; i < nPoints; i++) {
      ;[curLat, curLon] = advance(curLat, curLon, curBearing, stepM)
      curEle += grade * stepM
      pushPt()
    }
    return lats.length - 1
  }

  function turn(deg) {
    curBearing = ((curBearing + deg) % 360 + 360) % 360
  }

  // ─── Section 1: Gentle 60° corner (control — NOT filleted) ───
  const s1Start = lats.length
  pushPt() // start point
  appendArm(6, SPACING, 0.03) // approach heading north
  const s1Vertex = lats.length - 1 // vertex = last approach point
  turn(60) // change direction at vertex
  appendArm(6, SPACING, 0.03) // exit heading NE
  sections.push({
    name: 'gentle-60deg',
    startIdx: s1Start,
    endIdx: lats.length - 1,
    turnAngle: 60,
    shouldFillet: false,
    vertexIdx: s1Vertex,
  })

  // ─── Link 1 (60m) ───
  appendArm(5, SPACING, 0.03)

  // ─── Section 2: Tight 120° hairpin (single vertex) ───
  const s2Start = lats.length - 1 // overlap with link end
  appendArm(6, SPACING, 0.05) // approach
  const s2Vertex = lats.length - 1 // vertex = last approach point
  turn(120) // hairpin turn
  appendArm(6, SPACING, 0.05) // exit
  sections.push({
    name: 'hairpin-120deg',
    startIdx: s2Start,
    endIdx: lats.length - 1,
    turnAngle: 120,
    shouldFillet: true,
    vertexIdx: s2Vertex,
  })

  // ─── Link 2 (60m) ───
  appendArm(5, SPACING, 0.04)

  // ─── Section 3: S-curve (two 110° corners, opposite directions) ───
  const s3Start = lats.length - 1
  appendArm(4, SPACING, 0.04) // approach
  const s3V1 = lats.length - 1 // first vertex
  turn(110) // right turn
  appendArm(2, SPACING, 0.04) // short straight (~24m)
  const s3V2 = lats.length - 1 // second vertex
  turn(-110) // left turn (opposite)
  appendArm(4, SPACING, 0.04) // exit
  sections.push({
    name: 's-curve-110deg',
    startIdx: s3Start,
    endIdx: lats.length - 1,
    turnAngle: 110,
    shouldFillet: true,
    vertexIndices: [s3V1, s3V2],
  })

  // ─── Link 3 (60m) ───
  appendArm(5, SPACING, 0.06)

  // ─── Section 4: Near-U-turn (170°) ───
  const s4Start = lats.length - 1
  appendArm(6, SPACING, 0.06) // approach
  const s4Vertex = lats.length - 1 // vertex
  turn(170)
  appendArm(6, SPACING, 0.06) // exit
  sections.push({
    name: 'u-turn-170deg',
    startIdx: s4Start,
    endIdx: lats.length - 1,
    turnAngle: 170,
    shouldFillet: true,
    vertexIdx: s4Vertex,
  })

  // ─── Link 4 (60m) ───
  appendArm(5, SPACING, 0.07)

  // ─── Section 5: Multi-vertex hairpin (120° across 3 vertices, 5m spacing) ───
  const s5Start = lats.length - 1
  appendArm(6, SPACING, 0.07) // approach
  // Three sub-vertices, each turning 40°, with 5m advances between them
  const s5Vertices = []
  for (let v = 0; v < 3; v++) {
    // Last approach point or previous sub-vertex advance is the vertex
    const vertexIdx = lats.length - 1
    s5Vertices.push(vertexIdx)
    turn(40)
    if (v < 2) {
      // Advance 5m to next sub-vertex position (creates the exit segment for this vertex)
      ;[curLat, curLon] = advance(curLat, curLon, curBearing, 5)
      curEle += 0.07 * 5
      pushPt()
    }
  }
  appendArm(6, SPACING, 0.07) // exit arm from last sub-vertex
  sections.push({
    name: 'multi-vertex-120deg',
    startIdx: s5Start,
    endIdx: lats.length - 1,
    turnAngle: 120,
    subTurnAngle: 40,
    shouldFillet: true,
    vertexIndices: s5Vertices,
  })

  const dists = cumulativeDistances(lats, lons)

  return { lats, lons, eles, dists, sections }
}

/**
 * Export the test route as a GPX XML string for visual testing.
 */
export function buildFilletTestGPX() {
  const { lats, lons, eles } = buildFilletTestRoute()
  const pts = lats.map((lat, i) =>
    `      <trkpt lat="${lat.toFixed(8)}" lon="${lons[i].toFixed(8)}"><ele>${eles[i].toFixed(1)}</ele></trkpt>`
  ).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPXForge fillet test">
  <trk>
    <name>Fillet Test Route — 5 corner scenarios</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`
}
