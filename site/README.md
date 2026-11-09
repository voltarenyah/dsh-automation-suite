# 产品介绍页（GitHub Pages）

`main` 分支上 `site/` 的每次改动都会由 `.github/workflows/pages.yml` 直接发布到
<https://voltarenyah.github.io/dsh-automation-suite/>。站点是**纯静态**的：没有构建步骤、没有运行时依赖。

## 现在的结构：模板首页 + 自制子页

| 路径 | 视觉 | 文件 |
|---|---|---|
| `/` | **Pixa 模板改造的套件首页**（点阵、辉光、衬线标题、能力词墙），中英双语 | `index.html` + `css/` + `index.js` + `assets/main.js` + `assets/images/` |
| `/architecture/` | 自制四页版（浮动玻璃栏、卡片、表格） | `architecture/index.html` |
| `/roadmap/` | 同上 | `roadmap/index.html` |
| `/get-started/` | 同上 | `get-started/index.html` |

四页共用一套顶部导航（Home / Architecture / Roadmap / Get Started），所以从模板首页可以进入三个子页，反之亦然。

### 首页相对模板的改动

1. **顶栏**保留模板的四项导航与主题切换，把「中文」按钮接上（原模板里它是 `disabled`），并在语言开关右侧加回 GitHub 图标；去掉模板的 API/Blog/Solutions/Features/Pricing 与 “Try playground”。
2. **首屏**换成能力词墙（`#capability-wall`，由 `index.js` 按中英双语词表生成），删掉模板的 Try Prompts 演示窗口与视频弹窗。
3. **文案换成套件的**：删掉模板残留的 AI 工具卡片、订阅套餐（$9/$17/$29）、假推荐语、博客区、Pixa/LLM FAQ 与假页脚；换成「What ships today」六张能力卡（带状态）、套件自己的 FAQ、CTA 与页脚。首屏文案保持 `Agent Tool for PLC Programming` / `DeepSeek Harness integrated with the Siemens TIA Openness toolkit.` 不变。
4. 首页现在和子页共用一套机制：英文写在 `index.html` 的 `data-block` 里，中文在 `assets/main.js` 的 `I18N.zh`，语言偏好存 `das.lang`（与子页互通）。
5. 只保留模板的点阵背景、辉光、衬线排版与 Tailwind 类；模板 logo 换成站点自己的 20×20 标记，未引用的模板图片与 `scripts/components.js` 已删除（授权见下）。

### 子页的文件

```
assets/app.css       设计系统（明/暗两套变量）
assets/main.js       中文文案字典 + 每页 title/description + 语言切换 + 复制命令
assets/arch.js       架构页独有的数据与渲染器（仅 /architecture/ 加载）
assets/ui.js         主题切换、移动端菜单、滚动揭示
assets/fonts/        Instrument Sans + IBM Plex Mono（自托管）
content.md           子页的英文内容底稿（手动同步，不自动渲染）
```

- 子页英文在 HTML 里，中文由 `main.js` 按 `data-block` 覆盖；`<html lang>` 与 `<title>` 一起切换。
- 架构页的组件表与 preset 矩阵由 `arch.js` 按 `ARCH_I18N` 与数据数组渲染；改这两块只改 `arch.js`。
- 首页保留模板自己的脚本与样式（`tw-` 前缀的 Tailwind + `css/index.css`，不加载 `app.css`），但**语言切换走同一个 `assets/main.js`**：`<body data-page="home">`，中文在 `I18N.zh` 的 `home.*`。能力词墙是 `index.js` 生成的，`main.js` 切语言后会派发 `das:langchange`，词墙据此用另一语言重建。

## 改文案

- **首页**：改 `index.html` 里的 `data-block` 段落 → 中文同步进 `main.js` 的 `I18N.zh`（`home.*`）；英文改完也要更新 `I18N.en` 同名条目，否则从中文切回英文会显示旧文案。能力词墙改 `index.js` 的 `CAPABILITY_TERMS`（`{ en, zh }` 成对）。
- **子页**：改 `content.md` → 同步英文进对应 HTML → 同步中文进 `main.js` 的 `I18N.zh`。
- **架构页**：静态段落进 `arch.js` 的 `I18N`（`ARCH_I18N`），表格/矩阵改 `COMPONENTS`、`PRESETS` 数组。
- 技术名词、包名、命令不翻译。

### 可视化改文案（浏览器里点着改，自动写回源文件）

```powershell
node tools/site-editor/server.mjs     # 自动打开 http://127.0.0.1:4173/
```

点页面上任意文字就地编辑，回车即写回它真正的来源（首页 → `index.html`；子页英文/中文 →
`assets/main.js` 的 `I18N`；架构页段落与组件表 → `assets/arch.js`），Esc 取消，可撤销、可看
`git diff site/`。工具位于 `tools/site-editor/`（不随 Pages 发布），说明与验收见其 `README.md`。


## 授权

模板为付费授权（`license-pixa.txt`）：可自用与修改，**不可把模板本身再分发或开源**；
模板 `package.json` 里写的 MIT 是作者笔误，以 license 原文为准。

## 本地预览

```powershell
python -m http.server 4173 --directory site
# 打开 http://127.0.0.1:4173/
```

目录形式的地址需要服务器（`/architecture/` 走 `index.html`）；直接双击 `site/index.html` 只能打开首页。

## 发布

- Pages 已启用（`build_type=workflow`），`site/**` 有改动 → push 到 `main` → Actions 部署，约 30 秒。
- 只上传 `site/`：仓库其它内容（`docs/`、`packages/`、AGENTS 等）不会上线。

## 约定

- 状态文案必须与 `docs/roadmap.md` 一致（✅ 已验证 / 🟡 部分实现 / ⬜ 未开始），不要夸大。
- 页脚免责声明（非官方、与 DeepSeek / Siemens 无隶属关系）要保留。
