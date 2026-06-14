"""
LIDAR coverage GeoJSON builder.

Combines:
  1. Country border polygons (from Natural Earth via generate_borders.py)
  2. Regional provider boundaries (Italy sub-regions, GB EA LIDAR extent)
  3. Tile provider convex hulls (Spain MDT02, Portugal MDT2m)

Result is cached in memory after first build.
"""
import json
import math
import os
from typing import Any, Dict, List, Optional

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
BORDERS_FILE = os.path.join(DATA_DIR, 'country_borders.json')

_cached_coverage: Optional[Dict[str, Any]] = None


# ── Provider resolution metadata ────────────────────────────────────

# Primary resolution for each country (what the user gets for most of the country).
# Matches the client-side PROVIDER_RESOLUTION where applicable.
COUNTRY_META = {
    'FR': {'res': 1,    'name': 'France',         'full': True},
    'CH': {'res': 2,    'name': 'Switzerland',     'full': True},
    'SI': {'res': 1,    'name': 'Slovenia',         'full': True},
    'NL': {'res': 0.5,  'name': 'Netherlands',     'full': True},
    'HR': {'res': 20,   'name': 'Croatia',         'full': True},
    'NO': {'res': 1,    'name': 'Norway',           'full': True},
    'FI': {'res': 2,    'name': 'Finland',         'full': True},
    'DE': {'res': 1,    'name': 'Germany',         'full': True},
    'PL': {'res': 1,    'name': 'Poland',           'full': True},
    'CZ': {'res': 1,    'name': 'Czech Republic',   'full': True},
    'EE': {'res': 1,    'name': 'Estonia',         'full': True},
    'DK': {'res': 0.4,  'name': 'Denmark',         'full': True},
    'US': {'res': 1,    'name': 'USA',             'full': True},
    'BE': {'res': 1,    'name': 'Belgium',         'full': True,  'note': 'Flanders DHM 1m WCS + Wallonia MNT 50cm (identify)'},
    'AU': {'res': 5,    'name': 'Australia',       'full': True,  'gpxz': True},
    'MX': {'res': 5,    'name': 'Mexico',           'full': True,  'gpxz': True},
    'HK': {'res': 1,    'name': 'Hong Kong',       'full': True,  'gpxz': True},
    'LU': {'res': 5,    'name': 'Luxembourg',       'full': True,  'gpxz': True},
    'JP': {'res': 5,    'name': 'Japan',           'full': False, 'note': '~70% urban/coastal DEM5A, GPXZ fallback'},
    'AT': {'res': 5,    'name': 'Austria',         'full': True,  'note': 'ALS1 1m + DGM5 5m tiles'},
    'CA': {'res': 2,    'name': 'Canada',           'full': False, 'note': 'HRDEM 2m partial, GPXZ fallback'},
    'NZ': {'res': 1,    'name': 'New Zealand',     'full': False, 'note': 'LINZ 1m partial, limited fallback'},
    'ES': {'res': 5,    'name': 'Spain',           'full': True,  'note': 'WCS 5m full, MDT02 2m tiles partial'},
    'GB': {'res': 1,    'name': 'Great Britain',   'full': False, 'note': 'EA LIDAR 1m England/Wales + JNCC 0.5-1m Scotland ~40%, GPXZ NI'},
    'PT': {'res': 2,    'name': 'Portugal',         'full': False, 'note': 'MDT tiles partial, GPXZ fallback'},
    'IT': {'res': 5,    'name': 'Italy',           'full': True,  'note': 'TN 0.5m + FVG/TO 1m + BZ 2.5m + ER/VE/LO/PI 5m + TINITALY 10m'},
}


# ── Regional sub-providers ──────────────────────────────────────────

def _gb_ea_lidar_polygon() -> Dict:
    """Convert GB EA LIDAR OSGB36 extent to WGS84 polygon."""
    try:
        from pyproj import Transformer
        t = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
        e_min, e_max = 80000.0, 656000.0
        n_min, n_max = 4000.0, 665000.0
        corners_osgb = [
            (e_min, n_min), (e_max, n_min), (e_max, n_max), (e_min, n_max), (e_min, n_min)
        ]
        coords = []
        for e, n in corners_osgb:
            lon, lat = t.transform(e, n)
            coords.append([round(lon, 3), round(lat, 3)])
        return {'type': 'Polygon', 'coordinates': [coords]}
    except Exception:
        # Fallback approximate rectangle
        return {
            'type': 'Polygon',
            'coordinates': [[
                [-6.0, 49.9], [2.0, 49.9], [2.0, 55.8], [-6.0, 55.8], [-6.0, 49.9]
            ]]
        }


