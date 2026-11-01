# 版本库实施计划：分阶段、验收标准、回滚

> 对应设计：[详细设计（DDL）](2026-11-01-version-store-design.md)、[方案概览](2026-11-01-version-store.md)。
> 固定回放样例：`SWT2_PEI_1026_Night` 的 3 个提交（`17f21d4` 基线 / `a5f84d5` 逻辑 / `e331d6e` 注释）。
> 本文只排计划，未改代码。

---

## 0. 阶段总览

| 阶段 | 目标 | 依赖 | 估时 | 可演示的结果 |
|---|---|---|---|---|
| **P0 地基** | 建库 + 提交后自动写流水账 | — | 2 d | 提交后 `.dsh/versions.db` 有 3 版本、2 条变更、指纹链 |
| **P1 查询** | 选中块看时间线（核心需求） | P0 | 1 d | `project_block_history` 一条命令出完整历史 |
| **P2 重建/校验** | 删库可恢复、数据可对账 | P0 | 1 d | 删 db → reindex → 数据一致 |
| **P3 文档索引** | 设计文档挂到块上 | P0 | 1.5 d | 块 → 相关文档；中文全文搜索 |
| **P4 背景补录** | 问题/验收/关联补写 | P1 | 1 d | 按问题查影响面；annotate 后时间线更新 |
| **P5 工作流接入** | 工具挂到 preset、政策落地 | P1 | 0.5 d | auditor 提交后自动确认库已写 |

**最小可用（MVP）= P0 + P1**：能自动记录、能用一条命令看块的历史。
**完整闭环 = P0–P3**；P4/P5 是增强。

总量约 7 人日（单人），可按阶段交付、每阶段独立可用。

---

## 1. P0：地基与写入

### 交付

1. `src/version-store.ts`：`node:sqlite` 封装（建库、schema_meta、四图表 + 强类型表 + 索引、事务）。
2. `project_commit` 成功后写入：`versions`、`change_events`、图（Version/ChangeEvent/Object 节点 + 边）、`block_timeline`。
3. `create_engineering_project` 基线：`baseline_snapshots` + `_history/baseline.json`。
4. `_history.jsonl` 追加（随提交进 git）。
5. 失败只 warning（提交已完成），不阻塞。

### 验收（用 3 个历史提交回放）

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 建库 | `.dsh/versions.db` 存在，`schema_meta.schema_version = 1`，表齐全 |
| 2 | 版本数 | `versions` = 3（17f21d4 / a5f84d5 / e331d6e） |
| 3 | 变更数 | `change_events` = 2（a5f84d5 一块、e331d6e 一块；基线不计变更） |
| 4 | 基线 | `baseline_snapshots` = 1377 行 |
| 5 | 图完整 | 每个 event 有 `ChangeEvent` 节点 + `PRODUCED`/`CHANGED` 边 |
| 6 | 时间线 | `block_timeline` 2 行，同一块 seq = 1、2 |
| 7 | 指纹链 | a5f84d5 的 after 与 e331d6e 的 before 相等（同一块连续） |
| 8 | checksum 去重 | `checksum:` 节点 3 个（C0 / 71 / 86），`HAS_CHECKSUM` 边 3 条 |
| 9 | 不破坏提交 | `git log` 与 trailer 与改动前一致 |
| 10 | 失败隔离 | 把 `.dsh` 设为只读 → 提交成功 + 返回 warning |

### 不做

- 不做查询工具（P1）；
- 不做文档索引（P3）；
- 不动现有 `project_diff` / `project_commit` 的对外语义（只追加副作用）。

---

## 2. P1：查询（核心需求）

### 交付

1. `project_block_history(block)`：查速查表，返回时间线。
2. `project_version(commit)`：一次提交的全部块 + 背景。
3. `project_history({ checksum?, face?, since?, limit? })`：按条件找版本。
4. `project_versions_by_checksum(checksum)`：同一 checksum 的多个版本。

挂在 leader / auditor / expert 的工具面（只读）。

### 验收

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 块时间线 | `project_block_history("100_Cycle_Selection_Cav_A")` 返回 2 条变更 + 基线，指纹 C0→71→86 顺序正确 |
| 2 | 提交详情 | `project_version("a5f84d5")` 返回 1 个块、intent、session、checksum 迁移 |
| 3 | checksum 查询 | 查 `71 2D DC …` 返回 1 条；造一条重复 checksum 测试数据返回 2 条 |
| 4 | 输出上限 | 任何查询 ≤ 40 行，超出报"还有 N 条" |
| 5 | 不读 evidence | 查询日志/计数器证明未打开 `_evidence.json` |
| 6 | 坏入参 | 不存在的块/提交返回明确空结果，不抛异常 |

### 可演示脚本

