# 电气图纸插件（Drawing）最终方案

- 依据：`docs/research/electrical-drawings-see-swt2-pei.md`（353 页实测：图号 350/353、交叉引用 1,669 条 100% 可解析、电缆表 348/355 根、落墨率 100%）
- 已定：派生物按源 PDF 文件名建目录；P1 表格不做导出；插件 = 工具 + 解析 + 右侧栏 UI（可联动）
- 本文件：目录布局、5 个工具、工作流与示意图、UI 结构与联动机制、阶段划分与验收

> **实现状态（2026-11-03）**：P0 与 P1 已落地为 `packages/dsh-drawing`，交付清单与偏差见文末 §11；本文其余部分保持为设计基线。

---

## 1 边界

| 做 | 不做（v1 明确排除） |
|---|---|
| 图纸入库（复制）、解析、建档、检索、单页详情、交叉引用跳转 | 电气网表/连通性**重建**（符号是散线段，投入产出不成比例）——若用户能提供 SEE 的 `Project Data extraction` XML，网表来自 XML，不算重建（见 §6.6） |
| 右侧栏 Drawing 页：检索 + 看图 + 高亮 | 表格导出（CSV/XLSX）——agent 用解析结果直接答即可 |
| agent → UI 的单向联动（定位到页/区域） | 多份图纸跨册联合检索（v2 再议） |
| 图纸换版差异对比（同一 sha 缓存天然支持） | OCR（文本层完好）、符号识别、CAD 同步 |

---

## 2 目录与产物布局（按源文件名建目录）

```
workspace/drawing/
├── PEI---SWT2_20260527.pdf          ← 原件副本（用户给路径时复制进来，原件不动）
└── PEI---SWT2_20260527/             ← 派生物：与 PDF 同名（去扩展名）
    ├── profile.json                 ← 图纸档案卡（300–500 token，见 §7.1）
    ├── build.json                   ← 解析元数据：sha256 / 版本 / 耗时 / 落墨闸门结果
    ├── index/
    │   ├── sheets.json              ← 每页：柜/图号/标题/模板/列行标/上一张下一张
    │   ├── xrefs.json               ← 交叉引用（含解析结果、侧别、bbox）
    │   ├── names.json               ← 实体：位号/线号/电缆/端子/PLC 地址 → 出现位置
    │   └── tables/
    │       ├── cables.json          ← 电缆台账（348 根 / 3,016 芯线）
    │       └── …                    ← 后续模板：channels / terminals / connectors
    ├── pages/<page>.json            ← 单页详情缓存（懒生成）
    └── render/<page>[@region].png   ← 页面/区域渲染缓存（懒生成，LRU）
```

规则：

- **同名不同 hash**（换版）：派生物目录追加 `__<sha8>`，两份都保留——换版对比是特性。
- 派生物目录名与 PDF 同名，用户一眼能对上；无 PDF 时目录为空即可重建。
- 缓存键是 `sha256`，所以改名、挪目录、重复上传都不会重解析（`build.json` 里比对）。
- `.gitignore` 增加 `/drawing/*/`（派生物不入库）；PDF 原件是否入库由使用者决定（建议也不入库）。

---

## 3 五个 P0 工具

设计原则：**工具少、返回小、语义单一**。原来的 `drawing_xref` 合并进 `drawing_sheet`（它的返回里已带解析好的交叉引用），因为模型要在 5 个和 6 个工具之间选时，多一个就多一类选错。

### ① `drawing_status` —— 我有什么图纸？

- **做什么**：只读探测。列出 `drawing/` 下的 PDF、是否已建索引、索引健康度（页数/落墨率/模板覆盖）、最近解析时间。**不解析、不读 PDF 正文**。
- **入参**：无（可选 `detail: true` 返回每份的档案卡摘要）
- **返回**：`{ ok, documents: [{ name, path, pages, indexed, sha256, profile? }], hint }`
- **何时调**：任何图纸话题的第一步。`indexed: false` → 提示用户上传或给路径；`documents: []` → 引导入库。
- **成本**：毫秒级，返回 < 500 B。

### ② `drawing_open` —— 入库并建档

- **做什么**：把源 PDF **复制**进 `drawing/`（原件不动）→ 算 sha256 → 命中缓存则直接返回档案卡，否则解析（353 页约 4 s）→ 落盘 `index/` + `profile.json`。
- **入参**：`source`（绝对路径，或宿主落盘后的附件路径）、可选 `name`
- **返回**：`profile.json` 的内容（档案卡）
- **何时调**：`status` 显示没有/未索引时；用户说"这是新图纸，路径在…"时。
- **失败态**：`pdf/encrypted`、`pdf/no-text-layer`（→ 提示需 OCR，v1 不支持）、`parse/low-score`（落墨闸门不过 → 降级为"仅页级索引"并在 profile 的 `caveats` 里写明）。

