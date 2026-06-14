/**
 * Source-aware local dip smoothing.
 *
 * Conservative post-clean pass for medium/coarse elevation products (2m/5m)
 * to reduce short artificial dips cleaner can miss at default thresholds.
 *
 * This pass is intentionally strict:
 * - source-gated (MDT02 / WCS5 profile only),
 * - narrow width/depth windows,
 * - brunnel-masked,
 * - capped local lift with edge taper.
 */

const FLAG_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(import.meta.env.VITE_SOURCE_AWARE_LOCAL_DIP_SMOOTHING || '1').toLowerCase(),
)

const PROFILES = {
  MDT02: {
    minWidthM: 8,
    maxWidthM: 22,
    targetWidthM: 14,
    minDepthM: 1.0,
    maxDepthM: 4.0,
    sigmaM: 3.0,
    edgeTaperM: 4.0,
    maxCorrectionM: 2.5,
    maxSlopeFrac: 0.22,
    minCenterFrac: 0.2,
    maxCenterFrac: 0.8,
    minLiftM: 0.01,
  },
  MDT05: {
    minWidthM: 10,
    maxWidthM: 28,
    targetWidthM: 18,
    minDepthM: 1.5,
    maxDepthM: 5.0,
    sigmaM: 4.5,
    edgeTaperM: 6.0,
    maxCorrectionM: 3.5,
    maxSlopeFrac: 0.2,
    minCenterFrac: 0.2,
    maxCenterFrac: 0.8,
    minLiftM: 0.01,
  },
  // 10m DTM profile — defined for future 10m sources. Not yet wired to any
  // provider in profileFromSource(); USA 3DEP can fall back to 10m but the
  // service selects automatically per tile so we can't tag it deterministically.
  MDT10: {
    minWidthM: 20,
    maxWidthM: 55,
    targetWidthM: 35,
    minDepthM: 2.0,
    maxDepthM: 6.5,
    sigmaM: 8.0,
    edgeTaperM: 11.0,
    maxCorrectionM: 4.2,
    maxSlopeFrac: 0.2,
    minCenterFrac: 0.2,
    maxCenterFrac: 0.8,
    minLiftM: 0.01,
  },
  // 20m DTM profile — Croatia (Sonny's 20m DTM, EPSG:32633). Window scales
  // ~4× from MDT05; depth thresholds raised because 20m DTM has more inherent
  // vertical noise (1-2m) but smoother short-range artefacts.
  MDT20: {
    minWidthM: 40,
    maxWidthM: 100,
    targetWidthM: 70,
    minDepthM: 2.5,
    maxDepthM: 8.0,
    sigmaM: 14.0,
    edgeTaperM: 18.0,
    maxCorrectionM: 5.0,
    maxSlopeFrac: 0.18,
    minCenterFrac: 0.2,
    maxCenterFrac: 0.8,
    minLiftM: 0.02,
  },
}

function slopeBetween(eles, dists, a, b) {
  const ds = dists[b] - dists[a]
  if (ds <= 0) return 0
  return (eles[b] - eles[a]) / ds
}

function profileFromSource(source) {
  if (!source || source === 'MIXED') return null
  if (source === 'ES_MDT02_LOCAL') return 'MDT02'
  if (source === 'ES_WCS_5M' || source === 'ES_MDT05_LOCAL') return 'MDT05'
  if (source === 'HR_DTM20') return 'MDT20'
  return null
}

function detectDipWindows(eles, dists, profile, excludeMask) {
  const N = eles.length
  const windows = []
  let nextFreeIdx = 0

  for (let i = 2; i < N - 2; i++) {
    if (!Number.isFinite(eles[i]) || !Number.isFinite(eles[i - 1]) || !Number.isFinite(eles[i + 1])) continue
    if (i < nextFreeIdx) continue
    if (excludeMask && excludeMask[i]) continue
    if (!(eles[i] <= eles[i - 1] && eles[i] <= eles[i + 1])) continue

    const leftCandidates = []
    for (let lo = i - 1; lo >= 1; lo--) {
      if (excludeMask && excludeMask[lo]) break
      if (dists[i] - dists[lo] > profile.maxWidthM) break
      if (dists[i] - dists[lo] >= 1) leftCandidates.push(lo)
    }
    if (!leftCandidates.length) continue

    const rightCandidates = []
    for (let hi = i + 1; hi <= N - 2; hi++) {
      if (excludeMask && excludeMask[hi]) break
      if (dists[hi] - dists[i] > profile.maxWidthM) break
      if (dists[hi] - dists[i] >= 1) rightCandidates.push(hi)
    }
    if (!rightCandidates.length) continue

    let best = null
    for (const lo of leftCandidates) {
      for (const hi of rightCandidates) {
        const width = dists[hi] - dists[lo]
        if (width < profile.minWidthM || width > profile.maxWidthM) continue

        const t = (dists[i] - dists[lo]) / width
        if (t <= profile.minCenterFrac || t >= profile.maxCenterFrac) continue

        const baselineAtI = eles[lo] + (eles[hi] - eles[lo]) * t
        const depth = baselineAtI - eles[i]
        if (depth < profile.minDepthM || depth > profile.maxDepthM) continue

        const leftRise = eles[lo] - eles[i]
        const rightRise = eles[hi] - eles[i]
        if (leftRise < profile.minDepthM * 0.45 || rightRise < profile.minDepthM * 0.45) continue

        const inSlope = Math.abs(slopeBetween(eles, dists, lo, i))
        const outSlope = Math.abs(slopeBetween(eles, dists, i, hi))
        if (inSlope > profile.maxSlopeFrac || outSlope > profile.maxSlopeFrac) continue

        const score = depth - Math.abs(width - profile.targetWidthM) * 0.03
        if (!best || score > best.score) {
          best = { lo, hi, width, depth, score, apex: i }
        }
      }
    }

    if (!best) continue
    windows.push(best)
    nextFreeIdx = best.hi + 1
  }

  return windows
}

