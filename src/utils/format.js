/**
 * Formatting helpers — numbers, distances, times, gradients.
 *
 * Pure functions, no side effects.
 */

/**
 * Format seconds as "m:ss".
 * @param {number} sec
 * @returns {string}
 */
export function fmtTime(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m + ':' + String(s).padStart(2, '0')
}

/**
 * Format seconds as "Xh Ym" or "Xm SSs".
 * @param {number} sec
 * @returns {string}
 */
export function fmtTimeLong(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.round(sec % 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`
}

/**
 * Format distance in metres as "X.X km" or "X m".
 * @param {number} metres
 * @param {number} [decimals=1] — decimal places for km
 * @returns {string}
 */
export function fmtDist(metres, decimals = 1) {
  if (metres >= 1000) return (metres / 1000).toFixed(decimals) + ' km'
  return Math.round(metres) + ' m'
}

/**
 * Format elevation in metres.
 * @param {number} metres
 * @param {number} [decimals=0]
 * @returns {string}
 */
export function fmtEle(metres, decimals = 0) {
  return metres.toFixed(decimals) + ' m'
}

/**
 * Format gradient as percentage.
 * @param {number} pct — gradient in %
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function fmtGrade(pct, decimals = 1) {
  return pct.toFixed(decimals) + '%'
}

/**
 * Format a number with a thousands separator.
 * @param {number} n
 * @returns {string}
 */
export function fmtNum(n) {
  return n.toLocaleString()
}

// ────────────────────────────────────────────────────────────────────
// Gradient colour mapping
// ────────────────────────────────────────────────────────────────────

/** @type {Array<[number, [number, number, number]]>} */
const GRAD_STOPS = [
  [-25, [100, 0, 180]],   // deep purple
  [-15, [40, 80, 255]],   // blue-purple
  [-10, [0, 140, 255]],   // blue
  [-5, [0, 200, 220]],    // cyan
  [0, [0, 210, 80]],      // bright green
  [5, [150, 220, 0]],     // yellow-green
  [10, [255, 200, 0]],    // gold
  [15, [255, 110, 0]],    // orange
  [20, [255, 20, 20]],    // red
  [25, [200, 0, 80]],     // deep red/magenta
]

/**
 * Map a gradient percentage to an RGB colour string.
 * Continuous interpolation between stops, GPXmagic-style.
 * @param {number} pct — gradient in %
 * @returns {string} CSS rgb() string
 */
export function gradColor(pct) {
  const c = Math.max(-25, Math.min(25, pct))
  for (let i = 0; i < GRAD_STOPS.length - 1; i++) {
    const [p0, col0] = GRAD_STOPS[i]
    const [p1, col1] = GRAD_STOPS[i + 1]
    if (c >= p0 && c <= p1) {
      const t = (c - p0) / (p1 - p0)
      const r = Math.round(col0[0] + t * (col1[0] - col0[0]))
      const g = Math.round(col0[1] + t * (col1[1] - col0[1]))
      const b = Math.round(col0[2] + t * (col1[2] - col0[2]))
      return `rgb(${r},${g},${b})`
    }
  }
  return 'rgb(200,0,80)'
}

/**
 * Smooth gradient array with moving average (for colour display only).
 * @param {number[]} gr — gradient array
 * @param {number} [win=9] — window size
 * @returns {number[]} smoothed gradient array
 */
export function smoothGradForDisplay(gr, win = 9) {
  const half = Math.floor(win / 2)
  return gr.map((_, i) => {
    let sum = 0, cnt = 0
    for (let j = Math.max(0, i - half); j <= Math.min(gr.length - 1, i + half); j++) {
      sum += gr[j]
      cnt++
    }
    return sum / cnt
  })
}
