"""
Piemonte DTM 5m provider via ARPA Piemonte ArcGIS ImageServer.

Native 5m LIDAR DTM from the ICE 2009-2011 survey. Coverage: all of Piemonte
plus cross-border Alps (France). Source dataset:
  DTM_Piemonte_ICE-2010_05m_32632  (UTM 32N reprojected to Web Mercator 3857)

Uses the ImageServer `getSamples` endpoint — accepts a multipoint geometry in
WGS84 and returns one elevation per point in a single request. ~1000+ pts/s.

Service: webgis.arpa.piemonte.it/ags/rest/services/topografia_dati_di_base/
         DTM_multiscala_transfrontaliero_NEW/ImageServer
"""
import asyncio
import json
import aiohttp
from typing import List, Tuple, Optional
from .base import ElevationProvider, ElevationError


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


class PiemonteProvider(ElevationProvider):
    GETSAMPLES_URL = (
        "https://webgis.arpa.piemonte.it/ags/rest/services"
        "/topografia_dati_di_base/DTM_multiscala_transfrontaliero_NEW"
        "/ImageServer/getSamples"
    )
    BATCH_SIZE = 200
    BATCH_DELAY = 0.2
    REQUEST_TIMEOUT_S = 30
    MAX_RETRIES = 3
    RETRYABLE_STATUSES = frozenset({408, 429, 500, 502, 503, 504})
    _source_tag = "IT_PIEMONTE_5M"

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
        print(f"    Piemonte: {resolved}/{len(points)} pts resolved")
        return elevations

    async def _query_batch(
        self,
        session: aiohttp.ClientSession,
        points: List[Tuple[float, float]],
        batch_num: int,
    ) -> List[Optional[float]]:
        """Query getSamples for a batch of points (WGS84)."""
        geom = {
            "points": [[lon, lat] for lat, lon in points],
            "spatialReference": {"wkid": 4326},
        }
        data = {
            "geometry": json.dumps(geom),
            "geometryType": "esriGeometryMultipoint",
            "returnFirstValueOnly": "true",
            "f": "json",
        }

        last_err = ""
        for attempt in range(self.MAX_RETRIES):
            try:
                async with session.post(self.GETSAMPLES_URL, data=data) as resp:
                    if resp.status == 200:
                        result = await resp.json(content_type=None)
                        return self._parse_samples(result, len(points))

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

        print(f"    [Piemonte] batch {batch_num} failed ({last_err}) -> {len(points)} pts nodata")
        return [None] * len(points)

    @staticmethod
    def _parse_samples(result: dict, expected_count: int) -> List[Optional[float]]:
        """Parse getSamples JSON response.

        Response structure:
          { "samples": [ {"value":"123.45", "locationId":0, ...}, ... ] }

        Each sample's `locationId` is the index into the input multipoint array.
        Points outside coverage are dropped (no entry for that index).
        """
        samples = result.get("samples", [])
        elevations: List[Optional[float]] = [None] * expected_count

        for s in samples:
            loc_id = s.get("locationId")
            if loc_id is None or loc_id < 0 or loc_id >= expected_count:
                continue
            val = s.get("value")
            if val is None:
                continue
            try:
                v = float(str(val).strip())
                if v == -9999 or v == -9999.0 or abs(v) > 1e37:
                    continue
                elevations[loc_id] = v
            except (ValueError, TypeError):
                continue

        return elevations
