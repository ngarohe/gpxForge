/**
 * Overpass API client for fetching OSM bridge and tunnel geometry.
 *
 * Hardening goals:
 * - mirror fallback with retries on transient errors
 * - Retry-After aware backoff for 429/503
 * - optional tile fallback when a large bbox times out
 */

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504])
const REQUEST_TIMEOUT_MS = 70000
const QUERY_TIMEOUT_SEC = 60
const ATTEMPTS_PER_SERVER = 3
const RETRY_BASE_DELAY_MS = 1200
const SERVER_SWITCH_DELAY_MS = 700

const CH_BOUNDS = { minLat: 45.6, minLon: 5.7, maxLat: 47.9, maxLon: 10.7 }

const PRIMARY_SERVERS = [
  { name: 'Overpass DE', url: 'https://overpass-api.de/api/interpreter' },
  { name: 'Overpass Private', url: 'https://overpass.private.coffee/api/interpreter' },
  // Legacy alias still works sometimes, keep as extra fallback.
  { name: 'Overpass Kumi', url: 'https://overpass.kumi.systems/api/interpreter' },
  { name: 'Overpass MailRU', url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter' },
]

const REGIONAL_SERVERS = [
  {
    name: 'Overpass CH',
    url: 'https://overpass.osm.ch/api/interpreter',
    isRelevant: (bounds) => intersects(bounds, CH_BOUNDS),
  },
]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function intersects(a, b) {
  return !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon)
}

function getActiveServers(bounds) {
  const servers = [...PRIMARY_SERVERS]
  for (const server of REGIONAL_SERVERS) {
    if (!server.isRelevant || server.isRelevant(bounds)) {
      // Try regional servers before the less reliable public mirrors.
      servers.splice(2, 0, server)
    }
  }
  return servers
}

/**
 * Build an Overpass QL query for bridges and tunnels within a bounding box.
 * Excludes rail infrastructure, waterways, and closed ways (buildings).
 * @param {{ minLat: number, minLon: number, maxLat: number, maxLon: number }} bounds
 * @param {number} timeoutSec
 * @returns {string}
 */
function buildQuery(bounds, timeoutSec = QUERY_TIMEOUT_SEC) {
  const { minLat, minLon, maxLat, maxLon } = bounds
  const baseFilters = '[!waterway]'
  const railTypes = 'rail|light_rail|subway|tram|narrow_gauge|funicular|monorail|miniature|preserved'
  const railExcl = `["railway"~"^(${railTypes})$"]${baseFilters}(if:!is_closed());`
  return `[out:json][timeout:${timeoutSec}][bbox:${minLat},${minLon},${maxLat},${maxLon}];
(
  (
    way[bridge]${baseFilters}(if:!is_closed());
    - way[bridge]${railExcl}
  );
  way[bridge][highway=cycleway](if:!is_closed());
  way[man_made=viaduct]${baseFilters}(if:!is_closed());
);
out count;
out geom qt;
(
  (
    way[tunnel]["tunnel"!="building_passage"]${baseFilters}(if:!is_closed());
    - way[tunnel]${railExcl}
  );
  way[tunnel]["tunnel"!="building_passage"][highway=cycleway](if:!is_closed());
);
out count;
out geom qt;`
}

/**
 * Extract a display name from OSM tags.
 * @param {object} tags
 * @returns {string}
 */
function extractName(tags) {
  for (const key of ['name', 'name:en', 'ref', 'bridge:name', 'tunnel:name']) {
    if (tags[key]) return tags[key]
  }
  const hw = tags.highway || ''
  return hw
    ? hw.charAt(0).toUpperCase() + hw.slice(1)
    : (tags.bridge || tags.man_made === 'viaduct' ? 'Bridge' : 'Tunnel')
}

/**
 * Parse Overpass JSON response into bridge/tunnel arrays.
 * @param {object} data
 * @returns {{ bridges: object[], tunnels: object[] }}
 */
function parseOverpassResponse(data) {
  const result = { bridges: [], tunnels: [] }
  if (!data || !Array.isArray(data.elements)) return result

  let curType = null
  for (const el of data.elements) {
    if (el.type === 'count') {
      curType = curType === 'bridges' ? 'tunnels' : 'bridges'
      continue
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
    if (curType !== 'bridges' && curType !== 'tunnels') continue

    const valid = el.geometry.filter((n) =>
      typeof n.lat === 'number'
      && typeof n.lon === 'number'
      && n.lat >= -80 && n.lat <= 80
      && n.lon >= -180 && n.lon <= 180
    )
    if (valid.length < 2) continue

    const name = extractName(el.tags || {})
    result[curType].push({ id: el.id, geometry: valid, name })
  }
  return result
}

function parseRetryAfterMs(headers) {
  const raw = headers.get('Retry-After')
  if (!raw) return null

  const sec = Number(raw)
  if (Number.isFinite(sec)) {
    return Math.max(0, Math.min(120000, sec * 1000))
  }
  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(120000, dateMs - Date.now()))
  }
  return null
}

function summarizeBody(txt, maxLen = 180) {
  return String(txt || '').replace(/\s+/g, ' ').trim().slice(0, maxLen)
}

function buildAttemptError(server, attempt, status, body, retryable, reason) {
  const err = new Error(reason || (status ? `HTTP ${status}` : 'request failed'))
  err.server = server
  err.attempt = attempt
  err.status = status || null
  err.retryable = Boolean(retryable)
  err.body = body || ''
  return err
}

