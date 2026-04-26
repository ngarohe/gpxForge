#!/usr/bin/env python3
"""Build a tile index JSON from a SHP ZIP coverage file.

Supports optional matching against local GeoTIFF files and optional URL template.
Output schema matches GPXForge catalog tile providers.
"""

import argparse
import json
import os
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from pyproj import CRS, Transformer

try:
    import shapefile  # pyshp
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"pyshp is required (pip install pyshp): {exc}")


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value or "").strip())


def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _choose_field(fields: List[str], preferred: Optional[str], candidates: List[str]) -> Optional[str]:
    if preferred:
        for f in fields:
            if f.lower() == preferred.lower():
                return f
        return None
    lower = {f.lower(): f for f in fields}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    # Loose match for fields containing keywords
    for f in fields:
        fl = f.lower()
        if any(c.lower() in fl for c in candidates):
            return f
    return None


def _extract_shp_zip(zip_path: Path, shp_name: str = "") -> Tuple[Path, Optional[Path]]:
    tmp = Path(tempfile.mkdtemp(prefix="gpxforge_shp_"))
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(tmp)

    shp_files = sorted(tmp.rglob("*.shp"))
    if not shp_files:
        raise SystemExit(f"No .shp found in ZIP: {zip_path}")

    shp_path: Optional[Path] = None
    if shp_name:
        for p in shp_files:
            if p.name.lower() == shp_name.lower() or p.stem.lower() == shp_name.lower():
                shp_path = p
                break
        if shp_path is None:
            raise SystemExit(f"Requested shapefile not found in ZIP: {shp_name}")
    else:
        shp_path = shp_files[0]

    prj_path = shp_path.with_suffix(".prj")
    return shp_path, prj_path if prj_path.exists() else None


def _load_crs(prj_path: Optional[Path], source_crs_override: str) -> CRS:
    if source_crs_override:
        return CRS.from_user_input(source_crs_override)
    if prj_path and prj_path.exists():
        wkt = prj_path.read_text(encoding="utf-8", errors="ignore")
        return CRS.from_wkt(wkt)
    # Safe fallback if no PRJ available.
    return CRS.from_epsg(4326)


def _iter_tifs(input_dir: Path, recursive: bool) -> List[Path]:
    patterns = ("*.tif", "*.tiff", "*.TIF", "*.TIFF")
    out: List[Path] = []
    if recursive:
        for pattern in patterns:
            out.extend(input_dir.rglob(pattern))
    else:
        for pattern in patterns:
            out.extend(input_dir.glob(pattern))
    seen = set()
    unique: List[Path] = []
    for p in out:
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return unique


def _build_tile_lookup(tile_dir: Path, recursive: bool) -> Dict[str, List[Path]]:
    lookup: Dict[str, List[Path]] = {}
    for tif in _iter_tifs(tile_dir, recursive=recursive):
        key = _norm(tif.stem)
        lookup.setdefault(key, []).append(tif)
    return lookup


def _match_local_tile(tile_id: str, lookup: Dict[str, List[Path]]) -> Optional[Path]:
    key = _norm(tile_id)
    exact = lookup.get(key, [])
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        return exact[0]

    # Loose fallback: containment match when exact key is absent.
    candidates: List[Path] = []
    for k, paths in lookup.items():
        if key and (key in k or k in key):
            candidates.extend(paths)
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        # Keep deterministic behavior.
        return sorted(candidates, key=lambda p: str(p))[0]
    return None


