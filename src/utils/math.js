/**
 * Pure math utilities — no DOM, no state, no side effects.
 *
 * All distances are in metres, angles in degrees unless noted.
 * Functions ported from processGPX (djconnel) are marked with [processGPX].
 */

const R_EARTH = 6371000 // Earth radius in metres
const DEG2RAD = Math.PI / 180

// ────────────────────────────────────────────────────────────────────
// Distance
// ────────────────────────────────────────────────────────────────────

/**
 * Haversine distance between two lat/lon points.
 * @param {number} lat1 — latitude of point 1 (degrees)
 * @param {number} lon1 — longitude of point 1 (degrees)
 * @param {number} lat2 — latitude of point 2 (degrees)
 * @param {number} lon2 — longitude of point 2 (degrees)
 * @returns {number} distance in metres
 */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG2RAD
  const dLon = (lon2 - lon1) * DEG2RAD
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.sqrt(a))
}

/**
 * Build cumulative distance array from coordinate arrays.
 * @param {number[]} lats
 * @param {number[]} lons
 * @returns {number[]} cumulative distances in metres, starting at 0
 */
export function cumulativeDistances(lats, lons) {
  const dists = [0]
  for (let i = 1; i < lats.length; i++) {
    dists.push(dists[i - 1] + haversine(lats[i - 1], lons[i - 1], lats[i], lons[i]))
  }
  return dists
}

// ────────────────────────────────────────────────────────────────────
// Bearing
// ────────────────────────────────────────────────────────────────────

/**
 * Initial bearing from point A to point B (forward azimuth).
 * @returns {number} bearing in degrees [0, 360)
 */
export function bearing(lat1, lon1, lat2, lon2) {
  const r = DEG2RAD
  const dLon = (lon2 - lon1) * r
  const y = Math.sin(dLon) * Math.cos(lat2 * r)
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r)
    - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon)
  return (Math.atan2(y, x) / r + 360) % 360
}

/**
 * Smallest angle between two bearings (always 0–90°).
 * Used for brunnel alignment checks — treats opposite directions as aligned.
 * @returns {number} difference in degrees [0, 90]
 */
export function bearingDiff(b1, b2) {
  let d = Math.abs(b1 - b2) % 360
  if (d > 180) d = 360 - d
  if (d > 90) d = 180 - d
  return d
}

// ────────────────────────────────────────────────────────────────────
// Gradient
// ────────────────────────────────────────────────────────────────────

/**
 * Compute gradient array in % (100 × dz/ds) from elevation + distance arrays.
 * Last element copies the previous value to maintain array length.
 * @param {number[]} eles — elevation array
 * @param {number[]} dists — cumulative distance array
 * @returns {number[]} gradient percentage array
 */
export function grads(eles, dists) {
  const N = eles.length
  const gr = new Array(N)
  for (let i = 0; i < N - 1; i++) {
    const ds = dists[i + 1] - dists[i]
    gr[i] = ds > 0.01 ? 100 * (eles[i + 1] - eles[i]) / ds : 0
  }
  gr[N - 1] = gr[N - 2] ?? 0
  return gr
}

/**
 * Calculate total ascent and descent from an elevation array.
 * @param {number[]} eles
 * @returns {{ asc: number, desc: number }} rounded metres
 */
export function ascDesc(eles) {
  let a = 0, d = 0
  for (let i = 1; i < eles.length; i++) {
    const dv = eles[i] - eles[i - 1]
    if (dv > 0) a += dv; else d -= dv
  }
  return { asc: Math.round(a), desc: Math.round(d) }
}

// ────────────────────────────────────────────────────────────────────
// Interpolation
// ────────────────────────────────────────────────────────────────────

/**
 * Hermite elevation interpolation for bridge shapes.
 * @param {number} t — parameter [0, 1]
 * @param {number} e0 — elevation at start
 * @param {number} e1 — elevation at end
 * @param {number} m0 — slope at start (fraction, not %)
 * @param {number} m1 — slope at end (fraction, not %)
 * @param {number} S — span distance in metres
 * @returns {number} interpolated elevation
 */
export function hermiteElevation(t, e0, e1, m0, m1, S) {
  const h00 = 2 * t ** 3 - 3 * t ** 2 + 1
  const h10 = t ** 3 - 2 * t ** 2 + t
  const h01 = -2 * t ** 3 + 3 * t ** 2
  const h11 = t ** 3 - t ** 2
  return h00 * e0 + h10 * m0 * S + h01 * e1 + h11 * m1 * S
}

/**
 * Linear interpolation between two values.
 * @param {number} a — start value
 * @param {number} b — end value
 * @param {number} t — parameter [0, 1]
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + t * (b - a)
}

/**
 * Clamp a value between min and max.
 * @param {number} val
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(val, lo, hi) {
  return Math.max(lo, Math.min(hi, val))
}

// ────────────────────────────────────────────────────────────────────
// Turn angle
// ────────────────────────────────────────────────────────────────────

/**
 * Find the maximum turn angle across all interior points.
 * Works in degree-space (good enough for local angle calculation).
 * @param {number[]} lats
 * @param {number[]} lons
 * @returns {number} max turn in degrees (0 = straight, 180 = U-turn)
 */
export function maxTurnDeg(lats, lons) {
  let maxTurn = 0
  for (let i = 1; i < lats.length - 1; i++) {
    const ax = lats[i - 1] - lats[i], ay = lons[i - 1] - lons[i]
    const bx = lats[i + 1] - lats[i], by = lons[i + 1] - lons[i]
    const ma = Math.sqrt(ax * ax + ay * ay)
    const mb = Math.sqrt(bx * bx + by * by)
    if (ma < 1e-12 || mb < 1e-12) continue
    const cosA = clamp((ax * bx + ay * by) / (ma * mb), -1, 1)
    const turn = 180 - Math.acos(cosA) * 180 / Math.PI
    if (turn > maxTurn) maxTurn = turn
  }
  return maxTurn
}

