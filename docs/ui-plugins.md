# Web GUI UI 插件：可行性、机制与落地方案

> **本文的定位**：发行版层面的说明 —— 在本发行版（`dsh-automation-suite`，宿主 DSH
> **0.2.1-rc.2**；机制结论最初实测于 0.2.0-rc.2）
> 里给 **dsh web 页面**增加 UI 组件，有哪些路可走、各自的代价、以及一个具体案例
> （**工程块树**：把 workspace 里 `source/` 下的程序块渲染成可折叠树）的落地设计。
>
> **版本口径**：2026-10-19 在 0.2.1-rc.2 上**复核过**的是 —— 基座模块表（§2.3，已按新宿主重写）、
> 页面 boot 与 `PLATFORM_MODULES` 的读取方式。**其余机制条目仍以 0.2.0-rc.2 的实测为准**，
> 升级到 0.2.1 后没有逐条复核；引用前先按本节的方法在你实际要跑的宿主上重读一遍。
>
> **证据口径**：本文的机制部分**都在本机实测过**（运行中的 GUI、app.asar 里的官方产物、真实的
> `source/` 导出物），实测结论标 ✅；来自上游公开源码/文档、但未在本机逐条验证的标 📖；
> 还没验证的推断标 ⚠️。上游源码 <https://github.com/deepseek-ai/deepseek-harness> 是公开的，
> 但**默认分支可能比本机宿主新**，读它时要按版本核对。

---

## 1. 结论速览

| # | 路线 | 一句话 | 代价 | 适合 |
|---|---|---|---|---|
| **1** | **静态客户端 UI 插件包**（`dsh.client` + `lib/client.js`） | 新建一个插件包，浏览器半侧用 React 注册到既有 slot / 右侧栏 tab；宿主半侧是空 `apply()` | 一次性搭出**客户端打包链**（本文 §5），之后每个 UI 组件都是普通 React | ✅ **生产级推荐**：要长期维护、要随发行版交付 |
| **2** | **动态 Cordis 包**（浏览器半侧纯 JS，运行期求值） | 切到内置 `cordis` preset（创造模式），由 agent 写一个「定义」并在内存里跑 | 无 JSX/TS、能力受 guard 白名单限制、需人工审批、刷新即失 | 一次性/探索性面板、演示 |
| **3** | **宿主 HTTP 路由 + `fetch`** | 宿主半侧 `ctx.webServer.register({ kind, path, handler })` 出一条 JSON 路由，浏览器半侧直接 fetch | 自己管一条路由**和它的鉴权**（宿主不替你鉴权，见 §7.5） | 数据必须**宿主侧聚合**（图谱库查询、超大清单、跨工作区扫描） |
| 4 | 借第三方 `dsh-better-sidebar` 的 tab 注册服务 | 该包对外暴露「注册 sidebar tab / 文件查看器」的服务 | 依赖一个第三方插件的 API 稳定性 | 只是想快速验证、且愿意接受外部依赖 |

**本案例的推荐组合：路线 1（静态插件包）+ 会话作用域的面板 —— 落在「右侧栏 tab」
（边聊边看）或「会话主区 View 标签页」（Chat / Trajectory 旁边那一排，整页浏览）都可以，
两者共用同一套数据面与树模型，只差注册到哪个座位；数据走既有 `workspaceFiles` Remote，
不写任何宿主路由。** 后面 §4 是完整设计。

> 另一条本方案**不用**但值得知道的路：**不写生成器手写 Typert Remote**。宿主网关有 SRC 回退模式
> （`@Remote()` 标注 + `ctx.connection.rpc.call('/api', '<namespace>/<method>', { args })`），
> 但类型与 schema 的生成器对第三方不可用，且约束不少（参数只能是朴素标识符等）。
> 需要"新的宿主能力 + 强类型调用面"时再考虑，本案例的只读清单用不上。

---

## 2. 机制：客户端插件到底怎么被加载的

### 2.1 实测证据（本机、运行中的 GUI）

`http://127.0.0.1:19387/` 的 HTML 里注入了 `window.__DSH_BOOT__` 启动图，其中**已经有三个第三方
客户端 bundle**：`dsh-better-sidebar`、`dsh-remote-mobile`、`dsh-opencode-go`。✅
并且直接用组合 URL 取回了其中一个：

```powershell
Invoke-WebRequest "http://127.0.0.1:19387/plugins/??dsh-better-sidebar/client.js&rev=bb0fcabf352f"
# → 200，1,287,936 字节，开头就是：
#   window.__ModuleLoader__.load({ id: "dsh-better-sidebar", factory: (require) => { ... } });
```

结论：**第三方 UI 插件在本机已经是"跑起来"的形态**，不是纸面可能。

**而且本文作者做了一次完整的端到端实测**（与上一段是同一个宿主版本，2026-10-18）：临时目录里造一个
最小第三方包（`dsh.client` + 手写的 `lib/client.js`，无打包器）→ 装进一个**独立 DSH_HOME 的临时 profile**
→ 起一个独立端口的实例 → 用浏览器打开：

| 步骤 | 命令/动作 | 观测结果 |
|---|---|---|
| 1 | `dsh plugin --profile ui-probe add file:<pkg>` | 自动把 `dsh-ui-probe` **追加进** `dsh.profile.bundles`（无须手改 profile） |
| 2 | `dsh --profile ui-probe --dump-config` | 结尾出现 `# == dsh-ui-probe` / `- id: ui-probe` / `name: dsh-ui-probe` |
| 3 | 起实例（`--port 3099 --no-open`） | 监听成功；打印带 token 的 URL |
| 4 | `GET /`（带 token） | 启动图里出现 `{"id":"dsh-ui-probe","url":"plugins/??dsh-ui-probe/client.js&rev=e82d6ac9aef0","rev":"e82d6ac9aef0"}` |
| 5 | `GET /plugins/??dsh-ui-probe/client.js&rev=e82d6ac9aef0` | **200**，返回我手写的 bundle |
| 6 | 浏览器打开该实例后取 `document.documentElement.dataset.uiProbe` | **`loaded:react=true`**，且 `document.body.dataset.uiProbeEffect === 'on'` |

第 6 步同时证明了三件事：**bundle 被执行**、**`apply(ctx)` 被调用**、
**`require("react")` 从宿主平台模块表解析成功**。整条链路
（`dsh.client` 声明 → bundle 路由 → 浏览器执行 → Cordis 装载 → 平台模块）**不需要任何宿主侧改动**。

启动图每一行的形状（✅ 从 index.html 抄下来的真实片段）：

```jsonc
{ "id": "dsh-better-sidebar",
  "url": "plugins/??dsh-better-sidebar/client.js&rev=bb0fcabf352f",
  "rev": "bb0fcabf352f",
  "inject": ["@deepseek-ai/dsh-client-locale", "..."] }
```

- `rev` 由宿主按**产物 `lib/client.js` 的 `mtimeMs / ctimeMs / size`** 派生（📖 上游 `client-modules`），
  **改内容即换 rev**；单资源 URL 不带 rev 会 404（✅ 实测），浏览器从行里派生 rev；
