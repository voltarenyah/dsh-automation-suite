# Changelog

本文件记录 **dsh-automation-suite 发行版**（distribution）的版本。它和
**插件版本**（`packages/*/package.json`）以及 **DSH 宿主版本**（0.2.1-rc.x）是三套独立的版本号。

格式参考 [Keep a Changelog](https://keepachangelog.com/)；日期为本地日期；版本从
GitHub Releases 与 git tag `v<version>` 对齐（发布流程见 [`docs/releases.md`](docs/releases.md)）。

## [Unreleased]

### Planned

- 桌面壳（WebView2 独立窗口）、安装器、应用层自动更新。设计已定稿、尚未实施：
  [`docs/desktop-packaging.md`](docs/desktop-packaging.md)。

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