### ③ `drawing_search` —— 找在哪一页

- **做什么**：对**索引**做检索（不是每次扫 PDF）：实体（位号/线号/电缆/端子/PLC 地址）、交叉引用、自由文本。支持按柜/按图号段/按模板过滤。
- **入参**：`query`（必填）、`kind?` = `tag|wire|cable|terminal|address|xref|text|any`、`cabinet?`、`limit?`（默认 20）
- **返回**：命中数组，每条 `{ cabinet, sheet, page, bbox, role, context }`；`context` 是一行上下文（≤ 120 字符），**不是整页文本**
- **何时调**：用户说"W015 在哪""220KA3 这个继电器""%I400.3 接哪"
- **成本**：返回约 50–200 token。

### ④ `drawing_sheet` —— 这一页写了什么

- **做什么**：返回**单页的结构化内容**：标题块、该页实体（位号/线号/地址/端子）、该页表格行（若是电缆/端子/通道/针脚页）、出向交叉引用（已解析到目标页与列）。
- **入参**：`cabinet` + `sheet`（或 `page`）、`include?` = `["header","entities","tables","xrefs"]`（默认全给）
- **返回**：结构化 JSON（典型 1–2 KB），**不含原始全文**
- **何时调**：`search` 命中后看细节；用户问"第 210 张图画了什么"

### ⑤ `drawing_show` —— 让右侧栏跳过去

- **做什么**：把"看哪一页、看哪一块"发给 UI：写一条 `tool/result` 载荷（`{cabinet, sheet, page, bbox?, highlight?}`），右侧栏 Drawing 页监听本会话事件后自动翻页并高亮。
- **入参**：`cabinet`、`sheet`（或 `page`）、`bbox?`（`[x,y,w,h]` 或 `region:{column,row}`）、`caption?`
- **返回**：给模型一行摘要（"已显示 AG / sheet 210 · 第 5 列（W015）"），**不给图片**
- **何时调**：agent 已经确定"就是这张图"、且答案需要人核对时；也用于回答末尾"我已把图翻到对应位置"。

> 需要图片给人看时，不新开工具：`drawing_show` 的载荷里带 `capture: true` 时，服务端顺手渲染该区域 PNG 到 `render/`，UI 直接用；模型侧仍只拿到文字摘要。

### 3.1 五个工具的关系

```
drawing_status ──(缺/未索引)──> drawing_open ──> profile 卡
      │
      └─(已索引)──> drawing_search ──> 命中列表
                          │
                          ├──> drawing_sheet ──> 单页结构化内容 + 交叉引用
                          └──> drawing_show ──> 右侧栏跳转（人看）
```

---

## 4 工作流

### 4.1 首次：入库建档

```
用户："这是我这次的图纸 E:\…\PEI---SWT2_20260527.pdf"
   │
   ├─ Agent: drawing_status            → documents: []（还没有）
   ├─ Agent: drawing_open(source)      → 复制 5 MB → sha256 → 解析 4 s
   │                                    → drawing/PEI---SWT2_20260527/{profile.json,index/*}
   └─ Agent 用 profile 卡回答："353 页、3 个柜（AG/BASE-A/BASE-B）、
      图号分段、目录页不可信、24 页方向异常…"（消耗 300–500 token）
```

### 4.2 日常：查一根线

```
用户："W015 这根线从哪到哪？"
   │
   ├─ drawing_status                  → 已索引（命中缓存，0 解析）
   ├─ drawing_search("W015")          → 2 处：AG/sheet210/通道5、AG/sheet3000/电缆详图
   ├─ drawing_sheet(AG, 210)          → 8 通道台账 → 第 5 通道：%I400.2 / X3:3 / W015 0.00m 12x1.00
   ├─ drawing_sheet(AG, 3000)         → 电缆块：W015 参数 + 芯线表（若有）
   ├─ drawing_show(AG, 210, 第5列)    → 右侧栏翻到该页并高亮
   └─ 回答：线号、端子、电缆、两端去向、交叉引用目标
```

### 4.3 责任边界

| 环节 | 谁做 | 是否花钱（token） |
|---|---|---|
| 入库、解析、建索引 | 插件（代码） | 否 |
| 检索、取页、解析交叉引用 | 插件（代码） | 否 |
| 判断"该查什么"、组织答案 | 模型 | 是（50–200 token/次） |
| 看图形/方向异常页 | 模型（视觉，回退） | 是（200–500 token/次，限区裁剪） |

---

## 5 UI 层：右侧栏 Drawing 页

### 5.1 注册方式（照抄本仓已验证的三处 seat）

