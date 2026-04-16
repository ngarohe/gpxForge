/**
 * OpenTopoData API client for elevation data.
 *
 * Uses the EU-DEM 25m dataset. Single attempt with graceful fallback.
 */

const BASE_URL = 'https://api.opentopodata.org/v1/eudem25m'

/**
 * Fetch elevation for one or more points from OpenTopoData.
 * @param {{ lat: number, lon: number }[]} points — max ~100 per request
 * @returns {Promise<(number | null)[]>} elevation in metres for each point, null on failure
 */
export async function fetchElevations(points) {
  try {
    const locations = points.map(p => `${p.lat},${p.lon}`).join('|')
    const res = await fetch(`${BASE_URL}?locations=${locations}`)
    if (!res.ok) return points.map(() => null)
    const json = await res.json()
    return (json.results || []).map(r => r?.elevation ?? null)
  } catch {
    return points.map(() => null)
  }
}

/**
 * Fetch elevation for exactly two seam points (used during trim gap-fill).
 * Returns the original elevations as fallback on failure.
 * @param {number} latA
 * @param {number} lonA
 * @param {number} latB
 * @param {number} lonB
 * @param {number} fallbackA — original elevation for point A
 * @param {number} fallbackB — original elevation for point B
 * @returns {Promise<{ eleA: number, eleB: number }>}
 */
export async function fetchSeamElevations(latA, lonA, latB, lonB, fallbackA, fallbackB) {
  const elevations = await fetchElevations([
    { lat: latA, lon: lonA },
    { lat: latB, lon: lonB },
  ])
  return {
    eleA: elevations[0] ?? fallbackA,
    eleB: elevations[1] ?? fallbackB,
  }
}
