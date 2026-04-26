/**
 * Step 5: Split — physics-based ride time prediction and route segmentation.
 *
 * Power-speed model: CdA=0.32m², Crr=0.004, no wind.
 * Group ride drafting model (Blocken 2018) — 5 roaming bots.
 *
 * All functions are pure — read arrays in, results out.
 */

import { haversine } from '../utils/math.js'

// ────────────────────────────────────────────────────────────────────
// Physics constants
// ────────────────────────────────────────────────────────────────────

const G = 9.8067          // gravity (m/s²)
const RHO = 1.225         // air density at sea level (kg/m³)
const CRR = 0.004         // rolling resistance coefficient
const CDA = 0.32          // drag coefficient × frontal area (m²)
const MAX_SPEED = 22.2    // ~80 km/h speed cap
const MIN_SPEED = 1.0     // ~3.6 km/h minimum
const SMOOTH_WIN = 5      // gradient smoothing window (±pts)

// Blocken 2018 draft table — CdA reduction factor by row position
const DRAFT_TABLE = [0.95, 0.64, 0.52, 0.45, 0.40, 0.40, 0.40, 0.40]

// Roaming bot model parameters
const ROAMING = {
  width: 2,
  fixedBots: 5,
  climb:   { pctFront: 0.75, pctTime: 0.90 },
  flat:    { pctFront: 0.75, pctTime: 0.80 },
  descent: { pctFront: 0.75, pctTime: 0.70 },
}

// ────────────────────────────────────────────────────────────────────
// Terrain classification
// ────────────────────────────────────────────────────────────────────

/**
 * Classify terrain type from gradient fraction.
 * @param {number} gr — gradient as fraction (not %)
 * @returns {'climb'|'flat'|'descent'}
 */
export function terrainType(gr) {
  return gr > 0.02 ? 'climb' : gr < -0.02 ? 'descent' : 'flat'
}

// ────────────────────────────────────────────────────────────────────
// Drafting model
// ────────────────────────────────────────────────────────────────────

/**
 * Effective CdA for group ride vs solo.
 * Uses Blocken 2018 draft table for roaming bot model.
 * @param {boolean} useGroup — whether drafting is active
 * @param {number} gr — gradient as fraction
 * @returns {number} effective CdA (m²)
 */
export function effectiveCdA(useGroup, gr) {
  if (!useGroup) return CDA
  const terrain = terrainType(gr)
  const p = ROAMING[terrain]
  const ridersInFront = Math.round(ROAMING.fixedBots * p.pctFront)
  const rowsAhead = Math.floor(ridersInFront / ROAMING.width)
  const draftIdx = Math.min(rowsAhead, DRAFT_TABLE.length - 1)
  let baseMult = rowsAhead > 0 ? DRAFT_TABLE[draftIdx] : 0.95
  // Reduce draft benefit on climbs (aerodynamics matter less at low speed)
  if (terrain === 'climb') baseMult = 1.0 - 0.5 * (1.0 - baseMult)
  const ridersInBack = ROAMING.fixedBots - ridersInFront
  const leadMult = ridersInBack > 0 ? 0.95 : 1.0
  return CDA * (baseMult * p.pctTime + leadMult * (1.0 - p.pctTime))
}

// ────────────────────────────────────────────────────────────────────
// Speed solver
// ────────────────────────────────────────────────────────────────────

/**
 * Binary search for speed given power, mass, gradient, and CdA.
 * Force balance: (Crr·m·g + m·g·gr)·v + 0.5·CdA·ρ·v³ = watts
 * @param {number} watts — rider power output
 * @param {number} mass — total system mass (kg)
 * @param {number} gr — gradient as fraction
 * @param {number} cda — effective CdA (m²)
 * @returns {number} speed in m/s, clamped to [MIN_SPEED, MAX_SPEED]
 */
export function solveSpeed(watts, mass, gr, cda) {
  let lo = MIN_SPEED, hi = MAX_SPEED
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    const f = (CRR * mass * G + mass * G * gr) * mid + 0.5 * cda * RHO * mid * mid * mid
    if (f < watts) lo = mid
    else hi = mid
  }
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, (lo + hi) / 2))
}

// ────────────────────────────────────────────────────────────────────
// Route analysis
// ────────────────────────────────────────────────────────────────────

