# TIAOpennessV17Min

> DeepSeek Harness 插件：通过 TIA Portal V17 Openness 对 PLC 程序块做**最小化**读写
> （导出 / 导入 Simatic ML、外部源生成块、编译验证）。
>
> A DeepSeek Harness plugin that exposes TIA Portal V17 Openness as six model-facing
> tools backed by a whitelisted C# controller subprocess. Writes are dry-run by
> default, run in an exclusive-access transaction, and are read back for
> verification.

---

## 1. 它解决什么问题

模型需要读取/修改 TIA Portal 项目里的 PLC 程序块，但：

- Openness 只能被 .NET Framework 64 位进程调用，不能直接从 Node 进程调用；
- Openness 对象**非线程安全**，并且一次只能有一个 Openness 客户端；
- 写操作如果失败，必须保证项目不被写坏；
- 不能把"任意代码执行"能力暴露给模型。

本插件用**两层**解决：

```
┌─ DSH 宿主进程 (Node) ──────────────────────────┐
│  dsh-tia-openness-v17-min (本插件, TypeScript) │
│   • 注册 6 个工具                               │
│   • ctx.effect() 拥有 C# 控制器子进程           │
│   • 请求串行化 / 超时 / 硬超时终止与重启         │
│   • 结构化错误 → 结构化工具结果                  │
└───────────────┬────────────────────────────────┘
                │ NDJSON over stdin/stdout（一行一帧）
┌───────────────▼────────────────────────────────┐
│  TiaOpennessV17Min.Controller.exe (C#, x64,    │
│  .NET Framework 4.8)                           │
│   • 先注册程序集解析器，再加载                  │
│     Siemens.Engineering.dll（V17）              │
│   • 只执行 5 个白名单操作                       │
│   • 写入 = ExclusiveAccess + Transaction        │
│   • 写后读回验证                                │
│   • 返回结构化 JSON                             │
└────────────────────────────────────────────────┘
```

**一个宿主进程只有一个控制器子进程**，因此整个 profile 共享一个 TIA Portal 会话；
来自不同会话的请求在控制器内排队串行执行（Openness 本身也不允许并发）。

---

## 0. 验证状态（请先读这一段）

| 项目 | 状态 |
|---|---|
| TypeScript 构建 / typecheck | ✅ 0 错误 |
| C# 控制器编译（对着本机真实 V17 `Siemens.Engineering.dll`） | ✅ 0 Warning / 0 Error |
| 自动化测试 `npm test` | ✅ **54 项：53 通过 / 0 失败 / 1 跳过**（跳过项为"控制器未构建"的降级路径；其中 9 项覆盖 §4.4 知识库，含 3 项对**真实** skill 注册表的集成测试） |
| C# 控制器自检（无 TIA） | ✅ **14/14**（含"启动时不加载 Openness 程序集"与"Siemens 解析器包可用"） |
| Openness 环境探测（DLL 版本 / 位数 / 用户组） | ✅ `17.0.0.0` / x64 / 已在 `Siemens TIA Openness` 组 |
| 安装进真实 DSH 宿主的加载 / 卸载验证 | ✅ **已验证（真实宿主）**：独立 `DSH_HOME` + 测试 profile 启动真实宿主 → 控制器子进程出现（`apply` 执行、`ctx.effect` 持有）；宿主结束 → 子进程自行退出，无残留。`~/.dsh` 未被修改 |
| 真实 V17 项目上的导出→改→导入→编译 | ✅ **已验证（真实项目）**：237 块项目导出 234 个（3 个被 TIA 拒绝，逐块报告）、改 `HeaderVersion` 导入 override 进原组、写后验证 `passed/changed=True`、重新导出内容为新值、编译 `errors=0`。详见 §0.1 |
| 第二个真实项目（`PEI_SinoARP_Master_V4.1.3`，1152 块，**正式项目**，设备在用户组里） | ✅ 导出 **1151/1152**（1 个 Safety F 块被拒绝并逐块报告），1152 文件 / 70.6 MB，22 个用户组目录层级与非 ASCII 组名（`Fonctions méthode`、`55_Cavité_STD`）均正确；`.ap17` 修改时间未变、无锁文件、无残留进程。该轮又修掉一个缺陷（设备分组 → 见 [REAL-RUN.md](docs/REAL-RUN.md) §D.6、[decisions.md](docs/decisions.md) D16） |

