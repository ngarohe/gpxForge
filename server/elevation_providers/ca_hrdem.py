"""
Canada NRCan HRDEM (High Resolution Digital Elevation Model) Provider

Uses 1-2m LiDAR DTM tiles from NRCan (Natural Resources Canada).
Coverage: ~40% of Canada (urban/populated areas mainly).
CRS: EPSG:3979 (NAD83 / Canada Atlas Lambert)
"""
import asyncio
import json
import os
from typing import Dict, List, Optional, Tuple

import aiohttp
from pyproj import Transformer

from .base import ElevationProvider, ElevationError
from .http_hardening import request_with_retry

try:
    import rasterio
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False

from config import (
    CA_HRDEM_ENABLED,
    CA_HRDEM_STAC_URL,
)


class CaHrdemProvider(ElevationProvider):
    """NRCan HRDEM LiDAR DTM provider using STAC API + COGs.

    Queries STAC API to find HRDEM tiles by bbox,
    then samples via rasterio /vsicurl/ (no local download needed).
    """

    is_local = False

    def __init__(self):
        self.enabled = CA_HRDEM_ENABLED
        self.dataset_code = 'CA_HRDEM_LIDAR'
        self._resolution = 1.5  # Worst-case; actual is 1-2m per tile
        self._stac_api_url = CA_HRDEM_STAC_URL
        self._to_wgs84 = Transformer.from_crs('EPSG:3979', 'EPSG:4326', always_xy=True)
        self._to_3979 = Transformer.from_crs('EPSG:4326', 'EPSG:3979', always_xy=True)

    @property
    def country_code(self) -> str:
        return 'CA'

    @property
    def resolution(self) -> float:
        return self._resolution

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        if not self.enabled:
            return [None] * len(points)
        if not RASTERIO_AVAILABLE:
            raise ElevationError(f'{self.dataset_code}: rasterio is required for COG sampling')

        # Get route bbox
        lats = [p[0] for p in points]
        lons = [p[1] for p in points]
        bbox_wgs84 = [min(lons), min(lats), max(lons), max(lats)]

        # Query STAC API for matching items
        cogs = await self._query_stac_items(bbox_wgs84)
        if not cogs:
            return [None] * len(points)

        # Sample from COGs
        elevations = await asyncio.get_event_loop().run_in_executor(
            None, self._sample_cogs, points, cogs
        )

        if self.verbose:
            hit = sum(1 for e in elevations if e is not None)
            self._verbose_log = {
                'dataset': self.dataset_code,
                'items_found': len(cogs),
                'resolved': hit,
            }

        return elevations

    async def _query_stac_items(self, bbox: List[float]) -> List[dict]:
        """Query STAC OGC API for HRDEM items covering bbox.

        Uses GET /collections/hrdem-lidar/items?bbox=... (OGC API Features style).
        bbox = [lon_min, lat_min, lon_max, lat_max] (STAC/WGS84 order).
        Returns list of STAC item dicts.
        """
        try:
            lon_min, lat_min, lon_max, lat_max = bbox
            items_url = (
                f"{self._stac_api_url}/items"
                f"?bbox={lon_min},{lat_min},{lon_max},{lat_max}&limit=100"
            )
            timeout = aiohttp.ClientTimeout(total=15)
            async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
                status, data, _req_url, _ct = await request_with_retry(
                    session,
                    "GET",
                    items_url,
                    headers={"User-Agent": "GPXForge/0.2.0 (+local)"},
                    max_attempts=2,
                    transient_statuses={408, 425, 429, 500, 502, 503, 504},
                    retry_body_keywords=(),  # STAC JSON bodies may contain "rate" innocuously
                    verbose=self.verbose,
                    log_prefix=f"{self.dataset_code}/stac",
                )
                if status != 200:
                    return []

                result = json.loads(data.decode('utf-8', errors='replace'))
                features = result.get('features', []) if isinstance(result, dict) else []
                if self.verbose:
                    print(f"    [{self.dataset_code}] STAC returned {len(features)} items for bbox")
                return features
        except Exception as exc:
            if self.verbose:
                print(f"    [{self.dataset_code}] STAC query failed: {exc}")
            return []

    def _item_dtm_url(self, item: dict) -> str:
        """Extract the DTM COG URL from a STAC item.

        NRCan HRDEM items have a 'dtm' asset key containing the terrain model.
        Falls back to any https .tif asset if 'dtm' is absent.
        """
        assets = item.get('assets', {}) if isinstance(item.get('assets'), dict) else {}
        # Preferred: 'dtm' asset (bare terrain, not surface model)
        if 'dtm' in assets:
            href = assets['dtm'].get('href', '')
            if href.startswith('http') and '.tif' in href.lower():
                return href
        # Fallback: any http tif that isn't a DSM/coverage/thumbnail
        for key, info in assets.items():
            if key in ('dsm', 'coverage', 'thumbnail', 'extent'):
                continue
            if not isinstance(info, dict):
                continue
            href = info.get('href', '')
            if href.startswith('http') and '.tif' in href.lower():
                return href
        return ''

    def _sample_cogs(self, points: List[Tuple[float, float]], items: List[dict]) -> List[Optional[float]]:
        """Sample elevation from DTM COG assets using rasterio /vsicurl/."""
        elevations: List[Optional[float]] = [None] * len(points)

        for item in items:
            cog_url = self._item_dtm_url(item)
            if not cog_url:
                continue

            try:
                vsicurl_path = f'/vsicurl/{cog_url}'
                with rasterio.open(vsicurl_path) as src:
                    # Build transformer once per tile
                    try:
                        transformer = Transformer.from_crs('EPSG:4326', src.crs, always_xy=True)
                    except Exception:
                        transformer = None

                    bounds = src.bounds
                    nodata = src.nodata

                    for i, (lat, lon) in enumerate(points):
                        if elevations[i] is not None:
                            continue
                        try:
                            if transformer:
                                x, y = transformer.transform(float(lon), float(lat))
                            else:
                                x, y = self._to_3979.transform(float(lon), float(lat))

                            # Skip if outside this tile
                            if not (bounds.left <= x <= bounds.right and bounds.bottom <= y <= bounds.top):
                                continue

                            for sample in src.sample([(x, y)]):
                                z = float(sample[0])
                                if nodata is None or z != nodata:
                                    if z > -9000:
                                        elevations[i] = z
                        except Exception:
                            pass
            except Exception:
                pass

        return elevations
