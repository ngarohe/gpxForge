import asyncio
import json
import os
import re
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

import aiohttp
from pyproj import Transformer

from .base import ElevationProvider, ElevationError
from .http_hardening import body_snippet, request_with_retry
from config import (
    SPAIN_CNIG_BASE_URL,
    SPAIN_CNIG_DISCOVERY_GRID_DEG,
    SPAIN_CNIG_DYNAMIC_DISCOVERY,
    SPAIN_CNIG_MAX_DISCOVERY_POINTS,
    SPAIN_TILE_DOWNLOAD_ENABLED,
    SPAIN_TILE_DOWNLOAD_TIMEOUT_S,
    SPAIN_TILE_MAX_BYTES,
    SPAIN_MDT01_ENABLED,
    SPAIN_MDT01_INDEX_PATH,
    SPAIN_MDT01_INDEX_URL,
    SPAIN_MDT02_ENABLED,
    SPAIN_MDT02_INDEX_PATH,
    SPAIN_MDT02_INDEX_URL,
)

try:
    import rasterio
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False


def _safe_name(value: str) -> str:
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', value)


def _safe_relpath(raw_path: str, fallback: str) -> str:
    p = Path(raw_path or '').as_posix().strip().lstrip('/')
    if not p:
        return fallback
    if '..' in p.split('/'):
        return fallback
    return p


_CNIG_SEC_RE = re.compile(r'detalleArchivo\?sec=(\d+)')
_CNIG_SERIES_BY_DATASET = {
    'ES_MDT01_LOCAL': 'MDT01',
    'ES_MDT02_LOCAL': 'MDT02',
}


def _as_float_pair(value) -> Optional[Tuple[float, float]]:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    x, y = value[0], value[1]
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None
    return float(x), float(y)


def _iter_lonlat_pairs(node) -> Iterable[Tuple[float, float]]:
    pair = _as_float_pair(node)
    if pair is not None:
        yield pair
        return
    if isinstance(node, (list, tuple)):
        for child in node:
            yield from _iter_lonlat_pairs(child)


def _bbox_from_coords_json(coords_json: str) -> Optional[List[float]]:
    try:
        obj = json.loads(coords_json)
    except Exception:
        return None

    xs: List[float] = []
    ys: List[float] = []
    for feature in obj.get('features', []):
        geometry = feature.get('geometry') or {}
        coords = geometry.get('coordinates')
        if coords is None:
            continue
        for lon, lat in _iter_lonlat_pairs(coords):
            xs.append(lon)
            ys.append(lat)

    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


