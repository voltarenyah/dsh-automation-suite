# 决策记录（decisions）

本文件记录开发过程中的技术取舍、被否掉的方案与理由。约束：本项目**不在夜间修改用户
环境**，凡涉及用户 DSH profile / 全局配置的动作一律不做；只在本仓库目录内读写与提交。

---

## D1. 不做"安装进真实 DSH profile"的实机验证（最重要的一条）

**决定**

不把本 bundle 安装进 `~/.dsh/profiles/desktop`（也不新建/修改任何 profile、
bundle 列表、`cordis.patch.yml`、`package.json`）。真实宿主上的"安装 → 加载 → 卸载"
验证**跳过**，改由仓库内自动化测试作为证据，并在 README / `docs/verification.md`
中明确标注为**待人工验证**，附手动步骤。

**候选方案与被否理由**

| 方案 | 结果 | 理由 |
|---|---|---|
| A. 用 `plugin_manager install_bundle` 装进 `desktop` profile，观察子进程出现/消失 | **否** | 会写入用户的 profile：`profiles/desktop/package.json`（bundles 列表 + 依赖）、`pnpm-lock.yaml`、`cordis.patch.yml`、`node_modules`。夜间无审批通道，用户明确要求"不要动我的 profile"。回退虽可行（`remove_bundle`），但每一次回退本身就是又一次对用户环境的写操作，且桌面端 profile 是**启动时**组合，不影响运行中的会话，验证价值低于风险 |
| B. 新建一次性 profile（`--from-default-profile web`）再 boot 验证 | **否** | 该 profile 的 app 是 web 应用，boot 会再起一个 HTTP 服务，与用户正在用的 GUI（127.0.0.1:19387）存在端口/profile 锁冲突风险；`--dump-config` 只组合、不 mount，无法证明 `apply` 被调用 |
| C. `dsh headless "<task>"` 触发真实加载 | **否** | 需要真实 LLM 调用（消耗用户额度），且 headless 也会写 profile 的会话/存储目录 |
| D. 直接 `node -e "import(...)"` 走裸 cordis Context | **否（作为"宿主验证"）** | 裸 cordis 无法提供 `ctx.tools` 服务（实测：`ctx.plugin(dsh-tools)` 后 `ctx.tools === undefined`，因为 dsh-tools 依赖会话/代理等其余服务）。**已采纳**为"模块级加载测试"的一部分（`test/01`），但明确不把它当作宿主安装验证 |
| E. 忠实模拟 `ctx`（`tools.register` / `logger` / `effect`）跑真实 `lib/` 构建产物 | **采纳** | 覆盖 apply、注册、disposer、真实 exe 子进程生命周期；不触碰用户环境。局限（不是真实 registry、不是真实 HMR 卸载）已在文档中写明 |

**残留风险与缓解**

- 风险：真实 registry 的注册校验、真实 HMR 卸载顺序、真实 profile 的模块解析与
  测试模拟不完全一致。
- 缓解 1：`test/01` 用**真实** `@deepseek-ai/dsh-tools`（`defineTool` 编译参数与输出
  schema、`validateJsonSchemaValue` 校验）验证每个工具的 schema 与返回值，因此"注册
  能否被 registry 接受"这一环已被真实代码验证过。
- 缓解 2：手动验证步骤写在 `docs/verification.md` §B 与 README §7，用户白天可自行执行。

---

## D2. 测试用运行时包：本地链接而不是 npm 依赖

**决定**：`scripts/link-dsh-runtime.mjs` 把 harness 自带的 `@deepseek-ai/dsh-tools`、
`cordis`、`schemastery` 以 junction 方式链到仓库 `node_modules`（gitignore），
使 `npm test` 在裸 checkout 上可运行。

**理由**：插件与已发布插件一样 `import '@deepseek-ai/dsh-tools'`，运行时由 profile 的
runtime resolution 解析；构建期不应依赖网络，也不应把 harness 复制进仓库。
`@deepseek-ai/dsh-tools` 在 npmmirror 上只有 `0.0.1-rc.1`（远旧于运行时的 `0.2.0-rc.2`），
把它作为 devDependency 会引入版本错配。

**已知局限**：链到的是 `~/.dsh/profiles/node_modules` 里的副本（`dsh-tools 0.1.5-rc.2`），
而桌面宿主实际用安装目录里的 `0.2.0-rc.2`。本插件只依赖两版都有的稳定 API
（`defineTool` / `ctx.tools.register` / `ctx.effect` / Schemastery `Config`），
真实 `0.2.0-rc.2` 下的行为待人工验证（见 `docs/verification.md` §B.2）。

> **本条已被下方 D19 取代**（来源改为从 `app.asar` 抽取的 `<DSH_HOME>/plugin-runtime`）。
> 而且"真实宿主版本下也照常工作"这一条**已由测试覆盖**：0.2.1-rc.2 上 77 项测试
> （76 通过 / 1 跳过）都是对着真运行时跑的，见 `docs/verification.md` §B.2。

---

## D3. 类型来源：本地 ambient 声明（`src/dsh-runtime.d.ts`）

**决定**：不依赖发布包的 `.d.ts` 做构建；在仓库内声明本插件用到的那一小块
（`Context.effect`/`Context.tools`/`defineTool` DSL/`schemastery`）。

**理由**：① 离线可构建；② 发布包的 `.d.ts` 内部使用 `./schema.ts` 形式导入，
在没有 `allowImportingTsExtensions` 的 emit 配置下解析不稳；③ 运行时副本版本与
发布包版本不一致，用任一份都会产生"看起来对"的假保证。

**代价与缓解**：类型可能与真实实现漂移。缓解：`test/01`/`test/04` 全部用**真实**
运行时的编译器与校验器跑工具的 schema 与返回值；一旦声明与实际不符，测试会失败。

---

## D4. 结构化失败 vs 抛错（工具结果契约）

**决定**：

- **操作失败**（控制器已执行并返回 `ok:false`，如 `block_not_found`、`project_not_open`、
  `verification_failed`）→ 作为**规范返回值**返回，`ok:false` + `error{code,message,details}`，
  渲染文本以 `FAILED` + 错误码开头。
- **传输失败**（找不到 exe、握手超时、超时被终止、协议不匹配、写管道失败、取消）
  → **抛出** `ToolFailure`，消息以错误码开头。

**理由**：前者是模型需要据以调整下一步的**业务信息**，必须保留结构化字段（DSH 把抛出的
错误统一渲染为 `Error: <message>`，结构会丢失）；后者工具根本没跑起来，属于
"调用失败"，应让宿主标成错误结果。两者都在 `docs/PROTOCOL.md` 的错误码表中分列。

