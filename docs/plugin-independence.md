# 插件独立化与按需安装：技术路线评估

> **状态：评估稿，未拍板。** 本文回答两个问题：
>
> 1. 把 15 个插件做成“各自能说清、能单独安装、能力可原子化开关”的形态，技术路线怎么走；
> 2. 用户不装 `dsh-automation-suite` 发行版、只挑几个插件装进自己的 profile 时，
>    会出现哪些功能漏洞、哪些只是体验降级。
>
> 本文只做评估与方案，不改代码。所有结论都尽量落到仓内可核对的路径与行号上；
> 标“未实测”的地方就是未实测，不当作既成事实。
>
> **命名说明**：本文写于包名迁移前，正文用旧名 `@voltarenyah/*` / `dsh-tool-git`；
> 当前仓库已迁移到 `@automation-suite/*`（例如 `@automation-suite/dsh-tool-git`、
> `@automation-suite/pdf-drawing`、`@automation-suite/tia-openness-v17`）。
> 语义按包目录理解，包名以各包 `package.json` 为准。

---

## 0. 结论摘要

1. **“独立”不是一个开关，而是四个自由度**：代码/仓库独立、发布节奏独立、安装独立、运行能力独立。
   之前“都独立会增加迭代发布工作量”的结论，主要成立在**发布节奏独立**和**仓库独立**上；
   **安装独立**本身不必然增加发布工作量，但会放大兼容性与支持成本。
2. **当前 15 个包已经“物理可分”，但还不是“可独立使用”**。每个包都是合法的 DSH bundle，
   `dsh plugin add` 能装上；但 TIA / PLCSIM / 图谱 / git 四个包的 `cordis.patch.yml`
   **只插入宿主行**，模型面工具行在 profile 的 preset 里。单独装 bundle 的结果是
   “服务起来了、模型看不到任何工具”。
3. **发行版真正的价值不只在插件，而在“策略层 + 运维层”**：persona、`leader`/`auditor`/`expert`
   三个 preset、工具面分配、工作区约定、Todo 协议、doctor、安装器、版本台账，都不在任何插件包里。
   用户只装插件，等于只拿到“零件”，拿不到“装配图”。
4. **按需安装的功能漏洞是真实存在的，且按严重度分三档**：
   - **P0（会让用户以为插件坏了）**：装了没工具；策略层缺失导致行为退化；工程上下文双硬依赖；
     桌面升级丢掉后装插件；没有宿主/插件兼容性闸门。
   - **P1（能跑但会困惑/踩坑）**：关 bundle 可能让 preset 变 invalid；空态指向不存在的工具；
     跨插件工件没有版本协商；工具名/命令名硬编码漂移；提示词引导不知道装了什么；
     族内互斥未实现；安装机制的 pnpm 坑；缺少单插件 doctor。
   - **P2（可接受但应写清）**：卸载后的数据残留；单控制器排队；客户端私有 API 的宿主升级风险。
5. **推荐路线：B = 可独立安装 + 单一发布列车 + 独立策略 bundle + 少量 recipe**。
   不做 C（完全独立仓库/节奏），也不做 D（按能力拆成更多包）。
   “功能原子化”用**包内能力行**（`./tools/<capability>`）实现，不用拆包实现。
6. **先补“可验证的契约”，再谈发布独立**：每个包声明角色、提供/依赖的服务、行入口、
   磁盘工件、宿主前置条件、降级行为；用一个组合矩阵测试把“装了什么 → 模型看到什么 → 面板显示什么”
   固定下来。没有这层，独立安装只会把问题从“安装失败”变成“静默半残”。

---

## 1. 先把之前的结论找出来

### 1.1 仓内实际存在的相关文档

| 文档 | 当时说了什么 | 与今天问题的关系 |
|---|---|---|
| [`distribution.md`](distribution.md) §2 | 三种打包方案：A profile 分发包（已采用）、B 伞形 bundle、C npm 发布；B/C 都会让“行是复刻的，会漂移” | 回答“怎么发给别人”，不是“每个插件怎么独立” |
| [`decisions.md`](decisions.md) D10 | 插件之间先各自独立，不抽共享包，靠文件契约对接 | 独立化的**代码边界**已经定了 |
| [`decisions.md`](decisions.md) D31 | 接口插件族**不拆包**；能力写在一个包里，用 Loader 行 + 行内配置，由 preset 装配 | 回答“TIA 能力要不要拆成 min/std/pro 包”，结论是不要 |
| [`decisions.md`](decisions.md) D36 | 族内多成员：一族多包、bundle 开关激活、先到先占互斥、工具行“认错就空转” | 回答“V17/V18 怎么共存”，是独立安装最接近的先例 |
| [`decisions.md`](decisions.md) D23 / D30 | 工具可见性按 preset 分发；慢活交给 `auditor` | 解释为什么工具行在 preset 而不是 bundle 里 |
| [`desktop-packaging.md`](desktop-packaging.md) §4 | 固定 profile、app layer、安装器三方合并 | 回答“桌面版怎么升级”，也是按需安装的最大隐藏坑之一 |
| [`releases.md`](releases.md) §4 | 一次发布 = 一次 tag + 一套 tarball + zip/exe + 发布说明 + 台账 | 量化“发布工作量”的基线 |

**没有一个单独成文的“把插件都独立出来”的评估文档。** 当时“会增加迭代发布工作量”的判断，
最接近的书面痕迹是 D31 的“重审条件”（`decisions.md:1064-1065`）：

> 对外发 npm 且需要能力独立发版；出现第三方/他人独立维护的能力；
> 需要“装 = 知情同意”的物理隔离；单包构建/测试时间成为瓶颈。

也就是说，当时的结论不是“独立一定错”，而是“**在能力边界还在控制器里、分发还是 profile+tarball 的时候，
拆包没有额外表达力，只会多付成本**”。今天插件已经成型、用户开始要求按需安装，这个前提变了，
值得重审；但重审的应该是“四个自由度里到底要独立哪几个”，而不是笼统地“都独立”。

### 1.2 当时“工作量”论证的对象是什么

把当时的成本拆开看，真正会随“独立”增长的是：

- **发布单元数**：现在一次发布一个 `vX.Y.Z`；完全独立后是 15 个包各自的版本、changelog、tag、兼容性说明；
- **组合验证数**：现在只验一套蓝图；自由组合后用户可能装出任意子集，理论上 2^15 种；
- **E2E 回归**：TIA/PLCSIM 的验证是分钟到小时级的人工/半自动流程，不能靠 `pnpm test` 替代；
- **支持面**：用户装出“半套”后，报障信息不再对应一套已知组合。

不随“独立”增长的是：

- **构建**：仍在同一个 monorepo 里 `pnpm -r build`，一次构建 15 个包；
- **打包**：`build-distribution.mjs` 一次产出 15 个 tarball；
- **单测**：`pnpm -r test` 本来就是按包跑的，和发布几个包无关。

**所以正确的切法是：安装独立 ✅，发布节奏先不独立（单一 release train），仓库不独立（继续 monorepo）。**
这样既拿到“用户可挑着装”的价值，又不把发布矩阵乘 15。

### 1.3 当时为什么选 profile 分发：逐条复核

`distribution.md` 初版（commit `dab47a3`）把理由写得很清楚。把它们按性质分开，
才能看出哪些是“当时的约束”、哪些是“现在的结构”：

| 原始理由 | 当时 | 现在 | 性质 | 结论 |
|---|---|---|---|---|
| DSH 没有“安装一个 profile”的命令；`dsh plugin add` 只接受 bundle，profile 会被拒为 `not-a-bundle` | 成立 | **仍成立** | 机制性 | “整套环境”仍只能靠 profile；但它不排除再提供 umbrella 给已有 profile |
| 保留已经验收过的那套组合；政策层不复制，blueprint 是单一真相 | 成立 | **仍成立** | 工程性 | profile 仍是单一真相；umbrella 的 patch 应由 blueprint/元数据生成，避免复制漂移 |
| 不需要 npm 账号 | 成立 | **不成立** | 偶然性 | 这条理由已经消失 |
| 伞形包的 URL 子依赖会被 `ERR_PNPM_EXOTIC_SUBDEP` 拒绝；profile 的 tarball 是直接依赖，合法 | 成立 | **在“全部包都上 npm”后不成立** | 偶然性 | 只要所有包（含 `@automation-suite/dsh-tool-git`）以 semver 发布，这条不再是 blocker；只要还有一个 tarball-only 包，问题就回来 |
| `ERR_PNPM_IGNORED_BUILDS`：`dsh-opencode-go` 的传递依赖有未声明构建脚本 | 成立 | **仍成立** | pnpm 约束 | 两种方式都要在 profile 配 `allowBuilds`；不是 profile 分发独有的理由 |
| 伞形包只能装进已经含 `dsh-web-app` 的 profile；新 profile 模板只有 `dsh-base` | 成立 | **仍成立** | 机制性 | 已有 `web`/`desktop` 的用户可以用 umbrella；全新环境/桌面 App 仍要 profile |
| 伞形包要复刻行与整份政策层，和 blueprint 是两份会漂移的真相 | 成立 | **仍成立** | 工程性 | 用生成器 + 组合矩阵测试解决；不是不可解，但确实是成本 |
| 上游裸名 `dsh-tool-git` 被占用，不能以同名发 npm | 成立 | **不成立** | 决策 | 本仓以 fork 名 `@automation-suite/dsh-tool-git` 发布（D39），与上游不是同一个 npm 包；旧结论"改名或只出 tarball"已按改名落地 |
| 离线/固定 `DSH_HOME`/桌面安装器/doctor 都依赖固定 profile | 成立 | **仍成立**（如果产品是桌面 App） | 产品性 | profile 仍是桌面/离线渠道，不是 npm 能替代的 |
| 与日常 `~/.dsh` 隔离；版本化 profile 便于回退 | 成立 | **仍成立**（如果目标用户已有 DSH） | 产品性 | 取决于你要的是“一个独立 App”还是“给现有 DSH 用户的一组插件” |

**所以当时的结论不是“profile 分发优于 npm”，而是：**

> 在没有 npm 账号、且伞形包只能用 URL 依赖的那个时点，profile 分发是**唯一能立刻交付、
> 且不牺牲已验证组合**的形态；伞形 + npm 是文档里写明的“长期更顺手的形态”。

现在两个**偶然性**理由（没有 npm 账号、URL 子依赖）已经消失；剩下的主要是
**机制性**（profile 才是完整组合的载体）、**工程性**（两份 patch 会漂移）和
**产品性**（离线、固定 home、桌面 App、与日常 DSH 隔离）。这三类理由不会因为有了 npm 账号而消失。

更准确地说，当时的决定要拆成两层：

- **产品层**：发行版是一个“受控环境”（base + web-app + 政策层 + 固定 home + doctor），
  完整组合的单位只能是 **profile**；`dsh plugin add` 只能给已有 profile 打补丁。
  这一层与 npm 无关，今天仍然成立。
- **渠道层**：插件用 tarball + profile 交付，还是用 npm + umbrella 交付。
  当时的渠道层理由是“没有 npm 账号 + URL 子依赖被拒 + tool-git 名字冲突”；
  前两条今天基本消失，第三条改名即可解决。

所以今天不是“要不要推翻 profile 分发”，而是“**在 profile 之外，要不要再加一个 npm umbrella 渠道**”。
两者不是替代关系：profile 负责“从零得到一个完整环境”，umbrella 负责“把一套组合装进已有 profile”。

---

## 2. 四个自由度：现在各自独立到什么程度

| 自由度 | 现状 | 证据 | 结论 |
|---|---|---|---|
| **代码/仓库** | 一个 monorepo，`packages/*` 各自一个包；TIA 包是压平导入，历史在归档仓库 | 根 `AGENTS.md` §1；`packages/*/package.json` | 已经“代码可分”，不建议拆仓库 |
| **发布节奏** | 一套发行版版本（当前 0.2.6），15 个包版本基本是 `0.1.0`（`@automation-suite/dsh-tool-git` 是上游 `0.1.3`） | `docs/releases.md` §3；各包 `package.json` | 仍是 lockstep，没有独立语义 |
| **安装** | 每个包都声明 `dsh.bundle.patch`，`dsh plugin add` 可单独装；但 profile 分发才是已验收路径 | 各包 `package.json` 的 `dsh` 字段；`distribution.md` §1.2/§2 | 机械上可装，体验上不可用（见 §4） |
| **运行能力** | 宿主行提供服务；模型工具行在 preset；UI 插件各自独立 | 见 §3 表 | 只能整包启用，不能按能力授权 |

> 一句话：**“能装”不等于“能用”，“能用”不等于“能按功能开关”。**
> 现在只完成了第一层。

---

## 3. 现状盘点：15 个包的真实边界

### 3.1 总表

> “单独安装后的可用度”指：只 `dsh plugin add` 这个 bundle、不改 profile 的 preset，
> 在一个已经有 `dsh-base` + `dsh-web-app` 的 profile 里会发生什么。

