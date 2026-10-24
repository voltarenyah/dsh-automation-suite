# PLCSIM Advanced 接入评估：从「静态编译验证」到「动态运行验证」

> **状态**：评估报告（2026-10-24 定稿）· **全链路已跑通** · 需要两次一次性人工前置 · 未改路线图状态
> **已拍板（用户，2026-10-24）**：独立插件 · 默认 **Softbus** · 范围只做「PLC 程序动态下载执行」。
> **API 兼容结论**：PLCSIM API 不存在「V7 排他」——V7 Runtime 能驱动 API 3.0–7.0 的客户端；按 **API 4.0** 编译可覆盖 PLCSIM Advanced **4.0–7.0**。因此包名**不带版本号**，推荐 `@voltarenyah/dsh-plcsim-advanced`。
> **定稿更新（2026-10-24）**：V17 控制器 + PLCSIM Advanced V7（**TCP/IP**）+ TIA V17 工程的下载已实测跑通；根因不是 API 缺失，而是**工程 PLC 未配子网/IP** + **首次连接未在 TIA UI 接受自签名证书**。V17/V18 确实没有 `TargetForSoftware`，但 V17 路径不需要它；V20 路径也已由另一个会话验证。**§10.7/§10.8 的“Openness 失败”结论作废**，以 §10.9 + 交接文档为准。
> **一句话（定稿）**：程序能通过 Openness 下载到 PLCSIM，但**不是全无人工**——项目级配一次子网/IP，设备级在 TIA UI 接受一次证书，之后 `adopt_open_project` + `download` 可重复执行。

---

## 0. 结论

1. **可行，且已实测跑通**：V17 控制器 + PLCSIM Advanced V7（TCP/IP）+ TIA V17 工程，`adopt_open_project` → `download` → RUN → 标签读写全部成功。
   - 本机 PLCSIM Advanced V7.0 的 API 可初始化、建实例、上电，`LicenseStatus=OK`；按 **API 4.0** 编译的程序驱动 V7 Runtime 通过。
   - 下载使用 **TCP/IP + `Siemens PLCSIM Virtual Ethernet Adapter`**；Softbus 仍可用于纯本机在线，但不是这条下载链路的成功路径。
2. **两个一次性前置，缺一不可**：
   - **项目级**：给要下载的 PLC 分配子网 + 唯一 IP（实测不配时连 TIA UI 都下不了）；
   - **设备级**：首次连接在 TIA UI 接受自签名证书（Openness 无该委托，headless 必败）；
   - 之后用 `adopt_open_project` 接管 UI 打开的工程，`online_disconnect(force=true)` 清残留在线态，再 `download`。
   - 因此这不是“全自动无人值守”，但**每次下载不需要人工**。
3. **已定：独立插件；名字不带版本号。** V7 Runtime 对 API 3.0–7.0 全部可用（本轮实测）；按 API 4.0 编译覆盖 4.0–7.0。推荐 `@voltarenyah/dsh-plcsim-advanced`；只有将来出现真正不兼容的 API 代际，才加 `-vN` 或拆第二构建。
4. **工作量（定稿）**：Phase 0 与运行侧 MVP 均已落地；本轮补齐 PLCSIM 插件的 **TCP/IP + 指定 IP + Control Panel + 坐标查询**。剩余：把工作流写成随包 skill/E2E 回归、硬件下载与真实 PLC 仍属未验范围。
5. **已定范围**：只做「PLC 程序动态下载执行」；HMI/SCADA、SIMIT、工艺仿真、真实硬件、F 程序、S7-1200 均排除。

---

## 1. 问题与边界

### 1.1 为什么需要 simulation

现有 suite 的「验证器」只有**静态**一半：导入 + 编译 + 写后读回，能回答「这个改动编译得过吗」，不能回答「程序跑起来行为对不对」。PLCSIM Advanced 提供的正是后者：把下载后的程序放进虚拟 PLC，给输入、读输出、控制 RUN/STOP 与虚拟时间。

这不需要推翻三层架构，而是补上 **① 接入层的第二个验证器**：

| 验证器 | 回答的问题 | 现有/新增 |
|---|---|---|
| 静态：TIA 编译 + 写后读回 | 改动成立吗、编译得过吗 | ✅ 已有（TIA 插件） |
| 动态：PLCSIM 运行 + I/O 观测 | 程序行为对吗、输入变化后输出对吗 | ✅ 已跑通（本评估 + 插件） |

**它不产出工程语义**，也不管理作用域；它只产出**运行态证据**（状态迁移、标签值、耗时），供模型/工程上下文/版本台账消费。

### 1.2 范围（已定：只做 PLC 程序动态下载执行）

**v1 纳入**

- PLCSIM Advanced 实例的创建、上电/断电、删除、列表、许可与状态。
- 触发 TIA 侧下载（复用现有 `download`，但需要 Phase 0 的直连改动）。
- RUN / STOP / Memory Reset。
- 按标签名读写（Bool/数值/字符串/数组/结构体，按 PLCSIM API 能力）——没有它就无法施加输入、观察输出。
- 运行态证据（状态、标签快照、耗时）落盘，供后续版本台账引用。
- **snapshot / restore**：归档程序+硬件+retentive 数据为 ZIP，下次直接还原（§10.10）。

**v2 再评估（不属于本轮范围）**

- 按地址读写 I/O。
- 虚拟时间缩放、冻结/单步。
- 多实例、远程 Runtime Manager。
- `simulationAccess` 服务与版本台账联动。

**v1 明确排除**

- 真实 PLC / 真实硬件 I/O；不做 HIL。
- HMI / SCADA / WinCC、SIMIT、NX MCD、驱动与工艺对象仿真。
- Safety/F 程序的下载与运行（Openness 对 F-activated PLC 直接拒绝下载，见 TIA 插件限制 R16）。
- S7-1200 / S7-1200 G2（PLCSIM Advanced 不支持，手册 §2.3）。
- 多用户/项目服务器、远程 Runtime Manager（`IRemoteRuntimeManager` 能力存在，但本轮不做）。
- 任意脚本/场景 DSL 的代码执行；只做数据化操作。

---

## 2. 已验证的事实

> 标记：**[实测]** 本机本次会话跑出来的；**[手册]** 来自 Siemens 随装手册；**[代码]** 仓内代码/文档；**[推断]** 有依据但未验证；**[待验证]** 必须由 Phase 0 回答。

### 2.1 本机环境

| 项 | 事实 | 证据 |
|---|---|---|
| PLCSIM Advanced | **V7.0**（`70.0.323.0`）已安装 | `C:\Program Files (x86)\Siemens\Automation\PLCSIMADV`；卸载表 `SIMATIC S7-PLCSIM Advanced V7.0` |
| API 程序集 | `API\3.0` … `API\7.0` 均在；x64/x86 | `C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API\7.0\Siemens.Simatic.Simulation.Runtime.Api.x64.dll` |
| API 目标框架 | 7.0 为 **.NET Framework 4.8**；4.1 为 **.NET Framework 4.0**；均 x64 | 程序集 `TargetFrameworkAttribute` |
| 虚拟网卡 | `Siemens PLCSIM Virtual Ethernet Adapter`，Up，本机 IPv4 **192.168.1.240/24** | `Get-NetAdapter` / `Get-NetIPAddress` |
| TIA | V17 Update 7 与 V20 并存 | 卸载表；现有 TIA 插件绑定 V17 |
| TIA Openness | V17 可用，控制器可加载 | 现有控制器 ready 帧 `opennessDir=…\Portal V17\PublicAPI\V17` |
| 许可 | **`LicenseStatus=OK`**（本机 Automation License Manager 有可用许可） | 两次 API 冒烟均返回 OK |

