# 真实 PLC 下载能力评估

> 评估对象：`dsh-tia-openness-v17-min` 的在线/下载面，以及 agent 侧的编排面。
> 评估日期：2026-11-04。
> 口径：只有 **PLCSIM Advanced 上实测过** 的路径才算已验证；真实 PLC 一律按“未验证”处理。
> 关联文档：[`HANDOFF-PLCSIM-DOWNLOAD.md`](HANDOFF-PLCSIM-DOWNLOAD.md)、[`PROTOCOL.md`](PROTOCOL.md)、
> [`coverage-matrix.html`](coverage-matrix.html)。

---

## 0. 结论

**一句话：下载链路本身已经成型，并且在虚拟 PLC 上跑通了；但“真实 PLC”还差一次实测，而且“选哪个
interface”目前只是工程模型里的候选列表加名字启发式，不是基于网络可达性的判定。** 因此今天的 agent
在具备前置条件时可以完成下载，但还不能可靠地“自己搞清楚该用哪个 interface”；真机的证书信任、
下载配置差异、硬件下载和长任务超时也都没有闭环。

### 0.1 成熟度

| 能力 | 代码状态 | 实测状态 | 判定 |
|---|---|---|---|
| `online_targets` 目标发现 | 已实现 | PLCSIM 上用过；真实 PLC 未验 | 可用作候选列表，不是可达性证明 |
| `online_connect` / `online_status` / `online_disconnect` | 已实现，控制器持有单个会话 | V17 TCP/IP + V20 实测（PLCSIM） | 虚拟目标已验证；真机未验 |
| `adopt_open_project` 接管 UI 工程 | 已实现 | V17/V20 实测（PLCSIM） | 虚拟目标已验证；真机未验 |
| `download` 软件下载 | 已实现，含 dry-run/confirm/`confirm_real_device` | V17/V20 软件下载实测（PLCSIM） | 虚拟目标已验证；真机未验 |
| `download` 硬件 / `both` | 已接线 | **未测** | 不能承诺 |
| 密码 / 块绑定密码 | 已接线 | 只有参数转发单测 | 真机未验 |
| 无会话直连下载 | 已实现 | PLCSIM 实测 | 真机未验 |
| `target_address` 重载 | 已实现 | PLCSIM 上尝试过，失败在证书阶段 | 机制未证实 |
| 上传 / 在线比较 | 未实现 | — | 缺失 |
| 运行/停止 CPU | Openness V17 无 API | — | 缺失（只能通过下载选项间接影响） |
| 下载前备份 / 下载后在线校验 | 未实现 | — | 缺失 |
| 真机身份校验 / 防下错设备 | 未实现 | — | 缺失 |
| 第一方 agent 下载 playbook | 未提供 | — | 缺失（只有工具描述 + 内部交接文档） |

### 0.2 三个关键判断

1. **真正的阻断点不只是 interface，而是证书/信任。** 首次连接 PLC 需要在 TIA UI 接受自签名证书；
   Openness 没有回答该弹窗的委托，headless 控制器会在进入下载回调之前就失败。当前唯一被证明可行的
   路径是：人工在 TIA UI 打开工程并接受证书 → `adopt_open_project` 接管 → 再下载。真实 PLC 上
   证书是否持久化、headless 是否能直接连，**尚未验证**。这直接决定 agent 能否做到“无人值守下载”。
2. **interface 发现是“工程模型候选”，不是“网络可达性判定”。** `online_targets` 只枚举
   `OnlineProvider.Configuration`；按**子网名**把项目节点和 PC 接口配对；`virtual`/`physical`
   只看名字里有没有 `PLCSIM`/`Virtual`；没有 ping/ARP/DCP 扫描、没有 Windows 网卡状态、没有路由判断、
   也没有暴露 `DownloadProvider.Configuration`。多网卡、跨网段、目标 IP 与工程 IP 不一致时，
   agent 没有可靠依据选网卡。
3. **真机需要的下载配置还没有覆盖。** 回调策略对“设备配置与项目不同”“覆盖系统数据”“复位模块”
   等已知的高风险 `DownloadSelectionConfiguration` 一律 `NoAction`；`DownloadCertificate` 虽然也是
   selection 配置，但没有 `CurrentSelection`，当前只能直接返回、无法回答；只支持
   `DownloadOptions.Software`，没有 `SoftwareOnlyChanges`；`WaitOnReboot` 也用 `NoAction`。
   这些在 PLCSIM 上不出现或无关，在真机上很可能直接导致下载失败，或者让下载停在不可控状态。

