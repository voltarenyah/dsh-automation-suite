# dsh-ui-prompt-guide

**Prompt Guide**：`dsh-automation-suite` 发行版的主栏整页帮助页。左侧栏「Plugins」下面多一个入口，
点开是一页可搜索的功能地图——**每张卡片是一句可以直接发出去的 Prompt**，附「什么时候用」「会发生什么」
「由哪个工具/子 agent 执行」，并带「复制」和「在新会话中使用」两个按钮。

它回答的是同一个问题：*这个发行版能做什么，我该怎么说？* 面向人，不面向模型。

---

## 1. 它长什么样

```
左侧栏（sidebar.panellist）          主栏（main）
┌──────────────┐        ┌──────────────────────────────────────────┐
│ ▣ Plugins    │        │ Prompt Guide            [搜索]  [中/EN]  │
│ ✦ 歸藏设计   │        │ 起步 / 读工程 / 改程序 / 版本 / 仿真 …    │
│ ▶ Prompt Guide│  ───▶  │ ┌──────────────────────────────────────┐ │
│ ◷ …          │        │ │ 把现有工程带进工作区                  │ │
└──────────────┘        │ │ 什么时候用：工作区还没有工程…          │ │
                        │ │ ┌──────────────────────────────────┐ │ │
                        │ │ │ 把这个 TIA 工程建到当前工作区：…  │ │ │
                        │ │ └──────────────────────────────────┘ │ │
                        │ │ [复制] [在新会话中使用]               │ │
                        │ │ 会发生什么：TIA 打开工程、另存…       │ │
                        │ │ create_engineering_project            │ │
                        │ └──────────────────────────────────────┘ │
                        └──────────────────────────────────────────┘
```

- 内容 9 个分类、32 条 Prompt，中英双语（右上角切换，记在 `localStorage`）；
- 搜索匹配标题、场景、Prompt 正文、结果与工具名；点工具 chip 直接按该工具筛选；
- 「复制」走 `navigator.clipboard`，失败时退回 `execCommand('copy')`；
- 「在新会话中使用」把 Prompt 填进新会话的输入框（**不自动发送**），用户补上对象名再发；
- 明暗跟随外壳：宿主把当前 `colorScheme` postMessage 进 iframe，切换主题即时生效。

---

## 2. 注入方式（照 `dsh-guizang-design` 的四个座位）

这个包是「主栏全局面板」的一个实现，完整用到四个座位：

| 座位 | 形态 | 本包怎么用 |
|---|---|---|
| `sidebar.panellist` | root **list**，一行图标 + `label` + `order` | `ctx.slots.register({ name, id: 'prompt-guide', order: 7, label: () => 'Prompt Guide' }, GuideIcon)` |
| `main` | root **keyed**，key 与上面 `id` 相同 | 整页组件是一个 `<iframe src="/prompt-guide/">` |
| `theme` | Cordis 服务，**可能晚到** | `ctx.inject(['theme'], …)`，把 `colorScheme` 转发进 iframe |
| `uiWorkspace` | Cordis 服务 | `startSession(undefined, { prompt, whenDraftExists: 'replace' })` |

注册骨架（`src/client/index.jsx`）：

```jsx
export const inject = ['slots', 'uiWorkspace']

export function apply(ctx) {
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 7, label: () => 'Prompt Guide' }, GuideIcon))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, GuidePanel))
}
```

要点（都是实测得来的，别简化）：

1. **`ctx.slots.inject(name, () => ctx.slots.register(...))`，不要裸 `register`**。子座位只在声明它的父条目
   挂载期间存在；裸注册会抛 `slot "…" is not declared`。`inject` 负责在父条目塌陷时撤回、重新声明后重跑。
