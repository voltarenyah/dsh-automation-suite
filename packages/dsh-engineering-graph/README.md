# @voltarenyah/dsh-engineering-graph

DeepSeek Harness 插件（**工程知识图谱插件**）：在工程产物（块逻辑、交叉引用等）之上
建立可查询的知识图谱。

> **实现状态：TypeScript 半边已接通引擎，并已登记进蓝图。**
> 本包导出**两个 Loader 行**：
>
> | 行 | 包入口 | 导出 |
> |---|---|---|
> | **宿主行**（host row） | `"."` → `lib/index.js` | `name` = `engineering-graph`、`inject` = `[]`、`Config`、`apply`、`resolveConfig`、`resolveEnginePath`、`EngineClient` |
> | **工具行**（tools row） | `"./tools"` → `lib/tools-entry.js` | `name` = `engineering-graph-tools`、`inject` = `['tools', 'knowledgeEngine']`、`Config`（`includeIngest`）、`apply`、`resolveToolsEntryConfig` |
>
> 宿主行**不注册任何工具**：它持有引擎子进程（**首次请求时**才启动，卸载时 `stop()`）并发布两个
> cordis 服务 —— 给别的插件用的 `knowledgeGraph`，以及给本包自己的工具行用的内部缝
> `knowledgeEngine`。**八个工具**由工具行注册：`knowledge_workspace` / `knowledge_schema` / `knowledge_ingest` / `knowledge_query`，加四个下钻工具 `knowledge_search` / `knowledge_block` / `knowledge_network` / `knowledge_variable_usage`（后者由 `includeDrilldown` 开关控制，见 §2.2）
> 注册，所以**哪个 agent 看得见它们由 preset 决定**（见 §2.2）。
> C# 引擎（`engine/`，`EngineeringGraph.Engine`）由另一条工作线 vendoring 进来；
> 引擎缺席时两行都照常加载，宿主行只打一条警告，三个引擎后端工具每次调用以 `engine_not_found` 失败
> —— 而 `knowledge_workspace` 不碰引擎，照常可用（见 §2）。
> 已登记进 `profile/dsh-automation-suite/` 的 `dsh.profile.bundles`，并已被族 2 的工作流消费：
> 工程上下文插件的 `create_engineering_project` 在导出完成后逐设备调用 `knowledgeGraph.ingestDevice`
> （族 2 的 D25；那一步是软的 —— 本包缺席或引擎不可达只报"图谱未建成"，不让它的流程失败）。

---

## 1. 它管什么

| 概念 | 归属 |
|---|---|
| **引擎** | 本包内 vendored 的 C# 可执行文件 `engine/bin/EngineeringGraph.Engine.exe`（默认位置见 §3） |
| **宿主行** | 本目录的 TypeScript 外壳：解析配置、定位引擎、持有引擎子进程的生命周期（`EngineClient` + `ctx.effect`），发布两个服务 |
| **工具行** | 最多八个工具：`knowledge_workspace` / `knowledge_schema` / `knowledge_ingest` / `knowledge_query` + 四个下钻工具（见 §2.1），由 preset 按需声明 |
| **服务面（公开）** | 一个 cordis 服务 `knowledgeGraph`（`src/service.ts`）：`status()` + `ingestDevice(deviceDir, opts?)`。它是给**另一个插件**用的缝（族 2 的 `create_engineering_project` 在导出后逐设备调用它），工具与它共用同一套请求与信封转换，所以两边永远不会对默认值或错误形状各说各话 |
| **服务面（内部）** | 一个 cordis 服务 `knowledgeEngine`（`src/runtime-service.ts`）：`request(operation, params, options?)`。它是**本包自己的工具行**读回宿主行引擎的缝，**不是**给别的插件用的接口；外部插件该用的仍然是 `knowledgeGraph` |

工具名刻意保留来源库（`Tools/KnowledgeTools.cs`）的 `knowledge_*` 命名，而不是本仓
verb_noun 风格：改名会静默打断按旧名字写的提示词与调用方。