| 步骤 | API | 对应样例 |
|---|---|---|
| 注册 tab 类型 | `ctx.inject(['sidebarRightTabs'], …)` → `tabs.register({id, kind, title, guide})` | `dsh-ui-versions` |
| 注册 tab 正文 | `slots.register({name:'sidebar.right.pane.tab', key:ID, store, locale, inject}, Panel)` | `dsh-ui-plc-source`（用 `store` 让页面状态跨 tab 切换存活） |
| 注册 tab 标题 | `slots.register({name:'sidebar.right.pane.tab.title', key:ID, locale, inject}, Title)` | 两者一致做法 |
| 读文件 | `ctx.remote.workspaceFiles.readBytes(sessionId, path)` | `dsh-ui-versions` |
| 读本会话事件 | `ctx.sessions.binding(sessionId).eventSource`（`{getSnapshot, subscribe}`） | `dsh-ui-tia-console` |

> 三个坑（README 里都有记录，直接复用）：`sidebarRightTabs` 在 `apply` 时还不可读，必须 `ctx.inject`；子 slot 必须走 `ctx.slots.inject`，裸 `register` 会抛；tab 标题要单独 seat，否则切语言不跟随。

### 5.2 面板结构

```
┌ Drawing ──────────────────────────────────────────────┐
│ [图纸: PEI---SWT2_20260527 ▾]      [检索框________] 🔍│
├───────────────────────────────────────────────────────┤
│ 柜: [AG][BASE-A][BASE-B]   模板: [全部][通道][电缆][端子]│
├───────────────────────────────────────────────────────┤
│ 页列表（虚拟滚动）        │  页面视图（渲染 PNG）       │
│ 210 AG:8 SAFETY INPUTS   │  ┌───────────────────────┐ │
│ 211 …                    │  │  ╔═ 高亮框（W015）══╗  │ │
│ 3000 Cable: W021,…       │  │  ╚═══════════════════╝ │ │
│ …                        │  └───────────────────────┘ │
│                          │  [◀ 上一张] 25/353 [下一张 ▶]│
├───────────────────────────────────────────────────────┤
│ 命中：W015 · AG/sheet210 · 通道5   [定位] [复制引用]    │
└───────────────────────────────────────────────────────┘
```

- **数据来源**：`drawing/<name>/index/*.json`（小、可整体读入）+ 需要时读 `pages/<page>.json`；页面图按需渲染并读 `render/*.png`。
- **页面显示 v1**：`<iframe src={blobUrl}#page=N>`，浏览器自带 PDF 阅读器（与本仓 `dsh-better-sidebar` 的 `PdfView` 同一条路）。零依赖、立刻可用；缺点是不能高亮。
- **高亮/特写 v1.5**：服务端用 `@napi-rs/canvas` 渲染目标区域 → PNG 缓存 → 面板叠框显示。**不要把 pdf.js 塞进客户端**（3 MB + 还要 canvas）。
- **交互**：点页面上的交叉引用框 → 本地面板自己翻页（`xrefs.json` 里已有 target/column，不需要问 agent）；点"定位"→ 跳到 agent 给的命中；点"上一张/下一张"→ 用 `sheets.json` 里图框自带的 `prev/next`。

### 5.3 联动机制（两条通道，均已验证）

```
Agent 侧（宿主）                            浏览器侧（Drawing 插件）
────────────────                            ─────────────────────────
① 数据通道：drawing_show(AG,210,第5列)
   └─ 工具返回带定位载荷的文本
        └──── 本会话事件窗 tool/result ────► eventSource.subscribe()
                                             └─ 折叠出"看哪一页/哪块"

② 打开通道：客户端 decide→open
   right.openTab('dsh-drawing')  ◄────────── sidebarRight 服务面
   right.focus(tabId)
   right.toggleExpanded()（若收起）
```

- **数据通道**：`ctx.sessions.binding(sessionId).eventSource`，`dsh-ui-tia-console` 用的同一条，不需要宿主服务、不需要轮询、不需要新路由。
- **打开通道**：`sidebarRight` 服务面（`openTab/focus/isExpanded/toggleExpanded/mounted/openTabs`），完整调用序列与三个"别抢屏"的礼貌规则见 **§6.5**（`dsh-better-sidebar` 的 Tasks 页就是这么做的）。
- 两条通道的**分工**：事件窗决定"看哪一页"，`sidebarRight` 决定"把列打开"。用户手工操作与 agent 操作共用同一个 `store`（当前页/当前高亮），不会打架。

---

## 6 输入通道、解析引擎与依赖选型（已实测，已定）

### 6.1 需求

