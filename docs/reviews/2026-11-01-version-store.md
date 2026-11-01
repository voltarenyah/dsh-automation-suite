# 版本脚手架：git 做文件版本，事件图 + 时间线投影做工程版本

> **详细设计（DDL 级）**见 [2026-11-01-version-store-design.md](2026-11-01-version-store-design.md)：
> 图 schema、事件表与 entity 的关联、外部文档索引、与 git hash 的连接、写入事务与重建。

> 2026-11-01 决定：**不把 git 当作版本管理的主工具**，而是在 dsh-automation-suite 层另起一套版本脚手架。
> git 只负责文件级版本；工程信息记在 workspace 级 SQLite 里。
>
> 本文在"纯图"方案上做了再评估（§4）：**纯图不是最优**。推荐 **事件溯源 + 图关联 + 时间线投影**
> 的混合形态——变更（`ChangeEvent`）是一等节点，图负责多源关联，投影表负责"选中一个块看完整时间线"。
> 只做设计，未改代码。前序设计见 [变更包与提交契约](2026-10-27-change-bundle-design.md)。

---

## 1. 需求与查询

### 1.1 要管理的东西

| 东西 | 例子 | 形态 |
|---|---|---|
| 源文件 | `blocks/01_Cavity_A/100_Cycle_Selection_Cav_A.xml` | 文件（git 历史里有多个版本） |
| 提交 | `a5f84d5d` | git 对象 |
| 差异 | `+461/−243`、变更块清单 | 文档 / `project_diff` 结果 |
| evidence | 每块 4~5 个 face fingerprint | JSON（每提交一份） |
| agent session | "为什么改这个块"的对话记录 | 会话日志 |
| 工程问题 | "冷却台被占用时不应发起整周期" | 问题记录（可关联 session） |
| 变更文档 | 设计说明、验收记录 | 文档 |

### 1.2 目标查询（用户原话的直译）

> 选中一个源文件 → 它从第 1 版到最后一版改过多少次、每次因为什么问题、提交 hash 是多少、
> 每次 fingerprint 怎么变。

这是一条**以块为中心的时间线**：`block → [(seq, reason, commit, fingerprint_before, fingerprint_after, diff)]`。
不是任意图遍历。

---

## 2. 方案再评估：纯图为什么不是最优

| 方案 | 块时间线查询 | 多源关联（问题/会话/文档） | 加新关系 | 部署成本 | 结论 |
|---|---|---|---|---|---|
| 纯关系事件表 | ✅ 一条 SQL | ⚠️ 每加一种关联要加表/列 | ❌ 迁移 | 低 | 可用，关联弱 |
| 纯图（变更=边属性） | ❌ 事件不是节点，无法被问题/会话/文档再指向；时间线要靠边属性拼 | ✅ | ✅ | 中 | **不够** |
| 图 + 事件节点 | ✅ 事件节点自带 before/after/时间 | ✅ | ✅ | 中 | 好 |
| **图 + 事件节点 + 投影** | ✅✅ 直接查投影表 | ✅ | ✅ | 中 | **推荐** |
| 外部图库（Neo4j/Kuzu） | ✅ | ✅ | ✅ | ❌ 要打包/起服务 | 数据量小，不划算 |
| 时序库（Influx 等） | ⚠️ 只有数值序列 | ❌ | ❌ | 高 | 不适用 |
| 文档库（Mongo） | ⚠️ | ⚠️ | ⚠️ | 中 | 不必要 |

**核心判断**：

1. "变更"必须是一等实体（事件节点），不能是边属性。因为一次变更要同时被 **commit、session、
   problem、diff 文档** 指向，还要挂 **before + after 两个 fingerprint**——边只能挂属性，
   不能被其它边指向（SQLite 图表的边不是节点）。
2. 用户的核心查询是**线性时间线**，图的多跳 join 在这里是绕路；给它一张**投影表**
   （写模型 → 读模型，CQRS 风格），查询就是一条 `ORDER BY seq`。
3. 图仍然保留，因为"问题 ↔ session ↔ 块 ↔ 文档"是网状关系，正是图擅长的。

这就是比"纯图"更好的设计：**事件溯源（append-only 事件）+ 图（关联）+ 投影（查询）**，
在同一个 SQLite 文件里实现，不引入外部服务。