| 包 | 角色 | 宿主行提供 | 模型工具行 | UI / 命令 | 读写的跨插件工件 | 硬依赖 | 单独安装后的可用度 |
|---|---|---|---|---|---|---|---|
| `@automation-suite/tia-openness-v17` | TIA V17 接口 | `engineeringAccess`、`projectTextAccess`、`tiaOpennessRuntime`、skill provider、C# 控制器 | `./tools`（39 个） | `./commands`（7 个 `/tia-*`） | 写 `source/<device>/`（含控制器生成的 `_manifest.json`）；读写 TIA 工程 | Windows x64、TIA V17、Openness 组、.NET Framework 4.8 | **宿主行可加载，0 个模型工具**（工具行不在 bundle patch 里） |
| `@automation-suite/plcsim-advanced` | PLCSIM Advanced 运行时 | `plcsimRuntime`、C# 控制器 | `./tools`（4 个） | — | 写 `.dsh/simulation/**`；读 `source/_dsh-engineering-context.json`、`_evidence.json` | PLCSIM Advanced API 4.0 | **宿主行可加载，0 个模型工具** |
| `@automation-suite/engineering-graph` | 工程知识图谱 | `knowledgeGraph`、`knowledgeEngine`、C# 引擎子进程 | `./tools`（查询/建库 + 下钻，由 `includeIngest` / `includeDrilldown` 控制） | — | 写 `knowledge/<device>/*.db`、`.dsh/local/graph/*.json`；读 `source/<device>/_manifest.json` | 发布 tarball 自带 self-contained 引擎；源码构建要 .NET 10 | **宿主行可加载，0 个模型工具**；`engineering-context` 仍可通过服务建库 |
| `@automation-suite/dsh-tool-git`（vendor，无 scope） | Git 服务与工具 | `gitContext`、破坏性命令守卫 | `./tools`（12 个） | — | 读写 workspace 的 git 仓库；不做跨插件文件 | git 可执行文件 | **宿主行可加载，0 个模型工具**；`gitContext` 与守卫可用 |
| `@automation-suite/engineering-context` | 工程上下文 / 版本工作流 | **主行直接在宿主面注册 7 个工具** | 无 `/tools`；另有 `./status`、`./version`、`./diff`、`./handoff`、`./version-read` 子入口 | — | 写 `tia/`、`source/_dsh-engineering-context.json`、`source/<device>/_evidence.json`、`.dsh/local/**`、`handoff/`；读 TIA 服务、git 服务、图谱服务 | `engineeringAccess`（TIA）+ `gitContext`（git）为硬依赖；`knowledgeGraph` 为软依赖 | **7 个工具全部出现在宿主面**（所有 agent 继承）；`create_engineering_project` 缺 TIA 或缺 git 都会在调用时失败 |
| `@automation-suite/pdf-drawing` | 电气图纸 | 工具 + `/drawing` 查看路由 + 客户端 | 主行直接注册工具 | 右侧栏 Drawing | 写 `drawing/**` 索引；读 PDF | `@hyzyla/pdfium`、`unpdf`、`pngjs` | **完整可用**（工具 + 面板都在宿主/客户端） |
| `@automation-suite/tia-todo-bridge` | TIA 操作 Todo 兜底 | 事件监听，无服务/工具 | — | — | 只读会话事件 | 无 | **可加载但完全惰性**（没有 TIA 工具就什么都不做） |
| `@automation-suite/ui-changes` | 变更面板 | 只读状态路由 | — | 右侧栏 Changes | 通过 `gitContext` 现算 | git 插件（软） | **可加载**；没有 git 时面板显示“git 插件未加载” |
| `@automation-suite/ui-hardware` | 硬件面板 | 无（纯客户端） | — | 右侧栏 Hardware | 读 `.dsh/hardware-view.json` | TIA 插件（软） | **可加载但空态**；“跑 `export_hardware_config`”这句指引此时是死路 |
| `@automation-suite/ui-plc-source` | PLC 块面板 | 无（纯客户端） | — | 右侧栏 PLC Blocks | 读 `source/**` | `engineering-context` / TIA（软） | **可加载但空态**；指引会让人去跑不存在的工具 |
| `@automation-suite/ui-project-dashboard` | 项目看板 | tags 路由 | — | 主栏全局页 | 读 workspace 注册表、会话、tags | 无硬依赖 | **完整可用**（只做工作区总览） |
| `@automation-suite/ui-prompt-guide` | 提示词引导页 | 静态页路由 | — | 主栏整页 | 内容数据内置 | 无硬依赖 | **可加载**，但内容描述的是“整套发行版”，不知道用户装了哪些 |
| `@automation-suite/ui-tia-console` | TIA 控制台 | 无（纯客户端） | — | 输入框上方条 | 读会话里的 `command/*` / `tool/*` 事件 | TIA 插件（软） | **可加载**；没有 TIA 时显示“状态未检测”，按钮派发的 `/tia-*` 不存在 |
| `@automation-suite/ui-versions` | 版本面板 | 无（纯客户端） | — | 右侧栏 Versions | 读 `.dsh/versions-view.json` | `engineering-context`（软） | **可加载但空态**；指引会让人去跑 `project_version_reindex`，没装生产者时不存在 |

### 3.2 三个结构性事实

1. **bundle patch 只负责“宿主行”**。四个“有服务”的包（TIA / PLCSIM / 图谱 / git）的
   `cordis.patch.yml` 都只有一条 `insert`，`name` 指向包根；模块根入口明确“不注册模型工具”。
   例如 `packages/dsh-tia-openness-v17-min/src/index.ts:105-108`、`src/tools-entry.ts:44`；
   `packages/dsh-engineering-graph/src/index.ts:72-83`；`packages/dsh-plcsim-advanced/src/tools-entry.ts:17`；
   `packages/dsh-tool-git/cordis.patch.yml` 的注释也写明“12 个工具在 `./tools`，别插在这里”。
2. **工具行只存在于 profile 的 preset 里**。`profile/dsh-automation-suite/cordis.patch.yml:519-528`
   声明了 `leader-tia-tools`、`leader-plcsim-tools`、`leader-git-tools`、`leader-tia-commands`、
   `leader-graph-tools`。这些行不是 bundle 的一部分，`dsh plugin add` 不会带进来。
3. **`engineering-context` 是唯一的反例**：主行直接在宿主面注册工具（`src/index.ts:64`），
   再由 `/status`、`/version` 等子入口给不同 preset 发“子集”。这造成两个后果：
   - 单独安装时，7 个工具对所有 agent 可见（包括子 agent），不符合 D23/D30 的最小权限；
   - 如果同时装策略 bundle（里面又有 `/status` 行），同一作用域链上可能出现同名工具/重复暴露，
     需要按 DSH 的 `NamedEntries` 语义逐条确认（见 §5 P1-6）。

---

## 4. 独立安装要过的五层闸门

一个“功能”真正可用，需要五层同时成立：

| # | 闸门 | 谁负责 | 缺失时的症状 |
|---|---|---|---|
| 1 | 包已安装（`package.json` 依赖 + `node_modules`） | 用户 / `dsh plugin add` | 模块解析失败，整行 `failed` |
| 2 | bundle 已启用（`dsh.profile.bundles` 里这一层在） | 插件页 / profile | 宿主行不存在，服务和 UI 都没有 |
| 3 | 该 agent 的 preset 声明了对应行 | profile 的 preset | **服务在、工具不在**——用户以为插件坏了 |
| 4 | 生产者/服务/工件存在 | 另一个插件或磁盘 | 工具在，但调用报“没有 `engineeringAccess`/`knowledgeGraph`/`gitContext`” |
| 5 | 宿主前置条件满足 | 机器环境 | 控制器/引擎/Openness 报错；无 preflight 时像“随机失败” |

> **当前 `dsh plugin add` 只保证第 1、2 层。** 第 3 层是 profile/preset 的事，第 4、5 层是组合与环境的事。
> 这就是“按需安装”所有体验问题的总根源。
>
> 另一个容易误解的点：**发行版本身不是 bundle**。`dsh-automation-suite` 是 profile 蓝图，
> `dsh plugin add` 会以 `not-a-bundle` 拒绝它（`distribution.md` §1.3）。
> 所以“不装发行版、自己挑插件”是唯一可行的按需路径，但它必须自己承担 profile/preset 的装配。

---

## 5. 功能漏洞清单

### P0-1 · 装了 bundle，模型却没有工具

**症状**：用户 `dsh plugin add` 了 TIA 插件，重启后问“打开工程”，模型说没有工具；
插件日志却显示宿主行已加载、控制器已启动。

**证据**：
- `packages/dsh-tia-openness-v17-min/cordis.patch.yml` 只插入 `tia-openness-v17` 宿主行；
- `src/index.ts:105-108` 注释：“constructing it registers a service, but no tool, so the host row stays tool-free”；
- `src/tools-entry.ts:44` 的 `inject` 才是工具行；
- 蓝图把工具行放在 `leader` preset（`profile/.../cordis.patch.yml:519-528`）。

**影响**：这是按需安装最容易踩的坑，且没有报错——它“静默地半残”。
用户会先怀疑 TIA/Openness，实际只是没声明行。

**修复方向**：
- 每个包的 `package.json` 增加机器可读的 `dsh.plugin.rows`（host / tools / commands / client），
  安装后打印“这个包只提供宿主能力，模型工具需要 recipe/preset 声明”；
- 提供 recipe（见 §7），不要让用户手工拼 preset；
- 文档/README 第一段就区分“host-only”和“agent-usable”。

### P0-2 · 策略层不在任何插件里

**症状**：用户只装几个插件，得到的是“通用 DSH agent + 一堆工具”，而不是发行版里的行为：
没有 `leader`/`auditor`/`expert` 的分工，没有 Todo 协议，没有工作区约定，
没有“慢活交给 auditor”的纪律，子 agent 还可能继承宿主面的危险工具。

**证据**：
- 根 `AGENTS.md` §1“系统提示词注入在 profile 蓝图里（发行版政策层）”：persona、preset、
  工具面分配都在 `profile/dsh-automation-suite/cordis.patch.yml`，不在插件里；
- `decisions.md` D23（两层 agent）、D30（慢活必须派出去）、D31（行 + preset 装配）；
- 各插件的 `cordis.patch.yml` 里没有 persona、没有 preset、没有 `system-prompt` 行。

**影响**：行为质量下降是最难被用户归因的“漏洞”——工具都在，模型却自己干慢活、
不写 Todo、不按工作区布局找文件、让子 agent 看到不该看的工具。

**修复方向**：
- 拆一个独立的 `@automation-suite/dsh-automation-suite-policy` bundle，只负责
  `system-prompt` / `agent-preset-registry` / 三个 preset / 工具面分配；
- recipe = “能力包集合 + policy bundle + 该组合的 preset”；policy bundle 不依赖具体能力包，
  但它的 preset 行会引用能力包（因此 recipe 必须保证“引用的包都装了”）；
- 文档明确：**只装能力包 = 只有零件；要 agent 行为，必须装 policy**。

### P0-3 · `engineering-context` 的双硬依赖

**症状**：用户只装 `engineering-context`，第一次 `create_engineering_project` 就失败；
错误信息让他去装 TIA 和 git，但装完 bundle 后工具行仍可能不在 preset 里。

**证据**：
- `packages/dsh-engineering-context/src/tools/create-project.ts:1102-1122`：
  先要求 `engineeringAccess`，再要求 `gitContext`，两者缺一都抛结构化错误；
- 知识图谱是软依赖：`create-project.ts:1083-1086` 明确“图谱不在时只报未建成，不影响源树”；
- `project_translate` 还依赖 TIA 的 `projectTextAccess`。

**影响**：这不是“静默失败”，错误文案也写得清楚；但用户会经历“装一个 → 报错 → 再装一个 → 再报错”
的连环安装，且 `dsh plugin add` 不会自动带依赖。

**修复方向**：
- 在包元数据里声明 `requires.hard = [engineeringAccess, gitContext]`、`requires.soft = [knowledgeGraph]`；
- recipe `version-only` 明确包含 TIA 宿主行（不需要 TIA `/tools`）+ git 宿主行 + engineering-context；
- 安装器/文档在安装前就把“这个 recipe 需要哪些宿主前置条件”说清楚。

### P0-4 · 桌面升级会丢掉用户后装的插件

**症状**：用户在桌面版 Plugins 页装了额外插件，升级安装器后这些插件消失
（旧 profile 被整体移到 `.bak-<stamp>` 备份里，但新 profile 不再包含它们）；
会话、工程文件、tags 都还在，但对应面板/工具没了。

**证据**：
- `desktop/installer/install-profile.ps1:227-232`：旧 profile 整体移到备份目录，新 profile 整体换入；
- 合并只发生在 `cordis.patch.yml`（`:192-217`），`scripts/merge-profile.mjs:114-147`
  只保留用户改过的 `- id:` 块和旧 patch 里的 `- id:` 块；
- `package.json` 的 `dependencies` / `node_modules` 不参与合并，用户后装的插件不在新 app layer 里。

**影响**：这是“按需安装”与“固定 profile 升级”之间的结构性冲突。
用户越喜欢自己装，升级时丢得越多。

**修复方向**：
- 安装器升级时保留旧 profile 的 `package.json` 直接依赖，把新 app layer 的依赖合并进去，
  并对 `file:`/tarball 依赖做可解析性检查；
- 或在升级前扫描“非 app layer 管理的依赖”，生成 `user-plugins.json`，升级后提示一键重装；
- `doctor.ps1` 增加“用户额外插件是否还在”的检查（当前 doctor 只看固定组合）。

### P0-5 · 没有宿主/插件兼容性闸门

**症状**：DSH 升级后，某个独立安装的插件静默失效；或者插件独立升级后，宿主内部 API 变了，
面板空白/工具报错，但没有安装期提示。

**证据**：
- 15 个包的 `package.json` 都只有 `engines.node`，没有 `engines.dsh`，也没有
  `peerDependencies` 里的 `@deepseek-ai/dsh*`；
- `distribution.md` §1.6/§6 明确：兼容性检查只看 `engines.dsh` 或 `peerDependencies`，
  现在“等于不设闸门”；
- 多个插件依赖宿主私有面：客户端 `ctx.slots.inject`、locale 的 `translate` 包装、
  `ctx.webServer` 路由、会话事件、`uiWorkspace.startSession`（见各 UI 包 README 的“宿主升级要复核”）。

**影响**：发行版靠安装器/doctor 把宿主版本钉住；独立安装绕过了这层，升级时序完全自由，
兼容性问题会以“插件坏了”的形式出现。

**修复方向**：
- 每个 bundle 增加 `engines.dsh`（按实测过的宿主范围），必要时加 `peerDependencies`；
- 发布物附带 `compatibility.json`：suite 版本 × DSH 版本 × 各插件版本；
- 每个包提供最小 smoke（`--dump-config-schema` 能读到 Config 字段 + 客户端 seat 能挂上），
  在 CI 里对“当前宿主 + 上一个宿主”各跑一次。

### P1-1 · 关 bundle 可能让 preset 变 invalid（D36 已定，尚未落地）

**症状**：用户在插件页关掉 TIA bundle，重启后新会话起不来（preset 变 invalid），
或者工具面与背后的控制器不一致。

