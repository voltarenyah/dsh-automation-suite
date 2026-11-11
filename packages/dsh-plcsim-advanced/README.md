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
>
> **The certificate belongs to one virtual device, not to the project.** A brand
> new instance is a new device with its own self-signed certificate, so its first
> CONNECT/download needs one manual **Connect** click in the TIA Portal UI; a
> `resume`/`restore` of an existing snapshot keeps the original identity and needs
> none. The tools therefore scan the workspace first: every `create` refuses with
> `snapshots_available` while snapshots exist, and the agent asks the user whether
> to resume one or make a new device before retrying with `confirm_new=true`.
> See [Starting a simulation](#starting-a-simulation-scan-then-choose).
>
> **F-CPU (fail-safe) projects are different** — the virtual CPU must match the
> project CPU, and V17 Openness cannot download to an F-activated PLC at all. Read
> [F-CPU (fail-safe) projects](#f-cpu-fail-safe-projects--read-before-creating-an-instance)
> before creating an instance for a safety PLC.

## What it does

| Tool | Actions | Notes |
|---|---|---|
| `simulation_status` | read-only | API/Runtime version, licence, instances with name/comm/IP/state, this workspace's snapshot root and the snapshots found there |
| `simulation_instance` | `list` / `snapshots` / `create` / `power_on` / `power_off` / `remove` / `snapshot` / `restore` / `resume` | `create` takes `name`, `cpu_type` or `cpu_model`, `communication`, `ip`; `snapshots` lists saved snapshots + live instances without starting anything; `power_on` applies the IP suite; `snapshot` saves a ZIP + fast storage; `resume` reuses it; `power_off`/`remove` need `confirm=true`; `create` needs `confirm_new=true` once snapshots exist |
| `simulation_run` | `state` / `run` / `stop` / `reset` | write actions need `confirm=true` |
| `simulation_tags` | `list` / `read` / `write` | `list` capped (default 200); `write` needs `confirm=true` |

Coordinates the TIA side needs are returned directly: `name`, `communication`,
`ip`, `subnetMask`, `gateway`, `state`, `cpuType`, `license`. Rendered results
always carry that short fact line (`Key facts: name=… state=… cpuType=…`) even
with `verboseResults` off: in the 0.2.4 acceptance run a successful `create`
rendered only "succeeded", the model distrusted the empty answer and spent 20
minutes probing a healthy runtime.

## Starting a simulation: scan, then choose

When the user asks to *start* a simulation, scan before creating anything:

```jsonc
simulation_status({})                                   // root + snapshots + live instances
simulation_instance({ "action": "snapshots" })          // the same scan, instance-shaped
```

`create` refuses with `snapshots_available` (naming the snapshots) unless
`confirm_new=true`, so the tool itself enforces the question. Present the choice,
then act:

- **Resume** (fast path) — `simulation_instance(action="resume", name="PLC_1",
  snapshot="plc1-first-run", run=true)`. The program is already in the snapshot:
  no TIA download, and **no certificate click**, because the snapshot keeps the
  original device identity (same MAC, same self-signed certificate).
- **New instance** (slow path) — `create` with `confirm_new=true`: a new virtual
  device, so its first TIA CONNECT/download needs the user to accept the new
  certificate once, and the program must be downloaded again.


The controller speaks one JSON object per line over stdio and holds the PLCSIM
Runtime Manager API client. Instances are kept running when the plugin unloads
(`keepInstancesOnUnload`, default true); `remove` is the explicit cleanup.

## Proven workflow with the TIA plugin

1. **TIA `online_targets`** — read the target PLC's configured IP/subnet and the
   available PC interfaces (TCP/IP uses `Siemens PLCSIM Virtual Ethernet Adapter`).
2. **`simulation_instance(action=create, name="<PROFINET device name>",
   cpu_type="1511", communication="tcpip", ip="<project IP>")`** — creates the
   instance and opens the PLCSIM Advanced Control Panel (`showControlPanel`,
   default true). The CPU family must match the project CPU; for an **F-CPU**
   project use the matching F type (`cpu_type="1515F"`) or `cpu_model` with the
   order number/type name, never a standard family.
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

## F-CPU (fail-safe) projects — read before creating an instance

PLCSIM Advanced V7 **does** support fail-safe CPUs (manual §2.3), but the virtual
CPU must **match the project CPU**. The V7 function manual §7.4 is explicit:

> Loading project data of an F-CPU to a standard CPU is not possible.

That is exactly the TIA error `The virtual PLC model does not match the project
PLC model` (`虚拟 PLC 型号与项目 PLC 型号不符`). The manual's two remedies:

1. create the instance as the **matching F-CPU**: `cpu_type: "1515F"` (the
   enum carries `1511F`…`1518F`), or better `cpu_model: "CPU 1515F-2 PN"` /
   `cpu_model: "6ES7 515-2FM01-0AB0"` — the controller maps the project order
   number/type name to the PLCSIM CPU type (`A` = standard, `F` = fail-safe); or
2. create it as an **unspecified CPU** (`cpu_type: "unspecified"`): the first
   download from TIA initializes the real CPU type.

Two more boundaries:

- TIA V17 Openness cannot download to an **F-activated** PLC at all
  (`download_unavailable`, coverage-matrix limitation R16). The download must be
  done in the **TIA Portal UI** (first connection: accept the self-signed
  certificate there).
- `simulation_instance` never applies the IP suite on `create`; only `power_on`
  does (`SetIPSuite`). Powering on from the Control Panel leaves the instance on
  PLCSIM's own IP, which also makes a download fail.

So when the user asks to simulate a **safety PLC / F-CPU**, say up front that the
suite cannot finish the flow automatically: create + power on the instance with
the matching F type (or `unspecified`), then the user downloads from the TIA Portal
UI. Do **not** create a standard family instance for an F project, and do not
report "the runtime is missing" — the runtime is fine; the download path is the
limit.

Detect the CPU from the project hardware export (`hardware_inventory`: order
number/type name such as `6ES7 515-2FM01-0AB0`, `CPU 1515F-2 PN`) and pass it as
`cpu_model`. `cpu_model` accepts the family (`1515`, `1515F`, `CPU 1515F-2 PN`) or
the order number (`6ES7 515-2FM01-0AB0`; `A` = standard, `F` = fail-safe). Compact
(C), technology (T/TF), R/H and ET 200SP families are refused with
`invalid_cpu_type` instead of silently creating the wrong instance. `safety_status`
returning `NOT AVAILABLE` is **not** evidence of a non-F CPU (see
[`HARDWARE-CONFIG-SCOPE.md`](../dsh-tia-openness-v17-min/docs/HARDWARE-CONFIG-SCOPE.md)).

## Persistence: snapshot and restore

After the first successful download/run, save the **whole simulated PLC**
(program, hardware configuration and retentive data) as a PLCSIM archive ZIP:

```jsonc
simulation_instance({ "action": "snapshot", "name": "PLC_1", "snapshot": "cylinder-baseline" })
```

This writes under the **workspace** snapshot root, `<workspace>/.dsh/simulation/`,
where `<workspace>` is the session working directory of the call:

```text
<workspace>/.dsh/simulation/cylinder-baseline/
  instance.zip      # ArchiveStorage(): program + hardware + retentive data
  storage/          # fast copy of the Virtual SIMATIC Memory Card
  manifest.json     # name, cpuType, communication, ip, subnetMask, gateway, createdAt
```

The root is derived per call from the session workspace (`exec.agent.session.header.cwd`),
never from the host process working directory: a snapshot saved under the host cwd
was invisible to the next session in the same workspace, was not covered by that
workspace's backups, and vanished from view after a host restart. An explicit
`snapshotRoot` configuration still pins one shared root for every workspace.

`snapshot` uses the official `IInstance.ArchiveStorage(zip)` plus a directory
copy for the fast path; the instance must have been powered on at least once. If
it is running, the plugin briefly powers it off, archives, then restores its
previous state (RUN is resumed).

Next time, use the **fast resume** path — no TIA, no download:

```jsonc
simulation_instance({
  "action": "resume",
  "name": "PLC_1",
  "snapshot": "cylinder-baseline",   // optional; defaults to name
  "run": true
})
```

`resume` is the recommended non-first-run entry:

1. if the instance is still registered/running, attach with `CreateInterface`;
2. otherwise copy the snapshot's `storage/` directory (fast), register, power on,
   apply the manifest CPU/communication/IP, optionally RUN;
3. if an older snapshot has no `storage/`, fall back to `RetrieveStorage(zip)`.

`restore` remains available when you want an explicit new instance from a
snapshot; `fast=false` forces the ZIP path.

> Snapshots are local artifacts: keep the snapshot root out of git (the default
> `.dsh/simulation/` is ignored by the repository). A snapshot is tied to the
> PLCSIM Advanced version that created it.

## Safety

- Default communication is **Softbus**; the Openness workflow explicitly opts
  into **TCP/IP** to match the project IP. Softbus is only exposed by TIA V20;
  V17 Openness shows TCP/IP only. TCP/IP uses the PLCSIM virtual adapter, not a
  physical adapter mapping.
- Power-off/remove and every write require `confirm=true`.
- The plugin never loads a program and never writes a TIA project.
- **F-CPU projects**: a standard-CPU instance cannot take F project data (manual
  §7.4); use the matching F `cpu_type`/`cpu_model` (or `unspecified`) and remember
  that V17 Openness cannot download an F-activated PLC — the user must download
  from the TIA Portal UI.

## Configuration

Every field has a default; a profile may insert the bundle without a config
block.

| field | default | meaning |
|---|---|---|
| `controllerPath` | `''` | bundled `controller/bin/PlcsimAdvanced.Controller.exe` |
| `apiDir` | `C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API\4.0` | API assembly folder; never copied into the package |
| `storageRoot` | `%TEMP%\dsh-plcsim` | root of per-instance storage directories |
| `snapshotRoot` | `''` (= `<workspace>/.dsh/simulation`) | root of snapshot ZIPs and manifests; empty derives it per call from the session workspace, a value pins one shared root |
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
operation whitelist, CPU mapping, snapshot listing and API probe without a
running instance. The TypeScript tests need the real DSH runtime links
(`link:runtime`), like the sibling plugins.

## Layout

```
src/
  index.ts            host row: controller + plcsimRuntime seam, no tools
  tools.ts            four model tools
  tools-entry.ts      /tools row (declared by the leader preset)
  workspace.ts        session workspace -> <workspace>/.dsh/simulation
  controller.ts       subprocess lifecycle, NDJSON, deadlines
  protocol.ts         wire frames and the operation whitelist
  config.ts           Config schema and defaults
  runtime-service.ts  the internal seam between the two rows
controller/
  Program.cs          stdio controller, API 4.0 adapter, TCP/IP + IP suite, UI
  CpuTypes.cs         project CPU designation/order number -> ECPUType
  build.ps1           builds controller/bin and runs --self-test
  bin/                prebuilt exe (no Siemens API DLL)
test/                 node:test protocol + tool forwarding
```