| 必须 | 可选 | 约束 |
|---|---|---|
| 文本 + 每个文本 run 的**坐标与朝向**（高亮、按行切词、列带宽都靠它） | 页面渲染成 PNG（区域特写） | 许可证可随插件分发（不能 AGPL/GPL） |
| 353 页全量抽取在秒级 | 中文/内嵌字体兼容 | Windows 上**不能要编译工具链** |
| 与 DSH 自带 Node（实测 **v24.21.0**）兼容 | | 包体不能太大（`dsh plugin add` 会装进 profile） |

### 6.2 候选对比（registry 元数据 + 本机实测）

| 候选 | 许可证 | 安装体积 | 文本几何 | 渲染 | Node | 结论 |
|---|---|---|---|---|---|---|
| **unpdf 2.1** | MIT | **3.1 MB**（自带打包好的 pdf.js 6.4） | ✅ items + `transform` + `width` | 需 `@napi-rs/canvas` | ≥24 ✅ | **选用** |
| pdfjs-dist 6.5 | Apache-2.0 | 35.9 MB | ✅ 同上（unpdf 的上游） | 需 canvas | ≥22.13 ✅ | 备选（带 cmaps/字体） |
| @hyzyla/pdfium 3.0 | MIT | 14.1 MB（wasm 内含） | ❌ `getText()` 只给字符串，`objects()` 无 bbox | ✅ 自带 | ≥22 ✅ | 只能当渲染器 |
| pdfium-native 0.10 | MIT | 0.5 MB + **安装时联网下载二进制** | 待验证 | ✅ | ≥22 | 供应链/离线风险，不选 |
| mupdf (npm) | **AGPL-3.0** | — | ✅ | ✅ | — | **合规不可用**（分发即传染，除非买商业授权） |
| pdf-lib / pdf-parse / pdf2json | MIT | 小 | ❌ 无几何或极弱 | ❌ | — | 不满足 |

### 6.3 本机实测（同一份 353 页图纸）

| 指标 | 结果 |
|---|---|
| 打开 | 46 ms |
| 全量 `getTextContent()`（353 页） | **1.15 s**，125,501 个文本 run |
| 冷 import `unpdf` | **2 ms** → 可以懒加载，不拖慢插件启动 |
| 坐标一致性 | `MICHELIN` 的 `transform = [0, 10.03, -12, 0, 567.36, 338.51]`，与 pypdfium2 的 charbox `left=567.36 / bottom=338.51` **逐位一致** → 研究文档 `electrical-drawings-see-swt2-pei.md` §8.2 的坐标归一化方案原样可用 |
| 旋转 | `getViewport()` 自动应用 `/Rotate`（842×595）；`transform` 仍是未旋转页空间（与 pdfium 同）→ "先按行切、再按间隙切"的规则不变 |
| 粒度 | pdf.js 直接给 **run/词级**（page 25：475 项），比 pypdf 的字符级聚类更省事，还自带 `width` |
| 中文 | 文本层里的 17 个汉字（p106 注记）全部取到；p50 的 `半嵌式开孔` **不在文本层**（无 ToUnicode，画的是字形）——任何引擎都取不到，属"回退视觉"场景 |
| 位图 | 6 页含位图；pdf.js 的 JBIG2/JPX 解码器是可选 wasm，本项目用不到（按需再加） |

### 6.4 决定与打包影响

- **依赖只加一个 `unpdf`（MIT）**，写在 `dependencies`；宿主半边 `import('unpdf')` 用动态 import 懒加载。
- **必须 external**：esbuild/tsdown 默认会把能解析到的包打进产物（AGENTS.md §5 的 `neverBundle` 教训）。unpdf 的 3 MB pdf.js 被内联会让插件产物膨胀、且与 `lib/` 里的第二份副本并存 → 构建配置里显式 `external: ['unpdf']`，并加一条测试断言产物里没有 pdf.js 的特征串。
- **渲染 v1 不做**：右侧栏直接 `<iframe src={blobUrl}#page=N>`（与本仓 `dsh-better-sidebar` 的 `PdfView` 是同一条路，零依赖、浏览器自带 PDF 阅读器）。
  需要"区域高亮/特写"时再加 `@napi-rs/canvas`（MIT、预编译、`win32-x64-msvc` 有官方包，无需编译），它本来就是 unpdf 的可选 peer。
- **换引擎不动上层**：抽取层抽象成 `PdfSource`（`open/text/pageSize/render`），若将来遇到必须 cmaps/内嵌字体的中文图纸，换成 `pdfjs-dist` + 自带 cmaps(1.1 MB)/fonts(0.76 MB) 即可。

### 6.5 右侧栏"自动打开"的官方做法（从 `dsh-better-sidebar` 学到）

宿主 `ui-sidebar-right` 暴露了一个**服务面**，不需要点 DOM、不需要模拟事件：

```
ctx.get('sidebarRight')  →  { openTab(kind, opts?), focus(tabId), active(), isExpanded(), toggleExpanded(), mounted, openTabs }
```

