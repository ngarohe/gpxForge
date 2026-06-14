"""
Belgium / Wallonia — Relief de la Wallonie, MNT (DTM) 2021-2022, 50 cm.

Source: Service public de Wallonie (SPW), airborne LiDAR 2021-2022, published as
an ArcGIS MapServer at
  https://geoservices.wallonie.be/arcgis/rest/services/RELIEF/WALLONIE_MNT_2021_2022/MapServer

Wallonia publishes NO WCS, NO ImageServer and NO direct/on-demand raster tile
download (the official bulk download is an email order with ~48 h turnaround).
The only programmatic access to raw elevation values is the MapServer
`identify` operation, which returns the pixel value at a SINGLE point per
request. So this provider:

  1. Strides the incoming route to ~`TARGET_SPACING_M` so a 1 m-densified route
     doesn't fan out into tens of thousands of requests, then linearly
     interpolates elevations back onto every input point. The smooth step
     resamples to 1 m afterwards, so coarse horizontal identify-sampling of a
     50 cm-accurate source is fine for cycling gradients.
  2. Queries the identify anchors concurrently (bounded by a semaphore) so a
     route resolves in seconds rather than minutes.
  3. Caches every resolved anchor to an on-disk per-tile JSON cache so repeat /
     overlapping routes over the same roads are instant and gentle on the SPW
     server.

Points outside Wallonia coverage return None (the identify result is empty or
"NoData") so the chain falls through.
"""
import asyncio
import json
import math
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import aiohttp

from .base import ElevationProvider, ElevationError
from .http_hardening import make_timeout, request_with_retry

_IDENTIFY_URL = (
    "https://geoservices.wallonie.be/arcgis/rest/services/"
    "RELIEF/WALLONIE_MNT_2021_2022/MapServer/identify"
)

# Rough Wallonia bounding box (lat/lon) — a cheap pre-filter so points clearly
# outside Wallonia never hit the identify service.
_LAT_MIN, _LAT_MAX = 49.45, 50.85
_LON_MIN, _LON_MAX = 2.84, 6.41

_CACHE_DIR = Path(os.environ.get(
    "WALLONIA_MNT_CACHE_DIR",
    str(Path(__file__).resolve().parent.parent / "cache" / "wallonia_mnt"),
))
_TILE_DEG = 0.05          # cache tile size in degrees (~5.5 km x 3.5 km)
_COORD_DP = 6            # cache-key coordinate precision (~0.1 m)


def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def _tile_id(lat: float, lon: float) -> Tuple[int, int]:
    return (math.floor(lat / _TILE_DEG), math.floor(lon / _TILE_DEG))


def _cache_key(lat: float, lon: float) -> str:
    return f"{round(lat, _COORD_DP)},{round(lon, _COORD_DP)}"


class _TileCache:
    """Per-tile JSON disk cache: {tile_file: {"lat,lon": elev_or_null}}."""

    def __init__(self, cache_dir: Path):
        self._dir = cache_dir
        self._loaded: Dict[Tuple[int, int], Dict[str, Optional[float]]] = {}
        self._dirty: set = set()

    def _path(self, tile: Tuple[int, int]) -> Path:
        return self._dir / f"mnt_{tile[0]}_{tile[1]}.json"

    def _tile(self, tile: Tuple[int, int]) -> Dict[str, Optional[float]]:
        if tile not in self._loaded:
            data: Dict[str, Optional[float]] = {}
            p = self._path(tile)
            try:
                if p.exists():
                    with p.open("r", encoding="utf-8") as fh:
                        data = json.load(fh)
            except Exception:
                data = {}  # corrupt cache file → treat as empty, will be rewritten
            self._loaded[tile] = data
        return self._loaded[tile]

    def get(self, lat: float, lon: float):
        """Return (hit: bool, value: float|None)."""
        tile = self._tile(_tile_id(lat, lon))
        key = _cache_key(lat, lon)
        if key in tile:
            return True, tile[key]
        return False, None

    def put(self, lat: float, lon: float, value: Optional[float]) -> None:
        tid = _tile_id(lat, lon)
        self._tile(tid)[_cache_key(lat, lon)] = value
        self._dirty.add(tid)

    def flush(self) -> None:
        if not self._dirty:
            return
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            return  # cache is best-effort; never fail a fetch over it
        for tid in self._dirty:
            try:
                tmp = self._path(tid).with_suffix(".json.tmp")
                with tmp.open("w", encoding="utf-8") as fh:
                    json.dump(self._loaded[tid], fh)
                tmp.replace(self._path(tid))
            except Exception:
                pass
        self._dirty.clear()


