# 决策记录（`dsh-engineering-context`）

> 本文件记录**本插件自己的技术取舍**：为什么这么定、连带约束是什么、哪一条还等着验证。
> 发行版级的取舍在 [`docs/decisions.md`](../../../docs/decisions.md)；尚未决定的问题在
> [`docs/open-questions.md`](../../../docs/open-questions.md)。核心架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，
> 路径规则见 [`PATH-RULES.md`](PATH-RULES.md)。
>
> 状态图例：✅ 已定 ｜ 🟡 已定但有待验证项 ｜ ⏳ 有条件（条件满足即生效）
>
> ⚠️ **2026-10 起：本文的 P0 / P1 条目是历史记录。** D22 删除了 4 个工具
> （`eng_status` / `eng_project` / `eng_scope` / `eng_version`）与它们下面的两层
> （`_dsh-eng/projects.json` 注册表、内部 git 版本层），现行布局是 `tia/` + `source/`，
> 模型面只有 `create_engineering_project`。凡涉及那 4 个工具、注册表、`current` 指针、
> 内部 git、`projects/<id>/…` 路径的条目**均已失效**；现行口径以
> [`PATH-RULES.md`](PATH-RULES.md) 与 **D22** 为准。

---

## D1 · 作用域锚定在宿主的 workspace 上，不自建第二套 ✅

**背景**：D5 规定"session 绑定 workspace，workspace 是工程作用域的一级概念"。
按直觉实现会去写一套"建 workspace / 分组 session"的机制。

**决定**：**不写。** 宿主已经提供了它，且判定规则与本插件需要的完全一致：

- 服务 `ctx.workspaceRegistry`（`@deepseek-ai/dsh-workspace`，注册见 `dsh-workspace/lib/index.js:374`）；
- 路径查询 `resolveByPath(path)`（`:635-638`）；
- 会话归属判定 = session 的 `header.cwd` 归一后**等于** workspace 路径（`:122`）；
- 工具调用期读得到 cwd：`exec.agent.session.header.cwd`（`dsh-tools/lib/index.js:1423`）。

所以本插件的作用域根就是 **`exec.agent.session.header.cwd`**，宿主身份用 `resolveByPath` 认领。

**后果**：
- 隔离从"约定"变成**结构性**的：每次调用都从 cwd 重新解析 + 路径包含性校验（`PATH-RULES.md` §4）；
- 本插件**不定义 workspace**，只定义它里面的布局（`PATH-RULES.md`）；
- 若组合里没挂 `dsh-workspace`，`resolveByPath` 不可用 → 退化为 `registered: false`，功能不受阻（N2）。

**证据（非推断）**：`dsh-workspace/lib/index.js:3,122,374,406-410,443-458,635-638`；
`dsh-tools/lib/index.js:1423,3137-3150`。

---

## D2 · 只读宿主的 workspace 注册表，从不修改它 ✅

**决定**：只调 `resolveByPath` / `get` / `list`。
**不调** `create` / `delete` / `insertBefore` / `attachSession` / `detachSession` /
`archiveSession` / `pinSession`。

**理由**：建 workspace 是用户在 GUI 的显式动作（D5「换项目 = 换 workspace，是显式动作而非悄悄漂移」）。
插件一旦能改注册表，"隔离"就变成插件自己说了算，而且会与 GUI 的状态互相打架。

**后果**：用户在 workspace 之外起会话时，本插件只能"以 cwd 为根并标未登记"（N2），不能替他登记。

---

## D3 · 状态落在 workspace 内 `_dsh-eng/`，可携带、可进 git ✅

**背景**：基线（"上次的指纹"）必须先有地方放，才谈得上"变更"（变更检测必须跨会话才有意义）。

**决定**：权威状态放 `<workspace>/_dsh-eng/`，随 workspace 走、进 git、可跨机器比对。
宿主 `ctx.storageDomain` 只承担**可再生**的小状态（作用域指针）。

**被否掉的候选**：

| 候选 | 为什么不选 |
|---|---|
| `ctx.spillStore.saveText()` | 按会话归属、工件由 backend 决定过期（`@deepseek-ai/dsh-spill` README）；只配当**临时工件**，当基线会在某天静默失效 |
| `DSH_HOME` 下按路径哈希分目录 | 不污染工程目录，但**换机器就丢**，变更检测失去跨机器意义（与 [`docs/open-questions.md`](../../../docs/open-questions.md) A14 的倾向相反） |

**后果**：工程目录里会多一个 `_dsh-eng/`（与接口插件族已经在导出目录写 `_tia-openness-manifest.json` 同类）。

---

## D4 · 基线与导出物在同一个 git 仓库里 ✅

**决定**：仓库根 = workspace 根（`git rev-parse --show-toplevel`）；导出物与 `_dsh-eng/` 一起入库；
**`.ap17` 永不进 git**；**不自动 `git init`**（D13）。

**理由**：基线描述的是"导出物在某版本时长什么样"。两者分开版本化，
"这份基线对应哪一版导出物"就无法回答 —— 而**失效可感知**是本插件的验收口径之一。

**代价**：一个 workspace 多工程时，一次提交会跨工程。可接受（workspace 本就是作用域一级概念）；
若将来要每工程独立远端，改这一条即可。

---

## D5 · 【缝 A】接口插件族注册一个可选的 cordis 服务 ✅

**背景**：指纹**必须开项目**才拿得到（D6），而接口插件族的边界是"唯一与工控软件对话的插件"
（[`docs/architecture.md`](../../../docs/architecture.md) §4.2）。所以工程上下文插件必然要向接口插件族要一项**能力**。

**决定**：接口插件族在 `apply()` 里注册一个 cordis `Service`（名字为实现值，例如 `engineeringAccess`），
暴露 §5.3 列出的最小接口面（`status` / `openProject` / `closeProject` / `listObjects` / `exportObjects`）；
工程上下文插件用 `ctx.inject(['…'], …)` **可选**注入，缺席时降级。

