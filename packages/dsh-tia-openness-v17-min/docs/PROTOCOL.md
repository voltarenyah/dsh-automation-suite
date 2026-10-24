# Controller protocol (revision 1)

The plugin talks to `TiaOpennessV17Min.Controller.exe` over stdin/stdout using
newline-delimited JSON: **one JSON object per line, UTF-8, in both directions**.
This file is the authoritative description of that channel and of the error
vocabulary; `src/protocol.ts` and `controller/Protocol.cs` implement it.

Revision 1 is the only revision. A frame carries `"protocol": 1`; the plugin
refuses a controller that reports a different number
(`controller_protocol_mismatch`), and vice versa.

## Transport

- The controller writes a **ready** frame as its first line and then serves
  requests until stdin reaches end of file.
- Requests and results are correlated by an opaque `id` chosen by the plugin
  (a UUID). The controller echoes it verbatim.
- **Requests are serialized.** Openness objects are not thread safe, so the
  controller reads one line, finishes the operation, and only then reads the next.
  The plugin enforces the same rule on its side, with a bounded queue
  (`maxQueue`, default 8).
- **Closing stdin is the shutdown path.** The controller then closes the open
  project, disposes the TIA Portal instance it started, writes a final `result`
  frame and exits 0. The plugin waits `shutdownGraceMs`, then terminates the
  process and finally `SIGKILL`s it if needed.
- Progress and log frames may appear at any time and carry their own `id` when
  they belong to a request.
- Any output that is not a JSON object (for example a .NET runtime warning) is
  collected as a diagnostic instead of being treated as a frame.
- Requests are serialized with every non-ASCII code point escaped, so the channel
  is independent of the console code page the child inherited.

## Frames

### `ready` — first line, once

```json
{
  "type": "ready",
  "protocol": 1,
  "controller": "TiaOpennessV17Min.Controller",
  "controllerVersion": "0.1.0",
  "pid": 12345,
  "startedAt": "2026-01-01T10:00:00.000Z",
  "runtime": "4.0.30319.42000",
  "framework": ".NET Framework 4.8.9345.0",
  "processArchitecture": "x64",
  "userName": "operator",
  "machineName": "WS-01",
  "openness": {
    "opennessDir": "C:\\Program Files\\Siemens\\Automation\\Portal V17\\PublicAPI\\V17",
    "assemblyPath": "…\\Siemens.Engineering.dll",
    "available": true,
    "fileVersion": "1700.7.501.6",
    "assemblyVersion": "17.0.0.0",
    "processorArchitecture": "MSIL",
    "probeDirectories": ["…"]
  },
  "opennessUserGroup": { "group": "Siemens TIA Openness", "isMember": true },
  "operations": ["OpenProject", "ExportBlocks", "ImportBlocks", "CompilePlc", "CloseProject"],
  "notes": ["…"]
}
```

`openness.available = false` adds `reason` (`not_found`, `bad_image`, `unreadable`)
and `message`. The ready frame **never** loads `Siemens.Engineering.dll`; the
probe only reads file metadata, which is what lets the controller start — and
report a precise reason — on a machine without TIA Portal.

### Request — one line per call

```json
{ "id": "8f1c…", "operation": "ExportBlocks", "params": { "output_dir": "C:\\out" } }
```

- `type` is optional and must be `"operation"` when present.
- `operation` must be one of the 27 whitelisted names (`OperationCatalog` / `src/protocol.ts`); anything else is
  `unsupported_operation` and is never dispatched. Twenty-five of them back a model-facing tool; `PlcChecksum`
  and `SyncScan` are **service-only** (they back `engineeringAccess` methods and deliberately have no tool).
- `params` is an operation-specific object. Unknown keys are ignored; a key of the
  wrong type is `invalid_params`.

### `result` — exactly one per request

```json
{
  "type": "result",
  "protocol": 1,
  "id": "8f1c…",
  "operation": "ExportBlocks",
  "ok": true,
  "dryRun": false,
  "startedAt": "…",
  "durationMs": 812,
  "data": { "…operation specific…" },
  "changes": [{ "kind": "file", "target": "C:\\out\\Main.xml", "action": "created", "detail": "Main" }],
  "diagnostics": [{ "level": "info", "message": "…", "source": "progress:export" }]
}
```

