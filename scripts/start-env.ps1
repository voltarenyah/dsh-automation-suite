<#
.SYNOPSIS
  在独立 DSH_HOME 里启动 dsh-automation-suite 发行版，看不懂的路径它自己解析。

.DESCRIPTION
  把"部署 + 安装插件 + 起服务 + 带 token 开浏览器"这套动作收成一条命令，
  并且把工具链路径（dsh / pnpm）从 DSH 安装目录里解析出来 —— 这台机器上
  pnpm 与 dsh 都不在 PATH 上，手敲既长又容易记错。

  环境是**自包含**的：用自己的 $HOME 作为 DSH_HOME，不碰你日常的 ~/.dsh。
  删掉那个目录就等于完全回退。

  要部署哪些插件不写死在这里：脚本读蓝图 profile\<名字>\package.json 的
  dsh.profile.bundles，凡是能在 packages\ 下按包名找到的条目都算本地插件。
  所以新增插件只需在 packages\ 建目录并把包名写进蓝图的 bundles，本脚本无需改动。

.PARAMETER DshHome
  独立 DSH_HOME 的路径。默认 %USERPROFILE%\dsh-suite-env。

.PARAMETER Profile
  profile 名，同时决定用哪个蓝图（profile\<名字>\）。默认 dsh-automation-suite。

.PARAMETER Port
  监听端口。默认 3092；传 0 让系统挑一个空闲端口。

.PARAMETER Mode
  link（默认）：用 link: 把仓库里的插件包链进 profile —— 验的是**当前工作树**，
                 改完 src 重新构建即可生效，不用打包。
  pack          ：pnpm pack 出 tarball 再装 —— 验的是**真实交付物**。

.PARAMETER SkipBuild
  跳过 pnpm -r build。link 模式下构建产物 lib/ 是插件入口，一般不要跳。

.PARAMETER Reset
  先删掉现有的 profile 目录再按蓝图重建（会先请你确认）。

.PARAMETER Restart
  若目标端口上已经跑着一个 DeepSeek Harness 实例，先停掉它再启动 —— 开发循环用这个：
  改完代码直接 `-Restart`。占用者不是 DeepSeek Harness 时**不会**动它，只会报错退出。

.PARAMETER NoOpen
  不自动打开浏览器（默认会打开，并把带 token 的 URL 交给浏览器）。

.EXAMPLE
  pwsh -NoProfile -File scripts\start-env.ps1
.EXAMPLE
  pwsh -NoProfile -File scripts\start-env.ps1 -DshHome C:\temp\suite-env -Port 0
#>
[CmdletBinding()]
param(
  [string]$DshHome = "$env:USERPROFILE\dsh-suite-env",
  [string]$Profile = 'dsh-automation-suite',
  [int]$Port = 3092,
  [ValidateSet('link', 'pack')][string]$Mode = 'link',
  [switch]$SkipBuild,
  [switch]$Reset,
  [switch]$Restart,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'

function Say([string]$t) { Write-Host $t }
function Step([string]$t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t, [string]$hint = '') {
  Write-Host "ERROR: $t" -ForegroundColor Red
  if ($hint) { Write-Host "       $hint" -ForegroundColor Yellow }
  exit 1
}

$repo = Split-Path -Parent $PSScriptRoot
$blueprint = Join-Path $repo "profile\$Profile"
$profileDir = Join-Path $DshHome "profiles\$Profile"
$manifest = Join-Path $profileDir 'package.json'

if (-not (Test-Path $blueprint)) { Fail "找不到蓝图目录: $blueprint" 'profile\<名字> 必须存在；-Profile 决定用哪个蓝图。' }

<#
  蓝图 dsh.profile.bundles 里指向本仓 packages\ 的那些条目，就是要部署的本地插件。

  按 package.json 的 name 匹配，而不是按目录名 —— 带 scope（@scope/name）与不带 scope
  的包于是走同一条逻辑，新增插件只要在 packages\ 下建目录、并把包名写进蓝图的 bundles
  就会被这里自动带上，不需要改本脚本。顺序沿用 bundles 的顺序。
#>
function Get-LocalPlugins([string]$BlueprintDir) {
  $byName = @{}
  foreach ($dir in Get-ChildItem (Join-Path $repo 'packages') -Directory) {
    $candidate = Join-Path $dir.FullName 'package.json'
    if (-not (Test-Path $candidate)) { continue }
    $byName[(Get-Content $candidate -Raw | ConvertFrom-Json).name] = $dir.FullName
  }

  $blueprintPkg = Get-Content (Join-Path $BlueprintDir 'package.json') -Raw | ConvertFrom-Json
  $local = @()
  foreach ($bundle in @($blueprintPkg.dsh.profile.bundles)) {
    if ($byName.ContainsKey($bundle)) { $local += [pscustomobject]@{ Name = $bundle; Dir = $byName[$bundle] } }
  }
  return $local
}

$plugins = @(Get-LocalPlugins $blueprint)
if ($plugins.Count -eq 0) {
  Fail "蓝图 $Profile 的 dsh.profile.bundles 里没有任何一条指向 packages\ 下的插件" '本脚本只部署本仓的插件；官方 bundle 由 dsh 自己解析。'
}

# ----------------------------------------------------------------- 解析工具链
# dsh 与 pnpm 都不在 PATH 上：两者都从 DSH 安装目录解析。
$appRoot = $env:DSH_APP_ROOT
if (-not $appRoot) { $appRoot = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness' }
$dsh = Join-Path $appRoot 'resources\runtime\cli\bin\dsh.cmd'
$pnpmMjs = Join-Path $appRoot 'resources\runtime\pnpm\bin\pnpm.mjs'
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue)?.Source

if (-not (Test-Path $dsh)) { Fail "找不到 dsh CLI: $dsh" '设置 $env:DSH_APP_ROOT 指向 DSH 安装目录。' }
if (-not $nodeExe) { Fail 'PATH 上没有 node' '需要 node 来运行 DSH 自带的 pnpm；装一个 Node.js 或把它的目录加进 PATH。' }
if (-not (Test-Path $pnpmMjs)) { Fail "找不到 DSH 自带的 pnpm: $pnpmMjs" '设置 $env:DSH_APP_ROOT 指向 DSH 安装目录。' }

function Invoke-Pnpm([string[]]$Arguments, [string]$WorkDir) {
  Push-Location $WorkDir
  try { & $nodeExe $pnpmMjs @Arguments } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail "pnpm $($Arguments -join ' ') 失败（退出码 $LASTEXITCODE，工作目录 $WorkDir）" }
}