def _scotland_lidar_polygon() -> Dict:
    """Convert Scotland LIDAR OSGB36 extent to WGS84 polygon."""
    try:
        from pyproj import Transformer
        t = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
        e_min, e_max = 5000.0, 470000.0
        n_min, n_max = 530000.0, 1230000.0
        corners_osgb = [
            (e_min, n_min), (e_max, n_min), (e_max, n_max), (e_min, n_max), (e_min, n_min)
        ]
        coords = []
        for e, n in corners_osgb:
            lon, lat = t.transform(e, n)
            coords.append([round(lon, 3), round(lat, 3)])
        return {'type': 'Polygon', 'coordinates': [coords]}
    except Exception:
        return {
            'type': 'Polygon',
            'coordinates': [[
                [-8.0, 54.6], [-0.7, 54.6], [-0.7, 61.0], [-8.0, 61.0], [-8.0, 54.6]
            ]]
        }


def _italy_south_tyrol_polygon() -> Dict:
    """Approximate Province of Bolzano boundary."""
    # Simplified polygon following the actual provincial border
    return {
        'type': 'Polygon',
        'coordinates': [[
            [10.45, 46.22], [10.48, 46.63], [10.45, 46.84],
            [10.62, 46.96], [10.99, 46.98], [11.21, 47.01],
            [11.46, 47.08], [11.83, 47.06], [12.05, 47.02],
            [12.28, 46.99], [12.48, 46.75], [12.36, 46.61],
            [12.16, 46.64], [11.82, 46.51], [11.51, 46.47],
            [11.36, 46.50], [11.17, 46.38], [10.99, 46.31],
            [10.74, 46.33], [10.55, 46.36], [10.45, 46.22]
        ]]
    }


def _italy_emilia_romagna_polygon() -> Dict:
    """Approximate Emilia-Romagna region boundary."""
    return {
        'type': 'Polygon',
        'coordinates': [[
            [9.20, 44.06], [9.50, 44.10], [9.79, 44.01],
            [10.03, 44.02], [10.46, 44.05], [10.83, 44.06],
            [11.10, 43.97], [11.25, 44.06], [11.46, 44.12],
            [11.80, 44.16], [12.01, 44.09], [12.28, 44.13],
            [12.60, 44.14], [12.76, 43.96], [12.51, 43.90],
            [12.37, 43.92], [12.26, 43.73], [11.83, 43.76],
            [11.45, 43.62], [11.21, 43.73], [10.89, 43.80],
            [10.64, 43.85], [10.39, 43.92], [10.03, 43.92],
            [9.71, 43.96], [9.45, 44.01], [9.20, 44.06]
        ]]
    }


def _italy_toscana_polygon() -> Dict:
    """Approximate Toscana region boundary."""
    return {
        'type': 'Polygon',
        'coordinates': [[
            [9.69, 43.05], [9.95, 43.20], [10.15, 43.40], [10.31, 43.70],
            [10.27, 43.90], [10.18, 44.10], [10.18, 44.30], [10.50, 44.45],
            [10.85, 44.45], [11.20, 44.30], [11.45, 44.25], [11.75, 44.15],
            [11.95, 44.05], [12.20, 43.95], [12.40, 43.75], [12.30, 43.55],
            [12.10, 43.45], [11.95, 43.30], [11.85, 43.15], [11.70, 42.95],
            [11.55, 42.75], [11.40, 42.55], [11.20, 42.35], [10.95, 42.30],
            [10.70, 42.40], [10.50, 42.50], [10.30, 42.65], [10.10, 42.80],
            [9.95, 42.90], [9.69, 43.05]
        ]]
    }


def _italy_piemonte_polygon() -> Dict:
    """Approximate Piemonte region boundary (incl. cross-border Alps)."""
    return {
        'type': 'Polygon',
        'coordinates': [[
            [6.65, 44.10], [6.70, 44.50], [6.85, 44.85], [7.00, 45.10],
            [6.80, 45.40], [6.95, 45.65], [7.15, 45.90], [7.45, 46.05],
            [7.85, 45.95], [8.15, 45.85], [8.50, 45.85], [8.65, 45.70],
            [8.85, 45.45], [8.80, 45.10], [8.95, 44.90], [8.85, 44.65],
            [8.70, 44.45], [8.45, 44.30], [8.20, 44.20], [7.90, 44.10],
            [7.50, 44.00], [7.20, 43.85], [6.95, 43.95], [6.75, 44.05],
            [6.65, 44.10]
        ]]
    }


