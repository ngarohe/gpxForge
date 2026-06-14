"""
Portugal DGT LiDAR MDT provider.

Uses the DGT CDD STAC API (open, no auth) for route-driven tile discovery,
and the DGT S3 storage (requires PORTUGAL_DGT_TOKEN) for tile downloads.

STAC API:  https://dgt-be.a.incd.pt:8081
Storage:   https://stor-002.a.acnca.pt:9000/lidar/

Collections:
  MDT-50cm — 0.5m resolution (partial mainland coverage, NW incomplete)
  MDT-2m   — 2m resolution  (broader mainland coverage)

CRS:    EPSG:3763 (Portugal TM06)
Nodata: -999

Discovery is route-driven: each request queries the STAC API for tiles that
intersect the route's bbox and adds new tiles to a local JSON catalog.
Tiles are downloaded with a Bearer token and cached locally.
If no token is set or download is disabled, only locally placed tiles are used.
"""
import asyncio
import json
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import aiohttp
from pyproj import Transformer

from .base import ElevationProvider, ElevationError
from .http_hardening import body_snippet, request_with_retry

try:
    import rasterio
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False


_STAC_BASE = 'https://dgt-be.a.incd.pt:8081'
_STAC_LIMIT = 500   # max items per STAC page
_TIFF_MAGIC = (b'II', b'MM')  # TIFF little/big-endian first 2 bytes

_CDD_LOGIN_URL = 'https://cdd.dgterritorio.gov.pt/auth/login'
_CDD_STAC_SEARCH = 'https://cdd.dgterritorio.gov.pt/dgt-be/v1/search'


def _safe_name(value: str) -> str:
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', value or '')


