# Build the Phase 2 installer skeleton (Inno Setup).
#
#   pwsh -NoProfile -File desktop/build-installer.ps1
#   pwsh -NoProfile -File desktop/build-installer.ps1 -Version 0.2.0
#
# It packages the materialized app layer and the stable shell. DSH itself is
# still a prerequisite; the download/bootstrap step is the next Phase 2 task.
[CmdletBinding()]
param(
    [string]$Version = '0.2.0',
    [string]$AppDir = '',
    [string]$ShellDir = '',
    [string]$OutDir = '',
    [string]$Iscc = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $AppDir) { $AppDir = Join-Path $root "dist\desktop\$Version\app" }
if (-not $ShellDir) { $ShellDir = Join-Path $AppDir 'shell' }
if (-not $OutDir) { $OutDir = Join-Path $root "dist\desktop\$Version" }
$AppDir = [System.IO.Path]::GetFullPath($AppDir)
$ShellDir = [System.IO.Path]::GetFullPath($ShellDir)
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

foreach ($required in @(
    (Join-Path $AppDir 'profile\package.json'),
    (Join-Path $AppDir 'app-manifest.json'),
    (Join-Path $AppDir 'doctor.ps1'),
    (Join-Path $ShellDir 'DshSuite.Shell.exe')
)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "missing installer input: $required. Build the app layer and shell first."
    }
}

if (-not $Iscc) {
    $candidates = @(
        'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
        'C:\Program Files\Inno Setup 6\ISCC.exe',
        'ISCC.exe'
    )
    $Iscc = $candidates | Where-Object {
        if (Test-Path -LiteralPath $_) { return $true }
        return [bool](Get-Command $_ -ErrorAction SilentlyContinue)
    } | Select-Object -First 1
}
if (-not $Iscc) { throw 'Inno Setup 6 (ISCC.exe) was not found. Install it or pass -Iscc <path>.' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$script = Join-Path $PSScriptRoot 'installer\dsh-automation-suite.iss'
Write-Host "building installer: $Version"
Write-Host "  app:   $AppDir"
Write-Host "  shell: $ShellDir"
Write-Host "  out:   $OutDir"

& $Iscc "/DAppVersion=$Version" "/DSourceApp=$AppDir" "/DSourceShell=$ShellDir" "/DOutputDir=$OutDir" $script
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

$setup = Join-Path $OutDir "dsh-automation-suite-setup-$Version.exe"
if (-not (Test-Path -LiteralPath $setup)) { throw "ISCC produced no $setup" }
$size = (Get-Item -LiteralPath $setup).Length
Write-Host ("setup: {0} ({1:N1} MiB)" -f $setup, ($size / 1MB))
