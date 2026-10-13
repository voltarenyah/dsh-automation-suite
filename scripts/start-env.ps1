<#
.SYNOPSIS
  在独立 DSH_HOME 里启动 dsh-automation-suite 发行版，看不懂的路径它自己解析。

.DESCRIPTION
  把"部署 + 安装插件 + 起服务 + 带 token 开浏览器"这套动作收成一条命令，
  并且把工具链路径（dsh / pnpm）从 DSH 安装目录里解析出来 —— 这台机器上
  pnpm 与 dsh 都不在 PATH 上，手敲既长又容易记错。

  环境是**自包含**的：用自己的 $HOME 作为 DSH_HOME，不碰你日常的 ~/.dsh。
  删掉那个目录就等于完全回退。

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
$pluginDir = Join-Path $repo 'packages\dsh-tia-openness-v17-min'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$manifest = Join-Path $profileDir 'package.json'

if (-not (Test-Path $blueprint)) { Fail "找不到蓝图目录: $blueprint" 'profile\<名字> 必须存在；-Profile 决定用哪个蓝图。' }
if (-not (Test-Path $pluginDir)) { Fail "找不到插件目录: $pluginDir" }

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
$spec = if ($Mode -eq 'link') {
  "link:$($pluginDir -replace '\\', '/')"
} else {
  Step '打包插件（pnpm pack）'
  Invoke-Pnpm @('pack') $pluginDir
  $tgz = Get-ChildItem (Join-Path $pluginDir '*.tgz') | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $tgz) { Fail 'pnpm pack 没有产出 tarball' }
  Say "    $($tgz.Name)"
  "file:$($tgz.FullName -replace '\\', '/')"
}

$pkg = Get-Content $manifest -Raw | ConvertFrom-Json
$name = '@voltarenyah/dsh-tia-openness-v17-min'
$installed = Test-Path (Join-Path $profileDir "node_modules\$name\package.json")
$current = $pkg.dependencies.$name

if ($current -ne $spec -or -not $installed) {
  Step "设置依赖并安装: $spec"
  $pkg.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $spec -Force
  $pkg | ConvertTo-Json -Depth 10 | Set-Content $manifest
  $env:DSH_HOME = $DshHome
  & $dsh plugin --profile $Profile install
  if ($LASTEXITCODE -ne 0) { Fail "dsh plugin install 失败（退出码 $LASTEXITCODE）" }
} else {
  Say "插件已就绪，依赖未变（$spec）"
}

# ----------------------------------------------------------------- 端口检查
if ($Port -ne 0) {
  $busy = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($busy) {
    $who = Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue
    Fail "端口 $Port 已被占用（pid $($busy[0].OwningProcess) $($who.ProcessName)）" '换一个 -Port，或先停掉那个实例再启动。'
  }
}

# ----------------------------------------------------------------- 启动
Say ''
Step '启动（浏览器会自动打开；Ctrl+C 停止）'
Say '   首次进入：设置 → Models 填 API key；或用首次运行弹窗 "Save and continue"。'
Say '   验收 TIA 工具前，建议先在设置里把 requestTimeoutMs 调大（见 profile 的 cordis.patch.yml 注释）。'
Say ''

$env:DSH_HOME = $DshHome
$dshArgs = @('--profile', $Profile, '--port', "$Port")
if ($NoOpen) { $dshArgs += '--no-open' }
& $dsh @dshArgs
exit $LASTEXITCODE
