# 桌面壳与打包发行方案

> 状态：**设计定稿，尚未实施**（2026-10-26）。等发行版的基本功能完善后，按 §12 的
> Phase 1–4 执行。
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
| P5 | 版本上限 | 以 **0.2.1-rc.3** 为已验证参考上限；更高版本**只警告、不阻止**。 |
| P6 | 已装但过低 | **提示“先升级 DSH”**，不自动覆盖用户安装。 |
| P7 | UI 形态 | **WebView2 + 独立窗口 + 托盘**；不使用系统浏览器标签页。 |
| P8 | 自动更新 | 应用层自动更新（壳/插件/profile）；壳自身升级走安装器；DSH 走官方更新器。 |
| P9 | 代码签名 | **不买证书**。安装器与更新包未签名；接受 SmartScreen/杀软提示。 |
| P10 | 目标平台 | Windows 10/11 x64；WebView2 Evergreen。 |

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

`nightly.yml`（2026-10-26 实测）：

```yaml
version: 0.2.1-rc.3
files:
  - url: https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.1-rc.3-win-x64.exe
    sha512: q5IGr2Bf+TvvCpagHj49Ypn/ZrqR7kqrYpLjqXP7VfDINmddlqZQmG+YfsdL3q3EdTRMRlKz/a3jDAEzdNdDOw==
    size: 289415960
releaseDate: '2026-10-23T08:02:12.038Z'
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
- 不打包 Chromium；壳可以用 .NET 8 自包含单文件，体积远小于 Electron。
- 目标平台本来就是 Windows-only（TIA），不需要跨平台壳。

---

## 4. 产物与安装布局

### 4.1 发布产物

| 产物 | 内容 | 估算大小 | 更新频率 |
|---|---|---|---|
| `dsh-automation-suite-setup-<ver>.exe` | Inno Setup 安装器：壳 + 应用层 + 安装逻辑（**不含 DSH 运行时**） | 约 50–90 MB | 壳/安装器变化时 |
| `dsh-automation-suite-app-<ver>.zip` | 插件、profile、UI、`manifest.json`（壳除外） | 约 20–40 MB | 每次应用层迭代 |
| `latest.json` | 自动更新清单（版本、URL、sha256、minShell） | < 5 KB | 每次发布 |
| DSH 运行时 | 官方 feed 的安装包 | 约 276 MB | 安装时按需下载 |

> 自包含 .NET 8 的壳约 60–80 MB；如果改为依赖系统 .NET Desktop Runtime，可把 setup
> 降到约 5–15 MB，但需要额外的运行时检测/引导。**第一版建议自包含**，减少环境变量。

### 4.2 安装目录

```
%LOCALAPPDATA%\dsh-automation-suite\
  app\
    <version>\
      shell\                 DshSuite.exe（自包含）、WebView2Loader.dll、图标
      profile\               package.json / cordis.patch.yml / pnpm-workspace.yaml
      plugins\               构建产物（真实文件，不是 pnpm junction）
      manifest.json
    <previous>\              保留一版用于回滚
  current.txt                当前 app 版本目录名
  install.json               dshHome / profile / dshExe / 安装时版本
  logs\                      shell 与 CLI 日志（轮转）
  updates\                   下载中的更新包与解压暂存
  uninstall.exe
```

用户数据仍放在独立 DSH_HOME：

```
%USERPROFILE%\dsh-automation-suite-home\
  profiles\dsh-automation-suite-v<ver>\
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
 │   │   ├─ ≤ 0.2.1-rc.3 → 直接使用
 │   │   └─ > 0.2.1-rc.3 → 警告“未验证”，继续
 │   ├─ 已安装但 < 0.2.1-rc.1 → 提示先升级；提供“下载官方新版”或退出（不覆盖）
 │   └─ 未安装 → 询问后下载 nightly.yml → 校验 → /S 安装 → 失败回退交互 → 复核
 ├─ 解压应用层到 app\<version>，写 current.txt / install.json
 ├─ 创建快捷方式、注册卸载项
 └─ 可选：立即启动壳
```

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
| `0.2.1-rc.1` … `0.2.1-rc.3` | 正常使用 |
| `> 0.2.1-rc.3` | 允许，但首次启动显示“该 DSH 版本尚未验证”的警告（可关闭） |

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

- C# / .NET 8，WinForms（或 WPF），自包含单文件发布。
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

---

## 7. 自动更新

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
  "testedDshVersion": "0.2.1-rc.3",
  "notes": "..."
}
```

### 7.3 流程

