/**
 * Lane split — turn a one-way "out" route into a dual-lane out-and-back.
 *
 * The original centreline is offset laterally to two parallel lanes (out leg on
 * one side, back leg on the other), joined at the far end by a U-turn/teardrop
 * turnaround. Inner corners are clamped to a minimum radius by cutting the
 * corner early (an inscribed fillet arc), so the inner lane never gets tighter
 * than the floor while the lanes stay parallel on straights.
 *
 * Pure: takes/returns `{ lats, lons, eles }`. No DOM, no ST. The caller rebuilds
 * distances/gradients afterwards (see setActiveRoute in main.js).
 */

import { haversine, cumulativeDistances, bearing } from './math.js'
import { filletCorner, circumscribedRadius3, findCornerClusters } from './geometry.js'

const M_PER_DEG_LAT = 111320

/** Metres-per-degree-longitude at a given latitude. */
function mPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180)
}

/**
 * Offset a polyline laterally by signed distance `h` (metres). Positive `h` is
 * to the LEFT of travel direction. Uses a per-vertex miter so offset segments
 * stay parallel to the originals; the miter is capped at sharp corners to avoid
 * spikes (those are cleaned up by the min-radius clamp afterwards).
 *
 * @param {number[]} lats @param {number[]} lons @param {number} h
 * @returns {{ lats:number[], lons:number[] }}
 */
export function offsetPolyline(lats, lons, h) {
  const n = lats.length
  const oLat = new Array(n), oLon = new Array(n)
  for (let i = 0; i < n; i++) {
    const mLon = mPerDegLon(lats[i])
    let inx = 0, iny = 0, outx = 0, outy = 0, hasIn = false, hasOut = false
    if (i > 0) {
      inx = (lons[i] - lons[i - 1]) * mLon; iny = (lats[i] - lats[i - 1]) * M_PER_DEG_LAT
      const l = Math.hypot(inx, iny) || 1; inx /= l; iny /= l; hasIn = true
    }
    if (i < n - 1) {
      outx = (lons[i + 1] - lons[i]) * mLon; outy = (lats[i + 1] - lats[i]) * M_PER_DEG_LAT
      const l = Math.hypot(outx, outy) || 1; outx /= l; outy /= l; hasOut = true
    }
    let mx, my // offset vector in metres
    if (hasIn && hasOut) {
      const ninx = -iny, niny = inx        // left normal of incoming dir
      const noutx = -outy, nouty = outx    // left normal of outgoing dir
      let bx = ninx + noutx, by = niny + nouty
      const bl = Math.hypot(bx, by)
      if (bl < 1e-6) { mx = ninx * h; my = niny * h }   // ~180° flip — degrade to one normal
      else {
        bx /= bl; by /= bl
        const dot = bx * ninx + by * niny               // = cos(half-turn)
        const scale = Math.abs(dot) > 0.25 ? h / dot : h / 0.25 * Math.sign(dot || 1) // cap miter
        mx = bx * scale; my = by * scale
      }
    } else if (hasOut) { mx = -outy * h; my = outx * h }
    else { mx = -iny * h; my = inx * h }
    oLat[i] = lats[i] + my / M_PER_DEG_LAT
    oLon[i] = lons[i] + mx / mPerDegLon(lats[i])
  }
  return { lats: oLat, lons: oLon }
}

/**
 * Clamp tight corners to a minimum radius by cutting the corner early — at each
 * interior vertex whose circumscribed radius is below `minRadiusM`, splice in an
 * inscribed fillet arc of that radius. Vertices already wide enough are left
 * untouched (so the outer lane keeps its natural, gentler corners).
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles
 * @param {number} minRadiusM
 * @param {number} [spacingM=0.4]
 * @returns {{ lats:number[], lons:number[], eles:number[] }}
 */
