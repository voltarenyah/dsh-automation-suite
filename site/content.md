# dsh-automation-suite

## Home

### Hero
- Eyebrow: DeepSeek Harness For Automation (Unofficial)
- Title: Agent Tool for PLC Programming
- Lead: Deepseek Harness integrated with Siemens TIA Openness toolkit
- Primary action: Get started
- Secondary action: See the architecture
- Stats: 

### The gap
Note: Where a general-purpose model stalls on PLC work.

1. **Sealed project files**
   Logic lives in a binary that only the engineering software can read.
2. **Text is not structure**
   An exported XML is text; the model needs blocks, calls, tags and I/O.
3. **Unverified edits**
   A change is only real once it compiles and reads back.

### What ships
Note: Three layers, each one unlocking the next.

1. **Access** — Partial
   Read and write TIA Portal V17 blocks through Openness — inside a whitelist.
2. **Semantics** — Prototype
   Project sources become a queryable graph of blocks, calls, tags and I/O.
3. **Governance** — Partial
   Export to text, diff, commit and trace versions — with Git as the base.

### Capability wall
Note: Vocabulary of the hero demo panel. Rule: every term names something a TIA Portal engineer can point at inside the software — a block type, a table, a dialog, a device state. Internal design vocabulary (transactions, whitelists, ledgers, fingerprints) is deliberately excluded, as is anything the suite does not actually do. A trailing `*` marks a roadmap item, rendered with a star and the legend "on the roadmap, not shipped yet". Anchors (rendered largest): TIA Portal V17 · TIA Openness · Export blocks · Compile PLC · Version control · PLCSIM Advanced.

- TIA Portal — Export blocks · Import blocks · Generate source · External source · OB · FB · FC · DB · UDT · Tag tables · Watch tables · Force tables · Project archive · Project library · Master copy · Type version · Software units · Know-how protection · Safety signature · Project languages · Open in block editor · Save as
- Reading a project — Call structure · Cross references · Variable usage · Block search
- Versioning — Version control · Version history · Git diff · Project translation
- Simulation — PLCSIM Advanced · Power on / off · RUN / STOP / reset · Tag read / write · Snapshot / restore · Retained data · Softbus / TCP-IP
- Panels — PLC blocks panel · TIA console · Drawing search
- Roadmap (*) — TIA Portal V18* · Hardware config* · Online & download* · Compare blocks* · Project diff* · Cable & terminals*

## Architecture

### Page head
- Eyebrow: Architecture
- Title: A small surface, strictly enforced
- Lead: The model never gets arbitrary execution. Writes go through a whitelist, a transaction and a read-back check; tools return structured data instead of free-form shell output.

### Principles
Note: Four rules that decide what a tool may do.

1. **Whitelisted operations**
   The model expresses paths, block names and enums; the controller runs one of its registered operations.
2. **Transactional writes**
   All objects commit or none do — a failed import rolls back.
3. **Read-back verification**
   After an import the project is re-read and each block compared by name, number and language.
4. **Structured results**
   Every tool returns ok / summary / data / error as data, not as prose to parse.

### Components
Note: Eight packages plus one profile blueprint; each installs on its own.

| Package | Role | Tools | Status |
| --- | --- | --- | --- |
| `@voltarenyah/dsh-tia-openness-v17-min` | TIA Portal V17 access | 32 | Partial |
| `@voltarenyah/dsh-plcsim-advanced` | PLCSIM Advanced runtime | 4 | Verified |
| `@voltarenyah/dsh-engineering-context` | Project scope and version store | 4 | Partial |
| `@voltarenyah/dsh-engineering-graph` | Knowledge graph · SQLite + C# engine | 9 | Prototype |
| `dsh-tool-git` | Guard-railed Git | 12 | Verified |
| `dsh-ui-plc-source` | Sidebar · PLC Blocks | — | Verified |
| `dsh-ui-tia-console` | Composer · TIA console | — | Verified |
| `dsh-ui-versions` | Sidebar · Versions | — | Verified |

Note: The blueprint assembles them into one profile and splits the tools across three presets: leader (44), auditor (18), expert (16).

### How it runs
Note: One process boundary, because Openness demands it.

Openness can only be called from a 64-bit .NET Framework process, so the TIA plugin owns a C# controller subprocess and speaks one JSON object per line over stdio. Requests are serialized; a timeout terminates and restarts the controller.

