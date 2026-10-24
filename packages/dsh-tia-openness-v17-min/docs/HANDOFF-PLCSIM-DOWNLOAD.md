# HANDOFF — PLCSIM Advanced 下载：现状、证据与下一步

> 交接对象：实现 TIA Openness `download`（S2）的会话 `session-62702b0e-…`。
> 交接时间：2026-10-24。写这份 brief 的会话已完成 PLCSIM 运行侧 E2E，但没有完成 Openness 直连下载。
> **边界**：本 brief 只覆盖 `packages/dsh-tia-openness-v17-min`。不要改
> `packages/dsh-plcsim-advanced`、`docs/simulation-plcsim-advanced.md` —— 那是另一个会话的交付物。

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
