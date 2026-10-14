# @voltarenyah/dsh-engineering-graph

DeepSeek Harness 插件（**插件族 3 · 工程知识图谱**）：在工程产物（块逻辑、交叉引用等）之上
建立可查询的知识图谱。

> **实现状态：仅 TypeScript 骨架。**
> 本包现在只有插件外壳：导出 `name` / `inject` / `Config` / `apply` / `resolveConfig` /
> `resolveEnginePath`，**不注册任何工具**，也**不启动任何子进程**。
> C# 引擎（`engine/`，`EngineeringGraph.Engine`）由另一条工作线 vendoring 进来；
> 引擎缺席时插件照常加载，只打一条警告（见 §2）。
> 本包**尚未**登记进 `profile/dsh-automation-suite/` 的 `dsh.profile.bundles` ——
> 按约定，等第一个工具真正可用后再登记。

---

## 1. 它管什么

| 概念 | 归属 |
|---|---|
| **引擎** | 本包内 vendored 的 C# 可执行文件 `engine/bin/EngineeringGraph.Engine.exe`（默认位置见 §3） |
| **插件** | 本目录的 TypeScript 外壳：解析配置、定位引擎、持有引擎子进程的生命周期（**尚未接上**） |
| **工具面** | 尚未实现 —— 本阶段刻意不 `ctx.tools.register(...)` |

与族 1/族 2 的分工：族 1（`dsh-tia-openness-v17-min`）是唯一允许打开 TIA Portal 的插件；
族 2（`dsh-engineering-context`）管"现在谈的是哪个工程、哪一版"；本包只消费导出的工程产物，
不直接调用 Openness、不启动 TIA Portal。

## 2. 引擎缺席时的行为（硬约束）

`apply` **永不抛错**：

- 引擎可执行文件不存在 → 以 `warn` 级别打出一条日志，写明**解析出的路径**、
  **来源**（`config` 还是 `package`）以及**如何构建**（
  `dotnet build engine/EngineeringGraph.Engine.csproj -c Release`），然后继续；
- 插件加载本身不受影响 —— 缺引擎**不会**变成插件加载失败。

`apply` 还会注册**一个** `ctx.effect` 清理器：这是引擎子进程将来挂接的接缝（disposer），
目前**不持有任何资源**。所以现在卸载插件是安全的空操作，将来接上子进程后，
卸载（或宿主关闭）即由同一个 disposer 停止引擎。

## 3. 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enginePath` | `''` | 引擎可执行文件路径。空 = 自动解析到**本包内置副本**；非空 = 原样采用（相对路径按进程工作目录解析），`source` 报 `config` |
| `requestTimeoutMs` | `300000` | 单次引擎操作的截止时间（毫秒），下限 1000 |
| `startupTimeoutMs` | `30000` | 引擎 ready 握手的截止时间（毫秒），下限 1000 |
| `logEngineOutput` | `false` | 是否把引擎自身的 stdout/stderr 转发到插件日志 |

时间字段用 `Schema.natural()`（非负整数），与族 1 的写法一致；`resolveConfig` 重新施加
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

- **构建形态**：`tsc` → `lib/`，测试 `node:test`，`lib/` **不提交**（与族 2 一致；
  登记进蓝图后按族 1 的约定改为提交）。
- `scripts/link-dsh-runtime.mjs` 只链 `@deepseek-ai/*`（`RUNTIME_ROOTS` = 本包 `src/`
  与 `test/` 真正直接 import 的那些），且**从不抽取**运行时缓存 ——
  那个目录在仓库之外、无法用 git 恢复；缺缓存时请先跑兄弟包的抽取器。
  `typescript` / `@types/node` 由根 `pnpm install` 提供。
- `src/dsh-runtime.d.ts` 是手写的宿主运行时环境声明：抽取出来的运行时不含 `.d.ts`。
  新增任何 `@deepseek-ai/*` import 或访问新成员时，必须同步该文件与 `RUNTIME_ROOTS`。

## 6. 边界

不做：直接调用 Openness / 启动 TIA Portal（族 1）、工程注册表与版本层（族 2）、
解析 XML 与建图逻辑本身（在 C# `engine/` 里）。本包只负责"模型怎么问、引擎怎么被拥有"。
