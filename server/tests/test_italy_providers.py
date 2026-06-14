"""
Tests for Italian elevation providers:
- South Tyrol WCS 2.5m (Province of Bolzano)
- Emilia-Romagna ArcGIS REST 5m (ER region)

Unit tests mock the responses. Integration tests hit the real servers
(marked with @pytest.mark.integration so they can be skipped in CI).
"""
import pytest
import asyncio
from unittest.mock import patch, AsyncMock, MagicMock

# ── Unit tests (mocked) ──────────────────────────────────────────────

class TestSouthTyrolProvider:
    """South Tyrol DTM 2.5m WCS provider."""

    def test_properties(self):
        from elevation_providers.italy_south_tyrol import SouthTyrolProvider
        p = SouthTyrolProvider()
        assert p.country_code == 'IT'
        assert p.resolution == 2.5
        assert p.wcs_url == "https://geoservices9.civis.bz.it/geoserver/ows"
        assert p.coverage_id == "p_bz-Elevation__DigitalTerrainModel-2.5m"

    def test_transformer_converts_to_epsg25832(self):
        from elevation_providers.italy_south_tyrol import SouthTyrolProvider
        p = SouthTyrolProvider()
        x, y = p._transformer.transform(11.3548, 46.4983)
        assert 670000 < x < 690000, f"easting {x} out of range"
        assert 5140000 < y < 5160000, f"northing {y} out of range"

    def test_max_bbox_size(self):
        from elevation_providers.italy_south_tyrol import SouthTyrolProvider
        p = SouthTyrolProvider()
        assert p.max_bbox_size == 2000.0

    def test_no_data_value(self):
        from elevation_providers.italy_south_tyrol import SouthTyrolProvider
        p = SouthTyrolProvider()
        assert p.no_data_value == -9999.0

    def test_source_tag(self):
        from elevation_providers.italy_south_tyrol import SouthTyrolProvider
        p = SouthTyrolProvider()
        assert p._source_tag == "IT_BZ_WCS_25"


class TestEmiliaRomagnaProvider:
    """Emilia-Romagna DTM 5m ArcGIS ImageServer provider."""

    def test_properties(self):
        from elevation_providers.italy_emilia_romagna import EmiliaRomagnaProvider
        p = EmiliaRomagnaProvider()
        assert p.country_code == 'IT'
        assert p.resolution == 5.0
        assert 'Dtm5x5' in p.service_url
        assert p.wkid == 7791

    def test_transformer_converts_to_epsg7791(self):
        from elevation_providers.italy_emilia_romagna import EmiliaRomagnaProvider
        p = EmiliaRomagnaProvider()
        # Bologna: lat 44.4949, lon 11.3426
        x, y = p._transformer.transform(11.3426, 44.4949)
        # RDN2008/UTM32N easting ~680,000, northing ~4,928,000
        assert 670000 < x < 690000, f"easting {x} out of range"
        assert 4920000 < y < 4940000, f"northing {y} out of range"

    def test_source_tag(self):
        from elevation_providers.italy_emilia_romagna import EmiliaRomagnaProvider
        p = EmiliaRomagnaProvider()
        assert p._source_tag == "IT_ER_DTM5"

    def test_no_data_value(self):
        from elevation_providers.italy_emilia_romagna import EmiliaRomagnaProvider
        p = EmiliaRomagnaProvider()
        assert p.no_data_value == -9999.0


# ── Integration wiring tests (no network) ────────────────────────────

class TestItalyProviderChain:
    """Verify Italy is wired into gpx_elevation.py correctly."""

    def test_italy_in_supported_countries(self):
        from config import SUPPORTED_COUNTRIES
        assert 'IT' in SUPPORTED_COUNTRIES

    def test_italy_provider_chain_exists(self):
        from gpx_elevation import COUNTRY_PROVIDER_CHAINS
        assert 'IT' in COUNTRY_PROVIDER_CHAINS
        chain = COUNTRY_PROVIDER_CHAINS['IT']
        assert len(chain) >= 3  # BZ + ER + GPXZ

    def test_chain_first_is_highest_resolution(self):
        # Chain is ordered finest-resolution-first (see CLAUDE.md: "Higher-res
        # providers always first in chain"). The first step must be the finest
        # non-GPXZ provider in the chain.
        from gpx_elevation import COUNTRY_PROVIDER_CHAINS
        chain = COUNTRY_PROVIDER_CHAINS['IT']
        _label, first = chain[0]
        non_gpxz = [p for _l, p in chain if type(p).__name__ != 'GPXZProvider']
        assert first.resolution == min(p.resolution for p in non_gpxz)
        assert first.resolution <= 1.0  # currently Trentino 0.5m

    def test_regional_providers_present(self):
        # South Tyrol (2.5m) and Emilia-Romagna (5m) remain in the chain,
        # regardless of their exact position.
        from gpx_elevation import COUNTRY_PROVIDER_CHAINS
        labels = [lbl for lbl, _ in COUNTRY_PROVIDER_CHAINS['IT']]
        assert any('BZ' in l or 'Tyrol' in l for l in labels)
        assert any('ER' in l or 'Emilia' in l for l in labels)

    def test_chain_last_is_gpxz(self):
        from gpx_elevation import COUNTRY_PROVIDER_CHAINS
        label, provider = COUNTRY_PROVIDER_CHAINS['IT'][-1]
        assert 'GPXZ' in label
        assert type(provider).__name__ == 'GPXZProvider'

    def test_italy_neighbor_countries_updated(self):
        """IT should now be a supported country, not just a neighbor remap target."""
        from gpx_elevation import NEIGHBOR_COUNTRIES
        assert 'IT' in NEIGHBOR_COUNTRIES
        neighbors = NEIGHBOR_COUNTRIES['IT']
        for cc in ['CH', 'AT', 'FR', 'SI']:
            assert cc in neighbors, f"{cc} missing from IT neighbors"
        assert neighbors[0] == 'CH', "CH should be first — fastest fallback for Alpine routes"

    def test_italy_is_neighbor_of_border_countries(self):
        """Border countries should list IT as a neighbor for cross-border fallback."""
        from gpx_elevation import NEIGHBOR_COUNTRIES
        for cc in ['AT', 'SI', 'FR', 'CH']:
            assert 'IT' in NEIGHBOR_COUNTRIES.get(cc, []), \
                f"IT missing from {cc}'s neighbor list"