---

## 1. 现在已经有什么

### 1.1 工具面

在线/下载相关工具都在 `src/tools.ts`：

| 工具 | 控制器操作 | 作用 | 备注 |
|---|---|---|---|
| `adopt_open_project` (`:2361`) | `AdoptOpenProject` | 接管 TIA UI 已打开的工程 | 证书信任的唯一已验证来源 |
| `online_targets` (`:2388`) | `OnlineTargets` | 枚举设备、离线 IP/子网、PC 接口、slot | 只读；只基于 `OnlineProvider` |
| `online_connect` (`:2422`) | `OnlineConnect` | 应用连接配置并 `GoOnline` | 会话存活到 `online_disconnect` 或控制器退出 |
| `online_status` (`:2478`) | `OnlineStatus` | 读当前会话状态 | 不连接、不断开 |
| `online_disconnect` (`:2501`) | `OnlineDisconnect` | `GoOffline` 并忘记会话 | `force=true` 可清 UI 残留在线态 |
| `download` (`:2527`) | `Download` | 解析目标、过闸门、调用 `DownloadProvider.Download` | 默认 `dry_run=true` |

控制器侧的实现在 `controller/OperationsOnline.cs`：

- `OnlineTargets` (`:110`)：设备 → 离线节点 → PC 接口；
- `DescribeInterfaces` (`:182`)：`Modes → PcInterfaces → TargetInterfaces/Subnets`；
- `GroupNodesBySubnet` (`:242`)：按**项目子网名**分组，并把同名 PC 子网挂成 `reachableBy`；
- `Download` (`:686`)：目标解析、`ApplyConfiguration`、回调、结果树；
- `DownloadPolicy` (`:591`)：两个 `DownloadConfigurationDelegate` 的固定策略；
- `ClassifyInterface` (`:1248`)：名字含 `plcsim`/`virtual` 即 `virtual`，否则 `physical`。

### 1.2 下载目标的两种来源

`Download` 的目标解析有两条路（`controller/OperationsOnline.cs:697-749`）：

1. **复用在线会话**：`_onlineSession` 存在、设备名一致、且没有显式目标参数时，用
   `ResolveSessionTarget` (`:963`) 在 `DownloadProvider.Configuration` 上重新找同一个
   mode / PC interface / target interface 或 address。
2. **从下载 provider 直接解析**：传了 `pc_interface`（加 `target_interface` 或 `address`）时，用
   `ResolveTargetOnConfiguration` (`:1071`) 找目标。

两条路的差异很关键：

- 走 `download_property` 时，控制器会先 `ApplyConfiguration` (`:828-863`)，再
  `provider.Download(...)` (`:870-872`)；
- 走 `session` 时，代码认为“OnlineConnect 已经应用过”，**没有在 `DownloadProvider` 上再次
  `ApplyConfiguration`**。而 `OnlineProvider` 和 `DownloadProvider` 是两个 provider 实例，
  `ConfigurationTargetInterface` 是否跨 provider 共享，没有在真机上验证过。上游 skill 明确警告：
  重新 `GetService<DownloadProvider>()` 得到的实例，其 target 对象会失效，下载会静默回退默认接口
  （`../skills/online-and-download/SKILL.md` 的 “Cache the DownloadProvider instance” 一节）。
  当前会话路径没有重新 `GetService`，但也没有在下载 provider 上应用配置，存在**静默走默认接口**的
  风险，必须列为真机验证项。

### 1.3 回调策略

`DownloadPolicy.PreDownload` (`:607-666`) 目前这样回答：

