# 参考项目（Reference Project）：设计提案

> **状态：提案，未实现。** 这不是现状说明，也不是已定决策。
>
> 本文回答三件事：① 为什么"加一个参照工程"不是"再放一个目录"，而是改了一条隐含不变量；
> ② 目标形态是什么（项目根 + 角色、只读闸门、跨工程复制）；
> ③ 怎么分阶段做、每阶段怎么验收。
>
> 需要你先定的三条写在 [`open-questions.md`](open-questions.md) **A18–A20**（另加 B18：
> 参照项目进不进 git、默认建不建图谱库）。答复后本文转正，结论按仓库惯例落进
> [`decisions.md`](decisions.md) 与 [`architecture.md`](architecture.md)。
>
> ⚠️ **先读 §12.1**：如果参照项目本身就是本发行版管理的另一个 workspace（有 `source/` 与
> `knowledge/`），有一条成本低得多的路线 —— 读、查图谱、把 XML 导进主工程**今天就能做**
> （已实测），缺口只剩"发现、出处、只读约定"三件小事。本文 §3–§11 是「参照工程与主工程
> 同生命周期」的重路线，只在"A 必须自己维护一份参照副本"时才值得做。
>
> 📌 **2026-11-04 复盘（§15）**：用真实会话（SWT1 ← SWT2，154 次工具调用、17 个对象导入、
> 提交 `4af0a95`）验证了这个判断 —— 结论是**不建 `refs/` 项目根**，只做
> `workspace_describe` + `import_preflight` + 出处约定三件事。
>
> 因此：**§3–§11 现在的用途是"重路线的设计记录"**，供将来出现 §15.5 的情况（B 只有 `.ap17`、
> A 要自己刷新 B、面板要显示 B）时复用；§12.1 与 §15 才是当前建议。

---

## 1. 场景与目标

**场景**：改当前工程时，要照着另一个工程的做法来 —— 看它某个块怎么写的、某个功能怎么搭的，
必要时把其中某个对象拿过来改成自己要的样子。在 TIA Portal 里这是 **Reference project**
（把另一个工程以只读方式挂在旁边，可以看、可以取用，不能改）。

**要达成的能力**（使用者口径，逐条对应到后面的设计）：

| # | 能力 | 落在哪一节 |
|---|---|---|
| 1 | 参照工程也拿到**全部源文件**（和主工程同一套导出物） | §3.2 / §4.1 |
| 2 | 参照工程也做**knowledge 解析**，能被查询、下钻 | §7.1 |
| 3 | 能把参照工程的某个源文件/对象**复制到主工程**再改 | §6 |
| 4 | 参照工程**只读**：任何工具路径都不许改它 | §5 |
| 5 | 会话里始终能说清"这是哪个工程的哪个版本" | §3.3 |
| 6 | 主工程今天的一切（路径、工具、UI、git）**不被打断** | §3.6 |

**不是目标**：多用户/多分支工作流（另见 open-questions B11）；把参照工程当成第二个"主工程"
来同步、提交、编译；跨 TIA 版本复用（V17 只对 V17）。

---

## 2. 为什么这是一次架构改动：五条被打破的假设

现在的插件族建立在五条隐含假设上。引入参照工程后，每一条都要重新回答 —— 这是"架构挑战"的实质，
不是实现细节。

| # | 现在成立的假设 | 代码/文档依据 | 引入参照后 |
|---|---|---|---|
| 1 | **会话 cwd 就是工程根**：`<root>/source` 与 `<root>/knowledge` 属于**这一个**工程 | `config.ts` 的 `sourceDirectoryPath`/`knowledgeIgnoreRule`；PATH-RULES §2 | 参照也要有自己的 source/knowledge，必须有自己的根 |
| 2 | **一个 TIA 实例只持有一个打开的工程** | `controller/OpennessHost.cs:200` 的 `_project != null` 直接拒绝 | 导出参照必须先让出主工程，或改成多句柄（未验证，见 §12-C） |
| 3 | **`source/_dsh-engineering-context.json` 的 project 就是"本 workspace 的工程"** | `tools/create-project.ts` 的 `SourceIndex` | 每个根一份索引，且要能区分角色 |
| 4 | **所有写入都发生在 workspace 根下固定的三处** | `scope.ts` + `config.ts` 的四个目录名 | 参照根同样是写入目标（attach/refresh 时），但**只允许这两条路径写** |
| 5 | **知识库发现只看 `<workspace>/knowledge`，且"唯一库才自动解析"** | `dsh-engineering-graph/src/workspace.ts` | 要按项目根发现；自动解析规则会被多库打破 |

顺带受影响的还有三处（不是不变量，但会立刻踩）：

- **UI**：`dsh-ui-plc-source` 只读 `<workspace>/source`（`model.ts` 的 `SOURCE_DIRECTORY`），
  参照块在面板上默认不可见；
- **版本/差异**：`diff.ts` 的 `sourceDirectoryPath(config, root)` 钉死在 workspace 根，
  参照树的 diff 需要传不同的根；
- **git 边界**：`.gitignore` 只认 `tia/`、`knowledge/**/*.db*`、`.dsh/local/`
  （`config.ts` 的三条规则），参照目录需要自己的两条规则。

---

## 3. 核心抽象：项目根 + 角色

### 3.1 定义

> **项目根（project root）**：一个同时持有 `source/`（导出物文本树）与 `knowledge/`（图谱库）
> 的目录，并带一份 `source/_dsh-engineering-context.json` 说明"这棵树属于哪个工程"。

今天主工程的根**就是 workspace 根**。参照工程的根是 `refs/<slug>/`。**一个 workspace 因此拥有
一个主工程根 + 零到多个参照根**，而不再是一个根。

这条抽象不是新造的：知识图谱插件早就在用"project root = 持有 `source/` 的目录"这个说法
（`knowledgeGraph` 服务的 `databaseConvention`），`graph-freshness.ts:144` 也是从
`<root>/source/<device>` 往上两级反推根。我们只是把它从"恰好只有一个"放宽到"有多个"。

### 3.2 目标布局

```
<workspace>/                                   ← 会话 cwd；仍是唯一作用域（D5 不变）
├── tia/<workspace 名>/                         ← 主工程副本（不变）
├── source/                                     ← 主工程源树（不变）
│   ├── _dsh-engineering-context.json           ← 索引；role 缺省 = primary（向后兼容）
│   └── <device>/...
├── knowledge/<device>/<device>_knowledge.db    ← 主工程图谱库（不变）
│
├── refs/                                       ← 新增：参照工程（配置 referenceDirName，默认 refs）
│   └── <slug>/                                 ← 一个参照工程 = 一个项目根
│       ├── tia/<slug>/<slug>.ap17              ← 另存副本（TIA 用目标目录名命名，D24 实测）
│       ├── source/                             ← 参照源树（与主工程同构，文本）
│       │   ├── _dsh-engineering-context.json   ← role: "reference" + 原工程身份
│       │   └── <device>/{blocks,types,tag_tables}/...
│       ├── knowledge/<device>/<device>_knowledge.db
│       └── .dsh/local/graph/<device>.json      ← 图谱新鲜度 sidecar（按根隔离，不撞）
│
└── .dsh/local/
    ├── lock.json                               ← 主工程与参照的切换/同步共用一把锁
    ├── stage/<id>/                             ← 主工程 sync 的 STAGE（不变）
    └── transfer/<id>/                          ← 新增：跨工程复制的暂存（XML + provenance.json）
```

**为什么参照根是"迷你 workspace"而不是"参照特有布局"**：`rebuildSource(root)`、`syncScan`、
`ingestDevice(deviceDir)` 都只认"根/设备目录"这两个参数（`access.ts:1034`、`scan.ts`、
`knowledge-graph.ts:342`），不需要知道根是谁。把参照做成同样形状，**这三条缝一行都不用改**，
这是本方案成本最低的地方。