- 页面 shell 持有的 `window.__ModuleLoader__` queue facade 会把这些 bundle 收进模块表，
  再交给浏览器侧 Cordis 装载（每行一个 fiber）。facade 的 `mode` 从 `queue` 变 `live` 即装载完成（✅ 实测）。

### 2.2 一个 UI 插件包的最小契约（✅ 对照 asar 里的官方产物）

```jsonc
// package.json
{
  "name": "@scope/my-ui-plugin",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":        { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" }   // ← dsh.client 声明要求它存在
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-sidebar-right"]
    }
  }
}
```

```js
// lib/index.js —— 宿主半侧：插件的 Loader 行，什么都不做也是合法的
/** Loader-visible no-op body; the browser half carries the feature. */
export function apply() {}
```

```js
// lib/client.js —— 浏览器半侧，必须是这个包装形式
window.__ModuleLoader__.load({
  id: '@scope/my-ui-plugin',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const react = require('react')                 // 平台模块，裸 require
    function apply(ctx) { /* 注册 slot / tab / 字典 */ }
    const inject = ['slots', 'sessions', 'locale', 'sidebarRightTabs']
    exports.apply = apply; exports.inject = inject
    return module.exports
  }
})
//# sourceMappingURL=client.js.map
```

要点（✅ 来自官方 bundle、我的实测探针，📖 上游 `client-modules` 与 `tsdown.client.ts`）：

- **宿主半侧可以完全是空的**：官方 `dsh-client-ui-jobs/lib/index.js` 就是 `function apply() {}`，
  整包的价值都在浏览器半侧。这一行存在的意义只是"让包在 Loader 里有一个条目"。
- **`dsh.client.platform` 必须是 `'web'`**（否则该行被**静默丢弃**），且**必须**有 `./client` 导出
  （否则宿主抛 `declares dsh.client but exports no "./client" bundle`）。
- **`id` 必须与 `package.json` 的 `name` 逐字相同**：它是模块表的键。写错的表现是
  `loaded without registering "<id>" via __ModuleLoader__.load`（重试一次后回落到单资源 URL）。
- **脚本执行时除了 `window.__ModuleLoader__.load(...)` 什么都不能做**：所有副作用（含 CSS 注入）
  必须在 `factory` 内，否则物化时机就错了；顶层 `require(...)` 也会直接失败。
- 懒分块的文件名必须匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`，且分块 banner 里的
  `chunk:` 必须等于 `require.async("./client.<name>.js")` 的文件名。
- `dsh.client.inject` 是**信息性**的包名边（预检展示、HMR diff 用），**不排序激活**；
  真正的等待靠 Cordis 服务 `inject`（见 §2.4）。
- `dsh.client.external` 只用于**非基座**模块请求，并且会让宿主的模块图把提供方排到消费方之前；
  基座模块（§2.3）**不要**在这里重复声明。若请求了非基座的模块又忘了声明，**这是运行期错误**
  （`require("…") missed the module table`）——第三方没有上游那道构建期 purity 闸门。

### 2.3 基座模块表（`PLATFORM_MODULES`，✅ 0.2.1-rc.2 实测全表）

外壳启动时冻结一张静态模块表；浏览器半侧可以用裸 `require(...)` **直接拿到、无需声明**的
就是这张表（从运行中的 shell bundle `assets/index-*.js` 里直接读出来的，**这就是本机宿主版本的权威列表**）：

```js
{ "react": …, "react/jsx-runtime": …, "react-dom": …, "react-dom/client": …,
  "@deepseek-ai/cordis": …,
  "zod": …,
  "@tanstack/react-virtual": …,
  "@deepseek-ai/dsh-client-store": …,
  "@deepseek-ai/dsh-client-ui-slots": …,
  "@deepseek-ai/dsh-client-ui-primitives": …,
  "@deepseek-ai/dsh-client-ui-dockkit": … }
