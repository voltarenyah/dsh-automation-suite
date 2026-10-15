# 工具面重设计：从「能力清单」到「工作流」（调研与提案）

> **状态：调研 + 提案，未决定。** 本文只回答三件事：现状到底哪里不对（可核对）、
> 用户真正的工作流是什么、**从哪一步开始动手**。
>
> 需要拍板的地方集中在 §7，答复请写在 [`open-questions.md`](open-questions.md) 的
> **A14–A17**（那几条就是为本文新加的）；定了之后再回填 [`decisions.md`](decisions.md)
> 与 [`roadmap.md`](roadmap.md)，本文随之改成"当前形态"的说明。
>
> 口径：本文里凡引用代码/实测的地方都带 `path:line`；**推断**一律标注。

---

## 1. 结论（TL;DR）

1. **现状是"能力面"不是"工作流面"。** 26 个工具 = 25 个控制器白名单操作 + `controller_status`，
   一一对应，而且这个不变量被测试钉住了（`packages/dsh-tia-openness-v17-min/test/04-tools.test.mjs:204`）。
   控制器白名单的粒度直接变成了模型的粒度 —— 哪些该合并、哪些该藏，从来没被讨论过。
2. **用户抱怨的"一次只能 20 个"不在控制器，在插件的渲染层。**
   `MAX_LISTED = 20`（`packages/dsh-tia-openness-v17-min/src/tools.ts:36`；全文 37 处，含定义），
   而控制器一次就能返回全部（`max_items` 由调用方给，默认 200、无硬上限：
   `controller/OperationsPlc.cs:49-50,188`）。所以"全项目指纹要调一百次"是**纯插件代码造成的**，
   **去掉它不需要动一行 C#**。
3. **常驻成本可量化**：26 个工具的名字 + 描述 + 参数 schema 序列化后是 **50,593 字符 ≈ 14k tokens**，
   每个会话都要付（实测方法见 §6.3）。这些工具里有一大批是"工程管理旋钮"，
   绝大多数会话永远不会碰。
4. **正确的形态其实已经存在，只是被当成补充**：导出把完整清单落盘（`_tia-openness-manifest.json`，
   含逐文件 SHA-256），工具结果只给路径（`packages/dsh-tia-openness-v17-min/docs/OUTPUT-CONTRACT.md:120-176`）。缺的是把这条
   "**摘要 + 工件 + 下钻**"的路子变成**默认**，而不是只有 20 行文本。
5. **要补的不是"更多工具"，是中间层**：内部分页/批量、基线快照、增量 diff、长操作的可观测性、
   以及工作流级的 dry-run。这些东西没有一层承载，模型就只能自己编排几十次调用。
6. **建议起手：先做一条只读的垂直切片 —— `change_report`（指纹变更检测）+ 基线快照。**
   它零 C# 改动、是 [`roadmap.md`](roadmap.md) §3 第 3 项（变更识别）与 D6/D9 工作循环的硬依赖，
   并且一次性把所有新机制（内部分批、快照落盘、增量 diff、工件返回、结果预算）都走一遍。
   验收口径见 §6.1。

---

## 2. 体检：26 个工具到底哪里不对

### 2.1 工具 = 控制器操作（1:1，且被测试钉住）

| 事实 | 证据 |
|---|---|
| 每个 `OPERATIONS` 成员恰好一个工具、顺序一致 | `src/tools.ts:9-13`（模块头注释）；`src/protocol.ts` 的 `OPERATIONS` 25 项 |
| 26 个工具 ↔ 25 个操作 + `controller_status`（插件本地） | `src/tools.ts:892`–`2212`；`controller_status` 见 `src/tools.ts:2212` |
| 26 个渲染分支，一一对应 | `src/tools.ts` 的 `renderData()` 里 `case` 26 个 |
| **不变量被测试钉住** | `test/04-tools.test.mjs:204` "every tool maps onto exactly one whitelisted controller operation" |

后果：控制器的白名单是"安全边界"，本不该同时充当"模型的能力边界"。
两者混在一起，导致**要么把一个操作包成一个工具（现在），要么为了合并能力去改控制器**——
而实际上大部分合并根本不需要改控制器（§5.1）。

### 2.2 返回值是文本，且列表一律截到 20 行

| 事实 | 证据 |
|---|---|
| 每个工具的 `render` 只产出一条 text block | `src/tools.ts:929`（26 处同样写法） |
| 文本由 `renderOutcome()` 拼装 | `src/tools.ts:796-811` |
| 任何列表最多 20 行，超出写 `… N more` | `src/tools.ts:36`（`MAX_LISTED`），应用于 37 处 |
| **指纹行同样被截到 20 行** | `src/tools.ts:522,538` |
| 控制器侧的上限是另一个量级 | `max_items` 默认 200、每族独立（`controller/OperationsPlc.cs:49-50,188`）；`max_messages` 200（`controller/Operations.cs:62`） |
| 唯一"全量"出口是配置 `verboseResults: true`，它把整个 JSON 倒进文本 | `src/tools.ts:783`；`src/config.ts:32,43` |

