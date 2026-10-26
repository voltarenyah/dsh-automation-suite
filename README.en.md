**English** | [简体中文](README.md)

_English mirror of the canonical Chinese [README.md](README.md)._

# dsh-automation-suite

> **An automation distribution for DeepSeek Harness** (unofficial): one profile blueprint plus two
> plugins that give the model inside `dsh` verified **TIA Portal V17** Openness block access and a
> structured, safe-by-default way to operate **Git**.

![license](https://img.shields.io/badge/license-MIT-blue)
![plugins](https://img.shields.io/badge/plugins-2-4D6BFE)
![tools](https://img.shields.io/badge/tools-18-4D6BFE)
![node](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)
![platform](https://img.shields.io/badge/TIA%20plugin-Windows%20only-0078D4?logo=windows&logoColor=white)

> ⚠️ **Unofficial project**: not affiliated with DeepSeek (the publisher of DeepSeek Harness), and not
> affiliated with Siemens either. `dsh-tool-git` is a vendored copy of upstream
> [`lxj808624/dsh-tool-git`](https://github.com/lxj808624/dsh-tool-git) (MIT); see
> [§15](#15-license-and-third-parties) for provenance and differences.

---

## Contents

1. [What This Is](#1-what-this-is)
2. [The Problem It Solves](#2-the-problem-it-solves)
3. [What's Delivered](#3-whats-delivered)
4. [How It Works](#4-how-it-works)
5. [Requirements](#5-requirements)
6. [Quick Start](#6-quick-start)
7. [Using It Interactively](#7-using-it-interactively)
8. [Configuration](#8-configuration)
9. [Repository Layout](#9-repository-layout)
10. [Development](#10-development)
11. [Verification](#11-verification)
12. [Troubleshooting](#12-troubleshooting)
13. [Known Boundaries](#13-known-boundaries)
14. [Safety Red Lines](#14-safety-red-lines)
15. [License and Third Parties](#15-license-and-third-parties)
16. [Documentation Index](#16-documentation-index)

---

## 1. What This Is

In DSH, a "distribution" is not a single package but a combination of two things:

| Component | Location in this repo | Purpose |
|---|---|---|
| **profile blueprint** | `profile/dsh-automation-suite/` | Declares what a profile directory should look like: which bundles to install, and in what order they stack |
| **plugins (bundles)** | `packages/*` | The modules that actually provide capabilities; they run inside the DSH host process |

A blueprint is **not** a bundle. It only becomes a profile that `dsh` can use after it has been
materialized into `~/.dsh/profiles/<name>/`. This repo does not ship the distribution as "one giant
plugin"; it ships it as a **composable set**:

- want everything → materialize the profile from the blueprint and get all capabilities at once ([§6](#6-quick-start));
- want only one piece → every package under `packages/` is an **independently installable bundle**;
  `dsh plugin --profile <p> add <package name or tarball>` is enough.

This repo is a **monorepo**: `packages/*` holds plugins, `profile/*` holds blueprints, `scripts/`
holds monorepo-level tooling, and `docs/*` holds distribution-level documentation.

> **Current status: the prototype of this approach.** What works today is the **first layer** of the
> value chain (getting content out of engineering software and writing it back) plus one
> general-purpose tool from the management layer (git); **the semantic layer has not started yet**.
> For the layered plan, each layer's responsibilities, and the implemented/planned boundaries, see
> [§2](#2-the-problem-it-solves), [`docs/vision.md`](docs/vision.md) and
> [`docs/roadmap.md`](docs/roadmap.md).

---

## 2. The Problem It Solves

In industrial control, **PLC project files cannot be well accessed, understood, or operated by
LLMs**: TIA Portal's `.ap17`, and every vendor's proprietary engineering format, lock program
structure, call relationships, and engineering elements inside dedicated engineering software. A
text model can neither **read** them nor **understand** them (there is no structured semantics), and
it certainly **dares not change** them (it cannot verify that a change holds). As a result, its
usefulness in the industrial-control domain is extremely limited.

Connecting this chain has to be done **layer by layer**, where each layer unlocks the next:

| Layer | What it does | What it hands to the next layer | Status |
|---|---|---|---|
| **① Access layer**<br>Remove tool-level obstacles | Use the interfaces reserved by engineering software (TIA Openness, etc.) to **get program source files out** and **write changes back** | Program source files (Simatic ML / SCL / STL) | 🟡 Partially implemented: block read/write, project data, PLC object CRUD, and F-related interfaces for TIA V17 are connected (26 tools); the 20 operations added in v0.2 still need real-machine verification |
| **② Semantic layer**<br>Let the model understand | Parse source files, **reconstruct engineering information and elements**, and convert them into formats LLMs handle well | Engineering context that can be reasoned about | ⬜ Not implemented: XML is currently handed to the model as-is |
| **③ Management & collaboration layer**<br>Fill software gaps | Build on the **project-level** interfaces that engineering software reserves, and add capabilities it lacks | Project-level workflows and advice | 🟡 Only generic git tooling; not yet integrated with PLC projects |

**This distribution is the vehicle for that chain**: it consists of **multiple plugins**, each
responsible for one aspect. For the layer split and design principles, see
[`docs/vision.md`](docs/vision.md); for plugin responsibility boundaries and contracts, see
[`docs/architecture.md`](docs/architecture.md); for item-by-item progress, see
[`docs/roadmap.md`](docs/roadmap.md).

### Target plugin composition

| Name | Layer | Responsibility | Status |
|---|---|---|---|
| **Industrial-software interface plugin family**<br>(for TIA, `tia-openness`; split by **software version × capability tier**: V17/V18… × **min/std/pro**) | ① Access layer | Interface with engineering software and **read/write engineering objects**; provide **material** and **verification tools** for later analysis; and **ship documentation** explaining for each capability "when to call it / how to call it / how to use the returned data" | 🟡 **V17 × min** exists (positioned as basic-functionality verification) |
| **engineering-context plugin** | Scope (cross-cutting) | Own the user's **multiple TIA projects × multiple branches × multiple historical versions**; optimize/adapt engineering objects (path content, change detection and follow-up); carry engineering change context with a **"to-do list" style of tools**, and at the right moment hand it to the LLM to help judge user intent; make inter-version changes clear and readable, and allow engineering objects to be cross-referenced | 🟡 Partially implemented (3 tools: `create_engineering_project` / `project_status` / `project_sync`; TIA → SOURCE checksum+fingerprint sync and a single commit work, 73 unit tests; DRAFT/REMOTE and the change ledger are not done; **registered in the blueprint**, see [`packages/dsh-engineering-context/docs/`](packages/dsh-engineering-context/docs/)) |
| **engineering knowledge-graph plugin** | ② Semantic layer | **Accurately translate the PLC syntax in XML** (strong compatibility): parse engineering source files → **build a graph database** → expose an interface that returns engineering details | 🟡 Partially implemented (engine + protocol + 8 tools + `knowledgeGraph` service, 104 unit tests; **registered in the blueprint** and called by the family 2 workflow) |

Plugins are no longer numbered: **only the interface plugin family is "one family, many members"**
(member = software version × capability tier); the engineering-context plugin and the engineering
knowledge-graph plugin are both **single plugins**. Numbers remain only for the **layers** in
[`docs/vision.md`](docs/vision.md) §3 (① Access / ② Semantic / ③ Management & collaboration). For
dependencies and the suggested order, see [`docs/roadmap.md`](docs/roadmap.md) §5. For each plugin's
positioning, expectations, and boundaries, see [`docs/architecture.md`](docs/architecture.md) §4.

### ① Access layer: first remove the tool-level obstacles

Everything about an industrial-control program lives inside dedicated software, so the only first
step is to take the content out **through the interface that software reserves**. The segment
implemented in this repo is TIA Portal V17 Openness: project lifecycle and project data, PLC
blocks/types/tag-table read/write, PLC object CRUD, watch tables and software units, F-related
services, compiling and closing projects — and writes go through an allow-list + transactions +
read-back verification (details in [§4.2](#42-the-tia-plugin-two-tier-architecture-and-an-allow-listed-controller)).
The key at this layer is not "being able to call the API"; it is **compressing arbitrary code
execution that could never be exposed to a model into a set of data-only operations**.

### ② Semantic layer: give the engineering information back

Exports are only **files** (XML, SCL, STL), not **engineering semantics**. To be useful to a model,
those source files must be parsed and the engineering information and elements reconstructed — blocks,
block call relationships, data types (UDTs), tag tables, I/O, group hierarchies — and then converted
into formats LLMs handle well (structured, navigable, expandable on demand), instead of stuffing tens
of megabytes of XML into the context. **Only once this layer is done can the model give meaningful
advice on program diagnosis, analysis, and authoring.**

### ③ Management & collaboration layer: fill the software's gaps and track "which version are we talking about"

Engineering software itself often lacks project-level capabilities, most typically **version
management**: TIA Portal has no project-level VCS, and `.ap17` is a binary project file that, when
dropped into git as-is, can only tell you "changed / not changed". The viable route is "**export to
text sources → hand them to an external tool (git) for version management → re-import when needed**",
and let the model help produce meaningful change descriptions and commits.

This layer also has to answer an easily overlooked question: **which version of which branch of which
project are we talking about right now**. A user's assets are usually "multiple projects × multiple
branches × multiple versions"; without scope, the answer may be right but belong to the wrong version.
Every link in this chain depends on the first two layers: without ① nothing can be taken out or
written back; without ② what you get is a text diff, not an **engineering change** (which block
changed, what it affects).

### What you can do today

The two layers above are still on their way, but **the access-layer segment is already usable**, and
together with the generic git tooling from the management layer it supports the following two things
today.

#### Scenario A — Change PLC programs in natural language (TIA Portal V17)

An engineer's daily routine is "open the project → find a block → change a line → compile and
verify"; these actions are either clicked in the TIA UI or written as Openness scripts. This
distribution hands that chain to the model:

- the model **reads**: export the project's PLC blocks (Simatic ML XML, preserving the user group
  directory hierarchy), or just look at the block list and metadata;
- the model **writes**: edit the XML / write an external SCL source, then import it back; **rehearse
  before overwriting**;
- the model **verifies**: after writing, read the project's block set back and confirm each block,
  then compile and read the compilation result.

**Core constraint**: the model does not get "arbitrary code execution". All it can express is
**data** — paths, block names, enums — and what actually executes is a fixed set of 5 allow-listed
operations.

> Note the boundary of this segment: what the model gets today is **the exported file itself**;
> engineering semantics (call relationships, impact surface, tag↔I/O correspondence) have not been
> reconstructed — that is exactly what the ② semantic layer must add.

#### Scenario B — Let the model use Git safely

Models need git all the time when writing code, but the stock runtime only offers bare `bash`:
commands are assembled as strings, output is prose written for humans, and `push --force` or
`reset --hard` have no gate at all. This distribution adds 12 structured git tools (shell-free,
returning JSON) plus a `tools/pre-execute` gate — destructive git operations are denied by default
with an explanation, **whether they come through a plugin tool or through a shell tool**.

This is the **general-purpose foundation** that the ③ management layer will need: today it has no
coupling to PLC projects at all, and connecting it requires ② to be finished first.

### Technical problems already solved

| Problem | How this distribution solves it |
|---|---|
| Openness can only be called from **.NET Framework x64** processes; Node processes cannot call it | The plugin owns a C# controller child process and talks to it over NDJSON on stdio |
| Openness objects are **not thread-safe**; only one client at a time | One host process has exactly one controller; cross-session requests are queued and serialized inside the controller |
| A failed write must not corrupt the project | `ExclusiveAccess` + `Transaction`; only when everything succeeds does it call `CommitOnDispose()`, otherwise dispose rolls back |
| The model might call destructive git commands | `tools/pre-execute` policy gate: `deny` (default) / `ask` / `allow` |
| Long operations can hang | A hard per-request timeout; on timeout the controller is **terminated** (Openness is not cancellable) and automatically restarted on the next call |

### Current progress and roadmap

| Plugin | Goal | Status |
|---|---|---|
| **Industrial-software interface plugin family** | Turn the capabilities exposed by engineering software into the model's overall capability range (including companion documentation) | 🟡 **V17 × min** (blocks, UDTs, tag tables); the std/pro tiers and V18+ are still missing |
| **engineering-context plugin** | Own "which project are we talking about, where is it in the workspace, and is it consistent with TIA" | 🟡 **Partially implemented**: 3 tools (73 unit tests) — `create_engineering_project` saves the TIA-open project into the workspace, reads the source file tree, and triggers knowledge-graph builds per device through [seam B]; `project_status` only reads the ledger/manifest/git/lock and suggests the next step; `project_sync` uses the PLC checksum fast path + per-object fingerprint/normalized-hash slow path, promotes only differences into SOURCE, and makes one path-scoped git commit. When the graph is absent or its engine has not been built, it only reports "graph not built" rather than failing the flow. DRAFT/REMOTE and the change ledger are not done. P0's engineering registry and P1's internal git version layer **have been removed** (that package's D22; current version management is in D26). **Registered in the blueprint** (for `--dump-config` line counts see root `AGENTS.md` §4, DSH 0.2.1-rc.2) |
| **engineering knowledge-graph plugin** | Accurately translate PLC syntax in XML: XML → graph database → engineering details on demand | 🟡 **Partially implemented**: Simatic ML → graph → SQLite works (7 real fixtures produce 72 nodes / 153 edges, covering 15 node kinds); engine protocol + 8 tools + `knowledgeGraph` service (111 unit tests, including end-to-end runs through the real engine); **called by family 2's `create_engineering_project`** (that package's D25). `knowledge_workspace` lets the model read the database path itself, so `knowledge_query`'s `db_path` can be omitted; four drill-down tools (search / block / network / variable usage, fixed SQL on the TS side, zero C# changes) turn program logic into bounded answers (**D24** two-phase). **Freshness/incrementality and the compatibility layer are not done.** **Registered in the blueprint** |

For item-by-item progress, gaps, and verification criteria, see [`docs/roadmap.md`](docs/roadmap.md);
for settled trade-offs, see [`docs/decisions.md`](docs/decisions.md), and **34 open questions live in
[`docs/open-questions.md`](docs/open-questions.md)** (16 answered; edit the file directly to add
answers). **The roadmap is directional, not a promise**; implemented and planned capabilities are
always stated separately in this document.

---

## 3. What's Delivered

| Deliverable | Type | Version | What it provides |
|---|---|---|---|
| `@voltarenyah/dsh-tia-openness-v17-min` | plugin bundle | 0.1.0 | **Three Loader rows**: host row = TIA controller child process + `engineeringAccess` service + bundled skill; `/tools` row = **26 tools**: engineering lifecycle & project data 8 (`create_project` / `save_project` / `archive_project` / `project_info` / `project_languages` / `project_texts` / `update_project` / `portal_settings`), PLC device data 9 (`list_plc_objects` / `create_plc_objects` / `delete_plc_objects` / `write_tags` / `set_block_attributes` / `protect_blocks` / `generate_source` / `watch_and_force_tables` / `software_units`), F-related 3 (`safety_status` / `set_safety_settings` / `safety_signatures`), block read/write mainline 5 + `controller_status`; `/commands` row = **7 `/tia-…` slash commands** (`open` / `save` / `compile` / `close` / `info` / `find` / `status`, executed directly from the conversation box, bypassing the model). The tool row is declared by presets (`leader` has it, `expert` does not); the command line is independent of the tool row and only injects `commands` + `tiaOpennessRuntime`. The 20 new v0.2 operations **have not yet been verified on a real project** (see the package's `docs/VERIFICATION-PLAN.md`); the controller allow-list also carries 2 **service-only** operations (`PlcChecksum` / `SyncScan`, used by the engineering-context plugin for version evidence and not registered as model tools), for 27 operations in total. Real-machine verification on 2026-10-22: `PlcChecksum` 3.2 s; `SyncScan` full 1376 files in 121–231 s, a second run on the same ledger `unchanged` in 1.6–3.0 s, the slow path with 1 changed block 48.3 s (export 1 block + 7 tag tables); opening a project in a visible window 68–197 s (headless hangs) |
| `dsh-tool-git` | plugin bundle (vendor) | 0.1.3 | **12 tools**: `git_status` / `git_diff` / `git_log` / `git_branch` / `git_stage` / `git_commit` / `git_stash` / `git_show` / `git_fetch` / `git_pull` / `git_remote` / `git_checkout`; plus a destructive-command gate and a **`gitContext` service**. Model-facing tools have been split into `dsh-tool-git/tools` and are **wired only to `leader`**; `auditor` / `expert` cannot see them. The service resolves from an explicit root directory, so the model no longer passes `repoDir` |
| `@voltarenyah/dsh-engineering-context` | plugin bundle | 0.1.0 | **3 tools**: `create_engineering_project` (save the project currently open in TIA into `<workspace>/tia/<workspace name>/`, rebuild the source file tree into `<workspace>/source/<device>/`, then call the graph plugin's `knowledgeGraph.ingestDevice` per device through [seam B]), `project_status` (read-only: which PLC, whether the ledger/manifest exists, git status, locks, next action), `project_sync` (TIA → STAGE → SOURCE → one git commit; by default it only returns a plan). Equality during sync comes from the **PLC-level checksum** (fast path) + **per-object fingerprint/normalized hash** (slow path): the ledger `source/<device>/_evidence.json` is authoritative and `_manifest.json` is a derived manifest; both documents are written by **the same `SyncScan` call**; STAGE and locks live in `<workspace>/.dsh/local/` (not committed), and `.gitignore` gains only three lines: `tia/`, `knowledge/**/*.db*`, `.dsh/local/`. **Not implemented**: DRAFT/REMOTE and per-block fingerprint locks (S3), the change ledger. **Removed**: P0's engineering registry (`_dsh-eng/projects.json`), P1's internal git version layer, and the four tools `eng_status` / `eng_project` / `eng_scope` / `eng_version` (that package's D22; version-management stance in D26). **No host-side resources, so the whole row moves into the `leader` and `auditor` presets** |
| `@voltarenyah/dsh-engineering-graph` | plugin bundle | 0.1.0 | **Two Loader rows**: host row = C# engine child process + `knowledgeGraph` service (called per device by family 2's `create_engineering_project`); `/tools` row = **9 tools**: 5 shared tools (`knowledge_workspace` / `knowledge_schema` / `knowledge_ingest` / `knowledge_update` / `knowledge_query`) + 4 drill-down tools (`knowledge_search` / `knowledge_block` / `knowledge_network` / `knowledge_variable_usage`, fixed SQL on the TS side, zero C# changes). `knowledge_update` is the incremental entry point: it replaces changed components by `source_components` and rescans the one-hop dependency closure in a single transaction; the caller falls back to a full rebuild when provenance is missing, a limit is exceeded, or types/tag tables changed. `includeIngest: false` removes the two write tools; `includeDrilldown` has three levels (`none` / `inspect` / `all`): `leader` uses `inspect`, `expert` uses `all` — Simatic ML XML → property graph → SQLite, with the engine running as a net8 child process (`engine/`). **Pure SCL blocks are segmented by `REGION`** (**D27**). `knowledge_workspace` never touches the engine: it reads the session working directory and reports project identity, each device's database path/size/mtime, `device_dir`, and **graphFreshness** (sidecar checksum vs `_evidence.json`), so `knowledge_query`'s `db_path` can be omitted (auto-resolved for a single DB; rejected with candidates for zero/multiple DBs, **D24**). **Not implemented**: on-demand drill-down tools for a specific variable usage, the compatibility layer. For database locations and directory conventions see [`docs/roadmap.md`](docs/roadmap.md) §4 |
| `dsh-ui-plc-source` | plugin bundle (**browser half + one host pre-step listener**) | 0.1.0 | **One Loader row + one right-sidebar tab type**: adds **PLC Blocks** to the dsh-web right sidebar (after Files / Terminal / Browser). It reads `<workspace>/source/<device>/_manifest.json` and **flattens** every object into one row (type badge / name / number / language / size / post-write verification mark); you can filter by **device** and **simaticType**, and search by name or number. Objects TIA refused to export (`failures[]`) are listed as rows too (marked "refused", hover for the reason). **Single-click selects** (selection does not trigger an action yet); only the **context menu** opens the source file (via the existing document preview) or "mention in chat" (inserts `@'block name'` into the input box; the host half enriches the prompt with the block's device/type/number/language/file path in `agent/pre-step`). Filters/search/selection/scroll position and fetched data live in the slot store, so switching away and back neither loses them nor re-reads the manifest. **UI text follows DSH's language setting** (Settings → General → Language, Chinese/English) and switches without a refresh, including already-open tab chips. The host half does only this (`agent/pre-step` listener, no tools, no child process); when the manifest is unreadable, that device falls back to a directory listing. For feasibility and mechanics see [`docs/ui-plugins.md`](docs/ui-plugins.md); for this plugin's plan and verification see [`docs/ui-plugins-plc-blocks-plan.md`](docs/ui-plugins-plc-blocks-plan.md) |
| `dsh-ui-tia-console` | plugin bundle (**browser half only**) | 0.1.0 | **One Loader row + a TIA console above the input box**: shows "no project / opening / open · project name / saving / compiling (elapsed) / closing / unavailable" and directly provides the five buttons **Open / Save / Compile / Close / Refresh**. The buttons dispatch the existing `/tia-*` commands, and the state is folded from the session's `command/*` and `tool/*` events — model calls, slash commands, and button presses all show up in real time; it is even visible in an empty session (it sits on `conversation.input.dock` and does not depend on the timeline). Refresh re-synchronizes with the controller via `/tia-info`. It has an expandable panel (project path, latest compile, latest error, latest result). **Step 1 boundary**: state is folded per session; after other sessions or an external TIA close, click Refresh to recalibrate; a global state service is the next step. |
| `profile/dsh-automation-suite` | profile blueprint | 0.1.0 | Stacks the official Web composition (`dsh-base` + `dsh-web-app`) and the local plugins above into a directly startable profile; declares three presets: `leader` (main agent), `auditor` (version management), and `expert` (subagent). It also mounts one **public plugin** row, `dsh-opencode-go@0.1.15` (the OpenCode Go provider + settings page from npm, same version as the desktop profile; version pinned, and `allowBuilds` is declared for it in `pnpm-workspace.yaml` — rationale in that directory's README) |
| `scripts/start-env.ps1` | launcher | — | One command does "materialize profile + install plugins + start service + open browser with token" |
| `scripts/clean-build.mjs` | tooling | — | Cleans only `lib/` and `dist/`; links are unlinked, never descended into |

The main agent (`leader`) has this distribution's own **49 tools** (TIA 26 + git 12 +
engineering-context 3 + `project_diff` + graph 7), all available in the same session — for example,
"after changing this block, also commit the export directory"; plus the bunch that the built-in
`standard` preset brings (fs / search / skills / todo / web / present / subagent …).

The version-management session (`auditor`) declares only **9 tools**: engineering context 3
(`create_engineering_project` / `project_status` / `project_sync`), read-only files 4 (`read` /
`read_image` / `glob` / `grep`), `ask_user`, `todo`. It has **no** `pwsh`, TIA atomic tools, git,
`knowledge_*`, `project_diff`, or subagent.

The subagent (`expert`) preset declares **14 tools** of its own (graph 7: `knowledge_workspace` /
`knowledge_schema` / `knowledge_query` + the four drill-down tools; `project_diff`; read-only files
2: `read` / `read_image`; search 2: `glob` / `grep`; communication 2: `send_message` /
`interrupt_agent`), plus **1 that remains a global host-surface row** (`working_directory`) = **15**.
The 12 model-facing git tools have been split out of the host row into `dsh-tool-git/tools` and are
wired only to `leader`, so neither `expert` nor `auditor` can see them.

For the shape and rationale of the two agent tiers, see [§8.1](#81-the-distribution-policy-layer-system-prompt-injection-and-the-two-agent-tiers)
and [`docs/decisions.md`](docs/decisions.md) **D23**.

---

## 4. How It Works

### 4.1 Composition: bundle → layer → profile

DSH loads through two independent paths, and **both rely on package names**:

1. names in the profile manifest `dsh.profile.bundles` → used to resolve the bundle directory;
2. `insert[].name` in each bundle's `cordis.patch.yml` → passed to the cordis Loader as a **module identifier** to import.

Therefore `package.json`'s `name` and `cordis.patch.yml`'s `insert[].name` **must match verbatim**
(YAML scalars starting with `@` also need quotes). In this distribution it looks like this:

```yaml
# packages/dsh-tool-git/cordis.patch.yml      (no scope, no quotes needed)
- insert:
    - id: tool-git
      name: dsh-tool-git

# packages/dsh-tia-openness-v17-min/cordis.patch.yml
- insert:
    - id: tia-openness-v17-min
      name: '@voltarenyah/dsh-tia-openness-v17-min'
```

The blueprint's `dsh.profile.bundles` decides the **stacking order** (later layers may override
earlier ones); the profile's own `cordis.patch.yml` is the **user layer**, applied after all bundle
layers:

```
dsh-base  →  dsh-web-app  →  tia-openness-v17-min  →  dsh-tool-git  →  profile/cordis.patch.yml
(base)       (Web app)       (plugin layer, inserts   (plugin layer)   (environment-specific
                             only its own rows)                         settings go here)
```

The bundle patches of both plugins **insert only their own rows and carry no environment-specific
configuration**, so the same bundle can be installed into any profile; `opennessDir`, timeouts, and
`destructivePolicy` belong to the profile's user layer.

### 4.2 The TIA plugin: two-tier architecture and an allow-listed controller

Openness cannot be called directly from Node, so the plugin is split into two tiers, connected by a
**one-JSON-object-per-line NDJSON protocol**:

```
┌─ DSH host process (Node) ─────────────────────────────┐
│  dsh-tia-openness-v17-min (TypeScript)                │
│   • registers 6 model-visible tools                   │
│   • ctx.effect() owns the C# controller child process │
│   • serializes requests / queue cap / timeout kill    │
│   • transport errors → structured ToolFailure         │
└──────────────────┬────────────────────────────────────┘
                   │ NDJSON over stdin/stdout
┌──────────────────▼────────────────────────────────────┐
│  TiaOpennessV17Min.Controller.exe (C#, x64,           │
│  .NET Framework 4.8)                                  │
│   • registers Siemens' official assembly resolver     │
│     first, then lazily loads                          │
│     Siemens.Engineering.dll (V17)                     │
│   • executes only the 5 allow-listed operations       │
│   • writes = ExclusiveAccess + Transaction +          │
│     read-back verification                            │
│   • any exception → structured JSON {code, message,   │
│     details}                                          │
└───────────────────────────────────────────────────────┘
```

**Tools and their default policies** (26 tools, all returning the same envelope `ok` / `summary` /
`data` / `changes` / `diagnostics` / `error`; for the full list and parameters see the package's
[`README.md` §4](packages/dsh-tia-openness-v17-min/README.md) and
[`docs/EXTENDED-SURFACE.md`](packages/dsh-tia-openness-v17-min/docs/EXTENDED-SURFACE.md)):

| Tool group | Tools | Writes | dry-run by default |
|---|---|---|---|
| Project lifecycle | `open_project` | only when `allow_upgrade=true` | No (upgrades are gated separately) |
| Block read/write mainline | `export_blocks` / `compile_plc` / `close_project` / `import_blocks` | export only writes files; the rest **do** write | import/compile/close **yes**, export no |
| Project data (v0.2) | `create_project` / `save_project` / `archive_project` / `project_info` / `project_languages` / `project_texts` / `update_project` / `portal_settings` | everything except `project_info` can write | write operations **yes**, except create/save/archive/export-texts |
| PLC device data (v0.2) | `list_plc_objects` / `create_plc_objects` / `delete_plc_objects` / `write_tags` / `set_block_attributes` / `protect_blocks` / `generate_source` / `watch_and_force_tables` / `software_units` | everything except listing and source generation **does** write | **yes** for all except source generation |
| F-related (v0.2) | `safety_status` / `set_safety_settings` / `safety_signatures` | only `set_safety_settings` | **yes** for that tool |
| Diagnostics | `controller_status` | no (does not start the controller) | — |

The write path has four safeguards:

1. **dry-run is on by default**: write operations default to `dry_run: true`; you must explicitly
   pass `dry_run: false`;
2. **transactions**: `TiaPortal.ExclusiveAccess()` → `Transaction(project, …)`, and
   `CommitOnDispose()` is called **only after every file succeeded**; otherwise dispose rolls back;
3. **read-back verification**: exports are read back file by file, `<Name>` is checked, SHA-256 is
   recorded, and a manifest is written; after an import transaction commits, the project's block set
   is read again, each block is confirmed present, and `ModifiedDate` / `Number` /
   `ProgrammingLanguage` are compared;
4. **allow-list**: the controller accepts only the **25** operation names in `OperationCatalog` in
   `controller/Protocol.cs`; `OPERATIONS` in the plugin's `src/protocol.ts` is the same list (double
   validation, neither side trusts the other; `npm run matrix:check` compares them item by item).
   There is no `eval` / `Invoke` / reflection entry point at all.

A compile error is **not** a tool error: `state` / `errorCount` / `warningCount` / `messages` are
returned as data so the model can fix the code accordingly.

### 4.3 The Git plugin: shell-free execution and a policy gate

- **no shell injection**: every command goes through `execFile` with an explicit argument array; paths
  and commit messages from the model are never string-interpolated;
- **machine output**: porcelain v2, `--numstat`, and `--format` records are parsed into structured
  JSON instead of prose;
- **gate**: a `tools/pre-execute` listener inspects **every** tool call — both the plugin's own tools
  (e.g. `git_commit` with `amend: true`) and the **command text** of shell-like tools (`bash` /
  `pwsh` / `terminal` etc.) — and matches patterns such as `push --force`, `reset --hard`, `clean -f`,
  `branch -D`, `rebase`, `commit --amend`, `checkout --`, `update-ref -d`. Matching is done per
  command segment, never across `|`, `;`, or newlines, so `git add . && git push --force` is still
  blocked while innocent compound commands are not misjudged.

> This is a **policy guardrail, not a sandbox**. An agent that can run arbitrary code can always get
> around string matching with aliases, `-c` overrides, or scripts. The gate exists to make accidental
> destructive commands **fail loudly with an explanation**; deliberate destructive operations should
> be authorized through configuration (`ask` / `allow`), not by circumventing the gate.

### 4.4 Runtime resolution during development (why the repo doesn't install `@deepseek-ai/*`)

At runtime the plugins resolve `@deepseek-ai/*` from the profile's runtime; the repo **deliberately
does not declare them as dependencies**: on the public registry this line stops at `0.1.0-rc.6`,
while the host this repo targets is `0.2.1-rc.2` — type-checking or testing against an old copy means
validating against the wrong API surface.

So both packages have a `link:runtime` script that computes the closure from **the installed app's
own `resources/app.asar`** following `dependencies` + `peerDependencies` (about 32–33 packages /
8 MB / < 1 s), unpacks it into `<DSH_HOME>/plugin-runtime`, and junctions it into each package's
`node_modules/@deepseek-ai/`. `runtime.json` records the host version, and the runtime is re-extracted
automatically after a host upgrade. The extracted runtime **contains no `.d.ts`** (the app's
production build strips them), so each package hand-writes a `src/dsh-runtime.d.ts` to feed `tsc`.

---

## 5. Requirements

| Item | Requirement |
|---|---|
| OS | Windows (TIA plugin only; it loads on other platforms but tool calls return `controller_not_found`). The Git plugin is cross-platform |
| Node.js | **≥ 22.19** (both packages declare this in `engines`); `pnpm` and `dsh` may not be on PATH on this machine |
| DSH | any version that can load bundles |
| TIA Portal | **V17** (strictly pinned; V16/V18 are not compatible) — TIA plugin only |
| Openness DLL | `C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17\Siemens.Engineering.dll` |
| .NET Framework | 4.6.1+ (the controller targets **4.8**); the process bitness must be **x64** |
| Windows user group | the current user must belong to the local group **`Siemens TIA Openness`** (`net localgroup "Siemens TIA Openness"`) |
| Only to rebuild the C# controller | .NET SDK + .NET Framework 4.8 targeting pack + access to a NuGet feed |
| Only to rebuild the TS | `pnpm install` (installs only typescript / tsdown / vitest / @types/node) |

The repo already contains the **built artifacts** of both plugins (`lib/`, `controller/bin/*.exe`),
so nothing needs to be compiled before installing.

---

## 6. Quick Start

### 6.1 Bring up an isolated environment with one command (recommended)

`scripts/start-env.ps1` turns "materialize the profile from the blueprint + install the plugins +
start the service + open the browser with a token" into one command, and it **never touches your
daily `~/.dsh`** (by default it uses its own `DSH_HOME=%USERPROFILE%\dsh-suite-env`; delete that
directory to roll back completely):

```powershell
pwsh -NoProfile -File scripts\start-env.ps1
```

It does four things: `pnpm -r build` → materialize the profile directory from the blueprint → link
the local plugins into the profile by name (default `-Mode link`, which validates **the current
working tree**; `-Mode pack` instead runs `pnpm pack` to build tarballs and validates **the real
deliverables**) → start `dsh --profile dsh-automation-suite --port 3092`.

**Which plugins to deploy is not hard-coded in the script**: it reads the blueprint's
`dsh.profile.bundles`, and any entry that can be matched under `packages/` by `package.json`'s `name`
counts as a local plugin (the same logic for scoped and unscoped names), so adding a plugin only
requires creating its directory and adding its package name to the blueprint — the script needs no
changes.

Common switches:

```powershell
pwsh -NoProfile -File scripts\start-env.ps1 -Restart              # stop an old instance on the port, then start (dev loop)
pwsh -NoProfile -File scripts\start-env.ps1 -Port 0               # random port
pwsh -NoProfile -File scripts\start-env.ps1 -Mode pack            # validate real deliverables
pwsh -NoProfile -File scripts\start-env.ps1 -DshHome C:\temp\e2e  # use a different isolated home
pwsh -NoProfile -File scripts\start-env.ps1 -Reset -NoOpen        # delete and recreate first, and don't open a browser
```

| Parameter | Default | Description |
|---|---|---|
| `-DshHome` | `%USERPROFILE%\dsh-suite-env` | isolated DSH_HOME; delete it to roll back |
| `-Profile` | `dsh-automation-suite` | profile name, which also selects the blueprint |
| `-Port` | `3092` | `0` = let the system pick a free port |
| `-Mode` | `link` | `link` validates the working tree / `pack` validates tarballs |
| `-SkipBuild` | off | skip `pnpm -r build` |
| `-Reset` | off | delete the profile directory and recreate it (asks for confirmation first) |
| `-Restart` | off | stop **DeepSeek Harness** if it occupies the port; if another process does, exit with an error instead of killing it |
| `-NoOpen` | off | do not open a browser automatically |

> On this machine neither `pnpm` nor `dsh` is on PATH; the script resolves them from the DSH install
> directory itself (`$env:DSH_APP_ROOT` can override it; the default is
> `%LOCALAPPDATA%\Programs\DeepSeek Harness`).

### 6.2 Install into your daily `~/.dsh`

Mount the repo's blueprint directory directly as a profile (a junction, so edits apply live):

```powershell
pnpm install                     # at the monorepo root: workspace:^ links the plugins into the blueprint's node_modules
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\dsh-automation-suite" `
              "<repo>\profile\dsh-automation-suite"
dsh --profile dsh-automation-suite --dump-config     # you should see both plugins' rows
```

To tear it down, you **must** use `cmd /c rmdir` (which only deletes the link itself):

```powershell
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\dsh-automation-suite"
```

### 6.3 Install a release (outside the monorepo)

Download `dsh-automation-suite-<version>.zip` from
[Releases](https://github.com/voltarenyah/dsh-automation-suite/releases); after unpacking,
**double-click `install.cmd`** (recommended — double-clicking the `.ps1` directly hits the
mark-of-the-web plus the `RemoteSigned` policy and the window closes immediately), or run:

```powershell
pwsh -NoProfile -File install.ps1
```

It copies the profile's three files (`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`)
into a **release-private home**, `%USERPROFILE%\dsh-automation-suite-home\profiles\dsh-automation-suite-v<version>\`
— not the everyday `~/.dsh` — then uses DSH's bundled pnpm to install the seven plugins' tarballs
(release assets; the profile uses **direct URL dependencies**, so no npm account is needed). It
also writes `install.json` next to the scripts, recording the home and profile it used.

**Double-click `start.cmd` to launch**: it reads `install.json`, sets `DSH_HOME`, picks a free port
starting at 3093, and opens the browser — no `--profile` / `--port` to remember. Options:
`start.cmd -NoOpen`, `start.cmd -Port 3093`.

Why a private home: the left-sidebar workspace list comes from
`<DSH_HOME>\storages\workspace.json`, and sessions, settings, and model credentials also live under
DSH_HOME. Sharing `~/.dsh` with the desktop app would show every project opened there and let both
apps write the same registry. With a private home the release starts with an empty workspace list
and only shows folders you add inside this app.

**Development and release builds coexist**: the development profile keeps the plain
`dsh-automation-suite` name (`scripts/start-env.ps1` materializes it in the isolated
`%USERPROFILE%\dsh-suite-env`), while each release gets its own versioned profile in
`%USERPROFILE%\dsh-automation-suite-home`. Workspaces, sessions, settings, and credentials are fully
separate, so both can run at once (`start.cmd` picks its own port). To keep one stable name and
upgrade it in place, pass `-Profile dsh-automation-suite-release -Force`; the installer backs up
that profile's `package.json` and `cordis.patch.yml` first. It always refuses to write through a
junction/symlink.

To generate the release directory (tarballs + profile + `install.cmd` / `start.cmd` + sha256
manifest), maintainers run:

```powershell
node scripts/build-distribution.mjs
```

Why the whole distribution cannot be installed with `dsh plugin add`: that command accepts only
**bundles** carrying `dsh.bundle.patch`, whereas the blueprint declares `dsh.profile.bundles`, so it
is rejected as `not-a-bundle`. For the option comparison, the two `ERR_PNPM_*` pitfalls, and the
release and local-verification steps, see [`docs/distribution.md`](docs/distribution.md). The seven
plugins themselves are standard bundles and can still be installed individually with
`dsh plugin --profile web add <package name or tarball>`.

### 6.4 You must configure a model yourself on first entry

After startup, `dsh` prints a **URL with a token** and opens it in the default browser automatically
(the token changes on every start and is never written to disk; the bare address returns 401). On
first entry, go to **Settings → Models and enter an API key** (or use the first-run dialog "Add an
API key to get started"); credentials land in that home's `.credentials.yaml`, independent of your
daily home.

---

## 7. Using It Interactively

### 7.1 Three interactive surfaces

| Surface | Where | What it is for |
|---|---|---|
| **Conversation** | Web GUI session input box | Main usage: describe a task in natural language, and the model picks from 39 tools itself to execute it |
| **Settings / Plugins** | Sidebar Settings, Plugins | Configure the API key, see loaded plugins, enable/disable plugins, adjust configuration |
| **Command line** | `scripts/start-env.ps1`, `dsh …` | Start/stop the environment, deploy, verify (`--dump-config`) |

In **Creator mode** you can also let the model install plugins itself via `plugin_manager`:

```
plugin_manager(action: "install_bundle", target: "C:\\Users\\Ansel\\dsh-automation-suite\\packages\\dsh-tia-openness-v17-min")
```

### 7.2 Conversation examples

**TIA (export → change → import → compile)** — on the user side you only need to say:

> "Open `C:\Projects\Line1\Line1.ap17` and export all blocks to `C:\Projects\Line1\export`."

> "Change `FB_Motor`'s `<HeaderVersion>` from 0.1 to 0.2, import it back into its original group, and compile to verify."

On the model side this expands into a call chain (each step is one of the TIA plugin's tools):

```jsonc
{ "project_path": "C:\\Projects\\Line1\\Line1.ap17" }                       // open_project
{ "output_dir": "C:\\Projects\\Line1\\export", "block_names": ["FB_Motor"] } // export_blocks
{ "import_paths": ["…\\FB_Motor.xml"] }                                      // import_blocks: dry_run by default
{ "import_paths": ["…\\FB_Motor.xml"], "import_options": "override",
  "target_group": "999_Kautex", "dry_run": false }                           // real import + read-back verification
{ "dry_run": false }                                                          // compile_plc: real compile
{ "save": true, "dry_run": false }                                            // close_project
```

**Git** — when the user says "see what the status is and commit the changes", the model calls
`git_status` → `git_diff` → `git_stage` → `git_commit` and gets structured JSON instead of prose. If
it tries `git push --force`, the gate denies it outright and explains why and how to release it.

### 7.3 dry-run and approval: writes never happen silently

- **TIA writes rehearse by default**: without `dry_run: false`, `import_blocks` / `compile_plc` /
  `close_project` only return a plan (`data.ready` / `data.plan` / `data.conflicts`), and the project
  does not change by a single byte.
- **Git destructive operations are denied by default**: `destructivePolicy: deny`. Switching to
  `ask` routes through the runtime's approval seam (`ctx.approval`), where you approve in the UI; an
  environment without an approval service falls back to `deny`.
- Every tool's `description` spells out these policies, so the model reads them directly and you do
  not have to teach it.

### 7.4 The bundled knowledge base: the `tia-openness` skill

The plugin packs Siemens' official Openness skill collection
([`siemens/tia-portal-ai-extensions`](https://github.com/siemens/tia-portal-ai-extensions), MIT)
into the package **verbatim** and registers it as **one** model-visible skill, `tia-openness`:

- it is a **routing table** of "symptom / task → which file to read" (exclusive access, transactions,
  Simatic ML round-trips, block group hierarchies, compilation, licensing/firewall, threading, crash
  triage, performance, …);
- the 31 upstream files live under `skills/<name>/SKILL.md` as **resources**, and the model `read`s
  them in chunks on demand, so the knowledge base **occupies no standing context** and is paid for
  only when actually used;
- every tool description ends with ``Troubleshooting: load the bundled `tia-openness` skill …``, and
  the same entry appears in the session directory, so the model cannot miss it.

To have the model consult this material, just say "the compile failed — check the Openness
troubleshooting guide".

### 7.5 "Start the app", stopping, and rolling back

- Saying "**start the app**" (or "bring up the environment") means running
  `pwsh -NoProfile -File scripts\start-env.ps1 -Restart` at the repo root. `-Restart` makes this
  command **always usable**: if the port is taken, it stops the old `DeepSeek Harness` first and then
  starts, so "change the code → start the app" is one step.
- **Stopping**: `Ctrl+C` in that instance's window; if the window is lost, `Stop-Process -Id
  <harness pid> -Force`, and the controller will read stdin EOF and exit by itself (confirm no
  leftovers with `Get-Process TiaOpennessV17Min.Controller`).
- **Full rollback**: delete the isolated `DSH_HOME` directory — but you **must** use
  `cmd /c rmdir /s /q` (see [§14](#14-safety-red-lines)).

### 7.6 How to tell that startup succeeded

1. the console shows `dsh web: http://127.0.0.1:<port>/?token=…`, and the browser opens automatically;
2. the port is listening (`Get-NetTCPConnection -State Listen -LocalPort 3092` → `DeepSeek Harness`);
3. **hard evidence that the plugin actually loaded**: a `TiaOpennessV17Min.Controller` child process
   exists (`Get-Process TiaOpennessV17Min.Controller`) — which means `apply()` ran and `ctx.effect`
   owns the child process. If it is absent, the plugin did not load; do not rush to blame TIA.

---

## 8. Configuration

All environment-specific settings live in the **profile's user layer**
`~/.dsh/profiles/dsh-automation-suite/cordis.patch.yml`. The top level is an array of loader patch
entries: override a config by `id`, `disable` a row, or `insert` new rows. The blueprint's copy is
**no longer an empty array**: it also carries the distribution policy layer below, and is copied
into the profile when the profile is materialized.

### 8.1 The distribution policy layer (system-prompt injection) and the two agent tiers

The first few blocks of `profile/dsh-automation-suite/cordis.patch.yml` inject the distribution's
rules into the **system-role** prompt. **Pure configuration, no plugin code** — changing the text does
not require a rebuild:

| Entry | Purpose |
|---|---|
| `- id: system-prompt` | Overrides the global persona (affects **non-preset** agents) |
| `- id: agent-preset-registry` | Points new sessions' default preset to `leader` |
| `- insert: - id: preset-leader` | **Main agent**: the built-in `standard` tool list verbatim + engineering tool rows (TIA / git / context / graph) + policy text |
| `- insert: - id: preset-auditor` | **Version management**: engineering context 3 + read-only files + `ask_user`/`todo`; no shell, no TIA atomic tools, no git |
| `- insert: - id: preset-expert` | **Subagent**: a read-only engineering knowledge expert (graph discovery + query + four drill-down tools + read-only file search + `send_message`) |
| `- id: preset-standard` … `preset-cordis` | The four built-in modes are `disabled: true` by default; they declare none of the engineering tool rows and would silently drop them, so the picker only offers the three suite presets |

**To change policy text, edit only the four block scalars** (the global `personaPrefix`/`personaSuffix`,
`preset-leader`'s persona, `preset-auditor`'s persona, and `preset-expert`'s persona). The file header
comments show how to switch to Chinese; the four built-in presets are disabled by default (delete those
four entries to restore the native modes — not recommended).

#### Why the two agent tiers are split this way

There is only one purpose: **split the context**. The main agent handles project-level matters (open a
project, export, change blocks, commit), while the subagent dives into specific code questions (call
chains, variable reads/writes, what a particular network actually does); each reasons in its own
window, and only conclusions flow back.

- **Dispatch**: the main agent uses the `subagent` tool to dispatch to `expert` (the preset is pinned
  by configuration: `agentPreset: expert`). The tool returns immediately with
  `started subagent <id>`, **without waiting**; when the subagent finishes, the host writes its
  closing text back to the main session as a notice.
- **User interjection**: the "descendant count" trigger in the parent session header → directory
  tree → click a row to open it in the main pane, or click the arrow at the end of the row to open it
  in a **right-sidebar split**. Continuable child sessions have a full composer and can be asked
  follow-ups; follow-ups also flow back to the main agent. (The left session list **deliberately
  excludes** child sessions; that is the host's design.)
- **Tool surface**: `expert` sees no TIA operation tools, git, `pwsh`, or engineering-context
  workflows, and cannot obtain `knowledge_ingest`. Its "read-only" is guaranteed only by the tool
  surface — subagents inherit the parent session's explicit sandbox overrides, and the approval
  policy is pinned by the host to `never`, so do not expect the sandbox to stop it.
- **Depth**: `subagent.maxDepth` defaults to 1; `expert` cannot dispatch grandchildren.

Measured effect (a real request's persisted `system/message`): `personaPrefix` follows identity
immediately, and `personaSuffix` lands at the very end of the prompt.

> ⚠️ **`{{...}}` in persona text is strict interpolation, and only two variables exist: `provider`
> and `model`** (registered by `dsh-agent-loop`). Writing any other name (e.g. `{{cwd}}`) makes
> **the entire turn fail**: `unknown prompt variable "{{cwd}}" in section
> "deployment:persona-suffix"; registered variables: provider, model`. The working directory is
> already in the runtime context, so the persona does not need to repeat it — an early version of
> this blueprint hit this exact pitfall, and the global and both preset personas have now been
> unified into a one-line reference to the runtime context.

> ⚠️ Do not "simplify" this block down to a single `- id: system-prompt` row. Agents in the web
> composition always go through presets, and a `dsh-persona` row inside a preset **shadows** the
> global persona by scope — verified: tag the global persona and the tag **will not** appear in a
> preset session's prompt; and `dsh-base`'s global tool rows are all `disabled: true`, with the tool
> surface that actually takes effect living in the preset's `plugins`. For the mechanism and how to
> regenerate it after an upgrade, see
> [profile/dsh-automation-suite/README.md](profile/dsh-automation-suite/README.md).
>
> ⚠️ Engineering tools are **dispatched per preset**: the host surface keeps only the
> controller/engine child processes and services; model-facing tool rows are declared in presets.
> The four built-in presets are disabled by default; if you restore one and switch to it,
> **TIA, engineering-context, and graph tools do not exist** — this is intentional. See
> [`docs/decisions.md`](docs/decisions.md) **D23**.

### 8.2 Plugin configuration

```yaml
# ~/.dsh/profiles/dsh-automation-suite/cordis.patch.yml
- id: tia-openness-v17-min
  config:
    opennessDir: 'C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17'
    requestTimeoutMs: 600000        # real imports/compiles often need >10 min; the default 300000 times out
- id: tool-git
  config:
    destructivePolicy: ask          # deny (default) | ask | allow
    workDir: 'C:\work\my-repo'
```

**TIA plugin** (everything has a default; the whole `config` block can be omitted):

| Field | Default | Description |
|---|---|---|
| `controllerPath` | `''` | absolute path to the controller exe; empty = the bundled `controller/bin/…`. Can also be set via the env var `TIA_OPENNESS_V17_MIN_CONTROLLER` |
| `opennessDir` | `''` | passed to the controller as `--openness-dir`; empty = controller default. The controller side also honors `TIA_OPENNESS_V17_DIR` |
| `requestTimeoutMs` | `300000` | hard timeout per operation; on timeout the controller is **terminated** (Openness cannot cancel), and the next call restarts it automatically |
| `startupTimeoutMs` | `30000` | startup handshake timeout |
| `shutdownGraceMs` | `5000` | on unload, close stdin for a graceful exit, then force-kill after the timeout |
| `maxQueue` | `8` | queue limit; beyond it returns `controller_busy` |
| `logControllerOutput` | `false` | forward controller stdout/stderr to the DSH log |
| `verboseResults` | `false` | include the full controller payload in tool results |

**Git plugin**:

| Field | Default | Description |
|---|---|---|
| `workDir` | `''` | starting directory for repository discovery (defaults to process cwd) |
| `gitPath` | `git` | git executable |
| `destructivePolicy` | `deny` | `deny` / `ask` / `allow` |
| `extraDestructivePatterns` | `[]` | extra case-insensitive regexes appended to the gate |
| `logMaxCommits` | `20` | default `git_log` count (max 100) |
| `diffContextLines` | `3` | patch context lines for `git_diff` / `git_show` |

Every tool accepts an optional `repoDir` and reports the resolved repository root in its result.

> If the profile's `patchReload` is not `live`, restart DSH after changing configuration.

---

## 9. Repository Layout

```
packages/
  dsh-tia-openness-v17-min/        TIA Portal V17 Openness plugin (MIT)
    src/                           plugin and protocol implementation (index/config/controller/protocol/tools/skills/errors)
    controller/                    C# controller (x64 / .NET Framework 4.8)
      bin/                         built artifact TiaOpennessV17Min.Controller.exe (+ .exe.config)
    skills/                        bundled Openness knowledge base: 31 upstream SKILL.md files (verbatim) + routing skill
    test/                          node:test suite (62: 61 pass / 1 skip)
    docs/                          protocol, decision records, real-project runs, coverage matrix, functional-test guide
    test-profile/                  trial-run material: three-tier verification guide + scripts; does not touch the default profile
  dsh-tool-git/                    vendor copy (upstream lxj808624/dsh-tool-git v0.1.3, MIT)
    src/tools/                     12 git tools
    src/safety.ts                  tools/pre-execute destructive-command gate
    tests/                         vitest suite (33)
    README.md / README.zh.md       upstream README (English/Chinese)
  dsh-engineering-context/         engineering-context plugin: **registered in the blueprint; 3 tools (D22 + S2) + graph builds via seam B (D25)**
    src/                           scope resolution, seams A/B, evidence ledger, locks, shell-free git, 3 workflow tools (tsc → lib/)
    test/                          node:test suite (73; fake TIA/graph services + real runtime schema checks + real git repos)
    scripts/                       link-dsh-runtime.mjs / tsc.mjs / run-tests.mjs
    docs/                          ARCHITECTURE.md / PATH-RULES.md / decisions.md
  dsh-engineering-graph/           engineering knowledge-graph plugin: **engine + protocol + 8 tools + knowledgeGraph service, registered in the blueprint**
    src/                           NDJSON protocol client, 4 knowledge tools (incl. local discovery), knowledgeGraph service (tsc → lib/)
    test/                          node:test suite (111; incl. end-to-end through the real engine and transport-fault injection)
    engine/                        C# engine (net8 + Microsoft.Data.Sqlite): Simatic ML → graph → SQLite
                                   Graph/ Parsing/ Import/ are vendored (namespaces flattened, see D17);
                                   build.ps1 builds into engine/bin (**committed**: without the engine the plugin still loads but every call reports
                                   engine_not_found, so shipping it in the package is what makes "checkout just works"); fixtures/ are 7 real V17 exports
    scripts/                       link-dsh-runtime.mjs / tsc.mjs / run-tests.mjs
  dsh-ui-plc-source/               right-sidebar "PLC Blocks" tab + host pre-step listener (mention injection), registered in the blueprint
    src/index.ts                   host half: agent/pre-step resolves @'block name' into reference info (tsc → lib/)
    src/model.ts                   pure model: manifest parsing/flattening/filtering/sorting/resource URLs/copy/mention syntax (tsc → lib/)
    src/client/                    apply(ctx) + panel component + styles (esbuild → lib/client.js, the loader wrapper the host recognizes)
    test/                          node:test suite (20, pure model)
    scripts/                       tsc.mjs / build.mjs / run-tests.mjs
  dsh-ui-tia-console/              "TIA console" above the input box: status + open/save/compile/close/refresh (browser half only)
    src/index.ts                   host half: empty apply(), only so the package has a row in the Loader
    src/client/model.js            pure event folding: command/tool events → console state (unit-testable)
    src/client/TiaBar.jsx          console component (status, buttons, expanded details, stopwatch)
    src/client/index.jsx           registers the conversation.input.dock slot
    test/                          node:test suite (22, pure folding + dictionary)
    scripts/                       tsc.mjs / build.mjs / run-tests.mjs
profile/
  dsh-automation-suite/            the distribution's profile blueprint
    package.json                   dsh.profile.bundles = composition order
    cordis.patch.yml               user patch layer (empty array; environment settings go here)
    pnpm-workspace.yaml            verbatim match with DSH's initProfile() template (nodeLinker: hoisted)
scripts/
  start-env.ps1                    isolated DSH_HOME environment launcher
  clean-build.mjs                  build-artifact cleaner that touches only lib/ dist/
docs/
  vision.md                        vision: the problem, the three-layer plan, per-layer responsibilities and design principles
  architecture.md                  target architecture: the interface plugin family and the two engineering plugins: responsibilities, boundaries, contracts, data flow
  decisions.md                     distribution-level decision records (settled trade-offs + items to verify)
  open-questions.md                open questions (34; edit directly to add answers)
  roadmap.md                       roadmap and status: item-by-item progress, gaps, verification criteria
  tool-surface.md                  tool-surface redesign (research + proposal): current-state checkup, workflow list, target tool surface and return contracts
AGENTS.md                          repo-level conventions (structure & naming, dangerous-operation red lines, verification criteria)
LICENSE                            this repo's MIT license (original parts)
pnpm-workspace.yaml                workspaces: packages/* + profile/*
```

---

## 10. Development

```powershell
pnpm install              # install the whole repo
pnpm -r build             # build the whole repo
pnpm -r typecheck         # type-check the whole repo
pnpm test                 # test the whole repo
pnpm run clean:build      # clean build artifacts (only lib/ dist/)
```

The four plugins use **two test runners**, and `pnpm -r test` runs all six:

| Package | Runner | Test size |
|---|---|---|
| `dsh-tia-openness-v17-min` | `node:test` (`node --test test/*.test.mjs`) | 97: 96 pass / 1 skip (the skip is the "controller not built" fallback path) |
| `dsh-tool-git` | `vitest` (`vitest run`) | all 33 pass |
| `@voltarenyah/dsh-engineering-context` | `node:test` (`node scripts/run-tests.mjs`, build first) | all 56 pass (incl. contract cases through fake `engineeringAccess` / fake `knowledgeGraph` services) |
| `@voltarenyah/dsh-engineering-graph` | `node:test` (`node scripts/run-tests.mjs`, build first) | all 111 pass (incl. end-to-end through the real engine; when the engine is not built that test is skipped and prints the build command) |
| `dsh-ui-plc-source` | `node:test` (`node scripts/run-tests.mjs`, build first; the browser-half `.jsx` is not in `tsc`) | all 47 pass (pure model 33 + host 9 + dictionary 5) |
| `dsh-ui-tia-console` | `node:test` (`node scripts/run-tests.mjs`, build first) | all 22 pass (pure event folding + dictionary) |

Unit tests need the **real** `@deepseek-ai/*` runtime (not stubs). On a bare checkout, the test
bootstrap of the first two packages triggers extraction automatically; you can also run it manually:

```powershell
pnpm --filter @voltarenyah/dsh-tia-openness-v17-min run link:runtime
pnpm --filter dsh-tool-git run link:runtime
```

Each package also has targeted commands (run from the package directory):

```powershell
npm run check            # TIA: build + test + matrix:check + skills:check
npm run build:controller # TIA: rebuild the C# controller (needs local TIA V17 + NuGet feed)
npm run test:controller  # TIA: 14 controller self-checks (no TIA Portal needed)
npm run matrix:build     # TIA: regenerate docs/coverage-matrix.html
npm run skills:build     # TIA: refetch the upstream knowledge base at the pinned commit
```

### A few conventions you must know

- **Do not hand-edit generated files**: the TIA package's `docs/coverage-matrix.html`,
  `skills/<upstream name>/SKILL.md`, and `skills/UPSTREAM.json` are generated; after changing `src/`
  or the controller, run the matching `:build` command, otherwise `:check` fails.
- **`tsdown` bundles any package it can resolve**, so `deps: { neverBundle: true }` in
  `dsh-tool-git`'s two tsdown configs must not be removed: otherwise, after the runtime is linked,
  the artifact would inline the entire host runtime (57.78 kB → 391.40 kB), and the plugin would get a
  private copy of `dsh-tools`. **Acceptance criterion**: `lib/index.mjs` should be about 57.78 kB.
- **The name `clean` cannot be used**: pnpm 11 has a built-in subcommand that shadows the script;
  this repo uses `clean:build`.
- Writing a glob inside a JS block comment truncates the comment (the `*/` in
  `profiles/*/node_modules` ends `/** … */` early); write paths as
  `profiles/<profile>/node_modules` or escape them.

---

## 11. Verification

**End-to-end verification of the profile composition**:

```powershell
dsh --profile dsh-automation-suite --dump-config
```

The expected tail (3 lines per plugin, 21 lines for 7 plugins — 6 local + the public
`dsh-opencode-go`):

```yaml
# == @voltarenyah/dsh-tia-openness-v17-min
- id: tia-openness-v17-min
  name: '@voltarenyah/dsh-tia-openness-v17-min'
# == @voltarenyah/dsh-engineering-context
- id: engineering-context
  name: '@voltarenyah/dsh-engineering-context'
# == @voltarenyah/dsh-engineering-graph
- id: engineering-graph
  name: '@voltarenyah/dsh-engineering-graph'
# == dsh-tool-git
- id: tool-git
  name: dsh-tool-git
# == dsh-ui-plc-source
- id: ui-plc-source
  name: dsh-ui-plc-source
# == dsh-ui-tia-console
- id: ui-tia-console
  name: dsh-ui-tia-console
# == dsh-opencode-go
- id: opencode-go
  name: dsh-opencode-go
```

With **the policy layer from §8.1** applied, line counts are in the authoritative baseline table in
root `AGENTS.md` §4 (re-measured after this blueprint switched to three presets and added
`dsh-opencode-go`). The parts beyond the official web composition include the global `system-prompt`
override row, the `agent-preset-registry` override row, the whole tool-list block of
`preset-leader`, the smaller lists of `preset-auditor` and `preset-expert`, and additionally:

```yaml
- id: agent-preset-registry
  config:
    default: leader
- id: preset-leader
  name: '@deepseek-ai/dsh-agent-preset'
- id: preset-auditor
  name: '@deepseek-ai/dsh-agent-preset'
- id: preset-expert
  name: '@deepseek-ai/dsh-agent-preset'
- id: engineering-context
  disabled: true
```

To preview the policy layer without changing any environment, stack it with `--patch`
(`--dump-config` does not mount plugins):

```powershell
dsh --profile web --patch .\profile\dsh-automation-suite\cordis.patch.yml --dump-config
```

The stronger check is `dsh --profile <p> --dump-config-schema`: if the plugin's Config fields appear
in the output (e.g. `opennessDir`, `destructivePolicy`), the module was **really imported and its
schema read**.

> Note that `--dump-config-schema` also exits 1 on the official `web` profile **with no plugins
> installed** — those 4 `unrecognized Loader tree carrier` errors land on the official
> `dsh-agent-preset` rows (`/179`–`/182`) and have nothing to do with the plugins; do not
> investigate them as plugin problems.

**Tarball installation verification chain**:

```powershell
cd packages/<pkg>; pnpm pack
dsh plugin --profile <temporary profile> add <tarball>
dsh --profile <temporary profile> --dump-config     # contains your plugin's rows = passed
```

**Post-start runtime verification**: see [§7.6](#76-how-to-tell-that-startup-succeeded) (token URL,
port listening, `TiaOpennessV17Min.Controller` child process).

---

## 12. Troubleshooting

The first step in TIA troubleshooting is always to have the model call:

```jsonc
{ "include_controller_output": true }   // controller_status: process state, exe path, Openness probe, user group, last error
```

| Symptom / error code | Meaning and handling |
|---|---|
| `openness_unavailable` | `Siemens.Engineering.dll` cannot be found: confirm TIA Portal V17 is installed, or point `opennessDir` at it |
| `openness_load_failed` | the DLL exists but is unusable (bitness mismatch / missing dependency): confirm **x64** and a complete installation |
| `project_not_open` / `project_already_open` | call `open_project` first / call `close_project` first |
| `project_open_failed` | open failed (usually an older-version project): `allow_upgrade` is needed |
| `plc_software_not_found` / `plc_software_ambiguous` | pass `device_name` / `software_name` to disambiguate |
| `block_not_found` | the block does not exist; `details.available` lists the project's blocks |
| `verification_failed` | read-back verification after the write did not pass (`data` still contains the writes that happened and the verification report) — **do not** blindly retry |
| `transaction_failed` | could not obtain exclusive access (another Openness client may be modifying the project) |
| `controller_not_found` | controller exe not found: `npm run build:controller` or set `controllerPath` |
| `controller_timeout` | exceeded `requestTimeoutMs`; the controller has been terminated and the **TIA session is lost**; the next call restarts automatically; raise the timeout first |
| `controller_busy` | the queue exceeds `maxQueue`: a long operation is running; wait for it to finish |
| `controller_protocol_mismatch` | exe and plugin versions do not match: rebuild from the same repo |
| Port already in use | change `-Port`, or add `-Restart` to stop the old instance (it will not touch an occupant that is not DeepSeek Harness) |
| Bare address returns 401 | you must use the **tokenized URL** printed by `dsh`; the token changes on every start and is never persisted |
| TIA/git tools missing from the session | the plugin did not load: check `--dump-config` for the corresponding rows; restart if `patchReload` is not `live` |

---

## 13. Known Boundaries

- **The TIA plugin only handles blocks, PLC data types (UDTs), and tag tables**: `export_blocks` /
  `import_blocks` use `categories` to select `blocks` (default) / `types` / `tag_tables`. Hardware
  configuration, online download/upload, comparison, libraries, multi-user, HMI, and so on are
  **not implemented**; for item-by-item coverage see
  `packages/dsh-tia-openness-v17-min/docs/coverage-matrix.html` (391 capability entries, regenerated
  automatically with the code).
- **Not every block in a real project can be exported**: ProDiag-language blocks and Safety (F-)
  blocks are rejected outright by TIA; the controller reports them block by block
  (`data.failures[]`) and continues.
- **An import must specify the group where the block originally lived** (`target_group`), and
  "re-export after import" must come after compilation; see `docs/FUNCTIONAL-TEST.md` §8.5.
- **One host process, one TIA Portal session**: different DSH sessions share the same controller and
  queue behind each other.
- **A timeout means the session is lost**: Openness cannot cancel, so the only reliable handling of a
  timeout is to terminate the controller; when it is force-killed, **the TIA Portal process it
  started may remain running** (it is a separate process, and the plugin never kills it) — use
  `close_project` (`close_portal: true`) to shut down cleanly.
- **Two items awaiting manual verification** (they need a human in the UI / a real environment): the
  **HMR disposer path** in a live instance (disable/enable the plugin in the UI and watch the child
  process stop and restart), and the **V18+ Openness application allow-list** policy (not triggered
  on V17 here). Details in `docs/verification.md` §B.
- **The Git gate is a policy guardrail, not a sandbox**: see [§4.3](#43-the-git-plugin-shell-free-execution-and-a-policy-gate).

---

## 14. Safety Red Lines

Every item below has a real accident record (see
`packages/dsh-tia-openness-v17-min/docs/ECOSYSTEM-COMPAT.md`):

- ❌ **Never** use recursive deletion that **follows junction/symlink targets** — `rm -rf`,
  `Remove-Item -Recurse`, .NET `Directory.Delete`, etc. — to clean `node_modules` or profile
  directories. Such deletion has destroyed a source repository's `.git` metadata.
- ❌ **Never** declare `@deepseek-ai/*` (or any DSH runtime package) as a dependency in the root
  `package.json` — they are provided by the profile's runtime resolution.
- ❌ **Never** remove `private` from the root `package.json`.
- ✅ To detach a junction, use only `cmd /c rmdir "<path>"` (which deletes the link itself) or
  `Remove-Item -Force` (**without** `-Recurse`).
- ✅ Clean build artifacts with `pnpm run clean:build`: it checks only `lib/` and `dist/`, and
  unlinks links instead of descending into them.
- ✅ When using `-Reset` or deleting the isolated `DSH_HOME` by hand, you **must** use
  `cmd /c rmdir /s /q`: it contains `link:` entries and pnpm junctions pointing at the repo and the
  pnpm store, and following recursive deletion would destroy the targets.
- ✅ To relink the runtime, use `pnpm --filter <pkg> run link:runtime -- --force`: if the target is a
  link, it is only unlinked, never descended into.

---

## 15. License and Third Parties

The repo as a whole is licensed under **MIT** (root [`LICENSE`](LICENSE)), covering the original parts
of this repo: the `profile/` blueprint, the `scripts/` tooling, and this document. Third-party content
shipped with packages keeps its own terms:

| Component | License | Notes |
|---|---|---|
| `dsh-automation-suite` (this repo) | MIT (root [`LICENSE`](LICENSE)) | blueprint, monorepo scripts, docs; root `package.json` already declares `"license": "MIT"` |
| `@voltarenyah/dsh-tia-openness-v17-min` | MIT (package `LICENSE`) | original code from this repo |
| `dsh-tool-git` | MIT (package `LICENSE`) | a **flattened vendor copy** of upstream [`lxj808624/dsh-tool-git`](https://github.com/lxj808624/dsh-tool-git) `v0.1.3` (commit `2347e3d`); the package name deliberately stays upstream's `dsh-tool-git` (no scope), so it **cannot be published to npm under the same name** |
| Siemens Openness skill set | MIT | a **verbatim documentation copy** of upstream [`siemens/tia-portal-ai-extensions`](https://github.com/siemens/tia-portal-ai-extensions) commit `b5c7041` (31 files, not a single line of code taken), with the upstream license text and per-file sha256 |
| Siemens NuGet runtime | Siemens' own terms | `controller/bin/` ships **the Siemens resolver and its 5 dependencies** with the plugin (~889 KB, unmodified); `Siemens.Engineering.dll` is **never distributed by this repo** (the reference package uses `CopyLocal=false`) and always comes from the user's own TIA Portal installation. For the full list and compliance stance see `packages/dsh-tia-openness-v17-min/THIRD_PARTY_NOTICES.md` |

The differences between `dsh-tool-git` and this repo (package-name policy, runtime linking,
`neverBundle`, added scripts) are recorded in `packages/dsh-tool-git/AGENTS.md`, together with the
"four differences to preserve" when syncing with upstream.

---

## 16. Documentation Index

> The design documents linked below are currently written in Chinese; this README is the English
> entry point.

| Document | Contents |
|---|---|
| [`docs/vision.md`](docs/vision.md) | **Vision**: why PLC projects are unreachable for LLMs, the responsibilities and interfaces of the three layers (access / semantic / management), cross-cutting design principles, terminology, and non-goals |
| [`docs/architecture.md`](docs/architecture.md) | **Target architecture**: responsibilities, expectations, and boundaries of the interface plugin family and the two engineering plugins; the three orthogonal axes; data flow; inter-plugin contracts and dependency order |
| [`docs/decisions.md`](docs/decisions.md) | **Decision records (distribution level)**: 12 settled trade-offs (capability layering, workspace model, fingerprint-based change detection, object identity, graph foundation, where the engineering-context plugin keeps state, …) and 5 items to verify |
| [`docs/open-questions.md`](docs/open-questions.md) | **Open questions (34)**: 17 in part A block further work (including the A14–A17 tool-surface questions), 17 in part B affect details and verification criteria; 16 answered |
| [`docs/roadmap.md`](docs/roadmap.md) | **Roadmap and status**: item-by-item progress, gaps, and verification criteria per plugin |
| [`docs/tool-surface.md`](docs/tool-surface.md) | **Tool-surface redesign (research + proposal)**: current-state checkup (26 tools at 1:1, 20-line render cap, ~14k tokens of standing directory), user workflow list, target tool surface and return contracts, where to start |
| [`docs/ui-plugins.md`](docs/ui-plugins.md) | **Web GUI UI plugins**: client-plugin loading mechanism (with end-to-end measurements), base-module table, seat directory, the `source/` data plane, a worked design using the "engineering block tree" as an example, and client bundling recipes |
| [`docs/ui-plugins-plc-blocks-plan.md`](docs/ui-plugins-plc-blocks-plan.md) | **`dsh-ui-plc-source` implementation plan and verification record**: spec, data plane (flattened manifest + device/type filters), degradation, build, wiring, measured results |
| [`packages/dsh-ui-plc-source/README.md`](packages/dsh-ui-plc-source/README.md) | usage, build (tsc + esbuild), and installation location of the right-sidebar **PLC Blocks** tab |
| [`packages/dsh-engineering-context/README.md`](packages/dsh-engineering-context/README.md) | usage, configuration, and development commands of the engineering-context plugin (**S2 implemented**: create + status + sync) |
| [`packages/dsh-engineering-context/docs/`](packages/dsh-engineering-context/docs/) | the plugin's design and trade-offs: `ARCHITECTURE.md` (core architecture, scope model, version management, tool surface), `PATH-RULES.md` (in-workspace path rules, ledger/manifest), `decisions.md` (numbered decisions D1–D26) |
| [`docs/distribution.md`](docs/distribution.md) | **Public release and installation**: measured DSH install surface (`dsh plugin` spec forms, bundle reconciliation, patch semantics, two pnpm 11 errors), comparison of three packaging approaches, release steps, and verification records |
| [`profile/dsh-automation-suite/README.md`](profile/dsh-automation-suite/README.md) | composition of the blueprint, its three deployment methods, and how to verify it |
| [`packages/dsh-tia-openness-v17-min/README.md`](packages/dsh-tia-openness-v17-min/README.md) | complete TIA plugin documentation (verification state, protocol, tools, error codes, V17 API notes) |
| [`packages/dsh-tia-openness-v17-min/docs/`](packages/dsh-tia-openness-v17-min/docs/) | `PROTOCOL.md` (authoritative wire protocol), `decisions.md` (technical trade-offs), `REAL-RUN.md` (real-project runs), `FUNCTIONAL-TEST.md`, `verification.md` (verification checklist), `ECOSYSTEM-COMPAT.md` (ecosystem compatibility and accident records) |
| [`packages/dsh-tool-git/README.md`](packages/dsh-tool-git/README.md) · [`README.zh.md`](packages/dsh-tool-git/README.zh.md) | git plugin's tool table, safety gate, installation, and configuration |
| [`packages/dsh-tool-git/AGENTS.md`](packages/dsh-tool-git/AGENTS.md) | how this vendor copy differs from upstream, runtime linking, `neverBundle` |
| [`packages/dsh-tia-openness-v17-min/AGENTS.md`](packages/dsh-tia-openness-v17-min/AGENTS.md) | sync rules for the coverage matrix and knowledge base |
| [`AGENTS.md`](AGENTS.md) | repo-level conventions: structure, naming, dangerous-operation red lines, verification criteria |
| [`LICENSE`](LICENSE) | this repo's MIT license; license terms for shipped/vendored content are in [§15](#15-license-and-third-parties) |
