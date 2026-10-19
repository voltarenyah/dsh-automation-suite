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
- 路径规则（workspace 里放什么、怎么放）成为工程上下文插件的**交付物**，见
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

## D10 · 各插件之间先各自独立，不抽共享包 ✅

**决定**：公共类型、协议、作用域标识**暂不**抽 core 包，各插件独立，靠文件契约对接。
出现第三处重复时再抽。

---

## D11 · 先做深 TIA；之后按 Rockwell 排，其他暂无计划 ✅

**决定**：除 TIA 外**只规划 Rockwell**，其他厂商（Beckhoff / 三菱…）**暂无计划**。
跨厂商统一中间表示（IR）**暂不做**，先把 TIA 一家做深。

---

## D12 · 工程上下文插件：作用域锚定宿主 workspace，状态落 workspace 内 ✅

**背景**：工程上下文插件进入设计（产出：[`packages/dsh-engineering-context/docs/ARCHITECTURE.md`](../packages/dsh-engineering-context/docs/ARCHITECTURE.md)）。
设计前核对了运行中的宿主，发现 **D5 的 workspace 模型在宿主里已经存在**：
服务 `ctx.workspaceRegistry`（`@deepseek-ai/dsh-workspace`），
而会话归属判定 = session 的 `header.cwd` 归一后**等于** workspace 路径
（`dsh-workspace/lib/index.js:122`；服务注册见 `:374`），工具调用期可读到该 cwd
（`dsh-tools/lib/index.js:1423`）。

**决定**（三条，细节与该包的编号决策见其 `docs/decisions.md` D1–D14）：

1. **作用域锚定宿主的 workspace，不自建**：作用域根 = `exec.agent.session.header.cwd`；
   宿主身份用 `ctx.workspaceRegistry.resolveByPath()` 认领；**只读**注册表 ——
   从不 `create` / `attachSession` / `archiveSession`（建 workspace 是用户在 GUI 的显式动作）。
   ⇒ **D5 不需要这个插件实现一遍**，"不串味"由"每次调用从 cwd 重新解析 + 路径包含性校验"结构性保证。
2. **状态落 workspace 内**：`<workspace>/_dsh-eng/`（工程注册表、**指纹基线**、变更集、变更台账），
   可携带、可进 git；宿主 `ctx.storageDomain` 只承担**可再生**的作用域指针。
   `ctx.spillStore` 因按会话归属且工件会过期，**不用于基线**。
3. **与接口插件族的接缝 = 服务，不抽包**：接口插件族注册一个可选的 cordis `Service`
   （只读能力：状态 / 开关项目 / 列对象含指纹 / 导出），工程上下文插件可选注入，缺席时降级读旧工件并**报过期**。
   与 **D10**（先各自独立、不抽共享包）不冲突 —— 这是**服务契约**，不是共享包；
   且它不经过接口插件族的工具面，所以 **A15** 怎么定都不影响这条路径。

**随设计一并定的两条口径**：变更键**只用 TIA 指纹**，manifest 的 `sha256` 只作完整性审计
（它含 `<DocumentInfo><Created>`，每次导出都变，见
[`MANIFEST-GAP-ANALYSIS.md`](../packages/dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md) §3）；
对象身份键在 `tiaObjectId` 拿到之前走"复合键 + `rename-candidate`"降级路径，
并在结果里**显式标记**"身份按名字推断"（身份键错会让跨版本关联**静默断链**，见 D7）。

**后果**：

- 落地位置定为 `packages/dsh-engineering-context`；
- 新增两个**接口插件族侧**的工作项：注册该服务；补 `tiaObjectId`（后者仍待实测）；
- 开放问题 **A8 / B7 / B8 / B9** 已答（见 [`open-questions.md`](open-questions.md)）；
- 状态同步：[`roadmap.md`](roadmap.md) §1/§3 与根 [`README.md`](../README.md) §2 两处。

**进展（2026-10-14）**：