与接口插件族/工程上下文插件的分工：接口插件族（`dsh-tia-openness-v17-min`）是唯一允许打开 TIA Portal 的插件；
工程上下文插件（`dsh-engineering-context`）管"现在谈的是哪个工程、哪一版"，并在导出完成后
经 `knowledgeGraph` 服务触发本包建库；本包只消费导出的工程产物，
不直接调用 Openness、不启动 TIA Portal。

## 2. 引擎缺席时的行为（硬约束）

宿主行的 `apply` **永不抛错**：

- 引擎可执行文件不存在 → 以 `warn` 级别打出一条日志，写明**解析出的路径**、
  **来源**（`config` 还是 `package`）以及**如何构建**（
  `dotnet build engine/EngineeringGraph.Engine.csproj -c Release`），然后继续；
- 插件加载本身不受影响 —— 缺引擎**不会**变成插件加载失败；
- 工具行**照样注册**四个工具：引擎后端三个每次调用以传输错误 `engine_not_found` 失败（消息以错误码开头），`knowledge_workspace` 不碰引擎，照常可用，
  这样模型能区分"引擎拒绝了这条语句"与"根本没有引擎"。

宿主行的 `apply` 注册**一个** `ctx.effect` 清理器持有 `EngineClient`：引擎在**第一次请求**时才被
spawn（`apply` 不预热，所以缺引擎时加载没有任何副作用），卸载（或宿主关闭）时由该 disposer
`await client.stop()` 停掉子进程；`stop()` 可重复调用，不会留下子进程。
**构造 `knowledgeEngine` 服务不会启动任何东西** —— 它只保存依赖，`request` 原样转给
`EngineClient`，所以"懒启动"这个性质在拆行之后仍然成立。

## 2.1 工具面与统一信封

| 工具 | 引擎操作 | 作用 | 写入 |
|---|---|---|---|
| `knowledge_workspace` | —（本地文件，不经引擎） | 这个 workspace 是哪个工程、每个设备的库在哪、多大、什么时候写的；缺库时给出 `device_dir` | 否 |
| `knowledge_schema` | `GetSchema` | 图谱 schema：DDL、节点种类、边类型、示例查询 | 否 |
| `knowledge_ingest` | `Ingest` | 爬取导出目录 → 解析成图 → 写入 SQLite（**整库重建**） | 写 `.db` |
| `knowledge_query` | `Query` | 单条只读 `SELECT`/`WITH`/`EXPLAIN`（逃生舱） | 否 |
| `knowledge_search` | `Query`（TS 拼 SQL） | 在节点名 / 网段标题 / 译出的逻辑里找一段文本 | 否 |
| `knowledge_block` | `Query`（TS 拼 SQL） | 一个块：属性 + 网段紧凑清单（索引/标题/逻辑字符数） | 否 |
| `knowledge_network` | `Query`（TS 拼 SQL） | 一个网段：读/写变量 + 逻辑**分块**续读 | 否 |
| `knowledge_variable_usage` | `Query`（TS 拼 SQL） | 一个变量的全部使用点（read / write / mention） | 否 |

四者的名字、顺序、参数、描述与渲染都是**冻结的**契约。`knowledge_workspace` 是唯一的本地工具，它声明**自己的信封**（`ok`/`tool`/`summary`/`details`/`data`/`warnings`/`error`）而不是引擎信封 —— 报一个引擎从没跑过的 `operation` 就是撒谎（`src/workspace-tool.ts` 的模块注释）。唯一可变的只有"`knowledge_ingest` 在不在"
（工具行的 `includeIngest`，见 §2.2）：另外三个工具在任何配置下都完全一致。四个下钻工具由 `includeDrilldown` 控制：`none`（默认）/ `inspect`（只加 block + network）/ `all`（四个都加）。

