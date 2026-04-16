/**
 * Step navigation — horizontal tabs and per-step controls containers.
 *
 * Builds horizontal step tabs inside the step-toolbar element.
 * Each step has a number badge, title, and status indicator.
 * Per-step controls containers are managed here.
 * Step output/results are rendered in the info panel (shell.js).
 */

import { ST } from '../state.js'

// ────────────────────────────────────────────────────────────────────
// Step definitions
// ────────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 'trim',     num: 0, title: 'Trim',      desc: 'Select section to keep' },
  { id: 'snap',     num: 1, title: 'Road Snap',  desc: 'Road-snap to cycling routes' },
  { id: 'brunnels', num: 2, title: 'Brunnels',   desc: 'Fetch bridges & tunnels' },
  { id: 'clean',    num: 3, title: 'Clean',      desc: 'Detect & fix elevation spikes' },
  { id: 'smooth',   num: 4, title: 'Smooth',     desc: 'Gaussian elevation smoothing' },
  { id: 'split',    num: 5, title: 'Split',      desc: 'Timing & GPX split export' },
]

// ────────────────────────────────────────────────────────────────────
// Module state
// ────────────────────────────────────────────────────────────────────

let _container = null
let _stepEls = {}      // { trim: { root, num, status }, ... }
let _controlEls = {}   // { trim: div.step-controls, ... }
let _builderControlsEl = null
let _tabsRow = null
let _onStepChange = null

// ────────────────────────────────────────────────────────────────────
// DOM helpers
// ────────────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

// ────────────────────────────────────────────────────────────────────
// Step navigation
// ────────────────────────────────────────────────────────────────────

function setActiveStep(stepId) {
  for (const s of STEPS) {
    _stepEls[s.id].root.classList.remove('active')
    _controlEls[s.id].style.display = 'none'
  }
  _stepEls[stepId].root.classList.add('active')
  _controlEls[stepId].style.display = ''
  ST.activeStep = stepId
  if (_onStepChange) _onStepChange(stepId)
}

function setStepStatus(stepId, status, text) {
  const step = _stepEls[stepId]
  if (!step) return
  step.status.textContent = text || '\u2014'
  step.root.classList.toggle('done', status === 'done')
  step.root.classList.toggle('warn', status === 'warn')
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Initialize the step navigation inside the given container element.
 * Builds horizontal tabs + per-step controls containers.
 * @param {HTMLElement} container — the .step-toolbar element from shell
 * @param {object} [opts]
 * @param {Function} [opts.onStepChange] — callback(stepId) when active step changes
 * @returns {{ setActiveStep, setStepStatus, getActiveStep, getToolPanel }}
 */
export function initSidebar(container, opts = {}) {
  _container = container
  _onStepChange = opts.onStepChange || null

  // Build horizontal step tabs
  _tabsRow = el('div', 'step-tabs')
  const tabsRow = _tabsRow

  for (const step of STEPS) {
    const tab = el('div', 'step-tab')
    tab.dataset.step = step.id
    tab.title = step.desc

    const num = el('div', 'step-tab-num', String(step.num))
    const name = el('span', 'step-tab-name', step.title)
    const status = el('span', 'step-tab-status', '\u2014')

    tab.appendChild(num)
    tab.appendChild(name)
    tab.appendChild(status)

    tab.addEventListener('click', () => setActiveStep(step.id))

    _stepEls[step.id] = { root: tab, num, status }
    tabsRow.appendChild(tab)
  }

  container.appendChild(tabsRow)

  // Build per-step controls containers
  for (const step of STEPS) {
    const controls = el('div', 'step-controls')
    controls.dataset.step = step.id
    controls.style.display = 'none'
    _controlEls[step.id] = controls
    container.appendChild(controls)
  }

  // Builder controls container (shown when builder mode is active, hides step tabs)
  _builderControlsEl = el('div', 'step-controls')
  _builderControlsEl.dataset.step = 'builder'
  _builderControlsEl.style.display = 'none'
  container.appendChild(_builderControlsEl)

  return {
    /** Switch active step. Updates DOM classes and panel visibility. */
    setActiveStep,

    /** Update step status badge. status: 'done'|'warn'|'none' */
    setStepStatus,

    /** Get current active step id */
    getActiveStep() {
      return ST.activeStep
    },

    /** Get the controls container for a step (for panels.js to populate) */
    getToolPanel(stepId) {
      return _controlEls[stepId] || null
    },

    /** Get the builder controls container */
    getBuilderPanel() {
      return _builderControlsEl
    },

    /**
     * Show/hide builder mode: hides step tabs + step controls, shows builder controls.
     * @param {boolean} active
     */
    setBuilderActive(active) {
      _tabsRow.style.display = active ? 'none' : ''
      for (const step of STEPS) {
        if (active) _controlEls[step.id].style.display = 'none'
      }
      _builderControlsEl.style.display = active ? '' : 'none'
      if (!active) {
        // Restore previously active step controls
        if (ST.activeStep && _controlEls[ST.activeStep]) {
          _controlEls[ST.activeStep].style.display = ''
        }
      }
    },
  }
}