# ── Live integration tests (hit real servers) ─────────────────────────

@pytest.mark.integration
class TestSouthTyrolLive:
    """Live tests against the real South Tyrol WCS server.
    Run with: pytest server/tests/test_italy_providers.py -m integration -v
    """

    def test_bolzano_elevation(self):
        from elevation_providers.italy_south_tyrol import SouthTyrolProvider
        p = SouthTyrolProvider()
        points = [(46.4983, 11.3548)]
        result = asyncio.run(p.get_elevations(points))
        assert result[0] is not None, "No elevation returned for Bolzano"
        assert 200 < result[0] < 350, f"Bolzano elevation {result[0]}m out of range (expected ~262m)"

    def test_stelvio_pass_elevation(self):
        from elevation_providers.italy_south_tyrol import SouthTyrolProvider
        p = SouthTyrolProvider()
        points = [(46.5287, 10.4531)]
        result = asyncio.run(p.get_elevations(points))
        assert result[0] is not None, "No elevation returned for Stelvio Pass"
        assert 2700 < result[0] < 2850, f"Stelvio elevation {result[0]}m out of range (expected ~2757m)"

    def test_outside_coverage_returns_none(self):
        from elevation_providers.italy_south_tyrol import SouthTyrolProvider
        p = SouthTyrolProvider()
        points = [(41.9028, 12.4964)]
        result = asyncio.run(p.get_elevations(points))
        assert result[0] is None, "Should return None for point outside South Tyrol"

    def test_multi_point_route(self):
        from elevation_providers.italy_south_tyrol import SouthTyrolProvider
        p = SouthTyrolProvider()
        points = [
            (46.6713, 11.1597),
            (46.6750, 11.1550),
            (46.6800, 11.1500),
        ]
        result = asyncio.run(p.get_elevations(points))
        resolved = [e for e in result if e is not None]
        assert len(resolved) >= 2, f"Expected at least 2 resolved points, got {len(resolved)}"
        for e in resolved:
            assert 200 < e < 1500, f"Merano area elevation {e}m out of range"


@pytest.mark.integration
class TestEmiliaRomagnaLive:
    """Live tests against the real Emilia-Romagna ArcGIS ImageServer.
    Run with: pytest server/tests/test_italy_providers.py -m integration -v
    """

    def test_bologna_elevation(self):
        from elevation_providers.italy_emilia_romagna import EmiliaRomagnaProvider
        p = EmiliaRomagnaProvider()
        # Bologna city center: ~54m elevation
        points = [(44.4949, 11.3426)]
        result = asyncio.run(p.get_elevations(points))
        assert result[0] is not None, "No elevation returned for Bologna"
        assert 30 < result[0] < 100, f"Bologna elevation {result[0]}m out of range (expected ~54m)"

    def test_apennine_pass_elevation(self):
        from elevation_providers.italy_emilia_romagna import EmiliaRomagnaProvider
        p = EmiliaRomagnaProvider()
        # Passo della Raticosa (Apennines, on the ER side): ~968m
        points = [(44.1094, 11.3393)]
        result = asyncio.run(p.get_elevations(points))
        assert result[0] is not None, "No elevation returned for Passo della Raticosa"
        assert 400 < result[0] < 1200, f"Raticosa elevation {result[0]}m out of range"

    def test_outside_coverage_returns_none(self):
        from elevation_providers.italy_emilia_romagna import EmiliaRomagnaProvider
        p = EmiliaRomagnaProvider()
        # Sardinia — well outside Emilia-Romagna raster extent
        points = [(39.2238, 9.1217)]
        result = asyncio.run(p.get_elevations(points))
        assert result[0] is None, "Should return None for point outside Emilia-Romagna"

    def test_multi_point_route(self):
        from elevation_providers.italy_emilia_romagna import EmiliaRomagnaProvider
        p = EmiliaRomagnaProvider()
        # Short route near Modena
        points = [
            (44.6471, 10.9252),
            (44.6500, 10.9300),
            (44.6530, 10.9350),
        ]
        result = asyncio.run(p.get_elevations(points))
        resolved = [e for e in result if e is not None]
        assert len(resolved) >= 2, f"Expected at least 2 resolved points, got {len(resolved)}"
        for e in resolved:
            assert 0 < e < 500, f"Modena area elevation {e}m out of range"


