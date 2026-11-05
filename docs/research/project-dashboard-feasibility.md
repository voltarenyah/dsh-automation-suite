# Project Dashboard（跨 Workspace 总览页）可行性研究

> **状态**：调研结论 · 2026-11-04（同日两轮调整：会话列表移出、git 放弃、加多级标签）· 宿主 **DSH 0.2.1-rc.2**（本机安装产物，逐条读自 `app.asar`）
> **P0 已落地（2026-11-04）**：`packages/dsh-ui-project-dashboard` 在 3095 实测通过 —— 左侧栏第一行
> `Project Dashboard`（位于 Plugins 之上，`order: -10` 生效）、点击打开整页占位、`dataset.dshProjectDashboard === 'p0'`、控制台无报错。
> 数据、标签与搜索留在 P1/P2。
> **一句话**：可行。落点是**主栏左侧栏顶部新增一行（`sidebar.panellist`，order 取负值）**+
> **`main` 全局面板**；数据来自**浏览器侧已有的标准 Hook**（workspace / session 快照）与
> **既有 `workspaceFiles` 文件读取通道**；标签是纯客户端状态（`localStorage`），
> **不在后台对每个工作区跑宿主命令**（用户 2026-11-04 明确：不做全盘刷新式的宿主侧采集）。
> 主要不确定性：内部 API 跨版本稳定性、"借一个会话读文件"这条内部约定、order 负值的运行期表现。

---

## 1. 需求拆解与结论

用户要的是：**在 `dsh-automation-suite` 的左上角「Plugins」上方插入一个 "Project Dashboard" 页面，
把所有 Workspace 的基本信息汇总到一处**，并支持**多级标签**与**顶部搜索/筛选**。
会话列表不放（左侧栏 `sidebar.workspaces` 已有）；git 提交历史**放弃**（见 §3.3 的决定）。

拆成四件互相独立的事，可行性各自评估：

| # | 要做的事 | 结论 | 依据 |
|---|---|---|---|
| A | 在左侧栏 **Plugins 上方**加一个图标入口 | ✅ 纯插槽注册，**order 取负值**即可 | §2.1 / §2.2（读自宿主产物） |
| B | 整页面板（不绑会话） | ✅ 注册 root `main`（keyed） | §2.2（官方 `plugins` / `schedules` 面板同一机制） |
| C | 汇总所有 Workspace 的关键信息 | ✅ 一层纯 Hook、二层读工程产物文件（借会话） | §3.1 / §3.2 / §4 |
| D | **多级标签**（A/B/C）+ 顶部搜索 + 标签筛选 | ✅ 纯客户端；`localStorage` 持久化，零宿主代码 | §5.1 / §5.2 |

**推荐形态**：新建 `packages/dsh-ui-project-dashboard`（**纯客户端插件**，宿主半侧空 `apply()`），
与 `dsh-ui-prompt-guide` 同一套注入方式、与 `dsh-ui-hardware` 同一套构建链。

---

## 2. 落点：为什么是「`sidebar.panellist` + `main`」

### 2.1 左侧栏那一列到底是什么

@deepseek-ai/dsh-client-ui-sidebar 的浏览器产物（`lib/client.js`，本机 asar）把左侧栏拆成三段：

```
brand 行 → New Session 按钮 → 【nav.panelList ← sidebar.panellist 的一行一个图标】
       → sidebar.workspaces（工作区/会话树，占满中部） → 底部 settings
```

关键代码（同一文件）：

- **声明**：`"sidebar.panellist": { kind: "list", scope: "root" }`（line 503）——root **list** 座位，
  一行 = 一个 `id` + 一个图标组件 + 一个 `label`（thunk，随语言变化）+ `order`。
- **渲染**：`panels.map(...)` 渲染在 New Session 之下、`sidebar.workspaces` 之上（line 378–389）。
  也就是说"左侧栏顶部"就是这一行的位置，和用户说的"左上角 Plugins 上面"完全对应。
- **排序**：`syncPanels()` 把注册项映射成 `{id, order: options.order ?? 0, label}`，
  **然后 `sort((a,b) => a.order - b.order)`**（line 453–468），并且订阅 `locale` 变化重算 label。
  ⚠️ 这里**只按 `order` 排序**，不看 `priority` —— 想排在别人前面只能靠 `order`。
