# Changes 面板：右侧栏「未提交变更」+ 提交工作流（方案设计）

> **本文定位**：发行版层面的方案设计 —— 在 dsh web 页面右侧栏增加一个 **Changes** 视图，
> 列出「当前工作区里已改动、还没提交」的文件（含 `+N/−M` 变更量），并提供**提交区**：
> 一个按钮把**固定的提交提示词**（带上本次变更清单与用户写的提交信息）发进当前会话，
> 由 agent 走既有的 `git_*` 工具完成提交，从而把「提交」变成一次**带上下文的对话行为**。
>
> **状态**：**P1 已落地（2026-11-06）**。列表现在是**真实 git 状态**：宿主按会话的
> `header.cwd` 找到仓库，跑 `status --porcelain=v1 -z` + `diff --numstat -z -M`，
> 未跟踪文件按行数计数（有上限）。**P2（提交区）尚未实现** —— 面板目前只读。
> P0 与 P1 的验收证据见 §8.1 / §8.2。
>
> **宿主版本**：本机 0.2.1-rc.2（`dsh-web-frontend` 与 `@deepseek-ai/*` 均从
> `resources/app.asar` 内读出）。机制条目沿用 [`ui-plugins.md`](ui-plugins.md) 的口径：
> ✅ = 本机实测/从产物读出，📖 = 上游文档与说明，⚠️ = 推断，动手前必须验。
>
> **与既有文档的关系**：UI 插件的加载机制、构建链、验收套路不在这里重复，见
> [`ui-plugins.md`](ui-plugins.md)；会话事件与工具面见 [`tool-surface.md`](tool-surface.md)；
> 右侧栏插件的既有三个实例见 [`roadmap.md`](roadmap.md) §1.1。

---

## 1. 问题与目标

### 1.1 现状

今天的提交是**纯对话触发**的：

- 改完文件后，用户没有任何地方能**看到**"这个工作区现在有哪些文件被改过、改了多少"；
  他只能问 agent，或自己在终端里 `git status`；
- 提交动作依赖用户在对话框里说一句"提交一下"，agent 自己决定提交什么、写什么信息；
- 面板侧的既有两个右侧栏插件（PLC Blocks / Versions）都是**只读派生视图**，
  没有"当前 git 状态"这个概念。

### 1.2 目标

| # | 目标 | 判据 |
|---|---|---|
| G1 | **看得见**：随时看到未提交文件清单 + 每文件 `+N/−M` + 汇总 | 打开 tab 即见，无需问 agent |
| G2 | **看得懂**：区分 M/A/D/R/未跟踪/冲突，显示仓库根与分支 | 与 `git status` 逐项一致 |
| G3 | **提交得动**：有一个提交区，能把固定提示词发进**当前会话** | 点按钮后输入框出现提示词并被提交 |
| G4 | **不越权**：面板**自己不执行** `git commit`，提交仍由 agent 经 `dsh-tool-git` 的工具与安全门完成 | 提交出现在 transcript 里，可审计、可回滚 |
| G5 | **不抢戏**：不自动弹 tab、不改用户草稿、不打断正在跑的轮次 | 见 §5.4 |

### 1.3 非目标（v1 明确不做）

- ❌ 不做暂存区（stage/unstage 按钮）：暂存是 agent 的 `git_stage` 动作，面板只读；
- ❌ 不做提交历史 / blame / 分支切换；
- ❌ 不引入新的**模型工具**：一个工具都不加（提交走既有 `git_*` 工具面）；
- ❌ 不做多仓库：只显示**包含会话 cwd 的那个仓库**（嵌套仓库与 submodule 记为 gitlink）；
- ❌ 不替用户写提交信息（可以先给一条由模型拟的，但最终由用户在提交区确认）。

---

## 2. 已核实的机制（设计所依赖的地基）

### 2.1 右侧栏 tab 的三件套 ✅

现有 `packages/dsh-ui-versions` 是可直接照抄的样板（本仓代码，已验收）：

```js
// ① 类型注册：id 必须等于包名，kind 是这个类型的地址名（sidebar://<kind>）
ctx.inject(['sidebarRightTabs'], (i) => i.get('sidebarRightTabs').register({
  id: 'dsh-ui-changes',
  kind: 'changes',
  title: () => t('tab.title'),          // thunk，跟语言
  guide: [{ id: 'changes', order: 102, title: () => t('guide.title'),
            description: () => t('guide.description') }],
}))

// ② 正文：keyed seat，key 必须等于 definition.id
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: ID, locale: NS, inject: face }, Body))

// ③ 标题 chip 单独一个 seat（tab 记录会冻结打开时的标题文本）
ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab.title', key: ID, locale: NS }, Title))
```

要点：

