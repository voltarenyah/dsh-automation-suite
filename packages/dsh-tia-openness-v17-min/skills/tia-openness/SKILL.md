---
name: tia-openness
description: Troubleshooting index for the tia-openness-v17-min tools: project lifecycle/data, PLC blocks/types/tag tables/tags/watch+force tables/units, F-safety settings and signatures, hardware-configuration (CAx/AML) export, controller_status. Load it when one fails or reports an Openness error, or before answering any TIA Portal Openness question (exclusive access, transactions, Simatic ML round trip, block groups, compile, licensing, threading, crashes). Maps symptoms to vendored Siemens skill files.
---

# TIA Portal Openness 知识库（路由 skill）

本 skill 只是**索引**。真正的知识是 base directory 下 31 个上游 skill 的逐字副本
（Siemens AG，仓库 `siemens/tia-portal-ai-extensions`，commit `b5c7041`，MIT —— 见同目录
`UPSTREAM.json`）。本文件由本仓库维护，其余文件是上游原文，**不要手改**。

## 谁说了算（别把两边搞混）

| 问题 | 权威来源 |
|---|---|
| 这个插件能做什么、参数与返回结构、错误码、已验证边界 | 本包 `docs/PROTOCOL.md`、`docs/OUTPUT-CONTRACT.md`、`docs/verification.md`、`README.md` §10「已知边界」 |
| TIA Portal Openness 本身的语义（对象模型、事务、异常、性能、线程、License） | base directory 下的 `blocks/SKILL.md`、`engineering-objects/SKILL.md` 等上游文件 |

⚠️ **版本口径**：上游面向 TIA Portal **V21**（modular assemblies、`.s7dcl`/`.s7res`、LTS 链重启都是 V21
语义），本插件只做 **V17** 的块级读写。凡上游提到 V21 专有 API 的段落，在 V17 上**不成立**；反过来，
V17 的行为也不能从 V21 文本直接推。判不准时以本机 V17 实测或本包 `docs/` 为准，并明确说出这是推断。

## 先读这两个

- `openness-overview/SKILL.md` —— 上游自己的总索引（"该用哪个 skill"）。
- `openness-base/SKILL.md` —— 所有 Openness 开发的共同前提：SDK DLL 用**注册表**定位（不要扫盘）、
  `TypeIdentifier`、以及"命名空间不是全在 `Siemens.Engineering`"这个高频踩坑点。

## 症状 / 任务 → 该读哪个文件