```

✅ 交叉验证：`ui-primitives`、`ui-slots`、`client-store`、`ui-dockkit` 在启动图里**没有行**
（= 静态基座库；`ui-dockkit` 甚至没有独立包，它折进 shell），而 `ui-renderer`、`client-locale`、
`ui-sidebar-right`、`api-workspace-files`、`ui-sidebar-files`、`ui-conversation` 等**有行**（= 动态插件）。

⚠️ **这张表随宿主版本变，不能跨版本照抄**：0.2.0-rc.2 的宿主**没有** `zod` 与
`@tanstack/react-virtual`（当时只在未发布的分支上），**0.2.1-rc.2 已经把两者加了进来** ——
上面的表就是按 0.2.1-rc.2 重读的。复核办法：从 `app.asar` 取出
`@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js`，搜 `react/jsx-runtime`，
那个对象字面量就是权威列表（源码侧对应 `packages/client/web/src/platform.ts`）。

推论（也是官方红线 📖）：

- 可以**运行时** import 的：`react`、`ui-primitives`（共享控件库）、以及 `ui-slots`/`client-store`
  这类**静态**库的导出；
- **不可以**运行时 import 别的**功能插件**的值（如 `ui-sidebar-files`），
  跨包只能走 `import type` + Cordis 服务的注入面 + slot。

### 2.4 两个 inject 面，别混（📖 上游 `packages/client/AGENTS.md`，本机有实例佐证）

| | Cordis 服务 `inject` | 模块图 |
|---|---|---|
| 单位 | 服务名（`slots`、`locale`、`sidebarRightTabs`…） | 模块说明符（`react`…） |
| 时机 | 运行期；fiber **等待** | 物化期；`require` 同步、**不能等** |
| 不满足时 | 保持 pending（不超时） | 当场抛错 |

三条实测过的坑（✅ 来自本机已安装的第三方插件源码注释/上游源码）：

1. **嵌套服务要逐个列**：访问 `ctx.remote.workspaceFiles` 必须在 `inject` 里同时写
   `'remote'` 与 `'remote.workspaceFiles'`，否则 Cordis 报
   `cannot get property "remote.workspaceFiles" without inject`。
2. **服务可能来得比你的插件晚**：注册进别人的服务（如 `sidebarRightTabs`）要用
   `ctx.inject(['sidebarRightTabs'], (i) => { ... })`，不要在自己的 `apply` 里直接 `ctx.sidebarRightTabs`。
   这一条在本案例上有具体原因：右侧栏那个座位**先声明 slot、后提供 `sidebarRightTabs` 服务**，
   所以"等 slot 声明"的写法拿到的服务还是 `undefined`。
3. **注册 slot 必须用 `ctx.slots.inject(name, () => ctx.slots.register(...))`，不能用裸 `register`**：
   子 slot 只在声明它的父条目挂载期间存在，裸 `register` 会抛
   `slot "X" is not declared (a parent entry's children table must declare it)`。
   `slots.inject` 会在每次声明生命周期内重跑、父条目塌陷时撤回你的贡献、重新声明后重跑。

### 2.5 座位：UI 挂在哪里

| 座位 | 键 | 形态 | 适用 |
|---|---|---|---|
| 会话主区的 **View 标签页** | `conversation.view`（**list**，session scope；`id` = 标签身份 + `order` + `label`） | 与 **Chat / Trajectory 并列**的整页视图 | ✅ 另一个首选落点：**会话作用域 + 整页**，见 §2.5.1 |
| 右侧栏 **tab 类型** | `ctx.sidebarRightTabs.register({ id, kind, title, guide, patterns?, priority?, canOpen?, keepMounted?, multiple? })` + `sidebar.right.pane.tab`（keyed，**key = 定义的 `id`，不是 `kind`**）+ `sidebar.right.pane.tab.title`（keyed）+ 可选 `sidebar.right.tab.guide`（chain）/`.guide.entry`（keyed）/`.menu.item`（list） | 每会话一个停靠面 | **本案例首选**：会话作用域、可与文件预览并排分栏、可全屏 |
| 主栏全局面板 | `sidebar.panellist`（root **list**，一行一个图标 + `label` + `order`）+ root `main`（**keyed**）+ `ctx.layout.selectPanel(id)` | 整页 | 跨会话的仪表盘；**没有会话就没有 `sessionId`**（见 §4.1 的取舍） |
| 会话 header 控件 | `conversation.session.header.actions`（list，标题旁）/`.utilities`（list，右对齐）/`.corner`（single，最右角）/`.lineage`（single） | 小控件 | 状态灯、下拉浮层。**优先用两个 list 座位**，single 会挤掉产品自带的格子 |
| 设置区 | `settings.section`（list，owner 给 `close()`） | 设置页片段 | 配置项 |
| 浮动层 | `shell.overlay`（list，root） | 浮动面板 | 悬浮树 |
| 会话节点 | `conversation.chat.node`（keyed） | 转录行 | 与某个事件类型绑定的卡片 |
| root | `'root'`（只有外壳能渲染） | — | 不要动 |

> `rightbar.session` 是**已被占用**的 single 座位（右侧栏自己占着）——注册它会**替换整列**，不要碰。

#### 2.5.1 会话主区顶部的 View 标签栏（Chat / Trajectory 那一排）——✅ 第三方可加

那个标签栏就是 slot **`conversation.view`**：由 `dsh-client-ui-conversation` 拥有，声明在
`conversation.session` 的 `children` 表里，**`kind: 'list'`、`scope: 'session'`**
（✅ 从本机 asar 的产物里读出的原句：
`children: { "conversation.view": { kind: "list", scope: "session" } }`）。
随包的两个贡献者：`chat`（fallback）与 `trajectory`（`order: 10`）。加一个自己的标签页：

```tsx
export const inject = ['slots', 'sessions', 'uiConversation', 'locale',   // 按需再加 'remote'/'remote.workspaceFiles'
]

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'eng-blocks: dictionaries')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'engineering-blocks',        // list slot → id 必需；同时就是标签身份与偏好键
    order: 20,                       // 升序（trajectory = 10）
    locale: NS,
    label: () => t('view.blocks'),   // 标签文字；thunk → 跟随语言，不必重新注册
    inject: (sessionId: SessionId) => ({ /* 纯数据与回调：sessionId、读清单、树 */ }),
  }, BlocksView))
}
```

行为要点（📖 官方 README + 上游 `ui-trajectory/src/client/index.ts`，✅ 声明与渲染从本机产物读实）：

- 组件是**整页**视图：主区渲染 `renderSlot('conversation.view', { inspectCall, viewRequest,
  openView, completeViewRequest }, { only: viewId })`，也就是同一时刻只挂载被选中的那一个；
- **可用 View 少于两个时整个标签栏隐藏**（现在 Chat + Trajectory = 2，本来就显示）；
- **blank session 不渲染这个 slot**（没有会话就没有标签栏）；
- 用户选的 View 偏好**按会话持久化**，下次进入直接回到他上次的视图；
- Trajectory 的可用性受"代码工作工具"开关控制，而**其它插件贡献的 View 不受它影响**
  （README 原话：关闭时"外壳仅隐藏 Trajectory；其他插件贡献的 View 仍然可用"）。

⇒ 对「工程块树」来说这是**和右侧栏 tab 等价的首选**：同样会话作用域（有 `sessionId`，能读
`workspaceFiles`），但拿到的是**整页宽度**，适合树 + 详情并排；代价是与对话争主区（用户要来回切）。

### 2.6 谁能加座位：新增插件是唯一干净的路

| 做法 | 能不能加 | 说明 |
|---|---|---|
| **新增一个自己的插件包**（推荐） | ✅ | 座位就是扩展点：`ctx.slots.inject(name, () => ctx.slots.register(...))`、`ctx.sidebarRightTabs.register(...)`、`ctx.layout` 都是给**别的包**用的。官方随包的 `ui-sidebar-documentpreview`/`ui-sidebar-files`、第三方 `dsh-remote-mobile`/`dsh-better-sidebar` 走的都是同一条路，**不需要宿主或官方包配合**。 |
| **改官方 UI 插件** | ❌ | 官方包在 `resources/app.asar` 里，是只读安装产物，宿主升级即被替换；就算 fork 上游自建一份，也会和产品自带的同名行/kind 冲突（`tab type id "…" is already registered`、`tab kind "…" is already registered`），升级后还要重做。要改官方行为的正当形式是**给上游提 PR**。 |
| **借第三方 `dsh-better-sidebar`** | ⚠️ 有条件 | 它**不是宿主，是和你的插件同级的一个第三方插件**；它自己也是用同一套原生座位实现的（`src/client/native/index.ts` 读 `ctx.sidebarRightTabs` 注册类型、`ctx.slots.inject('sidebar.right.pane.tab', …)` 注册正文，`native/surface.ts` 是它对 `ctx.sidebarRight` 的写面）。它额外 `ctx.provide('betterSidebar', service)` 提供 `registerTab` / `registerFileViewer` / `registerFileIcon` / `openTab` / `isTabEnabled`，供别的插件往**它的侧栏**里加页。代价：你的 UI 只在装了它且启用时存在；你绑的是它自己定的 API；而且**会话主区那个 View 标签栏它管不着**（那是原生 `conversation.view`）。要用就走 Cordis 服务注入（`inject: ['betterSidebar']`），**不要**运行时 import 它的 `/client/service` 值。 |

**替换**与**新增**是两件事：想让某个已有 `kind`（例如 `files`）改由你的实现渲染，机制是注册**同 `kind` 的
`extension` 档**（extension 生效，builtin 在它离开后恢复）——那仍然是通过**你自己的插件**做的，
而不是去改官方包。

> 顺带：本仓的 `profile/dsh-automation-suite` 蓝图本身就是"聚合层"（把多个插件行插进组合），
> 所以你不需要再造一个 aggregate bundle；新增 UI 插件只要建包 + 把包名写进蓝图 `dsh.profile.bundles`。

### 2.7 开发期会碰到的两件事

- **产物才是真源**：宿主服务的是 `lib/client.js`，不是源码；改完必须重新构建
  （`pnpm --filter <pkg> build`）并让页面重载该行。
- **HMR**：客户端 HMR 驱动器（`dsh-client-hmr`）在 bundle 重建后按 `rev` 让那一行重新加载；
  但**新包首次挂载、`package.json` 的 `dsh.client` 变化、新增动态提供方**这类事仍要刷新页面。

---

## 3. 数据面（本案例）：`source/` 里到底有什么

### 3.1 目录与索引（✅ 实测本机真实工程）

```
<workspace>/                                     ← = 会话 cwd（宿主 workspace registry 认领）
├── tia/<workspace 名>/<workspace 名>.ap17        ← 二进制工程，不进 git
├── source/
│   ├── _dsh-engineering-context.json             ← 索引：这棵树属于哪个工程 + 每台设备的清单路径
│   └── <device>/
│       ├── _tia-openness-manifest.json           ← **唯一**的清单：三类对象都在里面
│       ├── blocks/<组路径>/<块目录>/<块>.xml
│       ├── types/<组路径>/<类型>.xml
│       └── tag_tables/<表>.xml
└── knowledge/<device>/<device>_knowledge.db      ← 图谱库（二进制，不进 git）
```

✅ 本机实例（`C:\Users\Ansel\Documents\deepseek-harness\tia-project-first`）：

| 项 | 实测值 |
|---|---|
| 索引 | 1 台设备 `Sino_PEI`，`exported: { blocks: 1155, types: 215, tagTables: 7 }`，`totals: { planned: 1377, written: 1375, refused: 2 }` |
| 清单 | **773,378 字节 / 17,464 行 / 1376 条**（`blocks[1376]` + `failures[2]`） |
| 分组深度 | 1–6 层（`group` 用 `/` 分隔，末尾带 `/`） |

清单里**每条对象**有的字段（✅ 实测并集）：
`name`、`group`、`file`（绝对路径）、`bytes`、`sha256`、`category`（`blocks` / `types` / `tag_tables`）、
`simaticType`（`FB` / `FC` / `OB` / `InstanceDB` / `GlobalDB` / `ArrayDB` / `PlcStruct` / `PlcTagTable`）、
`declaredName`、`declaredNumber`、`programmingLanguage`（`SCL` / `LAD`…）、`verified`。

### 3.2 能用它做什么、不能做什么（⚠️ 关键设计约束）

**能**：按设备/分组/块渲染树；显示块类型、编号、编程语言、字节数、写后读回校验结果；
筛出被 TIA 拒绝的对象（`failures[]`，本机 2 条：`FOB_SAFETY` 等）。

**不能**（依据本仓 [`MANIFEST-GAP-ANALYSIS.md`](../packages/dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md)）：

- ❌ **不能做变更检测**：`sha256` 是"导出文件字节"的哈希，而文件里含 `<DocumentInfo><Created>`，
  **每次导出都变**。树里绝不要写"已修改/未修改"这类结论。
- ❌ 没有跨导出稳定的对象 id、没有每对象时间戳、没有 Know-how 标志、没有 Safety 签名、
  没有项目/设备元数据块、`file` 是绝对路径（换机器/搬目录即失配）。
- 要做变更检测 → 得先在接口插件族补"内容级语义哈希"，那是另一条工作线。

### 3.3 浏览器怎么读到它（✅ 复用官方 `workspaceFiles` Remote）

`@deepseek-ai/dsh-api-workspace-files` 客户端面（由官方 `ui-sidebar-files` 在用同一套）：

```ts
// 每个方法都在线路上带 sessionId；路径可以是绝对路径或相对会话工作区根
remote.workspaceFiles.list(sessionId, path, signal)                    // 目录直接子项（限工作区内）
remote.workspaceFiles.stat(sessionId, path, signal)                    // { absolutePath, version, bytes? }
remote.workspaceFiles.read(sessionId, path, { offset?, limit? }, signal)// **按行分页**：UTF-8 文本
remote.workspaceFiles.readBytes(sessionId, path, { range?, baseFile? }, signal) // Uint8Array
remote.workspaceFiles.changes(sessionId, path, signal)                 // 变更流（ready + change）
```

- **上限**：单页文本/单字节窗口 `maxBytes` 2 MiB；`readBytes` 不带 `range` 时整文件上限
  `maxFileBytes` 32 MiB；`read` 的 `limit` 默认与上限都是 **5000 行**；`list` 的 `maxEntries` 2000（超出截断并报告）。
- ⇒ **读清单必须用 `readBytes(path, {})` 整文件读**，再 `TextDecoder` + `JSON.parse`；
  用按行分页的 `read` 读 17,464 行的清单要 4 页，纯属自找麻烦。
- 失败一律是带 `code` 的 `RemoteError`（`workspace-file/not-found`、`outside-workspace`、
  `not-text`、`not-directory`…）：**按 code 分支，不要按 message 文本**。

---

## 4. 推荐方案：「工程块树」面板

### 4.1 落点：会话作用域的两个座位

`workspaceFiles` 的每个方法都要 `sessionId`，也就是说这个 UI **天生是会话作用域的**。
会话作用域下有两个合适的座位，**都满足需求，按使用习惯选**：

| 落点 | 形态 | 适合 | 代价 |
|---|---|---|---|
| **右侧栏 tab**（§2.5 第一行） | 每会话一个停靠面板，可与文件预览/终端并排分栏、可全屏 | 想边看对话边看树；树常常只是"顺手看一眼" | 面板较窄（默认约视口 45%） |
| **会话主区 View 标签页**（§2.5.1） | 与 Chat / Trajectory 并列的**整页**视图 | 想认真浏览/检索 1155 个块，甚至树 + 详情并排 | 与对话争主区，来回切 |

**不推荐主栏全局面板**：它不绑定会话，要自己从"当前选中的会话"推导 `sessionId`，
只有做成**跨会话总览**（所有 workspace 的块）时才值得。

下面的设计（数据面、store、树模型、构建、验收）**两个落点完全通用**——差别只有
"注册到哪个座位"这一处（§4.4 里两段注册代码任选其一）。

### 4.2 放哪个包

| 选项 | 优点 | 缺点 |
|---|---|---|
| **A. 新建 `packages/dsh-engineering-context-ui`（推荐）** | UI 与宿主插件各自独立发版/启停；宿主插件保持"纯 Node、tsc + node:test"的干净面；符合官方"一个 UI 特性 = 一个插件包"的口径 📖 | 多一个包、多一条 bundle 行（`start-env.ps1` 会自动带上）；需要一条跨包**类型**契约 |
| B. 把浏览器半侧加进现有 `@voltarenyah/dsh-engineering-context` | 少一个包、少一条行；路径与清单类型就在手边 | 该包要同时长出浏览器构建面（tsconfig face、打包器、CSS 打包），它现在只有 `tsc`；一旦 `dsh.client` 声明了但 `lib/client.js` 没构建出来，web 侧启动审计会报错（`client bundle not found`） |

选 A。类型契约不共享运行时：UI 包自己对清单/索引写一份 `interface`（`import type` 不算运行时依赖），
再用**真实清单 fixture** 做单测钉住形状。

> 两条**数据通道**的取舍（与座位无关）：读清单走 `workspaceFiles` 远程通道 ——
> 零宿主代码、带会话作用域与工作区包含检查、走鉴权过的 `/api`；
> 只有需要宿主侧聚合（图谱库 SQL、跨工作区扫描、超大清单）时才自开
> `ctx.webServer.register({ kind: 'prefix', path: '/<something>/api', handler })`，
> 并且**必须自己抄一份 trust fence**（见 §7.5）。

### 4.3 包结构与文件职责

```
packages/dsh-engineering-context-ui/
├── package.json                 # name/exports(./client)/dsh.bundle.patch + dsh.client
├── cordis.patch.yml             # insert: { id: engineering-context-ui, name: '@voltarenyah/dsh-engineering-context-ui' }
├── tsconfig.json                # host face
├── tsconfig.client.json         # browser face（jsx: react-jsx）
├── tsdown.config.ts             # 两个入口：lib/index.js（宿主）+ lib/client.js（浏览器，见 §5）
├── locale/{zh,en}.json          # 展示标题/描述（插件管理页用）
├── icon.svg
├── src/
│   ├── index.ts                 # 宿主半侧：export const name / export function apply() {}（空）
│   └── client/
│       ├── index.tsx            # apply(ctx)：注册 tab 类型 + slot 组件 + 字典
│       ├── definition.tsx       # ctx.sidebarRightTabs.register({...}) 的静态声明 + guide 入口
│       ├── TabBody.tsx          # 正文：搜索框 + 树
│       ├── TabTitle.tsx         # tab 标题（图标 + 文案）
│       ├── store.ts             # defineStore：展开集合、折叠状态、过滤串、滚动位置
│       ├── model.ts             # 清单/索引的 TS 类型 + 纯函数：JSON → 树（可单测）
│       ├── face.ts              # 经 remote.workspaceFiles 读索引/清单 + changes 失效
│       ├── locales.ts           # 文案字典
│       └── TabBody.module.css   # 只用 --dsw-* 语义 token
└── test/                        # node:test：model.ts 的树构建、清单字段、错误码分支
```

### 4.4 关键骨架（按 0.2.0-rc.2 的 API 面；`id`/`kind`/slot key 三者的关系是本节的要点）

```tsx
// src/client/definition.tsx
export const BLOCKS_ID = '@voltarenyah/dsh-engineering-context-ui'  // 全局唯一；**就是 slot key**
export const BLOCKS_KIND = 'engineering-blocks'                     // 新 kind，别撞 files/browser/terminal
export function blocksDefinition(t: TranslateNS<'engBlocks'>): SidebarRightTabDefinition {
  return {
    id: BLOCKS_ID,
    kind: BLOCKS_KIND,
    priority: 'extension',            // 产品外的类型默认档；没有 patterns 时是惰性的
    title: () => t('type.label'),     // 页 tab 的地址是 `sidebar://<kind>`，别去解析它
    guide: [{ id: 'blocks', order: 40, title: () => t('guide.title'),
              description: () => t('guide.description') }],   // 引导页入口胶囊（id 必须定义内唯一）
    // 不写 patterns → 页类型，按 kind 打开；不写 canOpen → 无可否决；multiple → 一格一页，不写
  }
}
```

```tsx
// src/client/index.tsx
import { defineStore } from '@deepseek-ai/dsh-client-store'  // ✅ 静态基座库，可直接运行时 import
                                                             //    实测导出：createSnapshotStore / defineStore /
                                                             //    notifySubscribers / shallowEqual
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'      // 声明 ctx.slots 与标准 props
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client' // 声明 ctx.sidebarRight(Tabs)
// 其余跨包一律 import type：api-remotes / api-workspace-files / ui-session / client-locale

