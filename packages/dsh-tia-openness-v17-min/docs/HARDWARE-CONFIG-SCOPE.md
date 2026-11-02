# 硬件组态读取：能力矩阵筛选与落地范围

**状态**：P0 已落地（v0.3，`export_hardware_config` / `ExportHardwareConfig`）；P1/P2 未开始。
§1–§2 是筛选与范围（写作时的现状），§3 已按手册与实测更新，§7 记录实际交付了什么。
**触发**：需求为"插件具备从 TIA 读取硬件组态相关信息的能力，最低要求是读取一个项目级别的全局 `hardware.aml`"。
**依据**：`docs/coverage-matrix.html`（444 数据行 / 391 条能力条目）逐条筛选，
叠加 `C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17\Siemens.Engineering.dll`
的**反射实证**（见 §4）、本机 Openness CHM 手册原文（见 §3 的 U1/U3/U7）、以及 2026-11-02 的实施结论。
手册结论与 V17 实测结论分开标注，不混写。

---

## 0. 结论摘要

1. 矩阵里与硬件组态相关的叶子条目共 **114 条**（写作时的基线）：
   `none 103 · partial 6 · done 4 · na 1`。
   也就是说硬件面整体是"**只有导航，没有能力**"——已完成的 4 条全是 `project.Devices` 的遍历/访问。
2. 用户的最低要求（读项目级全局 `hardware.aml`）只落在**一条**上：
   `Export/import → Importing/exporting hardware data → Export of CAx data`（id **394**）。
   反射确认 V17 有 `CaxProvider.Export(Project, FileInfo, FileInfo)` 重载，这就是项目级 AML 的唯一入口。
3. 该章节当时 **37 条全为 none**，且控制器对 `Cax / HW.Utilities / HW.CustomDataTypes / HW.Extensions /
   HW.Systemdiagnostics.Settings` 五个命名空间是 **0/14 类型引用**——完全没接线，不是"接了一半"。
4. 硬件面当时只有 12 个 HW 类型、且全是导航用途（`Device / DeviceItem / DeviceUserGroup /
   DeviceSystemGroup / Subnet / Node / Address / Classification / InterfaceType / Mode / NetType`）。
5. **要做的最小集合是 3 条**（394 + 398 + 385 的汇总状态），加 1 个新操作。
   **"读取硬件组态信息"要名副其实**则还要一整组结构化读取（§2.2，约 20～25 条），两条技术路线二选一或并用。
6. **不确定项 10 条**（§3）：U1/U3/U7 已由手册原文消解，U2/U4 由用户决策或按决策实现，
   U5/U6/U8/U9/U10 仍需第一次真机跑通时确认。
7. **已落地（v0.3）**：工程级导出单个 `globalHardware.aml`（含所有设备的组态），独占访问内执行、
   不 Save、不解析 AML，默认落盘 `<workspace>/hardware/`。详见 §7。

---

## 1. 分组清单（114 条怎么来的）

### 1.1 A 组：CAx / AML 硬件数据导入导出（`Export/import → Importing/exporting hardware data`）

37 条叶子，**全部 none**。API 归属见矩阵：`Cax HW.Utilities HW.CustomDataTypes HW.Extensions
HW.Systemdiagnostics.Settings 0/14`。

| id | 条目 | 读侧可用 | 建议桶 |
|---|---|---|---|
| 385 | *(章节汇总)* | — | **P0**（其余条目落地后改 partial） |
| 386 | AML file format | 格式基础 | **P1**（解析前的知识前提） |
| 387 | Pruned AML | 精简 AML | P2 |
| 388 | Overview of the objects and parameters of the CAx import/export | 字段口径 | **P1** |
| 389 | Structure of the CAx data for importing/exporting | 字段口径 | **P1** |
| 390 | AML type identifiers | 设备/模块分类 | **P1** |
| 391 | Export/Import of base unit Information via AML | 读侧可 | P2 |
| 392 | Export/Import AML with extension rack connection | 读侧可 | P2 |
| 393 | Connection handling for extension racks | 读侧可 | P2（与 148 重叠，见 U 说明） |
| **394** | **Export of CAx data** | **这就是全局 `hardware.aml`** | **P0** |
| 395 | Import of CAx data | 写 | 不做（本轮） |
| 396 | Export/Import of sub modules | 读侧可 | P2 |
| 397 | Import CAx data without logical address | 写 | 不做 |
| **398** | **Exceptions during import and export of CAx data** | 错误归一 | **P0** |
| 399 | Round trip exchange of devices and modules | 读写往返 | P2 |
| 400 | Import AML ignoring unknown artifacts | 写 | 不做 |
| 401 | Export/Import topology | 读侧可 | **P1**（拓扑是最常问的硬件信息） |
| 402 | Import of device with Library references | 写 | 不做 |
| 403 | Export of a device object | 单设备 AML | P2（最便宜的下一个增量） |
| 404 | Import of a device object | 写 | 不做 |
| 405 | Export/Import of device with set address | 读侧可 | **P1**（地址是否进 AML，见 U7） |
| 406 | Export/Import of device with channels | 读侧可 | **P1**（通道是否进 AML，见 U7） |
| 407 | Export of device item objects | 读侧可 | P2 |
| 408 | Import of device item objects | 写 | 不做 |
| 409 | Export/Import of GSD/GSDML based devices | 读侧可 | **不确定**（U3） |
| 410 | Export/Import device configuration with virtual interface | 读侧可 | P2 |
| 411 | Export/Import of subnets | 读侧可 | P2（对象模型路线已能读，见 88 组） |
| 412 | Export/Import of IO-systems | 读侧可 | P2（同上） |
| 413 | Export/Import of multilingual comments | 读侧可 | **不确定** |
| 414 | Export/Import ET200 SP/ET200 AL devices with extension rack connections | 读侧可 | P2 |
| 415 | Export/Import of ARE APC Drive 1.2.0 | 特定驱动 | 不做 |
| 416 | AML AR APC Attribute Support *(组，6 条)* | 读侧可 | P2 |
| 417 | Export/Import of PLC tags | 读侧可 | P2 |
| 418 | Export/Import of RH/PLC | 冗余站 | 不做 |
| 419 | Export/Import AML with customized tag and deviceitems | 读侧可 | P2 |
| 420 | Export/Import of FailSafe PLC | 读侧可 | **不确定**（F 设备的 AML 口径） |
| 421 | Export/Import of Failsafe IO | 读侧可 | **不确定**（同上） |
| 422 | Export/Import vendor specific attribute | 受 **R12** | **不确定**（R12：Manufacturer 属性 Openness 不支持） |
| 423 | AML attributes versus TIA Portal Openness attributes | 映射表 | **P1**（AML 字段 ↔ Openness 属性） |