**四个下钻工具用 TypeScript 拼固定 SQL，走现有 `Query` 操作**（**D24** §5）：`knowledge_search`（FTS5 `knowledge_search` 索引，<3 字符退化 LIKE）、`knowledge_block`、`knowledge_network`（逻辑默认 3000 字符、硬顶 6000，给 `offset`/`nextOffset`）、`knowledge_variable_usage`（READS/WRITES 边 + 文本 mention 合并）。**没有一条改 C#、改协议白名单或重发 `engine/bin`**。每个工具都自己限界：长值截断、明细行按字符预算裁剪、超出给"下一页怎么取"的指引，**绝不把"其余在 data 里"当作答复**（框架只把 `render` 的文本交给模型）。**D26** 又收紧了两处：`knowledge_block` 的总数来自同一条语句的 `COUNT`（`Networks: 50 of 72`，不再把分页大小当总数），`knowledge_network` 一旦只给出一段就在 summary 里写 `PARTIAL 0–6000 of 93742` 并附一条可复制的 `NEXT:` 续读指令。

**`knowledge_query` 的渲染同样是预算化的**：逐字段默认截断到 200 字符（`max_field_chars` 可调到 3500，用来整段读一条长逻辑）、整段渲染有字符预算，超出的行数如实计数并提示用 `LIMIT`/`OFFSET` 翻页 —— 原先那句"其余在 `data.rows`"已删除，因为 `data` 到不了模型。**整网被注释掉的网络**（**D25**）在 `knowledge_network` 里直接说"no executable logic — the source is commented out"并附原文，在 `knowledge_block` 的列表里标 `COMMENTED OUT`。

**`knowledge_query` 的 `db_path` 可以省略**（2026-10-19，发行版 **D24**）。省略时它读会话工作目录：

1. `knowledge/` 下**恰好一个**设备有库 → 就用它（`data.dbPath` 会回显解析结果）；
2. **零个** → `ok:false` + `DB_NOT_FOUND`，remediation 写明该跑哪个 `knowledge_ingest`（带 `device_dir`）
   或先建工程；
3. **两个及以上** → `ok:false` + `DB_AMBIGUOUS`，remediation 列出全部候选并要求显式传 `db_path`。

三个分支都**不会**先问引擎：拒绝路径上引擎一次调用都没有（详见 `test/11-workspace.test.mjs`）。
相对路径按会话工作目录解析（引擎是把它按自己的进程目录解析的，那不是调用方想要的）。
"库是不是最新"**不在**这个解析里 —— 新鲜度属于 D13 的第 4 步，仍是 ⬜（见 §6）。

**服务面 `knowledgeGraph`**（`src/service.ts`，供族 2 的 `create_engineering_project` 调用）走的是同一套
`runOperation` + `outcomeOf`，只是没有工具 schema：

- `status()` → `{ available, reason, enginePath, engineExists, source, databaseConvention }`。
  `available:false` 表示引擎可执行文件不在（`status()` **从不启动它**），调用方应只报"图谱未建成"；
- `ingestDevice(deviceDir, { dbPath?, signal?, onProgress? })` → 上面那个规范信封，
  `data` 含 `device` / `dbPath` / `source` / `filesFound` / `filesImported` / `nodes` / `edges` /
  `byKind` / `warnings[]`（`warnings` 里含清单的 `failures[]`，即 TIA 拒绝导出的对象）。
  省略 `dbPath` 时库写到 `<项目根>/knowledge/<设备名>/<设备名>_knowledge.db`（由设备目录往上两级推出）。
  它是**全量重建**、没有新鲜度/增量，所以"每次导出后调一次"是唯一的刷新方式；
  实测 1376 个源文件约 30 s、库约 450 MB。库不进 git：本包自身的 `.gitignore` 挡包内残留，
  **工作区**那一侧由族 2 维护 `knowledge/**/*.db*`（含 SQLite 的 `-wal` / `-shm` / `-journal`，
  见族 2 D25）。

操作失败是**数据**：`ok:false` + `error.code`（`DEVICE_DIR_REQUIRED` / `DEVICE_DIR_NOT_FOUND` /
`NO_SOURCE_FILES` / `MANIFEST_INVALID`），`error.details.remediation` 写着下一步；
只有传输层失败（引擎 exe 不在、握手/请求超时、进程中途退出、协议不匹配）才抛错 —— 消费方据此
把"引擎不可达"与"引擎拒绝了这次建库"分开处理。

