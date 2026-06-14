"""
Tests for Belgium elevation providers:
- Flanders DHM Vlaanderen II 1m (WCS 2.0.1, multipart/related response)
- Wallonia MNT 2021-2022 50cm (ArcGIS MapServer identify + on-disk tile cache)

Unit tests are offline (mocked / pure logic). Integration tests hit the real
servers and are marked so they can be skipped in CI.
"""
import asyncio
import json

import pytest


# ── Flanders ─────────────────────────────────────────────────────────

class TestFlandersDhmProvider:
    def test_properties(self):
        from elevation_providers.belgium_flanders import FlandersDhmProvider
        p = FlandersDhmProvider()
        assert p.country_code == 'BE'
        assert p.resolution == 1.0
        assert p._source_tag == 'BE_FL_DHM_1M'
        assert p.coverage_id == 'EL.GridCoverage.DTM'
        assert p.wcs_url.endswith('/el-dtm/wcs')
        assert p._transformer is None  # geographic CRS, no reprojection

    def test_prefilter_rejects_wallonia_without_network(self):
        # A Wallonia point is outside the Flanders envelope, so get_elevations
        # must short-circuit to None without any HTTP request.
        from elevation_providers.belgium_flanders import FlandersDhmProvider
        p = FlandersDhmProvider()
        out = asyncio.run(p.get_elevations([(50.4372, 5.9714)]))  # Spa
        assert out == [None]

    def test_multipart_tiff_extraction(self):
        from elevation_providers.belgium_flanders import _extract_tiff_from_multipart
        tiff = b'II*\x00' + b'\x08\x00\x00\x00FAKE-TIFF-BODY'
        body = (
            b'--wcs\n'
            b'Content-Type: text/xml\n\n'
            b'<gml>...</gml>\n'
            b'--wcs\n'
            b'Content-Type: image/tiff\n\n'
            + tiff +
            b'\n--wcs--\n'
        )
        out = _extract_tiff_from_multipart(body, 'multipart/related; boundary=wcs')
        assert out == tiff

    def test_extraction_passes_through_bare_tiff(self):
        from elevation_providers.belgium_flanders import _extract_tiff_from_multipart
        bare = b'II*\x00rest-of-tiff'
        assert _extract_tiff_from_multipart(bare, 'image/tiff') == bare

    @pytest.mark.integration
    def test_real_flanders_query(self):
        from elevation_providers.belgium_flanders import FlandersDhmProvider
        p = FlandersDhmProvider()
        out = asyncio.run(p.get_elevations([(50.880, 4.701)]))  # Leuven
        assert out[0] is not None and 0 < out[0] < 100


# ── Wallonia ─────────────────────────────────────────────────────────

class TestWalloniaMntProvider:
    def test_properties(self):
        from elevation_providers.belgium_wallonia import WalloniaMntProvider
        p = WalloniaMntProvider()
        assert p.country_code == 'BE'
        assert p.resolution == 0.5
        assert p._source_tag == 'BE_WAL_MNT_50CM'

    def test_anchor_stride_caps_request_count(self):
        from elevation_providers.belgium_wallonia import WalloniaMntProvider
        p = WalloniaMntProvider()
        # 1000 points at ~1 m spacing → striding to ~8 m target.
        pts = [(50.40 + i * 1e-5, 5.90) for i in range(1000)]
        anchors = p._anchor_indices(pts)
        assert anchors[0] == 0 and anchors[-1] == len(pts) - 1
        assert len(anchors) < len(pts) / 4  # strided well below input count

    def test_anchor_count_hard_capped(self):
        from elevation_providers.belgium_wallonia import WalloniaMntProvider
        p = WalloniaMntProvider()
        pts = [(50.40 + i * 1e-6, 5.90) for i in range(60000)]  # huge, ~0.1 m
        anchors = p._anchor_indices(pts)
        assert len(anchors) <= p.MAX_ANCHORS + 1

    def test_interpolates_between_anchors(self, tmp_path, monkeypatch):
        from elevation_providers.belgium_wallonia import WalloniaMntProvider, _TileCache
        p = WalloniaMntProvider()
        p._cache = _TileCache(tmp_path)  # isolate cache
        p.TARGET_SPACING_M = 8.0

        async def fake_identify(session, sem, lat, lon):
            return lat * 1000.0  # deterministic, monotonic in lat

        monkeypatch.setattr(p, '_identify', fake_identify)
        pts = [(50.40 + i * 9e-5, 5.90) for i in range(20)]  # ~10 m spacing
        out = asyncio.run(p.get_elevations(pts))
        assert all(v is not None for v in out)
        # Monotonic increasing because lat increases monotonically.
        assert all(out[i] <= out[i + 1] + 1e-6 for i in range(len(out) - 1))
        # Endpoints match the (anchored) identify values exactly.
        assert out[0] == pytest.approx(pts[0][0] * 1000.0)
        assert out[-1] == pytest.approx(pts[-1][0] * 1000.0)

    def test_prefilter_rejects_out_of_box(self, tmp_path):
        from elevation_providers.belgium_wallonia import WalloniaMntProvider, _TileCache
        p = WalloniaMntProvider()
        p._cache = _TileCache(tmp_path)
        # A point in the Atlantic — outside Wallonia bbox → None, no network.
        out = asyncio.run(p.get_elevations([(50.0, -30.0), (50.0, -30.001)]))
        assert out == [None, None]

    def test_cache_round_trip(self, tmp_path):
        from elevation_providers.belgium_wallonia import _TileCache
        c = _TileCache(tmp_path)
        hit, _ = c.get(50.4372, 5.9714)
        assert hit is False
        c.put(50.4372, 5.9714, 390.95)
        c.put(50.4400, 5.9650, None)  # NoData is cached too
        c.flush()
        # New cache instance reads persisted tiles from disk.
        c2 = _TileCache(tmp_path)
        hit, val = c2.get(50.4372, 5.9714)
        assert hit is True and val == pytest.approx(390.95)
        hit2, val2 = c2.get(50.4400, 5.9650)
        assert hit2 is True and val2 is None

    @pytest.mark.integration
    def test_real_wallonia_query(self):
        from elevation_providers.belgium_wallonia import WalloniaMntProvider
        p = WalloniaMntProvider()
        out = asyncio.run(p.get_elevations([(50.4372, 5.9714)]))  # Spa
        assert out[0] is not None and 380 < out[0] < 410


# ── Chain wiring ─────────────────────────────────────────────────────

class TestBelgiumChain:
    def test_be_chain_registered(self):
        from gpx_elevation import COUNTRY_PROVIDER_CHAINS
        assert 'BE' in COUNTRY_PROVIDER_CHAINS
        labels = [lbl for lbl, _ in COUNTRY_PROVIDER_CHAINS['BE']]
        assert labels == ['BE Flanders DHM 1m', 'BE Wallonia MNT 50cm']

    def test_be_not_gpxz(self):
        # Belgium must NOT fall back to GPXZ (its BE data is only 20 m).
        from gpx_elevation import COUNTRY_PROVIDER_CHAINS
        for _lbl, prov in COUNTRY_PROVIDER_CHAINS['BE']:
            assert type(prov).__name__ != 'GPXZProvider'
