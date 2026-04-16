"""
Generic WCS 2.0.1 elevation provider base class.
Subclass and set: wcs_url, coverage_id, transformer (or None for WGS84/EPSG:4258),
subset_x_axis, subset_y_axis, no_data_value, and max_bbox_size.
"""
import asyncio
import aiohttp
from typing import List, Tuple, Optional
from .base import ElevationProvider, ElevationError
from .http_hardening import (
    DEFAULT_RATE_LIMIT_KEYWORDS,
    body_snippet,
    request_with_retry,
)

try:
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import rowcol
    from rasterio.enums import Resampling
    import numpy as np
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False


def _group_points_by_bbox(local_pts, max_size, buf):
    """Group consecutive points so each group's bbox stays <= max_size in each axis.

    Scans forward, extending the current group until adding the next point
    would exceed max_size in x or y. O(n) - each point visited once.

    Yields (indices, padded_bbox) for each group.
    """
    if not local_pts:
        return
    n = len(local_pts)
    start = 0
    while start < n:
        xmin = xmax = local_pts[start][0]
        ymin = ymax = local_pts[start][1]
        end = start + 1
        while end < n:
            x, y = local_pts[end]
            nxmin, nxmax = min(xmin, x), max(xmax, x)
            nymin, nymax = min(ymin, y), max(ymax, y)
            if nxmax - nxmin > max_size or nymax - nymin > max_size:
                break
            xmin, xmax, ymin, ymax = nxmin, nxmax, nymin, nymax
            end += 1
        yield list(range(start, end)), (xmin - buf, ymin - buf, xmax + buf, ymax + buf)
        start = end