**被否掉的候选**：

| 候选 | 为什么不选 |
|---|---|
| 工程上下文插件用 `ctx.tools.execute({name:'list_plc_objects'})` 间接调 | 受接口插件族工具面重构影响（**A15** 要把原子工具默认隐藏）；解析是**按可见性**的（`dsh-tools/lib/index.js:3058`）；还要过 `tools/pre-execute` 闸门 |
| 纯文件契约（只读指纹工件） | "谁触发指纹"变成"模型得记得先让接口插件族跑一次"，退回 [`docs/tool-surface.md`](../../../docs/tool-surface.md) §1 要消灭的模型编排 |

**回报**：这条路径**不经过接口插件族的工具面**，所以 A15 怎么定都不影响它。
**与 D10（不抽共享包）不冲突**：这是服务契约，不是共享包。

**连带工作项（属接口插件族，记录在此以免遗忘）**：注册服务 + 把两个方法接到已有控制器操作上
（`list_plc_objects` 已支持 `include_fingerprints`、`export_blocks` 已支持 `block_names`，
**不需要新的 C# 能力**）。

**待验证**：~~具体服务名与接口面两边同步后跑通一次~~ → **✅ 已落地**：接口插件族侧实现了
`engineeringAccess`（见 `packages/dsh-tia-openness-v17-min/src/access.ts` 与该包的
`docs/decisions.md` **D20**），接口面镜像在本包 [`ARCHITECTURE.md`](ARCHITECTURE.md) §5.3。
工程上下文插件 **尚未调用它** —— 消费代码属于 P2（`eng_changes` / `eng_export`）。

---

## D6 · 变更键只用 TIA 指纹；manifest 的 `sha256` 绝不作变更键 ✅

**决定**：`eng_changes` 的"变没变、改了哪一面"**只**依据 `FingerprintProvider` 的分面指纹（D6）。

**理由（已实验否定，非推断）**：现有 manifest 的 `sha256` 是"写出文件的字节哈希"，
而文件里含 `<DocumentInfo><Created>`（每次导出都不同）——
见 `packages/dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md` §3。
项目内容没变、只要重新导出，哈希就会变。它的正当用途只有"同一份 manifest 内的完整性审计"。

**后果**：变更检测**必须开项目**（"离线判断变没变"不在本方案的路径里，D6 的原文）；
标签表**没有指纹**，所以对标签表的变更检测**能力缺失**，结果里必须显式写"不在覆盖范围内"，
不能让它看起来"没变"。

---

## D7 · 身份键走降级路径；"身份不确定"必须显式标记 🟡

**背景**：D7 规定身份键 = "TIA 导出时提供的唯一 id"，但三项前提都不成立：

| 事实 | 证据 |
|---|---|
| V17 没有 `ObjectIdentifierProvider`（V21+ 才有） | [`docs/decisions.md`](../../../docs/decisions.md) D7；`skills/performance-and-caching/SKILL.md:117` |
| 现有 manifest 没有 `id` 字段 | `packages/dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md` §2 |
| 指纹的 `id` 是**面名**（`Code`/`Comments`/…），不是对象 id | 同仓 `src/tools.ts:1588-1590` |

**决定**：

1. **默认**用 `category + group + name` 复合键，并在结果里标 `identity: "by-name"`；
2. **改名兜底**：同一基线里"消失 A、出现 B"且结构相似 → 产出 `rename-candidate` 进变更台账等人确认；
3. **目标态**：接口插件族在导出物/指纹结果里补 `tiaObjectId`（并实测改名/编辑/重导/另存后的稳定性）。

**理由**：身份键错会让跨版本关联**静默断链**（[`docs/decisions.md`](../../../docs/decisions.md) D7 原话）。
宁可在结果里显式声明"身份按名字推断"，也不要让模型以为这是可靠关联。

**待验证**：`tiaObjectId` 在 V17 上究竟能不能拿到、稳不稳定（文末清单 2）。

---

## D8 · 版本层走内部 `execFile(git)`，不向模型暴露 git 原语 ✅

**决定**：照抄 `packages/dsh-tool-git/src/runner.ts` 的 shell-free 风格（参数数组、
`core.quotepath=false`、`--no-optional-locks`、`GIT_TERMINAL_PROMPT=0` 等），
但**这一层不注册成工具**：调用全在插件代码里，路径来自插件自己解析的 workspace。

**理由**：这正是 [`docs/open-questions.md`](../../../docs/open-questions.md) **A8** 补充分析里的形态 ——
"让 agent 调 git 命令"与"插件内部调 git"是两件事，后者的参数在代码里拼好，模型不参与，
没有"忘带参数、路径给错"的空间。现有 12 个面向模型的 git 工具是**通用**能力，
与 PLC 工程无关，本插件**不依赖模型去调它**。

**边界**：只做本地操作（`commit`/`log`/`show`/`diff`/`materialize`）；
**不 `--force`、不改写历史、不 push**。

---

## D9 · 工具面 7 个，返回契约"摘要 + 工件 + 下钻" ✅

**决定**：7 个**面向工作流**的工具（`eng_status` / `eng_project` / `eng_scope` / `eng_changes` /
`eng_export` / `eng_version` / `eng_context`），每个结果 ≤4KB，批量数据一律落盘成工件，
只给"计数 + 前 N + 工件路径 + 下钻方式"。

**理由**：26 个工具的名字+描述+schema 约 **14k tokens/会话**（[`docs/tool-surface.md`](../../../docs/tool-surface.md) §2.7）；
越过 Pruner 的 8192 字符会被**从中间剪掉**（剪掉的正好是中间那批数据），
越过 12500 tokens 会被 Spill 自动落盘。**与其被框架剪，不如自己给有意义的摘要 + 路径。**

