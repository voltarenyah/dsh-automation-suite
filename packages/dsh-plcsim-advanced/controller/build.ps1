# Builds the PLCSIM Advanced controller into controller/bin.
#
#   pwsh -NoProfile -File controller/build.ps1
#   pwsh -NoProfile -File controller/build.ps1 -PlcsimApiDir 'C:\...\API\4.0'
#
# Requires the .NET SDK (net48 targeting pack) and a PLCSIM Advanced install
# containing API\4.0. The API DLL is referenced, not copied.
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$PlcsimApiDir = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $here 'PlcsimAdvanced.Controller.csproj'
$output = Join-Path $here 'bin'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'The .NET SDK (dotnet) was not found on PATH.'
}

$arguments = @('build', $project, '-c', $Configuration, '-o', $output, '--nologo', '-v', 'minimal')
if ($PlcsimApiDir) { $arguments += "-p:PlcsimApiDir=$PlcsimApiDir" }

Write-Host "Building $project ($Configuration) -> $output"
& dotnet @arguments
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed with exit code $LASTEXITCODE" }

$exe = Join-Path $output 'PlcsimAdvanced.Controller.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "The build produced no executable at $exe" }

Write-Host ''
Write-Host "Built: $exe"
Write-Host 'Running the self test (it does not need a running PLCSIM instance):'
& $exe --self-test
exit $LASTEXITCODE
