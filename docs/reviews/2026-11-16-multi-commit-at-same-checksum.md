# 同一 PLC checksum 下的多次提交：现状拆解与优化方案

- 日期：2026-11-16
- 状态：**分析，未实施**（代码与文档均未改）
- 相关：工程上下文 D26（版本管理闭环）、D29（checksum 看不见安全程序）、
  [`2026-10-27-change-bundle-design.md`](2026-10-27-change-bundle-design.md) §3（trailer 用 `Tia-Checksum`、不用 tag）

---

## 1. 结论

1. **不是 checksum 在拦住多次提交。** 版本库的数据模型早就允许一个 checksum 对应多个版本：
   `versions` 表对 `plc_checksum` 只有普通索引、没有唯一约束；图里的 `checksum:` 节点刻意去重，
   多个 Version 可以指向同一个节点；`versionsByChecksum()` 的语义就是"列出所有携带该 checksum 的版本"。
   "重复 checksum 是正常场景"是既有设计口径，不是缺口。

2. **真正拦住的是两处，性质不同**：
   - **TIA 侧**：`project_sync` 的 checksum 快路径命中时**不枚举、不导出**，SOURCE 一个字节都不动。
     这时不是"不能提交第二次"，而是"根本没有第二笔差异"。
   - **git 侧**：`project_commit` 只在 `source/<device>/` 有脏文件时才创建提交。
     树与 HEAD 完全相同时 git 本身没有可提交内容，工具把这个事实翻译成 "Nothing to commit"。

3. 所以"多次提交"必须先分成四类场景（§3），各自需要不同机制。
   **"同一 checksum 的第二次提交"今天已经可达**（F-only 改动加 `force`、改回旧状态、跨分支），
   只要树与 HEAD 有差；**完全做不到的只有两类**：
   - 树不变、但要记一个"事件"（验收 / 上机 / 交付 / 里程碑）；
   - 一次同步想拆成多笔提交。

---

## 2. 代码事实：闸门到底在哪一行

| 环节 | 位置 | 今天的行为 |
|---|---|---|
| sync 快路径 | `packages/dsh-tia-openness-v17-min/controller/OperationsSync.cs` L713–722 | 只比 `checksum` / `software` / `safetyRecorded` / `manifest`；命中直接返回 `UnchangedResult`（`scanSkipped: true`），**不导出** |
| sync 计划 | `packages/dsh-engineering-context/src/tools/sync.ts` L152 | `wouldSync` 只由 checksum / 账本 / manifest 决定 |
| commit 计划 | `packages/dsh-engineering-context/src/commit.ts` L190–192 | 脏文件 = `git status --porcelain -- source/<device>` |
| commit 执行 | 同上 L236–240 | `paths.length === 0` → `committed: false`，不抛错 |
| git 底座 | `packages/dsh-engineering-context/src/git.ts` L136–161 | 再查一次 status；空则直接返回 `committed: false` |
| 版本回放 | `packages/dsh-engineering-context/src/version/write.ts` L435–510 | **逐 commit 回放**，读该提交里的 `_evidence.json`；因此一个"空提交"也会成为一条 version（0 个事件） |
| 实时记账 | 同上 L577–605 | 新提交按 `diffEvidence(父提交, 当前)` 记事件 |
| `op` 字段 | 同上 L496 与 L596 | **硬编码 `'sync'`**（回放与实时记账两处都不读 trailer） |
| 投影 | `src/version/view.ts` L93 / L125 | `op` 原样写进 `versions-view.json`，前端 `model.ts` L149 已解析 |
| UI | `packages/dsh-ui-versions/src/client/Panel.jsx` L337–339 | `events.length === 0` 一律显示 **Baseline** → 0 事件的非基线版本会被误标 |
| 本地性 | `packages/dsh-engineering-context/src/config.ts` L223–224 | `.dsh/` 整目录进 `.gitignore` → 版本库与批注只在本机，换 clone 就丢 |

**一句话**：版本库已经能承载"0 事件的空提交版本"，缺的只是
①产生这种提交的入口、②`op` 语义、③UI 标签这三项。

---

