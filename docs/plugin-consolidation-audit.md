# 插件精简审计（发布前）：15 个包的职责、重叠与合并建议

> **状态：审计结论 + 提案，未改任何代码。** 审计日期 2026-11-24，基线 HEAD `5e657ac`（工作树干净）。
>
> **方法**：只读审计每个包的 `package.json` / `cordis.patch.yml` / `README.md` / `docs/*.md` / `src/`，
> 另用脚本核对**座位与路由注册**（`sidebarRightTabs`、`sidebar.right.pane.tab`、`sidebar.panellist`、
> `conversation.input.dock`、`conversation.hero.brand.mark`、`ctx.webServer.register`）与构建脚手架的哈希。
> **未构建、未跑测试**；下文的工具数来自源码里 `defineTool` 的声明，不是测试通过数。
>
> **与其它文档的关系**：[`plugin-independence.md`](plugin-independence.md) 回答"要不要拆得更小、能不能各自安装"；
> 本文回答**相反方向**的问题："能不能合得更少、边界是否还站得住"。
> [`tool-surface.md`](tool-surface.md) 回答"模型该看到多少工具"，与本文正交（见 §1.4）。

---

## 1. 结论

1. **15 个包 = 6 个能力载体 + 1 个体验兜底 + 8 个 UI。数量本身不是问题。** 问题在于**同一件事被实现了 2–5 遍**：
   右侧栏座位注册 5 份、宿主路由 trust fence 4 份、UI 构建脚手架 8 份（其中 3 份逐字节相同）、
   TIA 工具名清单 3 份、git 能力 3 处。
2. **只有一处是"同一个东西写了两遍"**：`ui-versions` 与 `ui-hardware` —— 同形态（读 `<cwd>/.dsh/<x>-view.json`
   → 解析 → 筛选/详情）、同座位、同空态/错误/刷新，`readTextFile` 逐字相同、构建脚本逐字节相同。**合并这一对是纯收益。**
3. 其余 UI 包的**骨架**相同但**契约**不同（有没有路由、是否改输入面板、是否消费宿主服务）。
   把它们全并成一个"右侧栏大包"，只会再造一个"什么都干"的包——正是本次审计要消灭的形态。
4. **比"减包"更值钱的两件事**：
   - (a) 把重复的脚手架 / 座位样板 / fence / 工具名清单收成**单一来源**（不减包，减维护面）；
   - (b) 减**工具面**：按蓝图累加，`leader` preset 常驻 **≈72 个工程工具**（TIA 39 + context 12 + git 12 + graph 5 + plcsim 4），
     `auditor` ≈24。**模型成本来自工具数，不来自包数。** 这条已由 [`tool-surface.md`](tool-surface.md) 提案，卡在 A14–A17 拍板。
5. 有 8 处"名称 ≠ 职责"或"文档 ≠ 实现"。文案类发布前顺手改；**`pdf-drawing` 与 `tia-todo-bridge` 两个包名建议在发布前改**
   （还没发 npm，此时改名成本最低；发出去再改要留迁移期）。

---

## 2. 现状：契约角色地图