**为什么主工程不搬家**：主工程留在 `<workspace>/source` 与 `<workspace>/knowledge`，所有既有
路径、UI、git 规则、测试、文档全部继续成立。如果为了"整齐"把主工程也挪进
`projects/primary/`，要改的知识面远大于收益（`dsh-ui-plc-source` 的 `SOURCE_DIRECTORY`、
`versions-view.json` 的位置、`.gitignore` 的三条规则、PATH-RULES 的整棵树、全部既有测试）。
**兼容优先，参照放边上。**

### 3.3 索引与身份

`source/_dsh-engineering-context.json` 增加两个可选字段（旧文件没有 = primary，读取方全部按
缺省处理）：

```jsonc
{
  "schemaVersion": 1,
  "role": "reference",                     // 新增；缺省 = "primary"
  "project": {
    "name": "Line1",                       // TIA 回读的工程名（另存后 = slug，见 §3.4）
    "path": "C:\\Projects\\Line1\\Line1.ap17",          // 打开的那个工程（原工程）
    "savedAs": "…\\refs\\Line1\\tia\\Line1\\Line1.ap17", // 另存的实际落点（TIA 回读）
    "archive": null,
    "directory": "…\\refs\\Line1\\tia\\Line1",
    "sourceRoot": "…\\refs\\Line1\\source"
  },
  "reference": {                           // 新增；只在 role=reference 时出现
    "slug": "Line1",
    "sourceProject": "C:\\Projects\\Line1\\Line1.ap17",
    "attachedAt": "2026-11-04T04:30:00.000Z"
  },
  "exportedAt": "…",
  "devices": [ /* 不变：device / software / directory / manifest / exported / skipped */ ],
  "totals": { /* 不变 */ }
}
```

**身份仍按路径判定，不按名字**（D23 的规则不变）：`savedAs` / `path` / `archive` 任一命中就是
同一个工程。参照工程额外多一条"原工程路径"（`reference.sourceProject`），用于：
① 判断同一路径是否已挂过（是 → 刷新而不是重复挂）；
② 拒绝"把主工程自己挂成参照"；
③ 结果里永远能说清"参照的是磁盘上的哪个文件"。

### 3.4 slug 规则

- `slug = folderName(basename(source_project 去扩展名))`，与 `folderName()` 同一套安全化
  （`paths.ts`）；撞名追加 `~2`、`~3`。
- **为什么就用原工程文件名**：TIA 的 `SaveAs(DirectoryInfo)` 用**目标目录名**给工程命名
  （D24 真机实测：另存进 `tia/` 之后工程就叫 `tia`）。所以目标目录取 `refs/<slug>/tia/<slug>/`，
  另存后的工程名恰好等于原文件名，参照工程不会在 TIA 里莫名改名。
- **不追加随机 id**：目录是给人看的，也是工具的句柄；路径身份由索引记录，不靠目录名防撞。
  撞名用 `~2` 解决，并在结果里说明"目录名是 `<slug>~2`，TIA 里的工程名也是它"。
- **slug 一旦生成不再改**：即使 TIA 回读的工程名与 slug 不同（例如源工程文件夹名 ≠ 工程名），
  也只在索引里记两个名字并给 warning，不重命名目录 —— 重命名会让已写进结果、提交信息、
  用户笔记里的路径全部失效。

### 3.5 为什么仍然不要注册表

D22 把"workspace 里有哪些工程"交给目录布局本身。参照沿用这条：**列举 = 读
`refs/*/source/_dsh-engineering-context.json`**，没有第二个登记文件。好处与 D22 相同：
不会出现"注册表说有、磁盘上没有"；代价也相同：目录被手工改坏时，工具只能报告而无法纠正。
**不引入 `references.json`。**

### 3.6 兼容性承诺

| 今天的东西 | 参照工程引入后 |
|---|---|
| `create_engineering_project` / `project_status` / `project_sync` / `project_commit` 的参数与落点 | 不变（只作用主工程） |
| `dsh-ui-plc-source` 的 `source/<device>/_manifest.json` | 不变（面板默认只看主工程，见 §7.2） |
| `dsh-ui-versions` 的 `.dsh/versions-view.json` | 不变（参照不进版本时间线） |
| `.gitignore` 三条规则 | 追加两条（参照的 `tia/` 与 `*.db*`），不重写 |
| `refs/` 不存在时的一切行为 | 与今天完全一致 |

---

## 4. 参照工程的生命周期

### 4.1 attach（`create_reference_project`）

一次调用完成整条链，和 `create_engineering_project` 同构（计划 → 执行），默认 `dry_run: true`：

| # | 步骤 | 谁做 | 失败时的状态 |
|---|---|---|---|
| 1 | 解析 workspace 根、读主工程索引、判定 slug | 工程上下文 | 什么都没写 |
| 2 | 检查"要挂的是不是主工程自己" → `reference_is_primary` | 工程上下文 | 什么都没写 |
| 3 | 让 TIA 空出来（§4.2 的切换协议） | 工程上下文（经缝 A） | 主工程会被关掉但保证重开，见 §4.2 |
| 4 | 打开原工程 `.ap17`（或取回 `.zap17`） | 接口插件 | 主工程重开 |
| 5 | `saveProjectAs(refs/<slug>/tia/<slug>)` | 接口插件 | 原工程没变；副本可能半成品（TIA 决定） |
| 6 | 写索引（`role: "reference"`，先落盘再导出） | 工程上下文 | 下次可重跑刷新 |
| 7 | 追加 `.gitignore` 两条规则 | 工程上下文 | 下次重跑补 |
| 8 | `rebuildSource(refs/<slug>/source)` 全量导出 | 接口插件 | 源树部分落盘，逐设备回报 |
| 9 | 逐设备 `ingestDevice` → `refs/<slug>/knowledge/` | 图谱插件（缝 B） | 只报"图谱未建成"，不失败（与 D25 同一条规则） |
| 10 | 关参照（`save: false`）→ 重开主工程 | 工程上下文 | `reopen_failed`：导出结果保留，提示手动打开 |
| 11 | git：路径限定 `refs/<slug>/source` 的一次提交 | 工程上下文 + `gitContext` | 无仓库则跳过并 warning（**从不 `git init`**，D13 不变） |

**顺序上的两个刻意选择**：

- **索引在导出前写**：导出可能中途失败，但"这棵树属于哪个参照工程"必须先钉住，否则下次重跑
  无法做身份比对，只会当成新工程重复导出。
- **`.gitignore` 在导出前写**：和 D24 的理由一样 —— 目录里一有文件，ignore 就必须已经生效。

**与主工程的关键差异**：

| 项 | 主工程 | 参照 |
|---|---|---|
| `rebuildSource` 的覆盖语义 | `overwrite` 默认 false（跳过已有） | 首次 attach 用 false；`reference_refresh` 走增量 |
| 知识库 | 每次真实运行都全量重建 | 默认同主工程；大工程可 `knowledge: false` 只导出 |
| git 提交 | 由 `project_sync` / `project_commit` 显式触发 | attach/refresh 自带一次路径限定提交（快照） |
| 主工程是否存在 | — | **允许没有**（只挂参照做调研）；`copy_from_reference` 会以 `primary_not_created` 拒绝 |

### 4.2 单实例切换协议

控制器一次只持有一个工程（`OpennessHost.cs:200`）。参照的 attach/refresh 必须**让出**当前工程。
规则写死成状态机，不做"智能调度"：

| TIA 当前状态 | attach/refresh 的动作 | 拒绝条件 |
|---|---|---|
| 控制器没运行 / 没有工程 | 直接打开目标工程 | — |
| **主工程开着，`isModified === false`** | `close(save:false)` → 操作 → `open(primary)`（重开） | — |
| **主工程开着，`isModified !== false`** | **什么都不做，拒绝** | `primary_modified`：让用户先 `save_project`（工具描述里给下一步） |
| 另一个参照开着 | `close(save:false)` → 打开目标参照 | — |
| 目标参照已经开着 | 直接 refresh（不关不重开） | — |

