# Runs inside Windows Sandbox (C:\dist mapped read-only, C:\out writable).
# It verifies the current installer end-to-end on a clean Windows:
#   1. installer behavior when DSH is missing;
#   2. official DSH install (manual, because the suite installer does not bootstrap it yet);
#   3. suite installer with DSH present: profile + doctor + install.json;
#   4. installed shell --smoke-test (WebView2);
#   5. uninstall removes the install dir but keeps DSH_HOME.
#
# Results are written to C:\out\sandbox-result.json and C:\out\sandbox.log.
$ErrorActionPreference = 'Continue'
$out = 'C:\out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$logPath = Join-Path $out 'sandbox.log'
$resultPath = Join-Path $out 'sandbox-result.json'
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

$script:startedAt = (Get-Date).ToUniversalTime().ToString('o')
Log 'sandbox test starting'

try {
    Add-Step 'environment' 'INFO' ("OS=" + [System.Environment]::OSVersion.VersionString)
    $setup = if (Test-Path -LiteralPath 'C:\dist\desktop\0.2.0\setup-new.exe') {
        Get-Item -LiteralPath 'C:\dist\desktop\0.2.0\setup-new.exe'
    } else {
        Get-ChildItem 'C:\dist\desktop\0.2.0\dsh-automation-suite-setup-*.exe' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if ($null -eq $setup) { throw 'suite setup exe not found under C:\dist\desktop\0.2.0' }
    Add-Step 'setup' 'INFO' $setup.FullName

    $dshCmd = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

    # 1. DSH missing: the current installer must block.
    $dirWithout = Join-Path $out 'install-without-dsh'
    Remove-Item -LiteralPath $dirWithout -Recurse -Force -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $setup.FullName `
        -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', "/DIR=$dirWithout") `
        -PassThru
    $finished = Wait-ProcessExit $p 120
    Add-Step 'installer-without-dsh' $(if ($finished) { 'DONE' } else { 'TIMEOUT' }) `
        ("exit=" + (Exit-Text $p) + "; dirCreated=" + (Test-Path -LiteralPath $dirWithout))

    # 2. Install DSH manually from the official feed (Phase 2c will move this into the installer).
    if (-not (Test-Path -LiteralPath $dshCmd)) {
        try {
            $prefetchJson = Join-Path $out 'dsh-feed.json'
            $prefetchExe = Join-Path $out 'dsh-official-setup.exe'
            if (Test-Path -LiteralPath $prefetchJson -PathType Leaf) {
                $feed = Get-Content -LiteralPath $prefetchJson -Raw | ConvertFrom-Json
                $version = $feed.version
                $url = $feed.url
                $sha512 = $feed.sha512
                Add-Step 'dsh-feed' 'INFO' "prefetched $version -> $url"
            }
            else {
                $feedResponse = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 `
                    -Uri 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml'
                $feedText = if ($feedResponse.Content -is [byte[]]) {
                    [System.Text.Encoding]::UTF8.GetString($feedResponse.Content)
                } else { [string]$feedResponse.Content }
                $version = [regex]::Match($feedText, '(?m)^version:\s*([^\r\n]+)').Groups[1].Value.Trim()
                $url = [regex]::Match($feedText, 'url:\s*(?:>-)?\s*\r?\n?\s*(https://\S+)').Groups[1].Value.Trim()
                $sha512 = [regex]::Match($feedText, 'sha512:\s*(?:>-)?\s*\r?\n?\s*([^\s]+)').Groups[1].Value.Trim()
                Add-Step 'dsh-feed' 'INFO' "$version -> $url"
            }
            if (-not $url -or -not $version) { throw 'could not parse official DSH feed' }

            if (Test-Path -LiteralPath $prefetchExe -PathType Leaf) {
                $installer = $prefetchExe
                Add-Step 'dsh-download' 'OK' 'using prefetched installer from C:\out'
            }
            else {
                $installer = Join-Path $env:TEMP 'dsh-official-setup.exe'
                Log "downloading DSH $version ..."
                Invoke-WebRequest -UseBasicParsing -TimeoutSec 900 -Uri $url -OutFile $installer
            }
            $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA512).Hash
            $bytes = New-Object byte[] ($hash.Length / 2)
            for ($i = 0; $i -lt $bytes.Length; $i++) {
                $bytes[$i] = [Convert]::ToByte($hash.Substring($i * 2, 2), 16)
            }
            $actualSha = [Convert]::ToBase64String($bytes)
            Add-Step 'dsh-download' $(if ($actualSha -eq $sha512) { 'OK' } else { 'FAIL' }) `
                ("sha512=" + $actualSha.Substring(0, 12) + "…")
            if ($actualSha -ne $sha512) { throw 'DSH installer SHA-512 mismatch' }

            $install = Start-Process -FilePath $installer -ArgumentList @('/S') -PassThru
            $installFinished = Wait-ProcessExit $install 600
            Add-Step 'dsh-install' $(if ($installFinished) { 'DONE' } else { 'TIMEOUT' }) `
                ("exit=" + (Exit-Text $install))

            for ($i = 0; $i -lt 60 -and -not (Test-Path -LiteralPath $dshCmd); $i++) {
                Start-Sleep -Seconds 2
            }
            Add-Step 'dsh-present' $(if (Test-Path -LiteralPath $dshCmd) { 'OK' } else { 'FAIL' }) $dshCmd
            if (-not (Test-Path -LiteralPath $dshCmd)) { throw 'DSH was not installed by the official installer' }
        }
        catch {
            Add-Step 'dsh-install' 'FAIL' $_.Exception.Message
            Save-Result 'DSH installation failed; suite install skipped'
            exit 1
        }
    }
    else {
        Add-Step 'dsh-present' 'OK' $dshCmd
    }

    # 3. Suite installer with DSH present.
    $dir = Join-Path $out 'install-with-dsh'
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    $homeDir = Join-Path $env:USERPROFILE 'dsh-automation-suite-home'
    $env:DSH_HOME = $homeDir
    $p2 = Start-Process -FilePath $setup.FullName `
        -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', "/DIR=$dir") `
        -PassThru
    $finished2 = Wait-ProcessExit $p2 300
    Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
    $installJson = Join-Path $dir 'install.json'
    $profileDir = Join-Path $homeDir 'profiles\dsh-automation-suite'
    Add-Step 'suite-install' $(if ($finished2) { 'DONE' } else { 'TIMEOUT' }) `
        ("exit=" + (Exit-Text $p2) + "; installJson=" + (Test-Path -LiteralPath $installJson) +
         "; profile=" + (Test-Path -LiteralPath (Join-Path $profileDir 'package.json')) +
         "; current=" + (Test-Path -LiteralPath (Join-Path $dir 'current.txt')))
    if ($finished2 -and (Test-Path -LiteralPath $installJson)) {
        Copy-Item -LiteralPath $installJson -Destination (Join-Path $out 'install.json') -Force
    }
    if (Test-Path -LiteralPath (Join-Path $dir 'logs')) {
        Copy-Item -LiteralPath (Join-Path $dir 'logs') -Destination (Join-Path $out 'install-logs') -Recurse -Force
    }

    # 4. Installed shell smoke test (reads install.json for DSH_HOME/profile).
    $shell = Join-Path $dir 'shell\DshSuite.Shell.exe'
    $wvRegistered = @(Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients' -ErrorAction SilentlyContinue |
        Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).name -match 'WebView2' })
    Add-Step 'webview2-registration' $(if ($wvRegistered) { 'OK' } else { 'MISSING' }) `
        (($wvRegistered | ForEach-Object { $_.PSChildName }) -join '; ')

    if (Test-Path -LiteralPath $shell) {
        $smoke = Start-Process -FilePath $shell -ArgumentList @('--smoke-test') -PassThru
        $smokeFinished = Wait-ProcessExit $smoke 180
        $smokeFile = Join-Path $homeDir 'smoke-result.json'
        $smokeOk = $false
        if (Test-Path -LiteralPath $smokeFile) {
            Copy-Item -LiteralPath $smokeFile -Destination (Join-Path $out 'smoke-result.json') -Force
            try { $smokeOk = [bool](Get-Content -LiteralPath $smokeFile -Raw | ConvertFrom-Json).ok } catch { }
        }
        Add-Step 'shell-smoke' $(if ($smokeOk) { 'OK' } elseif ($smokeFinished) { 'FAIL' } else { 'TIMEOUT' }) `
            ("exit=" + (Exit-Text $smoke) + "; ok=" + $smokeOk)
        if (Test-Path -LiteralPath (Join-Path $homeDir 'logs')) {
            Copy-Item -LiteralPath (Join-Path $homeDir 'logs') -Destination (Join-Path $out 'shell-logs') -Recurse -Force
        }
    }
    else {
        Add-Step 'shell-smoke' 'FAIL' 'installed shell missing'
    }

    # 5. Uninstall: install dir gone, DSH_HOME retained.
    $uninstaller = Join-Path $dir 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $u = Start-Process -FilePath $uninstaller `
            -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru
        $uFinished = Wait-ProcessExit $u 120
        Start-Sleep -Seconds 2
        Add-Step 'uninstall' $(if ($uFinished) { 'DONE' } else { 'TIMEOUT' }) `
            ("exit=" + (Exit-Text $u) + "; dirExists=" + (Test-Path -LiteralPath $dir) +
             "; homeRetained=" + (Test-Path -LiteralPath $profileDir))
    }
    else {
        Add-Step 'uninstall' 'FAIL' 'uninstaller missing'
    }

    Save-Result ''
    # Keep the LogonCommand session alive for inspection; otherwise Sandbox may log off.
    Start-Process explorer.exe -ArgumentList 'C:\out' | Out-Null
    Start-Sleep -Seconds 5
}
catch {
    Add-Step 'fatal' 'FAIL' $_.Exception.Message
    Save-Result $_.Exception.Message
    Start-Process explorer.exe -ArgumentList 'C:\out' | Out-Null
    Start-Sleep -Seconds 5
    exit 1
}








