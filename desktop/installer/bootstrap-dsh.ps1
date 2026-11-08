# Download and install the official DeepSeek Harness runtime when it is missing.
#
# Called by the Inno installer before install-profile.ps1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap-dsh.ps1 `
#     -InstallRoot <app>
#
# The download is SHA-512 checked against the official feed and the installer's
# Authenticode signer must be DeepSeek. This script never uses npm/pnpm.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$logDir = Join-Path $InstallRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "bootstrap-dsh-$stamp.log"

function Write-Log {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format 'O'), $Message
    Write-Host $Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

function Find-Dsh {
    $candidates = @(
        $env:DSH_EXE,
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

$dsh = Find-Dsh
if ($dsh) {
    Write-Log "DeepSeek Harness already installed: $dsh"
    exit 0
}

$feedUrl = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml'
Write-Log "fetching official feed: $feedUrl"
$feedResponse = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri $feedUrl
$feedText = if ($feedResponse.Content -is [byte[]]) {
    [System.Text.Encoding]::UTF8.GetString($feedResponse.Content)
} else {
    [string]$feedResponse.Content
}

$version = [regex]::Match($feedText, '(?m)^version:\s*([^\r\n]+)').Groups[1].Value.Trim()
$url = [regex]::Match($feedText, 'url:\s*(?:>-)?\s*\r?\n?\s*(https://\S+)').Groups[1].Value.Trim()
$sha512 = [regex]::Match($feedText, 'sha512:\s*(?:>-)?\s*\r?\n?\s*([^\s]+)').Groups[1].Value.Trim()
if (-not $version -or -not $url -or -not $sha512) {
    throw 'official DSH feed is missing version/url/sha512'
}
$uri = [Uri]$url
if ($uri.Scheme -ne 'https' -or -not ($uri.Host -eq 'download.deepseek.com' -or $uri.Host.EndsWith('.deepseek.com'))) {
    throw "refusing unexpected DSH download host: $($uri.Host)"
}
Write-Log "official DSH version: $version"

$override = $env:DSH_SETUP_OVERRIDE
if ($override) {
    if (-not (Test-Path -LiteralPath $override)) { throw "DSH_SETUP_OVERRIDE not found: $override" }
    $installer = [System.IO.Path]::GetFullPath($override)
    Write-Log "using test override: $installer"
}
else {
    $installer = Join-Path $env:TEMP 'deepseek-harness-setup.exe'
    Write-Log "downloading $url"
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 1800 -Uri $url -OutFile $installer
}

$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA512).Hash
$bytes = New-Object byte[] ($hash.Length / 2)
for ($i = 0; $i -lt $bytes.Length; $i++) {
    $bytes[$i] = [Convert]::ToByte($hash.Substring($i * 2, 2), 16)
}
$actualSha = [Convert]::ToBase64String($bytes)
if ($actualSha -ne $sha512) {
    throw 'DSH installer SHA-512 mismatch'
}
Write-Log 'DSH installer SHA-512 verified'

$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'DeepSeek') {
    throw "DSH installer signature check failed: $($signature.Status) / $($signature.SignerCertificate.Subject)"
}
Write-Log 'DSH installer Authenticode verified'

if ($VerifyOnly) {
    Write-Log 'verify-only requested; not installing'
    exit 0
}

Write-Log 'running DSH installer silently'
$process = Start-Process -FilePath $installer -ArgumentList @('/S') -PassThru
if (-not $process.WaitForExit(600000)) {
    try { $process.Kill() } catch { }
    throw 'DSH installer timed out after 600 s'
}
Write-Log "DSH installer exit code: $($process.ExitCode)"
if ($process.ExitCode -ne 0) {
    throw "DSH installer failed with exit code $($process.ExitCode)"
}

for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    $dsh = Find-Dsh
    if ($dsh) { break }
}
if (-not $dsh) { throw 'DSH was not installed by the official installer' }

$installedVersion = $null
try {
    $installedVersion = (& $dsh --version 2>&1 | Out-String).Trim()
    Write-Log "DSH reports: $installedVersion"
}
catch {
    Write-Log "could not read DSH version: $($_.Exception.Message)"
}

[ordered]@{
    version = $version
    url = $url
    sha512 = $sha512
    installer = $installer
    dshExe = $dsh
    installedVersion = $installedVersion
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot 'install-dsh.json') -Encoding utf8

Write-Log "DeepSeek Harness installed: $dsh"