| # | 包（目录） | 契约角色 | Loader 行 | 模型工具 | 服务 | 人类面（座位 / 路由） | 硬依赖 |
|---|---|---|---|---|---|---|---|
| 1 | `tia-openness-v17`（`-min`） | **能力：TIA 接入** | 3（`.`/`/tools`/`/commands`） | **39**（映射 40 个白名单操作） | `engineeringAccess`、`projectTextAccess`、`tiaOpennessRuntime` | 无座位；7 条 `/tia-*` 斜线指令 | 0 |
| 2 | `engineering-context` | **编排：工程作用域/账本** | 6（`.`、`/status`、`/diff`、`/handoff`、`/version`、`/version-read`） | **19 个不同工具**（28 条注册，5 个只读工具跨入口重复） | 无 | 无座位；产物 `.dsh/versions-view.json` | `engineeringAccess`、`gitContext`、`projectTextAccess`（硬），`knowledgeGraph`、`workspaceRegistry`（软） |
| 3 | `engineering-graph` | **能力：语义/图谱** | 2（宿主 + `/tools`） | **9**（5 核心 + 4 下钻，可裁） | `knowledgeGraph`、`knowledgeEngine` | 无座位；C# 引擎子进程 | 0（`inject=[]`） |
| 4 | `plcsim-advanced` | **能力：仿真接入** | 2（宿主 + `/tools`） | **4** | `plcsimRuntime` | 无座位；PLCSIM 自带 Control Panel | 0（只读 context 的落盘文件） |
| 5 | `pdf-drawing`（`dsh-drawing`） | **能力：图纸检索 + 自带 UI** | 1 | **5** | 无 | 右侧栏 **Drawing** + 输入框 dock + 静态路由 `/drawing-viewer` | 0 |
| 6 | `dsh-tool-git`（vendor） | **底座：git + 安全闸门** | 2（宿主 + `/tools`） | **12** | `gitContext` | 无座位 | 0 |
| 7 | `tia-todo-bridge` | **体验兜底：Todo 不空转** | 1 | **0** | 无 | 无座位（改宿主 Todo 面板） | 0，但**硬编码 32 个他包工具名** |
| 8 | `ui-plc-source` | UI：右侧栏 **PLC Blocks** | 1 | 0 | 无 | `sidebarRightTabs`（guide 100）+ `conversation.user.text.node` + `uiConversation.userText` | 读 `source/*/_manifest.json` |
| 9 | `ui-tia-console` | UI：输入框 **TIA 控制台** | 1 | 0 | 无 | `conversation.input.dock`（order 30） | 派发 `/tia-*`；硬编码 26 个工具名 |
| 10 | `ui-versions` | UI：右侧栏 **Versions** | 1 | 0 | 无 | `sidebarRightTabs`（guide 101） | 读 `.dsh/versions-view.json` |
| 11 | `ui-hardware` | UI：右侧栏 **Hardware** | 1 | 0 | 无 | `sidebarRightTabs`（guide 102） | 读 `.dsh/hardware-view.json` |
| 12 | `ui-changes` | UI：右侧栏 **Changes** | 1 | 0 | 无 | `sidebarRightTabs`（guide 102，**与 hardware 撞号**）+ 路由 `/changes` | `gitContext` |
| 13 | `ui-project-dashboard` | UI：左栏 **项目看板** | 1 | 0 | 无 | `sidebar.panellist`（order −10）+ `main` + 路由 `/project-dashboard/api/*` | `workspaceRegistry`；**写** `<DSH_HOME>/storages/project-dashboard/tags.json` |
| 14 | `ui-prompt-guide` | UI：左栏 **Prompt Guide** | 1 | 0 | 无 | `sidebar.panellist`（order 7）+ `main`（iframe）+ 路由 `/prompt-guide/*` | 无 |
| 15 | `ui-brandmark` | 外观：首页 hero | 1 | 0 | 无 | `conversation.hero.brand.mark` + 包装 `locale.translate` | 无（依赖非文档 API） |

**三类前缀、四种风格**：`tia-*`（2）、`ui-*`（8）、`engineering-*`（2）、其余单名（`plcsim-advanced`、`pdf-drawing`、`dsh-tool-git`）。

---

## 3. 职责重叠审计

### 3.1 结构重复（可量化，全部实测）

| 重复项 | 份数 | 证据 |
|---|---|---|
| 右侧栏 tab 注册样板（`ctx.inject(['sidebarRightTabs'])` + 两条 slot + `inject` 失败 warn） | **5** | `drawing`、`ui-changes`、`ui-hardware`、`ui-plc-source`、`ui-versions` |
| 宿主只读路由 + 自抄 trust fence（拒 cross-site、Host 限 loopback、Origin=Host） | **4** | `drawing`（`/drawing-viewer`）、`ui-changes`（`/changes`）、`ui-project-dashboard`（`/project-dashboard`）、`ui-prompt-guide`（`/prompt-guide`） |
| UI 构建脚手架 `scripts/{build,tsc,run-tests}.mjs` | **8** | 8 个 `dsh-ui-*` 包各一份；`ui-hardware`/`ui-plc-source`/`ui-versions` 三份**逐字节相同** |
| `readTextFile` 与客户端 `index.jsx` 首段 | **2+** | `ui-versions` 与 `ui-hardware` 完全相同 |
| `link-dsh-runtime.mjs` | **6** | 各包各自一份（宿主升级要改 6 处） |

> 账：8 份脚手架 ≈ 8 × 7.5 KB ≈ 60 KB 近重复代码；这不是"包多"造成的，是"没有共享层"造成的。
> **把脚手架抽到仓库级 `scripts/ui-plugin/`（或一个 private dev 包）就能消掉它，且不改安装粒度。**

### 3.2 同一批落盘事实被 2 处以上渲染

| 落盘事实 | 生产者 | 消费者 |
|---|---|---|
| `source/*/_manifest.json` | `tia-openness-v17`（`rebuildSource`） | `ui-plc-source`、`engineering-graph`（新鲜度）、`engineering-context`（/status） |
| `source/_dsh-engineering-context.json` | `engineering-context` | `plcsim-advanced`（provenance）、`engineering-graph`、`ui-project-dashboard`(P2) |
| `source/<device>/_evidence.json` | `tia-openness-v17`（`SyncScan`） | `engineering-graph`、`engineering-context`、`plcsim-advanced` |
| `.dsh/versions-view.json` | `engineering-context`（`src/version/view.ts`） | `ui-versions`、**`ui-project-dashboard`(P2 计划)** |
| `.dsh/hardware-view.json` | `tia-openness-v17`（`hardware_view`） | `ui-hardware`、**`ui-project-dashboard`(P2 计划)** |
| `.dsh/drawing-manifest.json` | `pdf-drawing` | 本包面板、**`ui-project-dashboard`(P2 计划)** |

