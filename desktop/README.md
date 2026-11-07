# Desktop packaging foundation

This directory is reserved for the WebView2 shell and installer. The packaging
preparation lives in `scripts/` so it can be tested without the shell UI.

Status (2026-11-07): **prep complete; Phase 1 shell and Phase 2 installer not started.**

## What is already in place

| Contract | Implementation | Verification |
|---|---|---|
| App layer materialization | [`scripts/build-app-layer.mjs`](../scripts/build-app-layer.mjs) | offline `dsh --dump-config` + `doctor.ps1 -Json`, no pnpm/registry |
| Doctor JSON contract | [`scripts/doctor.ps1`](../scripts/doctor.ps1), [`scripts/test-doctor-json.ps1`](../scripts/test-doctor-json.ps1) | schemaVersion 1, pure JSON, `summary.fail` gate |
| Fixed-profile three-way merge | [`scripts/merge-profile.mjs`](../scripts/merge-profile.mjs) | `scripts/test-merge-profile.mjs` |
| DSH startup/cleanup contract | [`scripts/dsh-launch.mjs`](../scripts/dsh-launch.mjs), [`scripts/probe-dsh-web.mjs`](../scripts/probe-dsh-web.mjs) | token URL observed, process tree killed, no new controller |
| Installer runtime bootstrap | [`scripts/probe-dsh-runtime.ps1`](../scripts/probe-dsh-runtime.ps1) | detects DSH/WebView2/.NET 4.8, parses official `nightly.yml` |

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

## Next steps

1. WebView2 shell (`DshSuite.Shell`): window, tray, single instance, logs, start/stop.
2. Inno Setup + C# setup helper: DSH/WebView2 bootstrap, app layer copy, profile merge, doctor.
3. Fixed-profile upgrade/rollback and clean-VM acceptance matrix.
