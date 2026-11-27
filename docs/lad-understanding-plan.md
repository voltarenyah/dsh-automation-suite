# LAD 理解能力落地执行计划

> 状态：**待执行** · 2026-11-27 · 范围：读侧（理解 LAD），不含生成器、不含 dry-run 校验与导入回报修复
> 依据：会话 `session-3faa591a` 的复盘；`engineering-graph` 与 `tia-openness` 的现有代码（路径与行号均已核对）。
> 配套：[`ui-changes-panel-plan.md`](ui-changes-panel-plan.md) 等同类计划的写法；工作笔记约定见 [`notes-convention.md`](notes-convention.md)（仍为提案）。

---

## 0. 一句话目标

让 agent 对任意一个 LAD 网络，能像人一样回答四类问题：**这个线圈在什么条件下被置位/复位？这个位被谁写、被谁读？这一拍读到的是哪一拍的值？这一段在工艺上是干什么的？** 每个答案都能回溯到图里的具体元素与连线，而不是靠 agent 从展平的布尔语句里猜。

---

## 0. 执行进度（2026-11-27）

| 阶段 | 状态 | 产物 / 证据 |
|---|---|---|
| 0 语料盘点 | ✅ 完成 | [`research/lad-corpus-inventory.md`](research/lad-corpus-inventory.md)；`scripts/research/lad-census.ps1`（两次输出逐字节一致） |
| M0 TIA 实验 | ✅ 收尾（E7、E8 不做） | [`research/tia-lad-structure-rules.md`](research/tia-lad-structure-rules.md) 第 7、8.3 节 |
| 1 元素图模型 | ✅ 完成 | `engine/Parsing/Flg/FlgNetworkGraph.cs`、`FlgPinRoles.cs`；自检 `LAD element graph` |
| 2 串并联归约 | ✅ 完成（形态改为路径枚举） | `engine/Parsing/Flg/SeriesParallelReducer.cs`；自检 `rung reducer` |
| 3 三方等价校验 | ✅ 完成 | `engine/Parsing/Flg/BooleanExpression.cs`；自检 `rung equivalence`（reference：1323 线圈零分歧） |
| 4 呈现层 | 🟡 阶梯视图完成，`exec` 视图未做 | `engine/Parsing/Flg/LadderText.cs`；节点属性 `ladderText`；`knowledge_network(view='ladder')` |
| 5 入库与时序 | 🟡 时序标注完成；`flg_*` 表按 LAD-08 暂不建 | `scanOrderNotes`；`knowledge_variable_usage` 的 `Scan order` 段 |
| 6 技能文档 | ✅ 完成（形态改为包内文档 + 工具描述） | [`LAD-READING.md`](../../packages/dsh-engineering-graph/docs/LAD-READING.md) |
| 7 评测 | ✅ 收尾（**决定不跑分**） | 题库与判分标准就绪：`scripts/eval/lad-qa/`；质量证据改用等价校验 |

**阶段 1 的实际形态与计划的差异**（记录在此，便于复核）：

1. 计划写的是"把 `FlgNetContext` 内部改为调用 `FlgNetworkGraph`"。实际做法是**新增独立模型**，`FlgNetContext` 只把 UId/符号读取和引脚角色判定改为共享（`internal`），没有改它的语句生成流程。理由：先拿到可测的结构模型，再在阶段 2 需要时逐项替换，避免一次性重写翻译器。
2. T1-b（语句逐字零回归）**没有用黄金文件**，而是用既有的 `LAD logic: 3957/4142` 与 TS 128 项测试作为回归闸门。原因：本次未改任何语句生成逻辑，只改了可见性。真正需要黄金文件的时点是阶段 2/5 触到翻译器时，届时补 `--dump-logic` 与黄金文件。
3. 阶段 1 新增了两条真实导出才暴露的语义，已写入 `packages/dsh-engineering-graph/docs/decisions.md` **LAD-04**：`OpenCon/@UId` 不是元素引用；`Call` 引脚方向来自 `<Parameter Section>`。

**验收实测**（reference 工程，`engine/bin` 的构建）：`networks=4058 elements=58340 wires=61487 negated=2775 withBox=1792`，零诊断；`negated=2775` 与语料普查完全一致。

**阶段 2 的实际形态与计划的差异**：计划写的是"归约成 rung 树（`Series`/`Parallel`）"，实际实现为**路径枚举**（电源轨 → 终端的完整路径）。理由与取舍见 `packages/dsh-engineering-graph/docs/decisions.md` **LAD-06**：树需要从合流点反推分叉点，路径不需要，且路径可直接转成"或之与"表达式，正好供阶段 3 与 `logicStatements` 比对。阶段 4 的阶梯图由路径按共享前缀合并得到。