`dsh-better-sidebar` 的 Tasks 页自动弹出（源码：`src/client/context-diagnostics.ts:169-201`、`src/client/sidebar/use-host-feeds.ts:97-132`）走的就是这套，完整序列：

1. **先注册类型**：`sidebarRightTabs.register({id, kind, title, guide})`；`openTab()` 认的是 **kind**（不是包名）。
2. **探测面**：`ctx.inject(['sidebarRight', 'sidebarRightTabs'], …)`，逐个方法 `typeof === 'function'`——**不把"包已安装"当就绪**（宿主版本差异会让面缺席）。
3. **开页**：`right.openTab(KIND)`。
4. **取 tabId**：`right.openTabs.getSnapshot().find(r => r.sessionId === sid && r.kind === KIND)?.tabId`（原生页去重是 pane 级的，必须按会话取）。
5. **聚焦 + 展开**：`right.focus(tabId)`；若 `!right.isExpanded()` 再 `right.toggleExpanded()`。
6. **确认**：`right.mounted.getSnapshot() === sid && right.active()?.id === tabId && right.isExpanded()`。
7. **失败重试**：切会话瞬间会抛 `sidebarRight: no session surface is mounted` —— 下一个 tick 重试，不要放弃。

三个"别抢用户屏幕"的礼貌规则（同样值得照抄）：

- 只在**本会话已挂载**（`mounted.getSnapshot() === sid`）时才操作列；
- 列已展开、且用户正看着**别的**页面时不自动开（`active()?.kind !== 我们`）→ 改为在回答里给一句"右侧栏已可查看"，由用户自己点；
- 窄屏（<768px）宿主会把列画成全屏 → 开完立刻 `toggleExpanded()` 收起，等于"停在后台"，不盖住对话。

> 数据流分工：**工具结果**（本会话事件窗）决定"看哪一页/哪一块"，**`sidebarRight`** 只负责"把列打开并聚焦"。两者都不需要新 HTTP 路由，也不需要监听 DOM。

### 6.6 第二条输入通道：SEE 的 `Project Data extraction` XML（重要）

调研时在本机发现了既有项目 `C:\Users\Ansel\Documents\GitHub\ElectricalDrawingDigest`（Python，已可跑）：

- 它吃的是 SEE 的 **`Project Data extraction` XML**（例：`SEE_ProjectData_OTS-SWT-HF48e.XML`，1.5 MB），该 XML 自带
  **device / pin / net / wire / cable-group / endpoint-to-pin** 关系 —— 也就是我在研究里判定"不要从 PDF 重建"的那张网表，
  **在 XML 通道里是原生数据**。
- 它同时把 PDF 登记进来做"证据"（`pdf_page` / `pdf_text_span` / `entity_pdf_evidence`，FTS5 全文检索），
  并明确记录 **XML 里没有 PDF 页坐标**，页级链接要靠后续"证据关联"补上。
- 结论：**PDF 通道解决"人在哪张图、看哪一块"，XML 通道解决"电气上连着什么"。两者互补，不是替代。**

因此插件应支持**两条输入**，并允许只有其一：

| 输入 | 何时有 | 提供什么 | 本方案的定位 |
|---|---|---|---|
| PDF（必须） | 用户总有 | 页/图号/模板/交叉引用/文字/位置 → 查阅与定位 | P0/P1 主线（已实测） |
| SEE XML（可选） | 用户能从 SEE 里"导出项目数据" | 器件/引脚/网络/线缆/端点的**电气关系** | P2.5 接入：实体表与 PDF 出现位置做 join，`drawing_search` 多一个 `net` 维度 |

接入方式：`drawing_open` 增加可选参数 `projectXml`；存在时建 `entities.xml.json` 并在 `names.json` 上做实体对齐（tag → device UUID），
`drawing_where_used` 就能回答"这个网络/这台设备在图纸哪几页、连了什么"。**归并点是 tag（位号），不是坐标**——两边都认 `220KA3`。

### 6.7 已知输入现状（写进验收前提）

| 项 | 现状 |
|---|---|
| 本方案研究的 PDF | `E:` 盘已不可用；现存副本 `C:\Users\Ansel\Downloads\PEI---SWT2_20260527.pdf`（4.64 MB，与原文一致：353 页） |
| P5 泛化样本 | `C:\Users\Ansel\Documents\GitHub\ElectricalDrawingDigest\source\SWT-HF48e-Pilot\SWT_HF48E_20260706_Revision_A.pdf`（5.3 MB，同一 SEE 体系，且**同时有 XML 与 BOM xlsx 作对照真值**） |
| 对照真值 | 同目录 `HF48E_Cable_List_Bom_20260703.xlsx`、`HF48E_Part_List_Bom - 20260703.xlsx` → 可直接验证电缆表/BOM 抽取的准确率 |