def _italy_lombardia_polygon() -> Dict:
    """Approximate Lombardia region boundary."""
    return {
        'type': 'Polygon',
        'coordinates': [[
            [8.50, 45.05], [8.70, 44.80], [9.20, 44.70], [9.80, 44.95],
            [10.05, 44.95], [10.40, 45.05], [10.75, 45.15], [10.80, 45.50],
            [10.95, 45.80], [10.75, 46.20], [10.55, 46.50], [10.45, 46.60],
            [10.08, 46.55], [9.70, 46.50], [9.40, 46.50], [9.10, 46.50],
            [8.90, 46.25], [8.60, 46.10], [8.50, 45.80], [8.50, 45.50],
            [8.50, 45.05]
        ]]
    }


# ── Tile catalog hulls ──────────────────────────────────────────────

def _load_tile_hull(catalog_path: str) -> Optional[Dict]:
    """Compute convex hull from tile catalog bboxes."""
    try:
        from shapely.geometry import MultiPoint, mapping
    except ImportError:
        return None

    if not os.path.exists(catalog_path):
        return None

    with open(catalog_path) as f:
        catalog = json.load(f)

    tiles = catalog.get('tiles', [])
    if not tiles:
        return None

    # Collect all corner points from tile bboxes
    points = []
    for tile in tiles:
        bbox = tile.get('bbox', [])
        if len(bbox) == 4:
            lon_min, lat_min, lon_max, lat_max = bbox
            points.extend([
                (lon_min, lat_min), (lon_max, lat_min),
                (lon_max, lat_max), (lon_min, lat_max),
            ])

    if len(points) < 3:
        return None

    hull = MultiPoint(points).convex_hull
    geom = mapping(hull)
    # Round coordinates
    if geom['type'] == 'Polygon':
        geom['coordinates'] = [
            [[round(c[0], 3), round(c[1], 3)] for c in ring]
            for ring in geom['coordinates']
        ]
    return geom


# ── Main builder ────────────────────────────────────────────────────

