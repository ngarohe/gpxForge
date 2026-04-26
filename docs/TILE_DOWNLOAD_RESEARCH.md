# Tile Download Research (Spain + Other 5m/10m Countries)

Last updated: 2026-04-13

## Implementation Status (Current Repo)
- Spain chain is implemented in backend: `MDT01 -> MDT02 -> ES WCS 5m`.
- Austria chain is implemented in backend: `AT ALS1 local tile index -> AT DGM5 local tile index`.
- Austria target chain (best-first policy): `AT ALS-DGM 1m local tiles -> AT DGM5 local tiles`.
- Austria tile ingestion is opt-in and supports dynamic catalog bootstrap:
  - if Austria index files are missing, backend can auto-discover tile metadata from `data.gv.at` CKAN and persist local index JSON,
  - then download required tiles on demand.
- Austria index format matches Spain tile index:
  - `{"tiles":[{"id":"tile_name","bbox":[lon_min,lat_min,lon_max,lat_max],"path":"relative/local.tif","url":"optional-download-url"}]}`
- Index tooling added:
  - `server/tools/build_tile_index.py` (generic local GeoTIFF -> index builder)
  - `server/tools/build_tile_index_from_shp_zip.py` (generic SHP/ZIP coverage -> index builder)
  - `server/tools/build_austria_als1_index.py` (Austria ALS1 wrapper with defaults)
  - `server/tools/build_austria_dgm5_index.py` (Austria wrapper with defaults)
- Austria wrappers support `--coverage-zip` so BEV SHP/ZIP footprints can be imported directly (no manual tile-index editing).
- Downloader hardening added for catalog tile providers: if a tile URL returns ZIP bytes, GPXForge extracts the first `.tif/.tiff` and stores it as the tile path.

## Goal
Design a backend flow where GPXForge can:
1. Accept GPX upload.
2. Auto-resolve needed elevation tiles for route bbox.
3. Download missing tiles.
4. Store them locally (persistent tile store, not temporary cache).
5. Sample elevations from local tiles.
6. Fall back to existing provider flow when needed.

This plan targets the backend project (`C:\Users\Mitja\GPX Lidar download`) and keeps frontend changes minimal.

## Confirmed Findings

### Spain (critical)
- Public IDEE WCS / OGC API Coverages endpoints currently expose 5m max for national MDT coverage, not 1m.
- Spain MDT05 is clearly documented as a 5m terrain grid.
- Spain MDT01 (0.5m COG) exists in CNIG download catalog, but coverage is published progressively and is download-catalog based.
- Spain MDT02 (2m COG) is available in CNIG catalog, but CNIG marks it as "Cobertura por completar" (coverage still incomplete).

Implication:
- Current GPXForge behavior (ES=5m) is consistent with active API coverages.
- To get sub-5m where available, add a second path using MDT01 tile ingestion.
- Spain fallback should be explicit and ordered: `MDT01 -> MDT02 -> ES WCS 5m`.

### Other countries with coarse defaults in GPXForge
- Austria: BEV provides ALS-DGM 1m terrain raster (DTM) and legacy/older DGM 5m products.
- Australia: national LiDAR-derived DEM service is 5m (compiled/resampled from available higher-res inputs).
- Mexico: INEGI portal shows 15-120m CEM and higher-res MDE options (including 5m and 1.5m in the portal UI), but automated API-style endpoints for full GPX pipeline use need provider-specific validation.

Implication:
- The same tile-store architecture is reusable.
- Country adapters differ by access method and licensing constraints.

## Proposed Architecture (Persistent Tile Store)

### 1) Tile Store (not ephemeral cache)
- Root folder: `server/data/tiles/<country>/<dataset>/<tile_id>.tif`
- Metadata DB (SQLite): `server/data/tiles/index.db`
- Tables:
  - `tiles(tile_id, country, dataset, source_url, etag, checksum, bbox, resolution_m, crs, status, bytes, downloaded_at, last_used_at, pin)`
  - `tile_runs(run_id, gpx_hash, country, dataset, tiles_used, created_at)`
