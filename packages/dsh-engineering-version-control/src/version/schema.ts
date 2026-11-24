/**
 * The version store's schema.
 *
 * Three concerns share one SQLite file (`.dsh/versions.db`):
 *
 * - **graph** — the same four tables `dsh-engineering-graph` uses
 *   (`graph_nodes` / `graph_node_properties` / `graph_edges` /
 *   `graph_edge_properties`), so "version ↔ block ↔ session ↔ problem ↔ doc"
 *   can be walked the same way as the knowledge graph;
 * - **events** — `change_events`, the append-only record of one block change;
 * - **projection** — `block_timeline`, one row per event, ordered per block, so
 *   "show me this block's history" is a single indexed query.
 *
 * `versions` / `baseline_snapshots` are strongly typed mirrors of the graph
 * nodes; `documents` / `doc_spans` / `doc_text` / `doc_fts` index external
 * design documents (P3).
 *
 * Every table is created with `IF NOT EXISTS`, so opening an older database
 * upgrades it in place; `schema_meta.schema_version` is the migration anchor.
 *
 * @module dsh-engineering-context/version/schema
 */

/** The schema version this build writes. */
export const VERSION_SCHEMA_VERSION = 1

/** Statements executed in order when a version store is opened. */
export const VERSION_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS graph_nodes (
     id   TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     name TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS graph_node_properties (
     node_id TEXT NOT NULL,
     name    TEXT NOT NULL,
     value   TEXT,
     PRIMARY KEY (node_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS graph_edges (
     id           TEXT PRIMARY KEY,
     type         TEXT NOT NULL,
     from_node_id TEXT NOT NULL,
     to_node_id   TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS graph_edge_properties (
     edge_id TEXT NOT NULL,
     name    TEXT NOT NULL,
     value   TEXT,
     PRIMARY KEY (edge_id, name)
   )`,

  `CREATE TABLE IF NOT EXISTS versions (
     commit_sha        TEXT PRIMARY KEY,
     parent_sha        TEXT,
     device            TEXT NOT NULL,
     committed_at      TEXT NOT NULL,
     subject           TEXT NOT NULL,
     op                TEXT,
     plc_checksum      TEXT,
     plc_checksum_prev TEXT,
     state_id          TEXT,
     state_id_prev     TEXT,
     session_id        TEXT,
     bundle_dir        TEXT,
     acceptance        TEXT,
     subject_norm      TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS change_events (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id           TEXT NOT NULL UNIQUE,
     commit_sha         TEXT NOT NULL,
     object_key         TEXT NOT NULL,
     change             TEXT NOT NULL CHECK (change IN ('added','modified','removed')),
     faces_json         TEXT,
     fingerprint_before TEXT,
     fingerprint_after  TEXT,
     lines_added        INTEGER,
     lines_removed      INTEGER,
     occurred_at        TEXT NOT NULL,
     reason             TEXT,
     session_id         TEXT,
     problem_ref        TEXT,
     diff_path          TEXT,
     op                 TEXT,
     UNIQUE (commit_sha, object_key)
   )`,

  `CREATE TABLE IF NOT EXISTS block_timeline (
     block_key          TEXT NOT NULL,
     seq                INTEGER NOT NULL,
     event_id           TEXT NOT NULL,
     commit_sha         TEXT NOT NULL,
     occurred_at        TEXT NOT NULL,
     subject            TEXT,
     reason             TEXT,
     problem_ref        TEXT,
     session_id         TEXT,
     faces              TEXT,
     fingerprint_before TEXT,
     fingerprint_after  TEXT,
     diff_path          TEXT,
     lines_added        INTEGER,
     lines_removed      INTEGER,
     PRIMARY KEY (block_key, seq)
   )`,

  `CREATE TABLE IF NOT EXISTS baseline_snapshots (
     object_key       TEXT PRIMARY KEY,
     name             TEXT,
     category         TEXT,
     group_path       TEXT,
     source_path      TEXT,
     state            TEXT,
     fingerprint_json TEXT,
     commit_sha       TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS documents (
     doc_id       TEXT PRIMARY KEY,
     path         TEXT NOT NULL,
     title        TEXT,
     kind         TEXT,
     mime         TEXT,
     bytes        INTEGER,
     content_hash TEXT NOT NULL,
     git_commit   TEXT,
     git_path     TEXT,
     indexed_at   TEXT NOT NULL,
     UNIQUE (path, content_hash)
   )`,
  `CREATE TABLE IF NOT EXISTS doc_spans (
     span_id    TEXT PRIMARY KEY,
     doc_id     TEXT NOT NULL,
     anchor     TEXT,
     heading    TEXT,
     start_line INTEGER,
     end_line   INTEGER,
     text_hash  TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS doc_text (
     doc_id TEXT PRIMARY KEY,
     body   TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS ix_nodes_kind        ON graph_nodes(kind)`,
  `CREATE INDEX IF NOT EXISTS ix_nodes_kind_name   ON graph_nodes(kind, name)`,
  `CREATE INDEX IF NOT EXISTS ix_np_name_value     ON graph_node_properties(name, value)`,
  `CREATE INDEX IF NOT EXISTS ix_edges_type        ON graph_edges(type)`,
  `CREATE INDEX IF NOT EXISTS ix_edges_from        ON graph_edges(from_node_id)`,
  `CREATE INDEX IF NOT EXISTS ix_edges_to          ON graph_edges(to_node_id)`,
  `CREATE INDEX IF NOT EXISTS ix_edges_type_from   ON graph_edges(type, from_node_id)`,
  `CREATE INDEX IF NOT EXISTS ix_edges_type_to     ON graph_edges(type, to_node_id)`,
  `CREATE INDEX IF NOT EXISTS ix_versions_time     ON versions(committed_at)`,
  `CREATE INDEX IF NOT EXISTS ix_versions_cs       ON versions(plc_checksum)`,
  `CREATE INDEX IF NOT EXISTS ix_events_object     ON change_events(object_key, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS ix_events_commit     ON change_events(commit_sha)`,
  `CREATE INDEX IF NOT EXISTS ix_events_problem    ON change_events(problem_ref)`,
  `CREATE INDEX IF NOT EXISTS ix_timeline_commit   ON block_timeline(commit_sha)`,
  `CREATE INDEX IF NOT EXISTS ix_timeline_time     ON block_timeline(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS ix_documents_path    ON documents(path)`,
  `CREATE INDEX IF NOT EXISTS ix_documents_kind    ON documents(kind)`,
  `CREATE INDEX IF NOT EXISTS ix_spans_doc         ON doc_spans(doc_id)`,
]

/** The FTS table is separate: it is optional when SQLite lacks FTS5. */
export const VERSION_FTS_STATEMENT =
  `CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(doc_id UNINDEXED, title, body, tokenize = 'trigram')`
