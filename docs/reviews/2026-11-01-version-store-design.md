# 版本库详细设计：图 + 事件表 + 投影（单 SQLite 文件）

> 对应 [2026-11-01-version-store.md](2026-11-01-version-store.md) 的"图存关联、事件表存变更、投影表存时间线"。
> 本文给到 **DDL 级**：四组表、节点/边词汇、事件与 entity 的三种关联、外部文档索引、与 git hash 的连接、
> 写入事务与重建。仍未改代码。
>
> 宿主实测：DSH 自带 node **v24.21.0**，`node:sqlite` 可用；内置 **SQLite 3.53.4**，
> FTS5 `trigram` 对中文可用（实测"冷却台"命中）、WAL 可用。

---

## 1. 数据分层与真值

| 数据 | 表 | 角色 | 可重建 |
|---|---|---|---|
| 提交/版本 | `versions`（图的强类型镜像）+ `graph_nodes(kind=Version)` | 事实 | ✅ 从 git log + `_history.jsonl` |
| 变更事件 | `change_events` | **权威**（append-only） | ✅ 从 `_history.jsonl` |
| 关联 | `graph_nodes` / `graph_edges` / properties | 派生（图） | ✅ 从 events + 文档索引 |
| 时间线 | `block_timeline` | 派生（读模型） | ✅ 从 events join |
| 文档 | `documents` / `doc_spans` / `doc_text` / `doc_fts` | 派生（文档索引器） | ✅ 从文件重新扫描 |
| 基线状态 | `baseline_snapshots` + `_history/baseline.json` | 事实（指纹快照） | ✅ 从 evidence |

**写入顺序永远是 `events → graph → timeline`，同一事务。**
因此任何一张派生表都可以删掉重建，`change_events` 才是版本域的真值（它本身可从 git 历史重放）。

---

## 2. 全量 DDL

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = OFF;          -- 图表用应用级引用，不建 FK

-- ── 0. schema 元信息 ────────────────────────────────────────────────
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- 行：schema_version=1 / engine=node:sqlite / created_at / graph_schema_hash

-- ── 1. 图（与 knowledge graph 同构）────────────────────────────────
CREATE TABLE graph_nodes (
  id   TEXT PRIMARY KEY,             -- version:<sha> / event:<id> / object:<key> / …
  kind TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE graph_node_properties (
  node_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (node_id, name)
);
CREATE TABLE graph_edges (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id   TEXT NOT NULL
);
CREATE TABLE graph_edge_properties (
  edge_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (edge_id, name)
);

CREATE INDEX ix_nodes_kind        ON graph_nodes(kind);
CREATE INDEX ix_nodes_kind_name   ON graph_nodes(kind, name);
CREATE INDEX ix_np_name_value     ON graph_node_properties(name, value);
CREATE INDEX ix_edges_type        ON graph_edges(type);
CREATE INDEX ix_edges_from        ON graph_edges(from_node_id);
CREATE INDEX ix_edges_to          ON graph_edges(to_node_id);
CREATE INDEX ix_edges_type_from   ON graph_edges(type, from_node_id);
CREATE INDEX ix_edges_type_to     ON graph_edges(type, to_node_id);

-- ── 2. 版本（强类型镜像，便于直接 SQL）─────────────────────────────
CREATE TABLE versions (
  commit_sha        TEXT PRIMARY KEY,
  parent_sha        TEXT,
  device            TEXT NOT NULL,
  committed_at      TEXT NOT NULL,
  subject           TEXT NOT NULL,
  op                TEXT,               -- create | sync | manual
  plc_checksum      TEXT,
  plc_checksum_prev TEXT,
  state_id          TEXT,
  state_id_prev     TEXT,
  session_id        TEXT,
  bundle_dir        TEXT,
  acceptance        TEXT,               -- pending | accepted | rejected
  subject_norm      TEXT                -- 去 trailer 的正文（intent 来源）
);
CREATE INDEX ix_versions_time ON versions(committed_at);
CREATE INDEX ix_versions_cs   ON versions(plc_checksum);

-- ── 3. 变更事件（权威，append-only）────────────────────────────────
CREATE TABLE change_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT NOT NULL UNIQUE,   -- evt:<sha256(commit|key)[:16]>
  commit_sha         TEXT NOT NULL,
  object_key         TEXT NOT NULL,
  change             TEXT NOT NULL CHECK (change IN ('added','modified','removed')),
  faces_json         TEXT,                   -- ["Code","Comments"]
  fingerprint_before TEXT,                   -- JSON 或 null（added）
  fingerprint_after  TEXT,                   -- JSON 或 null（removed）
  lines_added        INTEGER,
  lines_removed      INTEGER,
  occurred_at        TEXT NOT NULL,
  reason             TEXT,                   -- Intent 文本快照
  session_id         TEXT,
  problem_ref        TEXT,
  diff_path          TEXT,
  op                 TEXT,
  UNIQUE (commit_sha, object_key)
);
CREATE INDEX ix_events_object ON change_events(object_key, occurred_at);
CREATE INDEX ix_events_commit ON change_events(commit_sha);
CREATE INDEX ix_events_problem ON change_events(problem_ref);