**已知代价（刻意的）**：`eng_version` 用 `action` 枚举，于是"哪些参数必填"在 schema 上表达不完整。
若更看重 schema 精确性，拆成 2–4 个工具即可（+1k 常驻/工具）。

---

## D10 · 不 `import @deepseek-ai/dsh-workspace`，按名取服务 ✅

**决定**：用 `ctx.get('workspaceRegistry')`（先例：`dsh-workspace` 自己就是
`this.ctx.get("sessions")`，`dsh-workspace/lib/index.js:427`），把形状写进本包手写的
`src/dsh-runtime.d.ts`。**不**把它加进 `RUNTIME_ROOTS`、不 import 它的类型。

**理由**：不新增运行时依赖、不与该包版本耦合（宿主升级不会因为一个类型导入而编译失败）；
服务缺席时天然返回 `undefined`，降级路径本来就是必需的（N2）。

---

## D11 · 变更台账落盘 + 工具读写 + 跨会话 ✅

**决定**：台账是 `_dsh-eng/<id>/change-context.json`，由 `eng_context` 读写，
每条 `refs` 必须指回**工程对象 + 版本**。

**与两个既有名词的区别（刻意）**：

| 既有 | 它是什么 | 为什么不能顶替 |
|---|---|---|
| `@deepseek-ai/dsh-tool-todo` | 会话内的 agent 计划清单，单 owner、整表替换 | 台账是**工程对象的变更记录**，跨会话、可指向版本、可进 git |
| `ctx.workspaceChanges`（`dsh-workspace-changes`） | **按轮次、文件级**变更，会话销毁即失效 | 本插件要的是**工程对象级、带基线**的变更 |

---

## D12 · 项目级 skill 走动态 `provider.list()`；保守默认 ✅

**决定**：通用能力文档走随包 skill（D4 三问）；项目级 skill 放 `<workspace>/.dsh/skills/`，
由 provider 的 `list()` **在目录构建时动态枚举**。

**可行性依据（非推断）**：`dsh-skill/lib/index.js:350` 的
`await waitWithAbort(provider.list(options), options.signal)` —— `list()` 是每次目录构建时调用的，
所以运行时枚举一个用户可写目录是支持的。

**保守默认**：只**广告 1 个路由 skill**（会话目录是每个会话都要付的常驻成本，
TIA 包已因此把 31 个上游 skill 收敛为 1 个）；项目级 skill **默认只对本 workspace 生效**，
不自动上升到用户级。

**待你确认**：这等于给 A12 提供了实现依据与一个默认取值；A12 的最终答复仍归你（见 [`docs/open-questions.md`](../../../docs/open-questions.md) A12）。

---

## D13 · 不自动 `git init` ✅

**决定**：`eng_project register` 默认 `init_vcs: false`，需要时显式传 `true`。

**理由**：在用户的目录里凭空建仓库是**难以察觉的副作用**（会改变用户后续所有 git 行为的语义）。
默认安全（fail-closed）的同一思路。

**连带**：仓库根在 workspace **之外**时（workspace 落在用户的大仓库里）仍然工作，
但 `eng_status` 必须**警告**——此时本插件的提交与无关内容共享历史。

---

## D14 · 边界去重：不产出语义、不做文件级变更记录 ✅

**决定**：本插件不解析 XML、不建图（工程知识图谱插件）；不重做宿主的按轮次文件级变更记录
（`dsh-workspace-changes`）；不做 agent 的计划清单（`todo_write`）；不起控制器（接口插件族）。

**理由**：[`docs/architecture.md`](../../../docs/architecture.md) §2 的三条正交轴 —— 作用域 / 语义 / 素材
任意两者都不能互相替代；重复实现会让两个来源对同一件事给出不同答案。

---

## 夜间自主决定（用户不在场时定的，按"最保守 + 可逆"取舍）

> 用户离开时授权："拿不准时用最保守、可逆的方案自己定，把决定和理由记进 docs/decisions.md"。
> 以下每条都是**可逆**的：改回来只需改本文 + 对应文档，无需迁移数据。

| # | 情形 | 取的方案 | 理由 | 怎么改回来 |
|---|---|---|---|---|
| **N1** | 本包要不要同时建 `package.json` 并登记进 profile 蓝图 | **不建、不登记**，只放文档 | 蓝图 `dsh.profile.bundles` 里多一个名字，`scripts/start-env.ps1` 的 `Get-LocalPlugins` 就会去 `packages/` 找它的 `package.json`；找不到会让**"启动 App"直接失败**。文档阶段引入这个副作用不划算 | 实现开始时加 `package.json` + 蓝图两行（`ARCHITECTURE.md` §9 已列全） |
| **N2** | session 的 cwd **不是**已登记的 workspace 时怎么办 | 仍以 cwd 为根工作，但结果里标 `workspace.registered: false` | 两条候选里，"拒绝工作"会让插件在"还没登记 workspace"时完全不可用；"标记未登记"不夸大身份、也不阻塞。且 `initializeDefault` 与启动时的历史引导会让绝大多数 cwd 本来就是已登记的 | 改成拒绝（`requireWorkspace: true` 且 `registered` 必须为 true）只需改一处判断 |
| **N3** | `_dsh-eng/` 放 workspace 根还是每个工程一份（原问题有歧义） | **workspace 根一份**，每个工程一个**子目录**：`_dsh-eng/<project-id>/…` | 兼顾"一份注册表管多个工程"（避免同一 workspace 内多份 `current` 指针互相矛盾）与"按工程隔离"。且与锁定的答案措辞"workspace 内 `_dsh-eng/`"一致 | 移动目录 + 改 `PATH-RULES.md` §2 一处 |
| **N4** | 一个 workspace 一个 git 仓库，还是每工程一个 | **workspace 根一个** | 基线必须与它描述的导出物同版本（D4）；workspace 本就是作用域一级概念 | 改 D4 + `PATH-RULES.md` §6 |
| **N5** | 开放问题里答复哪几条 | 只答 **A8 / B7 / B8 / B9**（本插件设计真正决定得了的） | 其余属于接口插件族（A14–A17 工具面）、工程知识图谱插件（A10–A13）、或纯用户偏好（A12 的最终取值），替用户决定会越权 | 在 `docs/open-questions.md` 里改回去即可 |
| **N6** | 要不要顺手改 `docs/architecture.md` §4.2 的正文 | **不改** | 不在授权清单里。发行版级的目标架构改动应该由你确认后再动；本文只在 `roadmap`/`README`/`decisions`/`open-questions` 落"状态与答复" | 下次要改时按 architecture §4.2 措辞更新 |
| **N7** | 提交策略 | **两个提交**：① 单独提交工作区里**既有的新文件** `docs/tool-surface.md`；② 再提交其余（既有的交叉引用编辑 + 本次全部设计文档）。**都不 push** | 那批调研材料与本次设计作者/意图不同，能分开就分开。但**同一文件内的改动已无法再拆**：我编辑的 `README.md` / `docs/open-questions.md` / `docs/roadmap.md` 本来就带着未提交的交叉引用编辑，所以第二个提交会一并带上，并在提交信息里写明 | `git reset --soft HEAD~2`，或按需 `git revert` |

