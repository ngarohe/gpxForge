#!/usr/bin/env python3
"""Build a tile index JSON from local GeoTIFF files.

Output schema:
{
  "tiles": [
    {"id":"tile_001","bbox":[lon_min,lat_min,lon_max,lat_max],"path":"relative/path.tif","url":"optional"}
  ]
}
"""

import argparse
import json
import os
import re
from pathlib import Path
from typing import Dict, List, Tuple

try:
    import rasterio
    from rasterio.warp import transform_bounds
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"rasterio is required: {exc}")


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def _wgs84_bbox(tif_path: Path) -> Tuple[float, float, float, float]:
    with rasterio.open(tif_path) as ds:
        b = ds.bounds
        if ds.crs is None:
            raise ValueError(f"{tif_path}: missing CRS")
        if str(ds.crs).upper() in ("EPSG:4326", "OGC:CRS84"):
            return float(b.left), float(b.bottom), float(b.right), float(b.top)
        xmin, ymin, xmax, ymax = transform_bounds(ds.crs, "EPSG:4326", b.left, b.bottom, b.right, b.top, densify_pts=16)
        return float(xmin), float(ymin), float(xmax), float(ymax)


def _iter_tifs(input_dir: Path, recursive: bool) -> List[Path]:
    patterns = ("*.tif", "*.tiff", "*.TIF", "*.TIFF")
    out: List[Path] = []
    if recursive:
        for pattern in patterns:
            out.extend(input_dir.rglob(pattern))
    else:
        for pattern in patterns:
            out.extend(input_dir.glob(pattern))
    # De-duplicate while preserving order.
    seen = set()
    unique = []
    for p in out:
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return unique


def main() -> int:
    parser = argparse.ArgumentParser(description="Build GPXForge tile index from local GeoTIFF files")
    parser.add_argument("--input-dir", required=True, help="Directory containing GeoTIFF tiles")
    parser.add_argument("--output", required=True, help="Output index JSON path")
    parser.add_argument("--recursive", action="store_true", help="Scan input directory recursively")
    parser.add_argument(
        "--id-from",
        choices=("stem", "name"),
        default="stem",
        help="Tile id source from filename stem or full name (default: stem)",
    )
    parser.add_argument(
        "--url-template",
        default="",
        help="Optional download URL template, supports {id}, {name}, {stem}",
    )
    parser.add_argument(
        "--path-mode",
        choices=("relative", "absolute"),
        default="relative",
        help="Write tile path relative to output file dir or absolute (default: relative)",
    )
    args = parser.parse_args()

    input_dir = Path(args.input_dir).expanduser().resolve()
    out_path = Path(args.output).expanduser().resolve()
    out_dir = out_path.parent

    if not input_dir.exists():
        raise SystemExit(f"Input dir not found: {input_dir}")

    tifs = _iter_tifs(input_dir, recursive=args.recursive)
    if not tifs:
        raise SystemExit(f"No GeoTIFF files found in: {input_dir}")

    tiles = []
    id_counts: Dict[str, int] = {}

    for tif in tifs:
        try:
            bbox = _wgs84_bbox(tif)
        except Exception as exc:
            print(f"[skip] {tif}: {exc}")
            continue

        stem = tif.stem
        name = tif.name
        base_id = stem if args.id_from == "stem" else name
        safe_id = _safe_name(base_id)
        n = id_counts.get(safe_id, 0)
        id_counts[safe_id] = n + 1
        if n > 0:
            safe_id = f"{safe_id}_{n}"

        if args.path_mode == "absolute":
            tile_path = str(tif)
        else:
            tile_path = os.path.relpath(str(tif), str(out_dir)).replace("\\", "/")

        item = {
            "id": safe_id,
            "bbox": [bbox[0], bbox[1], bbox[2], bbox[3]],
            "path": tile_path,
        }
        if args.url_template:
            item["url"] = (
                args.url_template
                .replace("{id}", safe_id)
                .replace("{name}", name)
                .replace("{stem}", stem)
            )
        tiles.append(item)

    if not tiles:
        raise SystemExit("No valid tiles found (all skipped).")

    payload = {"tiles": tiles}
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=True, separators=(",", ":"))

    print(f"Wrote index: {out_path}")
    print(f"Tiles indexed: {len(tiles)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
