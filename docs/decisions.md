# 决策记录（发行版级）

> 这里记录**已经定下来的取舍**：为什么这么定、连带约束是什么、哪一条还等着验证。
> 与 [`open-questions.md`](open-questions.md)（还没定的）互为反面；架构的**当前形态**描述在
> [`architecture.md`](architecture.md)，进度在 [`roadmap.md`](roadmap.md)。
>
> 各插件自己的技术取舍写在各自的 `docs/decisions.md`（如 TIA 包的 D1–D19），本文件只记**跨插件/发行版级**的决定。

状态图例：✅ 已定 ｜ 🟡 已定但有待验证项 ｜ ⏳ 有条件（条件满足即生效）

---

## D1 · 接口插件的能力层级按「能力范围」划分 ✅

**背景**：min / std / pro 需要一个划分依据，否则"更多更全"无从判断。

**决定**：按**能力范围**划分，维度包括 ——

| 维度 | 取值 |
|---|---|
| 读写性质 | 只读 PLC 数据 / 带**回写**能力 |
| 对象域 | 硬件 / 软件 |
| 连接状态 | 离线 / 在线 |
| 覆盖范围 | PLC only / 含 HMI |
| 工程结构 | 是否含软件单元（SW units）、多用户、项目库 / 全局库 |

**当前策略**：**只维护 min**（实现基础功能）；后续增加功能时**在 min 的基础上扩展**。
每个层级具体囊括哪些能力**日后再详细定义**。

**后果**：`std` / `pro` 不是现在要落地的交付物，而是 min 的延伸方向；
[`roadmap.md`](roadmap.md) §2 的"能力层级"一栏按此维护。

---

## D2 · min / std / pro 默认"一档一个包"，但有一个前提条件 ⏳

**背景**：分层形态决定包名、发布方式与 profile 蓝图条目数。

**决定**：**倾向一档一个包**（`-min` / `-std` / `-pro`）；**若"min 加能力后同步到其余档"的成本
不可接受，则改为"内核包 + 能力包"**。

**本仓补充的两条硬约束（会直接影响这个判断）**：

1. **同族两个档不能在同一个 profile 里同时生效**：一个宿主进程只允许一个控制器子进程
   （见 `architecture.md` §2），两档各自 `apply()` 会拉起**两个控制器 / 两个 TIA 会话**。
   所以多档共存必须靠 profile 的 patch 层**互斥启用**（disable 一档、启用另一档），
   或者根本上走"一个包 + 层级配置"。
2. **公共协议与控制器骨架不能复制三份**：std/pro 应当**以包依赖的方式复用 min**
   （或抽内核包），而不是拷贝代码 —— 这样 min 的能力增量会自然流向其余档。

**待验证**：把 min 作为依赖被 std 复用后，插件行、控制器生命周期与配置 schema 是否仍然干净
（一次 TIA 会话、一套配置）。

---

## D3 · 多 TIA 版本先只做 V17，第二个版本到来时抽公共包 ✅

**决定**：现在集中做 V17；等增加第二个 TIA 版本时，把公共部分（协议、帧、命令骨架、验证流程）
抽成 core 包。

**后果**：`packages/` 目前只有 V17 一个成员是**预期状态**，不是缺口。

---

## D4 · 接口能力的"文档"按 description + skill 交付，并做一致性校验 ✅

**背景**：光暴露接口不算达成 —— 模型必须能搞清**何时调用 / 怎么调用 / 调用后的数据怎么用**。

**决定**：

| 载体 | 承担什么 |
|---|---|
| 工具 description | "何时用"（触发条件）与一句话说明 —— 模型一定会读到 |
| 随包 skill | 细节：参数与顺序、约束、典型组合、**结果怎么解读** |
| 一致性校验 | 像 `matrix:check` 那样：工具签名/枚举变了而文档没变就**失败** |

**且需要提前考虑**：后续要支持**用户根据自己的项目特点自己写 skill** 供 agent 调取 ——
见 [`open-questions.md`](open-questions.md) **A12**（形态未定）。

