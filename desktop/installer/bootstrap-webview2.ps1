# Ensure the Evergreen WebView2 Runtime is present.
#
# The Windows Sandbox image has Edge but no WebView2 Runtime; the shell fails
# with "Couldn't find a compatible Webview2 Runtime installation to host WebViews."
# This script is called by install-profile.ps1 during setup.
$ErrorActionPreference = 'Stop'

function Find-WebView2 {
    # Use the EdgeUpdate registration, not directory existence. Windows Sandbox
    # contains an unregistered EdgeWebView folder that WebView2 rejects with
    # "Couldn't find a compatible Webview2 Runtime installation".
    $keys = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients',
        'HKCU:\Software\Microsoft\EdgeUpdate\Clients'
    )
    foreach ($key in $keys) {
        if (-not (Test-Path $key)) { continue }
        foreach ($client in Get-ChildItem $key -ErrorAction SilentlyContinue) {
            $props = Get-ItemProperty $client.PSPath -ErrorAction SilentlyContinue
            if ($props.name -match 'WebView2' -and $props.pv) {
                return "$($props.name) $($props.pv)"
            }
        }
    }
    return $null
}

$existing = Find-WebView2
if ($existing) {
    Write-Host "WebView2 runtime found: $existing"
    exit 0
}

Write-Host 'WebView2 runtime not found; downloading the Evergreen Bootstrapper'
$installer = Join-Path $env:TEMP 'MicrosoftEdgeWebview2Setup.exe'
Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 `
    -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer

$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
    throw "WebView2 bootstrapper signature check failed: $($signature.Status)"
}

$process = Start-Process -FilePath $installer -ArgumentList @('/silent', '/install') -PassThru -Wait
if ($process.ExitCode -ne 0) {
    throw "WebView2 bootstrapper exited with $($process.ExitCode)"
}

for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $existing = Find-WebView2
    if ($existing) {
        Write-Host "WebView2 runtime installed: $existing"
        exit 0
    }
}
throw 'WebView2 runtime was not detected after the bootstrapper completed.'