---

## 3. 三层定位

| 层 | 存什么 | 权威性 | 是否进 git |
|---|---|---|---|
| **git 提交** | 文件内容、message、`Tia-Checksum` trailer | 文件真值 | ✅ 本体 |
| **`_evidence.json`** | 每提交每对象的 face fingerprint | 指纹真值 | ✅ 已在 |
| **版本库 `.dsh/versions.db`** | 事件图（`ChangeEvent`/`Version`/`Object`/`Session`/`Problem`/`DiffDoc`…）+ 投影表 | 派生 + 背景 | ❌ 本地（可重建） |

`fingerprint` 已在 git 里；版本库的价值是**关联 + 时间线查询**，不是重复存指纹。

---

## 4. 推荐模型：事件图 + 投影

### 4.1 存储（与 knowledge graph 同构的四表）

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE graph_nodes (
  id   TEXT PRIMARY KEY,      -- version:<sha> / event:<id> / object:<key> / session:<id> / …
  kind TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE graph_node_properties (node_id TEXT, name TEXT, value TEXT, PRIMARY KEY (node_id, name));
CREATE TABLE graph_edges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL
);
CREATE TABLE graph_edge_properties (edge_id TEXT, name TEXT, value TEXT, PRIMARY KEY (edge_id, name));
```

### 4.2 节点词汇

| kind | id 形式 | 关键属性 | 说明 |
|---|---|---|---|
| `Version` | `version:<sha>` | commitSha, parentSha, subject, op, committedAt, plcChecksum, stateId, acceptance | 一次提交 |
| `ChangeEvent` | `event:<sha>:<object_key>` | occurredAt, faces, fingerprintBefore, fingerprintAfter, linesAdded, linesRemoved | **一次块变更（一等事件）** |
| `Object` | `object:<key>` | key, name, category, group, path | 源文件/块身份，跨版本复用 |
| `Session` | `session:<id>` | id, preset, startedAt, endedAt | agent session |
| `Problem` | `problem:<ref>` | ref, title, status | 工程问题 |
| `DiffDoc` | `diff:<sha>:<object_key>` | path, hash, bytes | 差异文档（变更包里的 patch） |
| `Intent` | `intent:<sha>` | text | 为什么改（message 正文/后补） |
| `Reference` | `reference:<kind>:<ref>` | kind, ref, note | 需求/工单/测试 |
| `Checksum` | `checksum:<value>` | value | 去重；多 Version 指向同一节点 → 重复 checksum |
| `State` | `state:<sha256>` | value | evidence stateId |
| `Bundle` | `bundle:<from>..<to>` | dir, manifest | 变更包 |
| `Face` | `face:<Name>` | name | Code / Interface / Comments / Properties / Events |

### 4.3 边词汇（PROV 风格：Entity / Activity / Agent）

| type | from → to | 含义 |
|---|---|---|
| `PARENT` | Version → Version | 提交链 |
| `PRODUCED` | Version → ChangeEvent | 这次提交产生了哪些变更事件 |
| `CHANGED` | ChangeEvent → Object | 哪个块被改 |
| `IN_SESSION` | Version / ChangeEvent → Session | 在哪个会话里发生 |
| `RESOLVES` | ChangeEvent / Session → Problem | 为了解决什么问题 |
| `HAS_DIFF` | ChangeEvent → DiffDoc | 差异文档 |
| `HAS_INTENT` | Version / ChangeEvent → Intent | 意图 |
| `REFERENCES` | Version / Intent → Reference | 需求/工单 |
| `CONTAINS` | Version → Object | **基线全量**（边属性 fingerprintJson / state / path） |
| `HAS_CHECKSUM` | Version → Checksum | 当前 checksum |
| `HAS_STATE` | Version → State | 当前 evidence state |
| `TOUCHED` | ChangeEvent → Face | 便于"哪些版本动过 Comments" |
| `AFFECTS` | Problem → Object | 问题影响哪些块（反向可查） |

一个 `ChangeEvent` 表示"一次提交里一个块的一次变更"：1 个 before、1 个 after、1 个 diff、
至多 1 个 session、可挂多个 problem。

### 4.4 时间线投影（读模型）

```sql
CREATE TABLE block_timeline (
  block_key          TEXT NOT NULL,
  seq                INTEGER NOT NULL,        -- 该块的第几次变更（1-based）
  event_id           TEXT NOT NULL,
  commit_sha         TEXT NOT NULL,
  occurred_at        TEXT NOT NULL,
  subject            TEXT,
  reason             TEXT,                    -- Intent 文本（为什么改）
  problem_ref        TEXT,                    -- 关联问题（可空，多问题时用 ; 连接）
  session_id         TEXT,
  faces              TEXT,                    -- JSON 数组
  fingerprint_before TEXT,
  fingerprint_after  TEXT,
  diff_path          TEXT,
  lines_added        INTEGER,
  lines_removed      INTEGER,
  PRIMARY KEY (block_key, seq)
);
CREATE INDEX ix_timeline_block ON block_timeline(block_key, seq);
CREATE INDEX ix_timeline_commit ON block_timeline(commit_sha);
```

投影在 `project_commit` 后增量追加一行，`project_version_reindex` 时全量重建；它是纯派生的，
可以随时删掉重算。

### 4.5 核心查询（一条 SQL 满足用户需求）

```sql
SELECT seq, occurred_at, commit_sha, reason, problem_ref, session_id,
       fingerprint_before, fingerprint_after, lines_added, lines_removed