---

## D5 · session 绑定 workspace，workspace 是工程作用域的一级概念 ✅

**决定**：参照 DSH Web 左侧导航栏的组织方式：

1. 用户要做一个工程项目，**先新建一个 workspace**；
2. 在 workspace 下**启动 session**；
3. agent 把源 TIA 项目**打开并另存到 workspace 目录**下；
4. 再打开 workspace 里的这个本地 TIA 项目，把源文件**导出到项目路径下**；
5. 按一定规则维护这个 workspace 的项目路径。

**因此**：**session 与工程项目绑定**；新启动的对话**原则上只能访问自己 workspace 下的工程项目**。

**后果**：

- 作用域隔离从"约定"变成"结构"（不同 workspace 不串味）；
- 工作副本与源项目分离：agent 动的是 workspace 里的副本；
- 路径规则（workspace 里放什么、怎么放）成为插件族 2 的**交付物**，见
  [`roadmap.md`](roadmap.md) §3（B7 仍待细化到字段级）。

---

## D6 · 变更识别以 TIA 指纹为硬依据 ✅

**背景**：`.ap17` 是二进制工程文件，mtime 不可靠；自研内容哈希与外部工具算法都不可复现。

**决定**：**用 TIA 提供的 fingerprint provider 识别块是否被更改**，以它为硬依据。

**技术口径（已核对本仓 `skills/` 语料）**：

- `Siemens.Engineering.SW.FingerprintProvider.GetFingerprints()` —— 手册主题
  "Changing blocks using fingerprints"；
- **仅块（FB/FC/OB/DB）与 PLC 数据类型（UDT）可用，标签表没有**；
- 每项形如 `{id, value}`，`id` ∈ `Code` `Comments` `Interface` `LibraryType` `Texts` `Alarms`
  `Supervisions` `TechnologyObject` `Events` `TextualInterface` `Properties`
  —— 即**能区分"改的是哪一部分"**，不只是"有没有变"；
- 同族还有更粗/更专的粒度可用：`PlcChecksumProvider`（整个 PLC 程序是否变过）、
  `SafetySignatureProvider`（Safety 专有）、项目级时间戳（`LastModified`）。

**后果**：变更检测**必须开项目**（指纹来自 Openness，不是文本分析）；
"离线判断变没变"不再是本方案的路径，离线能力留给图谱层。

**待验证**：指纹在 V17 上的实际可得性与粒度（本仓 `skills/` 语料是 V21 时代语义，
V17 子集需实测确认；该包 `docs/EXTENDED-SURFACE.md` 已在接线 `include_fingerprints`）。

---

## D7 · 工程对象的身份键 = TIA 提供的唯一 id ✅

**决定**：TIA 在**导出源文件时提供唯一的 id**，跨版本关联（"这还是同一个对象吗"）**以它为身份键**。

**补充（本仓语料核对结果）**：

- Openness 有 `ObjectIdentifierProvider` —— "stable, project-unique identifier per object"，
  但**自 TIA Portal V21 起才可用**，对本项目要做的 **V17 不可用**；
- 所以 V17 走**导出物携带的 id**，V21+ 可以再切换到 `ObjectIdentifierProvider`。

**待验证（重要）**：导出物里的 id 在**改名 / 编辑 / 重新导出 / 另存副本**之后是否稳定。
本仓 `docs/MANIFEST-GAP-ANALYSIS.md` 曾对某个外部工具的 `id` 做过推断（"疑似内容派生的稳定标识"）
并明确记下"无法验证跨导出是否稳定"—— 身份键错会让跨版本关联**静默断链**，所以要单独验一次。

---

## D8 · 图谱底座：SQLite + Graph DB ✅

**决定**：采用 **SQLite + Graph DB** 这条技术路径（已在另一个代码库中验证可用），不引入服务型图数据库。

**后果**：**无需用户额外部署服务**；原先随之收窄的两个问题已由 A10 / A11 答定 ——
分区与更新策略见 **D13**，PLC 语法翻译深度见 **D14**（答复见 [`open-questions.md`](open-questions.md)）。

