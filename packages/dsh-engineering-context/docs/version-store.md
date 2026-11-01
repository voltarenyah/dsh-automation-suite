# Version store — what changed, when, and why

The plugin records **engineering history** beside git, not inside it. git is the
file-level version tool; the version store is the queryable engineering layer on
top of it.

```
git commit ──────────► file contents, message, Tia-Checksum trailer
_evidence.json ──────► per-object fingerprints, one ledger per commit
.dsh/versions.db ────► graph + change events + timeline projection (local index)
```

The store is derived: delete it and `project_version_reindex` rebuilds it from
git history. Nothing in it is the only copy of anything.

## The three layers

| Layer | Table(s) | Answers |
|---|---|---|
| Events (the record) | `change_events` | which block changed in which commit, with fingerprints before/after |
| Graph (the relations) | `graph_nodes` / `graph_node_properties` / `graph_edges` / `graph_edge_properties` | version ↔ block ↔ session ↔ problem ↔ document |
| Projection (the read model) | `block_timeline` | one block's history in one ordered query |

`versions` and `baseline_snapshots` are strongly typed mirrors; `documents` /
`doc_spans` / `doc_text` / `doc_fts` index external documents.

## When it is written

- `create_engineering_project` — after the baseline commit: replays the history,
  then indexes `.dsh/docs/` when it exists.
- `project_commit` — after a successful commit: records that commit's changed
  objects, graph nodes/edges and timeline rows in one transaction. A store
  failure is a **warning**; the commit already happened.
- `project_version_reindex` — explicit full replay (after deleting the store,
  after importing an existing workspace, or when suspicious).

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `project_history` | read | `block=` timeline, `commit=` version details, `checksum=` all versions carrying it, `face=`/`since=` search |
| `project_version_reindex` | write | replay git history into the store |
| `project_version_verify` | read | commit/parent/timeline consistency; `deep=true` cross-checks ledgers |
| `project_doc_index` | write | index `.dsh/docs/**` (front matter, spans, full text) |
| `project_doc_search` | read | full-text search (FTS5 trigram; `LIKE` fallback for short terms) |
| `project_version_annotate` | write | add reason / problem / acceptance / references |
| `project_problem` | read | what one problem touched |
| `project_version_query` | read | one SELECT/WITH for questions the tools do not cover |

The expert mounts the read-only subset (`/version-read`); the leader and the
auditor mount the full set (`/version`).

## Documents

A markdown file can declare what it explains:

```markdown
---
kind: design
affects:
  - blocks|01_Cavity_A|100_Cycle_Selection_Cav_A
problems: [cooling-table-blocked]
---
# Cooling-table interlock
```

Indexing stores the content hash (`doc:<sha256>`, identical content is one
node), heading spans with line ranges, the text body for search, and `DOCUMENTS`
edges to the declared objects. The file stays the truth; the store keeps the
index. Only front matter creates links — a wrong edge is worse than a missing
one.

## Rebuild and verify

```text
project_version_reindex          # git log + each commit's _evidence.json
project_version_verify           # structural checks
project_version_verify {deep:true}  # also compares checksums with the ledgers
```

`project_version_reindex` reads every commit's `_evidence.json` (slow on a large
project) but never modifies git. Normal queries never read the ledger.

## Limits

- `node:sqlite` is still marked experimental by Node; the code uses only the
  stable subset (`DatabaseSync`, `exec`, `prepare`, `run/get/all`).
- The store is local (`.dsh/versions.db`, git-ignored). The durable record is
  git + `_evidence.json`; the store exists to make history queries cheap.
- `.dsh/docs/` is **not** git-ignored: design documents kept there can be
  versioned like the source tree.
- TIA does not need to be open: the device is resolved from `source/<device>/`.