`TiaOpennessV17Min.Controller.exe · x64 · .NET Framework 4.8`

## Roadmap

### Page head
- Eyebrow: Roadmap
- Title: Where it stands today
- Lead: An early build. Statuses follow the repository roadmap, and nothing planned is presented as shipped.

### Maturity
Note: The three layers, as they actually are.

1. **Access** — Partial
   Block export and import, compile and project data work on real projects. Twenty operations added in v0.2 are still unverified in the field.
2. **Semantics** — Prototype
   XML to SQLite graph works on fixtures. Freshness, incremental updates and a compatibility layer are not done.
3. **Governance** — Partial
   The Git tools are general-purpose. The version workflow is two steps: sync the source tree, then commit it.

### Compatibility
Note: What it runs on today.

- Operating system: Windows for the TIA tools. Other platforms can load the plugins, but TIA calls fail.
- DeepSeek Harness: Any version that can load bundles; built and tested against 0.2.1-rc.2.
- TIA Portal: V17 only — V16 and V18 are not compatible.
- Node.js: 22.19 or newer.
- Openness: Siemens.Engineering.dll from Portal V17, and membership in the local “Siemens TIA Openness” group.

### Next
Note: Planned, not promised.

1. **V18 member**
   A second interface-plugin member, sharing the same core.
2. **More capability**
   Hardware configuration, online and download, comparison and libraries.
3. **Graph freshness**
   Incremental updates and a compatibility layer for older exports.
4. **Change ledger**
   A per-block change ledger, with DRAFT and REMOTE workspace states.

Link: [Full roadmap and open questions](https://github.com/voltarenyah/dsh-automation-suite/blob/main/docs/roadmap.md)

## Get Started

### Page head
- Eyebrow: Get started
- Title: One command to a running instance
- Lead: The starter materializes the profile, links the plugins, starts dsh and opens a tokenized URL — in its own DSH_HOME.

### Before you start
Note: What has to be on the machine.

- Operating system: Windows 10 or 11 — the TIA tools are Windows-only.
- Node.js: 22.19 or newer.
- DeepSeek Harness: Installed, and able to load bundles.
- TIA Portal: V17 with Openness enabled — needed only for the TIA tools.

### Run it
Note: Three commands, no build step first.

```powershell
$ git clone https://github.com/voltarenyah/dsh-automation-suite
$ cd dsh-automation-suite
$ pwsh -NoProfile -File scripts\start-env.ps1
```

### After it starts
Note: A working session in three moves.

1. **Open the printed URL**
   It carries a one-time token; the bare port returns 401.
2. **Add a model API key**
   Settings → Models, or the first-run prompt. Credentials stay inside this DSH_HOME.
3. **Try the TIA console**
   Open or adopt a project, export a block, then read it back and compile.

Note: The environment defaults to %USERPROFILE%\dsh-suite-env. Delete that folder to roll everything back.

Link: [Repository README](https://github.com/voltarenyah/dsh-automation-suite/blob/main/README.md)

## Shared

- Navigation: Home · Architecture · Roadmap · Get Started
- GitHub button: GitHub
- Status labels: Verified · Partial · Prototype
- Copy button: Copy, then Copied
- Next-step cards:
  - Architecture — Why it's built this way
  - Roadmap — Can I use it now?
  - Get Started — Run it in one command
- Footer: Unofficial project. Not affiliated with DeepSeek or Siemens. TIA Portal and SIMATIC are trademarks of Siemens AG, named here for reference only.
- Footer links: GitHub · README · MIT
- Last checked: 2026-11-03

## Page metadata

### Home
- Title: dsh-automation-suite — agent tool for PLC programming
- Description: An unofficial DeepSeek Harness distribution that integrates the Siemens TIA Openness toolkit: TIA Portal V17 block access, an engineering knowledge graph and guard-railed Git.

### Architecture
- Title: Architecture — dsh-automation-suite
- Description: Design principles and components: whitelisted operations, transactional writes, read-back verification, structured results.

### Roadmap
- Title: Roadmap — dsh-automation-suite
- Description: Maturity, environment compatibility and the planned capability of the distribution.

### Get Started
- Title: Get Started — dsh-automation-suite
- Description: One command to a running DSH instance with the automation suite's plugins.
