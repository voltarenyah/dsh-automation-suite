# Run inside the clean VM after copying the setup to the Desktop.
# It installs the suite silently, checks DSH/WebView2/profile/doctor, and runs
# the shell smoke test. Results and logs are written under Desktop\suite-acceptance.
$ErrorActionPreference = 'Continue'
$setupCandidates = @(
    (Join-Path $env:USERPROFILE 'Desktop\dsh-automation-suite-setup-0.2.0.exe'),
    'C:\Users\Public\Desktop\dsh-automation-suite-setup-0.2.0.exe'
)
$setup = $setupCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $setup) { $setup = $setupCandidates[0] }
$installDir = 'C:\SuiteTest'
$homeDir = Join-Path $env:USERPROFILE 'dsh-automation-suite-home'
$outDir = Join-Path $env:USERPROFILE 'Desktop\suite-acceptance'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Save([hashtable]$value) {
    $value | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outDir 'result.json') -Encoding utf8
}
function ExitText($process) {
    try { if ($process.HasExited) { return [string]$process.ExitCode } } catch { }
    return 'unknown'
}

$webviewKey = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$dshCmd = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$profileDir = Join-Path $homeDir 'profiles\dsh-automation-suite'
$result = [ordered]@{
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    setupFound = (Test-Path -LiteralPath $setup)
    baselineDsh = (Test-Path -LiteralPath $dshCmd)
    baselineWebView2 = [bool](Get-ItemProperty -LiteralPath $webviewKey -ErrorAction SilentlyContinue)
    installExit = $null
    dshAfter = $false
    webView2After = $false
    installJson = $false
    profile = $false
    current = $false
    shellSmoke = $null
    shellError = $null
}
if (-not $result.setupFound) { Save $result; throw "setup not found: $setup" }

if (Test-Path -LiteralPath $installDir) {
    cmd /c rmdir /s /q "$installDir"
}
$env:DSH_HOME = $homeDir
$p = Start-Process -FilePath $setup `
    -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', "/DIR=$installDir") `
    -PassThru
$finished = $p.WaitForExit(900000)
$result.installExit = ExitText $p
Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
if (-not $finished) { try { $p.Kill() } catch { } }

$result.dshAfter = Test-Path -LiteralPath $dshCmd
$result.webView2After = [bool](Get-ItemProperty -LiteralPath $webviewKey -ErrorAction SilentlyContinue)
$result.installJson = Test-Path -LiteralPath (Join-Path $installDir 'install.json')
$result.profile = Test-Path -LiteralPath (Join-Path $profileDir 'package.json')
$result.current = Test-Path -LiteralPath (Join-Path $installDir 'current.txt')
if (Test-Path -LiteralPath (Join-Path $installDir 'logs')) {
    Copy-Item -LiteralPath (Join-Path $installDir 'logs') -Destination (Join-Path $outDir 'install-logs') -Recurse -Force
}

$shell = Join-Path $installDir 'shell\DshSuite.Shell.exe'
if (Test-Path -LiteralPath $shell) {
    $smoke = Start-Process -FilePath $shell -ArgumentList @('--smoke-test') -PassThru
    $smokeFinished = $smoke.WaitForExit(180000)
    $smokeFile = Join-Path $homeDir 'smoke-result.json'
    if (Test-Path -LiteralPath $smokeFile) {
        Copy-Item -LiteralPath $smokeFile -Destination (Join-Path $outDir 'smoke-result.json') -Force
        try {
            $smokeJson = Get-Content -LiteralPath $smokeFile -Raw | ConvertFrom-Json
            $result.shellSmoke = $smokeJson.ok
            $result.shellError = $smokeJson.error
        } catch { }
    }
    $result.shellSmokeExit = ExitText $smoke
    if (-not $smokeFinished) { try { $smoke.Kill() } catch { } }
}

$result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
Save $result
$result | Format-List
