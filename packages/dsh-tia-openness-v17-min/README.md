# TIAOpennessV17Min

> DeepSeek Harness 插件：通过 TIA Portal V17 Openness 对 PLC 程序块做**最小化**读写
> （导出 / 导入 Simatic ML、外部源生成块、编译验证）。
>
> A DeepSeek Harness plugin that exposes TIA Portal V17 Openness as 26 model-facing
> tools backed by a whitelisted C# controller subprocess. Every write runs in an
> exclusive-access transaction and is read back for verification; the operations
> whose preview carries information are dry-run by default.
>
> 插件由**两个 Loader 行**组成：宿主行（`.`,`src/index.ts`）持有控制器子进程、`engineeringAccess`
> 服务与知识库；工具行（`./tools`,`src/tools-entry.ts`）才是 26 个模型可见的工具，
> **由 agent preset 决定要不要声明** —— 主 agent（leader）声明它、子 agent（expert）不声明，
> 于是子 agent 看不到任何 TIA 工具。见 [§4.0](#40-两个-loader-行宿主行与-tools-行)。

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
│  宿主行 ('.')：                                │
│   • ctx.effect() 拥有 C# 控制器子进程           │
│   • 注册 engineeringAccess 服务（公开缝）        │
│   • 注册 tiaOpennessRuntime（本包工具行的内部缝）│
│   • 注册知识库 skill provider                   │
│  工具行 ('./tools'，按 preset 声明)：            │
│   • 注册 26 个模型可见工具                       │
│   • 请求串行化 / 超时 / 硬超时终止与重启         │
│   • 结构化错误 → 结构化工具结果                  │
└───────────────┬────────────────────────────────┘
                │ NDJSON over stdin/stdout（一行一帧）
┌───────────────▼────────────────────────────────┐
│  TiaOpennessV17Min.Controller.exe (C#, x64,    │
│  .NET Framework 4.8)                           │
│   • 先注册程序集解析器，再加载                  │
│     Siemens.Engineering.dll（V17）              │
│   • 只执行 25 个白名单操作                      │
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
| 自动化测试 `npm test` | ✅ **97 项：96 通过 / 0 失败 / 1 跳过**（跳过项为"控制器未构建"的降级路径；含 9 项知识库、3 项对**真实** skill 注册表的集成测试、6 项两行拆分契约与 13 项斜线指令测试——其中 2 项在**真实** cordis 服务图上把两行当兄弟插件挂载） |
| C# 控制器自检（无 TIA） | ✅ **14/14**（含"启动时不加载 Openness 程序集"与"Siemens 解析器包可用"） |
| Openness 环境探测（DLL 版本 / 位数 / 用户组） | ✅ `17.0.0.0` / x64 / 已在 `Siemens TIA Openness` 组 |
| 安装进真实 DSH 宿主的加载 / 卸载验证 | ✅ **已验证（真实宿主）**：独立 `DSH_HOME` + 测试 profile 启动真实宿主 → 控制器子进程出现（`apply` 执行、`ctx.effect` 持有）；宿主结束 → 子进程自行退出，无残留。`~/.dsh` 未被修改 |
| 真实 V17 项目上的导出→改→导入→编译 | ✅ **已验证（真实项目）**：237 块项目导出 234 个（3 个被 TIA 拒绝，逐块报告）、改 `HeaderVersion` 导入 override 进原组、写后验证 `passed/changed=True`、重新导出内容为新值、编译 `errors=0`。详见 §0.1 |
| 第二个真实项目（`PEI_SinoARP_Master_V4.1.3`，1152 块，**正式项目**，设备在用户组里） | ✅ 导出 **1151/1152**（1 个 Safety F 块被拒绝并逐块报告），1152 文件 / 70.6 MB，22 个用户组目录层级与非 ASCII 组名（`Fonctions méthode`、`55_Cavité_STD`）均正确；`.ap17` 修改时间未变、无锁文件、无残留进程。该轮又修掉一个缺陷（设备分组 → 见 [REAL-RUN.md](docs/REAL-RUN.md) §D.6、[decisions.md](docs/decisions.md) D16） |
| v0.2 新增的 20 个操作（工程数据 / PLC 数据 / F 相关） | ⏳ **已实现、编译通过、单测通过；尚未在真实 TIA Portal 项目上验证**。逐条测试项与执行方法见 [docs/VERIFICATION-PLAN.md](docs/VERIFICATION-PLAN.md)；接口契约见 [docs/EXTENDED-SURFACE.md](docs/EXTENDED-SURFACE.md) |

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
| DSH | 任何能加载 bundle 的版本（宿主行 `inject: []`；工具行 `inject: ['tools', 'tiaOpennessRuntime']`） |
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

- `lib/` —— TypeScript 编译输出（宿主行入口 `lib/index.js`；工具行入口 `lib/tools-entry.js`，
  即 `exports["./tools"]`）
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

**工具行要另行声明**（宿主行只提供控制器与服务，不含任何模型可见工具）：

```yaml
- insert:
    - id: tia-openness-v17-min-tools
      name: '@voltarenyah/dsh-tia-openness-v17-min/tools'
```

两条行可以放在 composition 的任意位置：工具行的 `inject` 会让 loader 等到 `tiaOpennessRuntime`
出现再调用它的 `apply`。但**只有该看到 TIA 的 agent preset 才应该声明工具行** ——
把它写进全局组合等于回到拆分之前（见 [§4.0](#40-两个-loader-行宿主行与-tools-行)）。

本插件的 bundle patch（`cordis.patch.yml`）只插入宿主行那一条，不含任何环境相关配置，
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

### 4.0 三个 Loader 行：宿主行、`/tools` 行与 `/commands` 行

DSH 按**声明作用域**决定工具对谁可见：一行里注册的工具属于该行的作用域。插件原来把 26 个工具
和控制器放在同一行，于是它们落在**宿主（全局）平面**上 —— 任何 agent（包括被派生的子 agent）
都继承。发行版要区分 `leader`（主 agent，保留 26 个工具）与 `expert`（子 agent，不应看到任何
TIA 工具），所以注册被拆成两行；**人**用的斜线指令是第三个面，再拆一行：

| 行 | 子路径导出 | `name` | `inject` | 内容 |
|---|---|---|---|---|
| 宿主行 | `.`（`lib/index.js`） | `tia-openness-v17-min` | `[]` | `ControllerProcess` + `ctx.effect` 的所有权、`engineeringAccess` 服务（公开缝）、`tiaOpennessRuntime`（本包另两行的内部缝）、bundled skill provider |
| 工具行 | `./tools`（`lib/tools-entry.js`） | `tia-openness-v17-min-tools` | `['tools', 'tiaOpennessRuntime']` | 26 个模型可见工具（`src/tools.ts`） |
| 命令行 | `./commands`（`lib/commands-entry.js`） | `tia-openness-v17-min-commands` | `['commands', 'tiaOpennessRuntime']` | 7 个 `/tia-…` 斜线指令（`src/commands.ts`，复用工具的操作与渲染） |

- **只有该看到 TIA 的 preset 才声明工具行**：`leader` 声明它 → 保留 26 个工具；
  `expert` 不声明 → 一个 TIA 工具都没有。宿主行对所有 agent 都加载，因为控制器与会话是
  composition 级资源。
- **命令行独立于工具行**：它不注册任何工具，也不要求 `/tools` 行存在；一个只想给人用 `/tia-open`
  的 preset 可以只声明命令行。反过来，声明工具行不会让命令出现。
- **宿主行没有工具，所以 `inject` 是空数组**；它唯一想等的 `skills` 是**可选**的，
  仍旧走 `apply` 里的 `ctx.inject(['skills'], …)`，缺 skill 注册表的 profile 照常加载。
- **工具行与命令行不拥有任何配置**：所有配置（`controllerPath`、`requestTimeoutMs`、`verboseResults`…）
  都写进宿主行，两行都从 `tiaOpennessRuntime` 读回已经归一化的值。
- **一个 composition 仍然只有一个控制器子进程 / 一个 TIA Portal 会话**，无论多少 agent 声明这些行。
- **`inject` 让顺序安全**：工具行/命令行可以在 composition 里写在宿主行之前，loader 会等
  `tiaOpennessRuntime` 出现再调用它们的 `apply`。反过来，只声明它们而不声明宿主行，
  它们就一直等不到那个服务、什么也不注册。

---

## 4. 工具

工具行注册的 26 个工具，统一返回同一个信封（`ok` / `summary` / `data` / `changes` / `diagnostics` / `error`）。
每个工具对应控制器的一个白名单操作，参数与返回结构见
[`docs/EXTENDED-SURFACE.md`](docs/EXTENDED-SURFACE.md)。

**块与工程主线（v0.1 已有）**

| 工具 | 作用 | 写入 | 默认 dry-run |
|---|---|---|---|
| `open_project` | 打开（或附加到已运行的）TIA Portal V17 项目 | 仅当 `allow_upgrade=true` | 否（升级写入由 `allow_upgrade` 单独把关） |
| `export_blocks` | 导出 PLC 块为 Simatic ML XML（每块一个文件，保留用户组目录） | 否（只写文件系统） | —（无 `dry_run`） |
| `import_blocks` | 导入 Simatic ML XML 或 SCL/STL 外部源 | **是** | **是** |
| `compile_plc` | 编译 PLC 软件并返回编译结果 | 是（编译状态） | —（无 `dry_run`） |
| `close_project` | 关闭项目（可选保存、可选关掉 TIA Portal 实例） | 是（保存/关闭会话） | **是** |
| `controller_status` | 报告控制器子进程与 Openness 环境状态 | 否 | —（不启动控制器） |

**工程与工程数据（v0.2 新增）**

| 工具 | 作用 | 写入 | 默认 dry-run |
|---|---|---|---|
| `create_project` | 新建工程（可选 Author/Comment），并保持打开 | **是**（新目录 + 新工程） | —（无 `dry_run`） |
| `save_project` | 保存工程，或另存到 `save_as_dir` | **是** | —（无 `dry_run`） |
| `archive_project` | `action=archive` 归档当前工程；`action=retrieve` 取回归档并打开 | 归档只写文件；取回打开工程 | —（无 `dry_run`） |
| `project_info` | 只读汇总：工程属性、注释、语言、历史、已用产品、设备树、PLC 软件、TIA 设置 | 否 | —（无 `dry_run`） |
| `project_languages` | 列出/设置支持语言、活动语言、编辑语言、参考语言 | **是**（`action=set`） | —（无 `dry_run`） |
| `project_texts` | 导出/导入整工程文本（xlsx，`ExportProjectTexts`/`ImportProjectTexts`） | 导出只写文件；导入改工程（**无事务，不可回滚**） | —（无 `dry_run`） |
| `update_project` | 写"块编译时仿真支持"与工程注释（多语言文本） | **是** | —（无 `dry_run`） |
| `portal_settings` | 列出/修改 TIA Portal 设置（`SettingsFolders`，如 General/SearchInProject） | 是（`action=set`） | —（无 `dry_run`） |

**PLC 设备数据（v0.2 新增）**

| 工具 | 作用 | 写入 | 默认 dry-run |
|---|---|---|---|
| `list_plc_objects` | 只读枚举块/PLC 类型/标签表（含变量与常量）/外部源/监视表/力表/软件单元，可带属性与指纹 | 否 | —（无 `dry_run`） |
| `create_plc_objects` | 建块组/类型组/标签表组/标签表/监视表/软件单元/单实例 DB | **是** | —（无 `dry_run`） |
| `delete_plc_objects` | 删块/类型/标签表/监视表/软件单元/各类组/变量/用户常量 | **是** | **是** |
| `write_tags` | 建/改/删 PLC 变量与用户常量（含注释、外部可见性） | **是** | **是** |
| `set_block_attributes` | 通用 `SetAttribute` 写块/UDT 属性（如 OB 的 `Priority`） | **是** | **是** |
| `protect_blocks` | 设置/解除块 know-how 保护（`PlcBlockProtectionProvider`） | **是** | **是** |
| `generate_source` | 由块/UDT 生成 `.scl`/`.awl`/`.db`/`.udt` 源文件 | 只写文件 | —（无 `dry_run`） |
| `watch_and_force_tables` | 监视表的建/删/导出/导入、力表的导出/导入 | **是** | —（无 `dry_run`） |
| `software_units` | 软件单元的列出/创建/删除、关系增删 | **是** | —（无 `dry_run`） |

**F 相关（v0.2 新增）**

| 工具 | 作用 | 写入 | 默认 dry-run |
|---|---|---|---|
| `safety_status` | 只读：`GlobalSettings` 两个动作、`SafetySettings`、`SafetyAdministration`、运行时组 | 否 | —（无 `dry_run`） |
| `set_safety_settings` | 写 `SafetyModificationsPossible` 与 `UsernameForFChangeHistory` | **是** | —（无 `dry_run`） |
| `safety_signatures` | 只读：逐块 `SafetySignatureProvider` 的 F 签名（`BlockOfflineSignature`） | 否 | —（无 `dry_run`） |

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
{ "compile_plc": {} }                       // 真编译：返回 state/errorCount/warningCount/messages

// 6) 保存并关闭
{ "save": true, "dry_run": false }
```

### 4.2 dry-run 与写入策略

`dry_run` **只留给"预览本身带信息量"的工具**（决策 [D22](docs/decisions.md)）：预览要能把模型
自己算不出来的东西查出来 —— 把名字/路径解析成真实对象、把冲突与现有状态 diff 出来 —— 而且
真正的风险落在**写入那一步**。满足这两条的只有 7 个：

- **默认 `dry_run: true`**（必须先预演，再显式传 `dry_run: false`）：`import_blocks`（逐文件解析 +
  目标块名解析 + 冲突与组不匹配）、`delete_plc_objects`（解析出真实删除集合与存在性）、
  `write_tags`、`set_block_attributes`、`protect_blocks`（逐对象 before/after 与当前保护状态）、
  `close_project`（会丢弃哪些未保存改动）。
- **`open_project`** 的 `dry_run` 默认 `false` 且是**零 TIA 接触**：它连 TIA Portal 都不启动，
  只校验路径；唯一可能的写入（升级重写项目）由独立的 `allow_upgrade`（默认 `false`）把关。
- **其余 14 个工具没有 `dry_run`**：`export_blocks`、`compile_plc`、`create_project`、`save_project`、
  `archive_project`、`project_languages`、`project_texts`、`update_project`、`portal_settings`、
  `create_plc_objects`、`generate_source`、`watch_and_force_tables`、`software_units`、
  `set_safety_settings`。理由分两类：(a) 它们写的是一两个具名对象，**真的调用会在写入前干净失败**
  （`object_already_exists`、`group_not_found`、`language_not_found`、`setting_not_found`、`file_exists`），
  预演买不到额外安全；(b) 预览只是把入参复述一遍（`wouldWrite: true`），没有信息量。
- **读操作**（`project_info`、`list_plc_objects`、`safety_status`、`safety_signatures`）不声明 `dry_run`：
  它们不写任何东西。
- **例外需要记一笔**：`project_texts` 的 `action=import` **不包在事务里**（Openness 手册禁止在事务内做
  ProjectText 导入），所以它无法回滚；去掉 dry-run 后这一处没有确认步骤，若将来要补，正确机制是
  用户审批（DSH 的 approval 门），而不是一个零信息量的预演。
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
  `skills` **没有**被放进宿主行的模块级 `inject`，所以未挂 skill 注册表的 profile 里
  宿主行（以及工具行）照常加载。知识库属于**宿主行**：它是 composition 级的知识，
  不是"某个 agent 的工具面"，所以不随工具行一起按 preset 开关。
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

### 4.5 给工程上下文插件的服务：`engineeringAccess`

宿主行**不注册任何模型可见工具**，它注册两个 cordis 服务。公开的那个是 `engineeringAccess`
（[`src/access.ts`](src/access.ts)），供**工程上下文插件**调用 —— 它要指纹做工程级
变更检测，而按架构规定它**自己不允许与 TIA Portal 对话**（发行版
[`docs/decisions.md`](../../docs/decisions.md) **D12** 的"缝 A"）。另一个是
`tiaOpennessRuntime`（[`src/runtime-service.ts`](src/runtime-service.ts)），只给本包的工具行读，
**不是公开接口**：其它插件要驱动 TIA 只能走 `engineeringAccess`。

| 方法 | 触发的操作 | 关键点 |
|---|---|---|
| `status()` | —（只读控制器快照） | 报告"值不值得试"：可执行文件在不在、Openness 探没探过；**从不启动控制器** |
| `openProject(path, opts)` | `OpenProject` | `allowUpgrade` 默认 false（打开唯一不可逆的写） |
| `closeProject(opts)` | `CloseProject` | **`dryRun` 是必填参数** —— 调用方是代码，不替它默认 |
| `listObjects(query)` | `ListPlcObjects` | 把每族的 `{count,items,truncated}` 摊平成一行一对象；默认 `max_items=1000` |
| `exportObjects(query)` | `ExportBlocks` | 与 `export_blocks` 同参；只写文件，不动工程 |
| `saveProjectAs(dir)` | `SaveProject` + `save_as_dir` | 另存到指定目录；**回读** TIA 实际产出的路径（项目名改不了，只有目录是新的） |
| `readTiaSession()` | `ProjectInfo` | 控制器在不在 + TIA 开着哪个项目 + 设备清单；**从不启动控制器** |
| `rebuildSource(root, opts)` | `ProjectInfo` + 每 device 两次 `ExportBlocks` | **`<root>/<device>/{blocks,types,tag_tables}/…` 的布局由它定死**；被 TIA 拒绝的对象逐条回报 |

- **与工具走同一条路径**：每个方法都构造与对应工具**相同**的操作与参数、复用 `runOperation`，
  所以模型面与服务面不会在默认值或错误形状上互相漂移。
- **失败语义与 §8 一致**：操作级失败（TIA 拒绝、块不存在）返回 `ok:false` + 结构化 `error`；
  传输级失败（找不到 exe、超时、协议不匹配）**抛出**。
- **不新增 C# 能力**：八个方法全部落在已有的白名单操作上，所以工具数（26）与操作数（25）不变。
- **它是可选的**：消费方按名取（`ctx.get('engineeringAccess')`），取不到就降级 ——
  读上一次的指纹工件并**明确报过期**，而不是装作数据是新的。
- 为什么"翻页"在 V17 上不存在、为什么 `closeProject` 这样定、`source/` 布局为什么归本插件：
  [`docs/decisions.md`](docs/decisions.md) **D20** / **D21**；契约镜像在
  [`packages/dsh-engineering-context/docs/ARCHITECTURE.md`](../dsh-engineering-context/docs/ARCHITECTURE.md) §5.3。

---

### 4.6 斜线指令：`/tia-…`（`/commands` 行）

DSH 的斜线指令是**绕过模型**的直接执行面：命令行与结果都不进模型上下文，UI 只落一张可折叠的
结果卡（折叠时只显示正文第一行）。因此只有"人能在一行里说清、结果能一眼看完"的操作才做成命令；
需要 dry-run → 复核 → apply 的结构化写入（导入、删对象、写变量、改属性、保护块）仍然只走模型工具。

| 命令 | 语法 | 映射 | 默认行为 |
|---|---|---|---|
| `/tia-open` | 无参数 | `OpenProject` | 打开**本工作区**的 TIA 项目，**可见窗口**；不升级旧工程 |
| `/tia-save` | 无参数 | `SaveProject` | 就地保存 |
| `/tia-compile` | 无参数 | `CompilePlc` | 编译当前 PLC，最多回 50 条消息 |
| `/tia-close` | `[--discard] [--portal] [--dry]` | `CloseProject` | **保存并关闭**；`--discard` 丢弃改动，`--portal` 同时关掉 TIA，`--dry` 只报告 |
| `/tia-info` | `[sections…]` | `ProjectInfo` | 默认 `attributes comment software`；`history_limit=10`、`max_objects=50` |
| `/tia-find` | `<substring> [--blocks] [--types] [--tables] [--units] [--fp]` | `ListPlcObjects` | 默认块/类型/变量表，`max_items=50` |
| `/tia-status` | 无参数 | —（控制器快照） | **从不启动控制器**，只读状态 |

- **`/tia-open` 不带路径**：先读 `source/_dsh-engineering-context.json` 的 `project.savedAs`，
  没有索引就扫 `tia/<name>/<name>.ap17`；**只认工作区里的副本**，绝不打开 `project.path` 指向的源工程。
  找到多个就报错列出，不猜。
- **`/tia-close` 默认保存**：工具面的 `close_project` 为模型默认 `dry_run=true`（模型可能不知道有没有
  未保存改动），而人敲 `/tia-close` 就是要关；丢改动必须显式 `--discard`。
- **结果是给人看的文本**：每条命令的第一行是摘要（如 `Opened Sino_PEI — 1 PLC software, 1155 block(s)`），
  其余是多行详情；失败时沿用工具的 `Error code / Reason / Hint` 渲染。
- **命令不写模型历史**：`/tia-open`、`/tia-save` 执行后模型并不知道状态变了；需要模型接着做时，
  让它先调 `project_info` / `controller_status`，或直接在对话里说明。
- **取消是协作式的**：命令卡上的取消只停止等待，TIA 侧的 Openness 操作不保证被打断。

---

## 5. 安全设计

| 措施 | 实现 |
|---|---|
| 操作白名单 | 控制器只接受 `controller/Protocol.cs` 的 `OperationCatalog` 里的 25 个操作名（v0.1 的 5 个 + v0.2 的 20 个）；其它名字返回 `unsupported_operation`。插件侧 `src/protocol.ts` 的 `OPERATIONS` 是同一份列表（双重校验，互不信任），`npm run matrix:check` 逐条比对两者 |
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
| `01-load.test.mjs` | **加载与拆分契约**：两行的模块级 `name`/`inject`/`apply`（宿主行 `inject: []`，工具行 `['tools', 'tiaOpennessRuntime']`）；工具行按注册顺序注册相同的 26 个工具、宿主行一个工具都不注册、缺少宿主行时工具行报错；参数与输出 schema 用**真实** `@deepseek-ai/dsh-tools` 编译器编译；校验器拒绝缺参/错类型/越界枚举；工具描述包含 dry-run 策略与错误码；工具返回值通过 output schema 校验；控制器缺失时宿主行仍能加载并给出结构化原因 |
| `02-lifecycle.test.mjs` | **生命周期测试**：用真实 exe 启动控制器，断言操作系统可见该进程；`ctx.effect` 的 disposer 卸载后断言**进程已消失**；卸载幂等；配置了不存在的路径时调用失败为 `controller_not_found`。注意：触发卸载的是测试里忠实模拟 `ctx.effect` 语义的 disposer，不是真实 DSH loader 的 HMR 路径（该环待人工验证） |
| `03-controller-protocol.test.mjs` | **协议测试**：握手、白名单拒绝、参数校验、`project_not_open`、ASCII 转义、进度帧、请求串行化、队列上限；用 stub 控制器覆盖**卡死超时→终止→重启**、请求中途退出、协议版本不匹配、stdout 噪声（这一组还捕获并回归了一个真实的 bug：被替换的旧子进程的迟到 `exit` 事件会清掉新子进程引用，导致进程泄漏） |
| `04-tools.test.mjs` | **工具语义**：每个工具发送的参数与默认值、dry-run 只留给预览带信息量的 7 个工具（决策 D22）、只发送白名单操作、`controller_status` 不触碰控制器、渲染文本包含错误码/提示/诊断 |
| `05-controller-cli.test.mjs` | **C# 控制器**：`--self-test` 14 项检查全绿；Openness 探测与用户组；`--version`/`--help`；命令行输出重定向为结构化帧；`--param` 重复值成数组 |
| `06-skills.test.mjs` | **知识库（替身注册表）**：宿主行 `ctx.inject(['skills'], …)` 注册；没有 skills 服务的 profile 仍加载控制器与全部工具；目录只多一条且 description ≤ 500；`get()` 正文无 frontmatter、引用的每个上游文件都存在、正文 < 8192；vendored 树与 `UPSTREAM.json` 一致；每个工具描述都指向该 skill |
| `07-skills-registry.test.mjs` | **知识库（真实注册表）**：把 `@deepseek-ai/dsh-skill` 的真实 `SkillRegistry` 挂到裸 cordis context 上（**不需要**工具注册表，因为宿主行已不含工具），验证 candidate 被真实校验接受、重名注册被拒、`get()` 能加载、`renderSkillContent` 带上 base directory、卸载宿主行后目录项消失 |
| `08-access-service.test.mjs` | **服务缝**：`engineeringAccess` 每个方法发送与对应工具相同的操作与参数、族信封摊平、截断如实上报、`closeProject` 必须显式给 `dryRun`、操作级失败回数据而传输级失败抛出；宿主行发布内部 `tiaOpennessRuntime` 缝（恰好三个成员）且卸载后消失 |
| `09-two-rows.test.mjs` | **两行接线的真实服务图**：把两行当**兄弟插件**挂在裸 cordis `Context` 上（只有记录用的 `tools` 服务），断言工具行的 `inject` 由宿主行满足、跨行读到 `tiaOpennessRuntime` 并注册同名同序的 26 个工具；宿主行自己一个工具都不注册，卸载后缝消失 |

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
| `unsupported_operation` / `unsupported_frame` | 越出白名单的请求被拒绝；`details.allowed` 列出全部 25 个允许的操作名 |
| `delete_failed` / `object_not_found` / `object_already_exists` | v0.2：删除对象失败 / 目标不存在（`details.missing`、`details.available`）/ 已存在 |
| `project_create_failed` / `project_save_failed` | v0.2：新建工程失败（目录非空、名称含非法字符等）/ 保存或另存失败 |
| `project_not_saved` | v0.2：`archive_project` 前工程有未保存改动（手册要求先 Save） |
| `archive_failed` / `archive_not_found` / `retrieve_failed` | v0.2：归档写入失败 / 归档文件不存在 / 取回失败 |
| `language_not_found` / `language_change_failed` | v0.2：工程不支持该语言（`details.available` 给出支持列表）/ 语言设置失败 |
| `project_text_export_failed` / `project_text_import_failed` / `project_update_failed` | v0.2：工程文本 xlsx 导出/导入失败 / 工程属性或注释写入失败 |
| `setting_not_found` / `setting_change_failed` | v0.2：TIA Portal 设置项不存在（列出可用文件夹与设置）/ 写入失败 |
| `group_not_found` / `group_not_empty` / `group_create_failed` | v0.2：用户组不存在 / 非空不能删 / 建组失败 |
| `tag_table_not_found` / `tag_not_found` / `tag_create_failed` / `tag_update_failed` / `constant_create_failed` / `constant_update_failed` | v0.2：标签表或变量/常量不存在与写失败 |
| `attribute_not_writeable` / `attribute_write_failed` | v0.2：属性没有写权限（`GetAttributeInfos` 无 Write）/ 写入失败 |
| `protection_unavailable` / `protect_failed` / `unprotect_failed` | v0.2：块不可 know-how 保护（provider 为 null）/ 加保护失败 / 解保护失败 |
| `generate_source_failed` / `file_exists` | v0.2：生成源文件失败 / 目标文件已存在且未给 `overwrite` |
| `watch_table_not_found` / `force_table_not_found` / `table_create_failed` / `table_delete_failed` | v0.2：监视表或力表不存在、建删失败；力表在 V17 既不能建也不能删（限制 R15） |
| `unit_provider_unavailable` / `unit_not_found` / `unit_exists` / `unit_create_failed` / `unit_delete_failed` / `relation_create_failed` | v0.2：软件单元——该 PLC 不支持 / 单元不存在或已存在 / 建删失败 / 关系建立失败 |
| `global_settings_unavailable` / `safety_setting_failed` / `signature_read_failed` | v0.2：没有 `Siemens.Engineering.Safety.GlobalSettings` 服务（未装 STEP 7 Safety）/ 写 F 相关设置失败 / 读 F 签名失败（非 F 块不报错，回报 `isFBlock:false`） |
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
  index.ts             宿主行入口：name / inject[] / Config / apply，ctx.effect 拥有子进程
  tools-entry.ts       工具行入口（exports["./tools"]）：读 tiaOpennessRuntime，注册 26 个工具
  commands-entry.ts    命令行入口（exports["./commands"]）：读 tiaOpennessRuntime，注册 7 个 /tia-… 斜线指令
  runtime-service.ts   宿主行与另两行之间的内部缝 tiaOpennessRuntime（恰好 request/status/verbose）
  config.ts            Schemastery 配置 schema + 归一化（所有字段有默认值）
  controller.ts        C# 控制器的生命周期、NDJSON 帧、串行化、超时与终止
  protocol.ts          线路类型 + 容错帧解析 + 统一结果信封
  skills.ts            知识库：把 skills/ 注册成一个 bundled skill（ctx.inject(['skills'], …)）
  tools.ts             26 个 defineTool 定义（模型可见描述）与渲染；工具行/命令行共用的唯一实现
  commands.ts          7 个斜线指令：单行语法解析、首行摘要、工作区工程定位
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
  Operations.cs        白名单操作：块/类型/标签表导出导入、编译、开关工程（dry-run、事务、写后验证）
  OperationsProject.cs v0.2 工程与工程数据（创建/保存/归档/取回/信息/语言/文本/设置）
  OperationsPlc.cs     v0.2 PLC 设备数据（枚举/建删/变量/属性/保护/生成源/监视表/软件单元）
  OperationsSafety.cs  v0.2 F 相关（GlobalSettings、SafetyAdministration、F 签名）
  OpennessHost.cs      会话：TIA Portal 实例、工程、独占访问事务、块遍历
  OpennessHost.Project.cs / .Plc.cs / .Safety.cs  上述三块的宿主侧实现
  SimaticMl.cs         Simatic ML XML 头解析与 SCL/STL 外部源扫描
  SelfTest.cs          14 项无 TIA 自检
test/                  node:test 测试套件
test-profile/          试跑材料：三层验证指南 + 两个脚本 + --patch 叠加层（不改默认 profile）
docs/PROTOCOL.md       线路协议与错误码（权威描述）
docs/EXTENDED-SURFACE.md  v0.2 新增 20 个操作的参数与返回契约（冻结）
docs/VERIFICATION-PLAN.md v0.2 新增能力的真实项目验证清单（待执行）
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
- **块、PLC 类型与标签表仍是核心，但已不止于此**：`export_blocks` / `import_blocks` 用 `categories` 选择
  `blocks`（默认）/`types`（PLC 数据类型 UDT）/`tag_tables`，三族对象互不冲突；
  v0.2 又补上工程生命周期与工程数据（`create_project`/`save_project`/`archive_project`/`project_info`/
  `project_languages`/`project_texts`/`update_project`/`portal_settings`）、PLC 对象增删改
  （`list_plc_objects`/`create_plc_objects`/`delete_plc_objects`/`write_tags`/`set_block_attributes`/
  `protect_blocks`/`generate_source`/`watch_and_force_tables`/`software_units`）与 F 相关
  （`safety_status`/`set_safety_settings`/`safety_signatures`）。仍未实现：硬件组态与网络、
  在线下载/上传/比较、库与主副本、多用户、HMI、OPC UA、工程图形删除、只读/UMAC 打开、
  力表的创建与删除（V17 无相应 API，见限制 R15）。完整的逐条覆盖情况见
  [`docs/coverage-matrix.html`](docs/coverage-matrix.html)（随代码自动重新生成）。
  PLC 类型与标签表可以被导入，但块的读回验证覆盖不到它们（会给出 warning）。
- **v0.2 的 20 个操作尚未在真实项目上验证**：已实现、编译、单测通过，但真实 TIA Portal 行为
  （尤其是 `archive_project` 的取回、`project_texts` 的 xlsx 往返、`software_units` 需要支持
  软件单元的 CPU、`safety_*` 需要 STEP 7 Safety 与 F-CPU）留待逐条执行
  [`docs/VERIFICATION-PLAN.md`](docs/VERIFICATION-PLAN.md)。在跑完之前不要把这些操作当成
  "已在 V17 上实测"向他人转述。
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