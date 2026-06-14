import asyncio
import contextlib
import io
import json
import os
import re
import zipfile
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


def _safe_name(value: str) -> str:
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', value or '')


def _safe_relpath(raw_path: str, fallback: str) -> str:
    p = Path(raw_path or '').as_posix().strip().lstrip('/')
    if not p:
        return fallback
    if '..' in p.split('/'):
        return fallback
    return p


class CatalogTileProvider(ElevationProvider):
    """Generic local/remote COG tile provider using a JSON index catalog.

    Catalog format (JSON):
      {
        "tiles": [
          {"id":"tile_001", "bbox":[lon_min,lat_min,lon_max,lat_max], "url":"...", "path":"optional/path.tif"}
        ]
      }
    Or directly a list of tile objects.
    """

    is_local = True

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
        prefer_remote_sampling: bool = False,
    ):
        self._country_code = country_code
        self.dataset_code = dataset_code
        self._resolution = resolution_m
        self.enabled = enabled
        self.index_path = index_path
        self.index_url = index_url
        self.download_enabled = download_enabled
        self.download_timeout_s = download_timeout_s
        self.tile_max_bytes = tile_max_bytes
        self.prefer_remote_sampling = bool(prefer_remote_sampling)
        self._catalog_cache: Optional[Dict[str, dict]] = None

    @property
    def country_code(self) -> str:
        return self._country_code

    @property
    def resolution(self) -> float:
        return self._resolution

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        if not self.enabled:
            return [None] * len(points)
        if not RASTERIO_AVAILABLE:
            raise ElevationError(f'{self.dataset_code}: rasterio is required for tile sampling')

        catalog = await self._ensure_catalog()
        if not catalog:
            return [None] * len(points)

        assignment, used_tiles = self._assign_points(points, catalog)
        if not used_tiles:
            return [None] * len(points)

        downloaded = await self._ensure_tiles(used_tiles, catalog)
        elevations = await asyncio.get_event_loop().run_in_executor(
            None, self._sample_tiles, points, assignment, used_tiles, catalog
        )

        if self.verbose:
            hit = sum(1 for e in elevations if e is not None)
            seam_retry_resolved = getattr(self, "_last_seam_retry_resolved", 0)
            self._verbose_log = {
                'dataset': self.dataset_code,
                'catalog_tiles': len(catalog),
                'used_tiles': len(used_tiles),
                'downloaded': downloaded,
                'resolved': hit,
                'seam_retry_resolved': seam_retry_resolved,
                'index_source': 'local' if os.path.exists(self.index_path) else 'remote',
            }

        return elevations

    async def _ensure_catalog(self) -> Dict[str, dict]:
        if self._catalog_cache is not None:
            return self._catalog_cache

        if not os.path.exists(self.index_path):
            if self.index_url and self.download_enabled:
                await self._download_index()
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
            fallback_name = f'{safe_id}.tif'
            relpath = _safe_relpath(item.get('path', ''), fallback_name)
            local_path = os.path.join(os.path.dirname(self.index_path), relpath)
            catalog[safe_id] = {
                'id': safe_id,
                'bbox': [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
                'url': item.get('url', ''),
                'path': local_path,
            }

        self._catalog_cache = catalog
        return catalog

    async def _download_index(self) -> None:
        os.makedirs(os.path.dirname(self.index_path), exist_ok=True)
        timeout = aiohttp.ClientTimeout(total=self.download_timeout_s)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
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
            if len(data) > self.tile_max_bytes:
                raise ElevationError(f'{self.dataset_code}: index file too large')
            tmp_path = self.index_path + '.part'
            with open(tmp_path, 'wb') as f:
                f.write(data)
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

    async def _ensure_tiles(self, tile_ids: Set[str], catalog: Dict[str, dict]) -> int:
        downloaded = 0
        if not tile_ids:
            return downloaded

        timeout = aiohttp.ClientTimeout(total=self.download_timeout_s)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            for tile_id in sorted(tile_ids):
                tile = catalog[tile_id]
                path = tile['path']
                if os.path.exists(path):
                    continue
                if not self.download_enabled:
                    continue

                url = tile.get('url')
                if not url:
                    continue
                if self.prefer_remote_sampling and str(url).lower().endswith(('.tif', '.tiff')):
                    # Avoid downloading multi-GB tiles when remote range-based sampling is enabled.
                    continue
                os.makedirs(os.path.dirname(path), exist_ok=True)
                try:
                    status, data, _req_url, _ct = await request_with_retry(
                        session,
                        "GET",
                        url,
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

                if len(data) > self.tile_max_bytes:
                    continue
                if data[:256].lower().startswith(b'<!doctype html'):
                    continue

                if self._write_tile_payload(path, data):
                    downloaded += 1
        return downloaded

    def _write_tile_payload(self, dst_path: str, payload: bytes) -> bool:
        """Persist payload as a GeoTIFF.

        Accepts direct TIFF bytes or ZIP payloads that contain one TIFF file.
        """
        os.makedirs(os.path.dirname(dst_path), exist_ok=True)

        # ZIP magic: PK\x03\x04
        if payload.startswith(b'PK\x03\x04'):
            try:
                with zipfile.ZipFile(io.BytesIO(payload)) as zf:
                    tif_names = [
                        n for n in zf.namelist()
                        if n.lower().endswith(('.tif', '.tiff'))
                    ]
                    if not tif_names:
                        return False
                    # Prefer shortest path entry (usually root tile file).
                    tif_name = sorted(tif_names, key=len)[0]
                    tif_bytes = zf.read(tif_name)
            except Exception:
                return False
            tmp_path = dst_path + '.part'
            with open(tmp_path, 'wb') as f:
                f.write(tif_bytes)
            os.replace(tmp_path, dst_path)
            return True

        tmp_path = dst_path + '.part'
        with open(tmp_path, 'wb') as f:
            f.write(payload)
        os.replace(tmp_path, dst_path)
        return True

    def _sample_tiles(
        self,
        points: List[Tuple[float, float]],
        assignment: List[Optional[str]],
        used_tiles: Set[str],
        catalog: Dict[str, dict],
    ) -> List[Optional[float]]:
        out: List[Optional[float]] = [None] * len(points)
        seam_retry_resolved = 0

        idx_by_tile: Dict[str, List[int]] = {}
        for i, tile_id in enumerate(assignment):
            if tile_id is None:
                continue
            idx_by_tile.setdefault(tile_id, []).append(i)

        def _sample_tile_indices(tile_id: str, indices: List[int]) -> Set[int]:
            resolved_here: Set[int] = set()
            tile = catalog.get(tile_id)
            if not tile or not indices:
                return resolved_here
            indices = [idx for idx in indices if out[idx] is None]
            if not indices:
                return resolved_here
            path = tile['path']
            src = path
            if not os.path.exists(path):
                remote_url = str(tile.get('url') or '').strip()
                if (
                    self.prefer_remote_sampling
                    and remote_url.lower().startswith(('http://', 'https://'))
                    and remote_url.lower().endswith(('.tif', '.tiff'))
                ):
                    src = remote_url
                else:
                    return resolved_here
            try:
                env = contextlib.nullcontext()
                if isinstance(src, str) and src.lower().startswith(('http://', 'https://')):
                    env = rasterio.Env(
                        GDAL_DISABLE_READDIR_ON_OPEN='YES',
                        CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif,.tiff',
                        GDAL_HTTP_TIMEOUT=str(max(10, int(self.download_timeout_s))),
                    )
                with env:
                    with rasterio.open(src) as ds:
                        transformer = None
                        if ds.crs and str(ds.crs).upper() not in ('EPSG:4326', 'OGC:CRS84'):
                            transformer = Transformer.from_crs('EPSG:4326', ds.crs, always_xy=True)
                        ds_nodata = ds.nodata

                        coords = []
                        for idx in indices:
                            lat, lon = points[idx]
                            if transformer is None:
                                x, y = lon, lat
                            else:
                                x, y = transformer.transform(lon, lat)
                            coords.append((x, y))

                        for idx, values in zip(indices, ds.sample(coords)):
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
                            resolved_here.add(idx)
            except Exception:
                return resolved_here
            return resolved_here

        # Primary pass: assigned tile only (fast path).
        for tile_id in used_tiles:
            sample_indices = idx_by_tile.get(tile_id, [])
            _sample_tile_indices(tile_id, sample_indices)

        # Seam pass: for unresolved points that were assigned to a tile, try other overlapping tiles.
        unresolved = [i for i, val in enumerate(out) if val is None and assignment[i] is not None]
        if unresolved:
            lats = [pt[0] for pt in points]
            lons = [pt[1] for pt in points]
            route_bbox = [min(lons), min(lats), max(lons), max(lats)]

            route_tiles: List[dict] = []
            for tile in catalog.values():
                xmin, ymin, xmax, ymax = tile['bbox']
                if xmax < route_bbox[0] or xmin > route_bbox[2] or ymax < route_bbox[1] or ymin > route_bbox[3]:
                    continue
                route_tiles.append(tile)

            # Smaller bbox area first gives higher confidence where datasets overlap at different extents.
            route_tiles.sort(key=lambda t: abs((t['bbox'][2] - t['bbox'][0]) * (t['bbox'][3] - t['bbox'][1])))

            alt_candidates: Dict[int, List[str]] = {}
            for idx in unresolved:
                lat, lon = points[idx]
                assigned = assignment[idx]
                candidates: List[str] = []
                for tile in route_tiles:
                    tid = tile['id']
                    if tid == assigned:
                        continue
                    xmin, ymin, xmax, ymax = tile['bbox']
                    if xmin <= lon <= xmax and ymin <= lat <= ymax:
                        candidates.append(tid)
                if candidates:
                    alt_candidates[idx] = candidates

            if alt_candidates:
                pending: Dict[int, List[str]] = {idx: list(cands) for idx, cands in alt_candidates.items()}
                while pending:
                    by_tile: Dict[str, List[int]] = {}
                    for idx, cands in pending.items():
                        if cands:
                            by_tile.setdefault(cands[0], []).append(idx)
                    if not by_tile:
                        break

                    progress = 0
                    for tile_id, idxs in by_tile.items():
                        resolved_now = _sample_tile_indices(tile_id, idxs)
                        progress += len(resolved_now)
                        for idx in resolved_now:
                            seam_retry_resolved += 1

                    next_pending: Dict[int, List[str]] = {}
                    for idx, cands in pending.items():
                        if out[idx] is not None:
                            continue
                        remainder = cands[1:] if cands else []
                        if remainder:
                            next_pending[idx] = remainder
                    pending = next_pending

                    if progress == 0 and not pending:
                        break

        self._last_seam_retry_resolved = seam_retry_resolved

        return out
