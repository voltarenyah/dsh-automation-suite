# 硬件工具怎么划分：按 AML 的属性性质分组

**写作日期**：2026-11-02
**依据**：真实导出物 `SWT2_PEI_1026_Night/hardware/globalHardware.aml`（1 470 084 B / 442 个 `InternalElement`）
＋ 本机 Openness V17 手册两篇原文（`Structure of the CAx data for importing/exporting`、
`AML attributes versus TIA Portal Openness attributes`）＋ 反射实证。
**关联**：`HARDWARE-CONFIG-SCOPE.md`（能力矩阵筛选与导出实现）。

---

## 0. 结论先行

1. **"静态身份 vs 参数"这个划分轴是对的，但在这份文件上第二桶是空的**——CAx 的 AML **不导出任何模块/通道参数**。
   手册逐条列出的导出属性表里没有"参数"这一类；实测整份文件只有 **34 个不同的属性名**。
2. 真正的第二桶不是"参数"，而是**组态值**：地址规划、网络标识、F 地址。它们是"人赋予的、可改的"，与
   "订货号决定的、不可改的"形成干净对立。
3. 第三桶（模块参数、GSD 参数块、MAC、端口连线）**在 AML 里拿不到**，只能走 Openness 对象模型，
   必须打开工程。它和 AML 路线是**两种数据源**，不是同一工具的两个视图。

所以工具应当按「**数据源 × 属性性质**」两条轴划分，而不是按"概览/明细"：

| 工具 | 数据源 | 回答什么 | 需要打开工程？ |
|---|---|---|---|
| `hardware_inventory` | AML 文件 | 有哪些元件、型号、订货号、槽位、固件、归属 | 否 |
| `hardware_configuration` | AML 文件 | 地址怎么分、通道宽度、标签地址、IP/子网/PROFINET 名、F 地址 | 否 |
| `hardware_parameters`（未来） | 对象模型 | 模块/通道参数、GSD 参数块、端口属性 | **是** |

---

## 1. 证据：AML 里没有"参数"

### 1.1 手册的权威属性表

手册主题 **"AML attributes versus TIA Portal Openness attributes"** 逐类列出了 AML 能带的属性：

| 对象类 | AML 属性 |
|---|---|
| 设备 / GSD 设备 | `Name`、`TypeIdentifier`、`Comment` |
| 设备项 | `Name`、`TypeIdentifier`、`FirmwareVersion`、`TypeName`、`DeviceItemType`、`PositionNumber`、`BuiltIn`、`PlantDesignation IEC`、`LocationIdentifier IEC`、`Comment` |
| GSD 设备项 | 上述去掉 PlantDesignation/LocationIdentifier，多一个 `Label` |
| 带 IO 接口的设备 | `Name`、`TypeIdentifier`、`FirmwareVersion`、`TypeName`、`DeviceItemType`、`PositionNumber`、`BuiltIn`、`Label`、`Comment` |
| 端口 | `Name`、`TypeIdentifier`、`FirmwareVersion`、`TypeName`、`PositionNumber`、`BuiltIn`、`Comment`、`Label` |
| 通道 | `Type`、`IoType`、`Number`、`Length`（↔ `ChannelWidth`） |
| 地址 | `StartAddress`、`Length`、`IoType` |
| 标签 | `Name`、`DataType`、`LogicalAddress`、`Comment` |
| 标签表 | `Name`、`AssignToDefault` |

**没有一条是"参数"**：没有测量类型、没有量程、没有滤波、没有断线检测、没有诊断使能。

### 1.2 关系数据其实在（一条重要更正）

> **更正（2026-11-02 晚）**：先前写的"端口到端口连线在 AML 里 0 命中"是**错的**。
> 文件里有 **404 个 `<InternalLink>`**，它们正是关系数据。按两端接口分类：
>
> | 条数 | 连接的两端 | 含义 |
> |---|---|---|
> | 356 | `Channel_*` ↔ `O_*`/`I_*`（Tag） | **通道 ↔ PLC 标签的 I/O 信号映射** |
> | 17 | `LogicalEndPoint_Node` ↔ `LogicalEndPoint_Subnet` | 节点属于哪个子网 |
> | 16 | `CommunicationPortInterface` ↔ `CommunicationPortInterface` | **端口到端口的物理连线** |
> | 15 | `LogicalEndPoint_Interface` ↔ `LogicalEndPoint_IoSystem` | IO 设备属于哪个 IO 系统 |
>
> 所以手册"CAx 不支持导出 port-port connections"说的是**连接对象**（可编辑的 connection），
> 不是"连线信息完全不给"——物理连线以 `InternalLink` 形式存在，**拓扑和信号映射都做得到**。