**关键结构性事实**（反射实证）：`CaxProvider` **只有 `CaxImportOptions`，没有 `CaxExportOptions`**。
所以导出**没有范围/过滤选项**——要么工程级全导，要么逐 `Device` 调 `Export(Device, …)`。
这条决定了 P0 的实现形态：工程级一个文件，设备级靠多次调用。

### 1.2 B 组：硬件对象模型（不走 AML 的结构化读取）

62 条叶子：`done 4 · partial 4 · none 54`。

| 子节 | 叶子数 | 现状 | 说明 |
|---|---|---|---|
| 83 Functions for accessing devices, networks and connections | 4 | 85 partial，其余 none | 84 是"打开 Devices & networks 编辑器"（**前置 D 界面，不做**） |
| 88 Functions on networks | 31 | **全 none** | 其中 **11 条是写**（89/94/99/100/101/103/107/110/111/112/118），**20 条是读** |
| 120 Functions on devices | 9 | 127/128 done，121 partial | 122（TypeIdentifier）**可直接读器件型谱**，见 U8 |
| 130 Functions on device items | 18 | 136/137 done，131/138 partial | 143 地址、144/145 HW 标识、146 通道是"硬件组态信息"的主力 |

原注释把这整片归为"硬件组态**写**属另一量级工程"（id 88），这个判断对**写**成立，
对**读**不成立：`NetworkInterface` 已经暴露 `Nodes / IoControllers / IoConnectors / TransferAreas / Ports`
四个组合（§4），读侧不需要 AML 也能拿到。

### 1.3 C 组：分散的硬件相关条目（15 条）

| id | 条目 | 现状 | 建议桶 |
|---|---|---|---|
| 22 | Hierarchy of hardware objects of the object model | na | 保持 na（参考文档，是读侧的层级图） |
| 60 | Configurable attributes of a port-to-port connection | none | **P1**（与 114/115 同批） |
| 174 | Accessing parameters of an online connection | partial | 不动（已用到 Subnet/Node 读） |
| 175 | Accessing fingerprint for quick station compare | none | **不确定**（U9：与 AML 哈希二选一） |
| 176 | Accessing CM DP as DP slave and transfer area | none | P2（DP 组态读） |
| 181 | Downloading PC System | none | 不做 |
| 182 | Downloading hardware and software components to PLC device | partial | 不动（硬件下载未验，与读无关） |
| 192 | Uploading hardware, software and files to PLC device | none | P2（**从设备读**硬件组态，需实机 P） |
| 194 | Comparing PLC hardware | none | P2（在线比较，需 P） |
| 200 | Setting a display password | none | 不做 |
| 201 | Supporting IP Accessibility | none | **不确定**（设备属性读写边界） |
| 202 | Updating module description | none | P2（`ModuleDescriptionUpdater`，GSD/固件升级后刷新） |
| 288 | Openness for CP 1604/CP 1616/CP 1626 | none | 不做（需真实通信处理器） |
| 289 | Openness transfer areas for PnPn coupler | none | P2 |
| 290 | Openness virtual modules/submodules for ET 200SP PN HF | none | P2 |

---

## 2. 三个桶

### 2.1 必须做（P0）——最低交付

