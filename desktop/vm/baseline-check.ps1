# Run inside the clean VM: records whether DSH/WebView2/suite are absent.
$ErrorActionPreference = 'Continue'
$webviewKey = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$webviewProps = Get-ItemProperty -LiteralPath $webviewKey -ErrorAction SilentlyContinue
$dshCmd = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$suiteRoot = Join-Path $env:LOCALAPPDATA 'dsh-automation-suite'

$result = [ordered]@{
    computerName = $env:COMPUTERNAME
    os = (Get-CimInstance Win32_OperatingSystem).Caption
    build = (Get-CimInstance Win32_OperatingSystem).BuildNumber
    dshPresent = (Test-Path -LiteralPath $dshCmd)
    dshExe = if (Test-Path -LiteralPath $dshCmd) { $dshCmd } else { $null }
    webview2Registered = [bool]$webviewProps
    webview2Version = if ($webviewProps) { $webviewProps.pv } else { $null }
    edgeWebViewFolder = (Test-Path -LiteralPath 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application')
    suiteInstalled = (Test-Path -LiteralPath $suiteRoot)
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$result | ConvertTo-Json | Set-Content -LiteralPath "$env:USERPROFILE\Desktop\baseline.json" -Encoding utf8
$result | Format-List