### 2.2 API 冒烟（不碰工程）

用 `csc.exe` 编译两个最小控制台程序，分别链接 API 7.0 与 4.1，然后运行：

| 步骤 | API 7.0 | API 4.0/4.1（驱动 V7 Runtime） |
|---|---|---|
| `IsRuntimeManagerAvailable` | `True` | `True` |
| `Version` | `458752`（`0x70000` = 7.0） | `458752`（同一 Runtime） |
| `RegisterInstance("Dsh…")` | 成功，`ID=0`，`CPUType=CPU1500_Unspecified`，`Article=6ES7 SIM-01500-APLC` | 成功，`ID=0` |
| `StoragePath` | 设置成功 | 设置成功 |
| `PowerOn(15000)` | `OK`，状态 `Stop` | `OK`，状态 `Stop` |
| `LicenseStatus` | `OK` | `OK` |
| `Run(5000)`（未下载程序） | 抛 `IsEmpty`（-52），符合手册 | 抛 `IsEmpty`（-52） |
| `PowerOff` / `Unregister` / `Shutdown` | 干净退出，无残留进程 | 干净退出 |

> API 4.0 与 4.1 在 v1 所需成员上一致（4.0 没有 `NetworkMode`，4.1 也没有；两者都用可写的 `CommunicationInterface`）；完整跨版本矩阵见 §2.7。

**结论**：
- **[实测]** API 4.0（以及 4.1）编译的程序可以在 V7 Runtime 上工作。手册 §3.1 也写明「新版本的 Runtime Manager 兼容更早版本的 API」。因此**编译基线选 4.0**：它覆盖 TIA V17 时代的 PLCSIM Advanced 4.0/4.1，也覆盖本机 V7；4.1 虽然同样可用，但会排除 4.0 Runtime。
- **[实测]** 4.1 的 `IInstance.CommunicationInterface` 是**可写**的，可设 `TCPIP` 或 `Softbus`；`SetIPSuite(0, suite, …)` 在 `PowerOn` 之后可用。7.0 改为 `SimulationRuntimeManager.NetworkMode`（全局），4.1 没有该属性。
- **[实测]** 在 `PowerOn` 前设 `StoragePath` 成功；**[手册]** 不设会报 `NoStoragePathSet`（§8.3）。

### 2.3 TIA V17 实际看到的接口

用现有 `TiaOpennessV17Min.Controller` 的 stdio 协议，打开演示工程 `TestPLCExportDemo.ap17`（5.8 MB，2 个 S7-1500 PLC，13 个块，`isSimulationDuringBlockCompilationEnabled=true`）：

| 场景 | `online_targets` 的接口 |
|---|---|
| 没有 PLCSIM 实例 | 只有 `Siemens PLCSIM Virtual Ethernet Adapter`（`kind=virtual`，target `1 X1`）与几张物理网卡 |
| 有一个 **Softbus** 实例在跑 | **`PLCSIM`**（`kind=virtual`，target `1 X1`）出现；虚拟网卡仍可选 |

**[实测] 这是本次最重要的可用性事实之一**：TIA 不是总能枚举到 `PLCSIM`；**必须先有实例运行**。所以工作流顺序必须是「建实例/上电 → 再让 TIA 枚举目标」，不能反过来。

### 2.4 现有「先上线、再下载」流程的真实失败

在 Softbus 实例已上电到 STOP 的情况下，对 `S7-1500/ET200MP station_1` 执行：

```jsonc
// online_connect（节选）
{
  "device_name": "S7-1500/ET200MP station_1",
  "mode": "PN/IE",
  "pc_interface": "PLCSIM",
  "pc_interface_number": 1,
  "target_interface": "1 X1",
  "expect_kind": "virtual",
  "timeout_ms": 60000
}
```

返回（`ok` 是操作信封，`data.ok` 才是连接结果）：

```jsonc
{
  "ok": true,
  "data": {
    "pcInterface": "PLCSIM",
    "kind": "virtual",
    "state": "Offline",
    "ok": false,
    "elapsedMs": 5054,
    "message": "Error when calling method 'GoOnline' of type 'Siemens.Engineering.Online.OnlineProvider'.\r\n\r\nChanging to online mode failed."
  }
}
```

随后 `download`：

```jsonc
{ "ok": false, "error": { "code": "online_session_required",
  "message": "A download needs the online session that was opened with online_connect; connect first." } }
```

**为什么这是阻塞点，而不是死路**：

- 在 TIA UI 里，首次下载到未组态实例走的是**下载对话框**：它显示「CPU-1500 Simulation」实例，下载后实例才显示 CPU 类型（手册 §5.1.3）。这条路径不需要先 `GoOnline`。
- Openness 的 `DownloadProvider.Download(IConfiguration, …)` 接受的正是 `provider.Configuration` 解析出的 `ConfigurationTargetInterface`；现有代码却从 `_onlineSession` 取这个 target（`OperationsOnline.cs:656-657`），于是把一个**下载前置条件**做成了**在线前置条件**。
- **[推断]** `GoOnline` 失败的最可能原因是实例尚未组态（无 CPU 类型/硬件配置）；其次是项目与实例的接口不匹配。Phase 0 必须把这两个原因分开验证。
- 现有文档也承认在线/下载**未在设备上实测**：`PROTOCOL.md:368-370`、`VERIFICATION-PLAN.md:536` 都把「真实 PLC/PLCSIM」列为前置条件 P。

### 2.5 网络模式：Softbus 是安全默认，但 TCP/IP 有硬约束

- **[手册]** Softbus 只在本机/虚拟机内通信，默认且最安全；TCP/IP Single/Multi Adapter 才能与分布式设备/真实 HMI/OPC UA 通信（Function Manual §4.1）。
- **[实测]** 演示工程两个 PLC 的离线 IP 都是 `192.168.0.1/24`；本机 PLCSIM 虚拟网卡是 `192.168.1.240/24`，**不同网段**。走 TCP/IP 直连时，要么改虚拟网卡 IP，要么把实例 IP 与工程 IP 对齐，否则 `online_connect` 不可达。
- **[实测]** 把实例设为 `TCPIP` 并用 `SetIPSuite(0, …)` 设成 `192.168.0.1/24` 是可行的；但要让 TIA 按工程 IP 找到它，还需要 Windows 虚拟网卡与实例处于同一子网——改网卡绑定需要管理员权限（`SetNetInterfaceBindings` 明确要求 elevated session）。
- **已定（用户）**：v1 默认 **Softbus**；TCP/IP 作为显式配置项，且只允许 `TCP/IP Single Adapter`（不开放物理网卡映射），以避免误连真实设备。

### 2.6 现有代码里可直接复用的部分

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 控制器子进程 + NDJSON 协议 + 超时/重启 | `packages/dsh-tia-openness-v17-min/src/runtime-service.ts`、`controller/Program.cs` | 新插件照抄骨架，换控制器 exe 与操作白名单 |
| `online_targets` 的接口枚举与 `kind` 判定 | `controller/OperationsOnline.cs:110-235`、`:1048` | 直接复用；`PLCSIM` 已被判为 `virtual` |
| `download` 工具与门禁 | `src/tools.ts:2333`、`controller/OperationsOnline.cs:617` | 保留；Phase 0 增加「无会话直连下载」分支 |
| `update_project` 写「编译时支持仿真」 | 包 README §4.2；`OperationsProject.cs` | 若工程未开仿真支持，先写属性再重编译 |
| 服务缝模式（按名取、不 import） | `src/access.ts:39`、`dsh-engineering-context/src/knowledge-graph.ts:43` | 新插件按同一模式暴露 `simulationAccess` |
| 工具按 preset 分发 | `docs/decisions.md:506`（D23）、`:1018`（D31） | 宿主行放控制器/服务；`/tools` 行只给 `leader` |

