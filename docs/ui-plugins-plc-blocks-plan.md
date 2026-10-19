# 实施计划：`dsh-ui-plc-source` —— 右侧栏「PLC Blocks」标签页

> **状态：P0 + P1 已实现并验收（2026-10-19）**，实测记录见 §10；P2/P3 仍未做。
> 通用机制（客户端插件怎么被加载、座位目录、构建配方、接线规则）见 [`ui-plugins.md`](ui-plugins.md)；
> 本文只写这一个插件的落地。
>
> **已锁定的规格**（2026-10-19 与使用者确认）：
> 插件名 `dsh-ui-plc-source`（**不带 scope**）、装进 `dsh-automation-suite` 那个发行版的 profile；
> 数据源 = 每个 workspace 根下的 `source/`；**平铺**、不保留源路径的分组层级；
> 可按 **device** 与 **simaticType** 筛选；点文件用既有预览打开；折叠状态放组件内；
> 引导页入口排在**最后**；不做命令与快捷键。

---

## 0. 由此产生的设计变更（必须写清楚）

原方案打算"纯目录树、不解析清单"。现在要**按 simaticType 筛选**，而 `simaticType`（`FB` / `FC` / `OB` /
`InstanceDB` / `GlobalDB` / `ArrayDB` / `PlcStruct` / `PlcTagTable`）**只存在于清单里**：

- `source/<device>/_tia-openness-manifest.json` 每条对象带
  `name / group / file / bytes / sha256 / category / simaticType / declaredName / declaredNumber /
  programmingLanguage / verified`（实测：1376 条、773 KB、17 464 行、缩进 JSON）；
- 文件名/目录名里没有类型信息（`blocks/…/SCP_IN/SCP_IN.xml` 只能看出是块）。

⇒ **数据面改为"列 `source/` 找 device → 读每个 device 的清单 → 平铺成一张表"**，
目录层级只用来发现 device，不用来渲染。

**为什么可以整个读进来**：`readBytes(path, {})` 一次读完整文件，上限 `maxFileBytes` 32 MiB；
本项目 1155 块是 773 KB。**不要**用按行分页的 `read`（单页 5000 行，17 464 行要 4 次请求）。
超 32 MiB 的工程走 §3.3 的降级。

---

## 1. 目标与验收

**目标**：`dsh-automation-suite` 发行版（3092 那套，profile `dsh-automation-suite`）的 dsh-web 页面里，
右侧栏在 **Files / Terminal / Browser** 之后多出 **PLC Blocks**；打开后：

- 顶部两个筛选器：**device**、**simaticType**（各自带"全部"与计数）；
- 正文是**平铺**的源文件表（不出现 `999_Bibliotheque/Fonctions méthode/…` 这类分组层级），
  每行：对象名、类型徽章、编号、语言、大小、写后校验状态；
- 点行 → 用既有的文档预览打开那个 `.xml`；
- 「刷新」清缓存重读。

**验收（五层）**

1. `dsh --profile dsh-automation-suite --dump-config` 出现 `- id: ui-plc-source` / `name: dsh-ui-plc-source`；
2. 重启后启动图里有 `{"id":"dsh-ui-plc-source","url":"plugins/??dsh-ui-plc-source/client.js&rev=…"}`；
3. `GET /plugins/??dsh-ui-plc-source/client.js&rev=<rev>` → 200；
4. 浏览器：引导页最后一项是 **PLC Blocks**；打开后 `device=Sino_PEI`、`类型=全部` 时应约 1154 行
   （实测 `category:blocks` 1154 + `types` 215 + `tag_tables` 7 = 1376 条，见下）；
5. 切 simaticType=FB → 218 行；点一行 → 预览打开；截图存档。

> 计数口径（实测同一份清单）：`simaticType` 分布 `InstanceDB 576 / FC 233 / FB 218 / PlcStruct 215 /
> GlobalDB 91 / OB 28 / ArrayDB 8 / PlcTagTable 7`；另有 `failures[2]`（TIA 拒绝导出，如 `FOB_SAFETY`）。

---

## 2. 包与接线（目标就是本仓的 profile）

