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
from .gb_tiles import GbEaLidarProvider
from .scotland_lidar import ScotlandLidarProvider
from .nz_linz import NzLinzProvider
from .ca_hrdem import CaHrdemProvider
from .cz_dmr import CzDmrProvider
from .portugal_tiles import PortugalMDT50cmProvider, PortugalMDT2mProvider
from .japan_tiles import JapanTilesProvider
from .italy_south_tyrol import SouthTyrolProvider
from .italy_emilia_romagna import EmiliaRomagnaProvider
from .italy_tinitaly import TinitalyProvider
from .italy_veneto import ItalyVenetoProvider
from .italy_lombardia import LombardiaProvider
from .italy_piemonte import PiemonteProvider
from .italy_fvg import ItalyFvgProvider
from .italy_trentino import ItalyTrentinoProvider
from .italy_toscana import ToscanaDtm1mProvider, ToscanaDtm10mProvider
from .belgium_flanders import FlandersDhmProvider
from .belgium_wallonia import WalloniaMntProvider
EnglandProvider = GPXZProvider  # backward-compat alias

__all__ = [
    'AustriaALS1Provider', 'AustriaDGM5Provider', 'LombardiaProvider', 'PiemonteProvider',
    'ItalyFvgProvider', 'ItalyTrentinoProvider',
    'ToscanaDtm1mProvider', 'ToscanaDtm10mProvider',
    'CaHrdemProvider', 'CroatiaProvider', 'CzDmrProvider', 'DenmarkProvider', 'ElevationError', 'ElevationProvider',
    'EmiliaRomagnaProvider', 'EnglandProvider', 'EstoniaProvider', 'FinlandProvider', 'FranceProvider', 'ItalyVenetoProvider',
    'GbEaLidarProvider', 'GermanyProvider', 'GPXZProvider', 'ScotlandLidarProvider', 'JapanTilesProvider', 'NetherlandsProvider', 'NorwayProvider',
    'NzLinzProvider', 'PolandProvider', 'PortugalMDT2mProvider', 'PortugalMDT50cmProvider',
    'SloveniaProvider', 'SouthTyrolProvider', 'SpainMDT01Provider', 'SpainMDT02Provider', 'TinitalyProvider',
    'SpainProvider', 'SwitzerlandProvider', 'USAProvider',
    'FlandersDhmProvider', 'WalloniaMntProvider',
]
