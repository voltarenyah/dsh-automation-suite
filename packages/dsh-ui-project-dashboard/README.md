# dsh-ui-project-dashboard

DSH 客户端的**全局面板**：在左侧栏最上面（Plugins 之上）加一行 **Project Dashboard**，
把当前所有 Workspace 的基本信息汇总到一页——会话计数、工程规模、硬件、版本、图纸，
外加**多级标签**、顶部搜索与标签筛选。

> **当前状态：P0（链路占位）。** 左侧栏入口与整页面板已注册，页面只说明注册结果与后续计划；
> 数据、标签与搜索在 P1/P2 接入。设计与取舍见
> [`docs/research/project-dashboard-feasibility.md`](../../docs/research/project-dashboard-feasibility.md)，
> 可交互的静态演示见 [`project-dashboard-demo.html`](../../docs/research/project-dashboard-demo.html)。

## 两个座位

| 座位 | 声明方 | 这份代码怎么用 |
|---|---|---|
| `sidebar.panellist`（root **list**） | `@deepseek-ai/dsh-client-ui-sidebar` | 一行：`id: project-dashboard`、`order: -10`、`label` thunk（跟随语言） |
| `main`（root **keyed**） | `@deepseek-ai/dsh-client-ui-layout` | 整页：`key: project-dashboard`，与左侧栏行同一个 id |

**为什么是 `order: -10`**：左侧栏的 `syncPanels()` 只按 `order` 升序排序（不看 `priority`）。
官方 Plugins 面板是 `order: 0`，Schedules 是 `10`；负值才能排到最上面。

**注册顺序**：先注册 `main`，成功后才注册左侧栏行。选中一个没有 `main` 条目的面板会在外壳的
点击处理器里抛错（`layout.selectPanel: main panel "…" is not registered`），所以页面注册失败时
不留"点了就炸"的死入口。

## 结构

```
src/index.ts              宿主半侧：Loader 行 + 空 apply()（浏览器半侧才是本体）
src/client/index.jsx      apply(ctx)：两个座位的注册、探针
src/client/style.js       P0 页面样式（注入一次 <style data-plugin>，只用 --dsw-* token）
src/client/locales.js     zh / en 字典（rail label 两种语言都是 Project Dashboard）
scripts/{build,tsc,run-tests}.mjs
test/01-manifest.test.mjs 行名/导出/产物结构
```

## 构建与验收

```powershell
# 构建 + 类型检查 + 测试（不需要 pnpm 在 PATH 上）
node scripts/build.mjs
node scripts/tsc.mjs -p tsconfig.json --noEmit
node scripts/run-tests.mjs
```

装进发行版验收环境（3095）：

```powershell
# 蓝图里已登记；-Restart 会同步 bundles 并重启
pwsh -NoProfile -File ..\..\scripts\start-env.ps1 -Restart
```

页面里应看到：左侧栏**第一行**是 Project Dashboard（在 Plugins 之上）；点开是 P0 说明页；
`document.documentElement.dataset.dshProjectDashboard === 'p0'`（只有 `apply()` 会写它，
用来区分"行没出现"和"bundle 根本没跑"）。

## 边界

- 页面**不**在后台跑宿主命令；工程数据只读派生视图，标签存浏览器 `localStorage`（P1）。
- 所有跨包访问都收敛在 `src/client/index.jsx`；座位/服务名属于宿主内部约定，升级宿主需复核。
- 宿主半侧不持有任何资源：没有行，浏览器半侧不会被请求（`client-modules` 扫描已启用的 Loader 条目）。
