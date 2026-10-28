# KautionGuard local dev starter (Windows PowerShell).
#
# Launches the FastAPI backend and the Next.js frontend in two windows.
# All paths resolve relative to this script's location (repository root).
#
# Usage: right-click > "Run with PowerShell", or from any terminal:
#   powershell -ExecutionPolicy Bypass -File .\start_dev.ps1
#
# Stopping: close both server windows, or run (IDs are printed on start):
#   Stop-Process -Id <backendPid>,<frontendPid>

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$BackendDir = Join-Path $RepoRoot "backend"
$FrontendDir = Join-Path $RepoRoot "frontend"
$BackendPython = Join-Path $BackendDir ".venv\Scripts\python.exe"

function Fail($message) {
    Write-Host ""
    Write-Host "STARTUP ERROR: $message" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $BackendDir -PathType Container)) {
    Fail "Backend directory not found: $BackendDir"
}
if (-not (Test-Path $FrontendDir -PathType Container)) {
    Fail "Frontend directory not found: $FrontendDir"
}
if (-not (Test-Path $BackendPython -PathType Leaf)) {
    Fail ("Backend interpreter not found: $BackendPython`n" +
        "Create it first (see README 'Local setup'):`n" +
        "  cd backend`n" +
        "  python -m venv .venv`n" +
        "  .\.venv\Scripts\Activate.ps1`n" +
        "  python -m pip install -r requirements.txt")
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js is not on PATH. Install Node.js 20+ and retry."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm is not on PATH. Reinstall Node.js (includes npm) and retry."
}
if (-not (Test-Path (Join-Path $FrontendDir "node_modules") -PathType Container)) {
    Fail ("Frontend dependencies are not installed: $FrontendDir\node_modules is missing.`n" +
        "Install them first:`n" +
        "  cd frontend`n" +
        "  npm install")
}

Write-Host "Starting FastAPI backend from $BackendDir ..."
$backend = Start-Process -FilePath $BackendPython `
    -ArgumentList "-m", "uvicorn", "main:app", "--reload", "--port", "8000" `
    -WorkingDirectory $BackendDir -PassThru

Write-Host "Starting Next.js frontend from $FrontendDir ..."
$frontend = Start-Process -FilePath "npm.cmd" `
    -ArgumentList "run", "dev" `
    -WorkingDirectory $FrontendDir -PassThru

Start-Sleep -Seconds 3
foreach ($proc in @($backend, $frontend)) {
    if ($proc.HasExited -and $proc.ExitCode -ne 0) {
        Write-Host ""
        Write-Host ("WARNING: process $($proc.Id) exited immediately " +
            "with code $($proc.ExitCode). See its window for details.") `
            -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "KautionGuard dev servers launching:" -ForegroundColor Green
Write-Host "  Backend  (PID $($backend.Id)): http://127.0.0.1:8000/docs"
Write-Host "  Frontend (PID $($frontend.Id)): http://localhost:3000"
Write-Host ""
Write-Host "To stop both servers, close their windows or run:"
Write-Host "  Stop-Process -Id $($backend.Id),$($frontend.Id)"