```
packages/dsh-ui-plc-source/
├── package.json          # name: dsh-ui-plc-source
├── cordis.patch.yml      # insert: { id: ui-plc-source, name: dsh-ui-plc-source }   ← 无 scope，不加引号
├── tsconfig.json         # 只覆盖 src/**/*.ts
├── .gitignore            # lib/、*.tgz
├── README.md
├── scripts/{tsc.mjs,build.mjs,run-tests.mjs}
├── src/
│   ├── index.ts          # 宿主半侧：export const name + 空 apply()
│   ├── model.ts          # 纯函数：清单解析/平铺/筛选/排序/计数/地址/文案（单测覆盖）
│   └── client/
│       ├── index.jsx     # apply(ctx)：样式 + tab 类型 + 正文座位 + inject 工厂
│       ├── Panel.jsx     # 正文：两个筛选器 + 平铺表 + 打开预览
│       └── style.js
└── test/model.test.mjs
```

**名字与 patch 必须逐字一致**（仓库强制）：`package.json` 的 `name` 与 `cordis.patch.yml` 的
`insert[].name` 都是 `dsh-ui-plc-source`；因为它不以 `@` 开头，YAML 里**不需要**引号
（对比：带 scope 的包必须写成 `'@scope/name'`）。

**蓝图三处**（`profile/dsh-automation-suite/package.json`）：

```jsonc
"dependencies": { "dsh-ui-plc-source": "workspace:^", … },
"dsh": { "profile": { "bundles": [ …现有 6 条…, "dsh-ui-plc-source" ] } }   // ← 放最后（层序）
```

**已物化环境**（3092 实际在跑的是 `C:\Users\Ansel\dsh-eng-v17`）：它的
`profiles/dsh-automation-suite/package.json` 里 `dsh.profile.bundles` 要**手工补一行** `dsh-ui-plc-source`
—— `start-env.ps1` 只写 `dependencies`，CLI 的 `reconcile()` 只追加"本次 pnpm 运行新加的依赖"，
所以蓝图加插件**不会**进已物化 profile（`ui-plugins.md` §9.2）。然后：

```powershell
pwsh -NoProfile -File scripts\start-env.ps1 -DshHome C:\Users\Ansel\dsh-eng-v17 -Restart
```

不用 `-Reset`（会丢应用回写到物化目录 `cordis.patch.yml` 的设置）。

---

## 3. 数据面

### 3.1 读取顺序

```
cwd  = useSessions(s => s.byId[sessionId]?.cwd)          // 框架钩子
root = joinPath(cwd, 'source')

1) list(sessionId, root, signal)            → device 目录列表（type === 'directory'）
2) 每个 device（首次展开/首次筛选时按需）：
   readBytes(sessionId, joinPath(deviceDir, '_tia-openness-manifest.json'), {}, signal)
   → TextDecoder → JSON.parse
3) 平铺：manifest.blocks[] 每条 → 一行 Row
```

- 索引文件 `source/_dsh-engineering-context.json` **不作为必需输入**：列目录就能发现 device，
  少一个会漂移的契约；它只在将来要做"这棵树属于哪个工程"的抬头时才有用。
- 一次只读一个 device 的清单（懒），失败只影响那一个 device（其余照常）。

### 3.2 行模型与筛选

```ts
interface Row {
  device: string; kind: 'block'|'type'|'tagTable'; simaticType: string;
  name: string; number?: string; language?: string; bytes?: number;
  verified: boolean; file: string;            // 绝对路径，用来生成资源地址
}
```

- `kind` 由 `category` 映射（`blocks` → block；`types` → type；`tag_tables` → tagTable），
  只用来给徽章配色；
- **平铺**：不按 `group` 建层级；`group` 不进 UI（需要定位时看每行 tooltip 的绝对路径）；
- 筛选器：
  - `device`：`全部` + 每个 device（带条数）；
  - `simaticType`：`全部` + 数据里出现过的类型（按固定顺序排：`OB, FB, FC, InstanceDB, GlobalDB,
    ArrayDB, PlcStruct, PlcTagTable`，未知类型排最后），选项文字带计数；
- 默认排序：类型序 → 名称自然序（数字段按数值，`2_x` 在 `10_x` 前）；
- 两个筛选器互相**不**收窄选项（选项始终来自全部数据），只收窄行 —— 否则用户会掉进"选完类型
  device 只剩一个"的陷阱。

### 3.3 降级（清单缺失或不可读）

