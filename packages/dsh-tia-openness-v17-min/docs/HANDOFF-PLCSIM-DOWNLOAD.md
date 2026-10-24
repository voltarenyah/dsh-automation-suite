# HANDOFF — PLCSIM Advanced 下载：现状、证据与下一步

> **状态（2026-10-24 定稿）：工作流已跑通。** V17 控制器 + PLCSIM Advanced V7
> （TCP/IP）+ TIA V17 工程，全链路实测通过（见 §0、§9）；V20 侧另有两次连续成功（§8）。
> 本文先给现行工作流与分工，再保留历史证据。

## 0. 现行工作流（定稿）

### 0.1 一句话触发与步骤

用户在 suite 里说「**启动仿真环境并把 PLC 下载到虚拟 PLC**」时，按下面顺序串：

| # | 执行方 | 动作 | 成败判据 |
|---|---|---|---|
| 1 | TIA 插件 | `online_targets`：读工程里目标 PLC 的**离线 IP / 子网**，以及本机可用 PC 接口（含 PLCSIM 虚拟网卡） | 目标 PLC 有子网 + 唯一 IP；否则先补工程（见 0.2） |
| 2 | PLCSIM 插件 | 创建并启动实例，**IP 用第 1 步读到的地址**，**实例名 = CPU 的 PROFINET 设备名**，**默认带 UI 窗口** | 返回 `state=RUN/STOP`、IP、通信方式、许可证 |
| 3 | TIA 插件 | `adopt_open_project`：接管 UI 里已打开的工程（工程必须先在 TIA UI 打开） | `adopted=true` |
| 4 | TIA 插件 | `online_disconnect(force=true)`：清掉 UI 残留在线的状态 | `state=Offline` |
| 5 | 人工（仅首次） | TIA 弹出「PLC_1 证书不可信」→ 点 **Connect** | 之后同一会话不再弹 |
| 6 | TIA 插件 | `compile_plc`（可选，下载本身会编译）→ `download(dry_run=true)` 核对目标 → `download(confirm=true, options=software)` | `state=Success`、`errorCount=0` |
| 7 | TIA 插件 | `online_connect` → `online_status` → `online_disconnect`（可选，用于确认可上线/取终态） | `Online` → `Offline` |
| 8 | PLCSIM 插件 | 保持实例运行；可选：读标签做业务验证（如 `Btn_ForwardCommand`） | 实例 `RUN`、标签可读 |
| 9 | PLCSIM 插件 | 首次成功后 `snapshot`；**下一次直接 `resume`**，不再走 2–7 | `resume` 返回 `state=RUN`、标签可读（§11） |

**谁编排**：由 suite 里的 agent（leader）按上表调用两个插件的工具。**两个插件互不调用**，
唯一共享的是「目标坐标」：`mode=PN/IE`、`pc_interface`（TCP/IP 用
`Siemens PLCSIM Virtual Ethernet Adapter`，Softbus 用 `PLCSIM`）、`target_interface=1 X1`、
`address=实例/工程 IP`。

### 0.2 人工介入次数

- **项目级一次性**：给要下载的 PLC **分配子网 + 唯一 IP**（实测：不配则连 TIA UI 都下不了）。
- **设备级一次性**：首次连接时在 TIA UI 接受自签名证书（Openness 无该委托，headless 必败）。
- **每次下载**：不需要人工；`download(confirm=true)` 是 agent 参数，只有**真实 PLC** 才额外要
  `confirm_real_device=true`（防止误下到产线）。

所以虚拟 PLC 的常态是 **2 次人工**（都只发生一次：配子网、接受证书）；项目已具备时是 **0 次**。

### 0.3 终态

- **PLCSIM 实例**：`RUN`，程序已加载（下载日志逐块 `loaded successfully`），IP 与工程一致，UI 可见。
- **TIA Portal**：工程仍由 UI 打开（接管后控制器退出**不**关它）；无在线会话（`online_status`
  返回 `connected=false`），除非显式保持在线。
