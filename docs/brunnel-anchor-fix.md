# Brunnel Anchor & Classification Fix

## Problem

When a bridge is fetched from OSM, the reported bridge boundaries often fall
**inside** the LIDAR elevation artifact. The LIDAR artifact extends beyond the
actual bridge structure because the sensor loses lock approaching the bridge
portal and doesn't recover until some distance after.

This means the cleaner places correction anchors on corrupted elevation data,
leaving the LIDAR artifact partially uncorrected — the cleaned profile still
shows the characteristic dip/spike at the bridge edges.

## Root Cause (3 issues)

### 1. Anchor search direction and index offset

The old `expandAnchorLo` / `expandAnchorHi` functions started their search
**at** the OSM boundary index and returned the boundary itself if the gradient
there was already below threshold. The prototype starts one index **outside**
the boundary (`b.alo - 1` for lo, `b.ahi` for hi) and returns that outer
index, guaranteeing the anchor sits on clean approach road, not on the
artifact edge.

**Before:**
```js
// expandAnchorLo started at idx, could return idx itself
for (let i = idx; i > 0; i--) { ... if (gr < threshold) return i }
```

**After (matching prototype):**
```js
// Start outside the OSM boundary, search outward
let alo = b.alo
for (let i = b.alo - 1; i >= 0; i--) {
  if (Math.abs(grRaw[i]) < anchorT) { alo = i; break }
}
```

### 2. Classification function mismatch

The old code used `classifyBrunnel` (from `2-brunnels.js`) which checks
`dipBelow > spikeAbove` to decide bridge vs tunnel. When a LIDAR artifact
has noise spikes above the anchor level (common with bridges), this check
can fail: `spikeAbove > dipBelow`, causing the bridge to be misclassified
as `'clean'` with interpolation `'none'` — no correction applied at all.

The prototype uses `classifyStructure` (from `3-clean.js`) which has a
different priority model:

```js
const isBridge = dipBelow >= bridgeDip    // bridgeDip=0 → always true
const isTunnel = spikeAbove >= tunnelSpk && !isBridge  // bridge wins
```

With `bridgeDip: 0` for OSM-declared bridges, `isBridge` is always `true`,
and `isTunnel` requires `!isBridge` so it can never fire. The bridge
classification is guaranteed regardless of spike noise in the zone.

Additionally, `classifyStructure` returns finer-grained type labels:
- `'ramp'` — uniform (linear) interpolation
- `'bridge'` — Hermite convex interpolation
- `'bridge_sag'` — Hermite concave interpolation

And the matching `applyInterp` function (also from `3-clean.js`) handles
all interpolation types including `hermite_convex` and `hermite_concave`,
which the old `applyBrunnelInterp` did not distinguish.

### 3. Redundant second pass on LIDAR-cleaned data

The code had a second `buildBrunnelCorrections` call that re-ran anchor
search on `ST.eleClean` (after LIDAR cleaning). This is exactly the bug
discovered in prototype commit `83204ee`:

> "OSM brunnel correction is now a pre-pass on raw gradient"

The LIDAR cleaner changes the elevation profile, so re-running anchor search
on cleaned data finds different (wrong) anchors. For long tunnels this is
especially bad — the LIDAR cleaner may partially smooth the tunnel interior,
moving the gradient transition point and causing the second pass to anchor
at the wrong location.

The fix: run brunnel corrections **once** as a pre-pass on raw elevations.
The LIDAR cleaner then runs on the pre-cleaned data. Since brunnel zones are
already smooth (interpolated), the LIDAR cleaner finds no spikes there and
leaves them untouched.

## Changes

### `src/pipeline/2-brunnels.js`

- **Import** `grads` from `utils/math.js` and `classifyStructure`, `applyInterp`
  from `3-clean.js`
- **Rewrite** `buildBrunnelCorrections`:
  - Add `anchorT` parameter (default 25%) for gradient threshold
  - Compute raw gradients once with `grads(eles, dists)`
  - Anchor search matches prototype: starts outside OSM boundary, searches
    outward on raw gradient
  - Uses `classifyStructure` instead of `classifyBrunnel` for classification
  - Uses `applyInterp` instead of `applyBrunnelInterp` for interpolation
  - Biases classification toward OSM-declared type by setting `bridgeDip: 0`
    for bridges and `tunnelSpk: 0` for tunnels