## 3. 四类"多次提交"今天各自在哪

| # | 场景 | 今天 | 卡点 | 现成出路 |
|---|---|---|---|---|
| 1 | 树变了、checksum 没变（F 程序，或改动后未重编译） | 默认**看不见** | 快路径跳过扫描，SOURCE 不更新 | `project_sync(force: true)`（D29） |
| 2 | 树变了、checksum 没变（改回旧状态，编译结果回到旧值） | ✅ 可以 | — | 正常 sync + commit；trailer 里的 checksum 自然重复 |
| 3 | **树没变**，要记一个事件（验收 / 上机 / 交付 / 审图 / 里程碑） | ❌ | 无脏文件 → 不产生提交 | 无；`project_version_annotate` 只能批注既有 commit，且不进 git |
| 4 | **一次同步拆成多笔**（按块族 / 按功能 / 按模块分批提交） | ❌ | `project_commit` 没有路径/范围参数，且账本在设备目录里 | 无 |

场景 1 需要说明一个事实边界：`PlcChecksumProvider.Software` 在"改动后未再编译"时是**空串**
（接口插件 D 系列已记录），空串会让 sync 以 `needs_compile` 拒绝，并不会静默漏掉。
真正被快路径漏掉的只有**只改安全程序**这一类（D29 的实测结论）。

---

## 4. 方案

### 4.1 A（推荐先做）：标记版本 `mark`

给 `project_commit` 加一个受控的空提交入口，专门表达"内容没变，但发生了一个值得记录的事件"。

**参数**

| 参数 | 默认 | 语义 |
|---|---|---|
| `allow_empty` | `false` | 允许在设备目录干净时创建一笔 0 文件的提交 |
| `kind` | `note` | `note` / `acceptance` / `milestone` / `test` / `delivery`（自由文本兜底） |

**trailer 设计**

```
Tia-Op: mark
Tia-Checksum: <账本里的 checksum>
Tia-State: <stateId>
Tia-Manifest: unchanged
Tia-Marks: <被重新标记的那个已知状态，通常 HEAD>
Tia-Kind: acceptance
```

`Tia-Marks` 是关键：mark 陈述的是**"关于某个已提交状态的事件"**，不是"TIA 当前是什么"。
这样即使 TIA 侧又编译过、账本还没同步，这条历史仍然是真话。

**守卫（缺一不可）**

1. `message` 非空（既有规则）；
2. 设备目录**必须干净**——有脏文件就拒绝，让调用方先决定那笔真实改动怎么提交，
   避免"标记"与"内容提交"混为一谈；
3. 账本可读（既有规则）；
4. 仓库已诞生（`headCommit` 非 `null`）。

**git 调用要写成 `--only`**

```
git commit --only --allow-empty -m <msg> -- <source/<device>>
```

不能只跑 `git commit --allow-empty`（没有 pathspec 时会把 index 里**别人的**暂存内容一起带走）。
`--only` + pathspec + `--allow-empty` 才能既限定范围、又允许空树。

**连带改动**

- `version/write.ts`：回放与实时记账都从 `meta.body` 解析 `Tia-Op`，`op` 取
  `create` / `sync` / `mark`，未知值按 `sync`（旧提交零迁移）；
- `packages/dsh-ui-versions`：0 事件且 `op === 'mark'` → **"标记版本 / Mark"**；0 事件且
  `op === 'create'` 才是 Baseline；
- `project_history(checksum=…)` 无需改：它本来就返回多行；
- `project_version_verify(deep)` 无需改：mark 的 checksum 与账本一致。

**代价**：`--allow-empty` 本身容易被滥用。用"仅当无脏文件 + mark trailer + 可选 kind"把它收窄，
不新增工具、不新增 preset 权限（auditor 仍只能通过 `project_commit` 触发）。

### 4.2 B（需先决策）：拆分提交 `split`

核心难点不是路径过滤，而是**账本归属**：`_evidence.json` / `_manifest.json` 描述整台设备，
**一次同步只产出一份新账本**。拆成 N 笔时：

