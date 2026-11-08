# Changelog

本文件记录 **dsh-automation-suite 发行版**（distribution）的版本。它和
**插件版本**（`packages/*/package.json`）以及 **DSH 宿主版本**（0.2.1-rc.x）是三套独立的版本号。

格式参考 [Keep a Changelog](https://keepachangelog.com/)；日期为本地日期；版本从
GitHub Releases 与 git tag `v<version>` 对齐（发布流程见 [`docs/releases.md`](docs/releases.md)）。

## [Unreleased]

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
- **Phase 2c DSH bootstrap**：DSH 缺失时从官方 feed 下载，校验 SHA-512 + DeepSeek
  Authenticode，静默安装并等待 `dsh.cmd`；已安装则 no-op。沙箱无 DSH 安装（profile/doctor/
  current 全部生成）与真实下载校验通过。WebView2 bootstrapper 已写，但 Sandbox 的
  EdgeWebView 残留会 `0x80040902`，留给干净 VM 验收。

### Planned

- 桌面壳（WebView2 独立窗口）、安装器（固定 profile + 升级时备份并合并用户覆盖项）。
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