---

## D5. dry-run 默认值的划分

**决定**：

| 工具 | 默认 | 理由 |
|---|---|---|
| `import_blocks` | `dry_run: true` | 修改项目内容 |
| `compile_plc` | `dry_run: true` | 改变项目编译状态 |
| `close_project` | `dry_run: true` | 保存/关闭会话即写入 |
| `open_project` | `dry_run: false` | 默认参数下**不修改项目内容**；唯一可能的写入（升级重写项目）由独立的 `allow_upgrade`（默认 `false`）把关，fail-closed |
| `export_blocks` | `dry_run: false` | 只读项目、只写文件系统 |

**理由**：需求要求"所有写入操作默认 dry-run"。若把 `open_project` 也默认 dry-run，
正常流程（open → export）第一次调用必然空转，模型容易误判；而升级写入已被
`allow_upgrade` 显式把关，因此这样划分既满足"写入默认 dry-run"的实质
（fail-closed + 显式确认），又保持可用性。此划分写进了每个工具的模型可见描述、
README §4.2 与 `docs/PROTOCOL.md`。

---

## D6. 超时处理：终止子进程，且绝不杀 TIA Portal

**决定**：`requestTimeoutMs` 到点后**终止控制器进程**（Windows 上 `kill` 即
`TerminateProcess`），并把这次调用判为 `controller_timeout`；下一次调用自动重启控制器。
插件**从不**去结束 `TiaPortal.exe`。

**理由**：Openness 调用不可取消，等待只会挂死宿主；TIA Portal 是独立进程，可能是用户
自己打开的窗口或其它客户端在用，杀掉它是越界行为。后果（该会话丢失）在 README §5、
工具描述与 `docs/PROTOCOL.md` 中都写明，并提示用 `close_project({close_portal:true})`
正常收尾。

---

## D7. 编译走 `ICompilable`，而不是内部 `CompileProvider`

**决定**：`plcSoftware.GetService<ICompilable>().Compile()`。

**理由**：实测（编译器 CS0122 + 反射）确认 V17 的
`Siemens.Engineering.Compiler.CompileProvider` 是 **internal**，而
`ICompilable` / `CompilerResult` 公开；`ICompilable` 的唯一实现者就是那个内部 provider。
因此公开可用的编译入口是按接口取服务。用反射硬调内部类型被否掉了：脆弱、且与
"不做任意反射调用"的安全取向冲突。

---

## D8. 只为测试暴露的启动参数接缝（`ControllerOptions.launchArgs`）

**决定**：`ControllerProcess` 增加可选 `launchArgs`（替换默认 `--stdio …`），生产路径不传。

**理由**：传输层最难的几条路径（卡死的子进程、请求中途退出、协议版本不匹配、
stdout 噪声）在真实控制器上**无法构造**（要构造就得先把 TIA Portal 弄坏）。
给一个"用什么参数启动"的显式接缝，让 `test/03` 用 Node stub 覆盖这些路径，
代价是生产 API 多一个字段。该字段的文档注释写明了"生产留空，测试用"。

**收益（非预期）**：这组测试当场抓到并回归了一个真实 bug —— 被替换的旧子进程的
迟到 `exit` 事件会清空新子进程的引用，导致新子进程成为孤儿（永不终止）。
修复见 `src/controller.ts` 的子进程身份检查。

---

## D9. 导入目标组固定为根块组；只做块

**决定**：`ImportBlocks` 一律导入到 `plcSoftware.BlockGroup.Blocks`（根组），
不提供 `target_group`；本插件不实现标签表/UDT 直导/HMI/在线下载等。

**理由**：名称中的 "Min" 就是最小化，需求只要求块读写；TIA 的 Simatic ML 导入本身
也不保留导出时的用户组层级（导出仍按组写目录，便于人读）。缩小面 = 减少出错面。
`SW.Types.PlcStruct` 可被导入但不在块集合中，验证时会以 warning 明确说明覆盖不到。

---

## D10. 进程模型：一个宿主进程一个控制器

**决定**：`apply` 每次组合只创建一个 `ControllerProcess`；`inject: ['tools']`；
子进程由 `ctx.effect()` 的异步 disposer 停止（框架 await 它）。
`apply` 里对进程做 pre-warm（fire-and-forget），但**不**因启动失败而让插件加载失败。

**理由**：① 需求要求用 `ctx.effect()` 管理子进程；② 一台机器同时只应有一个 Openness
客户端在改一个项目，多实例只会互相阻塞；③ 没有 TIA Portal 的机器也必须能加载插件并
给出结构化原因（否则用户根本看不到工具，也读不到 `controller_not_found` 的说明）。
卸载的确定性由"disposer 先 await 在飞的 start，再 stop"保证（见 `src/index.ts`）。

---

## D11. 进程内不再使用提问工具（流程决策）

**决定**：后续不再调用 `ask_user_question`。需要决策时自行选择更保守、可回退的方案，
并记入本文件。

**理由**：用户当前只走 HTTP 通道，夜间无法回答，提问会让整轮挂起（本次已实际发生一次）。

---

## D12. `.tools/asar.cjs` 保留为开发工具

**决定**：保留 `.tools/asar.cjs`（无依赖读取 Electron `app.asar` 的小工具，用于查看
DSH 自身实现与参考 skill），**不属于**插件运行时，也不被 `package.json#files` 包含。

**理由**：维护本插件时（例如核对 dsh-tools 的真实签名）需要读 asar 内的源码；
它是只读工具，不参与构建与运行。

---

## D13. 采用 Siemens 官方 NuGet 包（构建期引用 + 运行期解析器）

**决定**：把自研的"参考 + 运行时解析"整体换成 Siemens 官方包（分支 `feat/siemens-nuget`）：

- 构建期：`Siemens.Collaboration.Net.TiaPortal.Packages.Openness` **17.0.1685432625**
  （替换 csproj 里的 `OpennessDir` 属性 + `<Reference><HintPath>`）；
- 运行期：`Siemens.Collaboration.Net.TiaPortal.Openness.Resolver` **1.1.1725480302**
  （替换 `AssemblyResolver.Install` 作为主解析器，并在 ctor 前用
  `Api.Global.Openness().Initialize(tiaMajorVersion: 17)` 初始化）；
- 显式钉住 `Siemens.Collaboration.Net.OperatingSystem.Windows` **3.0.1725521661**，
  消除 NU1603（Resolver 1.1 声明的那个依赖版本 Siemens 已不再发布）；
- **保留** [AssemblyResolver.cs](../controller/AssemblyResolver.cs) 作为**最后手段**，
  并新增 [OpennessBootstrap.cs](../controller/OpennessBootstrap.cs) 负责惰性初始化 + 诊断 + 兜底注册。

