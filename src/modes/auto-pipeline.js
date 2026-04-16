/**
 * Auto Pipeline — one-click GPX processing for basic mode.
 *
 * Chains: Snap → Brunnels → Clean → Smooth → Simplify ×2
 * with progress feedback and error resilience. Each step is wrapped
 * in try/catch — failures are logged as warnings and the pipeline
 * continues with available data.
 */

import { ST } from '../state.js'
import { haversine, grads, ascDesc, cumulativeDistances, bsearchDists } from '../utils/math.js'
import { autoSnap } from '../pipeline/1-snap.js'
import { locateBrunnels, buildBrunnelCorrections } from '../pipeline/2-brunnels.js'
import { runCleaner, DEFAULT_SHAPE_PARAMS } from '../pipeline/3-clean.js'
import { runSourceAwareDipSmoothing } from '../pipeline/3.6-source-dip-smooth.js'
import { runSmoothing, runSimplify } from '../pipeline/4-smooth.js'

// ────────────────────────────────────────────────────────────────────
// Default parameters
// ────────────────────────────────────────────────────────────────────

/** Default cleaner parameters (same as UI defaults in panels.js) */
export const DEFAULT_CLEAN_PARAMS = {
  spikeT: 25,
  anchorT: 30,
  mergeGap: 30,
  mergeDist: 10,
  smart: true,
  tangWin: 8,
  hermDev: 0.5,
  bridgeDip: 1.0,
  tunnelSpk: 1.0,
  enabled: true,
  suspSpan: 200,
  suspRev: 5,
  suspGrade: 8,
}

/** Default snap spacing for basic mode (metres) */
const SNAP_SPACING = 400

// ────────────────────────────────────────────────────────────────────
// Stats helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Capture route stats from current ST state.
 * @returns {{ distM: number, ascM: number, pts: number, maxGr: number }}
 */
export function captureStats() {
  const N = ST.gpx.eles.length
  const totalDist = ST.dists[N - 1]
  const { asc } = ascDesc(ST.gpx.eles)
  const gr = ST.grOrig || grads(ST.gpx.eles, ST.dists)
  const maxGr = gr.reduce((m, g) => Math.max(m, Math.abs(g)), 0)
  return { distM: totalDist, ascM: asc, pts: N, maxGr }
}

/**
 * Capture stats from processed route (smoothedRoute if available, else clean).
 * @returns {{ distM: number, ascM: number, pts: number, maxGr: number }}
 */
export function captureStatsAfter() {
  if (ST.smoothedRoute) {
    const r = ST.smoothedRoute
    const M = r.lats.length
    const totalDist = r.dists[M - 1]
    const { asc } = ascDesc(r.eles)
    const maxGr = r.gr.reduce((m, g) => Math.max(m, Math.abs(g)), 0)
    return { distM: totalDist, ascM: asc, pts: M, maxGr }
  }
  // Fallback to clean data
  const N = ST.eleClean.length
  const totalDist = ST.dists[N - 1]
  const { asc } = ascDesc(ST.eleClean)
  const gr = ST.grClean || grads(ST.eleClean, ST.dists)
  const maxGr = gr.reduce((m, g) => Math.max(m, Math.abs(g)), 0)
  return { distM: totalDist, ascM: asc, pts: N, maxGr }
}

// ────────────────────────────────────────────────────────────────────
// Snap commit helper
// ────────────────────────────────────────────────────────────────────

/**
 * Commit snapped route to ST — same logic as commitSnapRoute in main.js
 * but without UI-specific calls (panels, sidebar, map).
 * @param {number[]} newLats
 * @param {number[]} newLons
 * @param {number[]} newEles
 */
export function commitSnap(newLats, newLons, newEles) {
  const N = newLats.length
  ST.gpx = { ...ST.gpx, lats: newLats, lons: newLons, eles: newEles }

  // Rebuild distances
  const dists = [0]
  for (let i = 1; i < N; i++) {
    dists.push(dists[i - 1] + haversine(newLats[i - 1], newLons[i - 1], newLats[i], newLons[i]))
  }
  ST.dists = new Float64Array(dists)
  ST.grOrig = grads(newEles, ST.dists)
  ST.eleClean = [...newEles]
  ST.grClean = ST.grOrig.slice()

  // Reset downstream
  ST.corrections = []
  ST.selectedCorr = null
  ST.smoothedRoute = null
  ST.eleSmoothed = null
  ST.grSmoothed = null
  ST.brunnels = null
  ST.viewStart = 0
  ST.viewEnd = 1
}

function buildBrunnelMask(brunnels, dists) {
  const mask = new Uint8Array(dists.length)
  for (const b of brunnels) {
    const lo = bsearchDists(dists, b.startDist - 10)
    const hi = Math.min(dists.length - 1, bsearchDists(dists, b.endDist + 11) - 1)
    for (let i = lo; i <= hi; i++) mask[i] = 1
  }
  return mask
}

// ────────────────────────────────────────────────────────────────────
// Main auto pipeline
// ────────────────────────────────────────────────────────────────────

