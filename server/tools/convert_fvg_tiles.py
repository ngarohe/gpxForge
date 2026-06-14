"""
Convert FVG LIDAR tiles to GeoTIFF and build index.json.

Usage:
    python convert_fvg_tiles.py --src ./italy/fvg_raw --dst ./italy/fvg_tif

The .asc files use EPSG:6708 (RDN2008/TM33). 1m resolution, ~900×840m per tile.
"""
import argparse
import glob
import json
import os
import sys
import zipfile

try:
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
    from pyproj import Transformer
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Install: pip install numpy rasterio pyproj")
    sys.exit(1)


TILE_CRS = "EPSG:6708"
WGS84 = "EPSG:4326"


def parse_asc_from_bytes(raw_bytes):
    """Parse ESRI ASCII grid from raw bytes."""
    import io

    text = raw_bytes.decode('utf-8', errors='replace')
    lines = text.split('\n')

    header = {}
    data_start = 0
    for i, line in enumerate(lines[:10]):
        parts = line.strip().split()
        if len(parts) >= 2 and parts[0].lower() in (
            'ncols', 'nrows', 'xllcenter', 'yllcenter',
            'xllcorner', 'yllcorner', 'cellsize', 'nodata_value',
        ):
            key = parts[0].lower()
            val = float(parts[1])
            if key in ('ncols', 'nrows'):
                val = int(val)
            header[key] = val
            data_start = i + 1
        else:
            break

    ncols = header['ncols']
    nrows = header['nrows']

    buf = io.StringIO('\n'.join(lines[data_start:]))
    data = np.loadtxt(buf, dtype=np.float32)
    if data.shape != (nrows, ncols):
        if data.size == nrows * ncols:
            data = data.reshape(nrows, ncols)
        else:
            return header, None

    return header, data


def asc_to_geotiff_from_bytes(raw_bytes, tif_path, crs=TILE_CRS):
    """Convert ESRI ASCII grid bytes to GeoTIFF."""
    header, data = parse_asc_from_bytes(raw_bytes)
    if data is None:
        return None

    ncols = header['ncols']
    nrows = header['nrows']
    cellsize = header['cellsize']
    nodata = header.get('nodata_value', -9999.0)

    if 'xllcenter' in header:
        xll = header['xllcenter'] - cellsize / 2
        yll = header['yllcenter'] - cellsize / 2
    else:
        xll = header['xllcorner']
        yll = header['yllcorner']

    xmin = xll
    ymin = yll
    xmax = xll + ncols * cellsize
    ymax = yll + nrows * cellsize

    valid_mask = data != nodata
    if not np.any(valid_mask):
        return None

    data[~valid_mask] = np.nan

    transform = from_bounds(xmin, ymin, xmax, ymax, ncols, nrows)

    profile = {
        'driver': 'GTiff',
        'dtype': 'float32',
        'width': ncols,
        'height': nrows,
        'count': 1,
        'crs': crs,
        'transform': transform,
        'nodata': np.nan,
        'compress': 'deflate',
        'predictor': 2,
        'tiled': True,
        'blockxsize': 256,
        'blockysize': 256,
    }

    with rasterio.open(tif_path, 'w', **profile) as dst:
        dst.write(data, 1)

    return {
        'native_bounds': (xmin, ymin, xmax, ymax),
        'ncols': ncols,
        'nrows': nrows,
        'cellsize': cellsize,
    }


def native_to_wgs84_bbox(xmin, ymin, xmax, ymax, src_crs=TILE_CRS):
    """Convert native CRS bounds to WGS84 bbox."""
    t = Transformer.from_crs(src_crs, WGS84, always_xy=True)
    corners = [
        (xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax),
    ]
    lons, lats = [], []
    for x, y in corners:
        lon, lat = t.transform(x, y)
        lons.append(lon)
        lats.append(lat)
    return [
        round(min(lons), 6),
        round(min(lats), 6),
        round(max(lons), 6),
        round(max(lats), 6),
    ]


