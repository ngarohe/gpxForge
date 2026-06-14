"""
New Zealand LINZ 1m LiDAR DEM Provider

Uses the public LINZ STAC catalog on S3 to discover per-COG bounding boxes,
then samples elevation from Cloud-Optimized GeoTIFFs via GDAL /vsicurl/.

Two-level spatial index with disk caching:
  Level 1: Collection index — 104 collection.json fetches, ~5s on first boot.
           Cached in memory for server lifetime.
  Level 2: Per-COG item index — fetched once per collection from item.json files,
           cached to disk in server/data/nz_linz_items/.  Subsequent server
           restarts load from disk (instant).

At query time:
  1. Filter collections by route bbox, sort newest-first
  2. Load per-COG items for matched collections (from disk or S3)
  3. Filter COGs by route bbox — typically 5–30 out of hundreds
  4. Open only matching COGs in parallel threads, sample with bilinear interp

CRS: EPSG:2193 (NZTM2000)
Resolution: 1 m
Coverage: ~80% of NZ (more regions added as surveys complete)
"""
import asyncio
import json
import os
import re
import threading
import time as _time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin

import aiohttp
from pyproj import Transformer

from .base import ElevationProvider, ElevationError
from .http_hardening import request_with_retry

try:
    import rasterio
    from rasterio.transform import rowcol
    from rasterio.windows import Window
    import numpy as np
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False

from config import NZ_LINZ_ENABLED, NZ_LINZ_STAC_URL

_CONCURRENCY = 50
_COG_WORKERS = 20

_NODATA_MAX = 1e37
_NODATA_MIN = -9999.0

# Disk cache directory (relative to server/)
_CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'nz_linz_items')


def _parse_year(path: str) -> int:
    """Extract the latest year from a collection path like 'canterbury_2020-2023'."""
    years = re.findall(r'(\d{4})', path)
    return max(int(y) for y in years) if years else 0


def _bbox_overlaps(a, b) -> bool:
    """Check if two [lon_min, lat_min, lon_max, lat_max] bboxes overlap."""
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


class _Collection:
    __slots__ = ('url', 'bbox', 'name', 'year', 'items')

    def __init__(self, url: str, bbox: List[float], name: str):
        self.url = url
        self.bbox = bbox
        self.name = name
        self.year = _parse_year(name)
        self.items: Optional[List[Dict]] = None  # [{bbox, cog_url}] when loaded


