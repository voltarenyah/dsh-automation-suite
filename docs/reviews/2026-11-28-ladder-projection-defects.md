# LAD 投影缺陷评估与改进草案（2026-11-28）

> 对象：`0.2.6-pre/HF48e/ladder-projection-defects.md` 提出的三项缺陷。
> 方法：逐条对照源码（行号以当前 `main`，提交 `e196894` 为准）；用 HF48e 的只读库核对当前输出。
> 本文是**草案**，修改前需要用户确认第 4.4 节的验收条款修订。

---

## 0. 结论

1. **三项缺陷全部成立，根因都在代码里，且都能指到具体行。** 没有一项是 XML 或 PLC 程序的问题。
2. **更重要的是：我们的测试没能抓住它们。** 等价校验有三个盲区，合起来使得"零分歧"几乎没有信息量：
   - 只比较**终端**线圈，中继线圈从不被检查（缺陷 2 因此不可见）；
   - 只比较**普通**线圈（`Kind == Coil`），S/R 线圈整体跳过；
   - **跳过所有含盒/调用的网络**（参考库 4058 个网络里 2306 个，约 57%）——缺陷 1 与 3 的全部候选面都在这一块里。
   
   之前"33% 覆盖、零分歧"的结论需要修正：它证明的是"没被检查的那部分无法检查"之外的一小块一致，**不是正确性**。
3. **验收条款 5 与 6 互相冲突。** 缺陷报告要求 `171_PLS_Transfer` 的 rung 文本"不得变化"，但 HF48e 库里 171 的第 6、16 号网络本身带盒（`[Eq]`、`[Move]` 等）。修复缺陷 3 必然改变它们。见 4.4。

---

## 1. 证据核对

| 缺陷 | 代码位置（当前） | 核对结果 |
|---|---|---|
| 1 下标丢失 | `FlgNetworkGraph.cs:514-523` `FirstComponentName` 只取 `Component/@Name`；`:291` 与 `:511` 复用它 | ✅ 证实 |
| 1 下标丢失（logic） | `ProgramBlockLogicYamlWriter.cs:2158-2192` `GetInstanceDb` / `GetInstanceName` 只调 `FormatComponentName`，无下标 | ✅ 证实（**第二份实现**） |
| 2 中继线圈消失 | `SeriesParallelReducer.cs:285-288` 线圈有后继时只写 note；`:290-302` 只有终端才产生 `RungPath`；`:189-212` `Reduce` 只收终端线圈 | ✅ 证实 |
| 3 盒内操作数缺失 | `SeriesParallelReducer.cs:362-365` `OperandFor` 对 Box/Call 返回 `element.Name`（指令名），不看任何输入引脚 | ✅ 证实 |
| 验收 5/6 冲突 | HF48e 库 `ladderText`：171 带盒网络为 **6、16**；051 带盒网络为 3,4,5,6,7,10,12 | ✅ 实测（只读 SQL） |
| 051 第 5/6 段现状 | 与报告附录 A 完全一致（`[Eq]` 同形、无 `JogFunction_BtnEnable`、无 `ExecuteMotion`） | ✅ 实测 |

额外发现（报告未提）：
- `FormatSymbol` 路径（Access 操作数）**已经**正确保留下标（`FormatSymbolComponent`，`:2259-2277`），所以"普通变量带 `[9]`、实例丢 `[0]`"的差异原因是**实例路径用了另一套取名函数**——修复应当让两条路径收敛到同一个函数。
- `GetInstanceName` 用的是 `instance.Descendants()`，会把**下标表达式里的 Component 也拽进来**。例如 `S_IEC_Timer[i]` 会被渲染成 `S_IEC_Timer.i`。这是报告没覆盖的第二个潜在错误，修复时必须一起消除。

---

## 2. 逐条评估

### 缺陷 1：盒实例的数组下标丢失

