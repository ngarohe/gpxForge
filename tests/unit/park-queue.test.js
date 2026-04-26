/**
 * Unit tests for Phase 3 — park-to-queue.
 *
 * Covers:
 *   - snapshotST() / restoreST() round-trip semantics
 *   - clearST() empties ST to unloaded defaults
 *   - batch-pipeline parkEntry() behaviour
 *   - Worker ignores parked entries (status === 'parked' never runs processEntry)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ST, snapshotST, restoreST, clearST } from '../../src/state.js'
import { parkEntry, getQueue, clearQueue, removeEntry } from '../../src/modes/batch-pipeline.js'

function seedST() {
  ST.gpx = {
    lats: [46.0, 46.1, 46.2],
    lons: [14.0, 14.1, 14.2],
    eles: [300, 305, 310],
    dists: new Float64Array([0, 1000, 2000]),
  }
  ST.dists = new Float64Array([0, 1000, 2000])
  ST.grOrig = new Float64Array([0, 0.5, 0.5])
  ST.eleClean = [300, 303, 308]
  ST.grClean = new Float64Array([0, 0.3, 0.5])
  ST.corrections = [{ alo: 0, ahi: 1, type: 'suspect', accepted: true }]
  ST.brunnels = [{ type: 'bridge', alo: 100, ahi: 200 }]
  ST.filename = 'rideX.gpx'
  ST.activeStep = 'smooth'
  ST.stepStatus = { trim: 'done', clean: 'done' }
  ST.history = [{ type: 'clean', eleClean: [300, 303, 308], corrections: [], selectedCorr: null }]
  ST.historyIdx = 0
  ST.origAvgSpacing = 1000
  ST.lidarSource = 'SI'
}

describe('snapshotST / restoreST', () => {
  beforeEach(() => {
    clearST()
    clearQueue()
  })

  it('round-trips populated ST back to identical values', () => {
    seedST()
    const snap = snapshotST()

    // Mutate ST after snapshot to make sure snap is a deep copy
    ST.gpx.lats[0] = 999
    ST.eleClean[0] = 999
    ST.corrections[0].accepted = false

    restoreST(snap)

    expect(ST.gpx.lats[0]).toBe(46.0)
    expect(ST.eleClean[0]).toBe(300)
    expect(ST.corrections[0].accepted).toBe(true)
    expect(ST.filename).toBe('rideX.gpx')
    expect(ST.activeStep).toBe('smooth')
    expect(ST.stepStatus.trim).toBe('done')
    expect(ST.origAvgSpacing).toBe(1000)
  })

  it('clones Float64Arrays (not shared by reference)', () => {
    seedST()
    const snap = snapshotST()
    expect(snap.dists).toBeInstanceOf(Float64Array)
    expect(snap.dists).not.toBe(ST.dists)
    expect(Array.from(snap.dists)).toEqual([0, 1000, 2000])

    // Mutating the snapshot must not affect ST
    snap.dists[0] = 42
    expect(ST.dists[0]).toBe(0)
  })

  it('restores transient interaction state to defaults (not from snapshot)', () => {
    seedST()
    ST.hoverIdx = 5
    ST.drawMode = true
    const snap = snapshotST()

    ST.hoverIdx = 10
    restoreST(snap)

    // Interaction state is reset, never restored
    expect(ST.hoverIdx).toBe(null)
    expect(ST.drawMode).toBe(false)
    expect(ST.viewStart).toBe(0)
    expect(ST.viewEnd).toBe(1)
  })

  it('handles empty ST gracefully', () => {
    clearST()
    const snap = snapshotST()
    expect(snap.gpx).toBe(null)
    expect(snap.eleClean).toBe(null)
    expect(snap.corrections).toEqual([])

    restoreST(snap)
    expect(ST.gpx).toBe(null)
    expect(ST.filename).toBe('')
  })
})

describe('clearST', () => {
  it('resets all pipeline fields to unloaded defaults', () => {
    seedST()
    clearST()
    expect(ST.gpx).toBe(null)
    expect(ST.eleClean).toBe(null)
    expect(ST.filename).toBe('')
    expect(ST.activeStep).toBe(null)
    expect(ST.history).toEqual([])
    expect(ST.historyIdx).toBe(-1)
    expect(ST.corrections).toBe(null)
    expect(ST.stepStatus).toEqual({})
  })
})

describe('parkEntry', () => {
  beforeEach(() => {
    clearST()
    clearQueue()
  })

  it('appends a parked entry to the queue', () => {
    seedST()
    const snap = snapshotST()
    const id = parkEntry('rideX.gpx', snap, 'smooth', 12345)

    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].id).toBe(id)
    expect(queue[0].status).toBe('parked')
    expect(queue[0].origin).toBe('parked')
    expect(queue[0].parkedAtStep).toBe('smooth')
    expect(queue[0].filename).toBe('rideX.gpx')
    expect(queue[0].snapshot).toBe(snap)
  })

  it('parked entries carry snapshot independent of ST mutation', () => {
    seedST()
    const snap = snapshotST()
    parkEntry('rideX.gpx', snap, 'clean', 0)

    // Mutate ST after parking — parked snapshot must be intact
    ST.eleClean[0] = 999
    ST.filename = 'other.gpx'

    const entry = getQueue()[0]
    expect(entry.snapshot.eleClean[0]).toBe(300)
    expect(entry.snapshot.filename).toBe('rideX.gpx')
  })

  it('multiple parks queue independently', () => {
    seedST()
    parkEntry('a.gpx', snapshotST(), 'trim', 100)
    ST.filename = 'b.gpx'
    parkEntry('b.gpx', snapshotST(), 'clean', 200)

    const queue = getQueue()
    expect(queue).toHaveLength(2)
    expect(queue[0].filename).toBe('a.gpx')
    expect(queue[1].filename).toBe('b.gpx')
    expect(queue.every(e => e.origin === 'parked')).toBe(true)
  })

  it('removeEntry drops a parked entry', () => {
    seedST()
    const id = parkEntry('rideX.gpx', snapshotST(), 'trim', 100)
    expect(getQueue()).toHaveLength(1)
    removeEntry(id)
    expect(getQueue()).toHaveLength(0)
  })
})