**两个上限必须分开说**（这是这次调研最容易误判的一点）：

| 想做的事（1000–1152 块的真实项目） | 控制器需要几次请求 | 模型现在要发几次调用 | 依据 |
|---|---|---|---|
| 拿到全部块/类型的指纹 | **1**（`max_items ≥ 1152` + `include_fingerprints`） | **≈58**（1152 ÷ 20） | `src/tools.ts:36,522,538`；`controller/OperationsPlc.cs:49` |
| 导出全部块 | **1**（不传 `block_names` 即全部） | 1（但文本只显示 20 个文件；完整清单在 manifest 里） | `src/tools.ts:166`；`packages/dsh-tia-openness-v17-min/docs/OUTPUT-CONTRACT.md:120` |
| 建 1000 个对象 | 1000（控制器一次一个） | 1000 | `controller/OperationsPlc.cs:226-229` |
| 一次导入整棵导出树（1314 个 XML） | **1**（目录扫描） | 1（但要配合 `import_options: 'override'` 与 `mirror_groups`，见 §2.4） | `controller/Operations.cs:684,712,827` |

**还有一条更硬的事实：信封里的 `data` 根本到不了模型。** DSH 只把 `render` 产出的 content blocks
交给模型（`appendToolResult` 只持久化 `content`，结构化的 `value` 既不落盘也不下发）。
所以 [`OUTPUT-CONTRACT.md`](../packages/dsh-tia-openness-v17-min/docs/OUTPUT-CONTRACT.md) §1 里
"`data` 里始终保留完整结构化负载 …… 这就是 agent 看到的 canonical value"这句话**与运行时行为不符**：
`data` 是留给宿主与未来接口的，**模型能看到的只有那 20 行文本**。这既解释了"上下文被撑爆"
（唯一通道是文本，于是只能往文本里塞），也说明**任何"把批量数据留在 data 里"的优化都是无效的**。
实测依据与机制细节见 §4.4。

### 2.3 指纹是"比较用"的数据，却被原样倒进上下文

- 指纹的语义（D6）：每项 `{id, value}`，`id ∈ Code / Comments / Interface / Properties / …`
  ——**它有价值的地方是"哪一块、哪一面变了"**（[`decisions.md`](decisions.md) D6）。
- `value` 是不透明字符串：模型既解释不了，也不能可靠地自己比较（跨调用比较还要它自己保存历史）。
- 现状：`list_plc_objects(include_fingerprints: true)` 把 `{id}={value}` 逐条渲染成文本
  （`src/tools.ts:523-532`）——**既撑上下文，又是无效信息**（用户的原话）。
- 而且指纹**每次调用都要重算**（`GetFingerprints()`，`controller/OpennessHost.Plc.cs:1191`），
  没有任何快照/缓存：项目没变也要重算一遍全项目。

### 2.4 模型被迫自己编排流程，每一步都可能错

- 写入默认 dry-run（插件 [`docs/decisions.md`](../packages/dsh-tia-openness-v17-min/docs/decisions.md) D5）
  → **任何写入都是两次调用**；
  "改一个块并证明成立"（插件 README §4.1 的典型流程）是 **7–8 次调用**：
  open → export(指定块) → 编辑文件 → import(dry) → import(真) → compile → export 复核 → close。
- 顺序有**只在文档里的硬约束**：块必须导入回原组、导入后必须编译才能再次导出
  （`packages/dsh-tia-openness-v17-min/docs/OUTPUT-CONTRACT.md:217-221`）。模型漏一步就得到"看起来对"的结论。
- 会话状态耦合：`project_not_open` 等要求模型自己记住"项目还开着"；
  一旦超时被杀，会话就丢了（`packages/dsh-tia-openness-v17-min/README.md:576`）。

### 2.5 长操作不可观测，而且默认超时会毁掉会话

| 事实 | 证据 |
|---|---|
| 控制器有 progress 帧（20+ 处上报） | `controller/Program.cs:571-591`；`Operations.cs:300`（逐块导出）、`:829`（逐文件导入）等 |
| 插件解析了这些帧 | `src/controller.ts:612-631` |
| **但没有工具把进度接出去**：`request()` 只接受 `signal` | `src/tools.ts:25`；`src/index.ts:73` |
| 结果：87 s 的导出、>10 分钟的编译全程静默 | 1151 块导出 81.7 s（`packages/dsh-tia-openness-v17-min/docs/REAL-RUN.md:132`）；大项目编译"常需 10 分钟以上"（`packages/dsh-tia-openness-v17-min/docs/FUNCTIONAL-TEST.md:248`） |
| `requestTimeoutMs` 默认 300 s，超时**终止控制器并丢失 TIA 会话** | `src/config.ts:38`；`packages/dsh-tia-openness-v17-min/README.md:576`；工具从不覆盖超时（`src/tools.ts:850`） |

