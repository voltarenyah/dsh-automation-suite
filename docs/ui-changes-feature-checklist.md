# Changes 面板功能清单（对齐 better-sidebar 的 Git 页）

> **用途**：以 `dsh-better-sidebar@0.28.0` 的 Git 页为参照，列出「我们的 `dsh-ui-changes` 可以做哪些功能」，
> 供逐条取舍。编号稳定，答复时按 `A03 / C02 …` 点选即可。
>
> **状态**：清单本身是**待拍板**；当前已实现的是 P1（只读列表 + 计数 + 5 s 轮询），P2 未做。
> 参照物源码：`~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/src/`（MIT）；
> 其能力来自 `gui/git.ts`、`index.ts` 的 `git.*` 路由、`client/changes/GitLens.tsx` 等。

图例：**成本** S（<1 天）/ M（1–3 天）/ L（3 天以上或会改架构）；
**建议**：✅ 推荐做 ／ 🤔 可做但看取舍 ／ ⛔ 不建议。

---

## A. 列表与状态（"看得见"）

| ID | 功能 | better-sidebar 怎么做 | 我们的成本 | 建议 |
|---|---|---|---|---|
| A01 | Merge / Staged / Changes **三组**分组，每组带文件数 | porcelain 的 `XY` 拆成三组 | S | 🤔 我们 39 行的规模，分组收益一般；冲突组值得要 |
| A02 | 每文件 `+N/−M`，**暂存/未暂存分开算、不相加** | 两次 `--numstat`（index vs HEAD、worktree vs index） | M（P1 只做了「相对 HEAD」一份） | ✅ 要真做「暂存 + 未暂存」就得改成两份计数 |
| A03 | 状态徽章（M/A/D/R/?/冲突），按色区分 | `StatusBadge` + tone 映射 | ✅ 已有 | ✅ 已有（`M/A/D/R/C/?/!`） |
| A04 | **目录树分组 + 可折叠**，行内露出所在目录 | `change-tree.ts` 建树，行内显示 path 前缀 | M | 🤔 39 行平铺够用；树在几百文件时才有价值 |
| A05 | 未跟踪文件不给计数（git 没有 numstat） | 不渲染 null | ✅ 已有 | ✅ 已有 |
| A06 | 二进制文件标 `binary` 而不是 `+0 −0` | `GitLineCounts` 变体 | ✅ 已有（`binary: true`） | ✅ 已有 |
| A07 | 超过上限时提示「列表被截断」 | `GIT_STATUS_LIMIT` + `truncated` | ✅ 已有（`maxFiles`） | ✅ 已有 |
| A08 | **嵌套仓库发现 + 仓库切换** | `repoRoots()` 扫 cwd 下多仓，下拉切换 | L | ⛔ 我们的会话 cwd 就是仓库根，不需要 |
| A09 | **git worktree 列表 + 切换** | `git worktree list --porcelain`，菜单切 | L | ⛔ 工控工程不用 worktree |
| A10 | 自动刷新：自适应节流（30 s → 60 → 180 → 停），仅可见时轮询 | 全局 git-status store + 慢查询降级 | M | 🤔 我们固定 5 s；大仓库上应改成"慢就退避" |
| A11 | 手动刷新 | 按钮 | ✅ 已有 | ✅ 已有 |
| A12 | 只显示会话 cwd 所在仓库 | `-C <cwd>` | ✅ 已有 | ✅ 已有 |
| A13 | 状态着色同步到文件树 | 共享 store | — | ⛔ 那是它的文件树；我们不做文件树 |

## B. 逐文件操作（"改得动"）

| ID | 功能 | better-sidebar 怎么做 | 我们的成本 | 建议 |
|---|---|---|---|---|
| B01 | 点行 → 底部 **diff 预览**（可拖高度、可切 tab） | 自绘 diff（行号、高亮、binary/超大提示） | L | 🤔 与早前"diff 只做计数"的决定冲突；要看就往这做 |
| B02 | **暂存单文件 / 暂存全部** | `git add` | S | 🤔 与"提交走 agent"的路线要一致：面板直接写 git 就破了安全门 |
| B03 | **取消暂存单文件 / 全部** | `git reset` | S | 🤔 同上 |
| B04 | **丢弃改动**（danger + 二次确认） | `git checkout -- <path>` | S + 风险 | ⛔ 破坏性操作，交给 agent + 安全门 |
| B05 | 右键菜单：打开编辑器 / 复制相对路径 / 复制绝对路径 | 菜单 | S | ✅ 复制路径、打开文件值得要（我们已有 `openResource`） |
| B06 | 行内文件图标 | `fileIcon()` | S | 🤔 纯装饰 |
| B07 | 行内 hover 出现暂存按钮 | 悬浮操作 | S | 跟 B02 一起定 |

## C. 提交（"提交得动"）

| ID | 功能 | better-sidebar 怎么做 | 我们的成本 | 建议 |
|---|---|---|---|---|
| C01 | 提交信息输入框，`Ctrl+Enter` 提交 | 顶部一行 textarea | S | ✅ 要（P2 已规划） |
| C02 | **由模型生成提交信息**（Generate 按钮） | 宿主 `git.suggest-message` 调 `ctx.llm`，喂 diff 前 12k 字符 | M | 🤔 另一条路：把提示词发给 agent，让它生成——二选一，别都做 |
| C03 | 选择生成用的模型（每会话记住） | `git.commit-model` + 设置页 | M | 🤔 只有走 C02 才需要 |
| C04 | **直接 `git commit`** | `runGit(['commit','-m',msg])` | S | ⛔ 与"提交经 agent、可审计、受 `destructivePolicy` 约束"冲突；这是我们要**有意不做**的一条 |
| C05 | 提交后自动刷新 | 触发 store refresh | ✅ 已有（轮询/C01 后刷新） | ✅ 已有 |
| C06 | 提交失败提示（含原因） | toast/内联 | S | ✅ 要（P2） |
| C07 | 空变更时禁用提交并提示 | | ✅ 已有（clean 空态） | ✅ 已有 |
| C08 | **勾选部分文件提交**（我们的差异点） | 它没有；只能全量 / 按组 | S | ✅ 要（P2 的路径白名单） |

