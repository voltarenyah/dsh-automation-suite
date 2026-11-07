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
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$sandboxExe = 'C:\Windows\System32\WindowsSandbox.exe'
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
$distXml = Escape-Xml $dist
$outXml = Escape-Xml $OutputDir

$wsb = @"
<Configuration>
  <Networking>$network</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$distXml</HostFolder>
      <SandboxFolder>C:\dist</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$outXml</HostFolder>
      <SandboxFolder>C:\out</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>cmd.exe /c start "" "C:\dist\desktop\$AppVersion"</Command>
  </LogonCommand>
</Configuration>
"@

$wsbPath = Join-Path $env:TEMP "dsh-automation-suite-$AppVersion.wsb"
Set-Content -LiteralPath $wsbPath -Value $wsb -Encoding utf8
Write-Host "sandbox config: $wsbPath"
Write-Host "  release (ro): $dist"
Write-Host "  output (rw):  $OutputDir"
Write-Host "  networking:   $network"
Start-Process -FilePath $sandboxExe -ArgumentList "`"$wsbPath`""
