# C 桶（参数）实施方案：对象模型读取

**日期**：2026-11-02
**前置阅读**：`HARDWARE-TOOL-TAXONOMY.md`（三桶划分与已实现的 A/B 工具）
**一句话**：C 桶做的是**通用属性读取器**，不是"参数清单"——因为参数名随型号变化，
Openness 也从不提供"这一型模块有哪些参数"的静态表，只有运行期的 `GetAttributeInfos()`。

---

## 0. 结论先行

| 判断 | 内容 |
|---|---|
| 能不能做 | 能。全部读取接口已在 V17 反射确认（见 §1） |
| 形态 | **一个工具** `hardware_parameters`，通用属性读取，不是逐参数白名单 |
| 前置 | **必须 `open_project`**（与 A/B 三个 AML 工具相反：那些只读文件，关掉工程也能跑） |
| 要不要独占访问 | **不要**。读属性不产生 undo 单元，包事务只会踩手册的事务禁区 |
| 要不要 dry_run | **不要**。只读，没有可预览的副作用 |
| 分几步 | P1a 设备项+通道属性 → P1b GSD 参数块 → P1c 端口/连线/MRP/MAC |
| 现在能做多少 | P1a 可立即开工（复用已有 helper）；P1b/P1c 各有一处语义要靠实机定，见 §5 |

---

## 1. 接口事实（V17 反射确认）

| 想读什么 | 接口 | 备注 |
|---|---|---|
| 设备项属性 | `DeviceItem.GetAttributeInfos()` / `GetAttribute(name)` | 继承自 `IEngineeringObject`，本插件已在用（`project_info(include_attribute_infos)`） |
| 通道参数 | `DeviceItem.Channels : ChannelComposition` → `Channel` | `Channel` 有 typed `Type` / `IoType` / `Number`，**参数走 `GetAttributeInfos()`** |
| 端口属性 / 连线 | `DeviceItem.GetService<NetworkPort>()` → `ConnectedPorts : NetworkPortAssociation`、`Interface : NetworkInterface` | `NetworkPort : DeviceItemFeature : HardwareFeature`（也支持 `GetAttributeInfos`） |
| MAC 地址 | **无 typed 属性** | 只能靠 `GetAttributeInfos()` 找名字；`DhcpSupportedMode.MacAddress` 只是枚举值，不是属性 |
| GSD 身份 | `GetService<GsdDeviceItem>()` → `GsdId` / `GsdName` / `GsdType` / `IsProfibus` / `IsProfinet` | 反射确认 |
| GSD 参数块 | `GsdDeviceItem.GetPrmData(int dsNumber, int byteOffset, int length) -> byte[]` | **三个 int 的语义待实机确认** |
| 厂商结构化参数 | `IEngineeringObject.GetComposition(name)` → `StructuredDataComposition`（`.Create()`）/ `TableData.Rows` | **组合名要运行期用 `GetCompositionInfos()` 发现** |
| MRP 域 | `MrpDomainOwner.MrpDomains : MrpDomainComposition` → `MrpDomain.DomainParticipants` | 反射确认 |
| 空槽位 | `HardwareObject.GetPlugLocations() -> IList<PlugLocation>` | `PlugLocation{Label, PositionNumber}` |

**类型关系已确认**：`Channel`、`NetworkPort`、`GsdDeviceItem` 都实现了 `IEngineeringObject`
（`Channel` 直接就是，另两个还实现 `IEngineeringService`，要经 `DeviceItem.GetService<T>()` 取）。
所以现有 helper 可以**原样**用在通道上，不需要为通道另写一套读取。

**可复用的现成代码**（`controller/OpennessHost.Project.cs`）：

`AttributeInfosOf(IEngineeringObject)` 返回 `{name, accessMode}`、`TryReadAttribute(target, name)`。
P1a 不需要新机制，只是把它们接到一个新操作上，并把**值**也读出来。

---

## 2. 为什么不能做"参数清单"

1. **名字随型号变**：AI 模块的 `SignalType`/`MeasurementRange`、F 模块的 `Failsafe_*`、
   GSD 设备的厂商自定义项，没有共同 schema。