1. 启动后延迟检查（每天一次 / 手动）。
2. `minShellVersion` 高于当前壳 → 提示下载 setup，不做增量更新。
3. 下载 app zip → 校验 sha256 → 解压到 `app\<new>`。
4. 停止 CLI → 切换 `current.txt`（写临时文件后原子替换）→ 重启壳。
5. 健康检查（窗口加载 + CLI 心跳）；失败则切回上一版并提示。
6. 保留上一版目录；清理更早版本。

### 7.4 无签名更新

- 更新包是 zip，不触发 SmartScreen 的 exe 拦截；解压后对 `shell\*.exe/dll` 执行
  `Unblock-File`，减少 MOTW 影响。
- 壳自身升级（setup）未签名，用户会看到“未知发布者”；文档给出“更多信息 → 仍要运行”。
- 不排除个别杀软误报；提供 SHA-256 与手动下载兜底。

---

## 8. 打包与构建流水线

### 8.1 开发模式（内循环）

- 壳直接指向**已安装的 DSH**（不打包运行时）。
- `dotnet run` 或本地构建壳；插件用 `pnpm -r build`。
- 迭代成本：壳 30–60 秒；插件 1–2 分钟。

### 8.2 应用层打包

1. 构建六个/七个插件（`pnpm -r build`）。
2. 在 staging profile 里安装插件，**物化 node_modules**：
   - 不能用 pnpm store 的 junction/hardlink 直接压 zip（到用户机器会变成死链接）；
   - 方案 A：`pnpm deploy --prod --node-linker=hoisted`（需实测）；
   - 方案 B：用 tarball 在普通目录 `pnpm install` 后复制真实文件；
   - 验收：递归检查 `node_modules` 下无 ReparsePoint，且 `lib/`、`controller/bin`、
     `engine/bin` 均在。
3. 拷贝 profile 三件套与 `manifest.json`（插件版本、profile 哈希、`minDshVersion`、
   `testedDshVersion`）。
4. 打 `dsh-automation-suite-app-<ver>.zip`。

### 8.3 安装器打包

- Inno Setup（per-user，无需管理员）。
- 内容：壳自包含产物 + 应用层 + `uninstall.exe`。
- 生成 `latest.json` 与 SHA-256 清单。
- 不包含 DSH 运行时。

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
  - `testedDshVersion`：0.2.1-rc.3（每次升级 DSH 后更新）
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
| 杀软隔离壳/更新 | 启动失败/文件消失 | 文档说明白名单；提供 SHA-256 与手动包 |
| TIA 控制器残留 | 退出后进程检查 | Job Object 杀进程树；记录并提示 |

---

## 12. 阶段与工作量

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| Phase 0（已完成） | zip + `install.cmd` / `start.cmd` + 专用 home | — | v0.1.x 可用 |
| **Phase 1** | WebView2 壳（开发模式，指向已装 DSH）：窗口、托盘、单实例、启动/停止、日志 | 5–8 天 | 双击图标出窗口；退出无残留 |
| **Phase 2** | 安装器 + DSH 检测/下载/校验/静默安装 + 版本策略 + 快捷方式/卸载 | 3–5 天 | 无 DSH 机器可一键装好；有 DSH 不重复下载 |
| **Phase 3** | 应用层打包（物化 node_modules）+ 自动更新 + 回滚 | 3–5 天 | 无 DSH 网络时更新只下 20–40 MB；失败可回滚 |
| **Phase 4** | 无签名兼容、首次引导、日志、异常恢复、文档 | 3–5 天 | 新机全流程通过验收清单 |

总计约 **3–4 周**（一人）。建议按阶段交付，每阶段保持“开发模式不打包运行时”的快循环。

---

## 13. 验收清单

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
| 官方安装器 `/S` | 未实测；可能按机器/版本不同 | Phase 2 在干净 VM 实测；失败回退交互 |
| DSH 运行时更新 | 自动更新到未验证版本 | 启动时版本检测 + 警告横幅；回归清单 |
| 未签名 | SmartScreen/杀软误报 | 发布 SHA-256；文档指引；不做静默提权 |
| node_modules 物化 | pnpm junction 进 zip 会失效 | `pnpm deploy`/普通 install 后递归检查 ReparsePoint |
| WebView2 企业策略 | 被组策略禁用 | 检测并提示；不绕过 |
| 壳自更新 | 运行中 exe 无法替换 | 第一版用 setup 覆盖；后续再做 stub/版本目录 |
| 安装器语言/权限 | 中文路径、非管理员 | per-user 安装；路径用 Unicode API |

---

## 15. 相关文件

- [`distribution.md`](distribution.md) — 当前 zip + install/start 的发行方式与实测。
- `profile/dsh-automation-suite/` — profile 蓝图（政策层、三个 preset）。
- `scripts/build-distribution.mjs` — 现有发布目录生成器；Phase 2 在其上增加 app zip / setup。
- 根 `README.md` §6.3 — 使用者视角的当前安装方式。