- **D12 第 3 条的"缝 A"已落地**：接口插件族注册了 **`engineeringAccess`** 服务
  （`packages/dsh-tia-openness-v17-min/src/access.ts`，该包 `docs/decisions.md` **D20**），
  接口面镜像在工程上下文插件的 `docs/ARCHITECTURE.md` §5.3。**消费代码已落地**：
  工程上下文插件的 `create_engineering_project` 就是这条缝的第一个（也是目前唯一）消费者 ——
  D21 交付的三个方法（另存 / 读会话 / 重建源）由此第一次连成一条可审阅的编排。
- **实现进度（2026-10 更新）**：工程上下文插件原先的 P0（作用域 + 工程注册表）与
  P1（内部 git 版本层、4 个工具）**已删除**（该包 **D22**）：注册表全仓没有第二个消费者，
  版本层用用户自己的 git 就能替代。现在它只有 **1 个工具**（`create_engineering_project`），
  布局是 `<workspace>/tia/` + `<workspace>/source/<device>/`（无项目名层）；
  本包 37 项单测全通过。`.ap17` 仍由 `.gitignore` 的 `tia/` 一行挡在库外，规则由新工具维护。
- **指纹可得性**：**用户报告已在另一个代码库验证可用**（用户侧证据，**不是本仓实测**）——
  本仓第一次在 V17 真机跑 P2 时仍需留下证据（见待办清单第 1 条）。
- **一处实测更正**：控制器的 `max_items` 只能截断、**没有 offset**，所以"按片翻页"不可行
  （工程上下文插件 `docs/decisions.md` **P0-15**）；这条同时更正了 `docs/tool-surface.md` §5.1 的措辞。

---

## D13 · 图谱分区与更新（工程知识图谱插件的数据模型）🟡

**背景**：[A10](open-questions.md) 问"图怎么分区、怎么更新"；图底座已由 **D8** 定为 SQLite + Graph DB。

**决定**（三条，答复原文见 [`open-questions.md`](open-questions.md) A10）：

1. **分区 = 一个 workspace 下每个 PLC device 一张图**；**一个 workspace 下的多个分支暂不考虑**
   —— 不为分支建多份图。
2. **更新 = 初次全量重建，之后增量更新。**
3. **变更键 = 每个块各自的 TIA fingerprint**；**没有 fingerprint 的对象用 contentHash 兜底**
   （D6 已记：标签表没有指纹）。

**后果**：

- **全量重建保持离线**：它只读 `projects/<id>/export/`，符合 D6"离线能力留给图谱层"。
  **但增量路径需要开项目** —— 指纹来自 Openness（D6），与工程上下文插件的工作循环
  （[`roadmap.md`](roadmap.md) §3 第 8 项）是**同一条依赖**，不是工程知识图谱插件自己能满足的。
- ⚠️ **contentHash 兜底必须归一化**（先剥掉 `<DocumentInfo>` / `<Created>`），否则标签表
  每次重新导出都会被判为"变了"。**D6 / D12 已经因为同一理由拒绝把 manifest 的 `sha256`
  当变更键**，依据见 [`MANIFEST-GAP-ANALYSIS.md`](../packages/dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md) §3。
- ⚠️ **"用 fingerprint 区分块有没有变"本来就是工程上下文插件的职责**（D6 + 工程上下文插件 P2 的指纹基线
  `_dsh-eng/<id>/fingerprints.json`）。所以工程知识图谱插件有两条落地路径：**① 消费工程上下文插件的变更集**
  （默认 —— 避免两处各自算指纹导致口径漂移）／**② 自己经接口插件族的 `engineeringAccess` 服务取指纹**
  （工程上下文插件缺席时的降级）。**这一条仍需拍板**，见文末待办清单。
- **db 的具体路径仍未定**：它是工程知识图谱插件的状态，**倾向** `_dsh-eng/<project-id>/` —— 因为
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

## D16 · 图谱能力的暴露形态（B16）✅

**背景**：[B16](open-questions.md) 问图谱能力是走工具族、随包索引文件，还是 skill 资源。

**决定**：

1. **图谱工具走工具面暴露，不用 skill 交付** —— 用户理由：skill 是静态文件，
   可能不按需、不最新；工具读的是活数据。
2. **面向"回答特定工程问题"的子 agent 必须能看到图谱工具**，而**操作层面的工具在那个子 agent 里隐藏**。
3. **先把工具暴露出来**（先可用，收口后置）。

**后果**：

