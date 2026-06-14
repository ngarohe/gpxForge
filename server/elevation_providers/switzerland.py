import json
import asyncio
import aiohttp
from typing import List, Tuple
from .base import ElevationProvider, ElevationError
from coord_transform import wgs84_to_lv95
from .http_hardening import body_snippet, make_timeout, request_with_retry


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


class SwitzerlandProvider(ElevationProvider):
    """Uses the swisstopo profile endpoint via POST with concurrent chunks.

    POST removes the GET URL-length constraint, allowing 2500 pts per chunk
    (vs 100 with GET). Chunks run concurrently (semaphore-limited to 5) for
    ~150x throughput improvement on long routes. The swisstopo rate limit is
    20 req/s — 5 concurrent requests stays well under that.
    """
    PROFILE_URL = "https://api3.geo.admin.ch/rest/services/profile.json"
    CHUNK_SIZE = 2500
    CONCURRENCY = 5
    REQUEST_TIMEOUT = make_timeout(total=35, connect=10, sock_connect=10, sock_read=25)

    @property
    def country_code(self) -> str:
        return 'CH'

    @property
    def resolution(self) -> float:
        return 2.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[float]:
        lv95_points = [
            (round(x, 3), round(y, 3))
            for lat, lon in points
            for x, y in [wgs84_to_lv95.transform(lon, lat)]
        ]

        chunks = list(_chunks(lv95_points, self.CHUNK_SIZE))
        sem = asyncio.Semaphore(self.CONCURRENCY)

        async with aiohttp.ClientSession() as session:
            tasks = [
                self._fetch_chunk(session, sem, chunk, ci, len(chunks))
                for ci, chunk in enumerate(chunks)
            ]
            chunk_results = await asyncio.gather(*tasks)

        elevations = []
        for result in chunk_results:
            elevations.extend(result)
        return elevations

    async def _fetch_chunk(self, session, sem, chunk, ci, total_chunks):
        async with sem:
            geom = {
                "type": "LineString",
                "coordinates": [[x, y] for x, y in chunk]
            }
            data = {
                "geom": json.dumps(geom, separators=(',', ':')),
                "sr": "2056",
                "nb_points": str(len(chunk)),
                "offset": "0",
            }
            status, body, _req_url, _ct = await request_with_retry(
                session,
                "POST",
                self.PROFILE_URL,
                data=data,
                timeout=self.REQUEST_TIMEOUT,
                max_attempts=4,
                transient_statuses={408, 425, 429, 500, 502, 503, 504},
                retry_body_keywords=("429", "rate", "too many", "quota"),
                verbose=self.verbose,
                log_prefix="CH",
            )
            if status == 413:
                raise ElevationError(
                    f"Switzerland API: payload too large for chunk {ci} "
                    f"({len(chunk)} pts). Reduce CHUNK_SIZE."
                )
            if status != 200:
                raise ElevationError(
                    f"Switzerland API error {status}: {body_snippet(body, 220)}"
                )
            try:
                result = json.loads(body.decode("utf-8", errors="replace"))
            except Exception as err:
                raise ElevationError(
                    f"Unexpected Switzerland API response body: {body_snippet(body, 220)}"
                ) from err
            if not isinstance(result, list):
                raise ElevationError(f"Unexpected Switzerland API response: {result}")
            if len(result) != len(chunk):
                raise ElevationError(
                    f"Switzerland API returned {len(result)} pts for {len(chunk)}-pt chunk"
                )
            elevations = []
            for pt in result:
                alts = pt.get('alts', {})
                z = alts.get('DTM2') or alts.get('DTM25')
                if z is None:
                    raise ElevationError(
                        f"No DTM elevation in Switzerland response for point: {pt}"
                    )
                elevations.append(float(z))
            return elevations