| id | 要做的事 |
|---|---|
| **394** Export of CAx data | 新控制器操作 `ExportHardwareConfig` + DSH 工具 `export_hardware_config`：`project.GetService<CaxProvider>()` → `Export(project, amlFile, logFile)`。默认落在 `<output_dir>/hardware.aml`，回报 `aml_path / aml_bytes / sha256 / log_path / log_excerpt / duration_ms`。 |
| **398** Exceptions | CAx 异常归一成稳定错误码（沿用 `ControllerException` 口径），至少区分：`cax_export_failed`、`cax_not_available`（`GetService` 返回 null）、`cax_log_reported_error`（Export 返回 false 但无异常）。 |
| **385** 章节汇总 | 在 `matrix-data.mjs` 把该章节从 `none` 改为 `partial`，并写明**只做了工程级导出**、导入未做。 |

注意矩阵维护的三条硬约束（`packages/dsh-tia-openness-v17-min/AGENTS.md` §1）：
新增 `using Siemens.Engineering.Cax` 会让 `matrix:check` 要求该章节不再全标 none；
新增 `OperationCatalog` 条目必须同步 `src/protocol.ts` 的 `OPERATIONS`；
`npm run matrix:build` 必须重跑。

### 2.2 应该做（P1）——让"读取硬件组态信息"名副其实

两条技术路线，**建议 P1 先做 (b)**，理由是成本低、无需解析 XML，且能直接回答"这个 PLC 是什么型号、有哪些模块、地址是多少"：

**(a) AML 解析路线**（把 `hardware.aml` 变成结构化字段）
386 / 388 / 389 / 390 / 423 —— 需要 AML(CAEX) 解析器 + 字段映射表。
产物是"文件 + 解析摘要"，解析器要能容忍 TIA 版本差异（矩阵 302「没有按 ML 版本分支」的同类问题）。

**(b) 对象模型读取路线**（不落盘、直接读属性）
- 设备/模块型谱：**122**（`HardwareObject.TypeIdentifier`）、121
- 地址与通道：**143**（`DeviceItem.Addresses`）、**146**（`DeviceItem.Channels`）、**86**（受 **R6**：压缩地址不支持）、**87**
- 硬件标识：**144**、**145**（`HwIdentifierController`——与块里引用的 HW ID 对得上）
- 接口属性：**139**（I/O device interface）、**140**（`IoController`）、**141**（`IoConnector`）、**138**
- 网络/拓扑读侧（20 条里挑核心）：**90/91/93**（子网）、**95**（参与者）、**96/102**（IO 系统）、
  **97/98**（节点）、**104/105/106**（控制器/连接器归属）、**108/109**（DP / PROFINET 系统）、
  **113/114/115**（端口互联）、**60**、**117**
- 拓扑导出：**401**；地址/通道是否进 AML：**405/406**

**(c) 两者都要时可交叉校验**：AML 是"交付物"，对象模型读数是"解释物"，两者对不上就是 TIA 侧有未导出对象。

### 2.3 明确不做（本轮读场景）

- **写/导入侧**：395、397、400、402、404、408、410、415、418；
  网络写 11 条：89、94、99、100、101、103、107、110、111、112、118；
  设备写：126（创建设备）、129（删除设备）、132、133、134、135（插/移/复制/删设备项）。
- **无 API / 需界面 / 需真实硬件**：84（Devices & networks 编辑器，前置 D）、147（.psc，**R10** 不能分步）、
  288（CP 1604/1616/1626）、181（PC System 下载）、200（显示密码）。
- **属别的数据面而非硬件组态**：149 与 314 两个 HMI 子树的 49 条（画面/标签/连接/报警），
  以及 55（工程图形）。HMI **设备本身**会出现在 AML 里，但那是 394 的产物，不需要 HMI 数据面。

---

## 3. 不确定项（10 条；U1–U5/U7/U10 已消解，U6/U8/U9 待定）

| # | 不确定的是什么 | 状态 | 依据 |
|---|---|---|---|
| **U1** | 项目级 `Export(Project, …)` 的产物形态；第二个 `FileInfo` 是什么 | **已消解** | 手册 "Export of CAx data"：`ExportFilePath = "Full Export file path of AML file"`、`LogFilePath = "Full file path of Log file"`。**单个 AML + 一个日志**，文件名由调用方决定。实测确认：`globalHardware.aml` 与 `globalHardware.log` 一对。 |
| **U2** | 是否要 `ExclusiveAccess` / 是否要求先 `Save` | **已决策并实测** | 用户定：启用独占访问、不 Save。实测 3 次：独占访问内导出成功，工程 `isModified:false` 未被改动。 |
| **U3** | 覆盖面：HMI、驱动、GSD、用户组内设备 | **已消解** | 用户组内设备**照常导出**（日志逐台出现 `Cav_A`/`IO_Cav_B`…，`deviceCount` 18）；HMI 被跳过并在日志写明（`device HMI_1 is being skipped … TypeIdentifier is invalid or missing`）。与手册一致：HMI（除按键面板）与驱动不在 CAx 范围内。 |
| **U4** | 耗时与体积 | **已消解** | SWT2（437 MB / 1155 块）：**1.47 MB AML / 86 s、100 s、60 s**（第 1、2 次含冷启动，第 3 次 TIA 已预热）。CAx 与块数关系不大，与设备/子网数相关。 |
| **U5** | headless 是否弹对话框 | **已消解** | 三次无界面运行全部跑完、无阻塞；导出期间无对话框。 |
| **U6** | **R12/R13 在导出侧的影响**：`Manufacturer`、`ProductDesignation` >54 字符、`Length=0` 地址 | 待定 | 需按字段核对产物 AML。日志里的 `Unsupported attributes … Failsafe_FSourceAddress, PlantDesignation, LocationIdentifier …` 说明**部分对象属性确实导不出**，但那是 AML 的属性面限制，不是 R12 的 `Manufacturer`。 |
| **U7** | AML 是否原生含 IO 地址与通道级数据 | **部分消解** | 产物结构：1 个 `InstanceHierarchy`、442 个 `InternalElement`、1041 个 `ExternalInterface`——设备/子网/端口的层级是完整的。地址与通道的具体呈现仍需解析确认（`Export` 无 options 参数，405/406 的"开关"假设不成立）。 |
| **U8** | AML 解析 vs 对象模型，哪条更准更全 | 待定 | 需同一设备两路各取一遍做字段 diff（属于 P1）。 |
| **U9** | "组态是否变化"用设备指纹还是 AML 的 SHA-256 | 待定 | 设备级用指纹（175），工程级用 AML 哈希（已回报 `sha256`）。注意实测三次哈希并不相同（1470081 / 1470080 字节），说明 AML 里含时间戳/序列号，**不能直接当"组态未变"的判据**——这条是个真发现。 |
| **U10** | `GetService<CaxProvider>()` 是否非 null | **已消解** | 三次都返回非 null。null → `cax_unavailable` 仍是代码路径。 |

