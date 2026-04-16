#!/usr/bin/env python3
"""
GPXForge LIDAR Elevation Server
Flask wrapper around the existing elevation engine.

Usage:
    python server.py          # runs on port 5050
    PORT=5051 python server.py

Endpoint:
    POST /api/elevation
      Body: multipart/form-data with field 'file' = GPX file
      Response (success): GPX file with LIDAR elevations
        Headers: X-Summary, X-Countries
      Response (422): unsupported countries
      Response (500): fetch error
"""
import asyncio
import os
import sys
import tempfile

from flask import Flask, request, send_file, send_from_directory, jsonify
from flask_cors import CORS

# Ensure project root is on path (for imports)
sys.path.insert(0, os.path.dirname(__file__))

from config import SUPPORTED_COUNTRIES, SERVER_PORT, SERVER_HOST, SLOVENIA_VRT
FRONTEND_DIR = os.environ.get(
    'FRONTEND_DIR',
    os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist')),
)

from gpx_parser import parse_gpx, write_gpx_fresh
from country_detector import detect_countries, group_points_by_country
from gpx_elevation import get_all_elevations, PROVIDERS, COUNTRY_PROVIDER_CHAINS
from elevation_providers.base import ElevationError


# Verbose mode: pass --verbose on startup or set VERBOSE=1 in environment.
# Prints per-provider source table + WCS chunk diagnostics to server stdout.
VERBOSE = '--verbose' in sys.argv or os.environ.get('VERBOSE', '').lower() in ('1', 'true', 'yes')

app = Flask(__name__)
CORS(app)  # Allow GPXForge browser (localhost:5173 / file://) to call


@app.route('/api/elevation', methods=['POST'])
def elevation():
    if 'file' not in request.files:
        return jsonify({'error': 'No GPX file uploaded — send multipart field "file"'}), 400

    gpx_file = request.files['file']
    if not gpx_file.filename:
        return jsonify({'error': 'Empty filename'}), 400

    # Write upload to temp file
    with tempfile.NamedTemporaryFile(suffix='.gpx', delete=False) as tmp_in:
        gpx_file.save(tmp_in.name)
        input_path = tmp_in.name

    output_path = input_path.replace('.gpx', '_lidar.gpx')

    try:
        # Parse
        points, _gpx = parse_gpx(input_path)
        if not points:
            return jsonify({'error': 'GPX file contains no track points'}), 400

        # Detect countries for the response header (unsupported border countries such as IT
        # are remapped to supported neighbours inside get_all_elevations()).
        countries = detect_countries(points)

        # Fetch elevations — out_points may be resampled (e.g. 1m for local providers)
        out_points, elevations, source_tags = asyncio.run(get_all_elevations(points, verbose=VERBOSE))
        valid_count = sum(1 for e in elevations if e is not None)
        if valid_count == 0:
            raise ElevationError(
                "No elevation values were resolved for this route. "
                "Check provider coverage/index configuration."
            )

        # Write enriched GPX (uses out_points, which may differ from input points)
        write_gpx_fresh(out_points, elevations, output_path)

        # Build summary header (show output point count)
        groups = group_points_by_country(points)
        summary_parts = []
        for cc, indexed_points in sorted(groups.items()):
            provider = PROVIDERS.get(cc)
            res = f'{provider.resolution}m' if provider else '?'
            label = f'{cc}: {len(indexed_points)} pts'
            if provider and provider.is_local:
                label += f' -> ~{round(len(indexed_points) * 3)}pts @ {res} (1m resample)'
            else:
                label += f' @ {res}'
            summary_parts.append(label)
        summary = ' | '.join(summary_parts)
        source_counts = {}
        for tag in source_tags:
            if not tag:
                continue
            source_counts[tag] = source_counts.get(tag, 0) + 1

        download_name = gpx_file.filename.rsplit('.', 1)[0] + '_lidar.gpx'
        response = send_file(
            output_path,
            mimetype='application/gpx+xml',
            as_attachment=True,
            download_name=download_name,
        )
        response.headers['X-Summary'] = summary
        response.headers['X-Countries'] = ','.join(sorted(countries))
        if source_counts:
            if len(source_counts) == 1:
                response.headers['X-Elevation-Source'] = next(iter(source_counts))
            else:
                response.headers['X-Elevation-Source'] = 'MIXED'
            response.headers['X-Elevation-Sources'] = ','.join(
                f'{src}:{count}' for src, count in sorted(source_counts.items())
            )
        response.headers['X-Elevation-Resolved'] = str(valid_count)
        response.headers['X-Elevation-Missing'] = str(max(0, len(elevations) - valid_count))
        response.headers['Access-Control-Expose-Headers'] = (
            'X-Summary, X-Countries, X-Elevation-Source, X-Elevation-Sources, '
            'X-Elevation-Resolved, X-Elevation-Missing'
        )
        return response

    except ElevationError as e:
        app.logger.exception('ElevationError in /api/elevation')
        return jsonify({'error': str(e)}), 500
    except ValueError as e:
        app.logger.exception('Validation error in /api/elevation')
        return jsonify({'error': str(e)}), 422
    except Exception as e:
        app.logger.exception('Unhandled server error in /api/elevation')
        return jsonify({'error': f'Server error: {e}'}), 500
    finally:
        try:
            os.unlink(input_path)
        except OSError:
            pass
        # output_path cleaned up after send_file completes — Flask handles this
        # (send_file streams the file before we reach the finally block)


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'supported_countries': sorted(SUPPORTED_COUNTRIES.keys()),
    })


@app.route('/api/config', methods=['GET'])
def get_config():
    at_chain = [label for label, _ in COUNTRY_PROVIDER_CHAINS.get('AT', [])]
    return jsonify({
        'valhalla_url': os.environ.get('VALHALLA_URL', 'https://valhalla1.openstreetmap.de'),
        'supported_countries': sorted(SUPPORTED_COUNTRIES.keys()),
        'at_chain': at_chain,
        'slovenia_vrt_exists': bool(SLOVENIA_VRT and os.path.exists(SLOVENIA_VRT)),
    })


@app.route('/')
def index():
    return send_from_directory(FRONTEND_DIR, 'simple.html')


@app.route('/expert')
def expert():
    return send_from_directory(FRONTEND_DIR, 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


if __name__ == '__main__':
    print(f'GPXForge LIDAR server starting on http://{SERVER_HOST}:{SERVER_PORT}')
    print(f'Supported countries: {", ".join(sorted(SUPPORTED_COUNTRIES.keys()))}')
    at_chain = "->".join(label for label, _ in COUNTRY_PROVIDER_CHAINS.get('AT', [])) or "<none>"
    print(f'Austria chain: {at_chain}')
    print(f'Slovenia local VRT: {SLOVENIA_VRT} (exists={bool(SLOVENIA_VRT and os.path.exists(SLOVENIA_VRT))})')
    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False)
