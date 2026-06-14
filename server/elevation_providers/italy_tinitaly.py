"""
TINITALY 1.1 — 10m national DTM via INGV GeoServer WCS.

Full coverage of all of Italy including islands.
CRS: EPSG:32632 (UTM zone 32N).
Academic server — be polite with request rates.
No authentication required. CC BY 4.0 license.

NOTE: HTTP endpoint (not HTTPS) — the INGV server's TLS cert may be problematic.
"""
from pyproj import Transformer
from .wcs_base import WCSProvider


class TinitalyProvider(WCSProvider):

    wcs_url = "http://tinitaly.pi.ingv.it/TINItaly_1_1/wcs"
    coverage_id = "TINItaly_1_1__tinitaly_dem"
    subset_x_axis = "E"
    subset_y_axis = "N"
    no_data_value = -9999.0
    max_bbox_size = 5000.0    # 5km side → 500×500 px at 10m
    chunk_delay = 0.5         # polite — academic server
    allow_zero_elevation = True  # Italy has coastline at 0m
    _source_tag = "IT_TINITALY_10M"

    def __init__(self):
        super().__init__()
        self._transformer = Transformer.from_crs(
            "EPSG:4326", "EPSG:32632", always_xy=True
        )

    @property
    def country_code(self) -> str:
        return 'IT'

    @property
    def resolution(self) -> float:
        return 10.0
