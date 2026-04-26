/**
 * Elevation chart — main canvas rendering and mouse interaction.
 *
 * Drawing layers (bottom to top):
 *  1. Grid + labels
 *  2. Gradient fill (colored strips)
 *  3. Brunnel bands
 *  4. Selected correction highlight
 *  5. Drag preview
 *  6. Draw mode rubber band
 *  7. Original elevation line (red)
 *  8. Clean elevation line (black)
 *  9. Smoothed elevation line (green)
 * 10. Correction zone anchors
 * 11. Hover tooltip
 */

import { ST } from '../state.js'
import { classifyStructure } from '../pipeline/3-clean.js'
import { hermiteElevation } from '../utils/math.js'
import { gradColor, smoothGradForDisplay } from '../utils/format.js'
import { getViewRange, zoom, setView, setCursor, clearCursor } from '../sync.js'
import {
  PAD, setupCv, niceStep, visibleRange,
  makeXp, makeYp,
  evToDistIdx, hitTestCorrection, findAnchorHandle,
} from './shared.js'

let _actions = null
let _fillColorSource = null
let _fillColors = null

function _readShapeParams() {
  const fallback = { smart: true, tangWin: 8, hermDev: 0.5, bridgeDip: 1.0, tunnelSpk: 1.0 }
  if (!_actions || typeof _actions.getShapeParams !== 'function') return fallback
  try {
    const p = _actions.getShapeParams()
    if (!p || typeof p !== 'object') return fallback
    return {
      smart: p.smart !== false,
      tangWin: Number.isFinite(+p.tangWin) ? +p.tangWin : fallback.tangWin,
      hermDev: Number.isFinite(+p.hermDev) ? +p.hermDev : fallback.hermDev,
      bridgeDip: Number.isFinite(+p.bridgeDip) ? +p.bridgeDip : fallback.bridgeDip,
      tunnelSpk: Number.isFinite(+p.tunnelSpk) ? +p.tunnelSpk : fallback.tunnelSpk,
    }
  } catch {
    return fallback
  }
}

function _previewStructure(alo, ahi, corr = null) {
  if (!ST.gpx || !ST.dists || alo >= ahi) return { interp: 'uniform', m0: 0, m1: 0 }
  if (corr && corr.type === 'suspect') return { interp: 'uniform', m0: 0, m1: 0 }

  const shape = _readShapeParams()
  const params = shape.smart
    ? {
      tangWin: shape.tangWin,
      hermDev: shape.hermDev,
      bridgeDip: shape.bridgeDip,
      tunnelSpk: shape.tunnelSpk,
    }
    : {
      tangWin: shape.tangWin,
      hermDev: shape.hermDev,
      bridgeDip: 999,
      tunnelSpk: 999,
    }

  try {
    return classifyStructure(ST.gpx.eles, ST.dists, alo, ahi, params)
  } catch {
    return { interp: 'uniform', m0: 0, m1: 0 }
  }
}

function _previewElevation(i, alo, ahi, structure) {
  const e0 = ST.gpx.eles[alo]
  const e1 = ST.gpx.eles[ahi]
  const d0 = ST.dists[alo]
  const span = ST.dists[ahi] - d0
  const t = span > 0 ? (ST.dists[i] - d0) / span : 0
  if (structure.interp === 'uniform') return e0 + t * (e1 - e0)
  return hermiteElevation(t, e0, e1, structure.m0, structure.m1, span)
}

function _shouldUseSmoothedFill() {
  if (!ST.smoothedRoute) return false
  // Simple mode keeps activeStep null; split also views final smoothed geometry.
  return ST.activeStep == null || ST.activeStep === 'smooth' || ST.activeStep === 'split'
}

function _getFillColors(grArr) {
  if (!grArr || !grArr.length) return null
  if (_fillColorSource !== grArr) {
    _fillColorSource = grArr
    const sm = smoothGradForDisplay(Array.from(grArr), 9)
    _fillColors = sm.map(gradColor)
  }
  return _fillColors
}

// ────────────────────────────────────────────────────────────────────
// Drawing
// ────────────────────────────────────────────────────────────────────

/**
 * Draw the elevation profile on the given canvas.
 * @param {HTMLCanvasElement} cv
 */
