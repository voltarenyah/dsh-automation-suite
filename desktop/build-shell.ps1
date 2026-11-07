# Build the WebView2 shell and publish it into the materialized app layer.
#
#   pwsh -NoProfile -File desktop/build-shell.ps1
#   pwsh -NoProfile -File desktop/build-shell.ps1 -Version 0.2.0
#   pwsh -NoProfile -File desktop/build-shell.ps1 -SmokeTest
#
# Requirements: .NET 10 SDK (the per-user %USERPROFILE%\.dotnet10 copy is found
# automatically) and an app layer built by scripts/build-app-layer.mjs.
[CmdletBinding()]
param(
    [string]$Version = '0.2.0',
    [string]$AppDir = '',
    [string]$Dotnet = '',
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $PSScriptRoot 'DshSuite.Shell\DshSuite.Shell.csproj'
if (-not $AppDir) { $AppDir = Join-Path $root "dist\desktop\$Version\app" }
$AppDir = [System.IO.Path]::GetFullPath($AppDir)
$shellOut = Join-Path $AppDir 'shell'

if (-not (Test-Path (Join-Path $AppDir 'profile\package.json'))) {
    throw "app layer not found at $AppDir. Run scripts/build-app-layer.mjs --version $Version first."
}

if (-not $Dotnet) {
    $userLocal = Join-Path $env:USERPROFILE '.dotnet10\dotnet.exe'
    $Dotnet = if (Test-Path $userLocal) { $userLocal } else { 'dotnet' }
}
if (-not (Get-Command $Dotnet -ErrorAction SilentlyContinue) -and -not (Test-Path $Dotnet)) {
    throw "dotnet not found. Install the .NET 10 SDK or pass -Dotnet <path>."
}

if (Test-Path $shellOut) { Remove-Item -LiteralPath $shellOut -Recurse -Force }
New-Item -ItemType Directory -Force -Path $shellOut | Out-Null

Write-Host "publishing $project -> $shellOut"
& $Dotnet publish $project -c $Configuration -r win-x64 --self-contained true `
    -p:DebugType=None -o $shellOut --nologo -v minimal
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

$exe = Join-Path $shellOut 'DshSuite.Shell.exe'
if (-not (Test-Path $exe)) { throw "publish produced no $exe" }
$size = (Get-ChildItem $shellOut -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("shell: {0} ({1:N1} MiB)" -f $exe, ($size / 1MB))

if ($SmokeTest) {
    $homeDir = Join-Path $env:TEMP ("dsh-shell-smoke-" + [Guid]::NewGuid().ToString('N'))
    try {
        Write-Host "smoke: $exe --smoke-test --dsh-home $homeDir"
        $process = Start-Process -FilePath $exe -ArgumentList @('--smoke-test', '--dsh-home', $homeDir) -Wait -PassThru
        $resultPath = Join-Path $homeDir 'smoke-result.json'
        if (Test-Path $resultPath) { Get-Content $resultPath -Raw | Write-Host }
        if ($process.ExitCode -ne 0) { throw "shell smoke test failed with exit code $($process.ExitCode)" }
        $result = Get-Content $resultPath -Raw | ConvertFrom-Json
        if (-not $result.ok) { throw "shell smoke test reported failure: $($result.error)" }
        Write-Host 'shell smoke test: OK'
    }
    finally {
        # The shell copies node_modules; remove links safely on Windows.
        if (Test-Path $homeDir) { cmd /c rmdir /s /q "$homeDir" }
    }
}