---

## 待验证 / 待确认（需要人看的部分）

| # | 事项 | 影响 | 谁来收 |
|---|---|---|---|
| 1 | **V17 上 `FingerprintProvider` 的可得性与粒度** | P2 的分面能力；拿不到就只能退到"变没变"（`PlcChecksumProvider`） | **用户报告已在另一代码库验证可用**（2026-10-14）—— 用户侧证据，**不是本仓实测**；本仓首次真机跑 P2 时仍要留证据 |
| 2 | **`tiaObjectId` 能否拿到、改名/重导后是否稳定** | 期望三（跨版本关联）；D7 的降级路径是兜底不是目标 | 需接口插件族补字段 + 实测（发行版级待验证清单第 2 条） |
| 3 | 一次**全项目指纹**的耗时与帧大小（1152 块） | 决定要不要做"指纹缓存 + 只重算可疑对象" | 真机实测 |
| 4 | ~~缝 A 的**服务名与接口面**最终取值~~ | — | ✅ **已定**：`engineeringAccess`（接口插件族 `src/access.ts` + 该包 D20）；镜像见 `ARCHITECTURE.md` §5.3 |
| 5 | `PATH-RULES.md` §10 的三项（git 位置、目录名、`source/` 保留） | 影响交付物形态，不影响 P0 可开工 | 你的判断 |

---

## P0 实现期的决定（实现「作用域 + 工程注册表」时定的）

> 这一节是**实现**阶段追加的，与上面的 D/N 同级：同样按"最保守 + 可逆"取舍，
> 每条都写明理由与回退方式。P0 的交付边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md) §10。

### P0-1 · 构建与测试沿用 TIA 包的形态（`tsc` + `node:test`）✅

**决定**：`build` 就是 `tsc -p tsconfig.json`，测试用 `node --test`；**不引入 `tsdown` / `vitest`**。

**理由**：`dsh-tool-git` 用 tsdown + vitest 是因为它是上游 vendor 副本；本包是原创代码，
TIA 包那套（`tsc` 出 `lib/`，`node:test` 跑真实运行时）已经够用，且**不新增任何工具链依赖**
（根 `node_modules` 里已有 `typescript`，`vitest`/`tsdown` 只在 git 包的 `node_modules` 里）。
连带好处见 P0-3：不需要 `pnpm install` 就能构建与测试。

**回退**：换成 tsdown/vitest 只需改 `package.json` 与加配置文件，源码不动。

### P0-2 · `lib/` 暂不提交 ✅

**决定**：`packages/dsh-engineering-context/.gitignore` 忽略 `lib/`。

**理由**：TIA 包提交 `lib/` 是因为它的 `lib/` **是交付物**（loader 直接 import 它，无需构建步骤）。
本包**还没进蓝图**（N1），没有任何东西会加载 `lib/`，提交构建产物只会让每次 diff 变脏。

**回退**：删掉 `.gitignore` 里那一行、重建并提交，即与 TIA 包一致。

### P0-3 · 不跑 `pnpm install`；lockfile 暂不更新 ⛔ 已被 P0-14 取代

**决定**：声明好 `devDependencies`，但**不在本仓执行 `pnpm install`**；
本地验证靠 `scripts/link-dsh-runtime.mjs` 建**项目内**的链接。

**理由（这是本阶段最要紧的一条）**：本工作树里 `dsh-tia-openness-v17-min` 与 `dsh-tool-git`
的 `node_modules/@deepseek-ai/*` 是**手工创建**的链接，而 `@deepseek-ai/*` 被刻意排除在
`dependencies` 之外（根 AGENTS.md §3）。pnpm 的 workspace 安装会把"多余"条目 prune 掉，
也就是**很可能删掉这两个包的手工链接**，使它们的测试立刻失效 —— 而当前还有别的会话在用这棵树。
这些目录都在仓库内、可重建，但"顺手让别人的测试挂掉"不是本阶段该付的代价。

**代价（必须承认）**：`pnpm-lock.yaml` 里**没有**本包的 importer，所以
`pnpm install --frozen-lockfile` 会失败，直到在**安全的时刻**跑一次普通的 `pnpm install`。
这不影响 `pnpm -r build` / `pnpm -r test`（`pnpm run` 不校验 lockfile），
也不影响本包自己的 `check`（已实测通过）。

**回退 / 补救**：等你确认没有别的会话在跑时，在仓库根执行：

```powershell
node "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs" install
# 然后按需恢复两个兄弟包的链接（若被 prune）：
node <pnpm> --filter @voltarenyah/dsh-tia-openness-v17-min run link:runtime
node <pnpm> --filter dsh-tool-git run link:runtime
```

