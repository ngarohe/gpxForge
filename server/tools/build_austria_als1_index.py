#!/usr/bin/env python3
"""Build Austria ALS1 (DGM1) tile index.

Default output matches server/config.py:
  server/data/austria_tiles/als1/index.json
"""

import argparse
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Austria ALS1 (DGM1) index for GPXForge")
    parser.add_argument("--input-dir", default="", help="Directory containing Austria ALS1 GeoTIFFs")
    parser.add_argument("--coverage-zip", default="", help="BEV coverage ZIP with SHP footprints")
    parser.add_argument("--shp-name", default="", help="Optional SHP filename/stem inside coverage ZIP")
    parser.add_argument("--id-field", default="", help="Optional feature field used as tile id")
    parser.add_argument("--url-field", default="", help="Optional feature field used as tile URL")
    parser.add_argument("--source-crs", default="EPSG:3035", help="Source CRS of coverage file (default: EPSG:3035)")
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parents[1] / "data" / "austria_tiles" / "als1" / "index.json"),
        help="Output index path (default: server/data/austria_tiles/als1/index.json)",
    )
    parser.add_argument("--recursive", action="store_true", help="Scan recursively")
    parser.add_argument("--url-template", default="", help="Optional URL template with {id}/{name}/{stem}")
    parser.add_argument("--tile-path-template", default="{id}.tif", help="Fallback tile path template, supports {id}")
    parser.add_argument("--path-mode", choices=("relative", "absolute"), default="relative")
    args = parser.parse_args()

    this_dir = Path(__file__).resolve().parent
    if not args.input_dir and not args.coverage_zip:
        raise SystemExit("Provide --input-dir or --coverage-zip")

    if args.coverage_zip:
        builder = this_dir / "build_tile_index_from_shp_zip.py"
        cmd = [
            sys.executable,
            str(builder),
            "--coverage-zip", str(Path(args.coverage_zip).resolve()),
            "--output", str(Path(args.output).resolve()),
            "--path-mode", args.path_mode,
            "--source-crs", args.source_crs,
            "--tile-path-template", args.tile_path_template,
        ]
        if args.shp_name:
            cmd.extend(["--shp-name", args.shp_name])
        if args.input_dir:
            cmd.extend(["--tile-dir", str(Path(args.input_dir).resolve())])
        if args.recursive:
            cmd.append("--recursive")
        if args.id_field:
            cmd.extend(["--id-field", args.id_field])
        if args.url_field:
            cmd.extend(["--url-field", args.url_field])
        if args.url_template:
            cmd.extend(["--url-template", args.url_template])
    else:
        builder = this_dir / "build_tile_index.py"
        cmd = [
            sys.executable,
            str(builder),
            "--input-dir", str(Path(args.input_dir).resolve()),
            "--output", str(Path(args.output).resolve()),
            "--path-mode", args.path_mode,
        ]
        if args.recursive:
            cmd.append("--recursive")
        if args.url_template:
            cmd.extend(["--url-template", args.url_template])

    print("Running:", " ".join(cmd))
    result = subprocess.run(cmd)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
