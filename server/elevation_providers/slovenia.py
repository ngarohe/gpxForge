import os
import asyncio
import aiohttp
from typing import List, Tuple
from .base import ElevationProvider, ElevationError
from coord_transform import wgs84_to_d96tm
from .http_hardening import body_snippet, make_timeout, request_with_retry

# Optional rasterio import — only needed for local VRT path
try:
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import rowcol
    from rasterio.windows import Window
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False

from config import SLOVENIA_VRT as LOCAL_VRT

# ARSO DTM — ArcGIS ImageServer getSamples endpoint (1m, EPSG:3794 / D96TM)
ARSO_SAMPLES_URL = "https://gis.arso.gov.si/arcgis/rest/services/Slovenija_DMR_D96TM/ImageServer/getSamples"
ARSO_BATCH_SIZE = 200  # safe limit for getSamples multipoint payload
ARSO_TIMEOUT = make_timeout(total=35, connect=10, sock_connect=10, sock_read=25)


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


class SloveniaProvider(ElevationProvider):
    """Slovenia LIDAR elevation.

    Strategy (in order of preference):
      1. Local GeoTIFF VRT at SLOVENIA_VRT path  (fastest, no network)
      2. ARSO ArcGIS ImageServer getSamples API  (fallback if VRT missing)
    """

    is_local = True  # local VRT (or ARSO WCS fallback) — no rate limits, skip downsampling

    @property
    def country_code(self) -> str:
        return 'SI'

    @property
    def resolution(self) -> float:
        return 1.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[float]:
        if LOCAL_VRT and os.path.exists(LOCAL_VRT):
            return await asyncio.get_event_loop().run_in_executor(
                None, self._read_local_vrt, points
            )
        else:
            if not LOCAL_VRT:
                print("  [Slovenia] SLOVENIA_VRT not set, falling back to ARSO ImageServer...")
            else:
                print(f"  [Slovenia] Local VRT not found at {LOCAL_VRT!r}, falling back to ARSO ImageServer...")
            return await self._query_arso_imageserver(points)

    def _read_local_vrt(self, points: List[Tuple[float, float]]) -> List[float]:
        if not RASTERIO_AVAILABLE:
            raise ElevationError("rasterio is required for local Slovenia VRT access")

        elevations = []
        with rasterio.open(LOCAL_VRT) as dataset:
            h, w = dataset.height, dataset.width
            nodata = dataset.nodata
            for lat, lon in points:
                x, y = wgs84_to_d96tm.transform(lon, lat)
                try:
                    row, col = rowcol(dataset.transform, x, y)
                    row, col = int(row), int(col)
                    # Skip points outside the raster extent
                    if row < 0 or col < 0 or row >= h or col >= w:
                        elevations.append(None)
                        continue
                    val = dataset.read(1, window=Window(col, row, 1, 1))
                    raw = float(val[0, 0])
                    if (nodata is not None and abs(raw - float(nodata)) < 1e-6) or raw <= -9999:
                        elevations.append(None)
                        continue
                    z = raw / 10  # GMG tiles store decimeters
                    elevations.append(z)
                except Exception as e:
                    raise ElevationError(
                        f"Failed to read elevation at ({lat}, {lon}): {e}"
                    ) from e
        return elevations

    async def _query_arso_imageserver(self, points: List[Tuple[float, float]]) -> List[float]:
        """Query ARSO DTM via ArcGIS ImageServer getSamples (1m, EPSG:3794/D96TM)."""
        import json

        # Transform (lat, lon) → D96/TM (EPSG:3794)
        local_points = [wgs84_to_d96tm.transform(lon, lat) for lat, lon in points]

        elevations = []
        async with aiohttp.ClientSession() as session:
            for batch in _chunks(local_points, ARSO_BATCH_SIZE):
                geom = json.dumps({"points": [[x, y] for x, y in batch]})
                params = {
                    "geometry": geom,
                    "geometryType": "esriGeometryMultipoint",
                    "returnFirstValueOnly": "false",
                    "f": "json",
                }
                status, body, _req_url, _ct = await request_with_retry(
                    session,
                    "GET",
                    ARSO_SAMPLES_URL,
                    params=params,
                    timeout=ARSO_TIMEOUT,
                    max_attempts=4,
                    transient_statuses={408, 425, 429, 500, 502, 503, 504},
                    retry_body_keywords=("429", "rate", "too many", "quota"),
                    verbose=self.verbose,
                    log_prefix="SI/ARSO",
                )
                if status != 200:
                    raise ElevationError(
                        f"Slovenia elevation server unavailable (HTTP {status}). "
                        f"Provider response: {body_snippet(body, 220)}"
                    )
                try:
                    data = json.loads(body.decode("utf-8", errors="replace"))
                except Exception as err:
                    raise ElevationError(
                        f"Slovenia elevation server returned invalid JSON: {body_snippet(body, 220)}"
                    ) from err

                samples = data.get("samples", [])
                if len(samples) != len(batch):
                    raise ElevationError(
                        f"ARSO ImageServer returned {len(samples)} samples for {len(batch)} points"
                    )
                for s in samples:
                    val = s.get("value", "NoData")
                    if val == "NoData" or val is None:
                        elevations.append(None)
                    else:
                        z = float(val)
                        elevations.append(None if z <= -9999 else z)

        return elevations
