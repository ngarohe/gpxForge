/**
 * Resolution-aware densification for LIDAR fetching.
 *
 * Detects the route's country via bounding-box lookup and densifies
 * the route to the provider's native resolution before sending to
 * the elevation server. Only called from the LIDAR fetch handler.
 */

import { resampleRoute } from './geometry.js'

// Native provider resolutions in metres
const PROVIDER_RESOLUTION = {
  FR: 1, CH: 2, SI: 1, ES: 5, NL: 1, HR: 20, NO: 1,
  FI: 2, US: 1, EE: 1, DK: 1, DE: 1, PL: 1,
  GB: 1, CA: 1, NZ: 1, AT: 10, BE: 1, AU: 5, MX: 5, HK: 1,
  DEFAULT: 5,
}

// Bounding boxes: [cc, latMin, latMax, lonMin, lonMax]
// Ordered small → large so specific countries match before overlapping larger ones.
const COUNTRY_BOXES = [
  ['HK', 22.15, 22.56, 113.83, 114.41],
  ['SI', 45.42, 46.88, 13.38, 16.60],
  ['HR', 42.39, 46.55, 13.49, 19.43],
  ['LU', 49.45, 50.18, 5.73, 6.53],
  ['EE', 57.51, 59.68, 21.84, 28.21],
  ['DK', 54.56, 57.75, 8.08, 15.20],
  ['NL', 50.75, 53.47, 3.36, 7.21],
  ['BE', 49.50, 51.50, 2.55, 6.40],
  ['CH', 45.82, 47.81, 5.96, 10.49],
  ['AT', 46.37, 49.02, 9.53, 17.16],
  ['PL', 49.00, 54.84, 14.12, 24.15],
  ['DE', 47.27, 55.06, 5.87, 15.04],
  ['FR', 41.36, 51.09, -5.14, 9.56],
  ['ES', 36.00, 43.79, -9.30, 3.32],
  ['NO', 57.96, 71.19, 4.64, 31.08],
  ['FI', 59.81, 70.09, 20.65, 31.59],
  ['GB', 49.96, 60.85, -8.17, 1.77],
  ['IT', 36.65, 47.09, 6.63, 18.52],
  ['US', 24.40, 49.38, -124.85, -66.93],
  ['CA', 41.68, 83.11, -141.00, -52.62],
  ['AU', -43.64, -10.06, 113.16, 153.64],
  ['NZ', -47.29, -34.39, 166.43, 178.52],
  ['MX', 14.53, 32.72, -118.37, -86.71],
]

/**
 * Detect the country for a single lat/lon point via bounding-box lookup.
 * @param {number} lat
 * @param {number} lon
 * @returns {string|null} 2-letter country code or null
 */
function detectCountryAtPoint(lat, lon) {
  for (const [cc, latMin, latMax, lonMin, lonMax] of COUNTRY_BOXES) {
    if (lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax) {
      return cc
    }
  }
  return null
}

/**
 * Detect the primary country of a route using its midpoint.
 * @param {number[]} lats
 * @param {number[]} lons
 * @returns {string|null}
 */
export function detectPrimaryCountry(lats, lons) {
  const mid = Math.floor(lats.length / 2)
  return detectCountryAtPoint(lats[mid], lons[mid])
}

/**
 * Get the target LIDAR resolution for a route, accounting for cross-border.
 * Samples 5 points along the route and returns the finest (smallest) resolution.
 * @param {number[]} lats
 * @param {number[]} lons
 * @returns {number} target spacing in metres
 */
export function getTargetResolution(lats, lons) {
  const N = lats.length
  const checkIndices = [
    0,
    Math.floor(N / 4),
    Math.floor(N / 2),
    Math.floor(3 * N / 4),
    N - 1,
  ]

  let finest = PROVIDER_RESOLUTION.DEFAULT
  for (const idx of checkIndices) {
    const cc = detectCountryAtPoint(lats[idx], lons[idx])
    const res = (cc && PROVIDER_RESOLUTION[cc]) || PROVIDER_RESOLUTION.DEFAULT
    if (res < finest) finest = res
  }
  return finest
}

/**
 * Densify a route to a provider's native resolution if current spacing is coarser.
 * Only called from the LIDAR fetch handler — never from snap or upload.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]|Float64Array} dists — cumulative distances
 * @param {number} targetSpacingM — provider's native resolution
 * @returns {{ lats: number[], lons: number[], dists: number[], wasDensified: boolean, originalCount: number, newCount: number }}
 */
export function densifyForLidar(lats, lons, dists, targetSpacingM) {
  const N = lats.length
  if (N < 2) {
    return { lats: [...lats], lons: [...lons], dists: [...dists], wasDensified: false, originalCount: N, newCount: N }
  }

  const totalDist = dists[N - 1]
  const avgSpacing = totalDist / (N - 1)

  // Don't densify if already at or below target resolution
  if (avgSpacing <= targetSpacingM * 1.5) {
    return { lats, lons, dists, wasDensified: false, originalCount: N, newCount: N }
  }

  const result = resampleRoute(lats, lons, dists, targetSpacingM)
  return {
    lats: result.lats,
    lons: result.lons,
    dists: result.dists,
    wasDensified: true,
    originalCount: N,
    newCount: result.lats.length,
  }
}