FROM block_timeline
WHERE block_key = 'blocks|01_Cavity_A|100_Cycle_Selection_Cav_A'
ORDER BY seq;
```

输出 = "第 1 版到最后一版，改过几次、每次因为什么、commit 是多少、fingerprint 怎么变"。

反向查（这个提交改了哪些块、为什么）：

```sql
SELECT t.block_key, t.faces, t.fingerprint_before, t.fingerprint_after, t.reason
FROM block_timeline t
WHERE t.commit_sha = 'a5f84d5d…'
ORDER BY t.block_key;
```

问题视角（一个问题影响了哪些块、经过哪些会话）：

```sql
SELECT p.name AS problem, s.name AS session, o.name AS object
FROM graph_nodes p
JOIN graph_edges es ON es.from_node_id = p.id AND es.type = 'RESOLVES'
JOIN graph_nodes s ON s.id = es.from_node_id AND s.kind IN ('Session', 'ChangeEvent')
JOIN graph_edges eo ON eo.from_node_id = s.id AND eo.type IN ('CHANGED', 'AFFECTS')
JOIN graph_nodes o ON o.id = eo.to_node_id AND o.kind = 'Object'
WHERE p.kind = 'Problem' AND p.name = 'cooling-table-blocked';
```

---

## 5. 写入与重建

### 5.1 写入（`project_commit` 成功后）

**基线**：

1. 读 `_evidence.json` 全量；
2. upsert `Object` 节点（1377 个）；
3. 写 `version:<sha>` + `CONTAINS` 边（属性 fingerprintJson/state/path）；
4. 写 `HAS_CHECKSUM` / `HAS_STATE` 边；
5. 写 `_history/baseline.json`（进 git，一次）。
6. 投影：基线不产生时间线行（时间线从第一次**变更**开始）。

**后续提交**：

1. `project_diff(parent→HEAD)` 拿变更块（before/after/faces/lines）；
2. 每个块写一个 `ChangeEvent` 节点：
   - `PRODUCED`（Version→Event）、`CHANGED`（Event→Object）、`TOUCHED`（Event→Face）；
   - 若有 diff 文件：`HAS_DIFF`（Event→DiffDoc）；
   - 若有 session：`IN_SESSION`（Event→Session）；
   - 若有问题：`RESOLVES`（Event→Problem）；
   - `HAS_INTENT`（Version→Intent，文本取 message 正文）；
3. 追加投影行（`block_timeline`，seq = 该块上次 seq + 1）；
4. 追加 `_history.jsonl`（事件 + 背景）；
5. `_history.jsonl` 随提交进 git。

### 5.2 当前状态查询（沿事件链回溯，不回读 evidence）

```text
fingerprintAt(block, commit):
  events = block_timeline WHERE block_key=block AND commit_sha 在 commit 的祖先链上
  if events: return 最后一条 fingerprint_after
  return CONTAINS(基线 version -> block).fingerprintJson
