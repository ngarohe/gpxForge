"""
Bulk downloader for Trentino 0.5m LIDAR tiles from SIAT STEM portal.

Usage:
    python download_trentino.py --dst ./italy/trentino_raw
    python download_trentino.py --dst ./italy/trentino_raw --batch-size 10
    python download_trentino.py --dst ./italy/trentino_raw --list-only

The STEM API requires NO authentication. Steps:
  1. Fetch tile list from WFS (stem:inqlid2014_dtm_asc, paginated)
  2. For each tile, POST to services/merge with the file path
  3. Poll services/file/info until ready
  4. Download the result (nested zip: outer.zip → TILE_DTM.asc.zip → TILE_DTM.asc)

Tiles are 1000×1000 cells at 0.5m resolution, EPSG:25832 (UTM 32N).
Total: ~25,201 tiles, ~7.2 GB compressed.
"""
import argparse
import json
import os
import sys
import time
import zipfile
import requests

WFS_BASE = "https://siat.provincia.tn.it/geoserver/wfs"
STEM_BASE = "https://siat.provincia.tn.it/stem"

# WFS layer for the DTM tile index
LAYER_NAME = "stem:inqlid2014_dtm_asc"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}


def fetch_tile_list(session, max_features=1000, start_index=0):
    """Fetch a page of tile features from WFS. Returns (features, total_returned)."""
    params = {
        "service": "wfs",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeNames": LAYER_NAME,
        "outputFormat": "application/json",
        "count": max_features,
        "startIndex": start_index,
    }
    resp = session.get(WFS_BASE, params=params, headers=HEADERS, timeout=60)
    if resp.status_code != 200:
        print(f"  ERROR: WFS HTTP {resp.status_code}")
        return [], 0

    data = resp.json()
    features = data.get("features", [])
    return features, len(features)


def fetch_all_tiles(session, page_size=5000):
    """Fetch all tiles from WFS with pagination."""
    all_features = []
    start = 0

    while True:
        print(f"  Fetching WFS page at offset {start}...")
        features, count = fetch_tile_list(session, max_features=page_size, start_index=start)
        if not features:
            break
        all_features.extend(features)
        print(f"  Got {count} features (total so far: {len(all_features)})")
        if count < page_size:
            break
        start += count
        time.sleep(0.5)

    return all_features


def request_merge(session, file_paths):
    """POST to services/merge to request file preparation. Returns (id, token) or None."""
    url = f"{STEM_BASE}/services/merge"
    payload = {
        "files": file_paths,
        "type": "raster",
    }
    resp = session.post(url, json=payload, headers={
        **HEADERS,
        "Content-Type": "application/json",
    }, timeout=30)

    if resp.status_code != 200:
        return None

    data = resp.json()
    if not data.get("success"):
        return None

    return data.get("id"), data.get("token")