- 只有最后一笔能带新账本；前 N−1 笔在 git 里看到的是**旧账本**，与新 XML 不一致；
- 回放会按"旧账本 vs 父提交旧账本"算出 0 事件，前 N−1 笔会**伪装成 0 事件的 sync 版本**——
  这比丢失更糟，是错误归因。

两种可行形态：

1. `Tia-Partial: true` trailer：前 N−1 笔标 partial，回放**跳过**（不进版本库、不计事件），
   只存在于 git 历史；最后一笔正常。改动小，代价是"历史里有提交、面板里没有版本"。
2. 账本按提交分批：要求 `SyncScan` 支持"部分导出 + 部分账本"，控制器改动，收益是每笔自洽。

**建议**：除非确实需要"按块族分批提交"，先不做 B；用 A（mark）+ 更充分的 message
与 `project_diff` 满足可读性。B 是唯一需要控制器/账本语义改动的方向，值得单独决策。

### 4.3 C（低成本增强）：让批注可移植

`project_version_annotate` 的目标是既有 commit，批注落在 `.dsh/` 本地库里，换机器就没了。
改法：加 `commit: true`，批注后创建一笔 mark（`Tia-Marks: <目标 sha>`、`Tia-Kind: annotation`），
回放时把 mark 的正文回填成目标版本的批注。这样"同一 checksum 多个版本"同时获得**可移植**的历史点。

### 4.4 备选（不推荐）

| 方案 | 否决理由 |
|---|---|
| git tag | ref 名唯一，同一 checksum 的第二次提交无法再打同名 tag（2026-10-27 §3.2 已实测） |
| `--amend` | 改写历史；`dsh-tool-git` 已把它列为 destructive 受策略保护 |
| 提交一个 marker 文件（`.dsh/marks.jsonl` 进 git） | 破坏"`.dsh/` 全 ignore"的简洁性，并引入跨分支合并冲突 |
| git notes | 不产生新的版本点，且需要额外 push 配置；只能当批注载体 |

---

## 5. 验收清单（若按 A 实施）

**单测**

- `packages/dsh-engineering-context/test/11-project-commit.test.mjs`
  - 设备目录干净 + `allow_empty: true` → 创建提交，`data.marked: true`，HEAD 前进；
  - 设备目录有脏文件 + `allow_empty: true` → 拒绝（错误码 `not_clean`），不产生提交；
  - 空提交的 message 带且只带一组 trailer（`Tia-Op: mark`）；
- `test/12-version-store.test.mjs`
  - 回放含 mark 的仓库 → 三条 version、事件数不变、mark 的 `op === 'mark'`；
  - 重复 checksum 查询返回包含 mark 的两行；
- `packages/dsh-ui-versions/test/01-model.test.mjs`
  - 0 事件 + `op: 'mark'` 不被归为 Baseline。

**真机**

1. 同一工程连续两次 `project_sync`（第二次 `force: true`，工程没变）→ `pending.paths` 为空；
2. `project_commit(allow_empty: true, kind: "acceptance", message: "客户验收通过")`；
3. `project_history(checksum: "<同一个>")` 返回两行；Versions 面板出现"标记版本"；
4. `project_version_verify` 连续、无 gap。

**文档同步**（改一处必须同步）

- `packages/dsh-engineering-context/docs/decisions.md` 新增 D30（`mark` 语义与守卫）；
- 该包 `README.md` 的 `project_commit` 行与 `docs/version-store.md`；
- 根 `docs/roadmap.md` 与根 `README.md` §2/§8；
- `CHANGELOG.md`。

---

## 6. 需要拍板的三件事

1. **`kind` 要不要固定枚举？** 建议：自由文本为主，附一个可选枚举供 UI 配色，避免为新增事件类型改代码。
2. **是否真的需要 B（拆分提交）？** 如果目的只是"历史可读"，A + 好 message 很可能就够；
   B 的代价是控制器与账本语义改动，收益是极少数场景。
3. **mark 要不要读 TIA 实时 checksum 做校验？** 建议不读：只用"git 干净 + `Tia-Marks`"表达，
   避免把一次 3 秒的 TIA 往返塞进 commit，也避免在 TIA 未开工程时无法标记。
