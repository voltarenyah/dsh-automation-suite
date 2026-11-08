# 桌面壳与打包发行方案

> 状态：设计定稿；**Phase 1 壳、Phase 2c DSH/WebView2 自动补齐、profile 安装/合并、
> 安装期 doctor 已实现并在干净 Windows 11 LTSC 2024 VM 上验收通过**（2026-11-08）。
> VM 分别覆盖“无 DSH（WebView2 存在）”与“无 WebView2（DSH 已装）”：安装器分别补齐
> DSH/WebView2、复制 profile、跑 doctor（8 OK / 4 WARN / 0 FAIL）、壳 smoke 通过、卸载干净。
> 仍缺：DSH 最低/参考版本策略、Windows 10 单独验收。
>
> 适用范围：Windows 10/11 x64。TIA 功能仍要求 TIA Portal V17（Windows-only）。
>
> 前置阅读：[`distribution.md`](distribution.md)（当前的 zip + `install.cmd` / `start.cmd`
> 发行方式）。本文描述的是它的下一阶段：桌面壳、安装器、自动更新。

---

## 1. 目标与非目标

### 1.1 目标

1. 安装后出现**桌面图标/开始菜单项**，双击直接打开，不出现命令行窗口。
2. 独立应用窗口（WebView2），带托盘、单实例、日志与退出清理。
3. **半独立安装**：优先使用本机已安装的 DeepSeek Harness；缺失时由安装器在安装阶段
   从 **DeepSeek 官方源**联网下载并安装。**不随包分发 DSH 运行时**。
4. 应用层（壳、插件、profile、UI）支持**自动更新**；DSH 运行时由官方更新器维护。
5. **不购买代码签名证书**：接受 SmartScreen “未知发布者”提示，并在文档中给出操作说明。
6. 每次迭代的打包成本保持在分钟级；不因“重打完整安装包”拖慢开发。

### 1.2 非目标

- 不把 DSH 运行时、Electron、Node、pnpm 打进我们的安装包（许可证未确认 + 体积 + 版本耦合）。
- 不做 MSIX / Microsoft Store（未签名无法干净侧载）。
- 不做 macOS/Linux 桌面壳（TIA 功能本来就是 Windows-only；其他平台继续用 CLI/zip）。
- 不接管 DSH 自身的更新；不修改 DSH 的 `desktop` profile。
- 不承诺离线首次安装（DSH 缺失时需要联网下载约 276 MB）。

---

## 2. 已确认的决策

| # | 决策 | 结论 |
|---|---|---|
| P1 | DSH 运行时分发 | **不随包**。用户预装优先；缺失时安装器联网下载。 |
| P2 | DSH 下载源 | DeepSeek 官方 feed：`https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`；安装包 URL、sha512、size 均来自该清单。 |
| P3 | 静默安装 | 先尝试官方安装器 `/S`；失败或未被接受时回退到官方交互安装器。 |
| P4 | 版本下限 | DSH **≥ 0.2.1-rc.1**。 |
| P5 | 版本上限 | 以 **0.2.1-rc.2** 为已验证参考；**0.2.2-rc.1 已出现在官方 feed**（2026-11-07），更高版本**只警告、不阻止**。 |
| P6 | 已装但过低 | **提示“先升级 DSH”**，不自动覆盖用户安装。 |
| P7 | UI 形态 | **WebView2 + 独立窗口 + 托盘**；不使用系统浏览器标签页。 |
| P8 | 自动更新 | 应用层自动更新（壳/插件/profile）；壳自身升级走安装器；DSH 走官方更新器。 |
| P9 | 代码签名 | **不买证书**。安装器与更新包未签名；接受 SmartScreen/杀软提示。 |
| P10 | 目标平台 | Windows 10/11 x64；WebView2 Evergreen。 |
| P11 | 桌面版 profile | **固定 profile 名 `dsh-automation-suite`**（不随版本号变）。安装器升级前备份旧 `cordis.patch.yml`，把用户覆盖项合并进新蓝图；合并冲突保留备份并提示，不静默丢弃。Web 版的版本化 profile 策略不变。 |

---

## 3. 现状与约束

### 3.1 当前发行方式（v0.1.x）

- Release 提供 `dsh-automation-suite-<version>.zip`，解压后 `install.cmd` 安装，
  `start.cmd` 启动。
- profile 安装在专用 home：`%USERPROFILE%\dsh-automation-suite-home`，
  profile 名为 `dsh-automation-suite-v<version>`。
- `start.cmd` 读取 `install.json`、设置 `DSH_HOME`、从 3093 起找空闲端口、
  启动 `dsh` 并打开浏览器。
- 没有桌面图标、开始菜单项、卸载器、独立窗口；关闭控制台窗口等于停止服务。

### 3.2 DSH 运行时布局（本机实测，0.2.1-rc.2）

```
%LOCALAPPDATA%\Programs\DeepSeek Harness\
  DeepSeek Harness.exe                         # Electron 可执行文件
  Uninstall DeepSeek Harness.exe
  resources\
    app.asar\                                  # @deepseek-ai/dsh-desktop 0.2.1-rc.2
    app.asar.unpacked\
    runtime\cli\bin\dsh.cmd                    # CLI 包装器
    runtime\primary-runtime\dependencies\pnpm\
    app-update.yml
```

- `dsh.cmd` 通过 `ELECTRON_RUN_AS_NODE=1` 把同一个 exe 当 Node 用，入口是
  `resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`。
- 启动 Web 后打印一行：`dsh web: http://127.0.0.1:<port>/?token=<token>`。
- 版本可从 `resources\app.asar\package.json` 读取（`@deepseek-ai/dsh-desktop`），
  也可以执行 CLI 的 `--version`。

### 3.3 官方下载源（本机实测）

