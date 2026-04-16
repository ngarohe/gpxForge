/**
 * Step 1.5: Overlap Snap — align coordinates where route revisits the same road.
 *
 * Runs after Valhalla snap, before LIDAR fetch. First-pass coordinates become
 * canonical; later passes snap to match. Identical XY guarantees identical Z
 * from LIDAR lookups.
 *
 * Algorithm:
 *   1. Build grid spatial index (cell size = threshold)
 *   2. Detect overlapping point pairs (index gap > minGap, distance < threshold)
 *   3. Cluster pairs into contiguous overlap segments
 *   4. Determine direction (same vs opposite) per segment
 *   5. Snap second-pass points to nearest first-pass coordinates
 *   6. Apply snaps (mutate lat/lon arrays in place)
 */

import { haversine, bearing } from '../utils/math.js'

// ────────────────────────────────────────────────────────────────────
// Phase 1: Spatial index
// ────────────────────────────────────────────────────────────────────

const R = 6371000 // Earth radius in metres

/**
 * Build a grid-based spatial index for fast proximity queries.
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {number} cellSize — grid cell size in metres
 * @returns {Map<string, number[]>} grid key → point indices
 */
function buildSpatialIndex(lats, lons, cellSize) {
  const index = new Map()
  for (let i = 0; i < lats.length; i++) {
    const x = Math.floor((lons[i] * Math.PI / 180 * R * Math.cos(lats[i] * Math.PI / 180)) / cellSize)
    const y = Math.floor((lats[i] * Math.PI / 180 * R) / cellSize)
    const key = `${x},${y}`
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(i)
  }
  return index
}

/**
 * Find all point indices within threshold distance of a given location.
 * Searches 3x3 neighbourhood of grid cells.
 */
function findNearbyPoints(index, lat, lon, cellSize, threshold) {
  const cx = Math.floor((lon * Math.PI / 180 * R * Math.cos(lat * Math.PI / 180)) / cellSize)
  const cy = Math.floor((lat * Math.PI / 180 * R) / cellSize)
  const result = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = `${cx + dx},${cy + dy}`
      const pts = index.get(key)
      if (pts) {
        for (const i of pts) result.push(i)
      }
    }
  }
  return result
}

// ────────────────────────────────────────────────────────────────────
// Phase 2: Detect overlap pairs
// ────────────────────────────────────────────────────────────────────

/**
 * Find all point pairs where the route is within threshold of itself,
 * excluding sequential neighbours (index gap < minGap).
 * @returns {Array<{firstIdx: number, secondIdx: number, distance: number}>}
 */
export function detectOverlaps(lats, lons, threshold = 8, minGap = 100) {
  const index = buildSpatialIndex(lats, lons, threshold)
  const overlaps = []

  for (let i = 0; i < lats.length; i++) {
    const nearby = findNearbyPoints(index, lats[i], lons[i], threshold, threshold)
    for (const j of nearby) {
      if (Math.abs(i - j) < minGap) continue
      if (i < j) {
        const dist = haversine(lats[i], lons[i], lats[j], lons[j])
        if (dist <= threshold) {
          overlaps.push({ firstIdx: i, secondIdx: j, distance: dist })
        }
      }
    }
  }

  return overlaps
}

// ────────────────────────────────────────────────────────────────────
// Phase 3: Cluster into segments
// ────────────────────────────────────────────────────────────────────

/**
 * Group individual overlap pairs into contiguous segments.
 * A new segment starts when either the first-pass or second-pass index
 * jumps by more than maxGap.
 */
export function clusterOverlaps(overlaps, maxGap = 3) {
  if (overlaps.length === 0) return []
  overlaps.sort((a, b) => a.firstIdx - b.firstIdx)

  const segments = []
  let cur = {
    firstStart: overlaps[0].firstIdx,
    firstEnd: overlaps[0].firstIdx,
    secondStart: overlaps[0].secondIdx,
    secondEnd: overlaps[0].secondIdx,
    pairs: [overlaps[0]],
  }

  for (let i = 1; i < overlaps.length; i++) {
    const pair = overlaps[i]
    const firstGap = pair.firstIdx - cur.firstEnd

    // For opposite-direction overlaps secondIdx decreases as firstIdx increases,
    // so check gap against whichever boundary is nearest to the new point.
    const secondGap = Math.min(
      Math.abs(pair.secondIdx - cur.secondStart),
      Math.abs(pair.secondIdx - cur.secondEnd),
    )

    if (firstGap <= maxGap && secondGap <= maxGap) {
      cur.firstEnd = pair.firstIdx
      cur.secondStart = Math.min(cur.secondStart, pair.secondIdx)
      cur.secondEnd = Math.max(cur.secondEnd, pair.secondIdx)
      cur.pairs.push(pair)
    } else {
      segments.push(cur)
      cur = {
        firstStart: pair.firstIdx,
        firstEnd: pair.firstIdx,
        secondStart: pair.secondIdx,
        secondEnd: pair.secondIdx,
        pairs: [pair],
      }
    }
  }
  segments.push(cur)
  return segments
}