**另外三条"条目归属"层面的不确定**（不影响 P0）：
- 393 与 148 标题几乎相同（`Connection handling for extension racks`），是否重复建模；
- 420/421（F 设备 AML）与既有 `safety_*` 能力是否该合并成一个主题；
- 416 是"组条目（6 条）"，其 6 个子条目（417–422）是否应独立成"AR/APC 属性"主题。

### 3.1 实测中改掉的三个设计错误

真机跑通之前，实现里有三个判断是错的，只有跑过才知道：

1. **`Export` 的 `false` 不是"失败"**。第一次跑返回 `false`，我按失败抛了 `cax_export_failed`，
   但产物是完整的 1.47 MB CAEX 文档，日志结尾 `completed (errors: 1, warnings: 0)`，
   唯一那条 error 是 HMI 被跳过。现在：`false` + 合法文件 = **部分成功**（`ok:true`、
   `allObjectsExported:false`、`logProblems[]` 逐条列原因），只有"没有文件"或"文件不合法"才算失败。
2. **日志摘录取头部是错的**。TIA 的日志 108 KB，头部全是逐对象进度，结论与 ERROR 在**末尾**。
   改成取尾部 4000 字符 + 结构化解析 `(errors: N, warnings: M)` + 抽出 ERROR 行去重。
3. **`deviceCount` 用 `Project.Devices.Count` 是错的**：本项目返回 **1**，而实际导出 18 个设备
   （其余都在用户组里）。改成三路遍历（扁平 + 未分组系统组 + 递归用户组）、按名去重。

---

## 4. API 实证（V17 反射，`Siemens.Engineering.dll`）

反射方式：`ReflectionOnlyLoadFrom` + `ReflectionOnlyAssemblyResolve`（`PublicAPI\V17` 只有
`Siemens.Engineering.dll` 与 `Siemens.Engineering.Hmi.dll`，其余依赖需按名解析）。

```
Siemens.Engineering.Cax.CaxProvider            (命名空间仅 3 个类型)
  Export(Device       deviceToExport,   FileInfo exportFilePath, FileInfo logFilePath) -> Boolean
  Export(Project      projectToExport,  FileInfo exportFilePath, FileInfo logFilePath) -> Boolean
  Export(ProjectBase  projectToExport,  FileInfo exportFilePath, FileInfo logFilePath) -> Boolean
  Import(FileInfo importFilePath, FileInfo logFilePath, CaxImportOptions importOption) -> Boolean

Siemens.Engineering.Cax.CaxImportOptions       (enum)
  MoveToParkingLot | OverwriteTiaDevice | RetainTiaDevice
  # 没有 CaxExportOptions —— 导出无可选参数

CaxProvider 取得方式：CaxProvider : IEngineeringService
  ProjectBase.GetService<T>()   ← Project 继承自 ProjectBase
  Device.GetService<T>() / DeviceItem.GetService<T>() / Subnet / Node / PlcSoftware … 均有
```

配套但本轮未接线的类型（说明"后续增量有现成 API，不必猜"）：