2. **`main` 的 key 必须等于 `sidebar.panellist` 的 id**，点击左栏那一行才会选中这个面板。
3. **主题服务用 `ctx.inject(['theme'], …)` 等**，不要在 `apply` 里直接 `ctx.theme`。iframe 不继承宿主的
   `prefers-color-scheme`，所以主题必须显式转发（`postMessage({ type: 'prompt-guide:scheme' })`）。
4. **注册抛错要自己吞掉并记日志**：一个座位坏掉不能让整列界面空白（官方注册期异常可能被吞，症状是无提示空白）。
5. **`dsh.client.inject` 不是排序机制**（`package.json` 里写的是 `[]`）：真正的等待是 Cordis 服务 inject，
   slot 一律走 `ctx.slots.inject`。

页面本身为什么用 iframe 而不是 React 面板：

- 帮助文本是**最常改**的东西，静态页改一句话不用重建 `lib/client.js`；
- 代价是同源 `postMessage` 桥（主题、开新会话）必须写全，且 iframe 拿不到宿主 CSS 变量——所以页面自带
  一套明暗 token（`page/style.css`），不依赖 `--dsw-*`。

---

## 3. 文件职责

```
packages/dsh-ui-prompt-guide/
├── package.json              # dsh.bundle.patch + dsh.client(platform: web) + exports ./client
├── cordis.patch.yml          # 一行 insert（id: ui-prompt-guide，name = 包名逐字）
├── tsconfig.json             # 宿主半侧（src/**/*.ts）交给 tsc
├── scripts/
│   ├── build.mjs             # tsc 宿主 + esbuild 浏览器半侧（ModuleLoader 包装）+ page/ 存在性检查
│   ├── tsc.mjs               # 从本包或仓库根解析 typescript
│   └── run-tests.mjs         # 先构建再跑 node:test
├── src/
│   ├── index.ts              # 宿主：注册 /prompt-guide 前缀路由，序列化 guide
│   ├── page.ts               # 纯函数：路径安全、MIME、trust fence、answer()
│   ├── guide.ts              # 数据：9 分类 / 32 条 Prompt / TOOL_CATALOG
│   └── client/index.jsx      # 浏览器：两个座位 + 主题转发 + startSession 桥
├── page/                     # 静态页（不经过构建）
│   ├── index.html
│   ├── app.js                # 取 /prompt-guide/api/guide，渲染、搜索、复制、开新会话
│   └── style.css             # 明暗两套 token；820px 以下分类导航变成横向 chip
└── test/
    ├── 01-guide.test.mjs     # 数据完整性 + 工具白名单
    ├── 02-page.test.mjs      # 路径穿越 / 点文件 / fence / 方法 / 响应
    └── 03-build.test.mjs     # 产物包装、座位名、apply 行为、路由真实响应
```