`app-update.yml`：

```yaml
provider: generic
url: https://download.deepseek.com/dsh-desk/feeds/win-x64/
channel: nightly
publisherName:
  - CN=Hangzhou DeepSeek Artificial Intelligence Co., Ltd., ...
```

`nightly.yml`（2026-11-07 实测）：

```yaml
version: 0.2.2-rc.1
files:
  - url: https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.1-win-x64.exe
    sha512: swcK0J6ofGka...（以清单为准）
    size: 293425336
releaseDate: '...'
```

> 只有 `nightly.yml` 是这个清单；`latest.yml` 在该域名上返回的是下载站 HTML，不能当成
> electron-updater 清单使用。实现时必须校验内容类型/必填字段，不能盲目解析。

### 3.4 为什么不分发运行时

- `@deepseek-ai/dsh-desktop` 的 `package.json` 声明 MIT，但运行时包
  `@deepseek-ai/dsh-desktop-runtime` **没有 license 字段**，`app.asar` 里也没有 LICENSE
  文件；分发条款未确认。
- 运行时约 276 MB，每版重新打包/上传会显著拖慢迭代。
- 运行时与 DSH 版本强耦合；把它固定在我们的包里，等于把官方更新器绕开。

结论：**只引用官方安装包，不复制、不转存、不随包分发**。

### 3.5 为什么是 WebView2

- Windows 10/11 的 Evergreen WebView2 通常已随 Edge 安装；缺失时可用约 2 MB 的
  Evergreen Bootstrapper 安装。
- 不打包 Chromium；壳可以用 .NET 10 自包含单文件，体积远小于 Electron。
- 目标平台本来就是 Windows-only（TIA），不需要跨平台壳。

---

## 4. 产物与安装布局

### 4.1 发布产物

| 产物 | 内容 | 估算大小 | 更新频率 |
|---|---|---|---|
| `dsh-automation-suite-setup-<ver>.exe` | Inno Setup 安装器：壳 + 应用层 + 安装逻辑（**不含 DSH 运行时**） | 约 120–170 MB | 壳/安装器变化时 |
| `dsh-automation-suite-app-<ver>.zip` | 物化 profile（含 node_modules）、doctor、`manifest.json`（壳除外） | 约 50–70 MB（解压后约 103 MiB） | 每次应用层迭代 |
| `manifest.json` / `SHA256SUMS` | 版本、依赖、sha256（无自动更新，仍用于校验） | < 10 KB | 每次发布 |
| DSH 运行时 | 官方 feed 的安装包 | 约 293 MB（2026-11-07 实测 0.2.2-rc.1） | 安装时按需下载 |

> 自包含 .NET 10 的壳实测约 **111 MiB**（WinForms + WebView2 + 运行时）；如果改为依赖系统
> .NET Desktop Runtime，可把壳降到约 5–15 MB，但需要额外的运行时检测/引导。**第一版建议自包含**，
> 减少环境变量。壳 + app layer 未压缩约 214 MiB，Inno 压缩后预计 120–170 MB。

### 4.2 安装目录

```
%LOCALAPPDATA%\dsh-automation-suite\
  app\
    <version>\
      shell\                 DshSuite.exe（自包含）、WebView2Loader.dll、图标
      profile\               package.json / cordis.patch.yml / node_modules\（真实文件）
      doctor.ps1
      manifest.json          doctor 契约（testedDshVersion 等）
      app-manifest.json      构建来源（commit、包版本、大小）
    <previous>\              保留一版用于回滚
  current.txt                当前 app 版本目录名
  install.json               dshHome / profile / dshExe / 安装时版本
  logs\                      shell 与 CLI 日志（轮转）
  updates\                   下载中的更新包与解压暂存
  uninstall.exe
```

`app\<version>\profile` 是**已经物化好的 profile**：安装器把它复制到
`%DSH_HOME%\profiles\dsh-automation-suite\`，不运行 pnpm、不访问 npm registry。应用层目录按版本分，
profile 名固定；升级时备份并合并 `cordis.patch.yml` 的用户覆盖项。

用户数据仍放在独立 DSH_HOME。桌面版用**固定 profile 名**，应用层目录才按版本分：

```
%USERPROFILE%\dsh-automation-suite-home\
  profiles\dsh-automation-suite\        (固定；升级时合并用户覆盖项)
  storages\workspace.json
  sessions\
  .credentials.yaml
```

**升级不覆盖 DSH_HOME**；卸载时默认保留用户数据，并提供“同时删除”勾选项。

### 4.3 快捷方式与注册表

- 桌面：`DSH Automation Suite.lnk`（可勾选）。
- 开始菜单：`DeepSeek Harness\DSH Automation Suite.lnk`。
- 卸载项：`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DshAutomationSuite`
  （DisplayName、DisplayVersion、DisplayIcon、UninstallString、Publisher、NoModify/NoRepair）。
- 全部按当前用户安装，不需要管理员权限。

---

## 5. 安装器流程

### 5.1 状态机

```
启动
 ├─ 检查 OS/架构（Windows x64）
 ├─ 检查 WebView2（缺失 → 下载 Evergreen Bootstrapper → 静默安装）
 ├─ 检测 DSH
 │   ├─ 已安装且 ≥ 0.2.1-rc.1
 │   │   ├─ ≤ 0.2.1-rc.2 → 直接使用
 │   │   └─ > 0.2.1-rc.2 → 警告“未验证”，继续（当前 feed 0.2.2-rc.1）
 │   ├─ 已安装但 < 0.2.1-rc.1 → 提示先升级；提供“下载官方新版”或退出（不覆盖）
 │   └─ 未安装 → 询问后下载 nightly.yml → 校验 → /S 安装 → 失败回退交互 → 复核
 ├─ 解压应用层到 app\<version>，写 current.txt / install.json
 ├─ 复制 app\<version>\profile → <DSH_HOME>\profiles\dsh-automation-suite\
 │   ├─ 已存在：备份旧 package.json / cordis.patch.yml，跑 merge-profile.mjs 合并用户覆盖项
 │   └─ 不存在：直接复制
 ├─ 跑 doctor.ps1 -Json；summary.fail > 0 则保留旧版并报错
 ├─ 创建快捷方式、注册卸载项
 └─ 可选：立即启动壳
