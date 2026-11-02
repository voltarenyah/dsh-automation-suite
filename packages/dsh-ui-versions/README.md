# dsh-ui-versions

DSH 插件（**浏览器半侧**）：在 dsh-web 的**右侧栏**增加一个 **Versions** 标签页，读工程上下文插件写出的
版本视图（`<workspace>/.dsh/versions-view.json`），展示版本历史、每个块的变更时间线与指纹变化。

> 本包只有 UI：宿主半侧是一个只写日志的 `apply()`，存在的意义是让包在 Loader 里有一行 ——
> `client-modules` 是**扫描已启用的 Loader 条目**才发现 `lib/client.js` 的，
> 没有行就不会有 `/plugins/??dsh-ui-versions/client.js`，而且**不报错**。
>
> 数据不在这里产生：视图文件由 `@voltarenyah/dsh-engineering-context` 在**版本操作之后**写出
> （`project_version_reindex`、`project_commit`、`project_version_annotate`）。
> 本包**不读 SQLite**，也不需要版本库的 schema。

## 它做什么

- 右侧栏 tab 类型（id `dsh-ui-versions`，kind `versions`，引导项 order **101**，排在 PLC Blocks 的 100 之后）；
- 顶部一行：标题、设备名、**刷新**（重新整文件读取一次；没有文件监听，切回 tab 不会自动重读）；
- 工具栏：**搜索**（提交号 / 标题 / 意图 / 块名 / 原因）、**All faces** 过滤、**All problems** 过滤
  （问题下拉只在视图里有问题时出现）；
- **VERSION HISTORY** 面板：计数 `n / total`，一行一个版本 —— 短 sha（10 位）、标题、日期、
  `checksumPrev → checksum`、徽章（`N block(s)`；没有变更事件的基线提交显示 `Baseline`）；
- 点版本行展开它的变更事件：变更徽章（`modified` / `added` / `removed`）、块 key（可点击）、
  `+added -removed`、**每个变化 face 一枚 pill**（`Code change` / `Interface change` …，
  **悬停**才显示该 face 的 `前 10 位 → 后 10 位` 指纹；缺失值显示 `—`）；
  再往下是 `Reason` 与 `Problem`（有才显示）；
- **BLOCK TIMELINE** 面板：点版本里的块 key 后，按 `seq` 列出这个块的每次变更 —— `#seq`、短 sha、日期、
  标题、face pills（同样悬停看指纹）、`Reason`；
- 可读性取舍：指纹只以 pill 悬停的形式出现（前 10 位），`reason` 只取首行并截到 160/180 字符。

**颜色只有一条规矩**：面（face）用三个色相区分 —— Code 蓝、Interface 紫、Comments 青（都由宿主
`--dsw-*` token 用 `color-mix` 派生，所以明暗主题都跟着走），Properties 保持中性；变更种类只用徽章上
的小圆点（新增绿 / 修改琥珀 / 删除红），`+n / -n` 也分别用宿主的增删色。除此之外一律中性色。

## 数据从哪来

```
<workspace>/.dsh/versions-view.json          ← dsh-engineering-context 写（派生文件）
        │  remote.workspaceFiles.readBytes(sessionId, path) 整文件一次读完
        ▼
   dsh-ui-versions（浏览器半侧）解析 → 过滤 → 渲染
```

- 路径常量在 `src/model.ts`（`VIEW_FILE`），与会写它的插件一致；
- 读取走宿主的 `remote.workspaceFiles`（`readBytes`），**没有新增 HTTP 路由**，
  也不把 SQLite 带进渲染进程；
- 视图字段：`device`、`workspace`、`generatedAt`、`counts.versions/events/baseline`、
  `versions[]`（每个带 `events[]`：`key` / `change` / `faces` / `before` / `after` / `linesAdded` /
  `linesRemoved` / `reason` / `problem`）、`timeline[]`、`problems[]`；
- 视图文件是**派生**的：删掉后重新跑一次版本操作就会再生成。

## 状态

| 状态 | 显示 |
|---|---|
| 会话没有工作区目录 | `noWorkspace`（说明无法读取版本数据） |
| 视图文件不存在 | `noView` + **Retry**（先提交一次，或运行 `project_version_reindex`） |
| 读取/网关失败 | `readFailed`，带错误码 + **Retry** |
| 过滤后没有匹配 | `noMatch` |
| 正在读取 | `loading` |

## 宽度行为

tab 的布局看**面板自己的宽度**，不看窗口宽度 —— 用 CSS **容器查询**（`.vsn-root { container-type: inline-size }`）
而不是 viewport media query：1600px 的窗口里侧栏可能只有 380px，media query 会把双列硬塞进去。

- 面板 ≥ **760px**：两列（左版本历史 / 右块时间线），中间是一条**可拖动的分隔条**
  （默认 62%，把手夹在 25%–75% 之间；拖动只改渲染态，不落盘）；
- 面板 < **760px**：单列，分隔条隐藏；
- 面板 < **560px**：版本行改成堆叠（sha / 标题 / 元信息各占一行）。

## 滚动