- **`get_schema` 类能力保留为工具**（返回活的 DDL / 词表），**不做成 bundled skill**。
  这与接口插件族的 skill 形态（`packages/dsh-tia-openness-v17-min/src/skills.ts` / **D4**）**不冲突** ——
  那一条服务的是**静态手册知识**，两者载体不同。
- **子 agent 的 preset 已落地**（**D23**）：`expert` 拿图谱工具、拿不到操作层工具。
  按根 [`AGENTS.md`](../AGENTS.md) §1，preset 必须**整份重述** `config.plugins` ——
  漏写会让该 agent 的工具**静默消失**（不报错）。
- **工具目录成本不再由主 agent 承担**，所以 B16 **不再需要**"工作流层 / 原子层两层收口"
  来省常驻字符。但 `query`（任意只读 SQL）**是否进子 agent 面仍是独立取舍** —— 见
  [`architecture.md`](architecture.md) §6「不向模型暴露任意代码执行」。
  本轮的决定：**进**（`expert` 有 `knowledge_query`）；它只读，写不了任何东西，
  而"不暴露任意代码执行"约束的是**任意代码**，不是参数化查询。
- **"按 agent 隐藏工具"的机制已查实并落地**（见 **D23** 与待验证清单 #9）。

---

## D17 · 工程知识图谱插件的包名与 C# 命名照接口插件族的规则 🟡

**背景**：工程知识图谱插件开工前定包名与 C# 工程命名。第一次 vendoring 时**沿用了来源库的
`Mcp.Knowledge.*` 命名空间**，理由是"最小偏离、便于与来源库 re-sync"——**该理由被否决**，
要求按**本仓既有风格**取名。

**旁证（支持这条否决）**：移植物中最大的那个文件的**来源头注释自己就写明放弃了 re-sync 约束** ——
`Parsing/ProgramBlockLogicYamlWriter.cs` 原文 "mcp-knowledge is now the home of this translator;
**the re-sync constraint is dropped** and the two copies may diverge"。
所以"保留原命名空间以便 diff"对它本就不成立。

**决定**：

1. **包名** `@voltarenyah/dsh-engineering-graph`（与工程上下文插件的 `@voltarenyah/dsh-engineering-context` 平行）。
2. **C# 目录** `engine/`，项目文件 `EngineeringGraph.Engine.csproj`。
3. **`AssemblyName` = `RootNamespace` = `EngineeringGraph.Engine`** —— 规则同接口插件族的
   `<产品 PascalCase>.<角色>`：产品取自包名去掉 `dsh-` 前缀，角色取自目录名
   （该族当前成员 = 包 `dsh-tia-openness-v17-min` + 目录 `controller/` → `TiaOpennessV17Min.Controller`，
   见其 `.csproj` 的 `AssemblyName` / `RootNamespace`）。
4. **12 个 vendored `.cs` 全部拍平为单一命名空间 `EngineeringGraph.Engine`** ——
   照接口插件族的**实际做法**（该族当前成员的 14 个 `.cs` 共用一个扁平命名空间，**不按子目录再分子命名空间**）。
   改名后的文件用**文件级** `namespace EngineeringGraph.Engine;`
   （net8 + `LangVersion latest` 允许；该族当前成员因 `LangVersion 7.3` 只能用块级）。
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

1. 接口插件族的稳定对象 id 待办（本会话写的 `roadmap.md` §2）被上一会话的提交 `b69ae24` 连带带入；
2. 工程上下文插件的 P1 状态同步（上一会话写的 `README.md` 多处 + `roadmap.md` §1/§3）留在工作树未提交，
   最后由本会话的 `2c1dc1e` 带入 —— 其中 README 的"对话"行由**两边共同改动**
   （先 `38 → 41`，再 `41 → 42`），是**同一个 hunk**，无法干净拆分。

**决定（约定）**：

- **能拆就拆**：按 **hunk** 切分提交。本会话的做法是 `git diff -U3` 取全文，
  按 `@@ -<起始行>` 把对方的 hunk 单独写成补丁，再 `git apply --cached` 只暂存那一份
  （实例：`5dc2c26` 只含工程上下文插件的三处 hunk，本会话的内容留在后续提交）。
  注意 `-U0` 的补丁需要 `git apply --unidiff-zero`，用默认 `-U3` 更省事。