On failure the same frame carries `ok: false` and:

```json
{
  "error": {
    "code": "verification_failed",
    "message": "The import was committed, but reading the blocks back …",
    "details": { "verification": { "passed": false, "missing": ["FB9"] }, "hint": "…" }
  }
}
```

`data` may still be present on failure when the operation produced a meaningful
partial result (for example the export file list when verification failed).

### `progress`

```json
{ "type": "progress", "id": "8f1c…", "phase": "import", "message": "Importing FB_Motor.xml", "time": "…" }
```

Progress frames keep a long operation observable. They do **not** extend the
plugin's hard deadline: Openness calls cannot be cancelled, so a request that
exceeds `requestTimeoutMs` is abandoned by terminating the controller.

### `log`

Controller-level notes that belong to no request (shutdown notes, warnings).

## Operations and their `params`

The five operations below are the original block read/write surface. v0.2 added 20 more
(8 project-data, 9 PLC-data, 3 F-related), and the versioning workflow added two
service-only operations (`PlcChecksum`, `SyncScan`). Their parameter and payload
contract is frozen in [`EXTENDED-SURFACE.md`](EXTENDED-SURFACE.md) and is not
repeated here beyond the two new sections above.

### `OpenProject`

| param | type | default | meaning |
|---|---|---|---|
| `project_path` | string | — | absolute path of the `.ap17` file |
| `with_window` | bool | `false` | attach to a running TIA Portal, or start a visible one |
| `allow_upgrade` | bool | `false` | allow TIA to upgrade and rewrite an older project |
| `dry_run` | bool | `false` | validate only; do not open |

`data`: `projectName`, `projectPath`, `upgraded`, `withUserInterface`,
`openDurationMs`, `isModified`, `plcSoftware{count,items[]}`, `blockSummary`.

### `ExportBlocks`

| param | type | default | meaning |
|---|---|---|---|
| `output_dir` | string | — | target directory (created when missing) |
| `block_names` | string[] | all | block names; an unknown name fails with `block_not_found` |
| `categories` | string[] | `["blocks"]` | object families: `blocks`, `types` (PLC types / UDTs), `tag_tables` |
| `type_names` | string[] | all | optional name filter for PLC types |
| `tag_table_names` | string[] | all | optional name filter for tag tables |
| `device_name` / `software_name` | string | auto | PLC selection when the project has several |
| `recursive` | bool | `true` | include user groups |
| `overwrite` | bool | `false` | replace existing files |
| `export_options` | enum | `with_defaults` | `none` \| `with_defaults` \| `with_read_only` |
| `write_manifest` | bool | `true` | write `_manifest.json` |

`data`: `device`, `software`, `outputDir`, `exportOptions`, `blockCount`,
`summary{exported,skipped,failed}`, `files[]{name,group,file,bytes,sha256,verified,declaredName,…}`,
`manifest` (path).

### `PlcChecksum`

Read-only. Reads `PlcChecksumProvider.Software` of one PLC — the checksum V17
reports only for a fully compiled software (it is empty again after any edit).

| param | type | default | meaning |
|---|---|---|---|
| `device_name` / `software_name` | string | auto | PLC selection |

`data`: `device`, `software`, `checksum`. An empty checksum fails with
`checksum_unavailable`; that is a state ("compile first"), not a transport error.

### `SyncScan`

Read-only against the project; writes files only. Compares the whole block /
PLC-type / tag-table composition with the previous evidence ledger, exports only
the changed objects (plus every tag table, which has no fingerprint) into
`stage_dir`, and writes the next `_evidence.json` **and** `_manifest.json` there.