> **关于验证范围**
>
> 上面两行已在**真实环境**跑通，且**没有修改你的默认 profile**：控制器直测、往返测试在项目**副本**上做
> （`C:\tia-openness-test\`），宿主验证用独立 `DSH_HOME`。`~/.dsh/profiles` 仍然是 `desktop, node_modules, web`。
>
> 仍然**待人工验证**的只剩两项（都需要人在界面/真实环境里操作，见
> [`docs/verification.md` §B](docs/verification.md)）：
>
> - **HMR disposer 路径**：在运行中的实例里"禁用/启用插件"，看 `ctx.effect` 的 disposer 停掉并重启子进程
>   （脚本只能验证"宿主结束 → 子进程退出"这条 EOF 路径）；
> - **其他 TIA 版本/其他机器上的 Openness 应用白名单**：本机 V17 上打开真实项目**没有**触发白名单拦截，
>   但 V18+ 或受管环境可能要求白名单条目（官方解析器自带 `WhitelistApp()`，本插件尚未接线）。

### 0.1 真实环境实测结果（本轮）

| 步骤 | 结果 |
|---|---|
| 打开真实项目（副本，`KPH_CellController_0822.ap17`，213 MB） | ✅ 1 个 PLC 软件 `S7-1500/ET200MP station_1 / PLC_KPH_CellController_SIM`，**237 个块**；首次冷启动 70.1 s，热启动 9.8–24.2 s |
| 导出全部块 | ✅ **234 个成功**（235 文件 / 33.9 MB，用户组目录层级保留），3 个被 Openness 拒绝并**逐块记录**：`ProDiagOB`（语言 `ProDiag_OB` 不支持）、`Default_SupervisionFB`（语言 `ProDiag`）、`FOB_RTG1`（Safety F-OB "export is not permitted"）；每个写出文件都读回校验（`verified=True`）+ manifest 记 SHA-256 |
| 导出预演 / 编译预演 | ✅ 正确列出 237 个文件 / 237 个待编译块；239 个 `progress` 帧证明长操作可观测 |
| 修改 → 导入（override）→ 写后验证 | ✅ 改 `HeaderVersion 0.1→0.2`，导入到原组 `999_Kautex`：`committed=True`、`verification.passed=True`、`confirmedCount=1`、`group='999_Kautex/'`、`replacedExisting=True`、`changed=True`、`ModifiedDate` 已更新 |
| 重新导出对比内容 | ✅ 重新导出的 `<HeaderVersion>` = **0.2**（证明改动真的写进了项目，不是"没报错"） |
| 编译 | ✅ `state=Warning, errorCount=0`，`FB_Array_Handling (FB34)` 等块 "successfully compiled" |
| 真空退出 | ✅ 控制器退出后无残留 `TiaPortal.exe`、无残留控制器进程 |
| 真实 DSH 宿主加载/退出 | ✅ 见上表 |

> 这一轮真实项目测试**抓出并修复了 3 个真缺陷**（单元测试无法覆盖的）：
> ① 真实导出的 XML 是 `Document > Engineering > DocumentInfo > SW.Blocks.*`，我的解析器把 `<Engineering>`
> 当成了块元素 → 导入预演拿不到块名、**写后验证静默失效**；② 一个不可导出的块会中止整批导出；
> ③ 导入固定落在根组 → 位于用户组的块即使 `override` 也无法覆盖（"name or number already exists"）。
> 细节与证据见 [`docs/decisions.md`](docs/decisions.md) D14/D15 与
> [`docs/verification.md` §D](docs/verification.md)。

---

## 2. 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows（仅限；插件在其它平台能加载，但所有工具调用会返回 `controller_not_found`） |
| TIA Portal | **V17**（严格绑定，不兼容 V16/V18） |
| Openness DLL | `C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17\Siemens.Engineering.dll`（可用 `--openness-dir` / `TIA_OPENNESS_V17_DIR` 覆盖） |
| .NET Framework | 4.6.1+（本控制器以 **4.8** 为目标框架构建） |
| 进程位数 | **x64**（Openness 是 64 位 API） |
| Windows 用户组 | 当前用户必须属于本地组 **`Siemens TIA Openness`** |
| DSH | 任何能加载 bundle 的版本（`inject: ['tools']`） |
| 重新构建 C# 时才需要 | .NET SDK（\dotnet build\）+ .NET Framework 4.8 targeting pack + **能访问 NuGet 源**（首次还原约 13 秒，见 §7.1） |
| 重新构建 TS 时才需要 | Node ≥ 22.19、`npm install`（只装 typescript 与 @types/node） |

检查用户组：

```powershell
net localgroup "Siemens TIA Openness"
```

---

## 3. 安装

### 3.1 已构建产物

仓库已包含构建结果，安装前无需编译：

- `lib/` —— TypeScript 编译输出（插件入口 `lib/index.js`）
- `controller/bin/TiaOpennessV17Min.Controller.exe`（+ `.exe.config`）—— C# 控制器

### 3.2 安装到 DSH profile

用内置的插件管理器（Web 侧边栏 Plugins 页，或 Creator 模式下的 `plugin_manager` 工具）：

```
plugin_manager(action: "install_bundle", target: "C:\\Users\\Ansel\\dsh-automation-suite\\packages\\dsh-tia-openness-v17-min")
```

或直接在 profile 的 patch 层里加一行（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: tia-openness-v17-min
      name: '@voltarenyah/dsh-tia-openness-v17-min'
      config:
        requestTimeoutMs: 600000     # 大项目导入/编译可能需要更长时间
```