- **根因**：两份独立实现（图谱侧 `FirstComponentName`，写出侧 `GetInstanceName`/`GetInstanceDb`），都只取组件名。
- **方案评估**：正确，改动小。
- **建议做法**：抽一个共享函数 `FormatInstance(XElement instance)`，按 `FormatSymbol` 的规则（沿 `Component` 子元素链、逐段调用 `FormatSymbolComponent`）渲染；图谱侧与写出侧都调它。**不要**保留两份。
- **必须处理**：下标可以是变量（`[i]`）而不是常量。`FormatSymbolComponent` 已经用 `GetAccessValue`，能覆盖这种情况；新函数要复用它，不能只取常量。
- **风险**：`Instance` 下 `Component` 的嵌套形态（单层 vs 多层）需用真实导出样本确认（见 4.5）。

### 缺陷 2：串联线圈链只标注末端

- **根因**：`Walk` 把"线圈有后继"当成"线圈不是终点"，于是只记 note 而不产生路径。线圈的写入语义被丢弃，只保留了它对下游条件的透明传递。
- **方案评估**：正确。
- **建议做法**：在 `Walk` 中，线圈**无论是否有后继**，都产生一条 `RungPath(prefix, coilId, kind, operand, IsOpenEnd: false)`（`prefix` 为线圈之前的步骤，不含线圈自身），然后**继续**沿 `out` 往下走。线圈本身仍不计入下游条件。
- **语义核对**：中继线圈的值 = 到达它的前缀条件，这与报告期望的 `(=) JogFunction_BtnEnable <- AxisEnabled AND [Eq ActMode=7]` 完全一致。
- **副作用**：路径数增加，`maxPaths`（400）更容易触发 `too-many-paths`。修复后要统计受影响网络数，必要时调大预算。
- **附带收益**：这条修复同时让等价校验能看见中继线圈（见第 3 节）。

### 缺陷 3：盒内操作数不进阶梯文本

- **根因**：`OperandFor` 对 Box/Call 只返回指令名；`StepName` 只输出 `[名字]`。输入引脚上的操作数从未被读取。
- **方案评估**：报告的"最小方案"是合理的：不展开完整表达式，只让盒子**可区分**。
- **建议做法**：为 Box/Call 生成一个"签名"：`指令名 + 关键输入引脚解析出的操作数`。
  - 输入源用 `TryGetInputSource(owner, pin)` → `Find(source).Operand`（Access 的符号文本或常量）。
  - **引脚归属要查两处**：Call/Instance 类盒的 `in`/`PT` 等引脚挂在 `Instance` 元素上，而不是 `Part`（代码注释 `:293-294` 已说明）。只查 Part 会全部查空。
  - 只查**一层**：输入来自另一个盒的输出时，写 `…`，不递归。避免递归与文本膨胀。
  - 每个签名限制约 80 字符，超出截断加 `…`。
  - 输出侧写入目标（`Move` 的 `out1` 写入变量）的接线形态需在样本中确认（见 4.5）。
- **依赖**：`TON`/`TOF` 的签名要用到实例名，所以**缺陷 3 依赖缺陷 1**，修复顺序必须是 1 → 3。
- **注意**：修复后，171 第 6、16 号网络会变化（见 4.4）。

---

## 3. 测试缺口（为什么没早发现）

| # | 缺口 | 位置 | 后果 |
|---|---|---|---|
| A | 只遍历 `rung.Coils`（终端线圈） | `SelfTest.cs:305` | 中继线圈从不比较 → 缺陷 2 不可见 |
| B | 只比较 `Kind == Coil`，S/R 线圈跳过 | `SelfTest.cs:308` | S/R 线圈从不比较 |
| C | 含 Box/Call 的网络整体跳过 | `SelfTest.cs:269` | 缺陷 1、3 的全部候选面不在检查范围（2306 / 4058） |
| D | 没有反向检查（翻译器有目标、rung 没有） | — | 漏标只会沉默 |
| E | 没有覆盖检查（网络操作数是否出现在文本中） | — | 任何"文本缺一块"都不会被发现 |

**这些缺口是结构性的**：等价校验只检查"存在的东西是否一致"，而不检查"该存在的东西是否存在"。缺陷 1–3 全部是后者。