---

## D9 · 真相源是 `.ap17` 项目本身 ✅

**决定**：**`.ap17` 是真相源**。用户可以**直接修改 `.ap17` 项目**，改完之后做对比，
然后**导出更新过的对应块** —— 导出物是派生的视图，不是源头。

**后果（把 D6 串起来）**：工作循环是

```
用户在 TIA 里改 .ap17  →  指纹比对找出变化的块  →  只导出这些块  →  更新图  →  交给模型
```

- 变更检测**必须先于**导出，否则要么全量重导（慢）、要么拿旧内容回答（错）；
- "全量重建 vs 增量更新"这个问题在图与导出物两侧都会出现（见 A10）。

---

## D10 · 插件族之间先各自独立，不抽共享包 ✅

**决定**：公共类型、协议、作用域标识**暂不**抽 core 包，各插件独立，靠文件契约对接。
出现第三处重复时再抽。

---

## D11 · 先做深 TIA；之后按 Rockwell 排，其他暂无计划 ✅

**决定**：除 TIA 外**只规划 Rockwell**，其他厂商（Beckhoff / 三菱…）**暂无计划**。
跨厂商统一中间表示（IR）**暂不做**，先把 TIA 一家做深。

---

## D12 · 工程上下文管理插件（族 2）：作用域锚定宿主 workspace，状态落 workspace 内 ✅

**背景**：插件族 2 进入设计（产出：[`packages/dsh-engineering-context/docs/ARCHITECTURE.md`](../packages/dsh-engineering-context/docs/ARCHITECTURE.md)）。
设计前核对了运行中的宿主，发现 **D5 的 workspace 模型在宿主里已经存在**：
服务 `ctx.workspaceRegistry`（`@deepseek-ai/dsh-workspace`），
而会话归属判定 = session 的 `header.cwd` 归一后**等于** workspace 路径
（`dsh-workspace/lib/index.js:122`；服务注册见 `:374`），工具调用期可读到该 cwd
（`dsh-tools/lib/index.js:1423`）。

**决定**（三条，细节与该包的编号决策见其 `docs/decisions.md` D1–D14）：

1. **作用域锚定宿主的 workspace，不自建**：作用域根 = `exec.agent.session.header.cwd`；
   宿主身份用 `ctx.workspaceRegistry.resolveByPath()` 认领；**只读**注册表 ——
   从不 `create` / `attachSession` / `archiveSession`（建 workspace 是用户在 GUI 的显式动作）。
   ⇒ **D5 不需要这一族实现一遍**，"不串味"由"每次调用从 cwd 重新解析 + 路径包含性校验"结构性保证。
2. **状态落 workspace 内**：`<workspace>/_dsh-eng/`（工程注册表、**指纹基线**、变更集、变更台账），
   可携带、可进 git；宿主 `ctx.storageDomain` 只承担**可再生**的作用域指针。
   `ctx.spillStore` 因按会话归属且工件会过期，**不用于基线**。
3. **与族 1 的接缝 = 服务，不抽包**：族 1 注册一个可选的 cordis `Service`
   （只读能力：状态 / 开关项目 / 列对象含指纹 / 导出），族 2 可选注入，缺席时降级读旧工件并**报过期**。
   与 **D10**（先各自独立、不抽共享包）不冲突 —— 这是**服务契约**，不是共享包；
   且它不经过族 1 的工具面，所以 **A15** 怎么定都不影响这条路径。

**随设计一并定的两条口径**：变更键**只用 TIA 指纹**，manifest 的 `sha256` 只作完整性审计
（它含 `<DocumentInfo><Created>`，每次导出都变，见
[`MANIFEST-GAP-ANALYSIS.md`](../packages/dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md) §3）；
对象身份键在 `tiaObjectId` 拿到之前走"复合键 + `rename-candidate`"降级路径，
并在结果里**显式标记**"身份按名字推断"（身份键错会让跨版本关联**静默断链**，见 D7）。

**后果**：