**结论**：前 4 行是干净的"一个生产者、多个只读消费者"（**这是对的**，属于"同一份事实的第二消费者"）。
风险在最后三行的 `ui-project-dashboard P2`：它计划把别人已经在渲染的四格**再渲染一遍**，
这才是真正会失控的重叠。**建议 P2 不做成"汇总四格"，改为"跳转到对应 tab"。**

### 3.3 单一事实被三处硬编码（最典型的一致性债）

`TIA 工具名清单`：

| 位置 | 数量 | 后果 |
|---|---|---|
| `tia-openness-v17`（真源） | **39** | — |
| `ui-tia-console/src/client/model.js` `TIA_TOOL_NAMES` | 26 | 缺 v0.3 的硬件/编辑器/库/在线工具 → 这些操作在状态条上"盲" |
| `tia-todo-bridge/src/bridge.ts` `TRACKED_TOOLS` | 32 | 且**不含 `simulation_*`** → 分钟级仿真操作不进 Todo |

同样的问题还有：`ui-versions` 硬编码 `FACES=['Code','Interface','Comments','Properties']`、
`ui-hardware` 硬编码 `ROLE_ORDER` 与 `F-` 前缀判 F 模块——**都在猜生产方的词汇**。

### 3.4 能力三处并存

| 能力 | 三处 | 说明 |
|---|---|---|
| git | `dsh-tool-git` 的 12 个模型工具 / `gitContext` 服务 / `engineering-context` 自带的 `src/git.ts` runner | 同一件事三种通道；`engineering-context` 同时"消费 `gitContext`"又"自带 runner" |

`engineeringAccess`（12 方法）与 `projectTextAccess`（7 成员）在 TIA 侧实现、在 context 侧**镜像声明**，
两侧必须同步改——这是有意的解耦（D10），**不建议合并**，但应加一条契约校验（见 §6.3）。

### 3.5 文档口径已经挡不住新功能

`architecture.md:21` 给 UI 视图包的定义是：**「不新增子进程、不新增 HTTP 路由、不注册模型工具」**，
`architecture.md:41` 的准入标准是**「只读、且不改变任何已落盘的东西」**。现实：

| 包 | 违反哪条 |
|---|---|
| `ui-changes` | 新增路由 `/changes` |
| `ui-project-dashboard` | 新增 2 条路由，且**写** `<DSH_HOME>/storages/project-dashboard/tags.json` |
| `ui-prompt-guide` | 新增静态路由 `/prompt-guide/*` |
| `ui-plc-source` | 宿主 `agent/pre-step` 监听，**把内容追加进模型输入** |
| `pdf-drawing` | 5 个工具 + 路由 + 两个座位（它是能力包，却按 UI 包的方式交付） |

**这不是要批评这些包**——它们各自都有理由（见 `roadmap.md:48-52` 对两条只读路由的说明）。
问题是：**按现行定义，一个新功能该不该进"视图类"，已经没有可用的判据了。** 这是"扩展界限不清晰"的根因，
比包数量重要得多。§6 给出一棵可执行的判定树。

---

## 4. 命名审计

| 包 | 问题 | 建议 |
|---|---|---|
| `tia-openness-v17` | **目录**名 `dsh-tia-openness-v17-min` 带 `-min`，包名不带；`-min` 暗示"最小能力"，实际 39 工具/40 操作，含项目库、硬件组态、在线下载 | 目录改名 `dsh-tia-openness-v17`（包名不动，零发布影响） |
| `pdf-drawing` | 名字写的是**输入格式**（PDF），职责是"电气图纸入库/检索/查看"；目录 `dsh-drawing` 与包名不一致 | **发布前**改包名 `@automation-suite/drawing` |
| `tia-todo-bridge` | 名字限定 TIA，实际跟踪 TIA 22 + context 8 + graph 2 = 32 个工具；且未覆盖 `simulation_*` | **发布前**改 `@automation-suite/todo-bridge`，并把仿真 4 个工具纳入 |
| `engineering-context` | 名字只说"上下文"，实际含版本库、交接（handoff）、文本翻译共 19 工具 | 保留（它确实是作用域所有者），但 README 首句要写清 5 个子域；或改名 `engineering-workspace` |
| `ui-project-dashboard` | 名字说 project，实际是 **workspace** 聚合（"工程 = 一个 workspace"的映射在 context 里） | `ui-workspaces` |
| `ui-tia-console` | 叫 console，实际是**状态条 + 5 个生命周期按钮**，不显示日志/编译正文 | `ui-tia-status`（或补上日志视图再叫 console） |
| `ui-plc-source` | 展示的是**导出对象清单**（含拒导对象），不是源码；标题「PLC Blocks」才准确 | 保留包名，文档统一称 "PLC Blocks" |
| `dsh-tool-git` | 唯一带 `dsh-` 前缀，与其余 14 个不一致 | **保留**（与上游 `lxj808624/dsh-tool-git` 对照的价值大于一致性），在清单里标为"vendor 例外" |

---

## 5. 合并建议

### M1 · ~~必做~~ **已否决（2026-11-24）** ：`ui-versions` + `ui-hardware` → `ui-engineering-views`