### P0-4 · dry-run 规则：加信息立即生效，删/覆盖信息需要显式 `dry_run: false` ✅

**决定**：`register` / `list` 立即生效；`adopt` / `forget` 默认 `dry_run: true`。

**理由**：本仓写操作默认 dry-run 的惯例针对的是**工程数据的破坏**；而 `register` 只往
workspace 内的注册表加一条记录、`forget` 就能撤销它 —— 要求两次调用只会拖慢正常使用。
反过来，`adopt` 会覆盖工作副本、`forget` 会移除一条人工录入的信息，默认必须停在"只给计划"。
规则写进了工具描述（模型一定会读到）。

**回退**：改一处默认值（`args.dry_run !== false` → `args.dry_run === true`）并同步描述。

### P0-5 · 只有一个"当前工程"指针，不设 `scope.json` ✅

**决定**：`current` 只存在于 `_dsh-eng/projects.json`。

**理由**：与 N3 同源 —— 两个指针可以互相矛盾，而"现在谈的是哪一个"是本插件最不能含糊的事。
`PATH-RULES.md` 里原先列出的 `_dsh-eng/scope.json` 因此**没有实现**，该行已同步更正。

### P0-6 · 每工程的状态目录 = `_dsh-eng/<project-id>/` ✅

**决定**：注册表在 `_dsh-eng/projects.json`，每个工程的状态（P2 的指纹基线、变更集，P3 的台账）
放 `_dsh-eng/<project-id>/`。

**理由**：落实 N3（workspace 根一份注册表 + 按工程隔离）。P0 还不会创建这个子目录
（只有 `adopt` 会建 `projects/<id>/work/`），但路径规则已按此实现与文档化。

### P0-7 · `adopt` 在本阶段只做字节复制，并把这一点说出来 ✅

**决定**：`adopt` = `copyFile(source, work)`；结果里明确写"TIA 侧另存属 P2 的接口插件族缝"，
并提示"若工程正在 TIA 里打开，请先保存"。

**理由**：D5 的理想形态是 agent 让 TIA「打开并另存」，那需要接口插件族的服务缝（D5/缝 A），P0 没有。
退而做纯文件复制是**可逆、无破坏**的（源文件只读、目标在工作区内、默认 dry-run），
而且能让 P0 独立产生价值（用户随后自己用 TIA 打开副本即可）。

**回退**：缝 A 落地后把 `adopt` 改成经接口插件族触发另存，并在结果里去掉这段说明。

### P0-8 · `link:runtime` 脚本**从不抽取**运行时缓存 ✅

**决定**：本包的 `scripts/link-dsh-runtime.mjs` 只**读**已存在的
`<DSH_HOME>/plugin-runtime`，缺包就报错退出；**不**复制兄弟包的抽取逻辑。

**理由**：抽取会删除并重建 `~/.dsh/plugin-runtime` —— 那个目录在仓库之外，
**无法用 git 恢复**，属于"需要停下等人"的操作。链接本身只写本包的 `node_modules/`（已 gitignore）。

**代价**：裸 checkout 若没有缓存，会提示去跑兄弟包的抽取器（一条明确命令），而不是自己动手。

### P0-9 · 未登记的 workspace 仍然可用，但标 `registered: false` ✅

**决定**：实现 N2。`eng_status` 同时报告"宿主有没有 workspace 服务"与"本目录是否已登记"。

**理由**：拒绝工作会让插件在"workspace 还没登记"时完全不可用；标记则不夸大身份。
实测覆盖：有 registry 服务且命中 / 有服务但未命中 / 完全没有服务（`ctx.get` 返回 undefined）三种。

### P0-10 · 配置里的目录名拒绝 Windows 保留设备名 ✅

**决定**：`segment()` 除了分隔符、`..`、保留字符，还拒绝 `con`/`prn`/`aux`/`nul`/`com1..9`/`lpt1..9`
（含带扩展名的形式，如 `nul.txt`）与结尾的点。

**理由**：这是**测试发现的真 bug** ——`stateDirName: 'nul'` 在 Windows 上无法创建
（`nul\projects.json` 不是可创建的文件），会让每一次写入都失败，且失败形态很怪。
原实现会静默接受它。回退：删掉那两行校验即可（但会重新引入这个失败模式）。

### P0-11 · 工具面就 3 个；`eng_scope` 只做 `select` / `clear` ✅

**决定**：不为了对称给 `eng_scope` 加 `show`（那是 `eng_status` 的职责），
分支/版本（`branch`/`version`）留到 P1，作用域四元组里先固定为
`branch: null` + `version: {kind:'none'}`。

**理由**：两个工具回答同一个问题会让模型无所适从；而四元组的**形状**现在定下来，
P1 填值时不必让模型重新学。结果里同时给出 `phases.pending`，明确"现在没有版本控制"。

### P0-12 · `defineTool` 会把 spec 编译成 raw JSON Schema（实测）✅

**事实**：`defineTool` 返回的 `definition.parameters` 与 `definition.output.schema`
已经是**编译后的 raw JSON Schema**（`required` 变成对象级的数组）。

**后果**：`src/dsh-runtime.d.ts` 的 `ToolDefinition` 按此修正（新增 `RawJsonSchema`），
测试也改为**直接用**这两个 schema 调 `validateJsonSchemaValue` 校验真实结果 ——
比"再编译一次"更接近注册表实际使用的对象。回退：改回声明即可，但那样声明就与实现不符。

### P0-13 · 构建/测试脚本自己解析 `tsc` ✅

**决定**：`scripts/tsc.mjs` 按"本包链接 → 仓库根"的顺序找 `typescript/bin/tsc`，
`scripts/run-tests.mjs` 先构建再跑测试；`package.json` 的 `test` 不依赖 PATH 上的 `tsc`。

