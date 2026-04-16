import asyncio
import aiohttp
from typing import List, Tuple, Optional
from .base import ElevationProvider, ElevationError


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


class FranceProvider(ElevationProvider):
    BASE_URL = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest"
    RESOURCE_PRIMARY  = "ign_lidar_hd_mnt_mono_wld"  # 0.5m real LIDAR HD (~46% coverage)
    RESOURCE_FALLBACK = "ign_rge_alti_wld"            # 1m RGE ALTI (100% coverage)
    BATCH_SIZE = 120
    BATCH_DELAY = 0.35
    REQUEST_TIMEOUT_S = 45
    MAX_RETRIES = 5
    RETRYABLE_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})

    @property
    def country_code(self) -> str:
        return 'FR'

    @property
    def resolution(self) -> float:
        return 0.5

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[float]:
        # Pass 1: query LIDAR HD for all points
        elevations: List[Optional[float]] = await self._query_resource(points, self.RESOURCE_PRIMARY)

        # Collect indices where LIDAR HD returned nodata (-99999 or None)
        nodata_indices = [i for i, e in enumerate(elevations) if e is None]

        if nodata_indices:
            # Pass 2: fallback to RGE ALTI for uncovered points
            fallback_points = [points[i] for i in nodata_indices]
            fallback_elevations = await self._query_resource(fallback_points, self.RESOURCE_FALLBACK)
            for idx, elev in zip(nodata_indices, fallback_elevations):
                elevations[idx] = elev

            lidar_count = len(points) - len(nodata_indices)
            fallback_count = len(nodata_indices)
            print(f"    France: {lidar_count} pts from LIDAR HD (0.5m), "
                  f"{fallback_count} pts from RGE ALTI fallback (1m)")
        else:
            print(f"    France: {len(points)} pts from LIDAR HD (0.5m)")

        return elevations

    async def _query_resource(
        self,
        points: List[Tuple[float, float]],
        resource: str,
    ) -> List[Optional[float]]:
        """Fetch elevations from a specific France API resource."""
        elevations: List[Optional[float]] = []
        timeout = aiohttp.ClientTimeout(total=self.REQUEST_TIMEOUT_S)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            for batch in _chunks(points, self.BATCH_SIZE):
                lons = "|".join(str(p[1]) for p in batch)
                lats = "|".join(str(p[0]) for p in batch)
                url = (
                    f"{self.BASE_URL}/elevation.json"
                    f"?resource={resource}"
                    f"&lon={lons}&lat={lats}"
                )
                batch_ok = False
                last_err = ""
                for attempt in range(self.MAX_RETRIES):
                    try:
                        async with session.get(url) as resp:
                            if resp.status == 200:
                                data = await resp.json()
                                if 'elevations' not in data or len(data['elevations']) != len(batch):
                                    last_err = "unexpected_response"
                                    break
                                for e in data['elevations']:
                                    z = e.get('z')
                                    if z is None or z == -99999 or z == -99999.0:
                                        elevations.append(None)
                                    else:
                                        elevations.append(float(z))
                                batch_ok = True
                                break

                            if resp.status in self.RETRYABLE_STATUSES:
                                last_err = f"http_{resp.status}"
                                retry_after = resp.headers.get("Retry-After")
                                wait = 1.2 * (attempt + 1)
                                if retry_after:
                                    try:
                                        wait = max(wait, float(retry_after))
                                    except ValueError:
                                        pass
                                await asyncio.sleep(wait)
                                continue

                            text = await resp.text()
                            raise ElevationError(
                                f"France API error {resp.status}: {text[:200]}"
                            )
                    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                        last_err = f"network_{type(e).__name__}"
                        wait = 1.2 * (attempt + 1)
                        await asyncio.sleep(wait)
                        continue

                if not batch_ok:
                    # Keep pipeline running: unresolved points stay None and may be filled
                    # by fallback resource / cross-border fallback later.
                    print(
                        f"    [FR/{resource}] batch failed after {self.MAX_RETRIES} retries "
                        f"({len(batch)} pts, {last_err or 'unknown'}) -> keeping nodata"
                    )
                    elevations.extend([None] * len(batch))
                await asyncio.sleep(self.BATCH_DELAY)
        return elevations