```

`scripts/probe-dsh-runtime.ps1` 是这套状态机的 dry-run 原型：检测 DSH/WebView2/.NET 4.8、
解析官方 `nightly.yml`（含 `url: >-` 折行），但不下载、不安装。

### 5.2 DSH 检测

按以下顺序解析安装位置与版本：

1. `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\*` 中含
   `DeepSeek Harness` 的 DisplayName/InstallLocation；
2. 默认路径 `%LOCALAPPDATA%\Programs\DeepSeek Harness`；
3. 环境变量 `DSH_APP_ROOT` / `DSH_EXE`（开发/便携场景）。

版本读取优先用 CLI 的 `--version`（避免自己解析 asar）；失败时再读
`resources\app.asar\package.json`。版本比较必须支持预发布段（`0.2.1-rc.1`）。

### 5.3 下载与校验

1. `GET https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`，
   `User-Agent: dsh-automation-suite/<ver>`，超时 30 s，失败重试 3 次。
2. 解析 `version`、`files[0].url`、`sha512`、`size`；只接受 `https://download.deepseek.com/`
   下的 URL。
3. 下载到 `%TEMP%\dsh-suite-setup\<version>.exe`，显示进度；支持 HTTP Range 续传（可选）。
4. 校验：
   - 文件大小；
   - SHA-512（base64，与清单一致）；
   - **Authenticode**：发布者必须是 `Hangzhou DeepSeek Artificial Intelligence Co., Ltd.`
     （与 `app-update.yml` 的 publisherName 一致）。校验失败 → 删除并报错。
5. 运行安装器：
   - 先 `/S`（electron-builder NSIS 静默开关；**Phase 2 必须实测确认**）；
   - 若退出码非 0、或等待超时、或未检测到安装结果 → 回退到交互式运行；
   - 用户取消 → 安装器终止并给出“可手动预装 DSH 后重试”的说明。
6. 复核：重新检测路径与版本；仍未满足下限 → 报错并保留日志。

### 5.4 版本策略

| 情况 | 行为 |
|---|---|
| 未安装 | 下载官方 nightly 最新版 → 安装 |
| `< 0.2.1-rc.1` | 阻止继续；提示升级；提供打开官方下载页/自动下载 |
| `0.2.1-rc.1` … `0.2.1-rc.2` | 正常使用 |
| `> 0.2.1-rc.2` | 允许，但首次启动显示“该 DSH 版本尚未验证”的警告（可关闭）；当前 feed 为 0.2.2-rc.1 |

下限/上限写在 `manifest.json`（`minDshVersion` / `testedDshVersion`），升级发行版时更新，
不要硬编码在安装器里。

### 5.5 失败与回滚

- 应用层解压失败：保留旧 `current.txt`，删除半成品目录。
- 快捷方式/注册表失败：记录日志，继续（不阻塞启动）。
- 安装器整体失败：`uninstall.exe` 可清理；用户数据不受影响。
- 所有日志写到 `%LOCALAPPDATA%\dsh-automation-suite\logs\setup-<timestamp>.log`。

---

## 6. 桌面壳设计（WebView2）

### 6.1 技术选型

- C# / .NET 10，WinForms（或 WPF），自包含单文件发布。
- `Microsoft.Web.WebView2` NuGet；Evergreen Runtime。
- 不使用 Electron：避免再打包一份 Chromium。

### 6.2 启动流程

