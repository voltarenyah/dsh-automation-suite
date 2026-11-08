# Desktop packaging foundation

This directory is reserved for the WebView2 shell and installer. The packaging
preparation lives in `scripts/` so it can be tested without the shell UI.

Status (2026-11-08): **Phase 1 shell implemented; Phase 2c DSH download/install,
profile setup, fixed-profile merge, doctor-on-install and install.json are
implemented.** WebView2 bootstrap exists but cannot be reliably tested inside
Windows Sandbox (stale EdgeWebView files); that one acceptance remains a
clean-VM item.

## What is already in place

| Contract | Implementation | Verification |
|---|---|---|
| App layer materialization | [`scripts/build-app-layer.mjs`](../scripts/build-app-layer.mjs) | offline `dsh --dump-config` + `doctor.ps1 -Json`, no pnpm/registry |
| Doctor JSON contract | [`scripts/doctor.ps1`](../scripts/doctor.ps1), [`scripts/test-doctor-json.ps1`](../scripts/test-doctor-json.ps1) | schemaVersion 1, pure JSON, `summary.fail` gate |
| Fixed-profile three-way merge | [`scripts/merge-profile.mjs`](../scripts/merge-profile.mjs) | `scripts/test-merge-profile.mjs` |
| DSH startup/cleanup contract | [`scripts/dsh-launch.mjs`](../scripts/dsh-launch.mjs), [`scripts/probe-dsh-web.mjs`](../scripts/probe-dsh-web.mjs) | token URL observed, process tree killed, no new controller |
| Installer runtime bootstrap | [`scripts/probe-dsh-runtime.ps1`](../scripts/probe-dsh-runtime.ps1) | detects DSH/WebView2/.NET 4.8, parses official `nightly.yml` |
| Phase 1 WebView2 shell | [`desktop/DshSuite.Shell`](DshSuite.Shell/) | `--smoke-test` hidden WebView2 navigation, token URL, process-tree cleanup |

## Build an app layer

```powershell
# from the repository root
node scripts/build-app-layer.mjs --version 0.2.0
```

Output:

```
dist/desktop/<version>/
  app/
    profile/              package.json + cordis.patch.yml + node_modules/ (real files)
    doctor.ps1
    manifest.json         doctor contract (testedDshVersion, ...)
    app-manifest.json     commit, package versions, sizes
  release/<version>/      tarballs + profile used to build it
  build-result.json
```

The installer copies `app/profile` to
`%DSH_HOME%\profiles\dsh-automation-suite\` (fixed name). It must not run pnpm or
touch the npm registry. Upgrades back up the old profile patch and merge user
overrides with `merge-profile.mjs`.

## Build and run the shell

```powershell
# 1) materialize the app layer
node scripts/build-app-layer.mjs --version 0.2.0

# 2) publish the shell into app/shell and run the hidden WebView2 smoke test
pwsh -NoProfile -File desktop/build-shell.ps1 -Version 0.2.0 -SmokeTest