- 落地位置定为 `packages/dsh-engineering-context`；
- 新增两个**族 1 侧**的工作项：注册该服务；补 `tiaObjectId`（后者仍待实测）；
- 开放问题 **A8 / B7 / B8 / B9** 已答（见 [`open-questions.md`](open-questions.md)）；
- 状态同步：[`roadmap.md`](roadmap.md) §1/§3 与根 [`README.md`](../README.md) §2 两处。

**进展（2026-10-14）**：

- **D12 第 3 条的"缝 A"已落地**：族 1 注册了 **`engineeringAccess`** 服务
  （`packages/dsh-tia-openness-v17-min/src/access.ts`，该包 `docs/decisions.md` **D20**），
  接口面镜像在族 2 的 `docs/ARCHITECTURE.md` §5.3。族 2 的**消费代码属 P2**，尚未接入。
- **实现进度**：**P0（作用域 + 工程注册表）与 P1（版本层 `eng_version`）都已实现，并已登记进蓝图**；
  `--dump-config` 实测 1520 行；本包 44 项单测全通过。
  P1 只版本化"导出物 + 工程状态"，`.ap17` 由 `.gitignore` 挡在库外，提交默认 dry-run，
  且绝不 `init` / `force` / `push`（该包 `docs/decisions.md` P1-1…P1-6）。
- **指纹可得性**：**用户报告已在另一个代码库验证可用**（用户侧证据，**不是本仓实测**）——
  本仓第一次在 V17 真机跑 P2 时仍需留下证据（见待办清单第 1 条）。
- **一处实测更正**：控制器的 `max_items` 只能截断、**没有 offset**，所以"按片翻页"不可行
  （族 2 `docs/decisions.md` **P0-15**）；这条同时更正了 `docs/tool-surface.md` §5.1 的措辞。

---

## D13 · 图谱分区与更新（族 3 的数据模型）🟡

**背景**：[A10](open-questions.md) 问"图怎么分区、怎么更新"；图底座已由 **D8** 定为 SQLite + Graph DB。

**决定**（三条，答复原文见 [`open-questions.md`](open-questions.md) A10）：

1. **分区 = 一个 workspace 下每个 PLC device 一张图**；**一个 workspace 下的多个分支暂不考虑**
   —— 不为分支建多份图。
2. **更新 = 初次全量重建，之后增量更新。**
3. **变更键 = 每个块各自的 TIA fingerprint**；**没有 fingerprint 的对象用 contentHash 兜底**
   （D6 已记：标签表没有指纹）。

**后果**：

- **全量重建保持离线**：它只读 `projects/<id>/export/`，符合 D6"离线能力留给图谱层"。
  **但增量路径需要开项目** —— 指纹来自 Openness（D6），与族 2 的工作循环
  （[`roadmap.md`](roadmap.md) §3 第 8 项）是**同一条依赖**，不是族 3 自己能满足的。
- ⚠️ **contentHash 兜底必须归一化**（先剥掉 `<DocumentInfo>` / `<Created>`），否则标签表
  每次重新导出都会被判为"变了"。**D6 / D12 已经因为同一理由拒绝把 manifest 的 `sha256`
  当变更键**，依据见 [`MANIFEST-GAP-ANALYSIS.md`](../packages/dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md) §3。
- ⚠️ **"用 fingerprint 区分块有没有变"本来就是族 2 的职责**（D6 + 族 2 P2 的指纹基线
  `_dsh-eng/<id>/fingerprints.json`）。所以族 3 有两条落地路径：**① 消费族 2 的变更集**
  （默认 —— 避免两处各自算指纹导致口径漂移）／**② 自己经族 1 的 `engineeringAccess` 服务取指纹**
  （族 2 缺席时的降级）。**这一条仍需拍板**，见文末待办清单。
- **db 的具体路径仍未定**：它是族 3 的状态，**倾向** `_dsh-eng/<project-id>/` —— 因为
  [`PATH-RULES.md`](../packages/dsh-engineering-context/docs/PATH-RULES.md) §2 的哲学是
  `projects/` 属用户、`_dsh-eng/` 属插件。**无论选哪里，都要回写该文件 §2/§8** ——
  那里现在没有它的位置。