**阶段 2 验收实测**（reference 工程）：`structured=4058 unstructured=0 coils=3994`，归约过程无异常。

**阶段 4 的实际形态**（与计划的差异）：
1. 阶梯文本在 **C# 侧渲染**（`LadderText.cs`），而不是 TS。理由是它需要归约结果，而归约在引擎里；TS 只负责把节点属性里的 `ladderText` 取出来渲染，格式迭代不需要重建引擎。
2. 存的不是新的 `flg_*` 表，而是 **network 节点属性 `ladderText`**。属性表已存在，读取走 `graph_node_properties` 子查询（与 `segmentKind`/`regionPath` 同一模式），旧库缺该属性时退化为"无阶梯视图"，不会 SQL 报错。
3. `view` 参数只有 `logic`（默认）与 `ladder`。**`exec`（STL 式线性化）未做**：它的信息量主要被阶梯视图的"每条路径一行"覆盖，且真正需要执行序时要的是"同拍/跨拍"，那属于阶段 5 的时序标注。
4. `rw` 视图不需要新参数：`knowledge_network` 的回复本来就有 `Writes(n)/Reads(n)` 两行。

**阶段 5 的实际形态**：只做了时序标注（`knowledge_variable_usage` 的 `Scan order` 段：同拍/上一拍、多写者谁赢、无写入者），`flg_*` 表按决策 LAD-08 暂不建。理由见 LAD-08：当前被消费的是"一个网络的可读结构"与"一个变量的时序"，属性 + 既有访问表足够；跨网络结构查询留到有明确需求时再补表。

**阶段 6 的实际形态**：读法指南写进包内 `docs/LAD-READING.md`，并把浓缩版写进 `knowledge_network` 的工具描述。**没有**放进 `skills/tia-openness/`：该路由 `SKILL.md` 已 8114 字符（上限 8192），而仓库约定明确"运行时模型真正看得见的是工具描述与 skill 目录"。工具描述是常驻可见的，比一个需要加载的 skill 文件更可靠。

**阶段 7 的实际形态**：题库生成器与判分标准已就绪（从数据库生成真值，含"排除不透明步骤""排除超过 6 条备选"两条数据质量规则）。**尚未实际跑分**，因为评测需要在装有本插件的会话里进行，而当前会话的 profile 没有加载它。

**阶段 4 的回归守卫**（2026-11-27 补）：两道，见 `packages/dsh-engineering-graph/docs/decisions.md` **LAD-11**。
1. 引擎自检的 DB 断言：`ladder text: 4058/4142`（差额 84 条写明原因），防止"算了但没入库"。
2. `test/16-ladder-end-to-end.test.mjs`：真实引擎 ingest → 查属性 → 真实工具 `view='ladder'`，防止"入库名与查询名对不上"。

**阶段 4 验收实测**：小规模端到端（`00_Common_Part` 组）入库后 `graph_node_properties` 里 `ladderText` 共 76 条，内容形如 `(=) Clock_100Hz <- NOT Clock_100Hz`、`-- (no coil) <- Starting_Value.CPU_Cycle_Time_Enable AND Runtime`。TS 侧新增 2 个用例（有阶梯视图时替换语句文本、缺阶梯视图时回退并说明），共 130 项全绿。

---

### 收尾结论（2026-11-27）

计划到此结束。**阶段 7 的模型跑分决定不做**（用户决策）：跑分需要在装有本插件的会话里调用 `knowledge_*`，当前会话的 profile 没有它；用"另开会话"的方式换来的数据，其可比较性也有限（单次、单模型）。质量证据改用**等价校验**——两个独立实现（路径求值 / 语句翻译）在 reference 工程 1323 个纯布尔线圈上零分歧，这比一次问答取样更可复现。

因此 `knowledge_network` 的默认 `view` **保持 `logic`**，阶梯视图由调用方显式选择。若将来要切换默认值，`scripts/eval/lad-qa/score.md` 的门槛仍然有效，直接照做即可。