def main():
    parser = argparse.ArgumentParser(description="Convert FVG .asc tiles to GeoTIFF + index.json")
    parser.add_argument("--src", default="./italy/fvg_raw", help="Directory with downloaded zip files")
    parser.add_argument("--dst", default="./italy/fvg_tif", help="Output directory for .tif + index.json")
    parser.add_argument("--skip-existing", action="store_true", default=True)
    parser.add_argument("--no-skip", action="store_true")
    args = parser.parse_args()

    if args.no_skip:
        args.skip_existing = False

    os.makedirs(args.dst, exist_ok=True)

    # FVG zips are named DTM01_PCR_{CODE}_RDN2008_TM33.zip
    zips = sorted(glob.glob(os.path.join(args.src, "DTM01_PCR_*_RDN2008_TM33.zip")))
    if not zips:
        zips = sorted(glob.glob(os.path.join(args.src, "*.zip")))
    print(f"Found {len(zips)} zip files in {args.src}")

    if not zips:
        print("No zip files found. Run download_fvg.py first.")
        sys.exit(1)

    index_path = os.path.join(args.dst, "index.json")
    existing_tiles = {}
    if os.path.exists(index_path):
        with open(index_path) as f:
            idx_data = json.load(f)
        for t in idx_data.get("tiles", []):
            existing_tiles[t["id"]] = t
        print(f"Existing index has {len(existing_tiles)} tiles")

    converted = 0
    skipped = 0
    failed = 0
    nodata_skipped = 0
    new_tiles = dict(existing_tiles)

    for i, zpath in enumerate(zips):
        zname = os.path.basename(zpath)
        # Extract tile ID from filename: DTM01_PCR_031033_RDN2008_TM33.zip → 031033
        tile_id = zname.replace("DTM01_PCR_", "").replace("_RDN2008_TM33.zip", "").replace(".zip", "")
        tif_name = f"{tile_id}.tif"
        tif_path = os.path.join(args.dst, tif_name)

        if args.skip_existing and os.path.exists(tif_path) and tile_id in existing_tiles:
            skipped += 1
            continue

        try:
            with zipfile.ZipFile(zpath, 'r') as zf:
                asc_names = [n for n in zf.namelist() if n.lower().endswith('.asc')]
                if not asc_names:
                    failed += 1
                    continue
                raw_bytes = zf.read(asc_names[0])
        except (zipfile.BadZipFile, Exception):
            print(f"  [{i+1}/{len(zips)}] FAIL {zname} -- bad zip")
            failed += 1
            continue

        try:
            info = asc_to_geotiff_from_bytes(raw_bytes, tif_path)
            if info is None:
                nodata_skipped += 1
                continue

            bbox = native_to_wgs84_bbox(*info['native_bounds'])
            new_tiles[tile_id] = {
                "id": tile_id,
                "bbox": bbox,
                "path": tif_name,
            }
            converted += 1

            if converted % 100 == 0 or converted <= 3:
                sz = os.path.getsize(tif_path) // 1024
                print(f"  [{i+1}/{len(zips)}] OK {tile_id} {sz}KB bbox={bbox}")
        except Exception as e:
            print(f"  [{i+1}/{len(zips)}] FAIL {tile_id}: {e}")
            failed += 1

    tile_list = sorted(new_tiles.values(), key=lambda t: t["id"])
    with open(index_path, 'w') as f:
        json.dump({"tiles": tile_list}, f, indent=2)

    print(f"\nDone! Converted: {converted}, Skipped: {skipped}, Nodata: {nodata_skipped}, Failed: {failed}")
    print(f"Index: {index_path} — {len(tile_list)} total tiles")

    if tile_list:
        all_lons = [t["bbox"][0] for t in tile_list] + [t["bbox"][2] for t in tile_list]
        all_lats = [t["bbox"][1] for t in tile_list] + [t["bbox"][3] for t in tile_list]
        print(f"Coverage: lon [{min(all_lons):.3f}, {max(all_lons):.3f}], lat [{min(all_lats):.3f}, {max(all_lats):.3f}]")


if __name__ == "__main__":
    main()