| 配置类型 | 策略 | 真机风险 |
|---|---|---|
| `DownloadPasswordConfiguration`（含 `BlockBindingPassword`、`ModuleReadAccessPassword`、`ModuleWriteAccessPassword`、`PlcMasterSecretPassword`） | 用 `password` / `block_binding_password` 设置 | 密码错误时只能从结果消息判断 |
| `StopModules` | `StopAll` | 真机会停 CPU；没有“只停被下载模块”选项 |
| `StartModules` | 后回调 `StartModule` | 下载后自动启动 |
| `ConsistentBlocksDownload` | 一致下载 | 安全默认 |
| `AlarmTextLibrariesDownload` | 一致下载 | 安全默认 |
| `AllBlocksDownload` | 下载所有块 | 可能不是“仅更改” |
| `DownloadCheckConfiguration`（含 `CheckBeforeDownload`、`DowngradeTargetDevice`、`UpgradeTargetDevice`、`FitHmiComponents`、`OverwriteHmiData`、`OverwriteTargetLanguages`、`TurnOffSequence`、`StartDriveDownloadCheckConfiguration`） | 只把 `CheckBeforeDownload` 勾上；其余一律不勾 | 真机上“目标固件升级/降级、覆盖 HMI 数据、目标语言覆盖”等会被拒绝 |
| `DownloadCertificate` | 直接 `return`（无 `CurrentSelection` 可设） | 证书弹窗无法回答；TIA 无法继续（通常表现为下载中止），结果只剩 `download_failed`，agent 难以诊断 |
| 其他 `DownloadSelectionConfiguration`（`DifferentTargetConfiguration`、`OverwriteSystemData`、`ResetModule`、`InitializeMemory`、`DataBlockReinitialization`、`ExpandDownload`、`LoadIdentificationData`、`ProtectionLevelChanged`、`StartBackupModules`、`StopHSystem`、`StopHSystemOrModule`、`SwitchBackupToPrimary`、`WaitOnReboot`、`ActiveTestCanBeAborted`、`ActiveTestCanPreventDownload`） | 保持 `NoAction` | 真机上“配置不同/覆盖/复位/重启/活动测试”等可能因此中止，或停在等待状态 |
| 未来新增且不属于以上三类的配置 | 抛 `NotSupportedException` → `download_failed` | 安全网；V17 现有的公共类型都已落在上面三类里 |

按 V17 `Siemens.Engineering.dll` 反射核对：`DownloadCertificate` 确实是
`DownloadSelectionConfiguration`，但**没有 `CurrentSelection` 属性**，所以它和别的 selection
配置不同——不是“选了 NoAction”，而是“没有可回答的入口”。这也是证书问题最终只能回到 TIA UI
处理的结构性原因（真实 PLC 上具体表现仍需实测确认）。除此之外，V17 的公共配置类型都能落到上面的
密码/检查/选择三类里，所以当前的主要问题不是“类型没接”，而是**选择保守、且对证书无解**。

`DownloadOptions` 的映射在 `:813-816`：`software` → `DownloadOptions.Software`，
`hardware` → `Hardware`，`both` → `Hardware | Software`。V17 枚举里还有
`SoftwareOnlyChanges`，但工具没有暴露；真机上“仅下载更改”通常是更安全的默认，当前只能做全量软件下载。

### 1.4 已验证的范围

按 `docs/HANDOFF-PLCSIM-DOWNLOAD.md` 的记录：

- V17 控制器 + PLCSIM Advanced V7 + TCP/IP：`adopt_open_project` → `online_disconnect(force)` →
  `download(software)` → `state=Success`、0 error；`online_connect` 4.4 s 到 `Online`；
- V20 + PLCSIM Advanced V7 + TCP/IP：连续两次 `state=Success`；
- V20 + Softbus：`state=Success`、0 error；
- 前置条件：工程给 PLC 分配子网 + 唯一 IP；首次连接在 TIA UI 接受证书；用 `adopt` 接管 UI 工程。

这些全部是**虚拟目标**。仓库里没有任何一条真实 PLC 的下载记录；`../README.md` §10 仍把在线/下载
描述为“已接线、V17 未实测”，`../scripts/coverage/matrix-data.mjs:873-884` 则把 download 标为“部分”。

### 1.5 测试覆盖

- `test/04-tools.test.mjs:797-845` 只验证 `download` 的参数转发（默认值、`confirm`、
  `confirm_real_device`、`options`、密码、直连目标）；
- `test/helpers/harness.mjs` 用假的控制器，不执行 C# 的 `Download` / `DownloadPolicy`；
- `controller/SelfTest.cs:157` 只把 `Download` 放进操作白名单，没有回调策略的单测；
- 没有 `DownloadProvider.Configuration` 的真机/半真机 fixture，也就没有“多网卡/子网不匹配/
  证书缺失/不同目标配置”的回归用例。

结论：**控制器侧的下载行为目前只有“人工跑一次”的证据，没有自动化回归。**

---

## 2. 真机链路逐步走查

