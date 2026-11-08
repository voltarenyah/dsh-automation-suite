# Test-only: remove WebView2 without letting Edge Update put it back.
# Run elevated via Run-Prepare-NoWebView2.cmd, then reboot.
$ErrorActionPreference = 'Continue'
$log = 'C:\Users\Public\Desktop\prepare-no-webview2.txt'
"prepare started $(Get-Date -Format o)" | Set-Content -LiteralPath $log -Encoding utf8

foreach ($name in @('edgeupdate', 'edgeupdatem')) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($svc) {
        Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
        Set-Service -Name $name -StartupType Disabled -ErrorAction SilentlyContinue
        Add-Content -LiteralPath $log -Value "service ${name}: $((Get-Service $name).Status) / $((Get-Service $name).StartType)"
    }
}
Get-ScheduledTask -TaskName '*EdgeUpdate*' -ErrorAction SilentlyContinue |
    ForEach-Object {
        Disable-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction SilentlyContinue | Out-Null
        Add-Content -LiteralPath $log -Value "task disabled: $($_.TaskPath)$($_.TaskName)"
    }

& "$PSScriptRoot\remove-webview2.ps1" *>&1 | Tee-Object -FilePath $log -Append
$key = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
if (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue) {
    Add-Content -LiteralPath $log -Value 'ERROR: WebView2 registration is still present'
} else {
    Add-Content -LiteralPath $log -Value 'OK: WebView2 registration is gone; reboot now.'
}
