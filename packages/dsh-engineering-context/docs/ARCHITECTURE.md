# 核心架构：工程上下文插件

> **状态：设计定稿；P0/P1 已按 D22 删除，现行实现是 `create_engineering_project` / `project_status` /
> `project_sync` 三个工具（S2 见 D26）。**
>
> ⚠️ **2026-10 起本文有相当一部分是"目标态"而不是现状**：原先注册的
> `eng_status` / `eng_project` / `eng_scope` / `eng_version`，以及它们下面的工程注册表与内部 git
> 版本层，都已在 [`decisions.md`](decisions.md) **D22** 中删除。现行布局（`tia/` + `source/` +
> `.dsh/local/`）以 [`PATH-RULES.md`](PATH-RULES.md) 为准。下文凡标 ❌ 或"P2"的段落是历史设计
> （`eng_changes` / `eng_export` 已被 `project_sync` 取代），保留是为了 P3 的论证链。

> 本文描述这个插件"要做成什么样"：定位与边界、核心架构、主要功能、实现方式、验收口径与风险。
> 实现进度见 §10；做到哪了只在 [`docs/roadmap.md`](../../../docs/roadmap.md) §3 与
> 根 [`README.md`](../../../README.md) §2 两处维护。
>
> - 本文的接口名、工具名、字段名都是**设计值**，实现时可以改；改了必须同步本文与该包的
>   [`decisions.md`](decisions.md)（实现期的取舍记在该文件的「P0 实现期的决定」一节）。
> - 引用代码/运行时一律带 `path:line`；凡属**推断**都显式标注，不与"已实测"混写。
> - 与发行版级文档的关系：[`docs/architecture.md`](../../../docs/architecture.md) §4.2 给出这个插件的
>   职责与边界，[`docs/decisions.md`](../../../docs/decisions.md) D5–D7、D12 给出已定的取舍，
>   本文把它们落成可实现的形态。
>
> 本包**已登记进 profile 蓝图**（`dsh.profile.bundles` 与 `preset-leader`），用
> `scripts/start-env.ps1` 加载；本包自己的 `check` 脚本仍是最快的验证方式。

---

## 1. 一句话定位

**它是宿主 workspace 之上的一层"工程作用域"：把 TIA 里正在做的那个工程放进 workspace，
并把它的源文件读出来。**（"工程变更"（P2）与"变更台账"（P3）仍是目标态，见 §10。）

面对用户**多个工程共存**的局面，它保证会话里的任何结论都能回答"这是哪个 workspace 的哪个工程"，
并为将来的变更检测准备好**可读、可版本化**的文本产物。它不产出工程语义、不碰设备。

### 1.1 边界（硬约束）

| 它做 | 它**不做** | 依据 |
|---|---|---|
| 解析作用域（workspace + 目标路径） | **不解析 XML、不建图**（只经缝 B 触发图谱插件的建库服务） | [`docs/architecture.md`](../../../docs/architecture.md) §4.2 边界；那是工程知识图谱插件 |
| 管 workspace 内的路径规则（`tia/` + `source/` + `knowledge/` 的 git 边界） | **不直接驱动 Openness、不起控制器** | §4.2 / §9「写入只有一个通道」；接口插件族是唯一通道 |
| 经缝 A 让 TIA 另存工程、重建源文件树；经缝 B 触发图谱建库 | 不做**文件级、按轮次**的变更记录 | 宿主已有 `dsh-workspace-changes`（见 §2.1） |
| （P2）消费接口插件族的**指纹**做工程级变更检测 | 不做版本管理 | 交给用户自己的 git（D22） |
| （P3）维护工程变更台账（期望二） | 不做 agent 的会话计划清单 | 那是 `@deepseek-ai/dsh-tool-todo` |
| 决定**范围** | 不决定**含义** | §4.2 边界 |

### 1.2 它**依赖**接口插件族（2026-10 起）

唯一的工具 `create_engineering_project` 要做的两件事（另存、重建源文件树）都必须由接口插件族执行，
所以组合里没有那个插件时它返回 `tia_access_unavailable`，**不降级**成本地版另存 ——
"没有 TIA 也能用"的那部分（作用域 + 注册表 + 内部 git 版本层）已随 D22 删除。

**保留的独立性**：它不 import 接口插件的包（按服务名取，D10），也不知道控制器与进程的存在；
除 `@deepseek-ai/*` 外没有任何运行时依赖，接口面变了只影响 `src/access.ts` 一个文件。

---

## 2. 前提：宿主已经提供了 workspace

这一节是本设计的地基。**D5 的 workspace 模型不需要插件自己实现一遍**，因为宿主里已经有了，
而且判定规则与本插件需要的完全一致。

### 2.1 宿主既有能力（已核对运行时，非推断）

| 能力 | 服务/包 | 证据 |
|---|---|---|
| workspace 注册表 | `ctx.workspaceRegistry`（`@deepseek-ai/dsh-workspace`） | `dsh-workspace/lib/index.js:374` 的 `super(ctx, "workspaceRegistry")` |
| 建 workspace（真实目录，`realpath` 归一） | `create(path, title?)` | 同上 `:406-410` |
| **路径 → workspace**（不改状态） | `resolveByPath(path)` | 同上 `:635-638` |
| 取 / 列 | `get(id)` / `list()` | 同上 `:443-458` |
| Workspace 实体 | `path` / `title` / `createdAt` / `updatedAt` / `sessionIds` / `status()` | 同上 `:85-160` |
| **会话归属判定** | session 归属某 workspace ⇔ 其 `header.cwd` 归一后**等于**该 workspace 路径 | 同上 `:122`（`if (cwd !== this.record.path) throw`） |
| 工具调用期能读到会话 cwd | `exec.agent.session.header.cwd` | `dsh-tools/lib/index.js:1423`；`exec` 的构造见 `:3137-3150` |
| 临时工件落盘 | `ctx.spillStore.saveText({owner, source, suggestedName, content})` → `{locator, bytes, retrievalHint}` | `@deepseek-ai/dsh-spill` README |
| 宿主侧持久 KV（schema 校验） | `ctx.storageDomain.open(spec)`；`defineDomain` + `domainTable` | `@deepseek-ai/dsh-storage-domain` README |
| 跨插件服务缝 | cordis `Service` 基类 + `ctx.get(name)` / `ctx.inject([...], …)` | `dsh-workspace/lib/index.js:3,374`；`ctx.get("sessions")` 见 `:427` |

**两条由此推出的规则**（已写进 [`decisions.md`](decisions.md) D1/D10）：

1. 作用域根 = **`exec.agent.session.header.cwd`**，宿主身份由 `resolveByPath(cwd)` 认领；
   **绝不新建第二套 workspace 概念**。
2. **只读宿主的 workspace 注册表**：只调 `resolveByPath` / `get` / `list`，
   **从不**调 `create` / `delete` / `attachSession` / `archiveSession` —— 建 workspace 是用户在 GUI 的
   显式动作（D5），插件改宿主状态会让"隔离"变成插件自己说了算。

### 2.2 两个会撞车的既有名词（必须避开）

| 宿主已有 | 它是什么 | 与本插件的关系 |
|---|---|---|
| `@deepseek-ai/dsh-workspace-changes` | **按轮次、文件级**变更：git 工作树快照 + 整文件捕获；服务 `ctx.workspaceChanges.summary/diff(sessionId, seq)`；会话销毁即失效 | 本插件要的是**工程对象级、跨会话、带基线**的变更。**不复用，也不重名** —— 本插件的东西不许叫 `workspace_changes` |
| `@deepseek-ai/dsh-tool-todo` | **会话内**的 agent 计划清单：单 owner、每次**整表替换** | 期望二的"工程变更台账"是**工程对象的变更记录**，跨会话、可指向版本。**不要**拿 `todo_write` 顶替 |