Say "仓库      : $repo"
Say "DSH 安装  : $appRoot"
Say "DSH_HOME  : $DshHome"
Say "profile   : $Profile   (mode=$Mode, port=$Port)"
Say "本地插件  : $($plugins.Name -join ', ')"
Say ''

# ----------------------------------------------------------------- 构建
if (-not $SkipBuild) {
  Step '构建工作区（pnpm -r build）'
  Invoke-Pnpm @('-r', 'build') $repo
}

# ----------------------------------------------------------------- 部署蓝图
if ($Reset -and (Test-Path $profileDir)) {
  Say "将要删除: $profileDir"
  $answer = Read-Host '确认删除并重建？输入 y 继续'
  if ($answer -ne 'y') { Fail '已取消' }
  # rmdir 只删链接本身，不会跟进 junction 目标（node_modules 里有指向 pnpm store 的链接）。
  cmd /c rmdir /s /q "$profileDir"
}

if (-not (Test-Path $manifest)) {
  Step "按蓝图物化 profile: $profileDir"
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  foreach ($file in @('package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml')) {
    Copy-Item (Join-Path $blueprint $file) -Destination $profileDir -Force
  }
}

# ------------------------------------------------------------- 依赖：link / pack
$env:DSH_HOME = $DshHome
$pkg = Get-Content $manifest -Raw | ConvertFrom-Json
$dirty = $false

foreach ($plugin in $plugins) {
  $name = $plugin.Name

  if ($Mode -eq 'link') {
    # link: 指向工作树 —— 每次启动前都跑过 pnpm -r build，所以验的是当前代码。
    $spec = "link:$($plugin.Dir -replace '\\', '/')"
  } else {
    Step "打包插件（pnpm pack）: $name"
    Invoke-Pnpm @('pack') $plugin.Dir
    $tgz = Get-ChildItem (Join-Path $plugin.Dir '*.tgz') | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $tgz) { Fail "pnpm pack 没有产出 tarball: $($plugin.Dir)" }
    Say "    $($tgz.Name)"
    $spec = "file:$($tgz.FullName -replace '\\', '/')"
  }

  # 带 scope 的包名天然是多一层目录，Join-Path 对两种形式都成立。
  $installed = Test-Path (Join-Path $profileDir "node_modules\$name\package.json")
  $current = $pkg.dependencies.$name

  if ($current -ne $spec -or -not $installed) {
    Step "设置依赖: $name"
    Say "    -> $spec"
    $pkg.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $spec -Force
    $dirty = $true
  } else {
    Say "已就绪，依赖未变: $name"
  }
}

if ($dirty) {
  $pkg | ConvertTo-Json -Depth 10 | Set-Content $manifest
  Step '安装 profile 依赖（dsh plugin install）'
  & $dsh plugin --profile $Profile install
  if ($LASTEXITCODE -ne 0) { Fail "dsh plugin install 失败（退出码 $LASTEXITCODE）" }
}

# ----------------------------------------------------------------- 端口检查
if ($Port -ne 0) {
  $busy = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($busy) {
    $holder = $busy[0].OwningProcess
    $who = Get-Process -Id $holder -ErrorAction SilentlyContinue
    # 只停自己人：占用者必须是 DeepSeek Harness，否则 -Restart 也不动它。
    if ($Restart -and $who -and $who.ProcessName -eq 'DeepSeek Harness') {
      Step "端口 $Port 上已有实例（pid $holder），按 -Restart 先停掉它"
      Stop-Process -Id $holder -Force
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) { break }
      }
      if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
        Fail "停掉 pid $holder 之后端口 $Port 仍被占用"
      }
      Say '    已停止，端口已释放'
    } else {
      $hint = if ($Restart) { '占用者不是 DeepSeek Harness，-Restart 不会动它。' } else { '换一个 -Port，或加 -Restart 停掉旧实例。' }
      Fail "端口 $Port 已被占用（pid $holder $($who.ProcessName)）" $hint
    }
  }
}

# ----------------------------------------------------------------- 启动
Say ''
Step '启动（浏览器会自动打开；Ctrl+C 停止）'
Say '   首次进入：设置 → Models 填 API key；或用首次运行弹窗 "Save and continue"。'
Say '   验收 TIA 工具前，建议先在设置里把 requestTimeoutMs 调大（见 profile 的 cordis.patch.yml 注释）。'
Say '   git_* 工具由 dsh-tool-git 提供；破坏性 git 命令默认被拒（destructivePolicy: deny）。'
Say ''

$env:DSH_HOME = $DshHome
$dshArgs = @('--profile', $Profile, '--port', "$Port")
if ($NoOpen) { $dshArgs += '--no-open' }
& $dsh @dshArgs
exit $LASTEXITCODE
