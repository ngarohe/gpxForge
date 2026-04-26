@echo off
setlocal

set "REPO_DIR=%~dp0"
if "%REPO_DIR:~-1%"=="\" set "REPO_DIR=%REPO_DIR:~0,-1%"
cd /d "%REPO_DIR%"

for /f "delims=" %%I in ('wsl wslpath "%REPO_DIR%"') do set "WSL_REPO_DIR=%%I"
if not defined WSL_REPO_DIR (
  echo Failed to resolve repo path in WSL. Make sure WSL is installed and running.
  exit /b 1
)

if not exist "%REPO_DIR%\node_modules\vite\bin\vite.js" (
  echo Installing frontend dependencies...
  npm.cmd install
  if errorlevel 1 (
    echo Frontend dependency install failed.
    exit /b 1
  )
)

if not exist "%REPO_DIR%\node_modules\esbuild\bin\esbuild.exe" (
  echo Rebuilding esbuild...
  npm.cmd rebuild esbuild
  if errorlevel 1 (
    echo esbuild rebuild failed.
    exit /b 1
  )
)

echo Starting GPXForge backend on http://localhost:5050 ...
start "GPXForge LIDAR Server" wsl -e bash -lc "cd '%WSL_REPO_DIR%/server' && bash start.sh"

echo Starting GPXForge frontend on http://127.0.0.1:5173 ...
start "GPXForge Frontend" cmd /k "pushd \"%REPO_DIR%\" && npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort"

timeout /t 5 /nobreak >nul
start "" http://127.0.0.1:5173/expert