---

## 3. 核心架构

```
                     session（cwd 即 workspace 目录）
                                  │
     exec.agent.session.header.cwd ───┐
     ctx.workspaceRegistry.resolveByPath(cwd) ───┐        ← 宿主已有：只认领，不重建
                                  ▼               ▼
                 ┌────────────────────────────────────────────┐
                 │ ① 作用域 Scope（纯函数，fail-closed）        │
                 │    workspace → project → branch → version  │
                 └──┬────────────┬────────────┬────────────┬──┘
                    │            │            │            │
          ┌─────────▼──┐  ┌──────▼─────┐  ┌───▼──────┐  ┌──▼─────────┐
          │② 工程注册表│  │③ 变更引擎  │  │④ 版本层  │  │⑤ 变更台账  │
          │  Registry  │  │  Change    │  │ Version  │  │ ChangeCtx  │
          └─────┬──────┘  └──────▲─────┘  └───┬──────┘  └──┬─────────┘
                │                │            │            │
                │         【缝 A】可选服务注入 │            │
                │                │            │            │
                │         ┌──────┴───────┐    │            │
                │         │ 接口插件族   │    │            │
                │         │ 指纹/开关项目 │    │            │
                │         │ 导出/编译/写回│    │            │
                │         └──────┬───────┘    │            │
                ▼                ▼            ▼            ▼
          _dsh-eng/*.json   工件 JSON      .git/      change-context.json
          （可携带/可进 git） 基线/变更集   导出物入库    （跨会话）
                                  │
                                  ▼
                 ┌────────────────────────────────────────────┐
                 │ ⑥ 工作流工具面（4 个：1 已实现 + 3 待做；≤4KB）│
                 │    摘要 + 计数 + 工件路径 + 下钻方式         │
                 └────────────────────────────────────────────┘
```

> ⚠️ 上图里 **② Registry 与 ④ Version 已随 D22 删除**；`_dsh-eng/*.json` 与 `.git/` 也不再由本插件
> 写入（`.git/` 仍可由用户自己建）。现行布局是 `tia/` + `source/`，见
> [`PATH-RULES.md`](PATH-RULES.md)。

| 层 | 职责 | 不做什么 |
|---|---|---|
| ① Scope | 解析作用域与 workspace、路径规则、越界校验 | 不读写工程内容 |
| ❌ ② Registry | ~~工程登记（源/工作副本/导出物/工件/VCS 角色）~~ | 已删除（D22）：布局本身就是记录 |
| ③ Change | 指纹 ↔ 基线 → 变更集；面 → 编译相关性 | 不算哈希当变更依据（见 §5.1） |
| ❌ ④ Version | ~~内部 git：commit/log/diff/materialize~~ | 已删除（D22）：交给用户自己的 git |
| ⑤ ChangeCtx | 工程变更台账（对象级、带版本、跨会话） | 不是 agent 计划清单 |
| ⑥ Tools | 4 个工作流工具（1 已实现）+ 返回契约 | 不按控制器操作 1:1 铺工具 |

---

## 4. 作用域模型

### 4.1 四元组

任何工具结果都必须带上作用域四元组：

```jsonc
{
  "scope": {
    "workspace": { "path": "C:\\work\\pei", "registered": true, "title": "PEI" },
    "project":   { "id": "pei-sinoarp", "title": "PEI SinoARP" },
    "branch":    "main",
    "version":   { "kind": "commit", "id": "a1b2c3d", "dirty": false }
  }
}
```

- `workspace.registered`：`resolveByPath(cwd)` 命中宿主注册表为 `true`；未命中为 `false`
  并仍以 cwd 为根（理由见 [`decisions.md`](decisions.md) N2）。
- `version.dirty`：工作副本/导出物有未提交改动时显式置位 —— 否则"这是哪一版"是假的。

### 4.2 解析算法（纯函数）

```
resolveScope(exec):
  1. root = realpath(exec.agent.session.header.cwd)        // 缺 cwd → scope_unavailable，fail-closed
  2. ws   = ctx.get('workspaceRegistry')?.resolveByPath(root)   // 可选：服务缺席则 registered=false
  3. registry = readEngRegistry(root)                       // 不存在的按 §4.3 规则处理
  4. project  = registry.current ?? (显式参数 ? 按名/按 id 查 : 唯一候选 ? 唯一候选 : ambiguous)
  5. branch/version = 内部 git 查询（§5.4）；无 VCS 时 version = { kind: 'none' }
  6. 断言 root 是 root 下一切路径的前缀（§4.3）
```

### 4.3 fail-closed 规则

| 情形 | 行为 |
|---|---|
| 缺 `session.header.cwd` | 拒绝执行，返回 `scope_unavailable`（不猜 cwd） |
| 目标路径不在 cwd 之下（含 `..`、符号链接逃逸） | 拒绝执行，返回 `path_outside_workspace`（比较用 `realpath`，不是字符串前缀） |
| 组合里没有接口插件 | 返回 `tia_access_unavailable` 并指出缺哪个服务（本插件从不自己连 TIA） |
| 控制器没在跑 / TIA 没开工程 | 返回 `tia_controller_not_running` / `tia_project_not_open`，**一个操作都不发** |
| 服务调用本身失败（控制器缺失、超时、协议不符） | 返回 `tia_unreachable`（操作级失败才是数据） |
| TIA 拒绝另存 | 返回 `save_failed`，带上 TIA 自己的错误码与消息 |
| ❌ 注册表不存在 / 损坏 / 当前工程未定 | **已随 D22 删除**：没有注册表，也就没有这四种状态 |

> 设计口径：**宁可拒绝，也不猜。** 与 [`docs/architecture.md`](../../../docs/architecture.md) §9
> 「默认安全：破坏性操作 fail-closed」「准确优先于覆盖」一致。

---

## 5. 关键机制

### 5.1 变更引擎（核心，D6 / D9）

```
resolveScope() → project + .ap17 + exportDir + baseline
   │
   ├─ 1. 经【缝 A】让 TIA 打开 .ap17（复用已开会话，不自开自闭）
   ├─ 2. listObjects({ categories: [blocks, types], includeFingerprints: true })
   │        └─ **抬高 max_items 并如实读 `truncated`**：控制器没有 offset，翻不了页
   ├─ 3. 与基线逐**面**比对 → changed / added / removed + 变化的面
   ├─ 4. 变更集落盘成工件 changes-<ts>.json（全量进工件）
   └─ 5. 返回 ≤4KB：计数 + 面直方图 + 前 N 条 + 工件路径 + 下钻提示
```

四条必须做对的细节：

1. **没有"翻页"这回事（已实测更正）。** 控制器的 `max_items` **只能截断** ——
   `controller/OpennessHost.Plc.cs:152,166` 在超过上限后**继续累加 `total` 但停止添加 items**，
   没有任何 offset/skip 参数，所以"请求下一页"不存在。唯一正确的做法是
   **把上限抬到预期规模**（接口插件族的 `listObjects` 默认已抬到 1000），并**如实传播 `truncated`**：
   调用方看到它就是"我没取全"，要么用更大的上限重试、要么把"未覆盖"写进结果。
   顺带更正：[`docs/tool-surface.md`](../../../docs/tool-surface.md) §5.1 写的"按片请求"
   在这一版控制器上也做不到（那份是提案）。
   另：渲染层还把列表砍到 20 行（同处 `MAX_LISTED`），所以工作流层必须**绕开渲染层**取值。