- **拆不开就在提交信息里写明**：同一个 hunk 被两边共同改动时，接受混在一个提交里，
  但**必须**在提交信息里指出哪部分不是本会话写的（实例：`2c1dc1e` 的 `ATTRIBUTION` 段）。
- **不因归属问题阻塞**：文档状态与代码不一致本身就是缺陷（根 `AGENTS.md` §1 要求
  `roadmap.md` 与 `README.md` §2 同步），宁可带着说明提交，也不要让**正确的状态**留在工作树里。
- 提交一律**本地**，不 `push`。

---

## D19 · 工程知识图谱插件的引擎协议、操作与工具命名 ✅

**背景**：工程知识图谱插件的引擎（vendored `Graph`/`Parsing`/`Import`）能解析、能建库，但**没有任何操作入口**，
所以插件一个工具都注册不了。这一步把入口打通，并把"协议长什么样"固定下来。

**决定**：

1. **协议照接口插件族的 NDJSON 帧模型**（`packages/dsh-tia-openness-v17-min/controller/Protocol.cs`）：
   一行一个 JSON 对象；`ready` 帧宣告就绪并列出操作目录，每个请求恰好一个 `result` 帧，
   中间可有 `progress` 帧；请求形如 `{id, type:"operation", operation, params}`。
   **操作目录是安全边界**，不在此列的名字一律 `unsupported_operation`。
   两处**刻意偏离**：net8 直接用 `System.Text.Json`（接口插件族因 net48 无依赖才手写）；
   错误对象在接口插件族的 `code`/`message`/`details` 之外**保留来源库的 `remediation`** ——
   是超集，不丢信息，两个消费端都能渲染。
2. **引擎四个模式**：无参 = stdio 服务；`--call <Op> [json]` 一次性执行并打印结果帧
   （人工排障与不走 TS 的端到端验证）；`--self-test [exportRoot]`；`--version` / `--help`。
   stdout **只承载帧**，一切人类可读说明走 stderr。
3. **本切片只有三个操作**：`GetSchema` / `Ingest` / `Query`。
   SQL 与只读校验**逐函数**从来源库的工具层搬来、语句未改（来源行号记在各函数注释里）。
   **`status` 刻意不做**：来源库里根本没有这个操作，新鲜度逻辑住在消费端应用里 ——
   它属于 D13 的第 4 步（freshness），本切片不凭空造一个。
4. **工具名带 `knowledge_` 前缀**：`knowledge_schema` / `knowledge_ingest` / `knowledge_query`。
   裸名 `query` 在共享会话里太泛，将来必然与别的插件撞。`knowledge_query` 是唯一的
   "逃生舱"（任意只读 SQL），按 **D16** 先暴露、收口后置。
5. **工具返回本仓的 canonical envelope**（`ok` / `operation` / `summary` / `data` /
   `changes` / `diagnostics` / `error` / `durationMs`，见接口插件族 `docs/OUTPUT-CONTRACT.md` §1），
   而不是直接把引擎的错误对象交给模型。**只有传输层失败**（找不到可执行文件、超时、
   进程中途死亡、协议不匹配）才抛；操作失败一律 `ok:false` + `error.code`。

**临时口径（待 D13 落地时替换）**：`Ingest` 的 `dbPath` 缺省为
`<exportRoot>/plc-knowledge.db`（照搬来源库）。这是**过渡值**：D13 已定"每个 PLC device 一张图"，
但 db 的具体位置仍未定（见待办清单第 6 条），定下来后要改这里并回写 `PATH-RULES.md` §2/§8。

**验证（2026-10-15）**：`dotnet build` 0 warning / 0 error；`--self-test` 覆盖四项 ——
原生 SQLite 往返、真实导出物 crawl（7/7、72 节点 / 153 边）、
**经真实分发的 `Ingest` → `Query`**（查询出 15 种节点种类）、以及**只读闸门拒绝 `DROP`**（`QUERY_REJECTED`）。
stdio 通道实测：`ready` 帧列出三个操作，`GetSchema` 返回 34 字节十六进制版本哈希，
`Ingest` 产出 3 条 `progress` 帧后 276 ms 返回，四条错误路径
（`DB_PATH_REQUIRED` / `unsupported_operation` / `unsupported_frame` / `bad_request`）都按契约返回。

