# 产品介绍页（GitHub Pages）

这个目录**只放站点文件**，`main` 分支上 `site/` 的每次改动都会由
`.github/workflows/pages.yml` 直接发布到
<https://voltarenyah.github.io/dsh-automation-suite/>。

站点是**纯静态**的：没有构建步骤、没有框架、没有运行时依赖。改完文件刷新即可。

## 结构

```
site/
  index.html          唯一页面；英文是默认内容，中文由 assets/main.js 切换
  assets/styles.css   全部样式（浅色编辑风；颜色与字号集中在 :root）
  assets/main.js      语言切换、滚动揭示、复制命令
  assets/favicon.svg
  assets/fonts/       Instrument Sans + IBM Plex Mono（自托管，不依赖 CDN）
```

## 改文案

- **英文**：直接改 `site/index.html` 里的文本（英文是 HTML 源内容，也是无 JS 时的默认）。
- **中文**：改 `site/assets/main.js` 里 `I18N.zh` 的对应键。
- 两边用同一批 `data-i18n` 键；新增文案时，HTML 加 `data-i18n="键名"`，两个字典各补一条，
  否则切换语言时该处会保持原样（不会报错）。
- 技术名词、包名、命令不翻译。

## 改样式

`assets/styles.css` 顶部 `:root` 是全部设计变量：纸色、墨色、唯一强调色 `--accent`、
最大宽度 `--maxw`。中文排版差异（字距、行高）在文件末尾 `html[lang="zh-CN"]` 段。

## 本地预览

```powershell
# 任选其一
python -m http.server 4173 --directory site
# 或直接双击 site/index.html（纯相对路径，file:// 也能打开）
```

## 发布

- 首次：仓库 Settings → Pages → Source 选 **GitHub Actions**（或由管理员调用
  `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow` 开启）。
- 之后：`site/` 有改动 → push 到 `main` → Actions 自动部署，约 30 秒。
- 只发布 `site/` 目录：仓库其它内容（`docs/`、`packages/`、AGENTS 等）不会上线。

## 约定

- 状态文案必须与 `docs/roadmap.md` 一致（✅ 已验证 / 🟡 部分实现 / ⬜ 未开始），不要在这里夸大。
- 页面不含第三方分析脚本、不加载外部字体与图片。
- 免责声明（非官方、与 DeepSeek / Siemens 无隶属关系）留在页脚，不要删。
