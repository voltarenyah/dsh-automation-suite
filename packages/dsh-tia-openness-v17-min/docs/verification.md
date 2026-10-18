# 验证清单与证据（section 8 checklist）

本文件逐条核对交付要求里的验证清单。原则：**能静态或离线核实的就给出可复现的命令与
文件位置；需要真实 DSH 宿主或真实 TIA Portal 项目的，明确标注为"待人工验证"，
绝不写成"已验证"。**

约定：

- ✅ **已验证**：有自动化测试或编译器/反射证据，命令可复现。
- ⚠️ **部分验证**：主要机制已自动化验证，但有一环需要真实环境（该环在 §B 给出人工步骤）。
- ⏳ **待人工验证**：必须在真实 DSH 宿主 / 真实 V17 项目上做，本仓库内无法覆盖。

复现全部自动化证据：

```powershell
npm install                 # 仅 typescript + @types/node
npm run link:runtime        # 一次性链接 harness 运行时包（见 docs/decisions.md D2）
dotnet build controller\TiaOpennessV17Min.Controller.csproj -c Release -o controller\bin
npm run check               # tsc 构建 + 45 项测试
controller\bin\TiaOpennessV17Min.Controller.exe --self-test
```

最近一次执行结果（本机，Windows / TIA Portal V17 / .NET Framework 4.8.09221）：

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| `npx tsc -p tsconfig.json`（构建 `lib/`） | 0 错误，产出 6 个 `.js` |
| `dotnet build -c Release -o controller\bin`（含 NuGet 还原） | Build succeeded，**0 Warning / 0 Error**；解析到 `...\Portal V17\PublicAPI\V17` |
| `node --test "test/*.test.mjs"` | **tests 45, pass 44, fail 0, skipped 1**（跳过项：控制器未构建时的降级路径；本机已构建） |
| `...Controller.exe --self-test` | `ok: true`，**14/14** 检查通过 |
| `...Controller.exe --self-test` → `openness` | `available: true`，`assemblyVersion 17.0.0.0`，`fileVersion 1700.7.501.6`，`processorArchitecture MSIL`，`resolvedFrom: registry`，`resolver 1.1.0.0` |
| `...Controller.exe --self-test` → `opennessUserGroup` | `group: Siemens TIA Openness`，`isMember: true` |
| 真实 V17 项目 A（237 块，副本） | ✅ 打开 1 PLC / 237 块；导出 234 成功 + 3 逐块拒绝；改 → 导入 override 进原组 → 写后验证 passed/changed → 重新导出内容为新值 → 编译 errors=0。原始输出见 [REAL-RUN.md](REAL-RUN.md) |
| 真实 V17 项目 B（1152 块，**正式项目**，设备在用户组里） | ✅ 导出 **1151/1152**（1 个 Safety F 块被拒绝）；1152 文件 / 70.6 MB；22 个用户组目录层级与非 ASCII 组名正确；项目未被写（`.ap17` mtime 未变、无锁、无残留进程）。见 [REAL-RUN.md](REAL-RUN.md) §D.6 |
| 真实 DSH 宿主（隔离 DSH_HOME） | ✅ 宿主启动 → 控制器子进程出现（pply 执行）；宿主结束 → 子进程退出无残留；~/.dsh 未被修改 |

---

## A. 逐条核对

### A1. 插件能被 DSH 正确加载（`apply` 被调用） —— ✅ 已验证（含真实宿主）

| 已覆盖 | 证据 |
|---|---|
| 模块级导出齐全：`name` / `inject` / `Config` / `apply` | `src/index.ts:29`（`export const name`）、`:35`（`export const inject = ['tools']`）、`:48`（`export function apply`）；测试 `test/01-load.test.mjs:28` |
| `apply` 真的会注册工具 | `src/tools.ts:313`（`ctx.tools.register`）；测试 `test/01-load.test.mjs:41` 断言 6 个工具名与顺序 |
| 生产构建产物（`lib/`）可被 Node 直接 `import` | `test/helpers/harness.mjs` 动态导入 `../../lib/index.js`（带 cache-bust），全部 45 项测试都建立在此之上 |
| 注册的 schema 能被**真实** registry 接受 | `test/01-load.test.mjs:52`（`parameterSchemaSpecToJsonSchema` / `assertSupportedJsonSchema`）、`:75`（`validateJsonSchemaValue` 拒绝缺参/错类型/越界枚举）、`:114`（返回的 canonical value 通过 output schema 校验）、`test/04-tools.test.mjs:187`（6 个工具全量校验） |
| 控制器缺失/未构建时插件仍能加载并给出原因 | `test/01-load.test.mjs:188`、`test/02-lifecycle.test.mjs:101` |