- 组件里拿会话信息用框架注入的 `useTabInfo()` / `useSessions(s => s.byId[sessionId]?.cwd)`；
- 打开别的文件用 `tab.actions.openResource(resourceAddress(sessionId, rel))`（复用既有预览 tab）；
- 导航控制器 `sidebarRight.openResource / openTab / focus / toggleExpanded` 可用，
  但 **v1 不主动弹 tab**（`ui-plugins.md` §7 的"别抢用户页面"同理）。

### 2.2 会话作用域与 composer 的动作面 ✅

`packages/dsh-ui-plc-source` 的「在对话里提及」已经打通这条路（真机验收过）：

```js
const actx = ctx.sessions.scope(sessionId)          // 会话作用域
const conversation = actx.get('conversation')        // ui-conversation 提供的服务
const shell = conversation.input.for(actx)           // 该会话的输入机
```

`shell.actions` 的成员（✅ 从 0.2.1-rc.2 的 `dsh-client-ui-conversation/lib/client.js`
里读出的 `SessionInputShell.actions`）：

| 动作 | 语义 | 本方案用途 |
|---|---|---|
| `captureInsertion()` | 取当前选区 + 草稿版本号 | 插入前的版本锚 |
| `insertText(text, span)` | 在光标处插入一次可撤销的纯文本；版本变了就**拒绝** | 草稿非空时追加 |
| `setDraft(text)` | **整篇替换**草稿 | 草稿为空时写提示词 |
| `submit()` | 提交草稿（投递模式 `queue`：空闲进 transcript，忙时进队列） | 发送提交提示词 |
| `addAttachments/remove/prune` | 附件 | v1 不用 |

`shell` 自己还有 `focus()`、`notify(level, text)`、`projection.clipboardText`（当前草稿纯文本）。

> ⚠️ 这些是**内部约定**，没有 semver 承诺。所有调用必须包 try/catch，并降级成一条可见诊断
> （与 `ui-plugins.md` §7 第 1、2 条一致）。

### 2.3 宿主侧：git 能力与"裸路由"

- **`gitContext` 服务** ✅（`packages/dsh-tool-git` 的宿主行 `ctx.provide('gitContext', …)`）：
  `isRepository(root)`、`repoRoot(root)`、`create(root)` → `{ repoDir, run, runChecked, status, head, commit }`。
  **仓库根必须显式传入，服务从不读 `process.cwd()`**。兄弟插件用 `ctx.get('gitContext')` 消费，
  不 import 本包。
- **会话到 cwd 的映射** ✅：宿主侧 `ctx.get('sessions').get(sessionId)` 拿活会话，`session.header.cwd`
  就是工作目录（`dsh-session` README §API；`dsh-agent-loop` 里也是这么用的）。
  P1 已真机验证：`session-a5256726…` → `C:\…\SWT1_HF48e_Pilot`，返回的 39 个文件与
  `git status --porcelain` 逐行一致。不需要 `inject: ['sessions']`，惰性 `ctx.get()` 即可。
- **自开 HTTP 路由** ✅：`ctx.webServer.register({ kind: 'prefix', path, handler })`，
  `ui-prompt-guide` 就是这么服务的页面。**这条路没有鉴权**（只有 `/api` 有会话鉴权），
  第三方要自己抄一份 trust fence（拒绝 cross-site、Origin 必须等于 Host、只认 loopback/trustedHosts）。
  `ui-plugins.md` §7.5 的结论是：**读数据优先走 `workspaceFiles` 远程通道，只有宿主侧聚合才自开路由**。

### 2.4 DSH 自带的两个近邻（避免重复造轮子）

从 `app.asar` 里读到的两个官方包（📖 README 已读）：

| 包 | 做什么 | 为什么不能直接替我干 |
|---|---|---|
| `@deepseek-ai/dsh-workspace-changes`（宿主） | **每轮**开始时对工作树做一次 git 快照、轮末再快照，`diff-tree --numstat` 出这一轮改了哪些文件（含 `+N/−M`），落一条 `workspace/changes` 会话事件；`ctx.workspaceChanges.summary/diff` 提供对比 | 口径是"**这一轮**改了什么"，不是"**相对 HEAD** 还有什么没提交"；且数据只活在会话生命周期内，不跨进程 |
| `@deepseek-ai/dsh-client-ui-deliverables`（客户端） | 轮末的 changed-files 卡片 + **review tab**（逐文件对比） | 同上：绑定 turn 摘要，没有"提交"这个概念，也不看未暂存的全量状态 |

结论：**它们证明这套交互在 DSH 里是成立的**（卡片、`+N/−M`、点开看对比都已有先例），
但**都不解决"未提交变更 + 提交工作流"**。本方案因此是新的，但可以借用它们的**形状**。

### 2.5 缺口清单

| 缺口 | 本方案怎么补 |
|---|---|
| 没有"当前未提交变更"的宿主能力 | 新插件宿主半侧消费 `gitContext`，跑 `status` + `numstat` |
| 客户端拿不到宿主实时数据 | 自开一条只读路由（§4.2），**只回路径与计数，不回文件内容** |
| 没有"提交提示词"的组装位置 | 面板里组装，走 composer 动作面（§5.3） |
| 提交不看上下文 | 提示词里带快照（分支/HEAD/文件清单），并要求 agent 先复核再提交 |