2. **指纹是唯一硬依据，`sha256` 绝不能当变更键。** 现有 manifest 的 `sha256` 是"写出文件的字节
   哈希"，而文件里含 `<DocumentInfo><Created>`（每次导出都不同）：
   [`MANIFEST-GAP-ANALYSIS.md`](../../dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md)
   §3 已用实验否定它作为变更检测手段。它的正当用途只有"同一份 manifest 内的完整性审计"。
3. **指纹的 `id` 是"面名"不是对象 id。** 每项形如 `{id, value}`，`id ∈ Code` / `Interface` /
   `Comments` / `Properties` / `Texts` / `Alarms` / `Supervisions` / `TechnologyObject` /
   `Events` / `TextualInterface` / `LibraryType`（[`docs/decisions.md`](../../../docs/decisions.md) D6；
   插件描述见 `packages/dsh-tia-openness-v17-min/src/tools.ts:1588-1590`）。**不要把面名当对象键。**
4. **面 → 编译相关性的映射**（本插件新增的解读，属设计值）：

   | 面 | 默认判为 | 说明 |
   |---|---|---|
   | `Code` | **编译相关** | 代码逻辑变了 |
   | `Interface` / `TextualInterface` | **编译相关** | 接口变了，调用方可能受影响 |
   | `LibraryType` | 需人工判断 | 类型来源变化 |
   | `Comments` / `Texts` | 非编译相关 | 注释/文本 |
   | `Properties` | 需人工判断 | 属性（含 know-how 保护等） |
   | `Alarms` / `Supervisions` / `Events` / `TechnologyObject` | 需人工判断 | 按对象域判断 |

   结果里必须**说明**这个判定，而不是让模型自己猜（[`docs/architecture.md`](../../../docs/architecture.md)
   §4.1「调用后拿到的数据怎么用」）。

**一个副产物**：标签表**没有指纹**（D6 记录的手册事实），所以变更检测对标签表**能力缺失**，
结果里必须显式说明"标签表不在本报告的覆盖范围内"，不能让它看起来"没变"。

### 5.2 身份键与降级路径（D7 缺口，本设计最大的外部风险）

期望三（跨版本认出同一对象）依赖 D7「TIA 导出时提供的唯一 id」。现状是三项都缺：

| 事实 | 证据 |
|---|---|
| V17 **没有** `ObjectIdentifierProvider`（V21+ 才有） | [`docs/decisions.md`](../../../docs/decisions.md) D7；`skills/performance-and-caching/SKILL.md:117` |
| 现有 manifest **没有** `id` 字段 | [`MANIFEST-GAP-ANALYSIS.md`](../../dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md) §2「稳定身份 id ❌ → 缺口」 |
| 指纹的 `id` 是面名，不是对象 id | §5.1 第 3 条 |

**降级路径（设计已定，不假装问题不存在）**：

| 阶段 | 身份键 | 代价 |
|---|---|---|
| 现在（默认） | `category + group + name` 复合键 | **改名即断链**，必须显式承认 |
| 兜底 | 同一基线里"消失 A、出现 B"且结构相似 → 产出 `rename-candidate` | 进变更台账等人工确认 |
| 目标 | 接口插件族在导出物/指纹结果里补 `tiaObjectId`（并实测其稳定性） | 需要接口插件族一个小改动 + 一次实测 |

**纪律**：任何"身份不确定"的对象，在 `eng_changes` 结果里都要**带标记**，
不许静默按名字对齐 —— 身份键错会让跨版本关联**静默断链**（D7 的原话）。

### 5.3 【缝 A】与接口插件族的服务契约（已定）

接口插件族的边界是"唯一与工控软件对话的插件"，而指纹**必须开项目**才拿得到（D6）。
所以工程上下文插件必然要向接口插件族要一项**能力**（不是文件）。**决定：接口插件族注册一个可选的 cordis 服务**，
工程上下文插件按名取用。

> **状态：✅ 已实现（接口插件族侧）。** 服务名 **`engineeringAccess`**，由
> `packages/dsh-tia-openness-v17-min/src/access.ts` 提供，在 `apply()` 里构造，随该插件的
> 卸载一起消失。接口插件族的 [`docs/decisions.md`](../../dsh-tia-openness-v17-min/docs/decisions.md) **D20**
> 是提供方那一侧的权威描述；**本节的接口面是消费方的镜像**，两边改一处必须改另一处。

实际的接口面（接口插件族的 `src/access.ts` 是权威；工程上下文插件 **不 import 它**，只按名取服务并自行声明形状，D10）：

```ts
// 由接口插件族提供；工程上下文插件只使用这一面。ctx.get('engineeringAccess') 取不到就返回 tia_access_unavailable（D22 起不再是"降级"）。
interface EngineeringAccess {
  readonly name: string                       // 'engineeringAccess'
  status(): {
    available: boolean                        // 值不值得试（exe 在、且 Openness 未被判为不可用）
    reason: string | null
    state: string; exePath: string; exeExists: boolean
    probed: boolean                           // 控制器是否真的探过 Openness
    controller: JsonRecord                    // 原始快照，供诊断
  }
  openProject(path: string, opts?: { withWindow?: boolean; allowUpgrade?: boolean; dryRun?: boolean; signal?: AbortSignal }): Promise<AccessCallResult>
  closeProject(opts: { dryRun: boolean; save?: boolean; closePortal?: boolean; signal?: AbortSignal }): Promise<AccessCallResult>
  listObjects(query?: {
    categories?: readonly AccessCategory[]     // 省略 = 由下面点名的族决定
    blockNames?: readonly string[]; typeNames?: readonly string[]; tagTableNames?: readonly string[]
    deviceName?: string; softwareName?: string
    recursive?: boolean; nameFilter?: string
    includeFingerprints?: boolean; includeAttributes?: boolean; includeTags?: boolean; includeConstants?: boolean
    maxItems?: number                          // 省略 = 1000（控制器没有 offset，抬高上限是唯一办法）
    signal?: AbortSignal
  }): Promise<AccessListResult>
  exportObjects(query: {
    outputDir: string
    categories?: readonly AccessCategory[]
    blockNames?: readonly string[]; typeNames?: readonly string[]; tagTableNames?: readonly string[]
    deviceName?: string; softwareName?: string
    recursive?: boolean; overwrite?: boolean
    exportOptions?: 'none' | 'with_defaults' | 'with_read_only'
    writeManifest?: boolean; dryRun?: boolean
    signal?: AbortSignal
  }): Promise<AccessCallResult>
  // —— D21 新增的三个方法：**这是本插件目前唯一使用的三个成员** ——
  saveProjectAs(directory: string, opts?: { dryRun?: boolean; signal?: AbortSignal }): Promise<AccessCallResult>
    // 另存只认目录、工程名不可改（D20 实测）；回读 savedAs / requestedSaveAsDir / projectPath，
    // 调用方必须记录 TIA 实际落点，而不是它请求的路径
  readTiaSession(opts?: { signal?: AbortSignal }): Promise<AccessTiaSession>
    // 报"控制器在不在 + TIA 开着哪个项目 + 设备清单"；**从不启动控制器**
    // （停着就回 running:false，一个操作都不发）；没项目时 project_not_open 是状态不是异常
  rebuildSource(sourceRoot: string, opts?: { overwrite?: boolean; deviceNames?: readonly string[]; signal?: AbortSignal }): Promise<RebuildSourceResult>
    // 每个 device 两次 ExportBlocks；**sourceRoot 以下的布局由提供方定死**：
    // <device>/blocks|types|tag_tables/…，每个 device 最多两份 manifest
    // 注意本插件**不使用** dryRun：它的"只给计划"由 readTiaSession 单独算得出来，
    // 不依赖控制器的 dry run（那个选项是否保留是接口插件自己的取舍）。
}

interface AccessCallResult {
  ok: boolean; operation: string; dryRun: boolean; summary: string
  error: { code: string; message: string; details: JsonRecord | null } | null
  data: JsonRecord | null; durationMs: number
  changes: readonly unknown[]; diagnostics: readonly unknown[]
}

interface AccessListResult extends AccessCallResult {
  objects: Array<{
    category: 'blocks' | 'types' | 'tag_tables'
    name: string
    group: string | null
    attributes: unknown
    fingerprints: Array<{ id: string; value: string | null; error: string | null }> | null
  }>
  /** 每族 count/returned/truncated（接口插件族把 `{count,items,truncated}` 信封摊平了）。 */
  families: Record<string, { count: number; returned: number; truncated: boolean }>
  truncated: boolean
  missing: unknown
}
```