function applyDipWindow(eles, dists, win, profile, excludeMask) {
  const e0 = eles[win.lo]
  const e1 = eles[win.hi]
  const span = dists[win.hi] - dists[win.lo]
  if (span <= 0) return { adjusted: 0, maxLiftM: 0 }

  const mid = (dists[win.lo] + dists[win.hi]) * 0.5
  let adjusted = 0
  let maxLiftM = 0

  for (let i = win.lo + 1; i < win.hi; i++) {
    if (excludeMask && excludeMask[i]) continue

    const t = (dists[i] - dists[win.lo]) / span
    const baseline = e0 + (e1 - e0) * t
    const residual = baseline - eles[i]
    if (residual <= 0) continue

    const distToEdge = Math.min(dists[i] - dists[win.lo], dists[win.hi] - dists[i])
    const edgeNorm = profile.edgeTaperM > 0 ? Math.min(1, distToEdge / profile.edgeTaperM) : 1
    const edgeWeight = edgeNorm >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * edgeNorm)

    const g = profile.sigmaM > 0 ? (dists[i] - mid) / profile.sigmaM : 0
    const gaussWeight = Math.exp(-0.5 * g * g)

    const lift = Math.min(profile.maxCorrectionM, residual) * edgeWeight * gaussWeight
    if (lift < profile.minLiftM) continue

    eles[i] += lift
    adjusted++
    if (lift > maxLiftM) maxLiftM = lift
  }

  return { adjusted, maxLiftM }
}

/**
 * Run a single dip-smoothing pass for one source zone.
 * @returns {{ windows: number, pointsAdjusted: number, maxLiftM: number }}
 */
function _runZone(out, dists, profileKey, brunnelMask) {
  const profile = PROFILES[profileKey]
  if (!profile) return { windows: 0, pointsAdjusted: 0, maxLiftM: 0 }
  const windows = detectDipWindows(out, dists, profile, brunnelMask)
  let pointsAdjusted = 0
  let maxLiftM = 0
  for (const win of windows) {
    const r = applyDipWindow(out, dists, win, profile, brunnelMask)
    pointsAdjusted += r.adjusted
    if (r.maxLiftM > maxLiftM) maxLiftM = r.maxLiftM
  }
  return { windows: windows.length, pointsAdjusted, maxLiftM }
}

/**
 * Run conservative source-aware dip smoothing.
 *
 * When sourceSegments is provided (cross-border routes), each zone is
 * processed with its own dip profile. Single-source routes use the
 * route-level source tag as before.
 *
 * @param {number[]} eles
 * @param {ArrayLike<number>} dists
 * @param {{
 *   source?: string,
 *   sourceSegments?: Array<{start: number, end: number, source: string}>,
 *   enabled?: boolean,
 *   brunnelMask?: Uint8Array|null,
 * }} [opts]
 */
export function runSourceAwareDipSmoothing(eles, dists, opts = {}) {
  const enabled = opts.enabled ?? FLAG_ENABLED
  const source = opts.source || ''
  const segments = opts.sourceSegments || []
  const brunnelMask = opts.brunnelMask || null

  const noop = (reason) => ({
    eles: eles ? eles.slice() : [],
    diagnostics: { enabled: !!enabled, applied: false, profile: '', windows: 0, pointsAdjusted: 0, maxLiftM: 0, reason },
  })

  if (!enabled) return noop('disabled')
  if (!eles || !dists || eles.length < 5 || dists.length !== eles.length) return noop('invalid_input')

  // Per-zone processing for cross-border routes
  if (segments.length > 1) {
    const out = eles.slice()
    let totalWindows = 0
    let totalAdjusted = 0
    let totalMaxLift = 0
    const profileKeys = []

    for (const seg of segments) {
      const profileKey = profileFromSource(seg.source)
      if (!profileKey) continue
      profileKeys.push(profileKey)
      // Build a zone mask: only allow dip detection within this segment's range
      const zoneMask = brunnelMask ? new Uint8Array(brunnelMask) : new Uint8Array(eles.length)
      for (let i = 0; i < eles.length; i++) {
        if (i < seg.start || i > seg.end) zoneMask[i] = 1
      }
      const r = _runZone(out, dists, profileKey, zoneMask)
      totalWindows += r.windows
      totalAdjusted += r.pointsAdjusted
      if (r.maxLiftM > totalMaxLift) totalMaxLift = r.maxLiftM
    }

    return {
      eles: out,
      diagnostics: {
        enabled: true,
        applied: totalAdjusted > 0,
        profile: profileKeys.join('+') || '',
        windows: totalWindows,
        pointsAdjusted: totalAdjusted,
        maxLiftM: totalMaxLift,
        reason: totalAdjusted > 0 ? '' : (profileKeys.length ? 'zero_adjustment' : 'unsupported_source'),
      },
    }
  }

  // Single-source route
  const profileKey = profileFromSource(source)
  if (!profileKey) return noop('unsupported_source')

  const out = eles.slice()
  const r = _runZone(out, dists, profileKey, brunnelMask)

  return {
    eles: out,
    diagnostics: {
      enabled: true,
      applied: r.pointsAdjusted > 0,
      profile: profileKey,
      windows: r.windows,
      pointsAdjusted: r.pointsAdjusted,
      maxLiftM: r.maxLiftM,
      reason: r.pointsAdjusted > 0 ? '' : (r.windows === 0 ? 'no_candidates' : 'zero_adjustment'),
    },
  }
}