每个工具返回同一个 canonical 信封：

```jsonc
{
  "ok": true,                    // 操作本身是否成功
  "operation": "Query",          // 实际执行的引擎操作
  "dryRun": false,               // 引擎没有 dry-run，恒为 false
  "summary": "…一行结论…",
  "data": { /* 引擎负载 */ },
  "changes": [],                 // 引擎不上报，恒为空
  "diagnostics": [],             // 同上
  "error": null,                 // 失败时 { code, message, details: { remediation } }
  "durationMs": 24
}
```

**操作失败**（如 `DROP` → `QUERY_REJECTED`）不抛异常，而是 `ok:false` + `error{}`；
**传输失败**（找不到 exe、握手/请求超时、进程中途退出、协议不匹配）抛错，消息以稳定错误码开头
（`engine_not_found` / `engine_handshake_timeout` / `engine_timeout` / `engine_exited` /
`engine_protocol_mismatch` / `engine_spawn_failed` / `engine_write_failed` / `engine_cancelled`）。

## 2.2 两行与 `includeIngest` 开关

DSH 按**声明作用域**解析工具可见性：一行插件注册的工具会落在宿主（全局）层，被**包括子 agent 在内**
的每个 agent 继承。所以本包把"持有引擎"和"给模型看工具"拆成两行：

| preset | 声明哪几行 | 工具面 |
|---|---|---|
| `leader`（主 agent） | 宿主行 `@voltarenyah/dsh-engineering-graph` + 工具行 `@voltarenyah/dsh-engineering-graph/tools`（`includeDrilldown: inspect`） | 共享四个 + `knowledge_block` / `knowledge_network`（写 brief 用；深读派 `expert`） |
| `expert`（子 agent） | 工具行 `@voltarenyah/dsh-engineering-graph/tools` + `includeIngest: false, includeDrilldown: all` | 上面四个（去掉 ingest）+ 四个下钻工具 = **7 个** |

两行都必须声明宿主行（`leader` 在 bundle 层，`expert` 由 composition 的宿主行提供）——工具行的
`inject: ['tools', 'knowledgeEngine']` 让 loader 等宿主行发布 `knowledgeEngine` 之后才调 `apply`，
所以**声明顺序无所谓**，但宿主行必须在同一个 composition 里。宿主行缺席时工具行的 `apply` 直接抛错
（而不是注册一批调用必然失败的工具），错误文本会指出缺的是哪个服务。

工具行自己的配置只有一个字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `includeIngest` | `true` | `false` 时**不注册** `knowledge_ingest`；另外三个工具的名字、顺序、参数、描述与渲染完全不变 |
| `includeDrilldown` | `none` | `inspect` 追加 `knowledge_block` + `knowledge_network`（主 agent 写 brief 用）；`all` 再追加 `knowledge_search` + `knowledge_variable_usage`（`expert` 用）。旧的 `true`/`false` 等价于 `all`/`none`；无法识别的值回落 `none` 并打 warning（**D25**） |

```yaml
# expert preset 里的那一行
- id: expert-graph-tools
  name: '@voltarenyah/dsh-engineering-graph/tools'
  config:
    includeIngest: false
    includeDrilldown: all
```

**子 agent 故意关掉 ingest**：`knowledge_ingest` 是重度写操作 —— 整库重建，一台设备一个 `.db`，
实测 1376 个源文件约 30 s、库约 450 MB。它属于**主 agent 的建工程流程**
（族 2 的 `create_engineering_project` 在导出后逐设备经 `knowledgeGraph` 触发），不属于一次只读调查。
`expert` 的职责是"回答一个被委派的问题"：它需要 `knowledge_workspace` 拿到库路径、`knowledge_schema` 看表结构，
以及四个下钻工具**真正去读程序逻辑**（`knowledge_query` 留给它们都覆盖不到的问题）；给它 ingest 等于给它一条
静默重写整个图谱库的路径。

