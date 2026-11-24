# versionControl 插件规划（拆包 + 工作流 + preset 重排）

> **状态：规划稿，未动代码。** 前置审计见 [`plugin-consolidation-audit.md`](plugin-consolidation-audit.md) §9.2。
> 本文只回答四件事：**为什么必须先在 context 里做 R1**、新包长什么样、preset 怎么重排、按什么顺序迁。

---

## 1. 位置：它补的是架构里本来就有的 ③ 层

```
        ┌──────────────────────────────────────────────────────────────┐
        │ ① 接入层      @automation-suite/tia-openness-v17             │
        │   导出 source/<device>/ + _evidence.json，写回并编译验证      │
        └───────────────┬──────────────────────────────────────────────┘
                        │ 素材（文件契约，只读）
        ┌───────────────▼──────────────────────────────────────────────┐
        │ 作用域        @automation-suite/engineering-context          │
        │   workspace 路径规则、create、sync、status、handoff、translate │
        └───────────────┬──────────────────────────────────────────────┘
                        │ 文件契约 + 软服务 versionControl
        ┌───────────────▼──────────────────────────────────────────────┐
        │ ③ 管理与协作  @automation-suite/engineering-version-control  │
        │   git 提交协议、版本账本、投影、差异                            │
        └───────────────┬───────────────────────────────▲──────────────┘
                        │ versions-view.json            │ gitContext（唯一 git 通道）
        ┌───────────────▼──────────┐        ┌───────────┴──────────────┐
        │ @automation-suite/        │        │ @automation-suite/        │
        │   ui-versions（只读）      │        │   dsh-tool-git（底座）     │
        └──────────────────────────┘        └──────────────────────────┘
```

**三条硬约束**（这就是新包的边界）：

1. **不碰 TIA**：不取 `engineeringAccess`、不开工程。它只读 `source/`（文件契约）。
2. **不自己跑 git**：只用 `gitContext` 服务。现在 context 自带一份 `src/git.ts`（`execFile('git', …)`，294 行），
   与 `gitContext` 规则相同、实现两份——新包落地时这份应当消失，git 能力从"3 处"降为"1 个实现 + 2 个面（服务 / 模型工具）"。
3. **不依赖 graph**：账本里的图跳转是它自己的事（见 §8 R4）。

---

## 2. R1 详解：为什么"提交"现在离不开 TIA

`project_commit` 一进 `execute` 就按这个顺序走（`src/tools/commit.ts`）：

| 步 | 代码 | 缺 TIA 时 |
|---|---|---|
| 1 | `resolveScope(...)`（commit.ts:84） | 正常 |
| 2 | `engineeringAccess(ctx)`，取不到就抛 `tia_access_unavailable`（:85-92） | **整条失败** |
| 3 | `resolveDevice(scope, service, exec)`（:93） | — |
| 4 | `access.readTiaSession({ signal })`（device.ts:81） | **`tia_unreachable`** |
| 5 | 闸门：控制器没跑 → `tia_controller_not_running`；工程没开 → `tia_project_not_open`（device.ts:90-103） | **全部失败** |
| 6 | 闸门：0 个 PLC → `device_not_found`；>1 个 PLC → `multiple_plc_unsupported`（device.ts:104-117） | **多 PLC 工程被拒** |
| 7 | 到这一步**才**读索引 `source/_dsh-engineering-context.json` 拿设备目录（device.ts:126 → `recordedDirectory()`:40-62） | — |

**一句话**：提交前 90% 的前置工作是在问 TIA"你现在开着哪个工程、里面有几个 PLC"，而设备清单本来就记在
`source/_dsh-engineering-context.json` 的 `devices[]` 里（`device.ts:33-37` 自己就在读它）。

**三个真实后果**：

1. 没装 TIA 插件的组合里，`project_commit` **永远**跑不了——尽管 source 树、evidence 账本、git 仓库都在磁盘上；
   这直接否掉"版本管理可离线/可在 CI 跑"这个卖点。
2. 工程里有 2 个 PLC 时，一个**磁盘上完全合法**的工作区被拒提交：`multiple_plc_unsupported` 是 TIA 会话的限制，不是 git 的。
3. 新包若照搬，等于把"记历史"绑在"TIA Portal 必须开着"上——那就不该拆出来。

**修法（三步，各自可独立验收）**：

