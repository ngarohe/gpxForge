"""
Germany multi-state WCS 2.0.1 elevation provider.

Each German federal state runs its own WCS endpoint for DGM1 (1m LIDAR).
This provider routes queries to the correct state WCS based on point
coordinates (bounding-box lookup), fetches the raster tile, and samples
elevations. Points that don't match any state WCS (or get nodata) are
returned as None — the orchestrator handles cross-border / GPXZ fallback.

Confirmed working states (Apr 2025):
  NRW, BB (+Berlin), MV, BW, HE

States with WCS but currently down (included, will auto-recover):
  ST (500), SL (503)

States without a public WCS (fall through to GPXZ):
  BY, NI, SH, HH, HB, TH, SN, RP
"""
import math
import aiohttp
from pyproj import Transformer
from typing import List, Tuple, Optional, NamedTuple
from .base import ElevationProvider, ElevationError
from .wcs_base import _group_points_by_bbox
from .http_hardening import (
    DEFAULT_RATE_LIMIT_KEYWORDS,
    body_snippet,
    make_timeout,
    request_with_retry,
)

try:
    from rasterio.io import MemoryFile
    from rasterio.transform import rowcol
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False


# ── State configuration ─────────────────────────────────────────────

class StateWCS(NamedTuple):
    abbrev: str
    wcs_url: str
    coverage_id: str
    epsg: int          # 25832 (western) or 25833 (eastern)
    x_axis: str        # SUBSET axis label for easting
    y_axis: str        # SUBSET axis label for northing
    # Approximate bounding box in WGS84 (lat_min, lat_max, lon_min, lon_max).
    # Boxes overlap ~0.05° (~5 km) at state borders so border points match
    # multiple states.  First match is tried; if nodata, next match is tried.
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float


STATES: List[StateWCS] = [
    # ── Confirmed working ────────────────────────────────────────────
    StateWCS('NRW',
             'https://www.wcs.nrw.de/geobasis/wcs_nw_dgm',
             'nw_dgm', 25832, 'x', 'y',
             50.25, 52.55, 5.75, 9.55),
    StateWCS('BB',   # Brandenburg — also covers Berlin
             'https://isk.geobasis-bb.de/ows/dgm_wcs',
             'bb_dgm', 25833, 'x', 'y',
             51.30, 53.65, 11.20, 14.85),
    StateWCS('MV',
             'https://www.geodaten-mv.de/dienste/dgm_wcs',
             'mv_dgm', 25833, 'x', 'y',
             53.05, 54.75, 10.55, 14.50),
    StateWCS('BW',
             'https://owsproxy.lgl-bw.de/owsproxy/wcs/WCS_INSP_BW_Hoehe_Coverage_DGM1',
             'EL.ElevationGridCoverage', 25832, 'E', 'N',
             47.45, 49.85, 7.45, 10.55),
    StateWCS('HE',
             'https://inspire-hessen.de/raster/dgm1/ows',
             'he_dgm1', 25832, 'E', 'N',
             49.35, 51.70, 7.75, 10.30),
    # ── WCS exists but service currently unreliable (included for auto-recovery)
    StateWCS('ST',
             'https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DGM1_WCS_OpenData/guest',
             'Coverage1', 25832, 'x', 'y',
             50.85, 53.05, 10.50, 13.25),
    StateWCS('SL',
             'https://geoportal.saarland.de/gdi-sl/inspireraster/inspirewcsel',
             'sl_inspire_el_dgm1', 25832, 'E', 'N',
             49.05, 49.65, 6.30, 7.45),
    # Berlin is served by BB's WCS — add a bbox entry so Berlin points match.
    StateWCS('BE',
             'https://isk.geobasis-bb.de/ows/dgm_wcs',
             'bb_dgm', 25833, 'x', 'y',
             52.30, 52.70, 13.05, 13.80),
]

MAX_BBOX_M = 500.0   # max WCS chunk side in projected metres
BUF_M = 50.0         # bbox padding
REQUEST_TIMEOUT = make_timeout(total=50, connect=10, sock_connect=10, sock_read=35)


# ── Helper ───────────────────────────────────────────────────────────