---

## D20 · 图谱数据库的位置与命名 ✅

**背景**：族 3 的库落在哪里、叫什么，工作流与 `knowledge_ingest` 必须一致 —— 否则建出来的库没人知道在哪。

**决定**：**`<项目根>/knowledge/<设备名>/<设备名>_knowledge.db`**。

- `knowledge/` 与 `source/` **同级**；一台设备一个文件夹，装它自己的**全部**生成物；
- `knowledge_ingest` 的 `device_dir` 指向 `<项目根>/source/<设备>`，路径由设备目录**往上两级**推出，
  所以与工作区叫什么无关；显式传 `db_path` 时以传入为准；
- **`*.db` 不进 git**（包内 `.gitignore` 已含 `*.db` / `*.db-wal` / `*.db-shm` / `*.db-journal`）。
  ✅ 工作区自己的 `.gitignore`（写 `tia/` 的那一处）**已加上 `knowledge/**/*.db*`** ——
  它是族 2 的写入范围，随族 2 **D25** 的接入一起做。尾随的 `*` 是刻意的：它把 SQLite 自己的
  旁挂文件（`-wal` / `-shm` / `-journal`，建库被超时杀掉时会留下）一起挡住 —— 只忽略数据库文件，
  不忽略整个 `knowledge/`，因为目录里将来的文本产物与 `source/` 有同样的入库理由。

**验证**：临时树实测 `…/source/Sino_PEI` → `…/knowledge/Sino_PEI/Sino_PEI_knowledge.db`，返回 `device=Sino_PEI`；
真实工程 `source/Sino_PEI` **1376 个源文件全部入库**（29.5 s），**117,922 节点 / 287,620 边**，库 **450 MB**。

---

## D21 · 族 3 暴露 `knowledgeGraph` 服务（族 2 的接缝）✅

**背景**：目标是让 ingest 嵌进 `create_engineering_project` 工作流。只提供工具的话，就得指望模型
"记得"导出后再调一次 —— 不确定、可能漏。

**决定**：族 3 注册一个 cordis `Service`，**名字是字符串 `knowledgeGraph`**，消费方用 `ctx.get` 查找、
**不 import**（D10：插件各自独立，靠字符串 + 契约对接）。形状与族 1 的 `engineeringAccess` 完全同构。

- **构造即注册**：`new KnowledgeGraph(ctx, …)` 内部走 `ctx.reflect.provide`，注册归该插件的 fiber，
  卸载即消失（在 `apply` 里构造）。
- **接口**：`status()`（引擎可用性 + 那个路径约定）与
  `ingestDevice(deviceDir, { dbPath?, signal?, onProgress? })`。
- **与工具走同一条转换**（`outcomeOf`），所以服务与 `knowledge_ingest` 不可能在默认值或错误形状上分歧。
- **操作失败是数据，传输失败才抛**：缺目录 / 清单读不了 → `ok:false` + `error.code`；找不到引擎、超时 → 抛。

**族 2 侧（✅ 已接入，见族 2 的 [`docs/decisions.md` D25](../packages/dsh-engineering-context/docs/decisions.md)）**：
`ctx.get('knowledgeGraph')`，缺席即降级并报"图谱未建成"；`create_engineering_project` 写完源树后按族 1
`rebuildSource` 返回的 `devices[].directory` **逐设备**调用，那个目录就是 `device_dir`
（不自己拼路径，也**不传 `dbPath`**，因为库的位置是本服务自己的约定）。这一步是**软的**：
服务缺席 / 引擎未构建 / 引擎不可达都只报"图谱未建成"，工作流照常成功；`ok:false` 逐设备带上
`error.code` 与 `error.details.remediation`，`data.warnings[]`（含清单 `failures[]`）转成工作流诊断。
它是**全量重建**、没有新鲜度/增量，所以"每次导出后调一次"是唯一的刷新方式
（实测 1376 个源文件约 30 s、库约 450 MB —— 那一次的服务调用就把库建好了）。