export const inject = [
  'slots', 'locale',
  'sidebarRightTabs', 'sidebarRight',      // 右侧栏：类型注册表 + 导航控制器
  'remote', 'remote.workspaceFiles',       // 数据面（嵌套服务必须两项都写）
  // 'sessions' 由 ui-session 提供、'shortcuts' 可选；只想用其一就 ctx.inject 局部等待
]

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind('engBlocks')
  ctx.effect(() => ctx.locale.register('engBlocks', { zh, en }), 'eng-blocks: dictionaries')

  // ① 类型注册：必须在任何 openTab(kind) 之前完成
  ctx.effect(() => ctx.sidebarRightTabs.register(blocksDefinition(t)), 'eng-blocks: tab type')

  // ② store 句柄在 apply 里建一次（**不要**写成模块级单例），正文与标题共享同一实例
  const store = createBlocksStore()

  // ③ 数据面做成 inject 工厂（sessionId, actions) => 注入值：组件永远拿不到 ctx
  const face = blocksFace(createRead(ctx.remote))

  // ④ 正文/标题：keyed seat，key 必须等于定义的 id
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: BLOCKS_ID, locale: 'engBlocks', store, inject: face },
    BlocksBody,
  )), 'eng-blocks: body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: BLOCKS_ID, store },
    BlocksTitle,
  )), 'eng-blocks: title')

  // ④′ 若落点选「会话主区 View 标签页」，把 ①②③④ 换成：注册一个 list 座位的
  //     标签页（id 即标签身份），正文组件换成整页的 BlocksView，其余完全一样：
  // ctx.slots.inject('conversation.view', () => ctx.slots.register({
  //   name: 'conversation.view', id: BLOCKS_ID, order: 20, locale: 'engBlocks',
  //   label: () => t('view.blocks'), store, inject: face,
  // }, BlocksView))
}
```

```ts
// src/client/store.ts —— 视图状态（折叠/过滤/滚动/清单缓存），写入只经 actions
export function createBlocksStore() {
  return defineStore({
    init: () => ({ byTab: {} as Record<string, BlocksTabState> }),
    actions: {
      start(d, tabId, root) { d.byTab[tabId] = { root, phase: 'loading', devices: [], expanded: [], scrollTop: 0 } },
      loaded(d, tabId, devices) { /* phase='ready'; devices */ },
      failed(d, tabId, failure) { /* phase='failed'; failure：按 error.code 渲染一行 */ },
      toggled(d, tabId, nodeId) { /* expanded 里增删 */ },
      forget(d, tabId) { /* tab.signal 中止时清桶 */ },
    },
  })
}
```

```ts
// src/client/face.ts —— 数据面：只用远程通道，不写宿主路由
const INDEX = 'source/_dsh-engineering-context.json'          // 相对会话工作区根