export function clampMinRadius(lats, lons, eles, minRadiusM, spacingM = 0.4) {
  const N = lats.length
  if (N < 3) return { lats: [...lats], lons: [...lons], eles: [...eles] }

  // Tight vertices: radius below the floor.
  const tight = []
  for (let i = 1; i < N - 1; i++) {
    if (circumscribedRadius3(lats, lons, i) < minRadiusM) tight.push(i)
  }
  if (tight.length === 0) return { lats: [...lats], lons: [...lons], eles: [...eles] }

  const outLats = [], outLons = [], outEles = []
  let prevEnd = 0
  for (const vi of tight) {
    if (vi <= prevEnd) continue
    const a = vi - 1, b = vi + 1
    if (b >= N) continue
    const fillet = filletCorner(lats[a], lons[a], lats[vi], lons[vi], lats[b], lons[b], minRadiusM, spacingM)
    if (!fillet || fillet.points.length < 2) continue
    for (let k = prevEnd; k <= a; k++) { outLats.push(lats[k]); outLons.push(lons[k]); outEles.push(eles[k]) }
    const arcN = fillet.points.length
    for (let k = 0; k < arcN; k++) {
      outLats.push(fillet.points[k].lat); outLons.push(fillet.points[k].lon)
      const f = arcN > 1 ? k / (arcN - 1) : 0.5
      outEles.push(eles[a] + f * (eles[b] - eles[a]))
    }
    prevEnd = b
  }
  for (let k = prevEnd; k < N; k++) { outLats.push(lats[k]); outLons.push(lons[k]); outEles.push(eles[k]) }
  return { lats: outLats, lons: outLons, eles: outEles }
}

/**
 * Widen tight centreline corners to a target radius by cutting the corner early
 * (a single inscribed arc tangent to the two straight legs). Done on the CENTRELINE
 * before offsetting so the two lanes come out as clean concentric (parallel) arcs
 * with no per-lane kinks; inner = targetR − halfGap, outer = targetR + halfGap.
 *
 * Corners already at/above targetR are left untouched. The fillet is clamped to
 * the available straight length on each side (best effort for short legs).
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles
 * @param {number} targetR @param {number} [spacingM=0.4]
 * @returns {{ lats:number[], lons:number[], eles:number[] }}
 */
export function widenCorners(lats, lons, eles, targetR, spacingM = 0.4) {
  const N = lats.length
  if (N < 5) return { lats: [...lats], lons: [...lons], eles: [...eles] }
  const lat0 = lats[Math.floor(N / 2)], mLon = mPerDegLon(lat0)
  const X = lons.map(lo => lo * mLon), Y = lats.map(la => la * M_PER_DEG_LAT)
  const toLL = (x, y) => ({ lat: y / M_PER_DEG_LAT, lon: x / mLon })
  const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l] }
  const turnDeg = (i) => {
    const ax = X[i - 1] - X[i], ay = Y[i - 1] - Y[i], bx = X[i + 1] - X[i], by = Y[i + 1] - Y[i]
    const ma = Math.hypot(ax, ay), mb = Math.hypot(bx, by)
    if (ma < 1e-9 || mb < 1e-9) return 0
    return 180 - Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (ma * mb)))) * 180 / Math.PI
  }
  const intersect = (p0, d0, p1, d1) => {
    const den = d0[0] * (-d1[1]) - d0[1] * (-d1[0])
    if (Math.abs(den) < 1e-9) return null
    const rx = p1[0] - p0[0], ry = p1[1] - p0[1]
    const t = (rx * (-d1[1]) - ry * (-d1[0])) / den
    return [p0[0] + t * d0[0], p0[1] + t * d0[1]]
  }

  const clusters = findCornerClusters(lats, lons, 25, 3, 60, 0)
  if (!clusters.length) return { lats: [...lats], lons: [...lons], eles: [...eles] }

  const oLat = [], oLon = [], oEle = []
  let prev = 0
  for (const c of clusters) {
    const s = c.startIdx, e = c.endIdx
    if (s <= prev + 1) continue
    let curR = Infinity
    for (let i = s; i <= e; i++) curR = Math.min(curR, circumscribedRadius3(lats, lons, i))
    if (curR >= targetR) continue
    // Extend into the straight legs on each side (collinear within 4°).
    let pi = s - 1; while (pi > prev + 1 && turnDeg(pi) <= 4) pi--
    let qi = e + 1; while (qi < N - 2 && turnDeg(qi) <= 4) qi++
    if (pi < 1 || qi > N - 2) continue
    const d1 = unit(X[s - 1] - X[pi], Y[s - 1] - Y[pi])   // incoming dir
    const d2 = unit(X[qi] - X[e + 1], Y[qi] - Y[e + 1])   // outgoing dir
    const ax = intersect([X[pi], Y[pi]], d1, [X[qi], Y[qi]], d2)
    if (!ax) continue
    const theta = Math.acos(Math.max(-1, Math.min(1, (-d1[0]) * d2[0] + (-d1[1]) * d2[1])))
    if (theta < 0.05 || theta > Math.PI - 0.05) continue
    const half = theta / 2
    let R = targetR, tan = R / Math.tan(half)
    const maxTan = Math.min(Math.hypot(ax[0] - X[pi], ax[1] - Y[pi]), Math.hypot(ax[0] - X[qi], ax[1] - Y[qi])) * 0.95
    if (tan > maxTan) { tan = maxTan; R = tan * Math.tan(half) }
    const t1 = [ax[0] - tan * d1[0], ax[1] - tan * d1[1]]
    const t2 = [ax[0] + tan * d2[0], ax[1] + tan * d2[1]]
    let bx = -d1[0] + d2[0], by = -d1[1] + d2[1]; const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl
    const cdist = R / Math.sin(half), cx = ax[0] + bx * cdist, cy = ax[1] + by * cdist
    const a1 = Math.atan2(t1[1] - cy, t1[0] - cx), a2 = Math.atan2(t2[1] - cy, t2[0] - cx)
    let sweep = a2 - a1; while (sweep > Math.PI) sweep -= 2 * Math.PI; while (sweep < -Math.PI) sweep += 2 * Math.PI
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) * R / spacingM))
    for (let k = prev; k <= pi; k++) { oLat.push(lats[k]); oLon.push(lons[k]); oEle.push(eles[k]) }
    let ll = toLL(t1[0], t1[1]); oLat.push(ll.lat); oLon.push(ll.lon); oEle.push(eles[pi])
    for (let k = 1; k < steps; k++) {
      const ang = a1 + sweep * k / steps
      ll = toLL(cx + R * Math.cos(ang), cy + R * Math.sin(ang))
      oLat.push(ll.lat); oLon.push(ll.lon); oEle.push(eles[pi] + (eles[qi] - eles[pi]) * k / steps)
    }
    ll = toLL(t2[0], t2[1]); oLat.push(ll.lat); oLon.push(ll.lon); oEle.push(eles[qi])
    prev = qi
  }
  for (let k = prev; k < N; k++) { oLat.push(lats[k]); oLon.push(lons[k]); oEle.push(eles[k]) }
  return { lats: oLat, lons: oLon, eles: oEle }
}