**理由**：既然不跑 `pnpm install`（P0-3），`<pkg>/node_modules/.bin` 与 PATH 都不可靠；
而且 `lib/` 不提交（P0-2），`pnpm -r test` 必须先构建才能跑测试。一条命令、无隐藏前提。

### P0-14 · 跑 `pnpm install` 更新 lockfile；链接脚本退回"只管运行时" ✅

**背景**：P0-3 的前提（"本工作树不能跑 `pnpm install`"）在用户确认可以跑之后不再成立。

**做了什么**：

1. 在仓库根执行 `pnpm install --prefer-offline`（自动切到 9.12.0）。
   `pnpm-lock.yaml` 现在有本包的 importer（`packages/dsh-engineering-context:`）。
2. **实测否定了 P0-3 的担心**：安装**没有** prune 掉兄弟包的 `@deepseek-ai/*` 手工链接
   （TIA 4 条、tool-git 4 条、本包 3 条，install 前后一致）；
   `dsh-tool-git` 的 `prepare` 也按预期跑了，产物仍是 **57.78 kB**（说明它的
   `deps.neverBundle: true` 没被破坏）。
3. `scripts/link-dsh-runtime.mjs` 退回**只管 `@deepseek-ai/*`**：typescript 与 `@types`
   交给 `pnpm install`。

**为什么必须退回（第一次 install 真的失败了，留下教训）**：P0-3 期间脚本为了"不跑 install
也能编译"，把 `@types` 直接 junction 到**兄弟包的 `node_modules/@types`**。结果是
`pnpm install` 在给 TIA 包重新链接 `@types/node` 时以
`ENOENT: no such file or directory, unlink '…\dsh-tia-openness-v17-min\node_modules\@types\node'`
中断 —— pnpm 无法替换一个**别的 workspace 项目正伸手进去**的目录。

> **结论（写给所有包）**：手工链接**只能指向本包之外的"只读来源"**（如
> `<DSH_HOME>/plugin-runtime`），**绝不能指向另一个 workspace 包的 `node_modules`**。
> 后者会让 pnpm 的链接阶段失败，而且失败点在**别人**的目录里，很难看出是自己的错。

**处置**：用 `cmd /c rmdir`（只删链接、不跟进目标）移除那个 `@types` 链接，
`pnpm install` 随即成功；`node_modules` 里的 `typescript` 与 `@types/node` 现在由 pnpm 管理。

**验证（install 之后实测）**：`pnpm -r test` 三个包全绿 ——
本包 37/37（无跳过）、TIA 62 项（61 通过 / 1 跳过）、`dsh-tool-git` 33/33。

### P0-15 · 更正："插件侧自翻页"做不到（控制器没有 offset）✅

**背景**：本包设计与 [`docs/tool-surface.md`](../../../docs/tool-surface.md) §5.1 都写过
"工作流工具内部自行抬高 `max_items` **并按片请求**"。实现缝 A 时核对了控制器源码，这句是错的。

**事实（已核对 C#）**：`controller/OpennessHost.Plc.cs:152,166` —— 超过 `max_items` 后
**继续累加 `total`，但停止把对象加进 `items`**，且**没有任何 offset / skip 参数**。
响应只有 `{count, items, truncated}`。所以"取下一页"这件事在协议层就不存在。

**决定**：

1. 接口插件族的 `engineeringAccess.listObjects` 把默认上限抬到 **1000**（`DEFAULT_LIST_MAX_ITEMS`），
   并**如实返回**每族的 `{count, returned, truncated}` 与顶层 `truncated`；
2. 工程上下文插件在 P2 必须**把这个 `truncated` 照实写进 `eng_changes` 的 `notCovered`** ——
   "没取全"和"没变"是两件完全不同的事，混在一起就是假报告；
3. 本包 `ARCHITECTURE.md` §5.1 与 §5.3 已按此更正；`docs/tool-surface.md` §5.1 也加了一条更正注记
   （那份是提案，不是现状）。

**为什么这不是小事**：D6 的整个承诺是"变更不漏报也不误报"。一个被上限截断的清单如果不说，
就会让"没看见"变成"没有变化" —— 这正是本插件最不能犯的错。

**回退**：若将来控制器加了 offset，把 `listObjects` 改成真正的分页即可；
`truncated` 字段保留（分页也需要它来表示"还有更多"）。

---

## P1 实现期的决定（实现「版本层」时定的）

> 与 P0 同级：同样按"最保守 + 可逆"取舍。P1 的交付边界见
> [`ARCHITECTURE.md`](ARCHITECTURE.md) §5.4 与 §10。

### P1-1 · `runGit` 的非零退出是**数据**，不是异常 ✅

**事实（实现时被测试逼出来的）**：第一版 `runGit` 对任何非零退出都 `reject`，
于是"这个目录不是 git 仓库"（`rev-parse --show-toplevel` 退出码 128）变成了异常 ——
而它其实是一个**状态**，跟 `rev-parse --verify HEAD` 在未诞生分支上的失败一样。

**决定**：`runGit` 一律 **resolve** 并带回退出码，`runGitChecked` 才是"非零即抛"。
只有两种情形仍然 `reject`：找不到可执行文件（`ENOENT`，根本没有结果可解释）、调用被中止。

**为什么值得记**：这条契约决定了后续所有调用方怎么写。谁想读状态就用 `runGit` +
自判退出码，谁想要求成功就用 `runGitChecked` —— 混用会让"没有仓库"这种正常情况看起来像崩溃。

**验证**：`test/05-version.test.mjs` 第一项就是"非仓库 workspace 报状态、不炸、并且**没有**被
插件初始化"（还断言 `.git` 不存在）。

### P1-2 · 只版本化「导出物 + 工程状态」，`.ap17` 永不入库 ✅

**决定**：`eng_version` 计算的路径集合固定为
`projects/<id>/export` 与 `_dsh-eng/<id>` 两项，**不接受调用方指定路径**（D8 的同一思路：
参数在代码里拼好）。