| 情形 | 表现 |
|---|---|
| `source/` 不存在（`workspace-file/not-found`） | 「还没有工程源树，先运行 create_engineering_project」＋刷新；**不是错误态** |
| 某 device 无清单 | 该 device 退回**递归列目录**（深度上限 8、总条目上限 5000），行只有名字与大小，`simaticType = '未知'`；`simaticType` 筛选里因此会出现"未知" |
| 清单读取失败（`too-large` / `not-text` / 其它码） | 该 device 一行按 `error.code` 的文案；其它 device 照常 |
| `manifest.failures[]` 非空 | 表尾一行「N 个对象被 TIA 拒绝导出」（不混进正常行） |
| `verified === false` | 该行加一个警示标记（有实例吗：实测本样本 0 条，但要处理） |
| 行数 > 2000（筛选后） | 先渲染前 2000 行 + 一行「已截断，请收窄筛选」；P2 用基座的 `@tanstack/react-virtual` 虚拟化 |

---

## 4. 座位与交互

### 4.1 注册（`src/client/index.jsx`）

```jsx
const ID = 'dsh-ui-plc-source'          // = 包名；也是正文座位的 key
const KIND = 'plc-source'               // 新 kind，不与 files/browser/terminal 撞

export const inject = ['slots', 'sessions', 'remote', 'remote.workspaceFiles']

export function apply(ctx) {
  ensureStyle(ID)
  ctx.effect(() => ctx.inject(['sidebarRightTabs'], (injected) => {     // 服务可能晚到，别直接读
    const tabs = injected?.get?.('sidebarRightTabs')
    if (tabs === undefined) return () => {}
    return tabs.register({
      id: ID, kind: KIND,
      title: () => 'PLC Blocks',
      guide: [{ id: KIND, order: 100, title: () => 'PLC Blocks',
                description: () => 'source/ 下的 PLC 源文件（按类型筛选）' }],   // order 最后
    })
  }), 'plc-source: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID,
    inject: (sessionId) => ({ listDevice: (path, signal) => listOneLevel(ctx, sessionId, path, signal),
                              readJson:  (path, signal) => readJsonFile(ctx, sessionId, path, signal) }),
  }, Panel)), 'plc-source: tab body')
}
```

- 不注册标题座位（chip 文字直接用 `title()`）；
- `order: 100` 只影响引导页里的顺序，**最后一个**；真实排位以现有三个入口的 order 为准（实现时读一次
  `ui-sidebar-files` / `browser` / `terminal` 的注册值再定，取比它们都大的数）；
- 整段包 try/catch → 失败打 `ctx.logger.warn` 并渲染一行诊断（注册错误会被 cordis 吞掉，
  不能让界面静默空白）。

### 4.2 打开文件

```js
actions.openResource(resourceAddress(sessionId, relativeUnder(cwd, row.file)))
// dsh-resource://file/session/<sessionId>/<逐段 encodeURIComponent 的相对路径>
```

复用 `ui-sidebar-documentpreview`（认领 `dsh-resource://file/**`），不自己写查看器；
无人认领时 `openResource` 会 throw，整段 try/catch —— 打不开文件不能把面板打空。

### 4.3 状态（v1：组件内）

`rows`（按 device 缓存）、`device`、`type` 两个筛选值、`expandedDevices` 都放 `useState`。
切 tab 回来会重新读（每 device 一次 `readBytes`）。P3 再换 `defineStore` 保状态。

---

## 5. 构建（不新增依赖）

- **宿主半侧 + 纯模型**：`tsc`（仓库根 typescript）→ `lib/index.js` + `lib/model.js`；
- **浏览器半侧**：**esbuild**（仓库 `.pnpm/esbuild@0.28.2`，按候选路径探测，写死会随 pnpm 布局变化而坏），
  `format:'cjs'`、`platform:'browser'`、`jsx:'automatic'`、`bundle:true`，用 `banner`/`footer` 包成
  `window.__ModuleLoader__.load({ id, factory })`；
- **`external` 必须逐字等于 0.2.1-rc.2 的基座表**（实测，从运行中的 `assets/index-*.js` 读出）：

  ```js
  ['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis',
   'zod','@tanstack/react-virtual',
   '@deepseek-ai/dsh-client-store','@deepseek-ai/dsh-client-ui-slots',
   '@deepseek-ai/dsh-client-ui-primitives','@deepseek-ai/dsh-client-ui-dockkit']
  ```

  **其它 `@deepseek-ai/*` 一律不 import**（跨包只有 `import type`、Cordis 服务、slot 三条路）；
  产物里若出现指向非基座模块的 `require(...)`，运行期就是 `missed the module table`。
