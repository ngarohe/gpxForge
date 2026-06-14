"""
Denmark 0.4m DTM via Dataforsyningen WCS 1.0.0 (EPSG:25832, UTM zone 32N).

WCS 1.0.0 with BBOX/WIDTH/HEIGHT pattern (same as Norway).
Token passed as URL query parameter &token=...
Does NOT inherit WCSProvider (which is 2.0.1-only); shares only the
_group_points_by_bbox helper.
"""
import math
import aiohttp
from pyproj import Transformer
from typing import List, Tuple, Optional
from .base import ElevationProvider, ElevationError
from .wcs_base import _group_points_by_bbox
from .http_hardening import DEFAULT_RATE_LIMIT_KEYWORDS, body_snippet, request_with_retry

try:
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import rowcol
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False

WCS_URL = "https://api.dataforsyningen.dk/dhm_wcs_DAF"
COVERAGE = "dhm_terraen"
MAX_BBOX_M = 500.0   # max chunk side in EPSG:25832 metres
BUF_M = 50.0         # bbox padding in metres


def _is_nodata(val: float, ds_nodata) -> bool:
    """Reject nodata sentinels."""
    if ds_nodata is not None and val == ds_nodata:
        return True
    if abs(val) > 1e37:
        return True
    if val < -100.0:
        return True
    if val != val:               # NaN
        return True
    return False


class DenmarkProvider(ElevationProvider):
    """Denmark 0.4m DHM Terræn — Dataforsyningen WCS 1.0.0, EPSG:25832.

    Requests are split into ≤500m chunks. WIDTH and HEIGHT are derived from
    the bbox dimensions at 1m resolution (conservative — native is 0.4m/px).
    Token is passed as a URL query parameter.
    """

    max_bbox_size = MAX_BBOX_M

    def __init__(self):
        from config import DENMARK_TOKEN
        self._token = DENMARK_TOKEN
        self._transformer = Transformer.from_crs(
            "EPSG:4326", "EPSG:25832", always_xy=True
        )

    @property
    def country_code(self) -> str:
        return 'DK'

    @property
    def resolution(self) -> float:
        return 0.4

    async def get_elevations(
        self, points: List[Tuple[float, float]]
    ) -> List[Optional[float]]:
        if not self._token:
            raise ElevationError(
                "Denmark elevation requires a token. "
                "Register free at https://dataforsyningen.dk/user/create "
                "then add DENMARK_TOKEN to your config.py"
            )
        if not RASTERIO_AVAILABLE:
            raise ElevationError("rasterio is required for Denmark WCS provider")

        # Transform (lat, lon) → EPSG:25832 (x=easting, y=northing)
        local_pts = [
            self._transformer.transform(lon, lat) for lat, lon in points
        ]

        elevations: List[Optional[float]] = [None] * len(points)

        if self.verbose:
            self._verbose_log = []

        chunk_num = 0
        async with aiohttp.ClientSession() as session:
            for _indices, chunk_bbox in _group_points_by_bbox(
                local_pts, MAX_BBOX_M, BUF_M
            ):
                chunk_num += 1
                tiff_bytes, req_url = await self._fetch_wcs(session, chunk_bbox)
                resolved_before = sum(1 for e in elevations if e is not None)
                self._sample_raster(tiff_bytes, chunk_bbox, local_pts, elevations)
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

        return elevations

    async def _fetch_wcs(
        self, session: aiohttp.ClientSession, bbox: Tuple[float, float, float, float]
    ) -> Tuple[bytes, str]:
        """Fetch a WCS 1.0.0 tile; return (tiff_bytes, request_url)."""
        xmin, ymin, xmax, ymax = bbox
        # WIDTH/HEIGHT at 1m/px, rounded up so no pixel is missed
        w = max(1, math.ceil(xmax - xmin))
        h = max(1, math.ceil(ymax - ymin))

        params = {
            "service":  "WCS",
            "VERSION":  "1.0.0",
            "REQUEST":  "GetCoverage",
            "COVERAGE": COVERAGE,
            "CRS":      "EPSG:25832",
            "BBOX":     f"{xmin},{ymin},{xmax},{ymax}",
            "WIDTH":    w,
            "HEIGHT":   h,
            "FORMAT":   "GTiff",
            "token":    self._token,
        }

        status, body, req_url, ct = await request_with_retry(
            session,
            "GET",
            WCS_URL,
            params=params,
            max_attempts=4,
            transient_statuses={408, 425, 429, 500, 502, 503, 504},
            retry_body_keywords=DEFAULT_RATE_LIMIT_KEYWORDS,
            verbose=self.verbose,
            log_prefix="DK",
        )
        if status != 200:
            raise ElevationError(
                f"Denmark WCS error {status}: {body_snippet(body)}"
            )
        if "tiff" not in ct and "octet" not in ct:
            raise ElevationError(
                f"Denmark WCS unexpected content-type '{ct}': {body_snippet(body)}"
            )
        return body, req_url

    def _sample_raster(
        self,
        tiff_bytes: bytes,
        chunk_bbox: Tuple[float, float, float, float],
        local_pts: List[Tuple[float, float]],
        elevations: List[Optional[float]],
    ) -> None:
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
                            if not _is_nodata(val, ds_nodata):
                                elevations[i] = val
                    except Exception as e:
                        raise ElevationError(
                            f"Denmark DTM: failed to sample ({x:.1f}, {y:.1f}): {e}"
                        ) from e

    def _raster_stats(self, tiff_bytes: bytes) -> dict:
        """Return shape/bounds/nodata/min/max for verbose diagnostics."""
        with MemoryFile(tiff_bytes) as memfile:
            with memfile.open() as ds:
                band = ds.read(1)
                return {
                    'shape':      ds.shape,
                    'bounds':     tuple(ds.bounds),
                    'ds_nodata':  ds.nodata,
                    'raster_min': float(band.min()),
                    'raster_max': float(band.max()),
                }
