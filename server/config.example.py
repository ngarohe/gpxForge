import os
import re
from dotenv import load_dotenv

load_dotenv()  # reads .env if present; env vars already set take precedence

_BASE_DIR = os.path.dirname(__file__)


def _normalize_local_path(path: str) -> str:
    """Normalize Windows drive paths to WSL form when running on Linux."""
    if not path:
        return path
    if os.name == 'nt':
        return path
    match = re.match(r'^([A-Za-z]):[\\/](.*)$', path)
    if not match:
        return path
    drive = match.group(1).lower()
    tail = match.group(2).replace('\\', '/').lstrip('/')
    return f"/mnt/{drive}/{tail}"

# API Keys
GPXZ_API_KEY = os.environ.get('GPXZ_API_KEY', '')
FINLAND_API_KEY = os.environ.get('FINLAND_API_KEY', '')
DENMARK_TOKEN = os.environ.get('DENMARK_TOKEN', '')

# Local file paths (only needed for SI, HR providers)
SLOVENIA_VRT = _normalize_local_path(os.environ.get(
    'SLOVENIA_VRT',
    os.path.join(_BASE_DIR, 'data', 'slovenia', 'slovenia_1m.vrt'),
))
SLOVENIA_REQUIRE_LOCAL = os.environ.get('SLOVENIA_REQUIRE_LOCAL', '0').lower() in ('1', 'true', 'yes', 'on')
CROATIA_DTM = _normalize_local_path(os.environ.get('CROATIA_DTM', ''))

# Optional Slovenia remote fallback
SLOVENIA_WCS_ENABLED = os.environ.get('SLOVENIA_WCS_ENABLED', '0').lower() in ('1', 'true', 'yes', 'on')
SLOVENIA_WCS_URL = os.environ.get('SLOVENIA_WCS_URL', 'https://gis.arso.gov.si/wcs/ows')
SLOVENIA_WCS_COVERAGE_ID = os.environ.get('SLOVENIA_WCS_COVERAGE_ID', 'DTM1')

# Spain tile-chain (MDT01 -> MDT02 -> WCS 5m)
_SPAIN_TILE_BASE = os.environ.get('SPAIN_TILE_STORE_ROOT', os.path.join(_BASE_DIR, 'data', 'spain_tiles'))

SPAIN_TILE_DOWNLOAD_ENABLED = os.environ.get('SPAIN_TILE_DOWNLOAD_ENABLED', '0').lower() in ('1', 'true', 'yes', 'on')
SPAIN_TILE_DOWNLOAD_TIMEOUT_S = int(os.environ.get('SPAIN_TILE_DOWNLOAD_TIMEOUT_S', '30'))
SPAIN_TILE_MAX_BYTES = int(os.environ.get('SPAIN_TILE_MAX_BYTES', str(300 * 1024 * 1024)))  # 300 MB safety cap

SPAIN_MDT01_ENABLED = os.environ.get('SPAIN_MDT01_ENABLED', '0').lower() in ('1', 'true', 'yes', 'on')
SPAIN_MDT01_INDEX_PATH = os.environ.get(
    'SPAIN_MDT01_INDEX_PATH',
    os.path.join(_SPAIN_TILE_BASE, 'mdt01', 'index.json'),
)
SPAIN_MDT01_INDEX_URL = os.environ.get('SPAIN_MDT01_INDEX_URL', '')

SPAIN_MDT02_ENABLED = os.environ.get('SPAIN_MDT02_ENABLED', '0').lower() in ('1', 'true', 'yes', 'on')
SPAIN_MDT02_INDEX_PATH = os.environ.get(
    'SPAIN_MDT02_INDEX_PATH',
    os.path.join(_SPAIN_TILE_BASE, 'mdt02', 'index.json'),
)
SPAIN_MDT02_INDEX_URL = os.environ.get('SPAIN_MDT02_INDEX_URL', '')

# CNIG dynamic tile discovery (Spain MDT datasets)
SPAIN_CNIG_DYNAMIC_DISCOVERY = os.environ.get('SPAIN_CNIG_DYNAMIC_DISCOVERY', '1').lower() in ('1', 'true', 'yes', 'on')
SPAIN_CNIG_BASE_URL = os.environ.get('SPAIN_CNIG_BASE_URL', 'https://centrodedescargas.cnig.es/CentroDescargas').rstrip('/')
SPAIN_CNIG_MAX_DISCOVERY_POINTS = int(os.environ.get('SPAIN_CNIG_MAX_DISCOVERY_POINTS', '36'))
SPAIN_CNIG_DISCOVERY_GRID_DEG = float(os.environ.get('SPAIN_CNIG_DISCOVERY_GRID_DEG', '0.02'))