- **唯一性**：`entriesOfSlot` 按 `id` 去重（先注册者胜），所以自定义 id 必须全局唯一
  （建议 `project-dashboard`）。

### 2.2 已装面板的 order 实测（决定"插在哪"）

| 面板 | id | order | 出处 |
|---|---|---|---|
| **Plugins** | `plugins` | **0** | plugin-manager `PANEL_ID="plugins"`（line 4355）、注册 `order: 0`（line 4477–4483） |
| Schedules | 内置 | 10 | ui-schedule（line 7484） |
| Prompt Guide（本仓） | `prompt-guide` | 7 | `packages/dsh-ui-prompt-guide/src/client/index.jsx` |
| **Project Dashboard（拟）** | `project-dashboard` | **-10** | —— |

⇒ **order 取负值就排在 Plugins 之上，是本列第一个图标**。排序函数是纯数值减法，宿主产物里没有
`order >= 0` 的钳制；但这条**只在代码里读到、尚未在运行期看到 DOM 顺序**，列为 P0 验收项
（⚠️ 若宿主拒绝负值，退路是把 order 设为 0 与 Plugins 并列，接受"排在它下面"，或向宿主提 issue）。

### 2.3 整页面板：root `main`

ui-layout 声明 `"main": { kind: "keyed", scope: "root" }`（`lib/client.js` line 631），
点击左侧栏某行 = `ctx.layout.selectPanel(id)`，主区渲染 `renderSlot("main", {}, { entryKey: 当前面板 id })`
（line 119）。官方 `plugins`、`schedules` 与本仓 `prompt-guide` 都是"panellist 一行 + main 一个 key"，
**id/key 必须一致**；key 没有对应注册项时 `selectPanel` 会抛错（且不改当前选择）。

⇒ 实现上**先注册 main、成功后再注册左侧栏行**；main 注册失败就整页不出现并打印诊断，
避免出现"点了就抛错"的死入口。

---

## 3. 数据源：能给这个总览页看什么

### 3.1 第一层 · Workspace 与 Session（纯 Hook，零新增通道）

root 作用域的每个插槽组件都会拿到一组**标准 Hook**，由宿主插件 `provideRoot` 注入
（`materializeStandardBinding` 在渲染位置绑定，组件自己不订阅）：

| Hook | 提供者 | 快照形状（代码实证） |
|---|---|---|
| `useWorkspaces` | ui-workspace `provideRoot({ hooks: { workspaces: workspaces.list } })` | `{ items, archivedSessionIds, pinnedSessionIds, state, phase, error }` |
| `useSessions` | ui-session `provideRoot({ hooks: { sessions: ctx.sessions.list } })` | `{ ids, byId, phase, projectionsBySession }` |
| `useSessionStatus` | ui-session | `Map<sessionId, { running, pendingInteraction?, completionUnread }>` |
| `usePanelInfo` | ui-layout | `{ activePanelId, … }` |
| `useResource` | `@deepseek-ai/dsh-client-resources` | `useResource<'file'>(address)` → `{ status, value, failure }` |

`Workspace` 项的字段（ui-workspace 自己在用的字段为准）：
`workspaceId`、`path`、`title`、`createdAt`、`sessionIds[]`。
`Session` 行字段（同上）：`id`、`title`、`blank`、`updatedAt`、`running`、`origin`、`retainedBy`。

**这一层就足以做"总览"的骨架**，而且**天然实时**（工作区增删、会话跑完、审批等待都会推过来）：

- 工作区名 / 目录 / 建立时间；
- 会话总数、活跃数、**待用户处理数**（approval / plan-review / question 三种）、未读完成数；
- 最近活动时间（`max(session.updatedAt)`）；会话标题留在左侧栏，总览页不重复列；
- 当前主区所在的会话/工作区高亮（`retainedBy.mainView` + `usePanelInfo`）；
- 未归属任何工作区的会话（Ungrouped）单独一组。

真值参照（本机 3095 环境的 `storages/workspace.json`）：3 个 Workspace，分别有 2 / 6 / 6 个会话。

### 3.2 第二层 · 工程产物（读 `.dsh/*.json`，本仓自己的文件）

这套插件族的每个视图都已经有一份**预构建 JSON**，正好是"关键信息"的来源，而且**都已在真实工作区里存在**：

