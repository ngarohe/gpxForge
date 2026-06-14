"""
South Tyrol (Alto Adige) 2.5m DTM via Civis.bz.it GeoServer WCS 2.0.1.

Province of Bolzano only — covers the Dolomites, Stelvio, Brenner Pass.
CRS: EPSG:25832 (ETRS89/UTM zone 32N).
SUBSET axes: E (easting), N (northing) — standard GeoServer projected CRS labels.
No authentication required. CC0 license.
"""
from pyproj import Transformer
from .wcs_base import WCSProvider


class SouthTyrolProvider(WCSProvider):

    wcs_url = "https://geoservices9.civis.bz.it/geoserver/ows"
    coverage_id = "p_bz-Elevation__DigitalTerrainModel-2.5m"
    subset_x_axis = "E"
    subset_y_axis = "N"
    no_data_value = -9999.0
    max_bbox_size = 2000.0   # 2km side → 800×800 px at 2.5m (~2.5MB TIFF)
    chunk_delay = 0.3
    _source_tag = "IT_BZ_WCS_25"

    def __init__(self):
        super().__init__()
        self._transformer = Transformer.from_crs(
            "EPSG:4326", "EPSG:25832", always_xy=True
        )

    @property
    def country_code(self) -> str:
        return 'IT'

    @property
    def resolution(self) -> float:
        return 2.5
