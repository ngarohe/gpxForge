from coord_transform import wgs84_to_rd
from .wcs_base import WCSProvider


class NetherlandsProvider(WCSProvider):
    """Netherlands AHN4 DTM — 0.5m via PDOK WCS 2.0.1.

    Endpoint confirmed working (tested 2026-04-01).
    WCS 2.0.1 with x/y axes in RD New (EPSG:28992) returns raw GeoTIFF.
    Note: WCS 1.1.1 returns multipart/mixed — use 2.0.1 to get raw TIFF.
    """

    wcs_url = "https://service.pdok.nl/rws/ahn/wcs/v1_0"
    coverage_id = "dtm_05m"
    subset_x_axis = "x"
    subset_y_axis = "y"
    no_data_value = 3.4028234663852886e+38  # PDOK nodata sentinel
    max_bbox_size = 500.0    # 500m in RD New metres — 1000×1000px at 0.5m res
    allow_zero_elevation = True  # Netherlands is partly below sea level

    def __init__(self):
        super().__init__()
        self._transformer = wgs84_to_rd

    @property
    def country_code(self) -> str:
        return 'NL'

    @property
    def resolution(self) -> float:
        return 0.5

    def _extra_params(self) -> dict:
        # Force WCS 2.0.1 (server defaults to 2.0.1 anyway but be explicit)
        return {}
