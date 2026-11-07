# Builds the dsh-engineering-graph C# engine.
#
#   pwsh -NoProfile -File engine/build.ps1
#   pwsh -NoProfile -File engine/build.ps1 -Configuration Debug
#   pwsh -NoProfile -File engine/build.ps1 -ExportRoot <dir>   # self-test against a real export tree
#   pwsh -NoProfile -File engine/build.ps1 -SelfContained      # release shape: one self-contained exe
#   pwsh -NoProfile -File engine/build.ps1 -SelfContained -Output <dir>
#
# Requires the .NET 10 SDK. Unlike the TIA Openness plugin's controller this needs
# no TIA Portal, no Siemens assemblies and no .NET Framework targeting pack: the
# engine is pure XML + SQLite on net10.
#
# The default output goes directly into engine/bin (same shape as controller/bin),
# which is where the TypeScript half resolves the executable from by default.
# That default build is framework-dependent: it is the developer/test shape and
# needs the .NET 10 runtime on the machine.
#
# -SelfContained produces the shape that is shipped to users: a single win-x64
# executable with the runtime and the native SQLite provider embedded. It needs
# no .NET installation on the target machine. It is written to -Output (default
# engine/bin), so a release build should pass a staging directory and must not
# overwrite the tracked developer build in engine/bin.
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$ExportRoot = '',
    [string]$Output = '',
    [string]$Dotnet = 'dotnet',
    [switch]$SelfContained
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $here 'EngineeringGraph.Engine.csproj'
$output = if ($Output) { $Output } else { Join-Path $here 'bin' }

if (-not (Get-Command $Dotnet -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $Dotnet)) {
    throw "The .NET SDK ('$Dotnet') was not found. Install the .NET 10 SDK (or pass -Dotnet <path>)."
}

# Clear the target so a framework-dependent build cannot leave old runtime files
# behind, and a self-contained build cannot inherit stale DLLs from a previous
# shape. The path is a normal build directory (never a junction).
if (Test-Path -LiteralPath $output) {
    Get-ChildItem -LiteralPath $output -Force | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
}
else {
    New-Item -ItemType Directory -Force -Path $output | Out-Null
}

if ($SelfContained) {
    Write-Host "Publishing $project ($Configuration, win-x64, self-contained) -> $output"
    & $Dotnet publish $project -c $Configuration -r win-x64 --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:EnableCompressionInSingleFile=true `
        -p:DebugType=None `
        -o $output --nologo -v minimal
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

    # The csproj copies engine/fixtures next to the executable for the developer
    # self-test. A shipped single-file engine does not need that second copy; the
    # fixture sources stay at engine/fixtures/.
    foreach ($extra in @('fixtures', 'EngineeringGraph.Engine.pdb')) {
        $path = Join-Path $output $extra
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
}
else {
    Write-Host "Building $project ($Configuration) -> $output"
    & $Dotnet build $project -c $Configuration -o $output --nologo -v minimal
    if ($LASTEXITCODE -ne 0) { throw "dotnet build failed with exit code $LASTEXITCODE" }
}

$exe = Join-Path $output 'EngineeringGraph.Engine.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "The build produced no executable at $exe" }

Write-Host ''
Write-Host "Built: $exe"
Write-Host 'Running the self test (it does not need TIA Portal):'
if ($ExportRoot) { & $exe --self-test $ExportRoot } else { & $exe --self-test }
exit $LASTEXITCODE