宿主路由：

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/prompt-guide` | 308 → `/prompt-guide/`（保证相对资源路径正确） |
| GET/HEAD | `/prompt-guide/` | `page/index.html` |
| GET/HEAD | `/prompt-guide/api/guide` | `guideDocument()` 的 JSON，`cache-control: no-store` |
| GET/HEAD | `/prompt-guide/app.js`、`style.css` | 白名单 MIME，`no-cache` |
| 其他 | — | 405（非 GET/HEAD）、403（cross-site / Origin 不匹配）、404（穿越、点文件、未知扩展名） |

---

## 4. 改内容：只动 `src/guide.ts`

新增一张卡片 = 在 `ENTRIES` 里加一条：

```ts
{
  id: 'read-call-chain',            // 唯一、kebab-case
  category: 'read',
  order: 70,                        // 同一分类内唯一
  title: { zh: '…', en: '…' },
  when: { zh: '…', en: '…' },
  prompt: { zh: '…', en: '…' },     // 用户真正要发的话，≤ 400 字符
  outcome: { zh: '…', en: '…' },
  tools: ['knowledge_block'],       // 必须在 TOOL_CATALOG 里
  note: { zh: '…', en: '…' },       // 可选
}
```

两条硬约束（测试会拦）：

- `tools` 里的名字必须出现在 `TOOL_CATALOG`——该目录是**手写白名单**，新增名字时请到对应包的
  `src/tools.ts` 核对，别凭印象写；
- 中英两个字段都不能空。

分类、顺序、文案都在同一个文件里；页面刷新即生效，不需要 `pnpm build`（只有改 `src/client/index.jsx`
或宿主半侧才要重建）。

---

## 5. 安全边界（必须知道）

`ctx.webServer.register` 出来的路由**没有宿主鉴权**（只有 `/api` 有）——这一点在
[`docs/ui-plugins.md` §7.5](../../docs/ui-plugins.md) 里有记录。所以本包按那个口径处理：

- 路由**只发静态内容**：本包自带的页面与 `guide.ts` 的文案，**没有任何用户/工程数据**。
  页面上所有数字都是文档，不读工作区、不读会话、不读数据库；
- 抄了一份最小的 **trust fence**（`src/page.ts` 的 `fenceFailure`）：拒绝 `Sec-Fetch-Site: cross-site`，
  以及 `Origin` 的 host 与请求 `Host` 不一致的请求。这只是防 DNS rebinding / 跨站嵌入，**不是鉴权**；
- 文件解析限制在 `page/` 内，并做 `realpath` 复核：`..`、点文件、指向目录外的符号链接一律 404，
  扩展名不在白名单（html/js/css/json/svg/png/ico/woff2）也 404；
- 页面上的「在新会话中使用」只接受**同源 + 来源 frame 匹配**的 `postMessage`，不能由别的窗口驱动。

如果将来要在这个页面里放「用户数据」（工程清单、版本历史等），**不能**沿用这条裸路由，要先按 §7.5
补会话作用域与鉴权，或改走 `workspaceFiles` 远程通道。

---

## 6. 构建、测试与验收

```powershell
# 包内（本机 pnpm 不在 PATH，用 node 直接跑脚本）
node scripts\build.mjs          # lib/index.js, lib/guide.js, lib/page.js, lib/client.js
node scripts\run-tests.mjs      # 先构建再跑 node:test（25 项）
node scripts\tsc.mjs -p tsconfig.json --noEmit

# 全仓
pnpm -r build
pnpm -r typecheck
pnpm test
```

验收（用户说「启动 App」时）：

```powershell
pwsh -NoProfile -File scripts\start-env.ps1 -Restart
```

进入 GUI 后应看到：左侧栏「Plugins」下面出现 **Prompt Guide**；点开是整页卡片；搜索、中英切换、
复制、明暗切换都可用。硬证据（不是"看到了"）：

1. 页面能加载 = 宿主路由通了：`/prompt-guide/api/guide` 返回 200 JSON；
2. 侧栏有这一行 = 浏览器半侧 `apply()` 执行过；
3. 点「复制」后按钮变「已复制」= 页面脚本与 iframe 同源；
4. 点「在新会话中使用」后出现带同一段 Prompt 的新会话 = `uiWorkspace.startSession` 桥通了。

---

## 7. 已知边界

- **slot 名与 `uiWorkspace.startSession` 都是内部约定**，上游没有 semver 承诺；宿主升级时要复核。
  注册失败会降级成一条 `logger.warn`，界面最多少一行/少一页，不会把整列打空。
- **iframe 与主体共享同一个 origin**，所以 `postMessage` 用 `location.origin` 而不是 `*`；
  若将来改成跨源（例如独立端口），桥与信任检查都要重写。
- **页面不依赖任何 CDN 或外部字体**：离线环境、断网演示都能用。
- **不是模型上下文**：页面内容不会自动进 prompt。要模型知道某条约定，把它写进 `profile` 的政策层或包内 skill。
- **搜索是纯前端子串匹配**（大小写不敏感），故意不做分词/模糊匹配——32 条数据不需要，也不会引入依赖。