| 文件（相对 workspace 根） | 生产者 | 实测大小 | 可提取的关键字段（真值） |
|---|---|---|---|
| `source/_dsh-engineering-context.json` | engineering-context | ~1 KB | `project.name`、`project.savedAs`、`exportedAt`、`devices[].exported.{blocks,types,tagTables}`、`totals.{planned,written,refused,verificationFailed}` |
| `.dsh/hardware-view.json` | TIA `hardware_view` | 137–138 KB | `aml.project`、`counts.{devices,racks,modules,channels.{di,do,ai,ao,total}}`、`content.{signals,subnets,nodes}`、`generatedAt` |
| `.dsh/versions-view.json` | engineering-context `version/view.ts` | 6–30 KB | `counts.{versions,events,baseline}`、`versions[].{date,subject}`、`problems[]`、`generatedAt` |
| `.dsh/drawing-manifest.json` | drawing | 0.7–1.2 KB | `documents[].{file,pages,project,cabinets[]}`、`generatedAt` |

两个真实工作区的对照（**这就是总览页第一屏应有的样子**）：

| | SWT1_HF48e_Pilot | SWT2_PEI_1026_Night |
|---|---|---|
| 工程 | PEI_HF_M4L_ZRW_Test_V5.1 | PEI_SinoARP_SWT2 |
| 块 / 类型 / 变量表 | 772 / 121 / 7 | 1155 / 215 / 7 |
| 写入（planned→written） | 900 → 897（refused 3） | 1377 → 1376（refused 1） |
| 硬件 | 10 设备 / 117 模块 / 530 点 | 17 设备 / 144 模块 / 472 点 |
| 版本 | 2 版 / 22 事件 / 基线 900 | 3 版 / 2 事件 / 基线 1377（problems 1） |
| 图纸 | 294 页（Revision B） | 353 页 / 3 柜 |

### 3.3 第三层 · 数据库 / Git / 目录状态（**v1 不做**）

- `.dsh/versions.db`、`knowledge/<device>/*_db` 是 SQLite（本机 3.9 MB / 6 MB，知识库可到 450 MB），
  浏览器读不了，`readBytes` 也有 32 MiB 上限 ⇒ 想要库级信息只能**宿主侧聚合**（自开路由或写一份派生 JSON）。
- **Git 提交历史：放弃（2026-11-04 决定）。** `git log --shortstat` / `git status --porcelain` 只能由宿主侧跑，
  而用户不希望页面每次打开/刷新都去各项目里跑宿主代码（项目会越来越多，会卡）。
  ⇒ 这一项**不做**；若将来确实需要，只允许做成"用户点某一行的按钮、只对那一个项目按需取一次"的动作，
  不做全盘刷新，也不进首屏。
- 目录是否存在：客户端 view 里没有该字段（⚠️ 未在客户端模型里找到），不要承诺"目录丢失"检测。

---

## 4. 取数通道：为什么"第一层 Hook + 第二层借会话读文件"是最优解

| 通道 | 能拿到什么 | 鉴权 | 代价 |
|---|---|---|---|
| **A. 标准 Hook**（推荐，第一层） | workspace / session / status / panelInfo | 走已鉴权的 Gateway 流 | 零；但**不含文件内容** |
| **B. `remote.workspaceFiles`**（推荐，第二层） | 任意**绝对路径**文件（`readBytes` 32 MiB 内） | ✅ 走 `/api`，带会话身份与主机校验 | 每个 workspace / 每个文件一次调用 |
| **C. `useResource('file', address)`** | 只给 `{absolutePath, version, bytes}` **stat**，带 `fs.watch` 失效推送 | 同上 | 便宜、可做"文件变了就重读"，不传内容 |
| **D. `localStorage`**（标签，推荐） | 多级标签映射（`{workspaceId: string[]}`） | 浏览器同源，无网络 | 零宿主代码；跨机器/跨浏览器不共享（见 §6） |
| E. 自开 `ctx.webServer.register` 路由 | 什么都能算（含 SQLite、git、目录） | ❌ **无鉴权**，只能自抄 trust fence（只防 DNS rebinding） | 多一条有数据泄露面的路由；远程部署时不可用；**本项目明确不用** |
| F. iframe 静态页 + postMessage 桥 | 同 A/B，但要自己搭双向桥 | 页面本身无鉴权（prompt-guide 经验） | 比 React 面板多一层胶水 |

**B 的关键证据**（`@deepseek-ai/dsh-api-workspace-files` README，本机 asar）：