| 步 | 改什么 | 验收 |
|---|---|---|
| R1a | `resolveDevice` 增加**磁盘优先**路径：先读索引 `devices[]`；没有索引就列 `source/*/_evidence.json` 推断；0 个 → `device_not_found`；**多个 → 要求显式 `device` 参数**（工具已有该参数）而不是拒绝 | 断网 + 不装 TIA，对一个已导出的工作区跑 `project_commit` 的 dry_run |
| R1b | `engineeringAccess` 降为**可选交叉校验**：服务在就比对索引与 TIA 会话，不一致报 `warning` 不拒绝；不在就跳过 | TIA 开着但会话指向别的工程时，提交仍成功并带警告 |
| R1c | `project_sync` / `project_status` **保持** TIA 依赖（它们本来就要开工程），只有 commit / diff / history 这条线脱离 | 两个工具的现有测试不改 |

> **✅ 已落地（2026-11-24，见 [`decisions.md`](decisions.md) D41）**：
> `resolveDeviceFromDisk` / `resolveDeviceFromTia` / `crossCheckDeviceWithTia` 三个出口已在
> `packages/dsh-engineering-context/src/device.ts` 实现；`project_commit` 不再需要 `engineeringAccess`；
> `source/_dsh-engineering-context.json` 的目录提示升级为"必须在 `source/` 内**且**有账本"（旧代码只查前者）。
> 新测试 `test/22-commit-without-tia.test.mjs` 9 项，本包 **177 项全通过**。
> **离线已验（真实工作区 `0.2.5\pilot`，只读 dry_run）**：`origin=index`、零警告、读到真实 934 对象账本，
> 不提供服务也 `ok:true` —— "真实数据形状"不再依赖真机。
> **仍未验**：应用内端到端（服务在、TIA 关着、经 preset 派 auditor）。风险已按代码核实：控制器对
> "TIA 被外部关闭"回 `project_not_open` 而非 `internal_error`（`Operations.cs:141-145`，`SelfTest.cs:195-215`
> 覆盖），不会挂到超时。**这条挪到 S2 之后做一次**，一次同时验"新包 + 关 TIA"。

> **R1 在 context 里做，不随包走。** 理由：它是 `resolveDevice` 的改造，而 `resolveDevice` 同时被
> `project_sync`（要 TIA）和 `project_commit`（不该要 TIA）用。先把它拆成两个入口函数
> （`resolveDeviceFromDisk` / `resolveDeviceFromTia`），再搬包，迁移期间 context 一直是绿的。

---

## 3. 新包形态

**包名**：`@automation-suite/engineering-version-control`（与 `engineering-context`/`engineering-graph` 同族；短名 `version-control` 亦可）
**目录**：`packages/dsh-engineering-version-control`

| Loader 行 | 入口 | 工具 | 挂给谁 |
|---|---|---|---|
| 宿主行 `.` | `src/index.ts` | **0** | 所有组合（提供服务、无模型工具） |
| `/record` | `src/record-entry.ts` | `project_commit` `project_version_reindex` `project_version_annotate` `project_doc_index` | auditor |
| `/read` | `src/read-entry.ts` | `project_history` `project_version_verify` `project_doc_search` `project_problem` `project_version_query` | leader、auditor、expert |
| `/diff` | `src/diff-entry.ts` | `project_diff` | auditor、expert |

**本轮工具名一个都不改**（理由见 §6）。写/读分入口的规矩沿用 D23/D29：工具面就是权限边界。

**对外服务 `versionControl`（软依赖，给 context 用）**：

```ts
interface VersionControlLike {
  /** create 的 baseline 提交；没有这个服务时 create 仍成功，只报"未建版本库"。 */
  recordBaseline(request: {
    workspace: string
    sourceRoot: string
    label: string
    checksum?: string
    stateId?: string
  }): Promise<{ commit: string | null; warning?: string }>

  /** 只读探测：仓库、HEAD、待提交数、账本状态（leader 判断"该不该做版本任务"用）。 */
  status(workspace: string): Promise<{
    repo: string | null
    head: string | null
    pending: number
    store: 'fresh' | 'stale' | 'absent' | 'unreadable'
  }>
}
```

**配置键**（新包自己的，不再读 context 的）：`stateDirName='.dsh'`、`sourceDirName='source'`、
`indexFileName='_dsh-engineering-context.json'`、`requireGitService=true`。
**git 通道**：`ctx.get('gitContext')`，缺 → `git_access_unavailable`（沿用现有错误码）。
**只允许的 git 操作**：`status` / `add`+`commit`（路径限定）/ `log` / `show` / `numstat` / `rev-parse` / `init -b main`。
**禁止**：`reset --hard`、`push`、`rebase`、`clean`、`gc --prune` —— 与 context 现有 `git.ts` 的"no reset/--force/rebase/push"一致，
并把这条写进包的 AGENTS。