只有**真正的布尔 `false`** 会关掉 ingest：省略、`undefined`、字符串 `"false"`、`0` 等都回落到默认
`true`（与 `src/config.ts` 的 `flag()` 同一套规则），所以一个写错类型的 preset 不会静默丢掉工具。

## 3. 配置

### 3.1 宿主行（`"."`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enginePath` | `''` | 引擎可执行文件路径。空 = 自动解析到**本包内置副本**；非空 = 原样采用（相对路径按进程工作目录解析），`source` 报 `config` |
| `requestTimeoutMs` | `300000` | 单次引擎操作的截止时间（毫秒），下限 1000 |
| `startupTimeoutMs` | `30000` | 引擎 ready 握手的截止时间（毫秒），下限 1000 |
| `logEngineOutput` | `false` | 是否把引擎自身的 stdout/stderr 转发到插件日志 |

### 3.2 工具行（`"./tools"`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `includeIngest` | `true` | 是否注册 `knowledge_ingest`（见 §2.2） |

时间字段用 `Schema.natural()`（非负整数），与接口插件族的写法一致；`resolveConfig` 重新施加
同一套默认值与范围校验（钳到下限而不是拒绝），所以即使不经 loader 的 schema 解析
（例如测试直接调用 `apply`）行为也一致。工具行同理：`resolveToolsEntryConfig` 重新施加
`includeIngest` 的默认值，**永不抛错**，只信任真正的布尔值。

**默认引擎路径**（相对本包根目录）：

```
engine/bin/EngineeringGraph.Engine.exe
```

`resolveEnginePath('')` 返回该路径且 `source === 'package'`；`resolveEnginePath(<非空>)`
返回该路径且 `source === 'config'`。命名规则见 `docs/decisions.md` D17。

## 4. 目录布局（本包自身）

```
packages/dsh-engineering-graph/
├── src/
│   ├── index.ts            # 宿主行（包 "."）：引擎生命周期 + 两个服务，不注册工具
│   ├── tools-entry.ts      # 工具行（包 "./tools"）：Config(includeIngest) + 注册四个工具
│   ├── workspace.ts        # 发现逻辑：工程身份 / 设备 / 库路径与 mtime / 单库解析与多库拒绝
│   ├── workspace-tool.ts   # knowledge_workspace 的定义、本地信封与渲染（不经引擎）
│   ├── runtime-service.ts  # 内部缝 knowledgeEngine：宿主行交给自己的工具行
│   ├── service.ts          # 公开缝 knowledgeGraph：给工程上下文插件用
│   ├── tools.ts            # 工具注册面：discovery 工具 + 三个引擎工具的 defineTool 定义与渲染；query 的渲染预算
│   ├── local-outcome.ts    # 本地工具共用的信封（ok/tool/summary/details/data/warnings/error）
│   ├── drilldown.ts        # 四个下钻工具的固定 SQL、转义、行整形、逻辑分块（纯函数）
│   ├── drilldown-tools.ts  # 四个下钻工具的 defineTool 定义与有界渲染
│   ├── config.ts           # 宿主行配置（enginePath / 超时 / logEngineOutput）
│   ├── engine-client.ts    # 引擎子进程：懒启动、串行化、超时、终止
│   ├── engine-path.ts / protocol.ts / errors.ts
│   └── dsh-runtime.d.ts    # 手写的 DSH 运行时声明（抽取的运行时不含 .d.ts）
├── scripts/                # 构建 / 测试 / 运行时链接脚本
├── test/                   # node:test 套件，驱动构建后的 lib/
└── engine/                 # vendored C# 引擎（另一条工作线；本包只读它的 bin/）
    ├── bin/                # 构建产物，.gitignore 忽略
    └── obj/                # 中间产物，.gitignore 忽略
```

`.gitignore` 覆盖 `engine/bin/` 与 `engine/obj/`：漏掉它们时 `git add -A` 会把 .NET
构建产物一起提交（`docs/decisions.md` D17 记录的事故）。

## 5. 开发