- **CSS**：字符串 + 一次性 `<style data-plugin=… data-plugin-css=…>` 注入；只用 `--dsw-*` 语义 token（带 fallback）。
- **不分块**：单文件 `lib/client.js`。
- **`.jsx` 不做类型检查**（仓库没有 `@types/react`，抽取的运行时也没有 `.d.ts`）：
  类型安全交给 `model.ts` 的单测 + 浏览器验收，组件逻辑刻意保持薄。

---

## 6. 测试（`node:test`，只测纯模型）

`test/model.test.mjs` 用**真实清单的裁剪 fixture**（挑 3 个类型各 1 条 + 1 条 failure）覆盖：

| 覆盖 | 用例 |
|---|---|
| `parseManifest` | 正常形状；`blocks[]` 缺字段不抛；`failures[]` 透传；非对象/坏 JSON 返回失败而不是 throw |
| `flatten` | `category`→`kind` 映射；`declaredName` 缺失回退 `name`；`group` 不进行模型 |
| `typeOptions` | 固定顺序优先、未知类型排最后、计数正确、`全部` 不在数据里 |
| `filterRows` | device × type 组合；`全部` 语义；空结果不抛 |
| `sortRows` | 类型序 → 自然序（`2_x` < `10_x`）；同类型同编号时稳定 |
| `resourceAddress` | 空格/中文/`#` 逐段编码；不产生 `//` |
| `relativeUnder` | Windows 大小写不敏感；分隔符混用；不在根下返回 null |
| `joinPath` | posix / Windows / 父路径已带分隔符 |
| `errorText` / `sizeLabel` | 已知码与兜底；B/KB/MB 边界 |

`pnpm -r test` 通过 `scripts/run-tests.mjs`（先 build 再跑），`pnpm -r build` / `typecheck` 也必须 exit 0。

---

## 7. 风险

1. **客户端 API 是内部约定**（`sidebarRightTabs`、`sidebar.right.pane.tab`、`ctx.slots.inject`）：
   升级可能改字段 → 全部收敛在 `src/client/index.jsx`，注册外层 try/catch + 可见诊断。
2. **`.jsx` 无类型检查**：靠模型单测 + 浏览器验收兜住。
3. **清单是第三方（TIA 控制器）写的 JSON**：解析必须防御式（缺字段/类型不符不许 throw）。
4. **大工程**：清单超 32 MiB → `readBytes` 会 `too-large`，按 §3.3 降级；行数过多按 §3.3 截断。
5. **接线**比代码更容易错：`dsh.client` 不构成 Loader 行；已物化 profile 的 `bundles` 才是装载依据。

---

## 8. 阶段

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| **P0** | 包装好、tab 类型注册出来（正文先只显示标题与 root 路径）+ 打包链路 | §1 第 1–3 层 |
| **P1** | 读清单 → 平铺表 + 两个筛选器 + 打开预览 + §3.3 全部降级 | §1 第 4–5 层（截图） |
| **P2** | `@tanstack/react-virtual` 虚拟化 + 表尾 failures 行 + verified 警示的统一视觉 | 1376 行滚动流畅 |
| **P3** | `defineStore` 保折叠/筛选状态；可选：按编号搜索框 | 切 tab 回来状态还在 |

---

## 9. 范围外

- 不写编辑器、不改文件、不触发导出/编译（纯只读）。
- 不解析 XML 内容、不读 `knowledge/*.db`。
- 不改官方 UI 包，也不依赖 `dsh-better-sidebar` 的私有服务。
- 不做命令/快捷键（使用者明确不需要）。

---

## 10. 实施记录（P0 + P1，2026-10-19）

**产物**：`packages/dsh-ui-plc-source/`（`dsh-ui-plc-source`，无 scope），
`lib/client.js` **26 755 字节**，包装为 `window.__ModuleLoader__.load({ id, factory })`，
产物里只有 `require("react")` 与 `require("react/jsx-runtime")` 两条外部请求（都在基座表内）。

