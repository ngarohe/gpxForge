import asyncio
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import List, Optional, Tuple

from .base import ElevationProvider, ElevationError

# ARSO DTM — ArcGIS ImageServer getSamples endpoint (1m, EPSG:3794 / D96TM).
# Source: Cyclic Laser Scanning of Slovenia (CLSS 2023-25), served by ARSO.
# Points sent in WGS84 (inSR=4326); server reprojects to D96TM internally.
ARSO_SAMPLES_URL = "https://gis.arso.gov.si/arcgis/rest/services/Slovenija_DMR_D96TM/ImageServer/getSamples"
ARSO_BATCH_SIZE = 200  # safe limit for getSamples multipoint payload
ARSO_TIMEOUT = 35      # seconds per request
ARSO_MAX_ATTEMPTS = 4

# NOTE: This provider deliberately uses urllib instead of aiohttp. The ARSO
# server (IIS behind a reverse proxy) emits TWO `Server` response headers, which
# aiohttp's HTTP parser rejects with `ClientResponseError 400 "Duplicate
# 'Server' header found."` — a hardcoded HTTP-splitting guard present in both
# the C and pure-Python parsers, with no opt-out. urllib is lenient about
# duplicate headers, so we run blocking urllib calls in a thread executor to
# keep the async provider interface. SSL verification is disabled to survive
# the Windows corporate-proxy TLS intercept (see git history).


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


def _make_ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _fetch_samples_sync(batch: List[Tuple[float, float]], ctx: ssl.SSLContext) -> List[Optional[float]]:
    """Blocking getSamples call for one batch. Returns elevations aligned to batch order."""
    geom = json.dumps({
        "points": [[lon, lat] for lat, lon in batch],
        "spatialReference": {"wkid": 4326},
    })
    # POST (not GET): a 200-point multipoint geometry is ~6.5 KB, which blows
    # past IIS's 2048-char query-string limit and comes back as a bare HTTP 404.
    # POST puts the geometry in the body, so there is no URL-length ceiling.
    body = urllib.parse.urlencode({
        "geometry": geom,
        "geometryType": "esriGeometryMultipoint",
        "inSR": "4326",
        "returnFirstValueOnly": "false",
        "f": "json",
    }).encode()
    req = urllib.request.Request(ARSO_SAMPLES_URL, data=body, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://gis.arso.gov.si/",
        "Content-Type": "application/x-www-form-urlencoded",
    })
    with urllib.request.urlopen(req, timeout=ARSO_TIMEOUT, context=ctx) as resp:
        raw = resp.read()

    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as err:
        snippet = raw.decode("utf-8", errors="replace")[:220].replace("\n", " ")
        raise ElevationError(
            f"Slovenia elevation server returned invalid JSON: {snippet}"
        ) from err

    if "error" in data:
        raise ElevationError(f"ARSO ImageServer error: {data['error']}")

    samples = data.get("samples", [])

    # ARSO OMITS samples for points outside the DTM extent (sea, across the
    # border, off-coverage GPS jitter) rather than returning "NoData". So the
    # sample count can be < the batch size — that's expected, not an error.
    # Map results by locationId (ARSO returns it) and leave gaps as None.
    # Only fall back to positional mapping when locationId is absent AND the
    # counts line up; otherwise we can't map safely.
    have_location_ids = all(isinstance(s.get("locationId"), int) for s in samples)
    if not have_location_ids and len(samples) != len(batch):
        raise ElevationError(
            f"ARSO ImageServer returned {len(samples)} samples for {len(batch)} "
            f"points without locationId — cannot map results"
        )

    out: List[Optional[float]] = [None] * len(batch)
    for pos, s in enumerate(samples):
        loc = s.get("locationId")
        idx = loc if isinstance(loc, int) and 0 <= loc < len(batch) else pos
        val = s.get("value", "NoData")
        if val == "NoData" or val is None:
            out[idx] = None
            continue
        try:
            z = float(val)
        except (ValueError, TypeError):
            out[idx] = None
            continue
        out[idx] = None if (z <= -9999 or abs(z) > 1e37) else z
    return out


class SloveniaProvider(ElevationProvider):
    """Slovenia LIDAR elevation via the ARSO ArcGIS ImageServer getSamples API.

    1m DTM from the Cyclic Laser Scanning of Slovenia (CLSS 2023-25), queried
    in WGS84 multipoint batches (inSR=4326); server reprojects to D96TM internally.

    Uses urllib (not aiohttp) because the ARSO server sends duplicate `Server`
    headers that aiohttp's parser rejects — see module docstring above.
    """

    @property
    def country_code(self) -> str:
        return 'SI'

    @property
    def resolution(self) -> float:
        return 1.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[float]:
        ctx = _make_ssl_context()
        elevations: List[Optional[float]] = []
        for batch in _chunks(points, ARSO_BATCH_SIZE):
            last_exc: Optional[Exception] = None
            for attempt in range(ARSO_MAX_ATTEMPTS):
                try:
                    batch_vals = await asyncio.to_thread(_fetch_samples_sync, batch, ctx)
                    elevations.extend(batch_vals)
                    last_exc = None
                    break
                except ElevationError:
                    raise
                except (urllib.error.URLError, TimeoutError, OSError) as exc:
                    last_exc = exc
                    if attempt < ARSO_MAX_ATTEMPTS - 1:
                        wait = 1.5 * (2 ** attempt)
                        if self.verbose:
                            print(
                                f"    [SI/ARSO] network error ({type(exc).__name__}), "
                                f"retrying in {wait:.1f}s "
                                f"(attempt {attempt + 1}/{ARSO_MAX_ATTEMPTS})"
                            )
                        await asyncio.sleep(wait)
            if last_exc is not None:
                raise ElevationError(
                    f"Slovenia elevation server unavailable: "
                    f"{type(last_exc).__name__}: {last_exc}"
                ) from last_exc

        return elevations