**理由**：`.ap17` 是二进制，进 git 只能得到"变了/没变"（[`docs/vision.md`](../../../docs/vision.md) §3.3）；
而"导出物 + 基线"才是可比对、可进历史的派生视图。**由 `.gitignore` 强制**，且测试里放了一个
`decoy.ap17` 验证它真的被排除（`test/05-version.test.mjs`：`ls-files` 里不含任何 `.ap17`）。

**连带**：`work/` 与 `source/` 根本不在这两个路径里，所以工作副本与源项目天然不入库。

### P1-3 · `commit` 默认 dry-run，必须显式 `dry_run: false` **且**给出 message ✅

**决定**：`eng_version action=commit` 默认只给计划（列出会提交的路径与改动）；
真正提交需要 `dry_run: false` **并且** `message` 非空，否则 `invalid_argument`。

**理由**：与 P0-4 的规则一致 —— 提交是在**写历史**，是这一层里最难随手撤销的动作。
"加信息"（例如 `register`）可以立即生效，但"写历史"不该在两次调用都懒的时候发生。

**回退**：把默认翻过来只需改一处判断；但那时要在工具描述里写清"默认会提交"。

### P1-4 · 绝不 `init` / `force` / 改历史 / push ✅

**决定**：本插件**从不** `git init`（D13）。仓库不存在时：`current` 报状态并**告诉用户自己建**
（给出 `git init` 的位置），`commit` / `diff` 返回 `repository_not_found`。
仓库根**在 workspace 之外**时照样工作，但结果里**必须警告**（那次提交与无关内容共享历史）。

**边界**：只跑 `rev-parse` / `branch` / `status` / `log` / `diff` / `add` / `commit`；
没有 `push`、没有 `--force`、没有 `reset`、没有 `rebase`。

**验证**：测试第一项断言非仓库 workspace 里 `.git` **不存在**（也就是没有被悄悄创建）。

### P1-5 · 完整 patch 落盘成工件，不进上下文 ✅

**决定**：`action=diff` 默认只回"改了哪些文件 + 状态计数 + `--stat` 摘要"；
`full: true` 时把完整 patch 写到 `_dsh-eng/<id>/diffs/<from>..<to>.patch` 并返回**路径**。

**理由**：ARCHITECTURE §6 的 R2 —— 一个真实导出树的 diff 是 MB 级，
而框架的 Pruner 会把超长结果**从中间剪掉**（剪掉的正好是中间那批数据）。
写文件 + 给路径，模型要用时自己 `read`（带 offset/limit）。

**一处按需扩展**：`_dsh-eng/<id>/diffs/` 是 P1 新增的状态子目录，
`PATH-RULES.md` §8 的"可以删"列表里它属于可重建项。

### P1-6 · 未跟踪文件按**文件**报，但有界 ✅

**决定**：`git status` 用 `--untracked-files=all`，所以 `current` 报的是
`?? projects/pei/export/FB_Motor.xml` 而不是一整个 `?? projects/pei/export/`；
同时结果里 **`uncommitted` 截到 20 条**，另给 `uncommittedCount` 作为完整计数。

**理由**：目录级输出会**藏掉**调用方真正想知道的东西（哪些文件出现了）；
而首次导出一个真实项目是上千个未跟踪文件，全量塞进结果同样不可接受。
"计数 + 前 N + 明确的总数"是这两者之间唯一诚实的折中（同 R4）。

---

## D22. 删掉 4 个工具与注册表 / 版本层，只留 `create_engineering_project`（`tia/` + `source/` 布局）

**背景**：使用者的判断是"这 4 个工具都没实际用途"。核过之后我同意，而且有据：

- `_dsh-eng/projects.json` 全仓**没有任何别的消费者** —— 只有本插件那 4 个工具和它们的测试读写它；
- 接口插件在 `76782e6` 交付的 `engineeringAccess`（另存 / 读会话 / 重建源）**零调用者**：
  D21 说它的调用方是 `create_engineering_project`，而那个工具一直不存在；
- A6（"靠什么识别工程文件被更改了"）至今没有工具回答，而它才是整件事的目的（D6）；
- 于是 `eng_status` / `eng_project` / `eng_scope` 的产出只是一个没人读的 JSON，
  而 `eng_version` 的产出用户用自己的 git 也能得到。

**决定**（三条，来自使用者 2026-10 的选择）：

1. **删除** `eng_status` / `eng_project` / `eng_scope` / `eng_version`，以及只为它们存在的
   `src/registry.ts`（注册表）、`src/git.ts`（版本层）、`src/tools/scope.ts`（指针）；
   `gitPath` / `projectsDirName` / `stateDirName` 三个配置项一并删除。
2. **新增唯一的工具 `create_engineering_project`**：把 TIA 当前打开的工程另存进
   `<workspace>/tia/<项目名>/`，再把源文件树重建到 `<workspace>/source/<项目名>/`；
   默认 `dry_run: true`（另存是本插件唯一难撤销的动作）。
3. **不再保留注册表**：workspace 里"有哪些工程"由目录布局本身回答。

**关键取舍**：

| 取舍 | 现在的选择 | 理由 |
|---|---|---|
| 工程本体 vs 源文件树 | **分两棵树**（`tia/` 二进制、`source/` 文本） | `.gitignore` 只忽略 `tia/`：满足"另存物不进 git"，又不丢 PATH-RULES §6.1 的原意 |
| 目录名 | TIA 的项目名，安全化后**原样**用（不做 slug） | 目录要能对上 TIA 里的名字；`SaveAs` 不能改名（接口插件 D20） |
| `dry_run` 默认 | **true** | 与 P0-4 同源：另存把工程搬到 workspace 副本上，先给计划 |
| `.gitignore` | 本插件维护，**只追加** | 这是本插件唯一自己写的文件：缺则创建、有则追加、已有该行则不动 |
| git | **完全不碰** | 版本化交给用户自己的 git（D13 从"不自动 init"变成"不碰"） |
| 记账 | 不留注册表 | 宁可少一层账，也不要一层没人读的状态 |