**三条与设计稿的差异（以实现为准）**：

1. **没有 `tiaObjectId`**：V17 拿不到（D7 / §5.2），所以行里根本没有这个字段 —— 身份仍由
   `category + group + name` 决定，不确定时在结果里标 `identity`。
2. **`families` 里的 `truncated` 必须向上传播**：接口插件族如实报，工程上下文插件必须**照实**写进
   `eng_changes` 的 `notCovered`，不能让它看起来"没变"。
3. **`closeProject` 的 `dryRun` 是必填参数**：工程上下文插件目前**不调用**它（A16 的倾向是复用已开会话），
   真要调用时必须显式表态。

**2026-10 的提供方新增（S0/S1）与消费方接入（S2）**：接口插件族在 `engineeringAccess` 上又加了两个方法，
本包 `src/access.ts` 已经声明并归一化，`project_status` / `project_sync` 正在使用它们：

```ts
readPlcChecksum(query?: { deviceName?; softwareName?; signal? }): Promise<AccessChecksumResult>
  // 读 PlcChecksumProvider.Software（V17 的属性名不是 Checksum）；空串 = 未编译/改动后未再编译，
  // 返回 ok:false + error.code 'checksum_unavailable'
syncScan(query: {
  sourceRoot; stageDir; evidencePath; manifestPath?; deviceName?; softwareName?; exportOptions?; signal?
}): Promise<AccessSyncResult>
  // **一次调用**完成：遍历全部块/类型/标签表、逐对象比对上一版 evidence 的指纹/归一化哈希，
  // 只把差异导出到 stageDir，并在同一次调用里写下 stageDir 的 _evidence.json 与 _manifest.json。
  // **sourceRoot 传 device 目录**（清单里的 file 相对它）；checksum 与账本一致、且账本与清单
  // 可用时返回 unchanged（不枚举、不导出，实测 1.6–3.0 s）。
```

路径契约：`source/<device>/_evidence.json`（权威、进 git）、`source/<device>/_manifest.json`
（派生清单、进 git）、`<workspace>/.dsh/local/{lock.json,stage/}`（本机临时状态、不进 git）。
`.dsh/local/` 由 `create_engineering_project` 追加进 `.gitignore`。

**为什么不用另外两条路**（已评估）：

| 方案 | 为什么不选 |
|---|---|
| 工程上下文插件用 `ctx.tools.execute({name:'list_plc_objects', …})` 间接调接口插件族的工具 | 脆弱：受接口插件族工具面重构（[`docs/open-questions.md`](../../../docs/open-questions.md) **A15** 要把原子工具默认隐藏）影响；解析是**按可见性**的（`dsh-tools/lib/index.js:3058`）；还要过 `tools/pre-execute` 闸门 |
| 纯文件契约：接口插件族写 `fingerprints.json`，工程上下文插件只读 | 零耦合，但"谁触发指纹"变成"模型得记得先让接口插件族跑一次" —— 正好退回 [`docs/tool-surface.md`](../../../docs/tool-surface.md) §1 要消灭的"模型自己编排几十次调用" |

**服务缺席时的降级**（必须实现，P2）：读**上一次**的指纹工件，并在结果里明确标注
`stale: true` + 工件时间 + "指纹未刷新"的原因；**绝不**静默拿旧数据当现状
（[`docs/architecture.md`](../../../docs/architecture.md) §5.4「失效可感知」）。

### 5.3.1 【缝 B】与工程知识图谱插件的服务契约（✅ 已实现）

图谱的输入就是缝 A 的产出（`source/<device>/`），所以这一步**没有新增文件契约**：工程上下文插件
在导出完成后，逐设备调用图谱插件注册的对应服务。**决定：与缝 A 同形** —— 图谱插件注册一个可选的
cordis 服务，工程上下文插件按名取用、不 import（D10）。

> **状态：✅ 已实现（消费者侧 + 提供者侧）。** 服务名 **`knowledgeGraph`**，由
> `packages/dsh-engineering-graph/src/service.ts` 提供，在 `apply()` 里构造，随该插件的卸载一起消失。
> 提供方那一侧的权威描述是**发行版** [`docs/decisions.md`](../../../docs/decisions.md) **D20**（数据库
> 位置与命名）与 **D21**（服务本身）外加该服务的模块注释；图谱包自己没有 `docs/` 目录。
> **本节的接口面是消费方的镜像**，两边改一处必须改另一处。
> 契约形状见 `src/knowledge-graph.ts`（消费方的声明，D25 记录了取舍）。

```ts
// 由图谱插件提供；工程上下文插件只使用这两个成员，取不到就当"图谱未建成"。
interface KnowledgeGraph {
  readonly name: string                     // 'knowledgeGraph'
  status(): {
    available: boolean                      // 引擎 exe 在不在（从不启动它）
    reason: string | null                   // 不可用时的一句话原因
    enginePath: string
    engineExists: boolean
    source: 'config' | 'package'            // enginePath 从哪来
    databaseConvention: string              // '<project root>/knowledge/<device>/<device>_knowledge.db'
  }
  // deviceDir = 缝 A 的 devices[].directory（含 manifest + blocks/ + types/ + tag_tables/）。
  // 省略 dbPath 时按上面那个约定落库；它是**全量重建**，没有增量。
  ingestDevice(deviceDir: string, opts?: {
    dbPath?: string
    signal?: AbortSignal
    onProgress?: (message: string) => void
  }): Promise<{                             // 与图谱插件三个工具同一个规范信封
    ok: boolean; operation: string; dryRun: false; summary: string
    data: {
      device: string; dbPath: string; source: 'manifest' | 'crawl'
      filesFound: number; filesImported: number; nodes: number; edges: number
      byKind: Record<string, number>
      warnings: string[]                    // 含清单的 failures[]（TIA 拒绝导出的对象）
    } | null
    error: { code: string; message: string; details?: { remediation?: string } } | null
    durationMs: number
  }>
}
```

**四条消费方纪律**（D25，全部由 `test/02` 与 `test/04` 覆盖）：

| 纪律 | 为什么 |
|---|---|
| **`deviceDir` 只用缝 A 返回的 `devices[].directory`**，不自己拼 | 目录布局是提供方定死的；自己拼会在布局一变时静默指向错的地方 |
| **不传 `dbPath`** | 库的位置是图谱插件的约定（D20）；传一个本插件算出来的路径等于把同一件事维护两遍 |
| **`available:false` / 服务缺席 / 传输错误 → 只报"图谱未建成"** | 图谱是加分项：工程与源文件树才是这个流程承诺的东西，缺它不该让流程失败 |
| **`ok:false` 是数据**：`error.code` + `error.details.remediation` 进结果与 warning | 引擎明确拒绝时，"下一步做什么"就在信封里，丢掉它等于让模型自己猜 |

