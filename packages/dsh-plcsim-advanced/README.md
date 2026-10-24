# @voltarenyah/dsh-plcsim-advanced

DSH plugin for **S7-PLCSIM Advanced**: manage local simulated PLC instances and
exchange tags through the PLCSIM Advanced runtime API. It is the runtime half of
the suite's simulation capability.

> **Status: runtime MVP, E2E verified.** Instance lifecycle, RUN/STOP/reset and
> tag I/O work. On 2026-10-24 a **manual TIA UI download** into an API-created
> Softbus CPU1511 instance was verified end-to-end: RUN, **51 tags** listed,
> `Btn_ForwardCommand` read/write, and `CylinderIsMovingForward` observed to
> change. **Program loading is not implemented here**: TIA V17 Openness has no
> `TargetForSoftware` / `PlcSimulationAdvanced` API; TIA V20 has it, but
> `DownloadProvider.Download` still fails at `Connect to module PLC_1 failed`
> before any download callback. The route is therefore **manual download once +
> this plugin for the runtime**, pending an Openness fix; see
> [`docs/simulation-plcsim-advanced.md`](../../docs/simulation-plcsim-advanced.md)
> §10.8.

## What it does

| Tool | Actions | Notes |
|---|---|---|
| `simulation_status` | read-only | API/Runtime version, licence, managed instances |
| `simulation_instance` | `list` / `create` / `power_on` / `power_off` / `remove` | `power_off` and `remove` need `confirm=true` |
| `simulation_run` | `state` / `run` / `stop` / `reset` | write actions need `confirm=true` |
| `simulation_tags` | `list` / `read` / `write` | `list` capped (default 200); `write` needs `confirm=true` |

The controller speaks one JSON object per line over stdio and holds the PLCSIM
Runtime Manager API client. Instances live exactly as long as the controller:
unloading the plugin powers them off and unregisters them.

## Safety

- **Softbus only** (`networkMode` is fixed to the PLCSIM default): local PC/VM
  communication, no route to real hardware.
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
  Program.cs          stdio controller, API 4.0 adapter
  build.ps1           builds controller/bin and runs --self-test
  bin/                prebuilt exe (no Siemens API DLL)
test/                 node:test protocol + tool forwarding
```