### 2.7 API 跨版本兼容矩阵（本轮新增实测）

用同一台 V7 Runtime，分别加载 API **3.0 / 4.0 / 4.1 / 5.0 / 6.0 / 7.0** 的程序集，做「注册实例 → 设存储 → 上电 → 读状态/许可 → 断电 → 注销」：

| API 版本 | 程序集版本 | 目标框架 | `LicenseStatus` | `CommunicationInterface` | `NetworkMode` | 对 V7 Runtime |
|---|---|---|---|---|---|---|
| 3.0 | `3.0.2.3501` | .NET 4.0 | ✅ | ✅ 可写 | ❌ | ✅ `PowerOn=OK`，`Stop`，`License=OK` |
| 4.0 | `4.0.0.4303` | .NET 4.0 | ✅ | ✅ 可写 | ❌ | ✅ 同上 |
| 4.1 | `4.1.0.1001` | .NET 4.0 | ✅ | ✅ 可写 | ❌ | ✅ 同上 |
| 5.0 | `50.43.4.0` | .NET 4.0 | ✅ | ✅ 可写 | ✅ | ✅ 同上 |
| 6.0 | `6.0.0.1` | .NET 4.8 | ✅ | ❌ 只读 | ✅ | ✅ 同上 |
| 7.0 | `7.0.0.0` | .NET 4.8 | ✅ | ❌ 只读 | ✅ | ✅ 同上 |

**结论**

- **旧 API → 新 Runtime 是兼容的**：V7 Runtime 接受 3.0–7.0 的客户端。手册 §3.1 也写明「新版本的 Runtime Manager 兼容更早版本的 API」。
- **反向不保证**：新 API → 旧 Runtime 没有承诺（手册明确 API V6.0 的接口与更早 API 不兼容）。所以**编译基线要选老版本，而不是 V7**。
- **API 4.0 是 TIA V17 代际的最低合理基线**：4.0 的 native header 写 `SREC_WRONG_VERSION ... Must be V4.0 or higher`；4.0 具备 v1 需要的全部能力（`PowerOn`/`Run`/`Stop`/`MemoryReset`/`UpdateTagList`/`TagInfos`/`Read*`/`Write*`/`ScaleFactor`/`SystemTime`/`SetIPSuite`/`ArchiveStorage`/`CleanupStoragePath`），只是没有 5.0 的 `NetworkMode`、6.0 的只读通信接口、7.0 的 article-number 注册。
- **未逐一实测**：4.1 / 5.0 / 6.0 的 Runtime 没有在本次安装中运行；按手册的向后兼容规则，4.0 客户端应在 4.0–7.0 上可用。Phase 0 若拿到别的版本机器，补一条即可。
- **因此包名不带版本号**：若叫 `-v7`，会误导 TIA V17 用户（他们通常装 4.0/4.1），也会掩盖「4.0 基线覆盖 4.0–7.0」这个事实。

> **产品代际配对（不是 API 兼容规则）**：PLCSIM Advanced 的大版本通常与 TIA Portal 大版本同期——4.0/4.1 ↔ V17、5.0 ↔ V18、6.0 ↔ V19、7.0 ↔ V20。V7 装在本机可以驱动旧 API，但 **V7 的产品配对是 V20**；TIA V17 的工程要下载到 V7 实例，仍属于 Phase 0 的待验证项。此条为产品代际/社区资料，**不是 Siemens 官方兼容声明**，以实际下载结果为准。

---

## 3. 方案空间与取舍

| 方案 | 做法 | 优点 | 代价/风险 | 结论 |
|---|---|---|---|---|
| **A. 独立仿真插件（已定）** | 新包 `dsh-plcsim-advanced`：自己的 C# 控制器、PLCSIM API、工具行；TIA 插件仍是工程写入/下载者 | 失败域隔离；PLCSIM 版本/许可独立；可按 preset 单独授权；未来可加 SIMIT/其它仿真器 | 跨插件编排；需要 `simulationAccess` 缝；多一个包/控制器 | ✅ 已定 |
| B. 塞进 TIA 控制器 | 在 `TiaOpennessV17Min.Controller` 里引用 PLCSIM API，新增操作 | 一个进程、编排简单、无需跨插件 | 耦合 TIA 会话与 PLCSIM 运行时；一个崩溃全挂；控制器更大；构建同时依赖两套 SDK；D31 的「一个包」是**TIA 能力**不拆包，不是把第二个产品塞进来 | ❌ 不推荐 |
| C. 每次调用起一次性 CLI | 小 exe：建实例→上电→退出 | 实现最简单 | 最后一个 API 客户端退出后 Runtime Manager/实例会结束；无法保持仿真会话；归档/取回太慢 | ❌ 只适合一次性诊断 |
| D. 用 S7/OPC UA 客户端（如 Snap7）替代 API | 只读写标签，不碰实例 | 语言/平台无关；可接外部 HMI | 不能建实例/上电/时间控制/冻结；Softbus 不可达；仍需 TCP/IP | ❌ 只能做补充，不能做底座 |
| E. 自动化 TIA UI 的「启动仿真」 | 点 UI | 无需写 API | 脆弱、不可无头、不可审计、版本一换就坏 | ❌ |

**为什么 A 不与 D31 冲突**：D31 说的是**接口插件族**（TIA V17/V18… 的能力）不拆包；PLCSIM Advanced 是**另一个产品**，有自己的 API、版本与许可。把它做成独立插件，等于在 ① 接入层新增一个**仿真接入成员**，而不是把 TIA 能力拆出去。

### 3.1 包名（本轮新增结论）

| 候选 | 评价 | 结论 |
|---|---|---|
| `@voltarenyah/dsh-plcsim-advanced` | 产品名完整、不带运行时版本；4.0 基线覆盖 4.0–7.0，不需要版本后缀 | ✅ **推荐** |
| `@voltarenyah/dsh-simulation-plcsim-advanced` | 显式「simulation 域」，将来可并列 `dsh-simulation-simit`；但过长，且产品名已含 simulation | 🟡 备选 |
| `@voltarenyah/dsh-plcsim-advanced-v7` | 只在 V7 可用时诚实；但会误导 TIA V17/4.x 用户，且实测 4.0 基线覆盖 4.0–7.0 | ❌ 不推荐 |
| `@voltarenyah/dsh-plcsim` | 与经典 S7-PLCSIM 混淆，且不是 Advanced API | ❌ |
| `@voltarenyah/dsh-simulation` | 过宽；未来 SIMIT/HMI 无法区分 | ❌ |

**规则**

- 包名 = **产品名**，不带运行时版本；支持范围写进 README 与 `simulation_status`（安装版本、API 版本、Runtime 版本）。
- 只有出现**真正不兼容的 API 代际**（例如 V8 改了接口）或**只验证了某一代**时，才加 `-vN`；届时优先做「一个包 + 能力检测/第二构建」，而不是复制包。
- 目录 `packages/dsh-plcsim-advanced/`；`cordis.patch.yml` 的 `insert[].name` 与 `package.json` 的 `name` 逐字一致（带 scope 时 YAML 必须加引号）。

---

## 4. 推荐架构

### 4.1 组成