- *"`read`, `readBytes`, and `stat` accept an absolute path or one relative to the selected Session's
  workspace root. The composed filesystem decides whether the path is readable; **the service does not
  impose workspace containment on file reads**."*
- 会话解析：*"The Host reads a live Session header or uses persistence `stat` for a cold Session"* ——
  冷会话（含归档）也能用，不激活 Agent。
- 地址语法 `dsh-resource://file/session/<sessionId>/<path>`，`encodeSegment` **保留盘符冒号**
  （`C:` 不会被编码掉），绝对路径由 `fileAddressFor()` 直接挂上去。
- 读取失败都是带 code 的 `RemoteError`：`workspace-file/not-found`、`not-regular-file`、`too-large`、
  `not-text`、`outside-workspace`（后者只针对**目录**列举/监听）—— **按 code 分支**。

⇒ 于是**第二个层只需要一个"授权用的会话 id"**：从 `useSessions` 里给每个 workspace 挑一个会话
（优先非空、最近活跃，其次任意一个），再用它读该 workspace 的 4 个绝对路径。
没有会话的工作区，退化为第一层；**整个 app 一个会话都没有时，只显示第一层**（全新安装也能用）。

> **诚实标注**：B 的这条路依赖"读文件不施加 workspace 包含检查"这条**内部约定**（README 明确写了，
> 但不是公开 API 承诺）。如果宿主某天收紧为"只准读会话自己的 workspace"，退路是**放弃跨工作区读取**，
> 只读取"有会话的工作区"（每个工作区用自己的会话读自己的文件）—— 结果一样，只是空工作区没有工程卡片。

---

## 5. 设计草案

### 5.1 页面结构

```
┌ Project Dashboard ─────────────────────────────────────────────── ［演示状态］［刷新］┐
│ ［🔍 搜索项目/工程/标签…        ］［▽ 标签 ①］ ［产线/焊装 ×］      2 / 3 个工作区 │
├────────────────────────────────────────────────────────────────────────────────┤
│ 2 工作区 · 12 会话 · 1,927 块 · 1,002 点 · 5 版 · 647 页（账条随筛选重算）        │
├────────────────────────────────────────────────────────────────────────────────┤
│ 01  SWT1_HF48e_Pilot        │ 工程    │ 硬件    │ 版本    │ 图纸    │
│     PEI_HF_M4L_ZRW_Test_V5.1│ 772 块  │ 10 设备 │ 2 版    │ 294 页  │
│     ⏱ 43 分钟前 · 6 会话 · 3 归档                                    │
│     ── 标签条 ───────────────────────────────────────────────────────           │
│     ［● 客户/PEI］［● 产线/焊装/HF48e］［● 阶段/试产］［+ 标签］   ［打开］［新会话］│
├────────────────────────────────────────────────────────────────────────────────┤
│ 02  SWT2_PEI_1026_Night     …（同上；缺文件的格子显示"未生成"，不是空白）           │
├────────────────────────────────────────────────────────────────────────────────┤
│ 03  default-workspace       （无工程数据 → 四格里一行说明；标签仍可编辑）            │
└────────────────────────────────────────────────────────────────────────────────┘
```

- 一行一个工作区；**没有展开区、没有会话列表、没有 git 历史**；
- **源项目路径不显示**（截断后很乱，2026-11-04 决定）：路径只作为标题的 `title` 提示与搜索字段；
- **标签条**是行内独立一条：多级标签（`A/B/C`，最多 4 级）+「+ 标签」+ 右侧两个动作按钮；
- 顶部**搜索框**同时匹配工作区名、工程名、设备名与标签；「标签」按钮打开**标签树**多选筛选，
  选中项在工具条上显示为可移除的筛选 chip；**结果数**与**账条**都按筛选结果重算；
- 缺失/损坏的产物**逐格降级**为 `未生成` / `无法解析` / `过大`，绝不整页空白；
- 语言：中英字典（`ctx.locale.register`），图标 18px 线性图标，颜色只用 `--dsw-*` token。

### 5.2 交互

