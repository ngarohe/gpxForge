from abc import ABC, abstractmethod
from typing import List, Tuple


class ElevationError(Exception):
    pass


class ElevationProvider(ABC):
    """Base class for all country elevation providers."""

    is_local = False         # True for local file/VRT providers — skip downsampling
    local_resample_m = 1.0  # Resample spacing used by orchestrator for local providers.
                             # Set to match the file's native resolution (e.g. 20.0 for 20m DTM).
    verbose = False          # Set by orchestrator before calling get_elevations()
    _verbose_log = None      # Populated by provider when verbose=True

    @property
    @abstractmethod
    def country_code(self) -> str:
        """ISO 3166-1 alpha-2 country code."""
        pass

    @property
    @abstractmethod
    def resolution(self) -> float:
        """Nominal resolution in meters."""
        pass

    @abstractmethod
    async def get_elevations(
        self,
        points: List[Tuple[float, float]]  # [(lat, lon), ...]
    ) -> List[float]:
        """Return elevation in meters for each point.
        May return None for points with no valid data (e.g. outside coverage).
        The orchestrator handles cross-border fallback for None entries.
        Raise ElevationError only for hard failures (network, auth, etc.)."""
        pass
