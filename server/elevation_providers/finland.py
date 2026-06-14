"""
Finland 2m DTM via Maanmittauslaitos WCS 2.0.1 (EPSG:3067, ETRS-TM35FIN).

Authenticates via api-key URL parameter. SUBSET axes are E (easting) and
N (northing). Inherits WCSProvider — same SUBSET/TIFF pipeline as Netherlands.
"""
from pyproj import Transformer
from .wcs_base import WCSProvider
from .base import ElevationError
from config import FINLAND_API_KEY


class FinlandProvider(WCSProvider):
    """Finland 2m Korkeusmalli DTM — Maanmittauslaitos WCS 2.0.1, EPSG:3067.

    Endpoint requires api-key as a URL query parameter.
    SUBSET axes: E (easting), N (northing).
    max_bbox_size = 500m — avoids oversized rasters at 2m/px.
    allow_zero_elevation = True — Finland has extensive coastline at 0m.
    """

    wcs_url = (
        "https://avoin-karttakuva.maanmittauslaitos.fi"
        "/ortokuvat-ja-korkeusmallit/wcs/v2"
    )
    coverage_id = "korkeusmalli_2m"
    subset_x_axis = "E"
    subset_y_axis = "N"
    no_data_value = -9999.0
    max_bbox_size = 500.0
    allow_zero_elevation = True  # coastlines and lakes are legitimately at 0m

    def __init__(self):
        super().__init__()
        self._transformer = Transformer.from_crs(
            "EPSG:4326", "EPSG:3067", always_xy=True
        )

    @property
    def country_code(self) -> str:
        return 'FI'

    @property
    def resolution(self) -> float:
        return 2.0

    def _extra_params(self) -> dict:
        if not FINLAND_API_KEY:
            raise ElevationError(
                "Finland elevation requires an API key. "
                "Register free at https://www.maanmittauslaitos.fi/en/rajapinnat/api-avaimen-hallinta "
                "then add FINLAND_API_KEY to your config.py"
            )
        return {"api-key": FINLAND_API_KEY}