- **控制器**：无残留在线会话；下载结果 `state=Success`、`errorCount=0`；`data.messages` 与
  `data.configurations` 可回溯。
- **业务验证**：实例标签可读（PLCSIM 侧工具），可确认程序真的在跑。

## 1. 你已经完成什么（来自你的会话记录）


- `Download`（S2）：`online_connect` 会话前置、dry-run/confirm/`confirm_real_device` 三档闸门、
  回调安全策略、`DownloadResult` 消息树、`configurations`、下载后会话清理。
- 32 个操作 / 31 个工具；103 项测试（102 通过 / 1 跳过）；`matrix:check` 通过。
- 你自己的结论：**回调策略“没有任何设备实际跑过”**，矩阵记为“部分（已接线未实测）”。
- 你没有处理 `TargetForSoftware`（V17 包本身也没有这个 API）。

## 2. 这次真实设备验证发现了什么

### 2.1 环境与对象

- TIA Portal V17 与 V20 同机安装；PLCSIM Advanced **V7.0**；Softbus。
- 测试工程：`TestPLCExportDemo`（2 个 S7-1500 PLC，CPU **1511-1 PN**，
  `6ES7 511-1AK02-0AB0/V2.9`）。工程副本已升级为 V20：
  `%TEMP%\tia-v20-spike\project\TestPLCExportDemo_V20\TestPLCExportDemo_V20.ap20`。
- 实例：API 创建，Softbus，CPU1511，名字 `PLC_1`，`LicenseStatus=OK`，状态 STOP/RUN。

### 2.2 关键 API 事实

- V17 与 V18 的 `Siemens.Engineering.dll` **不含** `TargetForSoftware` /
  `PlcSimulationAdvanced`；V19/V20 的 PublicAPI **含**。
- V20 临时控制器（`%TEMP%\tia-v20-spike\controller`）由 V17 控制器复制，只改
  `TiaPortalMajorVersion=20`、NuGet `20.0.1744190253`，并补了：
  ```csharp
  TargetForSoftware target = configuration as TargetForSoftware;
  if (target != null)
  {
      target.CurrentSelection = TargetForSoftwareSelections.PlcSimulationAdvanced;
      return;
  }
  ```
  编译 **0 warning / 0 error**；V20 工程升级成功。

### 2.3 失败签名

在 V20 控制器、V20 工程、CPU1511 实例、实例名 `PLC_1` 下：

```jsonc
// dry-run：目标解析成功
{ "targetSource": "download_property", "pcInterface": "PLCSIM",
  "targetInterface": "1 X1", "targetAddress": "192.168.0.1", "ok": true }

// 实际下载
{ "ok": false, "error": {
  "code": "download_failed",
  "message": "... 'Connect to module PLC_1 failed.'",
  "details": { "configurations": [], "kind": "virtual" } } }
```

- `DownloadProvider.Configuration` 实测只有：
  `PN/IE → PLCSIM → targetInterfaces: ["1 X1"]`，`addresses: []`，`subnetAddresses: []`。
- **下载回调一次都没有触发**（`configurations` 为空）——失败发生在连接阶段，不是回调策略。
- 已试过：CPU1516/CPU1511、实例名 `DshE2E_*`/`PLC_1`、`target_address=192.168.0.1`，
  结果相同。
- `online_connect` 到全新实例同样在 `GoOnline` 失败（`state=Offline`）。

### 2.4 对照：人工 UI 下载成功

同一实例/工程，用 **TIA V20 UI** 手动 Download 软件+硬件：

- 实例进入 **RUN**；
- `UpdateTagList` 得到 **51 个标签**；
- `Btn_ForwardCommand` 读 `False` → 写 `True` → 读回 `True`；
- 3 s 后 `CylinderIsMovingForward` 变为 `True`，写回 `False` 后回到 `False`；
- 结束后 `PowerOff` + `Unregister` + `Shutdown`，无残留。

