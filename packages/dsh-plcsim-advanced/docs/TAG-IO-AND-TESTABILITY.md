# PLCSIM Advanced 变量 I/O 与"块行为测试"可达性

> 依据：本机 `S7-PLCSIM Advanced API, Programming Manual, V7.0, 11/2024, A5E53246567-AC`
> （`C:\Program Files (x86)\Siemens\Automation\PLCSIMADV\documents\en-US\s7-plcsim_advanced_function_manual_API_en-US.pdf`）
> 与实际安装的程序集（API 3.0/4.0/4.1/5.0/6.0/7.0，`C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API`）。
> 本文只记录**可复核**的 API 事实与由此推出的测试可达性规则；"待实测"的地方明确标注。

## 1. 结论

- 变量读写**不经过 TIA Openness**：Openness 的在线面只有连接/状态/下载/上传/比较，
  没有变量 I/O（见 `packages/dsh-tia-openness-v17-min/scripts/coverage/matrix-data.mjs`
  的"在线与下载"主题）。
- PLCSIM Advanced 的 Runtime API 提供：符号名读写、I/Q/M 按地址读写、批量信号、
  周期控制（单步/时间同步）、快照存档。**这些足够做"块行为测试"，但不等于"任意块都能直接测"**。
- 是否可行由三件事决定：**实参是否落在可寻址存储**、**输出是否被同周期后续代码覆盖**、
  **块是否真的被调用**。三者缺一，黑盒测试就不成立，必须改程序（测试 OB / 探针）。

## 2. API 版本事实

| 能力 | 首次出现 | 备注 |
|---|---|---|
| 标量 `Read*/Write*`、`ReadSignals/WriteSignals`、`IIOArea`、`OperatingMode` | 4.0 及更早 | 本包控制器编译基准是 4.0 |
| `ReadString/WriteString/ReadWString/WriteWString` | **5.0** | 4.0 程序集里完全没有这两个方法 |
| 结构/数组整体读写 | **任何版本都不支持** | 手册：`NotSupported`（"Access to entire structures or arrays is not supported"） |

> 本包 `AGENTS.md` 规定控制器钉在 API 4.0（`Private=false`，运行时从安装目录解析）。
> 要用字符串读写，必须把编译基准抬到 ≥5.0 并重新验证 4.0–6.0 runtime 的兼容性，
> 这是策略变更，不是顺手改引用。

## 3. Tag list（`UpdateTagList` / `TagInfos`）

- 默认 `UpdateTagList()` = **`ETagListDetails.IOMCTDB` + `IsHMIVisibleOnly = true`**
  （手册 8.5）。也就是说默认只收 **"HMI Visible"** 标记的变量。
  **当前实现的 `RefreshTags` 先调无参版本、只在异常时回退到 `(IOMCTDB,false)`
  （`controller/Program.cs:741`）——这是错的**：只要第一次调用成功，非 HMI 可见的
  DB/STAT 变量就不在表里，随后 `tag_not_found`。应始终显式传 `false`。
- 结构：**结构本身一个条目 + 每个元素一个条目**，名字如 `"StructName"."ElementName"`。
- 数组：**数组本身一个条目 + 每个元素一个条目**，元素名形如 `ArrayName[a,b]`（各维首索引）。
- 未知类型（`EDataType.Unknown`）**不进表**。
- 上限 **500000 条目**，超了报 `NOT_ENOUGH_MEMORY`；大工程用
  `in_DataBlockFilterList`（只保留指定 DB，字符串写法见手册 8.5）收窄。
- 刷新后如果块被改名/新下载，要重新 `UpdateTagList`；`GetTagListStatus` 可判断是否过期。
- **读/写 API 都要求实例处于 RUN**（否则 `InstanceNotRunning`）。

## 4. 按符号名读写

- 支持 Bool、整数族、Float/Double、Char/WChar（4.0）；String/WString/String（≥5.0）。
- 类型用 `STagInfo.PrimitiveDataType`（`EPrimitiveDataType`）选读写方法，用
  `STagInfo.DataType`（`EDataType`）决定展示/解释（如 `Time` 的 primitive 是 Int32，
  按毫秒解释；`Date` 按天解释）。**当前实现按 `DataType` 字符串 switch，遇到
  `Time/Date/DTL/LWord` 等直接 `unsupported_type`——应改成按 `PrimitiveDataType` 分派。**
- 写比读的类型兼容更严格（手册 Table 10-98/10-99）；例如读可以用更宽的整数类型，
  写必须用目标 primitive。