/**
 * Walk an exact circular arc from P with heading `theta`, signed curvature `k`
 * (= ±1/R, CCW positive) over length `L`. Appends points (excluding the start)
 * to `out` and returns the end state. No integration drift.
 */
function arcWalk(P, theta, k, L, out, spacing) {
  const cf = P.f - (1 / k) * Math.sin(theta)
  const cl = P.l + (1 / k) * Math.cos(theta)
  const steps = Math.max(1, Math.ceil(L / spacing))
  let end = { f: P.f, l: P.l, hdg: theta }
  for (let i = 1; i <= steps; i++) {
    const th2 = theta + k * (L * i / steps)
    const f = cf + (1 / k) * Math.sin(th2)
    const l = cl - (1 / k) * Math.cos(th2)
    out.push({ f, l }); end = { f, l, hdg: th2 }
  }
  return end
}

/**
 * Build a NON-crossing forward bulb turnaround in a local (forward, left) frame,
 * from (0, +d) heading +forward to (0, −d) heading −forward, radius R = max(d, minR).
 *
 * Construction: each lane bows gently OUTWARD (away from the centre) via an
 * S-easement of two radius-R arcs until the two ends are 2R apart, then a clean
 * forward semicircle of radius R joins them. Every arc has radius exactly R and
 * the path never crosses itself. Degrades to a plain semicircle when d = R.
 *
 * @param {number} d — half the lane gap @param {number} minR — minimum turn radius
 * @returns {Array<{f:number, l:number}>} points from start to end (inclusive)
 */
