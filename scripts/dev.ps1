# Starts the FastAPI API and the Next.js UI for local development (Windows).
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Error "Missing root .venv. Run: py -3.12 -m venv .venv; .venv\Scripts\python -m pip install -r requirements.txt"
}
if (-not (Test-Path ".env")) {
    Write-Error "Missing root .env. Add PITCH_DB_URL before starting the API."
}

$api = Start-Process -PassThru -NoNewWindow -FilePath ".venv\Scripts\python.exe" `
    -ArgumentList "-m", "uvicorn", "backend.main:app", "--reload", "--port", "8000", "--env-file", ".env"
$web = Start-Process -PassThru -NoNewWindow -WorkingDirectory "web" -FilePath "npm.cmd" -ArgumentList "run", "dev"

try {
    Wait-Process -Id $api.Id
} finally {
    foreach ($p in @($api, $web)) {
        if (-not $p.HasExited) { taskkill /PID $p.Id /T /F | Out-Null }
    }
}
