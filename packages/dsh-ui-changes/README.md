# dsh-ui-changes

DSH 插件：右侧栏一个 **Changes（变更）** 标签页，列出当前工作区里**未提交**的文件
（含每文件 `+N/−M`），并把「提交」做成一次带上下文的对话行为。

> **状态：P1（真实 git 数据；提交区未做）。** 宿主按会话的 `header.cwd` 找仓库，经
> `gitContext`（`dsh-tool-git`）跑 `status --porcelain=v1 -z` 与 `diff --numstat -z -M HEAD`，
> 面板可见时每 5 s 自刷新。**P2 的提交区尚未实现** —— 现在面板只读。
> 设计与验收记录见仓库 [`docs/ui-changes-panel-plan.md`](../../docs/ui-changes-panel-plan.md)。

## 数据链路

```
session id ──ctx.get('sessions').get(id)──▶ header.cwd
          ──ctx.get('gitContext').create(cwd)──▶ repoDir
          ──git status -z / git diff --numstat -z ──▶ ChangedFile[] + totals
```

- 只读、无写操作：不 stage、不 commit，也不读文件内容（未跟踪文件只数行，≤1 MiB、≤200 个）；
- 750 ms 内同仓库的结果复用，避免面板轮询把 `git` 拉爆；
- 失败一律 `{ ok:false, code }`，面板按码选文案（非仓库 / 没装 git 插件 / 会话无目录 / 超时）。

## 它做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 右侧栏 tab：仓库 / 分支 / HEAD + 文件清单 + 每文件 `+N/−M` | 不显示 diff 内容（v1 只做计数） |
| 宿主一条**只读**路由 `GET /changes/api/status?session=<id>` | 不执行 `git commit`（提交由 agent 经 `dsh-tool-git` 的工具完成） |
| 失败降级成一行可见诊断（错误码 → 字典键） | 不新增模型工具、不读 SQLite、不写工作区 |

数据来自**宿主现算**，不是某个落盘产物：面板要的是"此刻相对 HEAD 的状态"，
所以它是本发行版里少数自开 HTTP 路由的 UI 插件之一。

## 安全边界

`ctx.webServer` 的路由**没有宿主鉴权**（只有 `/api` 有），因此这条路由：

- 只回**路径与计数**，不回文件内容；
- 只认 `session` 参数（不接受任意 cwd）；
- 自带 trust fence：拒绝 `Sec-Fetch-Site: cross-site`、要求 `Host` 是 loopback
  （或显式 trusted）、`Origin` 存在时必须等于 `Host`；
- 只允许 `GET` / `HEAD`。

详见 [`src/route.ts`](src/route.ts) 顶部注释。

## 构建与安装

```powershell
# 包内构建（tsc 出 lib/index.js + lib/route.js，esbuild 出 lib/client.js）
node scripts/build.mjs
node scripts/run-tests.mjs
node scripts/tsc.mjs -p tsconfig.json --noEmit

# 装进某个 profile（tarball 形式）
pnpm pack
dsh plugin --profile <profile> add <tgz>
```

蓝图（`profile/dsh-automation-suite`）里已登记：`dependencies` 一行 + `dsh.profile.bundles`
一行，`dsh --profile dsh-automation-suite --dump-config` 应出现 `# == dsh-ui-changes`。

## 布局

| 路径 | 作用 |
|---|---|
| `src/index.ts` | 宿主半侧：注册 `/changes` 前缀路由 |
| `src/route.ts` | 纯逻辑：fence、方法/路径/参数规则、JSON 封装、P0 桩数据 |
| `src/client/index.jsx` | tab 类型 + 两个座位 + 取数函数 |
| `src/client/Panel.jsx` | 正文：摘要 / 列表 / 错误态 |
| `src/client/locales.js` | `NS='changes'`，zh / en 两份字典 |
| `test/` | 路由纯逻辑 + 字典一致性（`node:test`，驱动构建产物） |