---

## D14 · 图谱的 PLC 语法翻译深度（A11）✅

**背景**：[A11](open-questions.md) 问翻译做到多深 —— "块级结构"与"语句级语法树"差着一个编译器前端。

**决定**：**SCL 与 LAD/FBD（含 Safety 的 `F_LAD` / `F_FBD`）做到语句级；其他块语言暂不支持。**
且**深度随结果标注**：每个网段带 `confidence` ∈ `exact` / `partial` / `untranslated` 与 `notes[]`；
未覆盖的指令**泛化渲染并显式标注**，**不猜**。

**依据**：移植物（另一代码库的 FlgNet → SCL 翻译器 `ProgramBlockLogicYamlWriter`）已在此深度上
跑过真实 V17 导出物；**STL（AWL）与 GRAPH 没有处理路径**，落入显式失败分支 ——
所以"暂不支持"是**已知边界**，不是待办。

**后果**：

- [`roadmap.md`](roadmap.md) §4 第 2 项的口径按此定：覆盖范围以**实测过的指令目录**为准；
- **B14（"准确"如何验收）因此可按 `confidence` 分级统计**，而不是只有"对 / 错" ——
  与 §4 验收口径"宁可明确报'不支持这种写法'，不要猜"一致。

---

## D15 · 图谱的关系边只来自 XML 解析（A13）✅

**背景**：[A13](open-questions.md) 问边从哪来 —— 自己解析 XML，还是取 TIA 的 `CrossReferenceService`。

**决定**：**只解析 XML，不取 TIA 交叉引用**（答复原文："A，纯 XML 解析，离线可用"）。
图谱层保持**离线**：不依赖 TIA Portal、可在 CI 跑。

**代价（必须写明）**：跨块、跨 UDT 的深层引用闭包（unused / used-by）靠 XML 推断，
**可能漏或错**；`CrossReferenceService` 是**权威答案**而**不用**它。

**后果**：在线对账**降级为后续可选项**，不作边的主来源。与 [`roadmap.md`](roadmap.md) §4
"**离线可 CI**"这条验收口径一致。

---

## D16 · 图谱能力的暴露形态（B16）🟡

**背景**：[B16](open-questions.md) 问图谱能力是走工具族、随包索引文件，还是 skill 资源。

**决定**：

1. **图谱工具走工具面暴露，不用 skill 交付** —— 用户理由：skill 是静态文件，
   可能不按需、不最新；工具读的是活数据。
2. **面向"回答特定工程问题"的子 agent 必须能看到图谱工具**，而**操作层面的工具在那个子 agent 里隐藏**。
3. **先把工具暴露出来**（先可用，收口后置）。

**后果**：

- **`get_schema` 类能力保留为工具**（返回活的 DDL / 词表），**不做成 bundled skill**。
  这与族 1 的 skill 形态（`packages/dsh-tia-openness-v17-min/src/skills.ts` / **D4**）**不冲突** ——
  那一条服务的是**静态手册知识**，两者载体不同。
- **需要一个子 agent 的 preset**（在 profile 蓝图 `profile/dsh-automation-suite/cordis.patch.yml` 里），
  把图谱工具列进去、把操作层工具排除。
  ⚠️ 按根 [`AGENTS.md`](../AGENTS.md) §1，preset 必须**整份重述** `config.plugins` ——
  漏写会让该 agent 的工具**静默消失**（不报错）。
- **工具目录成本不再由主 agent 承担**，所以 B16 **不再需要**"工作流层 / 原子层两层收口"
  来省常驻字符。但 `query`（任意只读 SQL）**是否进子 agent 面仍是独立取舍** —— 见
  [`architecture.md`](architecture.md) §6「不向模型暴露任意代码执行」。