### 1.3 属性面：整份文件只有 34 个属性名

- 34 个不同的属性名：`TypeName`、`PositionNumber`、`BuiltIn`、`TypeIdentifier`、
  `FirmwareVersion`、`PlantDesignation IEC`、`Comment`(+`aml-lang=*`)、`Label`、`DeviceItemType`、
  `Address`、`StartAddress`、`Length`、`IoType`、`Type`、`Number`、`LogicalAddress`、`DataType`、
  `NetworkAddress`、`SubnetMask`、`ProfinetDeviceName`、`IpProtocolSelection`、`RouterAddress`、
  `Failsafe_*`、`InstallationDate`、`LocationIdentifier IEC`、`Customized`。
- 一个 AI 4xRTD/TC 模块（`200MOD5`，`6ES7 134-6JD00-0CA1`）整棵子树只有：
  `TypeName`、`PositionNumber`、`BuiltIn`、`TypeIdentifier`、`PlantDesignation`、`Comment`、
  `FirmwareVersion` ＋ 一个地址组 `{StartAddress:1150, Length:72, IoType:Input}` ＋ 4 个通道骨架
  `{Type:Analog, IoType:Input, Number:0..3, Length:16}`。**一个参数都没带。**

### 1.4 由此得到的第一个设计约束

> 凡是"这个模块被配成什么"的问题（量程、滤波、诊断、报文、GSD 参数），
> **都不能靠 AML 工具回答**。要么承认答不了，要么另开对象模型工具。

---

## 2. 属性二分：哪些"跟着元件走"，哪些"由设计赋予"

34 个属性可以干净地切成两类（外加一小撮跨对象的派生值）：

### A. 元件身份（订购时确定，不可在组态里改）

| 属性 | 说明 | 备注 |
|---|---|---|
| `TypeIdentifier` | `OrderNumber:<MLFB>` / `GSD:…` / `System:Device.*` | 型号的唯一真相 |
| `TypeName` | 人能读的型号名（`F-DQ 4x24VDC/2A PM HF`） | |
| `FirmwareVersion` | 固件 | 手册说设备项版本可内嵌在 `TypeIdentifier` 的 `/` 之后，实测本项目 0 例，独立属性 104 个 |
| `DeviceItemType` | `CPU` / `HeadModule` / … | ↔ Openness 的 `Classification` |
| `PositionNumber` | 槽位 | 机架内位置 |
| `BuiltIn` | 是否为内置项 | ↔ `IsBuiltIn` |
| `PlantDesignation IEC` / `LocationIdentifier IEC` | 设备标识 / 位置标识 | 手册视为设备属性 |
| `Label` | 端口/接口的物理标注（`P1 R`、`X1`） | |
| `SupportedRoleClass` | 角色：`Device`(17) / `DeviceItem`(326) / `CommunicationPort`(43) / `CommunicationInterface`(18) / `Node`(17) | **分类器用它，别用 `RefBaseClassPath`（全空）** |
| 结构位置 | 组路径（`PEI_SinoARP/SubModule`）、机架名、父设备 | 由树推导，不是属性 |
| 派生计数 | 模块数、各类型通道数（DI/DO/AI/AO） | 由 B 推导 |

### B. 组态值（工程设计赋予，可以改）