| param | type | default | meaning |
|---|---|---|---|
| `source_root` | string | — | the source tree the ledger describes (echoed; files go to `stage_dir`) |
| `stage_dir` | string | — | empty/per-operation directory that receives the changed XML and the next ledger |
| `evidence_path` | string | — | previous ledger, normally `<source_root>/<device>/_evidence.json`; missing means a full scan |
| `manifest_path` | string | — | previous inventory, normally `<source_root>/<device>/_manifest.json`; missing or unreadable means it is rebuilt from the same export run |
| `adopt_existing` | bool | `false` | bootstrap the ledger from the existing tree: with **no** previous ledger and a usable manifest, a manifest row is adopted instead of exported when it names a relative `file` inside `source_root`, has `verified: true` and a `sha256` that still matches the file (tag tables also have to be readable, to hash their normalized XML). Anything unproven is exported. No-op with a previous ledger or an unusable manifest |
| `device_name` / `software_name` | string | auto | PLC selection |
| `export_options` | enum | `with_defaults` | `none` \| `with_defaults` \| `with_read_only` |

`data`: `device`, `software`, `checksum`, `unchanged`, `counts{blocks,types,
tagTables,changed,added,removed,unexportable}`, `safety{signatureType,
fBlockCount,zeroSignatureCount,changed[]{key,name,group,before,after}}`,
`changed[]`, `added[]`, `removed[]`, `unexportable[]{key,category,name,group,
reason}`, `stage{root,evidence,manifest,files}`, `manifestRebuilt`, `adopted`,
`stateId`. When the checksum matches the ledger the operation returns
`unchanged: true` with `stage: null` and enumerates nothing.

Safety blocks carry an F-signature (`SafetySignatureProvider`,
`BlockOfflineSignature`) in the ledger and in the comparison. A ledger written
before that field existed lacks `safetyRecorded`; the first scan with the new
controller backfills the signatures without reporting the F blocks as changed
(fingerprints alone decide that once), and every later scan compares the
signatures too. `safety.changed` also reports F-signatures of unexportable
blocks, which never appear under `changed`.

`adopted` counts the objects taken from the source tree instead of exported; such
files already exist, so they are not part of `stage.files` (which stays the
number of files this scan wrote). A first run with `adopt_existing` still reports
adopted objects under `added`, because there is no previous ledger to compare
against — `adopted` is the field that separates them from real new exports.

The manifest is the inventory the UI and the graph engine read: unchanged objects
are carried forward from the previous manifest, only a tag table whose normalized
content changed is promoted to STAGE, and the file has no timestamps or absolute
paths (`file` is relative to the device root).

Measured on `PEI_SinoARP_SWT2` (1155 blocks, 2026-10-22): unchanged **1.6–3.0 s**;
one changed block **48.3 s** (8 files: the block plus all 7 tag tables); full scan
**121–231 s** (1376 files / 74.8 MB). Enumeration plus all fingerprints is the
fixed cost (about 30 s); only the changed blocks add export time.

### `ImportBlocks`

| param | type | default | meaning |
|---|---|---|---|
| `import_paths` | string[] | — | files or directories (`*.xml`, `*.scl`, `*.stl`, `*.db`, `*.udt`, `*.txt`, `*.src`) |
| `mode` | enum | `auto` | `auto` \| `simatic_ml` \| `external_source` |
| `import_options` | enum | `none` | `none` (fails on an existing block) \| `override` |
| `sw_import_options` | enum[] | `[]` | `ignore_structural_changes`, `ignore_missing_referenced_objects`, `ignore_unit_attributes` |
| `generate_option` | enum | `none` | external sources: `none` \| `keep_on_error` |
| `device_name` / `software_name` | string | auto | PLC selection |
| `recursive` | bool | `true` | scan directories recursively |
| `verify` | bool | `true` | read the block composition back after committing |
| `keep_source` | bool | `false` | keep the external source in the project |
| `target_group` | string | root | user-group path to import into, e.g. `999_Kautex` or `A/B`. Import evaluates name/number collisions across the whole PLC, so a block that lives in a user group must be imported back into that group — `ImportOptions.Override` cannot overwrite it from the root (`group_not_found` when the group is missing and `create_group` is off) |
| `create_group` | bool | `false` | create a missing `target_group` instead of failing |
| `mirror_groups` | bool | `true` | for a directory input, derive each file's group from its subdirectory (the layout an export writes); a missing group falls back to the root group with a warning |
| `categories` | string[] | all | import only these families; a Simatic ML file is classified by its XML element (`SW.Blocks.*`, `SW.Types.*`, `SW.Tags.PlcTagTable`) |
| `dry_run` | bool | **`true`** | validate and report only |