四条配套约束：

1. **必须显式告诉用户"会关掉主工程"**：计划里单列一行（`Switch: close the open project (unsaved
   changes: none) → reopen it after the export`），不能藏在细节里。
2. **只在 `isModified === false` 时自动关**：`isModified` 读不出来（`null`）也按"可能有改动"处理，
   fail-closed。
3. **重开主工程按索引里记录的实际路径**（`savedAs`/`path`），失败则 `reopen_failed`，并明确说明
   "参照已导出，主工程需要你手动打开"。绝不猜路径、不搜索磁盘。
4. **切换与 refresh 共用 workspace 锁**（`.dsh/local/lock.json`，TTL 15 min），两个并发会话
   不会同时动 TIA。

### 4.3 列举（`project_references`）

只读、便宜（不碰 TIA）：逐个参照根读索引 + `stat` 源树与库文件，返回：

```
Primary:  Line1 — 1 device (Sino_PEI), source 2026-11-03 14:02, graph built 2026-11-03 14:20
refs/Line2   Line2 — 1 device (PLC_1), attached 2026-11-04 12:30 from C:\Projects\Line2\Line2.ap17
             source: refs/Line2/source/ (complete, 842 files) · graph: missing (knowledge: false)
refs/Line3~2 Line3 — attached 2026-10-30 … · graph: stale (source changed after ingest)
```

- `project_status` 另加一段紧凑摘要（引用数与每个引用的一行状态），不进详情；
- 参照根被手工删一半（只有 `tia/` 没有 `source/`）时，如实报 `incomplete` 并说明"重跑 attach
  同一路径即可补齐"，不自动修。

### 4.4 refresh 与"原工程变了"的边界

两件不同的事，必须分开说：

| 情形 | 做法 |
|---|---|
| 用户**在主工程**里改了东西 | 不关参照的事，`project_sync` 照旧 |
| 用户**在 TIA 里改了参照工程的原文件**（`reference.sourceProject` 指向的那份） | 我们手里的 `<slug>/tia/` 副本**不会自动更新**。`reference_refresh` 只刷新"副本 → 源树"，不重新取原件 |
| 要按原工程重新取一份 | `create_reference_project` 同一路径 + `rebuild_copy: true`（显式）：只删 `refs/<slug>/tia/` 后重取；源树与库保留并覆盖 |
| 参照工程在 TIA 里被改名/移动 | 副本路径由索引记录，重跑 attach 会按路径比对，命中即刷新；不命中则拒绝覆盖（`reference_slug_conflict`） |

**为什么 refresh 不重取原件**：`SaveAs` 到一个已存在的非空目录会被 TIA 拒绝（D24 记录过），
重取只能先删副本；而删除是不可逆动作，必须是显式的 `rebuild_copy`，不能藏在日常刷新里。

### 4.5 detach / 移除（不进 P1）

按"不擅自删"原则，P1 不提供删除工具。要移除参照，让用户自己删 `refs/<slug>/`（文本树在 git 里，
可恢复）或后续做 `remove_reference`（`dry_run` 默认、只删 `refs/<slug>`、绝不碰主工程）。

---

## 5. 只读：四层闸门与诚实边界

### 5.1 先说清 Openness 能做什么（结论：不能靠它）

V17 的 `ProjectComposition` 只有 `Open` / `OpenWithUpgrade` 六个重载
（反射 `PublicAPI\V17\Siemens.Engineering.dll` 得到），**没有一个接受只读参数**。
`Siemens.Engineering.OpenMode`（`ReadOnly` / `ReadWrite`）的文档写的是
"The library can only be read from" —— 它属于**库**（`LibraryComposition`），不是工程。
`ProjectOpenMode.Primary` / `Secondary` 是多用户项目的主/次副本，也不是只读。

手册目录里确有 "Accessing read-only TIA Portal project" 一节，但那是**已经在 UI 里以只读方式
打开**之后的访问语义（细节未核对），headless 控制器没有对应入口。

> **所以：参照工程的只读是"我们自己的策略"，不是 TIA 给的保证。** 这一点必须写进文档与工具
> 描述，不能说得比实际强。

### 5.2 四层闸门

> **适用前提**：这一节只管**重路线** —— A 自己打开参照副本时。轻量路线（§12.1）从不打开 B，
> 所以控制器的闸门对它**完全无效**：那时只读只能是"约定"或文件系统级（会话策略 / ACL）。
> 这也是 A19 必须先选路线的原因。

| 层 | 在哪 | 拦什么 | 强度 |
|---|---|---|---|
| **① 控制器写闸门** | 接口插件（C# `OpennessHost` + 操作分派） | 工程以 `role: "reference"` 打开时，**任何改工程的操作**一律 `project_read_only`，不看到底是谁调的、走的哪个工具 | 强（fail-closed，唯一的写通道） |
| **② 角色一致性校验** | 工程上下文（`project_sync` / `project_commit` / `copy_from_reference`） | 写之前读 `readTiaSession().projectRole` 与当前打开工程的路径：不是主工程 → `copy_target_mismatch` / `project_read_only` | 中（防"主工程被另存进 refs"这类漂移） |
| **③ 路径规则** | 工程上下文（`config.ts` + 新 `referenceRootPath`） | 参照根只由 attach/refresh 写；sync/commit 的 pathspec 只到 `source/<device>`；复制只写 `.dsh/local/transfer/` | 中（代码约定 + 测试） |
| **④ 审计与可观测** | 结果、提交 trailer、`.dsh/local/` 记录 | 每次 attach/refresh/复制都留下"哪个参照、哪个对象、哪个 sha256" | 弱（事后可查） |

### 5.3 控制器视角的写操作分类（P1 必须落成数据表）

`OperationCatalog` 现在只有白名单（`controller/Protocol.cs:39`）。P1 给它加**分类**，并由
`--self-test` 断言"每个操作恰好属于一类"，这样以后新增操作**漏分类就直接红**：

| 类别 | 操作 | 参照打开时 |
|---|---|---|
| **只读工程** | `PlcChecksum`、`ListPlcObjects`、`ProjectInfo`、`ProjectLanguages`、`ProjectTexts(export)`、`SafetyStatus`、`SafetySignatures`、`HardwareInventory/Configuration/Parameters/View`、`OnlineTargets`、`OnlineStatus`、`PortalSettings(list)` | 允许 |
| **只写外部文件** | `ExportBlocks`、`ExportHardwareConfig`、`SyncScan`、`ArchiveProject(archive)`、`GenerateSource`（写出源文件） | 允许 —— **attach/refresh 正靠这一类** |
| **改工程** | `ImportBlocks`、`CompilePlc`、`SaveProject`、`CreatePlcObjects`、`DeletePlcObjects`、`WriteTags`、`SetBlockAttributes`、`ProtectBlocks`、`WatchAndForceTables`、`SoftwareUnits`、`SetSafetySettings`、`ProjectTexts(import)`、`UpdateProject`、`CloseProject(save=true)` | **拒绝 `project_read_only`** |
| **改设备 / 在线** | `OnlineConnect`、`Download` | **拒绝**（参照工程不该被拿去下载） |
| **会话 / 前提状态** | `OpenProject`、`CloseProject(save=false)`、`CreateProject`、`ArchiveProject(retrieve)`、`AdoptOpenProject` | 由前置状态决定，与角色无关 |

两个容易漏的点：

- **`CompilePlc` 归"改工程"**：编译会改写工程内的编译状态/一致性信息，不能当只读用；
- **`AdoptOpenProject` 只能以 primary 接管**：Openness 读不出 UI 里那份工程是不是"参照打开"的，
  所以接管后按 primary 处理，并在结果里明说这一点（风险写在工具描述里）。

### 5.4 诚实边界（必须写进 README 与工具描述）