| 属性 | 归属 | 说明 |
|---|---|---|
| `Address{StartAddress, Length, IoType}` | 模块/子模块 | I/O 地址规划，`IoType` 区分输入/输出 |
| `Channel{Type, IoType, Number, Length}` | 通道 | `Length` 是通道宽度（模拟量 16 位等） |
| `Tag{DataType, IoType, LogicalAddress, Comment}` | PLC 侧接口 | 500 条，`LogicalAddress` 形如 `32.6` |
| `NetworkAddress` / `SubnetMask` / `ProfinetDeviceName` / `IpProtocolSelection` / `RouterAddress` | 网口节点 | 17 台有，未分配 IP 的（交换机）没有 |
| 子网 / IO 系统归属 | `LogicalEndPoint` + `InternalLink` | 关系型，不属于任何单个元件 |
| **连线与信号映射** | `InternalLink`（`RefPartnerSideA/B` = `元素ID:接口名`） | 四类：通道↔标签 356、节点→子网 17、端口↔端口 16、接口→IO 系统 15 |
| `Failsafe_FSourceAddress` / `FDestinationAddress` / 上下界 | F 设备项 | F 地址 |

### C. 描述性元数据（两边都不属于，单列）

`Comment`（多语言，`aml-lang=en-GB/zh-CN/fr-FR`）、`InstallationDate`、`Customized`。
它们既不决定"是什么"，也不决定"配成什么"，只是注解——放在 A 里随元件返回最省事，但**不要**混进 B 的地址/网络语义。

---

## 3. 工具定义（按上面的二分）

> **已实现（2026-11-02）**：`hardware_inventory`（`HardwareInventory`）与
> `hardware_configuration`（`HardwareConfiguration`）已在 `controller/HardwareAml.cs` 落地，
> 两者都只读文件、不需要打开工程。真机实测（`SWT2_PEI_1026_Night`，442 个 `InternalElement`）：
> inventory 167 ms、configuration 180 ms；17 台设备、144 个模块、通道 DI 192 / DO 192 / AI 86 / AO 2（合计 472）、
> 地址组 151、标签 500、信号映射 356、连线 48（端口 16 / 节点 17 / IO 系统 15）。
> 这两个数字与测试里 agent 手写脚本的统计**完全一致**，可交叉验证。

### 3.1 `hardware_inventory`（A 桶：元器件身份）

**回答**：这个工程有哪些设备、每台什么型号、几个站、每站几个槽、每槽什么模块、订货号、固件、
属于哪个用户组/机架、通道数量。**不含**任何地址与 IP。

```jsonc
hardware_inventory({
  aml_path?,        // 省略 = <workspace>/hardware/globalHardware.aml
  device?,          // 只看某台设备
  include?: ['comments','counts']   // 默认两者都开
})
// → {
//   project: { name, deviceCount, skipped: [{name, reason}] },
//   devices: [{
//     name, groupPath, roleClass,
//     typeIdentifier, orderNumber, typeName, firmwareVersion,
//     plantDesignation, locationIdentifier,
//     // 注意：这里没有 ip / subnetMask / profinetName —— 网络字段归 B（决策见 §4.1）
//     racks: [{ name, modules: [{
//       slot, name, typeIdentifier, orderNumber, typeName,
//       deviceItemType, builtIn, firmwareVersion,
//       channels: { di, do, ai, ao, total },
//       comment?
//     }]}]
//   }],
//   counts: { devices, racks, modules, channels: {di,do,ai,ao} }
// }
```

### 3.2 `hardware_configuration`（B 桶：组态值）

**回答**：地址怎么分的、通道多宽、哪个节点在哪个子网/IO 系统、IP 是多少、F 地址是多少。

**B 是网络身份的唯一归属地**（决策 §4.1）：`NetworkAddress` / `SubnetMask` / `ProfinetDeviceName` /
`IpProtocolSelection` / `RouterAddress` 只在这里出现，A 里一概没有。

每一行都用**引用**定位它描述的对象（`device` + `rack` + `slot`），不复述型号、订货号这些 A 的字段——
需要"型号 + IP"时由调用方先问 A 再问 B，或按名 join。

```jsonc
hardware_configuration({
  aml_path?, device?,
  sections?: ['addresses','channels','tags','network','links','signals','f']   // 默认全开
})
// → {
//   addresses: [{ device, rack, module, slot, ioType, start, length }],
//   channels:  [{ device, module, slot, channels:[{name,type,ioType,number,width}] }],
//   tags:      [{ device, name, dataType, ioType, logicalAddress, comment? }],
//   network:   {
//     subnets: [{ name, type, nodes:[{ device, interface, label, ip, subnetMask,
//                                      profinetName, ioSystem }] }],
//     ioSystems: [{ device, number }]
//   },
//   links:     [{ name, kind:'port-port'|'node-subnet'|'interface-iosystem',
//                 sideA:{ device, interface }, sideB:{ device, interface } }],
//   signals:   [{ channel:{ device, module, slot, name },
//                 tag:{ device, name, logicalAddress, dataType } }],
//   fAddresses: [{ device, item, fSource, fDestination, lowerBound, upperBound }]
// }
```