也就是说：模型在"最容易超时、最需要观察"的两个操作上，**既看不到进度，也没有一条不丢会话的退出路径**。

### 2.6 文档与参数已经不一致（问题不只是"太原子"）

| 现象 | 证据 |
|---|---|
| `import_blocks` 描述说 "categories narrows that"，但**没有** `categories` 参数，也从不发送 | 描述 `src/tools.ts:1034-1035`；参数表 `:1041-1095`；控制器其实读它 `controller/Operations.cs:699` |
| **10 个 PLC 作用域的工具**缺 `device_name`/`software_name`，控制器却都接受 → 多 PLC 项目直接 `plc_software_ambiguous` 且无路可走 | 接受方 `controller/OpennessHost.cs:477-518`；缺失方：`write_tags:1784`、`set_block_attributes:1861`、`protect_blocks:1914`、`generate_source:1961`、`watch_and_force_tables:2000`、`software_units:2062`、`create_plc_objects:1662`、`delete_plc_objects:1724`、`safety_status:2108`、`safety_signatures:2178` |
| `generate_source` 缺 `group_path`、`set_safety_settings` 缺 `with_window`、`software_units` 拿不到 `max_items`/`name_filter` | 控制器 `OperationsPlc.cs:1295`、`OperationsSafety.cs:114`、`OperationsPlc.cs:1606,1608` |
| 覆盖矩阵认为"没有缺口" | `scripts/coverage/matrix-data.mjs:1110` → `export const TOOL_GAPS = []` |

**这一节的意义**：把工具面按工作流重做，顺手就能把这些"能力已经在那儿、模型却够不到"的洞堵上；
反过来，如果只做"合并同类项"而不动参数面，多 PLC 项目的失败模式会原样保留。

### 2.7 常驻成本：26 个工具 ≈ 14k tokens/会话

实测（脚本见 §6.3）：`name + description + parameters` 三者的 JSON 是 **50,593 字符 ≈ 14k tokens**
（含 output schema 的全部定义是 75,450 字符，其中 output schema 不下发给模型）。

而这些工具里有相当一批是"工程管理旋钮"，绝大多数会话永远用不到：
`portal_settings`、`project_languages`、`update_project`、`set_block_attributes`、`protect_blocks`、
`watch_and_force_tables`、`software_units`、`project_texts`、`archive_project`、`safety_*`。
**它们不是没价值，而是不该用"常驻目录"的方式付钱。**

---

## 3. 用户工作流清单

重建方式：以 `docs/vision.md`、`docs/architecture.md`、`docs/roadmap.md`、
`docs/open-questions.md` 里**用户自己的表述**为证据，辅以 `skills/` 的症状→文档路由表
（`skills/tia-openness/SKILL.md:29-57`）与 `docs/` 里的实测记录。标 **推断** 的是我推出来的。

