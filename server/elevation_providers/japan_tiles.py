"""
Japan GSI DEM5A 5m LIDAR Provider

Uses PNG tiles from the Geospatial Information Authority of Japan (GSI).
Coverage: ~70% (urban + coastal regions). ~30% gap coverage falls back to GPXZ.

Base URL: https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png
CRS: WGS84 (EPSG:4326) — JGD2011 datum (< 10cm offset from WGS84)

PNG elevation encoding (GSI standard, 24-bit signed with 1cm precision):
  x = R * 65536 + G * 256 + B
  if x < 2^23:  elevation = x * 0.01       (positive elevations)
  if x == 2^23:  nodata  (R=128, G=0, B=0)
  if x > 2^23:  elevation = (x - 2^24) * 0.01  (negative elevations, below sea level)

Resolution: 0.01m (1cm) vertical precision at 5m horizontal grid.
"""
import asyncio
import io
import math
from typing import Dict, List, Optional, Tuple

import aiohttp

from .base import ElevationProvider, ElevationError
from .http_hardening import request_with_retry

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

_TWO_23 = 8388608    # 2^23 — nodata sentinel
_TWO_24 = 16777216   # 2^24 — for two's complement negative


def _latlon_to_tile(lat: float, lon: float, z: int) -> Tuple[int, int]:
    """Convert WGS84 lat/lon to Web Mercator tile coordinates."""
    n = 2.0 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(math.radians(lat)) + 1.0 / math.cos(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


def _tile_bounds(x: int, y: int, z: int) -> Tuple[float, float, float, float]:
    """Get WGS84 bbox for a tile: (lat_min, lat_max, lon_min, lon_max)."""
    n = 2.0 ** z
    lon_min = x / n * 360.0 - 180.0
    lon_max = (x + 1) / n * 360.0 - 180.0
    lat_max = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    lat_min = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 1) / n))))
    return lat_min, lat_max, lon_min, lon_max


def _decode_gsi_pixel(r: int, g: int, b: int) -> Optional[float]:
    """Decode GSI PNG elevation from RGB channels.

    Returns elevation in metres, or None for nodata.
    """
    x = r * 65536 + g * 256 + b
    if x == _TWO_23:
        return None
    if x > _TWO_23:
        x -= _TWO_24
    return x * 0.01


class JapanTilesProvider(ElevationProvider):
    """GSI DEM5A 5m LiDAR PNG tiles — Web Mercator z15.

    Queries tiles from https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/
    at zoom level 15. Points outside coverage (~30% gap) return None;
    the provider chain automatically falls back to GPXZ.
    """

    is_local = False
    _source_tag = 'JP_DEM5A'

    def __init__(self):
        self.dataset_code = 'JP_DEM5A_LIDAR'
        self._resolution = 5.0
        self._base_url = 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png'
        self._zoom = 15
        self._tile_cache: Dict[Tuple[int, int], Optional[bytes]] = {}

    @property
    def country_code(self) -> str:
        return 'JP'

    @property
    def resolution(self) -> float:
        return self._resolution

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        if not PIL_AVAILABLE:
            raise ElevationError(f'{self.dataset_code}: pillow is required for PNG tile sampling')

        # Collect unique tiles needed
        point_tiles: List[Tuple[int, int]] = []
        required_tiles: set = set()
        for lat, lon in points:
            t = _latlon_to_tile(lat, lon, self._zoom)
            point_tiles.append(t)
            required_tiles.add(t)

        # Fetch all tiles in parallel
        tile_list = list(required_tiles)
        results = await asyncio.gather(
            *[self._fetch_tile(tx, ty) for tx, ty in tile_list],
            return_exceptions=True,
        )

        tile_map: Dict[Tuple[int, int], bytes] = {}
        for txy, data in zip(tile_list, results):
            if isinstance(data, bytes) and len(data) > 0:
                tile_map[txy] = data

        # Parse each unique tile image once
        tile_images: Dict[Tuple[int, int], Image.Image] = {}
        for txy, raw in tile_map.items():
            try:
                img = Image.open(io.BytesIO(raw))
                if img.mode not in ('RGB', 'RGBA'):
                    img = img.convert('RGB')
                tile_images[txy] = img
            except Exception:
                pass

        # Sample each point
        elevations: List[Optional[float]] = [None] * len(points)
        resolved = 0
        for i, (lat, lon) in enumerate(points):
            txy = point_tiles[i]
            img = tile_images.get(txy)
            if img is None:
                continue
            z = self._sample_from_image(lat, lon, txy, img)
            if z is not None:
                elevations[i] = z
                resolved += 1

        if self.verbose:
            self._verbose_log = {
                'dataset': self.dataset_code,
                'tiles_fetched': len(tile_map),
                'tiles_parsed': len(tile_images),
                'resolved': resolved,
            }

        return elevations

    async def _fetch_tile(self, x: int, y: int) -> Optional[bytes]:
        """Fetch a single PNG tile from GSI CDN."""
        cached = self._tile_cache.get((x, y), -1)
        if cached != -1:
            return cached

        url = f'{self._base_url}/{self._zoom}/{x}/{y}.png'
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
                status, data, _req_url, _ct = await request_with_retry(
                    session,
                    'GET',
                    url,
                    headers={'User-Agent': 'GPXForge/0.2.0 (+local)'},
                    max_attempts=2,
                    transient_statuses={408, 425, 429, 500, 502, 503, 504},
                    retry_body_keywords=(),
                    verbose=self.verbose,
                    log_prefix=f'{self.dataset_code}/tile',
                )
                if status == 200 and data:
                    self._tile_cache[(x, y)] = data
                    return data
                self._tile_cache[(x, y)] = None
                return None
        except Exception:
            self._tile_cache[(x, y)] = None
            return None

    def _sample_from_image(
        self, lat: float, lon: float, txy: Tuple[int, int], img: Image.Image,
    ) -> Optional[float]:
        """Sample elevation for a lat/lon from a parsed tile image."""
        tx, ty = txy
        lat_min, lat_max, lon_min, lon_max = _tile_bounds(tx, ty, self._zoom)
        w, h = img.size

        # Fractional pixel position
        fx = ((lon - lon_min) / (lon_max - lon_min)) * w
        fy = ((lat_max - lat) / (lat_max - lat_min)) * h

        px = max(0, min(w - 1, int(fx)))
        py = max(0, min(h - 1, int(fy)))

        pixel = img.getpixel((px, py))
        if isinstance(pixel, tuple):
            r, g, b = int(pixel[0]), int(pixel[1]), int(pixel[2])
        else:
            return None

        z = _decode_gsi_pixel(r, g, b)
        if z is None:
            return None

        # Sanity: Japan ranges from ~-4m (reclaimed land) to 3776m (Fuji)
        if z < -100 or z > 5000:
            return None

        return z