---

## 7 数据契约

### 7.1 `profile.json`（档案卡，也是模型"怎么查"的说明书）

```jsonc
{
  "document": "PEI---SWT2_20260527.pdf",
  "sha256": "…", "pages": 353, "parsedAt": "2026-11-03T…",
  "vendor": "SEE Electrical 4.80 (MICHELIN V4R3)",
  "project": {"name":"SINO ARP PEI MANUAL CROSSING FLOW","no":"19126-17800-MPE","rev":"D","date":"2019-10-28"},
  "cabinets": [{"id":1,"name":"AG","pages":[1,81],"sheets":80},
               {"id":2,"name":"COF-BASE-A","pages":[82,216],"sheets":134},
               {"id":3,"name":"COF-BASE-B","pages":[217,353],"sheets":136}],
  "templates": {"channel":120,"cable":55,"terminal":18,"connector":34,"layout":12,"synoptic":22,"power":10},
  "numbering": {"100-199":"电源配电","200-299":"PLC通道","300-499":"IO-Link/无源","500/800/1800":"布置",
                "600/900/1900":"系统图","1100-1299":"盖板","3000-3023":"电缆详图","4000-4021":"端子/针脚"},
  "indexes": ["sheets","xrefs","names","tables/cables"],
  "quality": {"inkScore": 1.0, "pagesWithoutSheet": 3, "oddOrientationPages": 24},
  "caveats": ["SUMMARY 页与纸面不一致，不可作索引",
              "24 页方向异常（连接器针脚页），仅支持按页跳转",
              "图号跨柜重复，主键 (cabinet, sheet)"]
}
```

### 7.2 其余索引的字段（摘要）

| 文件 | 每条形如 | 量级（本项目） |
|---|---|---|
| `index/sheets.json` | `{cabinet, sheet, page, title, template, loc, prev, next}` | 350 条 / 74 KB |
| `index/xrefs.json` | `{fromPage, fromSheet, raw, targetSheet, column, side, targetPage, bbox}` | 1,669 条 / 117 KB |
| `index/names.json` | `{name, kind, occurrences:[{page, sheet, bbox, role}]}` | 1,322 键 / 205 KB |
| `index/tables/cables.json` | `{ref, type, strands, section, manufacturer, code, from, to, length, cores[]}` | 348 根 / 263 KB |

> 总量约 0.7 MB/项目——浏览器端整体读入无压力；后续如需全文检索再换 SQLite FTS（服务端侧）。

---

## 8 阶段划分、交付物与验收

| 阶段 | 任务 | 可交付物 | 验收（可验证） |
|---|---|---|---|
| **P0 骨架** | 建包 `packages/dsh-drawing`；宿主空壳 + 客户端空 tab；5 个工具签名桩；`cordis.patch.yml`；蓝图 bundle 行；`.gitignore` | 可安装的空插件（tarball + link 两种装法都通） | `dsh --profile … --dump-config` 出现插件行；`--dump-config-schema` 出现配置字段；`pnpm test` 桩测试通过；右侧栏出现空 Drawing tab |
| **P1 解析** | `unpdf` 抽取（§6）、坐标归一、落墨闸门、页索引/交叉引用/实体三类索引、`profile.json`；`drawing_open` + `drawing_status` | `index/*.json` 全套 + 档案卡 | 用本 PDF：图号 350/353、交叉引用 1,669 条且 100% 可解析、落墨率 ≥95%（329 页应 100%）、解析 <10 s、二次调用 0 解析（命中缓存） |
| **P2 检索** | `drawing_search` / `drawing_sheet`（含 xref 解析与表格行） | 三个查询工具可用 | `W015`→2 页；`220KA3`→4 页；`%I400.3`→1 页；`sheet(AG,210)` 返回 8 通道；单次返回 <2 KB |
| **P3 面板** | 右侧栏 tab（注册 + 正文 + 标题）、图册条、检索框、页面视图、高亮框、交叉引用点击、PNG 渲染与缓存 | 可用的 Drawing 页 | 353 页翻页不卡；点 `(220-14)` 跳 sheet 220 第 14 列；方向异常页有"仅按页跳转"提示；缓存命中后翻页 <100 ms |
| **P4 联动** | `drawing_show` + 客户端事件折叠（`tool/result` → 导航）+ `sidebarRight.openTab/focus/toggleExpanded`（§6.5） | agent↔UI 联动 | 对话问"W015 走哪"：**右侧栏被自动打开**、翻到 sheet 210 并高亮；列正被别的页面占用时不抢屏、只给提示；切会话瞬间的 `no session surface is mounted` 能自动重试成功 |
| **P5 泛化** | 黄金样本（5 类模板各 3 页）+ 回归测试；用 `SWT_HF48E_20260706_Revision_A.pdf`（另一项目，同 SEE 体系）跑通；用同目录 BOM xlsx 当真值核对电缆表 | 测试套件 + 泛化报告 + 准确率表 | 黄金样本字段级 100% 一致；新图纸一次跑通率 ≥90%；电缆表对 BOM 的召回/精确率均可量化（目标 ≥90%） |
| **P6 收尾** | 打包、profile 验收、文档 | tarball + README + 本方案回填 | `dsh plugin add` + `--dump-config` 通过；`pnpm -r build/typecheck/test` 全绿 |