```
                         agent / skill（编排）
                          │                         │
              ┌───────────▼───────────┐   ┌─────────▼─────────────┐
              │ TIA 接口插件           │   │ 仿真插件               │
              │  · OpenProject        │   │  · instance lifecycle  │
              │  · OnlineTargets      │   │  · PowerOn/Off         │
              │  · Download  ─────────┼──▶│  · Run/Stop/Reset      │
              │  · Compile / 写回      │   │  · Read/Write tags     │
              └───────────┬───────────┘   │  · Virtual time (v2)   │
                          │               └─────────┬─────────────┘
                          ▼                         ▼
                    TIA Portal V17            PLCSIM Advanced Runtime
                    （工程真相源）             （实例/进程/许可）
```

- **TIA 插件**：唯一能改工程、唯一发起下载的插件。`download` 需要 Phase 0 的直连改动。
- **仿真插件**：只驱动运行时与 I/O；**不写工程对象**，不解析 XML，不管作用域。
- **编排**：v1 由 skill/persona 明确写出调用顺序；v2 可让 `engineering-context` 通过 `simulationAccess` 把运行证据并入版本台账。

### 4.2 进程与生命周期

- 宿主行 `apply()` 用 `ctx.effect` 持有 `PlcsimAdvanced.Controller.exe`（net48 / x64），NDJSON over stdio；插件卸载/会话结束 → 控制器 `Dispose` → 对所有实例 `PowerOff` + `UnregisterInstance` + `Shutdown`。
- **实例活不过控制器**：PLCSIM Runtime Manager 在最后一个 API 客户端退出后结束；因此不能做成「每次工具调用起一个进程」。若需要跨 DSH 重启保留实例，只能用 `ArchiveStorage` / `RetrieveStorage`（慢，v2 可选），v1 明确「重启即重建」。
- **一个插件一个控制器**：与 TIA 插件同一模式（D31 的控制器所有权）；不同 DSH 会话共享同一控制器，需要 `owner`/实例名前缀与互斥。

### 4.3 API 版本策略

- **编译基线：API 4.0**（`Siemens.Simatic.Simulation.Runtime.Api.x64, Version=4.0.0.4303`）。
  - 覆盖 PLCSIM Advanced **4.0–7.0**：4.0 是 TIA V17 代际的最低合理基线；V7 Runtime 实测接受 4.0 客户端；4.1–6.0 按手册的向后兼容规则预期可用（未逐版本实测）。
  - 4.0 的 `CommunicationInterface` 可写，足以在 Softbus/TCPIP 间选择；`LicenseStatus`、`SetIPSuite`、`TagInfos`、`UpdateTagList`、`Read*`/`Write*`、`ScaleFactor`/`SystemTime`、`MemoryReset`、`ArchiveStorage` 均在；v1 不需要 5.0 的 `NetworkMode`、6.0 的只读通信接口、7.0 的 article-number 注册。
  - 4.0 只有 `RegisterInstance(ECPUType, name)` / `RegisterInstance(name)`；v1 用「默认/CPU 族」建实例，首次下载后由 TIA 组态，足够。
  - 若未来必须用 7.0-only 能力（article number、部分新事件），优先做「同一包 + 运行时反射/能力检测」；只有 API 代际真正不兼容时，才加第二构建或 `-vN` 包。
- **运行时解析**：必须找到 **`API\4.0`** 的程序集（编译期程序集身份固定为 `4.0.0.4303`）；V7/4.1/5.0/6.0 安装通常都带旧 API 目录，本机 V7 即带 3.0–7.0。找不到时返回 `plcsim_not_installed`，而不是回退到 3.0（3.0 的程序集身份不同，不能直接替换 4.0 的引用；要支持 3.0-only 安装需另做 3.0 基线构建或反射适配）。
- **运行前检查**：`simulation_status` 读 API 程序集版本、`SimulationRuntimeManager.Version`（Runtime 版本）与 `LicenseStatus`；三者一起构成「这台机器能跑哪个范围」的证据。
- **不重新分发 API DLL**：`CopyLocal=false`；`controller/bin` 只放我们自己的 exe/依赖，Siemens API 由用户安装提供（与 TIA 插件对 `Siemens.Engineering.dll` 的处理一致）。
- **构建机要求**：开发机需装 PLCSIM Advanced；CI 不构建控制器，直接用仓库里提交的 `controller/bin`（与 `dsh-tia-openness-v17-min` 的做法一致）。若将来 CI 要构建，再引入一个 `IPlcsimRuntime` 接口 + 编译期 stub，避免 CI 装 PLCSIM。

### 4.4 包结构（建议）

```
packages/dsh-plcsim-advanced/
  AGENTS.md
  README.md
  package.json                     @voltarenyah/dsh-plcsim-advanced
  cordis.patch.yml                 宿主行 + /tools 行
  src/
    index.ts                       宿主行：控制器 + simulationAccess + skill
    tools.ts                       /tools 行：模型面工具
    tools-entry.ts                 exports["./tools"]
    protocol.ts                    操作白名单（与 C# OperationCatalog 双份）
    runtime-service.ts             子进程生命周期、NDJSON、超时
    service.ts                     simulationAccess
    config.ts                      apiDir / storageRoot / networkMode / gates
  controller/
    PlcsimAdvanced.Controller.csproj     net48 / x64
    Program.cs                     stdio + 一次性 CLI + --self-test
    Operations.cs                  操作分派
    OperationsInstance.cs          建/上电/断电/删除/列表
    OperationsRun.cs               RUN/STOP/Reset
    OperationsTags.cs              标签列表/读写
    Protocol.cs                    帧与白名单
    PlcsimRuntime.cs               API 4.0 适配（唯一接触 Siemens 类型的地方）
    bin/                           预构建产物（不含 Siemens API DLL）
  skills/plcsim-advanced/SKILL.md
  test/
  docs/
```

### 4.5 工具面（v1 4 个；v2 再加 2 个）

| 工具 | 动作 | 默认 | 关键返回 | 失败码 |
|---|---|---|---|---|
| `simulation_status` | 只读 | — | 安装/API 版本、Runtime 版本、许可、实例列表、网络模式、控制器状态 | `plcsim_not_installed` / `runtime_unavailable` |
| `simulation_instance` | `create` / `power_on` / `power_off` / `remove` / `snapshot` / `restore` / `list` | 只读 `list`；写动作需 `confirm`；`create` 默认带 Control Panel | 实例名、ID、状态、CPU、communication、ip/subnet/gateway、存储路径；`create` 接收 `cpu_type` / `communication` / `ip`，`power_on` 应用 IP；`snapshot` 写 ZIP+manifest，`restore` 从 ZIP 新建 | `instance_exists` / `invalid_cpu_type` / `invalid_communication` / `ip_configuration_failed` / `snapshot_exists` / `snapshot_failed` / `snapshot_not_found` / `restore_failed` |
| `simulation_run` | `run` / `stop` / `reset` | `stop` 之外的写动作需 `confirm` | 状态迁移、耗时 | `instance_not_running` / `program_not_loaded`（`IsEmpty`） |
| `simulation_tags` | `list` / `read` / `write` | `list`/`read` 只读；`write` 需 `confirm`，且默认最多 N 个标签 | 标签名/类型/区域/值；截断与总数 | `tag_not_found` / `tag_type_mismatch` / `tag_list_stale` |
| `simulation_time`（v2） | `get` / `set_scale` / `set_system_time` | 只读 `get`；`set_*` 需 `confirm` | 缩放因子、虚拟系统时间 | `wrong_argument` |
| `simulation_storage`（v2） | `archive` / `retrieve` / `cleanup` | 需 `confirm` | 归档路径、大小 | `no_storage_path` / `access_denied` |

