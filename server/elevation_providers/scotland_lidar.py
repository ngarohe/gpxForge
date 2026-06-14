"""
Scotland LIDAR DTM Provider — JNCC Scottish Remote Sensing Portal

Uses the JNCC WCS 2.0.1 endpoint with multiple coverage layers (6 phases
+ HES + islands + NLP 2025). Queries highest-resolution layers first;
falls through on nodata.

Coverage: ~40% of Scotland (lowlands, urban, river corridors, cycling routes).
Points outside coverage return None and fall to GPXZ via the GB chain.

CRS: EPSG:27700 (OSGB36 British National Grid) — same as EA LIDAR.
Axis labels: E (easting), N (northing).
Nodata: -9999.0
Resolution: 0.5–1m (Phase 3–6 at 0.5m native, Phase 1–2 at 1m).
"""
import asyncio
import aiohttp
from typing import List, Optional, Tuple

from pyproj import Transformer

from .wcs_base import WCSProvider, _group_points_by_bbox, RASTERIO_AVAILABLE
from .base import ElevationError
from .http_hardening import DEFAULT_RATE_LIMIT_KEYWORDS, body_snippet, request_with_retry

try:
    from rasterio.io import MemoryFile
    from rasterio.transform import rowcol
except ImportError:
    pass

from config import (
    SCOTLAND_LIDAR_ENABLED,
    SCOTLAND_LIDAR_WCS_URL,
)

# Coverage IDs ordered by priority: newest/highest-res phases first.
# Phase 3–6 are 0.5m native; Phase 1–2 are 1m. NLP 2025 deliveries
# are 0.5m but small coverage so far. HES datasets are small focused areas.
# The chain tries each coverage in order and keeps the first non-None hit.
_COVERAGE_IDS = [
    # NLP 2025 — newest, 0.5m, small areas so far
    'scotland:nlp_2025_d2_nr50_dtm',
    'scotland:nlp_2025_d1_nx00_dtm',
    # Main phases — 0.5m (phases 3–6)
    'scotland:scotland-lidar-6-dtm',
    'scotland:scotland-lidar-5-dtm',
    'scotland:scotland-lidar-4-dtm',
    'scotland:scotland-lidar-3-dtm',
    # Main phases — 1m (phases 1–2, widest coverage)
    'scotland:scotland-lidar-2-dtm',
    'scotland:scotland-lidar-1-dtm',
    # Islands
    'scotland:orkney-islands-council-23-dtm',
    'scotland:outer-hebrides-2019-dtm-25cm',
    'scotland:outer-hebrides-2019-dtm-50cm',
    # HES (Historic Environment Scotland) — focused areas
    'scotland:scotland-gov-lidar-hes-hes-2017-dtm',
    'scotland:scotland-gov-lidar-hes-hes-2016-2017-dtm',
    'scotland:scotland-gov-lidar-hes-hes-2016-dtm',
    'scotland:scotland-gov-lidar-hes-hes-2017sp3-dtm',
    'scotland:scotland-gov-lidar-hes-hes-2010s10-dtm',
    'scotland:scotland-gov-lidar-hes-2010-dtm',
    'scotland:scotland-gov-lidar-hes-hes-luing-dtm',
]

# Scotland OSGB36 extent (covers all mainland + islands).
# EA LIDAR stops at ~N 665000 (English/Welsh border area). Scotland starts
# around N 530000 (Southern Uplands) and extends to N 1220000 (Shetland).
# We use a generous filter that covers all of Scotland + overlap zone with EA.
_E_MIN, _E_MAX = 5000.0, 470000.0
_N_MIN, _N_MAX = 530000.0, 1230000.0