1. **不做 OS 级只读**：TIA 打开工程本身会往工程目录写临时文件（实测 `IM\SearchIndex\segments_*`、
   `TMP\StandardMotionControl\cache.tmp`），把 `refs/<slug>/tia/` 设成只读会让打开失败；
   而且 agent 有 shell，文件属性只是减速带，不是闸门。
2. **参照源树是"派生缓存"，不是权威**：模型手改 `refs/<slug>/source/**` 不会改任何工程，
   只会让这棵树与 `_manifest.json` 的 sha256 对不上。`copy_from_reference` / `reference_refresh`
   在用它之前会校验清单哈希；`reference_refresh` 会重建被改坏的文件。
3. **原件只读是"我们不动它"**：全程不写 `reference.sourceProject` 指向的原工程文件；但"打开"
   本身会让 TIA 写它自己的临时文件（同上），核对"原件未被改动"时要排除这两类。

---

## 6. 跨工程复制（`copy_from_reference`）

### 6.1 为什么不能"把文件拷进主工程的 `source/`"

`source/` 是 **TIA 的派生视图**：它是"上一次从 `.ap17` 导出"的快照，不是编辑入口。把参照的 XML
拷进 `source/` 只会让这棵树和主工程不一致 —— 下一次 `project_sync` 会把它当外部改动覆盖/删除，
TIA 里的工程也完全没变。**唯一能改工程的是导入**（写入通道只有一条，`architecture.md` §9）。

### 6.2 正确链路：暂存 → 导入 → 编译

| # | 步骤 | 写什么 | 说明 |
|---|---|---|---|
| 1 | 在参照根的索引/清单里定位对象 | 无 | 按 `device` + `kind` + `name` 精确匹配；多个设备且没给 `device` → 拒绝并列出候选（和 `resolveDevice` 同一条规则） |
| 2 | 校验文件 sha256 与清单一致 | 无 | 不一致 → `copy_source_stale`，让用户先 `reference_refresh` |
| 3 | 复制到 `.dsh/local/transfer/<id>/`，保留用户组目录结构 | 暂存区 | 目录结构决定导入后的组（`mirror_groups`），不能拍平 |
| 4 | 写 `provenance.json` | 暂存区 | 参照 slug、原工程路径、对象名、源文件 sha256、参照 attach 时间、账本里的指纹 |
| 5 | 确保主工程打开且可写 | TIA 会话 | 没开 → 按索引路径打开（参照先关）；开着的不是主工程 → `copy_target_mismatch` |
| 6 | `importObjects([暂存文件], { importOptions, targetGroup? })` | **主工程** | 新缝（§8.2），与 `import_blocks` 同一条代码路径；默认 `none`（撞名就拒绝），`override` 显式 |
| 7 | `compile_plc`（按设备） | 主工程编译状态 | 编译失败原样回报；**不自动回滚**（TIA 的导入事务已经提交） |
| 8 | 结果里说明"主工程源树已过期，下一步 `project_sync`" | 无 | 复制不是同步；不要让人以为 `source/` 已经更新 |

### 6.3 依赖闭包（P2，不是 P1）

一个块导出到另一个工程，可能缺：它调用的 FB/FC、它实例化的 DB、它用的 UDT、它读写的标签表。
P1 **不做自动闭包**：只复制点名的对象，TIA 的 `import_failed` 原样回报（错误信息里通常带缺哪个
对象）。P2 用**参照工程的图谱**算闭包：

```
block(CALLS|INSTANCE_OF|HAS_TYPE|READS|WRITES)* → 需要一起带的对象
```

- 边来自 `dsh-engineering-graph` 已解析的 XML（D15：只解析 XML，不取 TIA 交叉引用），
  所以闭包**可能少算**，结果是"TIA 说还缺 X"，而不是"悄悄带错"；
- 标签表是工程级对象，带过去可能与主工程撞名 —— 默认不进闭包，只在结果里提示。

### 6.4 出处（provenance）

`.dsh/local/transfer/<id>/provenance.json` 至少包含：

```jsonc
{
  "schemaVersion": 1,
  "reference": "Line2",
  "referenceProject": "C:\\Projects\\Line2\\Line2.ap17",
  "referenceSavedAs": "…\\refs\\Line2\\tia\\Line2\\Line2.ap17",
  "attachedAt": "2026-11-04T04:30:00.000Z",
  "object": { "kind": "block", "name": "FB_Motor", "device": "PLC_1" },
  "file": { "path": "blocks/010_Cell/FB_Motor.xml", "sha256": "…", "bytes": 12345 },
  "importedAt": "2026-11-04T04:35:00.000Z",
  "importOptions": "none",
  "compile": { "ok": true, "durationMs": 12000 }
}
```

P1 只落在这里（不提交、不进 `versions-view.json`）；"变更台账"（P3）做起来时，这里是它的第一手
证据。复制**不写**参照树、**不写**主工程源树，出处也不进提交信息 —— 提交信息属于
`project_commit` 的调用者。

### 6.5 TIA 导入的已知限制（不是本方案的限制，但必须回报）

- 同名/同号对象已存在 → 需要 `import_options: "override"` **且**目标用户组一致
  （`import_blocks` 的 `target_group` 描述里有实测：从根组覆盖不了用户组里的块）；
- 缺被引用的对象 → 严格导入失败；`ignore_missing_referenced_objects` 能过，但会留下悬空引用，
  默认不替用户选；
- F 块（Safety）跨工程导入的成功条件未实测，P1 遇到就原样回报，不猜；
- 只支持同版本（V17 → V17）；更早版本的工程要先 `allow_upgrade` 另存，属于 attach 阶段的事。

---

## 7. 知识图谱、UI 与版本

### 7.1 图谱插件（`dsh-engineering-graph`）

| 改动 | 位置 | 说明 |
|---|---|---|
| **多根发现** | `src/workspace.ts` 的 `discoverWorkspace` | 除 workspace 根外，扫 `refs/*/source/_dsh-engineering-context.json`；产出 `projects: [{ role, slug, root, project, devices[] }]`，顶层 `project`/`devices` 继续指向主工程（兼容调用方） |
| **库解析规则** | `resolveDatabasePath` | 现在"恰好一个库才自动解析"；改成"**全部项目根里**恰好一个库才自动解析"，否则 `DB_AMBIGUOUS`，候选写成 `<slug>/<device>` |
| **sidecar** | `graph-freshness.ts:144` | 已按"设备目录上两级"派生根，参照天然隔离（`refs/<slug>/.dsh/local/graph/`），**不用改** |
| **`knowledge_ingest` 默认落点** | 同一套派生 | `device_dir` 传参照设备目录，默认库就落在参照根，**不用改** |
| **（P2）项目限定查询** | `knowledge_query` / 四个下钻工具 | 加 `project: "primary" | "<slug>"`，内部解析到该根的库；跨库搜索作为可选增强 |

`knowledge_workspace` 的输出示例（P1）：

```
Primary  Line1 — 1 device (Sino_PEI) · graph built
refs/Line2  Line2 — 1 device (PLC_1) · graph built 2026-11-04 12:40
refs/Line3  Line3 — 1 device (PLC_1) · graph missing (attach with knowledge:false)
```

### 7.2 UI 插件

| 插件 | P1 | P2 |
|---|---|---|
| `dsh-ui-plc-source` | 不变：只显示主工程；面板没有"参照块"入口（模型用 `read` / `knowledge_*` 查参照） | 顶部加 **Primary / refs/<slug>** 切换器：数据路径 `<root>/source/<device>/_manifest.json`，`dsh-resource://file/session/...` 地址本来就是 workspace 相对，可直接复用 |
| `dsh-ui-versions` | 不变：参照没有版本时间线 | 可选：把 attach/refresh 作为一类"参照快照"事件展示（读 git，不新增视图契约） |
| `dsh-ui-tia-console` | 不变（只多了几个工具名） | — |

**P1 不改 UI 是刻意的**：面板的写边界是"只读、不改变任何落盘的东西"（`architecture.md` §1.1），
加项目切换器要新增一个"当前查看哪个根"的客户端状态，属于新交互，先让工具面跑通。

