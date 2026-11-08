# Create a clean Hyper-V VM for desktop installer acceptance.
#
# Run from an elevated PowerShell (or a shell in Hyper-V Administrators):
#   pwsh -NoProfile -File desktop/vm/create-clean-vm.ps1
#
# The VM is Gen2, 4 GB RAM, 2 vCPU, 64 GB dynamic VHDX, Default Switch, vTPM
# and Secure Boot (required by Windows 11). The evaluation ISO is mounted and
# the VM boots from it.
[CmdletBinding()]
param(
    [string]$VMName = 'DSH-Clean',
    [string]$IsoPath = 'C:\VMs\ISO\Win11EnterpriseLTSC2024Eval.iso',
    [string]$VMRoot = 'C:\VMs',
    [int]$MemoryGB = 4,
    [int]$VhdGB = 64
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $IsoPath)) {
    throw "ISO not found: $IsoPath"
}
if (Get-VM -Name $VMName -ErrorAction SilentlyContinue) {
    throw "VM already exists: $VMName"
}

$vmDir = Join-Path $VMRoot $VMName
$vhdPath = Join-Path $vmDir "$VMName.vhdx"
New-Item -ItemType Directory -Force -Path $vmDir | Out-Null

Write-Host "creating $VMName ..."
New-VM -Name $VMName -MemoryStartupBytes ($MemoryGB * 1GB) -Generation 2 `
    -NewVHDPath $vhdPath -NewVHDSizeBytes ($VhdGB * 1GB) `
    -SwitchName 'Default Switch' | Out-Null

Set-VMProcessor -VMName $VMName -Count 2
Set-VM -VMName $VMName -AutomaticCheckpointsEnabled $false
Set-VMMemory -VMName $VMName -DynamicMemoryEnabled $true `
    -MinimumBytes 2GB -MaximumBytes ($MemoryGB * 1GB) -StartupBytes ($MemoryGB * 1GB)

# Windows 11 requires vTPM + Secure Boot on Gen2.
Set-VMKeyProtector -VMName $VMName -NewLocalKeyProtector
Enable-VMTPM -VMName $VMName
Set-VMFirmware -VMName $VMName -EnableSecureBoot On -SecureBootTemplate 'MicrosoftWindows'

Add-VMDvdDrive -VMName $VMName -Path $IsoPath
$dvd = Get-VMDvdDrive -VMName $VMName
Set-VMFirmware -VMName $VMName -FirstBootDevice $dvd

Start-VM -Name $VMName
Start-Sleep -Seconds 3
Write-Host "VM started. Opening vmconnect..."
Start-Process -FilePath 'vmconnect.exe' -ArgumentList @('localhost', $VMName)

Write-Host @"

Next steps inside the VM:
  1. Install Windows 11 Enterprise LTSC 2024 Evaluation.
     - Choose "Custom: Install Windows only".
     - The 64 GB virtual disk is unallocated; select it.
     - Create a local test account (no Microsoft account is needed on LTSC).
  2. Sign in and open an elevated PowerShell.
  3. Run C:\Users\Public\Desktop\baseline-check.ps1 (copy it from the host).
  4. In Hyper-V Manager, take a checkpoint named clean-no-dsh-no-webview2.
  5. Copy dsh-automation-suite-setup-0.2.0.exe into the VM and run the acceptance.
"@
