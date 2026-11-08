# dsh-ui-project-dashboard

DSH 客户端的**全局面板**：在左侧栏最上面（Plugins 之上）加一行 **Project Dashboard**，
把当前所有 Workspace 汇总到一页——会话计数、最后活动，加上**多级标签**、顶部搜索与标签筛选。
工程规模 / 硬件 / 版本 / 图纸四格留给 P2（读各工作区的派生视图）。

> **当前状态：P1（行 + 标签 + 搜索/筛选，宿主侧标签持久化）。** 三个真实工作区、标签增删、
> 标签树筛选、搜索与刷新持久化都在 3095 实测通过。设计与取舍见
> [`docs/research/project-dashboard-feasibility.md`](../../docs/research/project-dashboard-feasibility.md)，
> 可交互的静态演示见 [`project-dashboard-demo.html`](../../docs/research/project-dashboard-demo.html)。

## 两个座位

| 座位 | 声明方 | 这份代码怎么用 |
|---|---|---|
| `sidebar.panellist`（root **list**） | `@deepseek-ai/dsh-client-ui-sidebar` | 一行：`id: project-dashboard`、`order: -10`、`label` thunk（跟随语言） |
| `main`（root **keyed**） | `@deepseek-ai/dsh-client-ui-layout` | 整页：`key: project-dashboard`，与左侧栏行同一个 id |

**为什么是 `order: -10`**：左侧栏的 `syncPanels()` 只按 `order` 升序排序（不看 `priority`）。
官方 Plugins 面板是 `order: 0`，Schedules 是 `10`；负值才能排到最上面（3095 实测生效）。

**注册顺序**：先注册 `main`，成功后才注册左侧栏行。选中一个没有 `main` 条目的面板会在外壳的
点击处理器里抛错（`layout.selectPanel: main panel "…" is not registered`），所以页面注册失败时
不留"点了就炸"的死入口。

## 标签持久化（P1 的宿主半侧）

文件：**`<DSH_HOME>/storages/project-dashboard/tags.json`**，按 **workspace id** 存：

```jsonc
{
  "version": 1,
  "revision": 12,
  "owner": "dsh-ui-project-dashboard",
  "workspaces": {
    "<workspaceId>": {
      "path": "C:\\...\\SWT1_HF48e_Pilot",  // 宿主从 workspaceRegistry 反查的 canonical path
      "tags": ["客户/PEI", "产线/焊装/HF48e"],
      "updatedAt": "2026-11-05T07:01:36.054Z"
    }
  }
}
```

`path` 只用于排错与将来"同路径重新挂接"，**不参与匹配**；`revision` 每次成功写入 +1。

协议（`src/route.ts`）：

```
GET  /project-dashboard/api/tags
→ { ok, revision, corrupt, workspaces }

POST /project-dashboard/api/tags
   { workspaceId, op: "add"|"remove", tag, expectedRevision }
   { workspaceId, op: "set", tags: string[], expectedRevision }
→ { ok, revision, entry, workspaces }
   400 tag/…            标签非法（空、超过 4 级、单级超过 40 字…）
   409 tags/conflict    另一个窗口先写过；响应带当前 revision
   413 body/too-large   请求体超过 16 KiB
```

页面只在**打开时 GET 一次、每次编辑 POST 一次**；没有轮询、没有逐项目宿主任务。

## 默认工作区：这个发行版不要它

DSH 外壳在**空安装首次启动**时会自动建一个 first-use Workspace（`Documents/deepseek-harness/default-workspace`）。
本发行版不需要这个概念。宿主侧没有"不要创建"的开关，官方 `ui-workspace` 也没有过滤钩子，
所以这里采取**两步**（2026-11-05 用户决定）：

1. **页面隐藏**：宿主从 `storages/workspace.json` 读 `global.defaultWorkspaceId`（registry 服务没有这个 getter），
   GET 告诉页面这个 id；页面把它从行里排除 —— 即使它还注册着也看不到。
2. **一键注销**：只要它还注册着，页面顶部出现一条提示 +「移除默认工作区」按钮；
   POST 走 `workspaceRegistry.delete(id)`。**非破坏性**：文件夹与所有会话日志都留着，
   它的会话归到"未分组"（左侧栏中空白会话本来就不显示）。注销后 durable 的
   `defaultWorkspaceId` 标记仍在，外壳的 `initializeDefault` 不会再造一个 —— 一次即永久。

左侧栏本身无法用插件过滤（`sidebar.workspaces` 是 single 座位，替换等于重写整个会话浏览器），
所以"左侧栏不出现"就是靠注销；注销后 New Session 的回退目标是当前/最近的**真实**工作区，
没有真实工作区时是一个未绑定工作区的空白页，不会绑到默认工作区。