function bulbFL(d, minR) {
  const R = Math.max(d, minR)
  const spacing = Math.max(0.25, R / 24)
  // S-easement: shift outward by (R − d) over two opposite arcs of angle β each.
  // Lateral shift of a 2-arc S = 2R(1 − cos β) ⇒ cos β = (R + d) / (2R).
  const beta = Math.acos(Math.min(1, Math.max(-1, (R + d) / (2 * R))))

  const pts = [{ f: 0, l: d }]
  let P = { f: 0, l: d }
  // Out-lane S: bow toward +l (CCW then CW), ending at (xf, +R) heading +forward.
  let e = arcWalk(P, 0, 1 / R, beta * R, pts, spacing)
  e = arcWalk(e, e.hdg, -1 / R, beta * R, pts, spacing)
  // Forward semicircle (CW) from (xf, +R) to (xf, −R), bulging +forward.
  e = arcWalk(e, e.hdg, -1 / R, Math.PI * R, pts, spacing)
  // Back-lane S (mirror): ease from (xf, −R) back toward the axis to (0, −d).
  e = arcWalk(e, e.hdg, -1 / R, beta * R, pts, spacing)
  e = arcWalk(e, e.hdg, 1 / R, beta * R, pts, spacing)
  return pts
}

/**
 * Build a turnaround connecting the out-lane end to the back-lane start as a
 * non-crossing forward bulb of radius max(half-gap, minR) (see {@link bulbFL}).
 * Returns INTERIOR points only (excludes the two given endpoints) as lat/lon.
 *
 * @param {{lat,lon}} eOut — out-lane end @param {{lat,lon}} eBack — back-lane start
 * @param {{lat,lon}} pEnd — centreline end (frame origin)
 * @param {[number,number]} fwd — forward unit dir (metres, [east,north]) at the end
 * @param {number} minR
 * @returns {Array<{lat:number, lon:number}>}
 */
export function buildTurnaround(eOut, eBack, pEnd, fwd, minR) {
  const mLon = mPerDegLon(pEnd.lat)
  const toLL = (x, y) => ({ lat: pEnd.lat + y / M_PER_DEG_LAT, lon: pEnd.lon + x / mLon })
  const toXY = (p) => [ (p.lon - pEnd.lon) * mLon, (p.lat - pEnd.lat) * M_PER_DEG_LAT ]

  // Frame: forward = fwd, left = rot90(fwd)
  const fx = fwd[0], fy = fwd[1]
  const lx = -fy, ly = fx
  const proj = (p) => { const [x, y] = toXY(p); return { f: x * fx + y * fy, l: x * lx + y * ly } }
  const fromFL = (f, l) => toLL(f * fx + l * lx, f * fy + l * ly)

  const a = proj(eOut), b = proj(eBack)
  const d = Math.hypot(a.f - b.f, a.l - b.l) / 2
  const midF = (a.f + b.f) / 2
  const sideSign = Math.sign(a.l - b.l) || 1   // which side the out lane sits

  const bulb = bulbFL(d, minR)                 // canonical (0,+d) → (0,−d)
  const pts = []
  for (let i = 1; i < bulb.length - 1; i++) {
    pts.push({ f: midF + bulb[i].f, l: sideSign * bulb[i].l })
  }
  return pts.map(p => fromFL(p.f, p.l))
}

/**
 * Offset a sub-range of a route laterally to one side (a "divided section"):
 * the route stays one continuous pass but the selected stretch is shifted by
 * `signedGap` metres (positive = left of travel) and bows out/back. The caller
 * blends the two joints (returned as seamLo/seamHi) to smooth the rejoin.
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles
 * @param {number} alo @param {number} ahi — inclusive selection range
 * @param {number} signedGap — lateral offset (m), + = left of travel
 * @returns {{ lats:number[], lons:number[], eles:number[], seamLo:number, seamHi:number }}
 */
export function offsetSection(lats, lons, eles, alo, ahi, signedGap) {
  const lo = Math.max(0, Math.min(alo, ahi))
  const hi = Math.min(lats.length - 1, Math.max(alo, ahi))
  const off = offsetPolyline(lats.slice(lo, hi + 1), lons.slice(lo, hi + 1), signedGap)
  const outLats = [...lats.slice(0, lo), ...off.lats, ...lats.slice(hi + 1)]
  const outLons = [...lons.slice(0, lo), ...off.lons, ...lons.slice(hi + 1)]
  return { lats: outLats, lons: outLons, eles: [...eles], seamLo: lo, seamHi: lo + off.lats.length }
}

