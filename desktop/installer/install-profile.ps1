# Install or upgrade the fixed desktop profile from the materialized app layer.
#
# Called by the Inno installer after files are copied:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-profile.ps1 `
#     -InstallRoot <app> -AppVersion <ver>
#
# It does NOT run pnpm. It copies the app-layer profile into the fixed profile,
# backs up the previous profile, merges user overrides from the previous
# cordis.patch.yml (three-way merge, see merge-profile.mjs), writes install.json,
# and runs doctor.ps1 -Json. On a doctor failure it restores the previous profile.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [Parameter(Mandatory = $true)]
    [string]$AppVersion,
    [string]$DshHome = '',
    [string]$Profile = 'dsh-automation-suite',
    [switch]$NoDoctor
)

$ErrorActionPreference = 'Stop'
# Inno Setup is 32-bit; prefer native 64-bit PowerShell for WebView2/node/doctor.
$psExe = Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $psExe)) {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$appDir = Join-Path $InstallRoot "app\$AppVersion"
$newProfile = Join-Path $appDir 'profile'
$newPatch = Join-Path $newProfile 'cordis.patch.yml'
$mergeScript = Join-Path $appDir 'merge-profile.mjs'
$doctor = Join-Path $appDir 'doctor.ps1'

foreach ($required in @(
    (Join-Path $newProfile 'package.json'),
    $newPatch,
    (Join-Path $appDir 'app-manifest.json')
)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "missing app layer input: $required" }
}

if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME }
               else { Join-Path $env:USERPROFILE 'dsh-automation-suite-home' }
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$profileDir = Join-Path $DshHome "profiles\$Profile"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tempProfile = "$profileDir.new-$stamp"
$backupProfile = "$profileDir.bak-$stamp"
$logDir = Join-Path $InstallRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "install-profile-$stamp.log"

function Write-Log {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format 'O'), $Message
    Write-Host $Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

function Remove-Tree {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    # Avoid recursive .NET/PowerShell deletion following a junction; cmd rmdir
    # removes the link itself and never descends through it.
    cmd /c rmdir /s /q "$Path" | Out-Null
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Copy-Profile {
    param([string]$Source, [string]$Target)
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
    }
}

function Find-Dsh {
    $candidates = @(
        $env:DSH_EXE,
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    $dsh = $candidates | Select-Object -First 1
    if (-not $dsh) { throw 'DeepSeek Harness (dsh.cmd) was not found. Install DSH before this installer.' }
    return $dsh
}

function Find-Node {
    param([string]$DshCmd)
    $dshRoot = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $DshCmd) '..\..\..\..'))
    $candidates = @(
        $env:DSH_DESKTOP_NODE_EXECUTABLE,
        (Join-Path $dshRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $dshRoot 'resources\runtime\node\bin\node.exe'),
        (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    return ($candidates | Select-Object -First 1)
}

function Find-PreviousApp {
    param([string]$Root, [string]$CurrentVersion)
    $apps = Get-ChildItem (Join-Path $Root 'app') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne $CurrentVersion }
    $rows = @()
    foreach ($directory in $apps) {
        $manifestPath = Join-Path $directory.FullName 'app-manifest.json'
        if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            if ($manifest.appLayerVersion) {
                $rows += [pscustomobject]@{
                    Directory = $directory.FullName
                    Version = [version]$manifest.appLayerVersion
                }
            }
        }
        catch {
            # Ignore a broken old manifest.
        }
    }
    return ($rows | Sort-Object Version -Descending | Select-Object -First 1)
}

$dsh = Find-Dsh