/** 清单必须**整文件**读：17k 行的缩进 JSON 用按行分页要 4 次请求，而 readBytes 一次就够。 */
export async function loadJson(remote, sessionId, path, signal) {
  const r = await remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
  if (!r.ok) return r                                  // Remote 调用**从不 reject**，一律 {ok,value|error}
  return { ok: true, value: JSON.parse(new TextDecoder().decode(r.value.data)) }
}
```

```ts
// src/client/model.ts —— 纯函数，最好单测（不需要 React、不需要浏览器）
/** 目录里每个块自带一层同名子目录（blocks/<组>/<块目录>/<块>.xml），
 *  所以「程序块视角」的树要丢掉 group 的最后一段，块本身当叶子。 */
export function groupPathOf(entry: ManifestEntry): string[] {
  const parts = entry.group.split('/').filter(Boolean)
  return parts.length > 0 && parts[parts.length - 1] === entry.name ? parts.slice(0, -1) : parts
}
export function buildTree(manifest: OpennessManifest): DeviceNode[] { /* device → 组 → 对象 */ }
```

**正文组件怎么拿数据**（组件只收派生 props，不碰 ctx）：`useTabInfo()`（框架注入）给
`{ sidebar: {expanded, fullscreen}, panel: {id}, tab: { id, kind, visible, navigation, signal, actions } }`；
`useSessions(s => s.byId[sessionId]?.cwd)` 给工作区根；`props.useStore(sel)` 读、`props.actions.*` 写。
首次挂载用 `if (state === undefined && cwd !== undefined && !signal.aborted) actions.start(...)` 播种，
刷新按钮用 `tab.actions.bindCommands({ refresh })` 绑定。

```ts
// src/client/model.ts —— 纯函数，最好单测（不需要 React、不需要浏览器）
/** 目录里每个块自带一层同名子目录（blocks/<组>/<块目录>/<块>.xml），
 *  所以「程序块视角」的树要丢掉 group 的最后一段，块本身当叶子。 */