**验证**：`test/09-service-and-manifest.test.mjs` 断言服务在预期名字下注册、缺目录是**编码失败而非抛异常**、
以及 **D24 清单树经服务入库**（`source=manifest`、id 无类别前缀、`folderPath` 是干净组路径、
跨组 `CALLS` 指向真身、清单 `failures[]` 进 warnings、db 落在 D20 约定的位置）。
该文件同时是**清单模式的第一个自动化回归测试** —— 在此之前所有测试都只走 crawl 兜底（扁平 fixtures），
清单路径只有手工证据，这正是上一轮"跨组调用落到占位符"能藏住的原因。
**族 2 侧的接入**由 `packages/dsh-engineering-context/test/02-create-project.test.mjs`（工具级）与
`test/04-knowledge-graph.test.mjs`（缝 B 级）的 19 项新用例覆盖（顺序、`device_dir`、省略 `dbPath`、
四种降级、`ok:false` 的 code/remediation、清单 warning 上限、取消重抛）。

---

## D23 · 两层 agent：`leader` 主 agent + `expert` 子 agent，工程工具按 preset 分发 ✅

**背景**：[B16](open-questions.md) 答复里提出"回答特定工程问题的 agent 会启用子 agent，
其中隐藏一些操作层面的工具，但图谱工具要暴露给子 agent"。D16 记下了这个意图，但把
"DSH 按 agent 隐藏工具的确切机制"列为**待验证**（[待验证清单](#待办验证清单由以上决策派生) #9）。
本轮把机制查实并落地。

**机制（实测 + 读宿主源码，`@deepseek-ai/*` 0.2.1-rc.2）**

工具可见性由 `dsh-tools` 的 `view(scope)` 解析：**继承面 = 全局层 + 作用域链上的每个祖先层
（不含"自己这一层"）**，逐层过 `admits`（即 `tools.restrict({allow|deny})` 铺的掩码）后才可见。
三个后果：

1. **preset 里"不写" ≠ 隐藏**。宿主面（profile 顶层行）注册的工具落在**全局层**，
   每个 preset 的 agent 都会继承 —— 包括子 agent。实测：改造前父子工具面**完全相同**（各 32 个）。
2. 上游就是这个形态：`dsh-web-app/cordis.patch.yml` 把宿主面所有工具行 `disabled: true`
   （含 `tool-subagent*`/`tool-todo`/`tool-web`），注释写明"what a preset chooses is which
   delegation TOOLS its agent sees"。
3. 模型面工具**不接受内联过滤**：`@deepseek-ai/dsh-tool-subagent` 的配置里写 `persona`/`toolFilter`
   会直接报迁移错误，要求"configure persona and tool plugins in an Agent Preset"。

**决定**

1. **方案 A：把模型面工具注册拆成独立 Loader 行**（`/<pkg>/tools` 子路径导出），
   宿主行只留**资源与服务**：
   - `dsh-tia-openness-v17-min`：宿主行 = TIA 控制器子进程 + `engineeringAccess` + 随包 skill；
     `/tools` 行 = 26 个工具。
   - `dsh-engineering-graph`：宿主行 = C# 引擎子进程 + `knowledgeGraph`；`/tools` 行 = 3 个工具，
     带 `includeIngest` 开关（`false` 时只给 `knowledge_schema` / `knowledge_query`）。
   - `dsh-engineering-context`：**没有宿主面资源**，所以不拆包，只把它的行整个搬进 `leader`，
     宿主面那份 `disabled: true`。
2. **两个 preset**：`leader`（主 agent，内置 `standard` 的全部 + 上述三个工程工具行 + 派发政策）
   与 `expert`（子 agent）。preset id 由 `suite` 改名为 `leader`。
3. **`expert` 的工具面刻意极小**：图谱 `schema`/`query`（`includeIngest: false`）、
   `read`/`read_image`/`glob`/`grep`（`tool-fs` 配 `write: false`/`edit: false`）、
   `send_message`/`interrupt_agent`、`time-context`、`compaction` —— **8 个**。
   **不给**：任何 TIA 工具、工程上下文工作流、`pwsh`、`jobs`、`schedule`、`goal`、`plan`、
   `web`、`todo`、`ask_user`、`skill`。
   **仍会继承**宿主面仍是全局行的 13 个：`dsh-tool-git` 的 12 个 + `working_directory`
   （上游本来就把 `dsh-tool-working-directory` 留在宿主面）。已知欠账，不是遗漏。
4. **接线**：`tool-subagent` 行配 `agentPreset: expert` + `allowedAgentPresets: [expert]`；
   深度沿用宿主设置 `subagent.maxDepth`（默认 1，`expert` 不能再派孙代）。
5. **`knowledge_ingest` 不给子 agent**（用户决定）：整库重建是重度写操作（实测 1376 个源文件约 30 s、
   库约 450 MB），属于主 agent 的建工程流程。
6. **git 的 12 个工具本轮不拆**（用户决定）：`dsh-tool-git` 是 vendor 副本，拆 `/tools` 会成为
   **第 5 处与上游的差异**（现有 4 处见该包 `AGENTS.md` §1/§5），而它只是卫生问题。
   ⇒ **已知欠账：`expert` 也看得到 git 的 12 个工具。**

**后果与必须知道的事**

- **工程工具按 preset 分发**：切到没声明这些行的内置 preset（`standard`/`minimal`/…）时，
  TIA、工程上下文、图谱工具**不存在**。这是有意的，不是故障。
- **"子 agent 只读"只由工具面保证，不要指望沙箱**：子 agent 继承父会话的**显式**沙箱覆盖
  （本 profile 默认 `danger-full-access` 会原样继承），而审批策略被宿主钉死 `never`
  （`dsh-subagent` 的 `captureDelegatedPolicyOverrides`）——需要审批的操作自动拒绝、不弹给用户。
- **preset id 是稳定标识**：`suite` → `leader` 这次改名会让记录着旧 id 的会话、
  以及独立选过 preset 的子会话**无法恢复**（宿主明确"缺失/损坏的 preset 拒绝恢复、不回退"）。
- **维护成本**：`preset-leader` 必须整份重述上游 `standard` 的插件清单，升级宿主后要按
  [profile 蓝图 README](../profile/dsh-automation-suite/README.md) 重新生成；`preset-expert`
  只需核对它引用的包名。preset 清单从一份变两份。
- **用户插话的通道**：宿主不把子会话放进左侧会话列表（"The ordinary sidebar omits subagent
  conversations"），入口是父会话 header 的后代树 → 主区或**右侧栏分栏**；continuable 子会话有
  完整 composer，追问会回流给主 agent（源码依据：`subagents/prompt` 置 `announced`，
  结算通知的条件就是 `announced`；**端到端未实测**）。
- **行数基线会变**：`--dump-config` 的三个数要重测，见根 `AGENTS.md` §4。

**验证**（2026-10-19，本机）：

1. **真实解析器算出的工具面** —— 用真实的 `@deepseek-ai/dsh-tools` `ToolRuntime` + 真实的
   `@deepseek-ai/dsh-scope` 作用域链（`createScope` 建 preset 层、再建 agent 层，宿主面工具注册在
   global 层），工具名取自两个包**构建后的** `registerTools`（不是手抄）：
   - `expert` 可见 **21 个** = global 13（git 12 + `working_directory`）+ preset 8，逐项相等 ——
     **没有** 任何一个 TIA 工具、**没有** `knowledge_ingest`、**没有** `create_engineering_project`。
   - `leader` 可见 **43 个** = global 13 + 工程 30（TIA 26 + `create_engineering_project` + 图谱 3），
     26 个 TIA 工具全在。
2. **组合与解析**：`--dump-config` exit 0（1520 行；`default: leader`、两个 preset 行、
   宿主 `engineering-context` 带 `disabled: true`）；在**物化 profile 目录**里逐个 `import()`
   这 8 行，`name` / `inject` / `Config(...)` 全部按蓝图实参解析（含 `includeIngest:false`
   与 `write:false, edit:false`）。
3. **交付物**：两个包的 `pnpm pack` 产物都含 `lib/tools-entry.js`、`lib/runtime-service.js`
   与 `exports["./tools"]`（`-Mode pack` 那条验收链走得通）。
4. **实例**：`start-env.ps1` 起得来，`TiaOpennessV17Min.Controller` 子进程在（宿主行 apply 成功），
   启动日志无 preset 挂载报错。
5. **真实模型驱动的一次派发（2026-10-19，实测）**：在 `dsh-suite-env` 的 3092 实例里让 `leader`
   派发 `expert`，子 agent 自报的工具名**逐项等于**上面第 1 条算出的 21 个
   （git 12 + `working_directory` + `knowledge_schema`/`knowledge_query`/`read`/`read_image`/
   `glob`/`grep`/`send_message`/`interrupt_agent`），**没有**任何 TIA 工具、**没有**
   `knowledge_ingest`、**没有** `create_engineering_project`。
   会话头部出现"1 subagent"目录触发器，子会话标记为 **continuable**（带 token 数与耗时）；
   对**已结束**的子 agent 用 `send_message` 追问，宿主先回 `Message delivered to <id>`，
   随后子 agent 的结算通知作为新消息回到父会话 —— 续聊与回流都成立。
6. **暴露出来的两个真问题**（都在 live 跑第一次时炸出来，已修/已记）：
   - persona 里的 `{{cwd}}` **不是注册变量**，导致整轮失败
     （`unknown prompt variable "{{cwd}}" ... registered variables: provider, model`）。
     全局与两个 preset 的 persona 已改掉；机理记在根 `AGENTS.md` §1 第 5 条。
     这条**在本轮之前就存在**：`{{cwd}}` 是照抄来的，旧 `preset-suite` 同样会炸。
   - 子 agent 对"你有没有 TIA 或 git 写工具"答 **yes** —— 因为 git 的 12 个里含
     `git_commit`/`git_stage`/`git_checkout`/`git_stash`。**只读靠工具面保证这句话，
     目前对 git 不成立**。要么把 `dsh-tool-git` 也拆成 `/tools` 行（第 5 处 vendor 偏离），
     要么接受"expert 能改 git"。

---


## 待办验证清单（由以上决策派生）

| # | 待验证 | 来源 |
|---|---|---|
| 1 | V17 上 `FingerprintProvider` 的可得性与粒度 | D6 —— 🟡 **用户报告已在另一个代码库验证可用**（用户侧证据，不是本仓实测）；本仓首次真机跑 P2 时仍需留证据 |
| 2 | 导出物里的 id 在改名/编辑/重导/另存后的稳定性 | D7 |
| 3 | 以 min 为依赖被 std 复用时，插件行与控制器生命周期是否干净（一次会话） | D2 |
| 4 | ~~workspace 路径规则的字段级定义~~ → **已按 D22 重写**：[`packages/dsh-engineering-context/docs/PATH-RULES.md`](../packages/dsh-engineering-context/docs/PATH-RULES.md)（现行布局 `tia/` + `source/`；其 §10 是"已废止"清单） | D5 → B7 |
| 5 | ~~接口插件族的服务缝（服务名与接口面）~~ → **✅ 已定、已实现、已有消费者**：`engineeringAccess`（接口插件族 `src/access.ts` / 该包 D20），消费方是工程上下文插件的 `create_engineering_project`。**剩**：P2 的指纹消费仍未做 | D12 |
| 6 | 图谱 db 的具体路径（倾向 `_dsh-eng/<project-id>/`）+ 回写 `PATH-RULES.md` §2/§8 —— ⚠️ **需重新定**：`_dsh-eng/` 注册表层随 D22 删除，P2/P3 的状态路径待定 | D13（A10） |
| 7 | contentHash 兜底必须归一化（剥 `<DocumentInfo>`/`<Created>`）才可用作变更键 | D13 |
| 8 | 工程知识图谱插件取指纹的路径：消费工程上下文插件的变更集（默认）还是自己经接口插件族 `engineeringAccess` 服务 | D13（A10） |
| 9 | ~~DSH 按 agent 隐藏工具的确切机制（子 agent preset 如何排除操作层工具）~~ → **✅ 已查实并落地**：工具可见性 = 全局层 + 祖先层逐层过 `admits`；方案 A 拆 `/tools` 行 + 两个 preset，见 **D23** | D16（B16） |
| 10 | ~~工程知识图谱插件把 12 个文件拍平到单一命名空间后是否撞名~~ → **✅ 已验证无撞名**（`dotnet build` 0 error / 0 warning，37 个顶层类型无重名） | D17 |
