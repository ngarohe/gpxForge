/**
 * LIDAR elevation API client.
 *
 * Defaults to same-origin API calls so the public/self-hosted release can serve
 * the frontend and backend from one origin. During development, callers can set
 * VITE_LIDAR_BASE_URL to override the backend origin explicitly.
 */

const RAW_LIDAR_BASE_URL = (import.meta.env.VITE_LIDAR_BASE_URL || '').trim()
const LIDAR_BASE_URL = RAW_LIDAR_BASE_URL.replace(/\/+$/, '')

function lidarUrl(path) {
  return LIDAR_BASE_URL ? `${LIDAR_BASE_URL}${path}` : path
}

/**
 * Check if the LIDAR server is reachable.
 * @returns {Promise<boolean>}
 */
export async function lidarServerAvailable() {
  try {
    const res = await fetch(lidarUrl('/api/health'), { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Send a GPX string to the LIDAR elevation server and return enriched GPX text.
 *
 * @param {string} gpxString — GPX XML to enrich
 * @param {string} filename — original filename (for download_name on server)
 * @returns {Promise<{ gpxText: string, summary: string, countries: string }>}
 * @throws {Error} with a user-facing message on failure
 */
export async function fetchLidarElevations(gpxString, filename = 'route.gpx') {
  const blob = new Blob([gpxString], { type: 'application/gpx+xml' })
  const form = new FormData()
  form.append('file', blob, filename)

  let res
  try {
    res = await fetch(lidarUrl('/api/elevation'), { method: 'POST', body: form })
  } catch {
    const target = LIDAR_BASE_URL || 'the current site origin'
    throw new Error(
      `Cannot reach LIDAR server at ${target}.\n` +
      'Make sure the GPXForge server is running and exposing /api/elevation.'
    )
  }

  if (res.status === 422) {
    const body = await res.json().catch(() => ({}))
    const supported = body.supported ? ` Supported: ${body.supported.join(', ')}.` : ''
    throw new Error((body.error || 'Unsupported country') + supported)
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Server error ${res.status}`)
  }

  const gpxText = await res.text()
  const summary = res.headers.get('X-Summary') || ''
  const countries = res.headers.get('X-Countries') || ''
  const source = res.headers.get('X-Elevation-Source') || ''
  const sourceList = res.headers.get('X-Elevation-Sources') || ''
  const sources = parseElevationSourcesHeader(sourceList)

  return { gpxText, summary, countries, source, sources }
}

function parseElevationSourcesHeader(raw) {
  const out = {}
  if (!raw) return out
  for (const part of raw.split(',')) {
    const [nameRaw, countRaw] = part.split(':')
    const name = (nameRaw || '').trim()
    const count = Number((countRaw || '').trim())
    if (!name || !Number.isFinite(count)) continue
    out[name] = count
  }
  return out
}
