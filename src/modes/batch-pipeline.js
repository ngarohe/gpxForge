/**
 * Batch pipeline — multi-file GPX processing queue.
 *
 * Files are pre-snapped on input (no snap step).
 * Per-file pipeline: Brunnels → LIDAR → Clean (auto-accept).
 * Sorted smallest-first. Strictly one file at a time.
 * Smooth/split are NOT run here — user re-runs per session.
 */

import { grads } from '../utils/math.js'
import { buildGPXString } from '../utils/gpx.js'
import { locateBrunnels, buildBrunnelCorrections, buildBrunnelMask } from '../pipeline/2-brunnels.js'
import { runCleaner } from '../pipeline/3-clean.js'
import { runSourceAwareDipSmoothing } from '../pipeline/3.6-source-dip-smooth.js'
import { fetchLidarElevations } from '../api/lidar.js'
import { getTargetResolution, densifyForLidar, detectPrimaryCountry } from '../utils/resolution.js'
import { DEFAULT_CLEAN_PARAMS } from './auto-pipeline.js'

// ────────────────────────────────────────────────────────────────────
// Module state
// ────────────────────────────────────────────────────────────────────

/** @type {QueueEntry[]} */
let _queue = []
let _processing = false
let _onUpdate = null

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

function uid(filename) {
  return `${filename}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function notify() {
  if (_onUpdate) _onUpdate([..._queue])
}

function setStatus(entry, status) {
  entry.status = status
  notify()
}

// ────────────────────────────────────────────────────────────────────
// Per-file processing
// ────────────────────────────────────────────────────────────────────

async function processEntry(entry) {
  const log = (msg) => console.log(`[BatchPipeline] ${entry.filename}: ${msg}`)
  let lats = entry.gpx.lats
  let lons = entry.gpx.lons
  let eles = entry.gpx.eles
  let dists = entry.gpx.dists instanceof Float64Array ? entry.gpx.dists : new Float64Array(entry.gpx.dists)

  // Step 1 — Brunnels
  setStatus(entry, 'brunnels')
  let brunnels = []
  try {
    brunnels = await locateBrunnels(
      lats, lons, dists, eles,
      { queryBuffer: 10, routeBuffer: 3, bearingTol: 20 },
      () => {},
    )
    entry.brunnels = brunnels
    log(`brunnels: ${brunnels.length} found`)
  } catch (err) {
    entry.brunnels = []
    log(`brunnels failed: ${err.message}`)
  }

  await new Promise(r => setTimeout(r, 0))

  // Step 2 — LIDAR
  setStatus(entry, 'lidar')
  try {
    const targetRes = getTargetResolution(lats, lons)
    const densified = densifyForLidar(lats, lons, dists, targetRes)
    const fetchLats = densified.wasDensified ? densified.lats : lats
    const fetchLons = densified.wasDensified ? densified.lons : lons
    const fetchEles = densified.wasDensified ? new Array(densified.lats.length).fill(0) : eles

    const gpxString = buildGPXString(fetchLats, fetchLons, fetchEles, entry.filename)
    const { gpxText, source } = await fetchLidarElevations(gpxString, entry.filename)

    const parser = new DOMParser()
    const doc = parser.parseFromString(gpxText, 'text/xml')
    const trkpts = doc.querySelectorAll('trkpt')
    if (!trkpts.length) throw new Error('LIDAR response has no track points')

    const newLats = [], newLons = [], newEles = []
    for (const pt of trkpts) {
      newLats.push(parseFloat(pt.getAttribute('lat')))
      newLons.push(parseFloat(pt.getAttribute('lon')))
      const eleEl = pt.querySelector('ele')
      newEles.push(eleEl ? parseFloat(eleEl.textContent) : 0)
    }

    // Replace arrays — local providers may resample to different point count
    lats = newLats
    lons = newLons
    eles = newEles

    // Rebuild dists + gradients from returned points
    const distArr = [0]
    for (let i = 1; i < lats.length; i++) {
      const dlat = (lats[i] - lats[i - 1]) * Math.PI / 180
      const dlon = (lons[i] - lons[i - 1]) * Math.PI / 180
      const mlat = (lats[i] + lats[i - 1]) / 2 * Math.PI / 180
      const dx = dlon * Math.cos(mlat) * 6371000
      const dy = dlat * 6371000
      distArr.push(distArr[i - 1] + Math.sqrt(dx * dx + dy * dy))
    }
    dists = new Float64Array(distArr)

    entry.gpx = { lats, lons, eles }
    entry.dists = dists
    entry.grOrig = grads(eles, dists)
    entry.lidarSource = source || ''
    log(`LIDAR: ${trkpts.length} pts from ${source || 'unknown'}`)
  } catch (err) {
    // Rebuild dists from existing points if not already built
    if (!entry.dists) entry.dists = dists
    if (!entry.grOrig) entry.grOrig = grads(eles, dists)
    entry.lidarSource = ''
    log(`LIDAR failed: ${err.message}`)
  }

  await new Promise(r => setTimeout(r, 0))

  // Step 3 — Clean (auto-accept all)
  setStatus(entry, 'cleaning')
  try {
    const brunnelList = entry.brunnels || []

    let osmCorrs = []
    let eleWork = lats === entry.gpx.lats ? entry.gpx.eles : eles
    if (brunnelList.length > 0) {
      const shapeParams = { smart: true, tangWin: 8, hermDev: 0.5, bridgeDip: 1.0, tunnelSpk: 1.0 }
      const osmResult = buildBrunnelCorrections(
        brunnelList, eleWork, entry.dists, shapeParams, DEFAULT_CLEAN_PARAMS.anchorT,
      )
      eleWork = osmResult.eleClean
      osmCorrs = osmResult.corrections
    }

    const cleanResult = runCleaner(eleWork, entry.dists, DEFAULT_CLEAN_PARAMS, brunnelList)

    let lidarCorrs = cleanResult.corrections
    if (osmCorrs.length > 0) {
      lidarCorrs = lidarCorrs.filter(c =>
        !osmCorrs.some(o => !(c.ahi <= o.alo || c.alo >= o.ahi)),
      )
    }

    const allCorrs = [...osmCorrs, ...lidarCorrs]
    allCorrs.sort((a, b) => a.alo - b.alo)

    for (const c of allCorrs) {
      if (c.type === 'suspect' && c.interp === 'none') c.interp = 'uniform'
      c.accepted = true
      c.rejected = false
    }

    let eleClean = cleanResult.eleClean
    const brunnelMask = brunnelList.length ? buildBrunnelMask(brunnelList, entry.dists) : null
    const dipResult = runSourceAwareDipSmoothing(eleClean, entry.dists, {
      source: entry.lidarSource,
      brunnelMask,
    })
    if (dipResult.diagnostics.applied) eleClean = dipResult.eles

    entry.eleClean = eleClean
    entry.grClean = grads(eleClean, entry.dists)
    entry.corrections = allCorrs
    log(`clean: ${allCorrs.length} corrections`)
  } catch (err) {
    entry.eleClean = entry.gpx.eles.slice()
    entry.grClean = grads(entry.eleClean, entry.dists)
    entry.corrections = []
    log(`clean failed: ${err.message}`)
  }

  entry.error = null
  setStatus(entry, 'ready')
}

async function _runWorker() {
  if (_processing) return
  _processing = true
  try {
    while (true) {
      const next = _queue.find(e => e.status === 'pending')
      if (!next) break
      try {
        await processEntry(next)
      } catch (err) {
        next.error = err.message || String(err)
        next.status = 'error'
        notify()
        console.error(`[BatchPipeline] ${next.filename} failed:`, err)
      }
    }
  } finally {
    _processing = false
  }
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Register the update callback. Called every time queue state changes.
 * @param {(queue: QueueEntry[]) => void} onUpdate
 */
export function initBatchQueue(onUpdate) {
  _onUpdate = onUpdate
}

/**
 * Add File objects to the queue. Sorts by size (smallest first) before enqueuing.
 * @param {File[]} files
 * @param {(file: File, xml: string) => object} parseGpxFn - gpx parser (returns { lats, lons, eles, dists })
 */
export async function addFiles(files, parseGpxFn) {
  const sorted = [...files].sort((a, b) => a.size - b.size)
  const newEntries = []
  for (const file of sorted) {
    try {
      const xml = await file.text()
      const gpx = parseGpxFn(xml)
      if (!gpx.lats.length) continue
      /** @type {QueueEntry} */
      const entry = {
        id: uid(file.name),
        filename: file.name,
        fileSizeBytes: file.size,
        status: 'pending',
        origin: 'bulk',
        gpx,
        dists: gpx.dists instanceof Float64Array ? gpx.dists : new Float64Array(gpx.dists),
        grOrig: null,
        eleClean: null,
        grClean: null,
        corrections: [],
        brunnels: [],
        lidarSource: '',
        error: null,
      }
      newEntries.push(entry)
    } catch (err) {
      console.warn(`[BatchPipeline] Could not parse ${file.name}:`, err)
    }
  }
  _queue.push(...newEntries)
  notify()
  _runWorker()
}

/**
 * Return a copy of the queue entry data for loading into ST.
 * @param {string} id
 * @returns {QueueEntry | null}
 */
export function loadEntry(id) {
  return _queue.find(e => e.id === id) || null
}

/**
 * Save a full ST snapshot into the queue entry so every pipeline step
 * (trim, snap, brunnels, clean, smooth, split) is preserved when the user
 * switches entries.
 * @param {string} id
 * @param {object} snapshot - from snapshotST()
 */
export function saveBackFull(id, snapshot) {
  const entry = _queue.find(e => e.id === id)
  if (!entry) return
  entry.snapshot = snapshot
  // Sync duplicated summary fields so the bulk-list UI stays accurate
  entry.gpx = snapshot.gpx
  entry.dists = snapshot.dists
  entry.grOrig = snapshot.grOrig
  entry.eleClean = snapshot.eleClean
  entry.grClean = snapshot.grClean
  entry.corrections = snapshot.corrections
  entry.brunnels = snapshot.brunnels
  entry.lidarSource = snapshot.lidarSource
  notify()
}

/**
 * Park a single-file route into the queue. The snapshot captures full ST
 * so the user can resume work later. The background worker ignores parked
 * entries (it only processes status === 'pending').
 *
 * @param {string} filename
 * @param {object} snapshot - from snapshotST()
 * @param {string|null} parkedAtStep - activeStep at park time (for display)
 * @param {number} fileSizeBytes - estimated size (points * 32 as rough proxy)
 * @returns {string} the new entry id
 */
export function parkEntry(filename, snapshot, parkedAtStep, fileSizeBytes) {
  const entry = {
    id: uid(filename),
    filename,
    fileSizeBytes: fileSizeBytes || 0,
    status: 'parked',
    origin: 'parked',
    parkedAtStep: parkedAtStep || null,
    snapshot,
    // Normalised duplicates for the bulk-path UI; resume uses snapshot directly.
    gpx: snapshot.gpx,
    dists: snapshot.dists,
    grOrig: snapshot.grOrig,
    eleClean: snapshot.eleClean,
    grClean: snapshot.grClean,
    corrections: snapshot.corrections,
    brunnels: snapshot.brunnels,
    lidarSource: snapshot.lidarSource,
    error: null,
  }
  _queue.push(entry)
  notify()
  return entry.id
}

/**
 * Convert an existing queue entry (typically a bulk-processed file the
 * user was reviewing) into a parked entry with a full ST snapshot. Used
 * when the user parks while a queue entry is loaded — we keep one entry
 * in the queue instead of creating a duplicate.
 * @param {string} id
 * @param {object} snapshot - from snapshotST()
 * @param {string|null} parkedAtStep
 */
export function convertToParked(id, snapshot, parkedAtStep) {
  const entry = _queue.find(e => e.id === id)
  if (!entry) return
  entry.status = 'parked'
  entry.origin = 'parked'
  entry.parkedAtStep = parkedAtStep || null
  entry.snapshot = snapshot
  entry.gpx = snapshot.gpx
  entry.dists = snapshot.dists
  entry.grOrig = snapshot.grOrig
  entry.eleClean = snapshot.eleClean
  entry.grClean = snapshot.grClean
  entry.corrections = snapshot.corrections
  entry.brunnels = snapshot.brunnels
  entry.lidarSource = snapshot.lidarSource
  entry.error = null
  notify()
}

/**
 * Remove an entry from the queue (only safe for pending entries).
 * @param {string} id
 */
export function removeEntry(id) {
  const idx = _queue.findIndex(e => e.id === id)
  if (idx !== -1) { _queue.splice(idx, 1); notify() }
}

/** @returns {QueueEntry[]} */
export function getQueue() { return _queue }

export function clearQueue() { _queue = []; notify() }

/** @returns {boolean} */
export function hasPendingWork() {
  return _queue.some(e => e.status !== 'done')
}

/**
 * Set the status of an entry to 'reviewing'.
 * @param {string} id
 */
export function markReviewing(id) {
  const entry = _queue.find(e => e.id === id)
  if (entry) { entry.status = 'reviewing'; notify() }
}

/**
 * Test whether a parked entry is "raw" — no LIDAR fetch has run yet.
 * Such entries are safe to auto-process via Process All since there are no
 * manual elevation edits to overwrite. (We can't use eleClean as a signal
 * because builder routes initialise it to an array of zeros.)
 * @param {QueueEntry} entry
 * @returns {boolean}
 */
function isRawParked(entry) {
  if (entry.status !== 'parked') return false
  if (entry.lidarSource) return false
  return true
}

/** @returns {number} Count of raw parked entries eligible for Process All. */
export function countRawParked() {
  return _queue.filter(isRawParked).length
}

/**
 * Flip every raw parked entry to 'pending' so the worker processes them.
 * Clears each entry's snapshot so post-processing Load uses the freshly
 * processed entry fields (matches bulk-upload behaviour).
 * @returns {number} Count of entries flipped.
 */
export function processStaleParked() {
  let flipped = 0
  for (const entry of _queue) {
    if (!isRawParked(entry)) continue
    entry.status = 'pending'
    entry.origin = 'bulk' // post-processing it behaves like a bulk entry
    entry.snapshot = null  // force Load to use freshly processed fields
    entry.parkedAtStep = null
    flipped++
  }
  if (flipped > 0) {
    notify()
    _runWorker()
  }
  return flipped
}
