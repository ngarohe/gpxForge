import os
import asyncio
from typing import List, Tuple, Optional
from pyproj import Transformer
from .base import ElevationProvider, ElevationError

try:
    import rasterio
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False

from config import CROATIA_DTM

_NODATA_VALUE = -32767.0


class CroatiaProvider(ElevationProvider):
    """Croatia 20m DTM from Sonny's LIDAR collection (EPSG:32633, UTM zone 33N).

    Sampled via rasterio ds.sample() to avoid loading the full raster into RAM.

    is_local = True: no network, no rate limits.
    local_resample_m = 20.0: orchestrator resamples route to 20m before querying,
    matching the file's native resolution.
    """

    is_local = True
    local_resample_m = 20.0

    def __init__(self):
        self._transformer = Transformer.from_crs("EPSG:4326", "EPSG:32633", always_xy=True)

    @property
    def country_code(self) -> str:
        return 'HR'

    @property
    def resolution(self) -> float:
        return 20.0

    async def get_elevations(
        self, points: List[Tuple[float, float]]
    ) -> List[Optional[float]]:
        if not RASTERIO_AVAILABLE:
            raise ElevationError("rasterio is required for Croatia DTM")
        if not CROATIA_DTM:
            raise ElevationError(
                "CROATIA_DTM not set — add it to .env or set the environment variable."
            )
        if not os.path.exists(CROATIA_DTM):
            raise ElevationError(
                f"Croatia DTM not found at expected path: {CROATIA_DTM}\n"
                f"Mount the drive or update CROATIA_DTM in .env."
            )
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._sample_dtm, points)

    def _sample_dtm(
        self, points: List[Tuple[float, float]]
    ) -> List[Optional[float]]:
        result: List[Optional[float]] = [None] * len(points)

        with rasterio.open(CROATIA_DTM) as ds:
            ds_nodata = ds.nodata
            left, bottom, right, top = ds.bounds

            # Transform (lat, lon) → UTM 33N (x, y) and filter to raster extent.
            valid_indices: List[int] = []
            valid_xy: List[Tuple[float, float]] = []
            for i, (lat, lon) in enumerate(points):
                x, y = self._transformer.transform(lon, lat)
                if left <= x <= right and bottom <= y <= top:
                    valid_indices.append(i)
                    valid_xy.append((x, y))

            if not valid_xy:
                return result

            for idx, vals in zip(valid_indices, ds.sample(valid_xy)):
                val = float(vals[0])
                if (
                    (ds_nodata is not None and val == ds_nodata)
                    or val <= _NODATA_VALUE
                    or val != val  # NaN
                ):
                    continue  # leave as None — orchestrator handles fallback
                result[idx] = val

        return result