2. **Openness 不给候选值**：`GetAttributeInfos()` 只给 `Name` + `AccessMode`，不给类型、不给枚举范围。
   想知道"能填什么"，只能读当前值反推，或在 TIA UI 里看。
3. **AML 又完全没有这一类**（见 taxonomy §1）——所以这一层只能"读对象模型发布的属性"。

结论：工具的语义是**"把这个设备项/通道发布的属性列出来，并给出你要的那些属性的值"**，
而不是"我知道某型模块有哪些参数"。

---

## 3. 工具设计

```jsonc
hardware_parameters({
  device,                    // 必填：哪个设备（AML 工具里的设备名）
  item?,                     // 设备项：路径或名字（"Châssis_0/3" / "200MOD5"），缺省=整台设备
  channel?,                  // 通道编号（只看某一通道），缺省=该设备项全部通道
  attribute?,                // 只取这一个属性（省略则返回清单）
  include?,                  // ['attributes','channels','gsd','structured','ports']，默认 attributes+channels
  mode?,                     // 'list'(默认，只列名字与 accessMode) | 'values'(连值一起读)
  max_items?,                // 设备项上限，默认 200
  offset?                    // 分页游标
})
```

返回：

```jsonc
{
  "device": "COF-BASE-A",
  "amlHint": "hardware_inventory 给出同一台设备的结构（型号/槽位/订货号）",
  "items": [{
    "name": "200MOD5", "slot": "4", "typeIdentifier": "OrderNumber:6ES7 134-6JD00-0CA1",
    "attributes": [{ "name": "SignalType", "accessMode": "ReadWrite", "value": "Current" }],
    "channels": [{ "number": 0, "type": "Analog", "ioType": "Input",
                   "attributes": [{ "name": "WireBreakCheck", "accessMode": "ReadWrite", "value": true }] }],
    "gsd": { "gsdId": "...", "gsdName": "...", "prm": { "ds": 1, "bytesBase64": "..." } },
    "ports": [{ "label": "P1 R", "connectedTo": [{ "device": "...", "port": "P2" }] }]
  }],
  "truncated": true, "nextOffset": 200,
  "counts": { "items": 200, "channels": 61, "attributes": 812 }
}
```

### 3.1 两段式读取（关键性能决策）

`mode` 把"发现"和"取值"分开：

- `list`（默认）：只对每个对象调一次 `GetAttributeInfos()`，给出名字与 `AccessMode`。
  这是回答"这型模块有哪些参数可查"的最低成本方式。
- `values`：在 `list` 之上，对**每个发布属性**调 `GetAttribute`。成本按属性数线性增长，
  所以默认只对 `item` 指定的范围做；整设备 `values` 要显式给 `max_items`。

理由：一个 1155 块工程的设备项可达数百、属性可达数千，盲目 `values` 会把一次调用拖到分钟级，
而多数问题只需要看某个模块。

### 3.2 值类型

`GetAttribute` 返回 `object`，可能是 `bool` / `int` / `double` / `string` / 枚举 / `DateTime`。
JSON 化规则：枚举用 `ToString()`；`DateTime` 用 ISO-8601；数组/`byte[]` 用 base64；
无法序列化的类型退化成 `ToString()` 并加 `"typeHint"`。**不做隐式转换**，让调用方看到原样。

### 3.3 错误与边界

| 情形 | 错误码 |
|---|---|
| 没开工程 | `project_not_open` |
| `device` 不存在 | `device_not_found`（`details.available` 给设备名） |
| `item` 路径不存在 / 有歧义 | `item_not_found` / `item_ambiguous`（`details.candidates`） |
| 属性不在 `GetAttributeInfos` 里 | `attribute_not_found`（`details.available` 给该对象的属性名清单） |
| UMAC / 保护导致读不了 | `access_denied`（`details.exceptionType`） |
| 非 GSD 设备要 `gsd` | `not_a_gsd_device` |

---

## 4. 与现有工具的分工

| 问题 | 工具 | 需要开工程 |
|---|---|---|
| 有哪些设备/模块/订货号/槽位 | `hardware_inventory` | 否 |
| 地址/网络/连线/信号映射 | `hardware_configuration` | 否 |
| 这个 AI 模块量程多少、诊断开了没、GSD 参数是什么 | `hardware_parameters` | **是** |