**本次交付的东西**：
- 引擎里一条从 XML 到可读结构的独立管线：元素图（`FlgNetworkGraph`）→ 路径归约（`SeriesParallelReducer`）→ 阶梯文本（`LadderText`），以及一个只用于交叉验证的布尔求值器（`BooleanExpression`）。
- 工具面：`knowledge_network(view='ladder')`、`knowledge_variable_usage` 的 `Scan order`。
- 三道回归守卫：元素/取反守恒、归约与阶梯渲染的合成用例、真实端到端（XML → 入库 → 工具）。
- 两份实测知识：`docs/research/tia-lad-structure-rules.md`（TIA 接受什么拓扑）、`docs/research/lad-corpus-inventory.md`（真实语料里有什么）。
- 九个决策条目（`packages/dsh-engineering-graph/docs/decisions.md` LAD-01…LAD-11）。

**明确未做**：`exec`（STL 线性化）视图、`flg_*` 结构表、模型跑分。三者的理由分别记在 LAD-08、LAD-09 与本节的收尾结论里，不是遗漏。

---

## 1. 当前短板（已核实）

| # | 短板 | 证据 |
|---|---|---|
| S1 | FlgNet 在入库前被**压平**成 `logicStatements`，串并联结构丢失 | `ProgramBlockLogicYamlWriter.cs` `TranslateFlgNet`（282–377）直接输出语句字符串 |
| S2 | 图库里**没有 wire 级连接**，`CONNECTED_TO` 只用于地址 | `SemanticPlcGraph.cs` 594 行仅 `AddEdge(... addressId)` |
| S3 | `knowledge_network_accesses` 只有 `READS/WRITES` 与变量名，**没有写的种类**（置位/复位/赋值）和**执行序** | `SemanticPlcGraph.cs` 949–983 表结构 |
| S4 | 读的是"变量是否出现"，不是"这一拍读到哪个值"，时序靠 agent 自己推 | `knowledge_variable_usage`（`drilldown.ts` 271–303）只按网络号列出 |
| S5 | 结果里没有"分支 / 并联组 / 线圈末端"等结构语义，agent 无法判断逻辑是否合法或是否等价 | 同 S1 |
| S6 | 技能文档没有 V17 的 LAD 读法；路由 `SKILL.md` 已 8114 字符，逼近 8192 上限 | `skills/tia-openness/SKILL.md` |
| S7 | agent 只能用裸 SQL（`knowledge_query`）回答结构问题，写错 JOIN 后要重试 | 会话中多次 SQL 重试 |

**不在本计划范围**（已明确放弃或后置）：DSL 生成器、导入前 XML 校验、导入回报修复、仿真闭环。其中导入回报（`Operations.cs` 1187–1194 写死的"project is unchanged"）与 dry-run 不校验网络（1100–1106）是真实缺陷，但属于写侧，另立计划。

---

## 2. 设计原则

1. **C# 做事实，TS 做呈现。** 解析 FlgNet、归约串并联、写库都在引擎（C#）里完成，需要重建 `engine/bin`。文本呈现（梯级图、执行序、读写表）放在 TS 的 `drilldown` 层，格式迭代不需要重建引擎。
2. **同一份图派生所有视图。** 梯级图、执行序、读写表都从同一棵 rung 树派生；任何视图丢元素都要被测试发现。
3. **不确定就标 `unstructured`，不猜。** 归约失败的网络保留原始边，明确告诉 agent"这里不是标准串并联，请以边表为准"。
4. **向后兼容。** `knowledge_network` 现有输出保持不变；新视图通过新参数 `view` 显式启用，直到评测通过再切默认值。
5. **先测后用。** 每个阶段有可执行的验收命令与黄金样例，未通过不进入下一阶段。

---

## 3. 目标架构

```
导出 XML (source/**/*.xml)
   │  ExportFolderCrawler / ProgramBlockComponent（已有）
   ▼
[C#] FlgNetworkGraph        元素 + pin + wire（新增）
   │
   ├─▶ [C#] SeriesParallelReducer   → rung 树 或 unstructured（新增）
   │        │
   │        └─▶ 写库：flg_elements / flg_wires / flg_rung_nodes / flg_writes（新增）
   │
   ├─▶ 原有 logicStatements（保留，不删）
   ▼
[TS] drilldown 查询层
   ├─ knowledge_network(view=ladder)   梯级文本（已实现）
   ├─ knowledge_network(view=exec)     RLO 线性化（**未做**，理由见 LAD-08 与 §0）
   ├─ knowledge_network(view=rw)       读写表（已由回复里的 Writes/Reads 两行覆盖）
   └─ knowledge_variable_usage         Scan order 段：同拍/跨拍标注（查询时计算，不重建库）
```

---