---

## 4. 数据与契约（谁写、谁只读）

| 落盘物 | 写方 | 读方 | 契约状态 |
|---|---|---|---|
| `source/<device>/{blocks,types,tag_tables}` | TIA（导出）/ context（sync） | vc、graph、ui-plc-source | 不变 |
| `source/<device>/_evidence.json` | TIA（`SyncScan`） | vc、graph、plcsim | 不变 |
| `source/_dsh-engineering-context.json` | context（create/sync） | **vc（R1a 起）**、graph、plcsim | **升级为 vc 的设备来源** |
| `.dsh/versions.db` | vc | vc | 不变（schema_version 1） |
| `.dsh/versions-view.json` | vc | `ui-versions` | **不变 → UI 零改动** |
| `.dsh/local/repo.json` | **vc**（原为 context 的 `writeRepoMarker`） | vc | **归属改变** |
| git trailer `Tia-Op`/`Tia-Checksum`/`Tia-State` | vc | vc、文稿 | 不变 |
| `handoff/**` | context | context | 不动 |

---

## 5. 搬什么 / 留下什么

**搬走（≈167 KB 源码，约该包 1/4）**：
`commit.ts` `git.ts`(→ 删除，改用 gitContext) `git-context.ts` `diff.ts` `version/**`(8 文件)
`tools/{commit,diff,version}.ts` `version-entry.ts` `version-read-entry.ts` `diff-entry.ts` `docs/version-store.md`。
测试：`10-project-diff` `11-project-commit` `12-version-store` `13-version-commit-hook` `14-version-docs` `15-version-annotate`（≈61 KB）。

**留下 9 个工具**：`create_engineering_project`、`project_status`、`project_sync`、`workspace_describe`、
`import_preflight`、`project_translate`、`handoff_export`/`import`/`status`。

**搬完 context 剩什么**（这就是它的新自我描述）：*"把工程领进 workspace，管作用域，管交接，管工程文本翻译。"*
—— workspace 路径规则、create/sync/status/describe/preflight、handoff、translate。**没有历史、没有 diff、没有 SQLite。**

---

## 6. preset 重排

| preset | 现在（19 个工具 / 6 条入口） | 拆分后 | 工具数 |
|---|---|---|---|
| **leader** | `context/status`(4) + `context/version`(8) | `context/status`(4) + `vc/read`(5) | 12 → **9** |
| **auditor** | `context`(7) + `context/version`(8) + `context/diff`(1) + `context/handoff`(3) | `context`(6) + `vc/record`(4) + `vc/read`(5) + `vc/diff`(1) + `context/handoff`(3) | 19 → **19** |
| **expert** | `context/version-read`(5) + `context/diff`(1) | `vc/read`(5) + `vc/diff`(1) | 6 → **6** |

**唯一的行为变化**：leader 不再持有 `project_version_reindex` / `project_version_annotate` / `project_doc_index`
三个写工具——与 D30"慢活交给 auditor"一致。这是顺带修掉的错配，不是新功能。

> 入口 id 从 `engineering-context/version` 变成新包的路径，preset 行名必须同步；
> 但**工具名没变**，所以 `tia-todo-bridge`（硬编码 32 个工具名）与 `ui-prompt-guide`（文案里点名工具）**不受影响**。

---

## 7. 迁移顺序（每步可独立验收、可回退）

| 步 | 做什么 | 验收 | 回退 |
|---|---|---|---|
| **S0** ✅ | context 里做 R1a/R1b/R1c（device 解析脱 TIA；`resolveDevice` 拆成「磁盘 / TIA」两个入口） | 新增"无 engineeringAccess"用例；断网不装 TIA 也能 commit 一个现有工作区 | 单 commit 回滚 |
| **S1** ✅ | 建包骨架：`package.json`、`cordis.patch.yml`（宿主行 0 工具）、build/test 脚手架、`dsh-runtime.d.ts`、Config | `tsc --noEmit` 绿；5 项骨架测试 | 删目录 |
| **S2a** ✅ | 把 10 个工具（commit / diff / version 全套）与它们需要的支撑模块搬进新包；拆成 `/record`(4) `/read`(5) `/diff`(1) 三条行 | 新包 46 项全绿、`tsc` 干净；`engineering-context` 177 项不受影响 | `git revert 62a69c9` |
| **S2b** ⬜ | `versionControl` 服务（`planBaseline` / `recordBaseline`）+ `create_engineering_project` 改为软调用 + `repo.json` 归属 + 删掉 context 的副本 + 改编 `02` 里 10 个 git 断言 | 两边全绿；无版本包时 create 仍成功并报"未建版本库" | 恢复到 S2a |
| **S3** ⬜ | preset 重排（6 条行换归属）+ 蓝图 bundle 行；`dsh --profile … --dump-config` 对行数与顺序；确认 leader 工具数 12 → 9 | dump-config 行数落在新基线；三个 preset 的工具名逐个核对 | 改回 6 条旧行 |
| **S4** ⬜ | 文档与清单：`architecture.md` §8、`roadmap.md` §1、根 README/AGENTS 的包数与期望、`releases.md`、`tia-todo-bridge` 工具名核对、把 `10-project-diff` 里的 preset 守卫搬到合适的位置 | `pnpm test` 全仓；`--dump-config-schema` 能看到新包 Config | 文档回滚 |

