"""
Emilia-Romagna 5m DTM via ArcGIS REST ImageServer.

Covers the Emilia-Romagna region: Apennine passes, Po valley, Rimini coast.
Data source: Regione Emilia-Romagna Geoportale, LiDAR-derived DTM (bare earth).
CRS: EPSG:7791 (RDN2008 / UTM zone 32N).
Resolution: 5m × 5m, F32 single band.
No authentication required.
"""
from pyproj import Transformer
from .arcgis_imageserver_base import ArcGISImageServerProvider


class EmiliaRomagnaProvider(ArcGISImageServerProvider):

    service_url = "https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/public/Dtm5x5/ImageServer"
    wkid = 7791
    no_data_value = -9999.0
    max_bbox_size = 5000.0
    chunk_delay = 0.3
    _source_tag = "IT_ER_DTM5"

    def __init__(self):
        super().__init__()
        self._transformer = Transformer.from_crs(
            "EPSG:4326", "EPSG:7791", always_xy=True
        )

    @property
    def country_code(self) -> str:
        return 'IT'

    @property
    def resolution(self) -> float:
        return 5.0