**理由（实测证据，非推测）**

| 事实 | 证据 |
|---|---|
| 官方包确实存在且是 Siemens AG 发布 | NuGet 上 9 个同族包；引用包 35 个版本（17.0.x–21.0.x），Resolver 8 个版本；下载量 75,375 / 19,561 |
| 构建期在你机器上确实可用 | 构建打印 `Resolve Siemens.Engineering assemblies for TIA Portal V17.0 from C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17`；csc 命令行里出现该 DLL 与 `.Hmi.dll` 的 `/reference:`，而**产物里没有它们**（`CopyLocal=false`） |
| 它读的注册表项你机器上正好存在 | `HKLM\SOFTWARE\Siemens\Automation\Openness\17.0\PublicAPI\17.0.0.0` → 值 `Siemens.Engineering` = 本机 V17 DLL 路径 |
| 不挂 VPN 可构建 | 冷缓存（清 http-cache + 空 NUGET_PACKAGES）`dotnet restore` **13.3 s**；`api.nuget.org` 200/约 1 s；`globalcdn` 2.4 MB/约 2 s；华为云镜像收录这两个包（259–692 ms） |
| 运行期能初始化 | `--operation CompilePlc` 不再报 `openness_unavailable`，而是走到 `project_not_open`；`--self-test` 的 `openness_not_loaded_by_startup` 仍为 `true`（惰性初始化生效） |
| 官方库能力更宽 | XML 文档列出 `GetTiaPortalProcesses`（临时 AppDomain 里枚举跨版本进程）、`Edition()`（Editions 布局）、`IsUserInGroup`/`AddUserToGroupAsync`（含提权加组）、`IsAppWhitelisted`/`WhitelistApp`（**白名单**，本插件此前完全没有） |

**已知代价（全部实测）**

- 产物从 ~100 KB 变成 **1.1 MB**，其中 **889 KB 是 6 个 Siemens 程序集**（未修改）——即分发面从
  "零 Siemens 二进制"变成"随包分发 Siemens 解析器链"；合规分析见
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)（许可证第 2 条的 MIT 只覆盖**源代码**，
  对象码分发属于需要确认的判断；给了"严格零二进制"的做法）。
- 构建期需要 NuGet 源（首次 13 s，之后走本地缓存）。
- **版本线断裂**：Resolver V2 只兼容 TIA V21+，V17 锁定 1.1（2024-09）；将来做 V21 插件要换到 2.0
  且不能回头兼容 <V21——与"每个 TIA 版本一个插件"的计划天然吻合。
- 官方源码**不可读**：nuspec 里的 `repository` 指向 `tia-portal-applications/tia-portal-openness-assembly-resolver`，
  该仓库 404（org 下其他仓库公开，故非拼错）。
- **API 陷阱（已踩）**：`Initialize` 的位置参数 `Int32` 是 **TIA 进程 id**，不是版本；
  必须用命名参数 `tiaMajorVersion:`，否则报 `Process with an Id of 17 is not running`。
  这条已写进代码注释、README §6.1 和错误提示里。

**为什么保留兜底而不是彻底删掉自研代码**：官方解析器的失败模式（首次真实 `OpenProject`）在没有
V17 项目样本时无法验证，而 `main` 分支（纯自研、45 项测试全绿）是随时可回退的基线。
兜底的注册顺序保证官方解析器**始终优先**（`AssemblyResolve` 后注册者先执行），它只在"谁都解析不出来"
时生效；官方初始化失败也改为**非致命**（记诊断、降级、下个操作重试），因此这次替换相对原实现
严格不降级。若功能测试通过、确认官方解析器在你的项目上工作正常，删掉兜底只需删
`AssemblyResolver.cs` 与 `OpennessBootstrap` 里那一行注册。

**回退**：`git checkout main`（`dd9aa27`）即回到零 NuGet、零 Siemens 二进制分发的状态。

---

## D14. 导出：逐块容错，而不是一个块失败就整批失败

**背景（真实项目实测）**：对 237 块的真实项目做导出，`ProDiagOB` 直接抛错：

```
Error when calling method 'get_ProgrammingLanguage' … The programming language 'ProDiag_OB' is not supported during import and export.
```

当时实现是"任一块失败即中止整批"，结果 **237 个块只写出 2 个就中止**。

**决定**：
- 单块导出失败 → **记录到 `data.failures[]`**（含 file/code/message）+ 一条 warning 诊断 + `changes[]` 标 `export_failed`，
  **继续导出其余块**；`summary` 拆成 `exported / skipped / failed / verificationFailed`；
- 失败优先级：**一个都没成功** → `export_failed`；**显式 `block_names` 里有块被拒** → `export_failed`（附已写文件与
  `details.refused`）；**写出的文件读回失败** → `verification_failed`；其余情况 `ok:true` + 逐块失败清单；
- manifest 增加 `failureCount` 与 `failures[]`，这样后续导入知道哪些块根本没有 Simatic ML 表示。

**理由**：真实项目里"存在 Openness 根本不支持的块"是常态（ProDiag 语言、Safety F 块 "export is not permitted"）。
把整批拖下水既丢功能也不诚实；逐块报告 + 显式请求规则既保住可用性，又不会让"我点名要的块没导出"被静默吞掉。

**实测效果**：同一项目导出从 **2 个** 变成 **234 个成功 / 3 个被拒（逐块说明）**。

---

## D15. 导入：目标块组 + 目录镜像（否则用户组里的块永远无法覆盖）

**背景（真实项目实测，复现 3 次）**：把位于用户组 `999_Kautex` 的 `FB_Array_Handling` 导出的 XML，
用 `ImportOptions.Override` 导入到**根组**，稳定失败：

```
The block name 'FB_Array_Handling' is invalid. An object with this name or this number already exists.
```

即使是**原封不动**的导出文件也一样失败（先排除了"我改坏了文件"）；而把块**改名+改号**后导入同一个根组就成功，
把**原名原号**导入到 `999_Kautex` 也成功。结论：**导入按"全 PLC 名字/编号唯一"判断，override 不能跨组覆盖**。

**决定**：
- 新增 `target_group`（显式组路径，如 `999_Kautex` 或 `A/B`）：不存在时报 `group_not_found`（附可用组清单），
  除非 `create_group=true`（缺失时按层级创建）；
- 新增 `mirror_groups`（默认 `true`）：当 `import_paths` 给的是**目录**时，每个文件的子目录即它的组路径
  —— 这正是导出写出的布局，于是"导出到目录树 → 导入该目录树"能自动回到原位；镜像组不存在时**回退根组并告警**（不硬失败）；