| ID | 工作流（工程师真正想做的事） | 现在的调用数与痛点 | 证据 | 只靠现有控制器操作可实现？ |
|---|---|---|---|---|
| **W1** | 把工程导出成可读文本源（基线 / 进 git） | 4 次固定调用；但结果里 1152 条 `files[]`、20 行截断，git 是另一族工具，从未合并 | `docs/vision.md:43-45`；`open-questions.md:394`（B2）；`roadmap.md:132` | ✅ 一次导出已覆盖 blocks+types+tag_tables（D17） |
| **W2** | 改一个块并证明确实生效 | 7–8 次；顺序约束只在文档里 | `roadmap.md:63-65`；`packages/dsh-tia-openness-v17-min/README.md:431-447`（唯一有实测的闭环） | ✅（v0.1 已实测） |
| **W3** | 项目全局摘要 + 按需下钻 | 3 次固定但被 `max_items=200` 截断（1152 块 → ≥6 次）；没有"摘要"这一形态 | `roadmap.md:176`；`architecture.md:238` | ✅ 插件侧聚合即可 |
| **W4** | **"自上次以来哪些块变了、改了哪一部分"** | 数据 1 次可取，但**没有 baseline、没有 diff**：模型要自己比 ~1152×(1–11) 对 `{id,value}`，且文本只看得到 20 行 | `open-questions.md:126`（A6 原话"以这个为硬依据"）；D6；`roadmap.md:131` | ✅ **纯插件侧** |
| **W5** | 只导出变化的块并刷新下游（D9 工作循环） | 依赖 W4 的"变化集合"，现在不存在 | D9（`decisions.md:160-162`）；`roadmap.md:136` | ✅ `block_names` 已支持 |
| **W6** | 导入别人的导出树 / 处理冲突 | 5 次；冲突与组归属要模型自己判断 | `packages/dsh-tia-openness-v17-min/docs/EXPORT-COMPARISON.md:131-133`（**推断**） | ✅ `mirror_groups`/`override` 已有 |
| **W7** | 版本之间的"工程级差异说明 + 提交信息" | 无工具；1151 个 XML 的裸 diff 对模型无意义 | `vision.md:96`；`roadmap.md:137`；`open-questions.md:468` | ❌ 依赖工程知识图谱插件（图谱） |
| **W8** | 跨版本认出同一个对象（改名后仍关联） | 无工具；manifest 里**没有** TIA 唯一 id | D7；`packages/dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md:46` | ❌ 需先补 `id` 落盘 |
| **W9** | workspace 引导（新建/另存/归档/取回 + 路径规则） | 4–6 次；4 个生命周期工具**全部未在真实项目验证** | `open-questions.md:108`（A5）；D5；`roadmap.md:129`；`packages/dsh-tia-openness-v17-min/README.md:62` | ✅（操作存在，⏳ 未验证） |
| **W10** | 变更上下文"待办清单" | 完全不存在 | `roadmap.md:134`；`architecture.md:165-169` | ✅ 纯插件侧 |
| **W11** | 调用关系 / 影响面 | 不存在 | `roadmap.md:171`；A13 | ❌ 需新操作或工程知识图谱插件 |
| **W12** | 由块/UDT 生成 SCL/STL 源给模型读 | 3 次；一次只能一个输出文件，块与类型不能同文件 | `packages/dsh-tia-openness-v17-min/README.md:206`（**推断**） | ✅ |
| **W13** | 标签表/变量批量维护 | 6 次；`write_tags` 一次只能一张表 | `packages/dsh-tia-openness-v17-min/README.md:203`（**推断**） | ✅（控制器一次一张表，插件可循环） |
| **W14** | F 安全程序核对（签名 / 安全设置） | 4–5 次；`safety_status` 与 `safety_signatures` 本该一份报告 | `packages/dsh-tia-openness-v17-min/README.md:216`（**推断**） | ✅（需装 STEP 7 Safety 才能验） |

**排序（按"用户证据强度 × 现状糟糕程度 × 不需要新控制器能力"）**：
**W4 → W5 → W1 → W3 → W2 → W9 → W6 → W12/W13/W14 → W10 → W7/W8/W11**。

> 一句话读法：**只有 W2 是被完整服务的**；W1/W3/W4/W5/W9 都只差"一层插件侧的中间层"；
> W7/W8/W11 卡在工程上下文插件/工程知识图谱插件，不是卡在控制器。

---

## 4. 目标工具面（提案）

### 4.1 分层

| 层 | 谁看得见 | 放什么 |
|---|---|---|
| **工作流层** | 模型默认可见（目标 ~8–10 个） | 以**用户目标**命名；内部自己编排控制器操作、自己分页、自己聚合 |
| **原子层** | 默认**不**暴露（配置开关） | 现有 25 个操作的一对一封装，留给排障、测试与内部调用 |
| **控制器/白名单** | 模型永远看不见 | 不变（安全边界，继续由 `OPERATIONS` 与 C# 白名单双重校验） |

**关键：合并发生在新的一层里，控制器白名单不动。** 这样"安全边界"与"能力边界"解耦，
C# 侧只在确实需要（多对象建对象、批量设置项、跨操作事务）时才动。

### 4.2 工作流层清单（提案，名称可改）

| # | 工具（提案名） | 回答什么问题 | 内部合并的操作 | 默认写入？ |
|---|---|---|---|---|
| 1 | `project_open` | 打开/附加工程，并**立刻**回报"这是个什么工程"（设备、PLC 软件、块/类型/标签表规模、语言、未保存状态） | OpenProject + ProjectInfo + ListPlcObjects(仅计数) | 否 |
| 2 | `project_overview` | 任意时刻取工程概要：组树、各族计数、规模 top-N、（有基线时）变更概览 | ProjectInfo + ListPlcObjects(计数/组) | 否 |
| 3 | **`change_report`** | **"自上次以来哪些块变了、改了哪一面"** | ListPlcObjects(指纹，内部翻页) + 本地 diff + 基线工件 | 否（可选更新基线） |
| 4 | `snapshot_export` | 把工程导出成文本源树（默认 blocks+types+tag_tables）；可选 `changed_only` | ExportBlocks（+ 变化集合） | 只写文件 |
| 5 | `block_read` | 取指定块的源文件**并给出路径**，让模型用内置 `read` 按需分段读 | ExportBlocks(block_names) / GenerateSource | 只写文件 |
| 6 | `block_write` | 把改动写回并**证明成立**：计划 → 导入（自动原组/override）→ 编译 → 读回验证 | ImportBlocks + CompilePlc + 写后验证(+ 复核导出) | 是（工作流级 `apply`，默认 false） |
| 7 | `project_compile` | 编译并只回报**错误/warning**（其余消息进工件） | CompilePlc | 是（编译状态） |
| 8 | `tags_edit` | 跨多张标签表批量增删改变量与常量 | WriteTags(内部逐表循环) + 校验读取 | 是（默认 false） |
| 9 | `objects_edit` | 批量建/删 PLC 对象（组/表/块/单实例 DB/软件单元/监视表） | CreatePlcObjects + DeletePlcObjects（批量需 C# 侧配合，见 §5.1） | 是（默认 false） |
| 10 | `safety_report` | F 安全核对：全局设置 + 逐块签名，**一份报告** | SafetyStatus + SafetySignatures | 否 |
| 11 | `tia_status` | 环境自检（Openness 版本/位数/用户组、控制器与会话状态、最后一次错误） | controller_status | 否 |