**证据**：
- `@automation-suite/tia-openness-v17/src/tools-entry.ts:44` 仍然模块级 `inject: ['tools', TIA_RUNTIME_SERVICE]`；
- D36 第 5 条要求“工具行/命令行认错就空转”：模块级 `inject` 去掉 runtime，`apply()` 里主动取并比对
  `member.version`，缺席时注册 0 个工具并打 info 日志（`decisions.md:1344-1350`）；
- 该条在 D36 里是“决定”，但当前 V17 代码还是旧形态；
- 插件页的 `setPluginEnabled` 只作用于宿主面（`include` 平面），preset 行不可寻址
  （`decisions.md:1324-1328`）。

**影响**：这是“选择性开关某些功能”最直接的反例：开关本身可能把组合弄坏。
**风险等级取决于 DSH 对 pending 行的诊断行为**，D36 的结论是 pending 会让 preset `invalid`；
这一点在 D36 里也标了“读实现得出，未在插件页实点验证”。

**修复方向**：
- 先落地 D36 第 5 条，再对外宣传“可以关 bundle”；
- 在关闭路径上做一次 `--dump-config` / 新建会话 smoke；
- 如果短期不做，文档明确“不要用插件页关 TIA bundle，改 profile”。

### P1-2 · 面板空态指向不存在的工具

**症状**：用户只装了 UI 插件，面板告诉他“运行 `export_hardware_config` / `project_version_reindex` /
`create_engineering_project`”，但这些工具根本没装。

**证据**：
- `packages/dsh-ui-versions/src/client/locales.js` 的 `noView`：
  “先提交一次，或在会话里运行 project_version_reindex”；
- `packages/dsh-ui-hardware/src/client/locales.js` 的 `state.empty.body`：
  “在会话里调用 export_hardware_config 导出组态，再调用 hardware_view”；
- `packages/dsh-ui-plc-source/src/client/locales.js` 的 `error.notFound`：
  “先运行 create_engineering_project”；
- `packages/dsh-ui-changes/src/client/locales.js` 的 `error.noService` 反而写对了：
  “git 插件（@automation-suite/dsh-tool-git）没有加载，变更不可用”。

**影响**：不是硬故障，但会让用户按提示操作后得到一个“工具不存在”，
把“没装生产者”误判成“功能坏了”。

**修复方向**：
- 空态优先说“缺哪个插件/recipe”，其次才说“装好后跑哪个工具”；
- 客户端能拿到已注册工具列表时，按可用性切换文案（需要宿主暴露只读的 tool catalog）。

### P1-3 · 跨插件工件没有统一的版本协商

**症状**：独立升级生产者/消费者后，面板显示“无法解析”或字段缺失；数据本身没坏，但视图不对。

**证据**：
- `source/<device>/_evidence.json` 有严格 `schemaVersion === 1`（`packages/dsh-engineering-context/src/evidence.ts:140-145`）；
- `source/<device>/_manifest.json` 有 `schemaVersion: 1`（`create-project.ts:1648`）；
- `.dsh/versions-view.json` **没有** `schemaVersion`（`packages/dsh-engineering-context/src/version/view.ts:23-68`）；
- `.dsh/hardware-view.json` 由 TIA 的 `HardwareView` 操作写出，消费端按字段解析，没有统一版本字段
  （`packages/dsh-tia-openness-v17-min/src/tools.ts:3033-3095`）；
- 仿真快照 manifest 已经是 `schemaVersion: 2`（`packages/dsh-plcsim-advanced/AGENTS.md` §6）；
- handoff marker 有自己的 `HANDOFF_SCHEMA_VERSION`（`packages/dsh-engineering-context/src/handoff/marker.ts`）。

**影响**：现在锁步发布掩盖了这个问题；一旦独立升级，生产者/消费者可能只差一个字段，
表现为“空面板/解析失败/少一列”，而不是明确的版本错误。

**修复方向**：
- 所有跨插件 JSON 工件统一带 `schemaVersion`，消费端不匹配时给出“升级哪个包”的明确错误；
- 在 `docs/` 维护工件契约表（路径、生产者、消费者、schema、兼容规则）；
- 契约测试：生产者写 fixture，消费者解析 fixture，跨包 CI 跑。

### P1-4 · 硬编码名字契约会随独立发布漂移

**症状**：插件改了工具名/命令名，桥接器、提示词引导、persona 文本没跟上；
没有编译错误，只有运行时“少一条 Todo/一条引导指向不存在的工具”。

**证据**：
- `@automation-suite/tia-todo-bridge` 按 `TRACKED_TOOLS` 的 32 项工具名白名单匹配（`packages/dsh-tia-todo-bridge/src/bridge.ts`）；
  TIA 自己的 39 个工具名又是另一份契约（`docs/tia-version-members.md` §6.3）；
- `@automation-suite/ui-prompt-guide/src/guide.ts:787+` 的 `TOOL_CATALOG` 是静态白名单；
- persona 文本里写死了 `TIA · <tool_name> · <object>`、`/tia-*` 命令、工作区布局；
- `docs/tia-version-members.md` §6.3 把 39 个工具名、7 个命令名、skill 名、服务名列为“跨版本必须逐字一致”。

**影响**：独立发布让“改一个名字”从一次全仓同步变成跨包协调；没有契约测试就会静默漂移。

**修复方向**：
- 每个包导出自己的工具名/命令名常量（`TOOL_NAMES`、`COMMAND_NAMES`），
  桥接器/引导页从包导入或从生成的 catalog 读取，不手抄；
- 增加跨包 contract test：`tia-todo-bridge` 的白名单 ⊆ TIA 包的工具名；
  prompt-guide 的 `TOOL_CATALOG` ⊆ 所有已装包的工具并集；
- 改名字的 PR 必须同时更新契约表与 persona 文本（可做脚本校验）。

### P1-5 · 提示词引导不知道用户装了什么

**症状**：用户只装了图纸插件，打开 Prompt Guide 仍看到 TIA/仿真/版本的全部提示词；
复制一条，模型说“没有这个工具”。

**证据**：
- `@automation-suite/ui-prompt-guide/src/guide.ts:10-20` 的不变量只保证“工具名在 `TOOL_CATALOG` 里”，
  不保证“当前组合装了它”；
- 页面是静态数据 + 静态路由（`packages/dsh-ui-prompt-guide/src/index.ts`），没有读取已装工具集合。

**影响**：这是“文案承诺 > 实际能力”的典型；对独立安装的用户尤其明显。

**修复方向**：
- 宿主路由返回当前 composition 的工具/能力清单，页面按可用性过滤或标注“需要安装 X”；
- 或把 guide 拆成“基础页 + 各能力包自带的卡片”，装哪个包就出哪些卡片。

### P1-6 · 族内互斥与重复 provider 尚未实现

**症状**：将来用户同时装 V17 和 V18 两个 TIA 包，第二个包 `provide` 同名服务时抛错，
或者两套控制器同时启动；没有友好提示。

**证据**：
- D36 决定“先到先占”，但当前 V17 代码里没有 `claimFamily`（`decisions.md:1338-1341` 是方案，
  不是已实现代码）；
- `engineering-context` 主行在宿主面注册 7 个工具，若同时被 policy 的 `/status` 行再次声明，
  同名工具的作用域行为需要实测（`NamedEntries` 同作用域重复注册会 throw）；
- 当前 `cordis.patch.yml` 里 TIA 工具行仍是静态 `inject`，没有 D36 的版本比对。

**影响**：V18 到来前不暴露；但“独立安装”会让用户更容易同时装两个成员。
这是必须在 V18 发布前解决的 P1，不是 P2。

**修复方向**：
- 先实现 D36 的 `claimFamily` + 工具行空转 + doctor 检查“启用的族成员恰为 1”；
- 对 `engineering-context` 主行做“宿主面只留服务、工具全部拆行”的改造（见 §7.3），
  消除同名工具风险。

### P1-7 · 安装机制本身的坑

**症状**：用户按文档“把本地目录 add 进去”，插件加载失败；或 `dsh plugin add` 以 pnpm 错误退出，
但包其实已经写进依赖。

**证据**：
- `distribution.md` §1.1：本地目录是 `link:` 语义，**不会安装它的 dependencies**；
- `distribution.md` §1.5：`ERR_PNPM_IGNORED_BUILDS`（`dsh-opencode-go` 的传递依赖）与
  `ERR_PNPM_EXOTIC_SUBDEP`（伞形包的 URL 子依赖）会让 install 整体退出 1；
- `@automation-suite/dsh-tool-git` 的包名与上游冲突，不能以同名发布到 npm（`distribution.md` §2 方案 C；
  根 `AGENTS.md` §1“第三方插件是 vendor 副本”）；
- `dsh plugin add` 的对账只看“本次新增的直接依赖”，失败重试要先 `remove` 再 `add`
  （`distribution.md` §1.2）。

**影响**：独立安装把“安装”从发行版的 `install.ps1` 一条命令，变成用户要理解 pnpm 语义；
这是支持成本的主要来源之一。

**修复方向**：
- 提供“每个包一个 tarball + 一行安装命令”，文档不推荐本地目录；
- `@automation-suite/dsh-tool-git` 要么改 scope（破坏性，但正规化必须做），要么在文档里明确只能 tarball/URL；
- 安装脚本在失败时打印“包已装上但 bundle 未对账，请 remove 后重试”。

### P1-8 · 缺少单插件 doctor / 前置条件自检

**症状**：用户在没有 TIA 的机器上装 TIA 插件，或在没有 PLCSIM Advanced 的机器上装仿真插件，
得到的是控制器/引擎的底层错误，而不是“你缺什么”。

**证据**：
- `doctor.ps1` 是发行版级检查（`docs/desktop-packaging.md` §9；`distribution.md` §4），
  独立安装不会跑它；
- TIA 包要求 Windows x64、TIA V17、Openness 组、.NET Framework 4.8（`distribution.md` §6）；
- PLCSIM 包要求 API 4.0、证书规则、F-CPU 边界（`packages/dsh-plcsim-advanced/AGENTS.md` §1/§5）；
- 图谱引擎在发布 tarball 里自包含，但源码构建要 .NET 10（`docs/decisions.md` D33）。

**影响**：独立安装的用户没有“安装末尾的 doctor”这道闸门，第一次失败往往发生在真实工程上。

**修复方向**：
- 每个包提供 `doctor`/`self-test` 子命令或 `dsh` 配置检查；
- 工具错误里带 `remediation`（TIA 包已经这么做了，应推广到所有宿主依赖）；
- 发布页按包列“前置条件 + 自检命令”。

### P1-9 · UI 插件依赖官方客户端座位包，装错 profile 会“静默不显示”

**症状**：用户把 UI 插件装进一个没有完整 Web 客户端座的 profile（精简 profile、非 web 组合），
包在 `node_modules` 里、宿主行也加载了，但侧栏/主栏根本不出现新面板，也没有报错。

**证据**：
- 各 UI 包的 `package.json` 里有 `dsh.client.inject`，例如
  `@automation-suite/ui-plc-source` / `@automation-suite/ui-versions` / `@automation-suite/ui-hardware` 依赖
  `@deepseek-ai/dsh-api-workspace-files`、`@deepseek-ai/dsh-client-ui-sidebar-right`、
  `@deepseek-ai/dsh-client-ui-session`；`@automation-suite/ui-project-dashboard` 依赖
  `dsh-client-ui-sidebar` / `dsh-client-ui-layout` / `dsh-client-locale`；
  `@automation-suite/ui-tia-console` 依赖 `dsh-api-session-controller` / `dsh-client-ui-conversation`；
- 客户端模块的发现与座位注册由宿主完成；缺座位时通常只 warn，不阻止包加载。
- `dsh.client.platform` 都是 `web`，桌面壳也是 WebView2，但没有对应官方包的 profile 不具备这些座位。

**影响**：用户会以为“插件没装上”或“版本不对”，实际是 profile 组合不对。
这是“独立安装”里最难自查的一类，因为宿主日志不一定显眼。

**修复方向**：
- README 第一段写清“本包需要 web/desktop 组合（含哪些官方客户端座）”；
- 发布物提供最小 seat smoke（在真实 web profile 里断言面板出现）；
- 安装器/doctor 在安装 UI 包时检查目标 profile 是否含所需 `dsh-web-app` 行。

### P2-1 · 卸载后的数据残留

**症状**：用户卸掉 TIA/工程上下文/仿真插件后，`tia/`、`source/`、`knowledge/`、
`.dsh/simulation/`、`handoff/` 还在；面板消失，数据没有归属说明。

**证据**：这些目录由插件写入，但没有“工件所有权/清理”清单；
`docs/simulation-workspaces.md` 把仿真存档定义为工作区本地运行产物；
`AGENTS.md` §7 说明 `tia/` 与 `knowledge/**/*.db*` 进 `.gitignore`。

**影响**：不会丢数据（这是好事），但用户会困惑“删了插件为什么还有文件”，
也可能误删唯一副本。**卸载绝不自动删工程/历史**，只需要写清楚。

**修复方向**：每个包在 README 列“我写哪些路径、卸载后保留什么、怎么清理”；
安装器/插件页给“数据位置”入口，不做自动删除。

### P2-2 · 单控制器/单会话的排队

**症状**：多个会话/子 agent 同时用 TIA，工具排队；独立安装不会改变这一点。

**证据**：TIA 包 `src/runtime-service.ts` 顶部注释与 D2 的硬约束；
`docs/roadmap.md` §2“一次一个宿主进程一个 TIA 会话”。

**影响**：可接受，但独立用户可能以为是“插件装少了”。文档应写清“这是 Openness 的限制”。

### P2-3 · 客户端私有 API 的宿主升级风险

**症状**：DSH 升级后某个 UI 面板空白/不注册，控制台只有 warn。

**证据**：各 UI 包 README 记录了依赖的宿主内部面：
`ctx.slots.inject`、`ctx.locale.register` / `translate`、`ctx.webServer.register`、
`uiWorkspace.startSession`、会话事件形状（原 `@automation-suite/ui-brandmark` 连 `translate` 都包过，
已于 2026-11-24 移除，见 D40 —— 这类"包装内部方法"的形态本来就不该保留）。
这些不是官方扩展点，宿主升级要复核。

**影响**：发行版靠 lockstep 验一套；独立安装后用户可能先升级 DSH 再升级插件，
出现“版本组合没人验过”的窗口。

