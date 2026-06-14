"""
Trentino 0.5m DTM local tiles (CatalogTileProvider).

Source: Provincia Autonoma di Trento SIAT STEM portal — ESRI ASCII .asc files
(LIDAR 2014 survey) converted to GeoTIFF.
CRS: EPSG:25832 (ETRS89 / UTM Zone 32N), 0.5m resolution.
Tiles are 1000×1000 cells = 500m × 500m each.
"""
from .catalog_tiles import CatalogTileProvider
from config import ITALY_TRENTINO_ENABLED, ITALY_TRENTINO_INDEX_PATH


class ItalyTrentinoProvider(CatalogTileProvider):

    def __init__(self):
        super().__init__(
            country_code='IT',
            dataset_code='IT_TRENTINO_05M',
            resolution_m=0.5,
            enabled=ITALY_TRENTINO_ENABLED,
            index_path=ITALY_TRENTINO_INDEX_PATH,
            index_url='',
            download_enabled=False,
            download_timeout_s=30,
            tile_max_bytes=100 * 1024 * 1024,
        )