class WCSProvider(ElevationProvider):
    """Generic WCS 2.0.1 provider. Subclass per country."""

    wcs_url: str = ""
    coverage_id: str = ""
    subset_x_axis: str = "x"       # axis label for easting / longitude
    subset_y_axis: str = "y"       # axis label for northing / latitude
    no_data_value: float = -9999.0
    # Max bbox size in native CRS units per WCS request.
    # For projected CRS (metres): 10000 = 10km side.
    # For geographic CRS (degrees): 0.5 = ~55km side.
    max_bbox_size: float = 10000.0
    # Seconds to sleep between chunk requests (be polite to WCS servers).
    chunk_delay: float = 0.3

    def __init__(self):
        self._transformer = None  # set via property in subclass if needed

    @property
    def transformer(self):
        return self._transformer

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[float]:
        if not RASTERIO_AVAILABLE:
            raise ElevationError("rasterio is required for WCS providers")

        # Transform (lat, lon) -> local CRS (x, y)
        if self.transformer is not None:
            local_pts = [self.transformer.transform(lon, lat) for lat, lon in points]
        else:
            # No transform - use (lon, lat) directly as (x, y)
            local_pts = [(lon, lat) for lat, lon in points]

        # 50m buffer (or ~0.0005 deg for geographic CRS)
        buf = 50.0 if self.max_bbox_size > 100 else 0.0005
        elevations = [None] * len(points)

        if self.verbose:
            self._verbose_log = []

        # Group consecutive points so each group's bbox <= max_bbox_size.
        # Fetches only tiles where the route goes - avoids requesting huge
        # rasters for the full route bbox (fatal for high-res providers like NL).
        chunk_num = 0
        async with aiohttp.ClientSession() as session:
            for _indices, chunk_bbox in _group_points_by_bbox(local_pts, self.max_bbox_size, buf):
                chunk_num += 1
                tiff_bytes, req_url = await self._fetch_wcs(session, chunk_bbox)
                resolved_before = sum(1 for e in elevations if e is not None)
                self._sample_raster(tiff_bytes, chunk_bbox, local_pts, elevations)
                await asyncio.sleep(self.chunk_delay)
                if self.verbose:
                    stats = self._raster_stats(tiff_bytes)
                    resolved_now = sum(1 for e in elevations if e is not None)
                    self._verbose_log.append({
                        'chunk': chunk_num,
                        'bbox': chunk_bbox,
                        'url': req_url,
                        'resolved': resolved_now - resolved_before,
                        **stats,
                    })

        # Return list with None for points that got no valid elevation.
        # The orchestrator handles cross-border fallback for None entries.
        return elevations

    async def _fetch_wcs(self, session: aiohttp.ClientSession, bbox):
        """Fetch a WCS tile and return (tiff_bytes, request_url)."""
        xmin, ymin, xmax, ymax = bbox
        params = {
            "SERVICE": "WCS",
            "VERSION": "2.0.1",
            "REQUEST": "GetCoverage",
            "CoverageId": self.coverage_id,
            "SUBSET": [
                f"{self.subset_x_axis}({xmin},{xmax})",
                f"{self.subset_y_axis}({ymin},{ymax})",
            ],
            "FORMAT": "image/tiff",
        }
        params.update(self._extra_params())

        name = self.__class__.__name__.replace('Provider', '')
        status, body, req_url, ct = await request_with_retry(
            session,
            "GET",
            self.wcs_url,
            params=params,
            max_attempts=4,
            transient_statuses={408, 425, 429, 500, 502, 503, 504},
            retry_body_keywords=DEFAULT_RATE_LIMIT_KEYWORDS,
            verbose=self.verbose,
            log_prefix=name,
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
                f"{name} elevation server unavailable ({status_hint}). Try again later."
            )

        if "tiff" not in ct and "octet" not in ct:
            text = body_snippet(body).lower()
            if any(kw in text for kw in DEFAULT_RATE_LIMIT_KEYWORDS):
                raise ElevationError(
                    f"{name} elevation server is rate limiting requests. Please wait a moment and try again."
                )
            raise ElevationError(
                f"{name} elevation server returned unexpected data (expected TIFF, got '{ct}'). "
                f"Provider response: {body_snippet(body)}"
            )

        return body, req_url

    def _raster_stats(self, tiff_bytes: bytes) -> dict:
        """Return shape/bounds/nodata/min/max for a TIFF (for verbose diagnostics)."""
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

    def _extra_params(self) -> dict:
        """Override in subclass to add extra WCS parameters."""
        return {}

    def _is_nodata(self, val: float, ds_nodata) -> bool:
        """Check if a sampled value is a nodata sentinel.

        Handles both negative sentinels (e.g. -9999 for Spain/France) and
        large positive sentinels (e.g. AHN4: 3.4028235e+38 = float32 max).

        The old `val <= no_data_value` check was correct for negative sentinels
        but WRONG for positive ones - it flagged every valid elevation as nodata.
        """
        # 1. Rasterio's embedded nodata tag (exact match)
        if ds_nodata is not None and val == ds_nodata:
            return True
        # 2. Large positive sentinel (float32 max ~ 3.4e38). Catches AHN4 and
        #    any provider using a large positive fill value.
        if abs(val) > 1e37:
            return True
        # 3. Negative sentinel (e.g. -9999). Only applies when no_data_value < 0.
        if self.no_data_value < 0 and val <= self.no_data_value:
            return True
        # 4. Exact 0.0 is a common WCS "outside coverage" fill but is a
        #    legitimate elevation for coastal/low-lying areas. Only treat as
        #    nodata if the provider has not opted in via allow_zero_elevation.
        if not getattr(self, 'allow_zero_elevation', False) and val == 0.0:
            return True
        return False

    def _sample_raster(self, tiff_bytes, chunk_bbox, local_pts, elevations):
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
                        row, col = rowcol(ds.transform, x, y)
                        if 0 <= row < band.shape[0] and 0 <= col < band.shape[1]:
                            val = float(band[row, col])
                            if self._is_nodata(val, ds_nodata):
                                # Leave as None - caller handles fallback
                                continue
                            elevations[i] = val
                    except Exception as e:
                        raise ElevationError(
                            f"{self.__class__.__name__}: failed to sample ({x}, {y}): {e}"
                        ) from e
