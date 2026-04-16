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
    """Uses the swisstopo profile endpoint to stay within 20 req/min rate limit.

    Sends points as a GeoJSON LineString in a GET parameter. URL length limits
    the safe chunk size: each LV95 coordinate pair is ~30 chars; 100 points
    produces ~3 KB of raw JSON which URL-encodes to ~5-6 KB — safe under the
    typical 8 KB GET limit. The API returns nb_points evenly-spaced elevations
    along the LineString; with uniform 3 m input spacing the positions align
    1:1 with input vertices, so chunks can be concatenated directly.
    """
    PROFILE_URL = "https://api3.geo.admin.ch/rest/services/profile.json"
    CHUNK_SIZE = 100   # ~5-6 KB URL-encoded — well under 8 KB GET limit
    CHUNK_DELAY = 0.1  # swisstopo allows 20 req/min — 0.1s keeps well under limit
    REQUEST_TIMEOUT = make_timeout(total=35, connect=10, sock_connect=10, sock_read=25)

    @property
    def country_code(self) -> str:
        return 'CH'

    @property
    def resolution(self) -> float:
        return 2.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[float]:
        # Transform all points to LV95 (EPSG:2056), rounded to 3 decimal places.
        # Full float precision (~18 chars/coord) pushes 100-point URLs past 4094 chars.
        # 3dp = 1mm precision — more than sufficient for elevation lookup.
        lv95_points = [
            (round(x, 3), round(y, 3))
            for lat, lon in points
            for x, y in [wgs84_to_lv95.transform(lon, lat)]
        ]

        elevations = []
        async with aiohttp.ClientSession() as session:
            chunks = list(_chunks(lv95_points, self.CHUNK_SIZE))
            for ci, chunk in enumerate(chunks):
                geom = {
                    "type": "LineString",
                    "coordinates": [[x, y] for x, y in chunk]
                }
                params = {
                    "geom": json.dumps(geom, separators=(',', ':')),
                    "sr": 2056,
                    "nb_points": len(chunk),
                    "offset": 0,
                }
                status, body, _req_url, _ct = await request_with_retry(
                    session,
                    "GET",
                    self.PROFILE_URL,
                    params=params,
                    timeout=self.REQUEST_TIMEOUT,
                    max_attempts=4,
                    transient_statuses={408, 425, 429, 500, 502, 503, 504},
                    retry_body_keywords=("429", "rate", "too many", "quota"),
                    verbose=self.verbose,
                    log_prefix="CH",
                )
                if status == 414:
                    raise ElevationError(
                        f"Switzerland API: URL too long for chunk {ci} "
                        f"({len(chunk)} pts). Reduce CHUNK_SIZE."
                    )
                if status != 200:
                    raise ElevationError(
                        f"Switzerland API error {status}: {body_snippet(body, 220)}"
                    )
                try:
                    data = json.loads(body.decode("utf-8", errors="replace"))
                except Exception as err:
                    raise ElevationError(
                        f"Unexpected Switzerland API response body: {body_snippet(body, 220)}"
                    ) from err
                if not isinstance(data, list):
                    raise ElevationError(f"Unexpected Switzerland API response: {data}")
                if len(data) != len(chunk):
                    raise ElevationError(
                        f"Switzerland API returned {len(data)} pts for {len(chunk)}-pt chunk"
                    )
                for pt in data:
                    alts = pt.get('alts', {})
                    z = alts.get('DTM2') or alts.get('DTM25')
                    if z is None:
                        raise ElevationError(
                            f"No DTM elevation in Switzerland response for point: {pt}"
                        )
                    elevations.append(float(z))
                await asyncio.sleep(self.CHUNK_DELAY)

        return elevations
