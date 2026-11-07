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
- Title: One distribution, twelve bundles
- Lead: The suite is a DeepSeek Harness profile over twelve independently installable bundles. The profile decides which packages compose, which services connect them, and which tools each preset can see.

### Why a distribution
Note: DSH installs bundles; the profile composes them and sets policy.

1. **Bundle = capability** — Each plugin is a normal DSH bundle with its own `cordis.patch.yml`. It can be installed on its own; the release publishes one tarball per package.
2. **Profile = composition** — A profile is the composition layer: it declares bundles, presets and policy. It is not a bundle: `dsh plugin add` rejects it as `not-a-bundle`.
3. **Release = a tested combination** — The GitHub release ships the blueprint, per-package tarball URLs and an installer. It pins the combination that was verified together — not a mega-package.

### Principles
Note: Four rules that decide how the pieces are assembled.

1. **Compose, don't absorb** — One capability per bundle. The distribution is a profile over packages, not a single plugin that swallows them.
2. **Services are the cross-plugin API** — Plugins never import each other. They meet through a small set of host services — TIA access, the knowledge graph, and the git repository — and report a missing service instead of guessing.
3. **Visibility is a preset decision** — Host rows own processes and services. Tool rows are mounted by a preset, so the same package can expose different surfaces to leader, auditor and expert.
4. **Policy is configuration** — Personae, the default preset, disabled built-ins and subagent limits live in the profile. Changing them does not rebuild a plugin.

### Components
Note: Twelve bundles. “Work with” names the other bundles each one needs; “Version” is the package version.

| Package | Role | Tools | Work with | Version |
| --- | --- | --- | --- | --- |
| `@voltarenyah/dsh-tia-openness-v17-min` | TIA Portal V17 access | 39 | Works alone | 0.1.0 |
| `@voltarenyah/dsh-plcsim-advanced` | PLCSIM Advanced runtime | 4 | Works alone | 0.1.0 |
| `@voltarenyah/dsh-engineering-graph` | Knowledge graph · SQLite + C# engine | 9 | Works alone | 0.1.0 |
| `dsh-tool-git` | Guard-railed Git | 12 | Works alone | 0.1.3 |
| `@voltarenyah/dsh-engineering-context` | Project scope and version workflow | core + diff + version | TIA plugin · git · graph (optional) | 0.1.0 |
| `@voltarenyah/dsh-drawing` | PDF drawing index + sidebar | 5 | Works alone | 0.1.0 |
| `dsh-ui-plc-source` | Sidebar · PLC Blocks | — | engineering-context | 0.1.0 |
| `dsh-ui-tia-console` | Composer · TIA console | — | TIA plugin | 0.1.0 |
| `dsh-ui-versions` | Sidebar · Versions | — | engineering-context | 0.1.0 |
| `dsh-ui-hardware` | Sidebar · Hardware | — | TIA plugin | 0.1.0 |
| `dsh-ui-prompt-guide` | Main · Prompt Guide | — | Works alone | 0.1.0 |
| `dsh-ui-project-dashboard` | Sidebar · Project dashboard | — | Works alone | 0.1.0 |

Legend: “Work with” lists the bundles this one needs; “Works alone” means no other bundle is required. Versions are package versions; the suite release is versioned separately.

Note: The profile blueprint is not a component: it is the assembly layer above these packages. Package versions are independent of the suite release.

### Preset surfaces
Note: The package is not the unit of visibility; the row is.

| Surface | leader | auditor | expert |
| --- | --- | --- | --- |
| TIA tools · `/tools` (39) | ✓ | — | — |
| TIA `/tia-*` commands (human) | ✓ | — | — |
| PLCSIM tools · `/tools` (4) | ✓ | — | — |
| Git tools · `/tools` (12) | ✓ | — | — |
| Graph inspect · `/tools` | ✓ | — | — |
| Graph full + ingest · `/tools` | — | ✓ | — |
| Graph drill-down · `/tools` | — | — | ✓ |
| Engineering workflow · main row | — | ✓ | — |
| `project_status` · `/status` | ✓ | ✓ | — |
| `project_diff` · `/diff` | — | ✓ | ✓ |
| Version tools · `/version` | ✓ | ✓ | — |
| Version read-only · `/version-read` | — | — | ✓ |
| Filesystem | read/write | read-only | read-only |