- 计划里为每个文件报 `targetGroup`，已存在但组不一致时报 `existingGroup` + `groupMismatch:true`；
- 写后验证新增 `expectedGroup` 与组一致性差异项；
- 外部源生成块时，若目标是非根组，改用 `GenerateBlocksFromSource(PlcBlockUserGroup, GenerateBlockOption)` 重载。

**同时发现并记录的另一条 TIA 约束**：**成功导入后立刻导出该块会被拒绝**（"refused all 1 block(s)"），
**编译（errors=0）之后同一导出成功**。因此"改 → 导入 → 重新导出对比"的顺序必须是
**导入 → 编译 → 重新导出**；插件本身不受影响（它的写后验证读的是块集合与属性，不是重新导出）。
往返脚本已按此排序。

**残留**：`Override` 跨组失败的确切规则来自实验（3 次失败 + 3 次成功对照），Siemens 手册未如此明说；
`docs/verification.md` §D 记录了原始输出以便复核。

---

## D16. 设备遍历必须覆盖"设备用户组"（真实项目暴露的第二个致命缺陷）

**背景（真实项目实测）**：`PEI_SinoARP_Master_V4.1.3` 打开成功，但报告 **PLC 软件 0 个**，
`ExportBlocks` 直接以 `plc_software_not_found` 失败。

**根因**：V17 的设备模型有三处来源，我的 `ListPlcSoftware()` 只看了第一处：

| 来源 | 含义 |
|---|---|
| `Project.Devices` | 扁平设备组合 |
| `Project.UngroupedDevicesGroup.Devices` | "未分组设备"系统组（`DeviceSystemGroup`） |
| `Project.DeviceGroups` → `DeviceUserGroup.Devices` / `.Groups` | **设备用户组**（可嵌套） |

**决定/修复**：三处全部遍历（用户组递归 `Devices` + 嵌套 `Groups`），PLC 以 `ReferenceEquals` 去重；
并把 `plc_software_not_found` 的错误升级为**诊断**：附上 `devices[]`
（name / group / deviceItemCount / hasSoftwareContainer / softwareType）与 `deviceGroups[]`，
因为"项目里只有 HMI 设备"是完全正当的输入，调用方需要看到项目里到底有什么。

**实测效果**：同一项目从"PLC 0 个、导出失败"变成"PLC 1 个（`Sino_PEI`）、**1151/1152 个块导出成功**
（1 个 Safety F 块被 TIA 拒绝，逐块报告）、70.6 MB、22 个用户组目录层级完整"。

**教训**：`project.Devices` 不是"所有设备"。这类缺陷只有在"设备被分组"的真实项目上才会暴露——
另一个 237 块项目因为 PLC 未分组而完全看不出来。

---

## D17. 用 `categories` 把能力扩到 PLC 类型与标签表，而不是新增工具

**背景**：插件原本只做程序块，而真实项目里还有 **210 个 PLC 类型（UDT）** 与 **7 张标签表**
（对照另一份导出树的统计）。用户要求补齐这两类。

**备选**：
1. 新增 `export_types` / `import_types` / `export_tag_tables` / `import_tag_tables` 四个工具；
2. 保留两个工具，加一个 `categories` 参数选择对象族。

**决定：方案 2。** 理由：这三类对象的操作语义**完全同构**——同样的 dry-run 默认、同样的
`overwrite`/`import_options`、同样的"用户组层级镜像"、同样的写后读回验证、同样的逐对象容错；
差别只在"遍历哪棵组树"和"调用哪个 Export/Import"。四个新工具会让模型在六个近义工具里选，
并把已经验证过的写入流程复制四份。

**代价**：工具名 `export_blocks` / `import_blocks` 变成历史命名（描述里明确写了它们覆盖三类对象）。
默认 `categories: ["blocks"]` 保证旧调用行为不变。

**目录约定**：块保持 `<out>/<组>/<名>.xml`（向后兼容已有导出），类型与标签表放
`<out>/types/...`、`<out>/tag_tables/...`，三类永不撞名。清单 `_tia-openness-manifest.json`
增加 `categories`、`counts{blocks,types,tagTables}`、每个对象的 `category`。

**导入侧不加参数也能用**：文件的对象族由 XML 元素自动判定（`SW.Blocks.*` / `SW.Types.*` /
`SW.Tags.PlcTagTable`），并把组路径解析到**该族自己的组树**（块组 / 类型组 / 标签表组是三棵独立的树）。
`categories` 只在需要收窄时使用。

**实测**：真实项目 `PEI_SinoARP_Master_V4.1.3` 上 `categories: ["types","tag_tables"]` 导出
**210 个类型 + 7 张标签表**，`failed=0`、`verificationFailed=0`，数量与另一份导出树**逐一吻合**；
类型保持了 `999_Bibliotheque/Fonctions Procede/Twin_RTD/...` 的组层级。

---

## D18. 更正：我把另一份导出树误称为 "TIA 版本控制接口（VCI）"

**事实**：`docs/EXPORT-COMPARISON.md`（原 `VCI-COMPARISON.md`）分析的那份导出树位于
`…\AutomationWorkbench\…\worktrees\master\devices\Sino_PEI\source`。我**没有依据**就把它标注为
"TIA 自带版本控制接口（VCI）"，并据此推断"VCI 不支持 Safety 块，是其能力边界"。

**更正**：用户指出该导出**不是** VCI 做的。已把文档与脚本改为中性表述（"另一份导出树"、
生成工具未知），并把"为什么那 54 个 Safety 块不在里面"标注为**未知**（可能是该工具的过滤/配置，
也可能是它的能力边界——**我没有证据判断**）。

**保留下来的事实**（与生成工具无关，均可复核）：两边的块集合为 1097 交集 / 54 仅我有 / 0 仅它有；
那 54 个全是 Safety F 语言块；抽样 10 个共有块逐字节比对，唯一差异是
`<DocumentInfo><Created>` 时间戳。

**教训**：**能观察到的事实**与**对工具的归因**必须分开写；归因需要证据。文件已重命名
（`compare-exports.ps1`、`EXPORT-COMPARISON.md`），旧的 `-Vci` 参数改为 `-Other`。

---

## D19. 测试用运行时包：改从 `app.asar` 按运行版本抽取（取代 D2 的来源）

**背景**：D2 的"已知局限"是测试链到 `~/.dsh/profiles/node_modules` 的副本
（`dsh-tools 0.1.5-rc.2`），而宿主实际跑 `0.2.0-rc.2`。`docs/ECOSYSTEM-COMPAT.md` §5.2
记下了该副本随后被 `npm install` 的缓存回收删空（`_npx` 缓存内容消失），于是 5 个测试文件
全部无法启动。