def _to_wgs84_bbox(bbox: List[float], transformer: Optional[Transformer]) -> List[float]:
    xmin, ymin, xmax, ymax = bbox
    if transformer is None:
        return [float(xmin), float(ymin), float(xmax), float(ymax)]
    # Transform the 4 corners and expand bbox in WGS84.
    pts = [
        transformer.transform(xmin, ymin),
        transformer.transform(xmin, ymax),
        transformer.transform(xmax, ymin),
        transformer.transform(xmax, ymax),
    ]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def main() -> int:
    parser = argparse.ArgumentParser(description="Build GPXForge tile index from SHP ZIP coverage")
    parser.add_argument("--coverage-zip", required=True, help="Path to ZIP containing SHP coverage")
    parser.add_argument("--output", required=True, help="Output index JSON path")
    parser.add_argument("--shp-name", default="", help="Optional SHP filename/stem inside ZIP")
    parser.add_argument("--source-crs", default="", help="Optional CRS override, e.g. EPSG:3035")
    parser.add_argument("--id-field", default="", help="Optional feature field used for tile id")
    parser.add_argument("--url-field", default="", help="Optional feature field used for tile URL")
    parser.add_argument("--tile-dir", default="", help="Optional local tile folder for path matching")
    parser.add_argument("--recursive", action="store_true", help="Recursive tile-dir scan")
    parser.add_argument(
        "--tile-path-template",
        default="{id}.tif",
        help="Fallback tile path template when no local match, supports {id}",
    )
    parser.add_argument(
        "--url-template",
        default="",
        help="Optional URL template when URL field missing, supports {id}",
    )
    parser.add_argument(
        "--path-mode",
        choices=("relative", "absolute"),
        default="relative",
        help="Write tile path relative to output directory or absolute",
    )
    args = parser.parse_args()

    zip_path = Path(args.coverage_zip).expanduser().resolve()
    out_path = Path(args.output).expanduser().resolve()
    out_dir = out_path.parent
    if not zip_path.exists():
        raise SystemExit(f"Coverage ZIP not found: {zip_path}")

    shp_path, prj_path = _extract_shp_zip(zip_path, shp_name=args.shp_name)
    src_crs = _load_crs(prj_path, args.source_crs)
    transformer = None if src_crs.to_epsg() == 4326 else Transformer.from_crs(src_crs, CRS.from_epsg(4326), always_xy=True)

    sf = shapefile.Reader(str(shp_path))
    fields = [f[0] for f in sf.fields[1:]]
    id_field = _choose_field(
        fields,
        args.id_field,
        ["id", "tile_id", "name", "kachel", "kachelname", "kachel_nr", "sheet", "blatt", "secuencial"],
    )
    if not id_field:
        raise SystemExit(f"No id field found in {shp_path.name}. Fields: {fields}")
    url_field = _choose_field(fields, args.url_field, ["url", "download", "link", "href"])

    tile_lookup: Dict[str, List[Path]] = {}
    tile_dir = Path(args.tile_dir).expanduser().resolve() if args.tile_dir else None
    if tile_dir:
        if not tile_dir.exists():
            raise SystemExit(f"tile-dir not found: {tile_dir}")
        tile_lookup = _build_tile_lookup(tile_dir, recursive=args.recursive)

    seen_ids: Dict[str, int] = {}
    tiles: List[dict] = []
    recs = sf.records()
    shapes = sf.shapes()
    for rec, shp in zip(recs, shapes):
        row = rec.as_dict() if hasattr(rec, "as_dict") else {fields[i]: rec[i] for i in range(len(fields))}
        raw_id = row.get(id_field)
        if raw_id is None:
            continue
        safe_id = _safe_name(str(raw_id))
        if not safe_id:
            continue
        n = seen_ids.get(safe_id, 0)
        seen_ids[safe_id] = n + 1
        if n > 0:
            safe_id = f"{safe_id}_{n}"

        if not getattr(shp, "bbox", None):
            continue
        bbox_wgs84 = _to_wgs84_bbox([float(v) for v in shp.bbox], transformer)

        local_match: Optional[Path] = _match_local_tile(str(raw_id), tile_lookup) if tile_lookup else None
        if local_match is not None:
            if args.path_mode == "absolute":
                tile_path = str(local_match)
            else:
                tile_path = os.path.relpath(str(local_match), str(out_dir)).replace("\\", "/")
        else:
            tile_path = args.tile_path_template.replace("{id}", safe_id)

        url = ""
        if url_field and row.get(url_field):
            url = str(row[url_field]).strip()
        elif args.url_template:
            url = args.url_template.replace("{id}", safe_id)

        item = {
            "id": safe_id,
            "bbox": bbox_wgs84,
            "path": tile_path,
        }
        if url:
            item["url"] = url
        tiles.append(item)

    if not tiles:
        raise SystemExit("No tiles parsed from coverage file.")

    payload = {"tiles": tiles}
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=True, separators=(",", ":"))

    print(f"Wrote index: {out_path}")
    print(f"Tiles indexed: {len(tiles)}")
    print(f"ID field: {id_field}")
    if url_field:
        print(f"URL field: {url_field}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