| 命名空间 | 类型 | 用途 |
|---|---|---|
| `HW.Utilities` | `ModuleInformationProvider` | `FindModuleTypes` / `FindContainerTypes` / `GetTypeIdentifierNormalized`——按型谱查模块 |
| `HW.Utilities` | `OpcUaExportProvider` | `Export(DeviceItem, FileInfo)`——OPC UA 导出（与 189 相关） |
| `HW.Utilities` | `CardReaderPscProvider` | .psc（受 **R10**） |
| `HW.Features` | `GsdDevice` | `GsdId / GsdName / GsdType / IsProfibus / IsProfinet`——第三方设备识别（U3） |
| `HW.Features` | `NetworkInterface` | `Nodes / IoControllers / IoConnectors / TransferAreas / Ports / InterfaceType` |
| `HW.Features` | `AddressController` / `HwIdentifierController` / `NetworkPort` | 地址、HW 标识、端口（143/144/145/115） |
| `HW.Extensions` | `PlugLocation` | `HardwareObject.GetPlugLocations()`——插槽位次 |
| `HW.CustomDataTypes` | `StructuredData` / `TableData` | AML 内厂商结构化参数（**R12** 相关） |
| `HW.Systemdiagnostics.Settings` | `SystemdiagnosticsSettingsDataProvider` | 系统诊断设置导入导出 |
| `HW` | `HardwareObject` | `TypeIdentifier` / `Name` / `Items` / `DeviceItems` / `HwIdentifiers` |

---

## 5. 落地顺序（P0 已完成，见 §7）

1. ~~**P0 一步到位**~~ **已完成**：`ExportHardwareConfig` 操作 + `export_hardware_config` 工具。
   按用户决策**不做** `dry_run`、**不做** `scope: project|device`（只做工程级）、**启用独占访问**、
   **不 Save**。矩阵已同步（385/394/398 → partial）并 `matrix:build` 通过。
   剩下只有真机验证：跑一次 SWT2，把 U4/U5/U6/U7/U10 消掉，结果写回 §3。
2. **P1 走 (b) 对象模型路线**：`hardware_info` 工具（或扩 `project_info` 的 `hardware` 段），
   一次性把 121/122/139/140/141/143/144/145/146 + 网络读侧 90/95/96/97/98/113/114/115 接出来。
   这一步做完，"读取硬件组态相关信息"才算真的可用（AML 只是落盘证据）。
3. **P2 按需求再扩**：403（单设备 AML）→ 401（拓扑）→ 409（GSD）→ 192/194（需实机）。
4. 每步都有一条硬约束：矩阵状态与代码引用必须同步，否则 `npm run check` 会失败
   （`matrix:check` 会拦"引用了命名空间却全标 none"和"标了 done 却没引用"两种过期）。

---

## 6. 本文件没有做的事

- **不评估 HMI 数据面**（149/314 共 49 条）——那是独立主题，与本需求无关。
- **没有真机数据**：§3 里仍标"待实测"的项，只有在真实项目上跑过一次 `export_hardware_config` 才有答案。
  在跑完之前不要把本插件说成"已在 V17 上验证过硬件导出"。

---

## 7. 已交付（v0.3，2026-11-02）

| 层 | 位置 | 内容 |
|---|---|---|
| 控制器操作 | `controller/OperationsHardware.cs`（新） | `ExportHardwareConfig`：`project.GetService<CaxProvider>()` + `Export(project, aml, log)` |
| 独占访问 | `controller/OpennessHost.cs` | 新增 `BeginExclusiveAccess` + `ExclusiveAccessScope`（**只有独占，没有事务**——读操作不要 undo 单元） |
| 白名单 | `controller/Protocol.cs` + `src/protocol.ts` | `ExportHardwareConfig`（第 34 个操作），两侧顺序一致；`controller/SelfTest.cs` 的精确白名单同步 |
| 工具 | `src/tools.ts` | `export_hardware_config`：默认 `<workspace>/hardware/globalHardware.aml`，`output_dir` 可覆盖，相对路径按 workspace 解析 |
| 工作区解析 | `src/dsh-runtime.d.ts` | `ToolRunContext` 补 `agent.session.header.cwd`（与 `commands.ts` 读同一事实） |
| 矩阵 | `scripts/coverage/matrix-data.mjs` + 重新生成的 HTML | 385 → partial；394 `Export of CAx data` → partial；398 异常 → partial |
| 文档 | `README.md` §4/§8/§10、`docs/PROTOCOL.md`、`docs/EXTENDED-SURFACE.md` §23 | 工具表、错误码、边界、协议契约 |

设计取舍（与 §2.1 的原计划相比）：

- **去掉 `dry_run`**：导出不写工程，预演只会回显调用方自己的入参，属于决策 D22 里"预览不带信息量"的那类；
- **去掉 `scope: project|device`**：用户要求的是工程级单文件；设备级 `Export(device, …)` 留作 P2（403）；
- **不 Save、不包事务**：导出是只读，Save 会顺手改工程；事务对只读无意义，还要踩手册的事务禁区；
- **产物回读校验**：`bytes` / `sha256` / `rootElement` 三项，缺 `CAEXFile` 根元素即 `verification_failed`，
  避免"TIA 说成功但文件是空的"这种假成功。

未做（明确留给后续）：AML 解析、设备级导出、拓扑/子网/IO 系统导出、导入方向。

### 7.1 实测记录（2026-11-02，`PEI_SinoARP_SWT2`）

用 `--stdio` 直接驱动控制器跑了三轮（OpenProject → ExportHardwareConfig → CloseProject），
工程只读、三次都以 `isModified:false` 关闭：

