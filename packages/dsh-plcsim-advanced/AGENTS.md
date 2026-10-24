# AGENTS.md — dsh-plcsim-advanced

Package-level conventions for `@voltarenyah/dsh-plcsim-advanced`.
User-level rules are in `~/.dsh/AGENTS.md`; repository-level rules are in the
root `AGENTS.md`.

## 1. Scope

- This package is the **runtime half** of the simulation capability: PLCSIM
  Advanced instance lifecycle, TCP/IP or Softbus, RUN/STOP/reset and tag I/O.
- It is **not** a program loader. The TIA Openness plugin owns the download; the
  proven flow needs the project PLC to have a subnet/IP and the first connection
  certificate accepted once in the TIA UI, then `adopt_open_project` +
  `online_disconnect(force)` + `download`. Do not add a fake `download`/`load`
  tool here.
- The plugin never writes a TIA project and never talks to TIA Portal.

## 2. Version and API policy

- Compile the controller against **PLCSIM Advanced API 4.0**
  (`Siemens.Simatic.Simulation.Runtime.Api.x64, Version=4.0.0.4303`). The
  Runtime Manager is backward compatible with older API clients; V7 was verified
  in the assessment. Do not switch the baseline to 7.0 without re-verifying
  4.0–6.0 runtimes.
- Reference the API assembly with `Private=false` / `CopyLocal=false` and load it
  from `apiDir` via the controller's `AssemblyResolve`. **Never** copy a Siemens
  DLL into `controller/bin` or the npm package.
- TCP/IP and Softbus are both supported. On API 4.0 the switch is
  `IInstance.CommunicationInterface` **before** `PowerOn`; the IP suite is applied
  with `SetIPSuite(0, …)` **after** `PowerOn`. Do not expose physical adapter
  mapping; TCP/IP is for the PLCSIM virtual adapter.
- The first `create` starts the PLCSIM Advanced Control Panel by default
  (`showControlPanel`); keep it enabled so the user can see name/IP/comm/state.
- `keepInstancesOnUnload` defaults to true. The explicit cleanup is the
  `remove` action, not plugin unload.

## 3. Two Loader rows

- Host row (`src/index.ts`, package `"."`): owns the one C# controller and the
  internal `plcsimRuntime` seam. It registers **no model-facing tool**.
- `/tools` row (`src/tools-entry.ts`, package `"./tools"`): the four tools. It is
  declared by the leader preset only; expert/auditor must not inherit it.
- Keep the package name, `cordis.patch.yml` `insert[].name` and the profile
  bundle entry identical (`@voltarenyah/dsh-plcsim-advanced`, quoted in YAML).

## 4. Commands

```powershell
npm run link:runtime      # once per checkout, from <DSH_HOME>\plugin-runtime
npm run build
npm run build:controller  # needs PLCSIM Advanced + .NET SDK; also runs --self-test
npm test
npm run check             # build + test
```

The TypeScript tests need the real `@deepseek-ai/*` runtime links (the same
reason as the sibling plugins). The controller self-test does not need a running
instance.

## 5. Safety

- `power_off` / `remove` require `confirm=true`.
- Every tag write requires `confirm=true`; the list is capped.
- Softbus remains the default; TCP/IP is passed explicitly for the Openness
  workflow and must match the project IP. Do not add physical adapter mapping.
- `keepInstancesOnUnload` defaults to true; `remove` is the explicit cleanup.
  Do not silently fall back to a different instance or storage root.

## 6. Persistence

- `snapshot` / `restore` use the official `IInstance.ArchiveStorage(zip)` /
  `RetrieveStorage(zip)`, not a raw directory copy. The archive contains the
  program, hardware configuration and retentive data.
- `ArchiveStorage`/`RetrieveStorage` require the instance to be **OFF**;
  `ArchiveStorage` also requires the instance to have been powered on at least
  once. The snapshot action preserves the previous RUN/STOP state.
- Snapshots live under `snapshotRoot` (`<workspace>/.dsh/simulation` by default)
  as `<name>/instance.zip` + `manifest.json`; keep them out of git and do not
  copy a snapshot across incompatible PLCSIM Advanced versions.