**代价（必须承认）**：没有新鲜度/增量，所以每次真实运行都**整库重建**（实测 1376 个源文件约 30 s、
库约 450 MB）。这就是为什么"每次导出后调一次"是唯一的刷新方式，也是为什么这一步放在导出之后、
**且不能拖垮工作流** —— 图谱插件那侧的 `requestTimeoutMs`（默认 300 s）必须覆盖单台设备的建库时间。

### 5.4 版本管理（A8 / S2）：`project_sync` —— SOURCE 是 TIA 的提交物

D22 删掉的是 P1 那套**内部 git 版本层**（`eng_version` + 自建提交语义）；版本管理本身并没有消失，
而是换成了"TIA 是权威、SOURCE 是它的 git 快照"这一条更简单的形态（取舍见 [`decisions.md`](decisions.md) D26）：

```
TIA（权威，二进制，不进 git）
  └─ SyncScan ─→ STAGE（<workspace>/.dsh/local/stage/<id>/，本机临时，只放差异）
                   └─ 提升 ─→ SOURCE（source/<device>/**，文本，进 git，含 _evidence.json + _manifest.json）
                                  └─ project_sync 提交（路径限定在该 device 目录）
```

- **相等性有两个层级**：`PlcChecksumProvider.Software` 是 **PLC 级**的"有没有人动过"，一次读 3.2 s，
  用作快路径；逐对象是否真的变了，用**分面指纹**（块/UDT）与**归一化 XML 哈希**（标签表）判断。
  清单里的 `sha256` 只是文件完整性佐证，**绝不作变更键**（D6）。
- **`_evidence.json` 是权威账本**：记录每个对象的 `key` / `category` / `name` / `group` / `path` /
  `state`（`present` | `unexportable`）/ `fingerprint` / `contentHash`，加上 `plcChecksum`、`stateId`
  与 `tombstones`。**删除用墓碑**，所以"对象消失"与"对象暂时导不出来"不会被混为一谈。
- **`_manifest.json` 是派生清单**：`bytes` / `sha256` / `verified` / `simaticType` / `declaredName` /
  `declaredNumber` / `programmingLanguage`，相对 `file` 路径，无时间戳、无绝对路径。它**只描述磁盘上
  有什么**，从不参与相等性判断。同一次 `SyncScan` 调用内增量合并：未变对象沿用旧条目，只有真正变化的
  标签表才被提升/重写。
- **两条路径**：checksum 与账本一致、账本与清单都可用 → `unchanged`（不枚举、不导出）；
  否则慢路径枚举全部对象、只导出差异，并重写两份文档。**清单缺失/损坏会强制一次全量导出**，
  但账本仍然决定"哪些对象变了"，所以不会误删文件。
- **计划默认**：`project_sync` 默认只读 checksum（约 3 s）并报告 `wouldSync`，写盘必须显式
  `dry_run: false`。`project_status(verify: true)` 读到 checksum 后写一份 TTL 30 s 的进程内缓存
  （workspace + device + software 键控），计划命中即复用并标 `checksumCached: true`；真实同步
  从不使用缓存做决定，永远重新扫描。真实的同步在 workspace 锁内运行，成功/失败都会清掉 STAGE（`finally`）。
- **提交**：`project_sync` 的提交路径限定为 `source/<device>`，提交信息带 `Tia-Op: sync` / `Tia-Checksum` /
  `Tia-State` / `Tia-Manifest: rebuilt|updated` 四个 trailer。`project_sync`/`project_status` 仍**从不
  `git init`**：仓库不存在时 `repository_not_found` 并让用户自己建。`create_engineering_project` 相反：
  它在 workspace 没有仓库时经 `gitContext` 服务 `init`（`git init -b main`），并提交一次包含
  `.gitignore` / `.gitattributes` / `source` 的基线（`Tia-Op: create`）；workspace 位于别人的仓库里、
  或根仓库无法归属（历史里没有 `Tia-Op: create`、也没有 `.dsh/local/repo.json` 标记）时以
  `workspace_is_repository` 拒绝，绝不把基线写进别人的历史。任何工具都从不 `push`/`reset`/`--force`。

**仍然成立的两条硬口径**：

- **`.ap17` 永不进 git**：二进制工程文件进 VCS 只能得到"变了/没变"
  （[`docs/vision.md`](../../../docs/vision.md) §3.3）。由 `create_engineering_project` 维护的
  `.gitignore` 里的 `tia/` 强制（[`PATH-RULES.md`](PATH-RULES.md) §6）。
- **不自己起 TIA、不改工程**：`project_sync` 只读 checksum 与指纹、只写 SOURCE 与 STAGE；
  "编译"永远是用户在 TIA 里的动作（checksum 为空 → `needs_compile`）。

### 5.5 工程变更台账（期望二 / B8）

对象级记录，落盘为 `change-context.json`（可携带、可进 git、跨会话）：

```jsonc
{
  "schemaVersion": 1,
  "project": "pei-sinoarp",
  "items": [
    {
      "id": "c-0001",
      "kind": "intent | assumption | pending-verify | rename-candidate",
      "statement": "把 010_Cell 的电机启停改为脉冲触发",
      "refs": [
        { "object": "FB_Motor", "group": "010_Cell/", "category": "blocks",
          "version": "a1b2c3d", "facets": ["Code", "Interface"], "confidence": "confirmed" }
      ],
      "state": "open | done | dropped",
      "source": "agent | user",
      "createdAt": "2026-10-14T09:12:00Z",
      "updatedAt": "2026-10-14T09:12:00Z"
    }
  ]
}
```

- **必须能指回工程对象与版本**（`refs`）—— 否则"辅助判断用户意图"就是一句空话。
- `kind = rename-candidate` 是 §5.2 降级路径的落点：身份不确定的对象在这里等人工确认。
- 生命周期**跨会话**，随 workspace 走，可进 git。**不是** `todo_write` 那种会话内计划清单。

### 5.6 文档与项目级 skill（D4 / A12）

- **通用能力文档**：随包 `skills/engineering-context/SKILL.md`，按 D4 的三问组织
  （何时调用 / 怎么调用 / 调用后的数据怎么用），走
  `ctx.inject(['skills'], scoped => scoped.skills.registerProvider(() => provider))`
  —— 先例见 `packages/dsh-tia-openness-v17-min/src/skills.ts:146`。
- **项目级 skill 技术可行**：provider 的 `list()` 是**每次目录构建时动态调用**的
  （`dsh-skill/lib/index.js:350` 的 `await waitWithAbort(provider.list(options), options.signal)`），
  所以可以**运行时枚举**目录。这为 A12 的倾向 C（项目级覆盖用户级、默认只对本 workspace 生效）
  提供了实现依据。
- **纪律：只广告 1 个路由 skill。** 会话目录是每个会话都要付的常驻成本，TIA 包已经因此把
  31 个上游 skill 收敛成 1 个路由 skill（`src/skills.ts` 的模块头注释）。项目级 skill 同理：
  路由 skill 给基目录，模型按需 `read`。

---

## 6. 工具面（3 个已实现 + 1 个待做）

口径全部沿用 [`docs/tool-surface.md`](../../../docs/tool-surface.md) §4.3 的 R1–R8：
结果 **≤4KB / ~40 行**、批量数据一律落盘成工件、结果里只给"计数 + 前 N + 工件路径 + 下钻方式"、
成功项只给计数而**失败项全量给**、dry-run 提到工作流层、长操作给阶段摘要。

> 为什么必须这样：越过 Pruner 的 `thresholdChars: 8192` 会被**从中间剪掉**
> （剪掉的正好是中间那批数据），越过 Spill 的 `maxInlineTokens: 12500` 会被自动落盘
> （[`profile/dsh-automation-suite/cordis.patch.yml`](../../../profile/dsh-automation-suite/cordis.patch.yml)
> 的 Pruner 配置；Spill 见 `@deepseek-ai/dsh-spill` README）。
> **与其被框架剪，不如自己给一份有意义的摘要 + 路径。**

