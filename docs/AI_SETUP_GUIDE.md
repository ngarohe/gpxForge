# GPXForge — AI Assistant Setup Guide

This guide is written for AI coding assistants (Claude, Copilot, Cursor, etc.)
helping a user set up GPXForge for the first time. Follow the steps below in
order. Each step tells you what to check, what the expected output looks like,
and what to do if something goes wrong.

---

## Prerequisites

| Tool | Minimum version | Check command |
|------|----------------|---------------|
| Node.js | 18+ | `node --version` |
| npm | 9+ | `npm --version` |
| Python | 3.10+ | `python3 --version` |
| Git | any | `git --version` |

---

## Step 1 — Clone the repository

```bash
git clone https://github.com/ngarohe/gpxforge.git
cd gpxforge
```

---

## Step 2 — Install frontend dependencies

```bash
npm install
```

**Expected output:** `added N packages` with no errors.

**If it fails:** Check that Node.js ≥ 18 is installed. The project uses
ES modules (`"type": "module"` in `package.json`) — Node.js 18+ is required.

---

## Step 3 — Start the frontend dev server

```bash
npm run dev
```

**Expected output:**

```
  VITE v6.x.x  ready in NNNms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

Open `http://localhost:5173/` for Expert mode or
`http://localhost:5173/simple.html` for Simple mode.

Without the LIDAR server (Step 6), you can still load GPX files, use the
Route Builder, run Snap/Brunnels/Clean/Smooth/Split — only the LIDAR
elevation fetch button will fail.

---

## Step 4 — Create the server configuration file

```bash
cd server
cp config.example.py config.py
```

`config.py` is excluded from git (it may contain API keys). The example file
reads all values from environment variables — `config.py` is safe to
commit only if you never put real keys directly in the file.

---

## Step 5 — Configure API keys (optional — only needed for specific countries)

Edit `server/.env` (create it by copying `server/.env.example`):

```bash
cp server/.env.example server/.env
```

Then open `server/.env` and fill in any keys you need:

| Key | Country / Provider | Where to get it |
|-----|--------------------|-----------------|
| `GPXZ_API_KEY` | GB, AU, CA, BE, MX, HK, NZ | https://www.gpxz.io/account (free tier) |
| `FINLAND_API_KEY` | Finland | https://www.maanmittauslaitos.fi/en/rajapinnat/api-avaimen-hallinta (free) |
| `DENMARK_TOKEN` | Denmark | https://dataforsyningen.dk/user/create (free) |

All other countries (France, Germany, Netherlands, Norway, Estonia, Poland,
Slovenia, Switzerland, Spain, USA, Croatia, Austria) work without any key.

---

## Step 6 — Set up the Python environment and start the LIDAR server

```bash
cd server
bash start.sh
```

`start.sh` handles everything:
- Creates a virtual environment at `server/.venv/` if it doesn't exist
- Installs Python dependencies from `requirements.txt`
- Validates that `rasterio`, `pyproj`, `aiohttp`, and `flask` are importable
- Starts the Flask server on `http://127.0.0.1:5050`

**Expected output (first run):**

```
[GPXForge] Creating venv at .venv ...
[GPXForge] Installing requirements ...
[GPXForge] Starting server on 127.0.0.1:5050 ...
 * Running on http://127.0.0.1:5050
```

**Expected output (subsequent runs):**

```
[GPXForge] Requirements up to date.
[GPXForge] Starting server on 127.0.0.1:5050 ...
 * Running on http://127.0.0.1:5050
```

**If rasterio fails to install:** On some systems you need GDAL headers:
- Ubuntu/Debian: `sudo apt-get install libgdal-dev`
- macOS: `brew install gdal`
- Then re-run `start.sh`

---

## Step 7 — Verify the LIDAR server is running

```bash
curl http://127.0.0.1:5050/health
```

**Expected response:** `{"status": "ok"}`

If you get `Connection refused`, the server did not start. Check the terminal
where `start.sh` is running for Python error messages.

---

## Step 8 — Run the tests

```bash
npm run test:run
```

**Expected output:** All tests pass. The test suite covers math utilities,
pipeline processing, chart rendering, and UI construction (450+ tests).

---

## Step 9 — Load a GPX file

1. Open `http://localhost:5173/simple.html` in Chrome or Edge
2. Click **Upload GPX** and choose any `.gpx` file (a sample is in `public/test-route.gpx`)
3. Simple mode will auto-run the pipeline: LIDAR → Brunnels → Clean → Smooth → Simplify
4. When complete, review the elevation chart and click **Download** to export

For manual step-by-step control, use `http://localhost:5173/` (Expert mode).

---

## Troubleshooting

### "LIDAR elevation failed" toast in the browser

The frontend received an error from the LIDAR server. Check the terminal
running `start.sh` for a Python traceback. Common causes:

- **Missing API key** — the route passes through Finland, Denmark, or a
  GPXZ-only country (GB, AU, etc.) and the key is not set in `server/.env`
- **rasterio not installed** — run `pip install rasterio` in the `server/.venv`
  environment or re-run `start.sh`
- **Slovenia VRT missing** — the Slovenia provider requires a local VRT file.
  Set `SLOVENIA_VRT=/path/to/file` in `server/.env` or set
  `SLOVENIA_WCS_ENABLED=1` to use the remote ARSO fallback

### Map does not render

Leaflet requires the map container to have non-zero dimensions at init time.
This usually means the page CSS hasn't loaded. Hard-refresh (`Ctrl+Shift+R`)
and check the browser console for CSS import errors.

### Valhalla routing fails (Snap step)

The Snap step uses `valhalla1.openstreetmap.de`. If routing fails, the step
falls back to straight-line segments between waypoints. Check your internet
connection — Valhalla is a public free service and may have temporary outages.

### Austria tiles not found

Austria uses BEV tile metadata fetched on first use from `data.bev.gv.at`.
If that fetch fails (firewall, no internet), set `AUSTRIA_ALS1_ENABLED=0` in
`server/.env` to skip the Austria provider entirely.

---

## File layout reference

```
gpxforge/
├── index.html          # Expert mode entry
├── simple.html         # Simple mode entry
├── src/
│   ├── main.js         # Expert mode wiring
│   ├── simple.js       # Simple mode orchestrator
│   ├── pipeline/       # Processing steps (0-trim through 5-split)
│   ├── api/            # External API clients (Valhalla, Overpass, LIDAR, ...)
│   ├── chart/          # Canvas elevation chart (11-layer rendering)
│   ├── map/            # Leaflet map (setup, layers, interactions)
│   ├── ui/             # DOM construction (toolbar, panels, corrections)
│   └── utils/          # Pure math and geometry functions
├── server/
│   ├── server.py       # Flask application
│   ├── start.sh        # Startup script (venv + server)
│   ├── config.example.py  # Template — copy to config.py
│   ├── .env.example    # Template — copy to .env
│   ├── requirements.txt
│   └── elevation_providers/  # One class per country
└── tests/unit/         # 450+ Vitest unit tests
```
