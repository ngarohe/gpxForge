"""
Toscana DTM providers via Regione Toscana WMS GetMap (returns float32 GeoTIFF).

The service is documented as WMS-only, but a `GetMap&FORMAT=image/tiff` request
returns a real georeferenced float32 GeoTIFF — effectively a hidden WCS.

Two layers / two resolutions:
  - rt_morfologia.iddtm.1m.irs   — 1m LIDAR (IRS 2019-2021).  Nodata = 0.0.
                                   Coverage gaps in mountainous interior.
  - rt_morfologia.iddtm.10m.rt   — 10m derived from CTR10K.  Nodata = -9999.
                                   Full regional coverage.

Pattern matches `WCSProvider` (bbox fetch + bilinear sample with rasterio).
Subclasses override `_fetch_wcs` to use WMS GetMap with FORMAT=image/tiff.

CRS: native EPSG:32632 (RDN2008/UTM 32N) but the server accepts EPSG:4326
input bboxes and returns a georeferenced TIFF in the requested CRS. We use
WGS84 bboxes directly.
"""
import aiohttp
from typing import Tuple
from .wcs_base import WCSProvider
from .base import ElevationError
from .http_hardening import (
    DEFAULT_RATE_LIMIT_KEYWORDS,
    body_snippet,
    request_with_retry,
)


TOSCANA_WMS_BASE = "https://www502.regione.toscana.it/wmsraster/com.rt.wms.RTmap/wms"


class _ToscanaWmsBase(WCSProvider):
    """Base for Toscana WMS-as-WCS providers. Subclass sets `wms_layer` + nodata."""

    wms_layer: str = ""             # e.g. "rt_morfologia.iddtm.1m.irs"
    # bbox is in WGS84 degrees — 0.05° ~ 5.5km side, returns ~500x500 px at 10m,
    # 5000x5000 at 1m (which the server caps). 0.01° → ~1.1km, ~110×110 at 10m,
    # 1100×1100 at 1m (fits well under server limits).
    max_bbox_size: float = 0.01
    # Pixel size in metres for the GetMap request. Drives width/height.
    pixel_size_m: float = 1.0

    @property
    def country_code(self) -> str:
        return 'IT'

    async def _fetch_wcs(self, session: aiohttp.ClientSession, bbox):
        """Override: fetch GeoTIFF via WMS GetMap with FORMAT=image/tiff."""
        xmin, ymin, xmax, ymax = bbox

        # Convert degree bbox to pixel dimensions targeting pixel_size_m resolution.
        # ~111km per degree of latitude; longitude scaled by cos(lat).
        import math
        lat_mid = (ymin + ymax) / 2
        deg_to_m_lat = 111320.0
        deg_to_m_lon = 111320.0 * math.cos(math.radians(lat_mid))
        height_m = (ymax - ymin) * deg_to_m_lat
        width_m = (xmax - xmin) * deg_to_m_lon
        width = max(4, min(2000, int(width_m / self.pixel_size_m)))
        height = max(4, min(2000, int(height_m / self.pixel_size_m)))

        params = {
            "map": "wmsmorfologia",
            "SERVICE": "WMS",
            "VERSION": "1.1.1",
            "REQUEST": "GetMap",
            "LAYERS": self.wms_layer,
            "STYLES": "",
            "SRS": "EPSG:4326",
            "BBOX": f"{xmin},{ymin},{xmax},{ymax}",
            "WIDTH": str(width),
            "HEIGHT": str(height),
            "FORMAT": "image/tiff",
        }

        name = self.__class__.__name__.replace('Provider', '')
        status, body, req_url, ct = await request_with_retry(
            session,
            "GET",
            TOSCANA_WMS_BASE,
            params=params,
            max_attempts=4,
            transient_statuses={408, 425, 429, 500, 502, 503, 504},
            retry_body_keywords=DEFAULT_RATE_LIMIT_KEYWORDS,
            verbose=self.verbose,
            log_prefix=name,
        )

        if status != 200:
            status_hint = {
                403: 'access denied', 404: 'endpoint not found',
                429: 'rate limited', 500: 'internal server error',
                502: 'bad gateway', 503: 'service unavailable', 504: 'timeout',
            }.get(status, f'HTTP {status}')
            raise ElevationError(
                f"{name} elevation server unavailable ({status_hint}). Try again later."
            )

        if "tiff" not in ct and "octet" not in ct:
            text = body_snippet(body).lower()
            if any(kw in text for kw in DEFAULT_RATE_LIMIT_KEYWORDS):
                raise ElevationError(
                    f"{name} is rate limiting requests. Please wait a moment and try again."
                )
            raise ElevationError(
                f"{name} returned unexpected data (expected TIFF, got '{ct}'). "
                f"Provider response: {body_snippet(body)}"
            )

        return body, req_url


class ToscanaDtm1mProvider(_ToscanaWmsBase):
    """Toscana 1m LIDAR DTM (IRS 2019-2021). Partial coverage."""
    wms_layer = "rt_morfologia.iddtm.1m.irs"
    no_data_value = 0.0
    pixel_size_m = 1.0
    max_bbox_size = 0.01  # ~1.1km in lat, ~0.8km in lon
    _source_tag = "IT_TOSCANA_1M"

    @property
    def resolution(self) -> float:
        return 1.0


class ToscanaDtm10mProvider(_ToscanaWmsBase):
    """Toscana 10m DTM from CTR10K. Full regional coverage. Fallback for 1m gaps."""
    wms_layer = "rt_morfologia.iddtm.10m.rt"
    no_data_value = -9999.0
    pixel_size_m = 10.0
    max_bbox_size = 0.05  # ~5.5km × ~4km → 550×450 px (well under limits)
    _source_tag = "IT_TOSCANA_10M"

    @property
    def resolution(self) -> float:
        return 10.0