# Windows Sandbox has Edge but no WebView2 Runtime; DSH itself does not install
# it for us. Keep this as a prerequisite of the fixed profile.
$webviewScript = Join-Path $InstallRoot 'installer\bootstrap-webview2.ps1'
if ($env:DSH_SUITE_SKIP_WEBVIEW2 -eq '1') {
    Write-Log 'skipping WebView2 bootstrap (DSH_SUITE_SKIP_WEBVIEW2=1; test-only)'
}
elseif (Test-Path -LiteralPath $webviewScript) {
    Write-Log 'ensuring WebView2 runtime'
    $webviewOut = Join-Path $logDir 'webview2.out.log'
    $webviewErr = Join-Path $logDir 'webview2.err.log'
    # Use System.Diagnostics.Process instead of Start-Process: Windows
    # PowerShell 5.1 can return a null ExitCode for a redirected child even
    # after WaitForExit(), which made a successful bootstrap look failed.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $psExe
    $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $webviewScript + '"'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $InstallRoot
    $webviewProcess = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $webviewProcess.StandardOutput.ReadToEndAsync()
    $stderrTask = $webviewProcess.StandardError.ReadToEndAsync()
    if (-not $webviewProcess.WaitForExit(180000)) {
        try { $webviewProcess.Kill() } catch { }
        throw 'WebView2 bootstrap timed out after 180 s'
    }
    $webviewExit = $webviewProcess.ExitCode
    $webviewStdout = $stdoutTask.Result
    $webviewStderr = $stderrTask.Result
    Set-Content -LiteralPath $webviewOut -Value $webviewStdout -Encoding utf8
    Set-Content -LiteralPath $webviewErr -Value $webviewStderr -Encoding utf8
    foreach ($line in (($webviewStdout + "`n" + $webviewStderr) -split "\r?\n")) {
        if ($line) { Write-Log "webview2: $line" }
    }
    if ($webviewExit -ne 0) {
        throw "WebView2 bootstrap failed with exit code $webviewExit"
    }
}
else {
    Write-Log 'WARNING: bootstrap-webview2.ps1 not found; shell may fail without WebView2'
}

$appManifest = Get-Content -LiteralPath (Join-Path $appDir 'app-manifest.json') -Raw | ConvertFrom-Json
$hadProfile = Test-Path -LiteralPath (Join-Path $profileDir 'package.json')
$previousApp = if ($hadProfile) { Find-PreviousApp -Root $InstallRoot -CurrentVersion $AppVersion } else { $null }

Write-Log "install profile: app=$appDir profile=$profileDir dsh=$dsh"
if ($hadProfile) {
    Write-Log "existing profile found; backup will be $backupProfile"
    foreach ($name in @('package.json', 'cordis.patch.yml')) {
        $source = Join-Path $profileDir $name
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination "$source.bak-$stamp" -Force
            Write-Log "backed up $name"
        }
    }
}

Remove-Tree $tempProfile
Copy-Profile $newProfile $tempProfile
Write-Log "copied new app layer profile"