/**
 * Run full timing analysis on the active route.
 * Builds per-segment gradients (smoothed ±5 pts), then computes
 * cumulative time (group + solo), distance, and climb arrays.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number[]} eles — best available elevations
 * @param {number} watts — rider power
 * @param {number} mass — total system mass (kg)
 * @param {boolean} useGroup — enable drafting model
 * @returns {{
 *   cumTime: number[], cumTimeSolo: number[],
 *   cumDist: number[], cumClimb: number[],
 *   totalTime: number, soloTime: number, totalDist: number,
 *   watts: number, mass: number
 * }}
 */
export function analyzeRoute(lats, lons, eles, watts, mass, useGroup) {
  const N = lats.length

  // Build per-segment data
  const segs = []
  for (let i = 0; i < N - 1; i++) {
    const d = haversine(lats[i], lons[i], lats[i + 1], lons[i + 1])
    const dEle = eles[i + 1] - eles[i]
    const gr = d > 0.5 ? Math.max(-0.25, Math.min(0.25, dEle / d)) : 0
    segs.push({ dist: d, dEle, gradient: gr })
  }

  // Smooth gradients ±SMOOTH_WIN points
  const smoothed = new Array(segs.length)
  for (let i = 0; i < segs.length; i++) {
    let sum = 0, cnt = 0
    const lo = Math.max(0, i - SMOOTH_WIN)
    const hi = Math.min(segs.length - 1, i + SMOOTH_WIN)
    for (let j = lo; j <= hi; j++) {
      sum += segs[j].gradient
      cnt++
    }
    smoothed[i] = sum / cnt
  }
  for (let i = 0; i < segs.length; i++) segs[i].gradient = smoothed[i]

  // Cumulative arrays (length = N = segs.length + 1)
  const cumTime = [0], cumTimeSolo = [0], cumDist = [0], cumClimb = [0]
  for (let i = 0; i < segs.length; i++) {
    const gr = segs[i].gradient
    const cda = effectiveCdA(useGroup, gr)
    const spd = solveSpeed(watts, mass, gr, cda)
    const spdS = solveSpeed(watts, mass, gr, CDA)
    cumTime.push(cumTime[i] + segs[i].dist / spd)
    cumTimeSolo.push(cumTimeSolo[i] + segs[i].dist / spdS)
    cumDist.push(cumDist[i] + segs[i].dist)
    cumClimb.push(cumClimb[i] + (segs[i].dEle > 0 ? segs[i].dEle : 0))
  }

  return {
    cumTime, cumTimeSolo, cumDist, cumClimb,
    totalTime: cumTime[N - 1],
    soloTime: cumTimeSolo[N - 1],
    totalDist: cumDist[N - 1],
    watts, mass,
  }
}

// ────────────────────────────────────────────────────────────────────
// Split generation
// ────────────────────────────────────────────────────────────────────

/**
 * Generate splits from timing analysis at a target duration.
 * Divides total time into equal segments, finding the nearest
 * cumulative time boundary for each split.
 *
 * @param {{ cumTime: number[], cumDist: number[], cumClimb: number[], totalTime: number }} analysis
 * @param {number} targetSec — target split duration in seconds
 * @returns {Array<{ startIdx: number, endIdx: number, time: number, dist: number, climb: number, avgSpeed: number }>}
 */
export function generateSplits(analysis, targetSec) {
  const a = analysis
  if (!a || a.totalTime <= 0) return []

  const n = Math.max(1, Math.round(a.totalTime / targetSec))
  const adjTarget = a.totalTime / n
  const result = []
  let start = 0

  for (let seg = 0; seg < n; seg++) {
    const endTime = (seg + 1 === n) ? a.totalTime : adjTarget * (seg + 1)
    let endIdx = start

    for (let i = start + 1; i < a.cumTime.length; i++) {
      if (a.cumTime[i] >= endTime) {
        endIdx = Math.abs(a.cumTime[i] - endTime) < Math.abs(a.cumTime[i - 1] - endTime) ? i : i - 1
        break
      }
      if (i === a.cumTime.length - 1) endIdx = i
    }

    if (endIdx <= start) endIdx = Math.min(start + 1, a.cumTime.length - 1)

    const t = a.cumTime[endIdx] - a.cumTime[start]
    const dist = a.cumDist[endIdx] - a.cumDist[start]
    const climb = a.cumClimb[endIdx] - a.cumClimb[start]

    result.push({
      startIdx: start,
      endIdx,
      time: t,
      dist,
      climb,
      avgSpeed: t > 0 ? dist / t : 0,
    })

    start = endIdx
  }

  return result
}