/**
 * Separate an out/back overlap into two lanes, using the user's selection as the
 * EXACT segment to split. The selected range [alo, ahi] is one pass; its matching
 * opposite pass is found by where the route comes nearest to the selection's two
 * endpoints (a single nearest-point search per endpoint — no global threshold,
 * clustering, or direction gate). The selected pass and the matched pass are then
 * offset to opposite sides, pulling them `gapM` apart. The four joints (in `seams`)
 * are blended by the caller.
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles
 * @param {number} alo @param {number} ahi — inclusive selection range (the segment)
 * @param {number} gapM @param {'right'|'left'} side
 * @param {{ maxMatchM?:number }} [opts]
 * @returns {{ lats:number[], lons:number[], eles:number[], seams:number[], sepM:number } | null}
 *   null when the selection's endpoints have no matching opposite pass.
 */
export function separateOverlap(lats, lons, eles, alo, ahi, gapM, side, opts = {}) {
  const N = lats.length
  const lo = Math.max(0, Math.min(alo, ahi)), hi = Math.min(N - 1, Math.max(alo, ahi))
  if (hi - lo < 3) return null
  const maxMatchM = opts.maxMatchM ?? 40          // sanity: endpoints must lie on an overlapping pass
  const distMargin = opts.distMargin ?? 15        // skip same-pass neighbours just outside the selection (m)
  const dists = cumulativeDistances(lats, lons)
  const brg = (i) => bearing(lats[Math.max(0, i - 1)], lons[Math.max(0, i - 1)], lats[Math.min(N - 1, i + 1)], lons[Math.min(N - 1, i + 1)])

  // Nearest route point to `idx` that is the OTHER pass: skip the selection itself and
  // skip a near-in-route-distance neighbour ONLY when it heads the same way (the same
  // pass continuing). A near point heading the opposite way is the matching pass at a
  // turnaround — keep it (needed so the teardrop can attach at the apex).
  const nearestOther = (idx) => {
    let bj = -1, bd = Infinity
    const bi = brg(idx)
    for (let j = 0; j < N; j++) {
      if (j >= lo && j <= hi) continue
      if (Math.abs(dists[j] - dists[idx]) < distMargin) {
        const dd = Math.abs((((bi - brg(j)) + 540) % 360) - 180) // 180 = antiparallel, 0 = same heading
        if (dd < 90) continue   // same-ish heading & close in route-distance → same-pass continuation
      }
      const d = haversine(lats[idx], lons[idx], lats[j], lons[j])
      if (d < bd) { bd = d; bj = j }
    }
    return { idx: bj, dist: bd }
  }
  const mLo = nearestOther(lo), mHi = nearestOther(hi)
  if (mLo.idx < 0 || mHi.idx < 0 || mLo.dist > maxMatchM || mHi.dist > maxMatchM) return null
  const bLo = Math.min(mLo.idx, mHi.idx), bHi = Math.max(mLo.idx, mHi.idx)
  if (bHi - bLo < 3 || !(hi < bLo || bHi < lo)) return null   // matched range valid & disjoint

  const h = gapM / 2
  const mergeThreshM = opts.mergeThreshM ?? Math.max(3 * gapM, 12) // close lane-ends → join with a teardrop
  const minR = opts.turnMinR ?? 6

  // Offset the selection and the matched range. The split direction is auto-picked
  // (whichever sign separates the passes more), but the user's `side` toggle FLIPS
  // it so the user can force the other way on the ones auto gets wrong.
  const build = (sign) => ({
    s1: offsetPolyline(lats.slice(lo, hi + 1), lons.slice(lo, hi + 1), sign * h),
    s2: offsetPolyline(lats.slice(bLo, bHi + 1), lons.slice(bLo, bHi + 1), sign * h),
  })
  const sepOf = (b) => {
    let sum = 0, c = 0
    const step = Math.max(1, Math.floor(b.s1.lats.length / 8))
    for (let i = 0; i < b.s1.lats.length; i += step) {
      let best = Infinity
      for (let j = 0; j < b.s2.lats.length; j++) best = Math.min(best, haversine(b.s1.lats[i], b.s1.lons[i], b.s2.lats[j], b.s2.lons[j]))
      sum += best; c++
    }
    return c ? sum / c : 0
  }
  const autoSign = sepOf(build(1)) >= sepOf(build(-1)) ? 1 : -1
  const sign = side === 'left' ? -autoSign : autoSign   // toggle flips the auto choice
  const sel = build(sign)
  const off1 = sel.s1, off2 = sel.s2

  // Order the two offset lanes by index: earlier (E) then later (L). The gap between
  // E.end and L.start is the apex/turnaround region; E.start and L.end are the outer
  // ends. selection is [lo,hi], matched is [bLo,bHi]; they are disjoint.
  let E, eLo, eHi, L, lLo, lHi
  if (hi < bLo) { E = off1; eLo = lo; eHi = hi; L = off2; lLo = bLo; lHi = bHi }
  else { E = off2; eLo = bLo; eHi = bHi; L = off1; lLo = lo; lHi = hi }

  const ptOf = (lane, i) => ({ lat: lane.lats[i], lon: lane.lons[i] })
  const fwdOf = (lane, i, dir) => {
    const j = dir > 0 ? i : i - 1, k = dir > 0 ? i + 1 : i
    const mLon = mPerDegLon(lane.lats[i])
    let dx = (lane.lons[k] - lane.lons[j]) * mLon, dy = (lane.lats[k] - lane.lats[j]) * M_PER_DEG_LAT
    const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]
  }

  const oLat = [], oLon = [], oEle = []
  const seams = []
  const push = (la, lo2, el) => { oLat.push(la); oLon.push(lo2); oEle.push(el) }

  // [0 .. eLo-1] original
  for (let k = 0; k < eLo; k++) push(lats[k], lons[k], eles[k])
  if (eLo > 0) seams.push(oLat.length)            // joint: original → E lane
  // E lane (offset)
  for (let i = 0; i < E.lats.length; i++) push(E.lats[i], E.lons[i], eles[eLo + i])

  // Apex connector between E.end and L.start. Only a teardrop when the connecting
  // region is short (a real turnaround where the passes reverse end-to-end) — not a
  // long mid-road stretch (where the selection just ended and the route continues).
  const turnLenM = opts.turnLenM ?? Math.max(6 * gapM, 25)
  const apexLenM = dists[lLo] - dists[eHi]
  const apexSep = haversine(E.lats.at(-1), E.lons.at(-1), L.lats[0], L.lons[0])
  let apexMerged = false
  if (apexLenM < turnLenM && apexSep < mergeThreshM) {
    const pEnd = { lat: lats[eHi], lon: lons[eHi] }
    const fwd = fwdOf(E, E.lats.length - 1, -1)    // heading into the apex
    const tear = buildTurnaround({ lat: E.lats.at(-1), lon: E.lons.at(-1) }, { lat: L.lats[0], lon: L.lons[0] }, pEnd, fwd, minR)
    const e0 = eles[eHi], e1 = eles[lLo]
    tear.forEach((p, i) => push(p.lat, p.lon, e0 + (e1 - e0) * (tear.length > 1 ? i / (tear.length - 1) : 0)))
    apexMerged = true
  } else {
    seams.push(oLat.length - 1)                    // blend joint at E.end
    for (let k = eHi + 1; k < lLo; k++) push(lats[k], lons[k], eles[k])  // keep original apex region
    seams.push(oLat.length)                        // blend joint at L.start
  }

  // L lane (offset)
  for (let i = 0; i < L.lats.length; i++) push(L.lats[i], L.lons[i], eles[lLo + i])
  if (lHi < N - 1) seams.push(oLat.length)         // joint: L lane → original
  // [lHi+1 .. N-1] original
  for (let k = lHi + 1; k < N; k++) push(lats[k], lons[k], eles[k])

  // Outer (start/finish) loop: only when the section reaches both route ends and the
  // two outer lane-ends are close — then close it into a loop with a teardrop.
  let loopClosed = false
  if (eLo === 0 && lHi === N - 1) {
    const outerSep = haversine(E.lats[0], E.lons[0], L.lats.at(-1), L.lons.at(-1))
    if (outerSep < mergeThreshM) {
      const pEnd = { lat: lats[0], lon: lons[0] }
      const fwd = fwdOf(L, L.lats.length - 1, -1)   // heading into the finish
      const tear = buildTurnaround({ lat: L.lats.at(-1), lon: L.lons.at(-1) }, { lat: E.lats[0], lon: E.lons[0] }, pEnd, fwd, minR)
      const e0 = oEle[oEle.length - 1], e1 = oEle[0]
      tear.forEach((p, i) => push(p.lat, p.lon, e0 + (e1 - e0) * (tear.length > 1 ? i / (tear.length - 1) : 0)))
      loopClosed = true
    }
  }

  return { lats: oLat, lons: oLon, eles: oEle, seams, sepM: sepOf(sel), apexMerged, loopClosed }
}