> 生命周期类（新建/保存/另存/归档/取回/关闭）先并成一个动作枚举式的 `project_lifecycle`（或留到 P3），
> 理由：它们的**真实使用频率**远低于上表，而 `archive_project`/`project_texts` 这类
> 高不确定操作（`packages/dsh-tia-openness-v17-min/docs/VERIFICATION-PLAN.md:134`）不该占常驻目录。这一点见 §7 的 A15。

### 4.3 返回契约（提案）

| # | 规则 | 为什么 |
|---|---|---|
| R1 | 工具结果控制在 **~4 KB / 40 行**内（可配，但目标要远低于框架的 8192 字符 Pruner 阈值与 12500 tokens Spill 阈值） | 结果是要进上下文的，不是给人看的日志；被框架剪掉时**剪的是中间那段**，等于随机丢数据 |
| R2 | **批量数据一律落盘成工件**（JSON/XML/日志），结果里只给 `工件路径 + 计数 + 预览(前 N 行) + 下钻方式`；能复用框架的 `ctx.spillStore.saveText()` 就复用它（返回 `locator` + `retrievalHint`，本地就是文件路径） | DSH 自带 `read`（支持 `offset`/`limit`）与 `grep`，按需读比一次灌进去便宜得多；导出 manifest 已经是这个形态（`OUTPUT-CONTRACT.md:120`） |
| R3 | **对模型无效的字段不进文本**：指纹 `value`、`sha256`、`bytes`、绝对路径、逐文件行 | 用户原话："指纹字符对于模型来说是无效信息" |
| R4 | 列表 = `计数 + 前 N 名 + "其余 N 个见工件"`，N 可配 | 现在硬编码 20 且**没有**下钻手段（这才是致命处） |
| R5 | **失败优先**：编译错误、导入冲突、导出被拒、验证失败**全量**给；成功项只给计数 | 模型据错误行动；成功项它不需要逐条看 |
| R6 | 每个工作流工具都提供 `detail: summary \| full`（或 `max_rows`），`full` 也是**落盘 + 预览**，不是全倒进文本 | 保留"我要看全部"的能力，同时守住上下文 |
| R7 | **dry-run 提到工作流层**：`apply: false`（默认）→ 一次给出"将要做什么 + 影响面"；`apply: true` → 执行 + 验证 | 现在每一步各要一次 dry-run，模型容易只做了一半 |
| R8 | 长操作给出**阶段摘要或句柄**（见 §5.3） | 87 s / >10 min 的静默是不可接受的 |

**示例：`change_report` 的返回（提案）**

```jsonc
{
  "ok": true,
  "summary": "3 of 1152 blocks changed since baseline 2026-10-13T03:35Z; 1 compile-relevant (Code), 2 comments only.",
  "counts": { "blocks": 1152, "types": 210, "changed": 3, "added": 0, "removed": 0 },
  "facets": { "Code": 1, "Comments": 2, "Interface": 0, "Properties": 0 },
  "changed": [
    { "name": "FB_Motor", "group": "010_Cell", "facets": ["Code"], "signature": "…短标识，不是完整值…" },
    { "name": "FC_Test",  "group": "",          "facets": ["Comments"] }
  ],
  "artifacts": [
    { "kind": "change-set", "path": "…\\_tia-openness\\changes-2026-10-14T09-12Z.json", "rows": 3 },
    { "kind": "baseline",   "path": "…\\_tia-openness\\fingerprints.json",            "rows": 1362 }
  ],
  "baseline": { "path": "…", "createdAt": "2026-10-13T03:35:39Z", "updated": false },
  "drilldown": "Read the change-set artifact for the full per-object facet list; use snapshot_export with changed_only=true to materialise exactly these objects."
}
```

要点：**1152 个对象的完整指纹进工件，模型只看 3 条差异 + 计数 + 路径。**

### 4.4 框架给我们的边界（实测，决定契约能怎么写）