| 轮次 | 耗时 | 产物 | `allObjectsExported` | 结论 |
|---|---|---|---|---|
| 1（冷启动） | 100.2 s | 1 470 081 B / `CAEXFile` | false | 被误判为失败（见 §3.1） |
| 2（TIA 已起） | 86.2 s | 1 470 081 B / `CAEXFile` | false | 修好后 `ok:true` + `logProblems:[HMI_1]` |
| 3（已预热） | 59.7 s | 1 470 080 B / `CAEXFile` | false | `deviceCount` 修正后为 18 |

产物内容：1 个 `InstanceHierarchy`、442 个 `InternalElement`、1041 个 `ExternalInterface`。
日志：108 KB，结尾 `Exporting of the CAx data is completed (errors: 1, warnings: 0)`，
唯一 ERROR 是 `device HMI_1 is being skipped. The required attribute TypeIdentifier is invalid or missing.`

**注意**：三次的 SHA-256 与字节数并不相同（1 470 081 / 1 470 080），说明 AML 里含
时间戳或序号，**同一工程两次导出不会得到相同哈希**——所以不要把"AML 哈希相同"当作"组态未变"的判据（U9）。

### 7.2 GUI 端到端测试（2026-11-02，`session-2780b421`）

真实测法：**不点名工具**，只给一句自然语言——"帮我分析当前项目的硬件组态，看看里面包括哪些 hardware，
网络拓扑是怎样的"，工作区 `...\dsh-automation-suite\SWT2_PEI_1026_Night`，会话 preset = `leader`。

结果：**成功**，agent 自己走完了整条链：

1. `knowledge_workspace` / `project_status`（发现工程没打开）→ `open_project`（102 s）；
2. **第 3 步就自己选中了 `export_hardware_config`**——第一个 thinking 里写着
   "export_hardware_config is available to me (leader)"，说明工具列表本身就足以发现，**不需要 skill 指路**；
3. 导出 41.8 s / 1 470 084 B，之后 `online_targets` 取拓扑、`project_info` 交叉核对设备清单；
4. 自己写了 3 个 Python 脚本解析 AML（`parse_aml.py` / `parse_devices.py` / `count_io.py`），
   产出 `aml_outline.txt`（593 行）、`aml_devices.txt`（265 行）与 13 KB 的 `HARDWARE-ANALYSIS.md`；
5. 正确处理了 `allObjectsExported:false`（"唯一缺口是 HMI_1"），并主动声明
   "端口到端口的物理连线 CAx 不导出，我没有替它推断"。

**测试推翻了本文件与工具描述里的两处措辞**（已改）：

- ❌ 原文写"CAx 不能导出驱动"→ 实测**驱动是导出的**：17/18 台设备进 AML，含 2× SINAMICS V90 PN 与
  3× 汇川 SV660F（GSDML），只跳过了 `HMI_1`。现在的口径是"手册清单不能当预测用，丢失以 `logProblems` 为准"。
- ❌ U3 标"GSD 设备是否导出不确定"→ **确定导出**（AML 里 59 处 `GSD:GSDML`）。
- ✅ U7 补上答案：AML 原生含 `LogicalAddress`（byte.bit，如 `<Value>32.6</Value>`），
  所以 I/O 地址可以从文件本身映射出来，不需要额外 API。

**独立复核**（不采信 agent 的结论，自己查产物）：442 个 `InternalElement`、CPU 订货号 `6ES7 515-2FM01-0AB0`
存在、F 模块计数 F-DI 5 / F-DQ 4 / F-AI 1 / F-RS 2 与报告一致、通道合计 192+192+86+2=472 与逐站表自洽。

**环境层面的两处损耗**（与插件无关，但会拉长测试时间）：

- 两轮对话因模型提供方 `opencode-go` 连续 `EMPTY_RESPONSE` 各重试 5 次后失败，
  用户 1 小时 39 分后才发 `retry`——**单次真实测试的墙钟时间主要花在这里，不是导出**；
- `python` 在本机是 Microsoft Store 占位符，agent 试了 3 步才发现要用 `py`。

**一处诊断措辞的问题**（未改，留待下次重建控制器时一并处理）：`safety_status` 在服务为 null 时说
"A standard (non-failsafe) CPU does not have one"，而这个工程的 CPU 恰恰是 1515F-2 PN——
agent 因此把"F-CPU 却没有安全服务"报成矛盾点。措辞应改成两种可能，而不是断言一种原因。

---

## 8. AML 结构与"哪些能力该做成工具"（2026-11-02 实测 `globalHardware.aml`）

判断依据全部来自那 1 份真实产物（442 个 `InternalElement` / 1 470 084 B），不是推测。


### 8.2 已被实测确认的层级模型