| # | 工具 | 回答什么问题 | 写？ | 依赖 | 状态 |
|---|---|---|---|---|---|
| 1 | `create_engineering_project` | 把工程接进 workspace：没打开就**打开**（`source_project`），另存进 `tia/`，把**源文件树**重建到 `source/<device>/`，再逐设备把图谱库重建到 `knowledge/<device>/`；默认只给计划 | 是（TIA 写工程、接口插件写源文件、图谱插件写 `.db`、本插件维护 `.gitignore` 的三行） | ① + 缝 A + 缝 B | ✅ **已实现** |
| 2 | `project_status` | 这个 workspace 现在是什么状态：哪个 PLC、账本/清单在不在、git 看到什么、锁有没有被占、下一步该做什么（`open_project` / `compile` / `sync` / `commit` / `git_init` / `clean`） | 否（`verify: true` 时只读 checksum） | 缝 A | ✅ **已实现**（S2） |
| 3 | `project_sync` | 让 SOURCE 与 TIA 对齐：checksum 快路径 → 需要时全量扫描、只导出差异到 STAGE → 提升进 SOURCE → 写账本/清单 → 提交该 device 目录；默认只给计划 | 是（SOURCE + `.dsh/local/stage` + 一次 git commit） | 缝 A（`syncScan`）+ git | ✅ **已实现**（S2） |
| 4 | `eng_context` | 工程变更台账：`record` / `list` / `resolve` / `pending` | 状态 | 台账存储 | ⬜ P3 |

**为什么只有 4 行**：26 个控制器操作的名字 + 描述 + 参数 schema 序列化后约 **14k tokens/会话**
（[`docs/tool-surface.md`](../../../docs/tool-surface.md) §2.7）。工作流工具面保持个位数，
省下来的是每个会话都要付的常驻成本。

> **2026-10 的变更（D22）**：原先注册的 `eng_status` / `eng_project` / `eng_scope` / `eng_version`
> 已**删除** —— 它们维护的注册表全仓没有第二个消费者，内部 git 层用户自己的 git 就能替代。
> `create_engineering_project` 把 D21 交付的三个服务方法（另存 / 读会话 / 重建源）第一次连成一条
> **可审阅的编排**，也正是 A5 描述的流程。实现期的取舍见 [`decisions.md`](decisions.md) D22 与接口插件的 D20/D21。
>
> **2026-10 的追加（D25）**：这条编排不再止于源文件树 —— 导出完成后它会经**缝 B** 逐设备重建
> 图谱库（`knowledge/<device>/<device>_knowledge.db`），并且**这一步是软的**：图谱插件缺席、引擎没
> 构建或引擎不可达时只报"图谱未建成"，工作流照常成功。取舍与理由见 [`decisions.md`](decisions.md) D25、
> 契约见 §5.3.1。
>
> **2026-10 的追加（S2 / D26）**：新增两个工具，但不新增"版本号"概念 —— `project_status` 只回答
> "现在是什么状态"，`project_sync` 只做"把 TIA 的当前状态变成一次 SOURCE 提交"。三份文档
> （`_evidence.json` / `_manifest.json` / `.dsh/local`）的分工见 §5.4 与 [`PATH-RULES.md`](PATH-RULES.md) §2。

### 6.1 返回契约示例（`eng_changes`）

```jsonc
{
  "ok": true,
  "scope": { /* §4.1 四元组 */ },
  "summary": "3 of 1152 blocks changed since baseline 2026-10-13T03:35Z; 1 compile-relevant (Code), 2 comments only.",
  "counts": { "blocks": 1152, "types": 210, "changed": 3, "added": 0, "removed": 0 },
  "facets": { "Code": 1, "Comments": 2, "Interface": 0, "Properties": 0 },
  "compileRelevant": 1,
  "changed": [
    { "name": "FB_Motor", "group": "010_Cell/", "category": "blocks",
      "facets": ["Code"], "compileRelevant": true, "identity": "by-name" },
    { "name": "FC_Test",  "group": "",           "category": "blocks",
      "facets": ["Comments"], "compileRelevant": false, "identity": "by-name" }
  ],
  "notCovered": ["tag_tables (FingerprintProvider does not support them)"],
  "artifacts": [
    { "kind": "change-set", "path": "…\\_dsh-eng\\changes-2026-10-14T09-12Z.json", "rows": 3 },
    { "kind": "baseline",   "path": "…\\_dsh-eng\\fingerprints.json", "rows": 1362 }
  ],
  "stale": false,
  "drilldown": "Read the change-set artifact for the full per-object facet list; use eng_export with changed_only=true to materialise exactly these objects."
}
```

要点：**1152 个对象的完整指纹进工件，模型只看 3 条差异 + 计数 + 路径**；
`identity: "by-name"` 与 `notCovered` 把 §5.2 / §5.1 的两个缺口显式写在结果里。

---

## 7. 状态与持久化

| 层 | 放什么 | 现状 |
|---|---|---|
| **workspace 内 `tia/`** | TIA 的工程本体（二进制、不进 git） | ✅ `create_engineering_project` 经缝 A 的 `saveProjectAs` 写入 |
| **workspace 内 `source/`（含 `_dsh-engineering-context.json` 索引）** | 重建的源文件树（文本、进 git） | ✅ 经缝 A 的 `rebuildSource`（创建）与 `syncScan`（增量同步）写入 |
| **`source/<device>/_evidence.json`** | 权威账本：指纹 / 归一化哈希 / checksum / 墓碑（进 git） | ✅ `SyncScan` 写、`project_sync` 提交（S2） |
| **`source/<device>/_manifest.json`** | 派生清单：文件字节数 / sha256 / 类型元数据，无时间戳、相对路径（进 git） | ✅ 同一次 `SyncScan` 调用生成（S2） |
| **workspace 内 `knowledge/<device>/*.db`** | 图谱库（二进制、`*.db` 不进 git；图谱插件的地盘） | ✅ `create_engineering_project` 经缝 B 的 `ingestDevice` 触发重建（D25） |
| **`<workspace>/.dsh/local/{lock.json,stage/}`** | 本机临时状态：workspace 锁（TTL 15 min）与 STAGE；**不进 git**（`.dsh/local/` 已在 `.gitignore`） | ✅ `project_sync` 使用并在成功/失败后清理（S2） |
| **workspace 内 `_dsh-eng/**`** | P3 台账等 | ⬜ **路径待定**：注册表随 D22 删除后，这一层只剩 P3 的需求 |
| ❌ `_dsh-eng/projects.json` | 工程注册表 + 唯一的"当前工程"指针 | **已删除**（D22）：唯一读者是本插件自己的 4 个旧工具 |
| 宿主 `ctx.storageDomain`（可选、机器本地、可再生） | 目前**没有**用到 | ⬜ 作用域每次从 cwd 重新解析，不需要存 |

**为什么基线不落在 `DSH_HOME` 或 spill 里**：变更检测**必须跨会话/跨机器**才有意义
（[`docs/open-questions.md`](../../../docs/open-questions.md) A14 的倾向同此）。
`ctx.spillStore` 按会话归属、工件由 backend 决定过期（`@deepseek-ai/dsh-spill` README），
只适合临时工件。

**服务缺席时的降级**（已实现）：宿主没有 workspace 服务、或本目录未登记时，
作用域仍以会话工作目录为根，但结果里标 `registered: false` 并给出 warning（N2 / P0-9）。

---

## 8. 数据模型（记录 schema，设计值）