**v1 不做**：`simulation_download`（下载属于 TIA 插件）、`simulation_compile`（属于 TIA 插件）、按地址 I/O、时间控制/冻结、归档、任意脚本/循环/场景 DSL。这些都在 v2 或更后。

**工具面纪律**（沿用 D23/D31）：
- 宿主行只放控制器 + `simulationAccess` + skill；`/tools` 行放模型工具。
- 只给 `leader`；`expert`/`auditor` 不给（仿真能改运行态，属高危面）。
- 若以后要只读预览，再拆一个 `includeReadOnly` 开关给 auditor；v1 不做。

### 4.6 关键工作流（定稿的「一条正确路径」）

```
1. online_targets        # TIA：读目标 PLC 的离线 IP/子网 + PC 接口
2. simulation_instance   # PLCSIM：create (tcpip, cpu_type, name=PROFINET 设备名, ip=工程 IP) → power_on
3. adopt_open_project    # TIA：接管 UI 已打开的工程（证书信任的会话）
4. online_disconnect     # TIA：force=true，清 UI 残留在线态
5. download              # TIA：dry_run 核对 → confirm=true, options=software
6. simulation_run        # PLCSIM：run（首次下载后可能已在 RUN，先读 state）
7. simulation_tags       # PLCSIM：read 输出 / write 输入；必要时先 update_tag_list
8. simulation_instance   # 结束时保持运行（默认）；需要清理才 power_off + remove
```

**两个一次性前置**（缺一不可）：

- **项目级**：给要下载的 PLC 分配子网 + 唯一 IP；不配时连 TIA UI 都下不了。
- **设备级**：首次连接在 TIA UI 接受自签名证书（Openness 无该委托，headless 必败）。

**Phase 0 / 后续已落地的改动**：

- `Download` 不再强制 `_onlineSession`，支持 `pc_interface` / `target_interface` / `address` / `target_address`；
- TIA 侧新增 `AdoptOpenProject` 与 `online_disconnect(force=true)`；
- PLCSIM 侧新增 TCP/IP + 指定 IP + Control Panel + 坐标查询；
- 下载仍是 `dry_run` 默认 + `confirm` + 物理设备 `confirm_real_device` 三档闸门。

### 4.7 安全与门禁

| 风险 | 默认 | 放行条件 |
|---|---|---|
| 误连真实设备 | **默认 Softbus**（本机/VM 内）；Openness 工作流显式 `tcpip` + 工程 IP | TCP/IP 只用 PLCSIM 虚拟网卡；不开放物理网卡映射 |
| 误写运行态 | 标签写默认拒绝，需 `confirm=true` | 单次调用显式确认；批量写有上限 |
| 误断电/删实例 | `power_off`/`remove` 需 `confirm=true` | 显式确认；`remove` 先 `power_off` |
| 许可耗尽 | 创建前读 `LicenseStatus`；无许可直接拒绝 | 用户装许可或接受 trial 限制 |
| 实例名冲突/多会话 | 实例名带 workspace/session 前缀；同名拒绝 | 显式 `replace=true`（v2） |
| 存储路径 | 默认 `<workspace>/.dsh/simulation/<instance>/`；拒绝 Program Files/Windows | 显式 `storageRoot` 且在工作区内 |

---

## 5. 验收口径

### 5.1 Phase 0（已通过，2026-10-24）

在一台装有 TIA V17 + PLCSIM Advanced 的机器上，用小型演示工程完成：

1. **TIA `online_targets`**：目标 PLC 必须有子网 + 唯一 IP；记录 `pc_interface`
   （TCP/IP 用 `Siemens PLCSIM Virtual Ethernet Adapter`）和 `target_interface=1 X1`。
2. **PLCSIM `simulation_instance(create, tcpip, cpu_type=1511, name=<PROFINET 设备名>,
   ip=<工程 IP>)` → `power_on`**：实例 STOP、`LicenseStatus=OK`，返回 IP/communication/state。
3. **TIA UI 打开工程并接受一次自签名证书**，然后 `adopt_open_project` 接管。
4. **TIA `online_disconnect(force=true)`**：清掉 UI 残留在线态。
5. **TIA `download(dry_run=true)` → `download(confirm=true, options="software")`**：
   `state=Success`、`errorCount=0`。
6. **PLCSIM `simulation_run(run)` + `simulation_tags`**：RUN、标签可读、Bool 读写。
7. 结束时保持实例运行（默认）；需要清理才 `power_off` + `remove`。

**通过标准**：第 2–6 步全部成功，且第 3/4 步的人工前置可复述。

> **2026-10-24 实测**：全流程通过。关键不是 API 缺失，而是**证书 + 工程子网/IP**两个一次性前置；详见 §10.9。

### 5.2 MVP

- `--self-test` 覆盖 NDJSON、白名单、JSON、门禁；不依赖 PLCSIM。
- 控制器级测试用 fake `IPlcsimRuntime`（不装 PLCSIM 也能跑）。
- 一条真实 E2E 测试（手动/标记 skip）：建实例 → TIA adopt/download → RUN → 读写 → 清理。
- `pnpm -r build` / `typecheck` / `test` 全绿；`dsh --profile … --dump-config` 出现两行（宿主 + `/tools`），`--dump-config-schema` 能读到本插件 Config。
- 文档三问（何时调用/怎么调用/结果怎么用）写进工具 description + 随包 skill。

> 运行侧已 E2E 通过（RUN、51 标签、Bool 读写）；Openness 下载的两次一次性人工前置是验收的一部分，不能当作 headless 失败。

---

## 6. 分阶段计划（定稿）

| 阶段 | 工作 | 产出 | 估算 | 退出条件 |
|---|---|---|---|---|
| **Phase 0** | TIA `Download` 解耦 + 直连目标；PLCSIM TCP/IP/IP；`adopt_open_project`；证书/子网前置 | 全链路跑通 | **已完成** | 5.1 全过（§10.9） |
| **Phase 1** | 新插件骨架、控制器、`status`/`instance`/`run` + `tags(list/read)`、配置、preset、测试、文档 | 可安装的 MVP 包 | **已完成** | 四个工具可用；单测 + 配置验收 |
| **Phase 2** | `tags(write)`、批量上限、写入门禁、运行态证据落盘 | 能施加输入/观察输出的闭环 | **已完成** | 标签写入 + 证据 E2E（51 标签实测） |
| **Phase 3**（v2） | `simulationAccess`、版本台账联动、时间缩放/冻结、按地址 I/O、归档/多实例 | 与其他插件联动 | **4–6 天** | 版本台账能引用一次运行证据 |

> 运行侧插件本轮已补 TCP/IP + 指定 IP + Control Panel + 坐标查询；剩余是 skill/E2E 回归、硬件下载与真实 PLC 验证。

---

## 7. 风险与未决