`sections` 的选择器沿用 `project_info` 的既有约定，避免再造一套。

### 3.3 `hardware_parameters`（C 桶，未来；**对象模型**，需 `open_project`）

AML 给不了，只能读对象模型。可用的接口（反射已确认）：

- 通用：`DeviceItem.GetAttributeInfos()` / `GetAttribute(name)` —— 本项目 `project_info(include_attribute_infos)`
  已经在用同一机制，等于已经有一半；
- GSD：`GsdDeviceItem.GetPrmData(int, int, int) -> byte[]`（三个 int 的语义待实机）；
- 厂商结构化参数：`StructuredData` / `TableData`，经 `GetComposition(name)` 访问，组合名要运行期发现。

**形态建议**：不要做"参数白名单"，做**通用属性读取**——
`hardware_parameters({ device, item, attribute? })` 返回 `GetAttributeInfos` 的可用属性清单，
带 `attribute` 时返回该属性的值。理由：模块参数名随型号千变万化，白名单必然过期。

---

## 4. 分类决策

### 4.1 IP / PROFINET 名放 A 还是 B？——**已决定：放 B**

**决策**：A 只放静态身份（订购即定、组态里改不了的值），IP / `SubnetMask` / `ProfinetDeviceName` /
`IpProtocolSelection` / `RouterAddress` 一律归 B。

理由：它们是人赋予的设计值，和地址规划同源；混进 A 会让"身份"这个桶不再有定义。

**已知代价**（接受）：回答"这台设备是什么、IP 多少"需要 A、B 各调一次。
缓解手段有两条，按需启用，不要默认打开：

- B 的每一行带 `device`/`rack`/`slot` 引用，足以与 A 的返回按名 join；
- 若调用方明确要一次拿全，可给 B 一个**显式**开关 `join: 'identity'`，在每行附带 `name` / `orderNumber`——
  默认关闭，避免 B 又变成半个 A。

### 4.2 拓扑（子网 / IO 系统 / 节点归属 / 物理连线）——**已决定：并入 B**

拓扑是**关系**，不是任何单个元件的属性，但它 100% 由组态值构成（节点挂哪个子网、IO 系统编号）。
建议：**并入 B 的 `network` 段**，不单开工具。理由：单独开一个 `hardware_network` 会让"地址"与
"网络"分家，而用户问拓扑时往往同时问地址规划（"192.168.1.x 怎么分的"）。

---

## 5. 命名与兼容

- 字段名优先采用 **Openness 的属性名**（`PlantDesignation`、`Classification`、`IsBuiltIn`、`ChannelWidth`），
  AML 名放在文档的映射表里。这样将来对象模型工具能共用一套词汇，不用两张皮。
- 不叫 `hardware_summary`：`summary` 暗示"概览，细节另取"，与"按属性性质分组"的思路冲突。
- 与既有工具的分工：`project_info(devices)` 给的是**设备级**概览（含用户组），
  `list_plc_objects` 给的是**程序侧**对象；硬件工具只补"组态"这一块，不重复它们。

---

## 6. 复用的解析基础（三个工具共用）

1. `SupportedRoleClass/RefRoleClassPath` 判类（`Device` / `DeviceItem` / `CommunicationPort` /
   `CommunicationInterface` / `Node`），**不要**用 `RefBaseClassPath`（442 个全空）。
2. 属性读取统一走"元素 → `Attribute[@Name]/Value`"的 34 个已知名字，遇到未知名字放进 `extraAttributes`
   而不是丢弃（TIA 升级时能立刻看出新属性）。
3. `TypeIdentifier` 解析：`OrderNumber:` → MLFB；`GSD:` → GSD 标识；`System:Device.*` → 设备类型。
   手册提到的"版本内嵌在 `/` 之后"在本项目 0 例，但要兼容。
4. 地址组是**嵌套 Attribute**（`Address` → `1` → `{StartAddress,Length,IoType}`），不是元素属性。