### 7.3 版本

参照工程**不进** `versions-view.json` 的版本时间线（它没有"我的版本"这个概念）。它在
git 里的形态是**每次 attach/refresh 的一次路径限定提交**：

```
Tia-Op: reference-attach
Tia-Ref: Line2
Tia-Ref-Project: Line2
Tia-Ref-Source: C:\Projects\Line2\Line2.ap17
```

`project_sync` / `project_commit` 的 pathspec 仍然只到 `source/<device>`（`commit.ts:194`
的 `commitPaths(root, [plan.relative])`），**不会**把参照快照卷进主工程的提交。

---

## 8. 工具面与契约

### 8.1 新增/改动的工具

| 工具 | 入口 / preset | 写什么 | 参数（默认值） | 主要错误码 |
|---|---|---|---|---|
| **`create_reference_project`** | `engineering-context` 主入口 / `leader` | `refs/<slug>/{tia,source,knowledge}`、索引、`.gitignore`、git 提交 | `source_project`（必填，`.ap17` 或 `.zap17`）、`dry_run: true`、`with_window: true`、`allow_upgrade: false`、`overwrite: false`、`knowledge: true`、`reopen_primary: true`、`rebuild_copy: false` | `reference_is_primary`、`reference_slug_conflict`、`project_already_open`、`primary_modified`、`source_project_not_found`、`archive_upgrade_required`、`reference_attach_failed`、`reopen_failed` |
| **`project_references`** | 同上 | 无 | —（只读） | `scope_unavailable` |
| **`reference_refresh`** | 同上 | `refs/<slug>/source`、`refs/<slug>/knowledge` | `reference`（必填）、`dry_run: true`、`with_window`、`knowledge: true` | `reference_not_found`、`primary_modified`、`sync_failed`、`reopen_failed` |
| **`copy_from_reference`** | 同上 | `.dsh/local/transfer/` + **主工程**（导入/编译） | `reference`（必填）、`object`（必填）、`kind: block`、`device`（多设备时必填）、`import_options: none`、`compile: true`、`dry_run: true` | `reference_not_found`、`copy_source_missing`、`copy_source_stale`、`primary_not_created`、`copy_target_mismatch`、`import_failed`、`compile_failed`、`project_read_only` |
| **`open_project`（改）** | `tia-openness-v17-min/tools` / `leader` | 工程会话状态 | 新增 `role: "primary" | "reference"`（默认 primary） | 失败码不变；新增 `project_read_only` 在外层 |
| **`project_status`（改）** | 同上 | 无 | 不变 | 结果加 `references[]` 摘要 |
| **（P2）`compare_with_reference`** | 同上 | 无（只读 diff） | `reference`、`object` / `device` | — |

**错误码新增**（`errors.ts` 与工具描述同步）：

| 码 | 含义 | 下一步（写进结果） |
|---|---|---|
| `reference_is_primary` | 要挂的工程就是本 workspace 的主工程 | 换一个工程，或直接用主工程工具 |
| `reference_not_found` | `refs/<slug>/` 不存在或没有索引 | 先 `create_reference_project`；`project_references` 列现有 |
| `reference_slug_conflict` | 同名目录已属于**另一个**工程 | 换 `source_project`，或显式处理旧目录（不自动删） |
| `primary_modified` | 主工程有未保存改动，不能安全让出 TIA | 先 `save_project`，再重试 |
| `primary_not_created` | 还没有主工程，无法作为复制目标 | 先 `create_engineering_project` |
| `copy_target_mismatch` | TIA 里打开的不是本 workspace 的主工程 | 关掉当前工程，重开主工程 |
| `copy_source_missing` | 参照源树里没有这个对象 | `reference_refresh`，或检查名字/设备 |
| `copy_source_stale` | 暂存文件的 sha256 与清单不符（树被手改/半截导出） | `reference_refresh` |
| `reopen_failed` | 参照操作完成但主工程没重开成 | 手动 `open_project`（结果里给路径） |
| `project_read_only`（控制器） | 参照工程的写操作被闸门拒绝 | 打开主工程再做写操作 |

### 8.2 新缝：`engineeringAccess.importObjects`

现在 `engineeringAccess` 只有导出/扫描/打开/另存（`access.ts` 的方法清单里**没有导入**），
而复制必须写主工程。补一个与 `import_blocks` **同一条代码路径**的方法（和 `rebuildSource` 的
做法一致：服务方法复用 `runOperation`，不另写一套）：

```ts
importObjects(
  files: readonly string[],
  options?: {
    importOptions?: 'none' | 'override'
    targetGroup?: string
    createGroup?: boolean
    mirrorGroups?: boolean
    swImportOptions?: readonly string[]
    deviceName?: string
    softwareName?: string
    verify?: boolean
    dryRun?: boolean
    signal?: AbortSignal
  },
): Promise<AccessCallResult>
```

约束与既有缝相同：操作级失败是数据（`ok:false` + 错误码），传输级失败抛出；`dryRun` 默认
`true`，真实写入必须显式。**旧版接口插件没有这个方法时**，`copy_from_reference` 报
`import_unsupported` 并让用户升级，不自己调控制器。

### 8.3 配置新增

| 配置 | 默认 | 含义 |
|---|---|---|
| `referenceDirName` | `refs` | 参照工程的根目录名（单个安全路径段，校验规则同 `tiaDirName`） |
| `referenceKnowledge` | `true` | attach/refresh 是否默认建图谱库（大工程单库约 450 MB，见 §10） |

---

## 9. 路径与 git 边界

| 路径 | 谁写 | 进 git | 可删 |
|---|---|---|---|
| `refs/<slug>/tia/**` | TIA（经 `saveProjectAs` / `retrieve`） | ❌ | 可以（原件还在，重取即可） |
| `refs/<slug>/source/**`（含账本/清单） | 接口插件（`rebuildSource` / `syncScan`） | ✅（每次 attach/refresh 一次路径限定提交） | 可以（重取慢） |
| `refs/<slug>/knowledge/**/*.db*` | 图谱插件 | ❌ | 可以（全量重建） |
| `refs/<slug>/.dsh/local/graph/*.json` | 图谱插件 | ❌ | 可以 |
| `.dsh/local/transfer/<id>/**` | 本插件 | ❌ | 可以（暂存） |
| `.dsh/local/lock.json` | sync / attach / refresh | ❌ | 进程真的不在了才可以 |

`.gitignore` 追加（由工具**只追加**，规则从配置推出，不硬编码 `refs`）：

```gitignore
# Reference projects: the same two boundaries as the primary project, one level down.
refs/*/tia/
refs/*/knowledge/**/*.db*
```

`refs/` 本身不进 ignore —— 参照源树是要提交的证据（"当时参照的是哪一版"）。

---

## 10. 失败模式与对策

| # | 失败/风险 | 触发 | 影响 | 对策 |
|---|---|---|---|---|
| 1 | 切换时主工程被关闭，用户以为工作丢了 | attach/refresh 让出 TIA | 恐慌 | 只在 `isModified === false` 时自动关；计划与结果第一行写"关了、会重开" |
| 2 | 重开主工程失败 | 副本被移动、版本变化、TIA 崩 | 会话失去主工程 | `reopen_failed` + 给出索引里的路径；参照结果保留 |
| 3 | 参照副本与原工程漂移 | 用户改了原件 | 分析基于旧代码 | 索引记 `sourceProject` + `attachedAt`；结果与 `project_references` 显式标注；`rebuild_copy` 重取 |
| 4 | 磁盘被图谱库吃满 | 多参照 × 每设备约 450 MB | 磁盘 | `knowledge: false` 默认不建？→ 见 B18；`reference_refresh` 可按设备建 |
| 5 | 模型手改参照源树 | `write`/`edit` 落在 `refs/**` | 树与清单不符 | 用前校验 sha256（`copy_source_stale`）；refresh 重建 |
| 6 | 设备同名（`PLC_1` 到处都是） | 两个工程各有 `PLC_1` | 混淆 | 根隔离；复制按参照自己的设备目录定位，导入按主工程的设备名解析 |
| 7 | 主工程被 `save_project(save_as_dir=refs/...)` 搬进参照根 | 模型误用 TIA 工具 | 主工程路径漂移 | ②层校验（打开工程的路径必须落在主工程目录）→ `copy_target_mismatch`；工具描述写明 save_as 会搬持久化位置 |
| 8 | 并发：两个会话同时切 TIA | 双击/两个 session | TIA 状态互相踩 | workspace 锁 + 控制器单实例；第二个等锁或报 `lock_held` |
| 9 | 跨版本参照（V15 工程） | 用户给老工程 | 打不开 | attach 阶段就要 `allow_upgrade`，与现有归档规则一致（`archive_upgrade_required`） |
| 10 | 参照对象在 TIA 里导不出（ProDiag 等） | 清单 `failures[]` | 复制没有源文件 | 复制前先查清单的 `failures`，报 `copy_source_missing` 并说明"该对象 TIA 不导出" |