def _is_nodata(val: float, ds_nodata, allow_zero: bool = False) -> bool:
    """Check if a sampled pixel value is a nodata sentinel."""
    if ds_nodata is not None and val == ds_nodata:
        return True
    if abs(val) > 1e37:
        return True
    if val < -100.0:              # large negative sentinel
        return True
    if val != val:                # NaN
        return True
    if not allow_zero and val == 0.0:
        return True
    return False


# ── Provider ─────────────────────────────────────────────────────────

class GermanyProvider(ElevationProvider):
    """Germany 1m DGM via per-state WCS 2.0.1 endpoints."""

    max_bbox_size = MAX_BBOX_M

    def __init__(self):
        # Two transformers — one per UTM zone used in Germany.
        self._transformers = {
            25832: Transformer.from_crs("EPSG:4326", "EPSG:25832", always_xy=True),
            25833: Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True),
        }

    @property
    def country_code(self) -> str:
        return 'DE'

    @property
    def resolution(self) -> float:
        return 1.0

    @property
    def coverage_id(self) -> str:
        return 'multi-state DGM1'

    # ── State routing ────────────────────────────────────────────────

    def _find_states(self, lat: float, lon: float) -> List[StateWCS]:
        """Return all states whose bbox contains (lat, lon).

        Multiple matches are expected near state borders (bboxes overlap).
        """
        return [
            s for s in STATES
            if s.lat_min <= lat <= s.lat_max and s.lon_min <= lon <= s.lon_max
        ]

    # ── Main entry point ─────────────────────────────────────────────

    async def get_elevations(
        self, points: List[Tuple[float, float]]
    ) -> List[Optional[float]]:
        if not RASTERIO_AVAILABLE:
            raise ElevationError("rasterio is required for Germany WCS provider")

        elevations: List[Optional[float]] = [None] * len(points)

        if self.verbose:
            self._verbose_log = []

        # For each point, determine candidate states.
        point_states: List[List[StateWCS]] = [
            self._find_states(lat, lon) for lat, lon in points
        ]

        # Group consecutive points that share the same primary (first) state.
        # This keeps chunks geographically coherent.
        runs: List[Tuple[Optional[StateWCS], int, int]] = []
        if points:
            cur_state = point_states[0][0] if point_states[0] else None
            run_start = 0
            for i in range(1, len(points)):
                primary = point_states[i][0] if point_states[i] else None
                if primary != cur_state:
                    runs.append((cur_state, run_start, i))
                    cur_state = primary
                    run_start = i
            runs.append((cur_state, run_start, len(points)))

        # Fetch each state-run via WCS.
        async with aiohttp.ClientSession() as session:
            for state, start, end in runs:
                if state is None:
                    continue  # no WCS for these points → stay None
                await self._fetch_run(
                    session, state, points, start, end, elevations
                )

            # Retry nodata points with alternate states (border overlap).
            for i, elev in enumerate(elevations):
                if elev is not None:
                    continue
                alternates = point_states[i][1:]  # skip primary (already tried)
                for alt_state in alternates:
                    await self._fetch_single(
                        session, alt_state, points[i], elevations, i
                    )
                    if elevations[i] is not None:
                        break

        return elevations

    # ── WCS fetching ─────────────────────────────────────────────────

    async def _fetch_run(
        self,
        session: aiohttp.ClientSession,
        state: StateWCS,
        points: List[Tuple[float, float]],
        start: int,
        end: int,
        elevations: List[Optional[float]],
    ) -> None:
        """Fetch WCS tiles for a consecutive run of points in one state."""
        transformer = self._transformers[state.epsg]
        local_pts = [
            transformer.transform(points[i][1], points[i][0])  # (lon, lat) → (x, y)
            for i in range(start, end)
        ]

        chunk_num = 0
        for _indices, chunk_bbox in _group_points_by_bbox(
            local_pts, MAX_BBOX_M, BUF_M
        ):
            chunk_num += 1
            try:
                tiff_bytes, req_url = await self._fetch_wcs_tile(
                    session, state, chunk_bbox
                )
            except ElevationError as e:
                if self.verbose:
                    print(f"    [DE/{state.abbrev}] chunk {chunk_num} failed: {e}")
                continue  # leave as None → fallback handles it

            resolved_before = sum(1 for e in elevations if e is not None)
            self._sample_raster(
                tiff_bytes, chunk_bbox, local_pts, elevations,
                offset=start, state_abbrev=state.abbrev,
            )
            if self.verbose:
                stats = self._raster_stats(tiff_bytes)
                resolved_now = sum(1 for e in elevations if e is not None)
                self._verbose_log.append({
                    'chunk': chunk_num,
                    'state': state.abbrev,
                    'bbox': chunk_bbox,
                    'url': req_url,
                    'resolved': resolved_now - resolved_before,
                    **stats,
                })

    async def _fetch_single(
        self,
        session: aiohttp.ClientSession,
        state: StateWCS,
        point: Tuple[float, float],
        elevations: List[Optional[float]],
        idx: int,
    ) -> None:
        """Fetch a small tile around a single point (border retry)."""
        lat, lon = point
        transformer = self._transformers[state.epsg]
        x, y = transformer.transform(lon, lat)
        bbox = (x - BUF_M, y - BUF_M, x + BUF_M, y + BUF_M)
        try:
            tiff_bytes, _ = await self._fetch_wcs_tile(session, state, bbox)
        except ElevationError:
            return  # leave as None
        self._sample_raster(
            tiff_bytes, bbox, [(x, y)], elevations,
            offset=idx, state_abbrev=state.abbrev,
        )

    async def _fetch_wcs_tile(
        self,
        session: aiohttp.ClientSession,
        state: StateWCS,
        bbox: Tuple[float, float, float, float],
    ) -> Tuple[bytes, str]:
        """Fetch a WCS 2.0.1 tile; return (tiff_bytes, request_url)."""
        xmin, ymin, xmax, ymax = bbox
        params = {
            "SERVICE": "WCS",
            "VERSION": "2.0.1",
            "REQUEST": "GetCoverage",
            "CoverageId": state.coverage_id,
            "SUBSET": [
                f"{state.x_axis}({xmin},{xmax})",
                f"{state.y_axis}({ymin},{ymax})",
            ],
            "FORMAT": "image/tiff",
        }
        status, body, req_url, ct = await request_with_retry(
            session,
            "GET",
            state.wcs_url,
            params=params,
            timeout=REQUEST_TIMEOUT,
            max_attempts=4,
            transient_statuses={408, 425, 429, 500, 502, 503, 504},
            retry_body_keywords=DEFAULT_RATE_LIMIT_KEYWORDS,
            verbose=self.verbose,
            log_prefix=f"DE/{state.abbrev}",
        )
        if status != 200:
            raise ElevationError(
                f"DE/{state.abbrev} WCS error {status}: {body_snippet(body, 220)}"
            )
        if "tiff" not in ct and "octet" not in ct:
            raise ElevationError(
                f"DE/{state.abbrev} unexpected content-type '{ct}': "
                f"{body_snippet(body, 220)}"
            )
        return body, req_url

    # ── Raster sampling ──────────────────────────────────────────────

    def _sample_raster(
        self,
        tiff_bytes: bytes,
        chunk_bbox: Tuple[float, float, float, float],
        local_pts: List[Tuple[float, float]],
        elevations: List[Optional[float]],
        offset: int = 0,
        state_abbrev: str = '',
    ) -> None:
        xmin, ymin, xmax, ymax = chunk_bbox
        with MemoryFile(tiff_bytes) as memfile:
            with memfile.open() as ds:
                band = ds.read(1)
                ds_nodata = ds.nodata
                for i, (x, y) in enumerate(local_pts):
                    idx = offset + i
                    if elevations[idx] is not None:
                        continue
                    if not (xmin <= x <= xmax and ymin <= y <= ymax):
                        continue
                    try:
                        row, col = rowcol(ds.transform, x, y)
                        if 0 <= row < band.shape[0] and 0 <= col < band.shape[1]:
                            val = float(band[row, col])
                            if not _is_nodata(val, ds_nodata):
                                elevations[idx] = val
                    except Exception as e:
                        raise ElevationError(
                            f"DE/{state_abbrev}: sample ({x:.1f}, {y:.1f}): {e}"
                        ) from e

    def _raster_stats(self, tiff_bytes: bytes) -> dict:
        with MemoryFile(tiff_bytes) as memfile:
            with memfile.open() as ds:
                band = ds.read(1)
                return {
                    'shape': ds.shape,
                    'bounds': tuple(ds.bounds),
                    'ds_nodata': ds.nodata,
                    'raster_min': float(band.min()),
                    'raster_max': float(band.max()),
                }