class _PortugalDGTProvider(ElevationProvider):
    """Portugal DGT LiDAR — STAC-driven tile discovery + local COG sampling.

    Discovery: queries STAC API bbox-intersect for the route's WGS84 bbox (open).
    Download:  HTTP GET with Authorization: Bearer <token> to S3 (auth-gated).
    Sampling:  rasterio.open() on local tiles; auto-transforms EPSG:3763 → WGS84.
    """

    is_local = True

    def __init__(
        self,
        *,
        collection: str,
        resolution_m: float,
        dataset_code: str,
        enabled: bool,
        index_path: str,
        token: str,
        username: str,
        password: str,
        download_enabled: bool,
        download_timeout_s: int,
        tile_max_bytes: int,
    ):
        self._collection = collection
        self._resolution = resolution_m
        self.dataset_code = dataset_code
        self.enabled = enabled
        self.index_path = index_path
        self._token = token
        self._username = username
        self._password = password
        self._download_enabled = download_enabled
        self._download_timeout_s = download_timeout_s
        self._tile_max_bytes = tile_max_bytes
        self._catalog_cache: Optional[Dict[str, dict]] = None

    @property
    def country_code(self) -> str:
        return 'PT'

    @property
    def resolution(self) -> float:
        return self._resolution

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        if not self.enabled:
            return [None] * len(points)
        if not RASTERIO_AVAILABLE:
            raise ElevationError(f'{self.dataset_code}: rasterio is required for COG tile sampling')

        catalog = await self._ensure_catalog()
        await self._discover_tiles_for_points(points, catalog)

        assignment, used_tiles = self._assign_points(points, catalog)
        if not used_tiles:
            return [None] * len(points)

        downloaded = await self._ensure_tiles(used_tiles, catalog)
        elevations = await asyncio.get_event_loop().run_in_executor(
            None, self._sample_tiles, points, assignment, used_tiles, catalog
        )

        if self.verbose:
            hit = sum(1 for e in elevations if e is not None)
            self._verbose_log = {
                'dataset': self.dataset_code,
                'catalog_tiles': len(catalog),
                'used_tiles': len(used_tiles),
                'downloaded': downloaded,
                'resolved': hit,
                'index_source': 'local' if os.path.exists(self.index_path) else 'fresh',
            }

        return elevations

    # ── Catalog ──────────────────────────────────────────────────────────

    async def _ensure_catalog(self) -> Dict[str, dict]:
        if self._catalog_cache is not None:
            return self._catalog_cache

        catalog: Dict[str, dict] = {}
        if os.path.exists(self.index_path):
            try:
                with open(self.index_path, 'r', encoding='utf-8') as f:
                    payload = json.load(f)
                items = payload.get('tiles', []) if isinstance(payload, dict) else payload
                for item in items:
                    bbox = item.get('bbox')
                    if not isinstance(bbox, list) or len(bbox) != 4:
                        continue
                    tile_id = str(item.get('id') or '')
                    if not tile_id:
                        continue
                    safe_id = _safe_name(tile_id)
                    raw_path = item.get('path', f'{safe_id}.tif')
                    p = Path(raw_path).as_posix().strip().lstrip('/')
                    if '..' in p.split('/'):
                        p = f'{safe_id}.tif'
                    local_path = os.path.join(os.path.dirname(self.index_path), p)
                    catalog[safe_id] = {
                        'id': safe_id,
                        'bbox': [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
                        'url': item.get('url', ''),
                        'path': local_path,
                    }
            except Exception:
                pass

        self._catalog_cache = catalog
        return catalog

    def _persist_catalog(self, catalog: Dict[str, dict]) -> None:
        base_dir = os.path.dirname(self.index_path)
        tiles_out = []
        for tile_id in sorted(catalog.keys()):
            tile = catalog[tile_id]
            try:
                rel = os.path.relpath(tile['path'], base_dir).replace('\\', '/')
            except ValueError:
                rel = os.path.basename(tile['path'])
            entry = {'id': tile['id'], 'bbox': tile['bbox'], 'path': rel}
            if tile.get('url'):
                entry['url'] = tile['url']
            tiles_out.append(entry)

        os.makedirs(base_dir, exist_ok=True)
        tmp = self.index_path + '.part'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'tiles': tiles_out}, f, ensure_ascii=True, separators=(',', ':'))
        os.replace(tmp, self.index_path)

    # ── STAC discovery ────────────────────────────────────────────────────

    async def _discover_tiles_for_points(
        self, points: List[Tuple[float, float]], catalog: Dict[str, dict]
    ) -> int:
        if not points:
            return 0

        lats = [p[0] for p in points]
        lons = [p[1] for p in points]
        bbox_str = f"{min(lons)},{min(lats)},{max(lons)},{max(lats)}"

        timeout = aiohttp.ClientTimeout(total=30)
        added = 0
        offset = 0

        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            while True:
                url = f"{_STAC_BASE}/collections/{self._collection}/items"
                params = {'bbox': bbox_str, 'limit': _STAC_LIMIT, 'offset': offset}
                try:
                    status, body, _req_url, _ct = await request_with_retry(
                        session,
                        "GET",
                        url,
                        params=params,
                        max_attempts=3,
                        transient_statuses={408, 429, 500, 502, 503, 504},
                        retry_body_keywords=("429", "rate", "too many"),
                        verbose=self.verbose,
                        log_prefix=f"{self.dataset_code}/stac",
                    )
                    if status != 200:
                        break
                    data = json.loads(body.decode('utf-8', errors='replace'))
                except Exception:
                    break

                features = data.get('features', [])
                if not features:
                    break

                for feature in features:
                    item_id = str(feature.get('id') or '')
                    if not item_id:
                        continue
                    safe_id = _safe_name(item_id)
                    if safe_id in catalog:
                        continue

                    # DGT STAC returns bbox in EPSG:3763 (projected), not WGS84.
                    # Always derive WGS84 bbox from geometry coordinates instead.
                    bbox = None
                    geo = feature.get('geometry') or {}
                    coords = (geo.get('coordinates') or [[]])[0]
                    if coords and len(coords) >= 3:
                        xs = [c[0] for c in coords]
                        ys = [c[1] for c in coords]
                        bbox = [min(xs), min(ys), max(xs), max(ys)]
                    if not bbox:
                        continue

                    assets = feature.get('assets') or {}
                    asset = assets.get('Data') or assets.get('data') or next(iter(assets.values()), {})
                    url_href = str(asset.get('href') or '')

                    local_path = os.path.join(os.path.dirname(self.index_path), f'{safe_id}.tif')
                    catalog[safe_id] = {
                        'id': safe_id,
                        'bbox': [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
                        'url': url_href,
                        'path': local_path,
                    }
                    added += 1

                returned = data.get('numberReturned', len(features))
                if returned < _STAC_LIMIT:
                    break
                offset += _STAC_LIMIT

        if added:
            self._persist_catalog(catalog)
        return added

    # ── Assignment ────────────────────────────────────────────────────────

    def _assign_points(
        self, points: List[Tuple[float, float]], catalog: Dict[str, dict]
    ) -> Tuple[List[Optional[str]], Set[str]]:
        if not catalog:
            return [None] * len(points), set()

        lats = [p[0] for p in points]
        lons = [p[1] for p in points]
        route_bbox = [min(lons), min(lats), max(lons), max(lats)]

        tiles = [
            t for t in catalog.values()
            if not (t['bbox'][2] < route_bbox[0] or t['bbox'][0] > route_bbox[2]
                    or t['bbox'][3] < route_bbox[1] or t['bbox'][1] > route_bbox[3])
        ]

        assignment: List[Optional[str]] = [None] * len(points)
        used: Set[str] = set()
        for i, (lat, lon) in enumerate(points):
            for tile in tiles:
                xmin, ymin, xmax, ymax = tile['bbox']
                if xmin <= lon <= xmax and ymin <= lat <= ymax:
                    assignment[i] = tile['id']
                    used.add(tile['id'])
                    break
        return assignment, used

    # ── Auth ─────────────────────────────────────────────────────────────

    async def _login_session(self, session: aiohttp.ClientSession) -> bool:
        """Authenticate via Keycloak form login, storing cookies on the session.

        Flow: GET login redirect → parse Keycloak form → POST credentials →
        follow redirect back to CDD portal → session cookies are now set.
        """
        if self._token:
            return True
        if not self._username or not self._password:
            return False
        try:
            # Step 1: GET the login URL — follows redirect to Keycloak form
            async with session.get(_CDD_LOGIN_URL, allow_redirects=True, ssl=False) as resp:
                if resp.status != 200:
                    print(f'    [{self.dataset_code}] login page HTTP {resp.status}')
                    return False
                html = (await resp.read()).decode('utf-8', errors='replace')
                form_url = resp.url  # final URL after redirects

            # Step 2: extract the Keycloak form action URL
            import re as _re
            m = _re.search(r'<form[^>]+action=["\']([^"\']+)["\']', html)
            if not m:
                print(f'    [{self.dataset_code}] no form action in login page')
                return False
            action = m.group(1).replace('&amp;', '&')

            # Step 3: POST credentials
            payload = {'username': self._username, 'password': self._password}
            async with session.post(action, data=payload, allow_redirects=True, ssl=False) as resp:
                if resp.status != 200:
                    print(f'    [{self.dataset_code}] login POST HTTP {resp.status}')
                    return False
                # Check we landed back on the CDD portal (not the login form again)
                final = str(resp.url)
                if 'auth.cdd.dgterritorio' in final:
                    print(f'    [{self.dataset_code}] login failed (bad credentials?)')
                    return False

            return True
        except Exception as e:
            print(f'    [{self.dataset_code}] login error: {e}')
            return False

    # ── Download ──────────────────────────────────────────────────────────

    async def _resolve_download_urls(
        self, session: aiohttp.ClientSession, tile_ids: Set[str], catalog: Dict[str, dict]
    ) -> Dict[str, str]:
        """Query the authenticated CDD STAC to get proxied download URLs."""
        needed = {tid for tid in tile_ids
                  if tid in catalog and not os.path.exists(catalog[tid]['path'])}
        if not needed:
            return {}

        # Compute union bbox of needed tiles
        lons, lats = [], []
        for tid in needed:
            b = catalog[tid]['bbox']
            lons.extend([b[0], b[2]])
            lats.extend([b[1], b[3]])
        bbox = [min(lons), min(lats), max(lons), max(lats)]

        url_map: Dict[str, str] = {}
        try:
            search_body = json.dumps({
                'collections': [self._collection],
                'bbox': bbox,
                'limit': _STAC_LIMIT,
            }).encode('utf-8')
            status, body, _, _ = await request_with_retry(
                session, 'POST', _CDD_STAC_SEARCH,
                data=search_body,
                headers={'Content-Type': 'application/json'},
                max_attempts=2,
                transient_statuses={408, 429, 500, 502, 503},
                retry_body_keywords=(),
                verbose=self.verbose,
                log_prefix=f'{self.dataset_code}/auth-stac',
            )
            if status != 200:
                return {}
            data = json.loads(body.decode('utf-8', errors='replace'))
            for feat in data.get('features', []):
                fid = _safe_name(str(feat.get('id', '')))
                if fid not in needed:
                    continue
                assets = feat.get('assets', {})
                asset = assets.get('data') or assets.get('Data') or next(iter(assets.values()), {})
                href = asset.get('href', '')
                if href:
                    url_map[fid] = href
        except Exception as e:
            if self.verbose:
                print(f'    [{self.dataset_code}] auth-stac error: {e}')

        return url_map

    async def _ensure_tiles(self, tile_ids: Set[str], catalog: Dict[str, dict]) -> int:
        downloaded = 0
        if not tile_ids or not self._download_enabled:
            return downloaded

        timeout = aiohttp.ClientTimeout(total=self._download_timeout_s)
        cookie_jar = aiohttp.CookieJar(unsafe=True)

        async with aiohttp.ClientSession(
            timeout=timeout, trust_env=False, cookie_jar=cookie_jar,
        ) as session:
            if self._token:
                # Static Bearer token — download direct from S3
                auth_headers = {'Authorization': f'Bearer {self._token}'}
                download_urls = {tid: catalog[tid].get('url', '') for tid in tile_ids}
            elif await self._login_session(session):
                # Session cookies — resolve proxied download URLs
                auth_headers = {}
                download_urls = await self._resolve_download_urls(session, tile_ids, catalog)
            else:
                return downloaded

            for tile_id in sorted(tile_ids):
                tile = catalog.get(tile_id)
                if not tile:
                    continue
                path = tile['path']
                if os.path.exists(path):
                    continue
                url = download_urls.get(tile_id, '')
                if not url:
                    continue
                os.makedirs(os.path.dirname(path), exist_ok=True)
                try:
                    status, data, _req_url, _ct = await request_with_retry(
                        session,
                        "GET",
                        url,
                        headers=auth_headers,
                        max_attempts=3,
                        transient_statuses={408, 429, 500, 502, 503, 504},
                        retry_body_keywords=("429", "rate", "too many"),
                        verbose=self.verbose,
                        log_prefix=f"{self.dataset_code}/tile",
                    )
                    if status != 200:
                        continue
                except Exception:
                    continue

                if len(data) > self._tile_max_bytes:
                    continue
                if data[:2] not in _TIFF_MAGIC:
                    continue

                tmp = path + '.part'
                with open(tmp, 'wb') as f:
                    f.write(data)
                os.replace(tmp, path)
                downloaded += 1

        return downloaded

    # ── Sampling ──────────────────────────────────────────────────────────

    def _sample_tiles(
        self,
        points: List[Tuple[float, float]],
        assignment: List[Optional[str]],
        used_tiles: Set[str],
        catalog: Dict[str, dict],
    ) -> List[Optional[float]]:
        out: List[Optional[float]] = [None] * len(points)

        idx_by_tile: Dict[str, List[int]] = {}
        for i, tile_id in enumerate(assignment):
            if tile_id is not None:
                idx_by_tile.setdefault(tile_id, []).append(i)

        for tile_id in used_tiles:
            tile = catalog.get(tile_id)
            if not tile:
                continue
            path = tile['path']
            if not os.path.exists(path):
                continue
            try:
                with rasterio.open(path) as ds:
                    transformer = None
                    if ds.crs and str(ds.crs).upper() not in ('EPSG:4326', 'OGC:CRS84'):
                        transformer = Transformer.from_crs('EPSG:4326', ds.crs, always_xy=True)
                    ds_nodata = ds.nodata

                    indices = idx_by_tile.get(tile_id, [])
                    coords = []
                    for idx in indices:
                        lat, lon = points[idx]
                        if transformer is None:
                            coords.append((lon, lat))
                        else:
                            coords.append(transformer.transform(lon, lat))

                    for idx, values in zip(indices, ds.sample(coords)):
                        val = float(values[0])
                        if ds_nodata is not None and val == ds_nodata:
                            continue
                        if val <= -999:
                            continue
                        if abs(val) > 1e37:
                            continue
                        if val != val:  # NaN
                            continue
                        out[idx] = val
            except Exception:
                continue

        return out


class PortugalMDT50cmProvider(_PortugalDGTProvider):
    """Portugal DGT MDT 0.5m — primary hi-res (partial NW coverage)."""

    def __init__(self):
        from config import (
            PORTUGAL_MDT50CM_ENABLED, PORTUGAL_MDT50CM_INDEX_PATH,
            PORTUGAL_DGT_TOKEN, PORTUGAL_DGT_USERNAME, PORTUGAL_DGT_PASSWORD,
            PORTUGAL_TILE_DOWNLOAD_ENABLED,
            PORTUGAL_TILE_DOWNLOAD_TIMEOUT_S, PORTUGAL_TILE_MAX_BYTES,
        )
        super().__init__(
            collection='MDT-50cm',
            resolution_m=0.5,
            dataset_code='PT_MDT50CM_LOCAL',
            enabled=PORTUGAL_MDT50CM_ENABLED,
            index_path=PORTUGAL_MDT50CM_INDEX_PATH,
            token=PORTUGAL_DGT_TOKEN,
            username=PORTUGAL_DGT_USERNAME,
            password=PORTUGAL_DGT_PASSWORD,
            download_enabled=PORTUGAL_TILE_DOWNLOAD_ENABLED,
            download_timeout_s=PORTUGAL_TILE_DOWNLOAD_TIMEOUT_S,
            tile_max_bytes=PORTUGAL_TILE_MAX_BYTES,
        )


class PortugalMDT2mProvider(_PortugalDGTProvider):
    """Portugal DGT MDT 2m — broader coverage fallback."""

    def __init__(self):
        from config import (
            PORTUGAL_MDT2M_ENABLED, PORTUGAL_MDT2M_INDEX_PATH,
            PORTUGAL_DGT_TOKEN, PORTUGAL_DGT_USERNAME, PORTUGAL_DGT_PASSWORD,
            PORTUGAL_TILE_DOWNLOAD_ENABLED,
            PORTUGAL_TILE_DOWNLOAD_TIMEOUT_S, PORTUGAL_TILE_MAX_BYTES,
        )
        super().__init__(
            collection='MDT-2m',
            resolution_m=2.0,
            dataset_code='PT_MDT2M_LOCAL',
            enabled=PORTUGAL_MDT2M_ENABLED,
            index_path=PORTUGAL_MDT2M_INDEX_PATH,
            token=PORTUGAL_DGT_TOKEN,
            username=PORTUGAL_DGT_USERNAME,
            password=PORTUGAL_DGT_PASSWORD,
            download_enabled=PORTUGAL_TILE_DOWNLOAD_ENABLED,
            download_timeout_s=PORTUGAL_TILE_DOWNLOAD_TIMEOUT_S,
            tile_max_bytes=PORTUGAL_TILE_MAX_BYTES,
        )