class NzLinzProvider(ElevationProvider):
    """LINZ 1m LiDAR DEM via STAC catalog + /vsicurl/ COG sampling.

    Reliable provider with disk-cached per-COG spatial index.
    No GPXZ dependency — returns None only for genuine coverage gaps.
    """

    is_local = False
    dataset_code = 'NZ_LINZ_DEM_1M'

    def __init__(self):
        self.enabled = NZ_LINZ_ENABLED
        self._resolution = 1.0
        self._stac_root = NZ_LINZ_STAC_URL
        self._to_2193 = Transformer.from_crs('EPSG:4326', 'EPSG:2193', always_xy=True)
        self._collections: Optional[List[_Collection]] = None
        self._coll_lock = asyncio.Lock()
        self._item_locks: Dict[str, asyncio.Lock] = {}
        os.makedirs(_CACHE_DIR, exist_ok=True)

    @property
    def country_code(self) -> str:
        return 'NZ'

    @property
    def resolution(self) -> float:
        return self._resolution

    # ── Level 1: Collection index ─────────────────────────────────────

    async def _ensure_collections(self) -> List[_Collection]:
        if self._collections is not None:
            return self._collections
        async with self._coll_lock:
            if self._collections is not None:
                return self._collections
            self._collections = await self._build_collection_index()
            return self._collections

    async def _build_collection_index(self) -> List[_Collection]:
        t0 = _time.monotonic()
        timeout = aiohttp.ClientTimeout(total=30)
        hdrs = {'User-Agent': 'GPXForge/0.2.0 (+local)'}
        sem = asyncio.Semaphore(_CONCURRENCY)

        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            status, data, _, _ = await request_with_retry(
                session, 'GET', self._stac_root,
                headers=hdrs, max_attempts=3,
                retry_body_keywords=(),
                log_prefix='NZ/stac-root',
            )
            if status != 200:
                print(f'    [NZ_LINZ] root catalog HTTP {status}')
                return []

            root = json.loads(data.decode('utf-8', errors='replace'))
            dem_urls = [
                urljoin(self._stac_root, link['href'])
                for link in root.get('links', [])
                if link.get('rel') == 'child' and 'dem_1m' in link.get('href', '')
            ]

            async def fetch_coll(url: str) -> Optional[_Collection]:
                async with sem:
                    try:
                        st, body, _, _ = await request_with_retry(
                            session, 'GET', url,
                            headers=hdrs, max_attempts=2,
                            retry_body_keywords=(),
                            log_prefix='NZ/coll',
                        )
                        if st != 200:
                            return None
                        coll = json.loads(body.decode('utf-8', errors='replace'))
                    except Exception:
                        return None
                    bbox_list = coll.get('extent', {}).get('spatial', {}).get('bbox', [])
                    if not bbox_list or len(bbox_list[0]) < 4:
                        return None
                    bbox = bbox_list[0][:4]
                    if any(v is None for v in bbox):
                        return None
                    name = '/'.join(url.rstrip('/').split('/')[-5:-3])
                    return _Collection(url, bbox, name)

            results = await asyncio.gather(
                *[fetch_coll(u) for u in dem_urls],
                return_exceptions=False,
            )
            colls = [r for r in results if r is not None]
            elapsed = _time.monotonic() - t0
            print(f'    [NZ_LINZ] collection index: {len(colls)} dem_1m collections '
                  f'in {elapsed:.1f}s')
            return colls

    # ── Level 2: Per-COG item index (disk-cached) ─────────────────────

    def _cache_path(self, coll: _Collection) -> str:
        safe_name = coll.name.replace('/', '_').replace('\\', '_')
        return os.path.join(_CACHE_DIR, f'{safe_name}.json')

    def _load_from_disk(self, coll: _Collection) -> Optional[List[Dict]]:
        path = self._cache_path(coll)
        if not os.path.exists(path):
            return None
        try:
            with open(path, 'r') as f:
                items = json.load(f)
            if isinstance(items, list) and len(items) > 0:
                return items
        except Exception:
            pass
        return None

    def _save_to_disk(self, coll: _Collection, items: List[Dict]):
        path = self._cache_path(coll)
        try:
            with open(path, 'w') as f:
                json.dump(items, f, separators=(',', ':'))
        except Exception as e:
            print(f'    [NZ_LINZ] cache write failed for {coll.name}: {e}')

    async def _ensure_items(self, coll: _Collection) -> List[Dict]:
        if coll.items is not None:
            return coll.items

        # Try disk cache first
        cached = self._load_from_disk(coll)
        if cached is not None:
            coll.items = cached
            print(f'    [NZ_LINZ]   {coll.name}: {len(cached)} COGs (from cache)')
            return cached

        # Fetch from S3
        if coll.url not in self._item_locks:
            self._item_locks[coll.url] = asyncio.Lock()
        async with self._item_locks[coll.url]:
            if coll.items is not None:
                return coll.items
            items = await self._fetch_items(coll)
            coll.items = items
            if items:
                self._save_to_disk(coll, items)
            return items

    async def _fetch_items(self, coll: _Collection) -> List[Dict]:
        t0 = _time.monotonic()
        timeout = aiohttp.ClientTimeout(total=60)
        hdrs = {'User-Agent': 'GPXForge/0.2.0 (+local)'}
        sem = asyncio.Semaphore(_CONCURRENCY)

        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            # Re-fetch collection.json for item links
            try:
                st, body, _, _ = await request_with_retry(
                    session, 'GET', coll.url,
                    headers=hdrs, max_attempts=2,
                    retry_body_keywords=(),
                    log_prefix='NZ/coll-items',
                )
                if st != 200:
                    return []
                coll_json = json.loads(body.decode('utf-8', errors='replace'))
            except Exception:
                return []

            item_urls = []
            for link in coll_json.get('links', []):
                if link.get('rel') != 'item':
                    continue
                href = link.get('href', '')
                if href.endswith('.json'):
                    item_urls.append(urljoin(coll.url, href))

            if not item_urls:
                return []

            print(f'    [NZ_LINZ]   {coll.name}: fetching {len(item_urls)} item bboxes...')

            _first_logged = False

            async def fetch_item(item_url: str) -> Optional[Dict]:
                nonlocal _first_logged
                async with sem:
                    try:
                        st, body, _, _ = await request_with_retry(
                            session, 'GET', item_url,
                            headers=hdrs, max_attempts=2,
                            retry_body_keywords=(),
                            log_prefix='NZ/item',
                        )
                        if st != 200:
                            return None
                        item = json.loads(body.decode('utf-8', errors='replace'))
                    except Exception:
                        return None

                    bbox = item.get('bbox')
                    if not bbox or len(bbox) < 4:
                        return None

                    # Find COG URL from assets
                    cog_url = ''
                    assets = item.get('assets', {})
                    # Log first item's asset keys for debugging
                    if not _first_logged:
                        _first_logged = True
                        print(f'    [NZ_LINZ]   first item asset keys: {list(assets.keys())}')

                    # Try known asset keys
                    for key in ('dem', 'visual', 'data', 'default'):
                        asset = assets.get(key, {})
                        href = asset.get('href', '')
                        if href.endswith(('.tif', '.tiff')):
                            cog_url = urljoin(item_url, href)
                            break

                    # Fallback: any asset with a .tif href
                    if not cog_url:
                        for key, asset in assets.items():
                            if not isinstance(asset, dict):
                                continue
                            href = asset.get('href', '')
                            if href.endswith(('.tif', '.tiff')):
                                cog_url = urljoin(item_url, href)
                                break

                    # Last resort: derive from item URL (.json → .tiff)
                    if not cog_url:
                        cog_url = item_url[:-5] + '.tiff'

                    return {'bbox': bbox[:4], 'cog_url': cog_url}

            results = await asyncio.gather(
                *[fetch_item(u) for u in item_urls],
                return_exceptions=False,
            )
            items = [r for r in results if r is not None]
            elapsed = _time.monotonic() - t0
            print(f'    [NZ_LINZ]   {coll.name}: {len(items)} COGs indexed in {elapsed:.1f}s')
            return items

    # ── Public interface ───────────────────────────────────────────────

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        if not self.enabled:
            return [None] * len(points)
        if not RASTERIO_AVAILABLE:
            raise ElevationError(f'{self.dataset_code}: rasterio is required')

        collections = await self._ensure_collections()
        if not collections:
            return [None] * len(points)

        lats = [p[0] for p in points]
        lons = [p[1] for p in points]
        route_bbox = [min(lons), min(lats), max(lons), max(lats)]

        # Filter + sort newest first
        matched = [c for c in collections if _bbox_overlaps(c.bbox, route_bbox)]
        matched.sort(key=lambda c: c.year, reverse=True)

        if not matched:
            print(f'    [NZ_LINZ] no collections overlap route')
            return [None] * len(points)

        print(f'    [NZ_LINZ] {len(matched)} collections overlap route '
              f'(newest first):')
        for c in matched[:8]:
            print(f'    [NZ_LINZ]   {c.name} ({c.year})')
        if len(matched) > 8:
            print(f'    [NZ_LINZ]   ... and {len(matched) - 8} more')

        elevations: List[Optional[float]] = [None] * len(points)
        total_cogs_opened = 0

        for coll in matched:
            remaining = sum(1 for e in elevations if e is None)
            if remaining == 0:
                break

            items = await self._ensure_items(coll)
            if not items:
                continue

            # Filter items by route bbox
            matched_items = [it for it in items if _bbox_overlaps(it['bbox'], route_bbox)]
            if not matched_items:
                continue

            print(f'    [NZ_LINZ]   sampling {len(matched_items)} COGs '
                  f'from {coll.name} ({remaining} pts remaining)...')

            t0 = _time.monotonic()
            opened = self._sample_cogs(points, matched_items, elevations)
            elapsed = _time.monotonic() - t0
            total_cogs_opened += opened

            resolved_now = sum(1 for e in elevations if e is not None)
            print(f'    [NZ_LINZ]   → {resolved_now}/{len(points)} pts resolved '
                  f'({opened} COGs opened) in {elapsed:.1f}s')

        hit = sum(1 for e in elevations if e is not None)
        print(f'    [NZ_LINZ] done: {hit}/{len(points)} pts, '
              f'{total_cogs_opened} COGs opened total')

        if self.verbose:
            self._verbose_log = {
                'dataset': self.dataset_code,
                'collections_matched': len(matched),
                'cogs_opened': total_cogs_opened,
                'resolved': hit,
            }

        return elevations

    # ── COG sampling ──────────────────────────────────────────────────

    def _sample_cogs(
        self,
        points: List[Tuple[float, float]],
        matched_items: List[Dict],
        elevations: List[Optional[float]],
    ) -> int:
        """Sample from matched COGs in parallel. Returns count of COGs opened."""
        lock = threading.Lock()
        cogs_opened = 0

        gdal_env = {
            'GDAL_DISABLE_READDIR_ON_OPEN': 'YES',
            'CPL_VSIL_CURL_ALLOWED_EXTENSIONS': '.tif,.tiff',
            'GDAL_HTTP_TIMEOUT': '15',
            'CPL_VSIL_CURL_USE_HEAD': 'NO',
        }

        def _sample_one(entry: Dict) -> int:
            nonlocal cogs_opened
            eb = entry['bbox']
            pad = 0.0005
            blon_min, blat_min = eb[0] - pad, eb[1] - pad
            blon_max, blat_max = eb[2] + pad, eb[3] + pad

            with lock:
                eligible = [
                    (i, lat, lon)
                    for i, (lat, lon) in enumerate(points)
                    if elevations[i] is None
                       and blat_min <= lat <= blat_max
                       and blon_min <= lon <= blon_max
                ]
            if not eligible:
                return 0

            cog_url = entry['cog_url']
            vsicurl = '/vsicurl/' + cog_url
            resolved = 0
            try:
                with rasterio.Env(**gdal_env):
                    with rasterio.open(vsicurl) as src:
                        with lock:
                            cogs_opened += 1

                        transformer = None
                        if src.crs:
                            crs_str = src.crs.to_string().upper()
                            if 'EPSG:4326' not in crs_str and 'CRS84' not in crs_str:
                                transformer = Transformer.from_crs(
                                    'EPSG:4326', src.crs, always_xy=True
                                )

                        ds_nodata = src.nodata
                        total_rows, total_cols = src.shape

                        # Convert all eligible points to pixel coords first
                        px_coords = []
                        for idx, lat, lon in eligible:
                            if transformer is not None:
                                x, y = transformer.transform(float(lon), float(lat))
                            else:
                                x, y = float(lon), float(lat)
                            try:
                                rf, cf = rowcol(src.transform, x, y, op=float)
                                r0, c0 = int(rf), int(cf)
                                if 0 <= r0 < total_rows and 0 <= c0 < total_cols:
                                    px_coords.append((idx, rf, cf, r0, c0))
                            except Exception:
                                continue

                        if not px_coords:
                            return 0

                        # Compute minimal window covering all eligible pixels (+1 for bilinear)
                        min_r = min(p[3] for p in px_coords)
                        max_r = min(max(p[3] for p in px_coords) + 1, total_rows - 1)
                        min_c = min(p[4] for p in px_coords)
                        max_c = min(max(p[4] for p in px_coords) + 1, total_cols - 1)

                        win = Window(
                            col_off=min_c, row_off=min_r,
                            width=max_c - min_c + 1,
                            height=max_r - min_r + 1,
                        )
                        band = src.read(1, window=win).astype('float64')
                        win_rows, win_cols = band.shape

                        new_vals = []
                        for idx, rf, cf, r0, c0 in px_coords:
                            # Remap to window-local coords
                            lr0 = r0 - min_r
                            lc0 = c0 - min_c
                            if not (0 <= lr0 < win_rows and 0 <= lc0 < win_cols):
                                continue
                            v00 = band[lr0, lc0]
                            if ds_nodata is not None and v00 == ds_nodata:
                                continue
                            if abs(v00) > _NODATA_MAX or v00 <= _NODATA_MIN:
                                continue
                            # Bilinear interpolation
                            lr1 = min(lr0 + 1, win_rows - 1)
                            lc1 = min(lc0 + 1, win_cols - 1)
                            dr = rf - r0
                            dc = cf - c0
                            v01 = band[lr0, lc1]
                            v10 = band[lr1, lc0]
                            v11 = band[lr1, lc1]
                            if (ds_nodata is not None and
                                    (v01 == ds_nodata or v10 == ds_nodata or v11 == ds_nodata)):
                                val = float(v00)
                            elif abs(v01) > _NODATA_MAX or abs(v10) > _NODATA_MAX or abs(v11) > _NODATA_MAX:
                                val = float(v00)
                            else:
                                val = float(
                                    v00 * (1 - dr) * (1 - dc) +
                                    v01 * (1 - dr) * dc +
                                    v10 * dr * (1 - dc) +
                                    v11 * dr * dc
                                )
                            new_vals.append((idx, val))

                        with lock:
                            for idx, val in new_vals:
                                if elevations[idx] is None:
                                    elevations[idx] = val
                                    resolved += 1

            except Exception as e:
                # Log COG open failures (network timeout, bad URL, etc.)
                short_url = cog_url.split('/')[-1] if '/' in cog_url else cog_url
                print(f'    [NZ_LINZ]   COG fail ({short_url}): {type(e).__name__}: {e}')
            return resolved

        with ThreadPoolExecutor(max_workers=_COG_WORKERS) as pool:
            futures = {pool.submit(_sample_one, e): e for e in matched_items}
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception:
                    pass

        return cogs_opened
