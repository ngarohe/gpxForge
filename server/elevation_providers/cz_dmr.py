"""
Czech LIDAR DMR 5G (5th generation) Provider

Uses ČÚZK's WMS endpoint for on-demand 1m elevation queries via TIFF image extraction.
Coverage: entire Czech Republic
WMS confirmed working 2026-05-01.
CRS: EPSG:4326 (WGS84) — geographic coordinates

Resolution fix: max_bbox_size = 0.005° (~500m) + 512×512 px → ~1m/pixel effective resolution.
Previous 0.5° bbox caused ~107m/pixel staircase pattern.
"""
import asyncio
import aiohttp
from typing import List, Optional, Tuple

from .base import ElevationProvider, ElevationError
from .http_hardening import request_with_retry, DEFAULT_RATE_LIMIT_KEYWORDS, body_snippet
from .wcs_base import _group_points_by_bbox
from config import CZ_DMR_ENABLED, CZ_DMR_WMS_URL

try:
    import numpy as np
    from rasterio.io import MemoryFile
    from rasterio.transform import rowcol
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False

MAX_BBOX_DEG = 0.005   # ~500m side at 50°N → ~1m/pixel with 512 px
BUF_DEG = 0.0005       # ~50m buffer


class CzDmrProvider(ElevationProvider):
    """Czech LIDAR DMR 5G — WMS-based elevation via TIFF imagery.

    Full national coverage via ČÚZK DMR5G WMS service.
    Each WMS request covers ~500m × 500m at 512×512 px → ~1m/pixel.
    """

    def __init__(self):
        self.enabled = CZ_DMR_ENABLED
        self.wms_url = CZ_DMR_WMS_URL
        self.dataset_code = 'CZ_DMR5G'
        self.verbose = False

    @property
    def country_code(self) -> str:
        return 'CZ'

    @property
    def resolution(self) -> float:
        return 1.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        if not self.enabled:
            return [None] * len(points)
        if not RASTERIO_AVAILABLE:
            raise ElevationError("rasterio is required for Czech LIDAR provider")

        # Work in (lon, lat) = (x, y) for _group_points_by_bbox
        local_pts = [(lon, lat) for lat, lon in points]
        elevations: List[Optional[float]] = [None] * len(points)

        if self.verbose:
            self._verbose_log = []

        chunk_num = 0
        async with aiohttp.ClientSession() as session:
            for _indices, chunk_bbox in _group_points_by_bbox(local_pts, MAX_BBOX_DEG, BUF_DEG):
                chunk_num += 1
                try:
                    tiff_bytes = await self._fetch_wms_chunk(session, chunk_bbox)
                    resolved_before = sum(1 for e in elevations if e is not None)
                    self._sample_raster(tiff_bytes, chunk_bbox, local_pts, elevations)
                    if self.verbose:
                        resolved_now = sum(1 for e in elevations if e is not None)
                        with MemoryFile(tiff_bytes) as mf:
                            with mf.open() as ds:
                                band = ds.read(1)
                                self._verbose_log.append({
                                    'chunk': chunk_num,
                                    'bbox': chunk_bbox,
                                    'shape': ds.shape,
                                    'bounds': tuple(ds.bounds),
                                    'ds_nodata': ds.nodata,
                                    'raster_min': float(band.min()),
                                    'raster_max': float(band.max()),
                                    'resolved': resolved_now - resolved_before,
                                })
                except ElevationError as e:
                    if self.verbose:
                        print(f"[CzDmr] chunk {chunk_num} failed: {e}")
                await asyncio.sleep(0.1)

        return elevations

    async def _fetch_wms_chunk(self, session: aiohttp.ClientSession, bbox: Tuple[float, float, float, float]) -> bytes:
        """Fetch a WMS tile for the given (xmin, ymin, xmax, ymax) bbox and return TIFF bytes."""
        xmin, ymin, xmax, ymax = bbox  # lon, lat, lon, lat
        params = {
            "SERVICE": "WMS",
            "VERSION": "1.1.0",
            "REQUEST": "GetMap",
            "LAYERS": "DMR5G",
            "BBOX": f"{xmin},{ymin},{xmax},{ymax}",
            "WIDTH": "512",
            "HEIGHT": "512",
            "SRS": "EPSG:4326",
            "FORMAT": "image/tiff",
        }

        status, body, req_url, ct = await request_with_retry(
            session,
            "GET",
            self.wms_url,
            params=params,
            max_attempts=3,
            transient_statuses={408, 429, 500, 502, 503, 504},
            retry_body_keywords=DEFAULT_RATE_LIMIT_KEYWORDS,
            verbose=self.verbose,
            log_prefix="CzDmr",
        )

        if status != 200:
            status_hint = {
                403: 'access denied',
                404: 'endpoint not found',
                429: 'rate limited',
                500: 'internal server error',
                502: 'bad gateway',
                503: 'service unavailable',
                504: 'timeout',
            }.get(status, f'HTTP {status}')
            raise ElevationError(
                f"Czech LIDAR elevation server unavailable ({status_hint}). Try again later."
            )

        if "tiff" not in ct and "octet" not in ct:
            raise ElevationError(
                f"Czech LIDAR server returned unexpected data (expected TIFF, got '{ct}'). "
                f"Response: {body_snippet(body)}"
            )

        return body

    def _sample_raster(
        self,
        tiff_bytes: bytes,
        chunk_bbox: Tuple[float, float, float, float],
        local_pts: List[Tuple[float, float]],
        elevations: List[Optional[float]],
    ) -> None:
        """Sample elevation values from TIFF at given local_pts (lon, lat)."""
        xmin, ymin, xmax, ymax = chunk_bbox
        with MemoryFile(tiff_bytes) as memfile:
            with memfile.open() as ds:
                band = ds.read(1)
                ds_nodata = ds.nodata

                for i, (x, y) in enumerate(local_pts):
                    if elevations[i] is not None:
                        continue
                    if not (xmin <= x <= xmax and ymin <= y <= ymax):
                        continue
                    try:
                        row_float, col_float = rowcol(ds.transform, x, y)
                        row = int(np.round(row_float))
                        col = int(np.round(col_float))
                        if 0 <= row < band.shape[0] and 0 <= col < band.shape[1]:
                            val = float(band[row, col])
                            if ds_nodata is not None and val == ds_nodata:
                                continue
                            # Czech valid range: 0.1–3000m (Sněžka max 1603m)
                            if val < 0.1 or val > 3000.0:
                                continue
                            elevations[i] = val
                    except Exception as e:
                        raise ElevationError(
                            f"CzDmr: failed to sample ({x}, {y}): {e}"
                        ) from e