// ────────────────────────────────────────────────────────────────────
// Phase 4: Direction detection
// ────────────────────────────────────────────────────────────────────

/**
 * Determine if the second pass traverses the overlap in the same or opposite
 * direction as the first pass.
 * @returns {'same' | 'opposite'}
 */
export function determineDirection(segment, lats, lons) {
  const firstBearing = bearing(
    lats[segment.firstStart], lons[segment.firstStart],
    lats[segment.firstEnd], lons[segment.firstEnd],
  )
  const secondBearing = bearing(
    lats[segment.secondStart], lons[segment.secondStart],
    lats[segment.secondEnd], lons[segment.secondEnd],
  )

  let diff = Math.abs(firstBearing - secondBearing)
  if (diff > 180) diff = 360 - diff
  return diff < 90 ? 'same' : 'opposite'
}

// ────────────────────────────────────────────────────────────────────
// Phase 5: Snap second pass to first pass
// ────────────────────────────────────────────────────────────────────

/**
 * For each second-pass point in the segment, find the nearest first-pass point
 * and record the snap target.
 * @returns {Array<{secondIdx: number, targetLat: number, targetLon: number, distance: number}>}
 */
export function snapOverlapSegment(segment, lats, lons, direction) {
  const firstPoints = []
  for (let i = segment.firstStart; i <= segment.firstEnd; i++) {
    firstPoints.push({ idx: i, lat: lats[i], lon: lons[i] })
  }

  // Build iteration order for second pass
  const secondIndices = []
  if (direction === 'opposite') {
    for (let i = segment.secondEnd; i >= segment.secondStart; i--) {
      secondIndices.push(i)
    }
  } else {
    for (let i = segment.secondStart; i <= segment.secondEnd; i++) {
      secondIndices.push(i)
    }
  }

  const snaps = []
  for (const sIdx of secondIndices) {
    let bestDist = Infinity
    let bestFirst = null

    for (const fp of firstPoints) {
      const dist = haversine(lats[sIdx], lons[sIdx], fp.lat, fp.lon)
      if (dist < bestDist) {
        bestDist = dist
        bestFirst = fp
      }
    }

    if (bestFirst && bestDist <= 15) {
      snaps.push({
        secondIdx: sIdx,
        targetLat: bestFirst.lat,
        targetLon: bestFirst.lon,
        distance: bestDist,
      })
    }
  }

  return snaps
}

// ────────────────────────────────────────────────────────────────────
// Phase 6: Apply snaps
// ────────────────────────────────────────────────────────────────────

/**
 * Mutate lat/lon arrays, moving second-pass points to first-pass coordinates.
 * @returns {number} count of snapped points
 */
function applySnaps(snaps, lats, lons) {
  for (const snap of snaps) {
    lats[snap.secondIdx] = snap.targetLat
    lons[snap.secondIdx] = snap.targetLon
  }
  return snaps.length
}

// ────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────

/**
 * Snap overlapping route segments so revisited roads share identical XY.
 *
 * Mutates lats/lons in place. Returns metadata about what was snapped.
 *
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {{ threshold?: number, minGap?: number, minSegmentPairs?: number }} [opts]
 * @returns {{ snapped: number, segments: Array<{firstRange: number[], secondRange: number[], direction: string, snapCount: number}> }}
 */
export function snapOverlaps(lats, lons, opts = {}) {
  const threshold = opts.threshold ?? 8
  const minGap = opts.minGap ?? 100
  const minSegmentPairs = opts.minSegmentPairs ?? 5

  // Phase 1-2: Detect overlapping point pairs
  const overlaps = detectOverlaps(lats, lons, threshold, minGap)
  if (overlaps.length === 0) return { snapped: 0, segments: [] }

  // Phase 3: Cluster into segments
  let segments = clusterOverlaps(overlaps)

  // Filter short segments (noise, crossings)
  segments = segments.filter(s => s.pairs.length >= minSegmentPairs)
  if (segments.length === 0) return { snapped: 0, segments: [] }

  // Phase 4-6: For each segment, determine direction, compute snaps, apply
  const allSnaps = []
  for (const segment of segments) {
    const direction = determineDirection(segment, lats, lons)
    const snaps = snapOverlapSegment(segment, lats, lons, direction)
    allSnaps.push(...snaps)
    segment.direction = direction
    segment.snapCount = snaps.length
  }

  const count = applySnaps(allSnaps, lats, lons)

  return {
    snapped: count,
    segments: segments.map(s => ({
      firstRange: [s.firstStart, s.firstEnd],
      secondRange: [s.secondStart, s.secondEnd],
      direction: s.direction,
      snapCount: s.snapCount,
    })),
  }
}
