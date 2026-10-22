# One-time setup: SSH into this PC from your laptop, over Tailscale only (never the open internet).
# Run in an ADMINISTRATOR PowerShell (Start > PowerShell > "Run as administrator"):
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-remote-ssh.ps1 -PublicKey "ssh-ed25519 AAAA... you@laptop"
#
# The public key is the contents of ~/.ssh/id_ed25519.pub on the laptop (create it there with: ssh-keygen -t ed25519).
# What it does:
#   1. installs and starts Windows' OpenSSH Server (starts automatically from now on)
#   2. allows only that key: password login is turned off
#   3. firewall: SSH (port 22) is reachable only from Tailscale addresses (100.64.0.0/10)
#   4. PowerShell as the SSH shell
#   5. no sleep while plugged in (a sleeping PC can't be reached); keep it with -KeepSleep
param(
    [Parameter(Mandatory = $true)][string]$PublicKey,
    [switch]$KeepSleep
)
$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this in an administrator PowerShell (right-click PowerShell > Run as administrator)."
}
if ($PublicKey -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) \S+') {
    throw "That doesn't look like a public key. Paste the one line from ~/.ssh/id_ed25519.pub (starts with ssh-ed25519)."
}

Write-Host "1. OpenSSH Server"
$cap = Get-WindowsCapability -Online -Name "OpenSSH.Server*"
if ($cap.State -ne "Installed") { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service sshd -StartupType Automatic
Start-Service sshd  # creates C:\ProgramData\ssh\sshd_config on first start

Write-Host "2. Key login only"
# Accounts in the Administrators group use this file, not ~/.ssh/authorized_keys.
$keys = "C:\ProgramData\ssh\administrators_authorized_keys"
if (-not (Test-Path $keys) -or -not (Select-String -Path $keys -SimpleMatch $PublicKey.Trim() -Quiet)) {
    Add-Content -Path $keys -Value $PublicKey.Trim() -Encoding ascii
}
icacls $keys /inheritance:r /grant "*S-1-5-32-544:F" /grant "SYSTEM:F" | Out-Null  # sshd ignores the file otherwise

$config = "C:\ProgramData\ssh\sshd_config"
$text = Get-Content $config -Raw
foreach ($setting in @{ PasswordAuthentication = "no"; PubkeyAuthentication = "yes" }.GetEnumerator()) {
    $pattern = "(?m)^#?\s*$($setting.Key)\s+\S+"
    if ($text -match $pattern) { $text = [regex]::Replace($text, $pattern, "$($setting.Key) $($setting.Value)", 1) }
    else { $text = "$($setting.Key) $($setting.Value)`r`n" + $text }  # before any Match block
}
Set-Content -Path $config -Value $text -Encoding ascii

Write-Host "3. Firewall: Tailscale only"
Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue | Disable-NetFirewallRule
if (-not (Get-NetFirewallRule -Name "SSH-Tailscale-Only" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name "SSH-Tailscale-Only" -DisplayName "SSH (Tailscale only)" -Direction Inbound `
        -Protocol TCP -LocalPort 22 -RemoteAddress "100.64.0.0/10" -Action Allow | Out-Null
}

Write-Host "4. PowerShell as the SSH shell"
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -PropertyType String -Force `
    -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" | Out-Null
Restart-Service sshd

if (-not $KeepSleep) {
    Write-Host "5. No sleep while plugged in"
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0
}

$tailscale = "C:\Program Files\Tailscale\tailscale.exe"
$ip = if (Test-Path $tailscale) { (& $tailscale ip -4 2>$null | Select-Object -First 1) } else { $null }
Write-Host ""
if ($ip) {
    Write-Host "Done. From the laptop (signed in to the same Tailscale account):" -ForegroundColor Green
    Write-Host "  ssh $env:USERNAME@$ip"
} else {
    Write-Host "Done, but Tailscale isn't signed in on this PC yet. Open Tailscale from the Start menu and sign in," -ForegroundColor Yellow
    Write-Host "then run:  & '$tailscale' ip -4   and connect with:  ssh $env:USERNAME@<that address>"
}
