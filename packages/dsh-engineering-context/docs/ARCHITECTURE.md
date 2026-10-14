# 核心架构：工程上下文管理插件（插件族 2）

> **状态：设计定稿；P0 已实现（作用域 + 工程注册表 + 3 个工具）。**
> 本文描述这个插件"要做成什么样"：定位与边界、核心架构、主要功能、实现方式、验收口径与风险。
> 实现进度见 §10；做到哪了只在 [`docs/roadmap.md`](../../../docs/roadmap.md) §3 与
> 根 [`README.md`](../../../README.md) §2 两处维护。
>
> - 本文的接口名、工具名、字段名都是**设计值**，实现时可以改；改了必须同步本文与该包的
>   [`decisions.md`](decisions.md)（实现期的取舍记在该文件的「P0 实现期的决定」一节）。
> - 引用代码/运行时一律带 `path:line`；凡属**推断**都显式标注，不与"已实测"混写。
> - 与发行版级文档的关系：[`docs/architecture.md`](../../../docs/architecture.md) §4.2 给出这一族的
>   职责与边界，[`docs/decisions.md`](../../../docs/decisions.md) D5–D7、D12 给出已定的取舍，
>   本文把它们落成可实现的形态。
>
> 本包**尚未登记进 profile 蓝图**：这是刻意的（[`decisions.md`](decisions.md) N1 —— 蓝图里多一个
> bundle 名，而 `packages/` 下找不到对应包时，`scripts/start-env.ps1` 会直接失败）。
> 因此现在没有任何 profile 会加载它；用本包自己的 `check` 脚本验证。

---

## 1. 一句话定位

**它是宿主 workspace 之上的一层"工程作用域 + 工程变更"。**

面对用户的**多个工程 × 多个分支 × 多个历史版本**，它保证会话里的任何结论都能回答
"这是哪个 workspace 的哪个工程的哪个分支的哪个版本"，并把工程对象的变更以**可读、可跟进**的
形式交出来。它不产出工程语义、不碰设备。

### 1.1 边界（硬约束）

| 它做 | 它**不做** | 依据 |
|---|---|---|
| 解析作用域（workspace/project/branch/version） | **不解析 XML、不建图** | [`docs/architecture.md`](../../../docs/architecture.md) §4.2 边界；那是族 3 |
| 管 workspace 内的路径规则与工程注册表 | **不直接驱动 Openness、不起控制器** | §4.2 / §9「写入只有一个通道」；族 1 是唯一通道 |
| 消费族 1 的**指纹**做工程级变更检测 | 不做**文件级、按轮次**的变更记录 | 宿主已有 `dsh-workspace-changes`（见 §2.1） |
| 用内部 git 管导出物的分支/历史/差异 | **不把原始 git 暴露给模型** | [`docs/open-questions.md`](../../../docs/open-questions.md) A8 的补充分析 |
| 维护工程变更台账（期望二） | 不做 agent 的会话计划清单 | 那是 `@deepseek-ai/dsh-tool-todo` |
| 决定**范围** | 不决定**含义** | §4.2 边界 |

### 1.2 一个刻意的性质：没有 TIA 也能用