/**
 * Run the full auto-processing pipeline for basic mode.
 * Chains: Snap → Brunnels → Clean → Smooth → Simplify ×2
 *
 * Updates ST in place at each step. On error at any step,
 * logs warning and continues with available data.
 *
 * @param {function} onProgress - (stepName, pct, message) => void
 * @param {{ skipSnap?: boolean }} [opts] - pipeline options
 * @returns {Promise<{ before: object, after: object, warnings: string[] }>}
 */
export async function runAutoPipeline(onProgress, opts = {}) {
  const warnings = []
  const t0 = performance.now()
  const log = (msg) => console.log(`[AutoPipeline] ${msg} (${(performance.now() - t0).toFixed(0)}ms)`)

  // Capture "before" stats
  const before = captureStats()
  log(`Start: ${ST.gpx.lats.length} points, ${(ST.dists[ST.dists.length - 1] / 1000).toFixed(1)}km`)

  // ── Step 1: Snap to roads ──
  if (opts.skipSnap) {
    log('Snap: skipped (route already on-road)')
    onProgress('snap', 25, 'Already on road')
  } else {
    onProgress('snap', 0, 'Snapping to roads...')
    try {
      // Safety check
      if (!ST.gpx || !ST.gpx.lats || ST.gpx.lats.length < 2) {
        throw new Error('No valid route data')
      }

      const { lats, lons, eles } = ST.gpx
      log('Snap: starting...')
      const snapResult = await autoSnap(
        lats, lons, eles, ST.dists, SNAP_SPACING,
        (cur, total) => {
          const pct = Math.round((cur / total) * 25)
          onProgress('snap', pct, `Routing ${cur}/${total} segments...`)
        },
        { profile: ST.routeProfile, forcedIndices: ST.trimJoins },
      )

      commitSnap(snapResult.lats, snapResult.lons, snapResult.eles)
      log(`Snap: done, ${snapResult.lats.length} points`)
      onProgress('snap', 25, `Snapped: ${snapResult.lats.length} points`)
    } catch (err) {
      warnings.push(`Road snap skipped: ${err.message}`)
      log(`Snap: FAILED — ${err.message}`)
      console.warn('[AutoPipeline] Snap failed, continuing with raw track:', err)
    }

    // Allow UI repaint
    await new Promise(r => setTimeout(r, 0))
  }

  // ── Step 2: Fetch brunnels ──
  onProgress('brunnels', 30, 'Finding bridges & tunnels...')
  try {
    // Safety check
    if (!ST.gpx.lats || !ST.gpx.lats.length || !ST.dists) {
      throw new Error('No valid route for brunnel search')
    }

    log(`Brunnels: starting (route: ${ST.gpx.lats.length} pts)...`)
    const brunnels = await locateBrunnels(
      ST.gpx.lats, ST.gpx.lons, ST.dists, ST.gpx.eles,
      { queryBuffer: 10, routeBuffer: 3, bearingTol: 20 },
      (pct, msg) => {
        log(`Brunnels: ${pct}% — ${msg || ''}`)
        onProgress('brunnels', 30 + Math.round(pct * 0.15), msg || 'Processing structures...')
      },
    )
    ST.brunnels = brunnels
    log(`Brunnels: done, ${brunnels.length} structures`)
    onProgress('brunnels', 45, `Found ${brunnels.length} structures`)
  } catch (err) {
    warnings.push(`Brunnels skipped: ${err.message}`)
    ST.brunnels = null
    log(`Brunnels: FAILED — ${err.message}`)
    console.warn('[AutoPipeline] Brunnels failed, continuing without:', err)
  }

  // Allow UI repaint
  await new Promise(r => setTimeout(r, 0))

  // ── Step 3: Clean ──
  onProgress('clean', 50, 'Cleaning elevation data...')
  log('Clean: starting...')
  try {
    // Safety check
    if (!ST.dists || ST.dists.length !== ST.gpx.eles.length) {
      throw new Error('Distance array mismatch')
    }

    // Pre-pass: brunnel corrections
    let osmCorrs = []
    let eleWork = ST.gpx.eles
    if (ST.brunnels && ST.brunnels.length > 0) {
      const shapeParams = DEFAULT_SHAPE_PARAMS
      const osmResult = buildBrunnelCorrections(
        ST.brunnels, ST.gpx.eles, ST.dists, shapeParams, DEFAULT_CLEAN_PARAMS.anchorT,
      )
      eleWork = osmResult.eleClean
      osmCorrs = osmResult.corrections
    }

    const cleanResult = runCleaner(eleWork, ST.dists, DEFAULT_CLEAN_PARAMS, ST.brunnels || [])

    // Filter LIDAR corrections overlapping OSM zones
    let lidarCorrs = cleanResult.corrections
    if (osmCorrs.length > 0) {
      lidarCorrs = lidarCorrs.filter(c =>
        !osmCorrs.some(o => !(c.ahi <= o.alo || c.alo >= o.ahi)),
      )
    }

    // Combine and sort
    const allCorrs = [...osmCorrs, ...lidarCorrs]
    allCorrs.sort((a, b) => a.alo - b.alo)

    // Auto-accept ALL corrections (including suspects)
    for (const c of allCorrs) {
      if (c.type === 'suspect' && c.interp === 'none') {
        c.interp = 'uniform'
      }
      c.accepted = true
      c.rejected = false
    }

    ST.eleClean = cleanResult.eleClean
    const brunnelMask = ST.brunnels && ST.brunnels.length
      ? buildBrunnelMask(ST.brunnels, ST.dists)
      : null
    const sourceDipResult = runSourceAwareDipSmoothing(ST.eleClean, ST.dists, {
      source: ST.lidarSource,
      brunnelMask,
    })
    if (sourceDipResult.diagnostics.applied) {
      ST.eleClean = sourceDipResult.eles
      log(`Clean: source dip smoothing ${sourceDipResult.diagnostics.profile}, ${sourceDipResult.diagnostics.windows} windows`)
    }
    ST.corrections = allCorrs
    ST.grClean = grads(ST.eleClean, ST.dists)
    ST.selectedCorr = null

    log(`Clean: done, ${allCorrs.length} corrections`)
    onProgress('clean', 60, `Cleaned: ${allCorrs.length} corrections`)
  } catch (err) {
    warnings.push(`Clean failed: ${err.message}`)
    log(`Clean: FAILED — ${err.message}`)
    console.warn('[AutoPipeline] Clean failed:', err)
    // Ensure eleClean exists even if clean failed
    if (!ST.eleClean) {
      ST.eleClean = ST.gpx.eles.slice()
      ST.grClean = grads(ST.eleClean, ST.dists)
    }
  }

  // Allow UI repaint
  await new Promise(r => setTimeout(r, 0))

  // ── Step 4: Smooth ──
  onProgress('smooth', 65, 'Smoothing route...')
  log(`Smooth: starting (${ST.gpx.lats.length} pts)...`)
  try {
    // Safety check
    if (!ST.eleClean || ST.eleClean.length !== ST.gpx.lats.length) {
      throw new Error('Elevation data mismatch')
    }

    const smoothResult = runSmoothing(
      ST.gpx.lats, ST.gpx.lons, ST.eleClean, ST.dists,
      { origAvgSpacing: ST.origAvgSpacing },
    )

    ST.smoothedRoute = {
      lats: smoothResult.lats,
      lons: smoothResult.lons,
      eles: smoothResult.eleSmoothed,
      dists: new Float64Array(smoothResult.dists),
      gr: new Float64Array(smoothResult.grSmoothed),
    }
    ST.eleSmoothed = smoothResult.eleSmoothed
    ST.grSmoothed = new Float64Array(smoothResult.grSmoothed)

    log(`Smooth: done, ${smoothResult.stats.ptsOrig}→${smoothResult.stats.ptsAfter} pts`)
    onProgress('smooth', 80, `Smoothed: ${smoothResult.stats.ptsAfter} points`)
  } catch (err) {
    warnings.push(`Smooth failed: ${err.message}`)
    log(`Smooth: FAILED — ${err.message}`)
    console.warn('[AutoPipeline] Smooth failed:', err)
  }

  // Allow UI repaint
  await new Promise(r => setTimeout(r, 0))

  // ── Step 5: Simplify ×2 ──
  if (ST.smoothedRoute) {
    onProgress('simplify', 85, 'Simplifying (pass 1)...')
    log(`Simplify pass 1: starting (${ST.smoothedRoute.lats.length} pts)...`)
    try {
      let simplified = runSimplify(ST.smoothedRoute)
      log(`Simplify pass 1: done, ${ST.smoothedRoute.lats.length}→${simplified.route.lats.length} pts`)
      ST.smoothedRoute = simplified.route
      ST.eleSmoothed = simplified.route.eles
      ST.grSmoothed = simplified.route.gr

      // Allow UI repaint
      await new Promise(r => setTimeout(r, 0))

      onProgress('simplify', 92, 'Simplifying (pass 2)...')
      log(`Simplify pass 2: starting (${ST.smoothedRoute.lats.length} pts)...`)
      simplified = runSimplify(ST.smoothedRoute)
      log(`Simplify pass 2: done, ${ST.smoothedRoute.lats.length}→${simplified.route.lats.length} pts`)
      ST.smoothedRoute = simplified.route
      ST.eleSmoothed = simplified.route.eles
      ST.grSmoothed = simplified.route.gr

      onProgress('simplify', 95, `Simplified: ${ST.smoothedRoute.lats.length} points`)
    } catch (err) {
      warnings.push(`Simplify failed: ${err.message}`)
      log(`Simplify: FAILED — ${err.message}`)
      console.warn('[AutoPipeline] Simplify failed:', err)
    }
  }

  log('Pipeline complete')
  onProgress('done', 100, 'Processing complete')

  // Capture "after" stats
  const after = captureStatsAfter()

  return { before, after, warnings }
}