---

## 3. 产品设计

### 3.1 落点与入口

- **座位**：右侧栏一个 tab 类型，`kind: 'changes'`，标题 **「变更」/「Changes」**；
- **入口**：右侧栏引导页的胶囊（`order: 102`，排在 PLC Blocks 40 / Versions 101 之后）；
- **一个会话一个实例**：不做 `multiple`，切会话时正文按 `sessionId` 取数据；
- **不自动打开**：v1 不注册"有变更就弹 tab"的行为（那会抢走用户正在看的页面）。

### 3.2 面板结构（线框）

```
┌───────────────────────────────────────────────┐
│ 变更                     ⟳ 刷新   全部展开/收起 │  ← 工具条
│ main · cfa1244 · 8 个文件  +340 −57           │  ← 摘要行（分支 / HEAD 短哈希 / 汇总）
├───────────────────────────────────────────────┤
│ ☑ M  docs/ui-changes-panel-plan.md   +182 −0  │
│ ☑ M  README.md                        +12 −3  │
│ ☐ ?? temp/probe.md                    new     │
│ ☐ D  packages/old/file.ts            −240     │
│ …（超过 maxFiles 时表尾提示"只显示前 N 个"）    │
├───────────────────────────────────────────────┤
│ 提交信息                                       │
│ ┌───────────────────────────────────────────┐ │
│ │ （用户可写；留空则由 agent 按变更拟一条）    │ │
│ └───────────────────────────────────────────┘ │
│ ☑ 已选 6 个文件      [预览提示词]  [提交 ▶]    │
└───────────────────────────────────────────────┘
```

- 摘要行是"现在是什么状态"，不是"这一轮改了什么"；
- 每行：选中框 / 状态徽章 / 路径（仓库根相对）/ `+N −M`（未跟踪显示 `new`，二进制显示 `bin`）；
- 点行 = 选中；双击（或右键菜单「打开文件」）= 用既有预览 tab 打开；
- 提交区在底部固定，不随列表滚动。

### 3.3 状态表达（与 git 对齐）

| porcelain `XY` | 徽章 | 颜色语义 | 计数来源 |
|---|---|---|---|
| ` M` / `M ` / `MM` | `M` | 修改 | `git diff --numstat HEAD` |
| `A ` | `A` | 新增（已暂存） | 同上 |
| ` D` / `D ` | `D` | 删除 | 同上（`−N`，`+0`） |
| `R ` | `R` | 重命名 | 同上（按新路径合并） |
| `??` | `?` | 未跟踪 | 读文件数行（有上限，见 §4.3） |
| `UU` / `AA` / `DU`… | `!` | 冲突 | 无计数，行不可勾选（交给 agent 处理） |

徽章与计数分离：**计数来自 `HEAD` 对比，徽章来自 index/worktree 状态** —— 两者不一致
（如 `M ` 暂存后又改）时徽章用 `MM` 这种双字母，tooltip 给出"已暂存/未暂存"两句话。

### 3.4 状态机

| 状态 | 触发 | 画面 |
|---|---|---|
| `loading` | 首次挂载 / 刷新 | 骨架行 + "正在读取…" |
| `ready` | 有变更 | 列表 + 提交区可用 |
| `clean` | 0 个文件 | "工作区干净" + 提交区禁用 |
| `not-repo` | cwd 不在任何 git 仓库 | 说明 + "这不是 git 仓库，提交按钮不可用" |
| `no-git-service` | `gitContext` 没装（`dsh-tool-git` 不在组合里） | "git 插件未加载" |
| `error` | 超时/权限/未知 | 错误码 + 重试按钮（错误码是字典键，句子在字典里） |

### 3.5 交互细节

- **刷新**：按钮 + 自动（§4.4）；
- **全选/反选**：表头一个 checkbox（三态）；
- **打开文件**：`tab.actions.openResource(resourceAddress(sessionId, path))`，**try/catch**，
  没有查看器的地址不能把列表打空。地址构造可直接抄
  `packages/dsh-ui-plc-source/src/model.ts` 的 `resourceAddress()`（`dsh-resource://file/session/<id>/<rel>`，
  逐段 `encodeURIComponent`）；
- **键盘**：列表行 `role="row"` + `aria-selected`，`↑/↓` 移动、空格勾选、Enter 打开；
- **持久化**：选中集合、折叠、过滤（若有）按 tab id 放 `defineStore` 的桶里，随 `tab.signal` 清理
  （照抄 `dsh-ui-plc-source` 的 store 做法）。

### 3.6 文案

`ctx.locale.register('changes', { zh, en })`，**只提供 zh/en**（DSH 设置里就这两种）。
tab 标题、引导项、chip 标题都用 thunk，跟随语言；错误文案由模型层只返回**字典键**。
占位符集合两边必须一致（这是本仓 `dsh-ui-plc-source` 测试第 5 条的既定口径）。