假设用户说“把 PLC_1 下载到设备”。按今天的实现，agent 需要这样走：

| # | 步骤 | 现在怎么做 | 真机上会卡在哪 |
|---|---|---|---|
| 1 | 确定目标 PLC | `project_info` / `online_targets`；多个 PLC 时靠名字匹配 | 没有“用户说的设备”到项目设备的消歧；多 PLC 时容易下错 |
| 2 | 确认工程与证书 | `adopt_open_project`；工程必须已在 TIA UI 打开，且证书已接受 | headless 打开工程会在 `Connect to module … failed` 失败；证书信任是否持久化未验 |
| 3 | 发现 interface | `online_targets`：列 PC 接口、slot、PC 子网地址 | 只列 `OnlineProvider`；下载 provider 的接口可能不同；按子网名匹配；没有网卡链路/IP/路由检查 |
| 4 | 选 interface | agent 从 `subnets[].reachableBy[]` 里挑一个 | 多个候选时没有排序依据；`kind` 是名字启发式；物理/虚拟判断可能错 |
| 5 | 建立连接 | `online_connect`；失败会 `GoOffline` 清理 | 证书、防火墙、Openness 白名单超时；失败信息是泛化字符串 |
| 6 | dry-run | `download(dry_run=true)`：只解析目标 + 闸门 | 不展示“会停哪些模块/全量还是增量/哪些配置会中止/是否需要密码” |
| 7 | 真下载 | `download(confirm=true, confirm_real_device=true)` | 只支持全量软件；差异配置 `NoAction` 可能中止；未知配置抛异常；超时会杀控制器 |
| 8 | 结果验证 | 读 `state`、`errorCount`、`messages`、`configurations` | 没有 CPU RUN/STOP、没有在线比较/校验和、下载后会话可能掉线且不自动重连 |
| 9 | 异常恢复 | agent 根据错误码/消息人工判断 | `download_failed` 太泛；没有结构化 remediation |

---

## 3. 缺口清单

### P0：不补就不能承诺“能下真实 PLC”

**G1. 证书/信任闭环没有解决。**
- 现状：Openness 没有 `TlsVerificationConfiguration` 的可写入口；`DownloadCertificate` 虽然是
  selection 配置，但没有 `CurrentSelection`，当前代码只能直接返回、无法回答；PLCSIM 上实测
  headless 首连必败（`PROTOCOL.md:661-666`）。
- 影响：agent 不能自主完成“首次连接真机”；必须依赖用户在 TIA UI 里先打开工程并接受证书。
- 待验证：真实 PLC 的证书信任是否在 TIA 用户配置中持久化；如果是，headless 的
  `open_project` 能否直接连；如果不是，`adopt` 就是硬前置。
- 建议：先做一次“headless 真机连接”实验；无论结果如何，给 `DownloadCertificate` 一个专门错误码
  （如 `certificate_required`）和操作指引（“在 TIA UI 接受证书后 adopt”），不要把泛化的
  `download_failed` 丢给 agent。

**G2. interface 选择不是可达性判定。**
- 现状：`online_targets` 只基于 `OnlineProvider.Configuration`；`reachableBy` 按**子网名**匹配；
  `kind` 只看名字；没有 Windows 网卡状态、IP/掩码重叠、路由/网关、DCP/ARP 扫描；
  `download` 没有 `expect_kind` 参数；`target_address` 重载未在真机证实。
- 影响：多网卡、跨网段、目标 IP 与工程 IP 不一致、虚拟网卡桥接真实 PLC 时，agent 可能选错或选不到；
  安全闸门 `confirm_real_device` 依赖名字，VMware/VirtualBox 之类名字含 `Virtual` 的适配器
  可能把真实 PLC 误判为 `virtual`，从而**绕过**真机二次确认。
- 建议：
  1. `online_targets` 同时枚举 `DownloadProvider.Configuration`，每条候选带 `provider`
     （`online`/`download`）和 `source`；
  2. 用节点 `address`/`subnetMask` 与 PC 接口 `pcAddresses` 做 IP/掩码重叠计算，而不是比名字；
  3. 给候选加 `reachable: true/false/unknown` 与 `reason`（同网段/无地址/无链路/需要路由）；
  4. 给 `download` 加 `expect_kind`，与 `online_connect` 一致；
  5. `target_address` 用真机做一次“工程 IP 与实际 IP 不一致”的实验，明确它到底是目标设备地址
     还是 PC 侧地址，再决定是否保留这个参数名。

