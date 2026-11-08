# Changelog

本文件记录 **dsh-automation-suite 发行版**（distribution）的版本。它和
**插件版本**（`packages/*/package.json`）以及 **DSH 宿主版本**（0.2.1-rc.x）是三套独立的版本号。

格式参考 [Keep a Changelog](https://keepachangelog.com/)；日期为本地日期；版本从
GitHub Releases 与 git tag `v<version>` 对齐（发布流程见 [`docs/releases.md`](docs/releases.md)）。

## [0.2.3] - 2026-11-08

首页品牌、中文界面与桌面交互修正；插件与 profile 有更新，安装流程不变。

### Added

- **首页 hero 品牌**（`dsh-ui-brandmark`）：标题改为 `dsh-automation-suite`，徽标改为 `TIA-V17`，
  左侧图标改为桌面壳的 app 图标（`desktop/DshSuite.Shell/app.ico` 的 128 px PNG，构建期内联为
  data URL）。文案只覆盖 `conversation` 命名空间的 `hero.headline` / `hero.preview`，其余翻译
  原样落回字典；图标占用单座 `conversation.hero.brand.mark`，替换默认的鱼形 fallback。
- **侧栏插件中文名**：`Prompt Guide` → 提示词引导，`Project Dashboard` → 项目看板；提示词引导页
  的标题、`<h1>`、元信息与「从侧栏打开」的提示随语言切换。
- **右侧栏起始页的独立图标**：PLC 块 / 版本 / 变更 / 硬件组态 / 图纸 各有自己的 36-viewBox 图标，
  不再共用起始页的通用方块。

### Changed

- **目录选择器固定为应用内浏览**：profile 关闭上游 `directory-picker`（auto），改为显式挂
  `dsh-host-directory-picker-browse` + `dsh-client-ui-directory-picker-browse`。本地回环与
  远端/SSH 都弹应用内「选择工作区目录」，不再弹 Windows 系统文件夹对话框；安装器与 `start-env`
  共用同一份 profile patch。

### Fixed

- 中文环境下侧栏两个插件入口仍显示英文。
- 本地桌面/开发环境添加工作区时弹系统文件夹对话框（改为应用内 Miller 列对话框）。

### Verified

- `pnpm -r test`（16 个包全绿）、`pnpm -r build`、`pnpm -r typecheck`。
- `build-app-layer.mjs --version 0.2.3`：离线 `--dump-config` + doctor。
- 0.2.3 静默安装 + 固定 profile + doctor + 壳 `--smoke-test`。
- 浏览器实测（zh-CN）：首页品牌、侧栏中文、应用内目录选择、五个 tab 图标。

## [0.2.2] - 2026-11-08

标题栏与窗口外观版本；插件/profile 内容与安装流程不变。

### Added

- 桌面壳改为与 DeepSeek Harness 桌面版一致的无边框标题栏：40 px 标题条与侧边栏同色，
  左侧侧边栏开关 + `Application` / `Edit` 菜单，右侧最小化/最大化/关闭；颜色全部使用
  DSH 主题 token，浅/深色自动跟随。
- 标题条拖动、双击最大化/还原、右键系统菜单由 WebView2 非客户区拖动支持完成；
  `Application` 提供关于/打开日志/运行诊断/退出，`Edit` 提供撤销/重做/剪切/复制/粘贴/全选
  （粘贴经 WebMessage 读取宿主剪贴板，保留撤销栈）。
- 启动期改为覆盖客户区的加载层；移除原来的 30 px 状态行与 `Ready`。
- 初始窗口改为工作区的 90% 并居中（高 DPI 下旧的 1440×900 物理像素只有约 740 CSS px，
  DSH 布局会自动收起侧边栏）。

### Fixed

- **浅色/深色标题条上方的黑边**：`WM_NCCALCSIZE` 让客户区铺满整个窗口，不再保留系统
  8 px 尺寸边框；`DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` 关闭 DWM 1 px 边框；主题判断
  以应用自己的 `data-ds-dark-theme` 为准，不再用系统深色兜底。
- 客户区铺满后左/右/下边缘缩放改由 `TitleBarScript.js` 命中后调用系统缩放循环；
  最大化时客户区固定为监视器工作区。

### Verified

- `pnpm -r test`（设置 `DOTNET_ROOT` 到 `.dotnet10` 后）、`pnpm -r build`、`pnpm -r typecheck`。
- 0.2.2 静默安装 + 固定 profile + 壳 `--smoke-test`。
- 手工验收：拖动/双击/缩放、窗口按钮、Application/Edit 菜单、复制/粘贴、关闭到托盘、
  Exit 清理 DSH 子进程、浅/深色主题。

### Known limitations

- 窗口按钮为网页自绘，Windows 11 的贴靠布局浮出（悬停最大化按钮）不会出现；
  顶部 40 px 为拖动区，缩放从左/右/下边缘发起。

## [0.2.1] - 2026-11-08

0.2.0 的 DPI 与图标热修复，不改变 profile/插件内容与安装流程。

### Fixed

- 壳显式调用 `Application.SetHighDpiMode(HighDpiMode.PerMonitorV2)`；此前
  csproj 的 `ApplicationHighDpiMode` 未生成实际调用，导致 Windows 位图缩放、
  WebView2 界面模糊。进程 DPI awareness 已验证为 `2`（per-monitor）。
- 新增 `desktop/DshSuite.Shell/app.ico`（16–256 多尺寸），并用于 exe、窗口、
  托盘、安装器、桌面快捷方式与卸载项。

### Verified

- 0.2.1 静默安装 + 固定 profile + 壳 smoke 通过；图标可从 exe 与 setup 提取；
  本机视觉确认 DPI/图标正常。

## [0.2.0] - 2026-11-08

首个桌面安装包版本。

### Added

- **桌面打包前置件**（2026-11-07）：`build-app-layer.mjs`（真实 `node_modules` 物化 +
  离线 `--dump-config`/doctor 验收）、doctor JSON 契约（`schemaVersion: 1`）、
  固定 profile 三方合并 `merge-profile.mjs`、DSH 直接启动/清理探针 `probe-dsh-web.mjs`、
  安装器 runtime bootstrap 探针 `probe-dsh-runtime.ps1`。见 `desktop/README.md`。
- **Phase 1 WebView2 壳**（`desktop/DshSuite.Shell`）：独立窗口、托盘、单实例、日志、
  `--smoke-test` 隐藏导航；Job Object 持有 DSH 进程树，退出无残留。尚未打包安装器。
- **Phase 2 安装器**：Inno 安装器稳定 shell + 版本化 app layer；`install-profile.ps1`
  复制固定 profile、备份并三方合并旧 `cordis.patch.yml`、写 `install.json`、跑
  `doctor.ps1 -Json`（fail 则恢复旧 profile）。壳读取 `install.json` 的 DSH_HOME/profile。
  沙箱安装/模拟升级/卸载已验。
- **Phase 2c DSH/WebView2 bootstrap**：DSH 缺失时从官方 feed 下载，校验 SHA-512 +
  DeepSeek Authenticode，静默安装并等待 `dsh.cmd`；WebView2 缺失时安装 Evergreen
  Bootstrapper。干净 Windows 11 LTSC 2024 VM 分别验收“无 DSH（WebView2 存在）”与
  “无 WebView2（DSH 已装）”两条路径：DSH 0.2.2-rc.1、WebView2 157.0.4341.42、
  profile/doctor（8 OK / 4 WARN / 0 FAIL）、壳 smoke `ok=true`、卸载干净。

### Known limitations

- 安装器未签名，SmartScreen 会提示未知发布者。
- 无自动更新；升级 = 运行新版 setup，固定 profile 会备份并三方合并用户覆盖项。
- DSH 版本策略未实现（已装 DSH 直接复用，doctor 只警告版本差异）。
- Windows 10 未单独验收；干净 VM 验收用的是 Windows 11 LTSC。
  设计已定稿、尚未实施：[`docs/desktop-packaging.md`](docs/desktop-packaging.md)。

## [0.1.5] - 2026-11-07

**最后一个以 Web 方式启动的版本。** 安装后仍是本机 Web UI（浏览器标签页 + 控制台窗口），
桌面壳与安装器从下一阶段开始。

### Added

- **`doctor.ps1` / `doctor.cmd`**：安装末尾自动运行，也可随时双击重跑。检查 DSH/profile/插件行、
  图谱引擎 `--self-test`、.NET Framework 4.8、TIA V17 + Openness 组、PLCSIM API 4.0、git、
  PDF/Excel 的 npm 依赖与模型凭据；输出 `[ OK ]` / `[WARN]` / `[FAIL]`，`-Json` 供桌面安装器复用。
- **`dsh-ui-changes`（P1）**：右侧栏 **Changes** 标签页 + 只读状态路由
  `GET /changes/api/status`。真实 git 状态（宿主按会话 `header.cwd` 找仓库，
  `status --porcelain=v1 -z` + `diff --numstat -z -M HEAD`，未跟踪文件按行数计），
  面板可见时每 5 s 自刷新。**提交区（P2）尚未实现** —— 面板目前只读。
  设计与 P0/P1 验收记录见 [`docs/ui-changes-panel-plan.md`](docs/ui-changes-panel-plan.md)。
- 把 0.1.4 之后新增/登记的插件全部纳入发行版：`dsh-drawing`、`dsh-ui-versions`、
  `dsh-ui-hardware`、`dsh-ui-prompt-guide`、`dsh-ui-project-dashboard`，加上 `dsh-ui-changes`，
  共 **13 个本地插件** + 公共 `dsh-opencode-go`。

### Changed

- **图谱引擎升到 .NET 10 LTS，并在发布包里自包含**：`dsh-engineering-graph` 的 tarball 现在带一个
  win-x64 单文件引擎（约 39 MB），**用户不需要安装 .NET 8/10**；`engine/bin` 仍保留
  framework-dependent 的开发构建。理由与实测见 `docs/decisions.md` D33。
- 安装器在 `install.json` 里记录 `dshExe`；安装末尾自动跑 doctor。
- 蓝图增加 `dsh-ui-changes`；`--dump-config` 为 **2090 行 / 14 个插件行**（DSH 0.2.1-rc.2，
  全新 profile）。

### Notes

- profile：`dsh-automation-suite-v0.1.5`；专用 home 不变。
- 首次安装仍需网络：十三个 tarball 来自 GitHub Release（约 34 MiB），npm 依赖来自 registry。
- TIA 部分仍需 Windows + TIA V17；PLCSIM 需 PLCSIM Advanced API 4.0；git 插件需 `git.exe`。
  这些外部能力由 doctor 报告，不会被安装器静默假装可用。
- Release：<https://github.com/voltarenyah/dsh-automation-suite/releases/tag/v0.1.5>

## [0.1.4] - 2026-10-26

### Changed

- 四个内置 preset（Standard / PTC / Minimal / Creator）默认 `disabled: true`；选择器只保留
  发行版的 `leader` / `auditor` / `expert`。它们不声明工程工具行，切过去会静默丢工具。
- 只改 profile 政策层；插件资产与 0.1.3 相同。

### Notes

- profile：`dsh-automation-suite-v0.1.4`；`--dump-config` 2036 行。
- Release：<https://github.com/voltarenyah/dsh-automation-suite/releases/tag/v0.1.4>

## [0.1.3] - 2026-10-26

### Added

- 发布版默认使用**专用 DSH_HOME**：`%USERPROFILE%\dsh-automation-suite-home`。
  workspace 注册表、sessions、设置、模型凭据与日常 desktop 完全隔离。
- `start.cmd` / `start.ps1`：读取 `install.json`，设置 `DSH_HOME`，从 3093 起自动挑空闲端口，
  启动并打开浏览器。
- `install.ps1` 在解压目录写 `install.json`，记录本次安装的 home 与 profile。

### Changed

- 默认安装位置从 `~/.dsh` 改为上述专用 home；7 个插件 + `dsh-opencode-go`。
- `--dump-config` 2033 行（全新 profile）。

### Notes

- profile：`dsh-automation-suite-v0.1.3`。
- Release：<https://github.com/voltarenyah/dsh-automation-suite/releases/tag/v0.1.3>

## [0.1.2] - 2026-10-26

### Added

- `install.cmd`：可双击安装。它用进程级 `-ExecutionPolicy Bypass` 调用 `install.ps1` 并
  `pause`，避免下载标记（MOTW）+ `RemoteSigned` 导致的“窗口一闪而过”。

### Notes

- 仅打包入口变化；插件与 profile 内容与 0.1.1 相同。
- Release：<https://github.com/voltarenyah/dsh-automation-suite/releases/tag/v0.1.2>

## [0.1.1] - 2026-10-26

### Changed

- 发布版 profile 名带版本号：`dsh-automation-suite-v<version>`，每次发布一个独立目录，
  与开发版 `dsh-automation-suite`、其他发布版并存。
- 安装器拒绝写入 junction/symlink（即使 `-Force`）。
- `-Force` 覆盖真实 profile 前，备份 `package.json` 与 `cordis.patch.yml` 为
  `.bak-<timestamp>`。
- 首次把 `@voltarenyah/dsh-plcsim-advanced` 纳入发行版（7 个插件）。

### Notes

- `--dump-config` 2033 行。
- Release：<https://github.com/voltarenyah/dsh-automation-suite/releases/tag/v0.1.1>

## [0.1.0] - 2026-10-23

### Added

- 首个公开版本：GitHub Release 提供 zip，解压后 `install.ps1` 把 profile 装进
  `~/.dsh/profiles/dsh-automation-suite`，插件以 Release tarball 的**直接 URL 依赖**安装
  （不需要 npm 账号）。
- 6 个插件：TIA Openness V17、工程上下文、工程知识图谱、git、PLC Blocks UI、TIA console UI，
  外加 `dsh-opencode-go`。
- `--dump-config` 1872 行。

### Notes

- Release：<https://github.com/voltarenyah/dsh-automation-suite/releases/tag/v0.1.0>