---

## 4. 改进措施草案

### 4.1 立即可做：四条不变量（无需人工标注，覆盖全部网络）

在参考语料（`Sino_PEI`，4058 个网络）上全量运行，**修复前应当有违规，修复后必须为 0**：

| 编号 | 不变量 | 能抓住 |
|---|---|---|
| I1 | 双向线圈集：翻译器的目标集 == rung 线圈集（**含 S/R 与中继线圈**） | 缺陷 2、B、D |
| I2 | 操作数覆盖：网络内每个非常量 Access 的符号文本，必须**字面出现**在该网络的 `ladderText` 中 | 缺陷 2、3 |
| I3 | 实例下标：网络内每个 Call/Instance 的完整名（含下标）必须出现在该网络的 logic 语句中 | 缺陷 1 |
| I4 | 盒签名可区分：同一网络内，两个同名盒的签名不得完全相同 | 缺陷 3（量化用） |

I2 是关键：它不依赖任何"正确答案"，只要求**信息不丢失**，对缺陷 2、3 这类"少标"问题特别有效。

### 4.2 扩大覆盖面

- 把含 Box/Call 的网络从"跳过"改为"弱检查"：只跑 I1–I3，不做完整语义等价（盒的语义在别的网络，无法在本网络内判定）。
- 去掉 `SelfTest.cs:308` 的 `Kind == Coil` 过滤，让 S/R 线圈也进入比较。

### 4.3 修复顺序（依赖关系）

1. **先加测试，先红**：I1–I3 加进 `SelfTest`，在参考语料上记录违规数；另加 3 个合成夹具（串联线圈链、带变量下标的 TON、同形 Eq/Move）。
2. **缺陷 1**：共享 `FormatInstance`，两处调用；消除 `Descendants()`。验证 I3 归零。
3. **缺陷 2**：`Walk` 中线圈产生路径；验证 I1、I2 对中继线圈归零。注意 `maxPaths` 统计。
4. **缺陷 3**：盒签名（依赖第 2 步的实例名）；验证 I2、I4。
5. **回归**：全量语料违规计数前后对比；TS 套件 134 项；`engine --self-test`。

### 4.4 验收条款修订（**需要用户确认**）

| 条款 | 现状 | 问题 | 建议 |
|---|---|---|---|
| 5 | 两个 Move 可区分（TargetPos / TargetSpeed） | 合理 | 保留 |
| 6 | 171 的 1–26 网络 rung 文本**不得变化** | ❌ 与 5 冲突：171 的 6、16 网络带盒，缺陷 3 修复会改变它们 | **已采纳（用户确认，2026-11-28）**：以不变量代替逐字比对。修复后 171 必须满足 I1 = 0、I2 = 0、I3 = 0、I4 = 0；rung 文本的差异只允许出现在盒网络（修复前 I2 违规的 2 个网络）。171 没有串联线圈（I1 = 0），因此不会出现"新增中继线圈行"的差异 |
| 7 | WRITES 与 ladder 自洽 | 合理；依赖 I1 | 保留 |

此外，报告附录 B 的"影响面未量化"应在修复前完成：用 I1–I4 在参考语料上给出违规清单，作为修复的范围依据。

### 4.5 未决问题（需要真实 XML 确认，不能凭推断写代码）

1. **多层实例形态**：`<Instance>` 下的 `Component` 是单层还是嵌套？影响 `FormatInstance` 的遍历方式。
2. **写入型盒输出**：`Move` 的 `out1` 写入变量时，`Access` 出现在 `NameCon` 还是 `IdentCon` 里？影响缺陷 3 的签名（写入目标）能否读取。
3. **图谱层是否也要下标**：HF48e 的 `graph_nodes` 里没有 `S_IEC_Timer[0]` 节点。本次只修投影文本；`knowledge_variable_usage` 对数组元素是否需要同步下标，需要单独决策（它会影响"谁写了 `IO_MotionPara[9]`"这类问题的答案）。
4. **预算**：修复后 `maxPaths=400` 是否够用，需要在参考语料上统计触发次数。