## D. 分支与同步

| ID | 功能 | better-sidebar 怎么做 | 我们的成本 | 建议 |
|---|---|---|---|---|
| D01 | 分支下拉切换（checkout） | `git checkout <branch>` | M | ⛔ 切分支是重操作，属于 agent |
| D02 | 显示当前分支 / detached | `symbolic-ref` | ✅ 已有 | ✅ 已有 |
| D03 | upstream / ahead / behind | `rev-list --left-right` | M | 🤔 有用但只在多机协作时；工控仓库常无 upstream |
| D04 | push / pull（菜单） | `git push/pull` | M + 凭据问题 | ⛔ 网络写操作，交 agent |
| D05 | 冲突组单独列出 | porcelain `U*` | S | ✅ 值得（我们目前只给 `!` 徽章） |
| D06 | 新建分支 | 它没有 | — | ⛔ 不做 |

## E. 历史与提交图

| ID | 功能 | better-sidebar 怎么做 | 我们的成本 | 建议 |
|---|---|---|---|---|
| E01 | 只读**提交图**（泳道、ref 徽章、分叉合并） | 自绘 `graph-layout.ts` | L | ⛔ 它是 git 客户端；我们不是 |
| E02 | 提交图按分支筛选 | `git log <branch>` | M | ⛔ 随 E01 |
| E03 | 分页加载 + "refs 变了请刷新" | 每页 200 / 偏移 1 万 | M | ⛔ 随 E01 |
| E04 | 提交详情（作者/时间/完整信息） | `git show` | M | 🤔 也许只要"最近 5 条提交"做参考 |
| E05 | 提交 diff | `git show`/`commitDiff` | M | ⛔ 随 E01 |
| E06 | 复制短/全 hash、复制标题 | 菜单 | S | 🤔 低价值 |
| E07 | revert / cherry-pick | danger 菜单 | M + 风险 | ⛔ 破坏性，agent 的事 |
| E08 | blame（编辑器行内） | `git blame --porcelain` | L | ⛔ 没有编辑器就不需要 |

## F. 与 AI 的联动

| ID | 功能 | better-sidebar 怎么做 | 我们的成本 | 建议 |
|---|---|---|---|---|
| F01 | **Session lens**：本轮 AI 读/写/编辑过哪些文件（按 `tool/*` 事件折叠） | `changes.ops` 路由 + 客户端折叠 | L | 🤔 与 DSH 自带 deliverables 卡片重叠；我们用 `dsh-tool-git` 视角更准 |
| F02 | 读操作无 diff、写操作看 before/after | 同上 | L | ⛔ 随 F01 |
| F03 | Session lens 与 git lens 共用一个底部预览面板 | 共享 pane | M | ⛔ 随 F01 |
| F04 | 把文件以 `@` 引用插进对话草稿 | `conversation.input` + 结构化插入事件 | S | ✅ 简单且契合"结合上下文"，可和 P2 一起做 |
| F05 | **提交提示词发进对话，由 agent 提交** | **它没有** | S（P2） | ✅ 这是我们的核心差异点，保留 |

## G. 体验与基础设施

| ID | 功能 | better-sidebar 怎么做 | 我们的成本 | 建议 |
|---|---|---|---|---|
| G01 | 中英双语 | 自建 locales | ✅ 已有 | ✅ 已有 |
| G02 | 每会话独立状态（lens、面板高度、选中项）持久化 | tab meta | M | 🤔 选中项 + 滚动位置可要，面板高度没得拖 |
| G03 | 可拖拽的底部预览面板 | 自绘 pane | M | 随 B01 |
| G04 | 设置页（提交模型、编辑器、排除模式…） | `settings.section` | M | ⛔ 我们的配置项应放插件 config，不新开设置页 |
| G05 | 错误态 / 空态文案 | 内联 Notice | ✅ 已有 | ✅ 已有 |
| G06 | `Ctrl+Enter` 提交快捷键 | composer 焦点 | S | ✅ 要（C01 的一部分） |
| G07 | 大仓库保护（输出上限、超时、截断） | `runGit` 30 s 超时 + 输出上限 | ✅ 已有（10 s + 截断） | ✅ 已有，可按 A10 再加退避 |
| G08 | 自带 trust fence 的宿主路由 | 它自己的校验 | ✅ 已有 | ✅ 已有 |

---

## 一句话总结

- **它比我们多的**：暂存/取消暂存、diff 预览、丢弃、提交图、worktree/multi-repo、Session lens、生成提交信息。
- **它没有、而我们有**：每文件 `+N/−M` 的独立视图（它有计数但埋在树里）、"提交提示词发进对话"的审计式提交。
- **冲突点只有一个**：C04 直接 commit —— 一旦要它，我们的 P2 目标就变成"面板即 git 客户端"，安全门与 transcript 都不再经过。

> 取舍时建议只问一句：**「这个面板是"给 agent 看的变更视图"，还是"独立的 git 客户端"？」**
> 前者保留 F05 / B05 / D05 / A01 这类轻量项；后者才需要 B01–B04、C02–C04、E01–E07。
