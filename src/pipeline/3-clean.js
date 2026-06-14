/**
 * Step 3: Clean — LIDAR spike detection and elevation artifact removal.
 *
 * Detects elevation artifacts via edge-sharpness test.
 * Labels are assigned by cross-referencing OSM brunnels from step 2:
 *   - Corrections overlapping an OSM brunnel → 'bridge' / 'tunnel'
 *   - All other corrections → 'artifact' (shape-based interp still applies)
 *
 * Algorithm flow (runCleaner):
 *   1. Flag indices where |gradient| > spikeT
 *   2. Group into consecutive runs, merge within mergeGap points
 *   3. Expand outward until |gradient| < anchorT to find anchors
 *   4. Merge overlapping zones, then chain within mergeDist metres
 *   5. Per zone: edge test → suspect test → classify + interpolate
 */

import { grads, ascDesc, hermiteElevation } from '../utils/math.js'

/** Default shape classification params. */
export const DEFAULT_SHAPE_PARAMS = { smart: true, tangWin: 8, hermDev: 0.5, bridgeDip: 1.0, tunnelSpk: 1.0 }

// ────────────────────────────────────────────────────────────────────
// Structure classification
// ────────────────────────────────────────────────────────────────────

/**
 * Classify a detected zone as bridge, tunnel, or artifact.
 * Uses edge tangent analysis and Hermite shape matching.
 * @param {number[]} eles — raw elevations
 * @param {number[]} dists — cumulative distances
 * @param {number} alo — zone start index
 * @param {number} ahi — zone end index
 * @param {object} params — { tangWin, hermDev, bridgeDip, tunnelSpk }
 * @returns {{ type: string, interp: string, m0: number, m1: number }}
 */
export function classifyStructure(eles, dists, alo, ahi, params) {
  const { tangWin, hermDev, bridgeDip, tunnelSpk } = params
  const e0 = eles[alo], e1 = eles[ahi]
  const anchorLevel = (e0 + e1) / 2
  let zMin = Infinity, zMax = -Infinity
  for (let j = alo; j <= ahi; j++) {
    if (eles[j] < zMin) zMin = eles[j]
    if (eles[j] > zMax) zMax = eles[j]
  }
  const dipBelow = anchorLevel - zMin
  const spikeAbove = zMax - anchorLevel
  const isBridge = dipBelow >= bridgeDip
  const isTunnel = spikeAbove >= tunnelSpk && !isBridge

  if (isTunnel) return { type: 'tunnel', interp: 'uniform', m0: 0, m1: 0 }
  if (!isBridge) return { type: 'artifact', interp: 'uniform', m0: 0, m1: 0 }

  const gr = grads(eles, dists)
  const lo_win = Math.max(0, alo - tangWin)
  const hi_win = Math.min(gr.length - 1, ahi + tangWin)
  let m_in = 0, m_out = 0, cnt = 0
  for (let j = lo_win; j < alo; j++) { m_in += gr[j]; cnt++ }
  m_in = cnt ? m_in / cnt / 100 : 0
  cnt = 0
  for (let j = ahi; j < hi_win; j++) { m_out += gr[j]; cnt++ }
  m_out = cnt ? m_out / cnt / 100 : 0

  const span = dists[ahi] - dists[alo]
  let interpType = 'uniform', finalM0 = m_in, finalM1 = m_out

  if (m_in > 0 && m_out < 0) {
    interpType = 'hermite_convex'
  } else if (m_in < 0 && m_out > 0) {
    finalM0 = -Math.abs(m_in)
    finalM1 = Math.abs(m_out)
    interpType = 'hermite_concave'
  }

  if (interpType !== 'uniform') {
    let maxDev = 0
    for (let k = 0; k <= 20; k++) {
      const t = k / 20
      const dev = Math.abs(hermiteElevation(t, e0, e1, finalM0, finalM1, span) - (e0 + t * (e1 - e0)))
      if (dev > maxDev) maxDev = dev
    }
    if (maxDev < hermDev) interpType = 'uniform'
  }

  const typeLabel = interpType === 'uniform' ? 'ramp'
    : interpType === 'hermite_convex' ? 'bridge' : 'bridge_sag'

  return { type: typeLabel, interp: interpType, m0: finalM0, m1: finalM1 }
}