| 事实 | 含义 |
|---|---|
| 模型只看到 `render` 产出的 content blocks；**结构化 `value` 不下发**（`appendToolResult` 只持久化 `content`） | 契约必须写在**文本**里；`data` 不能当交付通道 |
| 可用的 block 类型：`text` / `image` / `file`（`file` 会被统一重写成一行"路径句柄"，字节永不下发）；**没有** `resource`/`link` | 大材料只有两条路：写成文件 + 文本里给路径，或用 `file` block 给句柄 |
| **裁剪三件套**：① Pruner `thresholdChars: 8192`（头 4096 + 尾 1024，按码点，**仅在压缩触发时**运行，剪掉中间）；② Spill：单条结果超过 `maxInlineTokens: 12500` 自动落盘，只留一行 `Full formatted result stored at: <locator>`；③ provider/工具自身上限（**不可恢复**） | 本发行版政策层里就是这两个数字：`profile/dsh-automation-suite/cordis.patch.yml:167-172`（Pruner）与 base 的 `:404-410`（Spill） |
| **`ctx.spillStore.saveText({ owner, source, suggestedName, content })` → `{ locator, bytes, retrievalHint }`**；本地后端的 `locator` **就是文件路径**，提示语直接让模型用 `read`（带 `offset`/`limit`）或 `grep` 取回 | 这正是"工件 + 下钻"，而且是**框架自带**的机制，不需要自己发明 |
| 会话工作目录来自 `exec.agent.session.header.cwd`；`ctx.workspace` 是宿主侧的项目/会话分组注册表，**不是**工作目录 | 工件默认路径怎么解析（对应 A14） |
| `defineTool({ timeoutMs })` 是**声明性**的，注册表**不执行**超时 | 长操作不能指望框架兜底 → 要做句柄就得**插件自己实现**（像内置 `pwsh`/`bash` 那样，见 §5.3） |
| 框架自己的预算口径：`read` 2000 行 / 50 KB、`grep` 250 条、`glob` 100 条；超限就给 `Found X of Y matches` 或 `Full result stored at: <locator>` | 要模仿的正是这套"**内联有界 → 给数字/分页 → 给出带外恢复路径**" |

**结论**：契约里的 R2/R4/R6（落盘 + 计数 + 下钻）不是自创，而是**与框架既有机制对齐**；
R1 的 4 KB 也必须这样定 —— 越过 8192 字符会被 Pruner 从中间剪掉（**剪掉的正好是中间那批数据**），
越过 12500 tokens 会被 Spill 自动落盘。**与其被框架剪，不如自己给一份有意义的摘要 + 路径。**

---

## 5. 机制设计（要落在插件侧的东西）

### 5.1 内部分页 / 批量

> ⚠️ **2026-10-14 更正（实现"缝 A"时核对 C# 得到）**：本节的"**按片请求**"做不到。
> 控制器的 `max_items` **只能截断** —— `controller/OpennessHost.Plc.cs:152,166` 在超过上限后
> 继续累加 `total` 但停止添加 `items`，**没有 offset/skip 参数**，所以不存在"下一页"。
> 可行的做法是**把上限抬到预期规模**（工程上下文插件消费的服务 `listObjects` 默认抬到 1000）并
> **如实传播 `truncated`**；下半句"TS 侧合并、去重、聚合"仍然成立（多族合并仍然要在插件侧做）。
> 详见 `packages/dsh-engineering-context/docs/decisions.md` **P0-15**。

- 控制器的 `max_items` 是**每族**上限（默认 200）：工作流工具内部自行抬高（~~并按片请求~~
  ——见上面的更正），TS 侧合并、去重、聚合。
- 已有数组语义的操作（导出/导入/删除/属性/保护/签名）**不需要循环**，只要工具把数组用满。
- **需要 C# 配合的**（先记着，P3 再做）：多对象 `create_plc_objects`、
  批量 `portal_settings` 设置、批量软件单元/关系、批量监视表建删导出、
  每对象一个文件的 `generate_source`、以及任何**跨操作**的原子性
  （open→import→compile→close 现在是 4 个独立请求，Openness 也不允许并发）。

### 5.2 基线快照与工件目录（**待决策，见 A14**）

- diff 需要一个"上次"：`{项目 → 对象 → facets → 指纹值}` 的 JSON。
- 三个候选：① 调用方显式传 `baseline_path`，默认落在项目目录旁（`<project_dir>\_tia-openness\fingerprints.json`）；
  ② 落在 `DSH_HOME` 下按项目路径哈希分目录；③ 交给 workspace（工程上下文插件的路径规则，**尚未存在**）。
- 建议：**① 为默认 + 允许显式覆盖**，理由：可携带、可进 git、与 D5 的 workspace 模型天然兼容；
  等工程上下文插件的路径规则定稿（B7）再让默认值跟随它。