A preset mounts an entry point:

```yaml
# profile/cordis.patch.yml — a preset mounts an entry point
- id: leader-tia-tools
  name: '@voltarenyah/dsh-tia-openness-v17-min/tools'

# the host row is separate; it owns the controller and the service
- id: tia-openness-v17-min
  name: '@voltarenyah/dsh-tia-openness-v17-min'
```

Note: `leader` gets the working surface; `auditor` owns the version workflow; `expert` gets read-only drill-down. A subagent cannot inherit a tool its preset did not mount.

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
- Title: Install it, start it, verify it
- Lead: Two main paths — the GitHub release zip for users, or the repository starter for development — plus a per-bundle install for advanced use. All run the same blueprint in an isolated DSH_HOME.

### Before you start
Note: The suite runs on DSH. Only the TIA and PLCSIM tools need Siemens software; the rest is a normal DSH plugin.

| Requirement | What it needs |
| --- | --- |
| Operating system | Windows 10/11 x64 for the release installer and all TIA/PLCSIM work. The non-TIA plugins can load on other platforms, but this guide assumes Windows. |
| DeepSeek Harness | Installed and able to load bundles — built and tested against 0.2.1-rc.2. The release installer uses its CLI and bundled pnpm; it does not install DSH for you. |
| TIA Portal V17 | Only for the TIA tools: V17 with Openness — V16 and V18 are not compatible; TIA also brings the .NET Framework 4.8 runtime the controllers use. Requires `Siemens.Engineering.dll` under `PublicAPI\V17` and the current user in the local “Siemens TIA Openness” group. |
| PLCSIM Advanced | Optional; only for the simulation tools. Needs PLCSIM Advanced with API 4.0 (4.0–7.0 runtimes work). |
| Git CLI | Only for the git tools. DSH does not bundle git; run `git --version`, or install Git for Windows. |

Note: Excel and PDF support is pure JavaScript/WASM — no Microsoft Office or Acrobat install. The only desktop software this suite calls is TIA Portal, PLCSIM Advanced and Git.

### Install
Note: Pick the path that matches you. The release zip is the supported path for users; the source starter is for development.

**A · Release zip** — recommended for users. No build, no Node; installs into a private DSH_HOME and creates a versioned profile.

```powershell
$ .\install.cmd
$ .\start.cmd
```

Download `dsh-automation-suite-<version>.zip` from Releases and extract it first. Double-clicking the two `.cmd` files works too; `install.cmd` avoids the PowerShell execution-policy block on downloaded scripts.

**B · From source** — for development. Runs the current worktree; needs Node 22.19+ and the pnpm bundled with DSH; `-Mode pack` tests the real tarballs.

```powershell
$ git clone https://github.com/voltarenyah/dsh-automation-suite
$ cd dsh-automation-suite
$ pwsh -NoProfile -File scripts\start-env.ps1
```

The starter builds the packages, materializes the profile in `%USERPROFILE%\dsh-automation-suite-home`, links the local packages, starts `dsh` and opens the tokenized URL. Use `-Mode pack` to test the release tarballs and `-Restart` to replace a running instance.

**C · One plugin only** — advanced. Every package is its own bundle; install its tarball and add the matching `/tools` row when it has one.

```powershell
$ dsh plugin --profile web add <tarball-url>
```

TIA, PLCSIM, graph and git expose model tools only after a `/tools` row is added; engineering-context also needs TIA and git at runtime. The Architecture page has the surface matrix.

Note: The release zip does not include DeepSeek Harness. Install DSH first; the installer exits with an error if it cannot find `dsh.cmd`.

### First start
Note: From a started instance to a working session.

1. **Open the printed URL**
   The console prints `dsh web: http://127.0.0.1:<port>/?token=…`. The token is required and changes on every start; the bare port returns 401. Do not share the URL.
2. **Add a model API key**
   Settings → Models, or the first-run prompt. The release profile defaults to `dsh-opencode-go` / `deepseek-v4.1-flash`; add that provider's key or pick another model. Credentials stay in this DSH_HOME.