```text
> project_block_history("100_Cycle_Selection_Cav_A")
第 1 次  a5f84d5  2026-10-26  feat(cav-a): gate full-cycle request…
         Code 3f1a…→8c02…  Interface 91be…→3d77…  Comments 22e0…→55aa…
第 2 次  e331d6e  2026-10-26  docs(cav-a): label cooling-table interlock…
         Comments 71ab…→86cd…（+4/-0）
```

---

## 3. P2：重建与校验

### 交付

1. `project_version_reindex`：从 `baseline.json` + `_history.jsonl` 重建图与时间线（不读 evidence）。
2. `project_version_verify`：commit 存在、parent 匹配、seq 连续、事件与图一致；`--deep` 抽查指纹。
3. 删库恢复演练脚本（测试用）。

### 验收

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 删库恢复 | 备份 → 删 `versions.db` → reindex → 行数与内容哈希与删除前一致 |
| 2 | 不读 evidence | 恢复过程日志无 `_evidence.json` 读取 |
| 3 | 校验通过 | `project_version_verify` 返回 ok |
| 4 | 坏数据检出 | 手工改坏一条 seq → verify 报 `timeline_seq_gap` |
| 5 | git 只读 | 恢复/校验前后 `git status` 不变 |

---

## 4. P3：外部文档索引

### 交付

1. `project_doc_index`：扫描 `.dsh/docs/`（可配）→ `documents` / `doc_spans` / `doc_text` / `doc_fts` + 图节点边。
2. front-matter `affects:` 解析 → `DOCUMENTS` 边。
3. `project_doc_search(text)`：FTS5 trigram 全文搜索。
4. 块 → 相关文档反查（并入 `project_block_history` 的可选列）。

### 验收

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 入库 | 放一篇 md → `documents` 1 行、`doc_fts` 可搜 |
| 2 | 精确关联 | front-matter 声明块 → 块反查命中该文档 |
| 3 | 中文搜索 | 搜"冷却台"（3 字）命中；2 字词走 `LIKE` 也命中 |
| 4 | 版本化 | 改文档再索引 → 新 doc 节点 + `SUPERSEDES` 边 |
| 5 | 不存正文 | 库内只有截断文本（≤512 KB），原文件仍是真身 |

---

## 5. P4：背景补录

### 交付

1. `project_version_annotate({ commit, reason?, problem?, acceptance?, references? })`，同步更新图与时间线。
2. `project_problem(ref)`：问题 → 影响块 / 会话 / 提交。
3. `project_version_query(sql)`：只读 SELECT（拒绝 INSERT/UPDATE/DELETE）。

### 验收

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 补录 | annotate 后 `block_timeline.reason/problem_ref` 更新 |
| 2 | 问题视角 | `project_problem("cooling-table-blocked")` 返回块 + 提交 + 会话 |
| 3 | 只读 | `project_version_query("DELETE …")` 被拒并说明原因 |
| 4 | 可重建 | 补录信息写入 `_history.jsonl`，重放后仍在 |

---

## 6. P5：工作流接入

### 交付

1. `preset-auditor` 政策：提交成功后必须确认版本库写入（失败要在报告里说明）。
2. leader / expert 的工具行挂载查询工具。
3. `create_engineering_project` 完成后自动索引 `.dsh/docs/`（若存在）。
4. 变更包 `DiffDoc` 与事件关联。

### 验收

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 工具可见 | 三个 preset 的 `--dump-config-schema` 含对应工具 |
| 2 | 提交确认 | auditor 报告里出现"版本库已写入/失败原因" |
| 3 | 文档自动索引 | 建工程后 `.dsh/docs/` 有文件即被索引 |
| 4 | 端到端 | 用户改块 → 提交 → 立即 `project_block_history` 能看到新记录 |

---

## 7. 依赖与顺序

```text
P0 ──┬── P1 ──┬── P4
     │        └── P5
     ├── P2
     └── P3
```

- P0 是所有阶段的前提；
- P1 与 P2、P3 可并行；
- P4/P5 依赖 P1 的工具面。

---

## 8. 回滚与开关

- `versionStore.enabled`（默认 true）：关掉后提交不写库，行为回到今天；
- 查询工具独立挂载，关掉不影响提交；
- db 写失败只 warning，提交不受影响；
- 删 `.dsh/versions.db` 即回到"无版本库"，`reindex` 可随时重建；
- 文档索引失败不影响提交与查询。

---

## 9. 风险

| 风险 | 阶段 | 缓解 |
|---|---|---|
| `node:sqlite` API 变化 | P0 | 只用 DatabaseSync/exec/prepare/run/get/all；宿主升级冒烟 |
| 事件与图不一致 | P0 | 同事务写；P2 的 verify 检出 |
| 大项目写入慢 | P0 | 基线一次 1377 行；后续每提交 N 行；事务批量 |
| 文档误关联 | P3 | 只有 front-matter 自动建边；其余需 agent 确认 |
| 路径/清理误删 | 全部 | `.dsh/` 已在忽略清单；删库用 reindex 恢复 |