> **决策：不合。** 理由（用户）：**这两个功能不一样** —— Versions 是版本时间线，Hardware 是机架/网络/信号组态，
> 只是恰好都读 `.dsh/*-view.json`。**"同形态"不等于"同职责"**，这条否决是对的：
> 判据应该是"这个包回答什么问题"，不是"它读什么文件"。
>
> 保留的观察仍然成立：两者共享座位样板与构建脚本，**这部分重复应通过共享脚手架消除，而不是并包**（§3.1）。
> 版本方向改为**把版本管理整体独立成一个包**，见 §9.2。

| 项 | 内容 |
|---|---|
| 依据 | 同形态（读 `<cwd>/.dsh/<x>-view.json` → 解析 → 筛选/详情/空态/重试）；同座位（`sidebarRightTabs` + `sidebar.right.pane.tab` + `.title`）；`readTextFile` 逐字相同；构建脚本**逐字节相同**（SHA 前三份一致）；测试结构相同（15 + 9 项） |
| 省下 | 1 个包、1 份构建脚手架、1 份座位样板、1 份样式注入、1 份字典骨架 |
| 代价 | 不能只装 Versions 或只装 Hardware（实际使用中两者几乎总是同装）；一个 bundle 装两页（体积 +，但只加载一次） |
| 风险 | 低。两页都是零路由、零服务、零写入；失败已被 `try/catch` 隔离 |
| 命名 | `ui-engineering-views`（两 tab）；或用 config `{ tabs: ['versions','hardware'] }` 控制 |
| 验收 | 两 tab 仍在、引导顺序连续（100→101→102）、各自空态/错误态不变；`pnpm test` 合并后仍全绿 |

> 顺带修掉：`ui-hardware` 与 `ui-changes` 的 guide order **都是 102**（撞号）。

### M2 · 可选（收益最大，风险最高）：右侧栏 4 个只读 tab → 1 个 `ui-workspace-panels`

对象：`ui-plc-source` + `ui-versions` + `ui-hardware` + `ui-changes`（15 → 11）。

- **省下**：3 个包、3 份脚手架、3 份座位样板、Changes 的路由可以收进同一个宿主入口。
- **代价**：① 安装粒度变粗（"只要 PLC Blocks"装不到）；② `@'块名'` 的 `agent/pre-step` 会对所有会话生效；
  ③ `gitContext` 依赖进入这个包（`ui-changes` 缺 git 时是 503 文案，需保持 fail-soft）；
  ④ 一个包的失败面从 1 个面板变成 4 个。
- **我的判断**：**先不做**。它减的是包数，付的是"契约不再单一"的代价——正好是本次审计要修的病。
  如果"发布单元少"是硬需求，再做；前提是 §3.1 的共享脚手架先落地（那样 4 个包已经很便宜了）。

### M3 · 可选（建议只做一半）：`ui-prompt-guide` + `ui-project-dashboard` → `ui-suite-shell`

- 相同点：同一对 root 座位（`sidebar.panellist` + `main`）、都自开路由、都是"发行版自身"的信息。
- 不同点：一个是**静态内容页**（iframe + `/prompt-guide/*`），一个是**工作区管理 + 写 `DSH_HOME`**。
- **判断**：合并只共享座位，收益小；但两者都应该被归入**新类别「发行版外壳」**（见 §6），
  并共享同一份 fence 与路由脚手架。

### M4 · **已定（2026-11-24）：删除** `ui-brandmark`，页面内品牌改由桌面壳注入（见 §9.1）

- 437 行，作用只有 3 个视觉元素（headline、preview 徽章、hero 图标），且包装了 `locale.translate`
  这个**非文档 API**（DSH 改名即静默失效）。
- 三个选项：① 删掉，接受 DSH 原生 hero（最干净，直接 −1 个包、−1 个升级风险点）；
  ② 并入 M3 的 `ui-suite-shell`；③ 保持独立。
- **决策**：删除。页面内三项的归属见 §9.1（桌面壳注入），不保留独立包、也不并进 `ui-suite-shell`。

### M5 · 明确不做（有文档级理由）

| 候选合并 | 为什么不 |
|---|---|
| `tia-openness-v17` + `plcsim-advanced` | **两个产品、两套 SDK、两套许可、两个子进程**；`simulation-plcsim-advanced.md:215` 已否决"塞进 TIA 控制器"；`plcsim-advanced/AGENTS.md:25-28` 写明"不是程序加载器、从不与 TIA Portal 对话"。合了会让"删掉仿真"变成"删掉 TIA" |
| `engineering-context` + `engineering-graph` | 运行时不同（纯 Node + 3 个 npm 依赖 **vs** C# 子进程 + 39 MB self-contained win-x64，打包需要 .NET 10 SDK）；依赖单向（graph `inject=[]`，**可完全无 TIA 独立建库**）；失败语义相反（graph 永不抛错 vs context 明确拒绝）；拆行拓扑不同（graph 必须"宿主+工具"防子 agent 继承，context 是 6 个按 preset 挂子集） |
| `pdf-drawing` 拆成"能力包 + UI 包" | 拆了要 3 行 + 2 个包，且图纸面板与解析强绑定（同一份索引）。**正确做法是承认"能力包可以自带 UI"并写进规则**（§6） |
| `tia-todo-bridge` 并入 `tia-openness-v17` 或 `ui-tia-console` | 它是**宿主面会话监听**（不改模型工具、不改客户端），并同时服务 context/graph 的工作流。并进能力包会让"Todo 策略"变成 TIA 包的职责；并进 console 会跨平面（host vs client） |

