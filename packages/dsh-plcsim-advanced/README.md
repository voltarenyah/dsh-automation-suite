# @voltarenyah/dsh-plcsim-advanced

DSH plugin for **S7-PLCSIM Advanced**: manage local simulated PLC instances and
exchange tags through the PLCSIM Advanced runtime API. It is the runtime half of
the suite's simulation capability.

> **Status: runtime MVP, E2E verified.** Instance lifecycle, TCP/IP or Softbus,
> RUN/STOP/reset and tag I/O work. The proven workflow with the TIA plugin is
> **TIA `online_targets` → create a TCP/IP instance at the project IP → power on →
> TIA `adopt_open_project` / `online_disconnect(force)` / `download` → read tags**.
> Openness download needs two one-time prerequisites on the TIA side: the project
> PLC must have a subnet and unique IP, and the first connection must accept the
> self-signed certificate in the TIA UI. The complete handoff workflow is
> [packages/dsh-tia-openness-v17-min/docs/HANDOFF-PLCSIM-DOWNLOAD.md](../dsh-tia-openness-v17-min/docs/HANDOFF-PLCSIM-DOWNLOAD.md).

## What it does

| Tool | Actions | Notes |
|---|---|---|
| `simulation_status` | read-only | API/Runtime version, licence, instances with name/comm/IP/state |
| `simulation_instance` | `list` / `create` / `power_on` / `power_off` / `remove` / `snapshot` / `restore` | `create` takes `name`, `cpu_type`, `communication`, `ip`; `power_on` applies the IP suite; `snapshot` saves a ZIP; `restore` recreates from one; `power_off`/`remove` need `confirm=true` |
| `simulation_run` | `state` / `run` / `stop` / `reset` | write actions need `confirm=true` |
| `simulation_tags` | `list` / `read` / `write` | `list` capped (default 200); `write` needs `confirm=true` |

Coordinates the TIA side needs are returned directly: `name`, `communication`,
`ip`, `subnetMask`, `gateway`, `state`, `cpuType`, `license`.

The controller speaks one JSON object per line over stdio and holds the PLCSIM
Runtime Manager API client. Instances are kept running when the plugin unloads
(`keepInstancesOnUnload`, default true); `remove` is the explicit cleanup.

## Proven workflow with the TIA plugin

1. **TIA `online_targets`** — read the target PLC's configured IP/subnet and the
   available PC interfaces (TCP/IP uses `Siemens PLCSIM Virtual Ethernet Adapter`).
2. **`simulation_instance(action=create, name="<PROFINET device name>",
   cpu_type="1511", communication="tcpip", ip="<project IP>")`** — creates the
   instance and opens the PLCSIM Advanced Control Panel (`showControlPanel`,
   default true). The CPU family must match the project CPU.
3. **`simulation_instance(action=power_on, name=..., ip="<project IP>")`** —
   powers on and applies the IP suite. The instance should be `STOP` and list an
   IP matching the project.
4. **TIA `adopt_open_project`** — attach to the already-open TIA UI project. If
   the certificate has not been accepted yet, the user accepts it once in the TIA
   UI on the first connection.
5. **TIA `online_disconnect(force=true)`** — drop any online state left by the UI.
6. **TIA `download(dry_run=true)` → `download(confirm=true,
   options="software")`** — verify the target, then download.
7. **`simulation_run(action=run, confirm=true)`** and **`simulation_tags`** —
   confirm the program is running and exercise inputs/outputs.

The two plugins never call each other; the agent passes the coordinates between
them.

## Persistence: snapshot and restore

After the first successful download/run, save the **whole simulated PLC**
(program, hardware configuration and retentive data) as a PLCSIM archive ZIP:

```jsonc
simulation_instance({ "action": "snapshot", "name": "PLC_1", "snapshot": "cylinder-baseline" })
```

This writes under `snapshotRoot`:

```text
.dsh/simulation/cylinder-baseline/
  instance.zip      # ArchiveStorage(): program + hardware + retentive data
  manifest.json     # name, cpuType, communication, ip, subnetMask, gateway, createdAt
```