本插件的 bundle patch（`cordis.patch.yml`）只插入自己的条目，不含任何环境相关配置，
因此同一份 bundle 可以装在任意 profile。**profile 的 `patchReload` 不是 `live` 时需要重启 DSH 才会生效。**

### 3.3 配置项（全部有默认值，可整块省略）

| 字段 | 默认 | 说明 |
|---|---|---|
| `controllerPath` | `''` | 控制器 exe 的绝对路径；空 = 使用包内 `controller/bin/...`。也支持环境变量 `TIA_OPENNESS_V17_MIN_CONTROLLER` |
| `opennessDir` | `''` | 传给控制器的 `--openness-dir`；空 = 控制器默认路径 |
| `requestTimeoutMs` | `300000` | 单次操作的硬超时（毫秒）。超时会**终止**控制器（Openness 无法取消），下一次调用自动重启 |
| `startupTimeoutMs` | `30000` | 启动握手超时 |
| `shutdownGraceMs` | `5000` | 卸载时先关闭 stdin 优雅退出，超时后强杀 |
| `maxQueue` | `8` | 排队上限，超出返回 `controller_busy` |
| `logControllerOutput` | `false` | 把控制器的 stdout/stderr 转发到 DSH 日志 |
| `verboseResults` | `false` | 工具结果里附带完整控制器 payload |

---

## 4. 工具

六个工具，统一返回同一个信封（`ok` / `summary` / `data` / `changes` / `diagnostics` / `error`）：

| 工具 | 作用 | 写入 | 默认 dry-run |
|---|---|---|---|
| `open_project` | 打开（或附加到已运行的）TIA Portal V17 项目 | 仅当 `allow_upgrade=true` | 否（升级写入由 `allow_upgrade` 单独把关） |
| `export_blocks` | 导出 PLC 块为 Simatic ML XML（每块一个文件，保留用户组目录） | 否（只写文件系统） | 否 |
| `import_blocks` | 导入 Simatic ML XML 或 SCL/STL 外部源 | **是** | **是** |
| `compile_plc` | 编译 PLC 软件并返回编译结果 | 是（编译状态） | **是** |
| `close_project` | 关闭项目（可选保存、可选关掉 TIA Portal 实例） | 是（保存/关闭会话） | **是** |
| `controller_status` | 报告控制器子进程与 Openness 环境状态 | 否 | —（不启动控制器） |

### 4.1 典型流程：导出 → 修改 → 导入 → 编译

```jsonc
// 1) 打开项目（headless）
{ "project_path": "C:\\Projects\\Line1\\Line1.ap17" }

// 2) 导出全部块（或指定 block_names）
{ "output_dir": "C:\\Projects\\Line1\\export", "block_names": ["Main", "FB_Motor"] }

// 3) 先预演导入（默认 dry_run=true）：校验文件、解析目标块名、报告冲突
{ "import_paths": ["C:\\Projects\\Line1\\export\\FB_Motor.xml"] }
//    → data.ready / data.plan / data.conflicts，项目未被修改

// 4) 真正导入（覆盖已存在块需要 import_options: "override"）
{ "import_paths": ["C:\\Projects\\Line1\\export\\FB_Motor.xml"],
  "import_options": "override", "dry_run": false }
//    → data.committed=true，data.verification.passed=true（读回块集合验证）

// 5) 编译验证
{ "compile_plc": {} }                       // 预演：列出会被编译的块
{ "dry_run": false }                        // 真编译：返回 state/errorCount/warningCount/messages

// 6) 保存并关闭
{ "save": true, "dry_run": false }
```

### 4.2 dry-run 与写入策略

- **写入类操作默认 dry-run**：`import_blocks`、`compile_plc`、`close_project` 的
  `dry_run` 默认 `true`，必须显式传 `dry_run: false` 才真正执行。
- `open_project` 默认 `dry_run: false`，因为默认参数下它**不修改项目内容**；唯一可能的写入
  （把旧版本项目升级为 V17）被独立的 `allow_upgrade`（默认 `false`）把关，属于 fail-closed。
- 每个工具的 `description` 都写明了上述策略，模型可以直接读到。

### 4.3 写后验证

- **导出**：写入的每个 XML 都被读回解析，校验非空、根元素、`<Name>` 与预期块名一致，
  并记录 SHA-256；同时在输出目录写 `_tia-openness-manifest.json` 便于审计。任一文件校验失败
  → 整个调用返回 `verification_failed`，并在 `data` 中给出已写入的文件清单。