`data`: `device`, `software`, `mode`, `importOptions`, `swImportOptions`,
`generateOption`, `keepSource`, `createGroup`, `mirrorGroups`, `targetGroup`,
`dryRun`, `fileCount`, `plan[]{file,format,category,blockName,blockKind,existsInProject,action,exactTarget,targetGroup,existingGroup?,groupMismatch?}`,
`conflicts[]`, and after a real run `committed`, `applied[]{file,blockName,targetGroup,status}`,
`failureCount`, `failures[]`, `verification{}`.

`verification.blocks[]` also carries `expectedGroup` and a `group:` entry in
`differences` when the block ended up somewhere else.

`verification`: `{ passed, checked, confirmedCount, missing[], advisoryNotConfirmed[],
blocks[]{name,found,group,attributes,modifiedDateBefore/After,replacedExisting,changed,differences[]},
method: "read_back_block_composition", message }`.

### `CompilePlc`

| param | type | default | meaning |
|---|---|---|---|
| `device_name` / `software_name` | string | auto | PLC selection |
| `max_messages` | int | `200` | cap on returned compiler messages |

`data`: `device`, `software`, `state` (`Success`/`Information`/`Warning`/`Error`),
`errorCount`, `warningCount`, `messageCount`, `messagesTruncated`,
`messages[]{level,path,description,dateTime}`, `durationMs`. Compile errors are
data, not a tool failure.

### `CloseProject`

| param | type | default | meaning |
|---|---|---|---|
| `save` | bool | `false` | save before closing (otherwise unsaved changes are discarded) |
| `close_portal` | bool | `false` | also shut down the TIA Portal instance the controller started |
| `dry_run` | bool | **`true`** | report what would happen |

`data`: `projectName`, `projectPath`, `saved`, `isModifiedBeforeClose`, `closed`,
`portalClosed`.

### `OnlineTargets`

Read-only discovery of how the open project can be reached online. Requires an
open project; touches no device and opens no connection.

| param | type | default | meaning |
|---|---|---|---|
| `device_name` | string | all devices | restrict discovery to one device |
| `include_offline_nodes` | bool | `true` | read each device's configured IP / subnet mask / subnet |
| `max_items` | int | `200` | cap on the offline nodes reported per device |

`data`:

- `devices[]{device, cpuItem, onlineProvider, nodeCount}` — `onlineProvider=false`
  means the device is not a PLC CPU and has no online surface.
- `interfaces[]{device, mode, pcInterface, pcInterfaceNumber, kind,
  targetInterfaces[], subnets[]{name, addresses[]{name,address}, gateways[]{name,addresses[]}}}`
  — the Modes → PcInterfaces → TargetInterfaces chain of the connection
  configuration, plus the PC-side subnets and gateways.
- `subnets[]{name, nodes[]{device, deviceItem, node, address, subnetMask,
  pnDeviceName}, reachableBy[]{mode, pcInterface, pcInterfaceNumber, kind,
  targetInterfaces[], pcAddresses[]}}` — the offline (configured) device
  addresses grouped by project subnet, each with the PC interfaces that can
  reach it.
- `unmatchedNodes[]` — nodes with no assigned subnet (they cannot be picked yet).
- `mode` (`PN/IE`), `connected`, `hint`.

`kind` is `virtual` when the PC interface name contains `PLCSIM` or `Virtual`,
`physical` otherwise, and `unknown` when the name is empty. That string is the
only thing that distinguishes a PLCSIM instance from a real PLC, so callers that
gate on "real plant" must pass it on (see `OnlineConnect`).

### `OnlineConnect`

Stateful: on success the controller keeps the `OnlineProvider` and the session
until `OnlineDisconnect` or process exit.

