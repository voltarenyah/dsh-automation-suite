# @automation-suite/version-control

DSH plugin: **engineering history**. It records the exported source tree as git
commits whose messages carry an evidence trailer block, keeps a queryable index of
those commits beside git, and answers *which block changed, in which version, and
why*.

This is the suite's **③ management layer** ([`docs/vision.md`](../../docs/vision.md) §3): the
engineering software has no project-level version control, so this plugin builds it
on top of the exported text.

## What it owns, and what it refuses

| Owns | Never does |
|---|---|
| git commits of `source/<device>` + the `Tia-*` trailer block | talk to TIA Portal (that is `engineeringAccess`) |
| `<workspace>/.dsh/versions.db` — the engineering index over those commits | open or save a project |
| the flat projection `<workspace>/.dsh/versions-view.json` for the Versions tab | decide the workspace layout (that is `engineering-context`) |
| the baseline commit of a freshly imported project, through the `versionControl` service | parse XML for meaning (that is `engineering-graph`) |

Its inputs are files other plugins already wrote: `source/<device>/` and
`source/_dsh-engineering-context.json`. Recording history therefore works with
TIA closed — that is the whole point of the split
([`docs/version-control-plan.md`](../../docs/version-control-plan.md), D41).

## Status

**S1: skeleton.** The host row exists and registers nothing: no service, no model
tools. The tools (`project_commit`, `project_diff`, `project_history`, …) and the
`/record` `/read` `/diff` rows arrive in S2/S3 of the split plan.

```powershell
node scripts\link-dsh-runtime.mjs   # once per checkout
node scripts\tsc.mjs -p tsconfig.json --noEmit
node scripts\run-tests.mjs          # builds, then node:test
```