/**
 * Edge-sharpness test: is this zone real terrain or a LIDAR artifact?
 * Real climbs have gradual gradient transitions; LIDAR spikes jump abruptly.
 * @param {number[]} gr — gradient array
 * @param {number[]} dists — cumulative distances
 * @param {number} alo — zone start index
 * @param {number} ahi — zone end index
 * @param {number} edgeWin — points to check on each side
 * @param {number} edgeThresh — max delta-grade/metre for "gradual"
 * @returns {boolean} true if zone appears to be real terrain
 */
export function isRealTerrain(gr, dists, alo, ahi, edgeWin, edgeThresh) {
  const loStart = Math.max(0, alo - edgeWin)
  const loEnd = Math.min(alo + edgeWin, ahi)
  let maxDgLo = 0
  for (let i = loStart + 1; i <= loEnd; i++) {
    const ds = dists[i] - dists[i - 1]
    if (ds > 0) maxDgLo = Math.max(maxDgLo, Math.abs(gr[i] - gr[i - 1]) / ds)
  }

  const hiStart = Math.max(alo, ahi - edgeWin)
  const hiEnd = Math.min(ahi + edgeWin, gr.length - 1)
  let maxDgHi = 0
  for (let i = hiStart + 1; i <= hiEnd; i++) {
    const ds = dists[i] - dists[i - 1]
    if (ds > 0) maxDgHi = Math.max(maxDgHi, Math.abs(gr[i] - gr[i - 1]) / ds)
  }

  return maxDgLo <= edgeThresh && maxDgHi <= edgeThresh
}

// ────────────────────────────────────────────────────────────────────
// Interpolation application
// ────────────────────────────────────────────────────────────────────

/**
 * Apply interpolation within a correction zone (mutates eleClean in-place).
 * Anchors (alo, ahi) are preserved — only interior points are replaced.
 *
 * @param {number[]} eleClean — elevation array to mutate
 * @param {number[]} dists — cumulative distances
 * @param {number} alo — zone start anchor index
 * @param {number} ahi — zone end anchor index
 * @param {{ interp: string, m0: number, m1: number }} structure — classification result
 */
export function applyInterp(eleClean, dists, alo, ahi, structure) {
  const e0 = eleClean[alo], e1 = eleClean[ahi]
  const d0 = dists[alo], span = dists[ahi] - d0
  if (span <= 0 || ahi - alo < 2) return

  for (let j = alo + 1; j < ahi; j++) {
    const t = (dists[j] - d0) / span
    eleClean[j] = structure.interp === 'uniform'
      ? e0 + t * (e1 - e0)
      : hermiteElevation(t, e0, e1, structure.m0, structure.m1, span)
  }
}

// ────────────────────────────────────────────────────────────────────
// Suspect detection
// ────────────────────────────────────────────────────────────────────

/**
 * Test whether a flagged zone is likely real terrain (a genuine climb/descent)
 * rather than a LIDAR spike. Suspects satisfy ALL three conditions:
 *   1. Span ≥ suspSpan metres (long enough to be real)
 *   2. Reversal rate ≤ suspRev % (smooth, not spiky)
 *   3. Mean |gradient| ≥ suspGrade % (steep enough to be a real climb)
 *
 * @param {number[]} eles — elevation array
 * @param {number[]} dists — cumulative distances
 * @param {number[]} gr — gradient array
 * @param {number} alo — zone start index
 * @param {number} ahi — zone end index
 * @param {{ suspSpan: number, suspRev: number, suspGrade: number }} params
 * @returns {boolean} true if zone appears to be suspect (likely real terrain)
 */
export function isSuspect(eles, dists, gr, alo, ahi, params) {
  const { suspSpan, suspRev, suspGrade } = params
  const span = dists[ahi] - dists[alo]
  if (span < suspSpan) return false

  const grZone = gr.slice(alo, ahi)
  if (!grZone.length) return false

  // Count sign reversals in gradient
  let reversals = 0
  for (let i = 1; i < grZone.length; i++) {
    if (Math.sign(grZone[i]) !== Math.sign(grZone[i - 1])
        && grZone[i] !== 0 && grZone[i - 1] !== 0) {
      reversals++
    }
  }

  const revRate = 100 * reversals / Math.max(1, grZone.length - 1)
  const meanAbsGr = grZone.reduce((s, g) => s + Math.abs(g), 0) / grZone.length

  // Must satisfy BOTH conditions to be suspect (likely real)
  return revRate <= suspRev && meanAbsGr >= suspGrade
}