```
InstanceHierarchy (Name="APC Sample Instance Hierarchy")
└─ InternalElement (Name=<工程名>)                        ← 顶层
   ├─ InternalElement (PN/IE_1)      Attribute Type=Ethernet + LogicalEndPoint_Subnet   ← 子网
   ├─ InternalElement (PEI_SinoARP)  …嵌套用户组（SubModule / Servo / Others）
   │  └─ InternalElement (COF-BASE-A)   TypeIdentifier=System:Device.ET200SP            ← 设备
   │     └─ InternalElement (Châssis_0) TypeName=Rack, PositionNumber=0                 ← 机架
   │        └─ InternalElement (200MOD4) PositionNumber=3, TypeName=F-DQ …, TypeIdentifier=OrderNumber:6ES7 …
   │           └─ InternalElement (200MOD4)  PositionNumber=1, BuiltIn=true             ← 子模块
   │              ├─ Attribute Address → { 1: {StartAddress,Length,IoType}, 2: {…} }    ← I/O 地址组
   │              └─ ExternalInterface Channel_DO_0 … RefBaseClassPath=…/Channel        ← 通道
   │                 { Type=Digital, IoType=Output, Number, Length }
   └─ InternalElement (Sino_PEI)     TypeIdentifier=System:Device.S71500                ← PLC
      └─ Interface PROFINET_1 (Label=X1, PositionNumber=32768)                          ← 网口
         ├─ E1  { NetworkAddress, SubnetMask, ProfinetDeviceName, IpProtocolSelection, Type=Ethernet }
         │   └─ LogicalEndPoint_Node
         ├─ PROFINET IO-System  { Number }  + LogicalEndPoint_IoSystem
         └─ Port_1 … Port_N     { Label=P1 R } + CommunicationPortInterface
```

另外两类 `ExternalInterface`：`…/Tag` 500 个（PLC 侧带 `LogicalAddress` 的 IO 接口，如 `32.6`）、
`…/Channel` 472 个（模块通道）。

### 8.3 AML 里没有、但**对象模型里有**的东西（2026-11-02 反射实证）

AML 缺这几样，不代表 Openness 缺。差别在于：AML 是**文件**，这些是**对象模型**，必须打开工程现读。

| 想拿 | AML | 对象模型接口（`Siemens.Engineering.HW.*`） | 置信度 |
|---|---|---|---|
| 端口到端口连接 | 无（0 命中） | `NetworkPort.ConnectedPorts : NetworkPortAssociation`；`NetworkPort.Interface`；`DeviceItemFeature.OwnedBy` 回溯所属设备项 | 反射确认 |
| 环网 / MRP 域 | 无 | `MrpDomainOwner.MrpDomains`（`MrpDomainComposition`）→ `MrpDomain.Name` + `MrpDomain.DomainParticipants`（`NetworkInterfaceAssociation`） | 反射确认 |
| 节点 / 子网归属 | 有（`E1`+`LogicalEndPoint_Node`） | `Node.Name` / `NodeId` / `NodeType` / `ConnectedSubnet` | 两者都有 |
| IO 系统 | 有（`PROFINET IO-System`） | `IoSystem.Name` / `Number` / `ConnectedIoDevices` / `HwIdentifiers` | 两者都有 |
| 端口属性（速率/双工/介质） | 部分（`Label=P1 R`） | `NetworkPort` 继承 `HardwareFeature`，走 `GetAttributeInfos()` / `GetAttribute(name)`，**没有 typed 属性** | 属性级 |
| **MAC 地址** | 无（0 命中） | **没有 typed 属性**（`DhcpSupportedMode.MacAddress` 只是枚举值）；只能靠 `GetAttributeInfos()` 在运行期找属性名 | 待实机确认属性名 |
| GSD 身份 | 有（`GSD:` 前缀的 `TypeIdentifier`） | `GsdDevice` / `IGsdObject`：`GsdId` / `GsdName` / `GsdType` / `IsProfibus` / `IsProfinet` | 反射确认 |
| **GSD 原始参数块** | 无 | `GsdDeviceItem.GetPrmData(int, int, int) -> byte[]`、`SetPrmData(int, int, IEnumerable<byte>)` | 反射确认，**三个 int 的语义待实机** |
| 厂商结构化参数 / 参数表 | 无（`StructuredData` / `TableData` 各 0） | `StructuredData` / `StructuredDataComposition` / `TableData.Rows`，经 `IEngineeringObject.GetComposition(name)` 访问；组合名要运行期用 `GetCompositionInfos()` 发现 | 反射确认 |
| 模块参数（通用） | 部分（模块属性） | `HardwareFeature.GetAttributeInfos()` / `GetAttribute(name)`（本插件 `project_info` 已用同一机制） | 已在用 |
| 类库 / 角色模型 | 无 | — | 与需求无关 |

**结论**：T7 / T8 不是"做不了"，而是**换一条路**——AML 路线不需要打开工程、可离线重复读；
对象模型路线必须 `open_project` 且要遍历 `DeviceItem` 的服务。两条路的产物形态也不同：
AML 是一个可归档的文件，对象模型是一次性的读数（要落盘得自己序列化）。

因此工具化应分成两组：**AML 只读组**（T1–T4，离线、快）与**对象模型组**（T9 拓扑 / T10 GSD 参数，需打开工程）。

### 8.4 候选能力清单