**决定**：新增 `scripts/asar-read.mjs`（最小 asar 读取器）与 `scripts/dsh-runtime-cache.mjs`
（闭包抽取）。`link:runtime` 现在**优先**从已安装 app 自己的 `resources/app.asar` 里，
按 `dependencies` **加** `peerDependencies` 计算闭包（32 个包 / 约 8 MB / 0.9 s），解包到
`<DSH_HOME>/plugin-runtime`，再把仓库的 `node_modules/@deepseek-ai/*` 链到那里。
`runtime.json` 记下宿主版本，版本变化时自动重抽。

**为什么必须走 peer**：harness 包之间普遍以 peer 互相声明，而且**加载期就 import** ——
`@deepseek-ai/dsh-tools` 一进 `lib/index.js` 就取 `@deepseek-ai/dsh-scope`。只跟
`dependencies` 会得到一个"看起来完整、第一次 import 就炸"的缓存（已实测踩到）。

**为什么不再用 `~/.dsh/profiles/*/node_modules`**：那是 0.1.5-rc.2（`cosmokit` 1.8.3，
宿主是 1.8.5）。用它等于**用错版本验收**。现在它只作为兜底候选，排在抽取缓存之后。

**顺带消除的风险**：链接现在指向 `~/.dsh/plugin-runtime`（我们自己拥有、且只含真实目录），
不再指向 DSH 安装目录里的包，所以 §5.1 那类"跟进 junction 的删除会毁掉目标"的事故无法再
经由 `node_modules/@deepseek-ai/*` 传导到 DSH 自身。`linkRuntime` 的 `--force` 也改为：
目标是 junction/symlink 时只 `unlink`，绝不递归下降。

**结果**：`pnpm test` 从"5 个文件全部无法启动"变为 **45 测试 / 44 通过 / 0 失败 / 1 跳过**，
且验的是宿主真实版本（当时 `0.2.0-rc.2`；宿主升级后同一个机制自动重抽，2026-10-19 实测宿主
`0.2.1-rc.2` 下为 77 项 / 76 通过 / 1 跳过）。

**与 `ECOSYSTEM-COMPAT` §5.2 建议 A+C 的关系**：实现的就是那条路线；唯一差别是没按
"整段 `@deepseek-ai` 作用域一起解包"，而是精确抽取闭包（32 包 vs 289 包），实测足够。

---

## D20. 给工程上下文插件暴露 `engineeringAccess` 服务（发行版 D12 的"缝 A"）

**背景**：工程上下文插件需要**指纹**才能做工程级变更检测（发行版 D6），而指纹只能
在工程打开时经 Openness 读到。工程上下文插件的边界又明确规定"不与工控软件对话"—— 所以它只能**要**，
不能自己做。发行版 [`docs/decisions.md`](../../../docs/decisions.md) **D12** 因此定下"缝 A"：
由本插件注册一个可选服务，工程上下文插件按名取用、缺席即降级。

**决定**：新增 [`src/access.ts`](../src/access.ts)，`apply` 里构造 `EngineeringAccess`
（cordis `Service` 子类，名字 `engineeringAccess`），暴露五个方法：

| 方法 | 对应控制器操作 | 说明 |
|---|---|---|
| `status()` | 无（只读 `controller_status` 的快照） | 报告"值不值得试"：可执行文件在不在、Openness 探没探过；**从不启动控制器** |
| `openProject(path, opts)` | `OpenProject` | 与 `open_project` 工具同参；`allowUpgrade` 默认 false（唯一不可逆的写） |
| `closeProject(opts)` | `CloseProject` | **`dryRun` 是必填参数**，见下 |
| `listObjects(query)` | `ListPlcObjects` | 把每族的 `{count,items,truncated}` 信封**摊平**成一行一对象；默认 `max_items=1000` |
| `exportObjects(query)` | `ExportBlocks` | 与 `export_blocks` 工具同参；只写文件，不动工程 |

**四条刻意的设计**：

1. **与工具走同一条代码路径**：每个方法都构造与对应工具**相同**的操作与参数，并复用
   `runOperation`。两个面（模型面 / 服务面）因此不可能在默认值或错误形状上互相漂移。
2. **失败语义沿用 D4**：操作级失败（TIA 拒绝、块不存在）返回 `ok:false` + 结构化 `error`；
   传输级失败（找不到 exe、超时、协议不匹配）**抛出** —— 由调用方决定怎么大声报告。
3. **`closeProject` 的 `dryRun` 必填**：工具的默认是 dry-run，而服务调用方是代码。
   让它显式写下意图，比替它在任一方向上默认更安全（写错要么什么都没干，要么丢掉未保存的改动）。
4. **`listObjects` 默认抬高 `max_items` 到 1000，并如实报告 `truncated`**：
   控制器的 `max_items` **只能截断、没有 offset**
   （`controller/OpennessHost.Plc.cs:152,166`：继续累加 `total` 但停止添加 items），
   所以"翻页取下一页"根本不存在。抬高上限 + 如实说"没取全"是唯一正确做法，
   调用方看到 `truncated` 就带更大的值重试。

**为什么不走别的缝**（发行版 D12 已论证，这里只记结论）：让工程上下文插件用 `ctx.tools.execute`
间接调工具，会受 A15（原子工具可能默认隐藏）影响，且解析是**按可见性**的；纯文件契约则把
"谁触发指纹"推回给模型编排。服务缝两者都不占。

**代价与边界**：本插件因此多了一个对外契约面 —— 改 `access.ts` 的方法签名/参数属于**跨包
破坏性变更**，要同时改该包的 `ARCHITECTURE.md` §5.3 与工程上下文插件的镜像声明。
服务**不新增任何 C# 能力**：五个方法全部落在已有的白名单操作上（`OPENNESS_OPERATIONS` 仍是 25 条、
工具仍是 26 个，`matrix:check` 因此不受影响）。

**验证**：[`test/08-access-service.test.mjs`](../test/08-access-service.test.mjs) 9 项 ——
`apply` 注册服务且卸载后消失、五个方法各自发出的操作与参数、families 摊平与 `truncated` 传播、
指纹的 `{id,value}` 与 `{id,error}` 两种形态、`closeProject` 缺 `dryRun` 抛 `TypeError`、
操作失败作为数据返回而传输失败抛出。另：`test/helpers/harness.mjs` 的替身 ctx 补上了
`fiber` / `reflect.provide` / `get`，否则真实 `Service` 无法在替身上构造（这是这次改动**修掉的
一个测试基建缺口**，不是放宽断言）。