// ────────────────────────────────────────────────────────────────────
// Main cleaner
// ────────────────────────────────────────────────────────────────────

/**
 * Check if a correction zone overlaps any OSM brunnel.
 * Returns the brunnel's type ('bridge'/'tunnel') if overlap found, else null.
 *
 * @param {number} corrStartDist — correction start distance
 * @param {number} corrEndDist — correction end distance
 * @param {object[]} brunnels — OSM brunnels with { alo, ahi } indices
 * @param {number[]} dists — cumulative distances
 * @returns {string|null}
 */
function matchBrunnel(corrStartDist, corrEndDist, brunnels, dists) {
  for (const b of brunnels) {
    const bStart = dists[b.alo]
    const bEnd = dists[b.ahi]
    if (corrStartDist < bEnd && corrEndDist > bStart) {
      return b.type // 'bridge' or 'tunnel'
    }
  }
  return null
}

/**
 * Bracket-merge: fuse a +spike/−spike pair that straddles a short, anomalously
 * high (or low) PLATEAU into one road-to-road zone. A flat-topped bump — e.g. a
 * route snapped onto an overpass deck — otherwise survives cleaning: the deck is
 * flat (≈0% gradient) so it is never flagged, only its two near-vertical walls
 * are, and each wall ends up with one anchor ON the deck, so interpolation just
 * smooths the walls into ramps and leaves the deck elevated. Merging the pair
 * gives both anchors at road level → uniform interp flattens the deck.
 *
 * Reliability comes from a CONJUNCTION of guards a real ride can't satisfy at
 * once (so the merge is deterministic, not threshold-luck):
 *   - both walls steeper than `wallGrade` (>40% — non-physical for any road;
 *     a real climb/bridge approach is ≤~25%)
 *   - plateau shorter than `maxPlateauM` (structure scale, not a real hilltop)
 *   - plateau elevation off the outer (road-level) baseline by > `deckThresh`
 *   - outer anchors at similar elevation (road continues at the same level —
 *     not a road climbing through)
 *   - the span does NOT overlap an OSM brunnel (real bridges/tunnels are handled
 *     by buildBrunnelCorrections, which preserves their profile)
 *
 * @param {number[][]} zones — [[alo, ahi], ...] sorted, non-overlapping
 * @param {number[]} eles
 * @param {number[]} dists
 * @param {number[]} gr — gradients (%) from grads(eles, dists)
 * @param {object[]} brunnels
 * @param {{ wallGrade?: number, maxPlateauM?: number, deckThresh?: number }} [opts]
 * @returns {number[][]} possibly-merged zone list
 */
export function bracketMergeZones(zones, eles, dists, gr, brunnels = [], opts = {}) {
  const wallGrade = opts.wallGrade ?? 40
  const maxPlateauM = opts.maxPlateauM ?? 250
  const deckThresh = opts.deckThresh ?? 1.5

  const maxAbsGr = (lo, hi) => {
    let m = 0
    for (let k = lo; k < hi && k < gr.length; k++) {
      const g = Math.abs(gr[k])
      if (g > m) m = g
    }
    return m
  }

  const canBracket = (z1, z2) => {
    const [a1, b1] = z1
    const [a2, b2] = z2
    if (a2 <= b1) return false // adjacent/overlapping — already one zone
    const plateauM = dists[a2] - dists[b1]
    if (plateauM <= 0 || plateauM > maxPlateauM) return false
    // walls must be non-physically steep (artifact, not a ridable climb)
    if (maxAbsGr(a1, b1) < wallGrade || maxAbsGr(a2, b2) < wallGrade) return false
    // outer anchors = road level on both sides
    const baseLo = eles[a1], baseHi = eles[b2]
    const baseline = (baseLo + baseHi) / 2
    // plateau (deck) elevation
    let sum = 0, cnt = 0
    for (let k = b1; k <= a2; k++) { sum += eles[k]; cnt++ }
    const deckLevel = cnt ? sum / cnt : baseline
    const anomaly = Math.abs(deckLevel - baseline)
    if (anomaly < deckThresh) return false // not an elevated/depressed deck
    if (Math.abs(baseLo - baseHi) > anomaly) return false // road climbing through, not a deck
    // leave real OSM bridges/tunnels to the brunnel pipeline
    if (brunnels.length > 0 && matchBrunnel(dists[a1], dists[b2], brunnels, dists)) return false
    return true
  }

  const out = []
  let i = 0
  while (i < zones.length) {
    if (i + 1 < zones.length && canBracket(zones[i], zones[i + 1])) {
      out.push([zones[i][0], zones[i + 1][1]])
      i += 2
    } else {
      out.push(zones[i].slice())
      i += 1
    }
  }
  return out
}