作用域、注册表、版本层、变更台账全是"文件 + git"，只有变更引擎依赖族 1 的指纹。
因此本插件**可以在没有 TIA Portal 的机器上独立交付价值**（"我现在在哪个工程的哪一版"、
"导出物的历史与差异"），这也与 [`docs/architecture.md`](../../../docs/architecture.md) §7
"② 已确认可以脱离图谱独立起步"一致。

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
                │         │ 族 1 接口插件 │    │            │
                │         │ 指纹/开关项目 │    │            │
                │         │ 导出/编译/写回│    │            │
                │         └──────┬───────┘    │            │
                ▼                ▼            ▼            ▼
          _dsh-eng/*.json   工件 JSON      .git/      change-context.json
          （可携带/可进 git） 基线/变更集   导出物入库    （跨会话）
                                  │
                                  ▼
                 ┌────────────────────────────────────────────┐
                 │ ⑥ 工作流工具面（7 个；结果 ≤4KB）            │
                 │    摘要 + 计数 + 工件路径 + 下钻方式         │
                 └────────────────────────────────────────────┘
```

| 层 | 职责 | 不做什么 |
|---|---|---|
| ① Scope | 解析四元组、路径规则、越界校验 | 不读写工程内容 |
| ② Registry | 工程登记（源/工作副本/导出物/工件/VCS 角色） | 不推断"哪些目录像工程" |
| ③ Change | 指纹 ↔ 基线 → 变更集；面 → 编译相关性 | 不算哈希当变更依据（见 §5.1） |
| ④ Version | 内部 git：commit/log/diff/materialize | 不对模型暴露 git 原语 |
| ⑤ ChangeCtx | 工程变更台账（对象级、带版本、跨会话） | 不是 agent 计划清单 |
| ⑥ Tools | 7 个工作流工具 + 返回契约 | 不按控制器操作 1:1 铺工具 |

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
| 注册表不存在 | 允许 `eng_project register`；**其余工具**返回 `project_not_registered` 并给出下一步命令 |
| 注册表存在但"当前工程"未定且有多个候选 | 返回 `project_ambiguous` 并列出候选（不默认挑一个） |
| 注册表损坏 | 返回 `registry_invalid`，**不**重建、**不**覆盖（宁可报错） |

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
   │        └─ 插件侧**自翻页**：控制器 max_items 默认 200 且**每族独立**、无硬上限
   ├─ 3. 与基线逐**面**比对 → changed / added / removed + 变化的面
   ├─ 4. 变更集落盘成工件 changes-<ts>.json（全量进工件）
   └─ 5. 返回 ≤4KB：计数 + 面直方图 + 前 N 条 + 工件路径 + 下钻提示
```

四条必须做对的细节：

1. **分页在插件侧。** 族 1 的 `list_plc_objects` 的 `max_items` 默认 200、**每族**上限、
   控制器侧无硬上限（[`docs/tool-surface.md`](../../../docs/tool-surface.md) §2.2）；而渲染层把列表
   砍到 20 行（同处 `MAX_LISTED`）。工作流层必须自己抬高上限、按片请求、TS 侧合并去重。
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
| 目标 | 族 1 在导出物/指纹结果里补 `tiaObjectId`（并实测其稳定性） | 需要族 1 一个小改动 + 一次实测 |

**纪律**：任何"身份不确定"的对象，在 `eng_changes` 结果里都要**带标记**，
不许静默按名字对齐 —— 身份键错会让跨版本关联**静默断链**（D7 的原话）。

### 5.3 【缝 A】与族 1 的服务契约（已定）

族 1 的边界是"唯一与工控软件对话的插件"，而指纹**必须开项目**才拿得到（D6）。
所以族 2 必然要向族 1 要一项**能力**（不是文件）。**决定：族 1 注册一个可选的 cordis 服务**，
族 2 可选注入。

设计的最小接口面（**只读 + 开关项目**；写回仍由族 1 自己的写路径负责）：

```ts
// 由族 1 提供；族 2 只使用这一面。名字与字段为实现值，可改，改了两边同步。
interface EngineeringAccess {
  readonly name: string                                  // 例如 'tia-openness-v17-min'
  status(): Promise<{ available: boolean; reason?: string; session?: SessionState }>
  openProject(path: string, opts?: { allowUpgrade?: boolean }): Promise<SessionState>
  closeProject(opts?: { closePortal?: boolean }): Promise<void>
  listObjects(query: {
    categories?: Array<'blocks' | 'types' | 'tag_tables'>
    names?: { blocks?: string[]; types?: string[]; tagTables?: string[] }
    includeFingerprints?: boolean
    deviceName?: string; softwareName?: string
    maxItems?: number
  }): Promise<ObjectRow[]>                            // 插件侧负责翻页合并
  exportObjects(query: {
    targets?: ObjectRef[]                             // 省略 = 全部；给了就只导这批（D9 工作循环）
    outputDir: string
    categories?: Array<'blocks' | 'types' | 'tag_tables'>
    overwrite?: boolean
  }): Promise<ExportReport>                           // 含 manifest 路径与逐项结局
}

interface ObjectRow {
  category: 'blocks' | 'types' | 'tag_tables'
  name: string; group: string
  simaticType?: string; number?: string
  tiaObjectId?: string                                // 目标态；现在缺席
  fingerprints?: Array<{ id: string; value: string }>  // 逐面
  error?: { code: string; message: string }
}
```

**为什么不用另外两条路**（已评估）：

| 方案 | 为什么不选 |
|---|---|
| 族 2 用 `ctx.tools.execute({name:'list_plc_objects', …})` 间接调族 1 的工具 | 脆弱：受族 1 工具面重构（[`docs/open-questions.md`](../../../docs/open-questions.md) **A15** 要把原子工具默认隐藏）影响；解析是**按可见性**的（`dsh-tools/lib/index.js:3058`）；还要过 `tools/pre-execute` 闸门 |
| 纯文件契约：族 1 写 `fingerprints.json`，族 2 只读 | 零耦合，但"谁触发指纹"变成"模型得记得先让族 1 跑一次" —— 正好退回 [`docs/tool-surface.md`](../../../docs/tool-surface.md) §1 要消灭的"模型自己编排几十次调用" |

**服务缺席时的降级**（必须实现）：读**上一次**的指纹工件，并在结果里明确标注
`stale: true` + 工件时间 + "指纹未刷新"的原因；**绝不**静默拿旧数据当现状
（[`docs/architecture.md`](../../../docs/architecture.md) §5.4「失效可感知」）。

**族 1 侧的工作项**（不在本包范围内，记录在此以免遗忘）：注册该服务、把 `listObjects` /
`exportObjects` 接到已有的控制器操作上（`list_plc_objects` 已支持 `include_fingerprints`、
`export_blocks` 已支持 `block_names`，所以**不需要新的 C# 能力**）。

### 5.4 版本层（A8）

**照抄 `dsh-tool-git` 的 shell-free 风格**（`packages/dsh-tool-git/src/runner.ts`）：
`execFile` + 显式参数数组、`-c core.quotepath=false`、`--no-optional-locks`、
`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=true`、`GIT_CONFIG_NOSYSTEM=1`、`windowsHide`。

与本仓已有 git 工具的区别（这是 A8 的答案）：**这一层不注册成工具**。
git 的调用全在插件代码里，路径来自插件自己解析的 workspace，**模型不参与** ——
没有"忘带参数、路径给错"的空间。

**一条硬规则：`.ap17` 永不进 git。** 二进制工程文件进 VCS 只能得到"变了/没变"（
[`docs/vision.md`](../../../docs/vision.md) §3.3）。进 git 的是**导出物 + 基线**，
这样 `eng_version diff` 才是"工程意义上的差异"。

版本操作（内部，按需暴露为 `eng_version` 的 `action`）：`commit` / `log` / `show` / `diff` /
`materialize`（把某版本物化成导出物，供族 3 解析）/ `current`（HEAD + dirty）。

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

## 6. 工具面（7 个）

口径全部沿用 [`docs/tool-surface.md`](../../../docs/tool-surface.md) §4.3 的 R1–R8：
结果 **≤4KB / ~40 行**、批量数据一律落盘成工件、结果里只给"计数 + 前 N + 工件路径 + 下钻方式"、
成功项只给计数而**失败项全量给**、dry-run 提到工作流层、长操作给阶段摘要。

> 为什么必须这样：越过 Pruner 的 `thresholdChars: 8192` 会被**从中间剪掉**
> （剪掉的正好是中间那批数据），越过 Spill 的 `maxInlineTokens: 12500` 会被自动落盘
> （[`profile/dsh-automation-suite/cordis.patch.yml`](../../../profile/dsh-automation-suite/cordis.patch.yml)
> 的 Pruner 配置；Spill 见 `@deepseek-ai/dsh-spill` README）。
> **与其被框架剪，不如自己给一份有意义的摘要 + 路径。**

| # | 工具 | 回答什么问题 | 写？ | 依赖 |
|---|---|---|---|---|
| 1 | `eng_status` | 我在**哪个 workspace / 哪个工程 / 哪个分支 / 哪个版本**？三份东西（源 `.ap17`、导出物、基线）**版本一致吗**？TIA/git/存储能力可用吗？ | 否 | ②④ + 宿主 |
| 2 | `eng_project` | 把工程**登记进 workspace**（`register`）/ 把源 `.ap17` **另存为工作副本**（`adopt`，默认 dry-run）/ `list` / `forget` | 是（注册表 + 文件） | ② + 缝 A |
| 3 | `eng_scope` | **显式**选工程 / 切分支 / 钉版本，并**留痕** | 状态 | ①④ |
| 4 | `eng_changes` | **自上次基线以来，哪些块/UDT 变了、改了哪一面**；可选更新基线 | 否（`update_baseline` 时写基线） | ③ + 缝 A |
| 5 | `eng_export` | 把**变化的那批对象**导出/刷新进导出物（D9 工作循环闭环），更新 manifest | 只写文件 | ③ + 缝 A |
| 6 | `eng_version` | 内部 git：`commit` / `log` / `diff`（工程级差异）/ `materialize` | 是（VCS） | ④ |
| 7 | `eng_context` | 工程变更台账：`record` / `list` / `resolve` / `pending` | 状态 | ⑤ |

**为什么是 7 个**：26 个工具的名字 + 描述 + 参数 schema 序列化后约 **14k tokens/会话**
（[`docs/tool-surface.md`](../../../docs/tool-surface.md) §2.7）。7 个约 3.5k。
`eng_version` 用 `action` 枚举而不是 4 个工具是**刻意的取舍**：代价是"哪些参数必填"在 schema 上
表达不完整（`action='commit'` 才需要 `message`）。若你更看重 schema 精确性，拆成
`eng_version_commit` / `eng_version_log` 即可（+2 工具 ≈ +1k 常驻）。

> **P0 现状（已实现）**：只注册 **`eng_status` / `eng_project` / `eng_scope`** 三个。
> `eng_scope` 目前只有 `select` / `clear`（分支与版本随 P1）；`eng_changes` / `eng_export` /
> `eng_version` / `eng_context` 都还没实现。实现期的取舍见 [`decisions.md`](decisions.md)
> 的「P0 实现期的决定」。

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
| **workspace 内 `_dsh-eng/projects.json`（权威、可携带、可进 git）** | 工程注册表 + **唯一**的"当前工程"指针 | ✅ P0 已实现 |
| **workspace 内 `_dsh-eng/<project-id>/`** | 指纹基线、变更集、变更台账 | 路径已定，P2/P3 写入 |
| 宿主 `ctx.storageDomain`（可选、机器本地、可再生） | 目前**没有**用到 | ⬜ P0 不需要：唯一的可再生状态就是那个指针，而指针必须与注册表在同一份文件里（P0-5） |

**为什么基线不落在 `DSH_HOME` 或 spill 里**：变更检测**必须跨会话/跨机器**才有意义
（[`docs/open-questions.md`](../../../docs/open-questions.md) A14 的倾向同此）。
`ctx.spillStore` 按会话归属、工件由 backend 决定过期（`@deepseek-ai/dsh-spill` README），
只适合临时工件。

**服务缺席时的降级**（P0 已实现）：宿主没有 workspace 服务、或本目录未登记时，
作用域仍以会话工作目录为根，但结果里标 `registered: false` 并给出 warning（N2 / P0-9）。

---

## 8. 数据模型（记录 schema，设计值）

### 8.1 工程注册表 `_dsh-eng/projects.json`（P0 已实现，字段以此为准）

```jsonc
{
  "schemaVersion": 1,
  "workspacePath": "C:\\work\\pei",                    // 创建时的 canonical workspace 路径
  "current": "pei-sinoarp",                            // 唯一指针；不设第二个 scope.json（P0-5）
  "projects": [
    {
      "id": "pei-sinoarp",
      "title": "PEI SinoARP",
      "source": "D:\\TIA\\SinoARP\\tia.ap17",           // 绝对路径，只作溯源；登记后不再读写
      "work": "projects/pei-sinoarp/work/tia.ap17",     // 可携带（相对 workspace 根），唯一会被改的 .ap17
      "export": "projects/pei-sinoarp/export",          // 可携带；导出物（含 _tia-openness-manifest.json）
      "createdAt": "2026-10-14T08:00:00.000Z",
      "adoptedAt": null                                 // adopt 成功后写入；未另存为 null
    }
  ]
}
```

**P0 实际写的字段就是这 8 个**：`artifacts` 与 `vcs` **不再存**（前者由 `stateDirName + id`
推导，后者是 P1 的产物），因为存下来的派生字段会与规则漂移。
每工程的插件状态目录 = `_dsh-eng/<project-id>/`（P0-6）。

### 8.2 指纹基线 `_dsh-eng/fingerprints.json`

```jsonc
{
  "schemaVersion": 1,
  "project": "pei-sinoarp",
  "capturedAt": "2026-10-13T03:35:39Z",
  "ap17": { "path": "…/work/tia.ap17", "sizeBytes": 0, "lastModified": "…" },  // 佐证，非依据
  "objects": {
    "blocks|010_Cell/|FB_Motor": {
      "category": "blocks", "name": "FB_Motor", "group": "010_Cell/",
      "simaticType": "FB", "number": "34",
      "tiaObjectId": null,                              // 目标态；现在为 null
      "facets": { "Code": "<opaque>", "Interface": "<opaque>", "Comments": "<opaque>" }
    }
  }
}
```

> `ap17.lastModified` 只是**佐证**：`.ap17` 一存就变、TIA 打开也可能触碰，
> 单独采信它会得到错误的变更结论（[`docs/decisions.md`](../../../docs/decisions.md) D6 的背景）。
> 它与指纹**不一致**时，要在结果里报"三份东西版本不一致"，而不是挑一个用。

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
│   ├── paths.ts          归一化、包含性校验、slug、portable 路径
│   ├── workspace.ts      作用域根解析 + **只读**的 workspaceRegistry 访问（按名取，不 import）
│   ├── registry.ts       `_dsh-eng/projects.json` 的原子写与防御性读
│   ├── scope.ts          四元组 + 一致性事实（路径存在性、warning）
│   ├── dsh-runtime.d.ts  手写环境声明（含 exec.agent.session.header.cwd 与 RawJsonSchema）
│   └── tools/            outcome.ts（共用信封）/ status.ts / project.ts / scope.ts / index.ts
├── scripts/              link-dsh-runtime.mjs（**从不抽取**缓存）/ tsc.mjs / run-tests.mjs
├── docs/                 本文 / PATH-RULES.md / decisions.md
└── test/                 node:test（37 项）+ helpers/harness.mjs
```

后续期次新增的模块（P1–P3）：`src/version/`（`execFile(git)`）、`src/change/`（指纹客户端、
基线、diff）、`src/context/`（变更台账）、`skills/engineering-context/SKILL.md`。

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
| **P0** | 作用域 + 工程注册表（`eng_status` / `eng_project` / `eng_scope`） | 纯 FS + 宿主 registry | "我现在在哪个工程的哪一版" —— **不需要 TIA** | ✅ **已实现**（37 项测试通过） |
| **P1** | 版本层（`eng_version`）+ 导出物入库 | git | 导出的文本源终于有分支与历史 | ⬜ |
| **P2** | 变更引擎（`eng_changes` / `eng_export`）+ 增量闭环 | **缝 A + V17 指纹实测** | D6/D9 的工作循环 | ⬜ |
| **P3** | 变更台账（`eng_context`）+ 项目级 skill + 对族 3 暴露 `ctx.engineeringScope` | P2 | 期望二 | ⬜ |

**P0 的实际产出**：`src/` 下 7 个模块 + `src/tools/` 下 5 个文件、`test/` 4 个测试文件
（37 项，全通过、无跳过）、`scripts/` 3 个脚本。**没有** `ctx.effect` —— 本插件不持有任何
自有资源（不起子进程、不开句柄），所以 `apply` 注册完工具就返回。
**没有** `skills/`：文档交付物（D4 三问）在 P3 与项目级 skill 一起做，P0 的三问写在工具描述里。

### 验收口径（对齐 `docs/roadmap.md` §3）

| 口径 | 怎么验 | 离线可测？ | P0 |
|---|---|---|---|
| 可重复 | 给定「project/branch/version」两次物化，导出物逐字节一致 | ✅ | P1/P2 |
| **不串味** | 两个 workspace 各放同名块/同名 UDT，交叉查询互不可见；越界路径被拒 | ✅ | ✅ 已测（两个 workspace + 同名 id；`path_outside_workspace`） |
| 作用域显式 | 每个工具结果都带四元组 | ✅ | ✅ 已测（含三档 workspace 身份） |
| **变更不漏报不误报** | stub 控制器喂录制的指纹：未改动 → `changed = 0`；只改注释 → 只报 `Comments`；只改代码 → 只报 `Code` | ✅（fixture） | ⬜ P2 |
| 增量可验证 | 改一个块后，导出集合 **==** 指纹报告的集合（D9 闭环） | ⚠️ 需真机 | ⬜ P2 |
| 失效可感知 | 人为让基线/导出物/`.ap17` 三者版本错配 → 必须**报不一致**，不得静默 | ✅ | 🟡 部分：注册表损坏/异 workspace 已测；导出物/基线错配待 P2 |
| 上下文预算 | 每个工具结果 ≤4KB；工具目录开销可复算 | ✅ | ✅ 列表封顶 20 行、细节封顶 40 行 |

测试形态：**`node:test`**（与 `dsh-tia-openness-v17-min` 一致），断言跑在**真实**运行时上 ——
工具的 schema 由 `defineTool` 真的编译，结果也由运行时的 `validateJsonSchemaValue` 真的校验。

---

## 11. 风险与待验证（**需要人看的部分**）

| # | 事项 | 影响 | 处置 |
|---|---|---|---|
| 1 | **V17 上 `FingerprintProvider` 的可得性与粒度未实测** | P2 的分面能力；若拿不到，只能退到"变没变"（`PlcChecksumProvider`） | [`docs/decisions.md`](../../../docs/decisions.md) 待验证清单第 1 条；P0/P1 不受影响 |
| 2 | **对象身份键缺位**（§5.2） | 期望三（跨版本关联） | 需族 1 补 `tiaObjectId` + 实测改名/重导后的稳定性 |
| 3 | **一次全项目指纹的耗时与帧大小未测** | 决定要不要做"指纹缓存 + 只重算可疑对象" | 手册说 `GetFingerprints()` **每次重算**；1152 块项目未测 |
| 4 | 缝 A 的具体服务名与接口面未最终定 | 族 1 与族 2 的接缝 | 已给出最小接口面（§5.3）；两边同步即可 |
| 5 | 宿主 workspace 服务是**可选**的（组合里没挂 `dsh-workspace` 时 `ctx.get` 返回 `undefined`） | `registered` 恒为 false | 已设计降级（§4.1 / N2），不阻塞 |

---

## 12. 非目标

- ❌ 不解析 XML、不建图（族 3）。
- ❌ 不自己起控制器、不直接调 Openness（族 1；且一宿主只允许一个控制器，D2）。
- ❌ 不重做宿主的 workspace/session 分组，也不改宿主的 workspace 记录。
- ❌ 不复用 `todo_write` 承载工程变更台账，也不复用 `ctx.workspaceChanges` 当工程级变更检测。
- ❌ 不把 `.ap17` 纳入 git；不用 manifest 的 `sha256` 当变更键。
- ❌ 不把 git 的原始命令能力暴露给模型。
- ❌ 不按"控制器操作"1:1 铺工具（那是 26 工具 ≈14k tokens 常驻的老路）。