---

## 4. 数据设计

### 4.1 三条路线

| 路线 | 机制 | 鉴权 | 实时性 | 代价 | 结论 |
|---|---|---|---|---|---|
| **A 只读路由** | 宿主 `webServer.register('/changes/api/*')`，按需跑 git | ❌ 裸路由（自抄 fence） | 请求即最新 | 要自己守安全边界 | ✅ **推荐**（v1） |
| **B 派生快照文件** | 宿主在 `tool/result`、`turn/end`、`fs/observed` 时重算并写 `<workspace>/.dsh/changes-view.json`；客户端 `workspaceFiles.readBytes` 读、`workspaceFiles.changes` 跟随 | ✅ 走已鉴权的 `/api` | 事件驱动，有窗口期 | 多一个落盘物 + 谁触发重算的问题 | ⚠️ 备选（无路由部署时） |
| **C 新 Typert Remote** | 在网关上加一个 `remote.workspaceChanges` 风格的命名空间 | ✅ | 流式/按需 | 生成器对第三方不可用；SRC 回退模式未验证 | ❌ v1 不做 |

**为什么选 A**：
1. 面板要的是"**此刻**相对 HEAD 的状态"，轮询/按需请求天然正确；B 在用户于编辑器里改文件时
   会滞后（没有事件可听）；
2. 路由**只回路径与计数**，不回文件内容 —— 泄露面是"文件名与行数"，与 `/prompt-guide/` 那种
   "只回发行版自带文本"相比更敏感一点，但仍在 trust fence 能接受的范围内（§6）；
3. B 的写盘物会让 `.dsh/` 多一份派生状态，且 `versions-view.json` 那种"谁写、什么时候写"
   的耦合已经够多，不再加一处。

> 若将来部署方**不接受**未鉴权路由，退回 B：把同一个 `status` 结果写到
> `.dsh/changes-view.json`，客户端用 `workspaceFiles` 读；此时**必须**同时提供一个显式触发
> （`fs/observed` 或每个 `tool/result` 后重算），否则面板会长期显示旧值。

### 4.2 HTTP 合约

```
GET /changes/api/status?session=<sessionId>
→ 200 application/json
```

```jsonc
{
  "ok": true,
  "generatedAt": "2026-11-04T21:40:12+08:00",
  "repo": "C:/Users/Ansel/dsh-automation-suite",
  "branch": "main",              // 分离头时是 "HEAD"
  "detached": false,
  "head": "cfa1244…",            // 未诞生分支为 null
  "files": [
    { "path": "README.md", "x": " ", "y": "M", "code": "M",
      "adds": 12, "dels": 3, "binary": false, "untracked": false, "renamedFrom": null }
  ],
  "totals": { "files": 8, "adds": 340, "dels": 57, "truncated": false },
  "limits": { "maxFiles": 1000, "timeoutMs": 10000 }
}
```

失败一律 `{ ok: false, code, message? }`，`code` 是**字典键**：

`changes/session-unknown`、`changes/not-a-repository`、`changes/git-missing`、
`changes/git-failed`、`changes/timeout`、`changes/no-git-service`、`changes/bad-request`。

> v1 只有 `status` 一个端点。**不加** `diff` 端点（那会把文件内容送出一条裸路由）；
> 想看对比就用既有的预览 tab 打开文件本身（v2 再讨论，见 §9）。

### 4.3 宿主侧命令与解析

对每个请求（带 750 ms 以内的结果缓存）：

```powershell
# 1) 仓库身份（gitContext.create 已做 rev-parse --show-toplevel）
git rev-parse --abbrev-ref HEAD
git rev-parse --verify HEAD                      # 未诞生分支时非 0，按 null 处理

# 2) 文件清单（含未跟踪；忽略项默认不列）
git status --porcelain=v1 -z --untracked-files=all

# 3) 计数（相对 HEAD；未诞生分支改用 --cached）
git diff --numstat -z -M HEAD

# 4) 未跟踪文件的"新增行数"（可选，见下）
```

解析规则（全部要有单测）：

