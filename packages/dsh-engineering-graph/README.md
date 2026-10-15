# @voltarenyah/dsh-engineering-graph

DeepSeek Harness 插件（**工程知识图谱插件**）：在工程产物（块逻辑、交叉引用等）之上
建立可查询的知识图谱。

> **实现状态：TypeScript 半边已接通引擎。**
> 本包导出 `name` / `inject` / `Config` / `apply` / `resolveConfig` / `resolveEnginePath` /
> `EngineClient` / `registerTools`，注册**三个工具**（`knowledge_schema`、
> `knowledge_ingest`、`knowledge_query`），并由 `ctx.effect` 持有引擎子进程（**首次请求时**
> 才启动，卸载时 `stop()`）。
> C# 引擎（`engine/`，`EngineeringGraph.Engine`）由另一条工作线 vendoring 进来；
> 引擎缺席时插件照常加载并注册工具，只打一条警告，每次调用以 `engine_not_found` 失败（见 §2）。
> 本包**尚未**登记进 `profile/dsh-automation-suite/` 的 `dsh.profile.bundles` ——
> 按约定，等验收通过后再登记。

---

## 1. 它管什么

| 概念 | 归属 |
|---|---|
| **引擎** | 本包内 vendored 的 C# 可执行文件 `engine/bin/EngineeringGraph.Engine.exe`（默认位置见 §3） |
| **插件** | 本目录的 TypeScript 外壳：解析配置、定位引擎、持有引擎子进程的生命周期（`EngineClient` + `ctx.effect`） |
| **工具面** | 三个工具：`knowledge_schema` / `knowledge_ingest` / `knowledge_query`（见 §4） |

工具名刻意保留来源库（`Tools/KnowledgeTools.cs`）的 `knowledge_*` 命名，而不是本仓
verb_noun 风格：改名会静默打断按旧名字写的提示词与调用方。

与接口插件族/工程上下文插件的分工：接口插件族（`dsh-tia-openness-v17-min`）是唯一允许打开 TIA Portal 的插件；
工程上下文插件（`dsh-engineering-context`）管"现在谈的是哪个工程、哪一版"；本包只消费导出的工程产物，
不直接调用 Openness、不启动 TIA Portal。

## 2. 引擎缺席时的行为（硬约束）

`apply` **永不抛错**：

- 引擎可执行文件不存在 → 以 `warn` 级别打出一条日志，写明**解析出的路径**、
  **来源**（`config` 还是 `package`）以及**如何构建**（
  `dotnet build engine/EngineeringGraph.Engine.csproj -c Release`），然后继续；
- 插件加载本身不受影响 —— 缺引擎**不会**变成插件加载失败；
- 三个工具**照样注册**：每次调用以传输错误 `engine_not_found` 失败（消息以错误码开头），
  这样模型能区分"引擎拒绝了这条语句"与"根本没有引擎"。

`apply` 注册**一个** `ctx.effect` 清理器持有 `EngineClient`：引擎在**第一次请求**时才被
spawn（`apply` 不预热，所以缺引擎时加载没有任何副作用），卸载（或宿主关闭）时由该 disposer
`await client.stop()` 停掉子进程；`stop()` 可重复调用，不会留下子进程。

## 2.1 工具面与统一信封

| 工具 | 引擎操作 | 作用 | 写入 |
|---|---|---|---|
| `knowledge_schema` | `GetSchema` | 图谱 schema：DDL、节点种类、边类型、示例查询 | 否 |
| `knowledge_ingest` | `Ingest` | 爬取导出目录 → 解析成图 → 写入 SQLite（**整库重建**） | 写 `.db` |
| `knowledge_query` | `Query` | 单条只读 `SELECT`/`WITH`/`EXPLAIN` | 否 |

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

## 3. 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enginePath` | `''` | 引擎可执行文件路径。空 = 自动解析到**本包内置副本**；非空 = 原样采用（相对路径按进程工作目录解析），`source` 报 `config` |
| `requestTimeoutMs` | `300000` | 单次引擎操作的截止时间（毫秒），下限 1000 |
| `startupTimeoutMs` | `30000` | 引擎 ready 握手的截止时间（毫秒），下限 1000 |
| `logEngineOutput` | `false` | 是否把引擎自身的 stdout/stderr 转发到插件日志 |

时间字段用 `Schema.natural()`（非负整数），与接口插件族的写法一致；`resolveConfig` 重新施加
同一套默认值与范围校验（钳到下限而不是拒绝），所以即使不经 loader 的 schema 解析
（例如测试直接调用 `apply`）行为也一致。

**默认引擎路径**（相对本包根目录）：

```
engine/bin/EngineeringGraph.Engine.exe
```

`resolveEnginePath('')` 返回该路径且 `source === 'package'`；`resolveEnginePath(<非空>)`
返回该路径且 `source === 'config'`。命名规则见 `docs/decisions.md` D17。

## 4. 目录布局（本包自身）

```
packages/dsh-engineering-graph/
├── src/                    # 插件源码（tsc 编译到 lib/）
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
$pnpm = "C:\Users\Ansel\AppData\Local\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs"

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

## 6. 边界

不做：直接调用 Openness / 启动 TIA Portal（接口插件族）、工程注册表与版本层（工程上下文插件）、
解析 XML 与建图逻辑本身（在 C# `engine/` 里）。本包只负责"模型怎么问、引擎怎么被拥有"。

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