**修复方向**：兼容性矩阵 + 每个 UI 包的最小 smoke（seat 挂载 + 路由 200 + 字典落回）。

### P2-4 · 发行版层面的能力不在插件里

“不装发行版、只装插件”还会少掉这些**不是插件**的东西；它们不一定是 bug，
但用户会感知为“体验不如发行版”：

| 发行版提供 | 独立安装时 | 影响 |
|---|---|---|
| 固定 profile + 政策层（persona / preset / 默认 `leader`） | 没有 | 行为退化，见 P0-2 |
| `dsh-opencode-go` 模型 provider + 默认模型设置 | 没有 | 用户要自己配 provider/API key |
| 桌面壳（WebView2）、安装器、托盘、单实例 | 没有 | 只能用 Web GUI |
| `doctor.ps1` 安装期自检 | 没有 | 前置条件问题推到第一次使用 |
| 版本化 home / profile、离线 tarball、lockfile | 没有 | 升级/回退/离线安装要自己管 |
| 品牌、Prompt Guide、项目看板 | 可选装 | 纯体验差异 |

**方向**：README 用一张“装插件 ≠ 装发行版”的对照表把预期说清；
如果希望独立安装也“开箱像发行版”，policy bundle + recipe 是必须补的那一层。

---

## 6. 路线选项对比

| 方案 | 用户能挑着装 | 发布成本 | 兼容性风险 | 实现成本 | 评价 |
|---|---|---|---|---|---|
| **A. 维持单一发行版** | ❌ 只能整套 | 最低（现状） | 最低（lockstep） | 0 | 不满足“按需安装”的诉求 |
| **B. 可独立安装 + 单一 release train + policy bundle + recipe** | ✅ 按 recipe 装 | 低（仍一次发布） | 中（组合需矩阵测试） | 中 | **推荐** |
| **C. 完全独立仓库 + 独立发布节奏** | ✅ 任意 | 高（15 套版本/兼容/支持） | 高 | 高 | 不推荐；正是之前“工作量”结论的对象 |
| **D. 按能力拆成更多包**（TIA min/std/pro、online/hardware 包） | ✅ 更细 | 高（包数 × 组合） | 高 | 高 | 不推荐；D31 已论证“能力边界在控制器，不在包” |

**推荐：B，外加 D 的“行级版本”**：

- 包的数量保持 15 个左右，不按能力拆包；
- “功能原子化”用包内 `./tools/<capability>` 行实现（同一控制器、同一进程，只是工具面分组）；
- 发布仍是一条列车：一个 suite 版本、一套 tarball、一份兼容性清单；
- 允许 UI/叶子包在兼容性清单内走 patch 级 hotfix（可选，后期再做）；
- 不做 C，因为 C 的发布矩阵和支持面会把之前结论里的成本真正兑现。

---

## 7. 推荐目标形态

### 7.1 三层结构

```
能力包（15 个，可独立安装）
  ├─ 宿主行：服务、子进程、目的地资源
  ├─ 工具行：./tools/<capability>（按 preset 授权）
  ├─ 命令/客户端：./commands、client.js
  └─ 文档/技能：README、skills、工件契约
策略层（1 个 bundle）
  ├─ system-prompt / persona
  ├─ agent-preset-registry（leader / auditor / expert）
  └─ 每个 preset 的行清单（引用能力包）
recipe（3–6 个安装集）
  ├─ version-only：TIA 宿主 + git 宿主 + engineering-context + policy
  ├─ tia-full：上述 + TIA tools/commands + graph + 全部 UI
  ├─ simulation：tia-full + PLCSIM
  ├─ drawing：drawing + policy（或独立使用）
  └─ ui-only：UI 插件 + git（Changes 需要）
```

> **policy bundle 也只能装进已经有 `dsh-web-app` 的 profile**（`web` / `desktop` 这类）。
> 它要改的 `system-prompt` / `agent-preset-registry` 行来自 `@deepseek-ai/dsh-web-app`；
> 缺这些行时 patch 只会 warning + 跳过，不会失败（`distribution.md` §1.3/§1.4）。
> 所以“独立安装”的隐含前提是：目标 profile 本身是一个完整的 Web 组合，而不是空 profile。

> **recipe 的落地形态**：现在最稳的是“profile 蓝图 / 安装脚本”直接列出该 recipe 的 tarball，
> 再把 policy bundle 装进去；不要先做“依赖一堆 URL tarball 的伞形 bundle”——
> `blockExoticSubdeps` 会拒绝子依赖里的 URL（`distribution.md` §1.5/§2 方案 B）。
> 等 npm 发布具备条件后，伞形 bundle 才是更顺手的形态。

### 7.2 每个包的“插件卡片”元数据

建议在 `package.json` 增加一个**不被 DSH 读取、只用于本仓校验与生成文档**的块
（字段名待定，避免和 DSH 自己的 `dsh` 字段冲突）：

```jsonc
"dsh": {
  "plugin": {
    "role": "interface",              // interface | context | graph | simulation | ui | integration
    "summary": "TIA Portal V17 Openness …",
    "provides": ["engineeringAccess", "projectTextAccess", "tiaOpennessRuntime"],
    "requires": {
      "hard": [],                     // 服务名或宿主要求
      "soft": ["knowledgeGraph"]
    },
    "rows": {
      "host": ".",                    // 宿主行，必须无工具
      "tools": ["./tools"],           // 模型面，按 preset 声明
      "commands": ["./commands"],
      "client": "./client"
    },
    "artifacts": [
      { "path": "source/<device>/_manifest.json", "schemaVersion": 1, "role": "producer" }
    ],
    "host": ["windows-x64", "tia-v17", "openness-group", "netfx-4.8"],
    "degradation": "missing-service: 0 tools + info log; missing-artifact: empty panel with install hint"
  }
}
```

配套一个 `scripts/plugin-catalog.mjs`：

- 校验 `rows.tools` 的每个子路径在 `exports` 里存在；
- 校验 `provides` 与源码里的 `ctx.provide(...)` 名字一致；
- 校验 `requires` 的服务名在别的包里有人提供；
- 生成 `docs/plugin-catalog.md`（人读）+ `manifest.json`（安装器/doctor 读）。

这样“每个插件能说清自己在做什么”不靠 README 自觉，而是有生成物和 CI 校验。

### 7.3 行入口规范（这是“原子化”的落点）

**硬规则：宿主行不注册模型工具。** 所有工具走 `./tools/<capability>` 子路径，
由 preset 决定给谁。当前 TIA/PLCSIM/图谱/git 已经这么做；`engineering-context` 和 `drawing`
还是宿主行直接注册，应逐步改造。

建议的能力行拆分（不新增包、不新增控制器）：

| 包 | 建议行 | 内容 |
|---|---|---|
| TIA | `./tools/project` | 打开/关闭/保存/新建/归档/取回/工程属性/语言/文本/Portal 设置 |
| TIA | `./tools/blocks` | 导出/导入/编译/在编辑器打开/生成源/块属性/保护/软件单元 |
| TIA | `./tools/objects` | 对象增删改/列表/标签表/监视表/强制表 |
| TIA | `./tools/hardware` | 硬件导出/清单/组态/参数/硬件视图 |
| TIA | `./tools/online` | 在线目标/连接/状态/断开/下载 |
| TIA | `./tools/safety` | 安全状态/设置/签名 |
| TIA | `./tools/library` + `./tools/status` | 项目库；控制器状态 |
| engineering-context | `./create`、`./status`、`./sync`、`./commit`、`./diff`、`./handoff`、`./version`、`./version-read` | 已有部分入口，补齐并让主行变“无工具宿主行” |
| git | `./tools/read`、`./tools/write` | 只读查询 vs 变更操作（子 agent 可只给 read） |
| graph | `./tools/query`、`./tools/ingest` | 查询/下钻 vs 建库/更新（现在用 config 开关，行更直观） |
| PLCSIM | `./tools/instance`、`./tools/io` | 实例生命周期 vs 标签读写 |

拆行的收益：

- preset 可以按 agent 授权，不需要“整包装了就给全部”；
- 用户/recipe 可以选择“只读能力”，不需要改包；
- 工具名冲突、重复注册的风险更容易控制（每行只注册自己的工具）。

拆行的成本：

- 每行一个模块入口，`package.json` 的 `exports` 要同步；
- preset 的工具面更长，但 policy bundle 可以生成；
- 需要一次覆盖矩阵/测试的同步（TIA 包的 `matrix:check` 会拦工具变化）。

### 7.4 降级契约

每个包都必须回答“缺了什么会怎样”，并统一成三种行为：

| 缺失 | 行为 |
|---|---|
| 依赖的服务缺席 | 工具行注册 **0 个工具** + 一行 info 日志；不 throw，不 pending（D36 第 5 条） |
| 依赖的工件缺席 | 工具照常注册，调用时返回结构化 `unavailable` + `remediation`；面板空态给出“装哪个包/recipe” |
| 宿主前置条件不满足 | 宿主行仍加载（不拖垮整个 profile），工具调用返回结构化错误；doctor/自检给出前置条件 |

**禁止**：因为一个可选插件没装就让 preset 变 `invalid`、让新会话起不来。

### 7.5 发布模型

- **一个 suite 版本**：`0.3.0`；所有包的 `version` 可以保持 `0.1.0`，但在 manifest 里记
  `suiteVersion` / `sourceCommit`，保证“这一套是一起验过的”；
- **一套 tarball**：`build-distribution` 仍一次产出 15 个；
- **一份兼容性清单**：`manifest.json` 增加 `compatibility: { dsh, suite, plugins }`；
- **可选 hotfix 车道**：只对 UI/叶子包开放 patch 版本，前提是兼容性清单声明它不改变服务/工件契约；
- **不做** 15 个独立 tag/release；需要单包发布时，从同一 commit 出 tarball 并更新清单。

---

## 8. 分阶段落地

### Phase 0 · 只补“契约与观测”（不改行为，1–2 天）

- 给 15 个包加 `dsh.plugin` 元数据（§7.2）；
- 写 `scripts/plugin-catalog.mjs`，生成 `docs/plugin-catalog.md`；
- 加组合矩阵测试（只读，不改 profile）：
  - 单包安装后 `--dump-config` 有宿主行；
  - 单包安装后 `--dump-config-schema` 能读到该包 Config（证明模块被 import）；
  - 单包安装后**没有**工具行（把“装上了但没工具”变成预期并写进测试）；
- 给 `@automation-suite/ui-hardware` 补 README（当前 15 个包里唯一没有 README 的）。

**验收**：`pnpm -r test` 仍全绿；新测试能在“只装一个 bundle”的临时 profile 上跑通。

### Phase 1 · 策略层与 recipe（最高性价比，3–5 天）

- 拆出 `@automation-suite/dsh-automation-suite-policy`（或先在仓内做 `profile/recipes/*.yml`）；
- 做 3 个 recipe：`version-only`、`tia-full`、`simulation`；
- 安装文档改成“先选 recipe，再装包”，不再让用户手工拼 preset；
- 修空态文案：缺插件时说插件名，不缺时再说工具名；
- 修 `engineering-context` 的安装指引：把“装 TIA + git”写进错误 `remediation` 和 README 第一段。

**验收**：
- 每个 recipe 在全新 profile 里 `--dump-config` 出现预期的 preset 行与工具行；
- 故意少装一个包时，会话能起、工具面缺该能力、面板给安装提示，而不是 preset invalid。

### Phase 2 · 工具行原子化 + 降级落地（5–8 天）

- 按 §7.3 拆 TIA / engineering-context / git / graph / PLCSIM 的工具行；
- `engineering-context` 主行改为无工具宿主行（或保留兼容别名，标记 deprecated）；
- 实现 D36 第 5 条：工具行不再模块级 inject runtime，缺席时注册 0 个工具；
- 给跨插件 JSON 工件补 `schemaVersion`（至少 `versions-view.json`、`hardware-view.json`）；
- 加契约测试：工具名白名单 ⊆ 包导出的 `TOOL_NAMES`；工件 fixture 跨包解析。

**验收**：
- 关掉 TIA bundle 后新建会话仍能起（工具面没有 TIA 工具）；
- `expert` 子 agent 看不到 TIA/git 写工具；
- 旧 `versions-view.json` 在新 UI 下给出明确版本错误，而不是空白。

### Phase 3 · 安装与兼容性（3–5 天）

- 每个 bundle 加 `engines.dsh`（或 `compatibility.json`）；
- 安装器升级时保留用户额外依赖（§P0-4）；
- 每个包提供 `doctor`/`self-test` 或至少一个前置条件检查；
- `@automation-suite/dsh-tool-git` 的发布方式决策（改 scope / 只出 tarball / URL 依赖）。

**验收**：在全新 `DSH_HOME` 里装一个 recipe、升级一次、再装一个额外包、再升级，
额外包仍在、doctor 全绿。

### Phase 4 · 独立节奏与 V18（后续）

- UI/叶子包可走 hotfix 车道；
- V18 前实现 D36 的 `claimFamily` + 族成员 doctor；
- 视情况把某个稳定包发布到 npm（如果要对外）。

---

## 9. 发布工作量账

### 9.1 现在一次发布

| 步骤 | 次数 |
|---|---|
| 版本号/changelog/发布说明/台账 | 各 1 |
| tag + GitHub Release | 1 |
| tarball | 15（+ `dsh-opencode-go` 来自 npm） |
| zip / 桌面 exe / app layer | 各 1 |
| `pnpm -r build/typecheck/test` | 1 套 |
| 真实 TIA/PLCSIM E2E | 1 轮（人工/半自动） |

### 9.2 方案 B（推荐）

与现在基本相同，增加：

- 每个包的 `dsh.plugin` 元数据/兼容性清单（生成，不手工）；
- recipe 组合测试（3–6 套，不是 2^15）；
- 单包安装的负向测试（预期“没工具”，防止回归）。

**结论：方案 B 不会把发布工作量乘 15。** 它增加的是“组合验证”，但组合数被 recipe 限制在个位数。

### 9.3 方案 C（不推荐）

- 15 个包各自版本、changelog、tag、release、兼容性说明；
- 用户任意组合，支持面无法用 recipe 收敛；
- 每次核心插件变更都要重验所有 recipe + 真实 E2E；
- 机械步骤可脚本化，但**真实 TIA/PLCSIM 回归与用户支持不能**。

