# Clean-sandbox test for Phase 2c: no DSH installed, the suite installer must
# download/install DSH from the official feed (or a test override), then install
# the fixed profile and run doctor. WebView2 is skipped in this test.
$ErrorActionPreference = 'Continue'
$out = 'C:\out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$logPath = Join-Path $out 'bootstrap-dsh.log'
$resultPath = Join-Path $out 'bootstrap-dsh-result.json'
$steps = New-Object System.Collections.Generic.List[object]

function Log([string]$message) {
    $line = "{0} {1}" -f (Get-Date -Format 'O'), $message
    Write-Host $line
    Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}
function Add-Step([string]$name, [string]$status, [string]$detail) {
    $steps.Add([pscustomobject]@{ name = $name; status = $status; detail = $detail })
    Log ("[{0}] {1}: {2}" -f $status, $name, $detail)
}
function Save-Result([string]$fatal) {
    [pscustomobject]@{
        schemaVersion = 1
        startedAt = $script:startedAt
        finishedAt = (Get-Date).ToUniversalTime().ToString('o')
        fatal = $fatal
        steps = $steps
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8
}
function Wait-ProcessExit($process, [int]$seconds) {
    if ($process.WaitForExit($seconds * 1000)) { return $true }
    try { $process.Kill() } catch { }
    return $false
}
function Exit-Text($process) {
    try { if ($process.HasExited) { return [string]$process.ExitCode } } catch { }
    return 'unknown'
}
function Keep-Open {
    Start-Process explorer.exe -ArgumentList 'C:\out' | Out-Null
    Start-Sleep -Seconds 5
}

$script:startedAt = (Get-Date).ToUniversalTime().ToString('o')
Log 'bootstrap-dsh test starting'
try {
    $dshCmd = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    Add-Step 'precondition' $(if (Test-Path -LiteralPath $dshCmd) { 'FAIL' } else { 'OK' }) "dshPresent=$(Test-Path -LiteralPath $dshCmd)"
    if (Test-Path -LiteralPath $dshCmd) { throw 'sandbox is not clean: DSH already installed' }

    $setup = 'C:\dist\desktop\0.2.0\dsh-automation-suite-setup-0.2.0.exe'
    if (-not (Test-Path -LiteralPath $setup)) { throw "setup not found: $setup" }
    $prefetch = Join-Path $out 'dsh-official-setup.exe'
    if (-not (Test-Path -LiteralPath $prefetch)) { throw 'prefetched DSH installer missing' }

    $dir = Join-Path $out 'install-bootstrap'
    $homeDir = Join-Path $env:USERPROFILE 'dsh-automation-suite-home'
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    $env:DSH_HOME = $homeDir
    $env:DSH_SETUP_OVERRIDE = $prefetch
    $env:DSH_SUITE_SKIP_WEBVIEW2 = '1'
    Add-Step 'setup' 'INFO' $setup
    $p = Start-Process -FilePath $setup `
        -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', "/DIR=$dir") -PassThru
    $finished = Wait-ProcessExit $p 600
    Remove-Item Env:DSH_HOME,Env:DSH_SETUP_OVERRIDE,Env:DSH_SUITE_SKIP_WEBVIEW2 -ErrorAction SilentlyContinue

    $installJson = Join-Path $dir 'install.json'
    $profileDir = Join-Path $homeDir 'profiles\dsh-automation-suite'
    Add-Step 'suite-install' $(if ($finished) { 'DONE' } else { 'TIMEOUT' }) `
        ("exit=" + (Exit-Text $p) +
         "; dsh=" + (Test-Path -LiteralPath $dshCmd) +
         "; installJson=" + (Test-Path -LiteralPath $installJson) +
         "; profile=" + (Test-Path -LiteralPath (Join-Path $profileDir 'package.json')) +
         "; current=" + (Test-Path -LiteralPath (Join-Path $dir 'current.txt')))
    if (Test-Path -LiteralPath $installJson) {
        Copy-Item -LiteralPath $installJson -Destination (Join-Path $out 'bootstrap-install.json') -Force
    }
    if (Test-Path -LiteralPath (Join-Path $dir 'logs')) {
        Copy-Item -LiteralPath (Join-Path $dir 'logs') -Destination (Join-Path $out 'bootstrap-logs') -Recurse -Force
    }
    $bootstrapLog = Get-ChildItem (Join-Path $dir 'logs') -Filter 'bootstrap-dsh-*.log' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($bootstrapLog) {
        Copy-Item -LiteralPath $bootstrapLog.FullName -Destination (Join-Path $out 'bootstrap-dsh-log.txt') -Force
    }

    $uninstaller = Join-Path $dir 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $u = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru
        $uFinished = Wait-ProcessExit $u 120
        Start-Sleep -Seconds 2
        Add-Step 'uninstall' $(if ($uFinished) { 'DONE' } else { 'TIMEOUT' }) `
            ("exit=" + (Exit-Text $u) + "; dirExists=" + (Test-Path -LiteralPath $dir))
    }

    Save-Result ''
}
catch {
    Add-Step 'fatal' 'FAIL' $_.Exception.Message
    Save-Result $_.Exception.Message
    Keep-Open
    exit 1
}
Keep-Open
