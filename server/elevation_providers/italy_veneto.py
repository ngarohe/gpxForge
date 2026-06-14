"""
Veneto 5m DTM local tiles (CatalogTileProvider).

Source: Regione Veneto IDT geoportal — ESRI ASCII .asc files converted to GeoTIFF.
CRS: EPSG:6876 (RDN2008 / Zone 12 N-E), 5m resolution.
Tiles are 2km × 2km (400×400 cells).
"""
from .catalog_tiles import CatalogTileProvider
from config import ITALY_VENETO_ENABLED, ITALY_VENETO_INDEX_PATH


class ItalyVenetoProvider(CatalogTileProvider):

    def __init__(self):
        super().__init__(
            country_code='IT',
            dataset_code='IT_VENETO_5M',
            resolution_m=5.0,
            enabled=ITALY_VENETO_ENABLED,
            index_path=ITALY_VENETO_INDEX_PATH,
            index_url='',
            download_enabled=False,
            download_timeout_s=30,
            tile_max_bytes=50 * 1024 * 1024,
        )