class _SpainTileProvider(ElevationProvider):
    """Generic local/remote COG tile provider for Spain datasets.

    Catalog format expected at index_path (JSON):
      {
        "tiles": [
          {"id":"tile_001", "bbox":[lon_min,lat_min,lon_max,lat_max], "url":"...", "path":"optional/path.tif"}
        ]
      }
    Or directly a list of tile objects.
    """

    country = 'ES'

    def __init__(
        self,
        dataset_code: str,
        resolution_m: float,
        enabled: bool,
        index_path: str,
        index_url: str,
    ):
        self.dataset_code = dataset_code
        self._resolution = resolution_m
        self.enabled = enabled
        self.index_path = index_path
        self.index_url = index_url
        self._cnig_serie = _CNIG_SERIES_BY_DATASET.get(dataset_code, '')
        self._cnig_enabled = bool(
            self._cnig_serie and SPAIN_CNIG_DYNAMIC_DISCOVERY and SPAIN_TILE_DOWNLOAD_ENABLED
        )
        self._catalog_cache: Optional[Dict[str, dict]] = None

    @property
    def country_code(self) -> str:
        return self.country

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
        if catalog:
            assignment, used_tiles = self._assign_points(points, catalog)
        else:
            assignment = [None] * len(points)
            used_tiles = set()

        discovered = 0
        if self._cnig_enabled and any(tile_id is None for tile_id in assignment):
            discovered = await self._discover_cnig_tiles(points, assignment, catalog)
            if discovered:
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
                'discovered': discovered,
                'cnig_dynamic': self._cnig_enabled,
                'index_source': 'local' if os.path.exists(self.index_path) else 'remote',
            }

        return elevations

    async def _ensure_catalog(self) -> Dict[str, dict]:
        if self._catalog_cache is not None:
            return self._catalog_cache

        if not os.path.exists(self.index_path):
            if self.index_url and SPAIN_TILE_DOWNLOAD_ENABLED:
                await self._download_index()
            elif self._cnig_enabled:
                self._catalog_cache = {}
                return self._catalog_cache
            else:
                return {}

        try:
            with open(self.index_path, 'r', encoding='utf-8') as f:
                payload = json.load(f)
        except Exception:
            return {}

        items = payload.get('tiles', []) if isinstance(payload, dict) else payload
        catalog: Dict[str, dict] = {}
        for item in items:
            bbox = item.get('bbox')
            if not isinstance(bbox, list) or len(bbox) != 4:
                continue
            tile_id = str(item.get('id') or item.get('tile_id') or item.get('name') or '')
            if not tile_id:
                tile_id = _safe_name(item.get('path') or item.get('url') or f'{self.dataset_code}_{len(catalog)}')
            safe_id = _safe_name(tile_id)
            secuencial = str(item.get('secuencial') or item.get('sec') or '').strip()
            cod_serie = str(item.get('cod_serie') or item.get('codSerie') or self._cnig_serie or '').strip().upper()
            fallback_name = f'{cod_serie}_{secuencial}.tif' if (secuencial and cod_serie) else f'{safe_id}.tif'
            relpath = _safe_relpath(item.get('path', ''), fallback_name)
            local_path = os.path.join(os.path.dirname(self.index_path), relpath)
            catalog[safe_id] = {
                'id': safe_id,
                'bbox': [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
                'url': item.get('url', ''),
                'path': local_path,
                'secuencial': secuencial,
                'cod_serie': cod_serie,
            }

        self._catalog_cache = catalog
        return catalog

    async def _download_index(self) -> None:
        os.makedirs(os.path.dirname(self.index_path), exist_ok=True)
        timeout = aiohttp.ClientTimeout(total=SPAIN_TILE_DOWNLOAD_TIMEOUT_S)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            status, data, _req_url, _ct = await request_with_retry(
                session,
                "GET",
                self.index_url,
                max_attempts=4,
                transient_statuses={408, 425, 429, 500, 502, 503, 504},
                retry_body_keywords=("429", "rate", "too many", "quota"),
                verbose=self.verbose,
                log_prefix=f"{self.dataset_code}/index",
            )
            if status != 200:
                raise ElevationError(
                    f"{self.dataset_code}: index download failed (HTTP {status}) "
                    f"{body_snippet(data, 180)}"
                )
            if len(data) > SPAIN_TILE_MAX_BYTES:
                raise ElevationError(f'{self.dataset_code}: index file too large')
            tmp_path = self.index_path + '.part'
            with open(tmp_path, 'wb') as f:
                f.write(data)
            os.replace(tmp_path, self.index_path)

    def _pick_discovery_points(
        self,
        points: List[Tuple[float, float]],
        assignment: List[Optional[str]],
    ) -> List[Tuple[float, float]]:
        unresolved = [points[i] for i, tile_id in enumerate(assignment) if tile_id is None]
        if not unresolved:
            return []

        if not SPAIN_CNIG_MAX_DISCOVERY_POINTS or SPAIN_CNIG_MAX_DISCOVERY_POINTS < 1:
            return unresolved[:1]

        step = max(1, len(unresolved) // SPAIN_CNIG_MAX_DISCOVERY_POINTS)
        grid = max(0.0001, SPAIN_CNIG_DISCOVERY_GRID_DEG)
        seen_cells = set()
        selected: List[Tuple[float, float]] = []

        for i in range(0, len(unresolved), step):
            lat, lon = unresolved[i]
            cell = (round(lat / grid), round(lon / grid))
            if cell in seen_cells:
                continue
            seen_cells.add(cell)
            selected.append((lat, lon))
            if len(selected) >= SPAIN_CNIG_MAX_DISCOVERY_POINTS:
                break

        first = unresolved[0]
        last = unresolved[-1]
        if first not in selected:
            selected.insert(0, first)
        if last not in selected and len(selected) < SPAIN_CNIG_MAX_DISCOVERY_POINTS:
            selected.append(last)
        return selected

    async def _cnig_search_tile_ids_for_point(
        self,
        session: aiohttp.ClientSession,
        lat: float,
        lon: float,
    ) -> Set[str]:
        point_geojson = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                }
            ],
        }
        form = {
            "codSerie": self._cnig_serie,
            "coordenadas": json.dumps(point_geojson, separators=(",", ":")),
        }
        try:
            status, body, _req_url, _ct = await request_with_retry(
                session,
                "POST",
                f"{SPAIN_CNIG_BASE_URL}/archivosSerie",
                data=form,
                max_attempts=4,
                transient_statuses={408, 425, 429, 500, 502, 503, 504},
                retry_body_keywords=("429", "rate", "too many", "quota"),
                verbose=self.verbose,
                log_prefix=f"{self.dataset_code}/cnig-search",
            )
            if status != 200:
                return set()
            html = body.decode("utf-8", errors="replace")
        except Exception:
            return set()
        return set(_CNIG_SEC_RE.findall(html))

    async def _cnig_fetch_tile_meta(
        self,
        session: aiohttp.ClientSession,
        secuencial: str,
    ) -> Optional[dict]:
        try:
            status, body, _req_url, _ct = await request_with_retry(
                session,
                "POST",
                f"{SPAIN_CNIG_BASE_URL}/localizarCoordsSec",
                data={"secuencial": secuencial},
                max_attempts=4,
                transient_statuses={408, 425, 429, 500, 502, 503, 504},
                retry_body_keywords=("429", "rate", "too many", "quota"),
                verbose=self.verbose,
                log_prefix=f"{self.dataset_code}/cnig-meta",
            )
            if status != 200:
                return None
            payload = json.loads(body.decode("utf-8", errors="replace"))
        except Exception:
            return None

        bbox = _bbox_from_coords_json(payload.get("coordsJson", ""))
        if bbox is None:
            return None

        safe_id = _safe_name(f"{self._cnig_serie}_{secuencial}")
        rel_path = f"{self._cnig_serie.lower()}/{safe_id}.tif"
        return {
            "id": safe_id,
            "bbox": bbox,
            "url": "",
            "path": os.path.join(os.path.dirname(self.index_path), rel_path),
            "secuencial": str(secuencial),
            "cod_serie": self._cnig_serie,
        }

    async def _discover_cnig_tiles(
        self,
        points: List[Tuple[float, float]],
        assignment: List[Optional[str]],
        catalog: Dict[str, dict],
    ) -> int:
        if not self._cnig_enabled:
            return 0

        discovery_points = self._pick_discovery_points(points, assignment)
        if not discovery_points:
            return 0

        known_sec = {
            str(item.get("secuencial"))
            for item in catalog.values()
            if item.get("secuencial")
        }
        discovered_sec: Set[str] = set()

        timeout = aiohttp.ClientTimeout(total=SPAIN_TILE_DOWNLOAD_TIMEOUT_S)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            for lat, lon in discovery_points:
                sec_ids = await self._cnig_search_tile_ids_for_point(session, lat, lon)
                for sec in sec_ids:
                    if sec and sec not in known_sec:
                        discovered_sec.add(sec)

            added = 0
            for sec in sorted(discovered_sec):
                tile = await self._cnig_fetch_tile_meta(session, sec)
                if tile is None:
                    continue
                catalog[tile["id"]] = tile
                known_sec.add(sec)
                added += 1

        if added:
            self._persist_catalog(catalog)
        return added

    def _persist_catalog(self, catalog: Dict[str, dict]) -> None:
        payload = {"tiles": []}
        base_dir = os.path.dirname(self.index_path)
        for tile_id in sorted(catalog.keys()):
            tile = catalog[tile_id]
            rel_path = os.path.relpath(tile["path"], base_dir).replace("\\", "/")
            item = {
                "id": tile["id"],
                "bbox": tile["bbox"],
                "path": rel_path,
            }
            if tile.get("url"):
                item["url"] = tile["url"]
            if tile.get("secuencial"):
                item["secuencial"] = tile["secuencial"]
            if tile.get("cod_serie"):
                item["cod_serie"] = tile["cod_serie"]
            payload["tiles"].append(item)

        os.makedirs(base_dir, exist_ok=True)
        tmp_path = self.index_path + ".part"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=True, separators=(",", ":"))
        os.replace(tmp_path, self.index_path)

    def _assign_points(self, points: List[Tuple[float, float]], catalog: Dict[str, dict]):
        if not catalog:
            return [None] * len(points), set()

        lats = [pt[0] for pt in points]
        lons = [pt[1] for pt in points]
        route_bbox = [min(lons), min(lats), max(lons), max(lats)]

        tiles = []
        for tile in catalog.values():
            xmin, ymin, xmax, ymax = tile['bbox']
            if xmax < route_bbox[0] or xmin > route_bbox[2] or ymax < route_bbox[1] or ymin > route_bbox[3]:
                continue
            tiles.append(tile)

        assignment: List[Optional[str]] = [None] * len(points)
        used = set()
        for i, (lat, lon) in enumerate(points):
            for tile in tiles:
                xmin, ymin, xmax, ymax = tile['bbox']
                if xmin <= lon <= xmax and ymin <= lat <= ymax:
                    assignment[i] = tile['id']
                    used.add(tile['id'])
                    break
        return assignment, used

    async def _ensure_tiles(self, tile_ids: set, catalog: Dict[str, dict]) -> int:
        downloaded = 0
        if not tile_ids:
            return downloaded

        timeout = aiohttp.ClientTimeout(total=SPAIN_TILE_DOWNLOAD_TIMEOUT_S)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            for tile_id in tile_ids:
                tile = catalog[tile_id]
                path = tile['path']
                if os.path.exists(path):
                    continue
                if not SPAIN_TILE_DOWNLOAD_ENABLED:
                    continue

                os.makedirs(os.path.dirname(path), exist_ok=True)
                if tile.get('secuencial') and tile.get('cod_serie'):
                    ok = await self._download_cnig_tile(session, tile)
                    if ok:
                        downloaded += 1
                    continue

                if not tile.get('url'):
                    continue
                try:
                    status, data, _req_url, _ct = await request_with_retry(
                        session,
                        "GET",
                        tile['url'],
                        max_attempts=4,
                        transient_statuses={408, 425, 429, 500, 502, 503, 504},
                        retry_body_keywords=("429", "rate", "too many", "quota"),
                        verbose=self.verbose,
                        log_prefix=f"{self.dataset_code}/tile",
                    )
                    if status != 200:
                        continue
                except Exception:
                    continue
                if len(data) > SPAIN_TILE_MAX_BYTES:
                    continue
                tmp_path = path + '.part'
                with open(tmp_path, 'wb') as f:
                    f.write(data)
                os.replace(tmp_path, path)
                downloaded += 1
        return downloaded

    async def _download_cnig_tile(self, session: aiohttp.ClientSession, tile: dict) -> bool:
        secuencial = str(tile.get('secuencial') or '').strip()
        cod_serie = str(tile.get('cod_serie') or self._cnig_serie).strip().upper()
        if not secuencial or not cod_serie:
            return False

        init_data = {'secuencial': secuencial}
        sec_download = secuencial
        try:
            status, body, _req_url, _ct = await request_with_retry(
                session,
                "POST",
                f'{SPAIN_CNIG_BASE_URL}/initDescargaDir',
                data=init_data,
                max_attempts=4,
                transient_statuses={408, 425, 429, 500, 502, 503, 504},
                retry_body_keywords=("429", "rate", "too many", "quota"),
                verbose=self.verbose,
                log_prefix=f"{self.dataset_code}/cnig-init",
            )
            if status == 200:
                payload = json.loads(body.decode("utf-8", errors="replace"))
                sec_download = str(payload.get('secuencialDescDir') or secuencial)
        except Exception:
            sec_download = secuencial

        form = {
            'secDescDirLA': sec_download,
            'secuencial': sec_download,
            'codSerie': cod_serie,
        }
        try:
            status, data, _req_url, content_type = await request_with_retry(
                session,
                "POST",
                f'{SPAIN_CNIG_BASE_URL}/descargaDir',
                data=form,
                max_attempts=4,
                transient_statuses={408, 425, 429, 500, 502, 503, 504},
                retry_body_keywords=("429", "rate", "too many", "quota"),
                verbose=self.verbose,
                log_prefix=f"{self.dataset_code}/cnig-download",
            )
            if status != 200:
                return False
        except Exception:
            return False

        if len(data) > SPAIN_TILE_MAX_BYTES:
            return False
        if (not content_type.startswith('image/tiff')) and data[:256].lower().startswith(b'<!doctype html'):
            return False

        path = tile['path']
        tmp_path = path + '.part'
        with open(tmp_path, 'wb') as f:
            f.write(data)
        os.replace(tmp_path, path)
        return True

    def _sample_tiles(
        self,
        points: List[Tuple[float, float]],
        assignment: List[Optional[str]],
        used_tiles: set,
        catalog: Dict[str, dict],
    ) -> List[Optional[float]]:
        out: List[Optional[float]] = [None] * len(points)

        idx_by_tile: Dict[str, List[int]] = {}
        for i, tile_id in enumerate(assignment):
            if tile_id is None:
                continue
            idx_by_tile.setdefault(tile_id, []).append(i)

        for tile_id in used_tiles:
            tile = catalog[tile_id]
            path = tile['path']
            if not os.path.exists(path):
                continue
            try:
                with rasterio.open(path) as ds:
                    transformer = None
                    if ds.crs and str(ds.crs).upper() not in ('EPSG:4326', 'OGC:CRS84'):
                        transformer = Transformer.from_crs('EPSG:4326', ds.crs, always_xy=True)
                    ds_nodata = ds.nodata

                    sample_indices = idx_by_tile.get(tile_id, [])
                    coords = []
                    for idx in sample_indices:
                        lat, lon = points[idx]
                        if transformer is None:
                            x, y = lon, lat
                        else:
                            x, y = transformer.transform(lon, lat)
                        coords.append((x, y))

                    for idx, values in zip(sample_indices, ds.sample(coords)):
                        val = float(values[0])
                        if ds_nodata is not None and val == ds_nodata:
                            continue
                        if abs(val) > 1e37:
                            continue
                        if val <= -9999:
                            continue
                        if val != val:  # NaN
                            continue
                        out[idx] = val
            except Exception:
                continue

        return out


class SpainMDT01Provider(_SpainTileProvider):
    def __init__(self):
        super().__init__(
            dataset_code='ES_MDT01_LOCAL',
            resolution_m=0.5,
            enabled=SPAIN_MDT01_ENABLED,
            index_path=SPAIN_MDT01_INDEX_PATH,
            index_url=SPAIN_MDT01_INDEX_URL,
        )


class SpainMDT02Provider(_SpainTileProvider):
    def __init__(self):
        super().__init__(
            dataset_code='ES_MDT02_LOCAL',
            resolution_m=2.0,
            enabled=SPAIN_MDT02_ENABLED,
            index_path=SPAIN_MDT02_INDEX_PATH,
            index_url=SPAIN_MDT02_INDEX_URL,
        )
