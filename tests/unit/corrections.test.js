/**
 * Unit tests for src/ui/corrections.js
 *
 * Tests corrections list rendering, selection, and summary.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ST } from '../../src/state.js'
import { initCorrections } from '../../src/ui/corrections.js'

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function resetState() {
  ST.corrections = null
  ST.dists = null
  ST.selectedCorr = null
}

function makeContainer() {
  const div = document.createElement('div')
  div.className = 'step-output'
  document.body.appendChild(div)
  return div
}

function makeMockCorrections() {
  return [
    {
      alo: 10, ahi: 20, span: 100, grade: 5.2,
      type: 'bridge', interp: 'hermite_convex', m0: 0.02, m1: -0.02,
      revRate: 10, meanGr: 12, accepted: true, rejected: false, source: 'auto',
    },
    {
      alo: 40, ahi: 55, span: 150, grade: -3.1,
      type: 'suspect', interp: 'none', m0: 0, m1: 0,
      revRate: 2, meanGr: 9, accepted: false, rejected: false, source: 'auto',
    },
    {
      alo: 70, ahi: 80, span: 100, grade: 1.5,
      type: 'tunnel', interp: 'uniform', m0: 0, m1: 0,
      revRate: 5, meanGr: 8, accepted: true, rejected: false, source: 'auto',
    },
  ]
}

const defaultActions = {
  onAccept: vi.fn(),
  onReject: vi.fn(),
  onSelect: vi.fn(),
  onRemove: vi.fn(),
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('initCorrections', () => {
  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('returns expected API', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    expect(typeof api.rebuild).toBe('function')
    expect(typeof api.setSelected).toBe('function')
    expect(typeof api.getHintText).toBe('function')
  })

  it('builds correction section DOM', () => {
    const container = makeContainer()
    initCorrections(container, defaultActions)
    expect(container.querySelector('.corr-section')).toBeTruthy()
    expect(container.querySelector('.corr-header')).toBeTruthy()
    expect(container.querySelector('.corr-list')).toBeTruthy()
  })

  it('shows "No corrections" when corrections is null', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = null
    api.rebuild()
    const list = container.querySelector('.corr-list')
    expect(list.textContent).toContain('No corrections')
  })

  it('shows "No corrections" when corrections is empty', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = []
    api.rebuild()
    expect(container.querySelector('.corr-empty')).toBeTruthy()
  })
})

describe('rebuild', () => {
  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('creates items from ST.corrections', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    const items = container.querySelectorAll('.corr-item')
    expect(items.length).toBe(3)
  })

  it('updates count badge', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    expect(container.querySelector('.corr-count').textContent).toBe('3')
  })

  it('displays distance range in km', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    const firstKm = container.querySelector('.corr-item .ci-km')
    expect(firstKm.textContent).toContain('km')
  })

  it('suspect items get suspect-item class', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    const items = container.querySelectorAll('.corr-item')
    expect(items[1].classList.contains('suspect-item')).toBe(true)
    expect(items[0].classList.contains('suspect-item')).toBe(false)
  })

  it('accepted items get accepted class', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    const items = container.querySelectorAll('.corr-item')
    expect(items[0].classList.contains('accepted')).toBe(true) // bridge, accepted
    expect(items[1].classList.contains('accepted')).toBe(false) // suspect, not accepted
  })

  it('rejected items get rejected class', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    const corrs = makeMockCorrections()
    corrs[2].rejected = true
    corrs[2].accepted = false
    ST.corrections = corrs
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    const items = container.querySelectorAll('.corr-item')
    expect(items[2].classList.contains('rejected')).toBe(true)
  })

  it('has type badges with correct classes', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    const badges = container.querySelectorAll('.ci-type')
    expect(badges[0].classList.contains('bridge')).toBe(true)
    expect(badges[1].classList.contains('suspect')).toBe(true)
    expect(badges[2].classList.contains('tunnel')).toBe(true)
  })
})

describe('click handlers', () => {
  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('clicking item calls onSelect', () => {
    const container = makeContainer()
    const onSelect = vi.fn()
    const api = initCorrections(container, { ...defaultActions, onSelect })
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    container.querySelectorAll('.corr-item')[1].click()
    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('clicking accept button calls onAccept', () => {
    const container = makeContainer()
    const onAccept = vi.fn()
    const api = initCorrections(container, { ...defaultActions, onAccept })
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    container.querySelector('.corr-item .ci-btn-accept').click()
    expect(onAccept).toHaveBeenCalledWith(0)
  })

  it('clicking reject button calls onReject', () => {
    const container = makeContainer()
    const onReject = vi.fn()
    const api = initCorrections(container, { ...defaultActions, onReject })
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    container.querySelector('.corr-item .ci-btn-reject').click()
    expect(onReject).toHaveBeenCalledWith(0)
  })

  it('accept/reject clicks do not trigger onSelect', () => {
    const container = makeContainer()
    const onSelect = vi.fn()
    const api = initCorrections(container, { ...defaultActions, onSelect })
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    container.querySelector('.ci-btn-accept').click()
    container.querySelector('.ci-btn-reject').click()
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('setSelected', () => {
  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
  })

  it('highlights correct item', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()

    api.setSelected(1)
    const items = container.querySelectorAll('.corr-item')
    expect(items[0].classList.contains('sel')).toBe(false)
    expect(items[1].classList.contains('sel')).toBe(true)
    expect(items[2].classList.contains('sel')).toBe(false)
  })

  it('deselects all when ci is -1', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = makeMockCorrections()
    ST.dists = Array.from({ length: 100 }, (_, i) => i * 10)
    api.rebuild()
    api.setSelected(1)
    api.setSelected(-1)

    const selected = container.querySelectorAll('.corr-item.sel')
    expect(selected.length).toBe(0)
  })
})

describe('getHintText', () => {
  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
  })

  it('returns "No corrections" when empty', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = []
    expect(api.getHintText()).toBe('No corrections')
  })

  it('returns pending count for unreviewed suspects', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    ST.corrections = makeMockCorrections() // 1 suspect pending
    expect(api.getHintText()).toBe('1 pending')
  })

  it('returns "reviewed" when all suspects handled', () => {
    const container = makeContainer()
    const api = initCorrections(container, defaultActions)
    const corrs = makeMockCorrections()
    corrs[1].accepted = true // accept the suspect
    ST.corrections = corrs
    expect(api.getHintText()).toContain('reviewed')
  })
})