**它替换 / 废止了什么**：D3（`_dsh-eng` 状态层的注册表部分）、D5（`current` 指针）、D13（`init_vcs`）、
P0-4 / P0-5 / P0-6 / P0-10 / P0-11、P1-1…P1-6（版本层与 patch 工件）。D3 中"状态放 workspace 内、
可携带"这一条仍然成立，但 P2/P3 的状态路径待定。

**代价（必须承认）**：`eng_changes`（P2）与 `eng_context`（P3）现在**没有落脚点** ——
它们原先的状态目录 `_dsh-eng/<id>/` 与"登记了哪些工程"都要等它们真的开工时重新定；
届时本文件与 `PATH-RULES.md` §8 必须同步。

**验证**：`test/02-create-project.test.mjs`（18 项）用一个假 `engineeringAccess` 服务断言：
计划不写任何东西、真实运行先另存再导出、TIA 拒绝时停在哪一步、工程已在 workspace 内时跳过另存、
被拒对象逐条回报、`.gitignore` 只追加不重写、无服务 / 控制器没跑 / 没开工程 / 没 cwd 各自的错误码。
`test/03-plugin.test.mjs` 断言只注册这一个工具、描述里写明 dry-run 规则、真实 harness 运行时接受其 schema。

---

## D23. 去掉项目名层；一个 workspace 一个工程；`source_project` 是唯一的路径参数

**背景**（使用者 2026-10 的三条要求）：① `source/` 下不要 `<项目名>` 这一层；② `tia/` 也一样；
③ 工具要能**打开源项目**（`source_project`；`with_window` 默认 true、`allow_upgrade` 默认 false，
且描述里必须写明"没有打开的项目时**向用户要路径，不许自己去磁盘上找**"）。

**一条被纠正的判断**：我曾按旧 `PATH-RULES.md` §10 的措辞推断"一个 workspace 可以放多个工程"，
**那是推断、不是规定**；使用者的口径是**一个 workspace 只管一个工程**（A5 的 session ↔ workspace 绑定）。

**决定**：

1. **`tia/` 与 `source/` 都不含项目名**。工程名只作为**身份**写进
   `source/_dsh-engineering-context.json` —— 本插件的索引：工程名 / 路径 / 实际另存落点 +
   每个 device 的目录、manifest 路径与计数 + totals。
2. **写之前比对身份**：索引里记的是**另一个工程** → `source_belongs_to_another_project` 并拒绝
   （结果里给出两个工程名，以及替代做法：换个 workspace，或自己确认后删掉那棵树）。
   索引存在但读不出来 → 只 warning：现有文件本来就是"跳过不覆盖"，所以仍然安全。**身份按索引里记录的工程文件路径判定，不按名字** —— TIA 会把另存进 `tia/` 的副本命名为 `tia`（真机实测），只比名字会让工具拒绝自己写过的工程（见下面的真机发现）。
3. **`source_project` 是唯一的路径参数**：TIA 没打开工程时必填，否则 `source_project_required`
   （消息里明说"向用户要路径，不要扫盘"）；已有工程时若传了**别的**路径 → `project_already_open`
   （控制器的 `OpenProject` 本来就会拒绝第二个，所以不去试探）。打开失败 → `open_failed` 并带上
   TIA 的原因；未开 `allow_upgrade` 时额外提示"那会**不可逆**地把工程改写成 V17，先问用户"；
   真发生了升级 → 在 warning 里点名。
4. `with_window` 默认 **true**（可见的 TIA 实例；这是有人在看的工作流），`allow_upgrade` 默认
   **false**（`OpenWithUpgrade` 会不可逆地重写工程文件）。
5. **dry run 现在能精确报出目标目录**（不再依赖"打开才知道工程名"），而且 dry run **不打开工程** ——
   打开本身就是真实动作。

**布局变化**：`source/<项目名>/<device>/…` → `source/<device>/…`；`tia/<项目名>/` → `tia/`。
**服务端同时改了导出布局**（接口插件 **D24**：三类各占一个目录、每 device 一次调用、一份 manifest），
所以"每 device 多份 manifest、消费方要合并"这件事不再存在 —— 本插件只读它返回的结果。

**验证**：`test/02-create-project.test.mjs`（23 项）+ `test/03-plugin.test.mjs`（6 项）+
`test/01-paths.test.mjs`（5 项）= **34 项全通过**。新增/改写的用例覆盖：没打开工程时要路径、
给了路径就打开（`with_window` / `allow_upgrade` 的传参）、别的工程已打开时拒绝且不试探、
打开被拒时的提示、升级被点名、目标目录与工程名无关、索引写入与身份守卫、索引损坏只 warning。

**真机发现（2026-10-16，改在 D24 之前）：`totals.refused` 曾经把同一份失败数两遍。**
接口插件在**成功**路径上返回的 `data` 是它自己的摘要（`data.failures` 与顶层 `failures` 是
**同一个数组**），只有**失败**路径上的 `data` 才是控制器的部分载荷（其中的 failures 不在顶层）。
`normalizeRebuild` 当时不区分两者，于是"1 个对象被 TIA 拒绝"被报成 `refused: 2`、`written` 少 1
（真实会话：1377 planned / 1376 files，报成 1375 written / 2 refused），模型为此花了六次以上
工具调用核对清单。修法：只有在 `data` 真的是控制器载荷（带 `summary`）时才计入其中的 failures。
**测试夹具同步补上**：假服务的成功载荷现在也带 `data`（且 `data.failures` 与顶层同一数组），
所以这条回归不会再溜过去 —— 原来的夹具没有 `data`，正好把这个 bug 放过去了。