/**
 * Calculate turn angle at a single interior point.
 * @param {number} lat0 — previous point lat
 * @param {number} lon0 — previous point lon
 * @param {number} lat1 — current point lat
 * @param {number} lon1 — current point lon
 * @param {number} lat2 — next point lat
 * @param {number} lon2 — next point lon
 * @returns {number} turn angle in degrees (0 = straight, 180 = U-turn)
 */
export function turnAngleDeg(lat0, lon0, lat1, lon1, lat2, lon2) {
  const ax = lat0 - lat1, ay = lon0 - lon1
  const bx = lat2 - lat1, by = lon2 - lon1
  const ma = Math.sqrt(ax * ax + ay * ay)
  const mb = Math.sqrt(bx * bx + by * by)
  if (ma < 1e-12 || mb < 1e-12) return 0
  const cosA = clamp((ax * bx + ay * by) / (ma * mb), -1, 1)
  return 180 - Math.acos(cosA) * 180 / Math.PI
}

// ────────────────────────────────────────────────────────────────────
// Smoothing — ported from processGPX (djconnel)
// ────────────────────────────────────────────────────────────────────

/**
 * Distance-based Gaussian smoothing. [processGPX]
 *
 * For each point, walks outward up to 4×sigma metres in both directions
 * accumulating exp(-dist²/sigma²) weights on actual segment lengths.
 * Behaviour is identical at 1m or 5m point spacing because it always
 * covers the same physical distance window.
 *
 * @param {number[]} arr — values to smooth (elevation or gradient)
 * @param {number[]} dists — cumulative distance array (metres)
 * @param {number} sigma — Gaussian sigma in metres
 * @returns {number[]} smoothed array
 */
export function distGaussSmooth(arr, dists, sigma) {
  const N = arr.length
  if (sigma < 0.5 || N < 3) return arr.slice()
  const dsMax = 4 * sigma
  const out = new Array(N)

  for (let i = 0; i < N; i++) {
    let lo = i
    while (lo > 0 && (dists[i] - dists[lo - 1]) < dsMax) lo--

    let hi = i
    while (hi < N - 1 && (dists[hi + 1] - dists[i]) < dsMax) hi++

    let wsum = 0, vsum = 0
    for (let j = lo; j <= hi; j++) {
      const d = dists[j] - dists[i]
      // Trapezoid weight: half-step on each side, matching processGPX du logic
      const dlo = (j > lo) ? (dists[j] - dists[j - 1]) : 0
      const dhi = (j < hi) ? (dists[j + 1] - dists[j]) : 0
      const du = 0.5 * (dlo + dhi) / sigma
      const w = Math.exp(-((d / sigma) * (d / sigma)) / 2) * du
      wsum += w
      vsum += w * arr[j]
    }
    out[i] = wsum > 0 ? vsum / wsum : arr[i]
  }
  return out
}

/**
 * Integrate a gradient array back to elevation. [processGPX]
 *
 * Anchors start to eles[0] and applies a linear tilt correction so the
 * endpoint matches eles[N-1] exactly (same as processGPX integrateGradientField).
 *
 * @param {number[]} grPct — gradient array in % (100 × dz/ds)
 * @param {number[]} dists — cumulative distance array
 * @param {number[]} eles — reference elevation array (for anchoring endpoints)
 * @returns {number[]} integrated elevation array
 */
export function integrateGradient(grPct, dists, eles) {
  const N = grPct.length
  const out = new Float64Array(N)
  out[0] = eles[0]
  for (let i = 1; i < N; i++) {
    const ds = dists[i] - dists[i - 1]
    out[i] = out[i - 1] + grPct[i - 1] / 100 * ds
  }
  // Linear tilt to match endpoint
  const drift = eles[N - 1] - out[N - 1]
  const span = dists[N - 1] - dists[0]
  if (span > 0) {
    for (let i = 1; i < N; i++) {
      out[i] += drift * (dists[i] - dists[0]) / span
    }
  }
  return Array.from(out)
}

/**
 * Binary search on a sorted cumulative-distance array.
 * Returns the leftmost index where dists[index] >= target.
 * Clamps to [0, dists.length - 1].
 * @param {ArrayLike<number>} dists — sorted cumulative distances
 * @param {number} target — distance to search for
 * @returns {number} index
 */
export function bsearchDists(dists, target) {
  let lo = 0, hi = dists.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (dists[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Densify a route to a target point spacing by linear interpolation.
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} eles
 * @param {number} spacingM — target spacing in metres
 * @returns {{ lats: number[], lons: number[], eles: number[] }}
 */
export function densifyRoute(lats, lons, eles, spacingM) {
  if (spacingM <= 0 || lats.length < 2) {
    return { lats: [...lats], lons: [...lons], eles: [...eles] }
  }
  const out = { lats: [], lons: [], eles: [] }
  out.lats.push(lats[0])
  out.lons.push(lons[0])
  out.eles.push(eles[0])
  for (let i = 1; i < lats.length; i++) {
    const segLen = haversine(lats[i - 1], lons[i - 1], lats[i], lons[i])
    const steps = Math.floor(segLen / spacingM)
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1)
      out.lats.push(lerp(lats[i - 1], lats[i], t))
      out.lons.push(lerp(lons[i - 1], lons[i], t))
      out.eles.push(lerp(eles[i - 1], eles[i], t))
    }
    out.lats.push(lats[i])
    out.lons.push(lons[i])
    out.eles.push(eles[i])
  }
  return out
}