---

## 11. 分阶段实施与验收

### P0 · 事实核对（不写产品代码，半天）

1. **Openness 只读能力**：已核对（§5.1）—— `ProjectComposition` 无只读重载；`OpenMode` 属库；
   `ProjectOpenMode` 是多用户主/次副本。**结论：只读只能自己拦。**
2. **同一 TIA 实例能否打开第二个工程**（决定 P3 是否值得做并发句柄）：临时实验（一次性小程序/临时
   控制器命令）→ 记录 `Projects.Count`、内存、两个工程的关闭语义。**在得到结论前按单工程做设计。**
3. **成本实测**：用 §6/§7 的真实源项目量一遍 attach（打开 / 另存 / 导出 / 建库 / 总耗时 / 磁盘），
   写进本文与工具描述，让计划里的估算有出处。

**退出条件**：2 有结论、3 有数。

### P1 · 只读参照 + 复制（核心，约 2–4 人日）

工程上下文（`packages/dsh-engineering-context`）：

- [ ] `config.ts`：`referenceDirName`、`referenceKnowledge`、参照根/源树/库/索引的路径函数、
      两条 ignore 规则（`refs/*/tia/`、`refs/*/knowledge/**/*.db*`）；
- [ ] `paths.ts`：slug 生成（复用 `folderName` + 撞名 `~2`）；
- [ ] 把 `create-project.ts` 里可复用的步骤抽出来（`retrieveIntoWorkspace` / `writeSourceIndex` /
      ignore 写入 / 建库调用），**不要复制那份 88 KB 的文件**；
- [ ] `tools/create-reference.ts`：attach（§4.1）+ 切换协议（§4.2）+ `rebuild_copy`；
- [ ] `tools/references.ts`：列举（§4.3）；
- [ ] `tools/reference-refresh.ts`：`syncScan` 增量 + 建库；
- [ ] `tools/copy-from-reference.ts`：§6.2 的 8 步（P1 不做闭包）；
- [ ] `tools/status.ts`：`references[]` 摘要；`tools/sync.ts` / `tools/commit.ts`：角色与路径校验；
- [ ] `errors.ts`：§8.1 的新错误码；`tools/index.ts` 注册（`leader` preset 自动可见）；
- [ ] 测试：attach 计划/执行、身份拒绝、切换（含 `primary_modified`）、slug 撞名、复制暂存与
      sha 校验、`project_read_only` 传播、参照根不存在时的旧行为（回归）。

接口插件（`packages/dsh-tia-openness-v17-min`）：