| 动作 | 实现 |
|---|---|
| 点某工作区的「打开」 | `ctx.uiWorkspace.startSession(workspaceId)` → 在该工作区开一个新会话 |
| 搜索 | 客户端即时过滤（真实实现要 **debounce ~120ms**，见 §5.3） |
| 点标签 chip | 加入/移除标签筛选（父标签自动覆盖整棵子树） |
| 「+ 标签」 | 行内浮层：输入 `A/B/C` 或选已有标签；Enter 添加、Esc 关闭 |
| 标签 chip 的 `×` | 从该工作区移除标签 |
| 刷新 | 只重读已缓存的工程视图，**不触发任何宿主任务** |
| 定位失败 | 所有注册包 try/catch，失败只写 `ctx.logger.warn` + 页面内一条诊断行 |

### 5.3 读取策略与规模（性能与正确性）

- **首屏**：只渲染第一层；工程卡片按可见性**懒读**（展开才读详情），缓存 key = `workspaceId + file version`。
- **文件监听**：可选 P3 用 `useResource('file', address)` 拿 `version`，版本变了才重读；
  这比轮询便宜（宿主侧 `fs.watch`），也避免"工具刚写完却看不到"。
- **并发**：每工作区的 4 个文件（工程索引 + 硬件 + 版本 + 图纸）并行读；整体上限 4×N 次调用
  （N=10 → 40 次，本地毫秒级；**只在"读这张卡"时发生**，不是每次打开页面全盘扫）。
- **规模（用户明确会变多）**：搜索/筛选的过滤与账条聚合是 `O(N)` 纯内存运算；
  N 到几十时每次按键全量重渲染仍可接受，但真实实现应 **debounce 输入**、**只重渲染变化的行**
  （或 N>50 时上虚拟滚动），并且**任何行级工作都不得触发宿主采集**。
- **标签存储**：`localStorage` 一份 `{workspaceId: string[]}`；读写都是同步小对象。
  更换浏览器/机器、清理站点数据会丢标签 —— 这是 v1 的已知边界（见 §6）。
- **陈旧**：卡片显示各自的 `generatedAt`，超过 24h 标灰并写"可能过期"——**绝不暗示这是 TIA 的实时状态**
  （`hardware_view` / `versions-view` 都是"上次导出/提交时的事实"）。

---

## 6. 风险与红线

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 1 | 客户端 API（`slots`/Hook 名/`main` 座位/`workspaceFiles`）**不是公开契约**，0.2.0→0.2.1 已经变过一次（基座表多了 zod 等） | 中 | 全部跨包调用收敛在 1–2 个文件；注册失败降级为诊断，不抛到渲染层 |
| 2 | **order 负值**只在代码里验证过（排序是数值减法、无钳制），运行期 DOM 顺序未实测 | 低 | P0 第一件事就是起 3095 看行顺序；不行则退到 order 0 并列 |
| 3 | "借会话读文件"依赖"读不施加包含检查"这条内部约定 | 中 | 优先用同工作区会话；跨读处写明理由与退路（§4 末） |
| 4 | 空工作区/空安装没有会话 → 读不到工程文件 | 低 | 两层数据模型天然降级；文档写清"没有会话就没有工程卡片" |
| 5 | 标签只存在浏览器 `localStorage`：换机器/换浏览器/清站点数据即丢 | 中 | v1 接受；README 写清边界。要跨机器就把标签映射改成宿主侧存储（**需要新的宿主代码与一条带鉴权的读写通道**，不在本期） |
| 6 | 大 JSON（138 KB/工作区）解析开销 | 低 | 懒读 + 缓存 + 只取字段；N 很大时再虚拟滚动 |
| 7 | 误把派生视图当实时状态 | 中 | 展示 `generatedAt`、"上次导出"等措辞；README 与 UI 都写死这条 |
| 8 | 与其它第三方面板抢 order（如 `dsh-guizang-design` 也占 panellist） | 低 | 只认自己的 order；不删不改别人的注册 |
| 9 | 标签命名随意，长路径把行撑高 | 低 | 最多 4 级、chip `max-width` + 省略号 + 完整路径进 `title`；重复标签去重 |

**红线**：不改官方包（`app.asar` 只读，升级即覆盖）；不注册 `sidebar.workspaces`（single，已被 ui-workspace 占用）；
不动 `rightbar.session`（single，会替换整列）；不把 UI 塞进宿主插件包（会污染其构建/测试面，见 `docs/ui-plugins.md` §4.2）。

---

## 7. 工作量与分期