-- ── 4. 时间线投影（读模型）─────────────────────────────────────────
CREATE TABLE block_timeline (
  block_key          TEXT NOT NULL,
  seq                INTEGER NOT NULL,       -- 该块第几次变更，1-based
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
);
CREATE INDEX ix_timeline_commit ON block_timeline(commit_sha);
CREATE INDEX ix_timeline_time   ON block_timeline(occurred_at);

-- ── 5. 基线快照（首次全量）────────────────────────────────────────
CREATE TABLE baseline_snapshots (
  object_key       TEXT PRIMARY KEY,
  name             TEXT,
  category         TEXT,
  group_path       TEXT,
  source_path      TEXT,
  state            TEXT,
  fingerprint_json TEXT,
  commit_sha       TEXT NOT NULL
);

-- ── 6. 外部文档索引 ────────────────────────────────────────────────
CREATE TABLE documents (
  doc_id       TEXT PRIMARY KEY,     -- doc:<sha256(content)>
  path         TEXT NOT NULL,
  title        TEXT,
  kind         TEXT,                 -- design | change | acceptance | issue | meeting
  mime         TEXT,
  bytes        INTEGER,
  content_hash TEXT NOT NULL,
  git_commit   TEXT,                 -- 文档在 git 里时记录
  git_path     TEXT,
  indexed_at   TEXT NOT NULL,
  UNIQUE (path, content_hash)
);
CREATE INDEX ix_documents_path ON documents(path);
CREATE INDEX ix_documents_kind ON documents(kind);

CREATE TABLE doc_spans (
  span_id    TEXT PRIMARY KEY,       -- span:<doc_id>:<anchor>
  doc_id     TEXT NOT NULL,
  anchor     TEXT,                   -- "## 冷却台" / "L120-L180" / jsonpointer
  heading    TEXT,
  start_line INTEGER,
  end_line   INTEGER,
  text_hash  TEXT
);
CREATE INDEX ix_spans_doc ON doc_spans(doc_id);

CREATE TABLE doc_text (
  doc_id TEXT PRIMARY KEY,
  body   TEXT NOT NULL               -- 截断后的纯文本（默认 ≤ 512 KB/篇）
);

CREATE VIRTUAL TABLE doc_fts USING fts5(
  doc_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);