## 4. 分阶段执行

### 阶段 0：语料盘点（只读，不改产品代码）

**目的**：确认真实语料里有哪些元素、连线形态，避免按想象设计。

**做什么**
- 对 `pilot` 与 `reference` 两个工作区的导出 XML（pilot 的 `source/` 约 934 个对象，reference 约 1376 个 XML）统计：
  - Part 名称分布（Contact、Coil、SCoil、RCoil、O、TON、Call、Add、Move、GT 等）；
  - `Negated` 出现位置；`TemplateValue` 的名称与取值；
  - 每个网络的元素数、分支深度、是否出现扇出（同一 IdentCon 的多个目标）；
  - 线圈是否位于分支中间（后面还有元素接在同一路径上）。
- 产出：`docs/research/lad-corpus-inventory.md`（新文件），包含表格与原始计数脚本。

**怎么做**：用一次性的 C# 控制台（放在 `engine/tools/` 下，不进发布包）或在 SelfTest 模式下增加 `--dump-flg <xml>`。**不要**用 TS 手写 XML 解析器，避免两套解析口径。

**验收**
- 语料内每个网络都有分类结果（按元素集合归类），未分类数 = 0。
- 盘点脚本可重复运行，两次输出逐字节一致。

**测试**：脚本输出与 `docs/research/lad-corpus-inventory.md` 中的数字做 diff，作为回归基线。

---

### 阶段 1：元素图模型（C#）

**目的**：把 FlgNet 变成显式的元素与连线，取代仅在内存中存在的 `FlgNetContext`。

**新增文件**（`packages/dsh-engineering-graph/engine/Parsing/Flg/`）

| 文件 | 内容 |
|---|---|
| `FlgElement.cs` | `record FlgElement(string Id, FlgKind Kind, string Name, IReadOnlyList<FlgPin> Pins, FlgAttrs Attrs)`；`FlgKind`：`Access`、`Contact`、`Coil`、`SetCoil`、`ResetCoil`、`OrBox`、`Box`、`Call`、`PowerRail`、`Constant` |
| `FlgPin.cs` | `record FlgPin(string Element, string Name, FlgDirection Dir, bool Negated)`；`Dir`：`In`、`Out`、`EnIn`、`EnOut` |
| `FlgWire.cs` | `record FlgWire(string SourceElement, string SourcePin, IReadOnlyList<(string Element, string Pin)> Targets)`，一条 Wire 可有多个目标（扇出） |
| `ElementCatalog.cs` | 静态表：Part 名 → 引脚列表与方向、读写语义；未知 Part 用 `GetPinRole`（已有）推方向，并标记 `generic=true` |
| `FlgNetworkGraph.cs` | `static FlgNetworkGraph Build(XElement flgNet, string compileUnitId)`；解析 `Parts`（Access、Part、Call）与 `Wires`（Powerrail、IdentCon、NameCon、OpenCon）；校验每个输入 pin 最多一个来源 |

**与现有代码的关系**：`FlgNetContext.Create`（684–845）已经做了同样的解析，但只服务于语句生成。新模型应**替换其内部实现**而不是并行维护两套。做法：先让 `FlgNetContext` 内部改为调用 `FlgNetworkGraph`，`logicStatements` 的输出必须逐网络不变（见下方测试）。

**测试**
- **T1-a（结构守恒）**：对 171 块全部 37 个网络，`Elements` 数量 = XML 中 Access + Part + Call 节点数；`Wires` 中所有 IdentCon 引用的 UId 都存在；`Negated` 数量与 XML 中 `<Negated` 出现次数一致。
- **T1-b（语句不回归）**：改造前后 `logicStatements` 逐网络字符串完全相同。把改造前的输出存成黄金文件 `engine/fixtures/lad/171.statements.golden.json`，先生成再改代码，改完逐条比对。
- **T1-c（非法输入）**：构造一条"同一输入 pin 两个来源"的合成网络，必须报出 `flg_multi_source` 诊断，而不是静默取一个。
- **执行方式**：`$env:DOTNET_ROOT="$env:USERPROFILE\.dotnet10"`；`pwsh -NoProfile -File engine/build.ps1`；`engine` 的自测 `--self-test`。

**验收**：T1-a/b/c 全部通过。

---

### 阶段 2：串并联归约与 rung 树（C#）

**目的**：把元素图归约成"能流树"：串联、并联、线圈末端。这是 agent 读懂梯形图的结构基础。

