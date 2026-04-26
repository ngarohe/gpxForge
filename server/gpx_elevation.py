#!/usr/bin/env python3
"""
GPX Hi-Res LIDAR Elevation Tool — CLI
Usage: python gpx_elevation.py input.gpx output.gpx
"""
import asyncio
import math
import sys
from typing import List, Tuple, Dict, Optional

from config import SUPPORTED_COUNTRIES
from gpx_parser import parse_gpx, write_gpx
from country_detector import detect_countries, group_points_by_country
from elevation_providers import (
    FranceProvider, SwitzerlandProvider, SloveniaProvider,
    SpainProvider, NetherlandsProvider, GPXZProvider, CroatiaProvider,
    NorwayProvider, FinlandProvider, USAProvider, EstoniaProvider, DenmarkProvider,
    GermanyProvider, PolandProvider, SpainMDT01Provider, SpainMDT02Provider,
    AustriaALS1Provider, AustriaDGM5Provider,
)
from elevation_providers.base import ElevationProvider, ElevationError


# ── Resample helpers ─────────────────────────────────────────────────

LOCAL_RESAMPLE_M = 1.0   # local providers: resample to 1m before querying


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance in metres between two lat/lon points."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _build_cumulative_distances(points: List[Tuple[float, float]]) -> List[float]:
    dists = [0.0]
    for i in range(1, len(points)):
        d = _haversine_m(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
        dists.append(dists[-1] + d)
    return dists


def _interpolate_back(
    run_pts: List[Tuple[float, float]],
    query_pts: List[Tuple[float, float]],
    query_elevations: List[Optional[float]],
) -> List[Optional[float]]:
    """Interpolate elevations from resampled query_pts back to original run_pts.

    Uses cumulative haversine distance along each point set as the common axis,
    so irregular spacing in either set is handled correctly.
    """
    import numpy as np

    run_dists = _build_cumulative_distances(run_pts)
    query_dists = _build_cumulative_distances(query_pts)

    # Filter to valid (non-None) query samples
    valid_dists: List[float] = []
    valid_eles: List[float] = []
    for d, e in zip(query_dists, query_elevations):
        if e is not None:
            valid_dists.append(d)
            valid_eles.append(e)

    if not valid_dists:
        return [None] * len(run_pts)

    # np.interp clamps at boundary values — fine since run and query cover the same segment
    interpolated = np.interp(
        np.array(run_dists),
        np.array(valid_dists),
        np.array(valid_eles),
    )
    return interpolated.tolist()


def _resample_to_spacing(
    points: List[Tuple[float, float]], spacing_m: float
) -> List[Tuple[float, float]]:
    """Resample a list of (lat, lon) points to uniform spacing via linear interpolation."""
    if len(points) < 2:
        return list(points)
    dists = _build_cumulative_distances(points)
    total = dists[-1]
    if total == 0:
        return list(points)
    n_pts = max(2, round(total / spacing_m) + 1)
    out: List[Tuple[float, float]] = []
    seg = 0
    for i in range(n_pts):
        d = total if i == n_pts - 1 else i * total / (n_pts - 1)
        while seg < len(points) - 2 and dists[seg + 1] < d:
            seg += 1
        seg_len = dists[seg + 1] - dists[seg]
        t = max(0.0, min(1.0, (d - dists[seg]) / seg_len)) if seg_len > 0 else 0.0
        lat = points[seg][0] + t * (points[seg + 1][0] - points[seg][0])
        lon = points[seg][1] + t * (points[seg + 1][1] - points[seg][1])
        out.append((lat, lon))
    return out


def _sanitize_elevation(value: Optional[float]) -> Optional[float]:
    """Filter impossible/sentinel elevation values from providers."""
    if value is None:
        return None
    try:
        z = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(z):
        return None
    # Keep realistic Earth elevations; discard common nodata sentinels.
    if z <= -1000 or z >= 10000:
        return None
    return z


# ── Providers ────────────────────────────────────────────────────────

SPAIN_MDT01_PROVIDER = SpainMDT01Provider()
SPAIN_MDT02_PROVIDER = SpainMDT02Provider()
SPAIN_WCS_PROVIDER = SpainProvider()
AUSTRIA_ALS1_PROVIDER = AustriaALS1Provider()
AUSTRIA_DGM5_PROVIDER = AustriaDGM5Provider()


def _gpxz_for(country_code: str) -> GPXZProvider:
    return GPXZProvider(country_code=country_code)

PROVIDERS: Dict[str, ElevationProvider] = {
    'FR': FranceProvider(),       # REST, 1m, confirmed working
    'CH': SwitzerlandProvider(),  # REST profile, 2m, confirmed working
    'SI': SloveniaProvider(),     # local VRT, 1m
    'ES': SPAIN_WCS_PROVIDER,     # WCS 2.0.1, 5m, final ES fallback
    'NL': NetherlandsProvider(),  # WCS 2.0.1, 0.5m, confirmed working
    'GB': GPXZProvider(),         # GPXZ REST, hi-res (≤5m) for GB + NL fallback
    'CA': GPXZProvider(),         # GPXZ REST, hi-res for Canada
    'HR': CroatiaProvider(),      # local GeoTIFF, 20m (Sonny's DTM)
    'NO': NorwayProvider(),       # WCS 1.0.0, 1m, Geonorge
    'FI': FinlandProvider(),      # WCS 2.0.1, 2m, Maanmittauslaitos
    'DE': GermanyProvider(),       # Multi-state WCS 2.0.1, 1m DGM
    'PL': PolandProvider(),       # GUGiK WCS 2.0.1, 1m DTM
    'US': USAProvider(),          # USGS 3DEP WCS 1.0.0, 1-10m
    'EE': EstoniaProvider(),      # WCS 2.0.1, 1m, Maaamet
    'DK': DenmarkProvider(),      # WCS 1.0.0, 0.4m DHM Terræn
    'AT': AUSTRIA_ALS1_PROVIDER,  # Austria uses ALS1->DGM5 chain (no GPXZ)
    'BE': GPXZProvider(),         # GPXZ REST, 1-20m
    'AU': GPXZProvider(),         # GPXZ REST, 5m
    'MX': GPXZProvider(),         # GPXZ REST, 5m
    'HK': GPXZProvider(),         # GPXZ REST, 50cm
    'NZ': GPXZProvider(),         # GPXZ REST, New Zealand
}

# Use dedicated GPXZ provider instances per country so source tags are accurate.
PROVIDERS['GB'] = _gpxz_for('GB')
PROVIDERS['CA'] = _gpxz_for('CA')
PROVIDERS['BE'] = _gpxz_for('BE')
PROVIDERS['AU'] = _gpxz_for('AU')
PROVIDERS['MX'] = _gpxz_for('MX')
PROVIDERS['HK'] = _gpxz_for('HK')
PROVIDERS['NZ'] = _gpxz_for('NZ')

# Country-specific provider chains for tile-first workflows.
# Countries not listed here use PROVIDERS[cc] directly.
COUNTRY_PROVIDER_CHAINS: Dict[str, List[Tuple[str, ElevationProvider]]] = {
    'ES': [
        ('ES MDT01', SPAIN_MDT01_PROVIDER),
        ('ES MDT02', SPAIN_MDT02_PROVIDER),
        ('ES WCS', SPAIN_WCS_PROVIDER),
    ],
    'AT': [
        ('AT ALS1', AUSTRIA_ALS1_PROVIDER),
        ('AT DGM5', AUSTRIA_DGM5_PROVIDER),
    ],
}

# Adjacency map: country → neighbors that have providers.
# Used for cross-border fallback when a point geocodes to one country
# but falls outside that country's raster coverage.
NEIGHBOR_COUNTRIES: Dict[str, List[str]] = {
    # Western Europe
    'FR': ['ES', 'CH', 'GB', 'NL', 'DE', 'BE'],
    'ES': ['FR'],
    'CH': ['FR', 'DE', 'AT', 'SI'],
    'NL': ['FR', 'GB', 'DE', 'BE'],
    'GB': ['FR', 'NL'],
    'BE': ['FR', 'DE', 'NL'],
    'DE': ['FR', 'CH', 'AT', 'NL', 'BE', 'DK', 'PL'],
    # Prefer SI first for AT fallback; SLO-AT border routes are common and this avoids
    # expensive dead-end calls to CH/DE before the actual resolving provider.
    'AT': ['SI', 'DE', 'CH'],
    'DK': ['DE'],
    # Central / Eastern Europe
    # Prefer AT first for SI border nodata to minimize timeout-heavy fallback hops.
    # SI does not border CH, so avoid that dead-end request.
    'SI': ['AT', 'HR'],
    'HR': ['SI'],
    'PL': ['DE', 'CZ', 'SK'],
    'EE': ['FI'],
    # Scandinavia
    'NO': ['FI'],
    'FI': ['NO', 'EE'],
    # Americas
    'CA': ['US'],
    'US': ['CA', 'MX'],
    'MX': ['US'],
    # No supported neighbours (yet)
    'AU': [],
    'HK': [],
    'NZ': [],
    # Unsupported countries — border points reassigned to supported neighbours
    'IT': ['AT', 'SI', 'FR', 'CH'],
    'PL': ['DE', 'CZ', 'SK'],
    'CZ': ['DE', 'AT', 'PL'],
    'SK': ['AT', 'PL'],
    'LU': ['DE', 'FR', 'BE'],
    'LI': ['CH', 'AT'],
    'SE': ['NO', 'FI', 'DK'],
    'HU': ['HR', 'AT'],
    'BA': ['HR'],
    'RS': ['HR'],
    'ME': ['HR'],
}


def _is_wcs_like(provider) -> bool:
    from elevation_providers.wcs_base import WCSProvider
    return isinstance(provider, WCSProvider) or type(provider).__name__ in ('GermanyProvider', 'PolandProvider')


def _provider_display(provider) -> str:
    """Short display name for a provider, e.g. 'NL WCS', 'GPXZ', 'AT TILE'."""
    if type(provider).__name__ == 'GPXZProvider':
        return 'GPXZ'
    if _is_wcs_like(provider):
        return f"{provider.country_code} WCS"
    if getattr(provider, 'dataset_code', ''):
        return f"{provider.country_code} TILE"
    return f"{provider.country_code} REST"


def _gpxz_source_str(provider) -> str:
    """Format GPXZ verbose_log {(source, res): count} into a table source string."""
    log = getattr(provider, '_verbose_log', None)
    if not log:
        return '—'
    parts = [f"{src} ({res}m): {cnt}" for (src, res), cnt in sorted(log.items())]
    return ' | '.join(parts)


def _wcs_source_str(provider, failed: bool) -> str:
    """Format WCS source string with optional FAILED annotation."""
    cov = getattr(provider, 'coverage_id', '—')
    if failed:
        return f"{cov} (FAILED: all nodata)"
    return cov


def _tile_source_str(provider) -> str:
    """Format tile-provider verbose metadata."""
    log = getattr(provider, "_verbose_log", None)
    if not log:
        return "local tiles"
    dataset = log.get("dataset", type(provider).__name__)
    used = log.get("used_tiles", 0)
    resolved = log.get("resolved", 0)
    downloaded = log.get("downloaded", 0)
    seam_retry = log.get("seam_retry_resolved", 0)
    return (
        f"{dataset}: resolved={resolved}, tiles={used}, "
        f"downloaded={downloaded}, seam_retry={seam_retry}"
    )


def _provider_source_tag(provider) -> str:
    """Stable source tag for per-point metadata."""
    explicit = getattr(provider, "_source_tag", "")
    if explicit:
        return explicit
    name = type(provider).__name__
    dataset_code = getattr(provider, 'dataset_code', '')
    if dataset_code:
        return dataset_code
    if name == "SpainProvider":
        return "ES_WCS_5M"
    if name == "GPXZProvider":
        return f"{provider.country_code}_GPXZ"
    if _is_wcs_like(provider):
        return f"{provider.country_code}_WCS"
    return f"{provider.country_code}_REST"


def _source_str_for_provider(provider, label: str, resolved_now: int) -> str:
    if _is_wcs_like(provider):
        src_str = _wcs_source_str(provider, failed=(resolved_now == 0))
        _print_wcs_chunk_details(provider, label)
        return src_str
    if getattr(provider, 'dataset_code', ''):
        return _tile_source_str(provider)
    if type(provider).__name__ == 'GPXZProvider':
        return _gpxz_source_str(provider)
    return _gpxz_source_str(provider)


async def _query_provider_chain(
    run_pts: List[Tuple[float, float]],
    chain: List[Tuple[str, ElevationProvider]],
    source_records: Optional[list] = None,
    verbose: bool = False,
) -> Tuple[List[Optional[float]], List[str]]:
    """Resolve elevations via a country-specific provider chain."""

    out: List[Optional[float]] = [None] * len(run_pts)
    out_source: List[str] = [""] * len(run_pts)
    unresolved: List[int] = list(range(len(run_pts)))

    for step_i, (label, provider) in enumerate(chain):
        if not unresolved:
            break

        batch = [run_pts[i] for i in unresolved]
        step_error = None
        if verbose:
            provider.verbose = True
        try:
            result = await provider.get_elevations(batch)
        except ElevationError as e:
            step_error = str(e)
            if step_i == len(chain) - 1:
                raise
            if verbose:
                print(f"    [{label}] failed: {e} -> continuing fallback chain")
            result = [None] * len(batch)
        finally:
            if verbose:
                provider.verbose = False

        resolved_now = 0
        next_unresolved: List[int] = []
        source_tag = _provider_source_tag(provider)
        for idx, val in zip(unresolved, result):
            val = _sanitize_elevation(val)
            if val is None:
                next_unresolved.append(idx)
                continue
            out[idx] = val
            out_source[idx] = source_tag
            resolved_now += 1
        unresolved = next_unresolved

        if verbose and source_records is not None:
            src_str = _source_str_for_provider(provider, label, resolved_now)
            if step_error:
                src_str = f"{src_str} | ERROR: {step_error}"
            source_records.append({
                "label": label,
                "points": resolved_now,
                "resolution": provider.resolution,
                "source": src_str,
            })

    return out, out_source


def _print_source_table(source_records: list) -> None:
    """Print the === Elevation Sources === summary table."""
    print("\n=== Elevation Sources ===")
    header = ("Provider", "Points", "Resolution", "Source")
    rows = [header]
    total_pts = 0
    for rec in source_records:
        rows.append((
            rec['label'],
            str(rec['points']),
            f"{rec['resolution']}m",
            rec['source'],
        ))
        total_pts += rec['points']
    rows.append(("Total", str(total_pts), "", ""))

    # Column widths (min 6 per col for readability)
    widths = [max(6, max(len(r[i]) for r in rows)) for i in range(4)]
    sep = "  " + "-" * (widths[0] + widths[1] + widths[2] + widths[3] + 11)

    for i, row in enumerate(rows):
        if i == 0:
            line = (f"  {row[0]:<{widths[0]}} | {row[1]:>{widths[1]}} "
                    f"| {row[2]:<{widths[2]}} | {row[3]}")
            print(line)
            print(sep)
        elif i == len(rows) - 1:
            # Total row — omit resolution/source columns
            print(f"  {row[0]:<{widths[0]}} | {row[1]:>{widths[1]}}")
        else:
            line = (f"  {row[0]:<{widths[0]}} | {row[1]:>{widths[1]}} "
                    f"| {row[2]:<{widths[2]}} | {row[3]}")
            print(line)


def _print_wcs_chunk_details(provider, label: str) -> None:
    """Print per-chunk bbox/TIFF stats from a WCS provider's verbose log."""
    log = getattr(provider, '_verbose_log', None)
    if not log:
        return
    n = len(log)
    for entry in log:
        xmin, ymin, xmax, ymax = entry['bbox']
        shape = entry.get('shape', '?')
        bounds = entry.get('bounds', '?')
        ds_nd = entry.get('ds_nodata')
        rmin = entry.get('raster_min')
        rmax = entry.get('raster_max')
        resolved = entry['resolved']
        print(f"    [{label}] chunk {entry['chunk']}/{n}: "
              f"bbox=({xmin:.0f},{ymin:.0f},{xmax:.0f},{ymax:.0f}) "
              f"→ {resolved} resolved")
        print(f"      URL: {entry['url']}")
        print(f"      TIFF: shape={shape}  bounds={bounds}")
        nd_str = f"{ds_nd:.4g}" if ds_nd is not None else "None"
        min_str = f"{rmin:.4g}" if rmin is not None else "?"
        max_str = f"{rmax:.4g}" if rmax is not None else "?"
        print(f"      nodata={nd_str}  raster min={min_str}  max={max_str}")


async def _try_fallback_batch(
    nodata_entries: List[Tuple[int, Tuple[float, float], str]],
    source_records: Optional[list] = None,
    verbose: bool = False,
) -> Tuple[Dict[int, float], Dict[int, str]]:
    """Try neighboring country providers for points that got nodata.

    nodata_entries: list of (original_index, (lat, lon), assigned_country_code)
    source_records: if provided (and verbose), fallback hits are appended here.
    Returns: dict mapping original_index → elevation for points that got resolved.
    """
    resolved: Dict[int, float] = {}
    resolved_source: Dict[int, str] = {}

    # Group nodata points by assigned country, then try each neighbor
    by_country: Dict[str, List[Tuple[int, Tuple[float, float]]]] = {}
    for idx, point, cc in nodata_entries:
        by_country.setdefault(cc, []).append((idx, point))

    for assigned_cc, entries in by_country.items():
        neighbors = NEIGHBOR_COUNTRIES.get(assigned_cc, [])
        # Track which points still need resolution
        unresolved = {idx: pt for idx, pt in entries}

        for neighbor_cc in neighbors:
            if not unresolved:
                break

            pts_to_try = list(unresolved.items())
            indices = [idx for idx, _ in pts_to_try]
            points_batch = [pt for _, pt in pts_to_try]

            chain = COUNTRY_PROVIDER_CHAINS.get(neighbor_cc)
            if chain:
                chain_desc = "->".join(step_label for step_label, _ in chain)
                print(f"    [fallback] Trying {neighbor_cc} chain ({chain_desc}) for "
                      f"{len(points_batch)} {assigned_cc} points...")
                chain_records = [] if (verbose and source_records is not None) else None
                try:
                    result, chain_sources = await _query_provider_chain(
                        points_batch,
                        chain,
                        source_records=chain_records,
                        verbose=verbose,
                    )
                except ElevationError as e:
                    print(f"    [fallback] {neighbor_cc} chain failed: {e}")
                    continue

                found = 0
                for idx, val, source_tag in zip(indices, result, chain_sources):
                    val = _sanitize_elevation(val)
                    if val is None:
                        continue
                    resolved[idx] = val
                    resolved_source[idx] = source_tag
                    unresolved.pop(idx, None)
                    found += 1
                if found:
                    print(f"    [fallback] {neighbor_cc} resolved {found}/{len(points_batch)} points")
                if chain_records:
                    for rec in chain_records:
                        source_records.append({
                            'label': f"{rec['label']} ({assigned_cc} fb)",
                            'points': rec['points'],
                            'resolution': rec['resolution'],
                            'source': rec['source'],
                        })
                continue

            provider = PROVIDERS.get(neighbor_cc)
            if provider is None:
                continue

            print(f"    [fallback] Trying {neighbor_cc} for {len(points_batch)} "
                  f"{assigned_cc} points...")

            if verbose:
                provider.verbose = True

            try:
                result = await provider.get_elevations(points_batch)
                found = 0
                source_tag = _provider_source_tag(provider)
                for idx, val in zip(indices, result):
                    val = _sanitize_elevation(val)
                    if val is not None:
                        resolved[idx] = val
                        resolved_source[idx] = source_tag
                        unresolved.pop(idx, None)
                        found += 1
                if found:
                    print(f"    [fallback] {neighbor_cc} resolved {found}/{len(points_batch)} points")
                    if verbose and source_records is not None:
                        fb_label = f"{_provider_display(provider)} ({assigned_cc} fb)"
                        if _is_wcs_like(provider):
                            src_str = _wcs_source_str(provider, failed=False)
                            _print_wcs_chunk_details(provider, fb_label)
                        elif getattr(provider, 'dataset_code', ''):
                            src_str = _tile_source_str(provider)
                        else:
                            src_str = _gpxz_source_str(provider)
                        source_records.append({
                            'label': fb_label,
                            'points': found,
                            'resolution': provider.resolution,
                            'source': src_str,
                        })
            except ElevationError as e:
                print(f"    [fallback] {neighbor_cc} failed: {e}")
                continue
            finally:
                if verbose:
                    provider.verbose = False

        if unresolved:
            unresolved_items = list(unresolved.items())
            preview = unresolved_items[:20]
            for _idx, pt in preview:
                print(f"    [warning] No fallback for ({pt[0]:.5f}, {pt[1]:.5f}) "
                      f"assigned to {assigned_cc}")
            remaining = len(unresolved_items) - len(preview)
            if remaining > 0:
                print(f"    [warning] ... and {remaining} more unresolved {assigned_cc} points")

    return resolved, resolved_source


async def get_all_elevations(
    points: List[Tuple[float, float]],
    verbose: bool = False,
) -> Tuple[List[Tuple[float, float]], List[Optional[float]], List[str]]:
    """Detect countries, validate all are supported, fetch elevations.

    Returns (out_points, elevations, source_tags) where out_points may differ from input:
    - Local providers (is_local=True): resampled to 1m before querying.
      Output has more points than input — e.g. 20km route -> ~20,000 pts.
    - Remote providers: input points queried directly (3m from Route Builder).

    For mixed-country routes, consecutive runs of each country are processed
    independently and concatenated in route order.
    """
    countries = detect_countries(points)
    unsupported = countries - set(SUPPORTED_COUNTRIES.keys())
    unsupported_neighbor_map: Dict[str, List[str]] = {}
    if unsupported:
        # Check each unsupported country for supported neighbours.
        # e.g. IT → ['AT', 'SI', 'FR', 'CH']: near-border points geocoded to Italy get
        # point-level reassignment is done later using route context.
        unresolvable = []
        for cc in sorted(unsupported):
            neighbours = NEIGHBOR_COUNTRIES.get(cc, [])
            supported_nb = [nb for nb in neighbours if nb in SUPPORTED_COUNTRIES]
            if supported_nb:
                unsupported_neighbor_map[cc] = supported_nb
                print(
                    f"  [remap] {cc} not supported - using route-context remap via: "
                    f"{', '.join(supported_nb)}"
                )
            else:
                unresolvable.append(cc)
        if unresolvable:
            names = ", ".join(unresolvable)
            raise ValueError(
                f"Cannot process: route passes through unsupported countries with no "
                f"supported neighbour: {names}.\n"
                f"Supported: {', '.join(sorted(SUPPORTED_COUNTRIES.keys()))}"
            )

    groups = group_points_by_country(points)

    # Build per-point country map with raw detected countries first.
    point_country: List[str] = [''] * len(points)
    for cc, indexed_points in groups.items():
        for idx, _ in indexed_points:
            point_country[idx] = cc

    # Remap unsupported runs using route context:
    # - if both sides touch valid candidates, split by nearest side
    # - if one side touches a candidate, use that side
    # - otherwise use neighbour priority order
    i = 0
    n_points = len(point_country)
    while i < n_points:
        cc = point_country[i]
        if cc in SUPPORTED_COUNTRIES:
            i += 1
            continue

        supported_candidates = unsupported_neighbor_map.get(cc, [])
        if not supported_candidates:
            raise ElevationError(f"No supported neighbour for unsupported country {cc}")

        run_start = i
        while i + 1 < n_points and point_country[i + 1] == cc:
            i += 1
        run_end = i

        left_cc = point_country[run_start - 1] if run_start > 0 else None
        right_cc = point_country[run_end + 1] if run_end + 1 < n_points else None
        left_ok = left_cc in supported_candidates
        right_ok = right_cc in supported_candidates

        if left_ok and right_ok and left_cc != right_cc:
            for idx in range(run_start, run_end + 1):
                dist_left = idx - run_start + 1
                dist_right = run_end - idx + 1
                point_country[idx] = left_cc if dist_left <= dist_right else right_cc
        elif left_ok:
            for idx in range(run_start, run_end + 1):
                point_country[idx] = left_cc
        elif right_ok:
            for idx in range(run_start, run_end + 1):
                point_country[idx] = right_cc
        else:
            fallback_cc = supported_candidates[0]
            for idx in range(run_start, run_end + 1):
                point_country[idx] = fallback_cc

        i += 1

    # Consecutive runs: [(cc, start_idx, end_idx_exclusive), ...]
    runs: List[Tuple[str, int, int]] = []
    if points:
        cur_cc = point_country[0]
        run_start = 0
        for i in range(1, len(points)):
            if point_country[i] != cur_cc:
                runs.append((cur_cc, run_start, i))
                cur_cc = point_country[i]
                run_start = i
        runs.append((cur_cc, run_start, len(points)))

    # Process each run and build output in route order
    out_points: List[Tuple[float, float]] = []
    out_elevations: List[Optional[float]] = []
    out_country: List[str] = []
    out_source: List[str] = []
    source_records: list = []  # for verbose table

    for cc, start, end in runs:
        provider = PROVIDERS[cc]
        run_pts = points[start:end]

        query_pts = run_pts
        chain = COUNTRY_PROVIDER_CHAINS.get(cc)
        if chain:
            chain_desc = "->".join(step_label for step_label, _ in chain)
            print(f"  Querying {SUPPORTED_COUNTRIES[cc].capitalize()} ({cc}): "
                  f"{len(query_pts)} pts @ {chain_desc} chain...")
            result, run_source = await _query_provider_chain(
                query_pts,
                chain,
                source_records=source_records if verbose else None,
                verbose=verbose,
            )
            out_points.extend(query_pts)
            out_elevations.extend(result)
            out_country.extend([cc] * len(query_pts))
            out_source.extend(run_source)
            continue

        print(f"  Querying {SUPPORTED_COUNTRIES[cc].capitalize()} ({cc}): "
              f"{len(query_pts)} pts @ {provider.resolution}m resolution...")

        if verbose:
            provider.verbose = True

        try:
            result = await provider.get_elevations(query_pts)
        finally:
            if verbose:
                provider.verbose = False
        result = [_sanitize_elevation(v) for v in result]

        resolved_primary = sum(1 for e in result if e is not None)
        failed = resolved_primary == 0
        source_tag = _provider_source_tag(provider)
        run_source = [source_tag if e is not None else '' for e in result]

        if verbose:
            label = _provider_display(provider)
            if _is_wcs_like(provider):
                src_str = _wcs_source_str(provider, failed=failed)
                _print_wcs_chunk_details(provider, label)
                if failed and getattr(provider, '_verbose_log', None):
                    first = provider._verbose_log[0]
                    print(f"\n  *** {label} returned all nodata — first chunk diagnostics: ***")
                    print(f"  URL: {first['url']}")
                    print(f"  TIFF shape={first.get('shape')}  bounds={first.get('bounds')}")
                    nd = first.get('ds_nodata')
                    rmin = first.get('raster_min')
                    rmax = first.get('raster_max')
                    nd_str = f"{nd:.4g}" if nd is not None else "None"
                    min_str = f"{rmin:.4g}" if rmin is not None else "?"
                    max_str = f"{rmax:.4g}" if rmax is not None else "?"
                    print(f"  nodata={nd_str}  raster min={min_str}  max={max_str}")
                    print()
            elif getattr(provider, 'dataset_code', ''):
                src_str = _tile_source_str(provider)
            else:
                src_str = _gpxz_source_str(provider)
            source_records.append({
                'label': label,
                'points': resolved_primary,
                'resolution': provider.resolution,
                'source': src_str,
            })

        out_points.extend(query_pts)
        out_elevations.extend(result)
        out_country.extend([cc] * len(query_pts))
        out_source.extend(run_source)

    # Cross-border fallback for any None elevations
    nodata_entries = [
        (i, out_points[i], out_country[i])
        for i, e in enumerate(out_elevations) if e is None
    ]
    if nodata_entries:
        print(f"  {len(nodata_entries)} points returned nodata — trying cross-border fallback...")
        resolved, resolved_source = await _try_fallback_batch(
            nodata_entries,
            source_records=source_records if verbose else None,
            verbose=verbose,
        )
        for i, _, _ in nodata_entries:
            out_elevations[i] = resolved.get(i)  # None if fallback also failed
            if i in resolved_source:
                out_source[i] = resolved_source[i]

    if verbose:
        _print_source_table(source_records)

    return out_points, out_elevations, out_source


async def main(input_path: str, output_path: str, verbose: bool = False):
    print(f"Parsing: {input_path}")
    points, gpx = parse_gpx(input_path)
    print(f"  {len(points)} points found")

    countries = detect_countries(points)
    print(f"  Countries detected: {', '.join(sorted(countries))}")

    print("Fetching elevations...")
    try:
        out_points, elevations, _sources = await get_all_elevations(points, verbose=verbose)
    except ValueError as e:
        print(f"\n{e}", file=sys.stderr)
        sys.exit(1)
    except ElevationError as e:
        print(f"\nElevation error: {e}", file=sys.stderr)
        sys.exit(1)

    write_gpx(gpx, elevations, output_path)
    print(f"Done. Written to: {output_path} ({len(points)} pts)")

    # Summary
    groups = group_points_by_country(points)
    summary_parts = []
    for cc, indexed_points in sorted(groups.items()):
        provider = PROVIDERS.get(cc)
        res = f"{provider.resolution}m" if provider else "?"
        summary_parts.append(f"{cc}: {len(indexed_points)} pts @ {res}")
    print(f"Summary: {' | '.join(summary_parts)}")


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    verbose = '--verbose' in sys.argv
    if len(args) != 2:
        print("Usage: python gpx_elevation.py [--verbose] <input.gpx> <output.gpx>")
        sys.exit(1)
    asyncio.run(main(args[0], args[1], verbose=verbose))