**G3. 会话路径可能在下载 provider 上用了默认 interface。**
- 现状：只有 `targetSource=download_property` 会 `ApplyConfiguration`；`session` 路径跳过了这一步
  （`controller/OperationsOnline.cs:828`）。
- 影响：先 `online_connect` 再 `download` 时，下载 provider 可能没有应用目标，静默回退默认接口；
  而 PLCSIM 的实测恰好都是先 `force offline` 再直连下载，**没有覆盖会话路径**。
- 建议：无论目标来源，`Download` 前都在 `DownloadProvider.Configuration` 上
  `ApplyConfiguration` 一次；并用“两个网卡/两个候选”的真机（或半真机）用例验证。
  这是当前最值得先修的一处，因为“先上线验证、再下载”正是真机最自然的流程。

**G4. 真机下载配置覆盖不足。**
- 现状：`Software` 而不是 `SoftwareOnlyChanges`；`DifferentTargetConfiguration`、
  `OverwriteSystemData`、`ResetModule`、`InitializeMemory`、`DataBlockReinitialization`、
  `WaitOnReboot` 等一律 `NoAction`；`DownloadCertificate` 无 `CurrentSelection` 可回答；
  `DownloadCheckConfiguration` 的升级/降级/覆盖 HMI 等只勾了 `CheckBeforeDownload`。
- 影响：真机上“设备配置与项目不同”很常见，`NoAction` 可能直接中止；硬件下载需要重启时
  `WaitOnReboot=NoAction` 不合适；没有“仅更改”会拉长停机时间；固件升级/降级/覆盖 HMI 一律
  被拒绝，某些现场升级场景即使人工同意也做不了。
- 建议：
  1. 增加 `software_only_changes`（或把 `software` 的默认改为 `SoftwareOnlyChanges`，
     另给 `software_full`）；
  2. 为高风险配置提供**显式白名单参数**（例如 `allow_target_configuration_diff=true`、
     `wait_on_reboot=true`、`allow_target_upgrade=true`），默认仍拒绝；
  3. 把“因为 `NoAction` 而中止”的配置类型/消息提升为结构化 `download_blocked`，而不是只给
     `download_failed`；
  4. 对 `DownloadCertificate` 给专门错误码；对 `ModuleWriteAccessPassword` 等密码类配置
     确认是否都已由 `DownloadPasswordConfiguration` 分支覆盖。

**G5. 超时/取消会杀控制器，可能中断下载。**
- 现状：`requestTimeoutMs` 默认 300 s（`src/config.ts:38`）；超时或 abort 会 `#hardAbort` 控制器
  （`src/controller.ts:287-303`）。Openness 调用不可取消。
- 影响：大工程真机下载可能超过 300 s；控制器被杀会中断下载，PLC 可能停在 STOP 或半下载，
  而 agent 只看到 `controller_timeout`。
- 建议：给 `download` 单独放宽超时（或按项目大小估算）；在调用前提示“下载期间不要取消”；
  中期把下载改成“发起 + 轮询”的异步操作，避免长连接被 DSH 超时截断；至少不要让 `cancel`
  在写操作中途静默杀进程。

**G6. 没有下载前备份/比较，也没有下载后验证。**
- 现状：`upload` / `compare_online` 未实现；下载前不读在线状态、不做身份校验、不备份；
  下载后只看 `DownloadResult`，不确认 CPU 是否 RUN、程序是否真的在跑。
- 影响：真机上误下、下错设备、下完没起来都无法提前/事后发现。
- 建议：短期用 `FingerprintDataProvider.GetFingerprintData` 做设备身份校验（至少读序列号/订货号），
  并要求下载前 `archive_project` 备份；中期补 `upload` + `compare_online`，下载后 `online_connect`
  + 结果校验。

### P1：为了达到“agent 自己搞清楚 interface 并下载”

**G7. 没有下载目标发现，也没有统一的候选模型。**
- 现状：`online_targets` 只给在线 provider 的接口；`download` 自己解析，二者可能不一致。
- 建议：新增 `download_targets`（只读）或扩展 `online_targets`，返回统一的
  `candidates[]`：device、cpu、projectIp、pcInterface、pcInterfaceNumber、targetInterface、
  pcAddresses、provider、kind、reachable、reason、requiresRouter。
  这样 agent 不需要在两次调用之间自己拼。

