# Builds the C# Openness controller into controller/bin.
#
#   pwsh -NoProfile -File controller/build.ps1                 # Release
#   pwsh -NoProfile -File controller/build.ps1 -Configuration Debug
#   pwsh -NoProfile -File controller/build.ps1 -OpennessDir 'D:\Siemens\...\PublicAPI\V17'
#
# Requires the .NET SDK (any version able to build net48) and the .NET Framework
# 4.8 targeting pack. The output is a 64-bit .NET Framework executable; the
# Siemens.Engineering.dll it references is loaded from the TIA Portal
# installation at run time and is never copied next to the executable.
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$OpennessDir = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $here 'TiaOpennessV17Min.Controller.csproj'
$output = Join-Path $here 'bin'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'The .NET SDK (dotnet) was not found on PATH.'
}

$arguments = @('build', $project, '-c', $Configuration, '-o', $output, '--nologo', '-v', 'minimal')
if ($OpennessDir) { $arguments += "-p:OpennessDir=$OpennessDir" }

Write-Host "Building $project ($Configuration) -> $output"
& dotnet @arguments
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed with exit code $LASTEXITCODE" }

$exe = Join-Path $output 'TiaOpennessV17Min.Controller.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "The build produced no executable at $exe" }

Write-Host ''
Write-Host "Built: $exe"
Write-Host 'Running the self test (it does not need TIA Portal):'
& $exe --self-test
exit $LASTEXITCODE