| # | 风险 | 影响 | 缓解 | 状态 |
|---|---|---|---|---|
| R1 | 全新实例不能直接 `GoOnline` | 旧下载流程不可用 | 用 `adopt_open_project` 接管 UI 工程；`online_disconnect(force=true)` 清残留 | ✅ 已解决（§10.9） |
| R2 | **首次连接需在 TIA UI 接受自签名证书**；工程 PLC 需子网/唯一 IP | 未接受时 `Connect to module … failed` / `configurations: []` | 两次一次性人工前置；之后下载不需要人工 | ✅ 已解决（有前置） |
| R3 | 许可（每许可 2 实例；trial；TIA Test Suite 限制） | 客户机上建实例失败/自动关机 | 创建前读 `LicenseStatus`；文档写清许可要求；trial 明确告警 | 本机 OK，客户未知 |
| R4 | Softbus / TCP/IP 选择 | 选错则不可达，或误连真实设备 | 默认 Softbus；Openness 工作流显式 TCP/IP + 工程 IP；不做物理网卡映射 | ✅ 已定 |
| R5 | 工程与实例 IP/子网不一致 | TCP/IP 不可达 | 先 `online_targets` 读 IP，再按同一 IP 建实例；不一致时先修工程 | ✅ 已实现 |
| R6 | API 版本漂移（4.0 vs 7.0） | 新特性不可用/绑定错误 | 4.0 基线；运行时检查 `Version`；7.0-only 特性用反射或第二构建 | ✅ 已定建议 |
| R7 | 构建机没有 PLCSIM | CI 构建失败 | 提交 `controller/bin`；CI 不构建控制器；开发机构建 | 可规避 |
| R8 | API DLL 再分发 | 合规问题 | 不复制 DLL；`CopyLocal=false`；随包 notices | 必须遵守 |
| R9 | 多会话/多实例并发 | 实例互相顶掉 | 实例名前缀 + owner；v1 每 workspace 1 实例；同名拒绝 | 设计待定 |
| R10 | 控制器退出导致实例消失 | 无法跨 DSH 重启保留 | `keepInstancesOnUnload` 默认保留；跨重启归档留 v2 | ✅ 已实现（尽力） |
| R11 | F 程序 / S7-1200 | 无法下载/仿真 | 明确排除；工具给 `unsupported_cpu` / `f_program_not_downloadable` | 已定建议 |
| R12 | 标签表语义（HMI-visible 默认、50 万上限、未知类型丢弃） | 模型以为「没这个标签」 | 先 `list` 再 `read`；`UpdateTagList` 后读状态；文档写清过滤参数 | 手册已载 |
| R13 | 工程未开「编译时支持仿真」 | 下载被拒 | `update_project` 写入并重编译；E2E 前置检查 `isSimulationDuringBlockCompilationEnabled` | 已有工具 |
| R14 | 下载会掉在线会话 | 后续状态读取失败 | 下载后重新 `online_status`/重连；仿真侧只看 `OperatingState` | 已知 |
| R15 | 硬件下载 / 真实 PLC 未验 | 不能承诺产线行为 | 本次只验软件下载；硬件/真实 PLC 仍为矩阵“部分” | ⬜ 明确边界 |

**Phase 0 的三个问题（已回答）**：

1. 直连 `DownloadProvider.Download` 能否下载到**未组态**的 Softbus 实例？——不能直接；需要 UI 接受证书 + `adopt_open_project`，且工程 PLC 要有子网/唯一 IP。成功后走 TCP/IP。
2. 下载后能否 RUN + 列出标签？——能；实测 RUN、**51 个标签**、`Btn_ForwardCommand` 读写、`CylinderIsMovingForward` 变化。
3. 根因是「未组态」「固件不匹配」「F 程序」还是「接口不匹配」？——是**证书信任 + 工程子网/IP**；不是固件或 API 缺失。

---

## 8. 需要拍板

| # | 问题 | 结论 / 推荐 | 状态 |
|---|---|---|---|
| 1 | simulation 的范围 | **只做 PLC 程序动态下载执行**；SIMIT/HMI/工艺仿真另立 | ✅ 已定（用户） |
| 2 | 插件边界 | **独立插件**，不塞进 TIA 控制器 | ✅ 已定（用户） |
| 3 | 默认网络模式 | **默认 Softbus**；Openness 下载工作流显式 `tcpip` + 工程 IP，不做物理网卡映射 | ✅ 已定（用户 + 实测） |
| 4 | 包名 | **`@voltarenyah/dsh-plcsim-advanced`**；不带版本号；备选 `dsh-simulation-plcsim-advanced` | ✅ 已按此创建 |
| 5 | 标签写入 | **默认只读；写需 `confirm=true`** | ✅ 已实现 |
| 6 | 实例持久化 | **不持久化；DSH 重启即重建**；`keepInstancesOnUnload` 只在插件卸载时保留 | ⬜ 待定（跨重启归档留 v2） |
| 7 | F / S7-1200 | **明确排除** | ✅ 技术排除（PLCSIM 不支持 S7-1200；Openness 不支持 F 下载） |
| 8 | API 基线 | **4.0**（覆盖 4.0–7.0；V7 实测；4.1/5.0/6.0 按手册预期） | ✅ 已实现 |
| 9 | Phase 0 | **已跑通**：V17 控制器 + PLCSIM V7 TCP/IP + `adopt_open_project` + `download`；两次一次性人工前置 | ✅ 已执行（§10.9） |
| 10 | TIA 版本 / 项目升级 | **V17 + adopt 定稿**；V20 路径已由另一会话验证；**无需升级工程** | ✅ 已定（另一会话实测） |

---

## 9. 参考与证据位置

**本机手册**（Siemens 随装，V7.0，11/2024）

- API Programming Manual：`C:\Program Files (x86)\Siemens\Automation\PLCSIMADV\documents\en-US\s7-plcsim_advanced_function_manual_API_en-US.pdf`
  - §2.2 许可（每许可 2 实例、trial、TIA Test Suite）· §2.3 支持的 CPU（S7-1500，固件 1.8–4.0）· §3.1 API 版本兼容 · §6.1 实例上限 16 · §8.3 PowerOn/Run/Stop · §8.5 标签表（50 万、HMI-visible、`UpdateTagList`）· §8.8 虚拟时间。
- Function Manual：同目录 `s7-plcsim_advanced_function_manual_en-US.pdf`
  - §2.3/2.4 支持 CPU 与兼容性 · §4.1 通信路径（Softbus / TCP/IP）· §5.1.1 基本流程 · §5.1.3 下载（`PLCSIM` 或 `Siemens PLCSIM Virtual Ethernet Adapter`；首次下载显示未组态实例）。
- API 程序集：`C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API\{3.0,4.0,4.1,5.0,6.0,7.0}\Siemens.Simatic.Simulation.Runtime.Api.x64.dll`。
- API 4.0 的 native header：`C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API\4.0\SimulationRuntimeApi.h`（`SREC_WRONG_VERSION ... Must be V4.0 or higher`）。

**仓内代码/文档**

- 现有在线与下载：`packages/dsh-tia-openness-v17-min/controller/OperationsOnline.cs:110`（targets）、`:365`（GoOnline）、`:617`（Download）、`:1048`（virtual 判定）。
- 下载工具：`packages/dsh-tia-openness-v17-min/src/tools.ts:2333`；协议契约 `packages/dsh-tia-openness-v17-min/docs/PROTOCOL.md:312`、`:368`、`:372`。
- 仿真支持属性：`packages/dsh-tia-openness-v17-min/README.md:245`；`ProjectInfo` 实测 `isSimulationDuringBlockCompilationEnabled=true`。
- 控制器骨架：`packages/dsh-tia-openness-v17-min/controller/TiaOpennessV17Min.Controller.csproj`（net48/x64）、`controller/Program.cs`（stdio + 一次性 CLI + self-test）。
- 服务缝：`packages/dsh-tia-openness-v17-min/src/access.ts:39`；`packages/dsh-engineering-context/src/knowledge-graph.ts:43`。
- 工具面与装配：`docs/decisions.md:506`（D23）、`:1018`（D31）；`docs/architecture.md:18`、`:101`；`docs/roadmap.md:330`。
- 前置条件 P（真实 PLC/PLCSIM）：`packages/dsh-tia-openness-v17-min/docs/VERIFICATION-PLAN.md:536`。
- **Phase 0 已改**：`controller/OperationsOnline.cs` 的 `Download`（会话可选、`pc_interface`/`target_interface`/`address`/`target_address`、`ApplyConfiguration`）；`src/tools.ts` 的 `download` 参数；`docs/PROTOCOL.md` 的下载契约。
- **版本证据**：`C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V19\Siemens.Engineering.dll` 与 `V20\Siemens.Engineering.dll` 含 `TargetForSoftware`/`PlcSimulationAdvanced`；同目录 `V17`/`V18` 与 V17 安装的 PublicAPI 不含。
- **测试证据**：控制器构建 0 warning / 0 error；TIA 包 `node --test` **102 pass / 1 skip**（Phase 0 后重跑）。