| param | type | default | meaning |
|---|---|---|---|
| `device_name` | string | **required** | PLC device to connect to |
| `mode` | string | `PN/IE` | connection mode |
| `pc_interface` | string | — | PC interface name as reported by `OnlineTargets` |
| `pc_interface_number` | int | `1` | interface number |
| `target_interface` | string | first one | target slot, e.g. `1 X1` |
| `address` | string | — | PC-side subnet address; alone it also selects the interface |
| `timeout_ms` | int | `60000` | how long to poll `State` for `Online` |
| `replace` | bool | `false` | drop an existing session instead of failing |
| `expect_kind` | string | — | `virtual` / `physical`; fails with `online_kind_mismatch` when the resolved interface differs |
| `owner` | string | — | label recorded in the session (shared controller) |

The target resolution order is: `pc_interface` + `target_interface`, then
`pc_interface` + `address`, then `address` alone (the interface is discovered),
then the first target slot of the named interface. `ApplyConfiguration` is called
first; a `false` result fails with `online_configuration_not_applied`.

`data`: `device`, `deviceItem`, `mode`, `pcInterface`, `pcInterfaceNumber`,
`kind`, `targetInterface`, `address`, `state`, `ok`, `elapsedMs`, `message`.
A terminal state other than `Online` (`NotReachable`, `Protected`,
`Incompatible`) is **data with `ok=false`**, not a thrown error, and no session is
stored.

### `OnlineStatus`

No parameters beyond `with_window`. `data`: `connected`, and when connected
`session{device, deviceItem, mode, pcInterface, pcInterfaceNumber,
targetInterface, address, kind, owner, connectedAtUtc}`, `state`, `ok`. Reads
the live `OnlineProvider.State`; never connects or disconnects.

### `OnlineDisconnect`

No parameters beyond `with_window`. Calls `GoOffline`, forgets the session and
reports `connected=false` (plus `note` when there was nothing to disconnect) and
the resulting `state`. Never throws for a missing session.

## Online session semantics

- Exactly one session per controller process. A second `OnlineConnect` fails
  with `online_already_connected` unless `replace=true`; parallel DSH sessions
  therefore share the connection and must coordinate through `owner`.
- The session is deliberately **not** tied to a request: it has to survive
  between `OnlineConnect` and a later download/compare. `OnlineDisconnect` and
  controller shutdown (`Dispose` → `GoOffline`) are the only ways it ends, so
  close the session before `CloseProject`.
- `OnlineTargets` and the session are implemented but **not yet verified against
  a device**; the matrix marks the affected capabilities "部分". Do not describe
  them as measured behaviour until the PLCSIM / real-PLC run has happened.

### `Download`

Downloads to a PLC. The target comes from one of two places:

1. **The online session** opened by `OnlineConnect` for the same device, when no
   explicit target parameter is passed. The session's target is re-resolved on
   the `DownloadProvider`'s own configuration so the interface cannot drift
   between "go online" and "download".
2. **A direct target** resolved from `DownloadProvider.Configuration` when
   `pc_interface` (plus `target_interface` or `address`) is passed. The controller
   calls `ApplyConfiguration` on that target before `DownloadProvider.Download`.
   This is the path a **fresh PLCSIM instance** needs: it cannot `GoOnline`
   before its first download, so it has no session to borrow. When
   `target_address` is passed, the controller uses the V17 overload that takes a
   `ConfigurationAddress` for the specific target IP instead of the offline
   project address.

An explicit target wins over an existing session. With neither a matching
session nor an explicit target the operation fails with
`download_target_required`.

| param | type | default | meaning |
|---|---|---|---|
| `device_name` | string | **required** | PLC device to download to |
| `dry_run` | bool | **`true`** | resolve target + gates only; never calls `DownloadProvider.Download` |
| `confirm` | bool | `false` | "I mean it": required for a real download |
| `confirm_real_device` | bool | `false` | second confirmation, required when `kind` is `physical` |
| `options` | string | `software` | `software`, `hardware` or `both` |
| `mode` | string | `PN/IE` | connection mode for a direct target |
| `pc_interface` | string | — | PC interface for a direct target, e.g. `PLCSIM` for a running Softbus instance |
| `pc_interface_number` | int | `1` | PC interface number for a direct target |
| `target_interface` | string | — | target slot for a direct target, e.g. `1 X1` |
| `address` | string | — | PC-side subnet address for a direct target; alternative to `target_interface` |
| `target_address` | string | — | specific PLC IP for the V17 `Download(IConfiguration, ConfigurationAddress, …)` overload; created on the selected PC interface |
| `password` | string | — | module read/write access + generic download password |
| `block_binding_password` | string | — | block binding password; falls back to `password` |
| `max_messages` | int | `200` | cap on the returned result messages |