---

## 5. 不做什么

- 不改 PLC 程序、不改导出 XML、不用 `import_blocks(override)` 修正任何块（沿用报告的红线）。
- 不把盒的完整表达式展开（沿用报告的最小方案）。
- 不在本轮修改 `logicStatements` 的语句形态（它是对照基准，改它等于改尺子）。

---

## 6. 验证计划

- **单元**：3 个合成夹具（串联线圈链；变量下标 TON；同形 Eq/Move）。
- **语料**：`Sino_PEI` 全量 I1–I4 违规计数，修复前后对比，记录在本文件末尾。
- **真实样本**：HF48e 的 `051_SingleServoControl` 第 3/5/6 网络，按 4.4 的验收清单逐条核对。
- **回归**：`171_PLS_Transfer` 按修订后的条款 6 核对，每个差异都要能解释。
- **部署**：修改 C# 后用 `dotnet build -c Release -o engine/bin` 重建（`engine/build.ps1` 被删除保护拦截，见 AGENTS 与 dsh-delete-guard）；已有知识库需重新 ingest；插件宿主需重启才会加载新 `lib/`。

---

## 7. 已落地：不变量与修复前基线（2026-11-28）

> 只加了检查与审计，**没有改任何功能代码**（渲染、取名、线圈路径都保持原样）。

### 7.1 实现

- `engine/Parsing/Flg/RungInvariants.cs`：I1–I4 为纯函数；`SelfCheck()` 用手工构造的坏输入证明探测器确实能抓住违规（不依赖 reducer，修复 reducer 不会让它变成同义反复）；`AuditFolder()` 统计整个导出目录。
- `engine/Program.cs`：新增 `--rung-invariants <exportRoot>`，输出 JSON。
- `engine/SelfTest.cs`：`--self-test` 调用 `RungInvariants.SelfCheck()`。自检结果：`[ok] rung invariants detect what they claim to detect`，`self-test: OK`。

### 7.2 修复前基线

| 语料 | 网络 | I1 线圈 | I2 操作数 | I3 实例 | I4 行 |
|---|---|---|---|---|---|
| 参考 `Sino_PEI`（1376 文件） | 4058 | 257 网络 / 358 线圈 | 2125 网络 / 11631 操作数（其中无盒网络 51 / 81） | 487 网络 / 519 实例（带下标 37，不带下标 482） | 138 网络 / 195 行 |
| HF48e `15_VOC_Door`（47 网络） | 47 | 3 网络 / 5 线圈 | 33 / 94 | 7 / 7（带下标 2，不带下标 5） | 2 / 8 |
| HF48e `171_PLS_Transfer`（26 网络） | 26 | 0 / 0 | 2 / 17（均为盒网络） | 0 / 0 | 0 / 0 |

参考库与 VOC 的 `errors` 均为 0。

与缺陷报告的交叉核对（只读）：
- I1 在 051 的三处正是缺陷 2 所列：`#35`（报告网络 3：`HS_ServoMove`、`MS_Global`）、`#5F`（网络 5：`JogFunction_BtnEnable`）、`#74`（网络 6：`SemiFunction_Enable`、`ExecuteMotion`）。
- I3 的带下标项正是缺陷 1：`S_IEC_Timer[0]`、`S_IEC_Timer[1]`。
- 171 的 I1、I3、I4 为 0，I2 只落在 2 个盒网络里，与"干净对照样本"的判断一致，也支撑了第 4.4 节的修订。

### 7.3 报告未列的新发现

