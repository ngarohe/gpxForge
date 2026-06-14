"""
Belgium / Flanders — DHM Vlaanderen II, Digital Terrain Model 1 m.

Source: agentschap Digitaal Vlaanderen, "EL.GridCoverage.DTM" via the public
INSPIRE WCS 2.0.1 endpoint (https://geo.api.vlaanderen.be/el-dtm/wcs).

CRS: EPSG:4258 (ETRS89, geographic lat/lon — effectively WGS84 here).
Axis labels for SUBSET: x = longitude, y = latitude (confirmed working).
Native resolution: ~1.37e-5° ≈ 1 m. nodata = -9999.

The server is MapServer-based and returns WCS GetCoverage as a
`multipart/related` body (a GML part + the GeoTIFF part) rather than a bare
TIFF, so `_fetch_wcs` is overridden to pull the TIFF out of the multipart.

Coverage is Flanders + Brussels (roughly north of the language border).
Points outside the coverage envelope return None so the chain falls through to
the Wallonia provider.
"""
from typing import List, Optional, Tuple

from .wcs_base import WCSProvider
from .base import ElevationError
from .http_hardening import DEFAULT_RATE_LIMIT_KEYWORDS, body_snippet, request_with_retry

# Coverage envelope (EPSG:4258, lat/lon) from DescribeCoverage boundedBy.
_LAT_MIN, _LAT_MAX = 50.6275, 51.5595
_LON_MIN, _LON_MAX = 2.4612, 6.0122

_TIFF_MAGIC = (b"II*\x00", b"MM\x00*")


def _extract_tiff_from_multipart(body: bytes, content_type: str) -> bytes:
    """Return the raw GeoTIFF bytes from a (possibly multipart/related) body.

    The Flanders WCS wraps the coverage as multipart/related: a text/xml GML
    part followed by an image/tiff part. We locate the TIFF by its magic bytes
    and trim at the closing MIME boundary.
    """
    if body[:4] in _TIFF_MAGIC:
        return body  # already a bare TIFF

    start = body.find(b"II*\x00")
    if start < 0:
        start = body.find(b"MM\x00*")
    if start < 0:
        raise ElevationError(
            "Flanders WCS returned no TIFF part in multipart response: "
            f"{body_snippet(body)}"
        )

    boundary = "wcs"
    if content_type and "boundary=" in content_type:
        boundary = content_type.split("boundary=", 1)[1].split(";", 1)[0].strip().strip('"')

    end = body.rfind(b"--" + boundary.encode())
    if end <= start:
        end = len(body)
    return body[start:end].rstrip(b"\r\n")


class FlandersDhmProvider(WCSProvider):
    """DHM Vlaanderen II 1 m DTM via WCS 2.0.1 (EPSG:4258 geographic)."""

    _source_tag = "BE_FL_DHM_1M"
    subset_x_axis = "x"            # longitude
    subset_y_axis = "y"            # latitude
    no_data_value = -9999.0
    # Geographic CRS (degrees). 0.02° ≈ 2.2 km side at ~1 m → ~2200 px tiles.
    max_bbox_size = 0.02
    chunk_delay = 0.15
    allow_zero_elevation = True    # Flanders polders/coast have legitimate ~0 m

    def __init__(self):
        super().__init__()
        self.wcs_url = "https://geo.api.vlaanderen.be/el-dtm/wcs"
        self.coverage_id = "EL.GridCoverage.DTM"
        self._transformer = None   # geographic CRS → use (lon, lat) directly

    @property
    def country_code(self) -> str:
        return "BE"

    @property
    def resolution(self) -> float:
        return 1.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        # Pre-filter to the Flanders coverage envelope; everything else (Wallonia,
        # offshore) returns None and falls through to the next chain step.
        in_cov = [
            i for i, (lat, lon) in enumerate(points)
            if _LAT_MIN <= lat <= _LAT_MAX and _LON_MIN <= lon <= _LON_MAX
        ]
        if not in_cov:
            return [None] * len(points)

        subset = [points[i] for i in in_cov]
        sub_elevs = await super().get_elevations(subset)

        result: List[Optional[float]] = [None] * len(points)
        for sub_i, orig_i in enumerate(in_cov):
            result[orig_i] = sub_elevs[sub_i]
        return result

    async def _fetch_wcs(self, session, bbox):
        """GetCoverage, tolerating the multipart/related response."""
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

        status, body, req_url, ct = await request_with_retry(
            session,
            "GET",
            self.wcs_url,
            params=params,
            max_attempts=4,
            transient_statuses={408, 425, 429, 500, 502, 503, 504},
            retry_body_keywords=DEFAULT_RATE_LIMIT_KEYWORDS,
            verbose=self.verbose,
            log_prefix="FlandersDhm",
        )

        if status != 200:
            raise ElevationError(
                f"Flanders DHM WCS unavailable (HTTP {status}). Try again later."
            )

        ct_l = (ct or "").lower()
        if "tiff" not in ct_l and "octet" not in ct_l and "multipart" not in ct_l:
            text = body_snippet(body).lower()
            if any(kw in text for kw in DEFAULT_RATE_LIMIT_KEYWORDS):
                raise ElevationError(
                    "Flanders DHM WCS is rate limiting requests. Please wait and retry."
                )
            raise ElevationError(
                f"Flanders DHM WCS returned unexpected data (got '{ct}'). "
                f"Response: {body_snippet(body)}"
            )

        return _extract_tiff_from_multipart(body, ct or ""), req_url