> **全新安装**：外壳仍会在首次启动时创建它一次（客户端调用 `initializeDefault`，宿主无法阻止）。
> 打开本页点一次「移除默认工作区」即可永久消除。宿主启动时自动清理**暂不做**（2026-11-05 决定：
> 先保持一键，等确有需要再议）。

```
GET  /project-dashboard/api/default-workspace
→ { ok, id: "<workspaceId>" | null, registered: boolean }

POST /project-dashboard/api/default-workspace        ← 只注销，不删文件/会话
→ { ok, deleted: true } | { ok, deleted: false, reason: "not-initialized"|"no-registry"|"not-registered"|"delete-failed" }
```

### 安全与边界（写进代码注释与文档，别忽略）

- `ctx.webServer` 的自开路由**没有鉴权**（只有 `/api` 有）。这条路由抄了最小 trust fence：
  拒绝 `Sec-Fetch-Site: cross-site`、要求 `Host` 是 loopback（可配 `trustedHosts`）、
  `Origin` 存在时必须与 `Host` 一致。**这不是鉴权**；本机进程本来就能直接读那个文件。
- 请求里**没有任何路径**（只收 workspace id 与标签），因此没有目录穿越面。
- 写入是**原子**的：同目录 temp → fsync/rename，旧文件留一份 `tags.json.bak`；
  文件坏掉时读侧报 `corrupt`，下一次写先把损坏文件另存为 `tags.json.corrupt-<ts>` 再写。
- `DSH_HOME` 解析：`process.env.DSH_HOME`（启动器会设），否则 `~/.dsh`。刻意不 import
  `@deepseek-ai/dsh-home-paths`：本包不带运行时依赖链接，两行 fallback 是诚实的契约；
  非默认 home 只要导出 `DSH_HOME` 即可。
- **按 id 存的代价**：删掉再添加同一目录会拿到新 id，标签变孤儿（文件里还在、页面看不到）。
  条目里存了 `path`，以后可以做"同路径重新挂接"；**不自动删**。跨机器分享标签需要连
  `storages/workspace.json` 一起拷（id 来自它）。

## 结构

```
src/index.ts              宿主半侧：标签文件 + 路由注册 + workspaceRegistry 路径反查
src/tags/model.ts         文档形状、标签校验/规范化、纯 mutation、冲突/输入错误
src/tags/store.ts         原子写、.bak、损坏文件保留、进程内串行、expectedRevision 检查
src/default-workspace.ts  默认工作区标记读取、状态、注销（非破坏性）
src/route.ts              tags + default-workspace 路由、trust fence、body 上限
src/client/index.jsx      两个座位的注册、uiWorkspace 回调、探针 dataset.dshProjectDashboard = 'p1'
src/client/dashboard.jsx  页面：行、标签、搜索、筛选树、编辑器、账条、默认工作区提示
src/client/model.js       纯函数：行构建、筛选、标签树、汇总
src/client/tags-api.js    tags / default-workspace 的 fetch 封装（错误带 host code）
src/client/style.js       P1 样式（注入一次 <style data-plugin>，只用 --dsw-* token）
src/client/locales.js     zh / en 字典（**扁平点号键**，client-locale 按 dict[key] 查）
scripts/{build,tsc,run-tests}.mjs
test/                     01 结构 + 10 客户端模型 + 11 存储 + 12 路由 + 13 默认工作区
```

## 构建与验收

```powershell
# 构建 / 类型检查 / 测试（pnpm install 已把 typescript 与 @types/node 装进本包）
node scripts/build.mjs
node scripts/tsc.mjs -p tsconfig.json --noEmit
node scripts/run-tests.mjs      # 35 项
```

装进发行版验收环境（3095）：

```powershell
pwsh -NoProfile -File ..\..\scripts\start-env.ps1 -Restart
```

页面里应看到：左侧栏第一行是 Project Dashboard；只列出真实工作区（默认工作区被隐藏，若仍注册则顶部有提示条）；
「+ 标签」加一个 `客户/PEI` 后刷新仍在（文件里带 canonical path）；搜索"客户"命中；标签树按层级筛选；
`document.documentElement.dataset.dshProjectDashboard === 'p1'`。

（宿主半侧改动必须重启实例；只改浏览器半侧时刷新页面即可，`lib/client.js` 的 rev 由 mtime 派生。）

## 下一步（P2）

四个指标格现在是 `— / P2`：接入 `source/_dsh-engineering-context.json` 与
`.dsh/{hardware-view,versions-view,drawing-manifest}.json`，每格独立降级，并显示各自的 `generatedAt`。
数据仍走 `workspaceFiles`（借任一会话的绝对路径读），不新增宿主任务。