The two `DownloadConfigurationDelegate` callbacks answer every configuration TIA
Portal asks about; each one is recorded in `data.configurations`:

- stop modules (`StopModules` → stop all), start them again in the post delegate
  (`StartModules` → start module),
- consistent block download and alarm-text download,
- all three password configurations (`password` / `block_binding_password`),
- `CheckBeforeDownload` ticked; every other checkbox left off,
- protection level change, module reset, memory initialisation, active tests,
  target configuration differences: **left at their NoAction default** — they are
  reported, not decided, because choosing them would change the plant,
- an unknown configuration type throws, which aborts the download as the manual
  requires (the abort is reported as `download_failed` with the configurations
  that were already answered).

`data`: `device`, `deviceItem`, `mode`, `pcInterface`, `pcInterfaceNumber`,
`kind`, `targetSource` (`session` or `download_property`), `targetInterface`,
`address`, `options`, `dryRun`, `gates{confirmed, realDevice,
realDeviceConfirmed}`, `state` (`Planned` for a dry run,
`Success`/`Warning`/`Information`/`Error` otherwise), `ok`, `errorCount`,
`warningCount`, `messageCount`, `messagesTruncated`, `messages[]{depth,dateTime,
state,message}`, `configurations[]{phase,type,message}`, `durationMs`,
`sessionState`, `sessionEnded`.

A download usually ends the online connection. When a session existed and the
provider reports `Offline` afterwards the controller forgets the session and
sets `sessionEnded=true`; a direct download with no session reports
`sessionState="not_connected"` and no `sessionEnded`.

**V17 limits that are not negotiable:** F-activated PLCs cannot be downloaded
through Openness at all (`download_unavailable`, limitation R16 in the coverage
matrix), and a download triggers a compilation — an inconsistent project aborts
it, so compile first.
## Error codes