这才是之前“都独立会增加迭代发布工作量”的真正含义。**今天要拒绝的是 C，不是 B。**

---

## 10. 需要拍板的问题

1. **发布物形态**：只出 GitHub Release tarball，还是也要 npm？如果要 npm，
   `@automation-suite/dsh-tool-git` 的同名冲突必须先解决（改 scope 或只出 tarball）。
2. **版本策略**：所有包继续 lockstep（推荐先这样），还是允许核心包/UI 包分批？
3. **组合策略**：只支持 recipe（推荐），还是允许用户自由混装并接受“需要自己配 preset”？
4. **策略层是否必装**：只装能力包时，是否明确告知“没有发行版行为，只有通用 agent”？
5. **功能开关粒度**：接受“bundle 开关 + recipe”作为用户级开关，
   还是要求“每个工具行都能在 UI 里单独开关”？后者需要 DSH 支持 preset 行寻址，或新增工具门禁插件。
6. **单插件自检**：doctor 是继续由发行版统一提供，还是每个包自带一个最小自检？
7. **兼容窗口**：每个包声明支持哪些 DSH 版本？只支持当前 + 上一个，还是更宽？

---

## 11. 验收基线（建议加进 CI）

| 场景 | 命令/断言 | 期望 |
|---|---|---|
| 单包安装 | 临时 profile `dsh plugin add <tarball>` → `--dump-config` | 有该包宿主行 |
| 单包 import | `--dump-config-schema` | 输出含该包 Config 字段（模块真被 import） |
| 单包工具面 | 新建会话看工具列表 | 只有宿主能力，**没有**模型工具（这是预期，不是 bug） |
| recipe 安装 | `--dump-config` | 出现 policy 的 preset 行与对应工具行 |
| 关 bundle | 关 TIA bundle → 新建会话 | 会话能起；工具面没有 TIA 工具 |
| 缺生产者 | 只装 `ui-versions` | 面板空态提示“装 engineering-context”，不是“跑不存在的工具” |
| 桌面升级 | 装额外插件 → 升级安装器 | 额外插件仍在，或升级前明确列出将丢失的包 |
| 工件契约 | 生产者 fixture → 消费者解析 | 版本不匹配时给出明确错误 |
| 目录一致性 | `plugin-catalog` 校验 | `provides`/`rows`/`exports`/工具名全部一致 |

> 行数基线仍按根 `AGENTS.md` §4 的方式维护；本文不重复那些数字，避免两处漂移。

---

## 12. 可解性矩阵：哪些能自己解决，哪些要 DSH 改

先说结论：**绝大多数漏洞都能解决，但不是“每个插件自己改一改”就能解决**。
它们大多要在“组合层（composition/profile/installer）”解决；真正被 DSH 当前机制卡住的只有三条：
preset 行不可寻址、不能向已有 preset 追加行、传递依赖的 bundle 不会自动启用。
另有两条是产品/环境固有约束，只能检测和说明，不能消除。

| 编号 | 问题 | 可解性 | 解法 | 谁来做 |
|---|---|---|---|---|
| P0-1 | 装了 bundle，模型没工具 | ✅ 本仓可解 | composition/recipe 声明工具行；包元数据标 `rows.tools`；安装后打印“host-only”提示 | 组合包 + 安装器 |
| P0-2 | 策略层不在插件里 | ✅ 本仓可解 | policy bundle 或 profile 承担 persona/preset/工具面；作为 recipe 的一部分 | 组合包 |
| P0-3 | `engineering-context` 双硬依赖 | ✅ 本仓可解 | 元数据声明 hard/soft requires；recipe 带齐 TIA 宿主 + git 宿主；安装前 preflight | 包元数据 + 安装器 |
| P0-4 | 桌面升级丢掉后装插件 | ✅ 本仓可解 | 安装器合并旧 profile 的直接依赖 / 记录 `user-plugins.json` / 升级前提示重装 | 安装器 |
| P0-5 | 没有兼容性闸门 | 🟡 部分可解 | 每个 bundle 加 `engines.dsh`；发布 `compatibility.json`；对当前 + 上一个宿主跑 smoke | 包 + CI |
| P1-1 | 关 bundle 让 preset invalid | ✅ 本仓可解 | 落地 D36 第 5 条：工具行去掉模块级 runtime inject，缺席时注册 0 工具 | 插件代码 |
| P1-2 | 空态指向不存在的工具 | ✅ 本仓可解 | 空态先提示“装哪个包/recipe”，再提示工具；能拿到工具目录时按可用性切换 | 客户端 |
| P1-3 | 跨插件工件无版本协商 | ✅ 本仓可解 | 所有跨包 JSON 加 `schemaVersion`；消费者拒绝不兼容版本并给升级指引 | 生产/消费两端 |
| P1-4 | 工具名/命令名硬编码漂移 | ✅ 本仓可解 | 包导出 `TOOL_NAMES`/`COMMAND_NAMES`；生成 catalog；跨包 contract test | 包 + CI |
| P1-5 | Prompt Guide 不知道装了什么 | ✅ 本仓可解 | 宿主路由暴露已装工具/能力清单，页面过滤或标注“需要安装 X” | UI + 宿主 |
| P1-6 | 族内互斥/重复 provider | ✅ 本仓可解 | 实现 D36 `claimFamily`；`engineering-context` 主行改无工具宿主行 | 插件代码 |
| P1-7 | 安装机制 pnpm 坑 | 🟡 部分可解 | 只发 tarball/npm；禁止本地目录当正式安装；`@automation-suite/dsh-tool-git` 改 scope 或只出 tarball | 发布决策 |
| P1-8 | 缺单插件 doctor | ✅ 本仓可解 | 每包一个 `self-test`；发行版 doctor 汇总调用 | 包 + 安装器 |
| P1-9 | UI 插件缺客户端座位包 | 🟡 部分可解 | profile 必须含 `dsh-web-app`；doctor 检查目标 profile；README 写清 | 安装器 + 文档 |
| P2-1 | 卸载后数据残留 | ✅ 可解（文档+清单） | 每包声明写哪些路径、卸载保留什么、怎么清；不做自动删除 | 包文档 |
| P2-2 | 单控制器/单 TIA 会话 | ❌ 固有约束 | Openness 只允许一个 TIA 会话；文档写清并做队列 | 无法消除 |
| P2-3 | 客户端私有 API 升级风险 | 🟡 部分可解 | 兼容矩阵 + 每个 UI 包 seat smoke；不能保证宿主永不改私有面 | CI |
| — | 逐功能 UI 开关 | ❌ 需 DSH 上游 | `setPluginEnabled` 只作用于宿主面；preset 行不可寻址。规避：bundle 开关 + recipe/配置 | DSH |
| — | 向已有 preset 追加行 | ❌ 需 DSH 上游 | patch 的 `config` 是整块替换，`config.plugins` 不按 id 合并。规避：composition 拥有完整 preset | DSH |
| — | 传递依赖 bundle 自动启用 | ❌ 需 DSH 上游 | `dsh plugin add` 只把“本次新增的直接依赖”里声明 bundle 的包加进 `bundles`。规避：umbrella 自己插全部行 | DSH |
| — | 任意子集都保证完整行为 | ❌ 不可解 | 组合数天然爆炸；用 recipe 收敛，非 recipe 组合只保证降级不崩 | 产品决策 |

**所以“能不能都解决”的准确回答是：**

- 用户能看到、能归因的“半残”问题（P0/P1 的大部分）——**能**，通过 composition + 元数据 +
  契约测试 + 安装器/doctor 解决；
- 真正的“逐功能开关”“插件自动往 leader 里加一行”“装一个伞形包就自动启用所有子 bundle”——
  **当前 DSH 做不到**，只能换成“composition 拥有完整组合”的模型；
- TIA/PLCSIM 的环境依赖、单会话限制——**不能消除**，只能提前检测和说明；
- “任意组合都保证体验”——**不能承诺**，只能承诺“recipe 组合完整可用，其他组合优雅降级”。

---

## 13. 多插件依赖下，当前 DSH 最 decent 的发布方式

### 13.1 先看 DSH 的四个硬机制

这四条决定了“发布单元”应该是什么：

1. **`dsh plugin add` 不是安装器，是“pnpm + bundle 对账”**。
   它把包装进 profile，再把**本次新增的直接依赖**里声明了 `dsh.bundle.patch` 的包追加进
   `dsh.profile.bundles`。**传递依赖不会自动成为 bundle 层**（`distribution.md` §1.2）。
   → 一个“伞形包依赖 15 个功能包”的写法，只会启用伞形包自己；功能包的 patch 不会自动生效。
2. **bundle patch 的 `insert` 只能加行，不能往已有 preset 的 `config.plugins` 里追加**。
   带 `- id:` 的 patch 会**整块替换** `config`（`composition-reference.md` §Loader patch dialect；
   根 `AGENTS.md` §1 的实测记录）。→ 工具行不能由“功能包自己的 patch”加进 `leader`；
   必须由一个拥有完整 preset 的组合层来声明。
3. **DSH 没有“插件服务依赖求解器”**。服务是运行期 `ctx.get('...')`；
   安装期兼容性只看 `engines.dsh`，没有就再看 `peerDependencies` 里的 `@deepseek-ai/dsh*`
   （`distribution.md` §1.6）。→ 不能靠 npm 的 peerDependencies 表达“需要 engineeringAccess”；
   只能靠元数据 + 运行期降级 + 安装期 doctor。
4. **pnpm 的两个硬约束**：URL/git 子依赖会被 `blockExoticSubdeps` 拒绝；
   本地目录是 `link:`，不装依赖（`distribution.md` §1.1/§1.5）。
   → 伞形包要么走 npm 的普通 semver 依赖，要么走 profile 的直接 tarball 依赖；
   “伞形包 + URL 子依赖”不是可发布形态。

### 13.2 四种发布形态对比

| 形态 | 用户侧 | 多插件依赖怎么成立 | 独立安装 | 离线 | 当前可行性 | 评价 |
|---|---|---|---|---|---|---|
| **A. profile 分发**（现状） | 解压 + `install.ps1` | 所有插件是 profile 的**直接** tarball 依赖；blueprint 写全 bundles 与 preset | ❌ 只能整套 | ✅ | ✅ 已验收 | **现在最稳**；桌面/离线首选 |
| **B. 伞形 bundle（npm）** | `dsh plugin add @scope/suite` | 伞形包依赖精确版本的功能包；**伞形 patch 自己插入所有 host/tools/preset 行**；profile 需 hoisted 或功能包也作直接依赖 | ✅ 按 recipe | ❌ 需 registry | 🟡 需 npm + 改 `@automation-suite/dsh-tool-git` 名 | **长期最顺手**；官方 profile bundle 同套路 |
| **C. 逐个装独立 bundle** | `dsh plugin add` × N | 每个包只插自己的宿主行；用户自己改 preset | ✅ | ✅ | ✅ 机械可行 | ❌ **不 decent**：用户要懂 preset，且多数包装上没工具 |
| **D. 完全独立仓库/节奏** | 15 套 | 每个包独立版本/发布/兼容 | ✅ | ✅ | ❌ | ❌ 发布矩阵 ×15，正是之前结论的对象 |

> B 的“伞形 patch 自己插所有行”不是可选项，是机制要求：功能包是传递依赖，
> 它们的 `cordis.patch.yml` 不会进入 `dsh.profile.bundles`。
> 官方 `@deepseek-ai/dsh-experimental-*-profile` 也是这个形态（`distribution.md` §2 方案 B）。

### 13.3 推荐：composition-first，而不是 plugin-first

**产品/支持单元 = composition（recipe 伞形包），不是单个插件。**

- 一个 recipe 伞形包 = 一组精确版本的功能包 + 一份完整 patch（host 行 + tools 行 + commands +
  preset/persona）；
- 用户装一个包，得到一套**已经验过的组合**；
- 单个功能包仍然可以独立安装，但文档定位是“host-only / 高级用法”，
  不是“装上就有完整 agent 行为”；
- 不要支持“用户自由混装 + 我们保证行为”；只支持 recipe + 明确的降级。

推荐的包布局（名字待定）：

```
@automation-suite/dsh-automation-suite            # full recipe（伞形，主入口）
@automation-suite/dsh-automation-suite-minimal    # version-only recipe
@automation-suite/dsh-automation-suite-simulation # full + PLCSIM
@automation-suite/tia-openness-v17        # 功能包（也可单独装，host-only）
@automation-suite/engineering-context
@automation-suite/engineering-graph
@automation-suite/plcsim-advanced
@automation-suite/dsh-tool-git                    # 需要改 scope 或只出 tarball
...                                          # UI 包
```

**关键实现：伞形 patch 由元数据生成，不手抄。**
每个功能包声明 `rows.host` / `rows.tools` / `rows.commands` / `rows.client`；
`scripts/build-composition.mjs` 从这些声明生成伞形 `cordis.patch.yml` 与 preset 行。
否则“伞形包的行”和“功能包自己的 patch”会成为两份会漂移的真相——
这正是 `distribution.md` §2 方案 B 当时指出的问题。

**解析前提：功能包必须能从目标 profile 顶层解析。**
伞形包只把功能包作为传递依赖安装时，pnpm 默认的 isolated linker 不会把
`node_modules/@scope/feature` 放到顶层；Loader 按包名解析就会失败。
两条可行路径：

- profile 使用 `nodeLinker: hoisted`（本仓蓝图就是这么写的），或
- 安装器把 recipe 里的功能包也作为 profile 的**直接依赖**（tarball 路径），伞形包只负责行。

发布前必须在**目标 `web`/`desktop` profile**里实测 `--dump-config` 能解析每一行，
不能只在仓库的 hoisted 环境里验。

**反模式：不要把“伞形包”和“单个功能 bundle”同时装。**
两者的 patch 都会插入同名行（`insert` 不去重），会出现重复行/重复实例/服务冲突。
要么装 recipe，要么装单包；文档和插件页都要明确。

### 13.4 版本与兼容

**先 lockstep，后分化。**