export function drawElevation(cv) {
  const { ctx, W, H } = setupCv(cv)
  ctx.clearRect(0, 0, W, H)
  if (!ST.gpx) return

  const N = ST.dists.length
  const eles = ST.gpx.eles.length === N ? ST.gpx.eles : (ST.eleClean || ST.gpx.eles)
  const { lo, hi } = getViewRange()
  const cw = W - PAD.l - PAD.r
  const ch = H - PAD.t - PAD.b
  const xp = makeXp(lo, hi, cw)

  // Visible index range
  const { iLo, iHi } = visibleRange(ST.dists, lo, hi)

  // Y range — scan visible points across all elevation arrays
  let minE = Infinity, maxE = -Infinity
  for (let i = iLo; i <= iHi; i++) {
    const e0 = eles[i]
    const e1 = ST.eleClean && ST.eleClean.length === N ? ST.eleClean[i] : e0
    if (e0 < minE) minE = e0; if (e0 > maxE) maxE = e0
    if (e1 < minE) minE = e1; if (e1 > maxE) maxE = e1
  }
  // Also scan smoothed route (different point count / dists)
  // Smoothed route has different total distance — map viewport proportionally
  if (ST.smoothedRoute) {
    const sd = ST.smoothedRoute.dists
    const se = ST.smoothedRoute.eles
    const sTotal = sd[sd.length - 1]
    const oTotal = ST.dists[ST.dists.length - 1]
    const sLoDist = oTotal > 0 ? lo * sTotal / oTotal : lo
    const sHiDist = oTotal > 0 ? hi * sTotal / oTotal : hi
    const { iLo: sLo, iHi: sHi } = visibleRange(sd, sLoDist, sHiDist)
    for (let i = sLo; i <= sHi; i++) {
      if (se[i] < minE) minE = se[i]
      if (se[i] > maxE) maxE = se[i]
    }
  }
  if (minE === Infinity) { minE = 0; maxE = 1 }
  const eRange = maxE - minE || 1
  const yp = makeYp(minE, eRange, ch)

  // ── Layer 1: Grid + labels ──
  ctx.strokeStyle = '#e8ecf2'
  ctx.lineWidth = 1
  ctx.fillStyle = '#8896a8'
  ctx.font = "10px 'IBM Plex Mono'"
  ctx.textAlign = 'right'
  for (let i = 0; i <= 5; i++) {
    const e = minE + eRange * i / 5
    const y = yp(e)
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke()
    ctx.fillText(Math.round(e) + 'm', PAD.l - 4, y + 3)
  }
  ctx.textAlign = 'center'
  ctx.fillStyle = '#8896a8'
  const step = niceStep((hi - lo) / 6)
  const firstTick = Math.ceil(lo / step) * step
  for (let d = firstTick; d <= hi; d += step) {
    const x = xp(d)
    if (x < PAD.l || x > W - PAD.r) continue
    ctx.fillText((d / 1000).toFixed(1) + 'km', x, H - PAD.b + 14)
  }

  // ── Layer 2: Gradient fill ──
  const drawEles = ST.eleClean || eles
  const useSmoothedFill = _shouldUseSmoothedFill()
  if (useSmoothedFill && ST.smoothedRoute) {
    const se = ST.smoothedRoute.eles
    const sg = ST.smoothedRoute.gr
    const sd = ST.smoothedRoute.dists
    const od = ST.smoothedRoute.origDists
    const sTotal = sd[sd.length - 1]
    const oTotal = ST.dists[ST.dists.length - 1]
    const dScale = sTotal > 0 ? oTotal / sTotal : 1
    const xDist = od || sd
    const xScale = od ? 1 : dScale
    const sLoDist = od ? lo : (dScale !== 1 ? lo / dScale : lo)
    const sHiDist = od ? hi : (dScale !== 1 ? hi / dScale : hi)
    const { iLo: sLo, iHi: sHi } = visibleRange(xDist, sLoDist, sHiDist)
    const colors = _getFillColors(sg)
    if (colors) {
      // Clip to area under the smoothed curve so the color top edge is smooth.
      const xStart = xp(xDist[sLo] * xScale)
      const xEnd = xp(xDist[sHi] * xScale)
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(xStart, PAD.t + ch)
      for (let i = sLo; i <= sHi; i++) {
        ctx.lineTo(xp(xDist[i] * xScale), yp(se[i]))
      }
      ctx.lineTo(xEnd, PAD.t + ch)
      ctx.closePath()
      ctx.clip()
      for (let i = sLo; i < sHi; i++) {
        const x0 = xp(xDist[i] * xScale)
        const x1 = xp(xDist[i + 1] * xScale)
        ctx.fillStyle = colors[Math.min(i, colors.length - 1)]
        ctx.fillRect(x0, PAD.t, Math.max(1, x1 - x0), ch)
      }
      ctx.restore()
    }
  } else {
    const colors = _getFillColors(ST.grClean || ST.grOrig)
    if (colors) {
      for (let i = iLo; i < iHi; i++) {
        const x0 = xp(ST.dists[i]), x1 = xp(ST.dists[i + 1])
        ctx.fillStyle = colors[Math.min(i, colors.length - 1)]
        const yTop = yp(drawEles[i])
        ctx.fillRect(x0, yTop, Math.max(1, x1 - x0), PAD.t + ch - yTop)
      }
    }
  }

  // ── Layer 3: OSM brunnel bands ──
  const brunnels = ST.brunnels || []
  if (brunnels.length) {
    for (const b of brunnels) {
      if (b.alo >= iHi || b.ahi <= iLo) continue
      const x0 = xp(ST.dists[Math.max(b.alo, iLo)])
      const x1 = xp(ST.dists[Math.min(b.ahi, iHi, N - 1)])
      const isBridge = b.type === 'bridge' || b.type === 'bridge/tunnel'
      ctx.fillStyle = isBridge ? 'rgba(0,180,216,0.13)' : 'rgba(155,93,229,0.13)'
      ctx.fillRect(x0, PAD.t, x1 - x0, ch)
      ctx.strokeStyle = isBridge ? 'rgba(0,180,216,0.55)' : 'rgba(155,93,229,0.55)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeRect(x0, PAD.t, x1 - x0, ch)
      ctx.setLineDash([])
      const mx = (x0 + x1) / 2
      ctx.fillStyle = isBridge ? 'rgba(0,180,216,0.9)' : 'rgba(155,93,229,0.9)'
      ctx.font = "bold 9px 'IBM Plex Mono'"
      ctx.textAlign = 'center'
      ctx.fillText(isBridge ? 'B' : 'T', mx, PAD.t + 10)
    }
  }

  // ── Layer 4: Selected correction highlight ──
  if (ST.selectedCorr != null && ST.corrections) {
    const c = ST.corrections[ST.selectedCorr]
    if (c) {
      const x0 = xp(ST.dists[c.alo]), x1 = xp(ST.dists[c.ahi])
      ctx.fillStyle = 'rgba(200,120,0,0.12)'
      ctx.fillRect(x0, PAD.t, x1 - x0, ch)
    }
  }

  // ── Layer 5: Drag preview ──
  if (ST.dragState && ST.eleClean) {
    const { corrIdx, which, previewIdx } = ST.dragState
    const c = ST.corrections[corrIdx]
    const alo = which === 'lo' ? previewIdx : c.alo
    const ahi = which === 'hi' ? previewIdx : c.ahi
    if (alo < ahi) {
      const struct = _previewStructure(alo, ahi, c)
      ctx.beginPath()
      ctx.strokeStyle = 'rgba(200,120,0,0.85)'
      ctx.lineWidth = 2.5
      for (let i = alo; i <= ahi; i++) {
        const e = _previewElevation(i, alo, ahi, struct)
        const x = xp(ST.dists[i]), y = yp(e)
        i === alo ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      // Type label
      const mx = xp((ST.dists[alo] + ST.dists[ahi]) / 2)
      ctx.fillStyle = 'rgba(200,120,0,0.9)'
      ctx.font = "bold 10px 'IBM Plex Mono'"
      ctx.textAlign = 'center'
      ctx.fillText('PREVIEW', mx, PAD.t + 12)
    }
  }

  // ── Layer 6: Draw mode rubber band ──
  if (ST.drawMode && ST.drawAnchor1 != null && ST.drawCursorIdx != null) {
    const alo = Math.min(ST.drawAnchor1, ST.drawCursorIdx)
    const ahi = Math.max(ST.drawAnchor1, ST.drawCursorIdx)
    if (alo < ahi) {
      const x0 = xp(ST.dists[alo]), x1 = xp(ST.dists[ahi])
      ctx.fillStyle = 'rgba(200,120,0,0.1)'
      ctx.fillRect(x0, PAD.t, x1 - x0, ch)
      ctx.strokeStyle = 'rgba(200,120,0,0.7)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 4])
      ctx.strokeRect(x0, PAD.t, x1 - x0, ch)
      ctx.setLineDash([])

      const struct = _previewStructure(alo, ahi)
      ctx.beginPath()
      ctx.strokeStyle = 'rgba(200,120,0,0.85)'
      ctx.lineWidth = 2.5
      for (let i = alo; i <= ahi; i++) {
        const e = _previewElevation(i, alo, ahi, struct)
        const x = xp(ST.dists[i]), y = yp(e)
        i === alo ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  // ── Layer 7: Original elevation line (red, thin) ──
  if (ST.eleClean && ST.gpx.eles.length === N) {
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(200,60,60,0.4)'
    ctx.lineWidth = 1.5
    for (let i = iLo; i <= iHi; i++) {
      const x = xp(ST.dists[i]), y = yp(ST.gpx.eles[i] || eles[i])
      i === iLo ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  // ── Layer 8: Clean elevation line (black, bold) ──
  const lineEles = ST.eleClean && ST.eleClean.length === N ? ST.eleClean : eles
  if (!useSmoothedFill) {
    ctx.beginPath()
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 2
    for (let i = iLo; i <= iHi; i++) {
      const x = xp(ST.dists[i]), y = yp(lineEles[i])
      i === iLo ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  // ── Layer 9: Smoothed elevation line (green overlay) ──
  // Use origDists (geographic mapping to original route distance axis) for X positioning.
  // Falls back to proportional scaling if origDists not available.
  if (ST.smoothedRoute) {
    const sd = ST.smoothedRoute.dists
    const se = ST.smoothedRoute.eles
    const od = ST.smoothedRoute.origDists // geographic X mapping
    const sTotal = sd[sd.length - 1]
    const oTotal = ST.dists[ST.dists.length - 1]
    const dScale = sTotal > 0 ? oTotal / sTotal : 1
    // Use origDists for visible range if available, else proportional
    const xDist = od || sd
    const xScale = od ? 1 : dScale
    const sLoDist = od ? lo : (dScale !== 1 ? lo / dScale : lo)
    const sHiDist = od ? hi : (dScale !== 1 ? hi / dScale : hi)
    const { iLo: sLo, iHi: sHi } = visibleRange(xDist, sLoDist, sHiDist)
    ctx.beginPath()
    ctx.strokeStyle = '#1a7a3a'
    ctx.lineWidth = 2
    for (let i = sLo; i <= sHi; i++) {
      const x = xp(xDist[i] * xScale), y = yp(se[i])
      i === sLo ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
    // Legend
    ctx.fillStyle = '#1a7a3a'
    ctx.font = "600 10px 'IBM Plex Mono'"
    ctx.textAlign = 'right'
    ctx.fillText('▬ SMOOTHED', W - PAD.r - 2, PAD.t + 10)
  }

  // ── Layer 10: Correction zone anchors ──
  if (ST.corrections) {
    ST._anchorHandles = []

    ST.corrections.forEach((c, ci) => {
      const isSel = ci === ST.selectedCorr
      const isDragging = ST.dragState?.corrIdx === ci
      const baseCol = c.type === 'suspect' ? [194, 65, 12]
        : c.type === 'tunnel' ? [0, 119, 170]
        : c.type === 'bridge' || c.type === 'bridge_sag' || c.type === 'ramp' || c.type === 'bridge/tunnel' ? [180, 120, 0]
        : c.type === 'artifact' ? [146, 64, 14]
        : [100, 120, 160]
      const alpha = isSel ? 0.9 : 0.5
      const colStr = `rgba(${baseCol[0]},${baseCol[1]},${baseCol[2]},${alpha})`

      for (const which of ['lo', 'hi']) {
        const idx = which === 'lo' ? c.alo : c.ahi
        const drawIdx = (isDragging && ST.dragState.which === which)
          ? ST.dragState.previewIdx : idx
        const x = xp(ST.dists[drawIdx])

        // Anchor line
        ctx.strokeStyle = colStr
        ctx.lineWidth = isSel ? 2 : 1.5
        ctx.setLineDash(isSel ? [] : [3, 3])
        ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + ch); ctx.stroke()
        ctx.setLineDash([])

        // Handle triangle at top
        const hx = x, hy = PAD.t + 2, hs = 7
        ctx.fillStyle = (ST.dragState?.corrIdx === ci && ST.dragState?.which === which)
          ? '#c87800' : colStr
        ctx.beginPath()
        ctx.moveTo(hx, hy + hs)
        ctx.lineTo(hx - hs / 2, hy)
        ctx.lineTo(hx + hs / 2, hy)
        ctx.closePath()
        ctx.fill()
        if (isSel) { ctx.strokeStyle = 'white'; ctx.lineWidth = 0.8; ctx.stroke() }

        // Store hit area for mouse detection
        ST._anchorHandles.push({ corrIdx: ci, which, idx: drawIdx, x, hy, hs })
      }
    })
  }

  // ── Layer 11: Hover tooltip ──
  if (ST.hoverIdx != null && !ST.dragState && !ST.drawMode) {
    const i = ST.hoverIdx
    if (i >= 0 && i < N) {
      const x = xp(ST.dists[i])

      // Step-aware elevation: smooth step shows smoothed, others show clean/raw
      let e, g
      if (ST.activeStep === 'smooth' && ST.smoothedRoute) {
        // Find closest smoothed point by geographic distance mapping (origDists)
        // or fall back to proportional distance mapping
        const distM = ST.dists[i]
        const od = ST.smoothedRoute.origDists
        const sd = ST.smoothedRoute.dists
        let bestJ = 0, bestD = Infinity
        if (od) {
          // origDists maps each smoothed point to the original distance axis
          for (let j = 0; j < od.length; j++) {
            const d = Math.abs(od[j] - distM)
            if (d < bestD) { bestD = d; bestJ = j }
          }
        } else {
          const sTotal = sd[sd.length - 1]
          const oTotal = ST.dists[ST.dists.length - 1]
          const targetDist = oTotal > 0 ? distM * sTotal / oTotal : distM
          for (let j = 0; j < sd.length; j++) {
            const d = Math.abs(sd[j] - targetDist)
            if (d < bestD) { bestD = d; bestJ = j }
          }
        }
        e = ST.smoothedRoute.eles[bestJ]
        g = ST.smoothedRoute.gr[bestJ]
      } else {
        e = lineEles[i]
        const gr = ST.grClean || ST.grOrig
        g = gr ? gr[Math.min(i, gr.length - 1)] : 0
      }
      const y = yp(e)

      // Vertical line
      ctx.strokeStyle = 'rgba(0,0,0,0.2)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + ch); ctx.stroke()
      ctx.setLineDash([])

      // Circle
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#f59e0b'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Info box
      const km = (ST.dists[i] / 1000).toFixed(2)
      const lines = [`${km} km`, `${e.toFixed(1)} m`, `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`]
      ctx.font = "500 11px 'IBM Plex Mono'"
      const lw = lines.reduce((mx, l) => Math.max(mx, ctx.measureText(l).width), 0)
      const bw = lw + 16, bh = 52
      const bx = Math.min(x + 8, W - PAD.r - bw - 4)
      const by = Math.max(PAD.t + 4, y - bh - 8)
      ctx.fillStyle = 'rgba(255,255,255,0.96)'
      ctx.strokeStyle = '#ddd'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(bx, by, bw, bh, 4)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#333'
      lines.forEach((l, li) => ctx.fillText(l, bx + 8, by + 15 + li * 15))
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Mouse interaction
// ────────────────────────────────────────────────────────────────────

/**
 * Wire up mouse events on the elevation chart canvas.
 * @param {HTMLCanvasElement} cv
 * @param {object} actions — callbacks from orchestrator
 * @param {Function} actions.drawAll — redraw all charts
 * @param {Function} actions.commitDrag — (corrIdx, which, newIdx)
 * @param {Function} actions.commitDraw — (alo, ahi)
 * @param {Function} actions.removeCorr — (ci)
 * @param {Function} actions.selectCorr — (ci)
 * @param {Function} actions.getShapeParams — () => current clean shape params
 */
export function initElevation(cv, actions) {
  _actions = actions
  let _mouseDownX = 0, _mouseDownY = 0, _didDrag = false

  cv.addEventListener('mousedown', ev => {
    if (!ST.dists || !ST.corrections) return
    if (ev.button !== 0) return
    _mouseDownX = ev.clientX
    _mouseDownY = ev.clientY
    _didDrag = false

    if (ST.drawMode) return

    const handle = findAnchorHandle(ev.clientX, ev.clientY, cv)
    if (handle) {
      ST.dragState = {
        corrIdx: handle.corrIdx,
        which: handle.which,
        startMouseX: ev.clientX,
        origIdx: handle.idx,
        previewIdx: handle.idx,
      }
      cv.style.cursor = 'ew-resize'
      ev.preventDefault()
    }
  })

  cv.addEventListener('mousemove', ev => {
    if (!ST.dists) return

    if (Math.abs(ev.clientX - _mouseDownX) > 4 || Math.abs(ev.clientY - _mouseDownY) > 4) {
      _didDrag = true
    }

    // Active drag
    if (ST.dragState) {
      const hit = evToDistIdx(ev, cv)
      if (hit) {
        const c = ST.corrections[ST.dragState.corrIdx]
        let clamped = hit.idx
        if (ST.dragState.which === 'lo') clamped = Math.min(hit.idx, c.ahi - 2)
        else clamped = Math.max(hit.idx, c.alo + 2)
        clamped = Math.max(0, Math.min(ST.dists.length - 1, clamped))
        ST.dragState.previewIdx = clamped
      }
      drawElevation(cv)
      return
    }

    // Draw mode cursor tracking
    if (ST.drawMode) {
      const hit = evToDistIdx(ev, cv)
      ST.drawCursorIdx = hit ? hit.idx : null
      cv.style.cursor = 'crosshair'
      drawElevation(cv)
      return
    }

    // Normal hover
    const hit = evToDistIdx(ev, cv)
    if (!hit) {
      clearCursor()
      cv.style.cursor = 'default'
      return
    }

    const handle = findAnchorHandle(ev.clientX, ev.clientY, cv)
    cv.style.cursor = handle ? 'ew-resize' : 'crosshair'
    setCursor(hit.idx, hit.distM)
  })

  cv.addEventListener('mouseup', ev => {
    if (!ST.dists) return
    if (ev.button !== 0) return

    // Commit drag
    if (ST.dragState) {
      const { corrIdx, which, previewIdx, origIdx } = ST.dragState
      ST.dragState = null
      cv.style.cursor = 'crosshair'
      if (previewIdx !== origIdx) actions.commitDrag(corrIdx, which, previewIdx)
      else actions.drawAll()
      return
    }

    // Draw mode: place anchors
    if (ST.drawMode) {
      const hit = evToDistIdx(ev, cv)
      const idx = ST.drawCursorIdx != null ? ST.drawCursorIdx : (hit ? hit.idx : null)
      if (idx == null) return
      if (ST.drawAnchor1 == null) {
        ST.drawAnchor1 = idx
        ST.drawCursorIdx = idx
      } else {
        const alo = Math.min(ST.drawAnchor1, idx)
        const ahi = Math.max(ST.drawAnchor1, idx)
        ST.drawMode = false
        ST.drawAnchor1 = null
        ST.drawCursorIdx = null
        if (ahi - alo >= 2) actions.commitDraw(alo, ahi)
      }
      return
    }

    // Click (no drag)
    if (!_didDrag) {
      const hit = evToDistIdx(ev, cv)
      if (!hit) return

      // Step-aware click dispatch: trim mode
      if (ST.activeStep === 'trim') {
        actions.trimClick(hit.idx)
        return
      }

      // Default: select correction
      const ci = hitTestCorrection(hit.distM)
      actions.selectCorr(ci >= 0 ? ci : null)
      actions.drawAll()
    }
  })

  cv.addEventListener('mouseleave', () => {
    if (!ST.dragState) clearCursor()
  })

  cv.addEventListener('contextmenu', ev => {
    if (!ST.corrections || !ST.dists) return
    ev.preventDefault()
    const hit = evToDistIdx(ev, cv)
    if (!hit) return
    const ci = hitTestCorrection(hit.distM)
    if (ci >= 0) actions.removeCorr(ci)
  })

  cv.addEventListener('dblclick', ev => {
    if (!ST.dists) return
    ev.preventDefault()
    const hit = evToDistIdx(ev, cv)
    if (!hit) return
    const total = ST.dists[ST.dists.length - 1]
    if (total <= 0) return
    const center = hit.distM / total
    // Zoom to ~1km window (or half the route if shorter)
    const win = Math.min(0.5, 1000 / total)
    setView(Math.max(0, center - win / 2), Math.min(1, center + win / 2))
  })

  cv.addEventListener('wheel', ev => {
    if (!ST.dists) return
    ev.preventDefault()
    const rect = cv.getBoundingClientRect()
    const xFrac = (ev.clientX - rect.left - PAD.l) / (rect.width - PAD.l - PAD.r)
    const factor = ev.deltaY > 0 ? 1.25 : 0.8
    zoom(Math.max(0, Math.min(1, xFrac)), factor)
  }, { passive: false })
}