---

## D21. 给工程上下文插件的三个方法：另存 / 重建源 / 读会话；`source/` 布局归本插件

**背景**：工程上下文插件的 `create_engineering_project` 要一口气完成"另存进 workspace → 全量导出源文件"，
而它按架构**不允许自己与 TIA Portal 对话**。所以这三个动作必须由本插件以**服务方法**提供。

**决定**：

| 方法 | 做什么 | 关键约束 |
|---|---|---|
| `saveProjectAs(directory)` | `SaveProject` + `save_as_dir` | SaveAs **只认目录**、项目名不可改（D20 已实测）；**回读** `savedAs` / `requestedSaveAsDir` / `projectPath`，调用方必须记录实际落点，而不是它请求的路径 |
| `readTiaSession()` | 报"控制器在不在 + TIA 开着哪个项目" | **从不启动控制器**（停着就回 `running:false`，一个操作都不发）；没有项目时 `project_not_open` 是**状态**不是异常，回 `projectOpen:false` + reason；有项目时读 `attributes`（name/path/isModified）+ `software`（device/software/blockCount） |
| `rebuildSource(sourceRoot, opts)` | 每 device 全量导出 + 逐条报告被拒对象 | **`sourceRoot` 以下的一切由本方法定死**（见下） |

**`source/` 以下的布局（本插件独占，代码即权威）**：

```
<sourceRoot>/<device>/blocks/<group>/<name>.xml
<sourceRoot>/<device>/types/<group>/<name>.xml
<sourceRoot>/<device>/tag_tables/<name>.xml
```

**为什么是两次 `ExportBlocks` 而不是一次**：控制器**没有 layout 选项**，而 TIA 把 blocks 写在
传入 `output_dir` 的**根**上（只有 `types/`、`tag_tables/` 各占子目录）。要让 blocks 也落在
`blocks/` 这一层，就得把它单独导出到 `<device>/blocks`。代价很小：第二次只导 types + tag_tables
（真实项目里 210 个类型 + 7 张表，远快于 1151 个块那次）。**好处是不用改 C#。**