三者共用设备名做 join：A 给结构，B 给组态，C 给参数。**不要**让 C 重复返回 A/B 的字段，
只返回对象模型独有或更权威的内容。

---

## 5. 分阶段

### P1a — 设备项与通道属性（**已实现，2026-11-02**）

- 新操作 `HardwareParameters` + 工具 `hardware_parameters`；
- 复用 `AttributeInfosOf` / `TryReadAttribute`；新增 `ChannelComposition` 遍历；
- 支持 `device` / `item` / `channel` / `attribute` / `mode` / `max_items` / `offset`；
- 单测：参数转发、分页、错误码；无 TIA 环境下用替身对象验证不了 Openness，主要靠真机验收。

**验收**：对 SWT2 的 `200MOD5`（AI 4xRTD/TC）列出属性清单；`mode:'values'` 能读到数值；
与 TIA UI 的模块属性对话框逐项对照。

### P1b — GSD 参数块

- `GetPrmData(dsNumber, byteOffset, length)` 的**三个 int 语义要先实测**：
  猜测 `dsNumber` = 数据集号、`byteOffset`/`length` = 该数据集内的窗口；
  但"有哪些数据集、每个多长"没有 typed 接口，可能要按 `1..N` 试探并处理异常。
- 输出：`{ds, byteOffset, length, bytesBase64, bytesHex}`；写操作（`SetPrmData`）不在本方案。
- 风险：试探式读取在真机上可能触发异常或很慢；**先写一个只读探针脚本**跑一轮，再决定是否固化成工具。
- 目标实验对象：`110A2_A`（Control Techniques UniDrive，GSDML V2.31）、`GSD device_3`（Eurotherm EPack）。

### P1c — 端口 / 连线 / MRP / MAC

- `NetworkPort.ConnectedPorts`（读连线，注意 AML 已有 16 条 `InternalLink`，这里用于交叉验证或取 AML 没有的细节）；
- `MrpDomainOwner.MrpDomains`（环网域与参与者）；
- MAC：无 typed 属性，靠 `GetAttributeInfos()` 在端口/接口上找名字，**找到名字再固化**；
- 与 B 的 `links` 段重叠时，以对象模型为准，并标注两者差异（AML 是快照，对象模型是当前状态）。

---

## 6. 验证计划

| 阶段 | 目标工程 | 验收标准 |
|---|---|---|
| P1a | `SWT2_PEI_1026_Night` | `200MOD5` 属性清单非空；`values` 与 TIA UI 一致；耗时 < 10 s/设备 |
| P1b | 同上（含 4 台 GSD 设备） | 能取到非空参数块；异常时的错误码可读；耗时可控 |
| P1c | 同上 | 端口连线与 AML 的 16 条对比，差异能解释；MAC 若有则记录属性名 |

真实工程耗时未知，`requestTimeoutMs` 已设 900 s，足够；但工具要回报 `durationMs` 便于观察。

---

## 7. 明确不做

- **写参数**：`SetAttribute` / `SetPrmData` / `ConnectToPort` 都不在本方案。要做得单独设计
  （dry_run + 事务 + 回读验证），且风险远高于读。
- **参数语义解释**：不解释"SignalType=Current 意味着什么"，那是领域知识，留给模型/用户。
- **跨型号参数对照表**：不维护白名单，理由见 §2。

---

## 8. 实测结论（2026-11-02，`SWT2_PEI_1026_Night`，P1a 落地后）

**这一节推翻了方案 §2 的一半假设，必须读完再往下做。**

