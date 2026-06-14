"""
Bulk downloader for Veneto 5m LIDAR tiles from idt2.regione.veneto.it.

Usage:
    python download_veneto.py --cookies "IDTJSESSIONID=xxx; LBLSESSIONID=yyy; cookiesession1=zzz"

Fetches tile lists for all 7 Veneto provinces, then downloads each .asc.zip tile.
Requires an active browser session — cookies expire after ~30 min of inactivity.

To get cookies: open the Veneto downloader in Chrome, open DevTools Network tab,
click any tile download, right-click the request → Copy → Copy as cURL, extract cookies.
"""
import argparse
import json
import os
import sys
import time
import requests

BASE = "https://idt2.regione.veneto.it/idt/download/layerDownload"

# All 7 Veneto provinces (ISTAT codes)
PROVINCES = {
    "023": "Verona",
    "024": "Vicenza",
    "025": "Belluno",
    "026": "Treviso",
    "027": "Venezia",
    "028": "Padova",
    "029": "Rovigo",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://idt2.regione.veneto.it/idt/downloader/download",
}


def parse_cookies(cookie_str):
    """Parse cookie string into dict."""
    cookies = {}
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies


def fetch_tile_list(session, province_id):
    """Fetch tile list for a province. Returns list of {id, name, ...}."""
    url = f"{BASE}/getDtmLidar5ByProvincia"
    params = {"idProvincia": province_id, "formatoFile": "ZIP"}
    resp = session.get(url, params=params, headers=HEADERS, timeout=30)

    if resp.status_code != 200:
        print(f"  ERROR: HTTP {resp.status_code} for province {province_id}")
        return []

    # Check if we got HTML (CAS redirect) instead of JSON
    text = resp.text.strip()
    if text.startswith("<!DOCTYPE") or text.startswith("<html"):
        print(f"  ERROR: Got HTML instead of JSON — session expired?")
        return []

    try:
        data = resp.json()
    except json.JSONDecodeError:
        print(f"  ERROR: Invalid JSON response ({len(text)} bytes)")
        print(f"  First 200 chars: {text[:200]}")
        return []

    # Response: {"success": true, "result": {"data": [{"idPol": "100", "percorsoFile": "12_2K_0119", ...}]}}
    if isinstance(data, dict):
        result = data.get("result", data)
        if isinstance(result, dict):
            return result.get("data", [])
        return result if isinstance(result, list) else []
    if isinstance(data, list):
        return data
    return []


def download_tile(session, tile_id, out_dir, filename=None):
    """Download a single tile by ID. Returns (success, filename, size)."""
    url = f"{BASE}/downloadDtmLidar5"
    params = {"dataDtmLidarId": tile_id}

    resp = session.get(url, params=params, headers=HEADERS, timeout=60, stream=True)

    if resp.status_code != 200:
        return False, None, 0

    # Get filename from Content-Disposition or use tile ID
    cd = resp.headers.get("Content-Disposition", "")
    if 'filename="' in cd:
        fname = cd.split('filename="')[1].split('"')[0]
    elif "filename=" in cd:
        fname = cd.split("filename=")[1].split(";")[0].strip()
    else:
        fname = filename or f"tile_{tile_id}.zip"

    out_path = os.path.join(out_dir, fname)

    # Skip if already downloaded
    content_length = int(resp.headers.get("Content-Length", 0))
    if os.path.exists(out_path):
        existing_size = os.path.getsize(out_path)
        if existing_size == content_length and content_length > 0:
            return True, fname, existing_size

    # Write file
    size = 0
    with open(out_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
            size += len(chunk)

    return True, fname, size


def main():
    parser = argparse.ArgumentParser(description="Bulk download Veneto 5m LIDAR tiles")
    parser.add_argument("--cookies", required=True, help="Browser cookie string (from DevTools)")
    parser.add_argument("--out", default="./italy/veneto_raw", help="Output directory for .zip files")
    parser.add_argument("--province", help="Single province code (e.g. 025 for Belluno)")
    parser.add_argument("--delay", type=float, default=0.5, help="Delay between downloads (seconds)")
    parser.add_argument("--list-only", action="store_true", help="Only list tiles, don't download")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)

    # Build session with cookies
    session = requests.Session()
    cookie_dict = parse_cookies(args.cookies)
    session.cookies.update(cookie_dict)

    print(f"Session cookies: {list(cookie_dict.keys())}")
    print(f"Output directory: {args.out}")
    print()

    # Select provinces
    provinces = {args.province: PROVINCES.get(args.province, "?")} if args.province else PROVINCES

    all_tiles = []

    # Phase 1: Fetch tile lists
    for code, name in provinces.items():
        print(f"Fetching tile list for {name} ({code})...")
        tiles = fetch_tile_list(session, code)
        print(f"  Found {len(tiles)} tiles")

        if tiles and len(tiles) > 0:
            # Print first tile to understand structure
            if not all_tiles:
                print(f"  Sample tile: {json.dumps(tiles[0], indent=2)[:300]}")

        for t in tiles:
            t["_province"] = name
            t["_province_code"] = code

        all_tiles.extend(tiles)

    # Deduplicate by ID (tiles near province borders may appear in multiple lists)
    seen_ids = set()
    unique_tiles = []
    for t in all_tiles:
        # Try common field names for the tile ID
        tid = t.get("idPol") or t.get("dataDtmLidarId") or t.get("id")
        if tid and tid not in seen_ids:
            seen_ids.add(tid)
            unique_tiles.append(t)

    print(f"\nTotal unique tiles: {len(unique_tiles)}")

    if args.list_only:
        for t in unique_tiles[:20]:
            print(f"  {t}")
        if len(unique_tiles) > 20:
            print(f"  ... and {len(unique_tiles) - 20} more")
        return

    if not unique_tiles:
        print("No tiles found. Session may have expired.")
        print("Try refreshing the Veneto downloader page and re-copying cookies.")
        sys.exit(1)

    # Phase 2: Download tiles
    print(f"\nStarting download of {len(unique_tiles)} tiles...")
    downloaded = 0
    skipped = 0
    failed = 0
    total_bytes = 0

    for i, tile in enumerate(unique_tiles):
        tid = tile.get("idPol") or tile.get("dataDtmLidarId") or tile.get("id")
        tname = tile.get("percorsoFile") or tile.get("nomeFile") or tile.get("name") or f"tile_{tid}"

        ok, fname, size = download_tile(session, tid, args.out, f"{tname}.zip")

        if ok and size > 0:
            if os.path.exists(os.path.join(args.out, fname)):
                existing = os.path.getsize(os.path.join(args.out, fname))
                if existing == size or (existing > 0 and size == existing):
                    # Could be skip or fresh download
                    pass
            downloaded += 1
            total_bytes += size
            status = "OK"
        elif ok:
            skipped += 1
            status = "SKIP"
        else:
            failed += 1
            status = "FAIL"

        mb = total_bytes / 1024 / 1024
        print(f"  [{i+1}/{len(unique_tiles)}] {status} {fname or tname} ({size//1024}KB) — {mb:.1f}MB total")

        if failed > 5 and downloaded == 0:
            print("\nToo many failures with no successes — session likely expired.")
            print("Refresh the Veneto downloader page and re-copy cookies.")
            sys.exit(1)

        time.sleep(args.delay)

    print(f"\nDone! Downloaded: {downloaded}, Skipped: {skipped}, Failed: {failed}")
    print(f"Total size: {total_bytes / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