- `ReadSignals/WriteSignals`：一次 API 调用读写多个信号，且第一次调用后会在
  `SDataValueByName` 内部缓存加速；**要做轮询/采样就固定用同一组信号列表**。
- `ReadSignals(...WithCheck, out changed)` 直接告诉你"自上次调用以来是否变化"，
  不必自己做 diff。

## 5. I / Q / M 区域（`InputArea` / `OutputArea` / `MarkerArea`，`IIOArea`）

- 按 **字节偏移 + 位** 读写：`ReadBit/ReadByte/ReadBytes`、`WriteBit/WriteByte/WriteBytes`；
  无需建测试 DB，也不需要符号存在。
- 手册 8.6.1/8.6.2：
  - 输入只能当输入用；**API 写输入是可见的**，但"通过 STEP 7/通信写进输入区的值在 API 里不可见"
    （API 只读自己写的值）。
  - 输出可写可读；**API 写与程序写同一区域冲突时，API 写优先**。
  - 内存区在**周期控制点**以及与**循环/非循环 OB 调用（PIP、中断、事件）**时与过程映像同步。
  - **实例必须 RUN** 才会应用 API 写入。
- `EArea` 允许 `{Input, Marker, Output}`；直接 I/O 访问（PEEK 等）也落到这块内存。
- F（故障安全）I/O 的同步有额外条件（需插 F 模块且 F 程序用到该模块的至少一位），
  见手册 8.6.1 Note。

## 6. 周期控制（这是"确定性测试"的关键）

| 模式 | 同步点 |
|---|---|
| `Default` | 不冻结；可开 `SendSyncEventInDefaultMode`，每个周期结束触发 `OnSyncPointReached` |
| `SingleStep_C` | 周期控制点（OB1 周期结束） |
| `SingleStep_P` | 读取过程映像分区之前 |
| `SingleStep_CT` | C + 最小周期时间（**默认覆盖为 100 ms 虚拟时间**，可设 0–6 s） |
| `SingleStep_CP` / `CPT` | C + P（+T） |
| `SingleStep_Bus` | C + 总线发送时钟 |
| `TimespanSynchronized_*` | 到周期控制点冻结，`StartProcessing(ns)` 至少跑指定虚拟时间 |

- 冻结后调用 `RunToNextSyncPoint()` 才继续到下一个同步点。
- `WaitForOnSyncPointReachedEvent(timeout)` 阻塞到下一同步点（返回虚拟时间等）。
- 虚拟时钟是用户程序的基准；`ScaleFactor` 可加速/减速；`SystemTime` 可设定。
- **没有"块级/语句级断点"API**。`HOLD` 状态只描述"TIA 里设的断点命中"，API 无法设置断点。
  所以自动化测试的时间粒度 = **一个同步点（通常是一个 OB 周期）**。

## 7. 注入点规则（能不能"模拟输入"）

> 铁律：**不要写块的形参，写"调用点实参的存储位置"**。调用发生时由调用者把实参值送进
> 块/实例 DB，你在形参上写的值会被覆盖。

| 实参/输入落在 | 可注入 | 怎么注入 |
|---|---|---|
| `%I` / 符号输入（PII） | ✅ | `InputArea.WriteBit/WriteByte`，或符号 `WriteBool("输入名")`；在周期边界写 |
| `%M` | ✅ | `MarkerArea` 或符号 |
| `%Q` | ⚠️ | 可写，但 API 写优先于程序写；不要对"你要测的输出"做写 |
| 全局 DB（含 HMI DB） | ✅ | 符号写（注意 HMI-visible 过滤与结构/数组元素命名） |
| 上游 FB 的实例 DB 成员 | ✅ | 符号写；前提是该成员不被本周期更早的代码覆盖 |
| **被测 FB 自己的 `IN` 形参**（实例 DB 成员） | ❌ | 调用者在调用前每周期重写它；写了也白写 |
| 临时变量 / 表达式 / 常量 | ❌ | 不可寻址，API 没有对应入口 |
| 间接寻址/指针算出、且不在 tag list 的对象 | ⚠️ | 不在表里就 `DoesNotExist`；只能驱动其来源 |

## 8. 观测点规则（能不能"拿到输出"）

