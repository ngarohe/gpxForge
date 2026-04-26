/**
 * Batch Queue panel — DOM builder for multi-file processing queue.
 *
 * Reads from getQueue() and calls batch-pipeline exports for actions.
 * Visible only when queue has 2+ entries.
 */

import { getQueue, removeEntry, clearQueue, countRawParked, processStaleParked } from '../modes/batch-pipeline.js'

// ────────────────────────────────────────────────────────────────────
// Module state
// ────────────────────────────────────────────────────────────────────

let _container = null
let _panel = null
let _listEl = null
let _headerCount = null
let _progressFill = null
let _progressText = null
let _btnProcess = null
let _opts = {}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function el(tag, cls, attrs) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v
      else if (k === 'html') e.innerHTML = v
      else e.setAttribute(k, v)
    }
  }
  return e
}

const STATUS_LABELS = {
  pending:  'Pending',
  brunnels: 'Brunnels…',
  lidar:    'LIDAR…',
  cleaning: 'Cleaning…',
  ready:    'Ready',
  reviewing:'Reviewing',
  done:     'Done ✓',
  parked:   '🅿 Parked',
}

const STATUS_CLASSES = {
  pending:  'badge-grey',
  brunnels: 'badge-pulse',
  lidar:    'badge-pulse',
  cleaning: 'badge-pulse',
  ready:    'badge-green',
  reviewing:'badge-amber',
  done:     'badge-done',
  parked:   'badge-amber',
}

