/**
 * Step 0: Trim — remove unwanted route sections (pitstops, detours, wrong turns).
 *
 * Click two points on chart/map to mark cut boundaries.
 * Three trim types: start (cut from beginning), end (cut from end),
 * mid (cut a section in the middle).
 *
 * Mid-trims query OpenTopoData for seam elevation fix.
 */

import { haversine, cumulativeDistances, grads } from '../utils/math.js'
import { fetchSeamElevations } from '../api/opentopodata.js'

// ────────────────────────────────────────────────────────────────────
// Trim type detection
// ────────────────────────────────────────────────────────────────────

/** Number of points from start/end that counts as a boundary trim. */
const BOUNDARY_PTS = 10

/**
 * Detect trim type from marker indices.
 * @param {number} idxA — first marker index (lower)
 * @param {number} idxB — second marker index (higher)
 * @param {number} N — total number of points
 * @returns {'start'|'end'|'mid'}
 */
export function detectTrimType(idxA, idxB, N) {
  if (idxA <= BOUNDARY_PTS) return 'start'
  if (idxB >= N - 1 - BOUNDARY_PTS) return 'end'
  return 'mid'
}

// ────────────────────────────────────────────────────────────────────
// Execute trim
// ────────────────────────────────────────────────────────────────────

/**
 * Execute a trim operation, producing new route arrays.
 * For mid-trims, queries OpenTopoData for seam elevation correction.
 *
 * @param {{ lats: number[], lons: number[], eles: number[] }} gpx
 * @param {number[]} eleClean — current clean elevations (or raw eles)
 * @param {number} idxA — first cut boundary (lower index)
 * @param {number} idxB — second cut boundary (higher index)
 * @param {'start'|'end'|'mid'} trimType
 * @returns {Promise<{ lats: number[], lons: number[], eles: number[], eleClean: number[] }>}
 */
export async function executeTrim(gpx, eleClean, idxA, idxB, trimType) {
  const { lats, lons, eles } = gpx
  let newLats, newLons, newEles, newEleClean

  if (trimType === 'start') {
    // Keep everything from idxB onward
    newLats = lats.slice(idxB)
    newLons = lons.slice(idxB)
    newEles = eles.slice(idxB)
    newEleClean = eleClean.slice(idxB)
  } else if (trimType === 'end') {
    // Keep everything up to and including idxA
    newLats = lats.slice(0, idxA + 1)
    newLons = lons.slice(0, idxA + 1)
    newEles = eles.slice(0, idxA + 1)
    newEleClean = eleClean.slice(0, idxA + 1)
  } else {
    // Mid trim — keep [0..idxA] + [idxB..end]
    newLats = [...lats.slice(0, idxA + 1), ...lats.slice(idxB)]
    newLons = [...lons.slice(0, idxA + 1), ...lons.slice(idxB)]
    newEles = [...eles.slice(0, idxA + 1), ...eles.slice(idxB)]
    newEleClean = [...eleClean.slice(0, idxA + 1), ...eleClean.slice(idxB)]

    // Fix seam elevations via OpenTopoData
    const seamA = idxA
    const seamB = idxA + 1
    try {
      const { eleA, eleB } = await fetchSeamElevations(
        newLats[seamA], newLons[seamA],
        newLats[seamB], newLons[seamB],
        newEles[seamA], newEles[seamB],
      )
      newEles[seamA] = eleA
      newEles[seamB] = eleB
      newEleClean[seamA] = eleA
      newEleClean[seamB] = eleB
    } catch (err) {
      console.warn('[Trim] Seam elevation fetch failed, using original values:', err.message)
    }
  }

  // Fix boundary elevations (zero gradient at endpoints)
  fixBoundaryElevations(newEles)
  fixBoundaryElevations(newEleClean)

  return { lats: newLats, lons: newLons, eles: newEles, eleClean: newEleClean }
}

// ────────────────────────────────────────────────────────────────────
// Boundary fix
// ────────────────────────────────────────────────────────────────────

/**
 * Copy neighbor elevation to endpoints to avoid artificial gradient spikes.
 * @param {number[]} eles — mutable elevation array
 */
export function fixBoundaryElevations(eles) {
  if (eles.length >= 2) {
    eles[0] = eles[1]
    eles[eles.length - 1] = eles[eles.length - 2]
  }
}

// ────────────────────────────────────────────────────────────────────
// Route rebuild
// ────────────────────────────────────────────────────────────────────

/**
 * Rebuild cumulative distances and gradients from new coordinate arrays.
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} eles — raw elevations
 * @param {number[]} eleClean — cleaned elevations
 * @returns {{ dists: number[], grOrig: number[], grClean: number[] }}
 */
export function rebuildRoute(lats, lons, eles, eleClean) {
  const dists = cumulativeDistances(lats, lons)
  const grOrig = grads(eles, dists)
  const grClean = grads(eleClean, dists)
  return { dists, grOrig, grClean }
}

/**
 * Calculate the gap distance between two trim markers.
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} idxA
 * @param {number} idxB
 * @returns {number} gap distance in metres
 */
export function trimGapDistance(lats, lons, idxA, idxB) {
  return haversine(lats[idxA], lons[idxA], lats[idxB], lons[idxB])
}

// ────────────────────────────────────────────────────────────────────
// Trim history snapshot
// ────────────────────────────────────────────────────────────────────

/**
 * Create a snapshot of the current route state for trim undo.
 * @param {{ lats: number[], lons: number[], eles: number[] }} gpx
 * @param {*} dists
 * @param {*} grOrig
 * @param {*} eleClean
 * @param {*} grClean
 * @returns {object} snapshot that can be passed to restoreTrimSnapshot()
 */
export function trimSnapshot(gpx, dists, grOrig, eleClean, grClean) {
  return {
    gpx: {
      ...gpx,
      lats: [...gpx.lats],
      lons: [...gpx.lons],
      eles: [...gpx.eles],
    },
    dists: dists instanceof Float64Array ? new Float64Array(dists) : [...dists],
    grOrig: grOrig ? (grOrig instanceof Float64Array ? new Float64Array(grOrig) : [...grOrig]) : null,
    eleClean: eleClean ? [...eleClean] : null,
    grClean: grClean ? (grClean instanceof Float64Array ? new Float64Array(grClean) : [...grClean]) : null,
  }
}
