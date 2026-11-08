# Launch a clean Windows Sandbox for the desktop installer.
#
#   pwsh -NoProfile -File desktop/sandbox/start-sandbox.ps1
#   pwsh -NoProfile -File desktop/sandbox/start-sandbox.ps1 -Offline
#   pwsh -NoProfile -File desktop/sandbox/start-sandbox.ps1 -AppVersion 0.2.0
#
# Prerequisites: Windows Pro/Enterprise and the "Windows Sandbox" optional
# feature enabled (one elevated command + reboot; see README.md in this folder).
[CmdletBinding()]
param(
    [string]$AppVersion = '0.2.0',
    [string]$OutputDir = '',
    [switch]$Offline,
    [switch]$Test
)

$ErrorActionPreference = 'Stop'
$sandboxExe = 'C:\Windows\System32\WindowsSandbox.exe'

$existing = Get-Process WindowsSandboxRemoteSession,WindowsSandboxServer -ErrorAction SilentlyContinue
if ($existing) {
    throw "A Windows Sandbox session is already running. Close its window; if it is stuck, reboot before starting another test."
}
$orphan = Get-Process vmmemWindowsSandbox -ErrorAction SilentlyContinue
if ($orphan) {
    throw "An orphaned Windows Sandbox VM is still resident (vmmemWindowsSandbox). Reboot before starting another test."
}
if (-not (Test-Path -LiteralPath $sandboxExe)) {
    throw @'
Windows Sandbox is not enabled on this machine.
Run this in an elevated PowerShell, then reboot:
  Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
'@
}

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dist = Join-Path $root 'dist'
if (-not (Test-Path -LiteralPath (Join-Path $dist "desktop\$AppVersion"))) {
    throw "release folder not found: $dist\desktop\$AppVersion"
}
if (-not $OutputDir) { $OutputDir = Join-Path $env:USERPROFILE 'dsh-sandbox-output' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Escape-Xml([string]$text) { [System.Security.SecurityElement]::Escape($text) }
$network = if ($Offline) { 'Disable' } else { 'Enable' }
$sandboxXml = Escape-Xml $PSScriptRoot
$distXml = Escape-Xml $dist
$outXml = Escape-Xml $OutputDir
$logon = if ($Test) {
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\sandbox\clean-install-test.ps1'
} else {
    "cmd.exe /c start `"`" `"C:\dist\desktop\$AppVersion`""
}
$logonXml = Escape-Xml $logon

$wsb = @"
<Configuration>
  <Networking>$network</Networking>
  <!-- vGPU sharing can make the Sandbox RDP client log off; the shell is 2D only. -->
  <VGpu>Disable</VGpu>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$distXml</HostFolder>
      <SandboxFolder>C:\dist</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$sandboxXml</HostFolder>
      <SandboxFolder>C:\sandbox</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$outXml</HostFolder>
      <SandboxFolder>C:\out</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>$logonXml</Command>
  </LogonCommand>
</Configuration>
"@

$wsbPath = Join-Path $env:TEMP "dsh-automation-suite-$AppVersion.wsb"
Set-Content -LiteralPath $wsbPath -Value $wsb -Encoding utf8
Write-Host "sandbox config: $wsbPath"
Write-Host "  release (ro): $dist"
Write-Host "  output (rw):  $OutputDir"
Write-Host "  networking:   $network"
Write-Host "  mode:         $(if ($Test) { 'automated clean-install test' } else { 'interactive' })"
Start-Process -FilePath $sandboxExe -ArgumentList "`"$wsbPath`""