/**
 * UNIFY an out/back (or multi-lap) overlap — the INVERSE of separateOverlap.
 *
 * The user selects ONE pass over a shared road `[alo, ahi]`. We find the matching
 * opposite pass with the SAME endpoint-matching as separateOverlap, then REPLACE that
 * matched pass with the selected (authority) pass's EXACT vertices — reversed for an
 * out-and-back, forward for a same-direction lap. The two passes then share ONE vertex
 * set (bit-identical XY + Z), so BikeTerra renders a single road, not two.
 *
 * Crucially this is NOT a resample-onto-the-other-pass's-positions: that would leave
 * two *different* vertex sets lying on the same line, which BikeTerra still renders as
 * two roads. Vertex identity is the whole point — same points, reversed.
 *
 * This is "constructed identity, not detected identity": the user supplies the one
 * fact the auto-detectors could never reliably infer — *which two ranges are the same
 * road* — and the result is exact, threshold-free. NOT length-preserving: the matched
 * pass takes the authority's point count (the splice shifts later indices).
 *
 * @param {number[]} lats @param {number[]} lons @param {number[]} eles
 * @param {number} alo @param {number} ahi — inclusive selection (authority pass)
 * @param {{ maxMatchM?:number, distMargin?:number }} [opts]
 * @returns {{ lats:number[], lons:number[], eles:number[], seams:number[],
 *            bLo:number, bHi:number, reversed:boolean } | null}
 *   null when the selection's endpoints have no matching opposite pass.
 *   bLo/bHi are the matched range in the ORIGINAL indices; the spliced replacement
 *   occupies [seams[0]..seams[1]-1] in the output.
 */