const STEP_LABELS = {
  trim: 'Trim',
  snap: 'Snap',
  brunnels: 'Brunnels',
  clean: 'Clean',
  smooth: 'Smooth',
  split: 'Split',
  builder: 'Builder',
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// ────────────────────────────────────────────────────────────────────
// Panel build
// ────────────────────────────────────────────────────────────────────

function buildPanel() {
  const panel = el('div', 'batch-panel')

  // Header
  const header = el('div', 'batch-header')
  _headerCount = el('span', 'batch-title', { text: 'Queue' })
  header.appendChild(_headerCount)

  const headerActions = el('div', 'batch-header-actions')

  _btnProcess = el('button', 'batch-btn batch-btn--primary', { text: '⚙ Process' })
  _btnProcess.title = 'Run LIDAR + brunnels + clean on all raw parked routes'
  _btnProcess.addEventListener('click', () => {
    const n = countRawParked()
    if (n === 0) return
    const flipped = processStaleParked()
    if (flipped > 0 && _opts.onProcessAll) _opts.onProcessAll()
  })

  const btnDownloadAll = el('button', 'batch-btn batch-btn--primary', { text: '⬇ Download All' })
  btnDownloadAll.title = 'Download all done files as zip'
  btnDownloadAll.addEventListener('click', () => { if (_opts.onDownloadAll) _opts.onDownloadAll() })

  const btnClear = el('button', 'batch-btn', { text: 'Clear' })
  btnClear.title = 'Remove all entries from queue'
  btnClear.addEventListener('click', () => {
    if (!confirm('Remove all entries from queue?')) return
    clearQueue()
    if (_opts.onClear) _opts.onClear()
  })

  headerActions.appendChild(_btnProcess)
  headerActions.appendChild(btnDownloadAll)
  headerActions.appendChild(btnClear)
  header.appendChild(headerActions)
  panel.appendChild(header)

  // List
  _listEl = el('div', 'batch-list')
  panel.appendChild(_listEl)

  // Footer progress
  const footer = el('div', 'batch-footer')
  const progressBar = el('div', 'batch-progress-bar')
  _progressFill = el('div', 'batch-progress-fill')
  progressBar.appendChild(_progressFill)
  _progressText = el('div', 'batch-progress-text')
  footer.appendChild(progressBar)
  footer.appendChild(_progressText)
  panel.appendChild(footer)

  return panel
}

function buildEntry(entry) {
  const row = el('div', 'batch-entry')
  row.dataset.id = entry.id
  if (entry.origin === 'parked') row.classList.add('batch-entry--parked')
  const activeId = _opts.getActiveId && _opts.getActiveId()
  if (activeId && entry.id === activeId) row.classList.add('batch-entry--active')

  const info = el('div', 'batch-entry-info')
  const name = el('div', 'batch-entry-name', { text: entry.filename, title: entry.filename })
  info.appendChild(name)
  if (entry.status === 'parked' && entry.parkedAtStep) {
    const stepLabel = STEP_LABELS[entry.parkedAtStep] || entry.parkedAtStep
    info.appendChild(el('div', 'batch-entry-size', { text: `Parked at ${stepLabel}` }))
  } else {
    info.appendChild(el('div', 'batch-entry-size', { text: fmtSize(entry.fileSizeBytes) }))
  }

  const badge = el('span', `batch-badge ${STATUS_CLASSES[entry.status] || 'badge-grey'}`,
    { text: STATUS_LABELS[entry.status] || entry.status })
  if (entry.error) {
    badge.title = entry.error
    badge.textContent = 'Error'
    badge.className = 'batch-badge badge-error'
  }

  const actions = el('div', 'batch-entry-actions')

  if (entry.status === 'parked') {
    const btnResume = el('button', 'batch-btn batch-btn--small', { text: 'Resume' })
    btnResume.title = 'Restore this parked route and continue editing'
    btnResume.addEventListener('click', () => {
      if (_opts.isLoadBlocked && _opts.isLoadBlocked()) {
        alert('Please park or download your current route before resuming another one.')
        return
      }
      if (_opts.onResume) _opts.onResume(entry.id)
    })
    actions.appendChild(btnResume)

    const btnRemove = el('button', 'batch-btn batch-btn--small batch-btn--danger', { text: '✕' })
    btnRemove.title = 'Discard parked route'
    btnRemove.addEventListener('click', () => {
      if (!confirm(`Discard parked route "${entry.filename}"? This cannot be undone.`)) return
      removeEntry(entry.id)
    })
    actions.appendChild(btnRemove)
  } else if (entry.status === 'ready' || entry.status === 'reviewing' || entry.status === 'done') {
    const btnLoad = el('button', 'batch-btn batch-btn--small', { text: 'Load' })
    btnLoad.addEventListener('click', () => {
      if (_opts.isLoadBlocked && _opts.isLoadBlocked()) {
        alert('Please park or download your current route before loading another one.')
        return
      }
      if (_opts.onLoad) _opts.onLoad(entry.id)
    })
    actions.appendChild(btnLoad)
  } else if (entry.status === 'pending') {
    const btnRemove = el('button', 'batch-btn batch-btn--small batch-btn--danger', { text: '✕' })
    btnRemove.title = 'Remove from queue'
    btnRemove.addEventListener('click', () => removeEntry(entry.id))
    actions.appendChild(btnRemove)
  }

  row.appendChild(info)
  row.appendChild(badge)
  row.appendChild(actions)
  return row
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Build and insert the batch panel into container.
 * @param {HTMLElement} container
 * @param {{ onLoad(id), onClear, onDownloadAll }} opts
 */
export function buildBatchPanel(container, opts) {
  _container = container
  _opts = opts || {}
  _panel = buildPanel()
  _panel.style.display = 'none'  // hidden until 2+ files loaded
  container.appendChild(_panel)
}

/** Re-render the list from current queue state. */
export function refreshBatchPanel() {
  if (!_panel) return
  const queue = getQueue()

  // Show panel when there are 2+ bulk entries OR at least one parked entry.
  const bulkCount = queue.filter(e => e.origin !== 'parked').length
  const parkedCount = queue.filter(e => e.origin === 'parked').length
  const shouldShow = bulkCount >= 2 || parkedCount >= 1
  if (!shouldShow) {
    _panel.style.display = 'none'
    return
  }
  _panel.style.display = 'flex'

  // Header count reflects the total queue size (bulk + parked)
  _headerCount.textContent = `Queue (${queue.length})`

  // Process button — always visible alongside Download All / Clear.
  // Disabled when no raw parked routes are eligible. Tooltip explains.
  const rawCount = countRawParked()
  if (_btnProcess) {
    _btnProcess.style.display = ''
    _btnProcess.disabled = rawCount === 0
    if (rawCount === 0) {
      _btnProcess.textContent = '⚙ Process'
      _btnProcess.title = 'No raw parked routes — Process runs LIDAR + brunnels + clean on parked routes that haven\'t had LIDAR yet'
    } else if (rawCount === 1) {
      _btnProcess.textContent = '⚙ Process 1 raw'
      _btnProcess.title = 'Run LIDAR + brunnels + clean on 1 raw parked route'
    } else {
      _btnProcess.textContent = `⚙ Process ${rawCount} raw`
      _btnProcess.title = `Run LIDAR + brunnels + clean on ${rawCount} raw parked routes`
    }
  }

  // Rebuild list
  _listEl.innerHTML = ''
  for (const entry of queue) {
    _listEl.appendChild(buildEntry(entry))
  }

  // Progress (bulk pipeline only — parked entries aren't part of the worker's throughput)
  const bulkEntries = queue.filter(e => e.origin !== 'parked')
  const readyBulk = bulkEntries.filter(e =>
    e.status === 'ready' || e.status === 'reviewing' || e.status === 'done',
  ).length
  if (bulkEntries.length === 0) {
    _progressFill.style.width = '0%'
    _progressText.textContent = ''
  } else {
    const pct = Math.round((readyBulk / bulkEntries.length) * 100)
    _progressFill.style.width = pct + '%'
    _progressText.textContent = `${readyBulk} / ${bulkEntries.length} processed`
  }
}

/** Returns true if the batch panel is currently visible (queue ≥ 2). */
export function isBatchPanelVisible() {
  return !!_panel && _panel.style.display !== 'none'
}