| 情况 | 处理 |
|---|---|
| `-z` 输出 | `NUL` 分隔、路径不做引号转义 —— **必须**用 `-z`，否则中文/空格/引号路径会错 |
| 重命名 | `-z` 下是 `XY <新路径>\0<旧路径>\0`（**新在前、旧在后**，与不带 `-z` 的 `R old -> new` 顺序相反）；计数按**新路径**合并，`renamedFrom` 记旧路径 |
| 二进制 | `numstat` 的 `-` `-` → `binary: true`，面包屑显示 `bin`，不计入 totals |
| 未跟踪 | 默认列 `?` + `new`；行数：文件 ≤ `maxUntrackedBytes`（默认 1 MiB）且未跟踪文件数 ≤ `maxUntrackedFiles`（默认 200）时读文件数行，否则不给计数（避免被一个新仓库的构建产物拖死） |
| 忽略项 | 默认不列（`git status` 默认行为）；`includeIgnored` 配置项留给 v2，v1 不暴露 |
| 子模块/嵌套仓库 | 按 gitlink 处理（`S`），行内提示"子模块"，不递归 |
| CRLF | 按 git 的 blob 口径计数（`numstat` 本身就是），不做归一化 |
| 超时 | `timeoutMs`（默认 10 s）到点 `changes/timeout`；**不要**用无超时的 `git status` 打大仓库 |
| 上限 | `maxFiles`（默认 1000）截断并置 `truncated: true`，表尾说明"只显示前 N 个" |

### 4.4 刷新策略（客户端）

| 触发 | 行为 |
|---|---|
| tab 首次挂载 | 立即拉一次 |
| 面板可见 + 会话有 `tool/result` / `turn/end` 事件 | 250 ms 防抖后拉一次（agent 刚改完文件） |
| 面板可见时的兜底轮询 | 5 s 一次；`document.hidden` 或 tab 不可见时**停** |
| 窗口重新获得焦点 | 拉一次 |
| 「刷新」按钮 | 立即拉一次（绕过缓存：`?refresh=<seq>`） |

> 轮询只在**面板可见**时开，且每次请求都要能被 `tab.signal` 中止；每次 `await` 之后写 store
> 前都要查 `signal.aborted`（`ui-plugins.md` §7.8）。

---

## 5. 提交工作流

### 5.1 按钮语义（含「编译按钮」的两种读法）

原始需求里的"编译按钮"有两种可能的读法，本方案默认第 1 种，第 2 种留作可选开关：

| 读法 | 设计 | 默认 |
|---|---|---|
| ① **"把提示词编译出来发进对话"** 的按钮 | 「提交」= 组装固定提示词 → 写进当前会话输入框 → 提交 | ✅ |
| ② 真正的 **TIA 编译** | 提交前先让 agent 跑 `compile_plc`，通过后再提交 | ⚠️ 用一个复选框「先编译再提交」实现（v2，见 §9） |

另有一个**次按钮**「预览提示词」：把最终要发送的文本以只读弹层展开，可手动改，
确认后才发送 —— 它承担"编辑"的角色，也让模型的输入对用户可解释。

按钮状态：

| 条件 | 状态 |
|---|---|
| 没有选中文件 / 工作区干净 | disabled + 悬停说明 |
| 没有会话（blank session） | disabled + "先选择一个会话" |
| `conversation` 服务不可用 | disabled + "会话输入框不可用" |
| 会话正忙 | 可用；`submit()` 会把它排进队列（提示"已排入队列"） |

### 5.2 固定提示词模板

模板放在 `src/prompt.ts`（纯函数、可单测），zh/en 两份，占位符集合必须一致：

```text
请提交当前工作区里这一批改动。

仓库：{repo}
分支：{branch}    HEAD：{head}
快照时间：{generatedAt}    共 {count} 个文件，+{adds} −{dels}

待提交文件（只提交这些路径）：
{fileLines}          # 每行：- {code} {path} (+{adds}/−{dels})

要求：
1. 先用 git_status 复核工作区；如果文件集合或计数与上面的快照不一致，先停下来把差异列给我，
   不要提交。
2. 只提交上面列出的路径；不要 git add -A，不要顺带提交别的改动。
3. 提交信息：{message}
   （用户没写时改为：按这些改动拟一条符合本仓库既有风格的中文提交信息，先给我看再提交。）
4. 用 git_commit 提交，然后报告 commit hash 与提交后的 git_status。
```

设计要点：

- **快照进提示词** = 让模型有"提交前的期望状态"，可以自检（第 1 条要求）；
- **路径白名单**（第 2 条）比"提交全部"更安全，也让"只提交我勾的那几个"变得可实现；
- **不写提交信息时不硬编造**：明确要求模型先给用户看；
- 模板里**不放文件内容**（内容由 agent 自己读），避免把大 diff 塞进提示词。

### 5.3 插入与提交（composer）

```js
const actx = ctx.sessions.scope(sessionId)
const shell = actx.get('conversation').input.for(actx)
const draft = shell.projection?.clipboardText ?? ''

if (draft.trim().length === 0) {
  shell.actions.setDraft(text)          // 整篇替换：草稿本来就空
  shell.actions.submit()
} else {
  // 草稿里有东西：**不覆写**，追加到光标处，让用户自己按 Enter
  const span = shell.actions.captureInsertion()
  const ok = shell.actions.insertText(`\n\n${text}`, span)
  shell.focus()
  // 被拒（版本变了/正在提交）时保留结果并说明，绝不降级成覆写
  shell.notify?.(ok === true ? 'info' : 'error', t(ok === true ? 'commit.appended' : 'commit.refused'))
}
```

