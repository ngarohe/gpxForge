@echo off
REM ─────────────────────────────────────────────────────────────────────
REM Portable GPXForge launcher (Windows + WSL).
REM Copy this file to "start-gpxforge.bat" (which is gitignored) and adjust
REM as needed for your machine. %~dp0 expands to this script's folder.
REM ─────────────────────────────────────────────────────────────────────

cd /d "%~dp0"

REM Optional: if you keep local LIDAR rasters on a Windows drive, set the
REM drive letter here so it gets mounted into WSL. Leave blank to skip.
set "GPXFORGE_LIDAR_DRIVE="

if defined GPXFORGE_LIDAR_DRIVE (
  echo [1/4] Mounting %GPXFORGE_LIDAR_DRIVE%: drive in WSL ...
  wsl -e bash -c "d=$(echo %GPXFORGE_LIDAR_DRIVE% | tr A-Z a-z); mkdir -p /mnt/$d && (mountpoint -q /mnt/$d || sudo mount -t drvfs %GPXFORGE_LIDAR_DRIVE%: /mnt/$d 2>/dev/null || mount -t drvfs %GPXFORGE_LIDAR_DRIVE%: /mnt/$d 2>/dev/null)"
) else (
  echo [1/4] No GPXFORGE_LIDAR_DRIVE set - skipping WSL drive mount.
)

echo [2/4] Starting backend ...
REM Convert this folder to a WSL path so the backend starts in ./server
for /f "usebackq delims=" %%i in (`wsl wslpath -a "%~dp0server"`) do set "SERVERDIR=%%i"
start "Backend" wsl -e bash -lc "cd '%SERVERDIR%' && bash start.sh"

echo Waiting for backend ...
:wait_backend
ping -n 2 127.0.0.1 >nul
curl -s -o nul http://127.0.0.1:5050/api/config && goto backend_ready
goto wait_backend
:backend_ready
echo Backend ready.

echo [3/4] Starting frontend ...
start "Vite" /min cmd /c "npm run dev -- --host 127.0.0.1 --port 5173"

echo [4/4] Opening browser in 4s ...
ping -n 5 127.0.0.1 >nul
start "" "http://127.0.0.1:5173"