- **N1：FB 调用的实例名整体缺失，不是下标问题。** 例：`005_Switch_PC` 中 XML 的实例是 `Switch_FrontLightCurtain`，逻辑文本只写 `Switch(Input := …)`。`Call` 分支取的是 `CallInfo/@Name`（类型名），实例 DB 从未进入文本。参考库 482 处，VOC 5 处（如 `PosSpdControl_Instance`、`S_SingleServoControl`）。它与缺陷 1 同属"读者看不到是哪个实例"，但机理不同，修复时需要单独的分支。
- **N2：多段实例在图谱侧只取第一段。** 参考库 1570 个实例中有 21 个是多段（如 `PC` 与 `T_Acces_Request` 是同层兄弟，不是嵌套）。图谱侧 `FirstComponentName` 只返回 `PC`；写出侧 `GetInstanceName` 用 `Descendants()` 拼出全部段，两侧不一致。这是第二份实现分叉的又一个实例。
- **N3：写出型接线的方向是反的。** `Move` 的 `out1` 写入变量，在 XML 里是 `<NameCon UId="49" Name="out1"/>` 配 `<IdentCon UId="29"/>`，`Build` 把 Access 记为 wire 的源、盒引脚记为目标。`IncomingWires(盒, "out1")` 能正确取到变量，但不能假设 `Wire.SourceElementId` 就是盒。修复缺陷 3 时必须按这条约定写。

### 7.4 第 4.5 节未决问题的回答

1. **多段实例形态**：是同层兄弟，不是嵌套（21 / 1570）。渲染规则是每个兄弟一段、用 `.` 连接；I3 的 `RenderInstanceChain` 已按此实现。
2. **写入型盒输出**：见 N3。
3. **图谱层是否也要下标**：未决，需要单独决策。本轮不处理。
4. **`maxPaths` 预算**：未统计。修复 I1 相关的中继线圈后，用同一审计再统计 `too-many-paths` 的触发次数。

### 7.5 工程状态

- **`engine/bin/` 未更新**：运行中的引擎进程（PID 32836，路径在仓库 `engine/bin`，父进程为 DeepSeek Harness）锁住了 `EngineeringGraph.Engine.exe`。我没有终止它。验证构建输出在 `engine/bin-check/`（临时产物，验证后删除）。替换提交物需要先停掉那个实例，再执行 `dotnet build -c Release -o bin`。
- 构建必须使用 .NET 10 SDK：`%USERPROFILE%\.dotnet10\dotnet.exe`。PATH 上的 `dotnet` 是 8.0，会报 NETSDK1045。

## 8. 修复回填（2026-11-28）

### 8.1 已修复

| 项 | 修复位置 | 修复前 → 修复后（参考库 `Sino_PEI`） |
|---|---|---|
| 缺陷 1（实例下标丢失）+ N2（多段实例只取第一段） | `ProgramBlockLogicYamlWriter.FlgNetContext.FormatInstance`（共享，逻辑与阶梯两侧都调用）；`FlgNetworkGraph.InstanceText` | I3 带下标违规 37 → 0 |
| 缺陷 2（中继线圈消失） | `SeriesParallelReducer.Walk`：每个到达的线圈产生一行，无论其后是否还有元件 | I1 257 网络 / 358 线圈 → 0 |
| 缺陷 3（盒内操作数不进阶梯） | `FlgNetworkGraph.BoxDescription`：指令名 + 实例名 + 接入输入/输出的变量与常量；EN 引脚除外；不截断 | I4 138 网络 / 195 行 → 0 |
| N3（写出型接线方向反置） | `BoxDescription` 同时接受两个方向（源为 Access 的 wire） | 写出型 Move 的变量进入盒签名 |

I2（操作数覆盖）：2125 网络 / 11631 操作数 → 216 网络 / 258 操作数（剩余见 8.3 的 N4）。

回归测试：`RungInvariants.SelfCheck` 新增三条渲染断言（串联线圈两行都在；比较盒带常量；TON 带下标），`--self-test` 全部通过。

### 8.2 对修订后验收条款的结论

- **HF48e `15_VOC_Door`（051）**：I1 = 0、I2 = 0、I4 = 0；I3 只剩 N1（逻辑视图的 FB 调用实例名，见 8.3）。阶梯文本实测输出见下。
- **HF48e `171_PLS_Transfer`**：I1 = I2 = I3 = I4 = 0，满足修订后的条款 6（差异只允许出现在盒网络，实际上 2 个盒网络的 I2 违规已消失）。
- **条款 7**（WRITES 与阶梯自洽）：依赖 I1，I1 已归零，但 `knowledge_network_accesses` 的 WRITES 对照尚未用新库核对，留待下一步。

