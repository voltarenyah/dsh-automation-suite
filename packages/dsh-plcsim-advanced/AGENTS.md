# AGENTS.md — dsh-plcsim-advanced

Package-level conventions for `@voltarenyah/dsh-plcsim-advanced`.
User-level rules are in `~/.dsh/AGENTS.md`; repository-level rules are in the
root `AGENTS.md`.

## 1. Scope

- This package is the **runtime half** of the simulation capability: PLCSIM
  Advanced instance lifecycle, RUN/STOP/reset and tag I/O.
- It is **not** a program loader. TIA V17/V18 Openness has no
  `TargetForSoftware` / `PlcSimulationAdvanced` API (V19+ only), so an Openness
  download to a fresh instance fails. Do not add a fake `download`/`load` tool
  here; the program-load route is a separate decision in
  `docs/simulation-plcsim-advanced.md` §10.
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
- Softbus is the only network mode in this MVP. TCP/IP is an explicit opt-in for
  later; do not expose physical adapter mapping.

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
- Instances are unregistered when the controller exits; do not promise
  persistence across DSH restarts.
- Do not silently fall back to a different instance or storage root.