-- trigram 最小 3 字符：中文 3 字以上可 MATCH；2 字词用 documents.title LIKE 或
-- 另建 tokenize='unicode61' 的表（按需）。
```

---

## 3. 图 schema：节点、边、id 规则

### 3.1 节点

| kind | id | 主要 properties | 说明 |
|---|---|---|---|
| `Version` | `version:<full sha>` | commitSha, parentSha, subject, op, committedAt, plcChecksum, stateId | 与 `versions` 表一一对应（图是镜像） |
| `ChangeEvent` | `event:<event_id>` | occurredAt, change, faces, fingerprintBefore, fingerprintAfter | 与 `change_events` 一行一一对应 |
| `Object` | `object:<key>` | key, name, category, group, path | 跨版本复用 |
| `Session` | `session:<id>` | id, preset, startedAt | agent session |
| `Problem` | `problem:<ref>` | ref, title, status | 工程问题 |
| `DiffDoc` | `diff:<commit8>:<keyhash>` | path, hash, bytes | 变更包里的 patch |
| `Intent` | `intent:<commit8>` | text | 为什么改 |
| `Doc` | `doc:<sha256>` | path, title, kind, bytes | 外部设计文档（正文不在图里） |
| `Span` | `span:<doc_id>:<anchor>` | anchor, heading, startLine, endLine | 文档里的锚点 |
| `Reference` | `reference:<kind>:<ref>` | kind, ref | 需求/工单/测试 |
| `Checksum` | `checksum:<value>` | value | 去重；多 Version 指向同一节点 |
| `State` | `state:<sha256>` | value | evidence state |
| `Agent` | `agent:<preset>` | preset | user / leader / auditor / expert |
| `Face` | `face:<Name>` | name | Code/Interface/Comments/Properties/Events |
| `Bundle` | `bundle:<from8>..<to8>` | dir, files | 变更包 |

**id 规则**：

- 可寻址实体（Version/Object/Doc/Problem）用**业务键**做 id，保证幂等 upsert；
- 事件用确定性哈希 `evt:<sha256(commit_sha + "\0" + object_key)[:16]>`，重放不会产生重复；
- 去重类（Checksum/State/Doc）用内容哈希，天然去重。

### 3.2 边

| type | from → to | edge properties | 用途 |
|---|---|---|---|
| `PARENT` | Version → Version | — | 提交链 |
| `PRODUCED` | Version → ChangeEvent | — | 该提交产生的事件 |
| `CHANGED` | ChangeEvent → Object | — | 事件改了哪个块 |
| `IN_SESSION` | Version / ChangeEvent → Session | — | 发生在哪个会话 |
| `RESOLVES` | ChangeEvent / Session → Problem | — | 解决什么问题 |
| `HAS_DIFF` | ChangeEvent → DiffDoc | — | 差异文档 |
| `HAS_INTENT` | Version / ChangeEvent → Intent | — | 意图 |
| `CONTAINS` | Version → Object | fingerprintJson, state, path | 基线全量 |
| `HAS_CHECKSUM` | Version → Checksum | — | 当前 checksum |
| `HAS_STATE` | Version → State | — | 当前 state |
| `TOUCHED` | ChangeEvent → Face | — | 动了哪些 face |
| `DOCUMENTS` | Doc → Object / ChangeEvent / Problem / Version | anchor | 文档索引到实体 |
| `HAS_SPAN` | Doc → Span | — | 文档段落 |
| `MENTIONS` | Span → Object / Problem | — | 段落提到什么 |
| `SUPERSEDES` | Doc → Doc | — | 文档改版 |
| `CITES` | Doc → Reference | — | 引用需求 |
| `AUTHORED_BY` | Doc / Version → Agent | role | 谁写的/谁提交的 |
| `AFFECTS` | Problem → Object | — | 问题影响面 |

约定：**只存一个方向，反向用 `ix_edges_to` 查询**；不建双向边（避免两份真值）。

### 3.3 图与强类型表的关系

- `versions` / `change_events` / `documents` 是**强类型事实表**（列固定、可 SQL 直查、可校验）；
- `graph_nodes/edges` 是它们的**关联投影**（同一事务写，可重建）；
- 查询二选一：要"某块时间线"直接读 `block_timeline`；要"任意多跳"读图；要"事件事实"读 `change_events`。

---

## 4. 事件表怎么跟 entity 关联

三条路径，各司其职：

### 4.1 直接列（覆盖 90% 查询，不依赖图）

`change_events` 自带 `object_key` / `commit_sha` / `session_id` / `problem_ref` / `diff_path`。
查"某块的所有事件"：

```sql
SELECT commit_sha, occurred_at, faces_json, fingerprint_before, fingerprint_after, reason
FROM change_events WHERE object_key = ? ORDER BY occurred_at;
```

### 4.2 图边（探索与多跳）

写入时同时建 `event:<id>` 节点与边：

```text
Version --PRODUCED--> ChangeEvent --CHANGED--> Object
                                  --IN_SESSION--> Session
                                  --RESOLVES--> Problem
                                  --HAS_DIFF--> DiffDoc
                                  --TOUCHED--> Face