---

## 6. 扩展界限：新增功能该落在哪

### 6.1 判定树（写进 `architecture.md`，替掉现在挡不住的"只读"标准）

```
新功能要什么？
├─ 与外部产品（TIA/PLCSIM/其它工程软件）对话？
│   └─ 是 → 能力包。一个产品一个包；宿主行只放控制器+服务，模型工具走 /tools 行。
│           同产品的新能力写进同一个包（D31），不新建包。
├─ 解析工程文件语义（XML/块/交叉引用）？
│   └─ 是 → engineering-graph。解析逻辑在 C# 引擎里，TS 侧只做编排与工具面。
├─ 跨步骤工作流 + 落盘账本（谁在哪个版本、交接、翻译）？
│   └─ 是 → engineering-context 的新子入口（./<area>），由 preset 授权。不新建包。
├─ 通用底座（git/文件/进程/网络）？
│   └─ 是 → 独立包 + 服务；宿主行不注册模型工具（否则所有子 agent 继承）。
└─ 给人看的？
    ├─ 需要写任何东西（工作区/DSH_HOME/输入框）或新增路由？
    │   └─ 是 → 「发行版外壳」类：自带路由 + fence，必须 fail-soft；不进视图类。
    └─ 全否（只读已落盘产物）→ 「只读视图」类：
        0 工具 / 0 服务 / 0 路由 / 0 写入；数据只来自别人已落盘的产物。
```

**判据的一句话版本**：*"它读的东西是不是已经有人落盘了？读完会不会改变任何状态？"*
两个都是"是/否"答案决定它属于视图类还是外壳类。

### 6.2 每类的红线（防止职责漂移）

| 类 | 可以有 | 不许有 |
|---|---|---|
| 能力包（TIA/PLCSIM/graph） | 子进程、服务、`/tools` 行、自己的文档与 skill | 语义建模、workspace 管理、Todo/提示词策略 |
| 编排包（context） | 多子入口、落盘账本、读写别人的产物 | 直接调 Openness / 起控制器 / 解析 XML |
| 底座包（git） | 服务 + `/tools` 行 + 安全闸门 | 任何工程语义 |
| 体验兜底（todo-bridge） | 会话事件监听、`additionalContexts` | 注册模型工具、注册服务、改别人的清单 |
| 只读视图 | 座位注册、读产物、本地筛选 | 路由、写入、`agent/pre-step` 之类的输入改写 |
| 发行版外壳（dashboard/prompt-guide/brandmark） | 座位、路由 + fence、写自己的 `DSH_HOME` 存储 | 读工程产物的第二份渲染（应改为跳转） |
| 政策层 | profile 蓝图里的 persona/preset | 写成插件 |

### 6.3 让边界不再漂移的三条机械手段

1. **插件卡片（`package.json` 的 `dsh.plugin`）**：`role` / `provides` / `requires` / `rows` / `artifacts` / `seats`。
   这是 [`plugin-independence.md`](plugin-independence.md) §7.2 已提出的方案，**现在就该落地**——
   它同时是 doctor、文档生成与"组合矩阵"的输入。
2. **单一事实来源**：`TIA 工具名清单`、`face 词汇表`、`角色分组`都从**生产方**导出
   （工具名可进插件卡片；face/role 词汇应写进 `versions-view.json` / `hardware-view.json` 本体）。
   消费方不得再手写第二份——现在 3 份清单里已经有两份过期。
3. **契约校验进测试**：`ui-*` 包各加一条"我读的产物字段 ⊆ 生产方 schema"用例；
   `doctor.ps1 -Json` 增加"声明的 `requires` 在 profile 里是否存在"。

---

## 7. 发布前清理清单（与合并无关，但影响发布质量）