- States: `missing`, `downloading`, `ready`, `failed`, `stale`.
- Deletion policy: manual only (no auto-delete by default). Optional purge command for non-pinned tiles.

### 2) Provider Adapter Layer
- Keep current provider adapters (WCS/REST/local).
- Add optional `tile_adapter` per country:
  - `resolve_tiles_for_bbox(bbox, resolution_target)`
  - `download_tile(tile_id)`
  - `sample_points(points)`
- Spain first adapter candidate: `ES_MDT01`.

### 3) Runtime Decision Flow
1. Parse GPX and split by country runs.
2. For each run:
   - For Spain, try datasets in strict order: `ES_MDT01`, then `ES_MDT02`.
   - Ensure required tiles are local (download missing).
   - Sample points from local tiles.
   - For uncovered Spain points after MDT01/MDT02, fallback to `ES_WCS_5M`.
3. Merge elevations and return standard GPX response.

### 4) Operations Endpoints (backend)
- `GET /api/tile-store/stats` (disk usage, tile count, by country/dataset)
- `GET /api/tile-store/list?country=ES&dataset=MDT01`
- `POST /api/tile-store/pin` (tile ids or bbox set)
- `POST /api/tile-store/purge` (manual only, dry-run supported)

### 5) Security and Stability Guardrails
- Strict URL allowlist per provider host.
- No user-controlled filesystem paths.
- Download size cap and timeout per tile.
- Validate GeoTIFF before indexing (CRS, bounds, nodata metadata).
- Checksum/etag tracking to detect partial/corrupt files.
- Concurrency limits and retry backoff.
- Full audit logging of tile fetch and source fallback decisions.

## Implementation Plan

### Phase A: Spain feasibility hardening
- Build `ES_MDT01` adapter behind feature flag.
- Build `ES_MDT02` adapter as direct fallback.
- Add tile index builder (from provider metadata/catalog).
- Test with small known routes in areas with known MDT01 coverage and areas with only MDT02 availability.
- Validate exact source traces in response headers:
  - `X-Elevation-Source: ES_MDT01_LOCAL | ES_MDT02_LOCAL | ES_WCS_5M | MIXED`

### Phase B: Productionizing tile store
- Add SQLite manifest, pin/purge tools, and health checks.
- Add observability counters:
  - tile hit ratio
  - missing tile rate
  - fallback rate
  - download failure rate

### Phase C: Extend to other coarse countries
- Austria adapter: implemented as index-driven chain `ALS-DGM 1m -> DGM 5m`; next step is BEV-specific auto-index/discovery tooling.
- Australia adapter candidate (5m national service remains baseline).
- Mexico adapter candidate only after endpoint/legal automation confirmation.

### Phase D: Post-clean targeted local smoothing for MDT02/MDT05
- Add a dedicated micro-smoothing pass after Clean (and after Vegetation filter), before Smooth step.
- Scope: only small-to-medium dips that cleaner misses on 2m/5m terrain products.
- Trigger by LIDAR source metadata from backend:
  - apply profile `MDT02` when source is MDT02,
  - apply profile `MDT05` when source is MDT05,
  - skip for MDT01/1m and unknown source.
- Required backend metadata:
  - route-level source header at minimum (`X-Elevation-Source`),
  - preferred: per-point source mask for mixed runs (`MDT01/MDT02/MDT05/WCS`).

#### Candidate detection (targeted, not global)
- Detect valley-like windows with constraints:
  - width in meters (bounded),
  - depth versus local anchor baseline,
  - moderate entry/exit slopes (below cleaner spike threshold),
  - non-brunnel area and not user-locked correction zones.
- Exclude obvious real terrain:
  - long monotonic climbs/descents,
  - broad natural valleys beyond width/depth limits.

#### Correction method
- Apply local Gaussian/Hermite blend only inside candidate windows.
- Preserve anchor elevations at window edges.
- Use cosine taper at edges to avoid seams.
- Hard cap max adjustment per window to prevent terrain flattening.