| # | 用户会问 | AML 依据 | 现在的做法 | 建议 | 优先级 |
|---|---|---|---|---|---|
| **T1** | 这项目有哪些设备？型号、订货号、IP、PROFINET 名、属于哪个组 | 设备 = `TypeIdentifier` 且子树含 Rack；`TypeName`/`TypeIdentifier`；`E1` 的 `NetworkAddress`/`SubnetMask`/`ProfinetDeviceName` | 每次现写脚本扫 442 个元素 | **做成工具**（`hardware_summary` 的 devices 段） | 高 |
| **T2** | 每个站有哪些槽、什么模块、订货号、几个通道 | rack=`TypeName="Rack"`；模块=rack 子元素（`PositionNumber`+`TypeName`+`TypeIdentifier`）；通道=`…/Channel` 的 `Type`/`IoType`/`Number`/`Length` | 同上的第二个脚本 | **做成工具**（`hardware_modules`） | 高 |
| **T3** | 几个子网、谁在哪个网、IO 系统、地址规划是否冲突 | 子网=项目下 `Type=Ethernet` + `LogicalEndPoint_Subnet`；节点=`E1` 的 `NetworkAddress` + `LogicalEndPoint_Node`；IO 系统=`PROFINET IO-System` + `LogicalEndPoint_IoSystem`；网口=`Interface PROFINET_N`（`Label` = X1/X2） | `online_targets`（那是**在线可达**，不是组态） | **做成工具**（`hardware_summary` 的 network 段） | 高 |
| **T4** | 每模块/每通道的 I/O 地址（`%I`/`%Q`） | 模块的 `Address` 组 `{StartAddress, Length, IoType}`；通道只有 `Number`/`Length`，地址要按 `StartAddress` + 偏移推 | 第三个脚本 + 手工 | 可选工具 `hardware_io_map` | 中 |
| T5 | 固件版本、安装日期、多语言注释、F 参数 | `FirmwareVersion`/`InstallationDate`/`Comment`(`aml-lang=`)/`Failsafe_*` | 脚本 | **并入 T1/T2 字段**，不单独开工具 | 中 |
| T6 | PLC 侧 IO 标签与地址 | `…/Tag` 接口 + `DataType`/`IoType`/`LogicalAddress`（500 条） | — | **不建议**：与 `list_plc_objects`（标签表）重复，AML 里这份是 IO 接口镜像 | 低 |
| T7 | GSD 厂商参数 | 文件里没有 | — | **对象模型可做**：`GsdDeviceItem.GetPrmData` + `StructuredData` 组合，需打开工程（见 §8.3） | 中 |
| T8 | MAC / 端口连线 / 环网 | 文件里没有 | — | **对象模型可做**：`NetworkPort.ConnectedPorts` / `MrpDomain` / `GetAttributeInfos`（见 §8.3） | 中 |

### 8.5 接口形态建议

T1–T4 都是**读已经导出的那个文件**，调用时**不需要 TIA**（控制器不用开工程，甚至在工程关闭后也能跑）。
所以它们应当是"AML 只读查询"，而不是新的 Openness 操作：

```jsonc
hardware_summary({ aml_path?, refresh? })   // → { project, devices[], networks[], counts }
hardware_modules({ device?, aml_path? })    // → { devices:[{ device, rack, modules:[{slot,name,type,orderNumber,channels,address}] }] }
hardware_io_map({ device?, aml_path? })     // 可选 → 每站/每模块/每通道的 StartAddress+Length
```

`aml_path` 省略即用 `<workspace>/hardware/globalHardware.aml`；`refresh:true` 先调一次导出再解析。
实现落点建议在**控制器 C#**（`System.Xml.Linq` 已在 csproj 里，不必引第三方依赖），
TS 侧只加工具壳；工作量约 500–700 行 C# + 130 行 TS + 单测，属于一次专注会话的量级。

---

## 9. 产物与脚本的管理规则（约定）

真实测试里出现的问题：agent 把 `parse_aml.py`、`parse_devices.py`、`count_io.py`、`aml_outline.txt`、
`aml_devices.txt` 和报告全写进了 `hardware/`，把"工具产物目录"变成了草稿纸。

### 9.1 三层分工

| 目录 | 只放什么 | 谁写 | 可丢弃？ |
|---|---|---|---|
| `<workspace>/hardware/` | **工具产物**：`globalHardware.aml` + `globalHardware.log` | 只有 `export_hardware_config` | 是（可随时重导出） |
| `<workspace>/temp/` | **一次性脚本与中间转储**：`*.py` / `*.ps1` / `*.txt` / `*.json` | agent 按需 | 是（测试完即可删） |
| 工作区根或用户指定路径 | **交付物**：分析报告（`*.md`）等 | agent | 否 |

### 9.2 判定规则

1. **先问"这是不是常用能力"**：是 → 用工具，**不写脚本**；不是 → 写脚本，但放进 `temp/`。
2. **`hardware/` 里出现脚本或中间文件 = 违规**：那里只认工具产物，别的都不许放。
3. **交付物不进 `temp/`**：`temp/` 视为可随时删除，报告放工作区根或用户指定位置。
4. **脚本命名带主题前缀**（如 `hardware-parse-devices.py`），一件脚本一件事，便于复用和清理。

### 9.3 执行面（规则写在模型看得见的地方）

- `export_hardware_config` 的工具描述里写明：该目录**只**放导出产物，派生脚本进 `temp/`；
- `skills/tia-openness/SKILL.md` 的「硬件组态怎么读」一节里写明同样的规则；
- 两个工作区的 `.gitignore` 都忽略 `/hardware/` 与 `/temp/`。