**所以实例、工程、CPU 类型、Softbus 都是对的；失败点是 Openness 的下载目标/连接选择，不是实例本身。**

## 3. 当前工作树里已有的改动（不要回退）

另一个会话在 `OperationsOnline.cs` / `src/tools.ts` / `PROTOCOL.md` / 测试里做了 Phase 0：

- `Download` 不再强制 `_onlineSession`；
- 新增参数 `pc_interface` / `pc_interface_number` / `target_interface` / `address` /
  `target_address`；
- 无会话时从 `DownloadProvider.Configuration` 解析目标并 `ApplyConfiguration`；
- 有 `target_address` 时调用 V17 的
  `Download(IConfiguration, ConfigurationAddress, …)` 重载。

先 `git show` / `git diff` 看当前提交与文件；不要 `git checkout` 这些文件。  
**注意**：基线提交里也包含你之前的 v0.2 工作（它原本未提交）；这是为了给交接一个可回退点。

## 4. 建议优先验证的假设（按顺序）

1. **首次下载 vs 任何下载**：先用 UI 下载一次，让实例变成“已组态”；
   再用 Openness 对同一实例做第二次下载。若第二次成功，问题只是“首次下载不支持 Openness”。
2. **单 PLC 工程**：当前工程两个 PLC 的离线 IP 都是 `192.168.0.1`，可能造成目标歧义；
   复制一份、删除 `station_2`，只留 `PLC_1` 再试。
3. **在线会话**：用 `online_connect(expect_kind=virtual)` 先连上（若实例已被 UI 下载/组态，
   `GoOnline` 可能成功），再 `Download` 走原来的 session 路径。
4. **目标选择**：确认 `TargetForSoftware` 是否只能在某个连接建立后出现；检查
   `DownloadProvider.Configuration` 是否有未暴露的实例选择属性/属性键。
5. **V20 是否必须**：V17 已证实没有 API；如果 V20 也走不通，明确记录“Openness 无法 target
   PLCSIM Advanced”，不要再猜。

## 5. 复现资产与命令

- V20 临时控制器（未进仓库）：
  `%TEMP%\tia-v20-spike\controller\bin\TiaOpennessV20Spike.Controller.exe`
- 升级后的 V20 工程：
  `%TEMP%\tia-v20-spike\project\TestPLCExportDemo_V20\TestPLCExportDemo_V20.ap20`
- V20 E2E 脚本（临时）：
  `%TEMP%\tia-v20-spike\v20-e2e.mjs`
  - 它会 attach 到已运行的 V20 TIA；若没有，会新启动 V20 **并需要人工点安全确认**。
- PLCSIM keeper / 日志（临时）：
  `%TEMP%\plcsim-spike\Keeper.exe`、`%TEMP%\plcsim-keeper.log`
- 关键文档：`docs/simulation-plcsim-advanced.md` §10.7/§10.8（只读，不要改）。

## 6. 完成标准

- 能对 API 创建的 Softbus 实例 `PLC_1`（CPU1511）完成 Openness 下载并 RUN；或
- 有可复现实验证明 Openness（V17/V20）无法 target PLCSIM Advanced，并把结论写进
  `PROTOCOL.md`、覆盖矩阵和 README，不再把它标为“待实测”。
- 不要修改 `packages/dsh-plcsim-advanced`；运行侧已经 E2E 通过，归另一个会话。
- 编辑 TIA 包前先 `claim_files`，完成后 `release_files`，避免与另一个会话撞车。

## 7. 本轮结果（2026-10-24 晚，接手会话）

**结论：握手没过去。** 本机 Openness 对 PLCSIM Advanced V7 实例既不能 GoOnline
也不能下载，但 TIA UI 能下载同一实例。复现脚本与日志都在 `%TEMP%`。

新增证据：