async function queryOverpass(server, query) {
  const resp = await fetch(server.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const text = await resp.text()
  if (!resp.ok) {
    const retryable = RETRYABLE_HTTP.has(resp.status)
    const msg = `HTTP ${resp.status}${text ? `: ${summarizeBody(text)}` : ''}`
    const err = buildAttemptError(server, 0, resp.status, text, retryable, msg)
    err.retryAfterMs = parseRetryAfterMs(resp.headers)
    throw err
  }

  let data
  try {
    data = JSON.parse(text)
  } catch {
    const maybeRetry = /too many|rate|timeout|temporar|busy|try again|gateway/i.test(text)
    throw buildAttemptError(server, 0, null, text, maybeRetry, `Invalid JSON: ${summarizeBody(text)}`)
  }
  return data
}

function isTransientError(err) {
  if (err && typeof err.retryable === 'boolean') return err.retryable
  const msg = String(err?.message || '')
  return /timeout|network|fetch|gateway|temporar|rate|too many/i.test(msg)
}

function splitBounds(bounds, rows = 2, cols = 2) {
  const latStep = (bounds.maxLat - bounds.minLat) / rows
  const lonStep = (bounds.maxLon - bounds.minLon) / cols
  const out = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        minLat: bounds.minLat + r * latStep,
        maxLat: r === rows - 1 ? bounds.maxLat : bounds.minLat + (r + 1) * latStep,
        minLon: bounds.minLon + c * lonStep,
        maxLon: c === cols - 1 ? bounds.maxLon : bounds.minLon + (c + 1) * lonStep,
      })
    }
  }
  return out
}

function mergeUniqueStructures(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = `${item.id}:${item.type}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

async function fetchFromMirrors(bounds, onProgress, progressBase, progressSpan) {
  const servers = getActiveServers(bounds)
  const query = buildQuery(bounds, QUERY_TIMEOUT_SEC)
  const failures = []

  for (let si = 0; si < servers.length; si++) {
    const server = servers[si]
    if (si > 0) await sleep(SERVER_SWITCH_DELAY_MS)

    for (let attempt = 0; attempt < ATTEMPTS_PER_SERVER; attempt++) {
      const rel = (si + (attempt / ATTEMPTS_PER_SERVER)) / Math.max(1, servers.length)
      onProgress?.(
        Math.min(99, Math.round(progressBase + progressSpan * rel)),
        `Overpass: ${server.name} (${attempt + 1}/${ATTEMPTS_PER_SERVER})`,
      )

      if (attempt > 0) {
        const baseDelay = RETRY_BASE_DELAY_MS * (attempt + 1)
        await sleep(baseDelay)
      }

      try {
        const data = await queryOverpass(server, query)
        return parseOverpassResponse(data)
      } catch (err) {
        const failure = {
          server: server.name,
          attempt: attempt + 1,
          status: err?.status ?? null,
          retryable: isTransientError(err),
          message: String(err?.message || 'Unknown error'),
        }
        failures.push(failure)

        if (failure.retryable && attempt < ATTEMPTS_PER_SERVER - 1) {
          const retryAfterMs = Number.isFinite(err?.retryAfterMs) ? err.retryAfterMs : null
          if (retryAfterMs && retryAfterMs > 0) await sleep(retryAfterMs)
          continue
        }
        break
      }
    }
  }

  const hasTransient = failures.some((f) => f.retryable)
  const short = failures.slice(-4).map((f) => `${f.server}#${f.attempt}: ${f.message}`).join(' | ')
  const err = new Error(`Overpass unavailable: ${short || 'all mirrors failed'}`)
  err.hasTransient = hasTransient
  err.failures = failures
  throw err
}

async function fetchTiled(bounds, onProgress) {
  const tiles = splitBounds(bounds, 2, 2)
  const merged = []
  let okTiles = 0

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]
    const tileBase = 40 + Math.round((i / tiles.length) * 45)
    const tileSpan = Math.max(6, Math.floor(45 / tiles.length))
    onProgress?.(tileBase, `Overpass fallback tile ${i + 1}/${tiles.length}...`)
    try {
      const res = await fetchFromMirrors(tile, onProgress, tileBase, tileSpan)
      for (const b of res.bridges) merged.push({ ...b, type: 'bridge' })
      for (const t of res.tunnels) merged.push({ ...t, type: 'tunnel' })
      okTiles++
    } catch (err) {
      // Keep going: partial tile success is still useful.
      console.warn(`[Overpass] Tile ${i + 1}/${tiles.length} failed:`, err?.message || err)
    }
  }

  if (okTiles === 0) {
    throw new Error('Overpass unavailable: tile fallback failed')
  }

  const uniq = mergeUniqueStructures(merged)
  return {
    bridges: uniq.filter((x) => x.type === 'bridge').map(({ type, ...rest }) => rest),
    tunnels: uniq.filter((x) => x.type === 'tunnel').map(({ type, ...rest }) => rest),
  }
}

/**
 * Fetch bridges and tunnels from Overpass API with mirror fallback and retries.
 *
 * On transient global failures (timeouts/429/5xx), it retries using a tiled
 * bbox fallback (2x2) and returns merged unique ways.
 *
 * @param {{ minLat: number, minLon: number, maxLat: number, maxLon: number }} bounds
 * @param {(pct:number,msg?:string)=>void} [onProgress]
 * @returns {Promise<{ bridges: object[], tunnels: object[] }>}
 */
export async function fetchBridgesAndTunnels(bounds, onProgress) {
  onProgress?.(10, 'Fetching from Overpass...')
  try {
    return await fetchFromMirrors(bounds, onProgress, 10, 70)
  } catch (err) {
    const shouldTileFallback = Boolean(err?.hasTransient)
    if (!shouldTileFallback) throw err
    onProgress?.(38, 'Overpass busy, retrying in smaller tiles...')
    return fetchTiled(bounds, onProgress)
  }
}
