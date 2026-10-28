# Starts the local voice server (BuzzASR on this PC's GPU) and, with -Tunnel, a Cloudflare tunnel to it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\voice.ps1            # local only, http://127.0.0.1:8001
#   powershell -ExecutionPolicy Bypass -File scripts\voice.ps1 -Tunnel    # plus a public https URL
#
# Settings live in .env.voice at the repository root (created on first run, not committed):
#   VOICE_SERVER_TOKEN   shared secret; the API sends it as PITCH_VOICE_TOKEN
#   VOICE_VENV           Python env with torch + voice/requirements.txt
#   VOICE_TUNNEL_NAME    optional named Cloudflare tunnel (stable URL); empty = quick tunnel (new URL each run)
param(
    [switch]$Tunnel,
    [int]$Port = 8001
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = Join-Path $root ".env.voice"
if (-not (Test-Path $envFile)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    @(
        "VOICE_SERVER_TOKEN=$token",
        "VOICE_VENV=B:\pinequest-data\voice-venv",
        "VOICE_TUNNEL_NAME="
    ) | Set-Content -Encoding utf8 $envFile
    Write-Host "Created .env.voice with a new VOICE_SERVER_TOKEN."
}
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
        Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim()
    }
}
# The voice proxy forwards to Ollama running on this PC.
$env:OLLAMA_URL = "http://127.0.0.1:11434"

$python = Join-Path $env:VOICE_VENV "Scripts\python.exe"
if (-not (Test-Path $python)) {
    throw "No Python env at $env:VOICE_VENV. See voice/README.md to create it."
}

$logDir = Join-Path $root "data\voice"
New-Item -ItemType Directory -Force $logDir | Out-Null

Write-Host "Starting voice server on http://127.0.0.1:$Port (loading the model takes ~30 s)..."
$server = Start-Process -FilePath $python -PassThru -NoNewWindow `
    -ArgumentList "-m", "uvicorn", "voice.server:app", "--host", "127.0.0.1", "--port", "$Port"

$tunnelProc = $null
try {
    if ($Tunnel) {
        if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
            throw "cloudflared is not installed. Run: scoop install cloudflared (or winget install Cloudflare.cloudflared)"
        }
        $log = Join-Path $logDir "tunnel.log"
        if (Test-Path $log) { Remove-Item $log }
        # Start-Process does not quote arguments, and the repo path may contain spaces.
        $quotedLog = '"' + $log + '"'
        if ($env:VOICE_TUNNEL_NAME) {
            $tunnelArgs = @("tunnel", "--no-autoupdate", "--logfile", $quotedLog, "run", "--url", "http://127.0.0.1:$Port", $env:VOICE_TUNNEL_NAME)
        } else {
            $tunnelArgs = @("tunnel", "--no-autoupdate", "--logfile", $quotedLog, "--url", "http://127.0.0.1:$Port")
        }
        $cloudflared = (Get-Command cloudflared).Source
        $tunnelProc = Start-Process -FilePath $cloudflared -ArgumentList $tunnelArgs -PassThru -WindowStyle Hidden

        if (-not $env:VOICE_TUNNEL_NAME) {
            $url = $null
            for ($i = 0; $i -lt 60 -and -not $url; $i++) {
                Start-Sleep -Seconds 1
                if (Test-Path $log) {
                    $hit = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
                    if ($hit) { $url = $hit.Matches[0].Value }
                }
            }
            if (-not $url) { throw "Tunnel did not start. See $log" }
            Write-Host ""
            Write-Host "Voice server is public at: $url"
            Write-Host "Set these where the API runs (.env):"
            Write-Host "  PITCH_ASR=remote"
            Write-Host "  PITCH_VOICE_URL=$url"
            Write-Host "  PITCH_VOICE_TOKEN=<VOICE_SERVER_TOKEN from .env.voice>"
            Write-Host "This quick-tunnel URL changes every run. Set VOICE_TUNNEL_NAME for a stable one."
            Write-Host ""
        } else {
            Write-Host "Named tunnel '$env:VOICE_TUNNEL_NAME' started. Log: $log"
        }
    }
    Write-Host "Press Ctrl+C to stop."
    Wait-Process -Id $server.Id
} finally {
    if ($tunnelProc -and -not $tunnelProc.HasExited) { Stop-Process -Id $tunnelProc.Id -Force }
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