export function unifyOverlap(lats, lons, eles, alo, ahi, opts = {}) {
  const N = lats.length
  const lo = Math.max(0, Math.min(alo, ahi)), hi = Math.min(N - 1, Math.max(alo, ahi))
  if (hi - lo < 3) return null
  const maxMatchM = opts.maxMatchM ?? 40
  const distMargin = opts.distMargin ?? 15
  const dists = cumulativeDistances(lats, lons)
  const brg = (i) => bearing(lats[Math.max(0, i - 1)], lons[Math.max(0, i - 1)], lats[Math.min(N - 1, i + 1)], lons[Math.min(N - 1, i + 1)])

  // Same matching as separateOverlap: nearest OTHER-pass point to each selection
  // endpoint, skipping the selection itself and a same-heading near neighbour.
  const nearestOther = (idx) => {
    let bj = -1, bd = Infinity
    const bi = brg(idx)
    for (let j = 0; j < N; j++) {
      if (j >= lo && j <= hi) continue
      if (Math.abs(dists[j] - dists[idx]) < distMargin) {
        const dd = Math.abs((((bi - brg(j)) + 540) % 360) - 180)
        if (dd < 90) continue
      }
      const d = haversine(lats[idx], lons[idx], lats[j], lons[j])
      if (d < bd) { bd = d; bj = j }
    }
    return { idx: bj, dist: bd }
  }
  const mLo = nearestOther(lo), mHi = nearestOther(hi)
  if (mLo.idx < 0 || mHi.idx < 0 || mLo.dist > maxMatchM || mHi.dist > maxMatchM) return null
  const bLo = Math.min(mLo.idx, mHi.idx), bHi = Math.max(mLo.idx, mHi.idx)
  if (bHi - bLo < 3 || !(hi < bLo || bHi < lo)) return null
  // Orientation: if A's START matched the HIGHER-index end of B, B runs opposite to A
  // (the classic out-and-back return). Otherwise B is a same-direction repeat (lap).
  const reversed = mLo.idx > mHi.idx

  // Build the replacement = the authority pass's EXACT vertices (reversed for an
  // out-and-back, forward for a same-direction lap). This is the key: we do NOT
  // resample onto B's positions (that leaves two different vertex sets = two roads
  // to BikeTerra). We REPLACE the matched pass with A's identical points, so the two
  // passes share one vertex set and render as a single road.
  const repLat = [], repLon = [], repEle = []
  if (reversed) {
    for (let i = hi; i >= lo; i--) { repLat.push(lats[i]); repLon.push(lons[i]); repEle.push(eles[i]) }
  } else {
    for (let i = lo; i <= hi; i++) { repLat.push(lats[i]); repLon.push(lons[i]); repEle.push(eles[i]) }
  }

  // Splice the replacement over [bLo..bHi] (index loops, not push(...spread), to avoid
  // the call-stack overflow on long routes — see CLAUDE gotcha #17). The authority pass
  // [lo..hi] lies outside [bLo..bHi] (disjoint, asserted above) so it is preserved.
  const outLats = [], outLons = [], outEles = []
  for (let i = 0; i < bLo; i++) { outLats.push(lats[i]); outLons.push(lons[i]); outEles.push(eles[i]) }
  for (let i = 0; i < repLat.length; i++) { outLats.push(repLat[i]); outLons.push(repLon[i]); outEles.push(repEle[i]) }
  for (let i = bHi + 1; i < N; i++) { outLats.push(lats[i]); outLons.push(lons[i]); outEles.push(eles[i]) }

  // Joints where the replaced pass meets the surrounding route.
  const seams = [bLo, bLo + repLat.length]
  return { lats: outLats, lons: outLons, eles: outEles, seams, bLo, bHi, reversed }
}

