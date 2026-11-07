# dsh-automation-suite doctor — report which capabilities this machine can run.
#
#   pwsh -NoProfile -File doctor.ps1
#   pwsh -NoProfile -File doctor.ps1 -DshHome C:\temp\dsh-home -Profile my-suite
#   pwsh -NoProfile -File doctor.ps1 -Json
#
# The installer copies this file (and doctor.cmd) into the extracted release
# folder; install.json next to it supplies the home/profile. The same script is
# the contract the desktop installer will call: -Json emits one machine-readable
# object so the installer can render the same report.
#
# Exit code: 0 when nothing is fatal (warnings are allowed), 1 when a fatal
# check fails. -NoFail always exits 0.
[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$Profile = '',
    [string]$DshExe = '',
    [switch]$Json,
    [switch]$NoFail
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
$results = @()
$dshVersion = ''
# Bump only when the JSON shape changes. The desktop installer and shell parse
# this contract; keep field names stable across releases.
$schemaVersion = 1

function Add-Result {
    param(
        [string]$Id,
        [string]$Capability,
        [ValidateSet('ok', 'warn', 'fail')]
        [string]$Status,
        [string]$Detail,
        [string]$Fix = ''
    )
    $script:results += [pscustomobject]@{
        id         = $Id
        capability = $Capability
        status     = $Status
        detail     = $Detail
        fix        = $Fix
    }
}

function Find-DshExe {
    $candidates = @()
    if ($DshExe) { $candidates += $DshExe }
    if ($env:DSH_EXE) { $candidates += $env:DSH_EXE }
    $appRoots = @()
    if ($env:DSH_APP_ROOT) { $appRoots += $env:DSH_APP_ROOT }
    $appRoots += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')
    foreach ($appRoot in $appRoots) {
        $candidates += (Join-Path $appRoot 'resources\runtime\cli\bin\dsh.cmd')
    }
    $onPath = Get-Command dsh -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    return ($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

# ---------------------------------------------------------------------------
# Resolve install.json next to this script (written by install.ps1).
# ---------------------------------------------------------------------------
$statePath = Join-Path $here 'install.json'
if (Test-Path -LiteralPath $statePath) {
    try {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if (-not $DshHome -and $state.dshHome) { $DshHome = [string]$state.dshHome }
        if (-not $Profile -and $state.profile) { $Profile = [string]$state.profile }
        if (-not $DshExe -and $state.dshExe) { $DshExe = [string]$state.dshExe }
    }
    catch {
        # A broken install.json is itself reported below via missing profile/home.
    }
}

if (-not $DshHome) {
    $DshHome = Join-Path $env:USERPROFILE 'dsh-automation-suite-home'
}

# ---------------------------------------------------------------------------
# DSH runtime
# ---------------------------------------------------------------------------
$resolvedDsh = Find-DshExe
if (-not $resolvedDsh) {
    Add-Result 'dsh' 'DSH runtime' 'fail' 'dsh.cmd was not found.' 'Install DeepSeek Harness, or pass -DshExe <path>.'
}
else {
    $dshVersion = ((& $resolvedDsh --version 2>&1) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or -not $dshVersion) {
        Add-Result 'dsh' 'DSH runtime' 'fail' ("dsh --version failed at $resolvedDsh") 'Reinstall or pass -DshExe.'
    }
    else {
        Add-Result 'dsh' 'DSH runtime' 'ok' ("$dshVersion at $resolvedDsh")
    }
}

# ---------------------------------------------------------------------------
# Profile and its installed bundles
# ---------------------------------------------------------------------------
$profileDir = if ($Profile) { Join-Path $DshHome "profiles\$Profile" } else { '' }
$profileManifestPath = if ($profileDir) { Join-Path $profileDir 'package.json' } else { '' }
$profileManifest = $null
if (-not $Profile) {
    Add-Result 'profile' 'Installed profile' 'fail' 'No profile was specified and install.json was not found.' 'Run doctor.cmd next to install.ps1, or pass -DshHome and -Profile.'
}
elseif (-not (Test-Path -LiteralPath $profileManifestPath)) {
    Add-Result 'profile' 'Installed profile' 'fail' ("profile '$Profile' was not found at $profileDir") 'Run install.ps1 (or pass the correct -DshHome/-Profile).'
}
else {
    try {
        $profileManifest = Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json
        Add-Result 'profile' 'Installed profile' 'ok' ("$Profile at $profileDir")
    }
    catch {
        Add-Result 'profile' 'Installed profile' 'fail' ("cannot read $profileManifestPath") 'Reinstall the profile.'
    }
}

$dependencies = @()
if ($profileManifest -and $profileManifest.dependencies) {
    $dependencies = @($profileManifest.dependencies.PSObject.Properties.Name)
}

if ($dependencies.Count -gt 0) {
    $missing = @()
    foreach ($dependency in $dependencies) {
        $path = Join-Path $profileDir (Join-Path 'node_modules' $dependency)
        if (-not (Test-Path -LiteralPath $path)) { $missing += $dependency }
    }
    if ($missing.Count -eq 0) {
        Add-Result 'plugins' 'Plugin packages' 'ok' ("$($dependencies.Count) dependencies installed")
    }
    else {
        Add-Result 'plugins' 'Plugin packages' 'fail' ("missing from node_modules: $($missing -join ', ')") 'Re-run install.ps1 (or dsh plugin install) for this profile.'
    }
}

if ($resolvedDsh -and $Profile -and (Test-Path -LiteralPath $profileManifestPath)) {
    $env:DSH_HOME = $DshHome
    $dump = @(& $resolvedDsh --profile $Profile --dump-config 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Add-Result 'config' 'Profile composition' 'fail' 'dsh --dump-config failed.' 'Run it manually and inspect the error above.'
    }
    else {
        $expected = @($dependencies | Where-Object { -not $_.StartsWith('@deepseek-ai/') })
        $missingRows = @()
        foreach ($name in $expected) {
            $needle = '# == ' + $name
            if (-not ($dump | Where-Object { $_ -like ('*' + $needle + '*') })) { $missingRows += $name }
        }
        if ($missingRows.Count -eq 0) {
            Add-Result 'config' 'Profile composition' 'ok' ("$($expected.Count) bundle rows present")
        }
        else {
            Add-Result 'config' 'Profile composition' 'fail' ("bundle rows missing: $($missingRows -join ', ')") 'Reinstall the profile; the bundle list in package.json did not load.'
        }
    }
}

# ---------------------------------------------------------------------------
# Graph engine: run its own self-test. This covers the native SQLite provider
# and is the only check that proves a self-contained engine actually runs.
# ---------------------------------------------------------------------------
if ($profileDir) {
    $engine = Join-Path $profileDir 'node_modules\@voltarenyah\dsh-engineering-graph\engine\bin\EngineeringGraph.Engine.exe'
    if (-not (Test-Path -LiteralPath $engine)) {
        Add-Result 'engine' 'Knowledge graph engine' 'warn' 'engine executable is not installed.' 'Install @voltarenyah/dsh-engineering-graph in this profile.'
    }
    else {
        $engineOut = @(& $engine --self-test 2>&1)
        if ($LASTEXITCODE -eq 0) {
            Add-Result 'engine' 'Knowledge graph engine' 'ok' (($engineOut | Select-Object -Last 1))
        }
        else {
            Add-Result 'engine' 'Knowledge graph engine' 'warn' (($engineOut | Select-Object -Last 1)) 'Reinstall the graph plugin; if this is a framework-dependent build, install the .NET 10 runtime.'
        }
    }
}

# ---------------------------------------------------------------------------
# Framework prerequisites for the Siemens controllers
# ---------------------------------------------------------------------------
$net48 = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Release
if ($net48 -ge 528040) {
    Add-Result 'net48' '.NET Framework 4.8' 'ok' ("release $net48")
}
else {
    Add-Result 'net48' '.NET Framework 4.8' 'warn' 'not detected (TIA and PLCSIM controllers need it).' 'Install .NET Framework 4.8 (included in current Windows 10/11 updates).'
}

$tiaDll = Join-Path $env:ProgramFiles 'Siemens\Automation\Portal V17\PublicAPI\V17\Siemens.Engineering.dll'
if (-not (Test-Path -LiteralPath $tiaDll)) {
    Add-Result 'tia' 'TIA Portal V17' 'warn' 'Openness V17 was not found.' 'Install TIA Portal V17; the TIA tools stay unavailable until it exists.'
}
else {
    $groups = @(& whoami /groups 2>&1) -join "`n"
    if ($groups -match 'Siemens TIA Openness') {
        Add-Result 'tia' 'TIA Portal V17' 'ok' 'Openness V17 and the Siemens TIA Openness group are present.'
    }
    else {
        Add-Result 'tia' 'TIA Portal V17' 'warn' 'Openness V17 exists, but the current user is not in the Siemens TIA Openness group.' 'Ask an administrator to add the user to that local group, then sign in again.'
    }
}

$plcsim = 'C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API\4.0\Siemens.Simatic.Simulation.Runtime.Api.x64.dll'
if (Test-Path -LiteralPath $plcsim) {
    Add-Result 'plcsim' 'PLCSIM Advanced' 'ok' 'API 4.0 is present.'
}
else {
    Add-Result 'plcsim' 'PLCSIM Advanced' 'warn' 'PLCSIM Advanced API 4.0 was not found.' 'Install PLCSIM Advanced 4.0+; simulation tools stay unavailable until it exists.'
}

# ---------------------------------------------------------------------------
# Git and the document engines (npm dependencies, not system software)
# ---------------------------------------------------------------------------
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    $gitVersion = ((& git --version 2>&1) | Select-Object -First 1)
    Add-Result 'git' 'Git' 'ok' $gitVersion
}
else {
    Add-Result 'git' 'Git' 'warn' 'git.exe was not found on PATH.' 'Install Git (winget install Git.Git) and restart the app.'
}

if ($profileDir) {
    $pdfium = Join-Path $profileDir 'node_modules\@hyzyla\pdfium\dist\pdfium.wasm'
    $unpdf = Join-Path $profileDir 'node_modules\unpdf\package.json'
    $xlsx = Join-Path $profileDir 'node_modules\@e965\xlsx\package.json'
    $xml = Join-Path $profileDir 'node_modules\fast-xml-parser\package.json'
    $missingDoc = @()
    foreach ($pair in @(@('pdfium.wasm', $pdfium), @('unpdf', $unpdf), @('xlsx', $xlsx), @('fast-xml-parser', $xml))) {
        if (-not (Test-Path -LiteralPath $pair[1])) { $missingDoc += $pair[0] }
    }
    if ($missingDoc.Count -eq 0) {
        Add-Result 'documents' 'Drawing / Excel engines' 'ok' 'pdfium WASM, unpdf, xlsx and fast-xml-parser are installed.'
    }
    else {
        Add-Result 'documents' 'Drawing / Excel engines' 'warn' ("npm dependencies missing: $($missingDoc -join ', ')") 'Re-run dsh plugin install for this profile (network access to the npm registry is required).'
    }
}

$credentials = Join-Path $DshHome '.credentials.yaml'
if (Test-Path -LiteralPath $credentials) {
    Add-Result 'credentials' 'Model credentials' 'ok' 'credentials file exists.'
}
else {
    Add-Result 'credentials' 'Model credentials' 'warn' 'no credentials file yet.' 'Open the app and add a model API key under Settings -> Models.'
}

# ---------------------------------------------------------------------------
# Tested DSH version (manifest.json next to doctor, when present)
# ---------------------------------------------------------------------------
$manifestPath = Join-Path $here 'manifest.json'
if ((Test-Path -LiteralPath $manifestPath) -and $dshVersion) {
    try {
        $releaseManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($releaseManifest.testedDshVersion) {
            $tested = [string]$releaseManifest.testedDshVersion
            if ($dshVersion -eq $tested) {
                Add-Result 'dsh-version' 'Tested DSH version' 'ok' $tested
            }
            else {
                Add-Result 'dsh-version' 'Tested DSH version' 'warn' ("this release was tested on $tested; found $dshVersion") 'Run the distribution regression checklist before relying on untested DSH versions.'
            }
        }
    }
    catch {
        Add-Result 'dsh-version' 'Tested DSH version' 'warn' 'manifest.json could not be read.' 'Re-extract the release zip.'
    }
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
$summary = [pscustomobject]@{
    ok   = @($results | Where-Object { $_.status -eq 'ok' }).Count
    warn = @($results | Where-Object { $_.status -eq 'warn' }).Count
    fail = @($results | Where-Object { $_.status -eq 'fail' }).Count
}

if ($Json) {
    [pscustomobject]@{
        schemaVersion = $schemaVersion
        generatedAt   = (Get-Date).ToUniversalTime().ToString('o')
        dshHome       = $DshHome
        profile       = $Profile
        dshExe        = $resolvedDsh
        dshVersion    = $dshVersion
        results       = $results
        summary       = $summary
    } | ConvertTo-Json -Depth 6
}
else {
    Write-Host ''
    Write-Host 'dsh-automation-suite doctor'
    Write-Host ("  DSH_HOME: " + $DshHome)
    Write-Host ("  profile : " + $Profile)
    if ($dshVersion) { Write-Host ("  DSH     : " + $dshVersion) }
    Write-Host ''
    foreach ($result in $results) {
        $marker = switch ($result.status) {
            'ok' { '[ OK ]' }
            'warn' { '[WARN]' }
            'fail' { '[FAIL]' }
        }
        Write-Host ("{0} {1,-26} {2}" -f $marker, $result.capability, $result.detail)
        if ($result.status -ne 'ok' -and $result.fix) {
            Write-Host ("       fix: " + $result.fix)
        }
    }
    Write-Host ''
    Write-Host ("Summary: {0} ok, {1} warning(s), {2} failure(s)" -f $summary.ok, $summary.warn, $summary.fail)
    if ($summary.fail -gt 0) {
        Write-Host 'The app cannot start correctly until the [FAIL] items are fixed.'
    }
    elseif ($summary.warn -gt 0) {
        Write-Host 'The app can start; the [WARN] items are unavailable capabilities.'
    }
    else {
        Write-Host 'All checked capabilities are ready.'
    }
}

if ($summary.fail -gt 0 -and -not $NoFail) { exit 1 }
exit 0