### 8.1 工程注册表 `_dsh-eng/projects.json` —— ❌ 已删除（D22）

原先的记录（`id` / `title` / `source` / `work` / `export` / `createdAt` / `adoptedAt` 七个字段
加一个 `current` 指针）连同 `src/registry.ts` 一并删除：它的唯一读者是本插件自己那 4 个工具，
而"这些工具没有实际用途"经核对成立（[`decisions.md`](decisions.md) D22 列了四条证据）。

现在 workspace 里"有哪些工程"由**目录布局本身**回答：`tia/` 下有什么、`source/` 下有什么。
若要重新引入登记，必须同时给出**消费者**与**失效时的行为** —— 否则只是又一层没人读的状态。

### 8.2 证据账本 `source/<device>/_evidence.json`（✅ 已实现，schemaVersion 1）

`SyncScan` 是唯一的写入方，`project_sync` 只负责把它提交；本插件读取它只为三件事：快路径判定、
删除比对、状态展示。**没有时间戳、没有绝对路径**，所以跨机器 diff 不会因为环境不同而变脏。

```jsonc
{
  "schemaVersion": 1,
  "hashAlgo": "xml-norm-v1",              // NormalizeXmlForHash 的标识，不含时间
  "device": "Sino_PEI",
  "software": "Sino_PEI",
  "plcChecksum": "C0 01 C3 13 58 AC 0E 50",  // PlcChecksumProvider.Software
  "stateId": "…",                          // 由对象 key + 指纹/哈希推出的稳定摘要
  "objects": {
    "block||010_Cell||FB_Motor": {
      "category": "block", "name": "FB_Motor", "group": "010_Cell",
      "path": "blocks/010_Cell/FB_Motor.xml",   // 相对 device 目录
      "fingerprint": { "Code": "…", "Comments": "…", "Interface": "…" }
    },
    "tag_table||||DB_Tags": {
      "category": "tag_table", "name": "DB_Tags", "group": null,
      "path": "tag_tables/DB_Tags.xml",
      "contentHash": "…"                        // 标签表没有指纹，用归一化 XML 哈希
    }
  },
  "unexportable": [
    { "key": "block||||FOB_SAFETY", "category": "block", "name": "FOB_SAFETY",
      "group": null, "reason": "…" }             // 存在但导不出来：保留上一次的文件
  ],
  "tombstones": [
    { "key": "block||010_Cell||FB_Old", "category": "block", "name": "FB_Old",
      "group": "010_Cell", "removedAtChecksum": "…", "reason": "…" }
  ]
}
```

> **为什么清单不能当变更键**：`_manifest.json` 的 `sha256` 是"写出文件的字节哈希"，而 TIA 导出的 XML
> 自带 `<DocumentInfo><Created>`，重新导出就会变（[`MANIFEST-GAP-ANALYSIS.md`](../../dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md) §3）。
> 所以 `project_sync` 只把清单当**清单**：回答"磁盘上现在有什么、多大、是否可读"，
> 从不回答"变没变"。相等性只来自 `_evidence.json`。

### 8.3 清单 `source/<device>/_manifest.json`（✅ 已实现）

```jsonc
{
  "schemaVersion": 1,
  "protocol": "…",
  "generatedBy": "TiaOpennessV17Min.Controller",
  "device": "Sino_PEI",
  "software": "Sino_PEI",
  "exportOptions": "…",
  "categories": ["blocks", "types", "tag_tables"],
  "failureCount": 1,
  "blocks": [
    {
      "category": "block",
      "name": "FB_Motor",
      "group": "010_Cell",
      "file": "blocks/010_Cell/FB_Motor.xml",   // 相对 device 目录；无 outputDir、无生成时间
      "bytes": 12345,
      "sha256": "…",
      "verified": true,
      "simaticType": "FB",
      "declaredName": "FB_Motor",
      "declaredNumber": "34",
      "programmingLanguage": "SCL"
    }
  ],
  "failures": [
    { "category": "block", "name": "FOB_SAFETY", "file": "blocks/FOB_SAFETY.xml",
      "code": "export_failed", "message": "…" }
  ]
}
```

它由 `SyncScan` 在同一次调用里**增量合并**：未变对象沿用旧条目，只有变化的标签表会被重新导出并
覆盖条目；新增对象插入，真正消失的对象由账本墓碑决定删除。清单损坏/缺失只会让下一次同步多做一次
全量导出，**不会**被当成"没有变化"。

---

## 9. 包骨架与登记点

```
packages/dsh-engineering-context/
├── package.json          name: @voltarenyah/dsh-engineering-context, dsh.bundle.patch
├── cordis.patch.yml      - insert: - id: engineering-context
│                                    name: '@voltarenyah/dsh-engineering-context'   ← 引号必须有
├── tsconfig.json         tsc → lib/（**不用** tsdown/vitest，见 decisions.md P0-1）
├── .gitignore            lib/ 与 node_modules/（lib/ 暂不提交，见 P0-2）
├── src/
│   ├── index.ts          apply(): 注册工具；无自有资源，故**没有** ctx.effect
│   ├── config.ts         Schema + defaults + resolveConfig（含目录名安全校验）
│   ├── errors.ts         稳定错误码 + describeFailure
│   ├── paths.ts          归一化、包含性校验、folderName（目录名安全化）
│   ├── workspace.ts      作用域根解析 + **只读**的 workspaceRegistry 访问（按名取，不 import）
│   ├── access.ts         `engineeringAccess` 服务客户端（按名取 + 防御性归一，D10）
│   ├── knowledge-graph.ts `knowledgeGraph` 服务客户端（缝 B：按名取 + 归一 + 降级，D25）
│   ├── scope.ts          作用域 + 路径存在性 + warning
│   ├── dsh-runtime.d.ts  手写环境声明（含 exec.agent.session.header.cwd 与 RawJsonSchema）
│   └── tools/            outcome.ts（共用信封）/ create-project.ts / index.ts
├── scripts/              link-dsh-runtime.mjs（**从不抽取**缓存）/ tsc.mjs / run-tests.mjs
├── docs/                 本文 / PATH-RULES.md / decisions.md
└── test/                 node:test（56 项）+ helpers/harness.mjs
```

**已删除**（D22）：`src/registry.ts`（工程注册表）、`src/git.ts`（内部 git 版本层）、
`src/tools/{status,project,scope,version}.ts`（4 个工具）。

后续期次新增的模块（P2–P3）：`src/change/`（指纹客户端、基线、diff）、
`src/context/`（变更台账）、`skills/engineering-context/SKILL.md`。

**登记点**（实现开始后各改一处；现在**先不动**，理由见 [`decisions.md`](decisions.md) N1）：

| 文件 | 改什么 |
|---|---|
| `profile/dsh-automation-suite/package.json` | `dependencies` 加包名 + `dsh.profile.bundles` 加一行 |
| `docs/roadmap.md` §1/§3 **与** 根 `README.md` §2 | 状态同步（**两处必须一致**，roadmap §8） |
| `docs/decisions.md` | 本插件定的发行版级取舍 |
| `docs/open-questions.md` | 把 A8 / B7 / B8 / B9 等答复落进去 |

**开发期纪律**（血泪见 `packages/dsh-tool-git/AGENTS.md` §2–§4）：
不把 `@deepseek-ai/*` 装成依赖，走 `link:runtime`；`RUNTIME_ROOTS` 只列**直接 import** 的包
（本包是 `dsh-tools` / `cordis` / `schemastery` 三个）。
本包用 `tsc` 而不是 tsdown，所以"tsdown 把可解析的包内联进产物"那个陷阱不适用；
**若将来改用 tsdown，必须显式加 `deps.neverBundle: true`**。

