# Builds the dsh-engineering-graph C# engine into engine/bin.
#
#   pwsh -NoProfile -File engine/build.ps1
#   pwsh -NoProfile -File engine/build.ps1 -Configuration Debug
#   pwsh -NoProfile -File engine/build.ps1 -ExportRoot <dir>   # self-test against a real export tree
#
# Requires only the .NET SDK. Unlike family 1's controller this needs no TIA
# Portal, no Siemens assemblies and no .NET Framework targeting pack: the engine
# is pure XML + SQLite on net8.
#
# The output goes directly into engine/bin (same shape as controller/bin), which
# is where the TypeScript half resolves the executable from by default.
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$ExportRoot = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $here 'EngineeringGraph.Engine.csproj'
$output = Join-Path $here 'bin'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'The .NET SDK (dotnet) was not found on PATH.'
}

Write-Host "Building $project ($Configuration) -> $output"
& dotnet build $project -c $Configuration -o $output --nologo -v minimal
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed with exit code $LASTEXITCODE" }

$exe = Join-Path $output 'EngineeringGraph.Engine.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "The build produced no executable at $exe" }

Write-Host ''
Write-Host "Built: $exe"
Write-Host 'Running the self test (it does not need TIA Portal):'
if ($ExportRoot) { & $exe --self-test $ExportRoot } else { & $exe --self-test }
exit $LASTEXITCODE