- **工程侧事实**：两个 CPU 的 X1 节点都是 `192.168.0.1/255.255.255.0`，
  **没有分配到任何子网**（`OnlineTargets` 的 `subnets` 为空，两个节点落在
  `unmatchedNodes`）；PN 设备名是 `plc_1.profinet interface_1` /
  `plc_2.profinet interface_1`。
- **实例命名对齐**（Softbus，实例名 `plc_1.profinet interface_1`）后仍失败：
  GoOnline 0.5 s 内 `Changing to online mode failed`；不先连、直接 Download
  仍在 connect 阶段 `Connect to module PLC_1 failed`，回调 `configurations: []`。
- **TCP/IP 模式**（虚拟网卡 `192.168.1.240/24`，实例 `192.168.1.1/24`，接口
  `Siemens PLCSIM Virtual Ethernet Adapter` 在 Openness 里可见）同样失败：
  GoOnline 10 s 后 `Changing to online mode failed`。
- **半在线状态**：失败的 GoOnline 会让 TIA 认为仍在线，随后 Download 的
  `ApplyConfiguration` 报 `The operation is not permitted in online mode`。
  已在控制器修复：连接失败时补 `GoOffline`；Download 把该异常映射为
  `online_mode_conflict`（新错误码，已写入 PROTOCOL）。

仍未排除的假设：**工程没给 CPU 分配子网**。若继续 V20 路线，应先建
「单 PLC + 已分配子网（PN/IE_1）」的工程再试；若那也失败，即可按 §6 判定
“Openness 无法 target PLCSIM Advanced”，不必再猜。

## 8. 后续突破（2026-10-24 晚，同一会话）

**根因找到：首次连接要先在 TIA UI 里接受 PLC 的自签名证书。**

- UI 弹窗：`Establish connection to device — "PLC_1" might not be a trustworthy device.
  The device uses an unknown, self-signed certificate.` → Connect / Abort。
- Openness **没有**回答这个弹窗的委托：`TlsVerificationConfiguration` 只挂在
  `FingerprintDataProvider.GetFingerprintData` 上，`DownloadCertificate` 也没有
  可写的选择属性。所以**自开工程**的控制器（headless 或同一 UI 进程里 `OpenProject`）
  一律在 connect 阶段失败：`Connect to module … failed`，`configurations: []`。
- 用户点过一次 Connect 之后，**adopt UI 已打开的工程**再下载即可成功：
  连续两次 `state=Success`、0 error、逐块 `loaded successfully`（V20 +
  PLCSIM Advanced V7 + TCP/IP + 单 PLC + `PN/IE_1` + CPU/实例同 IP `192.168.1.50`）。

**因此工作流定为：**

1. 人工在 TIA UI 打开工程，首次连接/下载并接受证书（每个新设备/新工程一次）；
2. 控制器 `adopt_open_project` 接管这个 UI 会话（接管后退出**不**关闭工程）；
3. `online_disconnect` → `download`（dry_run 默认，confirm 才真下）→ `online_status`。

代码：`AdoptOpenProject`（33 操作 / 32 工具），协议见 `docs/PROTOCOL.md`
的 `AdoptOpenProject` 与 “Certificate precondition”，矩阵 download 条已按此改写。
V17 控制器走同一路径，但**尚未实测**（成功数据来自 V20 spike）。

## 9. V17 端到端验证（2026-10-24 20:03）

用仓库里的 **V17 控制器**（不是 V20 spike）对用户已打开的 V17 工程
（`C:\Users\Ansel\Documents\Automation\V17\AgentAssistProgramming\TestPLCExportDemo\TestPLCExportDemo.ap17`）
跑通：

| 步骤 | 结果 |
|---|---|
| `AdoptOpenProject` | 1.2 s，2 个 PLC（station_1 / station_2） |
| `OnlineDisconnect force=true` | `Offline`（清掉 UI 的在线态） |
| `Download` dry_run | `targetSource=download_property`，`Siemens PLCSIM Virtual Ethernet Adapter → 1 X1` |
| `Download` software | **`state=Success`，0 error，逐块 loaded** |
| `OnlineConnect` | 4.4 s → `Online`，`OnlineStatus` 读回 `Online`，断开回 `Offline` |