| code | raised when | typical fix |
|---|---|---|
| `unsupported_operation` | the request named anything outside the whitelist | use one of the 31 operations (`details.allowed` lists them) |
| `unsupported_frame` | `type` was not `operation` | send a request frame |
| `invalid_params` | a parameter is missing or has the wrong type | read `error.message`, it names the parameter and the allowed values |
| `invalid_file` | an import file is not well-formed Simatic ML / a supported source | check the file and `mode` |
| `openness_unavailable` | `Siemens.Engineering.dll` was not found | install TIA Portal V17 or set `opennessDir` |
| `openness_load_failed` | the assembly exists but cannot be used | check x64 and the installation |
| `project_not_found` | the project file does not exist | check `project_path` |
| `project_not_open` | an operation needs an open project | call `OpenProject` first |
| `project_already_open` | a project is already open | call `CloseProject` first |
| `project_open_failed` | TIA refused to open the project | for an older project pass `allow_upgrade` |
| `project_save_failed`, `project_close_failed` | save/close failed | see `error.details` |
| `plc_software_not_found`, `plc_software_ambiguous` | PLC selection failed | pass `device_name` / `software_name` (the message lists the candidates) |
| `block_not_found` | a requested block does not exist | `error.details.available` lists every block |
| `export_failed`, `import_failed`, `compile_failed` | the Openness call failed | see `error.details.hint` (access denied, licence, …) |
| `verification_failed` | the write happened but the read-back did not confirm it | inspect `data.verification` / `data.files` |
| `checksum_unavailable` | `PlcChecksum` / `SyncScan` found no compiled checksum | compile the PLC (`CompilePlc`); an edit clears it again |
| `evidence_invalid` | the ledger file is not valid JSON | rebuild it with a full scan (omit `evidence_path` or delete the file) |
| `evidence_version_mismatch` | the ledger's `schemaVersion` is not the one this controller writes | rebuild the ledger |
| `evidence_device_mismatch` | the ledger belongs to another PLC | use that project's ledger, or start a new one |
| `transaction_failed` | exclusive access could not be acquired | another Openness client holds the project |
| `compile_provider_unavailable` | no `ICompilable` service | the project has no compilable PLC |
| `online_unavailable` | the device has no CPU item / no `OnlineProvider` | only PLC CPUs are online-capable |
| `online_mode_not_found`, `online_interface_not_found`, `online_target_interface_not_found` | the named mode / PC interface / slot does not exist | `details.available` lists what does |
| `online_address_not_found` | no PC interface carries that subnet address | run `OnlineTargets` and pick one of its addresses |
| `online_target_required` | no target was given | pass `pc_interface`+`target_interface`, `pc_interface`+`address`, or `address` |
| `online_already_connected` | a session already exists | disconnect first, or pass `replace=true` |
| `online_kind_mismatch` | `expect_kind` does not match the resolved interface | pick the matching interface (`online_targets` reports `kind`) |
| `online_session_device_mismatch` | the session belongs to another device and no explicit target was passed | call `OnlineConnect` for that device, or pass a direct download target |
| `download_unavailable` | no `DownloadProvider` (non-CPU item, F-activated PLC) | use a non-F PLC CPU |
| `download_target_required` | no session and no explicit target | pass `pc_interface` + `target_interface` (or `address`) |
| `download_target_mismatch` | the resolution failed or `ApplyConfiguration` returned false | inspect `details.available`, or reconnect with `OnlineConnect` |
| `confirmation_required`, `real_device_confirmation_required` | `confirm` / `confirm_real_device` missing | pass them explicitly for a real download |
| `download_failed` | `Download` threw or a callback hit an unknown configuration | inspect `details.configurations` and `details.exceptionType` |
| `online_configuration_not_applied` | `ApplyConfiguration` returned false | pick another interface/slot |
| `internal_error` | unexpected exception | `error.details.exceptionType` |

Transport failures are raised by the plugin, not by the controller, and are
thrown as errors rather than returned as an `ok: false` outcome:

| code | meaning |
|---|---|
| `controller_not_found` | the executable is missing (build it or set `controllerPath`) |
| `controller_spawn_failed` | the executable could not be started |
| `controller_handshake_timeout` | no ready frame within `startupTimeoutMs` |
| `controller_protocol_mismatch` | the executable speaks another protocol revision |
| `controller_timeout` | no answer within `requestTimeoutMs`; the controller was terminated |
| `controller_cancelled` | the caller's abort signal fired; the controller was terminated |
| `controller_exited` | the controller exited mid-request (`details.stderr`) |
| `controller_write_failed` | the request could not be written to the pipe |
| `controller_busy` | more than `maxQueue` requests are queued |
| `controller_restarted` | the controller was replaced while starting |

## Command line (for operators and CI)

```
TiaOpennessV17Min.Controller.exe [--stdio] [--openness-dir <dir>]
TiaOpennessV17Min.Controller.exe --operation <Name> [--param k=v]... [--params-json <json>] [--pretty]
TiaOpennessV17Min.Controller.exe --self-test [--pretty]
TiaOpennessV17Min.Controller.exe --version | --help
```

- One-shot mode prints exactly one result frame and exits 0 on success, 2 on a
  structured failure, 1 when the self test fails. A frame is always a single line
  unless `--pretty` was requested.
- Repeated `--param key=value` for the same key builds an array; `true`, `false`
  and integers are converted, everything else stays a string. `--params-json`
  takes a complete parameter object instead.
- `--self-test` needs no TIA Portal and asserts that starting the controller does
  **not** load `Siemens.Engineering.dll`.

Environment: `TIA_OPENNESS_V17_DIR` (Openness folder),
`TIA_OPENNESS_V17_MIN_CONTROLLER` (controller executable, read by the plugin).