```powershell
# 自带 pnpm 的位置随宿主升级会变（0.2.1-rc.2 在 primary-runtime\dependencies\pnpm\bin\，
# 0.2.0-rc.2 在 runtime\pnpm\bin\）；脚本里按候选列表探测，别写死一个。
$pnpm = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

node $pnpm --filter @voltarenyah/dsh-engineering-graph run link:runtime   # 裸 checkout 首次
node $pnpm --filter @voltarenyah/dsh-engineering-graph run build
node $pnpm --filter @voltarenyah/dsh-engineering-graph run typecheck
node $pnpm --filter @voltarenyah/dsh-engineering-graph run test          # 先构建再跑
```

- **构建形态**：`tsc` → `lib/`，测试 `node:test`，`lib/` **不提交**（与工程上下文插件一致；
  登记进蓝图后按接口插件族的约定改为提交）。
- `scripts/link-dsh-runtime.mjs` 只链 `@deepseek-ai/*`（`RUNTIME_ROOTS` = 本包 `src/`
  与 `test/` 真正直接 import 的那些：`cordis`、`dsh-tools`、`schemastery`），且**从不抽取**
  运行时缓存 —— 那个目录在仓库之外、无法用 git 恢复；缺缓存时请先跑兄弟包的抽取器。
  `typescript` / `@types/node` 由根 `pnpm install` 提供。测试的 harness 在裸 checkout 上会
  自行调 `linkRuntime()` 补链接（与接口插件族一致），但同样绝不抽取缓存。
- `src/dsh-runtime.d.ts` 是手写的宿主运行时环境声明：抽取出来的运行时不含 `.d.ts`。
  新增任何 `@deepseek-ai/*` import 或访问新成员时，必须同步该文件与 `RUNTIME_ROOTS`。
- **`package.json` 的 `exports` 必须同时有 `"."`、`"./tools"` 与 `"./package.json"`**：preset 里那两行
  的 `name` 是逐字比对模块标识符的，漏掉 `"./tools"` 会让工具行在加载期报模块解析失败。
  构建仍是纯 `tsc`（`node scripts/tsc.mjs`），`src/tools-entry.ts` 自动产出 `lib/tools-entry.js`，
  不需要额外配置。

## 6. 边界

不做：直接调用 Openness / 启动 TIA Portal（接口插件族）、工程注册表与版本层（工程上下文插件）、
解析 XML 与建图逻辑本身（在 C# `engine/` 里）。本包只负责"模型怎么问、引擎怎么被拥有"。

**`knowledgeEngine` 不是公开接口。** 它是本包两行之间的内部缝（§1），别的插件该用的仍然是
`knowledgeGraph`。两者刻意分开：`knowledgeGraph` 是"请帮我重建一台设备的库"的业务请求，
`knowledgeEngine` 是"把这次请求转给引擎"的管道；把后者暴露出去等于给外部插件第二个驱动引擎的入口，
而这个入口的生命周期属于 preset 里那一行工具，不属于 composition。

已知限制（实测，2026-10）：

- **引擎 stdout 的非 ASCII 会被降级成 `?`**。请求方向是安全的（`asciiStringify` 把非 ASCII
  转成 `\uXXXX`，引擎解回原字符串），但引擎写 stdout 时用的是继承来的控制台代码页，无法映射的
  字符变成 `?`。当宿主进程自身挂在控制台上时才会出现。修法在引擎侧（首帧之前设
  `Console.OutputEncoding = new UTF8Encoding(false)`），本包不猜代码页。
  `engine/fixtures` 除 BOM 外全是 ASCII，所以测试套件不依赖这条。
- `stop()` 的优雅路径是关 stdin（引擎读到 EOF 即退出）；宽限期 `SHUTDOWN_GRACE_MS = 5000`，
  之后强杀。这是常量而**不是**配置项：引擎不持有会话状态（接口插件族的 `shutdownGraceMs` 是为
  TIA Portal 会话存在的），profile 没有理由调它。
- 工具**不**暴露 `dry_run`：引擎的 `Ingest` 没有预演模式，凭空造一个参数就是撒谎。