class ScotlandLidarProvider(WCSProvider):
    """JNCC Scotland LIDAR DTM — WCS 2.0.1 multi-coverage in OSGB36 (EPSG:27700).

    Queries multiple coverage layers in priority order (newest/highest-res first).
    Points outside Scottish coverage return None; the GB chain falls back to GPXZ.
    """

    dataset_code = 'SCOTLAND_LIDAR_DTM'
    subset_x_axis = 'E'
    subset_y_axis = 'N'
    no_data_value = -9999.0
    max_bbox_size = 5000.0
    chunk_delay = 0.15
    allow_zero_elevation = False

    def __init__(self):
        super().__init__()
        self.enabled = SCOTLAND_LIDAR_ENABLED
        self.wcs_url = SCOTLAND_LIDAR_WCS_URL
        self.coverage_id = _COVERAGE_IDS[0]  # default; overridden per-query
        self._transformer = Transformer.from_crs('EPSG:4326', 'EPSG:27700', always_xy=True)

    @property
    def country_code(self) -> str:
        return 'GB'

    @property
    def resolution(self) -> float:
        return 1.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        if not self.enabled:
            return [None] * len(points)
        if not RASTERIO_AVAILABLE:
            raise ElevationError("rasterio is required for WCS providers")

        # Pre-filter: only query points within the Scottish OSGB36 extent.
        in_cov = []
        local_pts_all = []
        for i, (lat, lon) in enumerate(points):
            e, n = self._transformer.transform(lon, lat)
            local_pts_all.append((e, n))
            if _E_MIN <= e <= _E_MAX and _N_MIN <= n <= _N_MAX:
                in_cov.append(i)

        if not in_cov:
            return [None] * len(points)

        elevations: List[Optional[float]] = [None] * len(points)

        # Build local coords for in-coverage points only
        subset_local = [local_pts_all[i] for i in in_cov]

        buf = 50.0
        async with aiohttp.ClientSession() as session:
            for indices, chunk_bbox in _group_points_by_bbox(subset_local, self.max_bbox_size, buf):
                # Map chunk indices back to original indices
                orig_indices = [in_cov[j] for j in indices]

                # Points in this chunk that still need elevation
                unresolved = set(orig_indices)

                for cov_id in _COVERAGE_IDS:
                    if not unresolved:
                        break

                    tiff_bytes = await self._fetch_coverage(session, chunk_bbox, cov_id)
                    if tiff_bytes is None:
                        continue

                    self._sample_chunk(
                        tiff_bytes, chunk_bbox, local_pts_all,
                        orig_indices, elevations, unresolved,
                    )

                await asyncio.sleep(self.chunk_delay)

        return elevations

    async def _fetch_coverage(self, session, bbox, coverage_id):
        """Fetch a single WCS coverage tile. Returns bytes or None on error."""
        xmin, ymin, xmax, ymax = bbox
        params = {
            "SERVICE": "WCS",
            "VERSION": "2.0.1",
            "REQUEST": "GetCoverage",
            "CoverageId": coverage_id,
            "SUBSET": [
                f"E({xmin},{xmax})",
                f"N({ymin},{ymax})",
            ],
            "FORMAT": "image/tiff",
        }

        name = f"Scotland({coverage_id.split(':')[-1][:20]})"
        try:
            status, body, req_url, ct = await request_with_retry(
                session,
                "GET",
                self.wcs_url,
                params=params,
                max_attempts=2,
                transient_statuses={408, 429, 500, 502, 503, 504},
                retry_body_keywords=DEFAULT_RATE_LIMIT_KEYWORDS,
                verbose=self.verbose,
                log_prefix=name,
            )
        except Exception:
            return None

        if status != 200:
            return None
        if "tiff" not in ct and "octet" not in ct:
            return None

        return body

    def _sample_chunk(self, tiff_bytes, chunk_bbox, local_pts_all,
                      orig_indices, elevations, unresolved):
        """Sample elevation from a raster for unresolved points in this chunk."""
        xmin, ymin, xmax, ymax = chunk_bbox
        with MemoryFile(tiff_bytes) as memfile:
            with memfile.open() as ds:
                band = ds.read(1).astype('float64')
                ds_nodata = ds.nodata
                rows, cols = band.shape
                for idx in list(unresolved):
                    x, y = local_pts_all[idx]
                    if not (xmin <= x <= xmax and ymin <= y <= ymax):
                        continue
                    try:
                        rf, cf = rowcol(ds.transform, x, y, op=float)
                        r0 = int(rf)
                        c0 = int(cf)
                        if not (0 <= r0 < rows and 0 <= c0 < cols):
                            continue
                        v00 = band[r0, c0]
                        if self._is_nodata(v00, ds_nodata):
                            continue
                        # Bilinear interpolation
                        r1 = min(r0 + 1, rows - 1)
                        c1 = min(c0 + 1, cols - 1)
                        dr = rf - r0
                        dc = cf - c0
                        v01 = band[r0, c1]
                        v10 = band[r1, c0]
                        v11 = band[r1, c1]
                        if (self._is_nodata(v01, ds_nodata) or
                                self._is_nodata(v10, ds_nodata) or
                                self._is_nodata(v11, ds_nodata)):
                            elevations[idx] = float(v00)
                        else:
                            val = (v00 * (1 - dr) * (1 - dc) +
                                   v01 * (1 - dr) * dc +
                                   v10 * dr * (1 - dc) +
                                   v11 * dr * dc)
                            elevations[idx] = float(val)
                        unresolved.discard(idx)
                    except Exception:
                        continue
