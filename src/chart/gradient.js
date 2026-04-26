/**
 * Gradient overlay chart — renders gradient (%) vs distance.
 *
 * Drawing layers:
 *  1. Grid lines (±20%, ±10%, 0%)
 *  2. Y-axis labels
 *  3. Original gradient (red, semi-transparent)
 *  4. Clean gradient (cyan)
 *  5. Smoothed gradient (green)
 *  6. Legend labels
 */

import { ST } from '../state.js'
import { getViewRange, zoom, setCursor, clearCursor } from '../sync.js'
import {
  PAD, GRAD_CLIP, setupCv, visibleRange, makeXp,
  evToDistIdx, hitTestCorrection,
} from './shared.js'

// ────────────────────────────────────────────────────────────────────
// Drawing
// ────────────────────────────────────────────────────────────────────

/**
 * Draw the gradient overlay on the given canvas.
 * @param {HTMLCanvasElement} cv
 */
export function drawGradient(cv) {
  const { ctx, W, H } = setupCv(cv)
  ctx.clearRect(0, 0, W, H)
  if (!ST.gpx || !ST.grOrig) return

  const { lo, hi } = getViewRange()
  const cw = W - PAD.l - PAD.r
  const ch = H - PAD.t - PAD.b
  const xp = makeXp(lo, hi, cw)
  const yp = g => PAD.t + ch / 2 - g / GRAD_CLIP * (ch / 2)

  // ── Grid ──
  ctx.strokeStyle = '#e8ecf2'
  ctx.lineWidth = 1
  for (const g of [-20, -10, 0, 10, 20]) {
    const y = yp(g)
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke()
  }
  // Zero line bolder
  ctx.strokeStyle = '#c0c8d4'
  ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.moveTo(PAD.l, yp(0)); ctx.lineTo(W - PAD.r, yp(0)); ctx.stroke()

  // ── Y labels ──
  ctx.fillStyle = '#8896a8'
  ctx.font = "10px 'IBM Plex Mono'"
  ctx.textAlign = 'right'
  for (const g of [-20, -10, 0, 10, 20]) {
    ctx.fillText(g + '%', PAD.l - 4, yp(g) + 3)
  }

  // Visible range
  const { iLo, iHi } = visibleRange(ST.dists, lo, hi)

  // Helper to draw a gradient line
  function drawLine(gr, color, lw, alpha) {
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.lineWidth = lw
    ctx.globalAlpha = alpha
    let started = false
    for (let i = iLo; i < iHi && i < gr.length; i++) {
      const x = xp(ST.dists[i])
      const y = yp(Math.max(-GRAD_CLIP, Math.min(GRAD_CLIP, gr[i])))
      if (started) ctx.lineTo(x, y)
      else { ctx.moveTo(x, y); started = true }
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // ── Lines ──
  if (ST.grClean) drawLine(ST.grOrig, 'rgba(200,60,60,0.5)', 1, 1)
  drawLine(ST.grClean || ST.grOrig, '#0077aa', 1.5, 1)

  // Smoothed gradient from smoothedRoute (different point count / dists)
  // Use origDists for X alignment, fall back to proportional scaling
  if (ST.smoothedRoute) {
    const sd = ST.smoothedRoute.dists
    const sg = ST.smoothedRoute.gr
    const od = ST.smoothedRoute.origDists
    const sTotal = sd[sd.length - 1]
    const oTotal = ST.dists[ST.dists.length - 1]
    const dScale = sTotal > 0 ? oTotal / sTotal : 1
    const xDist = od || sd
    const xScale = od ? 1 : dScale
    const sLoDist = od ? lo : (dScale !== 1 ? lo / dScale : lo)
    const sHiDist = od ? hi : (dScale !== 1 ? hi / dScale : hi)
    const { iLo: sLo, iHi: sHi } = visibleRange(xDist, sLoDist, sHiDist)
    ctx.beginPath()
    ctx.strokeStyle = '#1a7a3a'
    ctx.lineWidth = 2
    let started = false
    for (let i = sLo; i < sHi && i < sg.length; i++) {
      const x = xp(xDist[i] * xScale)
      const y = yp(Math.max(-GRAD_CLIP, Math.min(GRAD_CLIP, sg[i])))
      if (started) ctx.lineTo(x, y)
      else { ctx.moveTo(x, y); started = true }
    }
    ctx.stroke()
  }

  // ── Legend ──
  ctx.fillStyle = '#8896a8'
  ctx.font = "10px 'Inter'"
  ctx.textAlign = 'left'
  ctx.fillText('gradient %', PAD.l + 4, PAD.t + 10)
  if (ST.grClean) {
    ctx.fillStyle = 'rgba(200,60,60,0.7)'
    ctx.fillText('orig', PAD.l + 80, PAD.t + 10)
    ctx.fillStyle = '#0077aa'
    ctx.fillText('clean', PAD.l + 110, PAD.t + 10)
  }
  if (ST.smoothedRoute) {
    ctx.fillStyle = '#1a7a3a'
    ctx.fillText('smooth', PAD.l + (ST.grClean ? 155 : 80), PAD.t + 10)
  }
}

// ────────────────────────────────────────────────────────────────────
// Mouse interaction
// ────────────────────────────────────────────────────────────────────

/**
 * Wire up mouse events on the gradient chart canvas.
 * @param {HTMLCanvasElement} cv
 * @param {object} actions
 * @param {Function} actions.selectCorr
 * @param {Function} actions.drawAll
 */
export function initGradient(cv, actions) {
  cv.addEventListener('wheel', ev => {
    if (!ST.dists) return
    ev.preventDefault()
    const rect = cv.getBoundingClientRect()
    const xFrac = (ev.clientX - rect.left - PAD.l) / (rect.width - PAD.l - PAD.r)
    const factor = ev.deltaY > 0 ? 1.25 : 0.8
    zoom(Math.max(0, Math.min(1, xFrac)), factor)
  }, { passive: false })

  cv.addEventListener('mousemove', ev => {
    if (!ST.dists || ST.dragState || ST.drawMode) return
    const hit = evToDistIdx(ev, cv)
    if (!hit) { clearCursor(); return }
    setCursor(hit.idx, hit.distM)
  })

  cv.addEventListener('mouseleave', () => {
    clearCursor()
  })

  cv.addEventListener('click', ev => {
    if (!ST.dists) return
    const hit = evToDistIdx(ev, cv)
    if (!hit) return
    const ci = hitTestCorrection(hit.distM)
    if (ci >= 0) {
      actions.selectCorr(ci)
      actions.drawAll()
    }
  })
}