| # | 问题 | 证据 | 处理 |
|---|---|---|---|
| 1 | **`ui-plc-source` 的 manifest 路径契约不一致**：生产方写 device 相对路径，消费侧按绝对路径处理 → 「打开源文件」静默无操作、提及上下文丢 `file=` | 生产 `OperationsSync.cs:524,541`、`Operations.cs:826,845-860`（显式拒绝对路径）；消费 `model.ts:63-64,611`、`Panel.jsx:263-276` | **发布前定契约**（建议：manifest 里加 `fileBase`，消费侧按它拼），并加真机验收 |
| 2 | `ui-changes` 的 description / README 标题 / `guide.description` 都承诺"提交区"，实际 P2 未做、面板只读 | `package.json:8`、README:6-9、`client/index.jsx:14-16` | 改文案（或补 P2） |
| 3 | TIA 包的文档工具数三处不一致：`src/index.ts:22` / `tools-entry.ts` 写 "38 tools over 39 operations"（实为 39/40）；`docs/OUTPUT-CONTRACT.md` 只列 27 个却自称 39 | 源码与文档 | 发布前统一 |
| 4 | `engineering-graph` README 与根 architecture/roadmap 仍写"8 个工具、无增量、新鲜度未做"，实际 9 个 + `knowledge_update` + sidecar | `tools.ts:667`、`service.ts:210`、`graph-freshness.ts` | 改文档 |
| 5 | `ui-hardware` 与 `ui-changes` 的 guide order 都是 102 | 源码常量 | 改一个 |
| 6 | `ui-project-dashboard` 的 `package.json` description 宣称四格（工程规模/硬件/版本/图纸）已有，实际 P1 只有工作区+标签 | `package.json:8` | 改文案 |
| 7 | `plcsim-advanced` 的 `src/config.ts:5-7` 注释说 `networkMode` "deliberately absent"，schema 里已有 | 源码 | 删注释 |
| 8 | 根 `AGENTS.md` §4 与 `decisions.md` 的测试数过期（112/119/22 → 实测 121/23 等） | 各包 `test/` 计数 | 发布前重测并更新 |

> 另：`ui-plc-source` README 说"宿主半侧是一个空的 `apply()`"，实际已有 234 行宿主逻辑（清单缓存 + pre-step）。

---

## 8. 需要拍板

| # | 问题 | 我的倾向 |
|---|---|---|
| Q1 | 右侧栏只读视图要不要合并？ | ✅ **已定：不合**（功能不同）。重复的座位样板与构建脚本改用共享脚手架消除 |
| Q2 | `ui-brandmark` 保留 / 并入外壳包 / 删掉？ | ✅ **已定：删除**；页面内品牌改由桌面壳注入（§9.1） |
| Q3 | `pdf-drawing` → `drawing`、`tia-todo-bridge` → `todo-bridge` 两个改名是否在发布前做？ | **做**。未发 npm，此时成本最低 |
| Q4 | 插件卡片（`dsh.plugin`）+ 契约测试是否作为发布门槛？ | **是**。否则本次审计的结论三个月后照样漂移 |
| Q5 | 工具面（leader 常驻 ≈72 个）是否在发布前收一层？ | **至少把 TIA 的 39 个按 `tool-surface.md` 的 P0/P1 收成工作流层**；这比减包对用户价值的提升大一个量级 |

---

## 9. 两项已定改动（2026-11-24）

### 9.1 外观（品牌）从插件移到桌面壳

**现状盘点**：桌面壳**已经**承担了页面之外的全部品牌
（`desktop/DshSuite.Shell/MainForm.cs:39,55,68-69,79-82,452-455,548-550`、`Program.cs:25,43-44,57`）：
窗口标题、托盘图标与提示、关于对话框、错误对话框、Doctor 窗口标题、可执行文件图标
（`app.ico` 经 csproj 嵌入）。`TitleBarScript.js:52` 的菜单项就是"关于 DSH Automation Suite"。

`ui-brandmark` 改的只是**页面内**三项：首页 headline（`conversation.hero.headline`）、预览徽章
（`conversation.hero.preview`）、hero 图标（`conversation.hero.brand.mark` 槽位）。它靠包装
`locale.translate` 实现——**非文档 API**（DSH 改名即静默失效）。

**结论：删包，三项分开处理**：

| 元素 | 落位 | 说明 |
|---|---|---|
| 产品名（headline 的语义） | **已在壳里**（窗口标题/托盘/关于/标题栏菜单） | 零成本。首页保持 DSH 原生不算"品牌缺失"：用户进门第一眼看到的是标题栏 |
| hero 图标 | **壳注入**（可选） | 复用 `app.ico` 的 128px 版本，与安装器图标同源 |
| 预览徽章（`Preview` → `TIA-V17`） | **建议不做** | 桌面版是稳定发行版；"Preview"是 DSH 官方的产品状态语义，换成内部版本号信息量更低 |

**若要三项都保留**，注入通道是现成的：`MainForm.cs:21,240` 用
`AddScriptToExecuteOnDocumentCreatedAsync(LoadTitleBarScript())` 注入 `TitleBarScript.js`（csproj 嵌入资源）。
新增 `BrandScript.js` 走同一机制，**C# 侧约 5 行**。

**Spike 结果（2026-11-24）：路线 B = 纯 DOM，稳，采用 —— 已落地（D40），`packages/dsh-ui-brandmark/` 已删除。**

- 环境：本机 Edge 158 + 临时 `--profile web` 实例（3099，独立 `DSH_HOME`）；脚本用 Playwright
  `add_init_script` 在 **document-start** 注入 —— 与 `AddScriptToExecuteOnDocumentCreatedAsync` 同语义。