| 症状或任务 | 读 |
|---|---|
| 应用被 TIA 拒绝、`LicenseNotFoundException`、Openness 防火墙、需要什么授权 | `licensing-and-firewall/SKILL.md` |
| 跨线程异常、后台服务或 MCP 式并发调用、Apartment 规则 | `threading-and-concurrency/SKILL.md` |
| 调用很慢、深层对象链循环、要不要缓存、批量属性读写 | `performance-and-caching/SKILL.md` |
| 调用过程中 TIA 进程直接消失、要按面包屑定位崩溃点 | `crash-diagnosis/SKILL.md` |
| 判断"和上次比变了什么"、要不要重编译/重下载、库类型版本 | `change-detection/SKILL.md` |
| 打开/关闭/attach 已运行实例、归档、项目生命周期 | `session-and-project/SKILL.md` |
| 工程语言、工程注释（多语言文本）、工程历史、TIA Portal 设置项 | `engineering-objects/SKILL.md`、`session-and-project/SKILL.md` |
| 块导出/导入/编译、块口令保护、InstanceDB/GlobalDB 接口成员、交叉引用 | `blocks/SKILL.md` |
| 要在 TIA 里**打开**程序块编辑器（按名单批量把块显示出来） | 本包 `show_blocks_in_editor`（工具描述即契约）；底层是 `IShowable.ShowInEditor()`，**必须带界面**的 TIA Portal，无界面实例报 `editor_unavailable`，补救是 `close_project` 后 `with_window=true` 重开 |
| 块/UDT 的指纹（FingerprintProvider）与"变了什么" | `change-detection/SKILL.md` |
| `PlcSoftware` 下的组层级（BlockGroup/TypeGroup/TagTableGroup/ExternalSourceGroup） | `software-hierarchy/SKILL.md` |
| 独占访问与事务、属性读写、`GetService` 模式、对象树导航 | `engineering-objects/SKILL.md` |
| 不知道 schema 也要遍历/比对两棵对象树 | `object-tree-walking/SKILL.md` |
| UDT（`PlcType`）XML 结构、成员属性格式、递归搜索 | `plc-data-types/SKILL.md` |
| PLC 变量与变量表、XML 往返、PLC 常量、监视表/强制表 | `tags-and-tagtables/SKILL.md` |
| SW-Unit（`PlcUnit`）里找元素、往正确组里建元素、InstanceDB 归属 | `sw-units/SKILL.md` |
| 由块/UDT 生成 SCL/STL 源文件（`GenerateSource` 的扩展名规则） | `blocks/SKILL.md`、`tags-and-tagtables/SKILL.md` |
| 想先小步验证、在 CI 或真实 TIA 上跑集成测试 | `openness-testing/SKILL.md` |
| UMAC 角色/用户/设备权限、项目保护、CPU 保护级别 | `security/SKILL.md` |
| 故障安全 PLC 的 `SafetyAdministration`（`Siemens.Engineering.Safety`） | `plc-safety-administration/SKILL.md` |
| 全局库 / MasterCopy / `.zap` `.zal` / 报警文本列表 / runtime group | `global-library/SKILL.md`、`libraries-and-alarms/SKILL.md` |
| 设备与硬件组态、PROFINET、I/O 系统、模块插拔 | `devices-and-hardware/SKILL.md`、`hardware-and-modules/SKILL.md` |
| **读**硬件组态（有哪些设备/模块/子网/地址）、把组态导出成 AML 去分析 | 本包 `export_hardware_config`（工具描述即契约，先读它）；上游那两个 skill 只回答"要**改**硬件该怎么做" |
| 在线连接与下载到 CPU | `online-and-download/SKILL.md` |
| V21 的 SIMATIC SD（`.s7dcl`/`.s7res`）导出/导入与按网络插入 | `simatic-sd/SKILL.md`（**V17 不适用，仅作对照**） |
| SINAMICS 驱动对象/参数/报文/DCC/DriveCliq、PROFIsafe 调试 | `drive-objects/SKILL.md`、`parameters/SKILL.md`、`telegrams/SKILL.md`、`drive-control-charts/SKILL.md`、`networks-and-drivecliq/SKILL.md`、`safety-commissioning/SKILL.md` |
| 工艺对象（TO，运动控制） | `technology-objects/SKILL.md` |

> 驱动、安全、在线下载、硬件组态这些上游章节回答的是「**Openness 能不能做**」，
> 不是「**这个插件能不能做**」：本插件的 38 个工具覆盖工程生命周期与工程数据、PLC 块/类型/标签表/
> 变量/监视表/软件单元、F 相关服务、块编辑器的批量打开（`show_blocks_in_editor`），以及**硬件组态的只读导出**（`export_hardware_config`，
> 输出一个 CAEX 2.15 的 AML 文件），边界以 `README.md` §10 与 `docs/EXTENDED-SURFACE.md` 为准。

## 硬件组态怎么"读"（本插件只有这一条路）

本插件**不解析** AML：`export_hardware_config` 只负责把工程级硬件组态导出成**一个**文件
（默认 `<workspace>/hardware/globalHardware.aml`，日志同级 `.log`）。要回答"这个项目的硬件组态是什么"，
流程是：