- **导入**：事务提交后**重新读取项目块集合**，逐个确认目标块存在，并对比
  `ModifiedDate` / `Number` / `ProgrammingLanguage`；缺失块 → `verification_failed`
  （`data.committed=true` 说明写入确实发生了，错误里同时给出验证报告）。
- **编译**：编译结果作为数据返回（`state`/`errorCount`/`warningCount`/`messages`），
  编译报错**不是**工具错误，而是让模型据此修正。

### 4.4 知识库：随包出货的 Openness skill（`skills/`）

插件把上游 Siemens 的 Openness skill 集
（[`siemens/tia-portal-ai-extensions`](https://github.com/siemens/tia-portal-ai-extensions)，MIT，
commit `b5c7041`）**逐字**打进包里，并注册成模型可见的**一个** skill `tia-openness`：

- **它是什么**：一张「症状 / 任务 → 该读哪个文件」的路由表（独占访问、事务、Simatic ML 往返、
  块组层级、编译、licensing/防火墙、线程、崩溃定位、性能……）。31 个上游文件（每个 4–23 KB）
  作为**资源**放在 `skills/<name>/SKILL.md`，模型按需用 `read` 分段读取 ——
  所以知识库**不占常驻上下文**，只在真正用到时付费。
- **为什么只注册一个**：会话目录是每个会话都要付的持久消息，描述上限 500 字符；31 条目录项会让
  每个（哪怕与 TIA 无关的）会话都替它买单。路由 skill 只占一行，同时把绝对 base directory 交给模型。
- **怎么注册**：`src/skills.ts` 通过 `ctx.inject(['skills'], …)` 注册 bundled provider；
  `skills` **没有**被放进模块级 `inject`，所以未挂 skill 注册表的 profile 里 6 个工具照常可用。
  两条都有单测守着：`test/06-skills.test.mjs` 用替身注册表，`test/07-skills-registry.test.mjs`
  用**真实**的 `@deepseek-ai/dsh-skill` 注册表（含"卸载后目录项消失"）。
- **模型一定会看到它**：每个工具的 description 末尾都带一句
  ``Troubleshooting: load the bundled `tia-openness` skill …``，会话目录里也有同名条目。
- **口径**：上游是 **V21** 时代的语义（modular assemblies、`.s7dcl`/`.s7res`、LTS 链重启），
  本插件是 **V17** 子集 —— 上游回答"Openness 能不能做"，本插件的能力边界仍以
  [§10](#10-已知边界) 与 `docs/` 为准。
- **维护**：`npm run skills:build`（按 pinned commit 重新取上游）/ `npm run skills:check`
  （离线校验 sha256、目录清单、上游依赖图、路由 skill 的体积与引用；已并入 `npm run check`）。
  为什么知识库不放 `docs/`，以及细节与合规说明，见 [`docs/KNOWLEDGE-BASE.md`](docs/KNOWLEDGE-BASE.md)、
  [`skills/README.md`](skills/README.md)、[`AGENTS.md`](AGENTS.md) §2 与
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

## 5. 安全设计

| 措施 | 实现 |
|---|---|
| 操作白名单 | 控制器只接受 `OpenProject` / `ExportBlocks` / `ImportBlocks` / `CompilePlc` / `CloseProject`；其它名字返回 `unsupported_operation`。插件侧同样只发送这 5 个名字（双重校验，互不信任） |
| 禁止任意代码 | 控制器不接受任何 C#/脚本片段，所有参数都是数据（路径、块名、枚举）；没有 `eval` / `Invoke` / `Create` 反射入口 |
| 事务与回滚 | 写入使用 `TiaPortal.ExclusiveAccess()` + `ExclusiveAccess.Transaction(project, "...")`；**只有全部文件成功后**才调用 `CommitOnDispose()`，否则 dispose 即回滚，项目保持不变 |
| 写后验证 | 见 4.3 |
| dry-run | 见 4.2 |
| 无密钥 | 插件不读也不写任何 API Key；配置里只有路径与超时 |
| 资源清理 | 子进程通过 `ctx.effect()` 的 disposer 停止（异步且被框架 await）；控制器退出/卸载时关闭项目并释放它自己启动的 TIA Portal 实例 |
| 结构化错误 | 控制器的任何异常都被转换为 `{code, message, details}`；插件层的传输失败（找不到 exe、握手超时、超时终止）抛 `ToolFailure`，消息以错误码开头 |

> **注意**：控制器子进程被强杀时（超时/取消），Openness 会话会丢失；由控制器启动的
> **TIA Portal 进程可能仍然驻留**（它是一个独立进程，插件绝不会去杀它）。请用
> `close_project`（`close_portal: true`）正常收尾。这一点在 README、工具描述和
> `docs/PROTOCOL.md` 中都有说明。

### 5.1 第三方依赖与合规

构建期与运行期都用 **Siemens 官方的 NuGet 包**（见 [§6.1](#61-程序集解析用-siemens-官方-nuget而不是自研)）。
要点：

- `Siemens.Engineering.dll` **从不被本仓库分发**（引用包 `CopyLocal=false`），它始终来自用户自己的
  TIA Portal 安装；
- `controller/bin/` 里会随插件分发 **Siemens 解析器及其 5 个依赖（约 889 KB，未做任何修改）**；
- 完整清单、版本规则、许可证原文要点、以及"想要严格零 Siemens 二进制的分发包该怎么做"，
  都写在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

> 许可证正文（`LICENSE_NuGet.org.md`，随每个包分发）是 Siemens 自定的
> "Royalty-free Software ... for sharing platforms" 条款 + `requireLicenseAcceptance=true`；
> 第 2 条把 MIT 授予"包内包含或生成的**源代码**"。因此"引用并随应用分发这些公开 NuGet 库"
> 属于常规消费，而"你是否接受把这些 DLL 打进公开发布物"是一个需要你（或 Siemens SIOS）确认的判断——
> `THIRD_PARTY_NOTICES.md` 里给了两种姿态的具体做法。


---

## 6. V17 API 要点（本仓库实测结论）

以下均以本机 `Siemens.Engineering.dll`（文件版本 `1700.7.501.6`，程序集版本 `17.0.0.0`）
编译验证，**不是猜测**：

- `IEngineeringObject` 成员（`GetAttribute` / `GetAttributeInfos`）在 **V17 对所有实现类型隐式可见**，
  无需强制转换；
- `PlcBlock.Export(FileInfo, ExportOptions)`、`PlcBlockComposition.Import(FileInfo, ImportOptions[, SWImportOptions])`；
- `PlcExternalSourceComposition.CreateFromFile(string name, string path)`（注意**先名字后路径**）、
  `PlcExternalSource.GenerateBlocksFromSource(GenerateBlockOption)`；
- 事务：`TiaPortal.ExclusiveAccess()` → `ExclusiveAccess.Transaction(project, "描述")` → `Transaction.CommitOnDispose()`；
- 编译：`CompileProvider` 是 **internal**，公开的是 `ICompilable` 接口
  （`plcSoftware.GetService<ICompilable>().Compile()`）。这一点用编译器与反射共同确认过；
- `PlcSoftware.BlockGroup`（`PlcBlockSystemGroup`，继承 `PlcBlockGroup`）提供 `Blocks` / `Groups` /
  `SystemBlockGroups`；块元数据可直接读强类型属性（`Name`/`Number`/`ProgrammingLanguage`/`ModifiedDate`…）。

### 6.1 程序集解析：用 Siemens 官方 NuGet，而不是自研

控制器的 Openness 引用与运行时解析都由 **Siemens 官方 NuGet 包**提供（详见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)）：

| 阶段 | 包 | 作用 |
|---|---|---|
| 构建 | `Siemens.Collaboration.Net.TiaPortal.Packages.Openness` `17.0.1685432625` | 纯 MSBuild 包：按 **注册表** → `TiaPortalLocation` → 默认路径 的顺序找到 `PublicAPI\V17` 下的程序集，并以 `CopyLocal=false` 全部引用（`Siemens.Engineering.dll` / `.Hmi.dll` 因此**永不进入产物**）。包版本与 TIA 版本一一对应（V17→17.0.x，V21→21.0.x） |
| 运行 | `Siemens.Collaboration.Net.TiaPortal.Openness.Resolver` `1.1.1725480302` | 注册 Siemens 自己的 `AssemblyResolve` 处理器；检查注册表、正在运行的 TIA 进程与 `TiaPortalLocation`，在找到的多个 `Siemens.Engineering` 中挑选与编译版本匹配的那个。**V2 只兼容 TIA V21+，所以 V17 锁 1.1** |

控制器在 [OpennessBootstrap.cs](controller/OpennessBootstrap.cs) 里做三件官方库不管的事：

1. **惰性初始化**：官方解析器在**第一个操作**前才初始化（`Initialize(tiaMajorVersion: 17)`），
   而不是进程启动时。这样没有可用 Openness 的机器仍能启动控制器、打印 ready 帧并给出结构化原因；
   `--self-test` 也能断言"启动时未加载 `Siemens.Engineering`"（14 项里的
   `openness_not_loaded_by_startup`）。
2. **诊断**：ready 帧里的 `openness` 对象（`resolvedFrom` = `registry`/`TiaPortalLocation`/`configured`、
   `assemblyPath`、`fileVersion`/`assemblyVersion`、`resolver`/`resolverVersion`）由控制器自己读
   注册表产出——官方库不提供等价信息，而它是 `controller_status` 与排障的主要依据。
3. **兜底**：`--openness-dir` 会被翻译成 `TiaPortalLocation` 交给官方解析器；同时注册控制器自带的
   目录探测作为**最后手段**（handlers 后注册者先执行，所以官方解析器始终优先，兜底只在"谁都解析不出来"
   时生效）。官方初始化失败也**不再致命**：记录诊断、降级到兜底探测、下个操作重试。

> 注意 `Initialize` 有个坑：位置参数 `Int32` 的重载是 **TIA 进程 id**（用于附加到已运行的 TIA），
> 不是版本号；版本必须用命名参数 `tiaMajorVersion:`。传错会得到
> `Process with an Id of 17 is not running`。

---

## 7. 测试

```powershell
npm run check            # 编译 TS + 运行全部测试
npm test                 # 只跑测试
npm run test:controller  # 只跑 C# 控制器自检
```

测试套件（`test/*.test.mjs`，`node --test`）：

| 文件 | 覆盖 |
|---|---|
| `01-load.test.mjs` | **加载测试**：模块级 `name`/`inject`/`Config`/`apply`；6 个工具注册；参数与输出 schema 用**真实** `@deepseek-ai/dsh-tools` 编译器编译；校验器拒绝缺参/错类型/越界枚举；工具描述包含 dry-run 与错误码；工具返回值通过 output schema 校验；控制器缺失时仍能加载并给出结构化原因 |
| `02-lifecycle.test.mjs` | **生命周期测试**：用真实 exe 启动控制器，断言操作系统可见该进程；`ctx.effect` 的 disposer 卸载后断言**进程已消失**；卸载幂等；配置了不存在的路径时调用失败为 `controller_not_found`。注意：触发卸载的是测试里忠实模拟 `ctx.effect` 语义的 disposer，不是真实 DSH loader 的 HMR 路径（该环待人工验证） |
| `03-controller-protocol.test.mjs` | **协议测试**：握手、白名单拒绝、参数校验、`project_not_open`、ASCII 转义、进度帧、请求串行化、队列上限；用 stub 控制器覆盖**卡死超时→终止→重启**、请求中途退出、协议版本不匹配、stdout 噪声（这一组还捕获并回归了一个真实的 bug：被替换的旧子进程的迟到 `exit` 事件会清掉新子进程引用，导致进程泄漏） |
| `04-tools.test.mjs` | **工具语义**：每个工具发送的参数与默认值（写入类默认 dry-run）、只发送白名单操作、`controller_status` 不触碰控制器、渲染文本包含错误码/提示/诊断 |
| `05-controller-cli.test.mjs` | **C# 控制器**：`--self-test` 14 项检查全绿；Openness 探测与用户组；`--version`/`--help`；命令行输出重定向为结构化帧；`--param` 重复值成数组 |
| `06-skills.test.mjs` | **知识库（替身注册表）**：`ctx.inject(['skills'], …)` 注册；没有 skills 服务的 profile 仍加载 6 个工具；目录只多一条且 description ≤ 500；`get()` 正文无 frontmatter、引用的每个上游文件都存在、正文 < 8192；vendored 树与 `UPSTREAM.json` 一致；每个工具描述都指向该 skill |
| `07-skills-registry.test.mjs` | **知识库（真实注册表）**：把 `@deepseek-ai/dsh-skill` 的真实 `SkillRegistry` 挂到裸 cordis context 上，验证 candidate 被真实校验接受、重名注册被拒、`get()` 能加载、`renderSkillContent` 带上 base directory、卸载插件后目录项消失 |

C# 控制器自检（无需 TIA Portal，14 项）：

```powershell
controller\bin\TiaOpennessV17Min.Controller.exe --self-test
```

### 7.1 构建 C# 控制器需要什么（含国内网络实测）

`npm run build:controller` 会做一次 NuGet 还原。**本机实测（中国移动网络，未挂 VPN）**：

| 项 | 实测 |
|---|---|
| `api.nuget.org` v3 索引 | HTTP 200，约 1.0 s |
| `globalcdn.nuget.org` 下载 | 2.4 MB / 约 2.0 s（≈1.2 MB/s） |
| 冷缓存 `dotnet restore`（2 个 Siemens 包 + 6 个传递依赖，`--no-cache` + 清空 http-cache） | **13.3 s** |
| 随后的 `dotnet build` | 2.1 s（已还原，离线可重复构建） |
| 华为云 NuGet 镜像 | **收录这两个包**（索引 259–692 ms，35 / 8 个版本），可作为加速或兜底 |

结论：**不挂 VPN 就能构建成功**；首次 13 秒，之后走本地 NuGet 缓存（`~/.nuget/packages`）无需联网。
若所在网络访问 nuget.org 不稳定，切换镜像即可：

```powershell
dotnet nuget add source https://mirrors.huaweicloud.com/repository/nuget/v3/index.json -n huawei
dotnet restore controller\TiaOpennessV17Min.Controller.csproj --source huawei
```

> 注意：控制器的**运行时**不联网、不还原——发布物里已包含所需程序集（见
> [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)），只有"重新构建控制器"这一步需要 NuGet。

真实 TIA 项目的功能测试（导出 → 修改 → 导入 → 编译）见
[`docs/FUNCTIONAL-TEST.md`](docs/FUNCTIONAL-TEST.md)。

### 测试用的运行时包链接

插件像任何已发布插件一样 `import '@deepseek-ai/dsh-tools'` 等，运行时由 profile 的
runtime resolution 解析。裸 checkout 里跑测试需要一次性链接：

```powershell
pnpm run link:runtime              # 从已安装 app 的 app.asar 抽取运行时并链到 node_modules
pnpm run link:runtime -- --force   # 无视缓存，按当前宿主版本重抽
```

抽取来源是**已安装 app 自己的 `resources/app.asar`**，也就是宿主正在用的那份运行时，
按 `dependencies` + `peerDependencies` 求闭包后解包到 `<DSH_HOME>/plugin-runtime`，
并记下宿主版本；宿主升级后下次运行会自动重抽。找不到安装位置时可用环境变量
`DSH_APP_ASAR` 指定 asar，或用 `DSH_HOME` 指向另一个 harness home。

（这些链接只用于本地开发与测试，不会被打包，也不影响已安装插件的行为。）

---

## 8. 错误码

| 错误码 | 含义 / 处理 |
|---|---|
| `openness_unavailable` | 找不到 `Siemens.Engineering.dll`：确认 TIA Portal V17 已安装，或用 `opennessDir` 指定路径 |
| `openness_load_failed` | DLL 存在但无法使用（位数不符/依赖缺失）：确认 x64 与安装完整性 |
| `project_not_found` | 项目文件不存在 |
| `project_not_open` | 需要先 `open_project` |
| `project_already_open` | 已打开一个项目：先 `close_project` |
| `project_open_failed` | 打开失败（多为旧版本项目：需要 `allow_upgrade`） |
| `plc_software_not_found` / `plc_software_ambiguous` | 项目中找不到/找到多个 PLC 软件：传 `device_name` / `software_name` |
| `block_not_found` | 指定块不存在，`details.available` 给出项目里的块清单 |
| `invalid_params` / `invalid_file` | 参数或输入文件不合法（`invalid_file` 表示 XML/外部源格式问题） |
| `export_failed` / `import_failed` / `compile_failed` | Openness 调用本身失败，`details.hint` 给出常见原因 |
| `verification_failed` | 写入后读回验证未通过（`data` 仍包含已发生的写入与验证报告） |
| `transaction_failed` | 无法获得独占访问事务（可能有另一个 Openness 客户端在改项目） |
| `unsupported_operation` / `unsupported_frame` | 越出白名单的请求被拒绝 |
| `controller_not_found` | 插件找不到控制器 exe：`npm run build:controller` 或配置 `controllerPath` |
| `controller_timeout` / `controller_cancelled` | 超过 `requestTimeoutMs` 或被取消：控制器已被终止，下次调用会自动重启（TIA Portal 会话丢失） |
| `controller_exited` / `controller_spawn_failed` / `controller_handshake_timeout` | 控制器启动/运行异常，`details.stderr` 带控制器自身输出 |
| `controller_busy` | 排队超过 `maxQueue` |
| `controller_protocol_mismatch` | exe 与插件版本不匹配：用同一份仓库重新构建 |

排障第一步永远是：

```jsonc
{ "include_controller_output": true }   // controller_status：进程状态、exe 路径、Openness 探测、用户组、最后错误
```

---

## 9. 仓库结构

```
src/
  index.ts             插件入口：name / inject / Config / apply，ctx.effect 拥有子进程
  config.ts            Schemastery 配置 schema + 归一化（所有字段有默认值）
  controller.ts        C# 控制器的生命周期、NDJSON 帧、串行化、超时与终止
  protocol.ts          线路类型 + 容错帧解析 + 统一结果信封
  skills.ts            知识库：把 skills/ 注册成一个 bundled skill（ctx.inject(['skills'], …)）
  tools.ts             6 个 defineTool 定义（模型可见描述）与渲染
  errors.ts            ToolFailure（传输层错误）
  dsh-runtime.d.ts     本插件用到的 DSH 运行时类型（离线可构建）
skills/                随包出货的 Openness 知识库：31 个上游 SKILL.md（逐字，MIT）+ 路由 skill（见 §4.4）
  tia-openness/SKILL.md  本仓库维护：症状→文件路由表（< 8192 字符）
  UPSTREAM.json        生成物：上游 commit、逐文件 sha256、许可证、被排除项
  LICENSE.siemens.txt  上游 MIT 许可证全文（随副本出货的合规要求）
controller/
  Program.cs           入口：参数解析、stdio 服务循环、一次性 CLI、self-test
  Protocol.cs          帧常量、操作白名单、结构化异常、诊断与变更日志
  Json.cs              有序 JSON 写出器 + 参数读取器
  OpennessBootstrap.cs 用 Siemens 官方 NuGet 解析器加载 Openness（惰性，首个操作用到才初始化）
  OpennessHost.cs      TiaPortal/项目会话、事务、块遍历、元数据读取
  Operations.cs        5 个白名单操作的实现（dry-run、事务、写后验证）
  SimaticMl.cs         Simatic ML XML 头解析与 SCL/STL 外部源扫描
  SelfTest.cs          14 项无 TIA 自检
test/                  node:test 测试套件
test-profile/          试跑材料：三层验证指南 + 两个脚本 + --patch 叠加层（不改默认 profile）
docs/PROTOCOL.md       线路协议与错误码（权威描述）
docs/KNOWLEDGE-BASE.md 知识库在哪、为什么不放 docs/、怎么更新（见 §4.4）
docs/FUNCTIONAL-TEST.md 真实项目功能测试步骤
docs/verification.md    section 8 验证清单逐条核对 + 待人工验证步骤
docs/decisions.md       技术取舍记录（被否方案与理由）
docs/coverage-matrix.html  折叠式能力覆盖矩阵（生成物，随代码更新；见 scripts/coverage/）
scripts/link-dsh-runtime.mjs  本地开发/测试用：把运行时包链到 node_modules
scripts/dsh-runtime-cache.mjs 从已安装 app 的 app.asar 抽取运行时闭包到 <DSH_HOME>/plugin-runtime
scripts/asar-read.mjs         最小 asar 读取器（供上一条使用）
scripts/coverage/       覆盖矩阵的数据、快照抽取与生成/校验脚本
scripts/knowledge/build-skills.mjs  知识库同步（联网重取上游）与离线校验（--check）
.tools/asar.cjs        开发工具：无依赖读取 Electron app.asar（不属于插件运行时）
```

---

## 10. 已知边界

- **真实环境验证已完成**（§0.1、[`docs/REAL-RUN.md`](docs/REAL-RUN.md)）：
  真实 DSH 宿主加载/退出、真实 237 块项目的导出→改→导入→编译。
  只剩两项需要人/其他环境补充：运行中实例里的 **HMR disposer 动作**（UI 里禁用/启用插件），
  以及 **V18+ 的 Openness 应用白名单**策略（本机 V17 未拦截）。
- **真实项目里的块不一定都能导出**：ProDiag 语言块与 Safety(F-)块被 TIA 直接拒绝，
  控制器逐块报告（`data.failures[]`）并继续；**导入必须指定块原来所在的组**（`target_group`），
  且"导入后重新导出"要放在编译之后。三条约束见
  [`docs/FUNCTIONAL-TEST.md`](docs/FUNCTIONAL-TEST.md) §8.5。
- **只做块、PLC 类型与标签表**：`export_blocks` / `import_blocks` 用 `categories` 选择
  `blocks`（默认）/`types`（PLC 数据类型 UDT）/`tag_tables`，三族对象互不冲突；
  硬件组态、在线下载/上传、比较、库、多用户、HMI 等仍未实现。完整的逐条覆盖情况见
  [`docs/coverage-matrix.html`](docs/coverage-matrix.html)（随代码自动重新生成）。
  PLC 类型与标签表可以被导入，但块的读回验证覆盖不到它们（会给出 warning）。
- **导入的目标组固定为根块组**：TIA 的导入不保留导出时的用户组层级，导出仍会按组写目录。
- **一次一个宿主进程一个 TIA Portal 会话**：不同 DSH 会话共用同一个控制器并排队。
- **超时即丢失会话**：Openness 不可取消，超时的唯一可靠处理是终止控制器。

---

## 11. 参考与致谢

设计参考（**未复制任何代码**）：

- Siemens TIA Portal Openness V17 系统手册（API 行为与事务/编译用法的最终依据）
- [siemens/tia-portal-ai-extensions](https://github.com/siemens/tia-portal-ai-extensions) —— 技能划分与诊断思路
- huahaizo/tia-portal-openness-ai —— "注册解析器 → 加载 DLL → 业务逻辑" 的控制器分层思路

明确未使用：TiaCommander 的任何代码；Siemens Skills 仓库中的 C# 代码。
唯一被复制过来的上游内容是**文档**：Openness skill 集（§4.4）按 MIT 逐字 vendor，
附上游许可证全文与逐文件 sha256，代码一行未取。

许可证：MIT（见 `LICENSE`）。