两个操作前置条件（缺一不可）：

1. **工程里给要下载的 PLC 配置子网和唯一 IP** —— 用户实测，连 TIA UI 下载都要求；
2. **首次连接要在 UI 接受自签名证书**；之后 adopt UI 打开的工程，Openness 才连得上。

V17 特有坑：attach 运行中的 TIA 会走 Openness 防火墙/白名单。控制器 exe 重建后
哈希变化，**第一次 attach 可能卡住几分钟后超时**（`EngineeringSecurityException:
Security error. The operation has timed out.`），重试即通过。矩阵里
`Establishing or disconnecting…`、`Determining the status…`、`Assigning PC interface`
已从「部分」改为「已适配」；download 仍是「部分」（只验了软件下载，硬件/真实 PLC 未验）。

## 10. 分工与衔接（按现行工作流）

### 10.1 TIA 插件侧（本包 `dsh-tia-openness-v17-min`）负责

| 能力 | 工具 / 操作 | 状态 |
|---|---|---|
| 读工程侧目标（离线 IP / 子网 / 可用的 PC 接口与 slot） | `online_targets` / `OnlineTargets` | ✅ 已适配（P） |
| 接管 UI 已打开的工程（证书信任的会话） | `adopt_open_project` / `AdoptOpenProject` | ✅ 已适配（P） |
| 清掉 UI 留在线状态 | `online_disconnect(force=true)` | ✅ 已适配（P） |
| 上线 / 状态 / 下线 | `online_connect` / `online_status` / `online_disconnect` | ✅ 已适配（P，PLCSIM 实测） |
| 编译 | `compile_plc` | ✅ |
| 软件下载（含 dry-run、confirm、回调、结果树） | `download` / `Download` | ✅ 软件已验证；硬件/真实 PLC 未验（矩阵“部分”） |
| 上传 / 在线比较 | `upload` / `compare_online` | ⬜ 未实现（S3） |

**不负责**：实例的创建/启停/标签读写；不依赖 PLCSIM 插件是否安装。

### 10.2 PLCSIM 插件侧（`packages/dsh-plcsim-advanced`，另一会话）负责

- 实例生命周期：register / power on / run / stop / power off / unregister；
- **实例默认带 UI 窗口运行**（用户要求）：能看到实例名、IP、通信方式（Softbus/TCP/IP）、
  `RUN/STOP`、许可证状态；API 创建的实例也应出现在 Control Panel 列表里；
- 提供坐标查询：`name`、`communication`、`ip`、`state`，供 agent 填给 TIA 侧；
- 可选的业务验证：标签读写（例如 `Btn_ForwardCommand` / `CylinderIsMovingForward`）；
- 结束时不自动关实例；首次成功后负责 `snapshot`，后续负责 `resume`（§11）；
- 结束时**保持实例运行**（除非用户明确要求关掉）。

### 10.3 两侧的衔接契约

1. **顺序**：先 `online_targets`（TIA 侧读工程 IP），再建实例（PLCSIM 侧用同一 IP）。
2. **实例名**：用 CPU 的 PROFINET 设备名（如 `plc_1.profinet interface_1`）；TCP/IP 下不是硬性要求，
   但作为约定便于对照。
3. **接口按 TIA 版本选**（2026-10-24 实测）：
   - **V17：只有 TCP/IP**（`Siemens PLCSIM Virtual Ethernet Adapter`）——Softbus 接口在 Openness 里根本不出现；
   - **V20：TCP/IP 与 Softbus（`PLCSIM`）都在**，两条都通，Softbus 下载实测 `state=Success`、0 error。
   两侧不需要共享这个字符串：agent 以 TIA 侧 `online_targets` 枚举出来的值为准。