def poll_until_ready(session, file_id, token, max_wait=120, interval=2):
    """Poll services/file/info until the file is ready. Returns True on success."""
    url = f"{STEM_BASE}/services/file/info"
    params = {"id": file_id, "token": token}

    elapsed = 0
    while elapsed < max_wait:
        try:
            resp = session.get(url, params=params, headers=HEADERS, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                state = data.get("state", -1)
                if state != 0:
                    return True
        except Exception:
            pass

        time.sleep(interval)
        elapsed += interval

    return False


def download_file(session, file_id, token, out_path):
    """Download the prepared file. Returns size in bytes or 0 on failure."""
    url = f"{STEM_BASE}/services/file"
    params = {"id": file_id, "token": token}

    resp = session.get(url, params=params, headers=HEADERS, timeout=120, stream=True)
    if resp.status_code != 200:
        return 0

    size = 0
    with open(out_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
            size += len(chunk)

    return size


def extract_nested_zip(outer_zip_path, out_dir):
    """Extract the nested zip structure: outer.zip → inner.asc.zip → .asc
    Returns list of extracted .asc.zip paths (inner zips kept for convert step)."""
    extracted = []
    try:
        with zipfile.ZipFile(outer_zip_path, 'r') as zf:
            inner_names = [n for n in zf.namelist() if n.endswith('.asc.zip')]
            for name in inner_names:
                inner_path = os.path.join(out_dir, os.path.basename(name))
                if not os.path.exists(inner_path):
                    with open(inner_path, 'wb') as f:
                        f.write(zf.read(name))
                extracted.append(inner_path)
    except (zipfile.BadZipFile, Exception):
        pass
    return extracted


def main():
    parser = argparse.ArgumentParser(description="Bulk download Trentino 0.5m LIDAR tiles")
    parser.add_argument("--dst", default="./italy/trentino_raw", help="Output directory for .asc.zip files")
    parser.add_argument("--batch-size", type=int, default=1, help="Tiles per merge request (1=safest)")
    parser.add_argument("--delay", type=float, default=1.0, help="Delay between downloads (seconds)")
    parser.add_argument("--list-only", action="store_true", help="Only fetch and list tiles, don't download")
    parser.add_argument("--start-at", type=int, default=0, help="Skip first N tiles (resume)")
    parser.add_argument("--max-tiles", type=int, default=0, help="Stop after N tiles (0=all)")
    args = parser.parse_args()

    os.makedirs(args.dst, exist_ok=True)

    session = requests.Session()

    # Phase 1: Fetch tile catalog from WFS
    print("Fetching tile catalog from WFS...")
    features = fetch_all_tiles(session)
    print(f"\nTotal tiles in catalog: {len(features)}")

    if not features:
        print("No tiles found. WFS may be down.")
        sys.exit(1)

    # Parse tile names and server paths from features
    # WFS returns: n_tavola (tile name), location (full server path to .asc.zip)
    tiles = []
    for feat in features:
        props = feat.get("properties", {})
        name = props.get("n_tavola")
        location = props.get("location")
        if name and location:
            tiles.append({"name": name, "location": location})

    # Deduplicate by name
    seen = set()
    unique_tiles = []
    for t in tiles:
        if t["name"] not in seen:
            seen.add(t["name"])
            unique_tiles.append(t)
    tiles = sorted(unique_tiles, key=lambda t: t["name"])
    print(f"Unique tiles: {len(tiles)}")

    if args.list_only:
        for t in tiles[:30]:
            print(f"  {t['name']} → {t['location']}")
        if len(tiles) > 30:
            print(f"  ... and {len(tiles) - 30} more")
        return

    # Phase 2: Download tiles
    if args.start_at > 0:
        print(f"Skipping first {args.start_at} tiles (resuming)")
    if args.max_tiles > 0:
        end_at = min(args.start_at + args.max_tiles, len(tiles))
    else:
        end_at = len(tiles)

    work_tiles = tiles[args.start_at:end_at]
    print(f"\nDownloading {len(work_tiles)} tiles (index {args.start_at} to {end_at - 1})...")

    downloaded = 0
    skipped = 0
    failed = 0
    total_bytes = 0
    tmp_dir = os.path.join(args.dst, "_tmp")
    os.makedirs(tmp_dir, exist_ok=True)

    for i, tile in enumerate(work_tiles):
        tile_name = tile["name"]
        file_path = tile["location"]

        # Check if already downloaded (inner .asc.zip exists)
        inner_zip_name = f"{tile_name}_DTM.asc.zip"
        inner_zip_path = os.path.join(args.dst, inner_zip_name)

        if os.path.exists(inner_zip_path) and os.path.getsize(inner_zip_path) > 1000:
            skipped += 1
            if skipped <= 5 or skipped % 500 == 0:
                print(f"  [{args.start_at + i + 1}/{len(tiles)}] SKIP {tile_name} (exists)")
            continue

        # Request merge
        result = request_merge(session, [file_path])
        if result is None:
            print(f"  [{args.start_at + i + 1}/{len(tiles)}] FAIL {tile_name} — merge request failed")
            failed += 1
            time.sleep(args.delay)
            continue

        file_id, token = result

        # Poll until ready
        if not poll_until_ready(session, file_id, token, max_wait=60):
            print(f"  [{args.start_at + i + 1}/{len(tiles)}] FAIL {tile_name} — poll timeout")
            failed += 1
            time.sleep(args.delay)
            continue

        # Download outer zip
        outer_path = os.path.join(tmp_dir, f"{tile_name}_outer.zip")
        size = download_file(session, file_id, token, outer_path)

        if size < 100:
            print(f"  [{args.start_at + i + 1}/{len(tiles)}] FAIL {tile_name} — download too small ({size}B)")
            failed += 1
            if os.path.exists(outer_path):
                os.remove(outer_path)
            time.sleep(args.delay)
            continue

        # Extract nested zip
        extracted = extract_nested_zip(outer_path, args.dst)

        # Clean up outer zip
        if os.path.exists(outer_path):
            os.remove(outer_path)

        if extracted:
            downloaded += 1
            total_bytes += sum(os.path.getsize(p) for p in extracted)
            mb = total_bytes / 1024 / 1024
            if downloaded <= 5 or downloaded % 50 == 0:
                print(f"  [{args.start_at + i + 1}/{len(tiles)}] OK {tile_name} ({size // 1024}KB) — {mb:.1f}MB total")
        else:
            print(f"  [{args.start_at + i + 1}/{len(tiles)}] FAIL {tile_name} — no .asc.zip inside outer zip")
            failed += 1

        if failed > 10 and downloaded == 0:
            print("\nToo many failures with no successes. Server may be down.")
            sys.exit(1)

        time.sleep(args.delay)

    print(f"\nDone! Downloaded: {downloaded}, Skipped: {skipped}, Failed: {failed}")
    print(f"Total extracted size: {total_bytes / 1024 / 1024:.1f} MB")
    print(f"Output: {args.dst}")


if __name__ == "__main__":
    main()