**G8. 没有第一方 agent playbook。**
- 现状：`../skills/online-and-download/SKILL.md` 是上游 Siemens 的 API 说明，不是本套件的
  “先 adopt、再 dry-run、再 confirm”工作流；`HANDOFF-PLCSIM-DOWNLOAD.md` 是内部交接文档，
  运行时的 agent 看不到。工具描述是唯一在带内的指引，且很长。
- 建议：写一个随包的 `skills/real-device-download/SKILL.md`（或扩展 `tia-openness` 路由 skill），
  把决策树、错误码、前置条件、禁止事项写清楚；工具描述只保留指针。

**G9. dry-run 不能预览风险。**
- 现状：`dry_run` 只解析目标 + 闸门，不展示“会停所有模块”“全量软件”“差异配置会中止”
  “可能需要密码/证书”，也不检查 PLC 是否已编译/项目是否一致；下载本身会触发编译，不一致时
  失败可能只表现为 `download_failed`。
- 建议：dry-run 返回 `plan`：`target`、`options`、`willStopModules`、`willStartModules`、
  `softwareMode`（full/changes）、`blockingPolicies`、`requiredPasswords`、`certificateState`、
  `compiled`；让确认是“知情确认”，而不是只看到一个 interface 名字。下载前显式调用
  `compile_plc`（或把编译状态纳入闸门）。

**G10. 多 PLC/多网卡/跨网段/目标 IP 不一致没有决策与诊断。**
- 现状：`online_targets` 只分组，不排序；`unmatchedNodes` 只列出节点，不给“下一步怎么修”。
- 建议：返回结构化诊断：`no_subnet`、`no_matching_nic`、`nic_down`、`needs_router`、
  `ip_mismatch`、`multiple_candidates`，每条带“建议动作”。agent 遇到多候选时先问用户，
  不要猜。

**G11. 硬件下载、`both`、密码、S7-1200、StartDrive、F-CPU、R/H 的覆盖边界。**
- 现状：硬件/`both` 未测；密码只有参数转发单测；`FindCpuItem` 只找 CPU，StartDrive 的
  headmodule（HM）不支持；F-CPU 明确 `download_unavailable`；S7-1200、第三方/GSD 设备未验；
  R/H 冗余站（`RHDownloadProvider`）不在范围内。
- 建议：明确产品边界（先只承诺 S7-1500 非 F、软件下载）；硬件下载单独做 bench 验证；
  把不支持的类型在 dry-run 就拒绝，而不是等到 `Download` 才失败。

**G12. 单控制器/单会话与 UI 所有权。**
- 现状：一个控制器只有一个在线会话；`adopt` 后工程归 UI 所有；多个 DSH 会话共享同一控制器。
- 影响：并发下载/连接会互相踢；UI 占用在线态会导致 `online_mode_conflict`。
- 建议：在 agent 层串行化“连接/下载/断开”；把会话 `owner` 用起来；下载前强制检查
  `online_status` 并清理残留。

### P2：加固与一致性

**G13. 文档口径互相矛盾。**
- `PROTOCOL.md:576-578` 说 `OnlineTargets` 和会话“尚未在设备上验证”，但
  `matrix-data.mjs:920-926` 已把 “Assigning PC interface” 标为 done，HANDOFF §9 也有 PLCSIM 实测。
- `matrix-data.mjs:884` 说“V17 控制器同路径未实测”，但 HANDOFF §9 和 `PROTOCOL.md:478-492`
  明确记录了 V17 控制器 + PLCSIM 的成功下载。
- `../README.md` §10 说“V17 未实测”，与上面相同。
- 影响：读文档的人无法判断到底验过什么，评估/排期会建立在错误前提上。
- 建议：以 HANDOFF §9 为准，统一改成“V17/V20 + PLCSIM 软件下载已验证；真实 PLC 未验”；
  重新生成覆盖矩阵。

**G14. 控制器侧没有回归测试。**
- 建议：为 `ResolveTargetOnConfiguration` / `ResolveSessionTarget` / `DownloadPolicy` 抽出可测的
  纯逻辑（或加 C# 测试工程），用录制的 `DownloadProvider.Configuration` fixture 覆盖：
  多接口、无 slot、按地址、`DifferentTargetConfiguration`、密码、未知配置。
  至少要能在没有 TIA 的 CI 里跑。