**另外两条本包特有的纪律**（都写进了 `decisions.md`）：
`link:runtime` 脚本**从不抽取**运行时缓存（那在仓库之外、不可 git 恢复，P0-8）；
**依赖一律走 `pnpm install`**，脚本只链 `@deepseek-ai/*` —— 手工链到别的包的 `node_modules`
会让 `pnpm install` 失败（P0-14 的实测事故）。

**一个省钱的设计**：**不要 import `@deepseek-ai/dsh-workspace`**，只用
`ctx.get('workspaceRegistry')` 按名取服务（先例：`dsh-workspace` 自己就是
`this.ctx.get("sessions")`，`dsh-workspace/lib/index.js:427`），把形状写进 `dsh-runtime.d.ts`。
这样不新增运行时依赖、不与该包版本耦合，缺席时还能优雅降级。

---

## 10. 分期与验收口径

| 期 | 做什么 | 依赖 | 独立交付的价值 | 状态 |
|---|---|---|---|---|
| ❌ **P0 / P1** | ~~作用域 + 工程注册表（`eng_status`/`eng_project`/`eng_scope`）+ 版本层（`eng_version`）~~ | — | — | **已删除**（D22） |
| **create** | `create_engineering_project`：打开/另存进 `tia/`、重建源文件树到 `source/<device>/`、逐设备重建图谱库到 `knowledge/<device>/`，默认只给计划 | 缝 A ✅ 已就绪（接口插件族的 `engineeringAccess`）；缝 B ✅ 已就绪（图谱插件的 `knowledgeGraph`，缺席即降级） | **A5 的流程第一次能跑通**：工程进 workspace、源文件读出来、块逻辑进图谱库 | ✅ **已实现** |
| **S0 / S1** | 控制器取证：`PlcChecksum`（V17 属性是 `Software`）+ `SyncScan`（遍历 / 指纹与归一化哈希比对 / 只导出差异到 STAGE / 同一次调用写 `_evidence.json` 与 `_manifest.json`） | 接口插件控制器 | 变更检测不再依赖"每次全量导出一遍再比字节" | ✅ **已实现 + 真机通过**（见接口插件 docs） |
| **S2** | 消费侧闭环：`project_status`（只读状态）+ `project_sync`（checksum 快路径 → 慢路径 → STAGE → SOURCE → 锁内提交） | S0/S1 + 缝 A + 用户自己的 git 仓库 | **D6/D9 的工作循环第一次落地**：TIA 改了 → 一次同步 → git 里有且只有差异 | ✅ **已实现**（单测 17 项；完整真机链路待跑） |
| **P3** | 变更台账（`eng_context`）+ 项目级 skill | S2 | 期望二 | ⬜ |

**当前的实际产出**：`src/` 下 13 个模块（另加手写的 `dsh-runtime.d.ts`）+ `src/tools/` 下 6 个文件、
`test/` 5 个测试文件（**73 项**，全通过、无跳过）、`scripts/` 3 个脚本。**没有** `ctx.effect` ——
本插件不持有任何自有资源（不起子进程、不开句柄），所以 `apply` 注册完工具就返回
（图谱引擎的子进程归图谱插件持有）。**没有** `skills/`：文档交付物（D4 三问）在 P3 与项目级 skill
一起做，现在的三问写在工具描述里。

### 验收口径（对齐 `docs/roadmap.md` §3）

| 口径 | 怎么验 | 离线可测？ | 状态 |
|---|---|---|---|
| 可重复 | 给定「project/branch/version」两次物化，导出物逐字节一致 | ✅ | ⬜ 真机 |
| **不串味** | 每次调用都从自己的 session cwd 重新解析 workspace；目标路径越界即拒 | ✅ | ✅ 已测（`path_outside_workspace`、配置兜底、无 cwd 拒绝） |
| 作用域显式 | 每个工具结果都带 scope（workspace 路径 + 是否登记 + warnings） | ✅ | ✅ 已测 |
| **变更不漏报不误报** | 未改动 → `unchanged`（不枚举）；只导出差异；消失的对象删文件、不可导出的对象保留旧文件 | ✅（假服务 + 真实 STAGE/git） | ✅ 工具级已测（`test/09`），真机待跑 |
| 增量可验证 | 改一个块后，导出集合 **==** 账本报告的集合（D9 闭环） | ⚠️ 需真机 | 🟡 1 块慢路径 48.3 s 已验证；消费侧待真机 |
| 失效可感知 | TIA 拒绝另存 → `save_failed`；重建失败 → `rebuild_failed` 并说明"哪一半已经落盘"；被拒对象逐条回报；checksum 为空 → `needs_compile` | ✅ | ✅ 已测 |
| **图谱可缺席** | 无 `knowledgeGraph` 服务 / 引擎未构建 / 引擎超时 → 工作流仍 `ok:true`，只报"图谱未建成"并给出原因；引擎拒绝 → 逐设备 `error.code` + remediation | ✅ | ✅ 已测（`test/02` 工具级 + `test/04` 缝 B 级） |
| 上下文预算 | 每个工具结果 ≤4KB；工具目录开销可复算 | ✅ | ✅ 列表封顶 20 行、细节封顶 40 行 |

测试形态：**`node:test`**（与 `dsh-tia-openness-v17-min` 一致），断言跑在**真实**运行时上 ——
工具的 schema 由 `defineTool` 真的编译，结果也由运行时的 `validateJsonSchemaValue` 真的校验。

---

## 11. 风险与待验证（**需要人看的部分**）

| # | 事项 | 影响 | 处置 |
|---|---|---|---|
| 1 | **V17 上 `FingerprintProvider` 的可得性与粒度** | P2 的分面能力；若拿不到，只能退到"变没变"（`PlcChecksumProvider`） | **用户报告已在另一个代码库验证可用**（2026-10-14）—— 这是**用户侧证据，不是本仓实测**；本仓第一次真机跑 P2 时仍要记录证据（发行版待验证清单第 1 条） |
| 2 | **对象身份键缺位**（§5.2） | 期望三（跨版本关联） | 需接口插件族补 `tiaObjectId` + 实测改名/重导后的稳定性 |
| 3 | **一次全项目指纹的耗时与帧大小未测** | 决定要不要做"指纹缓存 + 只重算可疑对象" | 手册说 `GetFingerprints()` **每次重算**；1152 块项目未测 |
| 4 | ~~缝 A 的服务名与接口面未定~~ | — | ✅ **已定**：`engineeringAccess`（接口插件族 `src/access.ts`、该包 D20）；接口面镜像见 §5.3 |
| 5 | 宿主 workspace 服务是**可选**的（组合里没挂 `dsh-workspace` 时 `ctx.get` 返回 `undefined`） | `registered` 恒为 false | 已设计降级（§4.1 / N2），不阻塞 |

---

## 12. 非目标

- ❌ 不解析 XML、不建图（工程知识图谱插件）。本插件只在导出完成后**触发**它的建库服务
  （缝 B，§5.3.1），不读它的库、不解析它的输出。
- ❌ 不自己起控制器、不直接调 Openness（接口插件族；且一宿主只允许一个控制器，D2）。
- ❌ 不重做宿主的 workspace/session 分组，也不改宿主的 workspace 记录。
- ❌ 不复用 `todo_write` 承载工程变更台账，也不复用 `ctx.workspaceChanges` 当工程级变更检测。
- ❌ 不把 `.ap17` 纳入 git；不用 manifest 的 `sha256` 当变更键。
- ❌ 不把 git 的原始命令能力暴露给模型。
- ❌ 不按"控制器操作"1:1 铺工具（那是 26 工具 ≈14k tokens 常驻的老路）。