新包 `packages/dsh-ui-project-dashboard`，构建链直接复用 `dsh-ui-hardware`（`scripts/build.mjs` 用 esbuild，
平台表 external；`tsc` 出宿主半侧；CSS/字典/`cordis.patch.yml` 同构）。**纯客户端**，宿主半侧只有空 `apply()`。

| 阶段 | 内容 | 验收 | 估时 |
|---|---|---|---|
| **P0 链路** | 建包（空宿主半侧）+ `cordis.patch.yml` + 蓝图 bundles；注册 `main` 占位页与 panellist 行（order -10） | 3095 里左侧栏**第一行**是 Project Dashboard，点击出整页占位；`pnpm -r build`/`typecheck`/`test` 全绿 | 0.5 天 |
| **P1 行与标签** | 工作区行（标题/工程名/时间/会话计数，**不显示路径**）+ 标签条（多级、增删、chip 筛选）+ 顶部搜索 + 标签树筛选 + 账条按筛选重算 + `localStorage` 持久化 | 3 个真实工作区全部正确；标签增删刷新后仍在；搜"产线"或点父标签能把两个工程工作区筛出来（2/3）；清空恢复 3/3 | 1.5 天 |
| **P2 第二层** | 4 个工程产物的读取、解析、字段提取、逐格降级、`generatedAt` 与陈旧标记 | 两个真实工作区的数字与 §3.2 表格逐项一致；删掉/改坏一个文件只影响那一格 | 1.5–2 天 |
| **P3 打磨** | 输入 debounce、只重渲染变化行、`useResource` 监听自动刷新、空态文案、键盘可达（标签删除/筛选可聚焦）、a11y、README/roadmap 同步 | 切换页面不串状态；中英切换即时生效；docs 三处（README §2 / roadmap / 包 README）同步 | 1 天 |

**纯代码量估计**：`src/model.ts`（纯函数：筛选/聚合/标签规范化/防御解析，可单测）约 350 行 +
浏览器半侧约 800–1000 行 JSX。测试沿用 `node:test` 驱动 `model.ts`
（模型输入用**真实 JSON 片段**做 fixture，与 ui-versions/hardware 的做法一致）。

### 登记三处（缺一处就静默不出现）

1. `packages/dsh-ui-project-dashboard/`：`package.json`（`dsh.client` + `exports["./client"]` + `dsh.bundle.patch`）、`lib/index.js`、`lib/client.js`；
2. 包内 `cordis.patch.yml`：`insert: - id: project-dashboard / name: 'dsh-ui-project-dashboard'`（`@` 不存在时不需要引号，但**逐字**等于包名）；
3. `profile/dsh-automation-suite/package.json`：`dependencies` + `dsh.profile.bundles`（放 `dsh-ui-prompt-guide` 之后）。

⚠️ **已存在的 3095 环境不会自动跟随蓝图**（`docs/ui-plugins.md` §9.2）：要么手工把包名补进
`%USERPROFILE%\dsh-automation-suite-home\profiles\dsh-automation-suite\package.json` 的 bundles，
要么 `-Reset`（先备份物化目录里的 `cordis.patch.yml`，那是应用回写的活状态）。

---

## 8. 验收怎么做（P0 就能跑）

```powershell
# 1) 起环境（3095；-Restart 幂等）
pwsh -NoProfile -File scripts\start-env.ps1 -Restart

# 2) 硬证据一：组合里有这一行（用该环境的 DSH_HOME）
$env:DSH_HOME = "$env:USERPROFILE\dsh-automation-suite-home"
dsh --profile dsh-automation-suite --dump-config | Select-String 'dsh-ui-project-dashboard'

# 3) 硬证据二：启动图里有客户端行（需带 token 的 URL）
#    {"id":"dsh-ui-project-dashboard","url":"plugins/??dsh-ui-project-dashboard/client.js&rev=…"}

# 4) 硬证据三（最直观）：页面左侧栏第一行是 Project Dashboard，位于 Plugins 之上；
#    控制台里 apply(ctx) 写的探针（如 dataset.dshProjectDashboard）存在。
```

功能验收清单：

