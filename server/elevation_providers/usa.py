"""
USA 1m/10m DTM via USGS 3DEP WCS 1.0.0 (EPSG:4326, no auth).

WCS 1.0.0 with BBOX/WIDTH/HEIGHT. CRS is EPSG:4326, no coordinate
transformation. BBOX order: lon_min,lat_min,lon_max,lat_max.
WIDTH/HEIGHT computed from degree extents times metres/degree at mid-latitude.

Does NOT inherit WCSProvider (WCS 2.0.1/SUBSET-only). Shares only
_group_points_by_bbox. max_bbox_size and buf are in decimal degrees
(~500m and ~55m respectively at mid-latitudes).
"""
import math
import asyncio
import aiohttp
from typing import List, Tuple, Optional
from .base import ElevationProvider, ElevationError
from .wcs_base import _group_points_by_bbox
from .http_hardening import body_snippet, make_timeout, request_with_retry

try:
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import rowcol
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False

WCS_URL = (
    "https://elevation.nationalmap.gov/arcgis/services"
    "/3DEPElevation/ImageServer/WCSServer"
)
COVERAGE = "DEP3Elevation"

# Bbox size and buffer in decimal degrees.
# 0.0045 deg latitude ~= 500m; varies slightly by longitude at high latitudes,
# but the chunk grouper clips width in degrees so tiles stay manageable.
MAX_BBOX_DEG = 0.0045
BUF_DEG = 0.0005   # ~= 55m padding
REQUEST_TIMEOUT = make_timeout(total=55, connect=10, sock_connect=10, sock_read=40)

# Metres per degree of latitude (constant)
_M_PER_DEG_LAT = 111_320.0


def _is_nodata(val: float, ds_nodata) -> bool:
    if ds_nodata is not None and val == ds_nodata:
        return True
    if abs(val) > 1e37:        # float32 max sentinel
        return True
    if val < -500.0:           # below Death Valley (-86m); no valid US land below -500m
        return True
    if val != val:             # NaN
        return True
    return False


class USAProvider(ElevationProvider):
    """USA 3DEP DTM - USGS WCS 1.0.0, EPSG:4326, no auth.

    Resolution is nominally 1m where 3DEP 1m LiDAR exists; falls back to
    10m (1/3 arc-second) elsewhere. The service selects automatically.
    """

    max_bbox_size = MAX_BBOX_DEG
    chunk_delay = 0.2  # USGS handles load well
    max_retries = 4

    @property
    def country_code(self) -> str:
        return 'US'

    @property
    def resolution(self) -> float:
        return 1.0

    async def get_elevations(
        self, points: List[Tuple[float, float]]
    ) -> List[Optional[float]]:
        if not RASTERIO_AVAILABLE:
            raise ElevationError("rasterio is required for USA WCS provider")

        # Geographic CRS - use (lon, lat) directly as (x, y)
        local_pts = [(lon, lat) for lat, lon in points]

        elevations: List[Optional[float]] = [None] * len(points)

        if self.verbose:
            self._verbose_log = []

        chunk_num = 0
        async with aiohttp.ClientSession() as session:
            for _indices, chunk_bbox in _group_points_by_bbox(
                local_pts, MAX_BBOX_DEG, BUF_DEG
            ):
                chunk_num += 1
                lon_min, lat_min, lon_max, lat_max = chunk_bbox
                mid_lat = (lat_min + lat_max) / 2.0
                w, h = _deg_bbox_to_pixels(lon_min, lat_min, lon_max, lat_max, mid_lat)
                tiff_bytes, req_url = await self._fetch_wcs(
                    session, chunk_bbox, w, h
                )
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

        return elevations

    async def _fetch_wcs(
        self,
        session: aiohttp.ClientSession,
        bbox: Tuple[float, float, float, float],
        w: int,
        h: int,
    ) -> Tuple[bytes, str]:
        """Fetch a WCS 1.0.0 tile; return (tiff_bytes, request_url)."""
        lon_min, lat_min, lon_max, lat_max = bbox
        params = {
            "SERVICE":  "WCS",
            "VERSION":  "1.0.0",
            "REQUEST":  "GetCoverage",
            "COVERAGE": COVERAGE,
            "CRS":      "EPSG:4326",
            "BBOX":     f"{lon_min},{lat_min},{lon_max},{lat_max}",
            "WIDTH":    w,
            "HEIGHT":   h,
            "FORMAT":   "GeoTIFF",
        }
        status, body, req_url, ct = await request_with_retry(
            session,
            "GET",
            WCS_URL,
            params=params,
            timeout=REQUEST_TIMEOUT,
            max_attempts=self.max_retries,
            transient_statuses={408, 425, 429, 500, 502, 503, 504},
            retry_body_keywords=("rate", "too many", "quota", "429"),
            verbose=self.verbose,
            log_prefix="US",
        )

        if status != 200:
            status_hint = {
                403: 'access denied',
                429: 'rate limited',
                500: 'internal server error',
                502: 'bad gateway',
                503: 'service unavailable',
                504: 'timeout',
            }.get(status, f'HTTP {status}')
            raise ElevationError(
                f"USA elevation server unavailable ({status_hint}). Try again later."
            )

        if "tiff" not in ct and "octet" not in ct:
            text = body_snippet(body).lower()
            if any(kw in text for kw in ("rate", "too many", "quota", "429")):
                raise ElevationError(
                    "USA elevation server rate limited. Try again in a few seconds."
                )
            raise ElevationError(
                f"USA elevation server returned unexpected data ('{ct}'). "
                f"Provider response: {body_snippet(body)}"
            )

        return body, req_url

    def _sample_raster(
        self,
        tiff_bytes: bytes,
        chunk_bbox: Tuple[float, float, float, float],
        local_pts: List[Tuple[float, float]],  # (lon, lat)
        elevations: List[Optional[float]],
    ) -> None:
        xmin, ymin, xmax, ymax = chunk_bbox  # (lon_min, lat_min, lon_max, lat_max)
        with MemoryFile(tiff_bytes) as memfile:
            with memfile.open() as ds:
                band = ds.read(1)
                ds_nodata = ds.nodata
                for i, (x, y) in enumerate(local_pts):  # x=lon, y=lat
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
                            f"USA 3DEP: failed to sample lon={x:.5f} lat={y:.5f}: {e}"
                        ) from e

    def _raster_stats(self, tiff_bytes: bytes) -> dict:
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


def _deg_bbox_to_pixels(
    lon_min: float, lat_min: float,
    lon_max: float, lat_max: float,
    mid_lat: float,
) -> Tuple[int, int]:
    """Convert a degree bbox to pixel dimensions at ~1m/px.

    WIDTH accounts for longitude compression at higher latitudes.
    HEIGHT uses the constant metres-per-degree-latitude.
    """
    m_per_deg_lon = _M_PER_DEG_LAT * math.cos(math.radians(mid_lat))
    w = max(1, round((lon_max - lon_min) * m_per_deg_lon))
    h = max(1, round((lat_max - lat_min) * _M_PER_DEG_LAT))
    return w, h