**算法**（经典串并联归约，简述）
1. 从 `PowerRail` 出发，沿"能流方向"（EN 或布尔输入输出）前进。
2. 把一条链上连续的单入单出元素折叠为 `Series(...)`。
3. 同一输入汇聚多个来源（O 盒输入、或多条 Wire 指向同一 pin）折叠为 `Parallel(...)`。
4. 同一输出分裂到多个后继（扇出）标记为 `Branch`，其中线圈作为分支末端。
5. 无法按 2–4 归约（例如桥接结构、线圈后仍有元素接续）→ 整网标记 `Unstructured`，并保留所有边。

**新增文件**：`SeriesParallelReducer.cs`（输入 `FlgNetworkGraph`，输出 `RungNode` 或 `Unstructured(reason, edges)`）。`RungNode` 节点类型：`Series`、`Parallel`、`Leaf(element)`、`Coil(element)`。

**测试**
- **T2-a（合成网络）**：在 `engine/fixtures/lad/synthetic/` 放 5 个小网络：单链、两路并联、并联后再串联、嵌套并联、桥接（应为 `Unstructured`）。每个预期树形状写成 JSON，逐一比对。
- **T2-b（黄金网络）**：171 的 37 个网络，逐一写预期分类（`structured` / `unstructured` + 原因）。**预期文件由工程师人工核对**，不由程序生成后直接当真相。
- **T2-c（线圈位置假设）**：见下文"需要先做的 TIA 实验"。实验结果决定"线圈后接续元素"这类情况怎么判。

**验收**：T2-a 全部通过；T2-b 中"人工认为可归约"的网络 100% 归约成功；`unstructured` 的每一条都有可读原因。

---

### 阶段 3：等价性校验（测试核心，不对外暴露）

**目的**：证明"树"、"执行序"、"原有语句"三者在逻辑上一致。这是防止"视图好看但算错"的关键。

**方法**
- 对每个结构化网络，收集其引用的布尔变量（上限 12 个，超过则随机采样 4096 组并标注 `partial`）。
- 对所有赋值组合，分别计算：
  - (a) 树的求值器（`Series`=AND，`Parallel`=OR，`Coil` 取输入）；
  - (b) 执行序的解释器（按 RLO 栈模拟）；
  - (c) 原有 `logicStatements` 经一个小的布尔表达式解析器求值。
- 三者结果必须一致。不一致即为 bug，阻断发布。

**实际实现（两方，不是三方）**：`exec` 视图没做（见 §0），所以只有 (a) 路径求值与 (c) 语句求值两个独立实现。这仍然是一次真交叉验证——两者由完全不同的代码路径得出——但**不要**把文档里的"三方"当成本次成果。若将来补 `exec`，再补 (b)。

**新增**：`engine/SelfTest` 的 `rung equivalence` 组（含 2 个合成网络的已知答案用例，防止"因为没比对任何东西而通过"）。

**验收**：reference 工程 `coils=1323` 全部一致；跳过数量按原因公开（`box=2306 statements=14 unresolved=589`）。

---

### 阶段 4：呈现层（TS）

**目的**：把 rung 树变成 agent 能读的文本，并支持三种视图。

**新增文件**
- `src/ladder-render.ts`：纯函数。
  - `renderLadder(tree, { maxWidth })`：列 = 串联深度，行 = 分支序号；每个元素方块上标 `R` / `W`；线圈在右端；盒子展开 EN、IN、ENO 引脚；超宽时折行并标注续行。
  - `renderExec(tree)`：输出 STL 式线性列表（`A`、`AN`、`O`、`ON`、`=`、`S`、`R`，分支用 `MPS` / `MRD` / `MPP`）。**明确标注为阅读投影，不是 TIA 的真实编译结果。**
  - `renderRW(tree)`：每个元素一行，列出读写的变量、方向、写入种类。
- `test/15-ladder-render.test.mjs`、`test/fixtures/lad/*.json`（由阶段 2 导出的树）。

**改动现有文件**
- `src/drilldown-tools.ts`：`knowledge_network` 增加参数 `view: 'logic' | 'ladder' | 'exec' | 'rw'`，默认 `logic`（保持现状）。描述里写明"读结构请用 `ladder`"。
- `src/drilldown.ts`：在网络查询中读取新表 `flg_rung_nodes`；预算常量（41–44、67、78 行附近）为梯级视图单独设一个字符上限；超限时输出 `NEXT:` 提示，告诉 agent 用 `exec` 或分页。