**宿主与接线**：宿主 0.2.1-rc.2；蓝图与已物化 profile（`C:\Users\Ansel\dsh-eng-v17`）的
`dsh.profile.bundles` 都已加入 `dsh-ui-plc-source`（blueprint 备份：`package.json.bak-before-plc-source`）。

**验收实测**（`http://127.0.0.1:3092/`，`-Mode link`，由 Playwright 驱动真实页面）：

| 检查 | 结果 |
|---|---|
| `--dump-config` 行 | 通过（`- id: ui-plc-source` / `name: dsh-ui-plc-source`） |
| 启动图行 | 通过（`plugins/??dsh-ui-plc-source/client.js&rev=3ba77de7fa86`） |
| 组合 URL 取回产物 | **200**，26 794 字节 |
| 浏览器半侧真的执行 | 通过（页面里存在 `style[data-plugin-css="dsh-ui-plc-source/plc-blocks.css"]`，无 console 警告） |
| 引导页入口 | 通过（右侧栏出现 **PLC Blocks**，点击后打开面板） |
| 平铺行数 | **1376 / 1376**（与清单对象总数一致） |
| device 筛选 | `Sino_PEI（1376）` |
| simaticType 计数 | `OB 28 / FB 218 / FC 233 / InstanceDB 576 / GlobalDB 91 / ArrayDB 8 / PlcStruct 215 / PlcTagTable 7`（与清单实测分布逐项一致） |
| 类型筛选 | 选 `FB（218）` → 列表 **218** 行 |
| 点击打开预览 | 通过：`001_Interface_EMS.xml` 在既有文档预览 tab 中打开（面包屑显示 `source\Sino_PEI\blocks\40_Exch_PLS_EMS\…`） |
| 拒绝导出提示 | 通过（表尾「1 个对象被 TIA 拒绝导出」） |
| 单元测试 | **20/20 通过**；`tsc --noEmit` 通过 |

**与计划的偏差**

- 计划里 `typeOptions` 的固定顺序是对的，但实际清单的 `category:blocks` 同时含 `InstanceDB` /
  `GlobalDB` / `ArrayDB`，所以"类型"与"类别"不能混用——实现里徽章用 `simaticType`，
  `category` 只用于决定「未知类型时的兜底徽章」。
- 清单 `failures[]` 在本工作区只有 1 条（先前另一份导出是 2 条），说明这个数字随导出而变，
  适合表尾计数，不适合当断言。

### 10.1 补做（同日，第二轮）

评审时按"是否影响功能完整"筛出两项，都已完成并验收：

| 项 | 实现 | 验收 |
|---|---|---|
| **拒导对象显示成行** | `parseManifest` 把 `failures[]` 也变成行（`refused: true` + `reason`），平铺进同一张表；徽章「拒绝」、灰显、`disabled`（没有文件可开），tooltip 是 TIA 的完整原因；表尾备注改为指向这些行 | 页面行数 **1377**（1376 导出 + 1 拒导），`FOB_SAFETY` 一行显示「拒绝」并可悬停看到 `The export of block 'FOB_SAFETY' is not permitted.` |
| **按名称/编号搜索** | `matchesQuery` + `filterRows(..., query)`；UI 加一个 `type="search"` 输入框与「清除」按钮，不分大小写 | `scp` → 5 行（`SCP_IN` / `SCP_OUT` / 两个实例 DB / `HMI_SCP_IN`）；`1001` → 2 行（按编号命中）；`safety` → 21 行；与另两个筛选可叠加 |

测试从 20 项加到 **24 项**（新增：拒导行字段、缺 message 时回退 code、坏 failure 条目不拖垮整份清单、
名称/编号查询与大小写）。仍未做：虚拟化（1376 行实测流畅）、折叠/筛选状态保持（使用者已取消）。

### 10.2 第二轮修复

- **深色主题下下拉弹层浅底浅字**：`--dsw-specific-menu` 是半透明叠层色，原生 `<option>` 弹层把它画在
  自己的白底上、文字却继承深色主题的浅色。改为弹层用不透明配色（`Canvas`/`CanvasText`）并在
  `body[data-ds-dark-theme]` 下把 `color-scheme` 钉成 dark；实测浅色 `rgb(255,255,255)`+黑字、
  深色 `rgb(18,18,18)`+白字。
- 表头拆成两行（标题+计数+刷新 / 两个下拉），搜索框独占一行，窄面板不再把控件叠成三行。