4. **失败沟通**：TIA 侧的错误码是稳定契约（`download_unavailable` / `online_session_required` /
   `download_failed` / `online_mode_conflict` …），PLCSIM 侧只需报告实例状态；agent 据此判断是
   “实例没起”还是“证书没接受/工程没子网”。

### 10.4 已知坑（都会在日志里留下可识别的签名）

| 现象 | 根因 | 处理 |
|---|---|---|
| `Connect to module … failed` + `configurations: []` | 首次连接未接受自签名证书（Openness 无该委托） | 在 TIA UI 打开工程并点一次 Connect，然后 `adopt_open_project` |
| 同上，且工程/实例 IP 不一致或未分配子网 | 工程没给 PLC 配子网（连 UI 也下不了） | 工程侧补子网 + 唯一 IP，重启实例对齐 |
| `EngineeringSecurityException: Security error. The operation has timed out.` | V17 Openness 白名单里没有当前 exe 的哈希（重建后哈希变了） | 首次 attach 重试一次；仍失败则管理员更新 `HKLM\…\Openness\17.0\Whitelist` |
| `online_mode_conflict` | TIA 还被 UI 占在线 | 先 `online_disconnect(force=true)` |
| 实例不可 ping / 状态 `Off` | 实例没启动或已 PowerOff | PLCSIM 侧重启实例后重试第 2–4 步 |

## 11. 非初次仿真：快速复用上次实例（2026-10-24 定稿）

**目标**：第一次仿真需要 TIA 下载 + 证书/子网前置；**后续仿真不要再走 TIA 下载**，直接从上次成功实例的存档启动。

### 11.1 流程

首次（§0.1 第 1–8 步）成功后：

```jsonc
simulation_instance({ "action": "snapshot", "name": "PLC_1", "snapshot": "cylinder-baseline" })
```

后续每次：

```jsonc
simulation_instance({ "action": "resume", "name": "PLC_1", "snapshot": "cylinder-baseline", "run": true })
```

`resume` 的三条路径（按优先级）：

1. 实例仍在 Runtime Manager 里 → `CreateInterface(name)` 直接 attach，必要时上电/RUN；
2. 实例不在了 → 复制 snapshot 的 `storage/` 目录到新实例，注册、上电、按 manifest 恢复 CPU/通信/IP，可选 RUN；
3. 旧 snapshot 没有 `storage/` → 回退 `RetrieveStorage(instance.zip)`。

**不再调用 TIA 的 `online_targets` / `adopt` / `download`**；TIA 只在首次仿真时参与。

### 11.2 存档内容

默认 `<workspace>/.dsh/simulation/<snapshot>/`：

```text
instance.zip      # ArchiveStorage(): 程序 + 硬件配置 + retentive 数据
storage/          # Virtual SIMATIC Memory Card 的目录副本（快速 resume 用）
manifest.json     # name / cpuType / communication / ip / subnetMask / gateway / createdAt / hasStorage
```

- `snapshot` 使用官方 `ArchiveStorage`；实例必须 **OFF** 且至少 `PowerOn` 过一次；
- 如果 snapshot 时实例在 RUN，插件会短暂断电、归档、恢复原状态（RUN 会恢复）；
- 快照与创建它的 PLCSIM Advanced 大版本绑定，跨大版本不要直接复用；
- `.dsh/simulation/` 已加入 `.gitignore`，是本地运行产物，不是工程源文件。

### 11.3 Softbus / TCP/IP 选择（定稿）

- **V17**：Openness 只枚举 TCP/IP（`Siemens PLCSIM Virtual Ethernet Adapter`）；Softbus 接口不出现。V17 首次下载必须用 `communication="tcpip"` + 工程 IP。
- **V20**：TCP/IP 与 Softbus（`PLCSIM`）都可用，Softbus 下载实测 `state=Success`、0 error。
- `resume` 用 snapshot 里记录的 `communication`；不要求重新读 TIA。若换网络模式，显式传 `communication`/`ip` 覆盖。