**测试**
- **T4-a（黄金快照）**：10 个网络的 `ladder` 输出与快照逐字比对。
- **T4-b（元素守恒）**：从 `ladder` 文本里解析出的元素名、引脚、R/W 标签集合，必须与图里该网络的集合相等。这是"视图丢了元素"的检测器。
- **T4-c（确定性）**：同一输入渲染两次，字节一致。
- **T4-d（预算）**：任一网络的 `ladder` 输出 ≤ 上限；超限时必须出现截断标记与 `NEXT:` 提示。
- **T4-e（兼容）**：`view` 缺省时，`knowledge_network` 输出与改造前逐字相同（现有 `12-drilldown.test.mjs` 不得改动即通过）。

**验收**：T4-a 至 T4-e 全部通过。

---

### 阶段 5：入库与写读语义（C# 落库 + TS 查询）

**目的**：让图可以被快速查询，并把"同拍 / 跨拍"等时序事实显式化。

**5.1 表结构**（`SemanticPlcGraph.cs` 935–983 附近新增）

| 表 | 关键列 | 说明 |
|---|---|---|
| `flg_elements` | `network_id`, `element_id`, `kind`, `name`, `attrs_json` | 元素 |
| `flg_wires` | `network_id`, `src_element`, `src_pin`, `dst_element`, `dst_pin` | pin 级连线，扇出展开为多行 |
| `flg_rung_nodes` | `network_id`, `node_id`, `parent_id`, `ord`, `kind`, `element_id` | 归约后的 rung 树，`ord` 为兄弟序号 |
| `flg_writes` | `network_id`, `variable_name`, `write_kind`（`ASSIGN`/`SET`/`RESET`）, `element_id` | 写的种类；这是 S3 的修复 |

**改动**
- `SemanticPlcGraph.cs` 1090 行附近的清理列表（`DELETE FROM ...`）加入新表；1140 行附近的写入路径同步写入新表。
- `Operations.cs` 58–59 行 `ComputeSchemaVersion`：表结构变化会自动改变 schema 版本，`known_version` 机制会让旧客户端得到变更提示。

**5.2 图版本与重建**
- 现有 `CREATE TABLE IF NOT EXISTS` 不会为旧库补数据。新增"图构建版本号" `GraphBuildVersion`（引擎常量），写入库的元数据；版本不一致时，`ingest` 必须全量重建，而不是静默沿用旧库。
- 需确认 `graph-freshness.ts` 的新鲜度判定能否感知构建版本（当前 sidecar `schemaVersion` 为 1，仅覆盖 sidecar 格式）。若不能，需在 sidecar 中加入引擎构建版本字段。

**5.3 时序标注（查询时计算，不重建库）**

`knowledge_variable_usage` 增加参数 `scan`。对同一变量，按网络号排序：
- 生产者网络号 < 消费者网络号 → **同拍可见**；
- 生产者网络号 ≥ 消费者网络号 → **上一拍可见**（一拍延迟）；
- 同一位既有 `SET` 又有 `RESET` → 标注"后写者胜，以网络号最大者为准"。

这部分纯 SQL 加 TS 计算，不需要引擎重建。

**测试**
- **T5-a（落库一致）**：171 入库后，`flg_elements` 行数 = 阶段 1 的元素数；`flg_wires` 行数 = 阶段 1 的展开边数；`flg_rung_nodes` 能还原出阶段 2 的树（逐节点比对）。
- **T5-b（幂等）**：重复 ingest 两次，表内容一致。
- **T5-c（旧库升级）**：用改造前的库（先在改动前生成一份作为固定夹具）启动，必须触发重建，且不报错。
- **T5-d（时序标注）**：合成块中构造"前向读、后向读、同网络读写、S/R 冲突"四种情况，标注结果逐条匹配。
- **执行方式**：`node --test test/12-drilldown.test.mjs test/14-freshness.test.mjs`，再加新文件 `test/16-flg-storage.test.mjs`。

**验收**：T5-a 至 T5-d 全部通过；171 的重建耗时与改造前相比增长不超过 2 倍（以 README 中的 1376 文件约 30 秒为参照，需实测）。

---

### 阶段 6：技能文档与 agent 读法

**目的**：让 agent 知道先读什么、怎么读、什么时候该怀疑自己。