# 3) run it normally (first run copies the profile into the DSH_HOME)
dist\desktop\0.2.0\app\shell\DshSuite.Shell.exe --dsh-home C:\temp\dsh-shell-dev
```

First run copies `app/profile` to `<DshHome>\profiles\dsh-automation-suite` (fixed
name) and reuses it afterwards. The shell starts DSH with `ELECTRON_RUN_AS_NODE=1`
and the direct `cli.js` entry, waits for the token URL, loads it in WebView2, and
owns the process tree via a Job Object. Closing the window hides to the tray;
tray Exit stops DSH. A `--smoke-test` run creates a hidden WebView2 window, waits
for `NavigationCompleted`, writes `smoke-result.json`, and exits without showing UI.

App-layer discovery order: `--app-dir`, `DSH_SUITE_APP_DIR`, the exe's sibling
`profile/` + `app-manifest.json`, the installed `current.txt` / `app/<ver>`
layout, then a repo checkout's `dist/desktop*/<ver>/app` found by walking the
exe's ancestors. This means the build-output exe (`desktop/.../bin/...`) also
works; if you copy the exe away from all of these, pass `--app-dir`.

Both `dotnet build` and publish output are **self-contained**. That means the
`DshSuite.Shell.exe` must stay beside its `coreclr.dll`, `hostfxr.dll` and
`DshSuite.Shell.runtimeconfig.json`. Copying the exe alone gives the Windows
".NET must be installed" dialog — that is not the shipped shape and does not mean
the app requires a separate .NET install.

## Installer skeleton

```powershell
pwsh -NoProfile -File desktop/build-installer.ps1 -Version 0.2.0
```

Output: `dist/desktop/0.2.0/dsh-automation-suite-setup-0.2.0.exe` (about 76 MiB).
It installs per-user under `%LOCALAPPDATA%\dsh-automation-suite`:

```
shell\DshSuite.Shell.exe      stable shortcut target
app\0.2.0\                    versioned app layer (profile + node_modules)
current.txt                   active app-layer version
unins000.exe
```

The installer now runs `installer\install-profile.ps1` after copying files:

- copies `app\<ver>\profile` to `%DSH_HOME%\profiles\dsh-automation-suite`;
- if a profile exists, backs up `package.json` / `cordis.patch.yml`, copies the
  new app layer to a temporary profile, and merges the old user overrides with
  `merge-profile.mjs` (three-way); the previous profile is kept as
  `dsh-automation-suite.bak-<stamp>`;
- writes `<install-root>\install.json` (dshHome/profile/dshExe/appVersion);
- runs `doctor.ps1 -Json`; `summary.fail > 0` restores the previous profile and
  aborts the launch.

Verified in a sandbox (`/VERYSILENT /NOICONS /DIR=C:\temp\...` with a temporary
`DSH_HOME`): profile copied, doctor 11 ok / 1 warn / 0 fail, install.json written,
`current.txt` written, installed shell reads install.json and starts; uninstall
removes the install directory. A simulated upgrade (old app layer 0.1.9 + a
`deepseek-v4-pro` user override) preserved the override and created a backup.

DSH bootstrap is now part of setup (`installer\bootstrap-dsh.ps1`):

- if `dsh.cmd` is missing, fetch the official feed, download the installer,
  verify its SHA-512 and Authenticode signer (DeepSeek), run it silently, and
  wait for `dsh.cmd`;
- if DSH is already present, it is a no-op;
- `install-dsh.json` records the downloaded version/URL/hash;
- `DSH_SETUP_OVERRIDE` is test-only (Sandbox uses a prefetched installer).

Verified: no-DSH Sandbox install with prefetched DSH completed profile + doctor
(7 OK / 5 WARN / 0 FAIL); real download/hash/signature path verified with
`bootstrap-dsh.ps1 -VerifyOnly`.

Current boundaries: WebView2 inside Windows Sandbox is unreliable (unregistered
EdgeWebView folder; bootstrapper 0x80040902), so shell/WebView2 acceptance still
needs a clean VM. No auto-update. The shell reads `install.json` for custom
DSH_HOME/profile and reuses an existing profile (profile replacement/merge is
done by the installer).

## Contracts

### Doctor JSON

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-07T...Z",
  "dshHome": "...",
  "profile": "...",
  "dshExe": "...",
  "dshVersion": "0.2.1-rc.2",
  "results": [
    { "id": "tia", "capability": "TIA Portal V17", "status": "ok|warn|fail", "detail": "...", "fix": "..." }
  ],
  "summary": { "ok": 11, "warn": 1, "fail": 0 }
}
```

Rules: `-Json` emits only JSON on stdout; exit 1 only when `summary.fail > 0`
(`-NoFail` forces 0); installer blocks on fail, warns otherwise.

### DSH launch

Do not spawn `dsh.cmd` from Node: its path contains spaces. Use:

```
ELECTRON_RUN_AS_NODE=1 "<DSH_APP_ROOT>\DeepSeek Harness.exe" \
  --expose-internals "<DSH_APP_ROOT>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" \
  --profile dsh-automation-suite --port 0 --no-open
```

Wait up to 60 s for `dsh web: http://127.0.0.1:<port>/?token=…`; keep the token
out of logs; kill the process tree on exit (Job Object in the shell).

### Profile merge

Inputs: old user patch, old app-layer baseline, new app-layer baseline. Output:
merged patch + JSON report. App-owned `- insert:` blocks come from the new
baseline; only user-modified `- id:` blocks override it. The installer must keep
a `.bak-<timestamp>` next to the old files and report conflicts.

## Windows Sandbox test environment

For clean-Windows packaging tests (no ISO/license), enable Windows Sandbox once
(elevated PowerShell + reboot):

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
```

Then:

```powershell
pwsh -NoProfile -File desktop/sandbox/start-sandbox.ps1 -AppVersion 0.2.0
# offline failure-path:
pwsh -NoProfile -File desktop/sandbox/start-sandbox.ps1 -AppVersion 0.2.0 -Offline
```

It maps `dist/` read-only to `C:\dist`, a host output folder read-write to
`C:\out`, and opens the release folder. See [`sandbox/README.md`](sandbox/README.md)
for the test matrix. WebView2-missing and TIA/PLCSIM cases are explicitly out of
scope for the sandbox.

## Next steps

1. Phase 2 completion: DSH/WebView2 bootstrap, fixed-profile backup/merge on
   upgrade, doctor-on-install, and a C# setup helper for failure handling.
2. Fixed-profile upgrade/rollback and clean-VM acceptance matrix.
3. Signed/unsigned distribution decision (currently unsigned per docs P9).
