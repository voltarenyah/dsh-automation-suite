# Windows Sandbox test environment

Use this for packaging/installer tests that need a **clean Windows** without an
ISO, license, or persistent VM. The sandbox is disposable; close it to reset.
WebView2/TIA cases that the sandbox cannot model are intentionally out of scope.

## Enable once (administrator + reboot)

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
```

Reboot, then verify:

```powershell
Test-Path C:\Windows\System32\WindowsSandbox.exe   # True
```

## Launch

```powershell
pwsh -NoProfile -File desktop/sandbox/start-sandbox.ps1 -AppVersion 0.2.0
# offline failure-path test:
pwsh -NoProfile -File desktop/sandbox/start-sandbox.ps1 -AppVersion 0.2.0 -Offline
```

The script maps:

- `dist/` → `C:\dist` (read-only)
- `%USERPROFILE%\dsh-sandbox-output` → `C:\out` (read-write)

and opens `C:\dist\desktop\<version>` in Explorer.

## Test matrix in the sandbox

| Scenario | Steps |
|---|---|
| Installer with DSH missing | Run `dsh-automation-suite-setup-<ver>.exe`; it should block and explain DSH is required (Phase 2c will make it download DSH). |
| Install with DSH present | Install DSH in the sandbox, then run setup; check `%USERPROFILE%\dsh-automation-suite-home\profiles\dsh-automation-suite`, `install.json`, `current.txt`, doctor. |
| Shell UI | Launch the desktop shortcut or `C:\dist\desktop\<ver>\app\shell\DshSuite.Shell.exe`; confirm the WebView2 window. |
| Upgrade in one session | Install version A, modify a user setting in `cordis.patch.yml`, then install version B; confirm backup + merged override. |
| Offline | Reopen with `-Offline`; verify DSH download/bootstrap and npm-related errors are clear. |
| Uninstall | Uninstall; install directory should be removed, `%USERPROFILE%\dsh-automation-suite-home` retained. |

## Out of scope here

- **Missing WebView2**: Windows Sandbox normally includes Edge/WebView2; use a
  Windows 10 VM if the bootstrapper itself must be tested.
- **TIA Portal / PLCSIM**: commercial software and heavy install; test those on
  the host machine, not the sandbox.
- **Persistent snapshots**: use Hyper-V if repeated checkpoint/rollback is needed.

## The "remote environment is logging off" client message

That message comes from the **Windows Sandbox RDP client**, not from the suite
installer. It appears when the sandbox VM session ends, most often because
`WindowsSandboxRemoteSession` / `WindowsSandboxServer` was force-stopped from the
host (this is how we produced it during early runs), an older sandbox VM was
still alive, or vGPU sharing crashed the remote session.

The `.wsb` disables vGPU, and the automated test starts Explorer before the
LogonCommand exits so the desktop stays alive. Do not kill sandbox processes to
close a test: close the window. If `vmmemWindowsSandbox` / `vmwp` remain and the
launcher refuses to start, reboot once.

**WebView2 correction:** Windows Sandbox contains an EdgeWebView folder but no
registered WebView2 Runtime; the shell can fail with "Couldn't find a compatible
Webview2 Runtime installation". That is a real prerequisite, not a test artifact.