# Austria tile-chain (AT ALS1 local tiles -> AT DGM5 local tiles)
_AUSTRIA_TILE_BASE = os.environ.get('AUSTRIA_TILE_STORE_ROOT', os.path.join(_BASE_DIR, 'data', 'austria_tiles'))
AUSTRIA_TILE_DOWNLOAD_ENABLED = os.environ.get('AUSTRIA_TILE_DOWNLOAD_ENABLED', '0').lower() in ('1', 'true', 'yes', 'on')
AUSTRIA_TILE_DOWNLOAD_TIMEOUT_S = int(os.environ.get('AUSTRIA_TILE_DOWNLOAD_TIMEOUT_S', '30'))
AUSTRIA_TILE_MAX_BYTES = int(os.environ.get('AUSTRIA_TILE_MAX_BYTES', str(300 * 1024 * 1024)))  # 300 MB safety cap
# Official metadata source for Austria BEV tiles (GeoNetwork OpenAPI).
AUSTRIA_BEV_API_BASE_URL = os.environ.get(
    'AUSTRIA_BEV_API_BASE_URL',
    'https://data.bev.gv.at/geonetwork/srv/api',
).rstrip('/')
AUSTRIA_BEV_SEARCH_SIZE = int(os.environ.get('AUSTRIA_BEV_SEARCH_SIZE', '12'))
# Keep CKAN knobs for backward compatibility with local setups that still use them.
AUSTRIA_CKAN_DYNAMIC_DISCOVERY = os.environ.get('AUSTRIA_CKAN_DYNAMIC_DISCOVERY', '1').lower() in ('1', 'true', 'yes', 'on')
AUSTRIA_CKAN_BASE_URL = os.environ.get('AUSTRIA_CKAN_BASE_URL', 'https://www.data.gv.at/api/3/action').rstrip('/')
AUSTRIA_CKAN_ROWS = int(os.environ.get('AUSTRIA_CKAN_ROWS', '1000'))
AUSTRIA_ALS1_CKAN_QUERY = os.environ.get('AUSTRIA_ALS1_CKAN_QUERY', 'ALS DTM')
AUSTRIA_DGM5_CKAN_QUERY = os.environ.get('AUSTRIA_DGM5_CKAN_QUERY', 'DGM')
AUSTRIA_TILE_URL_ALLOWLIST = tuple(
    h.strip().lower()
    for h in os.environ.get(
        'AUSTRIA_TILE_URL_ALLOWLIST',
        'data.bev.gv.at,bev.gv.at,data.gv.at,www.data.gv.at'
    ).split(',')
    if h.strip()
)
AUSTRIA_ALS1_ENABLED = os.environ.get('AUSTRIA_ALS1_ENABLED', '0').lower() in ('1', 'true', 'yes', 'on')
AUSTRIA_ALS1_INDEX_PATH = os.environ.get(
    'AUSTRIA_ALS1_INDEX_PATH',
    os.path.join(_AUSTRIA_TILE_BASE, 'als1', 'index.json'),
)
AUSTRIA_ALS1_INDEX_URL = os.environ.get('AUSTRIA_ALS1_INDEX_URL', '')
AUSTRIA_DGM5_ENABLED = os.environ.get('AUSTRIA_DGM5_ENABLED', '0').lower() in ('1', 'true', 'yes', 'on')
AUSTRIA_DGM5_INDEX_PATH = os.environ.get(
    'AUSTRIA_DGM5_INDEX_PATH',
    os.path.join(_AUSTRIA_TILE_BASE, 'dgm5', 'index.json'),
)
AUSTRIA_DGM5_INDEX_URL = os.environ.get('AUSTRIA_DGM5_INDEX_URL', '')

# Server
SERVER_PORT = int(os.environ.get('SERVER_PORT', '5050'))
SERVER_HOST = os.environ.get('SERVER_HOST', '127.0.0.1')

# Application config — not secrets, stays here directly
SUPPORTED_COUNTRIES = {
    'SI': 'slovenia',
    'FR': 'france',
    'CH': 'switzerland',
    'ES': 'spain',
    'NL': 'netherlands',
    'GB': 'england',
    'HR': 'croatia',
    'NO': 'norway',
    'FI': 'finland',
    'CA': 'gpxz',
    'DE': 'germany', # Germany — 1m LIDAR, multi-state WCS (GPXZ fallback)
    'US': 'usa',    # USA — 1-10m 3DEP (USGS WCS 1.0.0)
    'EE': 'estonia', # Estonia — 1m WCS 2.0.1
    'DK': 'denmark', # Denmark — 0.4m DHM Terræn
    'PL': 'poland',  # Poland — 1m DGM (GUGiK WCS)
    'AT': 'austria',   # Austria - ALS1 -> DGM5 tiles
    'BE': 'gpxz',   # Belgium — 1-20m
    'AU': 'gpxz',   # Australia — 5m
    'MX': 'gpxz',   # Mexico — 5m
    'HK': 'gpxz',   # Hong Kong — 50cm
    'NZ': 'gpxz',   # New Zealand
}