export function groupPathOf(entry: ManifestEntry): string[] {
  const parts = entry.group.split('/').filter(Boolean)
  return parts.length > 0 && parts[parts.length - 1] === entry.name ? parts.slice(0, -1) : parts
}
export function buildTree(manifest: OpennessManifest): TreeNode { /* device → 组 → 对象 */ }
```

**渲染**：树行直接用 `ui-primitives`（静态基座库，`require('@deepseek-ai/dsh-client-ui-primitives')`）：
`DisclosureRow`（24px 紧凑折叠行，正是树行想要的形态）、`Tag`（FB/FC/OB/DB 徽章）、
`StateDot`（`verified` 状态）、`Input`（过滤）、`PathLabel`（路径）、`icons/*`。**不要**另写一套控件。

**交互（v1 边界）**：折叠/展开、按名称与块类型过滤、点块名用
`tab.actions.openResource(fileAddressFor(...))` 打开既有 XML 预览 tab（复用
`ui-sidebar-documentpreview`，无需自己写查看器）、手写"重新读取"按钮 +
`workspaceFiles.changes` 失效。（**不做**：变更标记、搜索文件内容、编辑、拖拽。）

---

## 5. 构建：本方案最大的一次性成本

宿主只认 `lib/client.js` 那种 **`window.__ModuleLoader__.load({ id, factory })`** 包装。
**官方的构建助手对第三方不可用**（已核实）：`packages/client/` 在这个 tag 上**连 `package.json` 都没有**
（不是可发布单元）；`@deepseek-ai/dsh-build-utils` / `dsh-tsdown` / `dsh-client-build` 等候选包
在 npm 上**全部 404**；即使把 `tsdown.client.ts` 抄出来也不能在仓库外跑 —— 它 import 了
`modules/src/client/manifest.ts`、`web/src/platform.ts`、`scripts/*`，还按 `packages/*/*/package.json`
定位包。所以**必须自己产出这个包装**（这是本方案唯一"新造轮子"的地方，做完可被后续所有 UI 插件复用）。

好消息：包装本身只是 rolldown/tsdown 的 **`banner`（函数形式）+ `intro` + `footer`**，上游就是这么做的。
把下面这段照抄即可（📖 逐字来自上游 `tsdown.client.ts`）：

```ts
outputOptions: {
  entryFileNames: 'client.js',
  chunkFileNames: 'client.[name].js',
  banner: (chunk) => `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, ` +
    `${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
  intro: 'var module = { exports: {} }; var exports = module.exports;',
  footer: 'return module.exports; } });',
}
```

配套的其余配置（📖 上游同源 + ✅ 子代理已用 `tsdown@0.22.14` 实际构建并逐字节比对过产物形状）：

```ts
export default {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib', format: 'cjs', platform: 'browser',
  dts: false, sourcemap: true, clean: false,
  deps: {                                   // ← 与 dsh-tool-git 的 neverBundle 同理，别内联宿主
    neverBundle: (s) => external.has(s),    //   external = §2.3 基座表 ∪ dsh.client.external
    alwaysBundle: (s) => !external.has(s),
  },
  define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"',
            'import.meta.env.MODE': '"production"', 'import.meta.env': '{"MODE":"production"}' },
  plugins: [cssPlugin(), asyncChunkRequirePlugin()],
  outputOptions: { /* 上面那段 banner/intro/footer */ },
}
```

三条**不做就会静默出错**的配套（都有实际失败模式）：

1. **CSS**：`.module.css` 过 lightningcss（`cssModules.pattern: '[hash]_[local]'`）后，产物里放
   `if (document.querySelector('style[data-plugin-css="<包名>/<文件>"]') === null) { … }`。
   严格说**不打标记也能跑**（loader 会把没有 `data-plugin` 的 `<style>` 认领走），但认领者是
   "下一个物化的插件"，而回收（`removeOwnedStyles`）按属性删 —— 所以**必须打标记**。
2. **懒分块**：rolldown 的 CJS 动态导入要改写成 `require.async("./client.<name>.js")`，
   且非入口 banner 要带 `chunk: "client.<name>.js"`；v1 不用分块就整包一个文件，最省事。
3. **`rev` 只取 `lib/client.js` 的 mtime/ctime/size**，响应又是 `immutable` 长缓存：
   **只重建了 chunk 时，要在 `writeBundle` 里把 `client.js` 的 mtime 往后顶 ≥1 ms**，
   否则新 chunk 永远拿不到（上游为此专门打了 `utimes`）。

**依赖怎么钉**：打包器用 `tsdown@0.22.14`（上游 tag 是 `^0.22.2`；**别用 0.23.x**，本机宿主产物是
0.22.x 构建的）+ `lightningcss@1.32.0`；`rolldown` 随 tsdown 传递（1.2.13）。`react`/`@types/react`
只作 devDependencies，**`@deepseek-ai/*` 不要写进 dependencies**（运行期由宿主提供）。

**验收（不能只看构建成功）**——本文作者就是这么验的，两条都必跑：

```powershell
pnpm -r build                                    # 新包必须产出 lib/index.js 与 lib/client.js

# A. 独立环境：蓝图里登记了新 bundle，start-env.ps1 会自动带上
pwsh -NoProfile -File scripts\start-env.ps1 -Restart
#    然后浏览器里应看到引导页入口与本 tab

# B. 真交付物：临时 home + 临时 profile，第三方视角
$env:DSH_HOME = "$env:TEMP\ui-verify"
dsh plugin --profile ui-verify add <tarball 或 file:路径>   # 会自动把包名追加进 dsh.profile.bundles
dsh --profile ui-verify --dump-config                       # 末尾出现你的行
# 起实例后（--port 3099 --no-open），带 token 拉一次首页，确认启动图里有你的行与 rev：
#   {"id":"<你的包名>","url":"plugins/??<包名>/client.js&rev=…","rev":"…"}
# 再直接取回产物：
#   Invoke-WebRequest "http://127.0.0.1:3099/plugins/??<包名>/client.js&rev=<rev>"
# 最后在页面里查一个只由你的 apply(ctx) 写下的标记（探针做法，见 §2.1 第 6 步）
```

> 本机技巧（本文作者踩过）：`dsh` 与 `pnpm` 都不在 PATH 上；`dsh.cmd` 本身是
> `ELECTRON_RUN_AS_NODE=1 "<安装目录>\DeepSeek Harness.exe" --expose-internals "<asar>\…\dsh-desktop-host\lib\cli.js"` 的壳。
> 用 PowerShell 的 `& $dsh` 调用没问题；但用 `Start-Process`/`cmd` 拼参数时，**含空格的 CLI 路径会被拆开**
> （报 `Cannot find module 'C:\Users\Ansel\AppData\Local\Programs\DeepSeek'`）—— 必须自己加引号。
> 独立实例的 `GET /` 会 401，需要从启动输出里取带 token 的 URL。

`-Mode link`（默认）与 `-Mode pack`（真 tarball）**都要跑**：前者验工作树，后者验交付物。

---

## 6. 分阶段实施与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 打通链路** | 照 §2.1 的探针先跑通"包 → 行 → bundle → `apply()` 执行"（**手写 client.js 就够，先别碰打包器**）；再建正式包骨架 + 空宿主半侧 + 一个只画占位的 tab | 启动图有该行；`dataset` 探针或界面占位可见；`pnpm test`/`typecheck` 全绿 |
| **P1 最小可用树** | `readBytes` 读索引与清单 → 建树 → 折叠渲染全部块（设备→组→块），块行显示类型/编号/语言/大小/校验 | 在 `tia-project-first` 工作区（1155 块）打开不卡顿；`source/` 不存在或工程不匹配时给一行说明而不是空白 |
| **P2 交互完善** | 过滤、`changes` 自动刷新、点块打开 XML 预览、展开状态随 tab 生命周期保持、错误码分支文案 | 每个 `workspace-file/*` 错误码都有对应文案；切 tab 回来树状态还在 |
| **P3 与图谱联动（可选）** | 从 `knowledge/<device>/*.db` 取调用关系/网段，在树上叠加（**需要宿主侧读库 → 走路线 3 的 HTTP 路由**） | 路由只读、带会话校验；无库时降级为纯清单树 |

---

## 7. 风险与红线

1. **客户端 API 是内部约定**：所有 slot 名、`ctx.sidebarRightTabs`、`ctx.layout`、
   `workspaceFiles` 的调用面都**不是公开 API**（上游没有第三方扩展的 semver 承诺；最接近的"契约"
   是生成的 client inspect 目录），宿主升级随时可能变 —— **0.2.0-rc.2 → 0.2.1-rc.2 就是这样一次：
   基座模块表直接多出 `zod` 与 `@tanstack/react-virtual`（§2.3）**。
   缓解：把所有跨包 API 面收敛到一两个文件；注册失败要**降级成一条诊断**，
   绝不允许渲染期抛错把面板或整页打空。
2. **注册期的抛错可能被吞掉**：有第三方插件的实测记录说，某个注册字段变成必填后抛错被 cordis 吞了，
   整块界面**空白且没有任何症状**。所以：注册路径要自己包一层 try/catch 并把失败"钉"成可见诊断。
3. **`dsh.client.inject` 不是排序机制**，真实等待靠 Cordis 服务 inject；服务晚到要用 `ctx.inject`；
   slot 一律用 `ctx.slots.inject`（§2.4 第 3 条）。
4. **清单不能当变更检测**（§3.2）；UI 不得暗示"这块改过"。
5. **自己开 HTTP 路由就没有鉴权**：宿主只为 `/api`（Host API 与流）提供 Host/Origin 校验与
   浏览器会话鉴权，`ctx.webServer.register` 出来的路由**是裸的** —— 第三方只能自己抄一份
   "trust fence"（主机名为 loopback 或 `trustedHosts`、拒绝 cross-site、Origin 校验），
   而且那只是**防 DNS rebinding，不是鉴权**。所以**读数据优先走 `workspaceFiles` 远程通道**
   （带会话作用域 + 工作区包含检查 + 走鉴权过的 `/api`），只有需要宿主侧聚合时才自开路由。
6. **DOM 规模**：1376 条一次全渲染勉强可以，但工程规模再上台阶就需要虚拟化或"默认全折叠"。
   建议默认只展开第一层，其余懒渲染；解析后的树放 store，切 tab 回来不必重读。
7. **`readBytes` 上限 32 MiB**、`read` 单页 5000 行 / 2 MiB：超大工程清单若越界，要在 UI 上明说
   "清单过大"，并把它当作 P3 走宿主侧聚合的理由。
8. **`tab.signal` 只在记录消失或插件卸载时中止**（不是关闭、不是切 tab）；`tab.visible` 只该门控
   **渲染**，不该门控读取。每次 `await` 之后写 store 前都要查 `signal.aborted`。
9. **加一个 guide 入口会改变空分栏的默认页**：默认页取决于"已注册 guide 入口的**个数**"——
   恰好 1 个时直接开那个页，0 个或 ≥2 个时开引导页。`files` 已经贡献了 1 个，你再加就变 2 个。
10. **别把 UI 塞进宿主插件包**（§4.2 的 B 方案）会同时污染它的构建面与测试面。
11. **第三方包别运行时 import 别的功能插件的值**，也别把 `@deepseek-ai/dsh-client-ui-dockkit`
    当包解析（它折进 shell，只有模块表身份）：要类型就 `import type {}`，要形状就自己结构化重声明。
12. **验收环境隔离**：开发期用 `start-env.ps1` 的独立 `DSH_HOME`；要进日常 GUI
    （本机是 `desktop` profile）再单独 `dsh plugin --profile desktop add <tarball>`。

---

## 8. 参考与已确认/未确认

**上游（公开）** —— 本文机制结论对齐 **tag `dsh-v0.2.0-rc.2`**（commit `639ed015…`），
**不要读 master**。注意本机宿主已升到 **0.2.1-rc.2**，master 曾经"超前"的两项（基座表里的 `zod`、
`@tanstack/react-virtual`）**在本机宿主上已经生效**（见 §2.3），所以"master 有、本机没有"这条
判断要按版本重做，别沿用旧结论。

- `packages/client/AGENTS.md`：客户端插件的硬规则（声明形式、五类 props、inject 纪律、包清单、
  `dsh.client` 语义、共享模块图、红线）——
  <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/AGENTS.md>
- `docs/subsystems/{slots,client-modules,sidebar-right,web-server,typert}.md`、`docs/web-styling.md`。
- `packages/client/tsdown.client.ts`（包装与 external 的真源）、`packages/client/web/src/platform.ts`（基座表）。
- 参考实现：`packages/client/ui-sidebar-files`（右侧栏文件树，与本案例最接近）、
  `packages/client/ui-sidebar-right`（tab 注册表 + Tab 域）、`packages/client/ui-jobs`（最小骨架）、
  `packages/client/ui-plugin-manager`（主栏全页面板的样板）。

**本机实测（0.2.0-rc.2；2026-10-19 在 0.2.1-rc.2 上复核了标 ★ 的条目）**

- ✅ 本文 §2.1 的端到端探针（临时包 → 临时 profile → 独立实例 → 浏览器里读到
  `dataset.uiProbe = "loaded:react=true"`）；
- asar 内 `@deepseek-ai/dsh-client-modules`、`dsh-client-ui-slots`、`dsh-client-ui-sidebar-right`、
  `dsh-client-ui-sidebar-files`、`dsh-client-ui-primitives`、`dsh-client-store` 的 README/产物；
- ★ 从 shell bundle（0.2.1-rc.2 的 `dsh-web-frontend/dist/assets/index-CN7NIWNw.js`）里读出的
  基座表 —— 现在含 `zod` 与 `@tanstack/react-virtual`，见 §2.3；
- ← 以下仍是 0.2.0-rc.2 的实测记录：运行中的 GUI（`http://127.0.0.1:19387/`）的启动图、
  三个第三方 bundle；
- `C:\Users\Ansel\Documents\deepseek-harness\tia-project-first\source\**` 的真实导出物（1155 块 / 773 KB 清单）；
- 已安装的第三方 UI 插件 `C:\Users\Ansel\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\src\**`。

**已确认（原先的未知项）**

1. **第三方客户端 bundle 能被加载**：见 §2.1 第 1–6 步全绿；`dsh plugin add` 会**自动**把包名追加进
   `dsh.profile.bundles`。`file:` 路径（等价于 `link:` 的解析路径）也走通了。
2. **官方构建助手对第三方不可用**，包装必须自造；配方与失败模式见 §5。
3. **基座模块表**已按本机宿主版本逐字确认（§2.3）。

**仍未确认（动手时顺手验）**

1. `pnpm -r build` 的 `link:` 安装（`start-env.ps1 -Mode link`）下宿主解析 `dsh.client` 的行为
   —— 探针用的是 `file:` 路径，两者解析路径不同，按 §5 的 A 验收跑一次即可确认。
2. HMR 路径是否对第三方 bundle 有额外要求（`dsh-client-hmr` 的失效路径没读透）；
   v1 靠"重建 + 刷新页面"即可，不依赖 HMR。
3. 本案例的 tab 类型是否需要 `multiple` / `patterns`（v1 都不需要）。

---

## 9. 接进本发行版：蓝图 → 已物化 profile → 运行时

**目标环境**：本仓的本地发行版实例（`scripts/start-env.ps1` 起的那一个，默认端口 3092）。
它读的**不是**仓库里的蓝图目录，而是物化出来的 profile 目录
（`<DSH_HOME>/profiles/dsh-automation-suite/`，默认 DSH_HOME 是 `%USERPROFILE%\dsh-suite-env`）。

### 9.1 三处必须一致（UI 插件也不例外）

| 位置 | 改什么 | 作用 |
|---|---|---|
| `packages/<ui-pkg>/` | 包本身：`package.json`（`dsh.client` + `exports["./client"]` + `dsh.bundle.patch`）、`lib/index.js`、`lib/client.js` | 产物 |
| `packages/<ui-pkg>/cordis.patch.yml` | `insert: - id: <row> / name: '<包名>'`（`@` 开头**必须加引号**；name 逐字等于 `package.json` 的 `name`） | 给这个包一个 **Loader 行** |
| `profile/dsh-automation-suite/package.json` | `dependencies` 加 `"<包名>": "workspace:^"`；`dsh.profile.bundles` 加 `"<包名>"` | 让它成为依赖 + 进组合（层序：放最后） |

> **最容易被忽略的一条**：**只有 `dsh.client` 声明是不够的 —— 必须有一个"启用的 Loader 行"。**
> `dsh-client-modules` 是**扫描已启用的 Loader 条目**才发现客户端 bundle 的；没有行，宿主不会提供
> `/plugins/??<包名>/client.js`，页面上什么都不会发生（而且**不报错**）。

### 9.2 已物化的 profile 不会自动跟随蓝图（这条会静默失效）

`dsh.profile.bundles` 由**物化目录里那一份**决定。蓝图改了它不会同步，而且
`dsh plugin install` / `add` **只在一种情况下**会把包名追加进去：

- ✅ 该包是**这一次 pnpm 运行新加进 `dependencies`** 的（新依赖）；
- ❌ 已经在 `dependencies` 里的依赖（哪怕刚被脚本写进去、还没安装）属于 *retained*，**永远不追加**
  —— `dsh-plugin-manager` 的 `reconcile()` 里就是 `if (beforeDeps.has(name)) continue`。

而 `scripts/start-env.ps1` 是**自己先把 `dependencies` 写成 `link:<dir>`，再调 `dsh plugin install`**，
所以它**从不触发**那条追加：**往蓝图 bundles 里加插件，对已存在的环境不生效。**
（脚本头注释里"新增插件只需把包名写进蓝图的 bundles，本脚本无需改动"这句，
只在**首次物化**时成立。）

### 9.3 让已存在的环境装载新插件的三种做法

| # | 做法 | 代价 / 说明 |
|---|---|---|
| 1 ✅ | **手工把包名补进物化 profile 的 `dsh.profile.bundles`**，再 `start-env.ps1 -Restart`（脚本会写依赖并 install） | 保留该环境的活状态；改的是一个 JSON 数组 |
| 2 | **`start-env.ps1 -Restart -Reset`**（从蓝图重建） | 最省事，但**会丢掉该 profile 的活状态** —— 应用会把设置回写进物化目录的 `cordis.patch.yml`（模型、超时、`opennessDir`…），重建即丢。**先备份那个文件** |
| 3 | **不动 bundles，改走 profile 的 patch**：在物化 profile 的 `cordis.patch.yml` 里 `- insert: - id: … / name: '<包名>'`（依赖仍需装进该 profile） | 立刻可用、零 bundles 编辑；桌面 profile 的 `dsh-opencode-go` 就是这么挂的（有实测证据）。适合"先跑起来"，发行版仍建议走 bundle |

> 顺带：`dsh plugin --profile <p> add <spec>` 在**依赖尚未写入**时确实会自动追加 bundles
> （`client-modules` 之外的第二个"包名进 bundles"入口）；但只要 `start-env.ps1` 已经先写过依赖，
> 它同样会被当成 retained 而不追加。

### 9.4 验证（三层，缺一层都不算通）

```powershell
# 1) 组合里有你的行（必须用目标环境的 DSH_HOME）
$env:DSH_HOME = 'C:\Users\Ansel\dsh-eng-v17'          # ← 换成实际在跑的那个 home
dsh --profile dsh-automation-suite --dump-config | Select-String '<你的包名>'
# 2) 重启后页面启动图里有客户端行（需要带 token 的 URL）
#    {"id":"<包名>","url":"plugins/??<包名>/client.js&rev=…","rev":"…"}
# 3) 产物可取回（200）：/plugins/??<包名>/client.js&rev=<rev>
```

再加一条本文 §5 的探针式验收（页面里查只由 `apply(ctx)` 写下的标记）就能把"行有没有真的跑起来"
和"行在不在"分开。

### 9.5 现状快照（2026-10-18，本机）

| 环境 | 物化时间 | `dsh.profile.bundles` | 实际装载 |
|---|---|---|---|
| `C:\Users\Ansel\dsh-eng-v17`（**3092 在跑的就是它**，`cordis.yml` mtime = 实例启动时刻 10/17 22:36） | 10/16 09:31 | base, web-app, tia, **engineering-context, tool-git** | tia ✅ / engineering-context ✅ / tool-git ✅ / **engineering-graph ❌** |
| `%USERPROFILE%\dsh-suite-env`（脚本默认） | 10/13 19:58 | base, web-app, tia | 只装载 tia；engineering-context / graph / tool-git 都在**依赖里但不在 bundles 里** |
| 仓库蓝图 | — | base, web-app, tia, engineering-context, engineering-graph, tool-git | （蓝图不是运行时） |

教训：**判断"这个环境装载了什么"，只看 `--dump-config`（配对该环境的 DSH_HOME），不要看蓝图。**