| 对象 | 发布属性数 | 内容 | 结论 |
|---|---|---|---|
| 标准 I/O 模块（RTD/TC 型，`200MOD5` @ `COF-BASE-A`） | **18** | 全是身份/元数据：`OrderNumber`、`TypeName`、`FirmwareVersion`、`PositionNumber`、`IsPlugged`、`TypeIdentifierNormalized`… | **没有量程/测量类型/滤波/断线检测** |
| **标准 I/O 模块（U/I 型，`200MOD5` @ `ET 200SP_1`）** | 18 + 通道更多 | 通道发布 `OperatingType=4`、`OperatingRange=16`、`InterferenceFrequencySuppression=19`、`Smoothing`、逐通道诊断 | **有，但值是枚举索引，不是工程量** |
| 标准模块的通道 | **5** | 只有 `ChannelAddress`、`ChannelWidth`、`Type`、`IoType`、`Number` | **没有通道参数** |
| **F 模块**（`200MOD4`，F-DI/F-DQ） | **57** | `Failsafe_FSIL=2`、`FMonitoringtime=150`、`FPassivation`、`FDestinationAddress`、`ShortCircuitTest_0..7`、`TimeForShortCircuitTest_*`、`StartupTimeOfSensorAfter*`、`FParameterSignature*`、`F_CRC_Length`… | **F 参数完整暴露** |
| F 模块的通道 | **17** | `Failsafe_Activated`、`DiscrepancyTime=50`、`InputDelay=4`、`SensorEvaluation`、`ChatterMonitoring`、`NumberOfSignalChanges=5`… | **通道级 F 参数也有** |
| CPU（`Sino_PEI`） | **78** | 循环时间、时钟存储器、Web 服务器全套、时间同步、保护、`Failsafe_CentralFSourceAddress`、OPC UA 许可… | **CPU 参数是最大的一块** |
| GSD 设备（`110A2_A`） | 每项 19–27 | 另有 `GsdDeviceItem` 服务：`gsdId`/`gsdName`/`gsdType`/`isProfinet` | 身份可读，参数字节块仍是 P1b |

**修定后的结论**：

1. **C 桶的价值集中在三处：F 模块（57 个属性）、F 通道（17 个）、CPU（78 个）**。
2. **标准 I/O 模块要看具体型号，不能一概而论**（`200MOD5` 在三个站是两种型号）：
   RTD/TC 型只发布身份属性；**U/I 型却发布了 `OperatingType`/`OperatingRange`/`InterferenceFrequencySuppression`
   /`Smoothing` 与逐通道诊断**。所以"标准模块没有参数"是错的，正确说法是"因型号而异"。
3. **但发布的是枚举索引，不是工程量**：实测 `InterferenceFrequencySuppression = 19`，
   而这个参数只可能是 10/50/60 Hz —— 说明 Openness 只吐索引，枚举文本没有暴露。
   因此**不允许**把 `OperatingRange=16` 翻译成"±10 V"之类的量程，那只能是编的。工具描述已按此修正。
3. `ChannelAddress` 是有价值的一列：AML 只给模块级 `StartAddress + Length`，通道级起始地址只有对象模型有。
   P1a 已把它提升为通道行的 `address` 字段，与 `mode` 无关地始终返回。
4. GSD 身份（`gsdId/gsdName/gsdType`）已在 P1a 的 `include: ['gsd']` 里可用；
   **P1b 剩下的只有 `GetPrmData` 的参数字节块**。

### 实测耗时（同一工程）

| 调用 | 耗时 |
|---|---|
| `OpenProject`（冷启动） | 64–123 s |
| 设备级 `mode:list`（`COF-BASE-A` 55 项 / 1137 属性 / 101 通道） | **4.0–4.6 s** |
| 单模块 `mode:values`（18 属性） | 0.25 s |
| F 模块子项 `mode:values`（57 属性 + 8 通道 × 17） | **4.0 s** |
| CPU `mode:list`（78 属性） | 1.7 s |
| GSD 设备 `mode:list`（34 项） | 2.3 s |

`mode:values` 的成本随属性数线性增长，这组数字支持 §3.1 的"两段式"决策：**先 list 再对目标 item 取值**。

### 顺带修正的两条设计

- **对象模型的树形与 AML 不同**：ET200SP 站里机架（`Châssis_0`）和模块是**兄弟**，AML 里却是父子。
  按 AML 路径 `Châssis_0/200MOD5` 会找不到。P1a 已加**回退解析**：整条路径失败时按最后一段在整台设备里
  找**最浅**的唯一匹配，因此 `item: "200MOD5"` 可直接用；错误信息里也给出 `availablePaths`。
- 通道挂在**同名子项**上（`200MOD5/200MOD5`），模块项本身 `channels` 为空。列表里会如实显示
  两行（父项 `ch=0`、子项 `ch=4`），没有做"自动下沉"这种隐式合并。