```

投影表让这一步退化成一条索引查询；不需要图多跳。

### 5.3 重建

```text
project_version_reindex({ device?, from?, to? })
  → 读 _history/baseline.json → Object + CONTAINS 边
  → 重放 _history.jsonl → Version/ChangeEvent/边 + 投影行
  → 保留不可重建节点（Intent/Problem/Reference/Session/acceptance）
  → 不读 evidence（兜底才遍历 git log）
```

---

## 6. 查询接口

| 工具 | 实现 | 用途 |
|---|---|---|
| `project_block_history({ block })` | 查投影表 | **核心**：块从第 1 版到现在的时间线 |
| `project_history({ checksum?, face?, since?, problem? })` | 图查询 | 按 checksum/face/问题找版本 |
| `project_version({ commit })` | 图查询 | 一个提交的全部事件与背景 |
| `project_problem({ ref })` | 图查询 | 一个问题影响哪些块/会话 |
| `project_version_query({ sql })` | 只读 SQL | 临时多跳（与 `knowledge_query` 同款） |
| `project_version_annotate({ commit, reason?, problem?, acceptance? })` | 写 | 后补背景 |
| `project_version_reindex()` | 重建 | 从 history 文件恢复 |

---

## 7. 与现有组件的关系

- `project_diff`：计算"这一对修订之间改了什么"；版本库把结果固化成 `ChangeEvent` + 投影行。
- 变更包 `.dsh/changes/`：每版本一个；`DiffDoc` 节点指向其中的 `diff.patch`。
- knowledge graph：当前代码的语义快照；与版本库同构但独立文件，可用 `commit_sha` + `path` 交叉引用。
- trailer：`Tia-Checksum` 仍写，git 层轻量索引。

---

## 8. 风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| 投影与图不一致 | 两处写 | 投影是派生表，reindex 全量重建；写入放同一事务 |
| `node:sqlite` experimental | 每次加载打 `ExperimentalWarning` | 只用稳定子集；宿主升级冒烟测试 |
| 事件粒度 | 一次提交一块一个事件，块多的提交事件多 | 事件数 ≈ 变更块总数，量级小 |
| 多源关联为空 | session/problem 没填 | 事件仍可用（reason 来自 message），后补 annotate |
| 外部图库诱惑 | Neo4j/Kuzu 功能多 | 数据量万级，SQLite + 索引足够；不引入服务 |

---

## 9. 验收

| # | 断言 |
|---|---|
| 1 | 提交后新增 `version:<sha>` 与对应 `ChangeEvent` 节点 |
| 2 | 本次 1 个 modified 块：1 个 `ChangeEvent`，`faces=["Code","Interface","Comments"]`，before/after 与 evidence 一致 |
| 3 | 基线只有 `CONTAINS` 边（1377 条）；后续提交不增加 CONTAINS |
| 4 | `block_timeline` 中该块 seq 连续（1,2,…），每行 commit/fingerprint 与提交一致 |
| 5 | 同一 checksum 的两次提交指向同一个 `checksum:` 节点，`project_history(checksum)` 返回两条 |
| 6 | 删库后 `project_version_reindex` 从 `baseline.json` + `_history.jsonl` 完整恢复图与投影（不读 evidence） |
| 7 | `project_block_history` 返回 3 个版本点，checksum 依次 C0 → 71 → 86 |
| 8 | 重建期间 git 历史不被修改 |

---

## 10. 已定（2026-11-01）

- 形态：**事件图 + 时间线投影**（SQLite 单文件），不是纯图、不是纯关系表；
- 变更是一等节点 `ChangeEvent`（PROV 风格 Activity），不是边属性；
- 权威：基线 `_history/baseline.json` + 追加 `_history.jsonl`（进 git），库可重建；
- 粒度：基线全量（`CONTAINS`），后续只存变更（`ChangeEvent`），日常查询不读 evidence；
- 写入钩子：`project_commit` 成功后自动写（失败只 warning，reindex 可补）；
- 背景：`Intent` 自动从 message 提取，`Session` 自动；`Problem` / `Reference` / `acceptance`
  用 `project_version_annotate` 后补；
- 实现：TS 直连 `node:sqlite`（宿主 v24.21.0 实测可用，无需 flag，不引 better-sqlite3）。
