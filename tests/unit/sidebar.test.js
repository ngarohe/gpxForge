/**
 * Unit tests for src/ui/sidebar.js
 *
 * Tests horizontal step tab navigation, step status, and panel containers.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ST } from '../../src/state.js'
import { initSidebar } from '../../src/ui/sidebar.js'

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function resetState() {
  ST.activeStep = null
  ST.stepStatus = {}
}

function createContainer() {
  const el = document.createElement('div')
  el.className = 'step-toolbar'
  document.body.appendChild(el)
  return el
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('initSidebar', () => {
  let container

  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
    container = createContainer()
  })

  it('builds 6 step-tab elements', () => {
    initSidebar(container)
    const steps = container.querySelectorAll('.step-tab')
    expect(steps.length).toBe(6)
  })

  it('each step has correct number and title', () => {
    initSidebar(container)
    const expected = [
      { num: '0', title: 'Trim' },
      { num: '1', title: 'Road Snap' },
      { num: '2', title: 'Brunnels' },
      { num: '3', title: 'Clean' },
      { num: '4', title: 'Smooth' },
      { num: '5', title: 'Split' },
    ]

    const steps = container.querySelectorAll('.step-tab')
    steps.forEach((step, i) => {
      expect(step.querySelector('.step-tab-num').textContent).toBe(expected[i].num)
      expect(step.querySelector('.step-tab-name').textContent).toBe(expected[i].title)
    })
  })

  it('creates 7 step-controls containers (6 steps + builder)', () => {
    initSidebar(container)
    const panels = container.querySelectorAll('.step-controls')
    expect(panels.length).toBe(7)
  })

  it('all step-controls start hidden', () => {
    initSidebar(container)
    const panels = container.querySelectorAll('.step-controls')
    panels.forEach(p => {
      expect(p.style.display).toBe('none')
    })
  })

  it('returns expected API methods', () => {
    const api = initSidebar(container)
    expect(typeof api.setActiveStep).toBe('function')
    expect(typeof api.setStepStatus).toBe('function')
    expect(typeof api.getActiveStep).toBe('function')
    expect(typeof api.getToolPanel).toBe('function')
  })

  it('has step-tabs row', () => {
    initSidebar(container)
    expect(container.querySelector('.step-tabs')).toBeTruthy()
  })
})

describe('step navigation', () => {
  let container, api

  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
    container = createContainer()
    api = initSidebar(container)
  })

  it('clicking a step sets it as active', () => {
    const step = container.querySelector('[data-step="smooth"]')
    step.click()
    expect(step.classList.contains('active')).toBe(true)
  })

  it('only one step is active at a time', () => {
    container.querySelector('[data-step="trim"]').click()
    container.querySelector('[data-step="clean"]').click()

    const active = container.querySelectorAll('.step-tab.active')
    expect(active.length).toBe(1)
    expect(active[0].dataset.step).toBe('clean')
  })

  it('active step controls panel is visible, others hidden', () => {
    api.setActiveStep('smooth')

    const smoothPanel = container.querySelector('.step-controls[data-step="smooth"]')
    const cleanPanel = container.querySelector('.step-controls[data-step="clean"]')
    expect(smoothPanel.style.display).toBe('')
    expect(cleanPanel.style.display).toBe('none')
  })

  it('setActiveStep programmatically activates the correct step', () => {
    api.setActiveStep('brunnels')

    const step = container.querySelector('[data-step="brunnels"]')
    expect(step.classList.contains('active')).toBe(true)
    expect(ST.activeStep).toBe('brunnels')
  })

  it('getActiveStep returns current step id', () => {
    api.setActiveStep('split')
    expect(api.getActiveStep()).toBe('split')
  })

  it('onStepChange callback fires with step id', () => {
    const cb = vi.fn()
    document.body.innerHTML = ''
    container = createContainer()
    const sidebar = initSidebar(container, { onStepChange: cb })

    sidebar.setActiveStep('trim')
    expect(cb).toHaveBeenCalledWith('trim')
  })
})

describe('step status', () => {
  let container, api

  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
    container = createContainer()
    api = initSidebar(container)
  })

  it('setStepStatus done adds done class and sets text', () => {
    api.setStepStatus('clean', 'done', '12 fixes')

    const step = container.querySelector('[data-step="clean"]')
    expect(step.classList.contains('done')).toBe(true)
    expect(step.querySelector('.step-tab-status').textContent).toBe('12 fixes')
  })

  it('setStepStatus warn adds warn class and sets text', () => {
    api.setStepStatus('smooth', 'warn', 'stale')

    const step = container.querySelector('[data-step="smooth"]')
    expect(step.classList.contains('warn')).toBe(true)
    expect(step.querySelector('.step-tab-status').textContent).toBe('stale')
  })

  it('setStepStatus none removes done/warn and shows em dash', () => {
    api.setStepStatus('clean', 'done', '12 fixes')
    api.setStepStatus('clean', 'none', null)

    const step = container.querySelector('[data-step="clean"]')
    expect(step.classList.contains('done')).toBe(false)
    expect(step.classList.contains('warn')).toBe(false)
    expect(step.querySelector('.step-tab-status').textContent).toBe('\u2014')
  })

  it('status changes do not affect active state', () => {
    api.setActiveStep('clean')
    api.setStepStatus('clean', 'done', 'ok')

    expect(container.querySelector('[data-step="clean"]').classList.contains('active')).toBe(true)
    expect(container.querySelector('[data-step="clean"]').classList.contains('done')).toBe(true)
  })
})

describe('panel containers', () => {
  let container, api

  beforeEach(() => {
    resetState()
    document.body.innerHTML = ''
    container = createContainer()
    api = initSidebar(container)
  })

  it('getToolPanel returns the correct step-controls element', () => {
    const panel = api.getToolPanel('clean')
    expect(panel).toBeTruthy()
    expect(panel.dataset.step).toBe('clean')
    expect(panel.classList.contains('step-controls')).toBe(true)
  })

  it('getToolPanel returns null for unknown step', () => {
    expect(api.getToolPanel('unknown')).toBeNull()
  })
})