```

查"一个问题经过哪些会话、改了哪些块"：

```sql
SELECT p.name AS problem, s.name AS session, o.name AS object
FROM graph_nodes p
JOIN graph_edges e1 ON e1.from_node_id = p.id AND e1.type = 'RESOLVES'
JOIN graph_nodes s ON s.id = e1.from_node_id AND s.kind IN ('ChangeEvent','Session')
JOIN graph_edges e2 ON e2.from_node_id = s.id AND e2.type = 'CHANGED'
JOIN graph_nodes o ON o.id = e2.to_node_id AND o.kind = 'Object'
WHERE p.kind = 'Problem' AND p.name = ?;
```

### 4.3 投影冗余（单表时间线）

`block_timeline` 把 reason / problem_ref / session_id / diff_path 冗余进去，查询不用 join。
冗余字段在事件写入同一事务里生成；`project_version_annotate` 后补时同步更新投影。

### 4.4 一致性保证

- 三条路径在**同一事务**写：`change_events` → `graph` → `block_timeline`；
- 重建顺序：`_history.jsonl` → `change_events` → `graph` → `block_timeline`；
- `project_version_verify` 校验：每个 event 都有 `ChangeEvent` 节点 + `PRODUCED`/`CHANGED` 边；
  timeline 行数 = events 行数；seq 连续；commit 存在于 git。

**不建 `event_links` 表**：图边已经表达关联，再建链接表就是第三份真值。

---

## 5. 外部设计文档如何索引到 db

### 5.1 入库

文档目录（默认 `.dsh/docs/`，可配）扫描：

1. 读文件 → `sha256` → `doc_id = doc:<hash>`（同内容只存一次）；
2. 写 `documents`（path/title/kind/bytes/git_commit/git_path）；
3. 提取 markdown 标题与行号 → `doc_spans`；
4. 纯文本截断（≤ 512 KB）→ `doc_text` + `doc_fts`；
5. 建图节点 `Doc`/`Span`，以及 `HAS_SPAN` 边。

### 5.2 关联到实体（四种，按强度递减）

1. **显式 front-matter**（最强）：

   ```yaml
   ---
   kind: design
   affects:
     - blocks|01_Cavity_A|100_Cycle_Selection_Cav_A
   problems: [cooling-table-blocked]
   ---
   ```

   解析后建 `DOCUMENTS`（Doc→Object/Problem）。

2. **正文显式标记**：`<!-- affects: blocks|01_Cavity_A|100_Cycle -->` 或 `## 100_Cycle_Selection_Cav_A` 标题；
   建 `MENTIONS`（Span→Object）。

3. **名字/路径命中**：扫描正文中的块名或 `blocks/...xml` 路径，命中则建 `MENTIONS`（confidence 属性）。

4. **FTS 检索 + agent 确认**：`project_doc_search("冷却台")` 返回候选，由 agent/用户确认后
   `project_version_annotate` 建边（不自动，避免误关联）。

### 5.3 反查

"这个块有哪些相关文档"：

```sql
SELECT d.name AS doc, np.value AS path, ep.value AS anchor
FROM graph_nodes o
JOIN graph_edges e ON e.to_node_id = o.id AND e.type = 'DOCUMENTS'
JOIN graph_nodes d ON d.id = e.from_node_id AND d.kind = 'Doc'
LEFT JOIN graph_node_properties np ON np.node_id = d.id AND np.name = 'path'
LEFT JOIN graph_edge_properties ep ON ep.edge_id = e.id AND ep.name = 'anchor'
WHERE o.kind = 'Object' AND o.name = ?;
```