> **S2b 为什么单独列出来（2026-11-24 实测更正）**：原估"3–4 h 一口气做完"，实际卡在**基线提交归谁**这一个决定上。
> `create_engineering_project` 的 baseline 逻辑（`preflightRepository` 的三种拒绝、`createBaseline` 的 marker-先写、
> trailer 文案、`git_failed` 的 details）与 `02-create-project.test.mjs` 里**10 个 git 断言**（虚拟 `gitContext`、
> `data.plan.git` 的形状、三种 `workspace_is_repository`）绑在一起。把 baseline 交给 `version-control` 意味着
> 这些断言要改成"驱动假 `versionControl` 服务"，而不是小改。
> **S2a 的中间态是刻意的**：新包自成一体并全绿，context 仍持有自己的副本、蓝图也没动，所以**运行时零变化**——
> 这样在 S2b 完成前停下是安全的（`git revert 62a69c9` 即可回到 S1）。

**S3 之后才动工作流合并**（见 §8），不要同一轮做两件事。

---

## 8. 明确不做的部分（以及为什么）

| 不做 | 为什么 |
|---|---|
| **本轮不改工具名** | 改名会同时打到 `tia-todo-bridge` 的 `TRACKED_TOOLS`、`ui-prompt-guide` 的文案、各包 README 与几十条测试。改名应和 `tool-surface.md` 的 TIA 工作流层**一起**做（同一批"模型怎么问"的约定），否则改两次 |
| 下一轮的**工作流合并**（10 → 7） | 建议形态：`version_record`(commit+plan) / `version_rebuild`(reindex+doc_index) / `version_history`(含 problem= 参数) / `version_verify` / `version_docs`(search) / `version_query` / `version_compare`。**读与写仍分入口**，否则破坏 D23 |
| **不抽 `project_translate`** | 29.5 KB + xlsx + skill，但它没有自己的持久化状态，且强依赖 `projectTextAccess`。等 vc 落地后看 context 剩多少再决定 |
| **不抽 `handoff`** | 它满足"独立账本/独立失败语义"，但依赖 vc 的 base commit 与 TIA 的 archive。可作为**第二批**（`engineering-handoff`），不在本轮 |
| **不动 `knowledge-graph.ts`/`knowledge-refresh.ts`** | 这 28 KB 是"调 graph 服务"的胶水，属于 context 的编排职责；但它定义的 `KnowledgeGraphLike` 是**第二处镜像契约**（第一处是 `engineeringAccess`）。本轮只登记，不搬 |

> 关于 R4（`versions.db` 里 4 张 graph 表与 `engineering-graph` 同构，`src/version/schema.ts:6-9` 自述）：
> 拆包后这些跳转（version ↔ block ↔ problem ↔ doc）可以考虑改查 `knowledgeGraph`，但那会让 vc 依赖 graph，
> 与 §1 的约束 3 冲突。**保持独立副本，等图谱服务有稳定的"按 id 取邻域"接口再评估。**

---

## 9. 净效果

- 包数 **14 → 15**（`ui-brandmark` 已于 2026-11-24 下线，见 D40；本地插件现为 14 个，加 `version-control` 后 15）；
- Loader 入口 6 条不变，只是归属从 1 个包变成 2 个；
- 工具面 19 个不变，**leader 少 3 个写工具**；
- git 实现从 3 处降到 1 处；SQLite 依赖只在新包；
- `engineering-context` 从"19 个工具讲不清"变成"管作用域与交接的 9 个工具"；
- **③ 层第一次真实存在于代码里**，而不只是 `vision.md` 的一张图。