`snapshot` uses the official `IInstance.ArchiveStorage(zip)`; the instance must
have been powered on at least once. If it is running, the plugin briefly powers
it off, archives, then restores its previous state (RUN is resumed).

Next time, create a new instance directly from the ZIP:

```jsonc
simulation_instance({
  "action": "restore",
  "name": "PLC_1-next",
  "snapshot": "cylinder-baseline",
  "run": true
})
```

`restore` uses `RetrieveStorage(zip)`, applies the CPU/communication/IP from the
manifest (or explicit parameters), powers on, and optionally switches to RUN.
It does not need TIA or a new download. `snapshot`/`restore` are the only
persistence mechanism; the per-instance `storageRoot` directory is a working
copy, not the deliverable.

> Snapshots are local artifacts: keep `snapshotRoot` out of git (the default
> `.dsh/simulation/` is ignored by the repository). A snapshot is tied to the
> PLCSIM Advanced version that created it.

## Safety

- Default communication is **Softbus** (local only); the Openness workflow
  explicitly opts into **TCP/IP** to match the project IP. TCP/IP uses the PLCSIM
  virtual adapter, not a physical adapter mapping.
- Power-off/remove and every write require `confirm=true`.
- The plugin never loads a program and never writes a TIA project.

## Configuration

Every field has a default; a profile may insert the bundle without a config
block.

| field | default | meaning |
|---|---|---|
| `controllerPath` | `''` | bundled `controller/bin/PlcsimAdvanced.Controller.exe` |
| `apiDir` | `C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API\4.0` | API assembly folder; never copied into the package |
| `storageRoot` | `%TEMP%\dsh-plcsim` | root of per-instance storage directories |
| `snapshotRoot` | `<workspace>/.dsh/simulation` | root of snapshot ZIPs and manifests |
| `networkMode` | `softbus` | default when `create` does not pass `communication`; the download workflow passes `tcpip` |
| `showControlPanel` | `true` | start the PLCSIM Advanced Control Panel on the first create |
| `controlPanelPath` | PLCSIM Advanced `bin\...UserInterface.exe` | Control Panel executable |
| `keepInstancesOnUnload` | `true` | leave instances running when the plugin unloads; `remove` cleans up |
| `requestTimeoutMs` | `120000` | per-operation deadline |
| `startupTimeoutMs` | `30000` | ready-handshake deadline |
| `shutdownGraceMs` | `5000` | graceful controller shutdown |
| `maxQueue` | `8` | queued requests before new ones are refused |
| `logControllerOutput` | `false` | forward controller stderr to the plugin logger |
| `verboseResults` | `false` | include the full controller payload in rendered text |

The API baseline is **PLCSIM Advanced 4.0** (`4.0.0.4303`): it covers 4.0–7.0
because the Runtime Manager is backward compatible (V7 verified in the
assessment). The controller resolves `Siemens.Simatic.Simulation.Runtime.Api.x64`
from `apiDir` at run time and never ships the Siemens DLL.

## Build and test

```powershell
# once on a bare checkout: link the shared DSH runtime from <DSH_HOME>\plugin-runtime
npm run link:runtime

npm run build
npm run build:controller   # needs a PLCSIM Advanced install with API\4.0 and the .NET SDK
npm test
```

`build:controller` also runs `--self-test`, which checks the JSON framing,
operation whitelist and API probe without a running instance. The TypeScript
tests need the real DSH runtime links (`link:runtime`), like the sibling plugins.

## Layout

```
src/
  index.ts            host row: controller + plcsimRuntime seam, no tools
  tools.ts            four model tools
  tools-entry.ts      /tools row (declared by the leader preset)
  controller.ts       subprocess lifecycle, NDJSON, deadlines
  protocol.ts         wire frames and the operation whitelist
  config.ts           Config schema and defaults
  runtime-service.ts  the internal seam between the two rows
controller/
  Program.cs          stdio controller, API 4.0 adapter, TCP/IP + IP suite, UI
  build.ps1           builds controller/bin and runs --self-test
  bin/                prebuilt exe (no Siemens API DLL)
test/                 node:test protocol + tool forwarding
```