- **待验证**：DSH 里"按 agent 隐藏工具"的**确切机制**（族 2 `ARCHITECTURE.md` §5.3 提到工具解析
  "按可见性"，`dsh-tools/lib/index.js:3058`）—— **写工具层之前必须先核实，别猜**。

---

## D17 · 族 3 的包名与 C# 命名照族 1 的规则 🟡

**背景**：族 3 开工前定包名与 C# 工程命名。第一次 vendoring 时**沿用了来源库的
`Mcp.Knowledge.*` 命名空间**，理由是"最小偏离、便于与来源库 re-sync"——**该理由被否决**，
要求按**本仓既有风格**取名。

**旁证（支持这条否决）**：移植物中最大的那个文件的**来源头注释自己就写明放弃了 re-sync 约束** ——
`Parsing/ProgramBlockLogicYamlWriter.cs` 原文 "mcp-knowledge is now the home of this translator;
**the re-sync constraint is dropped** and the two copies may diverge"。
所以"保留原命名空间以便 diff"对它本就不成立。

**决定**：

1. **包名** `@voltarenyah/dsh-engineering-graph`（与族 2 的 `@voltarenyah/dsh-engineering-context` 平行）。
2. **C# 目录** `engine/`，项目文件 `EngineeringGraph.Engine.csproj`。
3. **`AssemblyName` = `RootNamespace` = `EngineeringGraph.Engine`** —— 规则同族 1 的
   `<产品 PascalCase>.<角色>`：产品取自包名去掉 `dsh-` 前缀，角色取自目录名
   （族 1 = 包 `dsh-tia-openness-v17-min` + 目录 `controller/` → `TiaOpennessV17Min.Controller`，
   见其 `.csproj` 的 `AssemblyName` / `RootNamespace`）。
4. **12 个 vendored `.cs` 全部拍平为单一命名空间 `EngineeringGraph.Engine`** ——
   照族 1 的**实际做法**（族 1 的 14 个 `.cs` 共用一个扁平命名空间，**不按子目录再分子命名空间**）。
   改名后的文件用**文件级** `namespace EngineeringGraph.Engine;`
   （net8 + `LangVersion latest` 允许；族 1 因 `LangVersion 7.3` 只能用块级）。
5. **默认引擎路径** `engine/bin/EngineeringGraph.Engine.exe`。

**后果**：

- 与来源库的 re-sync **不再是"可 diff"**，而是一次**显式重命名**：将来同步时须重新套用本条规则，
  并以 `dotnet build` 验证（拍平后的撞名会立刻暴露）。
- 首次以来源命名空间建立的包**已删除**——未提交、未进蓝图 `dsh.profile.bundles`、
  `pnpm-lock.yaml` 未变，且删除前已核实 **0 个 reparse point**。重建时按本条执行。
- 该包的 `.gitignore` **必须覆盖 `engine/bin/` 与 `engine/obj/`**：第一次建包时只忽略了
  `lib/`、`node_modules/`、`*.log`，此时 `git add -A` 会把 .NET 构建产物一起提交。

**已验证（2026-10-15）**：12 个文件拍平到单一命名空间 `EngineeringGraph.Engine` 后**没有撞名** ——
`dotnet build` **0 error / 0 warning**；全包 37 个顶层类型声明中**没有重名**。
同一次构建还跑通了 `--self-test`，这是编译证明不了的两件事：**原生 `e_sqlite3` 在运行期确实加载成功**
（SQLite 往返：写图 → 读回 → 2 节点 / 1 边），以及**真实导出物能被解析成图** ——
crawl 模式 7/7 个 fixture、**72 节点 / 153 边**，节点种类覆盖
`Project` / `OB` / `FB` / `FC` / `Network` / `Instruction` / `Variable` / `Global DB` / `Instance DB` /
`DB Member` / `UDT` / `UDT Member` / `Data Type` / `PLC Tag` / `IO Address`。
另外核过：12 个文件的正文**逐个等于**对来源文件施加同一条可逆变换的结果（纯变换，无夹带）；
包内**没有**残留对来源库其他工程的引用（`Contracts.*` 等）与绝对路径。

---

