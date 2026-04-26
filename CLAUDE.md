# CLAUDE.md — GPXForge

## What is GPXForge?

GPXForge is a browser-based GPX route processing tool for cycling. It takes raw GPX files and runs them through a 6-step pipeline: **Trim → Road Snap → Brunnels → Clean → Smooth → Split**. The result is a cleaned, road-snapped, elevation-corrected route with physics-based ride time predictions and downloadable split files.

Single user, single contributor. Built for Chrome and Edge.

---

## Current State

**Active development** is in `C:\Users\Mitja\gpxforge-v2\` (this repo).

The **prototype** lives at `C:\Users\Mitja\gpxforge\` — a single ~5200-line HTML file (`gpx_cleaner_v4_148.html`). Use it as a visual reference for behaviour comparison, but do not modify it.

### Recent Changes (2026-04-25) — v0.2.0

- **v0.2.0** — Unified UX + Batch Queue UX hardening (Phases 8r + 8s complete)
- Queue UX hardening: full-snapshot save-back on Load switch (snap/trim/smooth/split edits no longer lost), Park button works while reviewing a queue entry (converts to parked in-place), Resume/Load buttons always clickable with alert when blocked, active queue entry highlighted (amber), Download All includes parked entries and flushes pending edits, upload button label resets when queue stops processing, Place search dropdown navigates immediately on click. Plus dead-code sweep (removed `showOutput`/`hideOutput` no-op stubs from panels.js, unused `saveBack`/`markDone` from batch-pipeline).
- `5f5726a` Unified UX refactor (Phases 1–5 + landing): merged unified-ux branch. Simple/Expert toggle pill, park-to-queue (snapshot/restore ST), auto-dismiss on download, count-based upload routing, auto-pipeline on file load in simple mode, map-first landing for both modes, CSS mode gating.
- `117c58c` Batch queue — multi-file GPX (or zip) upload. 2+ files route to a queue panel that runs brunnels → LIDAR → auto-clean in the background. Each entry loadable for review, with eleClean + corrections saved back on switch. Bulk zip download. Load buttons disabled when a non-queue route is active. `src/modes/batch-pipeline.js` (new), `src/ui/batch-ui.js` (new), `shell.js`, `main.js`, `layout.css`, `steps.css`.

### Phase Progress

| Phase | Description | Status |
|-------|-------------|--------|
| 1–5 | Utils, State, API clients, Pipeline math | ✅ Complete |
| 6 | Chart system + view sync infrastructure | ✅ Complete (82 tests, 5,522 lines) |
| 7 | Map (Leaflet, subscribes to sync.js) | ✅ Complete (98 tests) |
| 8a | UI shell (layout, file loading, toolbar, undo/redo, download) | ✅ Complete (121 tests) |
| 8a-fix | Map rendering fix + rotatable focus layout (CSS grid) | ✅ Complete (121 tests) |
| 8b | Step toolbar framework + step navigation | ✅ Complete (145 tests) |
| 8c | Step panels + sidebar→toolbar refactor (all 6 panels inline) | ✅ Complete (198 tests) |
| 8d-1 | Clean + Smooth wiring, corrections panel, chart/map actions | ✅ Complete (272 tests) |
| 8d-1+ | processGPX-js integration (full auto pipeline replaces smooth) | ✅ Complete (272 tests) |
| 8d-2 | Brunnels + Trim + Snap + Split wiring | ✅ Complete (375 tests) |
| 8e | UX: move step results from toolbar to info panel | ✅ Complete (370 tests) |
| 8f | Smooth overlay mode, step-aware hover, persistent artifacts | ✅ Complete (370 tests) |
| 8g | Gradient averaging + fillet corner rounding for tight hairpins | ✅ Complete (419 tests) |
| 8h | Display fixes: proportional distance mapping + smoothed map route | ✅ Complete (402 tests) |
| 8i | UI polish: clickable brunnels, resize handle, snap arrows, chart dblclick zoom | ✅ Complete (402 tests) |
| 8j | Valhalla routing + snap deviation detection + car/bike profile selector | ✅ Complete (450 tests) |
| 8k | Split downloads use smoothed route + LIDAR toolbar button + remove U-turn loops | ✅ Complete |
| 8l | Route Builder mode — create routes from scratch by clicking waypoints on the map | ✅ Complete |
| 8m | Cleaner brunnel-aware labelling + LIDAR densification + overlap detection | ✅ Complete |
| 8n | Simple mode — one-click pipeline UI + auto-pipeline orchestrator | ✅ Complete |
| 8o | Place search (Nominatim), builder mode/profile/clear in simple mode | ✅ Complete |
| 8p | Valhalla costing flags: `ignore_oneways` + `ignore_restrictions` default ON, expert toggles, localStorage persist | ✅ Complete |
| 8q | Pedestrian / Hiking routing profile — Valhalla pedestrian with 5.1 km/h + 100 km max_distance | ✅ Complete |
| 8r | Batch queue — multi-file / zip upload, background pipeline, queue panel, bulk download | ✅ Complete |
| 8s | Unified UX: Simple/Expert modes in one shell, park-to-queue, map-first landing, CSS mode gating | ✅ Complete (512 tests) |
| 9+ | 3D view, additional features | ⬜ Future |

**Detailed plan file:** `C:\Users\Mitja\.claude\plans\staged-churning-seal.md`

---

## Prototype Reference (GitHub)

The working prototype lives on GitHub at:
**`https://github.com/ngarohe/gpxforge/commits/claude/stoic-nobel/`**

This branch has **42 commits** building a fully functional monolithic HTML file with all 6 pipeline steps working — interactive map routing, corrections panel, waypoint dragging, physics-based timing, and GPX export.

### Usage Rules

- **Reference for ideas and behaviour, NOT for copy-paste** — the wiring in the prototype has issues
- When implementing a feature, check the prototype commits for expected behaviour and UI patterns
- Ask about any prototype commit when planning implementation

### Key UI Insight: Toolbar-Based Step Controls

The prototype evolved from sidebar-based controls to **all step controls in the top toolbar**:
- Each step's controls (buttons, inputs, toggles) appear inline in the toolbar when that step is active
- If a step needs more space, the toolbar **expands to a second row**
- The sidebar auto-hides when controls are in the toolbar
- This approach keeps the chart/map area maximally large

**This is the preferred approach for v2** — step controls should live in the toolbar, not in sidebar panels.

### Key Commits to Reference