- **Remove** `expandAnchorLo`, `expandAnchorHi`, `applyBrunnelInterp`
  (replaced by inline anchor search and shared `applyInterp`)

### `src/main.js`

- **Clean Run handler**: passes `det.anchorT` to `buildBrunnelCorrections`
- **Brunnels btnGo handler**: passes `detParams.anchorT` to
  `buildBrunnelCorrections`
- **Remove second pass**: deleted the redundant `buildBrunnelCorrections`
  call on `ST.eleClean` that re-ran after LIDAR cleaning

### `tests/unit/brunnels.test.js`

- Update bridge correction type assertion to accept any bridge-family type
  (`'ramp'`, `'bridge'`, `'bridge_sag'`) since `classifyStructure` returns
  finer-grained labels than `classifyBrunnel`

## Prototype Reference

Key prototype commits that informed this fix:

| Commit | Description | Outcome |
|--------|-------------|---------|
| `5137616` | Post-pass after LIDAR | Failed |
| `930f95f` | Outward anchor on LIDAR-cleaned gradient | Failed for long tunnels |
| `c33e329` | Purely additive gap-fill | Partial |
| `e7863d4` | Raw portal anchors, full-span skip | Intermediate |
| `83204ee` | **Pre-pass on raw gradient** | **Final solution** |

---

## Follow-up: Force Hermite for bridges on monotonic terrain

### Problem

After the classification fix above, a second issue emerged: bridges on overall
uphill (or downhill) roads still got straight-line (uniform) interpolation
instead of following the road's natural curve over the highway.

`classifyStructure` computes approach slopes from exterior gradient windows:

```
m_in  = average gradient BEFORE the bridge zone
m_out = average gradient AFTER the bridge zone
```

It selects Hermite convex only when `m_in > 0 && m_out < 0` (road goes up
then down — classic hill). But on a climbing road where a bridge crosses a
highway, both slopes are positive (e.g., m_in=+5%, m_out=+3%). The sign
check fails and interpolation falls back to uniform (straight ramp).

This is a pre-existing limitation — the prototype at line 1280 has the
identical sign check and the same bug.

### Key Insight

The computed m0/m1 slopes are still meaningful even when the sign check
rejects Hermite. A Hermite curve with m0=+5%, m1=+3% correctly produces
a convex shape: steeper approach transitioning to gentler departure. This
matches the actual road profile over a highway bridge on a climb.

On flat terrain (m0≈0, m1≈0), Hermite ≈ linear, so there's no regression.

### Fix

In `buildBrunnelCorrections`, after the `classifyStructure` call, force
Hermite interpolation for OSM-declared bridges that got uniform fallback:

```js
if (b.type === 'bridge' && struct.interp === 'uniform' && struct.type !== 'tunnel') {
  struct.interp = 'hermite_convex'
  struct.type = 'bridge'
}
```

This is safe because:
- We **know** it's a bridge (OSM tags) — no risk of misclassification
- Tunnels are unaffected (guarded by `b.type === 'bridge'`)
- LIDAR detection in the Clean step is unaffected (change is only in
  `buildBrunnelCorrections`)

## Verification

- All 402 tests pass
- Bridge corrections extend to cover the full LIDAR artifact
- Anchor placement matches the prototype behavior
- Bridges on monotonic terrain now use curved Hermite interpolation

---

## Follow-up: Preserve OSM Tunnel Label In Corrections Panel

### Problem

OSM-declared tunnels occasionally appeared as `ramp` in the corrections panel.
This happened when shape classification inside `buildBrunnelCorrections` picked
`ramp`/bridge-family based on local profile shape.

### Fix

In `src/pipeline/2-brunnels.js`, correction labeling now preserves OSM tunnel
identity:

```js
const correctionType = b.type === 'tunnel' ? 'tunnel' : struct.type
```

Interpolation still uses the computed `struct.interp`, so smoothing behavior is
unchanged; only the displayed correction type is stabilized for OSM tunnels.

### Regression Test

`tests/unit/brunnels.test.js` now includes:
- `keeps OSM tunnel label even when shape classifier prefers ramp/bridge`