- [ ] 三个工作区都在，标题/工程名/会话数与 `workspace.json` 一致；**行里不出现路径**；
- [ ] 运行中/待审批/未读完成三种状态与左侧栏原有显示一致；
- [ ] 点「打开」进入该工作区；从面板切回会话无异常；
- [ ] SWT1/SWT2 的块数、设备数、点数、版本数、图纸页数与 §3.2 一致；
- [ ] 搜索"产线"命中两个工程工作区；点父标签「产线/焊装」= 2/3；账条同步变成 2 个工作区 / 12 会话；
- [ ] 加一个 `A/B/C` 标签 → 立刻出现在行内与标签树；刷新页面仍在（localStorage）；`×` 能移除；
- [ ] 删掉某工作区的 `hardware-view.json` → 只有那一格变"未生成"；
- [ ] 全新空 home（无会话/无工作区）→ 显示空态说明，不报错、不白屏；
- [ ] 折叠左侧栏只剩图标且有 tooltip；中英切换后 label 与页内文案即时更新。

---

## 9. 已定与待决

**已定（2026-11-04）**

1. **会话列表不入页**：左侧栏 `sidebar.workspaces` 已有同样内容，总览页不再重复。
2. **不显示源项目路径**：截断后很乱；路径只作标题提示与搜索字段。
3. **git 提交历史不做**：不允许为它每次打开/刷新都去各项目跑宿主命令（项目会变多、会卡）；
   将来若要做，只能是"用户点某一行 → 只对这一个项目按需取一次"，不做全盘刷新。
4. **标签持久化 = `localStorage`**（v1）：零宿主代码；代价是跨机器/清站点数据会丢，见 §6。

**待你拍板**

1. **信息范围**：建议工程（块/硬件/版本/图纸）全做，缺失即降级。
2. **排版**：单列行 + 行内标签条（演示版形态）是否 OK？还是改成卡片网格？
3. **是否接受"借会话读文件"**（§4）—— 避开这条内部约定的代价是放弃工程数据，或引入无鉴权路由。
4. **标签要不要跨机器共享**：要 → 必须新增宿主侧存储与带鉴权的读写通道（本期不做）。
5. **落地环境**：只要 3095（发行版验收环境）还是也要装进日常 3082 的 `desktop` profile？
6. **标签文案**：左侧栏显示 `Project Dashboard`，还是中文界面显示「项目总览」？
   —— 建议 label 走字典：中文「项目总览」/ 英文 `Project Dashboard`，页面标题固定 `Project Dashboard`。

---

## 10. 证据索引（本次调研实际读过的东西）

| 结论 | 证据位置 |
|---|---|
| `sidebar.panellist` 是 root list；渲染在 New Session 与工作区树之间 | `app.asar` → `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`（503 / 378–389 行） |
| 左侧栏**只按 order** 排序、label 随 locale 重算、按 id 去重 | 同上（453–468 行）+ 宿主 slots 核心（`entriesOfSlot` / register 内 `sort`） |
| Plugins 面板 id=`plugins`、order=0；Schedules order=10 | `dsh-client-ui-plugin-manager/lib/client.js`（4355 / 4477）；`dsh-client-ui-schedule/lib/client.js`（7484） |
| `main` 是 keyed/root；`selectPanel` 选中即渲染 | `dsh-client-ui-layout/lib/client.js`（631 / 119） |
| root 标准 Hook 的来源 | `dsh-client-ui-session/lib/client.js`（1104–1113）；`dsh-client-ui-workspace/lib/client.js`（5039–5042）；`dsh-client-ui-layout/lib/client.js`（621） |
| workspace/session 行字段 | `dsh-client-ui-workspace/lib/client.js`（3518–3548 / 1059–1073） |
| 文件读取不施加 workspace 包含、绝对路径可用、冷会话可解析 | `@deepseek-ai/dsh-api-workspace-files/README.md`（28 / 40 / 95 行） |
| `file` 资源只给 stat、地址保留盘符冒号 | `dsh-api-workspace-files/lib/client.js`（352–410）；`dsh-client-ui-sidebar-files/lib/client.js`（361–417） |
| 自开路由无鉴权（本项目因此不用） | `docs/ui-plugins.md` §7.5；`packages/dsh-ui-prompt-guide/src/page.ts` 头注释 |
| 真实数据样例 | `C:\Users\Ansel\Documents\dsh-automation-suite\{SWT1_HF48e_Pilot,SWT2_PEI_1026_Night}` 的 `source/_dsh-engineering-context.json`、`.dsh/{hardware-view,versions-view,drawing-manifest}.json` |
| 真实 workspace 注册表 | `%USERPROFILE%\dsh-automation-suite-home\storages\workspace.json`（3 个工作区、14 个会话） |
