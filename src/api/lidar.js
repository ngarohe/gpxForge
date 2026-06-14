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
/** A transient upstream-provider error worth retrying (read truncation / timeout / 5xx). */
function isTransientLidarError(status, message) {
  if (status === 502 || status === 503 || status === 504) return true
  return status === 500 && /IncompleteRead|timed out|timeout|read|connection|reset|EOF/i.test(message || '')
}

export async function fetchLidarElevations(gpxString, filename = 'route.gpx') {
  const blob = new Blob([gpxString], { type: 'application/gpx+xml' })
  const form = new FormData()
  form.append('file', blob, filename)

  // The upstream elevation providers (e.g. ARSO/SI) occasionally truncate a response
  // (IncompleteRead) or time out — the local server surfaces that as a 500. These are transient,
  // so retry a couple of times with a short backoff before giving up (a created course hit this
  // while a route built moments earlier succeeded — purely a provider hiccup).
  const MAX_ATTEMPTS = 3
  let lastErr = null
  let res = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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

    if (res.ok) break

    const body = await res.json().catch(() => ({}))
    lastErr = body.error || `Server error ${res.status}`
    if (attempt < MAX_ATTEMPTS && isTransientLidarError(res.status, lastErr)) {
      await new Promise((r) => setTimeout(r, 600 * attempt))   // 0.6s, 1.2s backoff
      continue
    }
    throw new Error(lastErr)
  }

  const gpxText = await res.text()
  const summary = res.headers.get('X-Summary') || ''
  const countries = res.headers.get('X-Countries') || ''
  const source = res.headers.get('X-Elevation-Source') || ''
  const sourceList = res.headers.get('X-Elevation-Sources') || ''
  const sources = parseElevationSourcesHeader(sourceList)
  const sourceSegments = parseSourceSegmentsHeader(res.headers.get('X-Source-Segments') || '')

  return { gpxText, summary, countries, source, sources, sourceSegments }
}

/**
 * Parse "0-3400:PT_MDT2M,3401-6200:ES_WCS_5M" into [{start, end, source}].
 * @param {string} raw
 * @returns {Array<{start: number, end: number, source: string}>}
 */
function parseSourceSegmentsHeader(raw) {
  if (!raw) return []
  const out = []
  for (const part of raw.split(',')) {
    const [rangeStr, source] = part.split(':')
    if (!rangeStr || !source) continue
    const [startStr, endStr] = rangeStr.split('-')
    const start = Number(startStr)
    const end = Number(endStr)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    out.push({ start, end, source: source.trim() })
  }
  return out
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
