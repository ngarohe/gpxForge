from pyproj import Transformer
from .wcs_base import WCSProvider


class EstoniaProvider(WCSProvider):
    """Estonia 1m DTM — Maaamet WCS 2.0.1, EPSG:3301 (L-EST97).

    No authentication required.
    SUBSET axes: x (easting), y (northing) — WCSProvider defaults.
    max_bbox_size = 500m — keeps tiles at 500x500px at 1m/px.
    allow_zero_elevation = True — Estonia has coastal areas at 0m.
    """

    wcs_url = "https://teenus.maaamet.ee/ows/wcs-dtm"
    coverage_id = "dtm-1"
    subset_x_axis = "x"
    subset_y_axis = "y"
    no_data_value = -500.0   # Estonia max depth ~0m; anything below -500 is a sentinel
    max_bbox_size = 500.0
    allow_zero_elevation = True

    def __init__(self):
        super().__init__()
        self._transformer = Transformer.from_crs(
            "EPSG:4326", "EPSG:3301", always_xy=True
        )

    @property
    def country_code(self) -> str:
        return 'EE'

    @property
    def resolution(self) -> float:
        return 1.0
