/**
 * Corrections list panel — displays detected correction zones
 * with accept/reject controls, click-to-select, and summary.
 *
 * Located inside the Clean step's output area.
 * No pipeline logic — just DOM rendering driven by ST.corrections.
 */

import { ST } from '../state.js'

// ────────────────────────────────────────────────────────────────────
// DOM helpers
// ────────────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function formatKm(distM) {
  return (distM / 1000).toFixed(2)
}

function typeBadge(type) {
  const badge = el('span', 'ci-type')
  badge.textContent = type
  if (type === 'bridge' || type === 'bridge_sag' || type === 'ramp') badge.classList.add('bridge')
  else if (type === 'tunnel') badge.classList.add('tunnel')
  else if (type === 'bridge/tunnel') badge.classList.add('bridge')
  else if (type === 'suspect') badge.classList.add('suspect')
  else if (type === 'artifact') badge.classList.add('artifact')
  return badge
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Initialise the corrections list panel inside a container.
 *
 * @param {HTMLElement} container — output panel for the Clean step
 * @param {{ onAccept: Function, onReject: Function, onSelect: Function, onRemove: Function }} actions
 * @returns {{ rebuild: Function, setSelected: Function, getHintText: Function }}
 */
export function initCorrections(container, actions) {
  // Build DOM structure
  const section = el('div', 'corr-section')

  const header = el('div', 'corr-header')
  const title = el('span', 'corr-title', 'Corrections')
  const count = el('span', 'corr-count', '0')
  header.appendChild(title)
  header.appendChild(count)

  const list = el('div', 'corr-list')

  section.appendChild(header)
  section.appendChild(list)
  container.appendChild(section)

  let _selected = -1

  /**
   * Re-render the corrections list from ST.corrections.
   */
  function rebuild() {
    list.innerHTML = ''
    const corrections = ST.corrections || []
    count.textContent = String(corrections.length)

    if (corrections.length === 0) {
      list.appendChild(el('div', 'corr-empty', 'No corrections'))
      return
    }

    corrections.forEach((c, ci) => {
      const item = el('div', 'corr-item')
      item.dataset.ci = ci

      // Number
      item.appendChild(el('span', 'ci-num', String(ci + 1)))

      // Distance range
      const kmText = `${formatKm(ST.dists[c.alo])}–${formatKm(ST.dists[c.ahi])} km`
      item.appendChild(el('span', 'ci-km', kmText))

      // Span
      const spanText = c.span < 1000
        ? `${Math.round(c.span)}m`
        : `${(c.span / 1000).toFixed(1)}km`
      item.appendChild(el('span', 'ci-span', spanText))

      // Type badge
      item.appendChild(typeBadge(c.type))

      // Grade info
      const gradeText = `${c.grade >= 0 ? '+' : ''}${c.grade.toFixed(1)}%`
      item.appendChild(el('span', 'ci-grade', gradeText))

      // Action buttons
      const btns = el('span', 'ci-actions')
      const btnAccept = el('button', 'ci-btn-accept', '\u2713')
      btnAccept.title = c.accepted ? 'Undo accept' : 'Accept correction'
      btnAccept.addEventListener('click', (ev) => {
        ev.stopPropagation()
        actions.onAccept(ci)
      })

      const btnReject = el('button', 'ci-btn-reject', '\u2717')
      btnReject.title = c.rejected ? 'Undo reject' : 'Reject correction'
      btnReject.addEventListener('click', (ev) => {
        ev.stopPropagation()
        actions.onReject(ci)
      })

      btns.appendChild(btnAccept)
      btns.appendChild(btnReject)
      item.appendChild(btns)

      // State classes
      if (c.type === 'suspect') item.classList.add('suspect-item')
      if (c.rejected) item.classList.add('rejected')
      if (c.accepted) item.classList.add('accepted')
      if (ci === _selected) item.classList.add('sel')

      // Click to select
      item.addEventListener('click', () => actions.onSelect(ci))

      list.appendChild(item)
    })
  }

  /**
   * Highlight a correction item and scroll it into view.
   * @param {number} ci — correction index, or -1 to deselect
   */
  function setSelected(ci) {
    _selected = ci
    // Update DOM classes
    const items = list.querySelectorAll('.corr-item')
    items.forEach((item) => {
      const idx = parseInt(item.dataset.ci, 10)
      item.classList.toggle('sel', idx === ci)
    })
    // Scroll into view
    if (ci >= 0) {
      const target = list.querySelector(`.corr-item[data-ci="${ci}"]`)
      if (target?.scrollIntoView) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }

  /**
   * Get a summary hint text for the corrections state.
   * @returns {string}
   */
  function getHintText() {
    const corrections = ST.corrections || []
    if (corrections.length === 0) return 'No corrections'
    const pending = corrections.filter(c => c.type === 'suspect' && !c.accepted && !c.rejected)
    if (pending.length === 0) return `${corrections.length} reviewed`
    return `${pending.length} pending`
  }

  return { rebuild, setSelected, getHintText }
}