**里程碑建议**：P0+P1 先跑通（能回答"这图纸里有啥"），P2 就能支撑 80% 的查阅；P3+P4 是体验跃迁；P5 决定能不能复用。

---

## 9 风险与待确认

| 项 | 影响 | 处理 |
|---|---|---|
| ~~客户端"打开 tab"的公开 API~~ | **已确认**：`sidebarRight` 服务面（§6.5），`dsh-better-sidebar` 的 Tasks 页在用 | P4 直接实现；仍保留"tab 已打开时自动跟随"作为兜底 |
| 解析引擎（纯 JS，无原生依赖） | 无编译/跨平台问题 | 已选 `unpdf`（MIT，3.1 MB）；接口层抽象成 `PdfSource`，必要时换 `pdfjs-dist` |
| 5 MB 图纸 + 0.7 MB 索引入库 | 工作区体积 | 派生物 gitignore；原件由用户决定；索引按 sha 去重 |
| 24 页方向异常 / 偶发字形误映射 | 少数页检索体验 | 落墨闸门自动标记，`caveats` 告知模型；这些页仅按页跳转 |
| 厂商绑定（SEE） | 换 EPLAN 要重写规则 | 规则做成 provider（`src/providers/see-*.ts`），P5 用第二份 SEE 图纸 + BOM 真值验证；EPLAN 另写 provider |
| 图纸多份时检索范围 | 用户可能想要跨册 | v1 单册（`document` 参数可选）；v2 再联合 |

---

## 10 目录（代码）

```
packages/dsh-drawing/
├── src/
│   ├── index.ts                宿主：注册 5 个工具 + 服务 drawingIndex
│   ├── indexer/
│   │   ├── pdf.ts              PdfSource 抽象（unpdf：文本 run + 框；渲染按需）
│   │   ├── normalize.ts        坐标归一化 + 落墨闸门
│   │   ├── providers/see.ts    SEE 规则：图号/位号/线号/交叉引用/模板
│   │   ├── sheets.ts  xrefs.ts  names.ts  tables/cables.ts
│   │   └── profile.ts          档案卡生成
│   └── client/
│       ├── index.jsx           三个 seat 注册
│       ├── Panel.jsx           图册条 + 检索 + 视图 + 高亮
│       ├── model.js            纯逻辑（筛选/翻页/事件折叠，可单测）
│       ├── locales.js  style.js  Title.jsx
└── test/                       纯逻辑与索引回归
```






---

## 11 实现状态（P0 + P1 已落地，2026-11-03）

代码在 `packages/dsh-drawing`（`@voltarenyah/dsh-drawing`），已进蓝图 `profile/dsh-automation-suite`。

### 11.1 交付

| 计划项 | 状态 | 证据 |
|---|---|---|
| P0 包骨架 + 5 个工具 + 右侧栏 tab + 蓝图注册 | ✅ | `dsh plugin add voltarenyah-dsh-drawing-0.1.0.tgz` → `--dump-config` 出现 `# == @voltarenyah/dsh-drawing` / `- id: drawing`；`--dump-config-schema` 出现 `dir` 字段且 `status: "schema"`、`diagnostics: []` |
| P1 解析 + 三类索引 + 档案卡 | ✅ | 353 页 **2.4 s**；图号 350/353；交叉引用 1,794 条、解析 1,750（97.5%）；实体 1,521；二次调用 `cached: true` |
| 电柜划分与命名 | ✅ | `1:AG` / `2:COF-BASE-A` / `3:COF-BASE-B`，页界 1–81 / 82–216 / 217–353 与实测一致 |
| 工程身份 | ✅ | `SINO ARP PEI MANUAL CROSSING FLOW` / `19126-17800-MPE` / `D` / `2019/10/28` / `SEE Electrical 4.80` |
| 模板分类 | ✅ | main 3 · revision 3 · summary 13 · ground 1 · marking 1 · power 10 · schematic 174 · layout 12 · synoptic 22 · cable 62 · terminal 18 · connector 34 |
| 目录不可信的自动告警 | ✅ | `caveats` 里自动生成"SUMMARY 列出 N 个纸面不存在的图号"（比研究报告里的手工比对更完整：79 个） |
| 右侧栏面板 | ✅（只读版） | 图纸列表 + 档案摘要 + 注意事项 + 按电柜/关键词筛图号；数据走 `.dsh/drawing-manifest.json` + `remote.workspaceFiles` |
| 测试 | ✅ | 17 项：10 项纯规则/基线（含真实 PDF）+ 7 项工具契约 |