**G15. 真机确认还是“一个布尔值”。**
- 现状：`confirm_real_device=true` 是 agent 传的参数，没有审批、角色、双人确认、审计事件。
- 建议：真机下载前要求用户明确确认（UI/对话），记录 `target fingerprint`、
  `device order number`、操作者、时间；`download` 的结果写入审计日志。
  这不是 Openness 层能单独解决的，但产品层必须定义。

**G16. 长任务没有进度。**
- 现状：`progress.Report` 只在调用前发一条“Downloading …”，之后同步阻塞。
- 建议：即使 Openness 没有下载进度回调，也可以在控制器层发心跳/已用时长；DSH 侧给
  `download` 一个更长的 deadline，并在 UI 上显示“下载中”。

---

## 4. 目标形态：agent 怎么“搞清楚 interface”

建议把 agent 的行为收敛为下面这条流程（也是验收标准）：

1. **解析设备**：从用户话里拿到 PLC 名/位置；项目里多个同类型设备时，先问用户，不猜。
2. **准备会话**：如果工程还没在 TIA UI 打开，提示用户打开并接受证书；然后 `adopt_open_project`。
   如果信任已持久化（待验证），才允许 headless `open_project`。
3. **读候选**：`online_targets`（扩展后）+ `download_targets`，得到每个 PLC 的
   project IP/mask、PC 接口、slot、PC 地址、`kind`、`reachable`、`reason`。
4. **选候选**：
   - 唯一 `reachable=true` 且 `kind` 符合预期 → 用它；
   - 多个 → 按“同网段 > 有链路 > 物理 > 显式用户指定”排序，仍不唯一就问用户；
   - 零个 → 返回结构化诊断（无子网/无网卡/网卡 down/需要路由/证书未信任/IP 不一致），
     不要直接调 `download`。
5. **先验证再写**：对真实 PLC，优先 `online_connect` 到候选；只有 `state=Online` 才继续。
   这一步同时验证了“网卡对不对”“设备在不在”“证书行不行”。失败就清理并报告，不进入下载。
6. **dry-run**：`download(dry_run=true)` 返回目标 + 风险计划；agent 把“会停所有模块/全量软件/
   差异会中止/需要密码”告诉用户。
7. **确认**：真实 PLC 必须由用户明确确认（不是 agent 自己填 `confirm_real_device`）；
   确认后再 `download(confirm=true, confirm_real_device=true)`。
8. **下载后**：读 `state`/`messages`/`configurations`；`online_status` 确认会话是否还在；
   可选 `online_connect` 复查；记录审计。

这条流程里，interface 的选择不再靠“名字猜”，而是靠“候选 + 在线验证”。这也是在不新增
Windows 网络探测的前提下，最稳的 MVP。

---

## 5. 分阶段建议

| 阶段 | 内容 | 目的 | 规模 |
|---|---|---|---|
| P0 评估收口 | 统一文档口径；补 `download_targets`/扩展 `online_targets`；IP/掩码匹配；`download` 加 `expect_kind`；`software_only_changes`；dry-run 风险计划；结构化 remediation；第一方 skill | 让 agent 有可靠候选和知情确认 | S–M |
| P1 半真机 | 用**物理网卡 + PLCSIM TCP/IP**（或 VMware/Hyper-V 桥接）跑：物理接口识别、非 PLCSIM 名字、多网卡、`target_address`、会话路径 `ApplyConfiguration`、超时 | 在不碰真实产线的前提下验证“物理 interface”分支 | S–M |
| P2 真机 bench | 用备用 PLC（非产线）：证书接受/持久化实验、工程子网/IP、dry-run、`confirm_real_device` 拒绝/通过、`SoftwareOnlyChanges`、差异配置、密码、硬件下载、下载后在线验证 | 拿到第一份真实 PLC 证据 | M–L |
| P3 安全与产品化 | 下载前备份/上传/比较、设备指纹校验、审批/审计、异步下载与进度、多设备/多会话策略 | 从“能下”到“敢下” | L |

建议先做 P1 的“会话路径 `ApplyConfiguration`”验证：它不需要真实 PLC，只需要两个候选接口
（例如物理网卡 + PLCSIM 虚拟网卡），就能证明“先上线再下载”会不会走错接口。这是当前代码里
最具体、最可能出问题的一处。

---

## 6. 验收用例