**做什么**
- 新建 `LAD-READING.md`，放在 tia-openness 技能目录（同 `PROJECT-LIBRARY.md` 的模式，**不**塞进 `SKILL.md`）。
- `SKILL.md` 只增加一行引用，保持在 8192 字符以内。需运行 `npm run skills:check`（该包已有此检查）。
- 文档内容（约 2–3 屏）：
  1. 读网络的固定顺序：`knowledge_block` 列网络 → `view=ladder` 读结构 → `view=rw` 查读写 → 不确定时 `view=exec` → 需要跨网络关系时 `knowledge_variable_usage(scan=1)`。
  2. 五个角度的含义（结构、时序、数据关系、业务、验证），每个角度回答什么问题。
  3. 三条红线：`unstructured` 时以边表为准；`partial` 等价校验时不得断言"一定成立"；业务意图来自注释，不得臆测。
  4. 常见误判清单（如：把 S/R 当成普通赋值、忽略一拍延迟、把并联当串联）。

**测试**
- `npm run skills:check` 通过。
- **T6-a（阅读流程回放）**：用固定的 10 个问题，在有/无 `LAD-READING.md` 两种条件下各跑一次（见阶段 7），记录工具调用序列是否符合固定顺序。

---

### 阶段 7：评测（决定是否切换默认值）

**目的**：用数字证明"理解"真的变好了，而不是输出变好看了。

**方法**
- 从阶段 3 的真值（已通过等价校验的网络）自动生成问题集：
  - 条件题："`X` 在什么条件下被置位？" 答案为布尔表达式，用真值表比对是否等价；
  - 写入者题："谁写 `X`？" 答案为集合，精确比对；
  - 时序题："网络 N 读到的 `X` 是同拍还是上一拍？" 答案为枚举，精确比对；
  - 冲突题："`X` 是否存在多个写入且有冲突？" 答案为布尔。
- 问题只取自 reference 工作区的 `Sino_PEI` 块（已决定，见第 10 节）。至少 40 题，按四类均匀分布。
- 对照组：现有 `view=logic`；实验组：`view=ladder` + `exec` + `rw` + `scan=1` + `LAD-READING.md`。同一模型、同一温度、同一工具预算。

**指标与目标**（建议值，待第一次评测后校准）

| 指标 | 对照组 | 实验组目标 |
|---|---|---|
| 条件题正确率（真值表等价） | 记录 | ≥ 90% |
| 写入者题精确率 | 记录 | ≥ 95% |
| 时序题正确率 | 记录 | ≥ 85% |
| 冲突题召回率 | 记录 | ≥ 90% |
| 每题平均 token | 记录 | 不高于对照组 +30%，若超出需说明 |

**产物**：`scripts/eval/lad-qa/`（问题生成、运行、评分脚本）；结果写入 `docs/research/lad-qa-results-<日期>.md`。

**验收**：实验组在条件题与写入者题上达到目标，且没有任何一类指标显著退化。达标后再把 `knowledge_network` 的默认 `view` 切到 `ladder`，并写入 `decisions.md` 条目。

---

## 5. TIA 实验（M0）——**已收尾**（2026-11-27）

结论见 [`docs/research/tia-lad-structure-rules.md`](research/tia-lad-structure-rules.md) 第 7、8.3 节：普通线圈后接元素、置位/复位线圈位于分支中间、取反触点、扇出、嵌套分支、同网络/跨网络同位 S/R 双写**全部合法**。E7（O 盒合流）与 E8（盒指令在分支中）**决定不做**，这两种形态在阶段 2 标为 `unstructured`。

因此阶段 2 **不再**受"线圈必须在分支末端"约束。以下原始描述保留作历史记录。

归约规则里"线圈位置"与"分支汇合"的判定，目前只有推断。必须在**隔离副本工程**上做，不得碰 pilot。每个用例一次真实导入（约 10 秒）。

| 编号 | 用例 | 要回答的问题 |
|---|---|---|
| E1 | 线圈位于分支中间，后面仍接一个触点 | 是否允许"线圈后接续元素" |
| E2 | 分支的分支，末端挂线圈 | 嵌套分支是否允许 |
| E3 | 同一位在同一网络里同时被 S 与 R 作用 | 是否允许、是否告警 |
| E4 | 同一输出同时驱动线圈与后续触点（扇出） | 扇出在 TIA 中的合法形态 |

**注意**：Import 工具存在部分写入的风险（见 `Operations.cs` 1187–1194 的讨论），实验必须用副本工程，每次实验后从备份恢复，并在实验记录中写明恢复步骤。

实验结论写入 `docs/research/tia-lad-structure-rules.md`，并由阶段 2 的 `SeriesParallelReducer` 引用。

---

## 6. 验证命令汇总