- 脚本：`%TEMP%\brand-spike\BrandScript.js`（**纯 DOM**：不碰 `__ModuleLoader__`、不碰 React、
  不碰 `locale`/`slots` 服务）。
- **13/13 检查通过**：三项替换成功；resize 风暴（1100→760→1440）后仍生效；外部把文本改回原生后**自愈**；
  空闲 3 s 内 **0 次重写**（观察者收敛）；全程 13 次 apply、无 console/page error；整页 reload 后仍生效。
- **关键发现**：hero 的 headline / badge 用的是**构建哈希类名**（`WOwLGG_*` / `an3WzG_*`），
  按类名选必然跨版本碎；但 mark 有一个**稳定钩子** `data-slot="conversation.hero.brand.mark"`。
  所以匹配只能按**文本**（en + zh 两套字面量），这也正是 brandmark 插件在翻译层的做法。
- **首屏不闪**：修复安排在 MutationObserver 微任务之后的 `requestAnimationFrame` 里，落在同一帧绘制前。
- **视觉**：1440 与 760 均无横向溢出（标题 256×32）；`06-hero-1440.png` / `07-hero-760.png` 为证。
- **失效即降级**：DSH 若改了这三个字面量或把 mark 槽位移走，脚本什么都不做、首页显示原生 hero，
  **不报错、不崩页面** —— 与"删掉插件"是同一种失败形态，这是可接受的。

**已落地（2026-11-24，决策记为 D40）**：两项待定按用户决定执行——**徽章保留**（`TIA-V17`）、
**图标用品牌图**（`brandmark.png`，非 `app.ico`）。

- `BrandScript.js` + `brandmark.png` 作嵌入资源进 `DshSuite.Shell.csproj`；
- `MainForm.cs` 在 `TitleBarScript` 之后注入两条 document-created 脚本：先 `window.__DSH_SUITE_MARK__`
  （data URL），再注入脚本本体（C# 侧约 25 行，含三个小 helper）；
- 壳 `-SmokeTest` 通过（`{"ok":true,"navigation":"completed"}`）；
- 删除清单已全部执行：包目录、蓝图 `dependencies` + `dsh.profile.bundles`、`pnpm-lock.yaml`（−12 行）、
  `README.md` / `AGENTS.md` / `docs/roadmap.md` / `docs/decisions.md`（D39 表加作废标注 + 新增 D40）/
  `docs/plugin-independence.md` / `docs/tia-version-members.md` / `CHANGELOG.md` / `site/content.md`。
  历史文档（`docs/releases/**`、`CHANGELOG` 的旧条目）保持原样。

**删除清单**（漏一处就会出现"包已删、蓝图还在引用"的加载失败）：
`packages/dsh-ui-brandmark/` → 蓝图 `profile/dsh-automation-suite/package.json` 的 `dsh.profile.bundles` 行 →
`scripts/build-distribution.mjs` 打包清单 → 根 `README.md` §2/§4/§5/§6 的行与计数 →
根 `AGENTS.md` 的"16 个插件行"基线与 `--dump-config` 期望 → `docs/roadmap.md` §1.2 →
`docs/plugin-independence.md` §7.1 的包数与 recipe → `docs/releases.md` 台账 → `site/`（如有提及）。

### 9.2 版本管理独立成包

**这个直觉与架构文档一致**：[`vision.md`](vision.md) §3 的 **③ 管理与协作层**原文就是"项目级版本管理
（导出为文本 → 外部 VCS → 差异/提交 → 可回滚）"。现在这批能力被塞进了**作用域**插件
（`engineering-context` 的 19 个工具里有 10 个是版本工具），那个包才讲不清自己是什么。
拆出来等于把 ③ 层恢复成一个真实的包。

**边界（各自一句话）**：

| 包 | 一句话 | 不做什么 |
|---|---|---|
| `engineering-context` | 把工程领进 workspace，并管它的**作用域**（哪个工程/设备/哪棵树） | 不写历史、不建索引、不做 diff |
| `version-control`（新） | 把 source 树的每次变化记成**可查询的工程历史**（提交协议 + 账本 + 投影 + 差异） | 不碰 TIA、不开工程、不管 workspace 路径规则 |
| `ui-versions` | 只读渲染 `.dsh/versions-view.json` | **零改动**（文件契约不变，这是拆包最大的好处） |

**搬迁清单**（≈167 KB 源码、约占该包 1/4；6 个测试文件 ≈61 KB）：

| 类别 | 文件（KB） |
|---|---|
| 提交协议 | `commit.ts`(8.7) `git.ts`(10.0) `git-context.ts`(7.5) `tools/commit.ts`(8.6) |
| 差异 | `diff.ts`(53.3) `tools/diff.ts`(4.3) |
| 账本 | `version/{schema,store,write,read,docs,view,device,evidence-diff}.ts`(48.9) |
| 工具面 | `tools/version.ts`(29.8) |
| 入口 | `version-entry.ts` `version-read-entry.ts` `diff-entry.ts`(5.2) |
| 文档 | `docs/version-store.md` |
| 测试 | `10-project-diff`(27.8) `11-project-commit`(10.2) `12-version-store`(9.3) `13-version-commit-hook`(4.1) `14-version-docs`(4.9) `15-version-annotate`(4.6) |

