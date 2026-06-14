"""
Convert Veneto LIDAR .asc.zip tiles to GeoTIFF and build index.json.

Usage:
    python convert_veneto_tiles.py --src ./italy/veneto_raw --dst ./italy/tif

Steps:
  1. Unzip all .asc.zip files
  2. Convert .asc (Gauss-Boaga / RDN2008 Zone 12) to GeoTIFF with CRS tag
  3. Compute WGS84 bounding boxes
  4. Build/merge index.json for the CatalogTileProvider

The .asc files use RDN2008 / Zone 12 (EPSG:6876) — the xllcenter/yllcenter
values are in that CRS. The GeoTIFF is kept in native CRS; rasterio handles
the WGS84 transform at query time.
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


# Veneto tiles use RDN2008 / Zone 12 N-E (EPSG:6876)
# xllcenter values around 3,026,000 confirm this (Gauss-Boaga zone 2 / RDN2008 zone 12)
TILE_CRS = "EPSG:6876"
WGS84 = "EPSG:4326"


def parse_asc_from_bytes(raw_bytes):
    """Parse ESRI ASCII grid from raw bytes. Returns (header_dict, numpy_array)."""
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
    nodata = header.get('nodata_value', -9999.0)

    # Parse elevation data from remaining lines
    buf = io.StringIO('\n'.join(lines[data_start:]))
    data = np.loadtxt(buf, dtype=np.float32)
    if data.shape != (nrows, ncols):
        # Try reshaping flat array
        if data.size == nrows * ncols:
            data = data.reshape(nrows, ncols)
        else:
            return header, None

    return header, data


def asc_to_geotiff_from_bytes(raw_bytes, tif_path, crs=TILE_CRS):
    """Convert ESRI ASCII grid bytes to GeoTIFF with CRS tag."""
    header, data = parse_asc_from_bytes(raw_bytes)
    if data is None:
        return None

    ncols = header['ncols']
    nrows = header['nrows']
    cellsize = header['cellsize']
    nodata = header.get('nodata_value', -9999.0)

    # Determine corner vs center registration
    if 'xllcenter' in header:
        xll = header['xllcenter'] - cellsize / 2
        yll = header['yllcenter'] - cellsize / 2
    else:
        xll = header['xllcorner']
        yll = header['yllcorner']

    # Bounds
    xmin = xll
    ymin = yll
    xmax = xll + ncols * cellsize
    ymax = yll + nrows * cellsize

    # Replace nodata with NaN for cleaner handling
    data[data == nodata] = np.nan

    # Build affine transform (top-left origin, y goes down)
    transform = from_bounds(xmin, ymin, xmax, ymax, ncols, nrows)

    # Write GeoTIFF
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
    """Convert native CRS bounds to WGS84 bbox [lon_min, lat_min, lon_max, lat_max]."""
    t = Transformer.from_crs(src_crs, WGS84, always_xy=True)
    # Transform all four corners for accuracy
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
    parser = argparse.ArgumentParser(description="Convert Veneto .asc tiles to GeoTIFF + index.json")
    parser.add_argument("--src", default="./italy/veneto_raw", help="Directory with .asc.zip files")
    parser.add_argument("--dst", default="./italy/tif", help="Output directory for .tif files + index.json")
    parser.add_argument("--skip-existing", action="store_true", default=True, help="Skip tiles that already have .tif")
    parser.add_argument("--no-skip", action="store_true", help="Reconvert all tiles")
    args = parser.parse_args()

    if args.no_skip:
        args.skip_existing = False

    os.makedirs(args.dst, exist_ok=True)

    # Find all .asc.zip files
    zips = sorted(glob.glob(os.path.join(args.src, "*.asc.zip")))
    print(f"Found {len(zips)} .asc.zip files in {args.src}")

    if not zips:
        print("No .zip files found. Run download_veneto.py first.")
        sys.exit(1)

    # Load existing index to preserve non-Veneto tiles
    index_path = os.path.join(args.dst, "index.json")
    existing_tiles = {}
    if os.path.exists(index_path):
        with open(index_path) as f:
            idx_data = json.load(f)
        for t in idx_data.get("tiles", idx_data if isinstance(idx_data, list) else []):
            existing_tiles[t["id"]] = t
        print(f"Existing index has {len(existing_tiles)} tiles")

    converted = 0
    skipped = 0
    failed = 0
    new_tiles = dict(existing_tiles)  # start with existing

    for i, zpath in enumerate(zips):
        zname = os.path.basename(zpath)
        tile_id = zname.replace(".asc.zip", "")
        tif_name = f"{tile_id}.tif"
        tif_path = os.path.join(args.dst, tif_name)

        # Skip if already converted
        if args.skip_existing and os.path.exists(tif_path) and tile_id in existing_tiles:
            skipped += 1
            continue

        # Read .asc directly from zip (avoids Windows charmap extraction errors)
        try:
            with zipfile.ZipFile(zpath, 'r') as zf:
                asc_names = [n for n in zf.namelist() if n.endswith('.asc')]
                if not asc_names:
                    print(f"  [{i+1}/{len(zips)}] SKIP {zname} -- no .asc inside")
                    failed += 1
                    continue
                raw_bytes = zf.read(asc_names[0])
        except zipfile.BadZipFile:
            print(f"  [{i+1}/{len(zips)}] FAIL {zname} -- bad zip")
            failed += 1
            continue

        # Convert
        try:
            info = asc_to_geotiff_from_bytes(raw_bytes, tif_path)
            if info is None:
                failed += 1
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

    # Write index.json
    tile_list = sorted(new_tiles.values(), key=lambda t: t["id"])
    with open(index_path, 'w') as f:
        json.dump({"tiles": tile_list}, f, indent=2)

    print(f"\nDone! Converted: {converted}, Skipped: {skipped}, Failed: {failed}")
    print(f"Index: {index_path} — {len(tile_list)} total tiles")

    # Summary stats
    if tile_list:
        all_lons = [t["bbox"][0] for t in tile_list] + [t["bbox"][2] for t in tile_list]
        all_lats = [t["bbox"][1] for t in tile_list] + [t["bbox"][3] for t in tile_list]
        print(f"Coverage: lon [{min(all_lons):.3f}, {max(all_lons):.3f}], lat [{min(all_lats):.3f}, {max(all_lats):.3f}]")


if __name__ == "__main__":
    main()
