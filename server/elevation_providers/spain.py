from .wcs_base import WCSProvider


class SpainProvider(WCSProvider):
    """Spain MDT05 — 5m LIDAR-derived DTM via IDEE WCS 2.0.1.

    Endpoint confirmed working (tested 2026-04-01).
    CoverageId: Elevacion4258_5 (5m, EPSG:4258 ≈ WGS84 — no coordinate transform needed).
    SUBSET axes: Lat / Long (geographic, in degrees).
    """

    wcs_url = "https://servicios.idee.es/wcs-inspire/mdt"
    coverage_id = "Elevacion4258_5"
    subset_x_axis = "Long"   # longitude axis label in EPSG:4258
    subset_y_axis = "Lat"    # latitude axis label in EPSG:4258
    no_data_value = -9999.0
    # ~0.1 deg ~= 8-11 km - keeps GeoTIFF responses manageable (~222x222 px confirmed)
    max_bbox_size = 0.1

    @property
    def country_code(self) -> str:
        return 'ES'

    @property
    def resolution(self) -> float:
        return 5.0