1. `open_project`（没有打开的工程时）；
2. `export_hardware_config`（不传参即用默认路径；实测 SWT2 约 1.47 MB / 60–100 s）；
3. **自己解析那个 XML**：它是 CAEX 2.15 且**没有 class library**——442 个 `InternalElement` 的
   `RefBaseClassPath` 全为空，靠 `TypeIdentifier` 前缀（`System:Device.` / `OrderNumber:` / `GSD:`）
   加 `TypeName`、`PositionNumber`、`DeviceItemType` 认设备/机架/模块。设备在 `<InstanceHierarchy>`
   的 `<InternalElement>` 树里，通道与端口是 `<ExternalInterface>`（`…/Channel`、`…/Tag`、
   `LogicalEndPoint`、`CommunicationPortInterface`）。不要试图把整文件塞进上下文。

**产物放哪（强制）**：

- `<workspace>/hardware/` 只放工具产物（`globalHardware.aml` + `.log`），**不放脚本、不放中间文件、不放报告**；
- 一次性解析脚本与中间转储放 `<workspace>/temp/`，命名带主题前缀（如 `hardware-parse.py`），用完可删；
- 交付给用户的报告放工作区根或用户指定位置，**不要埋进 `temp/`**；
- 同一个问题若反复出现（设备清单、槽位表、网络拓扑），那说明它该做成工具——提出来，别再重复写脚本。

⚠️ 三个必须一起说出去的边界：

- **被跳过的设备在 `data.notInAml[]` 里已经给了**：名字、`kind`、原因，以及每个节点的
  `address` / `subnetMask` / `pnDeviceName` / `subnet`——取自工程对象模型，**不是**从 AML 读的。
  HMI 在 CAx 里没有类模型，它的 IP 只在这里出现；**不要去 AML 里找 HMI，永远找不到**。
- **AML 不是完整清单，但手册清单也不是可靠预测**：手册说 CAx 不导出驱动、除按键面板外的 HMI、
  多 CPU 站、端口到端口连接、扩展机架连接、模拟量通道输出模式与量程、压缩地址；**实测 18 台设备只跳过了
  1 台 HMI，17 台全在，含 GSDML 形式的驱动与第三方设备**。所以"丢了什么"看返回值 `logProblems[]`，
  不要按类别假设。
- **`allObjectsExported:false` 不等于失败**：文件仍然完整，只是若干对象被跳过。
- 文件里**没有** MAC、厂商结构化参数、端口到端口物理连线——这三样别承诺。

设备/模块的**修改**（`PlugNew`、`ChangeType`、建子网）本插件没有，那时才去读上游那两个 skill。

## 跨工程取用（另一个 workspace / 另一个项目）

- 读另一个**受管 workspace** 的源树、清单或知识库不需要打开它的工程：绝对路径可用
  （发行版 `docs/reference-project.md` §15 有实测复盘）。
- 导入前先跑 **`import_preflight`**（engineering-context）：它报告语言文化不匹配、依赖缺失/顺序、
  同名对象。它**不查块号**——TIA 在导入时自动分配块号，文件名前缀只是排序，**名字才是身份**。
- 导入时传 `import_blocks(reference="<workspace>@<sha>")` 记出处；提交时
  `project_commit(reference=...)` 会追加 `Reference:` trailer。
- 跨项目导入的失败几乎都来自语言集与依赖顺序，而不是"路径不允许"。

## 怎么读

1. base directory 已由本 skill 的 `<skill_resources>` 给出；上表路径都相对它解析
   （例如 `<base>/blocks/SKILL.md`）。
2. 文件 4–23 KB，**按需加载**：先只读症状对应的那一个；大文件用 `read` 的 `offset`/`limit` 分段读。
3. 上游文件之间用相对链接互引（如 `../openness-testing/SKILL.md`），按同一 base 解析；
   frontmatter 的 `metadata.siemens-depends-on` 列出该主题的前置 skill，可顺着读。
4. 引用上游结论时**标出处**（Siemens AG / `siemens/tia-portal-ai-extensions` / commit `b5c7041`），
   不要把上游的 V21 结论说成是本插件在 V17 上实测过的结果。