| 阶段 | 命令 |
|---|---|
| 0 | 盘点脚本 + diff 基线 |
| 1 | `$env:DOTNET_ROOT="$env:USERPROFILE\.dotnet10"`；`pwsh -NoProfile -File packages/dsh-engineering-graph/engine/build.ps1`；`--self-test` |
| 2 | 同上，加合成网络用例 |
| 3 | `--self-test flg-equivalence` |
| 4 | `pnpm --filter @automation-suite/engineering-graph test`（`run-tests.mjs` 会先构建） |
| 5 | 同上，加 `test/16-flg-storage.test.mjs` |
| 6 | `npm run skills:check`（tia-openness 包） |
| 7 | `scripts/eval/lad-qa/` 运行脚本；结果入 `docs/research/` |
| 端到端 | `pwsh -NoProfile -File scripts\start-env.ps1 -Restart`，再在 GUI 里跑评测问题 |

---

## 7. 里程碑与交付物

| 里程碑 | 包含阶段 | 交付物 | 通过标准 |
|---|---|---|---|
| M0 | 0 + 5 个 TIA 实验 | 语料盘点、TIA 结构规则文档 | 语料 100% 分类；E1–E4 结论明确 |
| M1 | 1 | 元素图模型 | T1-a/b/c 通过，语句零回归 |
| M2 | 2 + 3 | rung 树、等价校验 | T2 通过；三方等价 100% |
| M3 | 4 | 三种视图（TS） | T4 通过；兼容测试不改 |
| M4 | 5 | 入库、时序标注、版本重建 | T5 通过 |
| M5 | 6 + 7 | 技能文档、评测报告 | 指标达标；决定默认视图 |

M0 与 M1 可并行：M0 是只读的，不阻塞 M1 的代码工作，但 M2 必须等 M0 的实验结论。

---

## 8. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| TIA 结构规则与推断不一致 | 归约正确但 TIA 不接受（只影响写侧，读侧仍正确） | M0 实验先行；归约规则只按实验结论放宽 |
| 串并联归约覆盖不全 | 很多网络落入 `unstructured` | 量化 `unstructured` 比例；若超过 10%，单独分析原因再补规则 |
| 图库体积增长 | 磁盘与重建时间 | 阶段 5 实测；当前库已有约 533 MB，增长超过 30% 需审查 |
| 版本重建漏判 | 旧库读到错误结构 | T5-c 固定夹具；版本号纳入 sidecar |
| 文本过长耗尽 token | agent 读不完，或被截断后误判 | 阶段 4 的预算与 `NEXT:` 提示；按网络分页 |
| 评测题本身有偏差 | 指标虚高 | 真值由等价校验（阶段 3）产出，不由人手写；不设人工抽查门槛（已决定） |
| 工程师对黄金网络的人工判断不一致 | T2-b 预期文件有争议 | 对争议网络记录为 `disputed`，不计入通过率 |

---

## 9. 不做什么（明确排除）

- 不做 LAD 生成器、不做 DSL。
- 不改 TIA 控制器的导入逻辑（留给写侧计划）。
- 不新增 Openness 调用，不依赖仿真环境完成读侧功能。
- 不删除 `logicStatements`；它仍是兼容路径与等价校验的参照。
- 不在 `docs/` 之外新建笔记目录（等待 `notes-convention.md` 拍板）。

---

## 10. 决策记录（2026-11-27）

| # | 问题 | 决定 | 对计划的影响 |
|---|---|---|---|
| 1 | 阶段 2 是否等 M0 实验结论再开始 | **未作答**。按计划默认执行：不等待，先用"线圈必须在分支末端"的保守规则实现，违反者标为 `unstructured`，M0 结论出来后再放宽 | 若你希望等待，请明确告知；M2 里程碑的依赖关系随之调整 |
| 2 | 评测题来源块 | **只用 reference 工作区的 `Sino_PEI` 块**，不用 pilot | 阶段 7 的题库范围收窄；风险表中"逻辑可能不同步"的问题不再适用 |
| 3 | `view` 默认值切换的门槛 | **只看阶段 7 的指标**，不增加人工抽查 10 题 | 阶段 7 验收与风险表已据此修改 |
| 4 | `decisions.md` 归属 | **包内** `packages/dsh-engineering-graph/docs/decisions.md`（新建），编号用 `LAD-` 前缀，见该文件 | 引擎包现有决策（D17、D24、D27、D28）仍在仓库根 `docs/decisions.md`，两处并存，见包内文件的说明 |