- [ ] 控制器：`OpenProject` 的 `role` 参数 + `_projectRole` + `readTiaSession.projectRole`；
- [ ] `OperationCatalog` 增加分类表 + 中央 `EnsureWritable`（分派处一处，不在 36 个操作里各写一遍）；
- [ ] `--self-test` 增加"每个操作恰有一类"的断言；
- [ ] `importObjects` 缝（§8.2）+ 工具描述与 `role` 说明；
- [ ] `npm run matrix:build`（改了 `controller/*.cs` 与 `src/tools.ts`，`matrix:check` 会拦）；
- [ ] 文档：`skills/tia-openness/SKILL.md`（路由 skill，<8192 字符）加"参照工程：`open_project(role:
      reference)`，写操作会被拒"；`docs/PROTOCOL.md` / `EXTENDED-SURFACE.md` 补 `role` 与
      `project_read_only`；
- [ ] 测试：role 默认值、写闸门（至少 `ImportBlocks` / `SaveProject` / `CompilePlc` 三条）、
      `importObjects` 的信封。

图谱插件（`packages/dsh-engineering-graph`）：

- [ ] `workspace.ts`：多根发现 + `projects[]` + `schemaVersion` 升版（旧字段保留）；
- [ ] `resolveDatabasePath`：跨项目唯一才自动解析；`DB_AMBIGUOUS` 的候选带 slug；
- [ ] 测试：单工程回归、双工程歧义、参照库存在但主工程没有库。

文档：

- [ ] 本文去"提案"标记；`PATH-RULES.md` 增 §2.3（参照根）与 §6 的两条 ignore；
- [ ] 该包 `docs/decisions.md` 加一条（A18–A20 定稿后）；
- [ ] 根 `README.md` §4.2（工程上下文插件的工具数 4 → 8）与 `roadmap.md` §1 同步 ——
      **状态只在这两处维护，改一处必须同步另一处**。

### P2 · 深度（约 2–3 人日）

- [ ] 依赖闭包（§6.3）+ `include_dependencies`；
- [ ] `compare_with_reference`：参照块 vs 主工程块（复用 `diff.ts` 的归一化，把"根"变成参数）；
- [ ] `knowledge_query` / 下钻的 `project` 参数；
- [ ] `dsh-ui-plc-source` 的项目切换器；
- [ ] 真实大工程（437 MB / 1155 块）上的端到端实测与成本记录。

### P3 · 可选

- [ ] 并发开两个工程（仅当 P0-2 证明可行，且内存/事务代价可接受）；
- [ ] `remove_reference`（`dry_run` 默认、只删 `refs/<slug>`）；
- [ ] 全局库通道：`LibraryComposition.Open(..., OpenMode.ReadOnly)` 是**真实存在**的只读入口
      （§5.1），可作为"从参照工程沉淀 master copy 到库"的另一条取用路径 —— 与本文不冲突。

### P1 验收清单（每条都要能对着输出核对）

1. 空 workspace 挂一个参照：`refs/<slug>/source/<device>/_manifest.json` 存在、文件数与清单一致、
   主工程目录未被创建；
2. 同一路径再挂一次：**刷新**，不产生第二个目录，不报 `reference_slug_conflict`；
3. 挂主工程自己：`reference_is_primary`，磁盘无变化；
4. 主工程开着且未修改时挂参照：计划里明确写"会关主工程并重开"，执行后主工程确实回来了；
5. 主工程有未保存修改时：`primary_modified`，**TIA 里工程仍开着**；
6. 参照开着时调 `import_blocks`（直接工具调用）：`project_read_only`，工程未被改；
7. `copy_from_reference`：暂存文件 sha256 = 参照清单 sha256；导入后主工程里出现该块；编译通过；
   参照树所有文件哈希不变；
8. `knowledge_workspace`：两条项目记录；`knowledge_query` 不给 `db_path` 且两个库都在 → `DB_AMBIGUOUS`；
9. git：`refs/<slug>/source` 进了提交（带 `Tia-Ref` trailer）；`refs/<slug>/tia/` 与库未进；
   `project_sync` 的提交仍只含 `source/<device>`；
10. 手工改一个参照源文件后再复制：`copy_source_stale`；`reference_refresh` 后恢复。

---

## 12. 备选方案与否决理由

| 方案 | 内容 | 结论 |
|---|---|---|
| **A. 外部参照（另一个受管 workspace）** | B 保持自己的 workspace；A 只读它的 `source/` 与 `knowledge/`，复制用 `import_blocks` 的绝对路径 | **可行且最便宜**（§12.1）。代价：发现、出处、只读只能是约定/沙箱；B 由自己的会话维护。**如果 B 会持续被维护，这是首选** |
| **B. 全局库 / master copy** | 把参照工程的对象沉淀成 `.al17` 全局库，用 `OpenMode.ReadOnly` 打开取用 | 只覆盖"复用对象"，**不覆盖**"读全项目、建图谱、回答另一个项目怎么实现"。**保留为 P3 的补充通道**，不替代本文 |
| **C. 并发打开两个工程** | 控制器同时持有主工程与参照两个 `Project` 句柄 | TIA 实例能否这么开**未实测**（P0-2）；即便可行，内存翻倍、事务/关闭语义、控制器全部单工程假设都要重审。**P3 再评估** |
| **D. 把参照整包复制成一个独立 workspace** | 参照工程 = 另一个完整 workspace | 与 A 的差别只在"谁维护它"：A 是现成的受管 workspace，D 是再复制一份。**否决**（多一份磁盘与同步，没有新能力） |
| **E. 只把需要的对象导入成 master copy 到主工程** | 不挂整项目，只挑对象 | 失去"看全貌、查实现"的价值。**否决**（B 是它的可控版） |

### 12.1 轻量路线：把受管 workspace 直接当外部参照（2026-11-04 新增）

**触发**：参照项目本来就是另一个受管 workspace（有 `source/`、`knowledge/`、`.git`）。
那么"拿到全部源文件、有 knowledge 解析、能复制过来"这三件事**今天就能做**，不需要新插件代码：

| 动作 | 怎么做 | 依据 |
|---|---|---|
| 读 B 的源文件 | `read` / `glob` / `grep` / `pwsh` 接受**绝对路径**（相对路径才从 workspace 解析） | 本会话从仓库根读 `~/.dsh/AGENTS.md` 成功 |
| 查 B 的图谱 | `knowledge_query` 与四个下钻工具的 `db_path`：**绝对路径原样使用** | `dsh-engineering-graph/src/workspace.ts:454` 的 `chooseDatabase`；引擎 `SqliteConnection(DataSource = dbPath)` |
| 实测 | 对 `SWT1_HF48e_Pilot\knowledge\PEI_1\PEI_1_knowledge.db` 跑 `SELECT COUNT(*) FROM graph_nodes` | **85,967 个节点 / 38 ms**（`--call Query`，从本仓库目录执行） |
| 复制到主工程 | `import_blocks(import_paths: [B 的绝对文件/目录])` | 控制器只校验存在（`controller/OperationsPlc.cs:1446-1464`），没有 workspace 概念 |

**结论：读、查、取用没有硬限制。** 但"没有硬限制"不等于"没有代价"，缺口只有三个 ——
而且都不是"再建一套项目根"能自然解决的：

| 缺口 | 事实 | 轻量补法 | 规模 |
|---|---|---|---|
| **发现 / 寻址** | A 的模型不知道 B 存在；`knowledge_workspace` 只扫 A 的 cwd；不给 `db_path` 时 `knowledge_query` 也只解析 A | `.dsh/references.json`（name → path）+ 一个只读的 `reference_workspace` 工具：校验 B 的结构，返回它的 project/device/db 路径；`knowledge_workspace` 加 `workspace_path` 参数 | 小 |
| **新鲜度 / 出处** | B 的 `source/` 是 B **上次导出**的快照；A 看不到 B 的 TIA 是否又变了，也不会记录"这条结论引自 B 的哪一版" | 指针里记 B 的 `exportedAt` / `stateId` / git HEAD；结果里标 "as of …"；复制时把出处带进暂存与结果 | 小 |
| **只读** | 轻量路线**从不打开 B** —— 所以控制器的角色闸门根本保护不到 B。只读只能是"约定"或文件系统级（会话文件策略 / ACL） | 写进文档与工具描述；要硬保证就让会话跑在 `workspace-write`（对 DSH 工具的写是沙箱硬拦；控制器/TIA 子进程是否也受沙箱约束**未实测**），或对 B 目录设 ACL | 零代码 / 人工 |

另外两个"不是原则、但会被感知到"的差异：

- **面板看不见**：PLC Blocks 与提及注解走宿主 `workspaceFiles`，只认会话 workspace
  （`ui-plc-source` 的错误表里有 `workspace-file/outside-workspace`），B 的块不会出现在 A 的侧栏；
- **A 不能替 B 刷新**：同一宿主一个控制器、一次一个工程。B 的源树要么由 B 自己的会话维护，
  要么 A `open_project(B 的 .ap17)`（会与 B 的会话抢 TIA）。

**用 `import_blocks` 直接取用 B 的三个坑**（轻/重都一样）：

1. 传**目录**会递归全量导入（`recursive: true`）；只想拿一个块就传具体文件；
2. 同名/同号对象已在 A 里存在时，要么 `import_options: "override"` **且**目标用户组一致
   （用户组里的块从根组覆盖不了，见 `import_blocks` 的 `target_group` 说明），要么先 `target_group`；
3. **没有 sha 校验与出处**：文件读完之后 B 的会话又重导出，你导进去的就是另一版。重路线用清单
   sha + provenance 补这一点；轻量路线只能靠"读完立刻导"。

**轻量路线的总成本约 0.5–1 人日**（一个枚举/校验工具 + `knowledge_workspace` 参数 + 文档与测试；
**不含** §15.4 的 `import_preflight`），没有 `refs/` 项目根、没有 `role` 参数、没有
`importObjects` 缝、没有图谱多根发现。

**什么时候必须走重路线（§3–§11）**：

| 需求 | 轻量 | 重 | 说明 |
|---|---|---|---|
| 读 B 的源文件 / 查 B 的图谱 | ✅ | ✅ | 轻量已够 |
| 把 B 的块导进 A | ✅ | ✅ | 轻量用绝对路径；重多一层 sha/出处 |
| A 的 agent **自己刷新** B（B 没开会话时） | ❌ | ✅ | 需要打开 B 的工程，只有重路线的切换协议能做 |
| 参照进 A 的 git 快照 / 面板 / 统一列举 | ❌ | ✅ | 轻量下 B 是"另一个 workspace"，不是 A 的一部分 |
| 只读的**可验证保证** | ❌（约定/沙箱） | 🟡（只保证 A 里的副本，不保证 B 本体） | 见 A19 |
| 参照与主工程**同一套**路径/索引/版本语义 | ❌ | ✅ | |

**倾向（2026-11-04 按真实会话修订，见 §15）**：**不建 `refs/` 项目根**。只做三件小事：
① `workspace_describe(workspace_path)`（不需要 TIA，读索引/清单/证据/库/git）+
修 `project_status` 在没有 TIA 工程时的误导输出；② `import_preflight`（语言集、依赖顺序、
同名对象）；③ 出处约定（`Reference: <workspace>@<git-head>`）。只有出现 §15.5 列的三种情况，
才回头考虑重路线。

---

## 13. 待决问题

> **2026-11-04 复盘（§15）之后，这里的倾向已经改成"不做 refs 项目根"**；下列选项保留为决策记录。

| 编号 | 问题 | 本方案的倾向 |
|---|---|---|
| **A18** | 参照走"外部受管 workspace"（轻量）还是"同 workspace 的 `refs/` 项目根"（重）？ | **不做 refs**：加 `workspace_describe` + `import_preflight` + 出处约定（§15.4） |
| **A19** | 只读做到"约定"还是"保证"？ | 约定 + 默认会话策略（本次会话 `workspace-write` 下 0 次写 B，沙箱已拦）；不动控制器 |
| **A20** | "复制到另一边改"要不要封装？ | **不封装**：本次 12 次 `import_blocks` 直接成功；失败源于语言/依赖，加 `import_preflight` 即可 |
| **B18** | 参照源树进不进 git？图谱库默认建不建？ | 不建 refs 后不适用；B 的 git 由 B 自己的流程维护 |

---

## 14. 对既有决策的影响

| 决策 | 影响 |
|---|---|
| **D5**（session ↔ workspace） | **不变**：workspace 仍是作用域。轻量路线是**用户点名的显式跨 workspace 读取**（不改变默认，也不产生隐式漂移）；重路线把参照放成 workspace 内的从属根 |
| **D22**（删注册表，目录即记录） | **不变**。列举 = 读 `refs/*/source/_dsh-engineering-context.json`，不引入 `references.json` |
| **D23**（一个 workspace 一个工程） | **不变**（不建 refs，无需注解）。跨 workspace 读取是"用户点名的显式动作"，不改变"一个 workspace 一个工程" |
| **D24**（另存用目录名命名） | **不变**（重路线才会用到它命名参照副本） |
| **D25**（图谱建库必须是软的） | **不变**，参照照抄这条 |
| **D13**（从不 `git init`） | **不变**，attach 只提交不初始化 |
| **新增决策（待 A18–A20 定稿）** | ① 项目根 + 角色模型；② 控制器写闸门与操作分类；③ 复制走"暂存 → 导入 → 编译"，不直接改 `source/` |

---

## 15. 真实会话复盘：SWT1 ← SWT2 的 VOC 导入（2026-11-04）

会话 `session-3f8b696e-7798-4f8d-b1fb-c8c42f810a4f`，工作区 A = `SWT1_HF48e_Pilot`（设备 `PEI_1`），
参照 B = `SWT2_PEI_1026_Night`（设备 `Sino_PEI`）。会话策略 **`workspace-write`**、审批 `ask`。
任务：在 B 里找 VOC 门控块并评估/执行导入 A。**已完成**：17 个对象导入、编译通过、提交 `4af0a95`。

### 15.1 事实

| 项 | 值 |
|---|---|
| 时长 / 工具调用 | 约 **2 h 26 min**（13:44–16:10）/ **154** 次 |
| 跨 workspace 读 | `knowledge_query` **34** 次（B 19、A 15，**全部显式传 `db_path`**）；`hardware_inventory(aml_path = B\hardware\...)`；`read`/`pwsh` 读 B 的索引、清单、XML |
| 跨 workspace 写 | **0 次**（5 次 `write` 全在 A 的 `temp/` 与交付文档） |
| 导入 | `import_blocks` **12** 次，其中**直接以 B 的绝对路径为源**也成功过（失败原因不是"路径不允许"） |
| 结果 | 新增 17（10 块 + 7 UDT）、修改 5；校验和 `52 4D…` → `11 05…`；图谱 fresh（87,586 节点）；`project_status` clean；commit `4af0a95` |

### 15.2 什么工作得很好（不需要新功能）

- B 的 `source/`、`knowledge/`、`hardware/` 按绝对路径直接可用；
- 跨库查询只要显式 `db_path`，与同库查询没有区别（19 次全部成功）；
- 直接 `import_blocks(import_paths: [B 的 XML])` 可行；
- `workspace-write` 下没有任何一次对 B 的写 —— **只读在这个策略下天然成立**。

### 15.3 真正的摩擦（以及参考项目能不能解决）

| 摩擦 | 证据 | refs 能解决吗 |
|---|---|---|
| **发现/描述** | 开头约 10 次 `pwsh` 手工列父目录、读 B 的索引、找库、数 XML；用户的原话也是"**如果你能访问**其他 workspace…" | ❌（它正是 refs 想替代的东西） |
| **`project_status` 在没有 TIA 工程时误导** | 13:44 与 15:09 两次输出 `no device / manifest missing / Git: not a repository`，而磁盘上 `_evidence.json`、`_manifest.json`、`.git` 都在（14:36 的输出证明）。代码原因：`device === null` 时 `repository` 保持 `false`，evidence/manifest 也按设备解析（`status.ts:341-347`、`device.ts:97-103`） | ❌（状态工具缺陷，与 refs 无关；**已修**：现在报 `not checked (no open project)`） |
| **导入的语言集不一致** | B 的 XML 带空的 `th-TH` 多语言项，A 未激活泰语 → `Cannot import multilingual text with culture 'th-TH'`；要写脚本剔除 | ❌（任何跨项目导入都会遇到） |
| **依赖顺序** | 先导 `typeCTRGetPEI_Voc` → `Data type typeCTRPutPEI_Voc is unknown`，须先 Put 后 Get | 🟡（闭包能算，但本次用图谱也查到了） |
| **块号"冲突"是伪问题** | 花了几次调用分析 365/470/497；用户指出 **TIA 导入会自动分配块号**，名字才是身份 | ❌（知识/文档缺口） |
| **TIA 会话占用** | UI 已开着工程 → `open_project` 拒绝、`adopt_open_project` 5 次；UI 并发编辑 → 控制器崩 **2** 次（`controller_exited`） | ❌（重方案同样受单实例约束，切换更糟） |
| **出处** | 提交信息没有"来自 SWT2 的哪一版"，只在 md 里手工写 | 🟡（一条约定即可） |

### 15.4 结论

对"B 是受管 workspace、A 只读 B 的导出物"这个模式：**refs 项目根（§3–§11）没有带来本次会话需要
的任何能力** —— 反而会多复制一份 725 MB 的库、把 1155 块再导出一遍，并把"只读"变成需要控制器
角色来维持的问题。值得做的只有三件小事：

| # | 改动 | 规模 |
|---|---|---|
| 1 | **`workspace_describe(workspace_path)`**：不需要 TIA，读索引/清单/证据/库/git，返回项目、设备、源树、库 freshness、硬件 AML、HEAD、dirty；**顺带修 `project_status` 的误导文案**（无工程时写"not checked (no open project)"，`Git` 不要报 `not a repository`） | ~0.5 天 |
| 2 | **`import_preflight`**：真导入前用本地 XML + 目标工程语言集/已有对象，报告"language culture 不在目标、依赖缺失/顺序、同名对象冲突"；块号交给 TIA | ~0.5–1 天 |
| 3 | **出处约定**：导入结果与提交信息带 `Reference: <workspace>@<git-head>`（不新增工具） | ~0.1 天 |

**状态（2026-11-04，已实现）**：三项都已落地 ——

- `workspace_describe(workspace_path)`（`@voltarenyah/dsh-engineering-context`，主入口 + `/status` 入口）；
- `import_preflight`（同一插件；经接口插件新增的 `readProjectLanguages` 缝读目标语言，`listObjects` 读目标对象）；
- `import_blocks(reference=...)` 回显出处、`project_commit(reference=...)` 追加 `Reference:` trailer；
- `project_status` 在没有 TIA 工程时不再把"没检查"说成"没有"（`Evidence/Manifest/Git` 都改为 `not checked (no open project)`，`git.repository` 为 `null`）。

验证：engineering-context 151 项单测全绿（新增 23 项）；接口插件 112 项（111 通过 / 1 跳过，控制器不在时跳过）；
`matrix:check` 与 `skills:check` 通过。**仍未做**：把出处自动写进提交（仍需调用方把同一个 `reference` 传给
`project_commit`）。

外加一条文档修正：`skills/blocks` 要写清"块号由 TIA 分配、导入按名字识别"（本次为此多花了分析）。

### 15.5 这次复盘**没有**证明的事

- **B 不是受管 workspace**（只有 `.ap17`）：仍要导出，重方案或一次性 `open_project` 才有意义；
- **B 的源树可能过期**：本次 B 的 `exportedAt` 是 `2026-11-04T04:01Z`，A 从 13:44 开始，中间 B 有无
  变化未核；若 B 长期不由会话维护，轻量方案要补新鲜度提示；
- **面板要显示 B 的块**、或 **B 要进 A 的 git 快照**：仍需 UI 或重方案；
- 只验证了**同一个受管 workspace 对**、同机、同 TIA 版本、B 源树成熟这一种组合。
