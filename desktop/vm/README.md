# Clean-VM acceptance for the desktop installer

Goal: prove that a **clean Windows machine with no DSH and no WebView2** can run
`dsh-automation-suite-setup-0.2.0.exe` and end with a working shell.

## Image choice

Use **Windows 11 Enterprise LTSC 2024 Evaluation (English, x64)**:

- official Microsoft Evaluation ISO, 90 days, no product key;
- LTSC is a minimal desktop image (no Store/consumer apps);
- if WebView2 happens to be present, the baseline check detects it and
  `remove-webview2.ps1` removes it for the missing-runtime test.

ISO URL used by the build:

```text
https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_LTSC_EVAL_x64FRE_en-us.iso
```

Local path: `C:\VMs\ISO\Win11EnterpriseLTSC2024Eval.iso`.

## 1. Administrator action (one time)

Windows Sandbox is already enabled; Hyper-V is installed and `vmms` is running.
The current user just needs Hyper-V management rights. In an **elevated**
PowerShell:

```powershell
Add-LocalGroupMember -Group "Hyper-V Administrators" -Member "$env:COMPUTERNAME\$env:USERNAME"
```

Then sign out and back in (or reboot). Verify:

```powershell
Get-VM
```

## 2. Create the VM

```powershell
pwsh -NoProfile -File desktop/vm/create-clean-vm.ps1
```

This creates `DSH-Clean` (Gen2, 4 GB RAM, 2 vCPU, 64 GB VHDX, Default Switch,
vTPM, Secure Boot) and opens `vmconnect`.

Install Windows 11 LTSC:

- choose **Custom: Install Windows only**;
- select the unallocated 64 GB disk;
- create a **local** test account (LTSC does not require a Microsoft account);
- after first sign-in, let Windows finish updates if it asks, but do not install
  DSH or WebView2 manually.

## 3. Baseline and checkpoint

Copy `baseline-check.ps1` into the VM (or paste it) and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\baseline-check.ps1
```

Expected: `dshPresent=False`, `webview2Registered=False`,
`edgeWebViewFolder=False`, `suiteInstalled=False`.

If WebView2 is present:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\remove-webview2.ps1
# reboot, then rerun baseline-check.ps1
```

In Hyper-V Manager take a checkpoint named `clean-no-dsh-no-webview2`.

## 4. Copy the installer into the VM

From the host (admin PowerShell), after the VM is running with integration
services:

```powershell
Copy-VMFile -VMName DSH-Clean `
  -SourcePath "C:\Users\Ansel\dsh-automation-suite\dist\desktop\0.2.0\dsh-automation-suite-setup-0.2.0.exe" `
  -DestinationPath "C:\Users\Public\Desktop\dsh-automation-suite-setup-0.2.0.exe" `
  -CreateFullPath -FileSource Host
```

Or use a temporary host HTTP server and download it inside the VM.

Copy `run-clean-acceptance.ps1` to the same desktop.

## 5. Run acceptance

In the VM, use an **elevated** PowerShell (needed for the WebView2 bootstrapper)
and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\run-clean-acceptance.ps1"
```

It writes `Desktop\suite-acceptance\result.json`, copies installer logs, and runs
the shell `--smoke-test`. Expected:

```text
installExit = 0
dshAfter = True
webView2After = True
installJson = True
profile = True
current = True
shellSmoke = True
```

Also do one **interactive** install once, so the unsigned SmartScreen prompt and
the download progress are observed. Test a Chinese/space path separately, e.g.
`/DIR="C:\测试 路径\Suite"`.

## 6. Report back

Copy these back to the host (or paste the content):

```text
Desktop\baseline.json
Desktop\suite-acceptance\result.json
Desktop\suite-acceptance\install-logs\*
Desktop\suite-acceptance\smoke-result.json
```

If the shell smoke fails, also include the shell log from
`%USERPROFILE%\dsh-automation-suite-home\logs\shell-*.log` and the WebView2
bootstrap logs from the install logs directory.