3. **Add a workspace**
   Point at the project folder. The left sidebar is a registry stored in DSH_HOME, not a scan of the disk, so every workspace is added explicitly.
4. **Verify the engineering path**
   TIA: open or create a project and make a read-only call. Graph: `create_engineering_project` should report a built database; “not built” often means .NET 8 is missing — install Microsoft.DotNet.Runtime.8. Git: run `git --version`.
5. **Keep the console open**
   Closing the console window stops the service and the TIA controller. Start it again with `start.cmd`; sessions, workspaces and credentials persist in DSH_HOME.

#### Large projects and long calls
Note: The default `requestTimeoutMs` is 300000 (5 minutes). Exporting a few hundred blocks already takes about 87 s, and compiling a large project can take more than 10 minutes. Raise it before the first large TIA or graph call.

```yaml
- id: tia-openness-v17-min
  config:
    requestTimeoutMs: 900000
- id: engineering-graph
  config:
    requestTimeoutMs: 900000
```

Note: The same value bounds a single-device graph build; a 1,376-file project took about 30 s, but large projects deserve the headroom.

### Installation notes
Note: The things that most often go wrong, and the safe way to undo.

| Topic | What to know |
| --- | --- |
| DSH first | The release installer only finds an existing `dsh.cmd` (or `DSH_EXE`). It does not download DSH. Install DeepSeek Harness first. |
| SmartScreen | Downloaded scripts carry the mark-of-the-web. Use `install.cmd` / `start.cmd`; running `install.ps1` directly may close before you can read the error. The binaries are unsigned, so SmartScreen may warn. |
| Private home | The release profile lives under `%USERPROFILE%\dsh-automation-suite-home`, not `~/.dsh`. The source starter defaults to the same home (override with `-DshHome`); use different homes if you want dev and release fully isolated. |
| Upgrade / rollback | Each release gets a versioned profile, so a new version sits next to the old one. For in-place upgrades use a fixed `-Profile` with `-Force`; the installer backs up `package.json` and `cordis.patch.yml` first. |
| Uninstall | The home is self-contained. Delete it with `cmd /c rmdir /s /q "%USERPROFILE%\dsh-automation-suite-home"`; do not use a recursive delete that follows junctions. |
| External runtimes | Only TIA and PLCSIM need Siemens software. The graph needs .NET 8; git needs `git.exe`; Excel/PDF need no Office or Acrobat, but their npm dependencies are downloaded at install time. |
| Network / proxy | First install needs GitHub and npm. On an isolated network, mirror the registry or pre-stage the tarballs. |
| Ports | DSH Web defaults to 3080; Windows IP Helper often holds it. `start.cmd` picks 3093+ automatically; pass `-Port` to pin one; it opens the default browser, and `-NoOpen` suppresses that. |
| Desktop status | This release runs as a local Web UI in your browser. A WebView2 desktop shell and installer are designed but not shipped; today there is no desktop icon, tray or auto-update. |
| Security | Treat the tokenized URL as a secret; it grants the session. Keep DSH_HOME out of source control — credentials and sessions live there. |

Links: [Releases](https://github.com/voltarenyah/dsh-automation-suite/releases) · [Repository README](https://github.com/voltarenyah/dsh-automation-suite/blob/main/README.md)

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
- Last checked: 2026-11-06

## Page metadata

### Home
- Title: dsh-automation-suite — agent tool for PLC programming
- Description: An unofficial DeepSeek Harness distribution that integrates the Siemens TIA Openness toolkit: TIA Portal V17 block access, an engineering knowledge graph and guard-railed Git.

### Architecture
- Title: Architecture — dsh-automation-suite
- Description: How twelve bundles become one DSH distribution: package boundaries, plugin dependencies, and preset-scoped tools.

### Roadmap
- Title: Roadmap — dsh-automation-suite
- Description: Maturity, environment compatibility and the planned capability of the distribution.

### Get Started
- Title: Get Started — install, start, verify — dsh-automation-suite
- Description: Prerequisites, three installation paths, first-run configuration and the notes that keep a dsh-automation-suite install working.