规则（都与 `ui-plugins.md` §7 的"内部 API 会变"一脉相承）：

1. **草稿非空绝不 `setDraft`**：那会连用户已插入的引用 chip 一起抹掉；
   `insertText` 被拒绝（版本变了 / 正在提交）时**保留**结果并提示，不重试、不降级成覆写；
2. **`submit()` 之后不做任何"已提交成功"的 UI 承诺**：真正的成败在 transcript 里；
3. 发送失败（`submit()` 抛）→ 恢复草稿由会话自己负责（composer 有既有的失败恢复机制），
   面板只 `notify('error', …)`；
4. 发送时把按钮置为"已发送" 1.5 s，避免双击重复入队（同内容二次提交由模型侧的快照复核兜住）。

### 5.4 为什么不直接 `git commit`

- 提交是**有后果**的操作：本仓的 `dsh-tool-git` 有安全门（`destructivePolicy`），
  提交信息、路径范围、失败恢复都由工具面承担；
- 面板直接提交会绕过 transcript：用户看不到"谁提交了什么、为什么"，也无法在失败后让 agent 补救；
- 走对话还顺带解决"提交信息写不好"：模型看得到 diff，可以拟一条像样的。

> 这也是本方案与"IDE 的 Changes 面板"最大的差异：**它不是一个独立的 git 客户端，
> 而是把提交这件事交回给有上下文的 agent**。

---

## 6. 安全与红线

| # | 风险 | 处置 |
|---|---|---|
| S1 | 裸路由泄露工作区结构 | 只回**路径与计数**，绝不回文件内容；`session` 参数只能是活会话；只读（GET/HEAD），其他方法 405 |
| S2 | DNS rebinding / 跨站请求 | 抄 `ui-prompt-guide` 的 fence：拒绝 `Sec-Fetch-Site: cross-site`；带 `Origin` 时必须等于 `Host`；`Host` 只接受 loopback 或 `trustedHosts` |
| S3 | 仓库根被客户端随意指定 | 路由**不接受 cwd 参数**：只接受 `session`，宿主用 `ctx.sessions.get(id).header.cwd` 反查；cwd 不在仓库里就 `changes/not-a-repository` |
| S4 | `git` 卡死 / 大仓 | 每个 git 命令都有 `timeoutMs`；结果按 repo 缓存 750 ms；`maxFiles` 截断 |
| S5 | 注入：文件名里带 shell 元字符 | **不拼 shell**：全部经 `GitContext.run(args)`（数组参数）执行，路径永远在 `-z` 输出里，不参与字符串拼接 |
| S6 | 提示词注入：文件名里带换行/指令 | 文件清单**每行一个**、路径做转义（换行、`\u0000`、过长截断），模板头部固定说明这是数据 |
| S7 | 面板被当成提交成功凭证 | 见 §5.4：面板只发提示词，不显示"已提交" |
| S8 | 客户端内部 API 变更 | 服务缺失/注册失败一律降级成一条可见诊断，禁止渲染期抛错打空页面 |

---

## 7. 包结构与实现清单

新包 `packages/dsh-ui-changes`（**不带 scope**，与 `dsh-ui-versions` / `dsh-ui-plc-source` 一致）：

```
packages/dsh-ui-changes/
  package.json            # dsh.client + dsh.bundle.patch；main=lib/index.js，exports["./client"]
  cordis.patch.yml        # - id: ui-changes / name: dsh-ui-changes
  tsconfig.json           # "types": ["node"]（宿主用 URL/URLSearchParams）
  src/
    index.ts              # 宿主半侧：路由 + 两个服务的解析（已实现）
    service.ts            # gitContext 调用、超时、缓存、错误码（已实现）
    changes.ts            # 纯逻辑：解析 porcelain/numstat、合并、totals（已实现）
    route.ts              # 纯逻辑：fence + answer()（已实现）
    types.ts / errors.ts  # 线上载荷 + StatusError（已实现）
    prompt.ts             # 纯逻辑：buildCommitPrompt()（P2）
    client/
      index.jsx           # 类型注册 + 两个 seat + 取数（已实现）
      Panel.jsx           # 正文：摘要 + 列表（P2 加提交区）
      Title.jsx           # chip 标题
      store.js            # defineStore：选中集合/滚动（P2 需要时再加）
      locales.js          # NS='changes'，zh/en
      style.js            # 注入 CSS（--dsw-* 变量，跟随主题）
  test/
    01-route.test.mjs     # fence / 方法 / 参数 / 错误码映射 / 500 分支
    02-locales.test.mjs   # zh/en 键一致、占位符一致
    03-changes.test.mjs   # 解析（含重命名两种 -z 形态、二进制、未跟踪、截断）
    04-service.test.mjs   # 命令编排、超时、缓存、各种 StatusError
  scripts/build.mjs       # tsc + esbuild，产物带 __ModuleLoader__ 包装
  scripts/run-tests.mjs
```