| Commit | Description |
|--------|-------------|
| `ab1d2a6` | All step controls move to tab bar, sidebar auto-hide removed |
| `aad8abb` | Snap controls move to tab bar, matching trim layout |
| `415fc70` | Unified undo/redo + trim controls move to tab bar |
| `68dd7b3` | Sticky Download All Stages button in split results |
| `229f6dc` | Four UX improvements across tools |
| `a72fed9` | Stadia/Valhalla routing with profile selector |
| `b275ba5` | Route waypoint markers with numbers + direction arrows |
| `b01edd1` | Interconnect chart/map/mini-strip views |
| `13c023a` | Overpass resilience — better mirrors, retry, aligned timeout |
| `0e96780` | Waypoint drag + redo stack for route planner |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Vanilla JavaScript (ES6+) |
| Maps | Leaflet 1.9.4 (OSM streets + ArcGIS satellite + hybrid layer control) |
| Routing | Valhalla via `valhalla1.openstreetmap.de` (car / bike / pedestrian profiles). **Car is the default profile** — OSRM bike lacks coverage on remote/mountain roads. Pedestrian profile uses `walking_speed: 5.1 km/h`, `max_distance: 100 km`. |
| Elevation | OpenTopoData API |
| Structures | Overpass API (bridges/tunnels from OSM) |
| Geocoding | Nominatim (OSM, free, no key) — replaced Stadia |
| LIDAR Server | Flask + rasterio backend (`C:\Users\Mitja\GPX Lidar download\`) — 22 countries, 0.4–10m resolution |
| Fonts | Inter (sans-serif), IBM Plex Mono (monospace) via Google Fonts |
| Build | Vite 6 |
| Tests | Vitest 3 + Playwright (E2E) |

All external APIs are free and public except Stadia which has a monthly call limit.

---

## Target Architecture (Modularized)

### Directory Structure

```
gpxforge/
├── CLAUDE.md
├── index.html                  # Slim shell: mount point, font links, CSS imports
├── package.json
├── vite.config.js
├── src/
│   ├── main.js                 # Expert mode entry point: boot app, wire event listeners
│   ├── simple.js               # Simple mode entry point: one-click pipeline orchestrator
│   ├── state.js                # Global ST object, history (undo/redo), constants
│   │
│   ├── pipeline/               # One module per processing step
│   │   ├── 0-trim.js           # Route trimming (cut sections, bridge gaps)
│   │   ├── 1-snap.js           # Road snapping via Valhalla (car default, bike option)
│   │   ├── 2-brunnels.js       # Overpass bridge/tunnel fetch + classification
│   │   ├── 3-clean.js          # LIDAR spike detection, manual corrections
│   │   ├── 3.5-vegetation.js   # Morphological vegetation artifact filter
│   │   ├── 4-smooth.js         # Gradient averaging + fillet + processGPX geometry
│   │   └── 5-split.js          # Physics-based timing, drafting model, GPX export
│   │
│   ├── modes/                  # App modes (orchestrators)
│   │   ├── auto-pipeline.js    # One-click pipeline: brunnels → clean → smooth → simplify
│   │   └── route-builder.js    # Create routes by clicking waypoints on the map
│   │
│   ├── api/                    # External API clients (fetch wrappers, retry logic)
│   │   ├── valhalla.js         # Valhalla + OSRM unified routing client (car/bike/auto profiles)
│   │   ├── overpass.js         # Overpass API with mirror fallback + retry
│   │   ├── opentopodata.js     # Elevation data fill
│   │   ├── lidar.js            # LIDAR elevation server client (Flask backend)
│   │   └── place-search.js     # Nominatim geocoding (place search + autocomplete)
│   │
│   ├── map/                    # Leaflet map setup and interaction
│   │   ├── setup.js            # Map init, tile layers (street/satellite)
│   │   ├── layers.js           # Route polylines, markers, correction overlays
│   │   └── interactions.js     # Click handlers, waypoint dragging, draw mode
│   │
│   ├── sync.js                 # ✅ View-agnostic viewport + cursor pub/sub
│   │                           #    zoom(), pan(), setCursor(), subscribe()
│   │                           #    Imported by chart/, map/, and future 3D
│   │
│   ├── chart/                  # ✅ Elevation chart system (Phase 6)
│   │   ├── index.js            # Orchestrator: initChart(), drawAll(), zoomToCorr()
│   │   ├── shared.js           # Canvas helpers, coord transforms, color cache
│   │   ├── elevation.js        # Main elevation profile (11-layer canvas + interaction)
│   │   ├── gradient.js         # Gradient overlay (orig/clean/smooth lines)
│   │   └── mini-strip.js       # Overview strip (full route, click-to-pan)
│   │
│   ├── ui/                     # DOM manipulation, panels, toolbar
│   │   ├── shell.js            # ✅ DOM skeleton, file loading, rotatable focus, stats (Phase 8a)
│   │   ├── toolbar.js          # ✅ Undo/redo/download buttons, keyboard shortcuts (Phase 8a)
│   │   ├── sidebar.js          # ✅ Pipeline step nav, tool panels, collapse/expand (Phase 8b)
│   │   ├── panels.js           # ✅ All 6 step panel builders with controls (Phase 8c)
│   │   ├── simple-ui.js        # Simple mode DOM builder (landing/builder/processing/review)
│   │   ├── corrections.js      # Corrections list panel, resizable (Phase 8d)
│   │   └── stats.js            # Before/after statistics display (Phase 8d)
│   │
│   ├── utils/                  # Pure functions, no side effects
│   │   ├── gpx.js              # GPX parsing and serialization
│   │   ├── math.js             # Haversine, bearing, interpolation, Gaussian
│   │   ├── geometry.js         # Point-to-segment distance, fillets, simplification
│   │   ├── resolution.js       # Country detection + LIDAR densification
│   │   └── format.js           # Number/time/distance formatting helpers
│   │
│   └── styles/                 # CSS split by concern
│       ├── base.css            # Reset, variables (--bg, --panel, etc.), typography
│       ├── layout.css          # Topbar, CSS grid content area, rotatable focus
│       ├── chart.css           # Elevation chart, gradient, canvas overlays
│       ├── map.css             # Leaflet overrides, layer controls
│       ├── components.css      # Buttons, inputs, sliders, badges, tooltips
│       └── steps.css           # Step-specific panel styles
```

### Key Architectural Decisions

- **ES Modules** — native `import`/`export`, no class hierarchy, prefer functions
- **Vite** — dev server with HMR, production build with hashing. Zero-config for vanilla JS
- **Single global state object (`ST`)** — keep the existing pattern, just move it to `state.js` and export it. Don't over-engineer state management for a single-user tool
- **Pipeline modules are self-contained** — each step exports an `init()` function (wires DOM) and processing functions. Steps don't import each other directly; they communicate through `ST`
- **API modules handle their own retry/fallback** — Overpass mirror rotation, OSRM error handling, Stadia rate tracking all live in `api/`
- **Utils are pure** — no DOM access, no state mutation, fully testable
- **Rotatable focus layout** — elevation chart, map, and (future) 3D view are all on screen simultaneously. CSS grid drives the layout via a `data-focus` attribute on `.content`: the featured panel spans the full top row (~60%), secondary panels share the bottom row (~40%). Clicking a ⤢ promote button on a secondary panel promotes it to featured — no DOM swapping, just a `data-focus` attribute change that triggers CSS grid area reassignment. ResizeObservers handle canvas/map redraws automatically. When 3D is added, secondary panels will split the bottom row side-by-side
- **View sync via `src/sync.js`** — view-agnostic pub/sub for coupled zoom and cursor. Any view (chart, map, 3D) subscribes to the same two channels (`viewport`, `cursor`). Scroll-zooming ANY view zooms ALL views simultaneously. Hovering ANY view shows a cursor in ALL views. This module is separate from `chart/` so map and 3D can import it independently
- **Cursor-locked zoom** — scroll wheel zooms around the cursor position, not the center. The cursor stays at the same data point before and after zoom

---

## Coding Conventions

### JavaScript

- **No frameworks, no classes** — vanilla JS with ES modules and plain functions
- **`const` by default**, `let` when reassignment is needed, never `var`
- **Arrow functions** for callbacks and short expressions; `function` declarations for top-level named functions
- **Descriptive names** — `calcHaversineDistance()` not `dist()`, `fetchBridgesAndTunnels()` not `getBrunnels()`
- **Early returns** over deep nesting
- **JSDoc comments** on exported functions with `@param` and `@returns`
- **No semicolons** (rely on ASI — match the existing codebase style)
- **Error handling** — always catch fetch errors, show user-facing messages via a shared `showToast()` or similar, log details to console

### CSS

- **CSS custom properties** (already defined in `:root`) — always use variables for colors, shadows, radii, fonts
- **No CSS-in-JS, no Tailwind** — plain CSS files, scoped by concern
- **BEM-ish naming** — `.step-panel__header`, `.chart-overlay--active`

### File & Module Patterns

- One export concern per file. If a file grows past ~300 lines, split it
- Group related imports at the top: externals first, then local modules
- Keep `index.html` minimal — just the DOM skeleton and a single `<script type="module" src="/src/main.js">`

---

## State Management

The `ST` object is the single source of truth:

```js
// src/state.js — current fields
export const ST = {
  // GPX data
  gpx: null,          // { lats, lons, eles } — parsed GPX arrays
  filename: '',       // original filename
  dists: null,        // Float64Array — cumulative distances (m)

  // Pipeline outputs
  grOrig: null,       // Float64Array — original gradients (%)
  eleClean: null,     // Float64Array — cleaned elevations
  grClean: null,      // Float64Array — cleaned gradients
  eleSmoothed: null,  // smoothed elevations (for download fallback)
  grSmoothed: null,   // smoothed gradients
  smoothedRoute: null, // { lats, lons, eles, dists, gr } — processGPX result (different point count)
  brunnels: null,     // bridge/tunnel data from Overpass
  corrections: [],    // Array of { alo, ahi, ... } — correction zones

  // Viewport (fractions 0–1, synced via sync.js)
  viewStart: 0,       // viewport start [0, 1)
  viewEnd: 1,         // viewport end (0, 1]

  // Cursor (synced via sync.js)
  hoverIdx: null,     // hovered point index
  hoverDistM: null,   // hovered distance (m)

  // Interaction state
  selectedCorr: -1,   // selected correction index
  drawMode: false,    // draw mode active
  drawAnchor1: null,  // first draw anchor index
  drawCursorIdx: null, // current cursor in draw mode
  dragState: null,    // active anchor drag

  // Sidebar / pipeline
  activeStep: null,     // current step id ('trim'|'snap'|...|null)
  stepStatus: {},       // { trim: 'done'|'warn'|'none', ... }

  // History (undo/redo)
  history: [],
  historyIdx: -1,

  // Internal
  _anchorHandles: [], // elevation chart anchor hit targets
}
```

**Undo/redo** uses tagged snapshots — `pushHistory(type)` where type is `'clean'` (default) or `'trim'`. Each snapshot stores `{ type, eleClean, corrections, selectedCorr }`. Clean + Trim share one global undo stack; Smooth/Snap will use revert buttons. Defined in `state.js` and exported as `pushHistory()`, `performUndo()`, `performRedo()`.

**Smooth overlay model:** processGPX produces a completely new route (different point count, different lat/lon/ele/dists). Instead of replacing the active route, the result is stored in `ST.smoothedRoute` as an overlay. The elevation chart draws the smoothed line using proportional distance mapping (`sd[i] × origTotal / smoothTotal`) to align X-coordinates with the original route's distance scale. The map switches to smoothed coordinates (green polyline) when `ST.smoothedRoute` exists, reverting to original (blue) when null. The cleaned profile, corrections, and undo history are preserved. Any upstream edit (accept/reject correction, re-run clean) invalidates `ST.smoothedRoute`.

**Interoperability model:** Steps are independent — each can accept an unprocessed GPX file. Fallback chain: `ST.eleSmoothed || ST.eleClean || ST.gpx.eles`. When an upstream step re-runs, downstream results are auto-invalidated (step status badges show "stale"). One adaptive download button changes filename suffix and elevation source based on `ST.activeStep`.

---

## Testing Strategy

### Unit Tests (Vitest)

High-value targets — the math and processing logic in `utils/` and `pipeline/`:

- `utils/math.js` — Haversine distance, bearing calculation, Gaussian smoothing kernel
- `utils/gpx.js` — GPX parsing edge cases (missing elevations, malformed XML, different GPX versions)
- `pipeline/3-clean.js` — spike detection with known elevation profiles
- `pipeline/4-smooth.js` — Gaussian smoothing output against expected curves
- `pipeline/5-split.js` — physics model (power→speed at known gradients, drafting coefficients)

### Integration Tests (Vitest + mocked fetch)

- API modules with mocked responses (Overpass XML, OSRM JSON, OpenTopoData JSON)
- Verify retry/fallback logic (Overpass mirror rotation)
- Verify Stadia rate limit tracking

### E2E Tests (Playwright)

- Load a GPX file → verify chart renders
- Run full pipeline → verify output GPX has expected point count
- Click-to-trim → verify segment removal
- Map interaction → verify waypoints appear

### Running Tests

```bash
npm run test          # Vitest unit + integration (watch mode)
npm run test:run      # Vitest single run (CI)
npm run test:e2e      # Playwright end-to-end
```

---

## processGPX Integration

GPXForge uses [processGPX-js](https://github.com/djconnel/processGPX) by Dan Connelly — a JavaScript port of a mature Perl CLI tool for processing GPX files for virtual cycling platforms. The full module (6,366 lines, 70+ functions) is integrated as a **standalone processing step**.

### How It Works

- **Location:** `src/lib/processGPX/process-gpx.js` — full module with bug fixes (SQRT2PI, note silencing)
- **Adapter:** `src/pipeline/4-smooth.js` — converts GPX arrays to GeoJSON Feature, calls `processGPX(feature, { auto: 1, zSmooth: 0, cornerCrop: 0, prune: 0, lSmooth: 2, autoSpacing: 0, spacing: 0, snap: 0 })`, converts back
- **Auto mode** sets ~13 defaults: `lSmooth=5`, `zSmooth=0` (disabled), `spacing=auto`, `autoSpacing=1`, `smoothAngle=10`, `minRadius=6`, `cornerCrop=6`, `prune=1`, `fixCrossings=1`, `rUTurn=6`, `snap=1`, `fitArcs=1`, `splineInterpolation=1`
- **Our overrides:** `zSmooth=0` (elevation handled separately), `cornerCrop=0` (our fillets already round corners), `prune=0` (pruning removes points needed for accurate elevation transfer at hairpins), `lSmooth=2` (reduced from default 5 — our pre-smooth σ=5m already handles geometric noise, so processGPX only needs light smoothing; default 5 caused excessive inward pull at hairpins due to double-smoothing), `autoSpacing=0` (disables processGPX's internal corner auto-spacing — our 1m resample already provides uniform input), `spacing=0` (disables processGPX's uniform resampling which would re-space to ~13m on 85km routes, losing our 1m precision), `snap=0` (disables overlapping road pass alignment — causes stack overflow when spacing=0 because snap expects spaced points internally)
- **Geometry only:** processGPX is used ONLY for lat/lon geometry (corner rounding, arc fitting, splines). Elevation is handled separately — see "Elevation Smoothing Design" below
- **Overlay model:** processGPX produces a **completely new route** (different point count) stored in `ST.smoothedRoute` as an overlay. The original route, corrections, and undo history are preserved
- **UI:** Single "▶ Process" button + "↺ Revert" — no sigma sliders, no advanced panel
- **Pipeline stages (active):** Position smoothing (lat/lon only, lSmooth=2) → spline fitting → crossing fixes → U-turn detection. Corner cropping, auto-spacing, interpolation, snap, and pruning are all disabled via our overrides
- **Performance:** processGPX has O(n²) passes (smoothLoop, crossing detection). Our 1m resample inflates routes to ~1 point/metre (e.g., 85km → 85,000 points). To prevent page-unresponsive hangs on long routes, processGPX's internal resampling is disabled — it would add even more points. The 1m input from our own resample stage is sufficient for arc fitting

### Elevation Smoothing Design

**Problem:** processGPX's position smoothing pass (smoothLoop 0, lSmooth=5) Gaussian-smooths elevation alongside lat/lon — there's no option to smooth only position. Even with `zSmooth: 0`, elevation gets a 5m Gaussian. This is too aggressive for LIDAR-quality cleaned data. Additionally, at tight hairpins, processGPX applies uniform gradient elevation (same slope across the entire hairpin arc), destroying the real elevation profile. The key insight: **pre-process geometry so processGPX receives clean, filleted input, then transfer elevation from the ORIGINAL route** — never from processGPX output.

**Five-stage smooth pipeline (`runSmoothing()` in `4-smooth.js`):**

1. **Stage 1 — Fillet tight corners** (`applyFillets()` from `geometry.js`): For corners with turn ≥ 70°, replace the sharp vertex/cluster with a circular arc at 6m radius (0.3m spacing). Catches both hairpins (180°) and 90° urban corners. Uses inscribed circle (fillet) geometry — tangent points are ON the original segments. Handles multi-vertex hairpins (common from road snap) by clustering adjacent vertices within 50m distance. Runs BEFORE resample so the arc points are not disrupted by resampling.

2. **Stage 2 — Resample** (`resampleRoute()` from `geometry.js`): Redistribute points at uniform ~1m spacing via linear interpolation along the filleted route. Elevations are separately interpolated from the filleted route onto the 1m grid (resampleRoute doesn't carry eles).

3. **Stage 2.5 — Gradient averaging** (`smoothElevationsByGradient()`): Count-based moving average of gradients — exactly **4 segments each side** (9-segment window), matching GPXmagic's "4-point average" algorithm exactly. Runs **after** the 1m resample so window size is always correct regardless of input point spacing (Valhalla 5–30m, GPS 5–10m, Route Builder 3m). Recomputes elevations from averaged gradients.

4. **Stage 3a — Position smoothing** (`smoothPositions()` from `geometry.js`): Gaussian smooth (σ=5m) on lat/lon only, pinning start and end points. Distance-weighted kernel removes remaining geometric noise without touching elevation.

5. **Stage 3b — processGPX geometry polish**: Arc fitting, splines, crossing fixes. Elevation transferred from Stage 2.5 output onto processGPX geometry via proportional distance interpolation.

**Post-processing — Triangle-area simplification** (`simplifyByArea()` in `geometry.js`): Optional point reduction using GPXmagic's algorithm. Each pass computes 3D triangle area for every interior point, selects smallest 20% as removal candidates, applies adjacency filter (never removes consecutive points), and applies curvature guard (protects points where circumscribed radius < 20m from removal). Multiple passes available via ✂ Simplify button, each tracked in info panel with undo/redo support (separate stack from clean/trim undo).

**Why this pipeline works (and why alternatives didn't):**

| Approach | Result | Problem |
|----------|--------|---------|
| processGPX with corners disabled + nudge | Hairpins widened but 90° corners not rounded | processGPX needs corner handling enabled to detect/round 90° turns |
| processGPX with corners enabled on raw OSRM geometry | Corners not properly rounded | Raw OSRM geometry too noisy for processGPX corner detection |
| Fillets + processGPX + nudge | Conflicting geometry changes | Fillets cut corners IN (inscribed arc), nudge pushed OUT — fighting each other |
| Fillets + resample + smooth (no processGPX) | Correct shape but radii too tight | Without processGPX's arc fitting, minimum radius insufficient |
| Fillets + 5m resample + processGPX (spacing=5) | Random lat/lon points, wrong elevations | 5m spacing too sparse for processGPX arc fitting |
| Fillets + no resample + processGPX (spacing=0, autoSpacing=0) | Wide turns, straight lines | ~25m natural spacing too sparse for processGPX |
| Fillets + 1m resample + processGPX (spacing=0, autoSpacing=0, snap=1) | Stack overflow in snapPoints | snap expects internally spaced points |
| Fillets → 1m resample → smooth → processGPX (autoSpacing=0, spacing=0, snap=0) → elevation from original | Correct corners, correct radii, correct elevation, no hangs | Our 1m resample provides uniform input; processGPX internal resampling disabled to prevent O(n²) hangs on long routes |
| Fillets BEFORE smoothPositions (σ=3m, 9m window) | Arc points pulled back toward corner vertex — effective radius below 6m | smoothPositions undoes the fillet |
| Resample → smoothPositions → fillets AFTER | Correct 6m radius preserved — smoothPositions cannot undo fillets run after it | Current approach |

**Fillet geometry (`filletCorner()` in `geometry.js`):**
- Inscribed circle of radius R tangent to both straight segments at a corner vertex
- Tangent distance from vertex: `d = R / tan(θ/2)` where θ is the turn angle
- Arc center along bisector at `R / sin(θ/2)` from vertex
- Arc points generated at 0.3m spacing using local Cartesian (cos(lat) longitude correction)
- Radius clamped when tangent exceeds 90% of segment length
- Returns null for near-straight corners (< 1° turn)

**Corner clustering (`findCornerClusters()` in `geometry.js`):**
- Scans all vertices for turn angle ≥ threshold (default 3°)
- Groups adjacent vertices by distance (maxGapM=50m via haversine)
- Multi-vertex hairpins (120° spread across 3 vertices at 5m spacing) merge into one cluster
- Only clusters with totalTurn ≥ minTurnDeg (70°) are filleted
- Each cluster is replaced with a single fillet arc at the cluster centroid

**Additional geometry utilities in `geometry.js`:**
- `circumscribedRadius3(lats, lons, i)` — Menger curvature: radius of circle through 3 consecutive points in local Cartesian. Used for radius analysis and simplify curvature guard
- `simplifyByArea(lats, lons, eles, dists, opts)` — GPXmagic-style triangle-area simplification with adjacency filter and curvature guard (minRadiusM=20m default). Used as optional post-processing after Process
- `nudgeTightCorners(lats, lons, dists, opts)` — Raised-cosine bell profile nudge with 20m anchors. Available but not used in final pipeline (fillets + processGPX proved sufficient)
- `resampleRoute(lats, lons, dists, spacingM)` — Uniform distance resampling via linear interpolation
- `smoothPositions(lats, lons, dists, sigma)` — Gaussian lat/lon smoothing, pins endpoints

**Analysis of GPXmagic's 4-point gradient average** (from user-provided test files, 20,119 points at ~1m spacing):
- Algorithm: `avg_gr[i] = mean(gr[i-4 .. i+4])`, then `ele[i+1] = ele[i] + avg_gr[i] × dist[i]`
- Window: ~7.8m of route distance at 1m spacing
- Max gradient reduced 40% (24.7% → 14.8%)
- Total ascent reduced 8.2% (381.9m → 350.5m)
- Mean elevation difference: 0.016m
- Equivalent Gaussian σ ≈ 2.5m

### Bug Fixes Applied to processGPX-js

1. **`SQRT2PI` undefined** — added `const SQRT2PI = Math.sqrt(2 * PI)` to constants
2. **`note()` console spam** — changed to opt-in via `globalThis.processGPXVerbose`

### Future processGPX Features (Not Yet Exposed)

These features exist in the module but aren't exposed in the UI. They could be added as advanced options later:

#### Lower Priority — Advanced / Niche

| Feature | processGPX Flag | What It Does |
|---|---|---|
| **Snapping repeated sections** | `-snap` | Aligns overlapping road passes to identical coordinates |
| **Circuit repetition** | `-repeat` | Duplicate laps for virtual races |
| **Splicing** | `-splice` | Replace route segments with data from another source |
| **Auto-segments** | `-autoSegments` | Automatic climb detection via vertical metres and gradient power |
| **Corner waypoints** | `-addCornerWaypoints` | Marks high-curvature positions |
| **Auto-smoothing** | `-autoSmoothZ` | Adaptive altitude smoothing — more where gradient changes rapidly |
| **Quality scoring** | computed | Metric combining grade and direction change per point |

### Implementation Approach: Client-Side, Not Backend

All processGPX algorithms are **pure math** — arrays of coordinates, elevations, and gradients in, processed arrays out. No I/O, no network, no filesystem. This means:

- **Keep everything client-side** in `pipeline/` and `utils/`
- The computation is lightweight (O(n) Gaussian walks, O(n log n) for RDP). Even 50k-point GPX files process in milliseconds
- No benefit from a backend — server round-trips would add latency for no gain
- The algorithms are trivially unit-testable as pure functions

A backend is only warranted for I/O concerns (API caching, rate limits, persistence) — never for running these algorithms server-side.

---

## External APIs

| API | Base URL | Auth | Rate Limit | Used For |
|-----|----------|------|------------|----------|
| Valhalla | `valhalla1.openstreetmap.de` | None | Fair use | **Road snapping (primary)** — car default, bike option. Full global coverage |
| OSRM | `routing.openstreetmap.de/routed-bike/` | None | Fair use | Road snapping (legacy fallback in 'auto' mode only). **Bike profile lacks remote/mountain roads — do NOT use as default** |
| Overpass | Multiple mirrors (see `api/overpass.js`) | None | Fair use | Bridge/tunnel geometry from OSM |
| OpenTopoData | `api.opentopodata.org` | None | Fair use | Elevation gap-fill (trim seam repair) |
| Nominatim | `nominatim.openstreetmap.org` | None | Fair use | Place search + autocomplete (replaced Stadia) |
| LIDAR Server | `localhost:5050` | None | Local | High-res elevation data (22 countries, 0.4–10m) |
| OSM Tiles | `tile.openstreetmap.org` | None | Fair use | Street map layer |
| ArcGIS/ESRI | `server.arcgisonline.com` | None | Fair use | Satellite imagery layer |

**Important:** Overpass API has multiple mirror servers with automatic fallback and retry logic. This resilience pattern must be preserved.

**Important:** The LIDAR server is a local Flask backend at `C:\Users\Mitja\GPX Lidar download\` that queries WCS/REST elevation APIs for 22 countries. It must be running for elevation fetching to work.

---

## Backend Considerations

### Current: No Backend (Client-Side Only)

The app works entirely in the browser. All API calls go directly from the client to public endpoints. This is fine for a single-user tool and keeps deployment trivial (static file hosting).

### When a Backend Becomes Advisable

A backend makes sense if any of these become real pain points:

1. **API rate limit management** — Stadia's 20k/month limit is the most likely trigger. A backend can cache geocoding results in SQLite/Redis so identical lookups never hit the API twice
2. **CORS issues** — some APIs may tighten CORS policies. A proxy eliminates this entirely
3. **Route persistence** — saving projects (GPX + corrections + parameters) server-side so you can resume sessions
4. **Heavier computation** — if processing ever becomes too slow in the browser (unlikely for current feature set)

### Backend Options (Ranked by Complexity)

#### Option 1: Cloudflare Workers / Vercel Edge Functions (Lightest)
- **What:** Serverless proxy that sits between your app and external APIs
- **Adds:** Response caching (KV store), rate limit tracking, CORS headers
- **Cost:** Free tier is generous (100k requests/day on Cloudflare)
- **Complexity:** One file per API endpoint, deploy with `wrangler` or `vercel`
- **Best for:** Solving the Stadia rate limit without changing your app's architecture
- **Downside:** No persistent storage for routes (would need a separate DB)

#### Option 2: Express/Fastify + SQLite (Middle Ground)
- **What:** Lightweight Node.js server co-located with your static files
- **Adds:** API proxying, caching, route/project persistence, full control
- **Cost:** ~$5/month on Railway, Fly.io, or a VPS
- **Complexity:** ~200-400 lines of server code
- **Best for:** When you want to save/load routes and manage API limits centrally
- **Example structure:**
  ```
  server/
  ├── index.js          # Express app, static file serving
  ├── routes/
  │   ├── proxy.js      # /api/osrm/*, /api/overpass/*, etc.
  │   └── projects.js   # CRUD for saved routes
  └── db.js             # SQLite via better-sqlite3
  ```

#### Option 3: Supabase / Firebase (Managed)
- **What:** BaaS with Postgres/Firestore, auth, storage
- **Adds:** Everything, including auth if you ever go multi-user
- **Cost:** Free tier available
- **Complexity:** SDK integration, more moving parts
- **Best for:** If GPXForge ever becomes multi-user or needs file storage
- **Downside:** Overkill for single user, vendor lock-in

### Recommendation

**Stay client-side for now.** Add **Option 1 (Cloudflare Workers)** when Stadia rate limits become a real problem — it's a 30-minute setup and doesn't change your app architecture. Move to **Option 2** only if you want persistent route storage.

---

## Commands

```bash
# Development
npm run dev           # Vite dev server with HMR (http://localhost:5173)

# Build
npm run build         # Production build → dist/
npm run preview       # Preview production build locally

# Testing
npm run test          # Vitest watch mode
npm run test:run      # Vitest single run
npm run test:e2e      # Playwright E2E tests

# Formatting
npm run format        # Prettier — format all files
npm run format:check  # Prettier — check only (CI)
```

---

## Git Conventions

- **No filename versioning** — use git history and tags
- **Commit messages:** imperative mood, concise (`Add waypoint drag-and-drop`, `Fix Overpass retry on 429`)
- **Branch strategy:** `main` is the working branch. Feature branches optional for larger changes

---

## Keyboard Shortcuts & Interactions (In-App)

| Key / Gesture | Action |
|---------------|--------|
| `S` | Open Google Street View at hovered point (chart or map) |
| `D` | Toggle freehand draw mode (Clean step only) |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| Double-click (chart) | Zoom to ~1km window centered on click point |
| Double-click (map) | Leaflet default zoom-in at click point |

---

## Known Gotchas

1. **Overpass API can be slow** — queries sometimes take 10-30s. The app uses multiple mirror servers with automatic fallback. Don't remove this resilience logic during modularization
2. **Routing uses Valhalla car by default** — OSRM bike profile lacks road data for remote/mountain roads (e.g. Ladakh at 4180m snaps 40km away). Valhalla car (`valhalla1.openstreetmap.de`) has full global coverage. **Never default to OSRM bike** — it causes catastrophic routing failures on remote roads. The bike option is available in the UI for users who want cycling-specific routing on well-mapped roads
3. **Canvas rendering** — the elevation chart is drawn on `<canvas>`, not SVG. This is intentional for performance with large GPX files (10k+ points)
4. **Stadia rate limit** — 20,000 calls/month. Cache results and debounce user input. Track usage if possible
5. **Large GPX files** — files with 50k+ points can cause jank. Processing should be chunked or use `requestAnimationFrame` to avoid blocking the main thread
6. **The `ST` global** — mutations to `ST` trigger no automatic re-renders. UI updates must be called explicitly after state changes. This is by design (simple, predictable), but means you must remember to update the DOM
7. **Leaflet needs visible container** — `initMap()` must be called AFTER the map container is visible and has dimensions (after `showViews()`). Leaflet reads container dimensions on `L.map()` creation and won't recover from 0×0. The ResizeObserver in `map/index.js` handles subsequent resizes (e.g., panel focus rotation) automatically via `invalidateSize()`
8. **Mini strip removed** — `chart/mini-strip.js` exists but is unused. `getChartEls()` returns `cvMini: null`, and `initChart()` guards with `if (_cvMini)`. The mini strip was removed from the UI as unnecessary
9. **`ST.smoothedRoute` has different point count and total distance** — processGPX produces a route with a different number of points (M ≠ N) and different total distance. Chart rendering must use **proportional distance mapping** (`sd[i] × origTotal / smoothTotal`) to align the smoothed line with the original route's X-axis. The `visibleRange()` calls for the smoothed line must map viewport lo/hi to the smoothed distance scale first. The hover tooltip maps the original distance proportionally before looking up the closest smoothed point. The map (`updateRoute()` in `layers.js`) switches between original (blue) and smoothed (green) coordinates based on `ST.smoothedRoute` existence
10. **Resize handle between panels** — the ⋯ drag handle between top and bottom panel rows updates `grid-template-rows` via inline style. The handle position is synced via `updateHandleTop()` reading computed grid row heights. ResizeObservers on chart/map containers handle redraws automatically. Clamped to 20%–80% range. The `ResizeObserver` for handle position is guarded with `typeof ResizeObserver !== 'undefined'` for jsdom compatibility
11. **processGPX hangs on long routes** — 1m resampling inflates routes to ~1 point/metre (85km → 85,000 points). processGPX's O(n²) passes (smoothLoop, crossing detection) cause page-unresponsive. Fixed by disabling processGPX's internal resampling (`autoSpacing: 0, spacing: 0, snap: 0`). Never re-enable these without solving the performance issue first
12. **Snap density default is 1m** — road snapping with density=0 reduces point count, losing 1m LIDAR elevation data. Default changed to density=1 to preserve elevation accuracy through the pipeline
13. **Route builder leaves `ST.grClean` / `ST.grOrig` null** — when a route is created via Route Builder, no clean step has run so gradient arrays are null. Any function in the `refresh()` path that calls `.map()` or `.reduce()` on these must null-guard. Currently guarded: `buildColors()` in `chart/shared.js`, `updateStats()` in `ui/shell.js`. If adding new stats/chart code that reads gradient arrays, always check for null first
14. **Brunnel merging gap is 50m** — `mergeAdjacent()` in `2-brunnels.js` merges same-type brunnels whose gap is ≤ `gapM`. Default is 50m (was 20m, originally 2m for OSM-way overlaps). This prevents "pumptrack" elevation artifacts between physically separate but close bridges/tunnels. Override via `opts.mergeGapM` in `locateBrunnels()`
15. **LIDAR can return a different point count** — local providers (Slovenia `is_local=True`) resample to 1m before querying, so a 20km route grows from ~6,600 pts (3m) to ~20,000 pts (1m). `main.js` LIDAR handler always parses lat/lon/ele from the returned GPX and replaces the entire route (calls `rebuildRoute()` for grOrig/grClean). Never check `elEls.length === ST.gpx.lats.length` — the count is expected to differ for local providers
16. **Gradient averaging is count-based, not distance-based** — `smoothElevationsByGradient()` uses 4 segments each side (fixed count), not a 4m distance window. The old distance window did nothing at 5–25m point spacing. The count-based approach always matches GPXmagic's algorithm regardless of input spacing. Runs after the 1m resample so the window is always ~4m of real distance
17. **`process-gpx.js` spread overflow on large routes** — `pNew.push(...largeArray)` spreads every element as a function argument onto V8's call stack. At 48K+ elements this exceeds the argument limit and throws `RangeError: Maximum call stack size exceeded`. This is NOT a recursion problem — all functions are iterative. Fixed by replacing all `push(...slice(...))` patterns with direct index loops (`for (let k = i0; k < arr.length; k++) pNew.push(arr[k])`). 8 sites patched. Never use `push(...spread)` on arrays that could exceed a few thousand elements
18. **Cleaner labels corrections as 'artifact', not 'bridge'/'tunnel'** — `runCleaner()` in `3-clean.js` classifies interpolation shape via `classifyStructure()` but the **label** is set by `matchBrunnel()` which cross-references OSM brunnels from step 2. Only corrections overlapping an OSM brunnel get 'bridge'/'tunnel'; all others are 'artifact'. The shape classification (Hermite convex/concave/uniform) still drives the interpolation method. `runCleaner()` takes an optional 4th param `brunnels = []` — always pass `ST.brunnels || []` from callers (`main.js` clean handler + `auto-pipeline.js`)
19. **LIDAR densification is client-side before fetch** — `resolution.js` detects the provider's native resolution via country bbox lookup, then `densifyForLidar()` resamples the route to that resolution using `resampleRoute()` from `geometry.js`. This happens in the `onLidar()` handler only — not during file upload or snap. The server may further resample (local providers do 1m). `ST.origAvgSpacing` is preserved before densification for the smoother's adaptive windowing
20. **Smooth step auto-trims start/end overlap** — `detectStartEndOverlap()` in `geometry.js` finds consecutive tail points within 10m of head points. The smooth handler silently trims the overlap before calling `runSmoothing()`, recalculating `ST.dists`/gradients in-place. This is a safety net — catches overlap from snap, drag-reroute, or any source. No UI prompt. Console log only
21. **Place search uses Nominatim, not Stadia** — `api/place-search.js` queries `nominatim.openstreetmap.org` (free, no key, no rate limit beyond fair use). Stadia geocoding code has been fully replaced. Base URL overridable via `VITE_GEOCODE_BASE_URL` env var
22. **Simple mode shares the map instance** — `simple.js` creates one Leaflet map and reparents it between builder and review views. The shared `sharedMapEl` div is moved via `container.appendChild()` and Leaflet's ResizeObserver handles `invalidateSize()` automatically. Never create a second map instance
23. **Simple mode auto-pipeline skips snap** — `runAutoPipeline()` in `auto-pipeline.js` is called with `{ skipSnap: true }` from simple mode because Route Builder already produces road-snapped geometry from Valhalla. Running snap again would be redundant
24. **LIDAR densification happens client-side** — `resolution.js` detects the provider's native resolution via country bounding-box lookup, then `densifyForLidar()` resamples the route before sending to the server. Countries are ordered small-to-large in `COUNTRY_BOXES` so Luxembourg matches before France
25. **Brunnel anchor extension** — `extendAnchor()` in `2-brunnels.js` walks outward from OSM boundary up to 50m with a 3% grade threshold. This catches approach ramps where LIDAR artifacts extend beyond the OSM-defined bridge geometry. Runs after `mergeAdjacent()` in `locateBrunnels()`
26. **Vegetation filter uses morphological opening** — `filterVegetation()` in `3.5-vegetation.js` applies erosion→dilation (sliding min→max) to detect canopy spikes, then replaces them with polynomial fits. Iterates up to 3 passes. Skips points inside brunnel masks
27. **LIDAR server unsupported country remapping** — `gpx_elevation.py` remaps border points geocoded as unsupported countries (IT, CZ, SK, etc.) to their nearest supported neighbour provider via `NEIGHBOR_COUNTRIES` dict. The server no longer rejects unsupported countries — it silently reroutes them
28. **`ignore_oneways` and `ignore_restrictions` both default ON for all Valhalla calls** — both flags are irrelevant when replaying a recorded GPX ride (the rider was physically there). Defaults live in `valhallaSegment()` via `opts.ignoreOneways ?? true`. Expert snap panel exposes two separate toggles (persisted via `localStorage`). Route builder always uses both ON (no UI controls). Simple mode always uses defaults (no toggles). Never default either to `false` — it breaks snapping of legal-but-one-way segments
30. **`simplifyIdx = -1` causes redo-branch splice to wipe the baseline on first simplify** — `clearSimplifyHistory()` sets `ST.simplifyIdx = -1`. In `pushSimplifyState()`, the redo-branch trim guard `simplifyIdx < stack.length - 1` fires when `simplifyIdx = -1` (e.g. `-1 < 0`), calling `splice(0)` which clears the just-pushed baseline. The result is the first simplify pass lands at index 0 instead of 1, so `updateSimplifyUI` uses `passCount = 0` and hides the log — the first pass is invisible and the second shows as "Pass 1". Fix: guard the splice with `simplifyIdx >= 0` so it is skipped when the stack is fresh or cleared.
29. **Pedestrian profile requires `max_distance: 100000`** — Valhalla's built-in cap for the `pedestrian` costing is around 50 km. Long hiking GPX tracks (50+ km) will get a "route exceeds max distance" error without this override. Set in `valhallaSegment()` (for route-builder drag) and in `autoSnap()` (for batch routing). The `walking_speed: 5.1` default is explicit but matches Valhalla's internal default — safe to keep. Pedestrian has no OSRM fallback; `valhallaSegment` routes directly to Valhalla pedestrian without attempting OSRM first
31. **Batch queue is a modal overlay on top of the single-file pipeline** — `_currentBatchId` in `main.js` is the critical flag. When null + `ST.gpx` exists, the active route is not from the queue (single file or route builder result) — Load buttons in the batch panel are disabled with a tooltip. When non-null, the active route came from the queue and save-back is active. Always reset `_currentBatchId = null` AND call `refreshBatchPanel()` after any path that sets `ST.gpx` outside the queue (file load, route builder Done). Forgetting either causes stale Load button state
32. **Batch panel visibility is detected via `isBatchPanelVisible()` from `batch-ui.js`** — `shell.js` imports this to decide whether `data-info` should stay set when there is no step-specific info content. Do NOT check `_batchContainer.firstChild.style.display` directly — the panel controls its own display and the DOM structure could change
33. **`buildBrunnelMask()` is the canonical shared version in `2-brunnels.js`** — used by `main.js` (dip smoothing after manual clean) and `batch-pipeline.js` (dip smoothing in background worker). Do not reduplicate locally. Uses a 10m buffer on each side of the brunnel span boundary
34. **Batch pipeline does NOT run snap** — files enter the queue already parsed from raw GPX. The background worker runs brunnels → LIDAR → clean. Snap must be run manually per file if needed. `markDone()` is exported but not yet wired to any UI trigger — currently entries stay in `reviewing` state indefinitely once loaded
35. **Mode is stored in `ST.mode` and `body.dataset.mode`** — `src/ui/mode.js` owns persistence (localStorage key `gpxforge.mode`) and URL override (`?mode=simple`). Default is `'expert'`. CSS uses `body[data-mode="simple"]` selectors to gate UI. Both must stay in sync — always use `setMode()` from `mode.js`, never mutate `ST.mode` or `body.dataset.mode` directly. `initMode()` must be called before `initShell()` so the body attribute exists when the shell builds its DOM.
36. **Simple mode hides step-toolbar and expert buttons via CSS** — `body[data-mode="simple"] .step-toolbar { display: none !important }` plus individual `tool-btn--undo / --redo / --lidar / --park` selectors. The `!important` overrides the `.step-toolbar.visible { display: flex }` rule. Builder mode adds `body.builder-active` which overrides the step-toolbar hide so builder controls remain accessible. Always add/remove `builder-active` in tandem in `doEnterBuilderMode` / `doExitBuilderMode` / `doFinishRouteBuilder`.
37. **`showViews(focus)` now takes a focus argument** — default is `'chart'`. Builder mode passes `'map'` so the map is featured while creating a route. `showLanding()` resets to `data-focus='landing'` (map full-screen, no chart). Call `showLanding()` in `doExitBuilderMode()` when no file is loaded so the user returns to the map landing rather than a blank content area.
38. **Map is initialised at boot via `requestAnimationFrame`** — deferred one frame so the map container has real layout dimensions when Leaflet reads them. The `if (!mapInited)` guard in `onFileLoaded`, `onFilesLoaded`, `doResumeParkedEntry`, and `doEnterBuilderMode` is kept as a safety net but will never fire under normal conditions. Never remove the guard — it prevents a double-init if something calls `initMap` before the rAF fires.
39. **`data-focus="landing"` shows map full-screen** — `grid-row: 1/-1; grid-column: 1/-1` on `.map-panel`. The chart panel is not rendered. `showViews()` (called on file load or route creation) overwrites this to `'chart'` or `'map'`. There is no empty-state element any more — the map IS the landing page.
40. **Simple mode file-load auto-runs `runSimplePipeline()`** — `onFileLoaded()` checks `ST.mode === 'simple'` after populating `ST`. Simple: calls `runSimplePipeline()` (LIDAR → auto-pipeline → smooth step). Expert: calls `shell.showStepToolbar()` + navigates to Trim. The progress overlay covers the screen during the pipeline. Panel controls are enabled before the fork so expert controls are always ready.
41. **Queue switch and Park use `saveBackFull` + full snapshots** — `saveBackFull(id, snapshotST())` stores the entire `ST` (snap/trim/smooth/split + all gradients/elevations/history) on the entry; `loadEntry`'s `onLoad` handler calls `restoreST(entry.snapshot)` when present. The old field-only `saveBack` was removed. **Always use `saveBackFull` when persisting review state** — saving only `eleClean/grClean/corrections` silently loses every other pipeline step. Triggered automatically on: Load-switch to another entry, single-file upload while reviewing (`onBeforeSingleLoad`), and `Download All` (flushes the active entry first).
42. **`canPark()` no longer blocks on `_currentBatchId`** — Park is allowed while reviewing a queue entry. `doParkCurrentRoute()` branches on `_currentBatchId`: if set, calls `convertToParked(id, snap, parkedAtStep)` to flip the existing entry to `origin: 'parked'` (no duplicate); otherwise calls `parkEntry()` to create a new parked entry. Both paths clear `ST` and `_currentBatchId` first so the post-notify UI sees `isLoadBlocked() === false`.
43. **Resume/Load buttons in batch panel never `disabled`** — clicking when blocked shows `alert('Please park or download your current route…')`. Disabled buttons gave zero feedback; this is the explicit explainer. The `isLoadBlocked()` check happens at click time, not render time.
44. **Active queue entry has `.batch-entry--active` class** — driven by `_opts.getActiveId()` callback (returns `_currentBatchId` from main.js) read on every `refreshBatchPanel()`. Style: amber background + 3px amber left border (matches `.corr-item.sel`). Don't track active state separately in batch-ui — the callback is the single source of truth.
45. **Upload button label resets when queue stops processing** — `shell.resetUploadLabel()` is called from the `initBatchQueue` update callback whenever no entry is in `pending|brunnels|lidar|cleaning`. Without this, "Processing in background…" lingers forever after Download All. Parked entries don't count as "still processing" — they're done from the worker's perspective.
46. **Download All includes parked entries** — bulk + parked are both downloadable (parked entries hold processed work the user paused). Filter: bulk needs `status ∈ {done, reviewing, ready}`; parked needs `entry.gpx`. The currently-reviewed entry is `saveBackFull`'d before the zip is built so unsaved edits land in the archive.

---

## Known Issues (processGPX Geometry)

These are visual artifacts observed with the current processGPX configuration:

1. **Start/end hairpin turns don't get loop treatment** — mid-ride 180° turns get nice rounded loops, but hairpins at the start or end of the route do NOT. Likely caused by processGPX's endpoint pinning behaviour
2. **Random straight line artifact** — occasionally a straight line connects a mid-ride loop to a random course point. Likely a `fixCrossings` artifact in processGPX. May need `fixCrossings: 0` if it persists
3. **Point count reduction after smoothing** — routes can go from 50k to 8k points after the smooth pipeline. This is expected behaviour from processGPX's internal pruning/merging of close points, but the magnitude may need investigation

---

## Route Builder (Phase 8l)

Create-from-scratch mode: user clicks waypoints on the map, Valhalla routes each A→B segment. On Done, exports to `ST.gpx` and enters the normal pipeline.

### Files
- **`src/modes/route-builder.js`** — all module state + async operations. Not in `ST` — builder is temporary
- **`src/map/layers.js`** — `updateRouteBuilderLayer()` renders draggable markers + polylines
- **`src/map/setup.js`** — `builderLayer` (L.layerGroup) added to layer stack
- **`src/map/index.js`** — builder intercepts map clicks when active; `drawMap()` calls builder layer even when `ST.gpx` is null

### State (module-level in route-builder.js)
```javascript
_waypoints: [{lat, lon}]
_segments:  [{type: 'routed'|'manual', points: [[lat,lon],...], dist: metres}]
_history:   [{waypoints, segments}]   // undo snapshots (max 50)
_pending:   boolean                   // blocks clicks during async routing
_mode:      'routed'|'manual'
_profile:   'car'|'bike'|'pedestrian'
```

### Operations
- **Add waypoint** (map click) — routes to prev via `valhallaSegment()`, falls back to straight line on failure
- **Drag waypoint** — reroutes adjacent segments preserving their original type
- **Delete waypoint** (right-click) — middle: merge + reroute if both were routed; first/last: splice
- **Insert on segment** (polyline click) — splits segment into two, re-routes if routed type
- **Undo** — snapshot stack, pops on `builderUndo()`

### UI
- `✏ Create Route` / `✕ Exit Builder` in topbar toolbar (orange when active)
- Step tabs hidden while builder active; dedicated builder controls panel shown instead
- Mode toggle: Routed (blue solid) / Manual (orange dashed), `M` key shortcut
- Profile selector: Car / Bike
- Live stats: waypoint count + total distance in info panel
- Map cursor: crosshair while active

### Done → pipeline
`finishRouteBuilder()` calls `mergeSegments()` → **resamples to 3m uniform spacing** (`resampleRoute(..., 3)`) → builds minimal `ST.gpx` with all zeros for elevation → navigates to clean step. The 3m resample normalises Valhalla's variable 5–30m spacing so LIDAR gets consistent density regardless of routing geometry. `ST.grClean` and `ST.grOrig` are **null** at this point — all code in the `refresh()` path must null-guard before calling `.map()` / `.reduce()` on gradient arrays.

### drawMap() guard
`drawMap()` in `map/index.js` now calls `updateRouteBuilderLayer()` before the `if (!ST.gpx)` guard, so the builder layer renders even before a file is loaded or after builder finishes.

---

## UI Features (Phase 8i)

- **Clickable brunnel list:** Info panel brunnel items are clickable via `setListItems()` in `panels.js`. Clicking calls `zoomToBrunnel(idx)` in `chart/index.js` which uses `setView()` to zoom chart+map to the brunnel's span with 80% padding
- **Resize handle:** Absolutely-positioned `⋯` handle between top/bottom panel rows in `.content` grid. Dragging updates `grid-template-rows` (20%–80% range). Chart/map ResizeObservers handle redraws. Handle element + drag logic in `shell.js`, styles in `layout.css`
- **Snap direction arrows:** SVG triangles on waypoint markers rotated by `bearing()` to next waypoint. Arrow orbits the 20px numbered circle via `rotate(deg, 14, 14)` in a 28×28 SVG. Last waypoint uses bearing from previous. Implemented in `updateSnapRoute()` in `layers.js`
- **Chart double-click zoom:** `dblclick` handler on elevation canvas zooms to ~1km window (`Math.min(0.5, 1000/total)`) centered on click point via `setView()`. Works at any pipeline step (no dependency on clean/smooth having run)

---

## Context Continuity (New Chat Sessions)

When starting a new Claude Code session for this project:

1. **This file is loaded automatically** — Claude Code reads `CLAUDE.md` from the project root at session start
2. **The plan file** at `C:\Users\Mitja\.claude\plans\staged-churning-seal.md` contains detailed architecture, file inventories, and implementation plans
3. **The prototype** at `C:\Users\Mitja\gpxforge\gpx_cleaner_v4_148.html` is the reference for porting behaviour
4. **Git log** — run `git log --oneline` in `gpxforge-v2/` to see what's been done
5. **Tests** — run `npm run test:run` to verify the current state (880 tests as of Phase 8i)
6. **Prototype commits** — check `https://github.com/ngarohe/gpxforge/commits/claude/stoic-nobel/` for reference behaviour

### How to Start a New Chat

Tell the new session something like:
> "I'm continuing work on GPXForge v2. Read CLAUDE.md and the plan file at `.claude/plans/staged-churning-seal.md`. Phase 8c is complete (198 tests, panels built). Let's start Phase 8d (pipeline wiring + corrections). Check the prototype commits for reference behaviour."

The CLAUDE.md + plan file together give a new session everything it needs to understand the project architecture, what exists, and what's next.

### Maintenance Rule

**Keep CLAUDE.md and the plan file up to date at all times.** After completing a phase, implementing a significant feature, or making an architectural decision:
1. Update the Phase Progress table in this file
2. Update the plan file with completion status and any new insights
3. Keep both copies in sync (`gpxforge/CLAUDE.md` and `gpxforge-v2/CLAUDE.md`)
