"""
Lombardia DTM 5m provider via ArcGIS REST MapServer Identify.

The regional DTM is a composite (LIDAR RL, LIDAR MATTM, LIDAR ADBPO, DBT,
DEM20 gap-fill) served as a MapServer — no WCS or ImageServer export available.
The Identify endpoint returns per-point pixel values at ~1400 pts/s.

Endpoint: https://www.cartografia.servizirl.it/arcgis/rest/services/wms/DTM5_RL_wms/MapServer/identify
Layer 2 ("DTM5x5 - Ombre") returns actual elevation in metres.
"""
import asyncio
import json
import aiohttp
from typing import List, Tuple, Optional
from .base import ElevationProvider, ElevationError


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


class LombardiaProvider(ElevationProvider):
    IDENTIFY_URL = (
        "https://www.cartografia.servizirl.it/arcgis/rest/services"
        "/wms/DTM5_RL_wms/MapServer/identify"
    )
    BATCH_SIZE = 1000
    BATCH_DELAY = 0.3
    REQUEST_TIMEOUT_S = 30
    MAX_RETRIES = 3
    RETRYABLE_STATUSES = frozenset({408, 429, 500, 502, 503, 504})
    _source_tag = "IT_LOMBARDIA_5M"

    # Lombardia approximate extent for mapExtent param
    MAP_EXTENT = "8.4,44.6,11.6,46.7"

    @property
    def country_code(self) -> str:
        return 'IT'

    @property
    def resolution(self) -> float:
        return 5.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[float]:
        elevations: List[Optional[float]] = [None] * len(points)
        timeout = aiohttp.ClientTimeout(total=self.REQUEST_TIMEOUT_S)

        if self.verbose:
            self._verbose_log = []

        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            batch_num = 0
            for batch_indices in _chunks(list(range(len(points))), self.BATCH_SIZE):
                batch_num += 1
                batch_points = [points[i] for i in batch_indices]
                batch_elevs = await self._query_batch(session, batch_points, batch_num)

                for idx, elev in zip(batch_indices, batch_elevs):
                    elevations[idx] = elev

                if batch_num > 1:
                    await asyncio.sleep(self.BATCH_DELAY)

        resolved = sum(1 for e in elevations if e is not None)
        print(f"    Lombardia: {resolved}/{len(points)} pts resolved via Identify")
        return elevations

    async def _query_batch(
        self,
        session: aiohttp.ClientSession,
        points: List[Tuple[float, float]],
        batch_num: int,
    ) -> List[Optional[float]]:
        """Query the Identify endpoint for a batch of points."""
        # Build multipoint geometry in WGS84 (lon, lat)
        mp = {
            "points": [[lon, lat] for lat, lon in points],
            "spatialReference": {"wkid": 4326},
        }

        data = {
            "geometry": json.dumps(mp),
            "geometryType": "esriGeometryMultipoint",
            "layers": "all:2",
            "tolerance": "0",
            "mapExtent": self.MAP_EXTENT,
            "imageDisplay": "600,400,96",
            "returnGeometry": "false",
            "f": "json",
        }

        last_err = ""
        for attempt in range(self.MAX_RETRIES):
            try:
                async with session.post(self.IDENTIFY_URL, data=data) as resp:
                    if resp.status == 200:
                        result = await resp.json(content_type=None)
                        return self._parse_identify_results(result, len(points))

                    if resp.status in self.RETRYABLE_STATUSES:
                        last_err = f"http_{resp.status}"
                        await asyncio.sleep(1.5 * (attempt + 1))
                        continue

                    text = await resp.text()
                    last_err = f"http_{resp.status}: {text[:200]}"
                    break

            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                last_err = f"network_{type(e).__name__}"
                await asyncio.sleep(1.5 * (attempt + 1))
                continue

        print(f"    [Lombardia] batch {batch_num} failed ({last_err}) -> {len(points)} pts nodata")
        return [None] * len(points)

    def _parse_identify_results(
        self,
        result: dict,
        expected_count: int,
    ) -> List[Optional[float]]:
        """Parse Identify JSON response into elevation list.

        When all points are within coverage, results match input order and count.
        Points outside coverage are silently dropped by the server, so we may
        get fewer results — return None for unmatched positions.
        """
        results = result.get("results", [])

        if len(results) == expected_count:
            elevations = []
            for r in results:
                val = self._extract_elevation(r)
                elevations.append(val)
            return elevations

        # Fewer results than points — server dropped some
        # Without geometry in the response we can't reliably map back,
        # so return None for the whole batch (orchestrator falls back)
        if len(results) < expected_count:
            elevations = []
            for r in results:
                elevations.append(self._extract_elevation(r))
            # Pad with None for dropped points
            elevations.extend([None] * (expected_count - len(results)))
            return elevations

        return [None] * expected_count

    @staticmethod
    def _extract_elevation(result_item: dict) -> Optional[float]:
        """Extract elevation value from a single Identify result."""
        attrs = result_item.get("attributes", {})
        # The pixel value key varies — try common names
        for key in ("Pixel Value", "PixelValue", "Stretch.Pixel Value", "value"):
            val = attrs.get(key)
            if val is not None:
                try:
                    v = float(str(val).strip())
                    if v == -9999 or v == -9999.0 or abs(v) > 1e37:
                        return None
                    return v
                except (ValueError, TypeError):
                    continue
        return None