| # | 场景 | 期望 |
|---|---|---|
| 1 | 真实 PLC，物理接口，`confirm_real_device=false` | 拒绝，且**不调用** `Download`；错误说明缺二次确认 |
| 2 | 同上，`confirm_real_device=true` | 下载成功或返回可解释的配置阻塞；结果含 messages/configurations |
| 3 | 传错 PC interface | `download_target_mismatch`，`details.available` 列出候选 |
| 4 | 工程没给 PLC 分配子网/IP | dry-run 就返回 `no_subnet`，不要等到 `Download` 失败 |
| 5 | 证书未信任 | 返回 `certificate_required`（或等价），提示“TIA UI 接受后 adopt” |
| 6 | 先 `online_connect` 再 `download`，两个候选接口 | 下载走的是会话那条接口，不是默认接口 |
| 7 | 设备配置与项目不同 | 默认明确中止并说明是哪个配置；显式白名单才允许接受 |
| 8 | 只改了几个块 | `software_only_changes` 可选，且比全量快/停机短 |
| 9 | 硬件下载 / `both` | bench PLC 上成功；失败时说明是重启/模块不匹配 |
| 10 | 下载超过默认超时 | 不杀控制器；或返回“仍在进行”的可恢复状态 |
| 11 | 多 PLC / 多网卡 | 返回多个候选与理由；不唯一时 agent 问用户 |
| 12 | 下载后会话掉线 | 结果报告 `sessionEnded`，agent 能重连并确认状态 |

---

## 7. 需要拍板的问题

1. **目标是不是“无人值守”？** 如果是，必须先解决证书信任持久化；否则只能接受“TIA UI 打开 +
   adopt”的前置。两条路的工作量和产品形态完全不同。
2. **真机下载是否允许由 agent 自主确认？** 还是必须用户每次明确说“确认下载到真实设备”？
   这决定 `confirm_real_device` 是 agent 参数还是 UI 审批。
3. **支持哪些 CPU？** 先只承诺 S7-1500 非 F、软件下载？S7-1200/300/400、StartDrive、F-CPU
   是否明确排除？
4. **硬件下载是否在范围内？** 硬件下载会改 IP/设备名、可能重启，风险和软件下载不是一个量级。
5. **是否要求下载前 upload/compare？** 如果要求，`upload` / `compare_online` 要先补，周期会变长。
6. **网络假设是什么？** 同网段直连、跨网段路由、VPN、双网卡？这决定 interface 选择要做到多强。
7. **目标 IP 与工程 IP 不一致时怎么办？** 是拒绝，还是允许 `target_address` 直连？需要真机证据。
8. **有没有真实 PLC 可以做 bench 测试？** 型号、固件、是否允许停机、是否在产线。

---

## 8. 证据索引

- 工具面：`src/tools.ts:2361`（adopt）、`:2388`（online_targets）、`:2422`（online_connect）、
  `:2527`（download）。
- 控制器：`controller/OperationsOnline.cs:110`（OnlineTargets）、`:182`（DescribeInterfaces）、
  `:242`（GroupNodesBySubnet）、`:591`（DownloadPolicy）、`:686`（Download）、`:963`
  （ResolveSessionTarget）、`:1071`（ResolveTargetOnConfiguration）、`:1248`（ClassifyInterface）。
- 下载 provider：`controller/OpennessHost.Online.cs:126`（FindDownloadProvider）、`:143`
  （DescribeOfflineNodes）。
- 超时：`src/controller.ts:287-303`、`src/config.ts:38`。
- 虚拟目标实测：`docs/HANDOFF-PLCSIM-DOWNLOAD.md` §0、§8、§9、§11.3。
- 协议与错误码：`docs/PROTOCOL.md:580-676`、`:677-719`。
- 下载配置类型层级：对 V17 `Siemens.Engineering.dll` 的
  `Siemens.Engineering.Download.Configurations` 命名空间做反射核对（2026-11-04）：
  `DownloadCertificate` 是 `DownloadSelectionConfiguration` 且没有 `CurrentSelection`；
  其余 selection 配置都带有各自的 `CurrentSelection` 枚举。
- 覆盖矩阵：`../scripts/coverage/matrix-data.mjs:873-884`、`:911-926`。
- 上游 API 提醒：`../skills/online-and-download/SKILL.md` 的 “Cache the DownloadProvider instance”。
