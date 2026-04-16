"""
Poland 1m DTM via GUGiK WCS 2.0.1 (EPSG:2180, Poland CS2000).

The server's image/tiff output is broken (returns uint8, clipping values
at 255m). We use FORMAT=image/x-aaigrid which returns full float32
precision wrapped in a MIME multipart response. The MIME envelope is
stripped and the ASCII grid is parsed directly with rasterio.

No authentication required.
"""
import aiohttp
import io
from pyproj import Transformer
from typing import List, Tuple, Optional
from .base import ElevationProvider, ElevationError
from .wcs_base import _group_points_by_bbox
from .http_hardening import (
    DEFAULT_RATE_LIMIT_KEYWORDS,
    body_snippet,
    make_timeout,
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

WCS_URL = "https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WCS/DigitalTerrainModel"
COVERAGE = "DTM_PL-EVRF2007-NH"
MAX_BBOX_M = 500.0
BUF_M = 50.0
REQUEST_TIMEOUT = make_timeout(total=50, connect=10, sock_connect=10, sock_read=35)


def _strip_mime(body: bytes) -> bytes:
    """Strip MIME multipart wrapper, returning the raw ASCII grid payload.

    The server wraps the response in multipart MIME with two parts:
        --wcs\\r\\n
        Content-Type: image/x-aaigrid\\r\\n  (part 1: the grid)
        ...\\r\\n
        \\r\\n
        <actual grid data>
        \\r\\n--wcs\\r\\n
        Content-Type: ...\\r\\n  (part 2: .prj file)
        ...
        \\r\\n--wcs--\\r\\n
    We extract only the grid data (between the first blank line and the
    next --wcs boundary).
    """
    # Find the first blank line (end of MIME headers for part 1)
    for sep in (b'\r\n\r\n', b'\n\n'):
        idx = body.find(sep)
        if idx != -1:
            payload = body[idx + len(sep):]
            # Trim at the FIRST inner boundary (not the last)
            for trail in (b'\r\n--wcs', b'\n--wcs'):
                end = payload.find(trail)
                if end != -1:
                    payload = payload[:end]
                    break
            return payload
    return body  # no MIME wrapper found — return as-is


def _parse_aaigrid(data: bytes) -> Tuple[np.ndarray, dict]:
    """Parse Arc/Info ASCII Grid into a numpy array and header dict.

    Returns (values_2d, header) where header has ncols, nrows,
    xllcorner, yllcorner, cellsize, and optionally NODATA_value.
    """
    text = data.decode('ascii', errors='replace')
    lines = text.strip().split('\n')

    header = {}
    data_start = 0
    for i, line in enumerate(lines):
        parts = line.strip().split()
        if len(parts) == 2 and parts[0].lower() in (
            'ncols', 'nrows', 'xllcorner', 'yllcorner', 'cellsize',
            'nodata_value', 'dx', 'dy',
        ):
            key = parts[0].lower()
            header[key] = int(float(parts[1])) if key in ('ncols', 'nrows') else float(parts[1])
            data_start = i + 1
        else:
            break

    ncols = header.get('ncols', 0)
    nrows = header.get('nrows', 0)
    # Some responses use dx/dy instead of cellsize
    if 'cellsize' not in header and 'dx' in header:
        header['cellsize'] = header['dx']

    values = []
    for line in lines[data_start:]:
        stripped = line.strip()
        if not stripped:
            continue
        values.extend(float(v) for v in stripped.split())

    arr = np.array(values[:ncols * nrows], dtype=np.float32).reshape(nrows, ncols)
    return arr, header


def _is_nodata(val: float, nodata_val) -> bool:
    if nodata_val is not None and val == nodata_val:
        return True
    if abs(val) > 1e37:
        return True
    if val != val:  # NaN
        return True
    # Poland has coastal areas at 0m — allow zero elevation
    return False


class PolandProvider(ElevationProvider):
    """Poland 1m DTM — GUGiK WCS 2.0.1, EPSG:2180.

    Uses ASCII grid format (image/x-aaigrid) because the server's
    GeoTIFF output is uint8-only (clips at 255m).
    """

    max_bbox_size = MAX_BBOX_M

    def __init__(self):
        self._transformer = Transformer.from_crs(
            "EPSG:4326", "EPSG:2180", always_xy=True
        )

    @property
    def country_code(self) -> str:
        return 'PL'

    @property
    def resolution(self) -> float:
        return 1.0

    @property
    def coverage_id(self) -> str:
        return COVERAGE

    async def get_elevations(
        self, points: List[Tuple[float, float]]
    ) -> List[Optional[float]]:
        if not RASTERIO_AVAILABLE:
            raise ElevationError("numpy is required for Poland WCS provider")

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
                self._sample_grid(tiff_bytes, chunk_bbox, local_pts, elevations)
                if self.verbose:
                    resolved_now = sum(1 for e in elevations if e is not None)
                    self._verbose_log.append({
                        'chunk': chunk_num,
                        'bbox': chunk_bbox,
                        'url': req_url,
                        'resolved': resolved_now - resolved_before,
                    })

        return elevations

    async def _fetch_wcs(
        self, session: aiohttp.ClientSession, bbox: Tuple[float, float, float, float]
    ) -> Tuple[bytes, str]:
        xmin, ymin, xmax, ymax = bbox
        params = {
            "SERVICE": "WCS",
            "VERSION": "2.0.1",
            "REQUEST": "GetCoverage",
            "CoverageId": COVERAGE,
            "SUBSET": [
                f"x({xmin},{xmax})",
                f"y({ymin},{ymax})",
            ],
            "FORMAT": "image/x-aaigrid",
        }
        status, body, req_url, _ct = await request_with_retry(
            session,
            "GET",
            WCS_URL,
            params=params,
            timeout=REQUEST_TIMEOUT,
            max_attempts=4,
            transient_statuses={408, 425, 429, 500, 502, 503, 504},
            retry_body_keywords=DEFAULT_RATE_LIMIT_KEYWORDS,
            verbose=self.verbose,
            log_prefix="PL",
        )
        if status != 200:
            raise ElevationError(
                f"Poland WCS error {status}: {body_snippet(body)}"
            )
        return body, req_url

    def _sample_grid(
        self,
        raw_bytes: bytes,
        chunk_bbox: Tuple[float, float, float, float],
        local_pts: List[Tuple[float, float]],
        elevations: List[Optional[float]],
    ) -> None:
        xmin, ymin, xmax, ymax = chunk_bbox
        payload = _strip_mime(raw_bytes)
        arr, header = _parse_aaigrid(payload)

        nodata_val = header.get('nodata_value')
        xll = header['xllcorner']
        yll = header['yllcorner']
        cellsize = header['cellsize']
        nrows, ncols = arr.shape

        for i, (x, y) in enumerate(local_pts):
            if elevations[i] is not None:
                continue
            if not (xmin <= x <= xmax and ymin <= y <= ymax):
                continue
            # Convert projected coords to grid row/col
            col = int((x - xll) / cellsize)
            row = int((yll + nrows * cellsize - y) / cellsize)
            if 0 <= row < nrows and 0 <= col < ncols:
                val = float(arr[row, col])
                if not _is_nodata(val, nodata_val):
                    elevations[i] = val

    def _raster_stats(self, raw_bytes: bytes) -> dict:
        payload = _strip_mime(raw_bytes)
        arr, header = _parse_aaigrid(payload)
        nrows, ncols = arr.shape
        return {
            'shape': (nrows, ncols),
            'bounds': (header['xllcorner'], header['yllcorner'],
                       header['xllcorner'] + ncols * header['cellsize'],
                       header['yllcorner'] + nrows * header['cellsize']),
            'ds_nodata': header.get('nodata_value'),
            'raster_min': float(arr.min()),
            'raster_max': float(arr.max()),
        }