if ($hadProfile) {
    $oldPatch = Join-Path $profileDir 'cordis.patch.yml'
    $oldBaseline = if ($previousApp) { Join-Path $previousApp.Directory 'profile\cordis.patch.yml' } else { $null }
    $mergeAvailable = $oldBaseline -and (Test-Path -LiteralPath $oldBaseline) -and (Test-Path -LiteralPath $mergeScript)
    if ($mergeAvailable) {
        $node = Find-Node -DshCmd $dsh
        if (-not $node) { throw 'node.exe was not found; cannot merge the previous profile overrides.' }
        $mergedPath = Join-Path $tempProfile 'cordis.patch.yml'
        $reportPath = Join-Path $tempProfile '.merge-report.json'
        Write-Log "merging previous overrides with $node"
        & $node $mergeScript `
            --old-patch $oldPatch `
            --old-baseline $oldBaseline `
            --new-baseline $newPatch `
            --out $mergedPath `
            --report $reportPath
        if ($LASTEXITCODE -ne 0) {
            Remove-Tree $tempProfile
            throw "profile merge failed with exit code $LASTEXITCODE"
        }
        Write-Log "profile merge: $((Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json).replaced -join ', ')"
    }
    else {
        Write-Log 'WARNING: no previous app-layer baseline found; keeping the new baseline (user overrides not merged)'
    }
}

$marker = [ordered]@{
    appLayerVersion = $AppVersion
    sourceCommit = $appManifest.sourceCommit
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    mergedFrom = if ($previousApp) { [string]$previousApp.Version } else { $null }
}
$marker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $tempProfile '.app-layer.json') -Encoding utf8

if ($hadProfile) {
    if (Test-Path -LiteralPath $backupProfile) { Remove-Tree $backupProfile }
    Move-Item -LiteralPath $profileDir -Destination $backupProfile
    Write-Log "previous profile moved to $backupProfile"
}
Move-Item -LiteralPath $tempProfile -Destination $profileDir
Write-Log "profile installed at $profileDir"

# pnpm records the store paths of the machine that built the app layer in
# node_modules\.modules.yaml, and its checkCompatibility() rejects them on any
# other machine before dependency resolution runs. The Plugins page is exactly
# `pnpm add` in this profile, so without this step the first plugin install
# fails with ERR_PNPM_UNEXPECTED_VIRTUAL_STORE / ERR_PNPM_UNEXPECTED_STORE.
$normalizer = Join-Path $appDir 'normalize-profile-pnpm.mjs'
if (Test-Path -LiteralPath $normalizer) {
    $node = Find-Node -DshCmd $dsh
    if (-not $node) {
        Remove-Tree $profileDir
        if ($hadProfile -and (Test-Path -LiteralPath $backupProfile)) { Move-Item -LiteralPath $backupProfile -Destination $profileDir }
        throw 'node.exe was not found; cannot normalize the profile for plugin installs.'
    }
    Write-Log 'normalizing pnpm metadata for this machine'
    $normalizeOut = & $node $normalizer --profile $profileDir --dsh $dsh 2>&1
    $normalizeExit = $LASTEXITCODE
    foreach ($line in @($normalizeOut)) { if ($line) { Write-Log "normalize: $line" } }
    if ($normalizeExit -ne 0) {
        Remove-Tree $profileDir
        if ($hadProfile -and (Test-Path -LiteralPath $backupProfile)) { Move-Item -LiteralPath $backupProfile -Destination $profileDir }
        throw "profile normalization failed with exit code $normalizeExit; the Plugins page would not be able to install anything."
    }
}
else {
    Write-Log 'WARNING: normalize-profile-pnpm.mjs not found; plugin installs will fail with ERR_PNPM_UNEXPECTED_VIRTUAL_STORE'
}

if (-not $NoDoctor -and (Test-Path -LiteralPath $doctor)) {
    Write-Log 'running doctor'
    $doctorOutput = & $psExe -NoProfile -File $doctor -DshHome $DshHome -Profile $Profile -Json -NoFail 2>&1
    $doctorText = ($doctorOutput | Out-String).Trim()
    $report = $null
    try { $report = $doctorText | ConvertFrom-Json } catch { }
    if ($null -eq $report) {
        Remove-Tree $profileDir
        if ($hadProfile -and (Test-Path -LiteralPath $backupProfile)) { Move-Item -LiteralPath $backupProfile -Destination $profileDir }
        throw "doctor did not emit valid JSON:`n$doctorText"
    }
    Write-Log ("doctor: {0} ok / {1} warn / {2} fail" -f $report.summary.ok, $report.summary.warn, $report.summary.fail)
    if ($report.summary.fail -gt 0) {
        Remove-Tree $profileDir
        if ($hadProfile -and (Test-Path -LiteralPath $backupProfile)) { Move-Item -LiteralPath $backupProfile -Destination $profileDir }
        throw "doctor reported $($report.summary.fail) fatal failure(s); previous profile restored."
    }
}

$state = [ordered]@{
    dshHome = $DshHome
    profile = $Profile
    dshExe = $dsh
    appVersion = $AppVersion
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot 'install.json') -Encoding utf8

Write-Log 'profile install completed'