def build_coverage_geojson() -> Dict[str, Any]:
    """Build the full LIDAR coverage GeoJSON FeatureCollection."""
    global _cached_coverage
    if _cached_coverage is not None:
        return _cached_coverage

    features: List[Dict] = []

    # 1. Load country borders
    borders_by_cc: Dict[str, Dict] = {}
    if os.path.exists(BORDERS_FILE):
        with open(BORDERS_FILE) as f:
            borders_data = json.load(f)
        for feat in borders_data.get('features', []):
            cc = feat['properties']['cc']
            borders_by_cc[cc] = feat['geometry']

    # 2. Build country-level features
    for cc, meta in COUNTRY_META.items():
        geom = borders_by_cc.get(cc)
        if not geom:
            continue

        props = {
            'cc': cc,
            'name': meta['name'],
            'resolution_m': meta['res'],
            'layer': 'country',
            'full_coverage': meta.get('full', False),
            'gpxz_only': meta.get('gpxz', False),
        }
        if 'note' in meta:
            props['note'] = meta['note']

        features.append({
            'type': 'Feature',
            'properties': props,
            'geometry': geom,
        })

    # 3. Add sub-region overlays

    # Italy — South Tyrol 2.5m
    features.append({
        'type': 'Feature',
        'properties': {
            'cc': 'IT',
            'name': 'South Tyrol',
            'resolution_m': 2.5,
            'layer': 'region',
            'parent': 'IT',
        },
        'geometry': _italy_south_tyrol_polygon(),
    })

    # Italy — Emilia-Romagna 5m
    features.append({
        'type': 'Feature',
        'properties': {
            'cc': 'IT',
            'name': 'Emilia-Romagna',
            'resolution_m': 5,
            'layer': 'region',
            'parent': 'IT',
        },
        'geometry': _italy_emilia_romagna_polygon(),
    })

    # Italy — Lombardia 5m (ArcGIS Identify)
    features.append({
        'type': 'Feature',
        'properties': {
            'cc': 'IT',
            'name': 'Lombardia',
            'resolution_m': 5,
            'layer': 'region',
            'parent': 'IT',
        },
        'geometry': _italy_lombardia_polygon(),
    })

    # Italy — Piemonte 5m (ARPA Piemonte ImageServer)
    features.append({
        'type': 'Feature',
        'properties': {
            'cc': 'IT',
            'name': 'Piemonte',
            'resolution_m': 5,
            'layer': 'region',
            'parent': 'IT',
        },
        'geometry': _italy_piemonte_polygon(),
    })

    # Italy — Toscana 1m / 10m (Regione Toscana WMS-GeoTIFF)
    features.append({
        'type': 'Feature',
        'properties': {
            'cc': 'IT',
            'name': 'Toscana',
            'resolution_m': 1,
            'layer': 'region',
            'parent': 'IT',
            'note': '1m LIDAR partial, 10m full',
        },
        'geometry': _italy_toscana_polygon(),
    })

    # Italy — Veneto 5m local tiles (convex hull from catalog)
    from config import ITALY_VENETO_INDEX_PATH, ITALY_FVG_INDEX_PATH, ITALY_TRENTINO_INDEX_PATH
    ve_hull = _load_tile_hull(ITALY_VENETO_INDEX_PATH)
    if ve_hull:
        features.append({
            'type': 'Feature',
            'properties': {
                'cc': 'IT',
                'name': 'Veneto tiles',
                'resolution_m': 5,
                'layer': 'tiles',
                'parent': 'IT',
            },
            'geometry': ve_hull,
        })

    # Italy — FVG 1m local tiles
    fvg_hull = _load_tile_hull(ITALY_FVG_INDEX_PATH)
    if fvg_hull:
        features.append({
            'type': 'Feature',
            'properties': {
                'cc': 'IT',
                'name': 'Friuli Venezia Giulia tiles',
                'resolution_m': 1,
                'layer': 'tiles',
                'parent': 'IT',
            },
            'geometry': fvg_hull,
        })

    # Italy — Trentino 0.5m local tiles
    tn_hull = _load_tile_hull(ITALY_TRENTINO_INDEX_PATH)
    if tn_hull:
        features.append({
            'type': 'Feature',
            'properties': {
                'cc': 'IT',
                'name': 'Trentino tiles',
                'resolution_m': 0.5,
                'layer': 'tiles',
                'parent': 'IT',
            },
            'geometry': tn_hull,
        })

    # GB — EA LIDAR extent (England/Wales)
    features.append({
        'type': 'Feature',
        'properties': {
            'cc': 'GB',
            'name': 'England & Wales (EA LIDAR)',
            'resolution_m': 1,
            'layer': 'region',
            'parent': 'GB',
        },
        'geometry': _gb_ea_lidar_polygon(),
    })

    # GB — Scotland LIDAR extent (JNCC)
    features.append({
        'type': 'Feature',
        'properties': {
            'cc': 'GB',
            'name': 'Scotland (JNCC LIDAR)',
            'resolution_m': 1,
            'layer': 'region',
            'parent': 'GB',
        },
        'geometry': _scotland_lidar_polygon(),
    })

    # 4. Add tile provider coverage hulls

    # Spain MDT02 2m tiles
    es_mdt02_path = os.path.join(DATA_DIR, 'spain_tiles', 'mdt02', 'index.json')
    es_hull = _load_tile_hull(es_mdt02_path)
    if es_hull:
        features.append({
            'type': 'Feature',
            'properties': {
                'cc': 'ES',
                'name': 'Spain MDT02 tiles',
                'resolution_m': 2,
                'layer': 'tiles',
                'parent': 'ES',
            },
            'geometry': es_hull,
        })

    # Portugal MDT2m tiles
    pt_mdt2m_path = os.path.join(DATA_DIR, 'portugal_tiles', 'mdt2m', 'index.json')
    pt_hull = _load_tile_hull(pt_mdt2m_path)
    if pt_hull:
        features.append({
            'type': 'Feature',
            'properties': {
                'cc': 'PT',
                'name': 'Portugal MDT 2m tiles',
                'resolution_m': 2,
                'layer': 'tiles',
                'parent': 'PT',
            },
            'geometry': pt_hull,
        })

    result = {
        'type': 'FeatureCollection',
        'features': features,
    }
    _cached_coverage = result
    return result