## D18 · 多会话并发时，共享文档文件的改动怎么提交 ✅

**背景**：本仓可能同时有多个会话在改，而"做到哪了"的状态集中在少数几个根文档里
（`README.md`、`docs/roadmap.md`、`docs/decisions.md`）。两个会话的改动会**落在同一个文件内**，
`git add <file>` 无法只提交其中一份 —— 于是要么连带提交别人的内容，要么把正确的状态留在工作树里。

**已发生的两次**（记在这里，免得下次重新踩）：

1. 族 1 的稳定对象 id 待办（本会话写的 `roadmap.md` §2）被上一会话的提交 `b69ae24` 连带带入；
2. 族 2 的 P1 状态同步（上一会话写的 `README.md` 多处 + `roadmap.md` §1/§3）留在工作树未提交，
   最后由本会话的 `2c1dc1e` 带入 —— 其中 README 的"对话"行由**两边共同改动**
   （先 `38 → 41`，再 `41 → 42`），是**同一个 hunk**，无法干净拆分。

**决定（约定）**：

- **能拆就拆**：按 **hunk** 切分提交。本会话的做法是 `git diff -U3` 取全文，
  按 `@@ -<起始行>` 把对方的 hunk 单独写成补丁，再 `git apply --cached` 只暂存那一份
  （实例：`5dc2c26` 只含族 2 的三处 hunk，本会话的内容留在后续提交）。
  注意 `-U0` 的补丁需要 `git apply --unidiff-zero`，用默认 `-U3` 更省事。
- **拆不开就在提交信息里写明**：同一个 hunk 被两边共同改动时，接受混在一个提交里，
  但**必须**在提交信息里指出哪部分不是本会话写的（实例：`2c1dc1e` 的 `ATTRIBUTION` 段）。
- **不因归属问题阻塞**：文档状态与代码不一致本身就是缺陷（根 `AGENTS.md` §1 要求
  `roadmap.md` 与 `README.md` §2 同步），宁可带着说明提交，也不要让**正确的状态**留在工作树里。
- 提交一律**本地**，不 `push`。

---

## 待办验证清单（由以上决策派生）

| # | 待验证 | 来源 |
|---|---|---|
| 1 | V17 上 `FingerprintProvider` 的可得性与粒度 | D6 —— 🟡 **用户报告已在另一个代码库验证可用**（用户侧证据，不是本仓实测）；本仓首次真机跑 P2 时仍需留证据 |
| 2 | 导出物里的 id 在改名/编辑/重导/另存后的稳定性 | D7 |
| 3 | 以 min 为依赖被 std 复用时，插件行与控制器生命周期是否干净（一次会话） | D2 |
| 4 | ~~workspace 路径规则的字段级定义~~ → **已定稿**：[`packages/dsh-engineering-context/docs/PATH-RULES.md`](../packages/dsh-engineering-context/docs/PATH-RULES.md) §8（其 §10 三项待确认） | D5 → B7 |
| 5 | ~~族 1 的服务缝（服务名与接口面）~~ → **✅ 已定并实现**：`engineeringAccess`（族 1 `src/access.ts` / 该包 D20）。**剩**：族 2 的消费代码（P2）跑通一次 | D12 |
| 6 | 图谱 db 的具体路径（倾向 `_dsh-eng/<project-id>/`）+ 回写 `PATH-RULES.md` §2/§8 | D13（A10） |
| 7 | contentHash 兜底必须归一化（剥 `<DocumentInfo>`/`<Created>`）才可用作变更键 | D13 |
| 8 | 族 3 取指纹的路径：消费族 2 的变更集（默认）还是自己经族 1 `engineeringAccess` 服务 | D13（A10） |
| 9 | DSH 按 agent 隐藏工具的确切机制（子 agent preset 如何排除操作层工具） | D16（B16） |
| 10 | ~~族 3 把 12 个文件拍平到单一命名空间后是否撞名~~ → **✅ 已验证无撞名**（`dotnet build` 0 error / 0 warning，37 个顶层类型无重名） | D17 |