1. 读取 `current.txt` / `install.json`，确定 app 版本、`DSH_HOME`、profile。
2. 找到 DSH CLI：
   `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，
   或 `install.json` 记录的路径。
3. 选空闲端口：从 3093 起 `TcpListener` 探测（与 `start.cmd` 一致）。
4. 启动 CLI。**优先直接调用 exe**，避免 `cmd.exe` 的引号/窗口问题：

   ```
   set ELECTRON_RUN_AS_NODE=1
   "DeepSeek Harness.exe" --expose-internals
     "<...>\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
     --profile <profile> --port <port>
   ```

   环境变量：`DSH_HOME=<home>`；工作目录：app 目录。
   `dsh.cmd` 作为回退（某些 DSH 版本路径不同）。
5. 读取 stdout，正则匹配 `dsh web: (http://127\.0\.0\.1:\d+/\?token=\S+)`；
   超时 60 s。失败时展示 stderr 与日志路径。
6. `CoreWebView2.Navigate(url)`；窗口显示。

### 6.3 生命周期

- **单实例**：命名互斥量；第二次启动通过命名管道把“打开窗口”消息发给已有实例。
- **关闭窗口**：默认最小化到托盘（可配置为直接退出）；托盘菜单：
  打开窗口、在浏览器打开、查看日志、检查更新、退出。
- **退出**：先关闭 stdin，等待 CLI 退出；超时 5 s 后用 Job Object 终止整棵进程树；
  确认 `TiaOpennessV17Min.Controller` 已消失。
- **崩溃**：CLI 意外退出时，窗口显示错误页 + “重启服务/查看日志”，不静默假死。
- **端口占用**：CLI 报 `EADDRINUSE` 时自动换下一个端口重试（最多 10 次）。
- **更新中**：停止 CLI、关闭 WebView2、切换目录、重启壳。

### 6.4 安全

- 只访问 `http://127.0.0.1:<port>`；外部链接交给默认浏览器。
- token 只存在于内存与 URL，不写日志；日志中对 `token=` 做脱敏。
- Release 构建禁用 DevTools 与任意导航。
- CLI 以当前用户运行，不提权。

### 6.5 日志

- 壳日志：`logs\shell-<date>.log`；CLI stdout/stderr：`logs\cli-<date>.log`。
- 轮转 7 天；托盘“查看日志”打开目录。
- 安装/更新日志单独保存，失败时在界面给出路径。

### 6.6 Phase 1 实现（2026-11-07）

- `desktop/DshSuite.Shell`：C# `net10.0-windows`、WinForms、`Microsoft.Web.WebView2 1.0.4314.35`。
- 直接 Electron 启动（`ELECTRON_RUN_AS_NODE=1` + `--expose-internals cli.js`），不使用 `dsh.cmd`；
  Job Object + `Kill(entireProcessTree)` 清理；token 只在内存/URL，日志经 `Log.Redact`。
- 单实例 `Local\DshAutomationSuite`；关窗到托盘；托盘菜单 Open / Doctor / Open logs / Exit；
  Doctor 调用同一份 `doctor.ps1`。
- 首次运行把 `app/profile` 复制到固定 profile；已有 profile 原样复用（升级合并归安装器）。
- `--smoke-test`：隐藏 WebView2 窗口 → 等待 token URL → `NavigationCompleted` → 写
  `smoke-result.json` → 停 DSH → 退出。2026-11-07 实测 **13.8 s**，导航完成，无新增 TIA 控制器。
- 构建：`pwsh -NoProfile -File desktop/build-shell.ps1 -Version 0.2.0 -SmokeTest`。

### 6.7 无边框标题栏（2026-11-08）

目标：让壳的窗口与 DeepSeek Harness 桌面版一致——没有系统白底标题栏和 `Ready` 状态行，
顶部是 40 px、与应用同色的标题条：左侧侧边栏开关、`Application` / `Edit` 菜单，右侧最小化 /
最大化 / 关闭。

窗口层（`MainForm.cs` + `NativeMethods.cs`）：

- `FormBorderStyle.None`，`CreateParams` 加 `WS_THICKFRAME | WS_MINIMIZEBOX |
  WS_MAXIMIZEBOX | WS_SYSMENU`，并用 `WM_NCCALCSIZE` 把客户区设为整个窗口（最大化时设为
  监视器工作区）。否则 Windows 会在标题条上方留出约 8 px 的尺寸边框，按帧颜色绘制——
  深色主题下就是一条黑边。客户区铺满后，网页标题条从窗口最上沿开始。
- 边框消失后原生拖边缩放没有命中区域，改由 `TitleBarScript.js` 在左/右/下边缘做 4 px
  命中检测，通过 WebMessage 让宿主 `ReleaseCapture()` + `WM_NCLBUTTONDOWN(HTLEFT/…)`
  进入系统缩放循环；顶部的 40 px 标题条仍然只负责拖动/双击最大化。
- `DwmExtendFrameIntoClientArea(1,1,1,1)` 保留阴影和圆角；
  `DWMWA_WINDOW_CORNER_PREFERENCE = ROUND`；
  用 `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` 关掉 DWM 那 1 px 边框，
  避免它在网页内容边缘再画一条线。
- 页面把当前主题（`data-ds-dark-theme`）发给宿主，宿主据此设置
  `DWMWA_USE_IMMERSIVE_DARK_MODE`；浅色主题**不能**用系统 `prefers-color-scheme`
  兜底（系统深色 + 应用浅色会把帧刷成黑色），以 `data-ds-dark-theme` 为准。
- 初始尺寸改为工作区的 90% 并居中（高 DPI 下旧的 1440×900 物理像素只有约 740 CSS px 宽，
  DSH 布局会自动收起侧边栏）。
- 旧的 30 px 状态行删除；启动期改为覆盖整个客户区的深色加载层，`NavigationCompleted` 后隐藏，
  启动失败时保留并把错误写在该层上。

网页层（`TitleBarScript.js`，作为嵌入资源注入）：

- 用 `AddScriptToExecuteOnDocumentCreatedAsync` 在页面脚本之前注入；设置
  `<html data-windows-titlebar>` 和 `--dsh-windows-titlebar-height: 40px`。DSH Web 客户端
  原生支持这套标记：标题条底色、内容区左上圆角、侧边栏开关上移到标题条、菜单起点
  `--dsh-windows-menu-start`（展开 48 px / 收起 84 px）都由它自己的 CSS 完成。
- 宿主打开 `CoreWebView2Settings.IsNonClientRegionSupportEnabled`，让 DSH 标题条上的
  `-webkit-app-region: drag` 生效：拖动标题条移动窗口、双击最大化/还原、右键系统菜单都由
  WebView2 处理（与官方 Electron 版行为一致）。
- 在页面里渲染 `Application` / `Edit` 菜单（未展开侧边栏时随 DSH 的 CSS 变量右移）、
  右侧 46×40 的三个窗口按钮；颜色全部用 DSH 主题 token，浅/深色自动跟随。
- `Application`：关于 / 打开日志 / 运行诊断 / 退出；`Edit`：撤销、重做、剪切、复制、粘贴、
  全选。编辑命令在页面内用 `document.execCommand`，粘贴经 WebMessage 向宿主取剪贴板文本
  （`Clipboard.GetText`）后 `insertText`，保留撤销栈。
- 窗口按钮点击 → `postMessage` → 宿主执行最小化/最大化/关闭（关闭仍按既有约定收进托盘）；
  宿主在激活、尺寸变化时把 `{maximized, active}` 发回页面，按钮图标随之切换。
- 菜单按钮通过 `pointerdown` 阻止默认行为以保持编辑框焦点；菜单打开时记住编辑框与选区，
  关闭/执行命令前恢复。

验收（手工，2026-11-08 已做）：

1. 发布后启动，确认没有系统标题栏、没有 `Ready` 行；标题条与侧边栏同色、内容区左上圆角；浅/深色下标题条上沿都直达窗口边缘，没有黑边。
2. 拖标题条移动窗口；双击标题条最大化/还原；拖窗口边缘缩放。
3. `Application` / `Edit` 菜单可打开；`Edit → 复制/粘贴` 与系统剪贴板互通。
4. 关闭按钮 → 窗口隐藏、进程仍在托盘；`Application → Exit` → 进程与 DSH 子进程退出。
5. 切深/浅色主题，标题条、按钮、DWM 边框颜色跟随。

已知限制：窗口按钮是网页自绘的，Windows 11 的贴靠布局浮出（悬停最大化按钮）不会出现；
标题条拖动、双击最大化、贴靠拖动仍可用。

---

## 7. 自动更新（本轮不做，保留为未来设计）

> 本轮范围明确**不做自动更新**：升级 = 用户手动下载新版 setup 覆盖安装；安装器负责停旧版、
> 物化新 app layer、合并固定 profile 覆盖项、跑 doctor、切换 `current.txt`，并保留上一版回滚。
> 以下 §7.1–7.4 保留为未来设计，不进入第一版。

### 7.1 更新对象

| 对象 | 更新方式 |
|---|---|
| 应用层（插件/profile/UI/清单） | 自动更新（本文） |
| 壳（exe） | 通过新版 setup 安装（或后续做壳自更新） |
| DSH 运行时 | 官方 electron-updater；壳只做版本检测与提示 |

### 7.2 清单

`latest.json`（GitHub Release 资产）：

```json
{
  "version": "0.2.0",
  "app": {
    "url": "https://github.com/.../releases/download/v0.2.0/dsh-automation-suite-app-0.2.0.zip",
    "sha256": "...",
    "size": 23456789
  },
  "minShellVersion": "0.1.0",
  "testedDshVersion": "0.2.1-rc.2",
  "notes": "..."
}
```

### 7.3 流程

1. 启动后延迟检查（每天一次 / 手动）。
2. `minShellVersion` 高于当前壳 → 提示下载 setup，不做增量更新。
3. 下载 app zip → 校验 sha256 → 解压到 `app\<new>`。
4. **备份并合并 profile 覆盖项**（固定 profile `dsh-automation-suite`）：
   - 先把旧 `package.json` / `cordis.patch.yml` 备份为 `.bak-<timestamp>`；
   - 用旧 patch 里**用户自己加的 id 条目**覆盖新蓝图中的同名条目（例如 `requestTimeoutMs`、
     `modelVisibility`、`provider`）；蓝图新增的行保留；
   - 无法安全合并的条目（结构冲突、目标行已不存在）**保留备份并在 doctor 里报告**，
     不静默丢弃、也不阻塞启动。
5. 停止 CLI → 切换 `current.txt`（写临时文件后原子替换）→ 重启壳。
6. 健康检查（窗口加载 + CLI 心跳 + doctor）；失败则切回上一版并提示。
7. 保留上一版目录；清理更早版本。

### 7.4 无签名更新

- 更新包是 zip，不触发 SmartScreen 的 exe 拦截；解压后对 `shell\*.exe/dll` 执行
  `Unblock-File`，减少 MOTW 影响。
- 壳自身升级（setup）未签名，用户会看到“未知发布者”；文档给出“更多信息 → 仍要运行”。
- 不排除个别杀软误报；提供 SHA-256 与手动下载兜底。

---

## 8. 打包与构建流水线

### 8.1 开发模式（内循环）

```powershell
node scripts/build-app-layer.mjs --version 0.2.0
pwsh -NoProfile -File desktop/build-shell.ps1 -Version 0.2.0 -SmokeTest
dist\desktop\0.2.0\app\shell\DshSuite.Shell.exe --dsh-home C:\temp\dsh-shell-dev
```

- 壳直接指向**已安装的 DSH**（不打包运行时），首次运行复制 app profile。
- 壳约 30–60 秒构建；插件 `pnpm -r build` 1–2 分钟；app layer 物化约 10 秒（缓存 npm 时）。

### 8.2 应用层打包（已实现）

```powershell
node scripts/build-app-layer.mjs --version 0.2.0
# 或复用已有 release：--skip-pack；跳过运行时自检：--no-verify
```

它做这些事：

1. 用 `scripts/build-distribution.mjs` 打包当前工作树（图谱引擎是 .NET 10 self-contained 单文件）；
2. 建 staging profile，把 tarball 写成 `file:` 依赖，跑
   `pnpm install --prod --node-linker=hoisted`，**物化 node_modules**；
3. 删除 tarball/lockfile，把依赖改回版本号，复制成
   `dist/desktop/<ver>/app/profile`；
4. 递归检查 `node_modules` 无 symlink/junction，`@deepseek-ai` 下只允许
   `cosmokit` / `dsh-brand` / `schemastery` 三个工具包（其余是宿主运行时，D19）；
5. 跑图谱引擎 `--self-test`；
6. 把 app layer 复制到临时 `DSH_HOME/profiles/dsh-automation-suite`，**不跑 pnpm**，
   跑 `dsh --dump-config`、逐 bundle 行检查与 `doctor.ps1 -Json`，要求
   `summary.fail = 0`；
7. 写出 `manifest.json`（doctor 契约）与 `app-manifest.json`（commit、包版本、大小）。

当前基线：**15 个依赖、app layer 约 103 MiB、`--dump-config` 2149 行**（2026-11-07，
DSH 0.2.1-rc.2）。安装器只需把 `app/profile` 复制到固定 profile，不需要 pnpm。

安装器打包（Phase 2）再把 app layer + 壳产物交给 Inno Setup，生成
`dsh-automation-suite-setup-<ver>.exe`、`app.zip`、`manifest.json`、`SHA256SUMS`。

### 8.3 安装器打包（Phase 2 骨架已实现）

```powershell
pwsh -NoProfile -File desktop/build-installer.ps1 -Version 0.2.0
```

- Inno Setup（per-user，无需管理员），脚本 `desktop/installer/dsh-automation-suite.iss`。
- 安装布局：`%LOCALAPPDATA%\dsh-automation-suite\shell`（稳定）+ `app\<ver>`（版本化）+
  `current.txt`（壳按它找 app layer）。
- 内容：壳自包含产物 + 物化 profile（含 `node_modules`）+ doctor + manifest + `unins000.exe`。
- 安装后运行 `installer\install-profile.ps1`：复制固定 profile；已有 profile 先备份，再把旧
  `cordis.patch.yml` 与新基线做三方合并（`merge-profile.mjs`）；写 `install.json`；跑
  `doctor.ps1 -Json`，`summary.fail > 0` 恢复旧 profile 并阻止启动。
- 沙箱实测（`/VERYSILENT /NOICONS /DIR=C:\temp\...` + 临时 `DSH_HOME`）：profile 复制、
  doctor 11 OK / 1 WARN / 0 FAIL、`install.json`/`current.txt` 写入；安装后的壳读取
  `install.json` 并通过隐藏 smoke；卸载后目录清空。
- 模拟升级（旧 app layer 0.1.9 + 用户把模型改成 `deepseek-v4-pro`）：合并后覆盖项保留，
  旧 profile 备份为 `dsh-automation-suite.bak-<stamp>`。
- `bootstrap-dsh.ps1`：DSH 缺失时从官方 feed 下载，校验 SHA-512 + Authenticode
  （DeepSeek），静默安装并等待 `dsh.cmd`；已存在则 no-op。`install-dsh.json` 记录版本/URL/hash。
  真实下载 + 校验路径已用 `-VerifyOnly` 实测；沙箱内用预取安装包完成无 DSH 安装
  （profile/doctor/current 全部生成）。
- 干净 VM 验收（2026-11-08，Windows 11 Enterprise LTSC 2024）：两次运行分别覆盖
  “无 DSH（WebView2 存在）”与“无 WebView2（DSH 已装）”。DSH 下载/安装 0.2.2-rc.1、
  WebView2 bootstrapper 安装 157.0.4341.42、profile/doctor（8 OK / 4 WARN / 0 FAIL）/
  `install.json`/`current.txt` 生成；壳 `--smoke-test` 通过（`ok=true`, `navigation=completed`）；
  卸载后安装目录清空、DSH_HOME 保留。
- **仍缺**：DSH 最低/参考版本策略；Windows 10 未单独验收；仍不包含 DSH 运行时、无自动更新。

### 8.4 CI（建议）

- GitHub Actions `windows-latest`：构建插件 → 打包应用层 → 构建壳 → Inno → 上传
  Release 资产。
- 缓存：pnpm store、NuGet、DSH 运行时（仅用于集成测试的机器，不进产物）。
- 每次发布产出：`setup.exe`、`app.zip`、`latest.json`、`manifest.json`、`SHA256SUMS`。

### 8.5 每版成本（目标）

| 改动 | 操作 | 时间 |
|---|---|---|
| 只改壳 | 编译 + 本地运行 | 30–60 秒 |
| 插件/政策/UI | 构建 + app zip | 1–3 分钟 |
| 发版 | 上传 20–40 MB + setup | 1–3 分钟 |
| DSH 升级 | 不重打包；只做兼容回归 | 数小时（测试） |
| 首次安装 | 无 DSH 时下载 276 MB | 取决于网络 |

---

## 9. 版本与兼容

- **发行版版本**（0.1.x）≠ 插件版本（0.1.0）≠ DSH 版本（0.2.1-rc.x）。
- `manifest.json` 记录：
  - `minDshVersion`：0.2.1-rc.1
  - `testedDshVersion`：0.2.1-rc.2（每次升级 DSH 后更新；2026-11-07 feed 已是 0.2.2-rc.1，
  安装器应警告而不是阻止）
  - 插件版本、profile patch 的哈希。
- DSH 升级后必须回归：
  - `--dump-config` 行数与 preset 注册；
  - TIA 控制器启动；
  - 三个 preset 的工具面；
  - 内置 preset 仍被禁用；
  - 自动更新与壳启动。
- DSH 被官方自动更新到更高版本时，壳显示“未验证版本”横幅，不阻止使用。

---

## 10. 安全与合规

- **不分发 DSH 运行时**；安装时从官方 HTTPS feed 下载，校验 SHA-512 与 Authenticode
  发布者。
- 官方安装器由 DeepSeek 签名；我们的安装器/壳未签名，用户需接受 SmartScreen 提示。
- 发布页提供 SHA-256；文档说明如何核对。
- token 只在 localhost 使用；不写日志、不外发。
- 不读取/上传用户凭据、工程文件；日志默认脱敏。
- 卸载默认保留 `dsh-automation-suite-home`，删除前二次确认。

---

## 11. 失败模式与处理

| 场景 | 检测 | 处理 |
|---|---|---|
| 无网络 | 下载/清单请求失败 | 提示手动预装 DSH；给出官方下载页；退出 |
| feed 不可用/格式变化 | 清单缺字段、非 YAML | 提示手动下载；记录 URL 与响应；不静默失败 |
| SHA-512/Authenticode 不匹配 | 校验失败 | 删除临时文件；拒绝运行；提示可能被篡改/网络劫持 |
| `/S` 不支持或失败 | 退出码/超时/未检测到安装 | 回退交互式安装；仍失败则终止并给日志 |
| 用户取消 DSH 安装 | 安装器退出码 | 终止；数据不变；说明可预装后重试 |
| DSH 版本过低 | 版本比较 | 阻止；提示升级；不覆盖 |
| DSH 版本过高 | 版本比较 | 警告；允许 |
| 端口全被占用 | 逐端口探测 | 报错并给出占用进程提示 |
| CLI 启动失败 | 60 s 无 token | 显示 stderr/日志；重启/换端口 |
| WebView2 缺失 | 运行时检测 | 安装 Evergreen Bootstrapper；失败则提示手动安装 |
| 更新中断/目录被锁 | 解压/切换失败 | 保留旧版；下次重试；必要时重启后应用 |
| profile 覆盖项合并冲突 | 按 id 合并失败 | 保留 `.bak-<timestamp>`，doctor 报告未合并项；旧版仍可回退 |
| 杀软隔离壳/更新 | 启动失败/文件消失 | 文档说明白名单；提供 SHA-256 与手动包 |
| TIA 控制器残留 | 退出后进程检查 | Job Object 杀进程树；记录并提示 |

---

## 12. 阶段与工作量

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| Phase 0（已完成） | zip + `install.cmd` / `start.cmd` + 专用 home | — | v0.1.x 可用 |
| **Prep（已完成 2026-11-07）** | app layer 物化、doctor JSON 契约、profile 三方合并、DSH 启动/清理探针、runtime bootstrap 探针 | 1–2 天 | `build-app-layer.mjs` 离线 `--dump-config` + doctor 通过 |
| Phase 1（已完成 2026-11-07） | WebView2 壳：窗口、托盘、单实例、启动/停止、日志、隐藏 smoke | — | 双击图标出窗口；退出无残留 |
| Phase 2a（已完成 2026-11-07） | Inno 安装器骨架：稳定 shell + 版本化 app layer + `current.txt` + 快捷方式/卸载 | — | 沙箱安装/卸载 + 安装后 smoke 通过 |
| Phase 2b（部分完成 2026-11-07） | 固定 profile 安装/备份/三方合并 + 安装期 doctor + `install.json` | — | 沙箱安装、模拟 0.1.9→0.2.0 升级通过 |
| Phase 2c（已完成 2026-11-08） | DSH 检测/下载/校验/静默安装 + WebView2 bootstrapper | — | 干净 Win11 LTSC VM：无 DSH/无 WebView2 → 全部补齐，doctor/壳 smoke 通过 |
| Phase 2d | DSH 版本策略、Windows 10、离线、升级回滚全流程 | 1–2 天 | 新机全流程通过验收清单 |
| **Phase 3** | 应用层打包已完成；本轮只做 **setup 覆盖式升级 + 回滚**，不做自动更新 | 2–3 天 | 升级保留 DSH_HOME 与用户覆盖项；失败可回退 |
| **Phase 4** | 无签名兼容、首次引导、日志、异常恢复、文档 | 3–5 天 | 新机全流程通过验收清单 |

总计约 **2–3 周**（一人，自动更新已从范围移除）。建议按阶段交付，每阶段保持“开发模式不打包运行时”的快循环。

---

## 13. 验收清单

**干净测试环境：Windows Sandbox（默认）**

本机没有 Windows VM 时，用 Windows Pro 自带的 **Windows Sandbox** 做干净安装测试：

```powershell
# 管理员 + 重启一次
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
# 之后：
pwsh -NoProfile -File desktop/sandbox/start-sandbox.ps1 -AppVersion 0.2.0
pwsh -NoProfile -File desktop/sandbox/start-sandbox.ps1 -Offline   # 断网失败路径
```

它把 `dist/` 只读映射到沙箱的 `C:\dist`，把 `%USERPROFILE%\dsh-sandbox-output`
读写映射到 `C:\out`，关闭即销毁，适合反复做“干净安装/升级/卸载”。**不适用**于验证
WebView2 缺失（沙箱自带 Edge/WebView2）和 TIA/PLCSIM（商业软件，仍在本机测）。
详见 [`desktop/sandbox/README.md`](../desktop/sandbox/README.md)。

**打包前置件（已完成 2026-11-07）**
- [x] app layer 无 symlink/junction，无宿主 `@deepseek-ai` 运行时（仅 3 个工具包）。
- [x] app layer 在**不跑 pnpm** 的临时 `DSH_HOME` 里 `--dump-config` 通过（15 个 bundle 行）。
- [x] `doctor.ps1 -Json` 纯 JSON，schema v1，`summary.fail = 0`。
- [x] 固定 profile 三方合并测试通过（含真实 suite patch）。
- [x] DSH 启动探针拿到 token URL，taskkill 进程树后无新增 TIA 控制器。
- [x] runtime bootstrap 探针能检测 DSH/WebView2/.NET 4.8 并解析官方 feed。

**Phase 1/2a（已完成 2026-11-07）**
- [x] 壳隐藏 smoke：13–19 s 拿到 token URL、WebView2 `NavigationCompleted`、退出无新增 TIA 控制器。
- [x] 安装器沙箱安装：`current.txt` 写入、`app\0.2.0` 与稳定 `shell` 就位。
- [x] 安装后的壳能按 `current.txt` 解析 app layer 并通过 smoke。
- [x] 卸载器清空安装目录（含 `current.txt`），DSH_HOME 不受影响。

**Phase 2b（已完成 2026-11-07）**
- [x] 安装期复制固定 profile、写 `install.json`、跑 `doctor.ps1 -Json`（11 OK / 1 WARN / 0 FAIL）。
- [x] 模拟 0.1.9→0.2.0 升级：用户 `deepseek-v4-pro` 覆盖项保留，旧 profile 备份为 `.bak-<stamp>`。
- [x] 安装后的壳读取 `install.json` 的 DSH_HOME/profile，并通过隐藏 smoke。

**Phase 2c（已完成 2026-11-08）**
- [x] 无 DSH 的 Sandbox 跑 setup：bootstrap 安装 0.2.2-rc.1，profile/doctor/`current.txt`/`install.json` 均生成。
- [x] 官方 feed 真实下载 + SHA-512 + Authenticode 校验通过（`bootstrap-dsh.ps1 -VerifyOnly`）。
- [x] DSH 已安装时 bootstrap no-op。
- [x] 干净 Win11 LTSC VM：分别覆盖无 DSH 与无 WebView2；WebView2 bootstrap 安装 157，壳 smoke 通过。
- [x] 干净 VM 卸载：安装目录清空，DSH_HOME 保留。
- [ ] DSH 版本策略、Windows 10 单独验收、离线安装指引。

**安装**
- [ ] 干净 Windows 10/11 x64、未装 DSH、未装 WebView2：安装器自动补齐并完成安装。
- [ ] 已装 DSH（≥ 下限）：跳过下载，直接安装应用层。
- [ ] 已装 DSH 但低于下限：阻止并提示升级，不覆盖。
- [ ] 已装 DSH 高于参考上限：警告后继续。
- [ ] 无网络：明确报错 + 手动预装指引。
- [ ] SHA-512 或 Authenticode 不匹配：拒绝运行。
- [ ] 安装到含空格/中文的路径正常。
- [ ] 桌面/开始菜单快捷方式、卸载项存在。

**壳**
- [ ] 双击图标打开独立窗口，无控制台窗口。
- [ ] 单实例：第二次启动聚焦已有窗口。
- [ ] 关闭窗口 → 托盘；托盘可重新打开。
- [ ] 退出后无 `DeepSeek Harness`、无 `TiaOpennessV17Min.Controller` 残留。
- [ ] CLI 崩溃时显示错误与日志路径，可重启。
- [ ] 端口 3080 被占用时自动换端口。

**更新**
- [ ] 应用层更新只下载 20–40 MB，安装后数据（workspace/凭据）保留。
- [ ] 更新中断或校验失败不影响旧版本。
- [ ] 新版本启动失败可回滚到上一版。
- [ ] `minShellVersion` 触发时引导下载 setup。

**合规/安全**
- [ ] 安装包内不含 DSH 运行时。
- [ ] 下载 URL 仅限官方域名；签名发布者校验通过。
- [ ] 日志不含 token/凭据。

---

## 14. 风险与待验证项

| 项 | 风险 | 验证/缓解 |
|---|---|---|
| 官方 feed 通道 | 只有 `nightly.yml`；未来可能改名/改结构 | 解析失败时回退手动下载；把 URL 做成可配置 |
| 官方安装器 `/S` | 未实测；可能按机器/版本不同 | Phase 2b 在干净 VM 实测；失败回退交互 |
| DSH 运行时更新 | 自动更新到未验证版本 | 启动时版本检测 + 警告横幅；回归清单 |
| 未签名 | SmartScreen/杀软误报 | 发布 SHA-256；文档指引；不做静默提权 |
| node_modules 物化 | pnpm junction 进 zip 会失效 | 已由 `build-app-layer.mjs` 递归检查 ReparsePoint；app layer 约 103 MiB |
| 官方 feed 版本漂移 | 2026-11-07 feed 已是 0.2.2-rc.1，高于 tested 0.2.1-rc.2 | 安装器只警告不阻止；升级发行版前重跑回归 |
| WebView2 企业策略 | 被组策略禁用 | 检测并提示；不绕过 |
| 壳自更新 | 运行中 exe 无法替换 | 第一版用 setup 覆盖；后续再做 stub/版本目录 |
| 安装器语言/权限 | 中文路径、非管理员 | per-user 安装；路径用 Unicode API |

---

## 15. 相关文件

- [`distribution.md`](distribution.md) — 当前 zip + install/start 的发行方式与实测。
- `profile/dsh-automation-suite/` — profile 蓝图（政策层、三个 preset）。
- `scripts/build-distribution.mjs` — Web 发布目录生成器（tarball + profile + doctor）。
- `scripts/build-app-layer.mjs` — **桌面 app layer 物化**：tarball → 真实 node_modules → 离线验收。
- `scripts/dsh-launch.mjs` — 直接 Electron 调用 DSH 的启动契约（避开 `dsh.cmd` 引号问题）。
- `scripts/probe-dsh-web.mjs` — 启动/清理探针：等待 token URL、超时、进程树清理。
- `scripts/merge-profile.mjs` — 固定 profile 三方合并（旧 patch × 旧基线 × 新基线）。
- `scripts/probe-dsh-runtime.ps1` — 安装器 bootstrap 探针：DSH/WebView2/feed。
- `scripts/doctor.ps1` / `scripts/test-doctor-json.ps1` — 能力报告与 JSON 契约测试。
- `desktop/DshSuite.Shell/` — Phase 1 WebView2 壳（WinForms、Job Object、托盘、隐藏 smoke）。
  `TitleBarScript.js`（嵌入资源）负责无边框标题条的菜单/窗口按钮；`NativeMethods.cs` 是 DWM/窗口样式互操作。
- `desktop/build-shell.ps1` — 自包含发布壳到 `app/shell`，可带 `-SmokeTest`。
- 根 `README.md` §6.3 — 使用者视角的当前安装方式。