- 两个现成的锚点（§4.4 实测）：会话工作目录 `exec.agent.session.header.cwd`（决定"相对路径解析到哪"）、
  框架自带的 `ctx.spillStore.saveText()`（临时工件可以完全交给它，连目录都不用自己定）。
- 工件统一放 `<workspace 或项目目录>\_tia-openness\`：`fingerprints.json`（基线）、
  `changes-*.json`、`compile-*.json`、`export/`（导出树，已有）。

### 5.3 长操作与进度（**待决策，见 A17**）

- 现状：progress 帧有、插件也解析，但没有接到工具结果（§2.5）。
- 三个候选：① **阶段摘要**——把 progress 聚合成"已导出 340/1151"，在结果里给出耗时与阶段；
  ② **长操作句柄**——工具立即返回 `job id`，另有工具查进度/取结果。框架**不提供**异步执行：
  `defineTool` 的 `timeoutMs` 是声明性的、注册表不执行超时（§4.4），所以要像内置的 `pwsh`/`bash`
  工具那样**由插件自己实现**（它们就是"立即返回 job id + 另一个工具读增量"）；
  ③ 只做"**超时前退出**"——为导出/编译提供 `timeout_ms` 参数并明确"超时 = 丢会话"，把选择权交给调用方。
- 无论选哪个，**默认 5 分钟对导出与编译都太短**（1151 块导出 81.7 s 尚可，大项目编译 >10 min），
  而超时的代价是丢会话。

### 5.4 一致性校验要跟着改

工作流层落地后，下面这几处守约机制必须同步（否则文档/矩阵会说谎）：

| 机制 | 现在守着什么 | 要改成什么 |
|---|---|---|
| `test/04-tools.test.mjs:204` | "一工具 = 一个白名单操作" | "工具内部用到的操作集合 ⊆ 白名单" |
| `npm run matrix:check` | 覆盖矩阵与代码/工具一致 | 增加"工作流 → 操作"映射的核对 |
| `npm run skills:check` | 知识库体积与引用 | 每个工作流工具的"何时/怎么/结果怎么读"三问（D4） |
| `packages/dsh-tia-openness-v17-min/docs/OUTPUT-CONTRACT.md` | 26 工具的清单 | 工作流层清单 + 工件/下钻约定 |

---

## 6. 从哪开始（建议的推进顺序）

### 6.1 P0 · 一条只读垂直切片：`change_report` + 基线（**建议从这里开始**）

**为什么是它**

1. **零 C# 改动**：控制器已经支持 `include_fingerprints` 与按名选择（`controller/OperationsPlc.cs:48,55-64`），
   "20 个上限"纯在渲染层（§2.2）。
2. **是已定决策的硬依赖**：D6（指纹是变更检测的硬依据）、D9（改 `.ap17` → 指纹比对 → 只导变化块）、
   `roadmap.md:131`（变更识别）与 `:136`（工作循环）都卡在这件事上。
3. **一次把所有新机制走通**：内部分页、快照落盘、增量 diff、工件返回、结果预算、dry-run 语义
   —— 后面 10 个工具都是它的翻版。
4. **只读、风险最低**：失败只是"报告不准"，不会写坏工程。

**验收口径（建议）**

| # | 口径 |
|---|---|
| 1 | 在 1152 块真实项目上，**1 次调用**返回变化集合；工具结果 ≤ 4 KB |
| 2 | 未改动的项目重复调用 → `changed = 0`（**不误报**，这是 D6 的核心承诺） |
| 3 | 只改一个块的注释 → 报出该块的 `Comments` 面变化；只改代码 → 报 `Code` 面变化（**能区分"改了哪一部分"**） |
| 4 | 抽样 5 个块与"导出内容逐字节对比"结论一致（**不漏报**）；`<DocumentInfo><Created>` 之类的噪声不算变化（`packages/dsh-tia-openness-v17-min/docs/EXPORT-COMPARISON.md:112-117`） |
| 5 | 记录耗时：全项目指纹读取 + diff 的秒数，与"重算一次"的代价（指纹无缓存，§2.3） |
| 6 | 与 `snapshot_export(changed_only: true)` 连胜：导出的块集合 = 变化集合（D9 的工作循环闭环） |
| 7 | 单测用 stub 控制器覆盖分页合并、基线缺失/损坏、`truncated` 边界 |

**前置风险（先验掉再动手）**

- V17 上 `FingerprintProvider` 的**可得性与粒度**（这是 D6 的待验证项 1，`decisions.md:187`）；
- 一次请求取 1152 块指纹的**帧大小与耗时**（无帧长限制，`controller.ts:585-591` 逐行解析）；
- **基线放哪**（A14）。

### 6.2 后续阶段

| 阶段 | 做什么 | 收口掉哪些原子工具 |
|---|---|---|
| **P1** | `project_open` + `project_overview` + `snapshot_export` + `block_read` | open_project, project_info, list_plc_objects, export_blocks, generate_source |
| **P2** | `block_write` + `project_compile`（写路径收口，dry-run 上提） | import_blocks, compile_plc, set_block_attributes, protect_blocks |
| **P3** | `tags_edit` + `objects_edit` + `safety_report` + 生命周期动作；原子层加 `atomicTools` 开关（默认关） | write_tags, create/delete_plc_objects, watch_and_force_tables, software_units, safety_*, create/save/archive/close_project, project_languages, project_texts, update_project, portal_settings |
| **P4** | 文档与 skill 按工作流重写（D4 三问）；守约机制同步（§5.4）；`TOOL_GAPS` 不再是空数组 | — |

### 6.3 本次调研的复现方法

- **工具目录成本实测**（§2.7）：用 stub 的 `ctx.tools.register` 捕获 26 个定义再序列化：

  ```powershell
  cd packages/dsh-tia-openness-v17-min
  node -e "(async()=>{const m=await import('./lib/tools.js');const cap=[];m.registerTools({tools:{register:d=>{cap.push(d);return()=>{}}}},{request:async()=>({}),status:()=>({}),verbose:false,log:()=>{}});let i=0;for(const d of cap) i+=JSON.stringify({name:d.name,description:d.description,parameters:d.parameters}).length;console.log(cap.length,'tools',i,'chars')})()"
  # 26 tools 50593 chars
  ```

- **上限定位**（§2.2）：`rg "MAX_LISTED" src/tools.ts`、`rg "DefaultMaxItems" controller/`；
- **批量能力**（§5.1）：`controller/Operations.cs:229,289`、`OperationsPlc.cs:357-441,453,488,1013`；
- **框架边界**（§4.4）：从 `resources/app.asar` 里抽出运行时（`dsh/node_modules/@deepseek-ai/*`），
  看 `dsh-tools/lib/index.js:838-887`（`defineTool` 真正读了哪些键）、
  `dsh-agent-loop/lib/index.js:691-707`（只持久化 `content`）、
  `dsh-spill/README.md`（`saveText` 契约）与 `dsh-base/cordis.patch.yml:404-423`（Spill/Pruner 阈值）。
  注：`resources/app.asar/dsh/` 不是真目录，要在 asar 内取包。

---

## 7. 待决策 / 待验证（需要你拍板）

> 这四条已作为 **A14–A17** 写进 [`open-questions.md`](open-questions.md)，可直接在那里写答复。

| # | 问题 | 我的倾向 |
|---|---|---|
| **A14** | 基线快照与工件放在哪？（项目目录旁 / DSH_HOME / 等 workspace） | 项目目录旁 `_tia-openness\`，允许显式覆盖；workspace 定了再跟随 |
| **A15** | 原子层怎么处理？彻底下架 / 保留但默认不暴露（配置开关） / 只保留只读的 | **保留但默认不暴露**：排障、测试与工程上下文插件/工程知识图谱插件的内部调用都需要它，删除的代价高于收益 |
| **A16** | 工作流工具要不要自己开关工程？（每次调用自开自闭 vs 复用已开会话） | 复用已开会话，但每个工具在结果里显式回报会话状态；冷启动 70.1 s、热 9.8–24.2 s（`packages/dsh-tia-openness-v17-min/README.md:81`），自闭会毁掉可用性 |
| **A17** | 长操作怎么表示？阶段摘要 / 句柄 / 只给 timeout 参数 | 先做阶段摘要 + `timeout_ms`，句柄等确认框架支持再上（`defineTool` 的 `timeoutMs` 是声明性的，注册表不执行超时，见 §4.4） |
| **待验证** | V17 指纹可得性与粒度、全项目指纹的耗时与帧大小 | 见 §6.1 前置风险 |

---

## 8. 与现有决策的关系

| 已有决策 | 本文与它的关系 |
|---|---|
| D4（文档 = description + skill + 一致性校验） | **不变**：工作流工具同样要回答三问，只是"一个能力一篇"变成"一条工作流一篇" |
| D5 / A5（workspace 作用域） | 本文的工件与基线路径是它的**落点候选**，不是替代；默认值等 B7 定稿 |
| D6（指纹是硬依据） | 本文是它的**首次落地**（P0） |
| D7（导出物唯一 id 作身份键） | **未解决**：manifest 里还没有 `id`（`MANIFEST-GAP-ANALYSIS.md:46`），W8 卡在这 |
| D9（`.ap17` 是真相源，只导变化块） | P0+P1 直接把这条工作循环做成可调用的一步 |
| D17（用 `categories` 扩能力，不新增工具） | **同一方向**：合并优于铺开。区别是 D17 合并的是"同类对象"，本文合并的是"同一条工作流" |
| 根 `AGENTS.md` §1（政策层在 profile） | 工作流工具的"何时用哪条工作流"也可以进 preset 的政策文本，但**先不做**，等工具面定型 |
