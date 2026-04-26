#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR="$SCRIPT_DIR/.venv"
RUN_DIR="$SCRIPT_DIR/.run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
REQ_FILE="$SCRIPT_DIR/requirements.txt"
REQ_STAMP="$VENV_DIR/.requirements.sha256"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

dotenv_get() {
  local key="$1"
  local file="$2"
  [ -f "$file" ] || return 1
  local line
  line="$(grep -m1 -E "^[[:space:]]*${key}=" "$file" || true)"
  [ -n "$line" ] || return 1
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

derive_mount_from_local_path() {
  local local_path="$1"
  if [ -z "$local_path" ]; then
    return
  fi

  # /mnt/e/... style
  if [[ "$local_path" =~ ^/mnt/([a-zA-Z])(/.*)?$ ]]; then
    local drive="${BASH_REMATCH[1]}"
    local lower_drive
    lower_drive="$(printf '%s' "$drive" | tr 'A-Z' 'a-z')"
    MOUNT_DRIVE="$drive"
    MOUNT_PATH="/mnt/$lower_drive"
    return
  fi

  # Windows E:\... or E:/... style
  if [[ "$local_path" =~ ^([a-zA-Z]):[\\/].*$ ]]; then
    local drive="${BASH_REMATCH[1]}"
    local lower_drive
    lower_drive="$(printf '%s' "$drive" | tr 'A-Z' 'a-z')"
    MOUNT_DRIVE="$drive"
    MOUNT_PATH="/mnt/$lower_drive"
  fi
}

ensure_venv() {
  require_cmd python3
  require_cmd sha256sum

  # Rebuild incompatible virtualenvs (for example a Windows-created .venv
  # used from WSL, which has Scripts/ instead of bin/).
  if [ -d "$VENV_DIR" ] && [ ! -f "$VENV_DIR/bin/activate" ]; then
    echo "Detected incompatible backend virtual environment at $VENV_DIR"
    echo "Recreating WSL-compatible backend virtual environment..."
    rm -rf "$VENV_DIR"
  fi

  if [ ! -d "$VENV_DIR" ]; then
    echo "Creating backend virtual environment: $VENV_DIR"
    if ! python3 -m venv "$VENV_DIR"; then
      echo "Failed to create virtual environment."
      echo "Install venv support (for Ubuntu/WSL: sudo apt install python3-venv) and retry."
      exit 1
    fi
  fi

  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"

  local req_hash=""
  local installed_hash=""
  req_hash="$(sha256sum "$REQ_FILE" | awk '{print $1}')"
  if [ -f "$REQ_STAMP" ]; then
    installed_hash="$(cat "$REQ_STAMP" 2>/dev/null || true)"
  fi

  if [ "$req_hash" != "$installed_hash" ]; then
    echo "Installing backend dependencies from requirements.txt..."
    python -m pip install --upgrade pip setuptools wheel
    python -m pip install -r "$REQ_FILE"
    printf "%s" "$req_hash" > "$REQ_STAMP"
  fi
}

verify_runtime() {
  python - <<'PY'
import importlib.util
import sys

required = [
    "flask",
    "flask_cors",
    "gpxpy",
    "aiohttp",
    "rasterio",
    "pyproj",
    "reverse_geocoder",
    "numpy",
    "shapely",
    "dotenv",
    "shapefile",
]
missing = [name for name in required if importlib.util.find_spec(name) is None]
if missing:
    sys.exit("Missing Python modules in backend venv: " + ", ".join(missing))
PY
}

stop_previous_if_owned() {
  mkdir -p "$RUN_DIR"
  if [ ! -f "$PID_FILE" ]; then
    return
  fi

  local old_pid
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$old_pid" ]; then
    rm -f "$PID_FILE"
    return
  fi

  if ps -p "$old_pid" >/dev/null 2>&1; then
    echo "Stopping previous GPXForge backend (PID $old_pid)..."
    kill "$old_pid" 2>/dev/null || true
    for _ in {1..20}; do
      if ! ps -p "$old_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
    done
    if ps -p "$old_pid" >/dev/null 2>&1; then
      echo "Previous backend did not exit gracefully, forcing stop."
      kill -9 "$old_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
}

cleanup() {
  if [ "${_GPXFORGE_CLEANED_UP:-0}" = "1" ]; then
    return
  fi
  _GPXFORGE_CLEANED_UP=1
  if [ -n "${ELEV_PID:-}" ] && ps -p "$ELEV_PID" >/dev/null 2>&1; then
    kill "$ELEV_PID" 2>/dev/null || true
    wait "$ELEV_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

# Optional helper for local setups that keep rasters on a Windows drive.
# Example:
#   GPXFORGE_AUTO_MOUNT_DRIVE=E
#   GPXFORGE_AUTO_MOUNT_PATH=/mnt/e
MOUNT_DRIVE="${GPXFORGE_AUTO_MOUNT_DRIVE:-}"
MOUNT_PATH="${GPXFORGE_AUTO_MOUNT_PATH:-}"

# Auto-derive mount target from SLOVENIA_VRT for local Slovenia setups.
# This keeps public defaults clean while making local VRT usage reliable.
if [ -z "$MOUNT_DRIVE" ]; then
  SLO_LOCAL="${SLOVENIA_VRT:-}"
  if [ -z "$SLO_LOCAL" ]; then
    SLO_LOCAL="$(dotenv_get "SLOVENIA_VRT" "$SCRIPT_DIR/.env" || true)"
  fi
  derive_mount_from_local_path "$SLO_LOCAL"
fi

if [ -n "$MOUNT_DRIVE" ]; then
  MOUNT_DRIVE="${MOUNT_DRIVE%:}"
  if [ -z "$MOUNT_PATH" ]; then
    lower_drive="$(printf '%s' "$MOUNT_DRIVE" | tr 'A-Z' 'a-z')"
    MOUNT_PATH="/mnt/$lower_drive"
  fi
  mkdir -p "$MOUNT_PATH"
  if ! mountpoint -q "$MOUNT_PATH"; then
    if mount -t drvfs "${MOUNT_DRIVE}:" "$MOUNT_PATH" >/dev/null 2>&1; then
      :
    elif command -v sudo >/dev/null 2>&1; then
      sudo mount -t drvfs "${MOUNT_DRIVE}:" "$MOUNT_PATH" >/dev/null 2>&1 || true
    fi
  fi
  if ! mountpoint -q "$MOUNT_PATH"; then
    echo "Warning: could not mount ${MOUNT_DRIVE}: at ${MOUNT_PATH}."
    echo "Local rasters on that drive may be unavailable in this session."
  fi
fi

ensure_venv
verify_runtime
stop_previous_if_owned
mkdir -p "$RUN_DIR"
touch "$LOG_FILE"

export PYTHONUNBUFFERED=1
python server.py >>"$LOG_FILE" 2>&1 &
ELEV_PID=$!
echo "$ELEV_PID" > "$PID_FILE"

echo ""
echo "GPXForge server started (PID $ELEV_PID)"
echo "URL: http://localhost:5050"
echo "Log: $LOG_FILE"
echo "Press Ctrl+C to stop"
echo ""

trap cleanup INT TERM EXIT
wait "$ELEV_PID"