- **现在**：所有包版本 = suite 版本（例如全部 `0.3.0`），伞形包同版本，
  依赖用**精确版本**（`"0.3.0"`，不用 `^`）；`pnpm-lock.yaml` 锁死。
  这是最容易支持、最容易复现的形态。
- **以后**：只对 UI/叶子包开放 patch 级独立版本；核心包仍随 suite 走。
  前提是 `compatibility.json` 声明“这个 UI 版本兼容哪些 core/suite 版本”。
- **每个 bundle 都加 `engines.dsh`**（当前 + 上一个宿主范围）；
  尽量**不要**用 `peerDependencies` 声明 `@deepseek-ai/dsh*` 来表达依赖——
  它会把宿主运行时包带进 pnpm 解析，和本仓 D19 的“验到旧宿主版本”是同一类坑。
- **`@automation-suite/dsh-tool-git` 必须先解决名字**：npm 上 `@automation-suite/dsh-tool-git` 已被上游占用；
  要么改名 `@automation-suite/dsh-tool-git`（同步 patch 的 `insert[].name`、蓝图 bundles、测试），
  要么它只走 tarball/profile，不进 npm 伞形包。**这是 B 方案的前置决策，不是发布细节。**
- **changesets / release-please 只解决 npm 层的版本与发布**，解决不了
  “bundle 怎么被启用、preset 行怎么装配”；不要把工具当成架构。

### 13.5 现在 vs 目标

| 阶段 | 主发布方式 | 单包安装 | 说明 |
|---|---|---|---|
| **现在（无 npm）** | A：profile 分发 + 安装器 | 可，但标 host-only | 所有插件作为 profile 的**直接** `file:` tarball 依赖；policy 在 profile；doctor 在安装末尾 |
| **过渡** | A + “recipe profile” | 可 | 每个 recipe 一个 profile 变体；仍不依赖 registry |
| **npm 就绪后** | B：伞形 bundle 为主，A 保留为离线/桌面 | 可，但非推荐 | 功能包 + 伞形包同一 commit 发布；伞形 exact pins；profile 继续作为离线渠道 |
| **稳定后** | B + UI hotfix 车道 | 可 | 仅 UI/叶子包允许独立 patch；核心仍 lockstep |

**结论：当前 DSH 下最 decent 的是“composition-first”的发布：**
现在用 profile 分发把组合固定下来；npm 就绪后升级为伞形 bundle（每个 recipe 一个），
功能包仍可独立安装但不再承担“完整体验”的承诺。
**不是** 15 个插件各自发版、让用户自己拼。

### 13.6 发布检查清单（composition-first）

1. 定 suite 版本；所有功能包与伞形包写同一版本，依赖用精确版本。
2. `pnpm -r build` / `typecheck` / `test` 全绿。
3. `node scripts/build-distribution.mjs --version X.Y.Z` 生成 tarball、profile、manifest。
4. 如走 npm：按依赖顺序 `pnpm -r publish --access public`；再发布伞形包（exact pins）。
5. `build-app-layer.mjs --version X.Y.Z` 与安装器从**同一个 commit** 构建。
6. 新 `web` profile：装伞形包 → `--dump-config` 出现全部 host/tools/preset 行 →
   `--dump-config-schema` 能读到关键 Config → 新建会话 → 插件页面板出现。
7. 新 `DSH_HOME`：装 profile zip → `doctor.ps1 -Json` 0 fail。
8. 关一个 bundle：新会话仍能起，工具面少一组（在 D36 空转落地之后）。
9. 更新 `compatibility.json`（suite × DSH × 插件）与 `docs/releases.md` 台账。
10. 在内容提交上打 tag，再发 Release；不要先发后提交。

### 13.7 不要做的事

- ❌ 用 URL tarball 做伞形包的子依赖（`ERR_PNPM_EXOTIC_SUBDEP`）。
- ❌ 让用户“先装 A 再装 B，自己去 leader preset 加一行”。
- ❌ 15 个包各自 tag/release/changelog，再让用户组合。
- ❌ 把 `peerDependencies` 当服务依赖解析器。
- ❌ 同时支持“伞形包 + 单包混装”而不去重行 id。
- ❌ 承诺任意子集都完整可用；只承诺 recipe 完整、其他组合优雅降级。

---

## 14. 当前分发形式的改进清单

### 14.1 先确认“当前”是哪条渠道

从 0.2.0 起，**桌面安装器 + 固定 profile** 是主渠道；0.1.5 是最后一个 Web 启动版
（`docs/releases.md` §1）。所以下面按优先级分两类：

- **桌面链路**：`build-distribution` → `build-app-layer` → `build-installer` →
  `install-profile.ps1` → `doctor.ps1`。这条链路离线、有运行时验证，是当前产品。
- **Web zip 链路**：`install.ps1` + 网络安装。它从 0.1.5 后基本停用；要么明确退役，
  要么补齐“锁文件 / 校验 / 回滚”，不要维持一个“看起来能用、实际没人验”的第三条路。

### 14.2 P0：先修“装得上、装得对、能回退”

| # | 改进 | 现状证据 | 建议 |
|---|---|---|---|
| 1 | **可复现安装** | `build-app-layer.mjs:272` 用 `--no-frozen-lockfile`；Web profile 不生成/不携带 `pnpm-lock.yaml`，`install.ps1` 直接 `dsh plugin install` | 在 staging 生成 lockfile 并随 app layer/profile 发布；安装用 `--frozen-lockfile`；把 lockfile 的 sha256 写进 manifest |
| 2 | **完整性校验** | `install.ps1` 有 `manifest.json` 的 sha256，但安装过程不校验；桌面 app layer 只检查 tarball 存在 | 安装前按 manifest 校验每个 tarball；`app-manifest.json` 记录每个 tarball/package 的 sha256；doctor 复核 |
| 3 | **升级原子性** | `install-profile.ps1:227-274` 会先移走旧 profile、失败时恢复；但 Web `install.ps1:435-462` 覆盖后失败不恢复 | 桌面保持现有回滚；Web 若保留，改成“临时目录安装 + 成功后原子替换” |
| 4 | **保留用户后装插件** | `install-profile.ps1` 只合并 `cordis.patch.yml`；`package.json` 的额外依赖随旧 profile 一起被移走；`merge-profile.mjs` 还会丢弃用户在 `- insert:` 块里的改动（app policy 优先） | 合并旧 profile 的直接依赖；或写 `user-plugins.json`，升级后提示/自动重装；如果允许用户手工加行，提供独立的 user patch 层；doctor 报告“缺失的用户插件” |
| 5 | **发布门禁** | `docs/releases.md` 只要求 `pnpm -r test`；TIA 的 `matrix:check`/`skills:check`/`test:controller` 不在其中 | 增加根 `release:verify`：`pnpm -r build/typecheck/test/check`、TIA controller self-test、`test-merge-profile`、`test-doctor-json`、app layer 运行时验证、安装器 smoke |
| 6 | **Manifest 同源** | Web `manifest.json` 没有 `sourceCommit`/包版本/验收记录；桌面 `desktop-manifest.json` 有 | 统一 schema；`build-distribution` 从 `git rev-parse HEAD` 写 `sourceCommit`；tag 必须等于它；把 desktop 的 `acceptance` 字段带到 Web |
| 7 | **DSH 版本元数据** | `build-distribution.mjs:345-346` 的 `minDshVersion`/`testedDshVersion` 默认仍是 0.2.1-rc.x | 构建时从实际宿主 `dsh --version` 读取；manifest 写 `testedDshVersion` + 验收日期；安装前用 `engines.dsh`/manifest 做闸门 |

### 14.3 P1：让用户“看得懂、查得到、换得掉”

| # | 改进 | 现状证据 | 建议 |
|---|---|---|---|
| 8 | **包版本身份** | 15 个包版本几乎全是 `0.1.0`；tarball 名固定；`build-distribution --no-pack` 按 `name-version.tgz` 复用 | 包版本随 suite 递增，或至少写 `build`/`contentHash`；`--no-pack` 校验 tarball 内容 hash，不能只看文件名 |
| 9 | **插件页展示元数据** | 15 个包都没有 `locale/`、`icon`、`meta.detail`；Plugin Manager 只能回退到 `package.json` 的 name/description 和通用图标 | 每个包加 `locale/en.json` + `locale/zh.json`（`meta.title` / `meta.description` / `meta.detail`）和图标；`files` 补 `locale`/`icon`；README 作为 detail 兜底 |
| 10 | **OS/架构闸门** | TIA/PLCSIM/图谱的控制器/引擎是 Windows x64；15 个包都没有 `os`/`cpu` 字段 | 给三个包加 `"os": ["win32"]`、`"cpu": ["x64"]`（或安装器 preflight）；避免“装上后才发现跑不了” |
| 11 | **doctor 深度** | `doctor.ps1` 只检查 bundle 行、包目录、graph 引擎、TIA/PLCSIM 路径、git、文档依赖、凭据 | 增加：preset 行/工具行是否在 `--dump-config` 里、每包实际版本、TIA/PLCSIM controller `--self-test`、族成员数恰为 1、磁盘空间、`--dump-config-schema` 关键 Config |
| 12 | **政策层生成** | `profile/dsh-automation-suite/cordis.patch.yml` 70 KB，`preset-leader` 手抄宿主 `standard`；0.2.5 就因 DSH 0.2.2 行变化导致 `agent-preset/invalid` | 写 `scripts/generate-policy.mjs`：从宿主 `standard` 生成 leader 基础行 + 套件增量；CI 对比 diff；每个支持的 DSH 版本跑一次新会话 smoke |
| 13 | **诊断包** | 0.2.4 已有“报告问题”入口，但没有一键收集环境 | `doctor --bundle` 输出 zip：doctor JSON、`--dump-config`（脱敏）、包版本、app-manifest、最近日志、TIA/PLCSIM 探测结果 |
| 14 | **离线与体积** | 桌面 app layer 每版约 137 MiB（node_modules 103 + tarballs 34），图谱引擎自包含约 39 MB；Web 仍需网络 | 保留离线能力；app layer 用共享 cache/硬链接或 delta；图谱引擎可按需下载（带 sha256）作为可选优化；Web 要么退役要么提供 offline zip |

### 14.4 P2：长期维护

- **`@automation-suite/dsh-tool-git` vendor 维护**：记录上游 commit/版本、同步脚本、LICENSE/NOTICE；npm 路线前改名。
- **旧 profile 清理**：`start.cmd` 选择版本、`doctor` 列出旧 profile、提供安全删除指引（不跟进 junction）。
- **签名**：安装器与图谱引擎 exe 目前未签名；SmartScreen/AV 误报会直接影响分发；至少提供 SHA-256 与签名计划。
- **`latest.json` / 更新检查**：当前没有自动更新；如果要做，先定义“更新 profile 但不丢用户插件”的契约。

### 14.5 建议的发布门禁（一次跑完）

```powershell
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm -r check                     # TIA 的 matrix:check / skills:check；其余包等同 test
pnpm --filter @automation-suite/tia-openness-v17 run test:controller
node scripts/test-merge-profile.mjs
pwsh -NoProfile -File scripts/test-doctor-json.ps1
node scripts/build-distribution.mjs --version X.Y.Z
node scripts/build-app-layer.mjs --version X.Y.Z
pwsh -NoProfile -File desktop/build-shell.ps1 -Version X.Y.Z -SmokeTest
pwsh -NoProfile -File desktop/build-installer.ps1 -Version X.Y.Z
```

再加三条人工/半自动验收：

1. 干净 `DSH_HOME` 安装 → `doctor` 0 fail → 新建会话；
2. 从上一版升级 → 用户额外插件/设置仍在（或明确列出将丢失项）；
3. 关掉一个 bundle → 新会话仍能起（D36 空转落地后）。

### 14.6 性价比排序

| 优先级 | 改进 | 成本 | 收益 |
|---|---|---|---|
| **先做** | 锁文件 + sha256 校验 + 发布门禁 | 低–中 | 直接减少“装坏了/装到旧包/没验就发”的事故 |
| **先做** | 保留用户插件 + 升级前提示 | 中 | 解决固定 profile 升级最痛的用户数据/能力丢失 |
| **先做** | 插件展示元数据（locale/icon/detail） | 低 | 插件页从“半成品”变成“能看懂” |
| **先做** | 包版本随 suite 递增 / 内容 hash | 低 | 让 tarball、manifest、问题报告能对应到真实代码 |
| **随后** | doctor 深度（preset/版本/controller self-test/诊断包） | 中 | 把支持成本从“远程猜”变成“用户一键给证据” |
| **随后** | policy 生成 + 每宿主版本 smoke | 中 | 降低 DSH 升级导致 preset invalid 的概率 |
| **随后** | TIA/PLCSIM 默认配置（prewarm/timeout/keepInstances） | 低 | 减少“开箱体验不对”的调参 |
| **可缓** | app layer 去重 / 引擎可选下载 | 高 | 省体积，但可能牺牲离线；先量收益 |

---

## 15. 关键插件逐项分析

### 15.1 `@automation-suite/tia-openness-v17`

**分发上最容易出问题的点：**

1. **启动即预热**：宿主行 `src/index.ts:148` 在控制器存在时无条件 `controller.prewarm()`；桌面 App 一启动就拉起控制器/Openness 探测。
   对“偶尔用 TIA”的用户，这是启动延迟和资源占用。建议加 `prewarm` 配置（默认 false），
   recipe 里对重度用户开 true；或只在 `/tools` 行被挂载时预热。
2. **默认超时 300 s**：`src/config.ts:37`。大工程导出/编译超过 5 分钟很常见；现在靠文档让用户手改
   `cordis.patch.yml`。建议发行版 profile 默认 900000，或在 doctor 里按项目规模提示。
3. **族成员/版本**：包里只有 V17；doctor 不检查“启用的 TIA 族成员数恰为 1”。
   V18 到来前要补 D36 的 `claimFamily` + doctor 检查，否则两个成员同时装会争服务。
4. **控制器自检**：`test:controller` 存在，但不在 `pnpm -r test`/发布清单里；doctor 也不跑。
   建议构建/安装后跑 `TiaOpennessV17Min.Controller.exe --self-test`，把 bitness/Openness 缺失提前暴露。
