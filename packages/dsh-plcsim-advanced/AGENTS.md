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
- **F-CPU (fail-safe) projects are a hard boundary.** PLCSIM Advanced V7 does
  support fail-safe CPUs, but a standard-CPU instance cannot take F project data
  (V7 function manual §7.4: "Loading project data of an F-CPU to a standard CPU
  is not possible"; TIA reports "virtual PLC model does not match the project PLC
  model"). Create such instances with the matching F family (`cpu_type="1515F"`,
  the enum carries `1511F`…`1518F`) or, preferably, `cpu_model` with the project
  order number/type name (`6ES7 515-2FM01-0AB0`, `CPU 1515F-2 PN`); `cpu_type`
  `unspecified` also works (the first TIA download initializes the type). **Never**
  create a standard family for an F project. V17 Openness also cannot download to
  an F-activated PLC (`download_unavailable`, R16), so the download must happen in
  the TIA Portal UI: tell the user up front that the suite cannot finish the flow
  automatically instead of reporting a missing runtime.

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
- **Scan before creating.** `create` refuses with `snapshots_available` while the
  workspace snapshot root holds any snapshot; the model is expected to ask the
  user "resume one of these or make a new instance?" and only then pass
  `confirm_new=true`. Keep that gate: it is the only place that enforces the
  question, and the alternative (silently creating) costs a full TIA download plus
  a manual certificate click.
- **The certificate is per virtual device.** A brand-new instance is a new MAC
  with its own self-signed certificate, so its first CONNECT/download needs one
  manual **Connect** click in the TIA Portal UI; Openness cannot answer that
  dialog. A `resume`/`restore` of a snapshot keeps the original identity and needs
  no acceptance. The tool descriptions state this rule up front (test
  `the certificate rule is stated in every tool description`); when the user asks
  to start a simulation, say it before creating anything instead of discovering it
  at the failed download.
- Rendered results always include the short fact line (`Key facts: name=… state=…
  cpuType=… ip=…`), independent of `verboseResults`. Do not remove it: an empty
  "succeeded" answer is what made a 0.2.4 session probe a healthy runtime for 20
  minutes — the pod is never rich enough to hide the coordinates.

## 6. Persistence

- `snapshot` / `restore` use the official `IInstance.ArchiveStorage(zip)` /
  `RetrieveStorage(zip)`; the ZIP is the portable archive and contains the
  program, hardware configuration and retentive data.
- `ArchiveStorage`/`RetrieveStorage` require the instance to be **OFF**;
  `ArchiveStorage` also requires the instance to have been powered on at least
  once. The snapshot action preserves the previous RUN/STOP state.
- `snapshot` also writes a `storage/` copy for the fast path. `resume` attaches to
  a still-registered instance (`CreateInterface`) or copies `storage/`; it falls
  back to `RetrieveStorage(zip)` for old snapshots.
- Snapshots live under the **session workspace**, `<workspace>/.dsh/simulation`,
  as `<name>/instance.zip` + `<name>/storage/` + `manifest.json`. The root is
  derived per call in `src/workspace.ts` from `exec.agent.session.header.cwd` and
  passed to the controller as `snapshot_root`; **never** derive it from
  `process.cwd()` (the host process directory): snapshots then land outside the
  workspace, are missing from its backups, and are invisible after a restart.
  `config.snapshotRoot` (default `''` = derive) remains the explicit override.
- Keep snapshots out of git and do not copy one across incompatible PLCSIM
  Advanced versions.
