# Changelog

本文件记录 **dsh-automation-suite 发行版**（distribution）的版本。它和
**插件版本**（`packages/*/package.json`）以及 **DSH 宿主版本**（0.2.1-rc.x）是三套独立的版本号。

格式参考 [Keep a Changelog](https://keepachangelog.com/)；日期为本地日期；版本从
GitHub Releases 与 git tag `v<version>` 对齐（发布流程见 [`docs/releases.md`](docs/releases.md)）。

## [0.2.5] - 2026-11-11

修复桌面安装包「Plugins 页无法安装插件」，并更新 PLCSIM 与 TIA 插件；安装流程不变（仍为
per-user setup），但 profile 现在随安装包保留自带的 tarball 与 lockfile。

### Fixed

- **桌面版无法从 Plugins 页安装任何插件**（0.2.0–0.2.5）：两个独立阻塞。(1) app layer 在
  staging 目录里物化后把 pnpm 的 `node_modules/.modules.yaml`（`storeDir` / `virtualStoreDir`
  指向构建机路径）原样复制出去，pnpm 在解析依赖前就报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`
  （换用户名时是 `ERR_PNPM_UNEXPECTED_STORE`）。(2) build 又删掉 `tarballs/` 与 `pnpm-lock.yaml`，
  把 15 个私有插件改写成裸版本号 —— 它们不在任何 registry 上，`pnpm add` 重新解析直接
  `ERR_PNPM_FETCH_404`。现在 app layer 保留 `tarballs/`、`pnpm-lock.yaml` 与 `file:` 规格；安装器
  复制后用 `scripts/normalize-profile-pnpm.mjs` 按本机 pnpm 实际使用的 store 重写
  `.modules.yaml` 与 workspace state（写后校验，失败回滚），Inno 脚本一并携带该脚本；doctor 新增
  插件安装检查，元数据与本机不符时 **fail** 而不是 warn。
- **只在安全程序里改动时无法进入同步闸门**：PLC checksum 只覆盖编译后的标准程序，仅改 F 程序时
  `project_sync` 的 checksum 快路径回 `unchanged`，`project_commit` 报 "Nothing to commit"。现在
  `project_sync` 接受 `force`（传给控制器 `force_scan`，跳过快路径）；快路径被跳过时结果会明确
  标注，`project_status` 用 `checksum-matches` 与 "Safety program: NOT compared" 取代误导性的
  `in-sync`。
- **导出清单丢失被跳过对象**：一次全部跳过的导出不再把 `_manifest.json` 写成空块表，被跳过的
  对象保留原有行并按盘上文件核对；`overwrite=true` 改为写同目录临时文件后 `File.Replace`，
  Openness 拒绝覆盖时原文件保持不变，而不是被替换成失败记录。
- **新会话创建失败（`agent-preset/invalid`）**：DSH `0.2.2-rc.1` 起
  `@deepseek-ai/dsh-tool-subagent-control` 只剩默认导出（`list_agents` 并回默认导出），
  `preset-leader` 里按 0.2.1 写的 `tool-subagent-list-agents`
  （`…/dsh-tool-subagent-control/list-agents`）行导致整个 preset 校验失败，
  点「New Session」报 `agent-preset/invalid: … never started`。已删除该行，
  并把 `tool-subagent` 的 `modelSelectionSettings: true` 换成 0.2.2 的
  `modelSelection: true` + `modelDiscovery: true`。

### Added

- **PLCSIM Advanced 快照按工作区保存**：快照根目录由会话工作区推导
  （`<workspace>/.dsh/simulation/`），并以 `snapshot_root` 随每次请求传给控制器；
  `snapshotRoot` 留空即按工作区，显式赋值仍固定共享目录。`simulation_instance(action="snapshots")`
  与 `simulation_status` 列出工作区快照和 Runtime Manager 里仍活着的实例；存在快照时 `create`
  以 `snapshots_available` 拒绝，除非 `confirm_new=true`，让用户先选「resume 旧快照还是新建」。
  工具说明明确证书规则：新虚拟设备（新 MAC）首次连接需在 TIA Portal UI 点一次 Connect，
  resume/restore 沿用原身份则跳过。结果始终带 `Key facts:` 行（name/state/cpuType/ip/snapshots）。
- **F-CPU 仿真型号**：`cpu_type` 增加 `1511F`…`1518F`，`cpu_model` 接受订货号/型号名
  （A = 标准，F = 故障安全）；`unspecified` 仍可用。PLCSIM Advanced V7 不能把 F 工程数据下到
  标准 CPU 实例（手册 §7.4），V17 Openness 对 F 激活 PLC 一律 `download_unavailable`，因此这一步
  必须由用户在 TIA Portal UI 完成。
- **TIA 接口族多成员路线（D36）**：新增 `docs/tia-version-members.md`，冻结 V17/V18 的共存与替换
  路线：一族多包、插件页 bundle 开关激活、同一时刻只激活一个、切换后重启客户端。本版无代码变化。

### Changed

- 站点统一使用桌面壳的品牌图标作为 favicon 与页头 mark；安装页增加 Releases 下载指引；Git CLI 行
  链接到 Git for Windows 官方下载页；首页文案改为 "Free, Open source, customizable by yourself."。
- 仓库忽略 `.scratch/` 与仓库内的 `.pnpm-store/` 等机器本地产物。

### Verified

- `build-app-layer --version 0.2.5`：15 个 tarball（33.8 MiB）、16 个依赖、离线 `--dump-config`
  2205 行 / 47 个插件行、doctor 11 ok / 2 warn / 0 fail、图谱引擎 self-test OK。
- 壳 `build-shell.ps1 -SmokeTest` 与安装后的 `DshSuite.Shell.exe --smoke-test`：
  `{"ok": true, "navigation": "completed"}`。
- 0.2.5 静默安装（隔离目录与 DSH_HOME）：exit 0，`install.json` / `current.txt` / profile 物化，
  `normalize` 重写 virtual store，doctor 11 ok / 2 warn / 0 fail；0.2.4 → 0.2.5 升级：备份旧
  profile、三方合并、doctor 通过。
- 安装后的 profile 里 `dsh plugin add` 连续两次成功，自带 `file:` 依赖未丢，`--dump-config`
  仍能组合（2207 行 / 48 行，含新增插件）；`scripts/test-plugin-add.mjs` 13 项全通过。

## [0.2.4] - 2026-11-10

桌面壳交互修正与问题反馈入口；插件与 profile 与 0.2.3 相同，安装流程不变。

### Added

- **`Application → 报告问题…`（Report Issues…）**：桌面壳标题栏菜单新增一项，用默认浏览器打开
  <https://github.com/voltarenyah/dsh-automation-suite/issues>，方便用户提交 bug；托盘菜单同时
  增加 `Report issues`。点击会写一条壳日志（`opening the issue tracker: <url>`），取消不了浏览器
  启动时弹框给出可复制地址。

### Fixed

- **桌面壳最大化后任务栏点不动**：无边框窗口（`WS_POPUP` 家族）最大化时按整个显示器取尺寸，
  窗口盖住任务栏，外壳的全屏启发式再把任务栏降级为非置顶，于是任务栏"看得见、点不动"。
  壳现在接管 `WM_GETMINMAXINFO`，把最大化矩形钉到工作区（含副屏换算）；实测最大化后点时钟
  弹快捷设置、点开始弹搜索、任务栏图标可切换应用。

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