**本次实测记录**

- API 7.0 冒烟：`IsRuntimeManagerAvailable=True`、`Version=458752`、`LicenseStatus=OK`、`PowerOn=OK`、`Run` 报 `IsEmpty`、干净退出。
- API 3.0 / 4.0 / 4.1 / 5.0 / 6.0 / 7.0 分别以独立进程驱动 V7 Runtime：全部 `PowerOn=OK`、`Stop`、`License=OK`、干净退出（详见 §2.7）。
- API 4.0 的程序集面：`LicenseStatus`、可写 `CommunicationInterface`、`SetIPSuite`、`TagInfos`、`UpdateTagList`、`ReadBool/WriteBool`、`ReadInt32/WriteInt32`、`ScaleFactor`、`SystemTime`、`OperatingMode`、`MemoryReset`、`ArchiveStorage`、`RetrieveStorage`、`CleanupStoragePath` 均在；`NetworkMode` 不在（5.0 才引入），`RegisterInstance(articleNumber, name)` 不在（7.0 才引入）。
- TIA V17 `online_targets`：无实例 → 仅 `Siemens PLCSIM Virtual Ethernet Adapter`；Softbus 实例运行 → `PLCSIM`（virtual，`1 X1`）。
- `online_connect` 到全新 Softbus 实例：`state=Offline`、`data.ok=false`、`GoOnline` 失败（5054 ms）。
- Phase 0 直连下载（无会话）：dry-run 解析成功，`targetSource=download_property`；实际 `DownloadProvider.Download` 报 `download_failed` / `Connect to module PLC_1 failed`（Unspecified 与 CPU1516 都失败）。
- 二进制核对：V17 与 V18 的 `Siemens.Engineering.dll` 不含 `TargetForSoftware` / `PlcSimulationAdvanced`；V20 安装的 PublicAPI **V19/V20 含**，V17/V18 不含。
- 演示工程：`TestPLCExportDemo.ap17`，5.8 MB，2 个 S7-1500 PLC，13 块，`isSimulationDuringBlockCompilationEnabled=true`，可见窗口打开 1.1–25.3 s。

---

## 10. Phase 0 结果与路线修正（2026-10-24）

### 10.1 已完成的代码改动

- `Download` 不再强制 `_onlineSession`：新增 `pc_interface` / `pc_interface_number` / `target_interface` / `address` / `target_address`，在无会话时从 `DownloadProvider.Configuration` 解析目标并 `ApplyConfiguration`。
- 接上 V17 的 `Download(IConfiguration, ConfigurationAddress, …)` 重载（`target_address`）。
- `download` 工具、`PROTOCOL.md`、单测同步；控制器构建 **0 warning / 0 error**；TIA 包 **102 pass / 1 skip**。
- 这些改动对 **V19/V20 仍然有用**；对 V17 无法弥补 API 缺失。

### 10.2 真机结果

| 步骤 | 结果 |
|---|---|
| dry-run 解析 | ✅ `targetSource=download_property`，`PLCSIM`，`1 X1` |
| 实际下载（默认/CPU1516） | ❌ `download_failed`：`Connect to module PLC_1 failed` |
| `online_connect` | ❌ `GoOnline` 失败，`state=Offline` |
| V17 `Siemens.Engineering.dll` 二进制 | ❌ 无 `TargetForSoftware` / `PlcSimulationAdvanced` |
| V20 安装的 PublicAPI | V17/V18 ❌；**V19/V20 ✅** |

### 10.3 解释

- TIA **UI** 能下载到 PLCSIM（Function Manual §5.1.3），但 **V17 Openness 没有暴露「目标 = 仿真 CPU」的 API**；`TargetForSoftware` / `PlcSimulationAdvanced` 是 V19+ 才加入的。
- 因此不是「先上线还是先下载」的顺序问题，也不是 CPU 族、实例名或 IP 的问题；`target_address` 重载只能解决「特定 IP」，不能替代「目标为仿真 CPU」。
- 本机 Openness 在多次启停后还出现握手超时（`EngineeringSecurityException`），`target_address` 分支未完成实测；这不影响上面的 API 边界结论。

### 10.4 路线（历史决策，结论已由 §10.9 修正）

| 路线 | 做法 | 优点 | 代价 | 结论 |
|---|---|---|---|---|
| **A. V17 + adopt（定稿）** | TIA UI 打开工程并接受一次证书 → `adopt_open_project` → `online_disconnect(force)` → `download`；PLCSIM 侧 TCP/IP + 工程 IP | 不升级工程；每次下载不需要人工 | 两次一次性人工前置（子网/IP、证书）；非无人值守首跑 | ✅ **已跑通（§10.9）** |
| B. TIA V20 + PLCSIM V7 | 新增 V20 成员/下载器；工作区副本升级 | 代际配对；V20 有 `TargetForSoftware` | 项目版本分裂；新成员/构建 | 🟡 备选（另一会话已验 V20 两次成功） |
| C. 人工下载一次 | 用户 UI Download，插件接管 RUN/标签 | 改动最小 | 非全自动 | 🟡 当时的过渡方案，已被 A 取代 |

### 10.5 需要拍板（历史，已由 §10.9 回答）

> 结论已定：**V17 + adopt 工作流**；不需要升级工程。以下是当时未决问题的存档。

1. ~~是否接受把工作区副本升级到 V20~~ → 不需要，V17 路径已跑通。
2. ~~V20 能力放哪~~ → 暂不需要 V20 成员；V20 路径由另一会话验证，未进蓝图。
3. ~~是否接受人工下载~~ → 不需要每次人工；接受两次一次性前置即可。
4. ~~`target_address` 是否在 V20 复验~~ → 已由另一会话的 adopt 工作流覆盖；不再是阻塞项。

### 10.6 运行侧 MVP 已落地（2026-10-24）

- 新包 `packages/dsh-plcsim-advanced`：宿主行（控制器 + `plcsimRuntime` 缝）+ `/tools` 行（4 个工具），默认 Softbus，编译基线 PLCSIM API **4.0**。
- 工具：`simulation_status` / `simulation_instance` / `simulation_run` / `simulation_tags`；`power_off`/`remove`/`run`/`stop`/`reset`/标签写都要求 `confirm=true`。
- 控制器：net48/x64，`--self-test` 通过；实测 `create → power_on (Stop) → tags list 0 → remove`，许可 `OK`，无残留进程。
- 构建/测试：控制器 **0 warning / 0 error**；插件 `npm run build` / `typecheck` 通过；`node --test` **9 pass**（本轮新增 TCP/IP 坐标转发）。
- 蓝图：`dsh.profile.bundles` 已加本包，`preset-leader` 已声明 `leader-plcsim-tools`；`--dump-config-schema` 能读到 `apiDir` / `storageRoot`。
- **程序加载由 TIA 插件 + adopt 工作流完成**；本包只负责运行态，不加载程序。本轮已补 **TCP/IP + 指定 IP + Control Panel + 坐标查询 + keepInstancesOnUnload**。