class WalloniaMntProvider(ElevationProvider):
    """Wallonia MNT 2021-2022 50 cm DTM via ArcGIS MapServer identify."""

    _source_tag = "BE_WAL_MNT_50CM"

    TARGET_SPACING_M = 8.0     # identify-anchor spacing along the route
    MAX_ANCHORS = 2500          # hard cap on identify requests per fetch
    CONCURRENCY = 8
    REQUEST_TIMEOUT = make_timeout(total=30, connect=10, sock_connect=10, sock_read=20)

    def __init__(self):
        self._cache = _TileCache(_CACHE_DIR)

    @property
    def country_code(self) -> str:
        return "BE"

    @property
    def resolution(self) -> float:
        return 0.5

    # ── anchor selection ──────────────────────────────────────────────
    def _anchor_indices(self, points: List[Tuple[float, float]]) -> List[int]:
        n = len(points)
        if n <= 2:
            return list(range(n))
        total = 0.0
        for i in range(1, n):
            total += _haversine_m(points[i - 1][0], points[i - 1][1],
                                  points[i][0], points[i][1])
        avg = total / (n - 1) if n > 1 else 1.0
        stride = max(1, round(self.TARGET_SPACING_M / avg)) if avg > 0 else 1
        if (n + stride - 1) // stride > self.MAX_ANCHORS:
            stride = max(stride, math.ceil(n / self.MAX_ANCHORS))
        idx = list(range(0, n, stride))
        if idx[-1] != n - 1:
            idx.append(n - 1)
        return idx

    # ── identify a single point ───────────────────────────────────────
    async def _identify(self, session, sem, lat: float, lon: float) -> Optional[float]:
        d = 0.001
        params = {
            "geometry": json.dumps({"x": lon, "y": lat}),
            "geometryType": "esriGeometryPoint",
            "sr": "4326",
            "layers": "all",
            "tolerance": "1",
            "mapExtent": f"{lon - d},{lat - d},{lon + d},{lat + d}",
            "imageDisplay": "400,400,96",
            "returnGeometry": "false",
            "f": "json",
        }
        async with sem:
            status, body, _url, _ct = await request_with_retry(
                session, "GET", _IDENTIFY_URL,
                params=params,
                timeout=self.REQUEST_TIMEOUT,
                max_attempts=4,
                transient_statuses={408, 425, 429, 500, 502, 503, 504},
                verbose=self.verbose,
                log_prefix="WalloniaMNT",
            )
        if status != 200:
            raise ElevationError(f"Wallonia MNT identify HTTP {status}")
        try:
            data = json.loads(body.decode("utf-8", errors="replace"))
        except Exception:
            return None
        results = data.get("results") or []
        if not results:
            return None
        attrs = results[0].get("attributes") or {}
        raw = None
        for k, v in attrs.items():
            if "pixel value" in k.lower() or k.lower() == "value":
                raw = v
                break
        if raw is None and attrs:
            raw = next(iter(attrs.values()))
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return None  # "NoData" / non-numeric → outside coverage
        if val <= -9999 or abs(val) > 1e6:
            return None
        return val

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        n = len(points)
        if n == 0:
            return []

        anchors = self._anchor_indices(points)

        # 1. Resolve anchors via cache, collecting cache misses.
        anchor_elev: Dict[int, Optional[float]] = {}
        misses: List[int] = []
        in_box_miss = False
        for ai in anchors:
            lat, lon = points[ai]
            if not (_LAT_MIN <= lat <= _LAT_MAX and _LON_MIN <= lon <= _LON_MAX):
                anchor_elev[ai] = None
                continue
            hit, val = self._cache.get(lat, lon)
            if hit:
                anchor_elev[ai] = val
            else:
                misses.append(ai)
                in_box_miss = True

        # 2. Fetch cache misses concurrently.
        if misses:
            sem = asyncio.Semaphore(self.CONCURRENCY)
            async with aiohttp.ClientSession() as session:
                tasks = [self._identify(session, sem, points[i][0], points[i][1]) for i in misses]
                results = await asyncio.gather(*tasks)
            for i, val in zip(misses, results):
                anchor_elev[i] = val
                self._cache.put(points[i][0], points[i][1], val)
            self._cache.flush()

        # 3. Interpolate anchor elevations onto every input point.
        knots = [(ai, anchor_elev[ai]) for ai in anchors if anchor_elev.get(ai) is not None]
        if not knots:
            return [None] * n

        out: List[Optional[float]] = [None] * n
        # Points before the first / after the last knot clamp to the edge knot.
        first_i, first_v = knots[0]
        last_i, last_v = knots[-1]
        for i in range(0, first_i):
            out[i] = first_v
        for i in range(last_i, n):
            out[i] = last_v
        for (i0, v0), (i1, v1) in zip(knots, knots[1:]):
            if i1 == i0:
                continue
            span = i1 - i0
            for i in range(i0, i1 + 1):
                t = (i - i0) / span
                out[i] = v0 + (v1 - v0) * t
        return out
