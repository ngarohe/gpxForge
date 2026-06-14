import asyncio
import json
import math
import os
import re
from datetime import date
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urlencode, urlparse

import aiohttp
from pyproj import Transformer

from config import (
    AUSTRIA_ALS1_CKAN_QUERY,
    AUSTRIA_ALS1_ENABLED,
    AUSTRIA_BEV_API_BASE_URL,
    AUSTRIA_BEV_SEARCH_SIZE,
    AUSTRIA_ALS1_INDEX_PATH,
    AUSTRIA_ALS1_INDEX_URL,
    AUSTRIA_CKAN_BASE_URL,
    AUSTRIA_CKAN_DYNAMIC_DISCOVERY,
    AUSTRIA_CKAN_ROWS,
    AUSTRIA_DGM5_CKAN_QUERY,
    AUSTRIA_DGM5_ENABLED,
    AUSTRIA_DGM5_INDEX_PATH,
    AUSTRIA_DGM5_INDEX_URL,
    AUSTRIA_TILE_DOWNLOAD_ENABLED,
    AUSTRIA_TILE_DOWNLOAD_TIMEOUT_S,
    AUSTRIA_TILE_MAX_BYTES,
    AUSTRIA_TILE_URL_ALLOWLIST,
)

from .catalog_tiles import CatalogTileProvider, RASTERIO_AVAILABLE
from .http_hardening import request_with_retry

_AT_TILE_RE = re.compile(r'CRS3035RES(?P<res>\d+)mN(?P<n>\d+)E(?P<e>\d+)', re.IGNORECASE)
_AT_TILE_GRID_CANDIDATES = (50000, 25000, 10000, 5000, 2000, 1000)
_AT_STICHTAG_RE = re.compile(r'stichtag\s*(\d{2})\.(\d{2})\.(\d{4})', re.IGNORECASE)
_AT_ALS_STICHTAG_DATES = (
    "20240915",
    "20230915",
    "20220915",
    "20210915",
    "20210401",
    "20190915",
)


def _safe_name(value: str) -> str:
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', value or '')


def _looks_like_raster_resource(haystack: str) -> bool:
    h = (haystack or "").lower()
    return any(token in h for token in (
        ".tif", ".tiff", ".zip", "geotiff", "geo tiff", "dtm", "dgm", "terrain"
    ))