/**
 * Run the full spike detection and correction pipeline.
 *
 * @param {number[]} eles — raw elevation array
 * @param {number[]} dists — cumulative distances
 * @param {object} params — merged params from panel:
 *   Detection: { spikeT, anchorT, mergeGap, mergeDist }
 *   Shape:     { smart, tangWin, hermDev, bridgeDip, tunnelSpk }
 *   Suspect:   { enabled, suspSpan, suspRev, suspGrade }
 *   Bracket:   { bracketMerge, bracketWallGrade, bracketMaxPlateauM, bracketDeckThresh }
 * @param {object[]} [brunnels=[]] — OSM brunnels from step 2 for label classification
 * @param {{ autoApplyArtifacts?: boolean }} [opts]
 *   autoApplyArtifacts (default true) — when false, corrections labelled
 *   'artifact' are detected with `accepted: false` and NOT baked into eleClean.
 *   Brunnel-matched corrections (label 'bridge'/'tunnel') are still applied.
 *   Used for low-res sources (≥10m) where artifact detections are usually
 *   real terrain, not spikes — see isLowResSource() in 4-smooth.js.
 * @returns {{ eleClean: number[], corrections: object[] }}
 */
export function runCleaner(eles, dists, params, brunnels = [], opts = {}) {
  const autoApplyArtifacts = opts.autoApplyArtifacts !== false
  const {
    spikeT, anchorT, mergeGap, mergeDist,
    smart = true, tangWin = 8, hermDev = 0.5, bridgeDip = 1.0, tunnelSpk = 1.0,
    enabled: useSuspect = true, suspSpan = 200, suspRev = 5, suspGrade = 8,
    bracketMerge = true, bracketWallGrade = 40, bracketMaxPlateauM = 250, bracketDeckThresh = 1.5,
  } = params

  const N = eles.length
  const gr = grads(eles, dists)

  // 1. Flag indices where |gradient| exceeds spike threshold
  const badIdx = []
  for (let i = 0; i < gr.length; i++) {
    if (Math.abs(gr[i]) > spikeT) badIdx.push(i)
  }
  if (badIdx.length === 0) {
    return { eleClean: eles.slice(), corrections: [] }
  }

  // 2. Group consecutive spike indices into runs (merge within mergeGap points)
  const runs = []
  let runStart = badIdx[0], prev = badIdx[0]
  for (let k = 1; k < badIdx.length; k++) {
    if (badIdx[k] - prev > mergeGap) {
      runs.push([runStart, prev])
      runStart = badIdx[k]
    }
    prev = badIdx[k]
  }
  runs.push([runStart, prev])

  // 3. Expand each run outward until gradient < anchorT to find clean anchors
  function findLo(rs) {
    for (let i = rs - 1; i >= 0; i--) {
      if (Math.abs(gr[i]) < anchorT) return i
    }
    return 0
  }
  function findHi(re) {
    for (let i = re + 1; i < gr.length; i++) {
      if (Math.abs(gr[i]) < anchorT) return i + 1
    }
    return N - 1
  }

  const expanded = runs.map(([s, e]) => [findLo(s), findHi(e)])

  // 4a. Merge overlapping zones by index
  const merged = [expanded[0].slice()]
  for (let k = 1; k < expanded.length; k++) {
    const [a, b] = expanded[k]
    const last = merged[merged.length - 1]
    if (a <= last[1]) {
      last[1] = Math.max(last[1], b)
    } else {
      merged.push([a, b])
    }
  }

  // 4b. Chain zones within mergeDist metres
  const chained = [merged[0].slice()]
  for (let k = 1; k < merged.length; k++) {
    const [a, b] = merged[k]
    const last = chained[chained.length - 1]
    const gap = dists[a] - dists[last[1]]
    if (gap <= mergeDist) {
      last[1] = Math.max(last[1], b)
    } else {
      chained.push([a, b])
    }
  }

  // 4c. Bracket-merge +spike/−spike pairs straddling a short anomalous plateau
  //     (overpass deck, underpass dip) into one road-to-road zone so the deck
  //     gets flattened instead of having only its walls ramped. Guarded so it
  //     can't touch real terrain or OSM bridges/tunnels (see bracketMergeZones).
  const zones = (bracketMerge && chained.length > 1)
    ? bracketMergeZones(chained, eles, dists, gr, brunnels, {
        wallGrade: bracketWallGrade, maxPlateauM: bracketMaxPlateauM, deckThresh: bracketDeckThresh,
      })
    : chained

  // 5. Build corrections array and apply interpolation
  const eleClean = eles.slice()
  const corrections = []

  for (const [alo, ahi] of zones) {
    const span = dists[ahi] - dists[alo]
    const grade = span > 0 ? (eles[ahi] - eles[alo]) / span * 100 : 0

    // Compute zone stats for the correction record
    const grZone = gr.slice(alo, ahi)
    let reversals = 0
    for (let i = 1; i < grZone.length; i++) {
      if (Math.sign(grZone[i]) !== Math.sign(grZone[i - 1])
          && grZone[i] !== 0 && grZone[i - 1] !== 0) {
        reversals++
      }
    }
    const revRate = Math.round(100 * reversals / Math.max(1, grZone.length - 1))
    const meanGr = grZone.length > 0
      ? grZone.reduce((s, g) => s + Math.abs(g), 0) / grZone.length
      : 0

    // Edge-sharpness test: skip real terrain zones
    if (isRealTerrain(gr, dists, alo, ahi, 8, 2.0)) {
      corrections.push({
        alo, ahi, span, grade, type: 'suspect', interp: 'none',
        m0: 0, m1: 0, revRate, meanGr,
        accepted: false, rejected: false, source: 'auto',
      })
      continue
    }

    // Suspect test: mark for manual review
    if (useSuspect && isSuspect(eles, dists, gr, alo, ahi, { suspSpan, suspRev, suspGrade })) {
      corrections.push({
        alo, ahi, span, grade, type: 'suspect', interp: 'none',
        m0: 0, m1: 0, revRate, meanGr,
        accepted: false, rejected: false, source: 'auto',
      })
      continue
    }

    // Classify structure shape (determines interpolation method)
    const structParams = smart
      ? { tangWin, hermDev, bridgeDip, tunnelSpk }
      : { tangWin, hermDev, bridgeDip: 999, tunnelSpk: 999 }
    const struct = classifyStructure(eles, dists, alo, ahi, structParams)

    // Label: only corrections overlapping an OSM brunnel get 'bridge'/'tunnel'.
    // All others are labelled 'artifact' regardless of shape.
    const osmType = brunnels.length > 0
      ? matchBrunnel(dists[alo], dists[ahi], brunnels, dists)
      : null
    const label = osmType || 'artifact'

    // Apply interpolation to eleClean — except for artifacts when the caller
    // opts out (low-res sources). We still record the correction with its
    // shape params so the user can accept it later via the corrections panel
    // and applyInterp() will run with the same parameters.
    const apply = label !== 'artifact' || autoApplyArtifacts
    if (apply) applyInterp(eleClean, dists, alo, ahi, struct)

    corrections.push({
      alo, ahi, span, grade,
      type: label, interp: struct.interp,
      m0: struct.m0, m1: struct.m1,
      revRate, meanGr,
      accepted: apply, rejected: false, source: 'auto',
    })
  }

  return { eleClean, corrections }
}