宿主半侧骨架（关键点：**不 import `dsh-tool-git`，只用服务**；实际实现见 `src/index.ts`）：

```ts
export const name = 'ui-changes'
export const inject = ['webServer']   // sessions / gitContext 都用 ctx.get() 惰性取

export function apply(ctx) {
  const service = createStatusService({
    git: () => asGitService(ctx.get('gitContext')),
    sessionCwd: (id) => ctx.get('sessions')?.get(id)?.header?.cwd ?? null,
    readTextFile,                      // 未跟踪文件按行数计（有上限）
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/changes', handler: createHandler(service, ctx.logger),
  }), 'ui-changes: status route')
}
```

客户端 `face`（组件拿不到 ctx，注入值只暴露函数；错误一律是 `{ ok:false, code }`）：

```js
inject: (sessionId) => ({
  t,
  fetchStatus: (signal) => fetchStatus(ctx, sessionId, signal),
  sendPrompt: (text) => sendCommitPrompt(ctx, sessionId, text),   // P2
})
```

---

## 8. 分阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 链路** | 包骨架 + tab 类型 + 空面板；宿主路由返回硬编码 JSON | ✅ 2026-11-06（证据见 §8.1） |
| **P1 真数据** | `gitContext` → `status`/`numstat` 解析 + 摘要 + 列表 + 计数；刷新与轮询 | ✅ 2026-11-06（证据见 §8.2） |
| **P2 提交区** | 提交信息 + 选中集合 + 提示词模板 + 预览弹层 + 插入/提交 | 草稿空 → 提示词进输入框并被提交；草稿非空 → 追加且**不覆写**；无会话/无服务 → 按钮禁用且有说明 |
| **P3 打磨**（可选） | 打开文件预览、键盘导航、三态全选、错误码全覆盖、en 文案 | 每个 `changes/*` 错误码都有 zh/en 两句 |

端到端验收（本仓口径，见根 `AGENTS.md` §6）：

```powershell
pwsh -NoProfile -File scripts\start-env.ps1 -Restart
# 页面右侧栏 → Changes → 列表与 git status 一致
# 在仓库里制造一次改动 → 面板自动刷新出现一行 +N/−M
# 勾选 2 个文件、写提交信息、点提交 → 输入框出现提示词并发出
dsh --profile dsh-automation-suite --dump-config    # 插件行数从 12 变 13
```

单测只测**纯逻辑**（解析、模板、路由 answer、字典），宿主与浏览器的接线由真机验收兜住 ——
这与 `dsh-ui-plc-source` / `dsh-ui-versions` 的分工一致。

### 8.1 P0 落地记录（2026-11-06）

包：`packages/dsh-ui-changes`（宿主 `src/index.ts` + `src/route.ts`；客户端 `src/client/*`；
测试 20 项）。蓝图已登记（`dependencies` 与 `dsh.profile.bundles` 各一行）。

| 验收项 | 结果 |
|---|---|
| `pnpm -r build` / `pnpm -r typecheck` | ✅ 全仓通过（新包产物 `lib/client.js` 15.6 KB） |
| 新包单测 | ✅ 20/20（fence、方法/路径/参数、500 两个分支、字典一致性） |
| 装载 | ✅ `start-env.ps1 -Restart` 打印 `设置依赖: dsh-ui-changes` / `同步 bundles: dsh-ui-changes` |
| 启动图行 | ✅ `{"id":"dsh-ui-changes","url":"plugins/??dsh-ui-changes/client.js&rev=…"}` |
| 客户端产物 | ✅ 200 / 15 600 B，`window.__ModuleLoader__.load({ id: "dsh-ui-changes" … })` |
| `apply()` 执行 | ✅ 页面里出现 `style[data-plugin="dsh-ui-changes"]` |
| tab 能开 | ✅ 右侧栏引导页出现 **Changes** 胶囊，点开后渲染面板（真实 GUI，Playwright 驱动） |
| 路由 | ✅ `GET /changes/api/status?session=…` → 200 桩数据；POST → 405、缺 session → 400、`Sec-Fetch-Site: cross-site` → 403 |
| 面板内容 | ✅ 示例横幅 + `main · 0000000 · 4 files +64 −93` + 四行（M/A/D/?） |

> 两个照抄时容易踩的点：
> 1. `ensureStyle(ID)` 传的是**包名**，所以 `<style>` 上是 `data-plugin="dsh-ui-changes"`，
>    而不是 `style.js` 里的 `TAG_ID`（用 `TAG_ID` 去查会查不到，误判成"没加载"）；
> 2. 宿主半侧用到 `URL` / `URLSearchParams`，类型来自 `@types/node`，所以本包 `tsconfig`
>    是 `"types": ["node"]`（与 `dsh-ui-prompt-guide` 一致），不是 `dsh-ui-versions` 的 `"types": []`。

### 8.2 P1 落地记录（2026-11-06，真实数据）