051 第 3、5、6 网络的修复后阶梯输出（引擎直接导入 HF48e 的 PEI_1 后读取）：

```
network 3:  (=) SinaPos_Instance.EnableAxis <- HS_ServoMove AND [InRange 1, I_OperationMode, 3] AND MS_Global AND … AND [TON S_IEC_Timer[0], T#500ms]
            (=) S_HMI_Control.HS_ServoMove  <- HS_ServoMove
            (=) S_HMI_Control.MS_Global     <- MS_Global
network 5:  (=) S_HMI_Control.JogFunction_BtnEnable <- SinaPos_Instance.AxisEnabled AND [Eq SinaPos_Instance.ActMode, 7]
            (=) SinaPos_Instance.Jog1 <- … AND [Eq SinaPos_Instance.ActMode, 7] AND S_HMI_Control.JogDown
network 6:  (=) S_HMI_Control.SemiFunction_Enable <- SinaPos_Instance.AxisEnabled AND [Eq SinaPos_Instance.ActMode, 2]
            (=) IO_MotionPara[9].ExecuteMotion <- … [Eq I_OperationMode, 2] …
            -- (no coil) <- … [Move S_HMI_Control.TargetPos, IO_MotionPara[9].TargetPos] AND [Move S_HMI_Control.TargetSpeed, IO_MotionPara[9].TargetSpeed]
```

### 8.3 N1 与 N4：已按确认的格式修复

- **N1（FB 调用实例名）**：逻辑文本改用实例 DB 名 —— `FLCurtain_PC_DB(Input := …)` 而不是 `Switch(Input := …)`，与同网络里 `FLCurtain_PC_DB.SafetyOK` 一致，也与阶梯视图一致。
  - 实现：`CallNode` 新增 `InstanceName`（块类型仍保留在 `Name`，调用图按它建边，未受影响），调用语句用 `CalleeName(call)` 取"有实例用实例、无实例用类型"。
  - 未改 `Skill`/类型名语义的其他用途：`CreateCallNode` 的 `Name` 仍是 `CallInfo/@Name`。
- **N4（边沿触点的记忆位）**：按你选的格式 `PContact(operand, mem=bit)`，**保留指令全名**（`PContact`/`NContact`/`PBox`/`NBox` 各写各的，不用统一的 `P`），操作数保留完整名称含下标。
  - 实测：`PContact(Exch_CTR_DB.Report_In_Progress_Cav_A, mem=Exch_CTR_DB.BO_OS[0])`、`PBox(mem=Cav_A.ONS[50])`。
  - 覆盖范围：`PContact`/`NContact`（Contact 类）与 `PBox`/`NBox`（Box 类）四种，由 `HasEdgeBit` + `EdgeText` 统一处理。
- **盒子数据流向**：改为 `in -> out`。实测 `[Move S_HMI_Control.TargetPos -> IO_MotionPara[9].TargetPos]`、`[TON S_IEC_Timer[0] T#500ms]`。
  - 实现：方向取自**引脚**（`RoleOf`），不取自 wire 的源/目标 —— 因为写出型接线里变量是 wire 的源、盒的 `out1` 是目标（N3）。EN 引脚仍排除。

### 8.4 最终不变量结果

| 语料 | 网络 | I1 | I2 | I3 | I4 | errors |
|---|---|---|---|---|---|---|
| 参考 `Sino_PEI` | 4058 | 0 | 0 | 0 | 0 | 0 |
| HF48e `15_VOC_Door` | 47 | 0 | 0 | 0 | 0 | 0 |
| HF48e `171_PLS_Transfer` | 26 | 0 | 0 | 0 | 0 | 0 |

四项在全部语料上归零。修复前的基线见 7.2。

