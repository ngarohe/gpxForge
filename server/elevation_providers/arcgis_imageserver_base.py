"""
Generic ArcGIS REST ImageServer elevation provider base class.

Subclass and set: service_url, wkid, _source_tag, and implement
country_code/resolution properties.

Fetches elevation rasters via the exportImage endpoint, which returns a
GeoTIFF URL that we download and sample with rasterio (bilinear interpolation).
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
    import numpy as np
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False


def _group_points_by_bbox(local_pts, max_size, buf):
    """Group consecutive points so each group's bbox stays <= max_size."""
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


class ArcGISImageServerProvider(ElevationProvider):
    """Generic ArcGIS REST ImageServer provider. Subclass per region."""

    service_url: str = ""
    wkid: int = 0
    no_data_value: float = -9999.0
    max_bbox_size: float = 5000.0
    chunk_delay: float = 0.3
    _source_tag: str = ""

    def __init__(self):
        self._transformer = None

    @property
    def transformer(self):
        return self._transformer

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[float]:
        if not RASTERIO_AVAILABLE:
            raise ElevationError("rasterio is required for ArcGIS ImageServer providers")

        if self.transformer is not None:
            local_pts = [self.transformer.transform(lon, lat) for lat, lon in points]
        else:
            local_pts = [(lon, lat) for lat, lon in points]

        buf = 50.0
        elevations = [None] * len(points)

        if self.verbose:
            self._verbose_log = []

        chunk_num = 0
        async with aiohttp.ClientSession() as session:
            for _indices, chunk_bbox in _group_points_by_bbox(local_pts, self.max_bbox_size, buf):
                chunk_num += 1
                tiff_bytes = await self._fetch_export_image(session, chunk_bbox)
                if tiff_bytes is None:
                    continue
                resolved_before = sum(1 for e in elevations if e is not None)
                self._sample_raster(tiff_bytes, chunk_bbox, local_pts, elevations)
                await asyncio.sleep(self.chunk_delay)
                if self.verbose:
                    resolved_now = sum(1 for e in elevations if e is not None)
                    self._verbose_log.append({
                        'chunk': chunk_num,
                        'bbox': chunk_bbox,
                        'resolved': resolved_now - resolved_before,
                    })

        return elevations

    def _bbox_to_pixels(self, bbox):
        """Calculate pixel dimensions for the bbox at native resolution."""
        xmin, ymin, xmax, ymax = bbox
        width = max(1, int((xmax - xmin) / self.resolution))
        height = max(1, int((ymax - ymin) / self.resolution))
        width = min(width, 4000)
        height = min(height, 4000)
        return width, height

    async def _fetch_export_image(self, session: aiohttp.ClientSession, bbox):
        """Fetch a raster tile via exportImage and return TIFF bytes."""
        xmin, ymin, xmax, ymax = bbox
        width, height = self._bbox_to_pixels(bbox)

        url = f"{self.service_url}/exportImage"
        params = {
            "bbox": f"{xmin},{ymin},{xmax},{ymax}",
            "bboxSR": str(self.wkid),
            "size": f"{width},{height}",
            "imageSR": str(self.wkid),
            "format": "tiff",
            "noData": str(int(self.no_data_value)),
            "interpolation": "RSP_BilinearInterpolation",
            "f": "json",
        }

        name = self.__class__.__name__.replace('Provider', '')
        status, body, req_url, ct = await request_with_retry(
            session,
            "GET",
            url,
            params=params,
            max_attempts=3,
            transient_statuses={408, 429, 500, 502, 503, 504},
            retry_body_keywords=DEFAULT_RATE_LIMIT_KEYWORDS,
            verbose=self.verbose,
            log_prefix=name,
        )

        if status != 200:
            raise ElevationError(
                f"{name} ImageServer unavailable (HTTP {status}). Try again later."
            )

        # exportImage returns JSON with an href to the TIFF
        import json
        try:
            resp = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ElevationError(
                f"{name} ImageServer returned non-JSON: {body_snippet(body)}"
            )

        href = resp.get("href")
        if not href:
            error = resp.get("error", {})
            if error:
                raise ElevationError(
                    f"{name} ImageServer error: {error.get('message', str(error))}"
                )
            return None

        # Fetch the actual TIFF
        status2, tiff_bytes, _, ct2 = await request_with_retry(
            session,
            "GET",
            href,
            max_attempts=2,
            transient_statuses={408, 500, 502, 503, 504},
            verbose=self.verbose,
            log_prefix=f"{name}_tiff",
        )

        if status2 != 200:
            return None

        return tiff_bytes

    def _is_nodata(self, val: float, ds_nodata) -> bool:
        if ds_nodata is not None and val == ds_nodata:
            return True
        if abs(val) > 1e37:
            return True
        if self.no_data_value < 0 and val <= self.no_data_value:
            return True
        return False

    def _sample_raster(self, tiff_bytes, chunk_bbox, local_pts, elevations):
        xmin, ymin, xmax, ymax = chunk_bbox
        with MemoryFile(tiff_bytes) as memfile:
            with memfile.open() as ds:
                band = ds.read(1).astype('float64')
                ds_nodata = ds.nodata
                rows, cols = band.shape
                for i, (x, y) in enumerate(local_pts):
                    if elevations[i] is not None:
                        continue
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
                            elevations[i] = float(v00)
                            continue
                        val = (v00 * (1 - dr) * (1 - dc) +
                               v01 * (1 - dr) * dc +
                               v10 * dr * (1 - dc) +
                               v11 * dr * dc)
                        elevations[i] = float(val)
                    except Exception as e:
                        raise ElevationError(
                            f"{self.__class__.__name__}: failed to sample ({x}, {y}): {e}"
                        ) from e