### 11.4 工具面

| 工具 action | 用途 |
|---|---|
| `simulation_instance(snapshot)` | 首次成功后保存 |
| `simulation_instance(resume)` | **后续默认入口**：attach 或快速恢复并启动 |
| `simulation_instance(restore)` | 显式从某个 snapshot 新建；`fast=false` 强制走 ZIP |
| `simulation_tags` | 恢复后做业务验证 |

**边界**：snapshot/resume 只保存运行实例，不替代 TIA 工程源文件与 git 版本管理；许可证仍按 PLCSIM 许可执行。

## 11. 交接清单（下一会话从这里开始）

### 11.1 已交付并验证

- TIA 侧（本包，33 操作 / 32 工具，`npm run check` 全绿）：
  `adopt_open_project`、`online_targets`、`online_connect` / `online_status` / `online_disconnect(force)`、
  `download`（dry_run 默认、confirm 真下、physical 目标再要 `confirm_real_device`）。
- 真实验证过的路径：
  - **V17 + TCP/IP**（`Siemens PLCSIM Virtual Ethernet Adapter`）：adopt 1.2 s、GoOnline 4.4 s、
    软件下载 `Success` / 0 error；
  - **V20 + Softbus**（`PLCSIM`）：adopt → force offline → 软件下载 `Success` / 0 error，
    消息含 `Certificate configuration` / `Hardware configuration` / `Connection configuration`；
  - **V20 + TCP/IP**：连续两次下载 `Success`。
- 前置条件（缺一不可）：工程给目标 PLC **配子网 + 唯一 IP**；首次连接在 **TIA UI 接受自签名证书**；
  **adopt UI 已打开的工程**（Openness 答不了证书弹窗）。

### 11.2 本机当前状态

- PLCSIM Softbus 实例可能已随本会话后台任务结束而消失；重启方式：
  `node %TEMP%\tia-v20-spike\keep-instance.mjs "plc_1.profinet interface_1" 192.168.1.50 softbus`
  （TCP/IP 则把最后的 `softbus` 去掉；脚本会一直持有实例，Ctrl+C 或 kill 即 `POWER_OFF + UNREGISTER`）。
- 临时资产（**都不在仓库里**）：`%TEMP%\tia-v20-spike`（V20 临时控制器 / V20 工程 / 各探针脚本）、
  `%TEMP%\plcsim-spike`（Keeper、PLCSIM API）、`%TEMP%\*.log`（各次运行的完整日志）。
- TIA V17 工程：`C:\Users\Ansel\Documents\Automation\V17\AgentAssistProgramming\TestPLCExportDemo\TestPLCExportDemo.ap17`
- V20 工程副本：`%TEMP%\tia-v20-spike\project\TestPLCExportDemo_Single\TestPLCExportDemo_V20.ap20`

### 11.3 待办（按优先级）

1. **V17 hardware 下载**（`options=hardware` / `both`）——目前只验过软件；
2. **真实 PLC 验证**（`confirm_real_device=true`）——虚拟实例不覆盖这条闸门；
3. **`upload`（StationUploadProvider）/ `compare_online`（PlcSoftware.CompareToOnline）**——S3 未实现；
4. 上述通过后，把矩阵里 `Downloading hardware and software components…` 从“部分”改成“已适配”。

### 11.4 复跑一次 V17 下载（命令级）

```powershell
# 1) 实例（如已存在可跳过）
node $env:TEMP\tia-v20-spike\keep-instance.mjs "plc_1.profinet interface_1" 192.168.1.50 tcpip

# 2) TIA UI 打开 V17 工程并接受一次证书（人工）

# 3) 控制器：adopt → force offline → dry_run → confirm
#    参考脚本：$env:TEMP\tia-v20-spike\v17-adopt-download2.mjs
```

注意：控制器 exe 重建后哈希变化，**第一次 attach 可能超时一次**，重试即通过（见 §10.4）。