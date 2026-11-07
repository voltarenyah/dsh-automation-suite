# 产品介绍页（GitHub Pages）

`main` 分支上 `site/` 的每次改动都会由 `.github/workflows/pages.yml` 直接发布到
<https://voltarenyah.github.io/dsh-automation-suite/>。站点是**纯静态**的：没有构建步骤、没有运行时依赖。

## 现在的结构：模板首页 + 自制子页

| 路径 | 视觉 | 文件 |
|---|---|---|
| `/` | **Pixa 模板原样**（点阵、辉光、衬线标题、Try Prompts 窗口、定价、FAQ） | `index.html` + `css/` + `index.js` + `scripts/` + `assets/images/` |
| `/architecture/` | 自制四页版（浮动玻璃栏、卡片、表格） | `architecture/index.html` |
| `/roadmap/` | 同上 | `roadmap/index.html` |
| `/get-started/` | 同上 | `get-started/index.html` |

四页共用一套顶部导航（Home / Architecture / Roadmap / Get Started），所以从模板首页可以进入三个子页，反之亦然。

### 首页相对模板的改动（只有这几处）

1. **顶栏**换成四项导航 + GitHub 按钮（去掉模板的 API/Blog/Solutions/Features/Pricing 与 “Try playground”）；
   主题切换保留，`index.js` 里对已删除的特性下拉做了空值保护。
2. **隐藏的 YouTube 视频弹窗整套删除**（`#video-container-bg` 与 iframe），连带删掉首屏的 “Watch video” 按钮。
3. 首屏 “Get started” 按钮指向 `get-started/`。
4. 去掉了模板自带的 GTM 空 ID 脚本（`G-`，没有追踪作用）。

其余文案、图片、版式与模板一致。

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
- 首页是模板自己的脚本与样式（`tw-` 前缀的 Tailwind + `css/index.css`），不加载 `app.css`、不参与语言切换。

## 改文案

- **首页**：直接改 `index.html`（模板文案全是普通 HTML，按小节标题搜索即可）。
- **子页**：改 `content.md` → 同步英文进对应 HTML → 同步中文进 `main.js` 的 `I18N.zh`。
- **架构页**：静态段落进 `arch.js` 的 `I18N`（`ARCH_I18N`），表格/矩阵改 `COMPONENTS`、`PRESETS` 数组。
- 技术名词、包名、命令不翻译。

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
