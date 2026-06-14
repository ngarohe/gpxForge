"""
Bulk downloader for Friuli Venezia Giulia 1m LIDAR tiles from IRDAT.

Usage:
    python download_fvg.py --dst ./italy/fvg_raw
    python download_fvg.py --dst ./italy/fvg_raw --list-only

NO AUTHENTICATION required. Direct URL download pattern:
  https://irdat.regione.fvg.it/cartogdownload/DTM_PCR/1M/6708/DTM01_PCR_{CODICE_DTM}_RDN2008_TM33.zip

Tile catalog from WFS:
  https://serviziogc.regione.fvg.it/geoserver/GRIGLIEGEO/wfs
  typeName=GRIGLIEGEO:QU_DTM_LIDAR_FVG

817 tiles, 1m resolution, EPSG:6708 (RDN2008/TM33), .asc in zip.
Each tile is ~900m × 840m.
"""
import argparse
import json
import os
import sys
import time
import requests

WFS_URL = "https://serviziogc.regione.fvg.it/geoserver/GRIGLIEGEO/wfs"
DOWNLOAD_BASE = "https://irdat.regione.fvg.it/cartogdownload/DTM_PCR/1M/6708"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}


def fetch_tile_catalog(session, page_size=5000):
    """Fetch all tile features from WFS with pagination."""
    all_features = []
    start = 0

    while True:
        params = {
            "service": "wfs",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "GRIGLIEGEO:QU_DTM_LIDAR_FVG",
            "outputFormat": "application/json",
            "count": page_size,
            "startIndex": start,
        }
        print(f"  Fetching WFS page at offset {start}...")
        resp = session.get(WFS_URL, params=params, headers=HEADERS, timeout=60)
        if resp.status_code != 200:
            print(f"ERROR: WFS returned HTTP {resp.status_code}")
            break

        data = resp.json()
        features = data.get("features", [])
        if not features:
            break
        all_features.extend(features)
        print(f"  Got {len(features)} features (total: {len(all_features)})")
        if len(features) < page_size:
            break
        start += len(features)

    return all_features


def download_tile(session, codice_dtm, out_dir):
    """Download a single tile zip. Returns (status, size).
    status: 'ok', 'notfound' (404), 'error' (network/other)
    """
    filename = f"DTM01_PCR_{codice_dtm}_RDN2008_TM33.zip"
    url = f"{DOWNLOAD_BASE}/{filename}"
    out_path = os.path.join(out_dir, filename)

    # Skip if already downloaded
    if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
        return 'ok', os.path.getsize(out_path)

    try:
        resp = session.get(url, headers=HEADERS, timeout=120, stream=True)
    except Exception:
        return 'error', 0

    if resp.status_code == 404:
        return 'notfound', 0
    if resp.status_code != 200:
        return 'error', 0

    size = 0
    with open(out_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
            size += len(chunk)

    return 'ok', size


def main():
    parser = argparse.ArgumentParser(description="Bulk download FVG 1m LIDAR tiles")
    parser.add_argument("--dst", default="./italy/fvg_raw", help="Output directory")
    parser.add_argument("--delay", type=float, default=0.3, help="Delay between downloads")
    parser.add_argument("--list-only", action="store_true", help="Only list tiles")
    args = parser.parse_args()

    os.makedirs(args.dst, exist_ok=True)

    session = requests.Session()

    # Fetch tile catalog
    print("Fetching tile catalog from WFS...")
    features = fetch_tile_catalog(session)
    print(f"Found {len(features)} tiles")

    if not features:
        print("No tiles found. WFS may be down.")
        sys.exit(1)

    # Extract tile codes — use CODICE_CTRN (6-digit), not CODICE_DTM (8-digit)
    # Multiple DTM sub-tiles share the same CTRN sheet, and the download URL uses CTRN
    tiles = []
    for feat in features:
        props = feat.get("properties", {})
        codice = props.get("CODICE_CTRN")
        if codice:
            tiles.append(codice)

    tiles = sorted(set(tiles))
    print(f"Unique CTRN codes: {len(tiles)}")

    if args.list_only:
        for t in tiles[:20]:
            print(f"  {t}")
        if len(tiles) > 20:
            print(f"  ... and {len(tiles) - 20} more")
        return

    # Download
    print(f"\nDownloading {len(tiles)} tiles...")
    downloaded = 0
    skipped = 0
    notfound = 0
    errors = 0
    total_bytes = 0
    consecutive_errors = 0

    for i, codice in enumerate(tiles):
        # Check if already exists before downloading
        filepath = os.path.join(args.dst, f"DTM01_PCR_{codice}_RDN2008_TM33.zip")
        if os.path.exists(filepath) and os.path.getsize(filepath) > 1000:
            skipped += 1
            if skipped <= 3 or skipped % 200 == 0:
                print(f"  [{i+1}/{len(tiles)}] SKIP {codice}")
            continue

        status, size = download_tile(session, codice, args.dst)

        if status == 'ok' and size > 0:
            downloaded += 1
            total_bytes += size
            consecutive_errors = 0
            if downloaded <= 5 or downloaded % 25 == 0:
                mb = total_bytes / 1024 / 1024
                print(f"  [{i+1}/{len(tiles)}] OK {codice} ({size//1024}KB) — {mb:.1f}MB total")
        elif status == 'notfound':
            notfound += 1
            consecutive_errors = 0
            # 404s expected — only ~817 of 1023 sheets have 1m LIDAR coverage
        else:
            errors += 1
            consecutive_errors += 1
            print(f"  [{i+1}/{len(tiles)}] ERROR {codice}")
            if consecutive_errors > 20:
                print("\nToo many consecutive errors. Server may be down.")
                sys.exit(1)

        time.sleep(args.delay)

    print(f"\nDone! Downloaded: {downloaded}, Skipped: {skipped}, Notfound: {notfound}, Errors: {errors}")
    print(f"Total size: {total_bytes / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