### 10.7 V20 临时副本 spike（2026-10-24，结论已由 §10.9 修正）

> **修正**：黑色加载屏是 V20 的安全确认，只有本机用户可以点。用户手动确认后，V20 正常启动、`.ap17` 副本在 55 s 内升级为 `.ap20` 并打开；§10.7 原先“V20 启动不可用”的结论**作废**。真实的下载结果见 §10.9。

为验证 A 路线，把 V17 控制器**复制到临时目录**（不改仓库、不改源工程），只改三处：`TiaPortalMajorVersion=20`、`OpennessReferencePackageVersion=20.0.1744190253`、`TargetForSoftware` 回调选择 `PlcSimulationAdvanced`。

- 编译：**成功，0 warning / 0 error**。V17 控制器代码对 V20 Openness 基本兼容。
- 运行时：默认解析到 V17 程序集；加 `--openness-dir ...\Portal V20\PublicAPI\V20` 后解析到 V20 程序集；`TiaPortalLocation` 强制后进程为 V20。
- 打开工程：安全确认点掉后，V20 TIA 在 **55 s** 内完成 `.ap17 → .ap20` 升级并打开（`projectName=TestPLCExportDemo_V20`）。
- **真实下载仍失败**：见 §10.8。

### 10.8 人工下载 + 运行侧 E2E（2026-10-24，历史对照）

> **结论已被 §10.9 取代**：本节只证明实例/工程/RUN/标签是通的；当时 Openness 失败是因为**没有接受证书、没有 adopt UI 工程、工程 PLC 未配子网/IP**，不是 Openness 不可用。

在 V20 工程已打开、API 创建的 Softbus 实例 `PLC_1`（CPU **1511**，与工程 `6ES7 511-1AK02-0AB0/V2.9` 匹配）已上电到 STOP 的条件下，用户用 TIA UI 完成一次 Download：

- 实例进入 **RUN**（`state=Run`）。
- `UpdateTagList` 返回 **51 个标签**（Inputs / Outputs / Markers / DataBlocks，含 `DB_CylinderHMI`）。
- 读 `Btn_ForwardCommand` = `False` → 写 `True` → 读回 `True`。
- 3 s 后 `CylinderIsMovingForward` = `True`；写回 `False` 后读回 `False`。
- 测试结束：`PowerOff` + `Unregister` + `Shutdown`，无残留进程。

**结论**：

- **B 路线（人工在 TIA UI 下载一次）已验证可用**：运行侧 MVP 的实例/RUN/标签读写全部真实跑通。
- **Openness 直连下载当时仍失败**：V20 的 `DownloadProvider.Download` 在 CPU1511、实例名 `PLC_1`、`target_address=192.168.0.1` 下仍报 `Connect to module PLC_1 failed`，且下载回调一次都没触发（`configurations: []`）；`DownloadProvider.Configuration` 只暴露 `PLCSIM → 1 X1`，没有实例级目标。
- 当时可交付的是「人工下载一次 + 插件接管运行态」；这个结论已在 §10.9 被更正。

### 10.9 定稿：证书 + adopt 工作流（2026-10-24）

另一个会话拿到本文证据后，把流程跑通并更新了交接文档
[`packages/dsh-tia-openness-v17-min/docs/HANDOFF-PLCSIM-DOWNLOAD.md`](../packages/dsh-tia-openness-v17-min/docs/HANDOFF-PLCSIM-DOWNLOAD.md)。结论如下：

**根因不是 API 缺失**：

- V17/V18 确实没有 `TargetForSoftware`，但 V17 路径不需要它；
- 失败的两个真实原因是：
  1. **工程 PLC 未分配子网/唯一 IP**（连 TIA UI 都下不了）；
  2. **首次连接未在 TIA UI 接受自签名证书**（Openness 无该委托，headless 必败）。
- 接受证书后，用 `adopt_open_project` 接管 UI 已打开的工程、`online_disconnect(force=true)` 清残留在线态，再 `download` 即可。

**实测**（交接文档 §0/§9，另一个会话）：

- V17 控制器 + PLCSIM Advanced V7（**TCP/IP**）+ TIA V17 工程：`AdoptOpenProject` 1.2 s →
  `OnlineDisconnect force` → `Download` software `state=Success` / `errorCount=0` → `OnlineConnect` 4.4 s → 断开；
- V20 路径另有两次连续成功；
- 两个一次性人工前置：项目级配子网/IP、设备级首次接受证书；之后每次下载不需要人工。
- 硬件下载与真实 PLC 仍未验；`download` 在矩阵里仍是“部分”。

**对 PLCSIM 插件的要求（已在本轮落地）**：

- 支持 **TCP/IP + 指定 IP**（`communication="tcpip"`、`ip=<工程 IP>`；`SetIPSuite` 在上电后应用）；
- 实例坐标返回 `name` / `communication` / `ip` / `subnetMask` / `gateway` / `state`；
- 首次 `create` 默认启动 **PLCSIM Advanced Control Panel**，能看到实例/状态/许可证；
- 实例默认在插件卸载后保持运行（`keepInstancesOnUnload`），`remove` 才是显式清理；
- CPU 族可指定（`cpu_type=1511` 等），与工程 CPU 对齐。

**编排**（agent 侧，两个插件互不调用）：

```
TIA online_targets
  → PLCSIM simulation_instance(create, name=PROFINET device name, cpu_type=1511,
      communication="tcpip", ip=<project IP>)
  → PLCSIM simulation_instance(power_on, name=..., ip=<project IP>)
  → TIA adopt_open_project
  → TIA online_disconnect(force=true)
  → TIA download(dry_run=true) → download(confirm=true, options="software")
  → PLCSIM simulation_run(run, confirm=true) / simulation_tags(...)
```

**边界**：这不是“无人值守全自动”。第一次需要人工配子网/IP、接受证书；之后可重复执行。  
**旧结论作废**：§10.7 的“V20 启动不可用”、§10.8 的“Openness 直连下载仍失败”均不再是当前结论。

### 10.10 持久化：snapshot / restore（2026-10-24）

“第一次仿真成功后保存 PLC 实例，下次直接用”已实现，使用 PLCSIM 官方归档 API：

- **snapshot**：`IInstance.ArchiveStorage(zip)`，把**程序 + 硬件配置 + retentive 数据**打成 ZIP，并写 `manifest.json`
  （name / cpuType / communication / ip / subnetMask / gateway / createdAt）；
- **restore**：新实例 `RetrieveStorage(zip)`，按 manifest（或显式参数）恢复 CPU/通信/IP，再 `PowerOn`，可选 `Run`；
- 两个 API 都要求实例 **OFF**；`ArchiveStorage` 还要求实例至少 `PowerOn` 过一次。snapshot 会短暂断电、归档后恢复原状态（RUN 会恢复）；
- 默认目录 `<workspace>/.dsh/simulation/<snapshot>/`，已加入 `.gitignore`；
- 实测：用成功工程的存储目录归档（`instance.zip` 约 224 KB）→ 新实例 restore → **41 个 HMI-visible 标签**（`UpdateTagList` 默认过滤）→ 再次 snapshot → 第二次 restore 仍为 41 标签；全量 `IOMCTDB` 列表为 **51 标签**。
- **不需要 TIA/重新下载**；但快照与创建它的 PLCSIM Advanced 版本绑定，跨大版本不要直接复用。

工具面：`simulation_instance(action="snapshot", name=..., snapshot="baseline")`；
`simulation_instance(action="restore", name="PLC_1-next", snapshot="baseline", run=true)`。