def _normalize_ckan_base(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    if not u:
        return ""
    # Accept both ".../api/3/action" and ".../api/3"
    if u.endswith("/action"):
        return u
    if u.endswith("/api/3"):
        return f"{u}/action"
    return u


def _collect_geojson_coords(node, out: List[Tuple[float, float]]) -> None:
    if node is None:
        return
    if isinstance(node, dict):
        ntype = str(node.get("type") or "").lower()
        if ntype == "featurecollection":
            for feat in node.get("features", []) or []:
                _collect_geojson_coords(feat, out)
            return
        if ntype == "feature":
            _collect_geojson_coords(node.get("geometry"), out)
            return
        if "coordinates" in node:
            _collect_geojson_coords(node.get("coordinates"), out)
            return
    if isinstance(node, (list, tuple)):
        if len(node) >= 2 and all(isinstance(v, (int, float)) for v in node[:2]):
            out.append((float(node[0]), float(node[1])))
            return
        for child in node:
            _collect_geojson_coords(child, out)


def _as_str_list(value) -> List[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        out: List[str] = []
        for item in value:
            text = str(item or "").strip()
            if text:
                out.append(text)
        return out
    text = str(value).strip()
    return [text] if text else []


def _extract_stichtag_ordinal(title: str) -> int:
    """Extract Stichtag date from title for deterministic newest-record selection."""
    m = _AT_STICHTAG_RE.search(title or "")
    if not m:
        return 0
    try:
        d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        return d.toordinal()
    except Exception:
        return 0


class _AustriaDynamicCatalogProvider(CatalogTileProvider):
    def __init__(
        self,
        *,
        country_code: str,
        dataset_code: str,
        resolution_m: float,
        enabled: bool,
        index_path: str,
        index_url: str,
        download_enabled: bool,
        download_timeout_s: int,
        tile_max_bytes: int,
        ckan_query: str,
        dataset_folder: str,
        search_prefix: str,
        url_keywords: List[str],
        tile_grid_m: int,
    ):
        super().__init__(
            country_code=country_code,
            dataset_code=dataset_code,
            resolution_m=resolution_m,
            enabled=enabled,
            index_path=index_path,
            index_url=index_url,
            download_enabled=download_enabled,
            download_timeout_s=download_timeout_s,
            tile_max_bytes=tile_max_bytes,
            prefer_remote_sampling=True,
        )
        self._ckan_query = (ckan_query or '').strip()
        self._dataset_folder = dataset_folder
        self._search_prefix = (search_prefix or '').strip()
        self._url_keywords = [kw.lower() for kw in url_keywords if kw.strip()]
        self._tile_grid_m = max(1, int(tile_grid_m))
        self._is_als_dataset = "als" in (self.dataset_code or "").lower()
        self._dynamic_discovery = bool(
            AUSTRIA_CKAN_DYNAMIC_DISCOVERY and self.download_enabled and self._is_als_dataset
        )
        self._bev_search_url = f"{AUSTRIA_BEV_API_BASE_URL}/search/records/_search"
        self._to_wgs84 = Transformer.from_crs('EPSG:3035', 'EPSG:4326', always_xy=True)
        self._to_3035 = Transformer.from_crs('EPSG:4326', 'EPSG:3035', always_xy=True)
        self._ckan_bases = self._build_ckan_bases()

    def _build_ckan_bases(self) -> List[str]:
        # Try configured base first, then known variants.
        configured = _normalize_ckan_base(AUSTRIA_CKAN_BASE_URL)
        known = [
            "https://www.data.gv.at/api/3/action",
            "https://www.data.gv.at/katalog/api/3/action",
            "https://data.gv.at/api/3/action",
            "https://data.gv.at/katalog/api/3/action",
        ]
        out: List[str] = []
        for base in [configured] + known:
            base = _normalize_ckan_base(base)
            if base and base not in out:
                out.append(base)
        return out

    async def _ckan_package_search(
        self,
        session: aiohttp.ClientSession,
        *,
        q: str,
        rows: int,
        start: int,
        log_prefix: str,
    ) -> Optional[dict]:
        params = {'q': q, 'rows': rows, 'start': start}
        headers = {"User-Agent": "GPXForge/0.2.0 (+local)"}
        last_err: Optional[str] = None
        for base in self._ckan_bases:
            query_url = f"{base}/package_search?{urlencode(params)}"
            try:
                status, data, _req_url, _ct = await request_with_retry(
                    session,
                    "GET",
                    query_url,
                    headers=headers,
                    max_attempts=4,
                    transient_statuses={408, 425, 429, 500, 502, 503, 504},
                    retry_body_keywords=("429", "rate", "too many", "quota"),
                    verbose=self.verbose,
                    log_prefix=log_prefix,
                )
                if status != 200:
                    last_err = f"HTTP {status} via {base}"
                    continue
                payload = json.loads(data.decode('utf-8', errors='replace'))
                result = payload.get('result') if isinstance(payload, dict) else None
                if result is None:
                    last_err = f"invalid payload via {base}"
                    continue
                return result
            except Exception as exc:
                last_err = f"{type(exc).__name__} via {base}: {exc}"
                continue
        if self.verbose and last_err:
            print(f"    [{self.dataset_code}] CKAN search failed ({last_err})")
        return None

    @property
    def _discovery_query(self) -> str:
        return self._ckan_query or self._search_prefix or ''

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        if not self.enabled:
            return [None] * len(points)
        if not RASTERIO_AVAILABLE:
            raise Exception(f'{self.dataset_code}: rasterio is required for tile sampling')

        catalog = await self._ensure_catalog()
        assignment, used_tiles = self._assign_points(points, catalog) if catalog else ([None] * len(points), set())

        discovered = 0
        if self._dynamic_discovery and any(tile_id is None for tile_id in assignment):
            discovered = await self._discover_tiles_for_points(points, assignment, catalog)
            if discovered:
                assignment, used_tiles = self._assign_points(points, catalog)

        if not used_tiles:
            return [None] * len(points)

        downloaded = await self._ensure_tiles(used_tiles, catalog)
        elevations = await asyncio.get_event_loop().run_in_executor(
            None, self._sample_tiles, points, assignment, used_tiles, catalog
        )

        # Important seam/coverage pass:
        # some points may be assigned to an existing broad bbox tile but still sample as nodata.
        # Run a second route-driven discovery on unresolved sampled points before falling back to DGM5.
        discovered_after_sample = 0
        if self._dynamic_discovery:
            unresolved_indices = [i for i, z in enumerate(elevations) if z is None]
            if unresolved_indices:
                unresolved_points = [points[i] for i in unresolved_indices]
                discovered_after_sample = await self._discover_tiles_for_raw_points(unresolved_points, catalog)
                if discovered_after_sample:
                    assignment, used_tiles = self._assign_points(points, catalog)
                    downloaded += await self._ensure_tiles(used_tiles, catalog)
                    elevations = await asyncio.get_event_loop().run_in_executor(
                        None, self._sample_tiles, points, assignment, used_tiles, catalog
                    )
                    discovered += discovered_after_sample

        if self.verbose:
            hit = sum(1 for e in elevations if e is not None)
            self._verbose_log = {
                'dataset': self.dataset_code,
                'catalog_tiles': len(catalog),
                'used_tiles': len(used_tiles),
                'downloaded': downloaded,
                'resolved': hit,
                'discovered': discovered,
                'index_source': 'local' if os.path.exists(self.index_path) else 'dynamic',
            }

        return elevations

    async def _ensure_catalog(self) -> Dict[str, dict]:
        catalog = await super()._ensure_catalog()
        if catalog:
            return catalog
        if not self._dynamic_discovery:
            return catalog
        # Start empty and populate route-driven using BEV GeoNetwork API.
        self._catalog_cache = {}
        return self._catalog_cache

    def _is_allowed_download_url(self, url: str) -> bool:
        if not url:
            return False
        host = (urlparse(url).hostname or '').lower()
        if not host:
            return False
        for allowed in AUSTRIA_TILE_URL_ALLOWLIST:
            if host == allowed or host.endswith(f'.{allowed}'):
                return True
        return False

    def _pick_resource_url(
        self,
        resources: List[dict],
        expected_code: str = '',
        require_keywords: bool = True,
    ) -> str:
        code_l = expected_code.lower()
        scored: List[Tuple[int, str]] = []
        for res in resources:
            url = str(res.get('url') or '').strip()
            if not url or not self._is_allowed_download_url(url):
                continue

            url_l = url.lower()
            fmt = str(res.get('format') or '').lower()
            name = str(res.get('name') or '').lower()
            desc = str(res.get('description') or '').lower()
            hay = f'{url_l} {fmt} {name} {desc}'

            if require_keywords and self._url_keywords and not any(kw in hay for kw in self._url_keywords):
                continue
            if not _looks_like_raster_resource(hay):
                continue

            score = 0
            if code_l and code_l in hay:
                score += 20
            if '.tif' in url_l or '.tiff' in url_l:
                score += 8
            if '.zip' in url_l:
                score += 6
            if 'geotiff' in fmt or fmt == 'tiff':
                score += 5
            if fmt == 'zip':
                score += 4
            if 'dtm' in hay or 'dgm' in hay:
                score += 3
            if 'wms' in hay or 'wfs' in hay or 'service' in hay:
                score -= 6

            scored.append((score, url))

        if not scored:
            return ''
        scored.sort(key=lambda item: item[0], reverse=True)
        return scored[0][1]

    def _parse_tile_code(self, text: str) -> Optional[Tuple[int, int, int]]:
        m = _AT_TILE_RE.search(text or '')
        if not m:
            return None
        res_m = int(m.group('res'))
        n = int(m.group('n'))
        e = int(m.group('e'))
        if res_m <= 0:
            return None
        return e, n, res_m

    def _extract_tile_code(
        self,
        package: dict,
        picked_url: str,
        fallback_code: str = '',
    ) -> Optional[Tuple[int, int, int]]:
        candidates: List[str] = [
            str(package.get('title') or ''),
            str(package.get('name') or ''),
            str(package.get('notes') or ''),
            picked_url,
        ]
        for res in package.get('resources') or []:
            candidates.append(str(res.get('name') or ''))
            candidates.append(str(res.get('description') or ''))
            candidates.append(str(res.get('url') or ''))

        for text in candidates:
            parsed = self._parse_tile_code(text)
            if parsed is not None:
                return parsed

        return self._parse_tile_code(fallback_code)

    def _tile_bbox_wgs84(self, e: int, n: int, res_m: int) -> List[float]:
        corners = [
            (e, n),
            (e + res_m, n),
            (e + res_m, n + res_m),
            (e, n + res_m),
        ]
        lons: List[float] = []
        lats: List[float] = []
        for x, y in corners:
            lon, lat = self._to_wgs84.transform(float(x), float(y))
            lons.append(float(lon))
            lats.append(float(lat))
        return [min(lons), min(lats), max(lons), max(lats)]

    def _normalize_bbox_wgs84(self, xmin: float, ymin: float, xmax: float, ymax: float) -> Optional[List[float]]:
        # Already lon/lat-like
        if (
            -180.0 <= xmin <= 180.0 and -180.0 <= xmax <= 180.0
            and -90.0 <= ymin <= 90.0 and -90.0 <= ymax <= 90.0
        ):
            lo_x, hi_x = sorted((float(xmin), float(xmax)))
            lo_y, hi_y = sorted((float(ymin), float(ymax)))
            return [lo_x, lo_y, hi_x, hi_y]

        # Projected (likely EPSG:3035); convert corners to WGS84
        try:
            corners = [
                self._to_wgs84.transform(float(xmin), float(ymin)),
                self._to_wgs84.transform(float(xmin), float(ymax)),
                self._to_wgs84.transform(float(xmax), float(ymin)),
                self._to_wgs84.transform(float(xmax), float(ymax)),
            ]
        except Exception:
            return None
        lons = [p[0] for p in corners]
        lats = [p[1] for p in corners]
        if not lons or not lats:
            return None
        return [min(lons), min(lats), max(lons), max(lats)]

    def _extract_bbox_from_value(self, value) -> Optional[List[float]]:
        if value is None:
            return None

        parsed = value
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            try:
                parsed = json.loads(text)
            except Exception:
                return None

        # Direct [xmin,ymin,xmax,ymax]
        if isinstance(parsed, (list, tuple)) and len(parsed) == 4 and all(isinstance(v, (int, float)) for v in parsed):
            return self._normalize_bbox_wgs84(float(parsed[0]), float(parsed[1]), float(parsed[2]), float(parsed[3]))

        # GeoJSON-like dict/list of coords
        coords: List[Tuple[float, float]] = []
        _collect_geojson_coords(parsed, coords)
        if not coords:
            return None
        xs = [p[0] for p in coords]
        ys = [p[1] for p in coords]
        return self._normalize_bbox_wgs84(min(xs), min(ys), max(xs), max(ys))

    def _extract_bbox(self, package: dict, resource: Optional[dict] = None) -> Optional[List[float]]:
        candidates = []
        if resource:
            candidates.extend([resource.get('bbox'), resource.get('spatial'), resource.get('extent')])
        candidates.extend([package.get('bbox'), package.get('spatial'), package.get('extent')])
        for extra in package.get('extras') or []:
            key = str(extra.get('key') or '').lower()
            if key in ('spatial', 'bbox', 'extent', 'spatial_bbox'):
                candidates.append(extra.get('value'))
        for candidate in candidates:
            bbox = self._extract_bbox_from_value(candidate)
            if bbox is not None:
                return bbox
        return None

    def _tile_code_for_point(self, lat: float, lon: float) -> str:
        x, y = self._to_3035.transform(float(lon), float(lat))
        e = int(math.floor(x / self._tile_grid_m) * self._tile_grid_m)
        n = int(math.floor(y / self._tile_grid_m) * self._tile_grid_m)
        return f'CRS3035RES{self._tile_grid_m}mN{n}E{e}'

    def _tile_codes_for_point(self, lat: float, lon: float) -> List[str]:
        x, y = self._to_3035.transform(float(lon), float(lat))
        grids: List[int] = []
        for g in (self._tile_grid_m,) + _AT_TILE_GRID_CANDIDATES:
            if g not in grids:
                grids.append(g)
        out: List[str] = []
        for grid in grids:
            e = int(math.floor(x / grid) * grid)
            n = int(math.floor(y / grid) * grid)
            out.append(f'CRS3035RES{grid}mN{n}E{e}')
        return out

    def _local_tile_path(self, tile_id: str) -> str:
        return os.path.join(os.path.dirname(self.index_path), self._dataset_folder, f'{tile_id}.tif')

    def _add_tile(self, catalog: Dict[str, dict], e: int, n: int, res_m: int, url: str) -> bool:
        tile_id = _safe_name(f'AT_{self._dataset_folder.upper()}_{e}_{n}_{res_m}')
        if tile_id in catalog:
            return False
        catalog[tile_id] = {
            'id': tile_id,
            'bbox': self._tile_bbox_wgs84(e, n, res_m),
            'url': url,
            'path': self._local_tile_path(tile_id),
        }
        return True

    def _add_bbox_tile(self, catalog: Dict[str, dict], bbox: List[float], url: str, hint: str = '') -> bool:
        seed = hint or os.path.basename(url) or f"bbox_{bbox[0]}_{bbox[1]}_{bbox[2]}_{bbox[3]}"
        tile_id = _safe_name(f"AT_{self._dataset_folder.upper()}_{seed}")
        if not tile_id:
            tile_id = _safe_name(f"AT_{self._dataset_folder.upper()}_{len(catalog)}")
        if tile_id in catalog:
            # dedupe exact same URL if already present
            if str(catalog[tile_id].get('url') or '') == str(url or ''):
                return False
            i = 1
            while f"{tile_id}_{i}" in catalog:
                i += 1
            tile_id = f"{tile_id}_{i}"
        catalog[tile_id] = {
            'id': tile_id,
            'bbox': bbox,
            'url': url,
            'path': self._local_tile_path(tile_id),
        }
        return True

    def _collect_primary_tile_codes(
        self,
        points: List[Tuple[float, float]],
        assignment: Optional[List[Optional[str]]] = None,
        unresolved_only: bool = False,
    ) -> List[str]:
        if not points:
            return []

        if unresolved_only and assignment is not None:
            scan_points = [points[i] for i, tile_id in enumerate(assignment) if tile_id is None]
        else:
            scan_points = points

        if not scan_points:
            return []

        # Scan densely so we don't miss short segments that cross a 50km tile edge.
        # Missing one ALS1 tile here causes avoidable fallback to lower-resolution sources.
        step = max(1, len(scan_points) // 50000)
        codes: Set[str] = set()
        for i in range(0, len(scan_points), step):
            lat, lon = scan_points[i]
            codes.add(self._tile_code_for_point(lat, lon))

        # Always include the final point in case route end is in a different tile.
        lat_last, lon_last = scan_points[-1]
        codes.add(self._tile_code_for_point(lat_last, lon_last))

        return sorted(codes)

    def _extract_bbox_from_geom(self, source: dict) -> Optional[List[float]]:
        coords: List[Tuple[float, float]] = []
        _collect_geojson_coords(source.get("geom"), coords)
        if not coords:
            return None
        xs = [p[0] for p in coords]
        ys = [p[1] for p in coords]
        return self._normalize_bbox_wgs84(min(xs), min(ys), max(xs), max(ys))

    def _extract_download_urls(self, source: dict) -> List[str]:
        urls: List[str] = []
        for key in ("linkUrlProtocolWWWDOWNLOAD10httpdownload", "linkUrl"):
            for raw in _as_str_list(source.get(key)):
                low = raw.lower()
                if not low.startswith("http"):
                    continue
                if not self._is_allowed_download_url(raw):
                    continue
                if not (low.endswith(".tif") or low.endswith(".tiff") or low.endswith(".zip")):
                    continue
                urls.append(raw)
        out: List[str] = []
        seen: Set[str] = set()
        for url in urls:
            if url in seen:
                continue
            out.append(url)
            seen.add(url)
        return out

    async def _search_bev_records(
        self,
        session: aiohttp.ClientSession,
        query: str,
        size: int = 12,
    ) -> List[dict]:
        body = json.dumps(
            {
                "from": 0,
                "size": max(1, min(size, 50)),
                "query": {"bool": {"must": [{"query_string": {"query": query}}]}},
            },
            separators=(",", ":"),
        ).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "GPXForge/0.2.0 (+local)",
        }
        try:
            status, data, _req_url, _ct = await request_with_retry(
                session,
                "POST",
                self._bev_search_url,
                data=body,
                headers=headers,
                max_attempts=4,
                transient_statuses={408, 425, 429, 500, 502, 503, 504},
                retry_body_keywords=("too many requests", "quota exceeded", "gateway timeout", "service unavailable", "bad gateway"),
                verbose=self.verbose,
                log_prefix=f"{self.dataset_code}/bev-search",
            )
        except Exception:
            return []
        if status != 200:
            return []
        try:
            payload = json.loads(data.decode("utf-8", errors="replace"))
        except Exception:
            return []
        hits = payload.get("hits", {}).get("hits", [])
        return hits if isinstance(hits, list) else []

    def _pick_als_record(self, hits: List[dict], tile_code: str) -> Optional[dict]:
        wanted = tile_code.lower()
        best: Optional[dict] = None
        best_key: Tuple[int, int] = (-1, -1)
        for hit in hits:
            source = hit.get("_source")
            if not isinstance(source, dict):
                continue

            title_obj = source.get("resourceTitleObject") or {}
            title = str(title_obj.get("default") or source.get("resourceTitle") or "")
            title_l = title.lower()
            if "als dsm" in title_l:
                continue

            urls = self._extract_download_urls(source)
            als_urls = [
                u for u in urls
                if "/download/als/dtm/" in u.lower()
                and wanted in u.lower()
                and (u.lower().endswith(".tif") or u.lower().endswith(".tiff"))
            ]
            if not als_urls:
                continue
            if wanted not in title_l and not any(wanted in u.lower() for u in als_urls):
                continue

            stichtag = _extract_stichtag_ordinal(title)
            score = stichtag
            if "als dtm" in title_l:
                score += 1
            if "als_dtm_" in als_urls[0].lower():
                score += 1
            rank_key = (score, stichtag)
            if rank_key <= best_key:
                continue
            best_key = rank_key
            best = {
                "url": als_urls[0],
                "bbox": self._extract_bbox_from_geom(source),
            }
        return best

    async def _discover_tile_by_bev_record(
        self,
        session: aiohttp.ClientSession,
        tile_code: str,
    ) -> Optional[dict]:
        if not self._is_als_dataset:
            return None

        query_candidates: List[str] = []
        for q in (
            f"ALS DTM {tile_code}",
            f"ALS_DTM_{tile_code}",
            tile_code,
        ):
            q = q.strip()
            if q and q not in query_candidates:
                query_candidates.append(q)

        merged_hits: List[dict] = []
        seen_ids: Set[str] = set()
        for q in query_candidates:
            hits = await self._search_bev_records(session, q, size=AUSTRIA_BEV_SEARCH_SIZE)
            for hit in hits:
                key = str(hit.get("_id") or "")
                if key and key in seen_ids:
                    continue
                if key:
                    seen_ids.add(key)
                merged_hits.append(hit)

        picked = self._pick_als_record(merged_hits, tile_code)
        if picked is None:
            return None

        parsed = self._parse_tile_code(tile_code)
        if parsed is None:
            return None
        e, n, res_m = parsed
        bbox = picked.get("bbox")
        if bbox is not None:
            return {"mode": "bbox", "bbox": bbox, "url": picked["url"], "hint": tile_code}
        return {"mode": "grid", "e": e, "n": n, "res_m": res_m, "url": picked["url"]}

    async def _discover_tile_by_code(
        self,
        session: aiohttp.ClientSession,
        tile_code: str,
    ) -> Optional[dict]:
        query_candidates: List[str] = []
        for q in (tile_code, f'{self._search_prefix} {tile_code}', f'{self._discovery_query} {tile_code}'):
            q = q.strip()
            if q and q not in query_candidates:
                query_candidates.append(q)

        for q in query_candidates:
            result = await self._ckan_package_search(
                session,
                q=q,
                rows=min(50, max(5, AUSTRIA_CKAN_ROWS)),
                start=0,
                log_prefix=f"{self.dataset_code}/ckan-code",
            )
            if not result:
                continue
            for package in result.get('results') or []:
                resources = package.get('resources') or []
                if not resources:
                    continue
                picked_url = self._pick_resource_url(resources, expected_code=tile_code, require_keywords=True)
                if not picked_url:
                    # Fallback for catalog variants where resource naming differs.
                    picked_url = self._pick_resource_url(resources, expected_code=tile_code, require_keywords=False)
                if not picked_url:
                    continue
                tile = self._extract_tile_code(package, picked_url, fallback_code=tile_code)
                if tile is not None:
                    e, n, res_m = tile
                    return {'mode': 'grid', 'e': e, 'n': n, 'res_m': res_m, 'url': picked_url}

                # Some CKAN entries expose spatial bbox but not a parseable tile code.
                resource_match = next((r for r in resources if str(r.get('url') or '').strip() == picked_url), None)
                bbox = self._extract_bbox(package, resource_match)
                if bbox is not None:
                    hint = str(package.get('name') or package.get('title') or tile_code)
                    return {'mode': 'bbox', 'bbox': bbox, 'url': picked_url, 'hint': hint}
        return None

    async def _discover_tile_by_direct_url(
        self,
        session: aiohttp.ClientSession,
        tile_code: str,
    ) -> Optional[dict]:
        # Official BEV open-download URL pattern observed on data.gv.at resource links:
        # https://data.bev.gv.at/download/ALS/DTM/<YYYYMMDD>/ALS_DTM_<TILE_CODE>.tif
        if not tile_code.startswith("CRS3035RES50000m"):
            return None

        headers = {
            "Range": "bytes=0-1023",
            "User-Agent": "GPXForge/0.2.0 (+local)",
        }
        candidates: List[str] = []
        for d in _AT_ALS_STICHTAG_DATES:
            candidates.append(f"https://data.bev.gv.at/download/ALS/DTM/{d}/ALS_DTM_{tile_code}.tif")
            candidates.append(f"https://data.bev.gv.at/download/ALS/DTM/{d}/{tile_code}.tif")

        for url in candidates:
            try:
                status, body, _req_url, content_type = await request_with_retry(
                    session,
                    "GET",
                    url,
                    headers=headers,
                    max_attempts=2,
                    transient_statuses={408, 425, 429, 500, 502, 503, 504},
                    retry_body_keywords=("429", "rate", "too many", "quota"),
                    verbose=self.verbose,
                    log_prefix=f"{self.dataset_code}/direct",
                )
            except Exception:
                continue

            if status not in (200, 206):
                continue
            ct = (content_type or "").lower()
            if "html" in ct and body[:256].lower().startswith(b"<!doctype html"):
                continue

            parsed = self._parse_tile_code(url)
            if parsed is None:
                parsed = self._parse_tile_code(tile_code)
            if parsed is None:
                continue
            e, n, res_m = parsed
            return {'mode': 'grid', 'e': e, 'n': n, 'res_m': res_m, 'url': url}
        return None

    async def _discover_tiles_for_points(
        self,
        points: List[Tuple[float, float]],
        assignment: List[Optional[str]],
        catalog: Dict[str, dict],
    ) -> int:
        if not self._dynamic_discovery:
            return 0

        tile_codes = self._collect_primary_tile_codes(points, assignment=assignment, unresolved_only=True)
        if not tile_codes:
            return 0
        added = 0
        timeout = aiohttp.ClientTimeout(total=self.download_timeout_s)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            for code in tile_codes:
                try:
                    discovered = await self._discover_tile_by_bev_record(session, code)
                except Exception:
                    discovered = None
                if discovered is None:
                    try:
                        discovered = await self._discover_tile_by_direct_url(session, code)
                    except Exception:
                        discovered = None
                if discovered is None:
                    continue
                if discovered.get('mode') == 'grid':
                    e = int(discovered['e'])
                    n = int(discovered['n'])
                    res_m = int(discovered['res_m'])
                    url = str(discovered['url'])
                    added_now = self._add_tile(catalog, e, n, res_m, url)
                else:
                    bbox = discovered.get('bbox')
                    url = str(discovered.get('url') or '')
                    hint = str(discovered.get('hint') or code)
                    added_now = bool(bbox) and self._add_bbox_tile(catalog, bbox, url, hint=hint)
                if added_now:
                    added += 1

        if added:
            self._persist_catalog(catalog)
        print(f"    [{self.dataset_code}] route-driven discovery added {added} tiles")
        return added

    async def _discover_tiles_for_raw_points(
        self,
        points: List[Tuple[float, float]],
        catalog: Dict[str, dict],
    ) -> int:
        if not self._dynamic_discovery:
            return 0

        tile_codes = self._collect_primary_tile_codes(points)
        if not tile_codes:
            return 0
        added = 0
        timeout = aiohttp.ClientTimeout(total=self.download_timeout_s)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            for code in tile_codes:
                try:
                    discovered = await self._discover_tile_by_bev_record(session, code)
                except Exception:
                    discovered = None
                if discovered is None:
                    try:
                        discovered = await self._discover_tile_by_direct_url(session, code)
                    except Exception:
                        discovered = None
                if discovered is None:
                    continue
                if discovered.get('mode') == 'grid':
                    e = int(discovered['e'])
                    n = int(discovered['n'])
                    res_m = int(discovered['res_m'])
                    url = str(discovered['url'])
                    added_now = self._add_tile(catalog, e, n, res_m, url)
                else:
                    bbox = discovered.get('bbox')
                    url = str(discovered.get('url') or '')
                    hint = str(discovered.get('hint') or code)
                    added_now = bool(bbox) and self._add_bbox_tile(catalog, bbox, url, hint=hint)
                if added_now:
                    added += 1

        if added:
            self._persist_catalog(catalog)
            print(f"    [{self.dataset_code}] post-sample discovery added {added} tiles")
        return added

    async def _discover_ckan_catalog(self) -> Dict[str, dict]:
        discovered: Dict[str, dict] = {}
        base_query = self._discovery_query
        if not base_query:
            return discovered

        query_candidates: List[str] = [base_query]
        low = self.dataset_code.lower()
        if "als" in low:
            query_candidates.extend([
                "ALS DGM",
                "ALS-Hoehenraster",
                "ALS Höhenraster",
                "Digitales Gelaendehoehenmodell ALS",
            ])
        else:
            query_candidates.extend([
                "DGM",
                "Hoehenraster",
                "Höhenraster",
                "Digitales Gelaendehoehenmodell",
            ])
        # Keep unique order
        seen_q: Set[str] = set()
        query_candidates = [q for q in query_candidates if q and not (q in seen_q or seen_q.add(q))]

        timeout = aiohttp.ClientTimeout(total=self.download_timeout_s)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            rows = max(1, AUSTRIA_CKAN_ROWS)
            for query in query_candidates:
                start = 0
                pages = 0
                while pages < 20:
                    pages += 1
                    result = await self._ckan_package_search(
                        session,
                        q=query,
                        rows=rows,
                        start=start,
                        log_prefix=f"{self.dataset_code}/ckan-search",
                    )
                    if not result:
                        break

                    packages = result.get('results') or []
                    if not packages:
                        break

                    for package in packages:
                        resources = package.get('resources') or []
                        if not resources:
                            continue
                        picked_url = self._pick_resource_url(resources, require_keywords=True)
                        if not picked_url:
                            picked_url = self._pick_resource_url(resources, require_keywords=False)
                        if not picked_url:
                            continue
                        tile = self._extract_tile_code(package, picked_url)
                        if tile is not None:
                            e, n, res_m = tile
                            self._add_tile(discovered, e, n, res_m, picked_url)
                            continue
                        resource_match = next((r for r in resources if str(r.get('url') or '').strip() == picked_url), None)
                        bbox = self._extract_bbox(package, resource_match)
                        if bbox is not None:
                            hint = str(package.get('name') or package.get('title') or f'pkg_{start}_{len(discovered)}')
                            self._add_bbox_tile(discovered, bbox, picked_url, hint=hint)

                    total = int(result.get('count') or 0)
                    start += len(packages)
                    if start >= total or len(packages) < rows:
                        break

        if self.verbose:
            print(f"    [{self.dataset_code}] CKAN broad discovery found {len(discovered)} tiles")
        return discovered

    def _persist_catalog(self, catalog: Dict[str, dict]) -> None:
        base_dir = os.path.dirname(self.index_path)
        payload = {'tiles': []}
        for tile_id in sorted(catalog.keys()):
            tile = catalog[tile_id]
            rel_path = os.path.relpath(tile['path'], base_dir).replace('\\', '/')
            payload['tiles'].append({
                'id': tile['id'],
                'bbox': tile['bbox'],
                'path': rel_path,
                'url': tile.get('url', ''),
            })

        os.makedirs(base_dir, exist_ok=True)
        tmp_path = self.index_path + '.part'
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=True, separators=(',', ':'))
        os.replace(tmp_path, self.index_path)


class AustriaALS1Provider(_AustriaDynamicCatalogProvider):
    def __init__(self):
        super().__init__(
            country_code='AT',
            dataset_code='AT_ALS_DGM1_LOCAL',
            resolution_m=1.0,
            enabled=AUSTRIA_ALS1_ENABLED,
            index_path=AUSTRIA_ALS1_INDEX_PATH,
            index_url=AUSTRIA_ALS1_INDEX_URL,
            download_enabled=AUSTRIA_TILE_DOWNLOAD_ENABLED,
            download_timeout_s=AUSTRIA_TILE_DOWNLOAD_TIMEOUT_S,
            tile_max_bytes=AUSTRIA_TILE_MAX_BYTES,
            ckan_query=AUSTRIA_ALS1_CKAN_QUERY,
            dataset_folder='als1',
            search_prefix='ALS DTM',
            url_keywords=['/download/als/dtm/', 'als_dtm'],
            tile_grid_m=50000,
        )


class AustriaDGM5Provider(_AustriaDynamicCatalogProvider):
    def __init__(self):
        super().__init__(
            country_code='AT',
            dataset_code='AT_DGM5_LOCAL',
            resolution_m=5.0,
            enabled=AUSTRIA_DGM5_ENABLED,
            index_path=AUSTRIA_DGM5_INDEX_PATH,
            index_url=AUSTRIA_DGM5_INDEX_URL,
            download_enabled=AUSTRIA_TILE_DOWNLOAD_ENABLED,
            download_timeout_s=AUSTRIA_TILE_DOWNLOAD_TIMEOUT_S,
            tile_max_bytes=AUSTRIA_TILE_MAX_BYTES,
            ckan_query=AUSTRIA_DGM5_CKAN_QUERY,
            dataset_folder='dgm5',
            search_prefix='DGM',
            url_keywords=['/download/dgm/', ' dgm '],
            tile_grid_m=50000,
        )
