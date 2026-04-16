# GPXForge Gotchas

This file tracks known behavior quirks, dead ends, and practical guardrails.

## Backend Runtime Guardrail

- Always run backend via `server/start.sh` (or repo `start-gpxforge.bat` which calls it).
- Do not rely on system Python package state for server/tooling commands.
- `start.sh` is the source of truth for backend runtime:
  - creates/uses `server/.venv`
  - installs `requirements.txt` on hash change
  - verifies required modules (including tile-index deps like `pyshp`)
  - uses PID-file ownership to stop only GPXForge backend instance

## Austria Tile Discovery Guardrail

- Austria tile mode can bootstrap index metadata from `data.gv.at` (CKAN) when local index files are missing.
- For security, downloads are restricted by `AUSTRIA_TILE_URL_ALLOWLIST` (default `data.bev.gv.at,bev.gv.at`).
- If CKAN metadata or allowed download hosts are unavailable, Austria chain may return missing values for unresolved AT points until coverage/index is fixed.

## Slovenia Local Data Guardrail

- Default local Slovenia path is `server/data/slovenia/slovenia_1m.vrt`.
- If local Slovenia data must be mandatory, set `SLOVENIA_REQUIRE_LOCAL=1` to disable ARSO fallback.
- This avoids hidden provider switching on border routes (`SI -> AT -> SI`) when local path is misconfigured.

## Snap Reroute Elevation Drift (Fixed on master)

### Symptom (historical)
- Auto-snap elevation transfer looked correct.
- After manual reroute in Snap step (add/delete waypoint), elevation profile could drift.

### Root cause
- Manual reroute transfer passed only `origIndices` into `transferElevations(...)`.
- Without matching `newIndices`, transfer fell back to full-route proportional mapping, which accumulates drift on edited geometry.

### Fix now in master
- Manual reroute paths remap waypoint anchors on both:
  - original pre-snap route, and
  - rerouted (and densified) route.
- `transferElevations(...)` now receives both `origIndices` and `newIndices` so transfer stays segment-anchored after post-snap edits.

### Release guardrail
- Keep anchor mapping logic shared/consistent between:
  - initial auto-snap commit,
  - add-waypoint reroute,
  - delete-waypoint reroute.

## Snap Elevation Transfer Gotchas (Technical)

### How transfer works (current implementation)
- `transferElevations(...)` in `src/pipeline/1-snap.js` maps elevation by cumulative-distance interpolation.
- Preferred mode is segment-anchored mapping:
  - original segment bounded by `origIndices[a..a+1]`
  - snapped segment bounded by `newIndices[a..a+1]`
  - inside each segment, distance fraction is preserved and elevation is linearly interpolated on original elevations.
- Fallback mode (when anchors are missing) is whole-route proportional mapping.

### Why segment anchors matter
- Whole-route proportional mapping accumulates phase drift over long tracks and after manual reroute edits.
- Segment-anchored mapping bounds mismatch to each waypoint segment instead of the full route.
- In practice this prevents the "profile looks shifted after reroute" behavior.

### Densify order is critical
- Correct order:
  1. merge routed geometry
  2. densify snapped geometry
  3. remap waypoint anchors to densified indices
  4. run `transferElevations(...)`
- Wrong order (transfer first, densify later) smears elevation detail by linear interpolation between sparse routed points.

### Non-obvious failure modes to watch
- Missing `newIndices` silently triggers whole-route fallback.
- Anchor arrays with different cardinality/order produce local kinks at segment boundaries.
- Any future change to `mergeSegments(...)` junction behavior must keep `wpIndices` semantics stable.
- If waypoint remap tolerance is changed in `mapWaypointsToDensified(...)`, verify anchor matching still lands on original preserved vertices.

## Loop + Overlap Status (Current)

### What works
- Reverse-overlap canonicalization is useful for many clean out-and-back cases.
- Start/finish overlap trim safety net is stable and low risk.
- Core elevation pipeline (LIDAR -> clean -> smooth -> export) remains the primary reliable value path.

### What does not reliably work yet
- Deterministic lollipop loop insertion for all turnaround/intersection combinations.
- Perfect turnaround loop anchoring on complex intersections after full smoothing pipeline transforms.
- Threshold-only tuning that avoids both:
  - false positives (sideways/branch-attached loops), and
  - false negatives (valid turnarounds skipped).

### Why this is hard in current pipeline
- Geometry changes in multiple stages (fillet/resample/smooth/process/post-overlap).
- Turnaround semantics drift across stages, so early anchors can map to wrong final branch.
- Tight thresholds reduce bad loops but increase missed loops.
- Loose thresholds insert more loops but allow wrong placement.

## Dead-End Branch Note

The branch `codex/overlap-canonicalization` is considered a research/dead-end branch for loop insertion reliability.

### Practical merge guidance
- Do not merge loop insertion experiments from that branch into `master` as-is.
- Keep overlap safety behavior conservative.
- Protect core export correctness and elevation quality first.

## Hairpin / Geometry Mismatch Watchlist

Observed in testing:
- In some scenarios, visual/editing behavior can appear smoother than exported geometry.
- Exported GPX is authoritative; any preview-vs-export mismatch must be treated as a release blocker.

Recommended check before release:
1. Compare rendered green route vs downloaded GPX on tight hairpins.
2. Confirm min-radius intent survives final export path.
3. Verify no hidden alternate geometry path is used for chart interactions only.

## Scope Boundary (Release)

- GPXForge release scope keeps overlap handling conservative (safety trim + basic canonicalization only).
- Deterministic turnaround/lollipop perfection and all overlap beautification are out of scope for the release pipeline.
- Final overlap/loop polishing should be done in dedicated geometry tools (for example GPXmagic) after GPXForge export.
- Rationale: repeated attempts showed high regression risk to the core elevation/export pipeline.

## Barometric Lag Offset (Not Implemented)

- Head-unit barometric elevation lag is real, but the lag is not constant over a route.
- In the same file the effective shift can vary from ~0m to ~70m depending on terrain and dynamics.
- A single global distance offset (for example "shift elevation 50m back") is therefore unreliable and can improve one section while degrading another.
- Decision: do not add a global barometric offset stage to GPXForge pipeline.

## Priority Policy

1. Core objective: correct elevation profile and trustworthy export.
2. Overlap/turnaround edge-case beautification: only ship when it cannot degrade #1.
