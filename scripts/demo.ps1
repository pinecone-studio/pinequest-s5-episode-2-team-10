# Starts everything for a demo on this PC and checks it works:
#   voice server (speech-to-text on the GPU), FastAPI backend, web app, and Ollama (Gemma).
#
#   powershell -ExecutionPolicy Bypass -File scripts\demo.ps1            # start (stops old copies first)
#   powershell -ExecutionPolicy Bypass -File scripts\demo.ps1 -Tunnel    # also a public URL for the voice server
#   powershell -ExecutionPolicy Bypass -File scripts\demo.ps1 -Stop      # stop everything it started
#
# Logs go to data\demo-logs. Settings come from .env.voice (see voice/README.md).
param(
    [switch]$Tunnel,
    [switch]$Stop,
    # Model for the backend's full analysis: gemma4-base (local Gemma), rules (no LLM), claude.
    [string]$FeedbackModel = "gemma4-base"
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8  # model names contain "·"
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root "data\demo-logs"
New-Item -ItemType Directory -Force $logs | Out-Null

function Stop-Port([int]$port) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        # Only our own kinds of process; never something else that happens to use the port.
        if ($p -and ($p.ProcessName -like "python*" -or $p.ProcessName -in @("node", "uvicorn"))) {
            Stop-Process -Id $p.Id -Force
            Write-Host "  stopped $($p.ProcessName) on port $port"
        }
    }
}

function Wait-Url([string]$name, [string]$url, [int]$seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { Write-Host ("  {0,-14} OK" -f $name) -ForegroundColor Green; return $true }
        } catch { }
        Start-Sleep -Seconds 1
    }
    Write-Host ("  {0,-14} NOT RESPONDING ({1})" -f $name, $url) -ForegroundColor Red
    return $false
}

Write-Host "Stopping old copies..."
Stop-Port 8001; Stop-Port 8000; Stop-Port 3000
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
if ($Stop) { Write-Host "Stopped."; exit 0 }

# Settings: VOICE_SERVER_TOKEN and VOICE_VENV.
$envFile = Join-Path $root ".env.voice"
if (-not (Test-Path $envFile)) { throw "Missing .env.voice. Run scripts\voice.ps1 once to create it." }
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim() }
}
$python = Join-Path $env:VOICE_VENV "Scripts\python.exe"
if (-not (Test-Path $python)) { throw "No Python env at $env:VOICE_VENV (VOICE_VENV in .env.voice)." }
$backendPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $backendPython)) { $backendPython = $python }
& $backendPython -c "import fastapi, sqlmodel, PIL"
if ($LASTEXITCODE -ne 0) {
    throw "Backend Python is missing dependencies. Install them with: .venv\Scripts\python.exe -m pip install -r requirements.txt"
}

# Ollama runs as its own app; start it if it isn't up.
try { Invoke-WebRequest "http://localhost:11434/api/version" -UseBasicParsing -TimeoutSec 3 | Out-Null }
catch {
    $ollamaApp = @("B:\Ollama\ollama app.exe", "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($ollamaApp) { Write-Host "Starting Ollama..."; Start-Process $ollamaApp } else { Write-Host "Ollama isn't installed; Gemma choices will be unavailable." -ForegroundColor Yellow }
}

Write-Host "Starting voice server, backend and web app..."
Start-Process -FilePath $python -WorkingDirectory $root -WindowStyle Hidden `
    -ArgumentList "-m", "uvicorn", "voice.server:app", "--host", "127.0.0.1", "--port", "8001" `
    -RedirectStandardOutput (Join-Path $logs "voice.log") -RedirectStandardError (Join-Path $logs "voice.err.log")

$env:PITCH_ASR = "remote"
$env:PITCH_VOICE_URL = "http://127.0.0.1:8001"
$env:PITCH_VOICE_TOKEN = $env:VOICE_SERVER_TOKEN
$env:PITCH_EMBEDDINGS = "none"
$env:PITCH_DEFAULT_BACKEND = $FeedbackModel
$env:PITCH_CORS_ORIGINS = "http://localhost:3000"
Start-Process -FilePath $backendPython -WorkingDirectory $root -WindowStyle Hidden `
    -ArgumentList "-m", "uvicorn", "backend.main:app", "--port", "8000" `
    -RedirectStandardOutput (Join-Path $logs "api.log") -RedirectStandardError (Join-Path $logs "api.err.log")

Start-Process -FilePath "npm.cmd" -WorkingDirectory (Join-Path $root "web") -WindowStyle Hidden `
    -ArgumentList "run", "dev" `
    -RedirectStandardOutput (Join-Path $logs "web.log") -RedirectStandardError (Join-Path $logs "web.err.log")

if ($Tunnel) {
    $cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
    if (-not $cloudflared) { throw "cloudflared isn't installed (scoop install cloudflared)." }
    $tunnelLog = Join-Path $logs "tunnel.log"
    if (Test-Path $tunnelLog) { Remove-Item $tunnelLog }
    Start-Process -FilePath $cloudflared -WindowStyle Hidden `
        -ArgumentList "tunnel", "--no-autoupdate", "--logfile", ('"' + $tunnelLog + '"'), "--url", "http://127.0.0.1:8001"
}

Write-Host "Checking (the speech model takes ~30 s to load)..."
$ok = (Wait-Url "Ollama" "http://localhost:11434/api/version" 60)
$ok = (Wait-Url "Voice server" "http://127.0.0.1:8001/health" 120) -and $ok
$ok = (Wait-Url "Backend" "http://localhost:8000/api/v1/health" 60) -and $ok
$ok = (Wait-Url "Web app" "http://localhost:3000" 120) -and $ok

# Warm up: the model list also pre-loads Gemma, so the first "send" in the demo doesn't wait.
try {
    $models = (Invoke-WebRequest "http://localhost:3000/api/models" -UseBasicParsing -TimeoutSec 30 -Headers @{ "x-pitch-lang" = "en" }).Content | ConvertFrom-Json
    foreach ($m in $models.models) {
        $state = if ($m.available) { "ready" } else { $m.reason }
        Write-Host ("    {0,-28} {1}" -f $m.name, $state)
    }
} catch { Write-Host "  Couldn't read the model list." -ForegroundColor Yellow }

if ($Tunnel) {
    $url = $null
    for ($i = 0; $i -lt 40 -and -not $url; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path $tunnelLog) {
            $hit = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
            if ($hit) { $url = $hit.Matches[0].Value }
        }
    }
    if ($url) { Write-Host "Voice server tunnel: $url" } else { Write-Host "Tunnel didn't start; see $tunnelLog" -ForegroundColor Yellow }
}

Write-Host ""
if ($ok) { Write-Host "Ready: http://localhost:3000   (logs: data\demo-logs)" -ForegroundColor Green }
else { Write-Host "Something didn't start. Check the logs in data\demo-logs." -ForegroundColor Red; exit 1 }