| 输出落在 | 可观测 | 说明 |
|---|---|---|
| **被测 FB 实例 DB 的 `OUT` / `STAT`** | ✅✅ | 最忠实：块自己写的值，不受调用者/下游覆盖 |
| 全局 DB | ✅ | 若同周期后面还有写者，看到的是最后一次写的值 |
| `%M` | ✅ | 同上 |
| `%Q` | ✅ | 周期结束后读 `OutputArea`；同样"最后写者胜" |
| 临时变量 | ❌ | 不可寻址 |
| 只被下游消费、自身不落存储 | ❌ | 除非加探针 |
| 块内中间值 | ❌ | 无块级断点；只能改程序加探针 |

## 9. 明确不可行（不改程序就做不到）

1. 形参接到临时变量/常量/表达式；
2. 输出在同一周期内被后续代码覆盖，而你需要的是块自己的值；
3. 块被条件调用，且条件无法通过可寻址变量满足；
4. 需要块内某条语句执行后的中间值；
5. 块只执行一次（启动 OB）或由非周期事件触发，且虚拟时间/事件无法重放；
6. 变量类型未知（不在 tag list）或用了 API 不支持的整结构/整数组访问。

## 10. 三种工程打法

### A. 黑盒整机激励（不改程序，首选）
用图谱静态算出实参绑定 → 在周期边界写实参存储 → 步进 N 个同步点 → 读观测点 → 断言。
优点：测的是真实上下文；缺点：可注入性和覆盖性受程序写法约束，需先做可达性分析。

### B. 测试 OB / 测试实例（改程序，隔离最好）
新建测试 OB（如 OB123），用**专用 instance DB + 专用测试 DB** 调用被测 FB/FC；
下载测试工程。优点：输入输出完全隔离、可重复；缺点：测的是"块的副本调用"，不是生产接线，
且需要维护测试分支/测试工程。**这是 PLC 单元测试的标准做法**。
同一虚拟设备重新下载不需要再点证书（证书只与设备身份绑定）。

### C. 探针（改程序，最小侵入）
在块调用后加 `"ProbeDB".x := <表达式>;`，观测 FC 中间结果或被覆盖前的值。
只适合调试构建；会改变被测程序。

### 关于"快照"
`simulation_instance(snapshot)` 是 `ArchiveStorage` 的**程序+硬件+保持性数据**存档，
需要实例 OFF，适合"基线/变体"，**不适合当每个用例的廉价内存快照**。用例隔离优先用
`MemoryReset`（重启+总体复位）或重新下载；`resume` 快照只恢复保持性数据，
非保持性 DB 会回到起始值——依赖这些值的用例必须显式重新建立状态。

## 11. 静态可达性分析（下载前就能给判定）

现有 `dsh-engineering-graph` 的图谱已含：`CALLS`、`CONNECTED_TO`、`READS`、`WRITES`、
`EXECUTES_BEFORE/AFTER`、`REFERS_TO`，以及渲染后的调用语句（含实参绑定）。
`knowledge_variable_usage` 给出变量全部读写点，`knowledge_network` 给出网段读写与调用语句。

对被测块应产出：
- 调用链（哪个 OB/FB 调它、是否条件调用、每周期几次）；
- 每个 `IN/IN_OUT` 实参落在哪种存储（I/M/Q/DB/临时/表达式/常量）；
- 每个 `OUT` 的去向，以及"同周期后续还有谁写它"；
- 结论：可注入点清单 / 观测点清单 / 覆盖风险 / 建议用 A 还是 B。

这一步（testability analyzer）应该是测试执行器的前置，而不是执行器本身。

## 12. 对现有实现的立刻可做修正

1. `RefreshTags` 改为一律 `UpdateTagList(ETagListDetails.IOMCTDB, false)`
   （或用 `in_DataBlockFilterList` 收窄），否则大量非 HMI 可见变量不可见。
2. 读写分派从 `DataType` 改为 `PrimitiveDataType`；补 Char/WChar；Time/Date/LTime 等按
   primitive + 语义解释展示。
3. `Tags` 增加批量：`ReadSignals/WriteSignals`，返回每信号 `ErrorCode`。
4. 增加"周期同步"原语：`SendSyncEventInDefaultMode` + `WaitForOnSyncPointReachedEvent`，
   或 `OperatingMode=SingleStep_CT` + `RunToNextSyncPoint` + `OverwrittenMinimalCycleTime`。
5. `simulation_tags` 的 `write` 保留 `confirm`，但测试执行器内部按用例一次性确认，
   不要逐步弹闸门。
6. 字符串支持是 API ≥5.0 的新能力；当前 4.0 基线只能先做"不支持"的明确报错。
