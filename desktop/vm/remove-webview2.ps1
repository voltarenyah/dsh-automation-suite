# Test-only: remove the Evergreen WebView2 Runtime from a clean VM so the suite
# installer's WebView2 bootstrap can be exercised. Run elevated, then reboot.
$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$props = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
if (-not $props) {
    Write-Host 'WebView2 Runtime is already absent.'
    exit 0
}
if (-not $props.SilentUninstall) {
    throw 'WebView2 registered but SilentUninstall is missing; remove it from Apps & Features manually.'
}
Write-Host "removing WebView2 $($props.pv) ..."
cmd /c $props.SilentUninstall
$exit = $LASTEXITCODE
Write-Host "uninstall exit: $exit"
$after = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
if ($after) { throw 'WebView2 registration still present; reboot or remove manually.' }
Write-Host 'WebView2 registration is gone; reboot before running the acceptance test.'
