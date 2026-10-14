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

**后果**：**无需用户额外部署服务**；下面的问题随之收窄 ——
分区/更新策略（A10）与 PLC 语法翻译深度（A11）仍待定，见 [`open-questions.md`](open-questions.md)。

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

- 落地位置定为 `packages/dsh-engineering-context`；**蓝图登记与 `package.json` 留到实现开始时再加**
  （理由：蓝图 `dsh.profile.bundles` 多一个名字，`scripts/start-env.ps1` 就会去链一个不存在的包，
  会让"启动 App"直接失败 —— 见该包 `docs/decisions.md` N1）；
- 新增两个**族 1 侧**的工作项：注册该服务；补 `tiaObjectId`（后者仍待实测）；
- 开放问题 **A8 / B7 / B8 / B9** 已答（见 [`open-questions.md`](open-questions.md)）；
- 状态同步：[`roadmap.md`](roadmap.md) §1/§3 与根 [`README.md`](../README.md) §2 均记为
  "实现未开始（设计已定稿）"。

---

## 待办验证清单（由以上决策派生）

| # | 待验证 | 来源 |
|---|---|---|
| 1 | V17 上 `FingerprintProvider` 的可得性与粒度 | D6 |
| 2 | 导出物里的 id 在改名/编辑/重导/另存后的稳定性 | D7 |
| 3 | 以 min 为依赖被 std 复用时，插件行与控制器生命周期是否干净（一次会话） | D2 |
| 4 | ~~workspace 路径规则的字段级定义~~ → **已定稿**：[`packages/dsh-engineering-context/docs/PATH-RULES.md`](../packages/dsh-engineering-context/docs/PATH-RULES.md) §8（其 §10 三项待确认） | D5 → B7 |
| 5 | 族 1 的服务缝（服务名与接口面）与族 2 跑通一次 | D12 |