### 5.4 文档版本化

- `doc_id` 用内容哈希 → 同一文件改版产生新 Doc 节点；
- 同路径的新旧版本用 `SUPERSEDES` 连接；
- `documents.path` 不是唯一键（`UNIQUE(path, content_hash)`），保留历史版本；
- 文档若在 git 里，`git_commit` + `git_path` 可定位到历史版本，db 不存正文。

---

## 6. 跟 git hash 怎么连

### 6.1 锚点

| db 字段 | git 对应 | 取法 |
|---|---|---|
| `versions.commit_sha` | 提交对象 | `git rev-parse HEAD` |
| `versions.parent_sha` | 父提交 | `git rev-parse HEAD^` 或 commit 头 |
| `Object.path` | 仓库内文件 | 相对路径（`source/Sino_PEI/...`） |
| `DiffDoc.path` | 变更包 patch | `.dsh/changes/<from>..<to>/diff.patch` |
| `documents.git_commit` | 文档所属提交 | 若文档进 git |

### 6.2 取内容（db 不存文件，只存指针）

```text
任意版本的文件内容   git cat-file -p <commit_sha>:<path>
该版本的全部指纹     git show <commit_sha>:source/<device>/_evidence.json
两个版本的差异       git diff <parent_sha> <commit_sha> -- <path>
```

`Object` + `Version` 两个 id 就能定位到"某块在某版本的内容"；
fingerprint 只是该内容的摘要，不替代内容。

### 6.3 校验（`project_version_verify`）

1. `versions.commit_sha` 在 git 中存在（`git cat-file -e`）；
2. `parent_sha` 与 git 的父提交一致；
3. `change_events` 的 `(commit_sha, object_key)` 唯一，且 commit 在 versions 里；
4. `block_timeline` 每块 seq 连续、行数 = 该块 events 数；
5. 抽查 `fingerprint_after` 与 `git show <sha>:…/_evidence.json` 一致（可 `--deep`）；
6. 文档 `content_hash` 与文件当前内容一致（可 `--docs`）。

### 6.4 重建

```text
project_version_reindex      → 从 _history.jsonl 重放 events → 重建 graph + timeline
project_doc_reindex          → 扫描 .dsh/docs → 重建 documents/spans/text/fts + 图节点边
project_version_verify       → 只读校验上述一致性
```

`_history.jsonl` 每行：

```jsonc
{
  "commit": "a5f84d5d…",
  "parent": "17f21d4a…",
  "checksum": "71 2D DC D7 F9 DF 81 90",
  "stateId": "sha256:b3e2…",
  "session": "session-132825e0…",
  "events": [
    { "object": "blocks|01_Cavity_A|100_Cycle_Selection_Cav_A",
      "change": "modified",
      "faces": ["Code","Interface","Comments"],
      "before": "…", "after": "…",
      "linesAdded": 461, "linesRemoved": 243,
      "reason": "gate full-cycle request on cooling-table occupancy",
      "problem": "cooling-table-blocked",
      "diff": ".dsh/changes/17f21d4a..worktree/diff.patch" }
  ]
}
```

---

## 7. 写入事务（伪代码）

```text
on project_commit success:
  BEGIN IMMEDIATE
  upsert versions(row)
  upsert graph node version:<sha> + props
  for each changed object:
     event_id = evt(sha, key)
     INSERT change_events(...)                       -- 权威
     upsert graph node event:<event_id> + props
     INSERT edges PRODUCED / CHANGED / TOUCHED
     IF session  INSERT IN_SESSION
     IF problem  INSERT RESOLVES
     IF diff     INSERT HAS_DIFF
     seq = COALESCE(MAX(seq),0)+1 WHERE block_key
     INSERT block_timeline(block_key, seq, ...)      -- 投影
  INSERT HAS_CHECKSUM / HAS_STATE / HAS_INTENT / IN_SESSION
  INSERT PARENT (if parent version exists)
  link_docs_for_objects(changed keys)                -- 可选：自动关联
  COMMIT
on failure:
  ROLLBACK; return warning (提交已完成)
```