**该环现已覆盖**（本轮实测）：在**隔离 `DSH_HOME`** 里创建测试 profile、`link:` 安装本仓库、用 `--patch` 叠加层启动真实宿主，观察到控制器子进程出现 → 证明真实 loader 组合了插件并调用了 `apply`。原始输出见 [REAL-RUN.md](REAL-RUN.md) §D.5。
原因与取舍见 [`docs/decisions.md` D1](decisions.md#d1-不做安装进真实-dsh-profile的实机验证最重要的一条)（本仓库不在夜间修改用户 profile）。
人工步骤见 §B.1。

### A2. `inject` 声明了所有依赖 —— ✅ 已验证

`apply` 只使用 `ctx.tools`、`ctx.logger`、`ctx.effect`；`inject` 声明 `['tools']`
（`src/index.ts:35`）。`logger` 与 `effect` 由 cordis 内建提供，不需要注入。
测试：`test/01-load.test.mjs:36`（断言 `inject` 含 `'tools'`）。

### A3. `ctx.effect()` 管理了子进程生命周期 —— ✅ 已验证

- 注册点：`src/index.ts:93`（`ctx.effect(() => async () => { … await controller.stop() … })`）。
- disposer 是**异步**的（框架会 await），并且先 `await startup` 再 `stop()`，
  避免"卸载跑在启动之前"留下孤儿进程。
- `ControllerProcess.stop()` 先关 stdin 走优雅路径，`shutdownGraceMs` 超时后强杀：
  `src/controller.ts` 的 `stop()` / `#kill()` / `#killChild()`。
- 测试：`test/02-lifecycle.test.mjs:41`（真实 exe：启动 → 断言进程存活 → 走 disposer 卸载
  → 断言 `process.kill(pid, 0)` 抛 `ESRCH`）、`:81`（disposer 幂等，且注册被释放）。

### A4. C# 控制器使用 V17 的 `Siemens.Engineering.dll` —— ✅ 已验证

| 要求 | 证据 |
|---|---|
| 引用本机 V17 的 DLL，不复制副本 | `controller/TiaOpennessV17Min.Controller.csproj`：`<HintPath>$(OpennessDir)\Siemens.Engineering.dll</HintPath>` + `<Private>false</Private>`；默认 `OpennessDir = C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17` |
| **先**注册程序集解析器，**再**加载 DLL | `controller/Program.cs:60`（`AssemblyResolver.Install(opennessDir)`，位于 `--self-test` 与操作分发之前）；解析顺序见 `controller/AssemblyResolver.cs` 的 `BuildProbeDirectories`（PublicAPI\V17 → Bin\PublicAPI\V17 → Bin\PublicAPI → Bin → 自身目录） |
| 启动时不加载 Openness 程序集 | 自检项 `openness_not_loaded_by_startup`（`controller/SelfTest.cs:42`）断言 `AppDomain` 里没有 `Siemens.Engineering` |
| 实际版本 | 自检输出：`assemblyVersion 17.0.0.0`、`fileVersion 1700.7.501.6`；测试 `test/05-controller-cli.test.mjs:69` 断言 `assemblyVersion` 以 `17.` 开头 |
| 引用与解析的来源 | **Siemens 官方 NuGet**：构建期 `Packages.Openness 17.0.1685432625`（`CopyLocal=false`，产物里无 Siemens.Engineering.dll），运行期 `Openness.Resolver 1.1.1725480302`（惰性初始化，见 [OpennessBootstrap.cs](../controller/OpennessBootstrap.cs)） |
| x64 | csproj `<PlatformTarget>x64</PlatformTarget>`；ready 帧与自检输出 `processArchitecture: x64` |

### A5. 所有 `GetAttribute` 调用不需要强制转换 —— ✅ 已验证

- `controller/OpennessHost.cs:531`：`foreach (EngineeringAttributeInfo info in target.GetAttributeInfos())`
- `controller/OpennessHost.cs:547`：`target.GetAttribute(candidate)`
- 两处都在 `IEngineeringObject` 形参上直接调用，**没有任何 `(IEngineeringObject)` 或
  `as IEngineeringObject` 强制转换**（这正是 V17 行为变化的要求）。
- **证明方式**：Roslyn 编译器对着本机真实的 `Siemens.Engineering.dll` 编译通过
  （0 Warning / 0 Error）。若 V17 仍需显式转换，这里会直接 CS1061。
  另外块元数据优先用强类型属性（`PlcBlock.Name/Number/ProgrammingLanguage/ModifiedDate/…`），
  属性名先与 `GetAttributeInfos()` 求交集再读取。

### A6. 白名单只包含 5 个允许的操作 —— ✅ 已验证

> **v0.2 更新（2026-10-13）**：白名单从 5 个扩展到 **25 个**（新增 20 个：工程数据 8、
> PLC 数据 9、F 相关 3）。C# 自检项 `whitelist_exact_five` 更名为 **`whitelist_exact`**，
> 现在逐条比对 25 个名字与顺序；`test/01`、`test/04` 改用 `test/helpers/harness.mjs` 的
> `EXPECTED_TOOLS` / `loadOperations()`，`test/02`、`03`、`05` 直接与 `src/protocol.ts` 的
> `OPERATIONS` 比对。下表描述的是 v0.1 的 5 个操作，机制未变。新增的 20 个操作**尚未在真实
> 项目上验证**，见 [`VERIFICATION-PLAN.md`](VERIFICATION-PLAN.md)。

| 位置 | 内容 |
|---|---|
| `controller/Protocol.cs:37-41` | 五个常量 |
| `controller/Protocol.cs:43` | `Names = { OpenProject, ExportBlocks, ImportBlocks, CompilePlc, CloseProject }` |
| `controller/Operations.cs:66` | `if (!OperationCatalog.IsAllowed(operation))` → 抛 `unsupported_operation`，**先于**任何分发 |
| `src/protocol.ts` | `OPERATIONS` 常量（插件侧只发送这 5 个，双重校验、互不信任） |
| 测试（C# 自检） | `whitelist_exact_five`（数量=5 且名字完全一致）、`whitelist_rejects_unknown`（拒绝 `RunScript`/`DeleteBlock`/`Shutdown`/`Ping`/`export_blocks`/空串等） |
| 测试（插件侧） | `test/04-tools.test.mjs:175` 断言 5 次工具调用发出的正是这 5 个操作；`test/03-controller-protocol.test.mjs:119` 用真实 exe 请求 `RunScript` → `unsupported_operation`，且 `details.allowed` 正确 |
| 测试（CLI） | `test/05-controller-cli.test.mjs:110`：`--operation RunScript` 退出码 2 + 结构化帧 |

其它入口同样封死：非 `operation` 类型帧 → `unsupported_frame`（`test/03:...` 由
`test/03-controller-protocol.test.mjs` 覆盖请求/帧形态；控制器侧见 `controller/Program.cs` 的帧类型校验）。

### A7. 写入操作有 dry-run 模式和写后验证 —— ✅ 已验证

> **2026-10 更新（决策 [D22](decisions.md)）**：`dry_run` 已收敛到 7 个"预览带信息量"的工具，
> 其余 14 个删除。下表已按新策略重写；历史划分见 D5，理由与代价见 D22。

**dry-run 默认值**（图表见 README §4.2，逐字段证据）：

| 操作 | 默认 | 位置 |
|---|---|---|
| `OpenProject` | `dry_run = false`（零 TIA 接触：连 TIA Portal 都不启动；升级写入由 `allow_upgrade=false` 独立把关） | `Operations.cs` `OpenProject` |
| `ImportBlocks` | `dry_run = true` | `Operations.cs` `ImportBlocks` |
| `CloseProject` | `dry_run = true` | `Operations.cs` `CloseProject` |
| `DeletePlcObjects` / `WriteTags` / `SetBlockAttributes` / `ProtectBlocks` | `dry_run = true` | `OperationsPlc.cs` |
| 其余 14 个操作 | **无 `dry_run`**（`data.dryRun` 恒为 `false`） | — |

插件侧同样施加默认值（模型不传也有确定语义）：`src/tools.ts` 里 7 个保留工具各自的
`args.dry_run ?? …`；测试 `test/04-tools.test.mjs` 的 "only the tools whose preview carries
information keep a dry run" 双向断言：14 个工具的 params 里**没有** `dry_run`，4 个写入类工具
默认 `true`（`import_blocks` / `close_project` 各自另有专测）。

**写后验证**：

| 写入 | 验证方式 | 位置 |
|---|---|---|
| 导出文件 | 读回每个 XML：非空、可解析、`<Name>` 与预期块名一致，记 SHA-256 + manifest | `controller/Operations.cs:234` 后的 `VerifyExportedFile`，失败抛 `verification_failed`（`data` 仍带已写文件清单） |
| 导入块 | 事务提交后**重读项目块集合**，逐个确认存在，并比较 `ModifiedDate`/`Number`/`ProgrammingLanguage`；缺失块 → `verification_failed`（`data.committed=true`） | `controller/Operations.cs:642`（`VerifyImport`）、`:610`（调用）、`:617`（失败抛出） |
| 导入的原子性 | 全部文件成功才 `scope.Commit()`，否则 dispose 即回滚 | `controller/Operations.cs:539`（`BeginTransaction`）、`:594`（`scope.Commit()`）、`controller/OpennessHost.cs:912`（`CommitOnDispose`），`controller/OpennessHost.cs:251`（`ExclusiveAccess.Transaction`） |
| 编译 | 返回 `state/errorCount/warningCount/messages[]` 作为**数据**，供模型判定 | `controller/Operations.cs` 的 `CompilePlc` + `test/01-load.test.mjs:91` 断言描述里讲到 `errorCount` |

真实项目上的端到端写入/回读验证仍是 ⏳ 待人工验证（无 V17 项目样本），步骤见
[`docs/FUNCTIONAL-TEST.md`](FUNCTIONAL-TEST.md)。

### A8. 插件卸载时子进程被终止 —— ✅ 已验证（含真实宿主）

| 已覆盖 | 证据 |
|---|---|
| 真实控制器 exe 被启动，操作系统可见 | `test/02-lifecycle.test.mjs:41`（`processAlive(pid) === true`） |
| 触发 disposer 后进程**确实消失** | 同测试：`await harness.unload()` 后 `processAlive(pid) === false`，且 `status().state === 'stopped'`、`pid === null` |
| disposer 幂等、注册被释放 | `test/02-lifecycle.test.mjs:81` |
| 超时/取消时的强制终止与自动重启 | `test/03-controller-protocol.test.mjs:213`（卡死→终止→重启）、`:328`（队列上限 + 重启不泄漏） |
| 修复过的真实缺陷（回归保护） | 被替换的旧子进程迟到 `exit` 事件会清空新子进程引用 → 孤儿进程；修复为子进程身份检查（见 docs/decisions.md D8），`test/03:328` 末尾断言 `pid === null` 守住它 |

**未覆盖的一环**：真实 DSH 宿主的 HMR 卸载路径（由 loader 触发 disposer）。
本测试通过忠实模拟 `ctx.effect` 的 disposer 语义来触发，因此验证的是"disposer 正确性"，
不是"loader 一定调用 disposer"。人工步骤见 §B.1。

### A9. 工具 `description` 清晰描述功能 —— ✅ 已验证

- 26 个工具的描述都在 `src/tools.ts`（`open_project`、`export_blocks`、`import_blocks`、`compile_plc`、
  `close_project`、`controller_status`，以及 v0.2 的 20 个）。
- 每个描述都写明：做什么、**是否写入**、dry-run 策略（保留该参数的工具写明默认值与如何关闭；
  没有该参数的工具直接写"WRITES to the project"）、关键参数语义、以及会返回哪些错误码。
- 测试：`test/01-load.test.mjs` 断言 `import_blocks` 描述里出现 `dry_run`、`transaction`、
  `verification_failed`；`export_blocks` 出现 `block_not_found`；`compile_plc` **不再**出现 `dry_run`
  （决策 D22）而出现 `errorCount`；`controller_status` 出现 `Siemens TIA Openness`；
  并断言每个描述长度 > 120 字符。

### A10. 错误被转换为结构化输出 —— ✅ 已验证

| 层次 | 机制 | 证据 |
|---|---|---|
| C# 控制器 | 所有异常 → `ControllerException{code,message,details}`；含 HResult、内部异常、以及 `hint`（access denied / 缺组 / 许可证等常见原因） | `controller/Protocol.cs`（`ControllerException.ToErrorJson`）、`controller/OpennessHost.cs`（`OpennessFailure` + `HintFor`） |
| 帧 | 失败仍是一个 `result` 帧：`ok:false` + `error{code,message,details}`（必要时带 `data` 部分结果） | `test/05-controller-cli.test.mjs:110`（`unsupported_operation`）、`:140`（`project_not_open`）、`:127`（命令行参数错→`invalid_params`） |
| 插件 | 结构化失败 → `ok:false` 的规范返回值；传输失败 → 抛 `ToolFailure`（消息以错误码开头） | 设计见 docs/decisions.md D4；测试 `test/01-load.test.mjs:150`（控制器失败**不**抛错，带 `error.code`）、`test/04-tools.test.mjs:220`（渲染出 `Error code:` / `Hint:` / 诊断）、`:250`（传输失败保持抛错） |
| 渲染 | 失败文本以 `FAILED` + 错误码 + 原因 + hint + 诊断开头，模型能直接据以修正 | `src/tools.ts` 的 `renderOutcome` / `renderError`；测试 `test/04-tools.test.mjs:220` |
| 错误码表 | 完整清单（含每个码的处置建议） | [`docs/PROTOCOL.md`](PROTOCOL.md) 末尾 |

---

## B. 待人工验证的两项（本仓库内无法覆盖）

### B.1 真实 DSH 宿主上的安装 / 卸载（A1/A8 已由脚本覆盖，仅剩 UI 里的 HMR 动作）

> 前置：`lib/` 与 `controller/bin/` 已构建（本仓库已包含）。建议在**你自己的** profile
> 副本或非关键 profile 上做；桌面 profile 是启动时组合，通常需要重启 DSH 才生效。

1. 安装（二选一）：
   - 插件管理器：`plugin_manager(action: "install_bundle", target: "C:\\Users\\Ansel\\dsh-automation-suite\\packages\\dsh-tia-openness-v17-min")`
   - 或手工在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加：
     ```yaml
     - insert:
         - id: tia-openness-v17-min
           name: '@voltarenyah/dsh-tia-openness-v17-min'
     ```
2. 确认加载：重启 DSH 后
   ```powershell
   Get-Process -Name TiaOpennessV17Min.Controller -ErrorAction SilentlyContinue
   ```
   **期望**：出现一个进程 —— 这是 `apply` 被执行、pre-warm 生效的直接证据（`src/index.ts:93` 之前的 `controller.prewarm()`）。
   同时在会话里应能看到 6 个工具：`open_project` / `export_blocks` / `import_blocks` /
   `compile_plc` / `close_project` / `controller_status`；也可调用
   `controller_status` 核对 `Openness: available` 与用户组。
3. 确认卸载：禁用或移除该 bundle（`plugin_manager` 的 `set_plugin enabled:false` 或
   `remove_bundle`），然后：
   ```powershell
   Get-Process -Name TiaOpennessV17Min.Controller -ErrorAction SilentlyContinue
   ```
   **期望**：无输出 —— 子进程随插件卸载被终止（`ctx.effect` 的 disposer）。
4. 记录：把结果填到下面 §C 的两行"待人工验证"里。

### B.2 真实运行时包版本（`@deepseek-ai/dsh-tools` 0.2.1-rc.2，已实测）

本仓库测试链接的是 `<DSH_HOME>/plugin-runtime` —— 由 `scripts/dsh-runtime-cache.mjs` 从**已安装 app
自己的 `resources/app.asar`** 抽取（`runtime.json` 记录宿主版本，升级后自动重抽），**不再**指回
`~/.dsh/profiles/node_modules` 那份 `0.1.5-rc.2` 的旧投影（见 D19）。

**2026-10-19 在宿主 `0.2.1-rc.2` 上实测**：抽取到 34 个运行时包（`@deepseek-ai/dsh-tools` 0.2.1-rc.2、
`cordis` 4.0.5、`schemastery` 3.18.5），本包 `node --test test/*.test.mjs` 为
**77 项：76 通过 / 1 跳过（跳过的是"控制器未构建"分支，因为本机控制器是构建好的）**。
其中"工具注册到真实 `ToolRuntime`"、"每个参数的 JSON Schema 在真实实现里编译通过"、
"真实 skill registry 接受 provider 返回的 candidate"这些用例都是对着**真运行时**跑的 ——
所以"在真实宿主版本下也照常工作"这一条**已由测试覆盖**，不再是待验证项。

宿主版本可以从 `dsh --profile dsh-automation-suite --dump-config` 的输出里读
（`@deepseek-ai/dsh-base` 的版本即宿主版本）。B.1 的第 2 步仍值得人工过一遍 —— 它同时验 TIA 侧。

### B.3 真实 V17 项目的功能链路

导出 → 修改 → 导入 → 编译：见 [`docs/FUNCTIONAL-TEST.md`](FUNCTIONAL-TEST.md)（含期望值与结果记录表）。
本机已具备条件（V17 已安装、Openness DLL 就位、用户组已加入），仅缺一个可用的 V17 项目样本。

### B.4 官方解析器的首次真实加载 + 应用白名单（已实测：V17 上未被拦截）

换成 Siemens 官方 NuGet 后，"程序集解析"这一步在**没有真实项目**时只能验证到"解析器初始化成功、
选中了正确路径"（已由 `--self-test` 的 `siemens_resolver_package_present`、
`openness_not_loaded_by_startup`，以及 ready 帧的 `openness.resolvedFrom = registry` +
`assemblyPath` + `resolver 1.1.0.0` 证明）。**首次真正加载 `Siemens.Engineering` 并连上 TIA**
只能在功能测试第 1 步发生：

1. 跑 [`docs/FUNCTIONAL-TEST.md`](FUNCTIONAL-TEST.md) 第 1 步 `open_project`；
2. 若失败，先用 `controller_status` 看解析器状态与用户组成员；
3. **特别确认白名单**：V17 手册（SIOS 109798533）有"Openness 防火墙 / 白名单条目"章节，
   而本插件没有调用官方解析器自带的 `IsAppWhitelisted()` / `WhitelistApp()`。
   若 `open_project` 被拒绝、或弹出需要人点击的对话框（headless 控制器答不了），即属此类，
   处理步骤见 [`FUNCTIONAL-TEST.md` 的排障表](FUNCTIONAL-TEST.md)；
4. 把结论记进 §C。

---

## C. 结论

- 交付要求里的 10 条清单：**10 条 ✅ 已验证**（含真实宿主与真实 V17 项目）；仅剩两项需要人在界面/其他环境里做的补充验证（HMR disposer 动作、V18+ 白名单策略），已在 §B.1/§B.4 写明。
- 未覆盖的部分集中在两类需要真实环境的地方：真实 DSH 宿主的安装/卸载，真实 V17 项目上的
  块进出与编译。两者的原因、替代验证与人工步骤都在 §B 写明，并在 README 中显式标注。
- 换用 Siemens 官方 NuGet（见 [decisions.md D13](decisions.md)）后，B.4 也已在真实项目上验证：
  官方解析器成功加载 `Siemens.Engineering`（`resolvedFrom=registry`），V17 上打开真实项目**未被白名单拦截**。
  该替换在无 TIA 环境可验证的范围内**未造成回归**：控制器构建 0 Warning/0 Error、
  `--self-test` 14/14、`npm test` 45 项 44 通过 0 失败 1 跳过，与替换前完全一致。
- 缺陷修复：**4 处**。测试发现的 1 处（孤儿子进程，D8）+ 真实项目实测发现的 3 处
  （XML 对象元素解析错误导致写后验证静默失效、单块导出失败中止整批、导入固定落根组导致 override 无法覆盖；
  见 [REAL-RUN.md](REAL-RUN.md) §D.4 与 [decisions.md](decisions.md) D14/D15）。
