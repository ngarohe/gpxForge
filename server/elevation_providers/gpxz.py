import json
import asyncio
import aiohttp
from typing import List, Tuple
from .base import ElevationProvider, ElevationError
from config import GPXZ_API_KEY
from .http_hardening import body_snippet, make_timeout, request_with_retry

GPXZ_MAX_RESOLUTION_M = 10  # reject sources coarser than 10m (e.g. Copernicus ~30m)


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


class GPXZProvider(ElevationProvider):
    """GPXZ API elevation provider — accepts any hi-res source (≤ 10m resolution).

    Batch queries: up to 512 points per request, pipe-separated lat,lon pairs.
    Validates resolution per point; returns None for points where the best
    available source is coarser than GPXZ_MAX_RESOLUTION_M.
    """
    BATCH_SIZE = 512
    ENDPOINT = "https://api.gpxz.io/v1/elevation/points"
    RATE_LIMIT_DELAY = 1.1  # free tier: 1 request/second
    REQUEST_TIMEOUT = make_timeout(total=40, connect=10, sock_connect=10, sock_read=25)

    def __init__(self, country_code: str = 'GB'):
        self._country_code = country_code

    @property
    def country_code(self) -> str:
        return self._country_code

    @property
    def resolution(self) -> float:
        return 1.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[float]:
        if not GPXZ_API_KEY:
            raise ElevationError(
                "GPXZ elevation requires an API key. "
                "Register free at https://www.gpxz.io/account "
                "then add GPXZ_API_KEY to your config.py"
            )

        elevations = []
        headers = {"x-api-key": GPXZ_API_KEY}

        if self.verbose:
            self._verbose_log = {}  # {(source, resolution_m): count}

        batches = list(_chunks(points, self.BATCH_SIZE))
        async with aiohttp.ClientSession() as session:
            for i, batch in enumerate(batches):
                latlons = "|".join(f"{lat},{lon}" for lat, lon in batch)
                url = f"{self.ENDPOINT}?latlons={latlons}"
                status, body, _req_url, _ct = await request_with_retry(
                    session,
                    "GET",
                    url,
                    headers=headers,
                    timeout=self.REQUEST_TIMEOUT,
                    max_attempts=4,
                    transient_statuses={408, 425, 429, 500, 502, 503, 504},
                    retry_body_keywords=("429", "rate", "too many", "quota"),
                    verbose=self.verbose,
                    log_prefix="GPXZ",
                )
                if status != 200:
                    raise ElevationError(
                        f"GPXZ API error {status}: {body_snippet(body, 220)}"
                    )
                try:
                    data = json.loads(body.decode("utf-8", errors="replace"))
                except Exception:
                    raise ElevationError(
                        f"GPXZ API returned invalid JSON: {body_snippet(body, 220)}"
                    ) from None

                results = data.get("results", [])
                if len(results) != len(batch):
                    raise ElevationError(
                        f"GPXZ returned {len(results)} results for {len(batch)} points"
                    )

                for pt in results:
                    elev = pt.get("elevation")
                    source = pt.get("data_source", "unknown")
                    resolution_m = pt.get("resolution", 999)
                    if elev is None:
                        elevations.append(None)
                        continue
                    if resolution_m > GPXZ_MAX_RESOLUTION_M:
                        print(f"  [GPXZ] Rejected: source '{source}' at {resolution_m}m "
                              f"(>{GPXZ_MAX_RESOLUTION_M}m threshold)")
                        elevations.append(None)
                        continue
                    if self.verbose:
                        key = (source, resolution_m)
                        self._verbose_log[key] = self._verbose_log.get(key, 0) + 1
                    elevations.append(float(elev))

                if i < len(batches) - 1:
                    await asyncio.sleep(self.RATE_LIMIT_DELAY)

        return elevations
