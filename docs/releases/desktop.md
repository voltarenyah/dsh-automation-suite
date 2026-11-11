# 桌面安装包发布流程

本文件是 `docs/releases.md` 的桌面版补充。Web zip / 插件 tarball 的流程仍以
`docs/releases.md` 为准；桌面安装包额外有 `setup.exe`、`desktop-manifest.json` 和
sha256 三个资产。

## 1. 每次发版必须重复的工作

| 步骤 | 是否每次都要 | 说明 |
|---|---|---|
| 选择新版本号 | 是 | 不复用；tag `v<version>` |
| 全仓测试/构建 | 是 | `pnpm -r test`、`pnpm -r build`、`pnpm -r typecheck` |
| 物化 app layer | 插件/profile 有改动时 | `build-app-layer.mjs`，约 100 MiB，最慢 |
| 构建自包含壳 | 壳有改动时也必须重打 | `build-shell.ps1`，内含 WebView2 壳 |
| 构建 Inno 安装器 | 每次 | `build-installer.ps1`，把 app layer + shell 包进 setup |
| 安装/卸载 smoke | 每次 | 至少本机静默安装 + shell `--smoke-test` |
| 干净 VM 验收 | 安装器/依赖有改动时 | 无 DSH、无 WebView2；用 `desktop/vm/` |
| 资产/manifest/sha256 | 每次 | 容易漏，建议按本文件命令生成 |
| CHANGELOG + release notes | 每次 | `CHANGELOG.md` + `docs/releases/v<ver>.md` |
| tag/push/GitHub Release | 每次 | 先提交内容，再 tag，再 release |
| 发布台账 | 每次 | 发布后更新 `docs/releases.md` §1 |

## 2. 构建命令

```powershell
$version = '0.2.2'   # 改成新版本

git status --short
pnpm -r build
pnpm -r test
pnpm -r typecheck

# 1) 物化 app layer（插件/profile 有改动时；会重建 app 目录）
node scripts/build-app-layer.mjs --version $version

# 2) 自包含壳 + 隐藏 smoke
pwsh -NoProfile -File desktop/build-shell.ps1 -Version $version -SmokeTest

# 3) Inno 安装器
pwsh -NoProfile -File desktop/build-installer.ps1 -Version $version
```

输出：

```text
dist\desktop\<version>\dsh-automation-suite-setup-<version>.exe
```

如果只改了壳/安装器、没有改插件/profile，可以复用现有 `dist\desktop\<version>\app`，
只跑 `build-shell.ps1` 和 `build-installer.ps1`；但发布物仍要重新做安装 smoke。

## 3. 安装 smoke（每次）

> **先把 setup 复制到工作区外再运行。** 在本仓库的 DSH 会话里，`dist/` 下的文件会被沙箱标成
> Low integrity；从那里直接启动时 Inno 的 SetupLdr 也以 Low IL 运行，创建 `%TEMP%\is-*.tmp`
> 会报 `Setup was unable to create the directory ... Error 5: Access is denied`（0.2.4 / 0.2.5
> 实测，与安装器内容无关）。把同一个 exe 复制到 `C:\temp` 后 exit 0 —— 发布到 GitHub 的资产
> 不带这个标签，用户下载后不受影响。所以 smoke 一律从复制品跑：
>
> ```powershell
> Copy-Item "dist\desktop\$version\dsh-automation-suite-setup-$version.exe" "C:\temp\setup-$version.exe"
> ```
>
> 并且复制品与 `dist/` 原件的 SHA-256 必须一致；`desktop-manifest.json` 记录的是原件的哈希。

```powershell
$setup = "C:\temp\setup-$version.exe"
$dir   = "C:\temp\dsh-release-install-$version"
$home  = "C:\temp\dsh-release-home-$version"

if (Test-Path $dir)  { cmd /c rmdir /s /q $dir }
if (Test-Path $home) { cmd /c rmdir /s /q $home }

$env:DSH_HOME = $home
Start-Process -FilePath $setup `
  -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS',"/DIR=$dir") -Wait
Remove-Item Env:DSH_HOME

Test-Path "$home\profiles\dsh-automation-suite\package.json"   # True
Test-Path "$dir\install.json"                                  # True
Test-Path "$dir\current.txt"                                   # True

# 壳 smoke；GUI/WebView2 需要交互桌面
Start-Process -FilePath "$dir\shell\DshSuite.Shell.exe" -ArgumentList '--smoke-test' -Wait
Get-Content "$home\smoke-result.json" -Raw
```

干净 VM 验收（依赖/安装器有改动时必须做）：见 [`desktop/vm/README.md`](../../desktop/vm/README.md)。

## 4. 资产与 manifest

```powershell
$version = '0.2.2'
$src = "dist\desktop\$version\dsh-automation-suite-setup-$version.exe"
$rel = "dist\release\$version"
New-Item -ItemType Directory -Force -Path $rel | Out-Null
Copy-Item $src "$rel\dsh-automation-suite-setup-$version.exe" -Force

$setup = "$rel\dsh-automation-suite-setup-$version.exe"
$hash  = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
$size  = (Get-Item $setup).Length
"$hash  dsh-automation-suite-setup-$version.exe" |
  Set-Content "$rel\dsh-automation-suite-setup-$version.exe.sha256" -Encoding ascii
```

`desktop-manifest.json` 至少记录：

- `version`
- `sourceCommit`（发布提交，`git rev-parse HEAD`）
- `installer.sha256` / `installer.size`
- `appLayerVersion`
- DSH tested/feed 版本
- WebView2 版本
- 验收摘要（哪台 VM、哪些场景、doctor/shell 结果）

可参考 `dist\release\0.2.1\desktop-manifest.json` 的结构。

## 5. 文档与提交

1. `CHANGELOG.md` 增加 `[<version>] - <date>`；
2. 新建 `docs/releases/v<version>.md`（会被 tag 包含）；
3. 提交所有内容：
   ```powershell
   git status --short
   git add ...
   git commit -m "chore(release): prepare <version> desktop installer"
   ```
4. **先提交，再 tag**：
   ```powershell
   git tag -a v<version> -m "dsh-automation-suite <version>"
   git push origin main v<version>
   ```
5. 创建 Release 并上传：
   ```powershell
   gh release create v<version> --verify-tag --latest `
     --title "dsh-automation-suite <version>" `
     --notes-file docs/releases/v<version>.md `
     "dist\release\<version>\dsh-automation-suite-setup-<version>.exe" `
     "dist\release\<version>\dsh-automation-suite-setup-<version>.exe.sha256" `
     "dist\release\<version>\desktop-manifest.json"
   ```
6. 发布后更新 `docs/releases.md` §1 表格，并提交推送。

## 6. 当前仍是手工、没有一键脚本的部分

- `desktop-manifest.json` 的字段和验收摘要；
- release notes 的“本次变化/已知问题”；
- 干净 VM 的两种缺失场景；
- `CHANGELOG` / 台账同步；
- tag 和 GitHub Release 的发布决策。

构建、壳 smoke、安装器打包已经有脚本；**资产收集、manifest、版本台账**还没有合成一条
`release-desktop.ps1`。如果后续发布频率上来，建议把它做成只生成资产的脚本（不自动 push），
发布决策仍保留人工确认。