5. **技能与矩阵**：`skills:check`/`matrix:check` 只在 `npm run check` 里；发布清单只跑 test。
   31 个 skill、391 条覆盖矩阵如果过期，tarball 里就是错的文档。建议发布门禁跑 `check`。
6. **Windows x64 前置**：控制器是 Windows x64 + .NET Framework 4.8 + TIA V17 + Openness 组；
   包没有 `os`/`cpu`。npm/跨平台安装会“装上但永远失败”。建议加字段 + 安装器 preflight。
7. **工具面 39 个**：全量装进 leader，常驻上下文成本高；能力行拆分（project/blocks/hardware/online/safety）
   可以让 recipe 按需授权，也降低误用风险（D31 的行级方向）。
8. **展示元数据**：无 `locale`/`icon`/`detail`；Plugin Manager 只能显示包名和英文 description。
   对“关键插件”尤其值得补中文标题、一句话说明、详情页图标。

### 15.2 `@automation-suite/engineering-context`

1. **宿主行注册工具，profile 再禁用**：主行 `src/index.ts:64` 注册 7 个工具；发行版蓝图
   `engineering-context` 行 `disabled: true`，实际工具由 `auditor` preset 挂载。这个“装了但默认禁用”的
   组合很脆弱：用户改 profile/换 recipe 很容易把 7 个工具重新暴露到宿主面。建议主行改成无工具宿主行，
   工具全部拆到 `./create`、`./status`、`./sync`、`./commit` 等行。
2. **硬依赖 TIA + git**：`create-project.ts:1102-1122`。发行版必须同时有 TIA 宿主行和 git 宿主行；
   doctor 只检查包目录，不检查这两个服务是否在组合里。建议加 composition check。
3. **图谱是软依赖但影响体验**：`create_engineering_project` 会尝试建库；图谱插件/引擎缺席时只报“未建成”。
   发行版应保证图谱包在 recipe 里，doctor 检查引擎 + `knowledgeGraph` 行。
4. **工件 schema**：`_evidence.json` 严格 v1；`_dsh-engineering-context.json` 有 v1；
   `versions-view.json` 没有 `schemaVersion`。升级后旧工作区/旧面板可能出现“解析失败”。
   建议所有跨包工件统一版本字段 + 迁移说明。
5. **Excel/依赖**：`@e965/xlsx`、`fast-xml-parser`、`fflate` 需要在 profile 里安装；
   桌面 app layer 离线已覆盖，Web 安装依赖 registry。发布门禁应校验这些依赖实际可加载。
6. **展示元数据**：同 TIA；建议补 `locale`/`icon`/`detail`，把“它做什么、需要什么”写在插件页。

### 15.3 `@automation-suite/engineering-graph`

1. **39 MB 自包含引擎**：`build-distribution.mjs` 每次发布用 .NET 10 `dotnet publish` 生成；
   构建完没有先跑 `--self-test` 再打包。建议 pack 前跑一次 self-test（不设 `DOTNET_ROOT`），
   失败就阻止发布，而不是等用户机器上 doctor 才发现。
2. **OS/架构**：引擎是 win-x64；包没有 `os`/`cpu`。建议加字段；如果将来上 npm，这是必须的。
3. **体积/重复**：app layer 同时有 tarball 和 node_modules 解包副本；每版约 137 MiB。
   可考虑共享 cache、delta、或把引擎作为可选下载资产（带 sha256）；但离线是当前卖点，别为了省体积牺牲它。
4. **数据库 schema**：图谱 schema 版本是引擎计算的，不是 DB 里的显式 `user_version`；
   引擎升级后旧 DB 可能需要重建。建议在 `knowledge_schema`/`doctor` 里给出“旧库需重建”的明确提示。
5. **配置/preset**：`includeIngest`/`includeDrilldown` 由 preset 行控制；发行版应校验
   leader/auditor/expert 三处配置符合预期（当前蓝图是手写的）。
6. **展示元数据**：无 locale/icon/detail；对“知识图谱”这种抽象能力，一句话说明尤其重要。

### 15.4 `@automation-suite/plcsim-advanced`

1. **API 探测**：doctor 只检查 `API\4.0\Siemens.Simatic.Simulation.Runtime.Api.x64.dll` 是否存在；
   PLCSIM Advanced V7 可能安装的是更高 API 版本。建议枚举 4.0–7.0，并报告实际版本。
2. **控制器自检**：`controller` 有 `--self-test`，doctor 不跑；建议加，提前发现 bitness/API 缺失。
3. **实例生命周期**：`keepInstancesOnUnload` 默认 true；桌面 App 退出后虚拟实例仍驻留。
   发行版 profile 应显式配置并在 README/详情页说明“退出应用不等于关仿真”。
4. **F-CPU 与证书**：这是产品边界，不是 bug；但应在插件详情页/首启提示里写清
   “F-CPU 不能用标准型号、首次连接要在 TIA UI 点一次 Connect、快照 resume 可跳过”。
5. **Windows x64**：加 `os`/`cpu` 或安装器 preflight。
6. **展示元数据**：无 locale/icon/detail；建议补。

### 15.5 `@automation-suite/dsh-tool-git`

1. **vendor 维护**：上游 `v0.1.3` 的压平副本；版本/commit/许可要可追溯。建议加
   `UPSTREAM.md`/同步脚本，并在发布 manifest 里记录上游版本。
2. **名字冲突**：npm 上 `@automation-suite/dsh-tool-git` 已被占用；npm 路线前改名 `@automation-suite/dsh-tool-git`
   或只走 tarball。桌面 profile 目前不受影响。
3. **破坏性策略**：`destructivePolicy` 默认值要明确；发行版 profile 应显式写 `deny`/`allow`，
   不要依赖默认值。
4. **展示元数据**：无 locale/icon/detail；对“会执行 git 写操作”的插件，详情页应写清危险边界。

### 15.6 `@automation-suite/pdf-drawing` 与 UI 插件

- **打包**：`@automation-suite/pdf-drawing` 的 `files: lib` 已包含 `lib/viewer`（pdf.js、字体、viewer.html/css/js）；
  `@automation-suite/ui-prompt-guide` 的 `files` 含 `page`。这几项目前是完整的，但发布门禁应加
  “tarball 内容断言”，防止以后改 `files` 时漏掉。（首页品牌的内联图标已随 `ui-brandmark` 一起移除，见 D40。）
- **UI 座位**：所有 UI 包依赖 `@deepseek-ai/dsh-client-*` 座位；doctor 不检查目标 profile 是否含这些行。
  建议加一个“UI seat smoke”（真实 web profile 里断言面板出现）。
- **展示元数据**：所有 UI 包都没有 `locale`/`icon`/`detail`；`@automation-suite/ui-hardware` 连 README 都没有。
  这是“插件页看起来像半成品”的直接原因，成本很低，建议优先补。
- **离线依赖**：drawing 依赖 `@hyzyla/pdfium`/`unpdf`/`pngjs`；桌面 app layer 已物化，Web 安装需要 registry。
  如果保留 Web 渠道，必须带 lockfile/离线包。

---

## 16. “核心随 profile 打包 + 可选插件走 npm”是否可行

**结论：可行，而且比“全独立”和“全 profile”都更符合当前 DSH 的架构。**
但有一条硬约束必须先解决，否则“插件页随时装”会变成“装上了但没有工具”。

### 16.1 先纠正：DSH 允许改/建 preset，但一次只能有一个“组合所有者”

你记得没错，我上一条把“不能追加”说成了“不能修改”，这不准确。DSH 的文档写得很明确：

- **可以新建 preset**：bundle patch `insert` 一个 `@deepseek-ai/dsh-agent-preset` 行；
- **可以覆盖已有 preset**：用 `- id: preset-leader` 的 patch 覆盖它；
- **可以在会话里创建自定义 preset**：Creator mode 会“在对话里生成这样的 bundle，再用
  `plugin_manager` 装进 profile”——落地形态是 bundle，不是直接改注册表
  （`@deepseek-ai/dsh-agent-preset-registry` README：“The registry writes no declarations …
  Creator mode authors such bundles in conversation.”）。

**但“改”和“追加”是两件事：**

- 带 `id` 的 patch 会**整块替换** `config`，不做 deep merge（`dsh-app-boot` README：
  “A user patch replaces the whole matched config — an id-targeted patch does not deep-merge”）；
- preset 的 `config.plugins` 是对象字段，不是原生 group；patch 层的 `buildMap` 只递归
  `entry.group && Array.isArray(entry.config)`（`cordis-plugin-include/src/patch.ts`），
  而 preset 的子列表由 `agent-preset-registry` 单独 mount，**profile patch 不会进去**。
  因此也不能靠“往 preset 里的 group insert”来追加。

所以真实限制不是“不能碰 preset”，而是：

| 操作 | 是否可行 |
|---|---|
| 新建一个自定义 preset | ✅ bundle `insert` 一个 preset 行；Creator mode 可在会话里生成 |
| 覆盖 `leader` / 改写它的完整子列表 | ✅ `- id: preset-leader` + 完整 `config` |
| 往已有 preset 的 `config.plugins` 追加**一行** | ❌ patch 层不进入 preset 子列表；只能整块重写 |
| 多个可选插件各自追加自己的工具行，且自动合并 | ❌ 每个覆盖都会整块替换；最后一个生效 |
| 在会话里创建 preset | ✅ Creator mode 生成 bundle 并安装；不是直接写注册表 API |
| 多个可选插件各自新建 preset | ✅ 但会得到多个 preset，用户得自己选；不会自动合成一个 |

**因此需要一个“组合所有者”**：它知道当前选中了哪些可选插件，生成一份完整的 preset 列表。
四种做法：

1. **Composer（安装器 / Creator mode / 核心组合插件）**：读已选插件的元数据，生成
   `preset-leader`（以及 auditor/expert）的完整 config。安装器负责初次勾选；插件页后装时
   触发一次“重新组合”（Creator mode 或核心 composer），然后重启。
   **这是最适合“真正 npm 可选”的路线**，代价是装/卸后多一步“应用组合”。
2. **预声明 + 代码随核心**：核心 preset 预先写所有已知可选工具行；可选包代码始终安装，
   勾选/插件页只启用/停用宿主行。**零组合步骤**，但可选包不是“真 npm 可选”，且包必须在
   `node_modules`（否则 preset 行 import 失败）。
3. **每个可选插件自带一个 preset**（`leader+plcsim`、`leader+drawing`）：装一个就能选；
   多个插件会得到多个 preset，用户自己选，或再用 Creator 合成一个。
4. **核心 tool broker**：broker 行在 leader preset，可选包宿主行提供 `toolProvider` 服务，
   broker 动态注册/注销工具。**真正 npm 装 + 最小权限**，但要新增核心插件/契约，
   并处理卸载、重启、同名工具；不建议第一版做。

**前置条件（对第 2 条）**：当前 TIA / PLCSIM / 图谱的 `/tools` 行仍是模块级 `inject` 服务
（`tools-entry.ts`），服务缺席时行会 `pending`，preset 会 invalid。必须先落地 D36 第 5 条：
去掉模块级 runtime inject，在 `apply()` 里主动取服务，缺席时注册 0 个工具并打 info 日志。

### 16.2 这如何改变“core + optional”的建议

如果接受“装/卸后应用一次组合”，**Composer 路线**可以做到真正的 npm 可选：
可选包不需要随核心安装，只要每次选择变化后重新生成 preset。插件页安装后提示
“已安装，点此应用组合 / 重启”，由 Creator mode 或核心 composer 完成。

如果不接受额外步骤，**预声明 + 代码随核心**更稳：可选工具行始终在 preset 里，
包始终在 `node_modules`，勾选只控制宿主行启用。代价是安装包更大，且“卸载”只能停用。

**不要做**：让每个可选插件各自覆盖 `preset-leader`。单装一个时能用；装第二个时
最后一个覆盖，前一个的工具行消失。这是最隐蔽的坑。

### 16.3 建议的 core / optional 划分

| 类别 | 包 | 安装/启用方式 | 理由 |
|---|---|---|---|
| **Core（随 profile 打包并启用）** | `@automation-suite/tia-openness-v17` | 始终安装 + 启用 | 接入层；`engineeringAccess` / `projectTextAccess` 服务 |
| | `@automation-suite/dsh-tool-git`（或改 scope 后） | 始终安装 + 启用 | `gitContext` + 破坏性命令守卫；工程上下文硬依赖 |
| | `@automation-suite/engineering-context` | 始终安装 + 启用 | workspace/版本工作流；硬依赖 TIA + git |
| | policy/preset 层（不是插件） | 始终 | persona、leader/auditor/expert、工具面分配 |
| **Bundled tool plugins（代码随核心，bundle 常驻，按需启用）** | `@automation-suite/engineering-graph` | 代码始终安装；bundle 始终在 `dsh.profile.bundles`；未勾选时用 profile patch 禁用宿主行 | 工具行在 preset 里；包不在 `node_modules` 会让 preset invalid。默认启用 |
| | `@automation-suite/plcsim-advanced` | 同上；默认禁用宿主行 | 同上；需要 PLCSIM 许可/API，默认不启用 |
| **真正 npm-optional（可随时装）** | 全部 `dsh-ui-*` | 安装器勾选或插件页 npm 装 | 纯 UI/客户端；无模型工具，不依赖 preset 行 |
| | `@automation-suite/tia-todo-bridge` | 安装器勾选或插件页 npm 装 | 宿主事件监听，无工具/服务；装完即生效 |
| | `@automation-suite/pdf-drawing` | 安装器勾选或插件页 npm 装 | 工具在宿主行（所有 agent 继承）；无 preset 行，装完即可用 |

> **为什么 graph/PLCSIM 不按“真正 npm-optional”处理**：它们的 `/tools` 行在 preset 里。
> 包不在 `node_modules` 时，preset 行 import 失败 → preset invalid；包在但宿主行被禁用时，
> 工具行能解析并注册 0 个工具。所以“可选”对它们是**启用/停用**，不是“下载/不下载”。
> 这条限制由 DSH 的 preset 机制决定，不是实现偷懒。

> 如果希望 PLCSIM/图谱也“随时 npm 装”，只能选 §16.1 的第 2 或第 3 条：
> 工具放宿主面（失去最小权限），或安装时改 preset（插件页做不到）。
> 不建议为了“装”的自由度牺牲权限边界。