/**
 * Split a one-way route into a dual-lane out-and-back.
 *
 * @param {{lats:number[], lons:number[], eles:number[]}} route — centreline (out leg)
 * @param {{ gapM?:number, minRadiusM?:number, turnaroundMinRadiusM?:number, side?:'right'|'left' }} [opts]
 * @returns {{ lats:number[], lons:number[], eles:number[], gapM:number, turnRadiusM:number }}
 */
export function laneSplit(route, opts = {}) {
  const gapM = opts.gapM ?? 4
  const minRadiusM = opts.minRadiusM ?? 6
  const turnMinR = opts.turnaroundMinRadiusM ?? 6
  const side = opts.side ?? 'right'
  const h = gapM / 2
  const sgn = side === 'right' ? -1 : 1   // out lane: right of travel = negative (left+) offset

  // Widen the CENTRELINE corners to (minInner + halfGap) so that offsetting gives
  // two clean concentric (parallel) lanes — inner = minInner, outer = inner + gap —
  // with no per-lane kinks. Corners already wide enough are untouched.
  const cl = widenCorners(route.lats, route.lons, [...route.eles], minRadiusM + h)

  // Out lane (offset to chosen side) and back lane (offset to the other side, reversed).
  const out = offsetPolyline(cl.lats, cl.lons, sgn * h)
  out.eles = [...cl.eles]
  const back = offsetPolyline(cl.lats, cl.lons, -sgn * h)
  back.eles = [...cl.eles]
  back.lats.reverse(); back.lons.reverse(); back.eles.reverse()

  // Forward direction at the centreline end (for the turnaround frame).
  const n = cl.lats.length
  const mLon = mPerDegLon(cl.lats[n - 1])
  let fdx = (cl.lons[n - 1] - cl.lons[n - 2]) * mLon
  let fdy = (cl.lats[n - 1] - cl.lats[n - 2]) * M_PER_DEG_LAT
  const fl = Math.hypot(fdx, fdy) || 1; fdx /= fl; fdy /= fl

  const eOut = { lat: out.lats.at(-1), lon: out.lons.at(-1) }
  const eBack = { lat: back.lats[0], lon: back.lons[0] }
  const pEnd = { lat: cl.lats[n - 1], lon: cl.lons[n - 1] }
  const turn = buildTurnaround(eOut, eBack, pEnd, [fdx, fdy], turnMinR)

  const turnRadiusM = Math.max(h, turnMinR)
  const eleEnd = out.eles.at(-1), eleBack = back.eles[0]
  const turnEles = turn.map((_, i) => eleEnd + (eleBack - eleEnd) * (turn.length > 1 ? i / (turn.length - 1) : 0))

  const lats = [...out.lats, ...turn.map(p => p.lat), ...back.lats]
  const lons = [...out.lons, ...turn.map(p => p.lon), ...back.lons]
  const eles = [...out.eles, ...turnEles, ...back.eles]

  return { lats, lons, eles, gapM, turnRadiusM }
}
