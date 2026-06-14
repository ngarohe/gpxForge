"""
GB Environment Agency 1m LIDAR Composite DTM Provider

Uses the EA's OGC WCS 2.0.1 endpoint for on-demand 1m elevation queries.
Coverage: ~85% of England and Wales. Scotland and Northern Ireland return
None and fall back to GPXZ automatically via the provider chain.

WCS confirmed working 2026-05-01.
CRS: EPSG:27700 (OSGB36 British National Grid)
Axis labels: E (easting), N (northing) — confirmed from DescribeCoverage
Coverage extent (OSGB36): E [80000, 656000], N [4000, 665000]
Elevation range: -12 m to 1400 m
"""
from typing import List, Optional, Tuple

from pyproj import Transformer

from .wcs_base import WCSProvider
from config import (
    GB_EA_LIDAR_ENABLED,
    GB_EA_LIDAR_WCS_URL,
    GB_EA_LIDAR_WCS_COVERAGE_ID,
)

# EA LIDAR coverage extent in OSGB36 metres (from DescribeCoverage bounding box).
# Points outside this extent (Scotland, NI, offshore) get None and fall to GPXZ.
_E_MIN, _E_MAX = 80000.0, 656000.0
_N_MIN, _N_MAX = 4000.0, 665000.0


class GbEaLidarProvider(WCSProvider):
    """EA 1m LIDAR Composite DTM — WCS 2.0.1 in OSGB36 (EPSG:27700).

    Points outside EA coverage (Scotland, NI) return None; the chain
    automatically falls back to GPXZ for those points.
    """

    dataset_code = 'GB_EA_LIDAR_DTM'
    subset_x_axis = 'E'        # OSGB36 easting (confirmed from DescribeCoverage)
    subset_y_axis = 'N'        # OSGB36 northing
    no_data_value = -9999.0
    max_bbox_size = 5000.0     # 5 km in OSGB36 metres; ~20 chunks for a 100 km route
    chunk_delay = 0.1
    allow_zero_elevation = False

    def __init__(self):
        super().__init__()
        self.enabled = GB_EA_LIDAR_ENABLED
        self.wcs_url = GB_EA_LIDAR_WCS_URL
        self.coverage_id = GB_EA_LIDAR_WCS_COVERAGE_ID
        # always_xy=True → transform(lon, lat) → (easting, northing)
        self._transformer = Transformer.from_crs('EPSG:4326', 'EPSG:27700', always_xy=True)

    @property
    def country_code(self) -> str:
        return 'GB'

    @property
    def resolution(self) -> float:
        return 1.0

    async def get_elevations(self, points: List[Tuple[float, float]]) -> List[Optional[float]]:
        if not points:
            return []
        if not self.enabled:
            return [None] * len(points)

        # Pre-filter: only query WCS for points within the EA coverage extent.
        # The WCS returns HTTP 500 for requests outside the extent (Scotland, NI,
        # offshore), so we skip those and let the chain fall back to GPXZ.
        in_cov = []
        for i, (lat, lon) in enumerate(points):
            e, n = self._transformer.transform(lon, lat)
            if _E_MIN <= e <= _E_MAX and _N_MIN <= n <= _N_MAX:
                in_cov.append(i)

        if not in_cov:
            return [None] * len(points)

        subset = [points[i] for i in in_cov]
        sub_elevs = await super().get_elevations(subset)

        result: List[Optional[float]] = [None] * len(points)
        for sub_i, orig_i in enumerate(in_cov):
            result[orig_i] = sub_elevs[sub_i]
        return result