#### Source-specific default profiles (initial)
- `MDT02` (2m, milder):
  - width: 8-22m
  - depth: 1.0-4.0m
  - sigma: 3.0m
  - edge taper: 4m
  - max correction: 2.5m
- `MDT05` (5m, stronger):
  - width: 10-28m
  - depth: 1.5-5.0m
  - sigma: 4.5m
  - edge taper: 6m
  - max correction: 3.5m

#### Safety + rollout
- Feature flag: `SOURCE_AWARE_LOCAL_DIP_SMOOTHING`.
- First release in Expert mode with visual logging (count, total corrected meters, source profile used).
- Add before/after diagnostics in console and optional debug overlay.

#### Test plan
- Unit tests on synthetic dips:
  - catches 10-20m / ~3m dips,
  - does not over-smooth real ramps/hairpins.
- Regression tests:
  - no change on MDT01/1m routes,
  - no conflicts with brunnel corrections,
  - no shift in total ascent beyond tolerance.

## Country Feasibility Matrix (Current)

| Country | GPXForge current baseline | High-res tile path | Feasibility now | Notes |
|---|---|---|---|---|
| Spain | 5m | MDT01 (0.5m COG) + MDT02 (2m COG fallback) | Medium | Both MDT01 and MDT02 are marked with incomplete coverage; keep WCS 5m final fallback |
| Austria | 10m in GPXForge config (historical) | BEV ALS-DGM 1m (DTM) + DGM 5m fallback | Medium | Best-first chain implemented (index-driven): ALS 1m -> DGM5 |
| Australia | 5m | National service is already 5m | Low for national 1m | 1m is not a single national endpoint |
| Mexico | 5m in GPXForge config (historical) | INEGI higher-res portal options | Unknown/Medium | Confirm automatable endpoints before coding |

## Notes For Future Work
- Do not assume that "LiDAR exists" means a public API exposes 1m.
- Separate concepts:
  - sampling API resolution
  - downloadable tile resolution
  - route point spacing (1m densification)
- Keep fallback chain explicit and observable; never silently degrade without trace headers.

## Source Links
- CNIG web services overview (WCS + OGC API):  
  https://centrodedescargas.cnig.es/CentroDescargas/servicios-web
- Spain OGC API Coverages collections (shows 5m/25m/200m/500m/1000m):  
  https://api-coverages.idee.es/collections?f=html
- Spain 5m collection example (OGC API Coverages):  
  https://api-coverages.idee.es/collections/EL.ElevationGridCoverage_4258_5_PB
- Spain MDT05 catalog page (5m COG):  
  https://centrodedescargas.cnig.es/CentroDescargas/modelo-digital-terreno-mdt05-primera-cobertura
- Spain MDT01 catalog page (0.5m COG):  
  https://centrodedescargas.cnig.es/CentroDescargas/index.jsp%2821/05/modelo-digital-terreno-mdt01
- Spain MDT02 catalog page (2m COG, coverage in progress):  
  https://centrodedescargas.cnig.es/CentroDescargas/modelo-digital-terreno-mdt02-segunda-cobertura
- Austria BEV ALS-DGM 1m (DTM) product page:  
  https://www.bev.gv.at/Services/Produkte/Digitales-Gelaendehoehenmodell/ALS-Hoehenraster.html
- Austria BEV DGM (legacy 5m standard raster) page:  
  https://www.bev.gv.at/Services/Produkte/Digitales-Gelaendehoehenmodell/Hoehenraster.html
- Austria OGD DGM dataset listing (10m Geoland historical dataset):  
  https://www.data.gv.at/katalog/de/dataset/dgm
- Australia 5m DEM WCS service listing:  
  https://researchdata.edu.au/digital-elevation-model-grid-wcs/3426741
- Mexico INEGI elevation portal (CEM + MDE options):  
  https://www.inegi.org.mx/app/geo2/elevacionesmex/