### 11.2 与设计基线的偏差（都是有意为之）

| 偏差 | 原因 |
|---|---|
| 落墨闸门（ink gate）未启用，改为"文本框是否落在页面内"自检（实测 100%） | 落墨需要把页面栅格化，而 v1 没有 canvas 依赖（渲染推到 P3）；页面内自检同样能抓住坐标归一化错误 |
| 交叉引用 1,794 条 vs 研究报告 1,669 条 | pdf.js 的分词与 PDFium 不同，且本次同时保留了"裸写"形式；解析率仍 >97% |
| 电缆 62 张 vs 研究报告 55 张 | 研究报告有 7 张电缆页标题没取到而被归入 SCHEMATIC；本次标题全部取到 |
| 24 页纵向针脚图 | 图号靠"距 `SHEET` 标签最近的大字号数字"取到（350/353 全中）；标题按"标题词表 + 就近"取，`prev/next` 仍为 null |
| 未做 `drawing_table` / 电缆表 | 按你的决定，P1 不导出表格；解析层已保留 `names`/`xrefs` 足够回答，表格留到 P2 |

### 11.3 下一步入口

- P2：电缆/端子/通道表格（解析层加 `tables/`），`drawing_search` 增加 `net` 维度（接 SEE XML 通道）。
- P3：右侧栏页面渲染（`<iframe src={blobUrl}#page=N>` 起步）+ 命中高亮覆盖层。
- P4：`drawing_show` → 事件折叠 → `sidebarRight.openTab/focus/toggleExpanded`（§6.5 的序列已就绪）。

### 11.4 P3 + P4 追加（2026-11-03 晚）

| 计划项 | 状态 | 证据 |
|---|---|---|
| P3 页面渲染 | ✅ | `@hyzyla/pdfium`（MIT，wasm）+ `pngjs`（MIT）在宿主侧栅格化：page 25 → **1684×1190 PNG / 292 KB**，约 120 ms，按 `页面+scale+mtime` 缓存在 `drawing/<名>/render/`；坐标与文本框同源（display 842×595），所以命中框 2× 后直接落在元件上（已用渲染图核对 W015 位置） |
| P3 面板查阅 | ✅ | 左侧图号列表点击 → 浏览器自带 PDF 阅读器 `#page=N`；agent 定位时显示渲染图 + 蓝框高亮 + 当前定位说明 |
| P4 联动 | ✅（宿主+客户端代码已通，真机点验待做） | 宿主 `drawing_show` 栅格化该页并写 `.dsh/drawing-view.json`；客户端在 `conversation.input.dock` 挂一个渲染为 null 的 controller，折叠 `tool/call`+`tool/result`（按 callId 认 `drawing_show`）→ 读 view 文件 → 共享 store → `sidebarRight.openTab/focus/toggleExpanded`（§6.5 序列，含"不抢用户页面"与切会话重试） |
| 客户端装配 | ✅ | 实际启动的 shell 里 `__DSH_BOOT__.entries` 含 `{"id":"@voltarenyah/dsh-drawing","url":"plugins/??@voltarenyah/dsh-drawing/client.js&rev=dfabc4992f8c"}`；bundle 28,142 B，含 `sidebar.right.pane.tab` / `conversation.input.dock` / `drawing-controller` / `drawing-view.json` 标记 |
| 测试 | ✅ | 23 项：10 规则+基线（含 PNG 尺寸/签名/缓存）、7 工具契约、6 客户端联动逻辑（store 去重、openTab 顺序、不抢屏、切会话重试） |

**尚未验证**：真机点验（点 tab chip、看图片渲染、agent 调用后侧栏自动翻开）。本轮环境没有浏览器自动化工具，只能验到"bundle 被 shell 加载、宿主文件与调用序列正确"。验收路径：`pwsh -NoProfile -File scripts\start-env.ps1 -Restart` → 打开右侧栏 Drawing → 在对话里让 agent `drawing_show`。

**渲染引擎选择（补充记录）**：P3 实际用 `@hyzyla/pdfium` 而不是计划里的 `@napi-rs/canvas`。理由：canvas 要带平台二进制（win32-x64 各一份），而 pdfium 是 wasm、无需编译、一次 `render()` 出 RGBA；代价是 +14 MB 安装体积（只在宿主侧，浏览器半侧仍 28 KB）。