> 如果图谱也做 optional，`engineering-context` 的 create 会跳过建库并明确报告“未建成”；
> 用户之后启用图谱、重启后可以补建。这条降级路径已经存在，所以图谱可以 optional，
> 但建议默认勾选。

### 16.4 安装器勾选怎么落地

下面先按 §16.2 的**零步骤方案（预声明 + 代码随核心）**写；如果选 **Composer**，
勾选项直接 `dsh plugin add` 真正安装，安装器最后调用 composer 生成完整 preset 即可，
其余流程相同。

- Inno 的 Components 页分三组：
  - **Core（不可取消）**：TIA + git + engineering-context + policy；
  - **Bundled tool plugins（代码必装，勾选 = 启用）**：图谱、PLCSIM；
  - **npm optional（勾选 = 安装）**：UI、drawing、todo-bridge。
- **Bundled tool plugins 不走 `dsh plugin add`**：它们的代码已经在 app layer 里，
  bundle 也已经写进 `dsh.profile.bundles`。勾选与否只决定是否在 profile patch 里加
  `- id: <宿主行 id> disabled: true`。这样：
  - 未勾选：包在 `node_modules`、bundle 在列表、宿主行 disabled → preset 工具行能解析并注册 0 个工具；
  - 勾选：不加 disabled → 宿主行加载，工具行注册工具；
  - 千万不要“未勾选就不装包”——包不在 `node_modules` 会让 preset 行 import 失败。
- **npm optional 走 `dsh plugin add`**：只有它会把 bundle 追加进 `dsh.profile.bundles`；
  只改 `package.json` 不够。
- 可选包如果从 npm 拉取，安装时需要网络；如果要求离线：
  - 把可选 tarball 放进 app layer 的 `optional/`，用本地 tarball 安装；
  - 但可选包的依赖（如 drawing 的 pdfium/unpdf/pngjs）也要一并离线，否则 `dsh plugin add` 仍要 registry。
  - 更简单的折中：安装器只负责 core + bundled tool plugins；UI/drawing 在联网时从插件页装。
- 安装完所有可选项后再跑 `normalize-profile-pnpm.mjs`，保证 Plugins 页后续还能 `pnpm add`。
- 每个可选项安装失败不能让整个安装失败：记录失败项，doctor 报出来，core 仍可用。

### 16.5 插件页随时装怎么落地

同样分两条路：

- **Composer 路线**：可选包真正 npm 安装；装/卸后由 Creator mode 或核心 composer
  重新生成 preset，然后重启。这是“真正随时装”的代价。
- **零步骤路线**：带工具的可选包代码已随核心安装，插件页只做启用/停用；UI/drawing/todo
  仍然可以真正 npm 安装。

- 插件页的 Add plugin / Discover 走 `plugin_manager` 的 `install_bundle`；它接受 registry 包名/安装 spec
  （页面是否直接给出包名输入框取决于目标 DSH 版本，需实测）。可选包发布到 npm 后，
  用户输入包名或从市场索引点装。
- **UI/host-only 包**（UI、drawing、todo-bridge）：装完通常 HMR 即可生效；最稳妥仍是刷新/重启。
- **带模型工具的包**（PLCSIM、图谱）：它们的代码应随核心安装，插件页只做**启用/停用 bundle**，
  不做 npm 安装。启用后需要**重启客户端**，让 preset 子树重新挂载；未启用时工具行注册 0 个工具。
  如果包根本不在 `node_modules`，不要从插件页安装它——preset 行会 import 失败。
- **卸载**：对真正 npm-optional 的 UI/drawing/todo，`remove_bundle` 后宿主行消失，工具行回到 0；
  数据（快照/图谱库）保留，按包文档清理。
  **对图谱/PLCSIM 这类 preset 已预声明工具行的包，不要 `remove_bundle`/卸载包**：
  包从 `node_modules` 消失后，preset 行 import 失败，整个 preset 会 invalid。
  它们只能“停用宿主行”，代码留在磁盘上；要真正卸载，必须同时更新核心 preset（核心版本更新时做）。
- **兼容性**：可选包声明 `engines.dsh` 和自定义元数据（例如 `requiresSuite: ">=0.3.0 <0.4.0"`）；
  插件页/doctor 在装前检查；不满足就拒绝或明确警告。DSH 没有服务依赖求解器，
  所以不要指望 `peerDependencies` 自动解决 `engineeringAccess`/`gitContext`。
- **市场索引**：发布一个 `plugin-market` 索引（标题、描述、图标、版本、兼容范围），
  用户在 Discover 页看到的是“图纸/面板”等真正可 npm 装的可选项；
  图谱/PLCSIM 如果做成“随核心启用”，就在插件页的已装列表里显示，不放进市场索引的“安装”项。

### 16.6 最容易被忽略、但会毁掉这个方案的一点

**核心 profile 升级必须保留用户后装的可选包。**

当前 `install-profile.ps1` 会整体替换 profile，只合并 `cordis.patch.yml`；
用户后装的 `package.json` 依赖和 `dsh.profile.bundles` 条目会丢。
如果采用“core + 可选 npm”，升级一次核心就把用户的可选插件全清掉，这个方案不可用。

所以必须做：

1. 升级前读取旧 profile 的 `package.json` 直接依赖与 `dsh.profile.bundles`；
2. 把“非核心”的依赖和 bundle 条目合并进新 profile；
3. 如果版本不兼容，保留旧版本并让 doctor 报“可选包需要升级”，不要静默删掉；
4. 记录 `user-plugins.json` 作为恢复清单；
5. 测试：装 core + 两个可选 → 升级 core → 两个可选仍在、面板/工具仍在。

### 16.7 包名与发布

- 可选 UI 包目前是不带 scope 的 `dsh-ui-*`；发布前要确认 npm 名可用，或统一改成 `@automation-suite/ui-*`。
  改名要同步 `cordis.patch.yml` 的 `insert[].name`、蓝图 bundles、测试。
- `@automation-suite/dsh-tool-git` 是 core，不一定要上 npm；如果将来 core 也走 npm，必须先改名。
- 可选包版本建议先跟 suite lockstep；稳定后再允许独立 patch，但要在市场索引/doctor 里写兼容范围。

### 16.8 验收矩阵

| 场景 | 期望 |
|---|---|
| 只装 core | 新会话能起；可选工具行存在但注册 0 个工具；无 preset invalid |
| core + 图谱（安装器勾选） | 重启后 `knowledge_*` 工具出现；expert 可用 |
| core + PLCSIM（插件页后装） | 重启后 `simulation_*` 出现；卸载后消失 |
| core + 所有 UI | 所有面板出现；缺生产者时是空态，不是报错 |
| core 升级 | 后装的可选包与面板仍在；doctor 无缺失 |
| 可选包版本不兼容 | 插件页/doctor 拒绝或明确警告，core 仍可用 |
| 离线安装 | core 可离线；可选包若离线不可用，要明确提示“联网后从插件页安装” |

---

### 16.9 Composer 覆盖不到的地方

Composer 只解决“最终 preset 的完整 config 由谁生成”。它不是依赖求解器，也不是事务系统。
以下方面仍然需要单独设计；标 **P0** 的是会直接让“装了但不可用”的。

| 方面 | Composer 是否覆盖 | 残余风险 | 需要补什么 |
|---|---|---|---|
| **已有会话** | ❌ | 已存在的 Agent 保留创建时的 composition；Composer 改 preset 只影响新 Agent | 明确“装完 → 重启 → 新会话”；不要承诺旧会话会变 |
| **默认/自定义 preset** | ❌ | 用户可能选 `minimal`/`auditor`/自建 preset；只改 `leader` 时这些会话没有可选工具 | 要么 compose 所有相关 preset，要么文档写清“可选能力只在 leader”；自建 preset 需要用户自己组合 |
| **子 agent preset** | ❌ | `expert`/`auditor` 的工具行、`subagent.allowedAgentPresets`、`agentPreset` 默认值都是独立配置 | Composer 必须同时更新三个 preset 与 `allowedAgentPresets`，不能只改 leader |
| **角色化工具行** | ❌ | 同一个包在不同 preset 要不同行/配置（如图谱 `includeIngest` 只给 auditor、下钻只给 expert） | 元数据不能只写 `rows.tools`，要写 `placements: { leader, auditor, expert, config }` |
| **命令 / skill / prompt / persona** | ❌ | Composer 只加插件行；`/tia-*` 命令、skill provider、prompt section、persona 可能是另一行或另一平面 | 贡献类型要分类：tools / commands / skills / prompt / persona / client；Composer 逐类处理 |
| **服务隔离** | ❌ | 如果可选包在 preset 内提供服务，provider 与 consumer 必须在同一 `isolate` realm；否则 registry 以 `Preset services require isolate realms` 拒绝 mount | 元数据声明 service/isolate 需求；Composer 生成 `cordis:group` + `isolate`，不能只加工具行 |
| **重名工具** | ❌ | 两个可选包或核心包注册同名工具；`NamedEntries` 同作用域抛错 | 构建期/安装期做 tool-name 碰撞检查；冲突就拒绝组合，不能靠运行时才发现 |
| **安装/卸载事务** | ❌ | 先装包后 compose 失败 → 包在、preset 没行；先删行后卸包失败 → 行在、包没了 → preset invalid | 顺序固定 + 事务：install → compose → validate → commit；卸载反向；失败回滚 |
| **核心升级** | ❌ | Composer 如果只“在旧 leader 上追加”，会漏掉新核心的 `standard` 行；如果整份重写，可能覆盖用户/新政策 | 保存版本化 base manifest；每次从“新核心 base + 当前可选贡献”重新生成，并与用户层三方合并 |
| **用户手改 preset** | ❌ | 用户自己改过 `preset-leader` 或自建 preset；Composer 重写会丢失用户改动 | 独立 managed 层 + 三方合并；或明确“policy 归发行版，用户只改设置，不改 preset” |
| **安装器/插件页两个写者** | ❌ | 安装器、插件页、Creator mode、用户手改都可能写 profile/preset；没有统一锁 | 单一写入口（安装器或核心 composer 服务）；写入用原子写并与 HMR 串行 |
| **HMR / 热更新** | ❌ | 新 bundle 可热激活，但 preset 子树是否重挂没有保证；已有 Agent 不会换 composition | 要求重启；Composer 不能承诺“装完立即生效” |
| **版本兼容** | ❌ | 可选包版本与核心 suite 版本可能不匹配；`engines.dsh` 只管宿主，不管服务契约 | `requiresSuite` + 服务契约版本 + 组合矩阵测试；不兼容时拒绝组合 |
| **上下文预算** | ❌ | 把所有可选工具都加进 leader，39 个 TIA 工具 + 可选工具会让常驻上下文和误用风险上升 | 支持“按任务多个 preset”（leader-minimal / leader-full），而不是一个无限大的 leader |
| **UI / client 侧** | ❌ | Composer 改的是 preset；UI 包还要 client bundle、seat、locale、路由 | client 侧单独装/启用；doctor 做 seat smoke |
| **离线/网络** | ❌ | “先 npm 装再 compose”需要网络；离线安装要可选 tarball + 依赖 | 离线可选包/延迟安装；失败时保留 core 可用 |
| **安全/信任** | ❌ | 装插件本身就会执行 Host 代码；Composer 自动把工具授予 leader 会放大影响 | 安装/组合前明确确认；可选包视为可信代码，不是安全边界 |
| **验证/回滚** | ❌ | Composer 生成的 preset 可能 mount 失败；`--dump-config` 通过不代表 preset 能挂载 | 提交前做“新会话 smoke”（至少 mount/audit）；失败回滚到上一个 composition |

**最危险的三条：**

1. **核心升级 vs Composer 输出**：如果 Composer 的输出被当成用户覆盖层，安装器的三方合并可能保留旧 leader，
   导致核心政策更新失效；如果安装器整份替换，又可能清掉可选行。必须有“managed composition 层”的明确所有权。
2. **安装/卸载事务**：包与 preset 行必须同进同退；任何一步失败都可能留下 `preset invalid`。
3. **已有会话 / 默认 preset / 自定义 preset**：Composer 只影响“新 Agent 使用被它改过的 preset”；
   用户选别的 preset、或继续用旧会话时，会看到“插件装了但工具不在”。

**Composer 还必须做的事（清单）：**

- 读 **版本化 base manifest**（核心 leader/auditor/expert 的完整行），而不是在旧 config 上 append；
- 读每个可选包的 **placements**（哪个 preset、哪些行、什么 config、是否需要 isolate）；
- 合并后做 **tool/command 重名检查**、**service/isolate 检查**、**包存在性检查**；
- 用 **managed 层**写入（profile patch 或专用 bundle），并与安装器/用户层做三方合并；
- **事务化**：install → compose → validate（新会话 mount）→ commit；失败回滚；
- 输出 **composition report**（加了什么、为什么、哪些 preset 变了），让用户能看懂；
- 对“用户自建 preset”只提供“复制一份再组合”的工具，不自动改用户私有 preset；
- 每次核心升级后重新生成，不能把上一次的合成结果当成新 base。

**结论**：Composer 能解决“谁写最终 preset”，但解决不了“会话生命周期、角色化 placement、非工具贡献、
安装事务、所有权/升级、上下文预算”这些组合层问题。它必须和 **managed 层 + 事务 + 验证 + 版本化 base**
一起设计，否则只是把“装不上”换成了“装上了但某些 preset/会话里没有”。

---

## 17. 相关文件

- [`distribution.md`](distribution.md) — 三种打包方案、安装面、已知限制
- [`decisions.md`](decisions.md) — D10 / D23 / D30 / D31 / D36
- [`tia-version-members.md`](tia-version-members.md) — 族契约、为什么重启、待实测项
- [`architecture.md`](architecture.md) — 接口插件族与两个工程插件的目标架构
- [`desktop-packaging.md`](desktop-packaging.md) — 固定 profile、app layer、安装器合并
- [`releases.md`](releases.md) — 发布检查清单与版本规则
- 根 `AGENTS.md` §1 — 政策层为什么在 profile 里、patch 语义、preset 工具面
- 各包 `README.md` / `AGENTS.md` — 单包职责、命令、边界