### 8.5 回归测试

`RungInvariants.SelfCheck` 现在有 6 条渲染断言 + 6 条探测器断言，全部通过：
串联线圈两行都在；比较盒带常量；TON 带下标；`PContact(.., mem=..)`；`Move src -> dst`；调用用实例名而非类型名。

`--self-test` 全绿；参考库等价校验 `coils=1338`（修复前 1323）零分歧；TypeScript 134/134 通过。

### 8.6 两项收尾：已处理

**A. `ProgramSemanticReference.GetInstanceDb`（第三份实例实现）——已验证并修复**

它是同一类缺陷的第三份拷贝（`instance` 下用 `Descendants()` 拼接、丢下标）。已改为委托 `FlgNetContext.FormatInstance`。

实测结论：本语料的 **Call 实例没有任何数组下标**（扫描 1376 个块，`CallInfo` 下带 `AccessModifier="Array"` 的实例 = 0），所以这一处是**正确性加固，语料上看不出差别**。多段实例（`PC.T_Acces_Request` 等 4 例）都挂在**指令盒**上，走的是图谱那条路，已由 N2 修复并通过阶梯文本验证。

**B. `GetSymbolName`（同一文件的符号取名）——发现并修复了更严重的问题**

它同样丢下标，而它生成的是**引用图的变量节点名**。后果比实例名更重：

| | 修复前 | 修复后 |
|---|---|---|
| 数组元素节点 | `symbol:IO_MotionPara.ExecuteMotion`（10 个元素合成 1 个节点） | `symbol:IO_MotionPara[9].ExecuteMotion` |
| 含下标的符号节点（参考库） | 122 | 437 |
| 图规模（参考库） | nodes=118271 / edges=291543 | nodes=119230 / edges=295170 |

修复后仍保留原来的门槛：只有带 `<Symbol>` 的 Access 才算变量引用，常量/标签照旧返回空并被跳过。

真实数据验证（`CoolingCoupelleSWT2`）：

```
[Ge statProductData[1].CoolingTime.ET, statHMI.CC[1].Parameter.coolingTime_Min]
[TONR statProductData[2].CoolingTime T#1h]
```

`statProductData[1].CoolingTime` 同时含下标与嵌套成员——旧实现会渲染成 `statProductData.1.CoolingTime`（把下标表达式里的常量也当成一段）。

**注意**：变量节点身份变了，**旧知识库必须重新 ingest** 才能看到这个修复，否则 `knowledge_variable_usage` 仍会按合并后的节点回答。

**C. 原验收条款 7（WRITES 与阶梯自洽）——已用新库核对**

新增 SelfTest 断言：LAD 网络里被标记为 WRITES 的目标，必须出现在该网络阶梯文本中。

结果：参考库 **6692/6692** 全部可见（修复前，中继线圈被吞会直接违反这一条）。当前不变量：

| 语料 | 网络 | I1 | I2 | I3 | I4 | WRITES 可见 |
|---|---|---|---|---|---|---|
| 参考 `Sino_PEI` | 4058 | 0 | 0 | 0 | 0 | 6692/6692 |
| HF48e `15_VOC_Door` | 47 | 0 | 0 | 0 | 0 | — |
| HF48e `171_PLS_Transfer` | 26 | 0 | 0 | 0 | 0 | — |

### 8.7 回归测试

`RungInvariants.SelfCheck` 现有 8 条渲染/命名断言 + 6 条探测器断言：
串联线圈两行都在；比较盒带常量；TON 带下标；`PContact(.., mem=..)`；`Move src -> dst`；调用用实例名而非类型名；`statProductData[1].CoolingTime`；`PC.T_Acces_Request`。

`--self-test` 全绿；参考库等价校验 `coils=1338` 零分歧；TypeScript 134/134 通过。

### 8.8 工程状态

- `engine/bin/` 已重建（含全部修复）。测试环境（3095）残留进程已停止。
- 工作区改动已提交（见提交信息）。

## 9. 可达性与可理解性复核（2026-11-28 晚）

