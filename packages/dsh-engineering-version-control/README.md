# @automation-suite/version-control

DSH plugin: **engineering history**. It records the exported source tree as git
commits whose messages carry an evidence trailer block, keeps a queryable index of
those commits beside git, and answers *which block changed, in which version, and
why*.

This is the suite's **③ management layer** ([`docs/vision.md`](../../docs/vision.md) §3):
the engineering software has no project-level version control, so this plugin
builds it on top of the exported text. The split that created it is
[`docs/decisions.md` D42](../../docs/decisions.md).

## What it owns, and what it refuses

| Owns | Never does |
|---|---|
| git commits of `source/<device>` + the `Tia-Op` / `Tia-Checksum` / `Tia-State` trailers | talk to TIA Portal |
| `<workspace>/.dsh/versions.db` — the engineering index over those commits (events / graph / block timeline) | open or save a project |
| the flat projection `<workspace>/.dsh/versions-view.json` for the Versions tab | decide the workspace layout (that is `engineering-context`) |
| the baseline commit of a freshly imported project, through the `versionControl` service | parse XML for meaning (that is `engineering-graph`) |

Its inputs are files other plugins already wrote: `source/<device>/` and
`source/_dsh-engineering-context.json`. Recording history therefore works with TIA
closed — that is the whole point of the split (D41).

## Rows and tools

The host row registers **no model tool**; a tool there would be inherited by every
agent, including subagents. It provides the `versionControl` service instead.

| Row | Tools | Mounted for |
|---|---|---|
| `.` (host) | — (`planBaseline`, `recordBaseline`) | every agent (service only) |
| `/record` | `project_commit`, `project_version_reindex`, `project_version_annotate`, `project_doc_index` | auditor |
| `/read` | `project_history`, `project_version_verify`, `project_doc_search`, `project_problem`, `project_version_query` | leader, auditor, expert |
| `/diff` | `project_diff` | auditor, expert |

The split is by **permission**, not by capability: `/read` answers questions and
writes nothing, so every agent may have it; recording history is the auditor's job
(D23/D29/D30).

## The service (what `engineering-context` calls)

```ts
planBaseline({ workspace, stateDirName?, sourceDirName? })
  → { state: 'none' | 'reuse', initialize, repoRoot, description }

recordBaseline({ workspace, sourceRoot, device, label, checksum, stateId, stateDirName?, sourceDirName? })
  → { root, initialized, committed, hash, versionNote, warnings }
```

`planBaseline` is a **preflight**: a workspace inside somebody else's repository is
refused while a dry run is still a dry run. `recordBaseline` writes the ownership
marker first (so a half-finished commit stays retryable), then initializes or
reuses the repository, commits `.gitignore`, `.gitattributes` and the source
directory, and replays the commit into the version store.

Both calls resolve `gitContext` themselves and refuse with coded errors:
`git_access_unavailable`, `workspace_is_repository`, `git_failed`.

## Layout coupling (read before moving directories)

This plugin reads the same layout `engineering-context` writes: `stateDirName`
(default `.dsh`) and `sourceDirName` (default `source`). The service takes them
from the caller, so `create_engineering_project` stays consistent; the **tools**
use this package's own config. If a profile moves either directory, configure both
plugins.

## Known debt

`src/git.ts` is the same implementation that `engineering-context` still uses for
its own reads (a copy, chosen on 2026-11-25 for behaviour parity). The intended end
state is one git channel through the `gitContext` service from
`@automation-suite/dsh-tool-git`; that refactor is listed in D42 as debt.

```powershell
node scripts\link-dsh-runtime.mjs   # once per checkout
node scripts\tsc.mjs -p tsconfig.json --noEmit
node scripts\run-tests.mjs          # builds, then node:test
```
