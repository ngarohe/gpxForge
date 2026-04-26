from .base import ElevationProvider, ElevationError
from .france import FranceProvider
from .switzerland import SwitzerlandProvider
from .slovenia import SloveniaProvider
from .spain import SpainProvider
from .netherlands import NetherlandsProvider
from .gpxz import GPXZProvider
from .croatia import CroatiaProvider
from .norway import NorwayProvider
from .finland import FinlandProvider
from .usa import USAProvider
from .estonia import EstoniaProvider
from .denmark import DenmarkProvider
from .germany import GermanyProvider
from .poland import PolandProvider
from .spain_tiles import SpainMDT01Provider, SpainMDT02Provider
from .austria_tiles import AustriaALS1Provider, AustriaDGM5Provider
EnglandProvider = GPXZProvider  # backward-compat alias

__all__ = [
    'AustriaALS1Provider', 'AustriaDGM5Provider',
    'CroatiaProvider', 'DenmarkProvider', 'ElevationError', 'ElevationProvider',
    'EnglandProvider', 'EstoniaProvider', 'FinlandProvider', 'FranceProvider',
    'GermanyProvider', 'GPXZProvider', 'NetherlandsProvider', 'NorwayProvider',
    'PolandProvider', 'SloveniaProvider', 'SpainMDT01Provider', 'SpainMDT02Provider',
    'SpainProvider', 'SwitzerlandProvider', 'USAProvider',
]
