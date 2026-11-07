# Installer runtime bootstrap probe — detect DSH/WebView2 and inspect the official feed.
#
#   pwsh -NoProfile -File scripts/probe-dsh-runtime.ps1 -Json
#   pwsh -NoProfile -File scripts/probe-dsh-runtime.ps1 -DshHome C:\temp\dsh-home
#   pwsh -NoProfile -File scripts/probe-dsh-runtime.ps1 -NoFetch
#
# This is a dry-run prototype for the desktop installer. It never downloads or
# installs anything; it answers "what is already there, what is missing, and what
# would the installer do next". The JSON shape is deliberately small and stable.
[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$AppRoot = '',
    [string]$FeedUrl = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
    [switch]$NoFetch,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$schemaVersion = 1
$result = [ordered]@{
    schemaVersion = $schemaVersion
    generatedAt   = (Get-Date).ToUniversalTime().ToString('o')
    dsh           = $null
    webview2      = $null
    netfx48       = $null
    feed          = $null
    plan          = $null
}

function Find-Dsh {
    $candidates = @()
    if ($env:DSH_EXE) { $candidates += $env:DSH_EXE }
    $roots = @()
    if ($AppRoot) { $roots += $AppRoot }
    if ($env:DSH_APP_ROOT) { $roots += $env:DSH_APP_ROOT }
    $roots += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')
    foreach ($root in $roots) {
        $candidates += (Join-Path $root 'resources\runtime\cli\bin\dsh.cmd')
    }
    foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (-not (Test-Path $hive)) { continue }
        Get-ChildItem $hive -ErrorAction SilentlyContinue | ForEach-Object {
            $item = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($item.DisplayName -match 'DeepSeek Harness' -and $item.InstallLocation) {
                $candidates += (Join-Path $item.InstallLocation 'resources\runtime\cli\bin\dsh.cmd')
            }
        }
    }
    $onPath = Get-Command dsh -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    $candidates = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
    $dsh = $candidates | Select-Object -First 1
    if (-not $dsh) {
        return [ordered]@{ found = $false; path = $null; version = $null; appRoot = $null }
    }
    $version = ((& $dsh --version 2>&1) | Select-Object -First 1)
    $root = Resolve-Path (Join-Path (Split-Path -Parent $dsh) '..\..\..\..') -ErrorAction SilentlyContinue
    return [ordered]@{
        found   = $true
        path    = $dsh
        version = [string]$version
        appRoot = if ($root) { [string]$root } else { $null }
    }
}

function Find-WebView2 {
    $keys = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )
    foreach ($key in $keys) {
        if (-not (Test-Path $key)) { continue }
        $item = Get-ItemProperty $key -ErrorAction SilentlyContinue
        if ($item.pv) {
            return [ordered]@{ found = $true; version = [string]$item.pv; source = $key }
        }
    }
    $dir = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application'
    if (Test-Path $dir) {
        $version = Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
        if ($version) {
            return [ordered]@{ found = $true; version = $version; source = $dir }
        }
    }
    return [ordered]@{ found = $false; version = $null; source = $null }
}

function Read-Feed {
    if ($NoFetch) {
        return [ordered]@{ ok = $false; skipped = $true; reason = 'NoFetch' }
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $FeedUrl -TimeoutSec 30 -Headers @{ 'User-Agent' = 'dsh-automation-suite-probe' }
        # The feed is served as application/octet-stream, so Windows PowerShell
        # hands back a byte[]; decode it explicitly instead of parsing "118 101 …".
        $text = if ($response.Content -is [byte[]]) {
            [System.Text.Encoding]::UTF8.GetString($response.Content)
        } else {
            [string]$response.Content
        }
        $version = [regex]::Match($text, '(?m)^version:\s*([^\r\n]+)').Groups[1].Value.Trim()
        # electron-builder writes folded scalars: `url: >-` then the URL on the
        # next line; accept both folded and inline forms.
        $url = [regex]::Match($text, 'url:\s*(?:>-)?\s*\r?\n?\s*(https://\S+)').Groups[1].Value.Trim()
        $sha512 = [regex]::Match($text, 'sha512:\s*(?:>-)?\s*\r?\n?\s*([^\s]+)').Groups[1].Value.Trim()
        $size = [regex]::Match($text, 'size:\s*(\d+)').Groups[1].Value.Trim()
        if (-not $url -or -not $version) {
            return [ordered]@{ ok = $false; skipped = $false; reason = 'feed missing version/url'; status = $response.StatusCode }
        }
        $uri = [Uri]$url
        if ($uri.Host -ne 'download.deepseek.com') {
            return [ordered]@{ ok = $false; skipped = $false; reason = "feed URL host is not download.deepseek.com: $($uri.Host)" }
        }
        return [ordered]@{
            ok            = $true
            skipped       = $false
            version       = $version
            url           = $url
            size          = if ($size) { [long]$size } else { $null }
            sha512Prefix  = if ($sha512) { $sha512.Substring(0, [Math]::Min(12, $sha512.Length)) } else { $null }
            status        = $response.StatusCode
        }
    }
    catch {
        return [ordered]@{ ok = $false; skipped = $false; reason = $_.Exception.Message }
    }
}

$result.dsh = Find-Dsh
$result.webview2 = Find-WebView2
$net48 = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Release
$result.netfx48 = [ordered]@{ release = $net48; ok = ($net48 -ge 528040) }
$result.feed = Read-Feed

$result.plan = [ordered]@{
    needsDshInstall = -not $result.dsh.found
    needsWebView2   = -not $result.webview2.found
    needsNetFx48    = -not $result.netfx48.ok
    next            = if (-not $result.dsh.found) { 'download and install DSH from the official feed' }
                      elseif (-not $result.webview2.found) { 'install the WebView2 Evergreen runtime' }
                      else { 'ready for the app layer and shell' }
}

if ($Json) {
    $result | ConvertTo-Json -Depth 6
}
else {
    Write-Host ''
    Write-Host 'desktop installer bootstrap probe'
    Write-Host ("  DSH:       " + $(if ($result.dsh.found) { "$($result.dsh.version) at $($result.dsh.path)" } else { 'MISSING' }))
    Write-Host ("  WebView2:  " + $(if ($result.webview2.found) { $result.webview2.version } else { 'MISSING' }))
    Write-Host ("  .NET 4.8:  " + $(if ($result.netfx48.ok) { "release $($result.netfx48.release)" } else { 'MISSING' }))
    if ($result.feed.skipped) { Write-Host '  feed:      skipped (-NoFetch)' }
    elseif ($result.feed.ok) { Write-Host ("  feed:      $($result.feed.version) -> $($result.feed.url)") }
    else { Write-Host ("  feed:      FAILED: " + $result.feed.reason) }
    Write-Host ("  next:      " + $result.plan.next)
}