> ⚠️ **本节被 [D24](#d24-三类各占一个目录rebuildsource-收敛成每-device-一次调用) 取代**：
> 后来选择改 C#（`BlockFolderName`），让 blocks 与另两类对称，于是每 device 只需**一次**调用、
> **一份** manifest。下面"两次调用 / 最多两份 manifest"的描述是 D21 当时的事实，保留作历史。

**连带事实（消费方必须知道）**：

- 每个 device 最多**两份** `_tia-openness-manifest.json`（blocks 那次一份、其余那次一份），
  *（D24 起：每 device 一份，含三个 family。）*
  各描述自己写出的文件。消费方**读 manifest / 读服务返回**，**不要自己拼路径** ——
  这是防"约定失效"的机制：路径是运行时返回的事实，不是两边各自维护的约定。
- 设备名做文件系统安全化，撞名追加 `~2`（与控制器对对象名的做法一致）。
- 被 TIA 拒绝的对象**逐条**进 `failures`（device / category / name / code / message），不静默丢。
- `skipped` 与 `verificationFailed` 是**调用级**数字，因此如实标在 device 上；
  **不**硬拆到每个 family（拆了就是编数字）。family 级只给可精确归属的 `exported` / `failed` / `manifest`。

**不注册成模型工具**：三个方法都只走服务（`engineeringAccess`），接口插件族的模型面仍是 **26 个工具**。
模型只调工程上下文插件的 `create_engineering_project`，由它按顺序调这三个 ——
这样"何时建项目、怎么建"是一次可审阅的编排，而不是让模型自己拼步骤。

**验证**：[`test/08-access-service.test.mjs`](../test/08-access-service.test.mjs) 新增 6 项：
`saveProjectAs` 的参数与回读、`readTiaSession` 的三态（停着**一个操作都不发** / 无项目 / 有项目）、
`rebuildSource` 的两次调用与三段路径、被拒对象归属到 family、目录安全化与撞名消解、
设备过滤与 `missingDevices`、以及无控制器 / 无项目时**拒绝导出**。

---

## D22. `dry_run` 收敛到 7 个工具（其余 14 个删除）

**决定**：`dry_run` 只保留在**预览本身带信息量**的工具上，其余一律删除：

| 保留（7） | 删除（14） |
|---|---|
| `open_project`、`import_blocks`、`close_project`、`delete_plc_objects`、`write_tags`、`set_block_attributes`、`protect_blocks` | `export_blocks`、`compile_plc`、`create_project`、`save_project`、`archive_project`、`project_languages`、`project_texts`、`update_project`、`portal_settings`、`create_plc_objects`、`generate_source`、`watch_and_force_tables`、`software_units`、`set_safety_settings` |

（`project_info`、`list_plc_objects`、`safety_status`、`safety_signatures`、`controller_status` 本来就没有。）

**判据（两条同时成立才留）**：

1. **预览必须算出调用方自己算不出来的东西** —— `preview = f(inputs, world)`，而且 `f` 需要
   "特权限"（遍历对象树、解析名字/路径、跨对象比对）。若 `preview ≈ inputs`（只回一个
   `wouldWrite: true`），那是仪式；
2. **风险落在写入本身**（多对象、批量、不可逆），而不是"具名对象写错名，真的调用会在写入前干净失败"。

**理由（带实测数字）**：

- **代价**：`dry_run` 在工具面里占 **6,246 字符 ≈ 1,509 token**，即本插件工具块的 **12.3 %**
  （参数块 3,221 + 描述句 3,025），比那条 26 次重复的 `KNOWLEDGE_HINT`（2,834 字符）还大 2.2 倍。
  另外 14 个默认 `true` 的工具在正常路径上要求模型**调两次**，第二次把枚举/解析整跑一遍。
- **保留者为什么值**：`import_blocks` 的预览会逐文件解析、解析目标块名、给出
  `existsInProject` / `existingGroup` / `groupMismatch` / `action`（这条 `groupMismatch` 揭示的是
  "TIA 在**整个 PLC** 范围评估名字/编号冲突，住别处的块即使 Override 也覆盖不了"，别处看不到）；
  `delete_plc_objects` 给出解析后的 `planned` + 只数**存在**对象的 `wouldDelete`；
  `write_tags` / `set_block_attributes` 给出逐项 before/after；`protect_blocks` 给出当前
  `IsKnowHowProtected` 与 `protectionAvailable`；`close_project` 给出 `isModified`（会丢什么）；
  `open_project` 是唯一的**零 TIA 接触**预检（连 TIA Portal 都不启动）。
- **删除者为什么可以删**：它们要么只写一两个具名对象、真的调用会在写入前干净失败
  （`object_already_exists`、`group_not_found`、`language_not_found`、`setting_not_found`、`file_exists`），
  要么预览只是入参复述（`portal_settings` 的预览只有一个 `wouldWrite: true`；`save_project` 那份
  12 行 plan 的字段都能从 `project_info` + 入参推出）。`project_languages` 的预览虽然会解析语言名，
  但 `action=list` 这个**只读**分支本来就返回完整当前设置，且"写语言"是随时可改回的低风险操作。

**没有做（刻意）**：不加 plan hash / 两阶段提交。预览与提交之间**没有**凭据绑定，因此它仍是
"参考"而不是"契约"（这是它**固有**的局限，不是本次引入的）；要真做成契约需要
`expected_plan_hash` 一类的协议改动，那属于**增加复杂度**，在当前阶段（基本功能尚未在真实项目上
跑通）不做。若将来要做，`planned` 已经是 `JsonObject` 列表，`Hashing.Sha256OfFile` 也已在用。

**已知的静默行为（实测，必须记住）**：`defineTool` 编译出的参数 schema **不禁止多余属性**——
实测给 `export_blocks` / `compile_plc` 传一个已删除的 `dry_run`，校验结果是
`NONE (accepted and ignored)`，即**不报错、直接忽略**。后果：按旧文档/旧习惯传
`dry_run: true` 期待"预演"的调用，会**真的写入**。缓解办法（本次**未**实施，因为要加代码）：
在 `registerTools` 的共享 `register()` 里集中拒绝未声明的 `dry_run`（约 5 行），
把静默忽略变成一条自解释的错误。目前靠文档与模型读到的实时 schema 兜着。

**代价与例外（必须记住）**：

- `project_texts` 的 `action=import` **不包在事务里**（Openness 手册禁止事务内做 ProjectText 导入），
  所以它**无法回滚**；删掉 dry-run 后这一处没有确认步骤。若将来要补，正确机制是**用户审批**
  （DSH approval 门），而不是一个零信息量的预演。
- `set_safety_settings` 也是"一个布尔开关"型写入，删除的依据与 `portal_settings` 相同；
  它改的是 `SafetyModificationsPossible`，属于安全相关设置，但预览只是入参复述，删了不损失信息。
- **`project_languages` 的多项写入不是事务性的**：`SetProjectLanguages` 逐个
  `ActiveLanguages.Add/Remove`，`FindLanguage` 对未知 culture 抛 `invalid_params` /
  `language_not_found`，但它发生在**循环内部**，因此 `active_languages: ["de-DE","xx-XX"]`
  可能"改了一半才失败"。**这不是本次引入的**（写路径一直如此，直接传 `dry_run: false` 的调用者
  早就能撞上），但过去 `dry_run` 默认 `true`，预演会**先**把整列名字解析一遍，使默认路径是
  全有或全无。删掉 `dry_run` 后这条暴露面变成首次调用即可达。它没到"必须现在修"的程度
  （项目语言随时可改回，且 `data.added` / `data.removed` 如实报告已经改了什么），
  真要修，正确做法是**在写入前预解析整列**或把这段放进事务，而**不是**恢复一个入参复述式的预演。

**改动面**（本次一起改完，缺一处 `npm run check` 就会失败）：

- `src/tools.ts`：14 个工具的 `dry_run` 参数与参数搬运删除、描述改写；8 处因删除而变成死代码的
  渲染分支（export/compile/create/save/archive×2/createPlcObjects/generateSource）删除。
- `controller/Operations*.cs`：18 个 dry 分支 + 14 处 `p.Bool("dry_run", …)` 删除；
  `Add("dryRun", dryRun)` → `false`；`OperationsProject.cs` 的 `PortalSettings` 里
  `else if` 因为 `if (dryRun)` 被删而必须改回 `if`，`AccessPortalSetting(..., !dryRun)` → `true`。
- `src/access.ts`：`ExportObjectsQuery.dryRun`、`SaveProjectAsOptions.dryRun`、
  `RebuildSourceOptions.dryRun` 删除（它们映射的正是被删的三个操作，留着就是**说谎的选项**）。
- 测试：`01-load`、`04-tools`、`08-access-service` 中编码旧默认值的断言改为新策略；
  `04-tools` 新增"只有预览带信息量的工具保留 dry-run"一项，双向断言 14 个不发 `dry_run`、4 个默认 `true`。
- 文档：README §4 表格与 §4.2、`docs/EXTENDED-SURFACE.md`、`docs/PROTOCOL.md`、
  `docs/VERIFICATION-PLAN.md`、`docs/FUNCTIONAL-TEST.md`；覆盖矩阵用 `npm run matrix:build` 重建
  （`src/tools.ts` 的参数面变了，代码指纹随之变）。
- **D5 不修改**：它记录的是当时的划分（历史），其表已被本条取代。

**验证**：`npm test` = 77 项（76 通过 / 1 跳过 / 0 失败）；`npm run build` 与 C# `dotnet build`
（0 warning / 0 error）+ `--self-test` 全绿；`npm run matrix:check`、`npm run skills:check` 通过。

**回退**：`git checkout -- packages/dsh-tia-openness-v17-min`（本条与代码同一提交，无跨提交依赖）。

---

## D23. `rebuildSource` 的已知缺口（2026-10 复盘；🟡 待修，行号按 D22 之后的工作树）

**背景**：工程上下文插件上线了它的第一个工具 `create_engineering_project`（该包 **D22**），
它按顺序调 `readTiaSession` / `saveProjectAs` / `rebuildSource` —— 也就是说 `rebuildSource` 第一次有了
真实调用方。逐个核对 C# 之后的结论：happy path 是完整的（每 device 两次 `ExportBlocks`、三段布局、
每 device 最多两份 manifest、逐条 `failures`、`missingDevices`、按设备过滤），但有五处不完整，
其中第 1、2 条会产出**看起来正常的错答案**。

| # | 缺口 | 证据（当前工作树行号） | 后果 | 状态 |
|---|---|---|---|---|
| 1 | `exported == 0 && plan.Count > 0` 不区分"全被跳过"与"全被拒绝" | [`controller/Operations.cs:346-353`](../controller/Operations.cs#L346-L353)（跳过见 `:273-279`） | 对**已建好**的树重跑（`overwrite=false`）返回 `export_failed`，消息却写着 "Openness refused all N object(s)"，真实原因是"文件都已在"；文件和 manifest 其实都写好了（manifest 在抛错**之前**的 `:335-341` 写出） | 🟡 消费方已兜住（工程上下文插件把它读成"什么都没写"并提示 `overwrite=true`）；**根因待修**：条件应为 `exported == 0 && skipped == 0 && plan.Count > 0` |
| 2 | **Software Units 不被遍历** | `CollectBlocks` 只从 `software.BlockGroup` 递归（[`OpennessHost.cs:572-576`](../controller/OpennessHost.cs#L572-L576)、`:610`）；单元是另一棵树 `PlcUnit.BlockGroup`（[`OpennessHost.Plc.cs:1250`](../controller/OpennessHost.Plc.cs#L1250)）；`CollectTypes` / `CollectTagTables` 同理 | 用了软件单元的工程，源文件树**整整少一批对象而没有任何提示**（不报错、不 warning）—— 五条里唯一的**静默**错误 | ⬜ 待修（优先级最高） |
| 3 | **从不清理陈旧文件** | 导出路径里没有任何 `Delete`（全仓只有 [`SelfTest.cs:55`](../controller/SelfTest.cs#L55) 删临时目录） | 在 TIA 里删掉的块，XML 永远留在磁盘；`overwrite=true` 也只替换同名文件 → 树是**增量堆积**而非快照，P2 的变更检测与图谱 ingest 会把"已删除"看成"还在" | ⬜ 待修（导到临时目录再整体换 / 按 manifest 的文件列表 prune） |
| 4 | 一个文件读不回来 → **整次调用**失败 | [`Operations.cs:365-371`](../controller/Operations.cs#L365-L371)（`verificationFailures > 0` 即抛） | 文件全写完了，只要有一个读不回来（被其它进程锁住等），这个 device 的调用就是失败 | ⬜ 待定（也可能就是刻意的严格） |
| 5 | 空集合被当成错误 | [`Operations.cs:243-249`](../controller/Operations.cs#L243-L249) | "这台设备没有块"或"没有类型也没有标签表"是**正常状态**，却报 `object_not_found`，还会中断后面的 device（本方法第一次失败就 return，见 `src/access.ts` 的两处 early return） | ⬜ 待定 |

**另一条报告口径问题**（消费方已自行修正，提供方也值得改）：
`counts[family]` 是 `CountByCategory(plan)`（[`Operations.cs:251`](../controller/Operations.cs#L251)，在写入**之前**算的），
**包含被跳过的对象**；而 `src/access.ts` 的 `RebuiltFamily.exported` 注释写的是 "Objects TIA wrote for this family"，
并不准确。真正写成功的数字是调用级的 `summary.exported`（`:326`），而它在**成功路径上没有**被服务暴露出来
（失败路径反而有，因为失败帧带着部分 `data`，见 `controller/Program.cs:545-550`）。
工程上下文插件因此自己算 `written = planned - skipped - refused`，并在失败帧里优先采信 `summary.exported`
（该包 `src/access.ts` 的 `RebuildTotals`）。

**与 D22 的接口**：`rebuildSource` 现在**没有** `dryRun` 了（随 D22 一起删）—— 重建一定写盘。
这不影响消费方：它的"只给计划"由 `readTiaSession` 单独算得出来，从不依赖控制器的 dry run。

**落地的机器约束**：动 `controller/*.cs` 必须重跑 `npm run matrix:build` 并让 `matrix:check` 通过
（本包 AGENTS.md §1），且 `npm run build:controller` 需要本机 TIA Portal V17 + NuGet 源 ——
所以这几条要留到**真机那一轮**一起做；现在改等于改一份编不了、也验不了的代码。

> 第 1、5 条与 D24 有交互：D24 把每 device 的导出从两次并成一次，于是"计划为空"的机会从两次
> 降到一次（只有整台设备三类全空才触发）；第 1 条（"全被跳过"被报成 `export_failed`）仍在。

---

## D24. 三类各占一个目录，`rebuildSource` 收敛成每 device 一次调用

**背景**：D21 的布局是 `<device>/blocks/…` + `<device>/types/…` + `<device>/tag_tables/…`，
但控制器只把 blocks 写到传入 `output_dir` 的**根**，types / tag_tables 各进子目录 ——
所以"blocks 也落在 `blocks/` 下"是靠**两次导出**换来的：第一次 `output_dir=<device>/blocks`（只导 blocks），
第二次 `output_dir=<device>`（导 types + tag_tables）。代价是每 device 两次 TIA 往返、两份 manifest、
两次超时暴露，而且**块组恰好叫 `types` / `tag_tables` 时会与另外两类挤进同一个目录**。

**决定**：让 blocks 与另两类**对称** —— 新增 `BlockFolderName = "blocks"`，
`BuildBlockExportPlan(blocks, Path.Combine(outputDir, BlockFolderName), …)`。
于是**一次调用**（`output_dir = <device>`、`categories: ['blocks','types','tag_tables']`）就得到：

```
<sourceRoot>/<device>/blocks/<group>/<name>.xml
<sourceRoot>/<device>/types/<group>/<name>.xml
<sourceRoot>/<device>/tag_tables/<name>.xml
<sourceRoot>/<device>/_tia-openness-manifest.json      ← 一份，counts 含三个 family
```

**代价（破坏性）**：`export_blocks` 的**输出布局变了** —— 以前 blocks 落在调用方给的那个目录的根下，
现在落 `blocks/` 子目录。任何"根目录下就是 blocks"的调用方/脚本都要跟着改
（[`OUTPUT-CONTRACT.md`](OUTPUT-CONTRACT.md) §2 已改，并标明该节的真实例子是 D24 之前测的）。

**收益**：① 三类的命名空间分开，组名撞目录的隐患消失；② 每 device 一次往返 ⇒ 超时暴露减半
（对默认 5 分钟的 `requestTimeoutMs` 是实质差别）；③ D23 第 5 条（计划为空即抛错）的机会从两次降到一次；
④ 每 device 一份覆盖三类的 manifest ⇒ 消费方不再需要自己合并，工程上下文插件因此**取消**了
原计划的"工具侧合并清单"。

**验证**：`test/08-access-service.test.mjs` 改成单次调用断言（`categories`、`output_dir`、
三个 family 报同一份 manifest、设备过滤后仍是一次调用）；`npm test` 77 项（76 通过 / 1 跳过）；
`npm run build:controller` 成功且 `--self-test` 全绿（本机 TIA Portal V17 的 PublicAPI 解析正常、
Openness 用户组 `isMember: true`）；`npm run matrix:build` + `matrix:check` 通过。

**未验证**：真机上的一次调用导出（需要 TIA Portal 里打开一个真实项目）。**注意**：
`controller/bin/*.exe` 是随包出货的交付物，已按本条重新构建 —— 源码与二进制必须一起提交。