**留下 9 个工具**：`create_engineering_project`、`project_status`、`project_sync`、`workspace_describe`、
`import_preflight`、`project_translate`、`handoff_export`/`import`/`status`。
**搬走 10 个**：`project_commit`、`project_diff`、`project_history`、`project_version_reindex`、
`project_version_verify`、`project_doc_index`、`project_doc_search`、`project_version_annotate`、
`project_problem`、`project_version_query`。

**新包三个入口**（总入口数不变，仍 6 条）：

| 入口 | 工具 | 谁挂 |
|---|---|---|
| `.`（record） | `project_commit`、`project_version_reindex`、`project_version_annotate`、`project_doc_index` | auditor |
| `/read` | `project_history`、`project_version_verify`、`project_doc_search`、`project_problem`、`project_version_query` | leader、auditor、expert |
| `/diff` | `project_diff` | auditor、expert |

> **顺带修掉一个错配**（已于 2026-11-25 落地：leader 只挂 `version-control/read`）：原来 leader 挂的 `engineering-context/version` 含 `reindex`/`annotate`/`doc_index`
> 三个写工具。拆包后 leader 只挂 `/read`(5)——**少 3 个写工具**，与 D30"慢活交给 auditor"一致。

**三条新契约**（缺一条拆完就是半残）：

1. **`versionControl` 服务（软依赖）**：`create_engineering_project` 的 baseline 提交改为
   `ctx.get('versionControl')?.recordBaseline(...)`；缺失时 **create 仍成功**，只报"未建版本库"
   （先例：`knowledgeGraph.ingestDevice` 的 fail-soft）。反过来 context **不得**自己 `git commit`。
2. **文件契约不变**：`source/` 布局、`_evidence.json`、`.dsh/versions.db`、`.dsh/versions-view.json` 全保持；
   消费者（`ui-versions`、`engineering-graph`、`plcsim-advanced`）零改动。
3. **写完必须回写视图**：`recordBaseline`/`commit`/`reindex`/`annotate` 都走同一个 `recordVersion` 路径
   （现在如此），否则 Versions 页停在旧数据。

**五个风险（按处理顺序）**：

| # | 风险 | 证据 | 处理 |
|---|---|---|---|
| R1 | **`project_commit` 硬依赖 TIA**：为 `resolveDevice` 必须有 `engineeringAccess`，缺了就 `tia_access_unavailable` | `src/tools/commit.ts:9,85-91` | **拆包第一块砖**：device 解析改为读 `source/_dsh-engineering-context.json` 索引（plcsim/graph 已有先例），`engineeringAccess` 降为可选回退；否则新包硬绑 TIA，"可离线测试"就没了 |
| R2 | baseline 跨包 | `tools/create-project.ts` 的 `createBaseline` + `writeRepoMarker` | 见契约 1；`repo.json` 标记的写入归属改为新包（谁提交谁写标记），否则新包不认这个仓库 |
| R3 | 布局常量再复制一份（`source/`、`EVIDENCE_FILE`、evidence schema） | `config.ts` 被 `commit.ts`/`diff.ts`/`version/*` 广泛引用 | 按 D10**不抽共享包**：定为**文件契约**，由 TIA 包定义、两边只读，两侧 AGENTS 各写一句"不得改格式" |
| R4 | `versions.db` 的 4 张 graph 表与 `engineering-graph` 同构 | `src/version/schema.ts:6-9` 自述"same four tables dsh-engineering-graph uses" | **不阻塞拆包**；拆完评估这些跳转（version ↔ block ↔ problem ↔ doc）能否改查 `knowledgeGraph`，少一份图实现 |
| R5 | 两个大测试夹着跨包断言 | `02-create-project`(72.7)、`09-status-sync`(47.4) | 改成假 `versionControl` 服务，正好验证契约 1 的 fail-soft |

**命名（已定，2026-11-25）**：`@automation-suite/version-control`（③ 层，不带 `engineering-` 前缀；目录仍叫
`dsh-engineering-version-control`）。入口：`/record`、`/read`、`/diff`。

**净效果**：包数 **14 → 15**（+`version-control`；`ui-brandmark` 已于 D40 下线，所以与下线合并看仍是 15 个），
Loader 入口 6 → 6，模型工具 19 → 9 + 10，leader 少 3 个写工具。
**包数没怎么变，但 ③ 层从"混在作用域包里"变成一个真实的包。**


---

## 10. 落地结果（2026-11-25）

§9.2 的方案已实施，**包名与行名以实际交付为准**：`@automation-suite/version-control`，
宿主行（只提供服务 `versionControl`）+ `/record`(4) + `/read`(5) + `/diff`(1)；
`engineering-context` 收窄到 9 个工具、三个入口；preset 分配见 `decisions.md` D42 与
`profile/dsh-automation-suite/cordis.patch.yml`。
