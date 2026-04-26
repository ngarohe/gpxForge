# GPXForge

A browser-based GPX route processing tool for cycling. GPXForge takes raw GPX files — from Strava exports, Garmin downloads, or hand-drawn routes — and transforms them into clean, road-snapped, elevation-corrected files with accurate gradient profiles and physics-based ride time predictions.

Two interfaces: **Simple mode** for one-click processing and **Expert mode** for fine-grained control over every pipeline step.

---

## Table of Contents

1. [Features](#features)
2. [Quick Start](#quick-start)
3. [Architecture Overview](#architecture-overview)
4. [The Pipeline](#the-pipeline)
5. [Simple Mode vs Expert Mode](#simple-mode-vs-expert-mode)
6. [Route Builder](#route-builder)
7. [Batch Queue](#batch-queue)
8. [LIDAR Elevation Server](#lidar-elevation-server)
9. [The Math Behind GPXForge](#the-math-behind-gpxforge)
10. [External APIs](#external-apis)
11. [Testing](#testing)
12. [Project Structure](#project-structure)
13. [License](#license)

---

## Features

### Route Creation
- **Route Builder** — click waypoints on the map, Valhalla routes each segment automatically. Supports Routed (road-following) and Manual (straight-line) modes, Car, Bike, and Pedestrian profiles, drag-to-reroute, insert, delete, and undo
- **Place search** — Nominatim-powered geocoding with autocomplete suggestions. Type a city or landmark name and the map jumps there
- **GPX upload** — drag-and-drop or file picker. Accepts Strava, Garmin, and standard GPX exports

### Elevation Processing
- **LIDAR elevation data** — 22 countries at 0.4m to 10m resolution via a local Flask server querying national WCS/REST elevation APIs
- **LIDAR spike detection** — automatic identification of bridge dips, tunnel spikes, and noise artifacts using gradient reversal analysis
- **Vegetation filter** — morphological image processing (erosion + dilation) detects and removes canopy/shrub returns in DTM data
- **Bridge/tunnel detection** — Overpass API queries for OSM structure geometry, projected onto the route with bearing alignment and overlap resolution
- **Hermite interpolation** — cubic spline corrections that match the terrain's natural curvature (convex for bridges, concave for tunnels)
- **Manual corrections** — draw custom correction zones on the elevation chart, with accept/reject and anchor drag

### Geometry Processing
- **Road snapping** — Valhalla routing with adaptive waypoint density (denser in curves, sparser on straights). Car profile default for full global coverage, bike option for cycling-specific roads
- **Fillet corner rounding** — inscribed circular arcs replace sharp corners (hairpins, 90-degree turns) with smooth curves at 6m minimum radius
- **Gradient averaging** — count-based moving average matching GPXmagic's "4-point average" algorithm. Reduces max gradients by ~40% while preserving total ascent
- **Position smoothing** — Gaussian lat/lon smoothing (sigma=5m) removes geometric noise without touching elevation
- **processGPX integration** — 6,366-line geometry library for arc fitting, spline interpolation, crossing fixes, and U-turn detection
- **Triangle-area simplification** — GPXmagic-style point reduction with adjacency filter and curvature guard (protects corners < 20m radius)

### Visualization
- **Elevation chart** — 11-layer canvas rendering with original, cleaned, and smoothed profiles overlaid. Gradient-colored background, before/after comparison
- **Gradient overlay** — separate gradient chart showing slope changes across the route
- **Interactive map** — Leaflet with OSM streets, ArcGIS satellite, and hybrid layer control. Route polyline, correction overlays, brunnel markers
- **Coupled views** — scroll-zooming any view (chart or map) zooms all views simultaneously. Hovering shows a synchronized cursor across all views. Cursor-locked zoom keeps the data point under the pointer fixed

### Export
- **Physics-based timing** — power/speed model with rolling resistance, aerodynamic drag, and gradient forces. Group drafting via Blocken 2018 coefficients
- **Split files** — divide the route into equal-time segments for pacing
- **GPX download** — corrected file with smoothed elevation and geometry
- **Bulk download** — zip archive of all processed files in the batch queue

---

## Quick Start

### Frontend (Vite dev server)

```bash
npm install
npm run dev          # http://localhost:5173
```

Open `http://localhost:5173/` — use the **Simple / Expert** toggle in the toolbar to switch modes.

### LIDAR Server (optional, for high-resolution elevation data)

```bash
cd server
bash start.sh
```

The LIDAR server fetches high-resolution elevation data from national geographic services. Without it, elevation data comes from the GPX file itself (or OpenTopoData for trim seam repairs). The app is fully functional without it.

`start.sh` manages a project-local Python environment:
- creates/uses `server/.venv`
- installs `requirements.txt` when dependency hash changes
- validates required modules before launch
- manages only the GPXForge backend PID (no broad system process kills)

On Windows, `start-gpxforge.bat` in the repo root runs the same flow.

If your local rasters are on a Windows drive in WSL, set `GPXFORGE_AUTO_MOUNT_DRIVE=E` (or the appropriate drive letter) before running `start.sh`.

#### Country-specific setup

API keys for some providers are read from environment variables (set in `server/.env`):

```bash
GPXZ_API_KEY=       # Great Britain, Canada, Belgium, Australia, Mexico, Hong Kong, New Zealand
FINLAND_API_KEY=    # Finland (Maanmittauslaitos)
DENMARK_TOKEN=      # Denmark (Dataforsyningen)
```

Slovenia local data defaults to `server/data/slovenia/slovenia_1m.vrt`. Austria tiles auto-bootstrap from `data.gv.at` on first run and download tiles on demand — no manual setup required.

### Scripts

| Command             | Description                  |
|---------------------|------------------------------|
| `npm run dev`       | Vite dev server with HMR     |
| `npm run build`     | Production build to `dist/`  |
| `npm run preview`   | Preview production build     |
| `npm test`          | Vitest watch mode            |
| `npm run test:run`  | Run tests once               |
| `npm run format`    | Format with Prettier         |

---

## Architecture Overview

GPXForge is a **client-side application** built with vanilla JavaScript (ES6 modules, no frameworks). All processing runs in the browser. The only backend component is the optional local Flask server for LIDAR elevation data.

### Key Design Decisions

- **No frameworks** — vanilla JS with ES modules and plain functions. No React, no Vue, no build-time JSX
- **Single global state** — the `ST` object in `state.js` is the single source of truth. No state management library; mutations are explicit, UI updates are called manually
- **Pipeline architecture** — six independent processing steps, each a self-contained module. Steps communicate through `ST`, not through each other
- **Overlay model** — the smooth step produces a completely different route (different point count). Instead of replacing the original, it's stored as `ST.smoothedRoute` and rendered as an overlay. The original profile, corrections, and undo history are preserved
- **View sync** — a pub/sub system (`sync.js`) couples the elevation chart and map. Any view publishes viewport/cursor changes; all views subscribe. Adding a 3D view later just means subscribing to the same channels
- **Batch queue** — `batch-pipeline.js` runs a background worker (brunnels → LIDAR → auto-clean) on multiple files serially. Each entry stores a full pipeline snapshot so switching between files loses nothing

### State Flow

```
GPX File / Route Builder
    │
    ▼
ST.gpx { lats, lons, eles }     ← raw coordinates
    │
    ├─ Trim ──→ ST.gpx (truncated)
    ├─ Snap ──→ ST.gpx (road-aligned, new lat/lon)
    ├─ Brunnels ──→ ST.brunnels (OSM structures)
    ├─ Clean ──→ ST.eleClean, ST.corrections
    ├─ Smooth ──→ ST.smoothedRoute { lats, lons, eles, dists, gr }
    └─ Split ──→ downloadable GPX segments
```

Each step can accept an unprocessed GPX file. The fallback chain for elevation is: `ST.eleSmoothed || ST.eleClean || ST.gpx.eles`.

---

## The Pipeline

GPXForge processes routes through six sequential steps. Each step is independent — you can run them in any order or skip steps entirely.

### Step 0: Trim

**Purpose:** Remove unwanted sections — pitstops, wrong turns, out-and-back detours.

**How it works:** Click two points on the elevation chart to define a cut region. The trim is classified as `start` (first 10 points), `end` (last 10 points), or `mid` (interior). Mid-trims produce a topological discontinuity where two distant points become adjacent, so the OpenTopoData API is called to fetch real ground elevation at both seam points before joining.

**File:** `src/pipeline/0-trim.js`

### Step 1: Snap (Road Alignment)

**Purpose:** Align a GPS track onto road geometry using Valhalla routing.

**How it works:**
1. **Curvature analysis** — compute per-point curvature by summing bearing-change angles over a ±100m window, normalized by pi/4 per segment
2. **Adaptive waypoint placement** — spacing = `baseSpacing × (1 - 0.65 × curvatureScore)`. Twisty sections get 35% of base spacing; straight sections get 100%
3. **Batch routing** — waypoints sent to Valhalla in batches of 20 (server limit), with 1s throttle between batches. Failed batches retry each pair individually; final fallback is straight-line
4. **Elevation transfer** — per-anchor-segment proportional distance mapping (bounds drift to ~250m segments instead of accumulating over the full route)
5. **Manual reroute consistency** — add/delete waypoint reroutes remap waypoint anchors on both original and rerouted paths before elevation transfer, preventing profile drift after post-snap edits

**File:** `src/pipeline/1-snap.js`

### Step 2: Brunnels (Bridge/Tunnel Detection)

**Purpose:** Fetch OSM bridges and tunnels from the Overpass API and project them onto the route.

**How it works:**
1. **Overpass query** — fetch all `bridge=*` and `tunnel=*` ways within the route's bounding box (with buffer)
2. **Proximity filter** — keep structures where the median node distance to the route is within the buffer (median is robust against outlier nodes)
3. **Projection** — project first OSM node globally onto the route, last node within a ±2km local window (prevents cross-pass projections on out-and-back routes). Pad by 10m each side
4. **Bearing alignment** — reject structures where no OSM segment aligns with any route segment within tolerance
5. **Overlap resolution** — sweep-line algorithm keeps the candidate closest to the route
6. **Merge** — combine same-type brunnels within 50m gap to prevent pumptrack artifacts
7. **Anchor extension** — walk 50m beyond OSM boundary with 3% grade threshold to capture approach ramps

**Classification:** Each brunnel span is classified by comparing interior elevations to anchor levels:
- **Bridge** — dip below anchor level exceeds threshold
- **Tunnel** — spike above anchor level exceeds threshold
- **Artifact** — max Hermite deviation exceeds threshold
- **Clean** — no significant deviation

**File:** `src/pipeline/2-brunnels.js`

### Step 3: Clean (Spike Detection)

**Purpose:** Detect and correct LIDAR elevation artifacts — spikes from bridge surfaces, tunnel ceiling reflections, and noise.

**Algorithm:**
1. **Flag** points where `|gradient| > spikeThreshold` (default 25%)
2. **Group** flagged points into runs, merge within `mergeGap` points
3. **Expand** outward until `|gradient| < anchorThreshold` to find clean anchor points
4. **Merge** overlapping zones and chain zones within `mergeDist` metres
5. **Classify** each zone:
   - **Edge test** — compute max gradient-change rate at both edges. Real climbs have gradual transitions (< 2 %/m); LIDAR spikes jump abruptly
   - **Suspect test** — span >= 200m AND gradient reversal rate <= 5% AND mean |gradient| >= 8% → likely a real climb, not an artifact
   - **Structure classification** — determine if bridge (dip), tunnel (spike), or artifact based on deviation from anchor level
6. **Interpolate** — apply cubic Hermite (for bridges/tunnels) or linear interpolation

**OSM labelling:** Corrections that overlap an OSM brunnel from Step 2 get the 'bridge' or 'tunnel' label. All others are labelled 'artifact'.

**File:** `src/pipeline/3-clean.js`

### Step 3.5: Vegetation Filter

**Purpose:** Remove positive elevation spikes caused by misclassified canopy/shrub returns in LIDAR DTM data.

**Algorithm:**
1. **Morphological opening** — apply erosion (sliding minimum) then dilation (sliding maximum) over a distance-based window. This removes positive spikes narrower than the window radius while preserving the terrain floor
2. **Detection** — compare original elevation to the opened profile. Points where the difference exceeds the threshold are flagged as vegetation
3. **Correction** — fit a polynomial (linear or quadratic, least-squares) through clean context points on both sides (±100m window), then apply with a cosine-taper blend at region edges for smooth transitions
4. **Iteration** — repeat up to 3 passes because wide canopy can lift the morphological floor estimate, requiring re-detection after corrections

**File:** `src/pipeline/3.5-vegetation.js`

### Step 4: Smooth (Geometry + Elevation)

**Purpose:** Transform the cleaned route into a smooth, rideable geometry suitable for virtual cycling platforms.

**Five-stage pipeline:**

1. **Fillet tight corners** — for turns >= 70 degrees, replace the sharp vertex (or multi-vertex cluster) with a circular arc at 6m radius, 0.3m point spacing. Uses inscribed circle geometry where tangent points lie on the original segments

2. **Resample to 1m** — redistribute points at uniform 1m spacing via linear interpolation. This normalizes variable input spacing (Valhalla 5–30m, GPS 5–10m, Route Builder 3m)

3. **Gradient averaging** — count-based moving average over ±4 segments (9-segment window). Matches GPXmagic's "4-point average" algorithm exactly. Reduces max gradient by ~40% (e.g. 24.7% → 14.8%) while mean elevation error is only 0.016m

4. **Position smoothing** — Gaussian smooth (sigma=5m) on lat/lon only, pinning start and end points. Removes geometric noise without touching elevation

5. **processGPX geometry polish** — Dan Connelly's library handles arc fitting, spline interpolation, crossing fixes, and U-turn detection. Only used for lat/lon geometry — elevation output is discarded and replaced via proportional distance interpolation from the gradient-averaged source

**Why this specific order:** Fillets must run before position smoothing (smoothing would undo the fillet arcs). processGPX must receive 1m-resampled input (sparser spacing causes arc fitting failures). Elevation must come from the gradient-averaged source (processGPX applies uniform-gradient interpolation at hairpins, destroying real profiles).

**File:** `src/pipeline/4-smooth.js`

### Step 5: Split (Physics-Based Timing)

**Purpose:** Predict ride time using a cycling power model and divide the route into equal-time splits for pacing.

**Physics model:** At each segment, solve for speed `v` satisfying the force balance:

```
P_rolling + P_gravity + P_aero = P_rider

Crr * m * g * v  +  m * g * gradient * v  +  0.5 * CdA * rho * v^3  =  watts
```

Where:
- `Crr = 0.004` (rolling resistance coefficient)
- `m` = rider mass (kg)
- `g = 9.8067 m/s^2`
- `CdA = 0.32 m^2` (drag area, default solo)
- `rho = 1.225 kg/m^3` (air density at sea level)
- `watts` = rider power (user-configurable)

The cubic equation is solved by binary search (50 iterations). Speed is clamped to [1.0, 22.2] m/s (3.6–80 km/h).

**Group drafting** uses the Blocken 2018 model: CdA reduction factors `[0.95, 0.64, 0.52, 0.45, 0.40, 0.40, 0.40, 0.40]` by row position. On climbs, draft benefit is halved since aerodynamics matter less at low speeds.

**File:** `src/pipeline/5-split.js`

---

## Simple Mode vs Expert Mode

Both modes share the same pipeline modules, chart system, and map — they use the same `index.html` entry point, toggled by a **Simple / Expert** pill in the toolbar.

Simple → Expert is always allowed. Expert → Simple is only allowed when no route is loaded (Park or clear first) — switching back mid-workflow would hide the controls you'd need. The Simple half of the pill greys out when blocked, with a tooltip explaining why.

### Simple Mode

A streamlined interface for one-click processing:

1. **Landing** — map-first view with two buttons: Create Route or Upload GPX
2. **Builder** — full-screen map with mode (Routed/Manual), profile (Car/Bike/Pedestrian), place search, undo, clear, and done controls
3. **Processing** — animated progress through LIDAR → Brunnels → Clean → Smooth with step-by-step status
4. **Review** — elevation chart + gradient overlay + map + corrections panel. Draw corrections, accept/reject, undo, download

Simple mode runs `runAutoPipeline()` which chains all steps automatically with error resilience (failed steps generate warnings, not failures).

### Expert Mode

Full 6-step pipeline with individual controls for each step:

- **Step tabs** — click through Trim, Snap, Brunnels, Clean, Smooth, Split
- **Per-step controls** — each step has its own toolbar controls (thresholds, options, action buttons)
- **Corrections panel** — resizable list with per-correction accept/reject/drag
- **Statistics** — before/after comparison (distance, ascent, max gradient, point count)
- **Rotatable focus** — elevation chart and map are both visible, with a drag handle to resize the split

---

## Route Builder

Create routes from scratch by clicking waypoints on the map.

### How It Works

1. **Click** to add a waypoint. Each new waypoint is automatically routed from the previous one via Valhalla
2. **Drag** any waypoint to reroute the adjacent segments
3. **Right-click** to delete a waypoint (adjacent segments are merged and rerouted)
4. **Click on a segment** to insert a new waypoint at that position

### Modes
- **Routed** (default) — segments follow roads via Valhalla routing (blue solid line)
- **Manual** — straight-line segments for off-road or direct connections (orange dashed line)

### Profiles
- **Car** (default) — full global road coverage including remote/mountain roads
- **Bike** — cycling-specific routing on well-mapped roads
- **Pedestrian** — walking/hiking routing, up to 100 km

### Routing flags
Two toggles control how Valhalla treats the requested route:

- **One-ways** (ON by default) — allow routing through one-way streets in either direction. ON is appropriate when retracing a recorded GPS track. Turn OFF to plan a new route that respects one-way rules.
- **Restrictions** (ON by default) — allow routing through OSM turn restrictions. Turn OFF to validate a route against turn restrictions.

These flags are shared with the Snap step and persist across reloads via localStorage.

### Exit warning

If you click "Exit Builder" with two or more waypoints placed, a confirm dialog asks before discarding the route. Click "Done" instead to keep the route and enter the pipeline.

### After "Done"

`finishRouteBuilder()` merges all segment points, deduplicates junction overlaps, and resamples to uniform 3m spacing. The result enters the processing pipeline with zero elevation (ready for LIDAR fetch).

---

## Batch Queue

Process multiple GPX files in the background simultaneously.

### How It Works

Drop 2 or more GPX files (or a zip archive) onto the upload area. Files enter the queue sorted smallest-first. The background worker processes each file through the full pipeline (Brunnels → LIDAR → Clean) one at a time.

- **Load** any ready entry to review it in the main editor — all edits are preserved when you switch
- **Park** an in-progress route to the queue at any time and resume later
- **Process** — runs the same background pipeline on all *raw* parked routes (those that have never had LIDAR run). Useful when building several routes from scratch in the editor — park each one, then process them all at once. Already-processed parked routes are skipped, so this never overwrites manual edits.
- **Download All** — exports all processed entries as a zip archive

The queue panel appears automatically when 2+ files are loaded or any entry is parked.

---

## LIDAR Elevation Server

A local Python/Flask server that fetches high-resolution LIDAR elevation data from national geographic survey services.

### Supported Countries (22)

| Country | Provider | Resolution | Protocol |
|---------|----------|-----------|----------|
| Denmark | Dataforsyningen | 0.4m | WCS 1.0.0, EPSG:25832 |
| Netherlands | PDOK | 0.5m | WCS 2.0.1 |
| Slovenia | Local VRT | 1m | Local file (rasterio) |
| France | IGN | 1m | WCS 2.0.1 |
| Germany | BKG (14 states) | 1m | WCS 2.0.1, multi-state |
| Poland | GUGiK | 1m | WCS 2.0.1 |
| Estonia | Maaamet | 1m | WCS 2.0.1 |
| Norway | Geonorge | 1m | WCS 1.0.0, EPSG:25833 |
| Great Britain | GPXZ | 1m | REST API |
| Finland | Maanmittauslaitos | 2m | WCS 2.0.1 |
| Switzerland | Swisstopo | 2m | REST API |
| Spain | MDT01/MDT02 local tiles → IGN-ES fallback | 0.5m/2m/5m | Local COG + WCS 2.0.1 |
| USA | USGS 3DEP | 1–10m | WCS 1.0.0 |
| Australia | GPXZ | 5m | REST API |
| Austria | ALS1 local tiles → DGM5 (optional) | 1m/5m | Local COG |
| Croatia | Local DTM | 20m | Local file (rasterio) |
| + Canada, Belgium, Mexico, Hong Kong, New Zealand | GPXZ | varies | REST API |

### How It Works

1. **Country detection** — `reverse_geocoder` (offline KD-tree over GeoNames) maps each point to an ISO-2 country code
2. **Run segmentation** — consecutive points in the same country form a "run" sent to one provider or provider chain
3. **BBox chunking** — WCS providers split the run into small bounding-box tiles (typically 500m per side) and fetch GeoTIFF raster tiles
4. **Raster sampling** — `rasterio` reads each tile in memory and samples elevation at each point's projected coordinates
5. **Cross-border fallback** — points where the primary provider returns nodata are retried with a neighbouring country's provider
6. **Unsupported country remapping** — points geocoded as unsupported countries are automatically reassigned to their nearest supported neighbour

### Provider Architecture

```
ElevationProvider (ABC)
    ├── WCSProvider (WCS 2.0.1 base)
    │     ├── FranceProvider
    │     ├── SpainProvider
    │     ├── NetherlandsProvider
    │     ├── EstoniaProvider
    │     ├── FinlandProvider
    │     ├── GermanyProvider (multi-state)
    │     ├── PolandProvider
    │     └── USAProvider (USGS 3DEP, WCS 1.0.0)
    ├── NorwayProvider (WCS 1.0.0)
    ├── DenmarkProvider (WCS 1.0.0 + token auth)
    ├── GPXZProvider (REST API, 512-point batches)
    ├── SloveniaProvider (local VRT file)
    └── CroatiaProvider (local GeoTIFF file)
```

---

## The Math Behind GPXForge

### Haversine Distance

The fundamental distance calculation between two GPS coordinates on the Earth's surface:

```
a = sin^2(delta_lat / 2) + cos(lat1) * cos(lat2) * sin^2(delta_lon / 2)
d = 2 * R * arcsin(sqrt(a))
```

Where `R = 6,371,000 m` (Earth's mean radius). Used everywhere — cumulative route distances, point-to-route projection, buffer calculations.

**File:** `src/utils/math.js` → `haversine()`

### Gradient Calculation

Per-segment gradient as a percentage:

```
gradient[i] = 100 * (elevation[i+1] - elevation[i]) / (distance[i+1] - distance[i])
```

**File:** `src/utils/math.js` → `grads()`

### Bearing and Turn Angle

Forward azimuth between two points:

```
y = sin(delta_lon) * cos(lat2)
x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(delta_lon)
bearing = atan2(y, x) mod 360
```

Turn angle at a vertex uses the dot product of the incoming and outgoing unit vectors. Bearing difference is collapsed to [0, 90] degrees so that opposite directions register as "aligned" (important for bridge/tunnel bearing checks).

**File:** `src/utils/math.js` → `bearing()`, `turnAngleDeg()`, `bearingDiff()`

### Cubic Hermite Interpolation

Used for bridge and tunnel elevation corrections. Given anchor elevations `e0, e1` and tangent slopes `m0, m1` at endpoints:

```
h00(t) = 2t^3 - 3t^2 + 1
h10(t) = t^3 - 2t^2 + t
h01(t) = -2t^3 + 3t^2
h11(t) = t^3 - t^2

E(t) = h00*e0 + h10*m0*S + h01*e1 + h11*m1*S
```

Where `S` is the span in metres and `t = (d - d0) / S` is the fractional position.

**File:** `src/utils/math.js` → `hermiteElevation()`

### Gaussian Smoothing

Distance-based Gaussian with trapezoid integration weights for non-uniform point spacing:

```
w[j] = exp(-(d_ij / sigma)^2 / 2) * du_j / sigma
```

Where `d_ij` is the distance between points `i` and `j`, `du_j` is the trapezoid weight, and the window extends to 4×sigma in each direction.

**File:** `src/utils/math.js` → `distGaussSmooth()`

### Fillet Corner Geometry

For a corner vertex with incoming and outgoing segments, an inscribed circle of radius `R`:

```
tangent_distance = R / tan(theta / 2)
center_distance  = R / sin(theta / 2)
sweep_angle      = -sign(cross) * (pi - theta)
```

Arc points are generated at 0.3m spacing in local Cartesian coordinates (with `cos(lat)` longitude correction), then converted back to lat/lon.

**File:** `src/utils/geometry.js` → `filletCorner()`, `findCornerClusters()`, `applyFillets()`

### Gradient Averaging (GPXmagic Algorithm)

A count-based moving average matching GPXmagic's "4-point average":

```
for each segment i:
    avg_gradient[i] = mean(gradient[i-4 .. i+4])    // 9-segment window

for each point i > 0:
    elevation[i] = elevation[i-1] + avg_gradient[i-1] * segment_distance[i-1]
```

After 1m resampling, the ±4 segment window covers ~8m of real distance. Measured effects on test data (20,119 points at ~1m spacing):
- Max gradient reduced 40% (24.7% → 14.8%)
- Total ascent reduced 8.2% (381.9m → 350.5m)
- Mean elevation error: 0.016m

**File:** `src/pipeline/4-smooth.js` → `smoothElevationsByGradient()`

### Morphological Opening (Vegetation Filter)

```
opening(f) = dilation(erosion(f, r), r)
```

- **Erosion** (sliding minimum): removes all positive peaks narrower than window radius `r`
- **Dilation** (sliding maximum): restores the baseline shape without the peaks

Uses a monotonic deque for O(n) complexity.

**File:** `src/pipeline/3.5-vegetation.js` → `slidingMin()`, `slidingMax()`, `morphOpen()`

### Triangle-Area Simplification

GPXmagic-style point reduction for smoothed routes:

1. Compute the 3D triangle area for every interior point using its two neighbours
2. Select the smallest 20% as removal candidates
3. **Adjacency filter** — never remove two consecutive points
4. **Curvature guard** — protect points where the circumscribed radius (Menger curvature) is less than 20m
5. Remove surviving candidates and repeat

**File:** `src/utils/geometry.js` → `simplifyByArea()`, `circumscribedRadius3()`

### Cycling Power-Speed Model

Force balance at each route segment:

```
F_rolling  = Crr * m * g
F_gravity  = m * g * sin(arctan(gradient))
F_aero     = 0.5 * CdA * rho * v^2

Total power = (F_rolling + F_gravity) * v + F_aero * v
```

Solved for `v` by binary search over [1.0, 22.2] m/s (50 iterations).

**Drafting model** (Blocken 2018): CdA reduction factors `[0.95, 0.64, 0.52, 0.45, 0.40, ...]` by row position ahead.

**File:** `src/pipeline/5-split.js` → `solveSpeed()`, `effectiveCdA()`, `analyzeRoute()`

### Curvature-Adaptive Snap Spacing

```
curvature_score[i] = min(sum_bearing_change / count / (pi/4), 1.0)
                     // over a ±100m window

local_spacing[i] = base_spacing * (1 - 0.65 * curvature_score[i])
```

A curvature score of 1.0 (maximum twistiness) yields 35% of base spacing; 0.0 (perfectly straight) yields 100%.

**File:** `src/pipeline/1-snap.js` → `computeCurvature()`, `buildAutoSnapIndices()`

---

## External APIs

| API | Base URL | Used For |
|-----|----------|----------|
| **Valhalla** | `valhalla1.openstreetmap.de` | Road snapping + route building (car/bike/pedestrian) |
| **Overpass** | Multiple mirrors with auto-failover | Bridge/tunnel geometry from OSM |
| **OpenTopoData** | `api.opentopodata.org` | Elevation gap-fill at trim seams |
| **Nominatim** | `nominatim.openstreetmap.org` | Place search + autocomplete |
| **LIDAR Server** | `localhost:5050` | High-res elevation (22 countries, optional) |
| **OSM Tiles** | `tile.openstreetmap.org` | Street map layer |
| **ArcGIS** | `server.arcgisonline.com` | Satellite imagery layer |

All APIs are free and public with no authentication required (the LIDAR server queries national services — some require free API keys, see server setup above).

---

## Testing

512+ unit tests covering the math, pipeline, and UI modules.

```bash
npm test              # Watch mode
npm run test:run      # Single run
```

### Test Coverage by Module

| Module | Focus |
|--------|-------|
| `utils/math.js` | Haversine, gradients, Gaussian, Hermite — numerical accuracy, edge cases |
| `utils/geometry.js` | Fillets, resampling, simplification — geometric correctness, turn angles |
| `pipeline/3-clean.js` | Spike detection, classification — known artifact profiles |
| `pipeline/4-smooth.js` | Gradient averaging, smoothing — output against expected curves |
| `pipeline/5-split.js` | Power model, drafting — physics equations at known gradients |
| `pipeline/2-brunnels.js` | Projection, bearing, overlap — OSM structure alignment |
| `pipeline/3.5-vegetation.js` | Morphological filter — canopy detection on synthetic data |
| `ui/panels.js`, `ui/shell.js` | Panel construction — DOM structure, controls |
| `chart/shared.js` | Color cache, transforms — viewport math |
| `sync.js` | Viewport/cursor pub/sub — subscription, zoom, coupled pan |

---

## Project Structure

```
gpxforge/
├── index.html                  # App shell (Simple + Expert modes)
├── package.json
├── vite.config.js
├── server/                     # Optional LIDAR elevation server (Python/Flask)
│   ├── server.py
│   ├── gpx_elevation.py
│   ├── config.example.py
│   ├── requirements.txt
│   ├── start.sh
│   └── elevation_providers/    # One module per country/provider
│
└── src/
    ├── main.js                 # App entry point (Simple + Expert unified)
    ├── state.js                # Global ST object + undo/redo history
    ├── sync.js                 # View-agnostic viewport/cursor pub/sub
    │
    ├── pipeline/               # Processing steps
    │   ├── 0-trim.js           # Route trimming
    │   ├── 1-snap.js           # Road snapping (Valhalla)
    │   ├── 1.5-overlap.js      # Start/end overlap detection + removal
    │   ├── 2-brunnels.js       # Bridge/tunnel detection (Overpass)
    │   ├── 3-clean.js          # LIDAR spike detection + correction
    │   ├── 3.5-vegetation.js   # Morphological vegetation filter
    │   ├── 3.6-source-dip-smooth.js  # Source-aware dip smoothing
    │   └── 4-smooth.js         # Fillet + gradient avg + processGPX
    │   └── 5-split.js          # Physics timing + GPX export
    │
    ├── modes/                  # App modes
    │   ├── auto-pipeline.js    # One-click processing orchestrator
    │   ├── batch-pipeline.js   # Multi-file background queue
    │   └── route-builder.js    # Click-to-create route builder
    │
    ├── api/                    # External API clients
    │   ├── valhalla.js         # Valhalla routing
    │   ├── overpass.js         # Overpass with mirror fallback
    │   ├── opentopodata.js     # Elevation gap-fill
    │   ├── lidar.js            # LIDAR server client
    │   └── place-search.js     # Nominatim geocoding
    │
    ├── chart/                  # Canvas-based charts
    │   ├── index.js            # Orchestrator
    │   ├── shared.js           # Coord transforms, color cache
    │   ├── elevation.js        # Elevation profile (11-layer canvas)
    │   └── gradient.js         # Gradient overlay
    │
    ├── map/                    # Leaflet map
    │   ├── index.js            # Map orchestrator
    │   ├── setup.js            # Tile layers, layer groups
    │   └── layers.js           # Route, markers, corrections, brunnels
    │
    ├── ui/                     # DOM construction
    │   ├── shell.js            # Layout, file loading, upload handling
    │   ├── toolbar.js          # Undo/redo/download toolbar
    │   ├── sidebar.js          # Step navigation
    │   ├── panels.js           # Step control panels
    │   ├── batch-ui.js         # Batch queue panel
    │   ├── corrections.js      # Corrections list panel
    │   ├── mode.js             # Simple/Expert mode toggle + persistence
    │   └── toast.js            # Toast notification system
    │
    ├── utils/                  # Pure functions
    │   ├── math.js             # Haversine, bearing, Gaussian, Hermite
    │   ├── geometry.js         # Fillets, resampling, simplification
    │   ├── gpx.js              # GPX parsing + serialization
    │   ├── resolution.js       # Country detection + LIDAR densification
    │   ├── download-name.js    # Download filename generation
    │   └── format.js           # Number/time/distance formatting
    │
    ├── lib/
    │   └── processGPX/
    │       └── process-gpx.js  # Dan Connelly's geometry library (6,366 lines)
    │
    └── styles/
        ├── base.css            # CSS variables, reset, typography
        ├── layout.css          # Grid layout, topbar, panels
        ├── chart.css           # Chart canvas styles
        ├── map.css             # Leaflet overrides
        ├── components.css      # Buttons, inputs, controls
        └── steps.css           # Step panels + batch queue

tests/
└── unit/                       # 512+ Vitest unit tests
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Vanilla JavaScript (ES6+) |
| Maps | Leaflet 1.9.4 (OSM streets + ArcGIS satellite) |
| Routing | Valhalla (car default, bike + pedestrian options) |
| Elevation | LIDAR server (22 countries, optional) + OpenTopoData fallback |
| Structures | Overpass API (OSM bridges/tunnels) |
| Geocoding | Nominatim (OpenStreetMap) |
| Fonts | Inter + IBM Plex Mono (Google Fonts) |
| Build | Vite 6 |
| Tests | Vitest 3 |

---

## License

[MIT](LICENSE)