整个面板是**一个滚动容器**（`.vsn-root { overflow-y: auto }`），标题与工具栏用 `position: sticky`
固定在上方。原因：本插件坐在一个 `overflow: hidden` 且有固定高度的 tab 座位里，按"子元素自己滚"
的写法在窗口变矮时会**直接裁掉**内容而且没有滚动条（真机复现后改的）。滚动条显式设了
`scrollbar-width` / `scrollbar-color`，不再依赖会隐藏的 overlay 滚动条。

## 主题与语言

- 样式只用宿主的语义 token（`--dsw-alias-label-*`、`--dsw-alias-border-l1/l2`、`--dsw-alias-fill-l1`、
  `--dsw-alias-state-*`、`--dsw-alias-scrollbar-*`、`--dsw-alias-button-floating-fill`、`--dsw-radius-sm`，
  都带 fallback），**没有自带的调色板**，浅色/深色都跟随应用；
- face 的三个色相（Code 蓝 / Interface 紫 / Comments 青）是宿主 token 的 `color-mix`，不是新字面量，
  所以换主题时不会偏色；徽章上只保留 4px 语义点，`+n / -n` 用宿主的增删色；
- 下拉是**自绘**的（`Dropdown`），因为原生 `<select>` 的弹层由系统绘制 —— 深色主题下出现过
  浅底浅字（看不清）。自绘弹层用 `--dsw-alias-button-floating-fill` 作底色，跟着主题走。
- 字典在 `src/client/locales.js`：`NS = 'versions'`，`zh` / `en` 两份；
  `apply` 里 `ctx.locale.register(NS, { zh, en })`，`ctx.locale.bind(NS)` 拿到 `t`。
  界面文字**跟随 DSH 的语言设置**（设置 → 通用 → 语言），切换不刷新；
- tab 类型的标题是 **thunk**（`() => t('tab.title')`），另有一个 `sidebar.right.pane.tab.title` 座位
  （`src/client/Title.jsx`）让**已打开**的 chip 也跟着语言变。

## 装到本发行版

两处（少一处就静默不生效）：

1. `profile/dsh-automation-suite/package.json` 的 `dependencies` 加 `"dsh-ui-versions": "workspace:^"`；
2. 同文件 `dsh.profile.bundles` 加 `"dsh-ui-versions"`，位置在 `dsh-ui-tia-console` 之后、`dsh-opencode-go` 之前。

已物化的 profile **不能只靠依赖**：`start-env.ps1` 以前只在 profile 目录尚不存在时拷贝
`dsh.profile.bundles`。现在脚本多了一步 **bundle sync** —— 把蓝图的 bundle 列表并进已物化的
`package.json`（按蓝图顺序，profile 自己的额外条目保留在末尾），列表有变化时重装依赖。
症状记在这里，免得下次再查：只装依赖、不补 bundle 行时，`dsh-ui-versions` 不会出现在启动 HTML 里。

## 开发

```powershell
node scripts/build.mjs      # tsc → lib/index.js + lib/model.js；esbuild → lib/client.js
node scripts/run-tests.mjs  # 先构建，再 node --test（15 项：纯模型 10 + 字典 5）
node scripts/tsc.mjs -p tsconfig.json --noEmit
```

两个构建面各有原因：

- **宿主半侧 + 纯模型**：`tsc`（仓库根的 typescript），与兄弟包一致；
- **浏览器半侧**：`esbuild`（本仓 `.pnpm` 里已有，按候选路径探测，不新增依赖），产出
  `window.__ModuleLoader__.load({ id, factory })` 包装 —— 宿主只认这个形状，不是普通 ESM；
  只有宿主冻结的基座模块保持 external（`react` / `react/jsx-runtime` 等，清单见
  `scripts/build.mjs` 的 `PLATFORM_MODULES`），**其它 `@deepseek-ai/*` 一律不 import**。

浏览器半侧写 `.jsx` 而不是 `.tsx` 是有意的：本仓没有 `@types/react`，抽取的宿主运行时也没有 `.d.ts`，
`.tsx` 过不了 `tsc`。所以把"能类型检查的部分"留在 `src/model.ts`（有单测），
把"只能靠浏览器验证的部分"写成 `.jsx`（验收 = 真实 tab）。

## 已知边界

- **只在版本操作后更新**：视图文件由 reindex / commit / annotate 写出；TIA 侧改了但还没同步、没提交时，
  tab 不会自己变。刷新按钮只重读文件，不触发版本操作。
- **不解析 SQLite**：所有信息都来自视图文件；视图里没有的字段（例如文件内容、网络逻辑）这里也看不到，
  那是 expert / 图谱的事。
- **块时间线要点一下块 key 才出现**：面板不预选块（不同版本可能改的是不同块）。
- **不渲染 `added` 的完整旧状态**：`added` 事件的 `before` 为空，pill 的悬停提示左边显示 `—`。
- **同一视图文件串行覆盖**：多个版本操作连续跑时以最后一次写为准；没有历史视图文件。
- **没有文件监听**：切到别的 tab 再回来保留已读数据与筛选，但不会重新读取；需要用刷新按钮。
