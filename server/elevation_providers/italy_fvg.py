"""
Friuli Venezia Giulia 1m DTM local tiles (CatalogTileProvider).

Source: Regione FVG IRDAT geoportal — ESRI ASCII .asc files (LIDAR 2006-2010
survey) converted to GeoTIFF.
CRS: EPSG:6708 (RDN2008 / TM Zone 33N), 1m resolution.
Tiles correspond to 1:5000 CTRN sheets, roughly 1.4km × 1.7km each.
"""
from .catalog_tiles import CatalogTileProvider
from config import ITALY_FVG_ENABLED, ITALY_FVG_INDEX_PATH


class ItalyFvgProvider(CatalogTileProvider):

    def __init__(self):
        super().__init__(
            country_code='IT',
            dataset_code='IT_FVG_1M',
            resolution_m=1.0,
            enabled=ITALY_FVG_ENABLED,
            index_path=ITALY_FVG_INDEX_PATH,
            index_url='',
            download_enabled=False,
            download_timeout_s=30,
            tile_max_bytes=100 * 1024 * 1024,
        )