> 问题：agent 是否会在正确的时候用上阶梯视图？除工具描述外还需要什么？符号表达是否可理解？

### 9.1 四个可达性缺口（均已修）

| # | 缺口 | 证据 | 修法 |
|---|---|---|---|
| R1 | **expert persona 说 LAD 触点/线圈接线"看不见"**，让 agent 去问用户——正好否定了新能力 | `profile/.../cordis.patch.yml` expert 段旧文本："LAD contact and coil wiring, or an enable condition, because the translation is statement-level" | 改为：这些接线**就在** `view='ladder'` 里；真正缺的只剩"盒内算出的条件"和"运行时值"。这类错误有先例（同文件 D29：一句 brief 让三个子 agent 绕开图谱去读 XML） |
| R2 | **leader persona 完全没提阶梯视图**，只说"有 `knowledge_block`/`knowledge_network`" | 同文件 leader 段 | 补一句：问"哪些触点通向这个线圈"时传 `view='ladder'` |
| R3 | **读法指南没随包发布** | `package.json` 的 `files` 只有 `lib`/`cordis.patch.yml`/`engine/bin`/`README.md`，`docs/` 不在其中；而描述写着 "The reading guide is docs/LAD-READING.md in this package" | ① `files` 加 `docs`；② **符号表直接写进工具描述**，不再依赖文件可达 |
| R4 | **默认视图是 logic，短网络没有任何提示** | `NEXT:` 提示只在分块（`hasMore`）时出现 | 回 `logic` 且该网络有阶梯文本时，追加一行 `Also available: view='ladder' — …` |

### 9.2 符号可理解性：实测，不是推断

用不知情子 agent 做盲测：只给「工具描述 + 真实阶梯文本」，禁止读文件、禁止搜索，回答可判定对错的问题。

**第一轮（修正前的说明）**：7 问中 5 问正确（数据流向 `->`、计时器实例与 `PT`、`in1` 在左、"看不到盒内条件"），2 处失败/存疑，且**都是我文档写错**：

| 暴露的问题 | 事实 | 已修 |
|---|---|---|
| 它问：`-- (no coil)` 行上的 `[Move]` 到底写不写？ | **写**。该行只是不写线圈，盒子在 RLO 为真时照样执行。原文"ends without writing"是错的 | 描述与文档改为"writes no coil, but a box on it still executes" |
| `[InRange a, b, c]` 谁是"被比较值"？ | 中间那个（引脚序 `min`/`in`/`max`）。原文没写 | 描述与文档写明"tests the middle operand" / "下限、被比较值、上限" |

**第二轮（修正后）**：5/5 全对，包括两处原先答错的（`-- (no coil)` 行上的 Move 会写；InRange 的中间操作数），以及"看不到运行时真值"的边界判断。

结论：**可理解**，前提是符号表就在描述里。剩余未标注、但盲测未造成误解的两处：
- 计时器 `[TON Inst PT]` 里除实例外只有一个操作数，靠位置识别（本轮无歧义，因为 TON 只有 `IN`/`PT` 两个输入且 `IN` 已被 RLO 占用）；
- 块调用 `[058_PosSpdControl Inst, a, b]` 的实参**不带引脚名**，只按引脚顺序。若以后出现同名类型实参顺序被误读的案例，可升级为 `[Inst pin=value, …]`。

### 9.3 生效前提（重要）

persona 的改动在**蓝图**里，而运行用的是**物化副本**：

- 物化副本 `<DSH_HOME>/profiles/dsh-automation-suite/cordis.patch.yml`（2026-11-28 12:33 版本）里仍是旧文本：旧断言命中 1 次、`view='ladder'` 命中 0 次。
- **不要用 `-Reset` 同步**：该副本里有 `requestTimeoutMs: 600000`，蓝图里没有（蓝图是默认 300000），Reset 会把它丢掉。应按 AGENTS §1 注意 4 的方式**合并**persona 段落。

## 附：修复后的验收回填（已由第 8、9 节替代）