---

## 8. 查询示例

```sql
-- A. 块时间线（核心需求）
SELECT seq, occurred_at, commit_sha, reason, problem_ref, session_id,
       fingerprint_before, fingerprint_after, lines_added, lines_removed
FROM block_timeline WHERE block_key = ? ORDER BY seq;

-- B. 某提交的全部变更
SELECT block_key, faces, fingerprint_before, fingerprint_after, reason
FROM block_timeline WHERE commit_sha = ? ORDER BY block_key;

-- C. 某 checksum 的所有版本（重复 checksum 返回多行）
SELECT v.name AS commit_sha, p.value AS committed_at
FROM graph_nodes c
JOIN graph_edges e ON e.to_node_id = c.id AND e.type = 'HAS_CHECKSUM'
JOIN graph_nodes v ON v.id = e.from_node_id
LEFT JOIN graph_node_properties p ON p.node_id = v.id AND p.name = 'committedAt'
WHERE c.kind = 'Checksum' AND c.name = ?;

-- D. 块 + 相关文档 + 问题（多跳）
SELECT t.seq, t.commit_sha, t.reason, d.name AS doc, p.name AS problem
FROM block_timeline t
LEFT JOIN graph_nodes o ON o.kind = 'Object' AND o.name = t.block_key
LEFT JOIN graph_edges e1 ON e1.to_node_id = o.id AND e1.type = 'DOCUMENTS'
LEFT JOIN graph_nodes d ON d.id = e1.from_node_id AND d.kind = 'Doc'
LEFT JOIN graph_edges e2 ON e2.from_node_id = o.id AND e2.type = 'AFFECTS'
LEFT JOIN graph_nodes p ON p.id = e2.from_node_id AND p.kind = 'Problem'
WHERE t.block_key = ? ORDER BY t.seq;

-- E. 文档全文检索（trigram，≥3 字符）
SELECT f.doc_id, d.path, snippet(doc_fts, 2, '[', ']', '…', 12) AS hit
FROM doc_fts f JOIN documents d ON d.doc_id = f.doc_id
WHERE doc_fts MATCH ? LIMIT 20;
```

---

## 9. 容量与索引

- `change_events`：每次提交 N 个变更块；1000 次提交 × 20 块 = 2 万行，< 10 MB；
- `block_timeline`：与 events 同量级（一行一事件）；
- 图：基线 1377 Object + 1377 CONTAINS 边；每事件约 5 条边 + 1 节点；
- 文档：元数据小；FTS 正文按 512 KB/篇截断；
- 关键索引已在 §2：`ix_events_object`、`ix_timeline_block`、`ix_edges_type_to`、`ix_np_name_value`。

---

## 10. 验收

| # | 断言 |
|---|---|
| 1 | 提交后 `change_events` 行数 = 变更块数；`event_id` 可重算（幂等） |
| 2 | 每个 event 有对应 `ChangeEvent` 节点，且 `PRODUCED`/`CHANGED` 边齐全 |
| 3 | `block_timeline` 的 seq 连续；行数 = 该块 events 数 |
| 4 | `versions` 与 `git log` 的 sha/parent 一致（`project_version_verify`） |
| 5 | 同一 checksum 两次提交指向同一 `checksum:` 节点，查询返回两行 |
| 6 | 文档入库后 `documents`/`doc_spans`/`doc_fts` 有行；FTS 能命中中文 3 字词 |
| 7 | `DOCUMENTS` 边可反查"块 → 相关文档"；front-matter 声明的块精确命中 |
| 8 | 删库后 `project_version_reindex` + `project_doc_reindex` 完整恢复（不读 evidence） |
| 9 | `project_version_verify --deep` 抽查 fingerprint 与 evidence 一致 |