宿主从"桩"换成真读：`src/service.ts` 通过 `ctx.get('sessions')` 把 sessionId 换成
`header.cwd`，再用 `ctx.get('gitContext').create(cwd)` 绑仓库，跑
`rev-parse --verify HEAD` / `symbolic-ref --short HEAD` / `status --porcelain=v1 -z -uall` /
`diff --numstat -z -M HEAD`（未诞生分支改 `--cached`）。解析在 `src/changes.ts`（纯函数），
未跟踪文件按行数计（≤200 个、≤1 MiB，超限只列不计）。测试 **48 项**（解析 18 / 服务 11 /
路由 17 / 字典 5，含超时、缓存、detached HEAD、重命名两种 `-z` 形态）。

| 验收项 | 结果 |
|---|---|
| 新包单测 | ✅ 48/48 |
| 真实会话 → 仓库 | ✅ 会话 `session-a5256726…` 的请求返回 `repo=C:\…\SWT1_HF48e_Pilot`、`branch=main`、`head=4af0a95` |
| 与 `git status` 对齐 | ✅ 面板 39 个文件 = `git status --porcelain` 39 行；`+40799 −0` 是这些未跟踪文件的行数合计 |
| 未跟踪计数 | ✅ `VOC-import-feasibility.md +327` 等逐项来自文件本身；PDF/AML 超过 1 MiB，只列不计（正是上限的目的） |
| 真实 `-z` 字节 → 解析器 | ✅ 以本仓为样本：40 条 status（14 tracked / 26 untracked）、numstat 14 条、tracked 行 **0** 个缺计数，`.gitignore` 的 `3\t0` 与原始 numstat 一致 |
| 路由错误路径 | ✅ 真会话 → 200；未知 session → 404 `changes/session-unknown`；缺 session → 400；POST → 405；cross-site → 403 |
| 刷新 | ✅ 面板挂载即拉一次；可见时每 5 s 一次（`document.hidden` 时停）；窗口 focus 拉一次；手动「刷新」立即拉 |
| 缓存 | ✅ 同一仓库 750 ms 内复用（单测断言 status 命令只跑一次） |

> P1 的两处实现选择，都写在这里以免下次"顺手优化"掉：
> 1. **未跟踪文件不套用 `numstat`**：git 对未跟踪文件没有这条线，硬凑会给出假数字；
>    取而代之是读文件数行，并以上限兜住"新仓库里几百个构建产物"这种场景；
> 2. **请求里不带路径**：只带 `session`，由宿主查 `header.cwd`。这是路由不被当成目录探测器的前提。

---

## 9. 风险与待拍板

### 9.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 内部客户端 API 变动 | 面板注册失败/静默空白 | 所有注册包 try/catch + 可见诊断；把跨包 API 收进 2 个文件 |
| 裸路由被部署方拒绝 | 无法交付 | 备选 B（§4.1）：写 `.dsh/changes-view.json` + `workspaceFiles` |
| 大仓库 `git status` 慢 | 面板卡顿 | 超时 + 缓存 + `maxFiles` 截断 + 只在可见时轮询 |
| 未跟踪文件太多 | 行数统计拖慢 | 上限（§4.3），超出后只列不计 |
| 与官方 `workspace-changes` 语义混淆 | 用户以为是"这轮改了什么" | 文案明确"未提交变更（相对 HEAD）"，不显示轮次信息 |

### 9.2 待拍板与已拍板

**已拍板（2026-11-06，用户）**

1. **不做「编译」按钮** —— 语义还没想好，本轮不引入；v1 的提交区只有「提交」与「预览提示词」。
2. **diff 只做计数** —— 面板显示 `+N/−M`，不做逐行对比视图（§9.1 的"是否需要 diff"因此关闭）。

**仍待拍板**

1. **提交范围**（P2 之前要定）：只允许"勾选路径"（默认，安全），还是也允许"提交全部"一个按钮？
   后者等价于 `git add -A`，风险更高但更省手。
2. **是否要放进 blueprint**：已做（`dependencies` + `dsh.profile.bundles`，`--dump-config` 13 → 14 行）；
   已物化的 profile **不会自动跟随**（根 `AGENTS.md` §1、`ui-plugins.md` §9.2），
   `start-env.ps1` 已在本次重启中自动同步。

---

## 10. 与既有三个右侧栏插件的差异（一句话）

| 插件 | 数据来源 | 写动作 |
|---|---|---|
| `dsh-ui-plc-source` | workspace 里的 `source/_manifest.json` | 无（只读；"在对话里提及"是写 composer） |
| `dsh-ui-versions` | workspace 里的 `.dsh/versions-view.json` | 无 |
| **`dsh-ui-changes`** | **宿主经 `gitContext` 现算，走自开路由** | **无 git 写；写的是 composer（提交提示词）** |

它是本发行版里**第一个**为了"实时状态"自开路由的 UI 插件 —— 因此 §6 的安全条目不是可选项。
