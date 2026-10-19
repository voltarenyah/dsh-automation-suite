<#
.SYNOPSIS
  第 1 层验证：在**独立测试 profile** 里验证 DSH 真的加载了本插件，并且控制器子进程
  随宿主结束而退出。不修改 desktop（默认）profile。

.DESCRIPTION
  流程：
    0. 只读检查：测试 profile 是否存在、插件是否已链接、端口是否空闲；
    1. 记录当前控制器进程快照；
    2. 启动一个**第二个** DSH 实例（同一个 ~/.dsh，独立端口，--patch 叠加插件行，
       不写任何 profile 文件）；
    3. 轮询等待控制器子进程出现  → 证明 apply 被调用、prewarm 生效；
    4. 结束该实例（关闭宿主）；
    5. 轮询等待控制器子进程消失  → 证明宿主结束时子进程不会残留。

  注意这里验证的是"宿主进程结束 → 子进程随之退出"（控制器读到 stdin EOF 后自行退出）。
  真实的 **HMR disposer** 路径（在 UI 里禁用插件触发 ctx.effect 的 disposer）需要在该实例里
  操作插件页，脚本无法代劳，见 test-profile/README.md。

.PARAMETER Profile
  测试用的 profile 名（默认 tia-test）。脚本不会创建它，见 README 的两条命令。

.PARAMETER Port
  第二个实例监听的端口（默认 3080；桌面端在 19387，不冲突）。用 -1 让系统随机分配。

.PARAMETER PlanOnly
  只做第 0 步的只读检查并打印将要执行的命令，不启动任何进程。

.EXAMPLE
  pwsh -NoProfile -File test-profile\test-dsh-load.ps1 -PlanOnly
  pwsh -NoProfile -File test-profile\test-dsh-load.ps1
#>
[CmdletBinding()]
param(
  [string]$Profile = 'tia-test',
  [int]$Port = 3080,
  [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$overlay = Join-Path $repo 'test-profile\plugin-overlay.yml'
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
# $DSH_HOME wins, so the whole test can run in an isolated home and leave ~/.dsh untouched.
$dshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim().Length -gt 0) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$logDir = Join-Path $repo 'test-profile\logs'
$packageName = '@voltarenyah/dsh-tia-openness-v17-min'
$controllerName = 'TiaOpennessV17Min.Controller'

function Controllers {
  @(Get-Process -Name $controllerName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}
function Say([string]$t) { Write-Host $t }

Say "仓库      : $repo"
Say "dsh CLI   : $dsh"
Say "测试 profile: $profileDir"
Say "overlay   : $overlay"
Say ''

# ----------------------------------------------------------------- 0. 只读检查
Say '0) 前置检查'
$ok = $true
if (-not (Test-Path $dsh)) { Write-Host "  [FAIL] 找不到 dsh CLI: $dsh" -ForegroundColor Red; $ok = $false }
else { Write-Host '  [OK]   dsh CLI 存在' -ForegroundColor Green }

if (-not (Test-Path $profileDir)) {
  Write-Host "  [FAIL] 测试 profile 不存在。先运行：" -ForegroundColor Red
  Write-Host "         & `"$dsh`" --profile $Profile --from-default-profile web --dump-config" -ForegroundColor Yellow
  $ok = $false
} else { Write-Host '  [OK]   测试 profile 存在' -ForegroundColor Green }

$installed = Test-Path (Join-Path $profileDir "node_modules\$packageName\package.json")
if (-not $installed) {
  Write-Host "  [FAIL] 插件还没链接进该 profile。先运行：" -ForegroundColor Red
  Write-Host "         & `"$dsh`" plugin --profile $Profile add link:$repo" -ForegroundColor Yellow
  $ok = $false
} else { Write-Host '  [OK]   插件已链接进该 profile' -ForegroundColor Green }

if (-not (Test-Path $overlay)) { Write-Host "  [FAIL] 缺少 overlay: $overlay" -ForegroundColor Red; $ok = $false }
else { Write-Host '  [OK]   overlay 存在' -ForegroundColor Green }

if ($Port -ge 0) {
  $busy = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($busy) { Write-Host "  [FAIL] 端口 $Port 已被占用，换 -Port 或先用 0" -ForegroundColor Red; $ok = $false }
  else { Write-Host "  [OK]   端口 $Port 空闲" -ForegroundColor Green }
}

$before = Controllers
Say ("  当前控制器进程: {0}" -f $(if ($before.Count) { $before -join ', ' } else { '无' }))
Say ''

if ($PlanOnly -or -not $ok) {
  Say '将要执行的命令（PlanOnly / 前置检查未通过，不实际启动）：'
  Say "  & `"$dsh`" --profile $Profile --patch `"$overlay`" --port $Port --no-open"
  exit $(if ($ok) { 0 } else { 2 })
}

# ----------------------------------------------------------------- 1. 启动实例
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "dsh-$Profile.out.log"
$errLog = Join-Path $logDir "dsh-$Profile.err.log"
Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

Say '1) 启动第二个 DSH 实例（独立端口；不写 profile 文件）…'
$dshArgs = @('--profile', $Profile, '--patch', $overlay, '--port', "$Port", '--no-open')
$wrapper = Start-Process -FilePath $dsh -ArgumentList $dshArgs -RedirectStandardOutput $outLog -RedirectStandardError $errLog -NoNewWindow -PassThru
Say "   启动器 pid = $($wrapper.Id)（dsh.cmd 是 cmd.exe 包装，真正的宿主是它的子进程）；日志: $outLog"

# dsh.cmd 只是 cmd.exe 包装：真正的宿主是它的子进程，必须结束那个进程（单进程结束即可——
# 宿主退出会关掉控制器的 stdin 管道，控制器读到 EOF 后自行退出）。
$harnessPid = $null
for ($i = 0; $i -lt 40 -and -not $harnessPid; $i++) {
  Start-Sleep -Milliseconds 500
  $child = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ParentProcessId -eq $wrapper.Id -and $_.CommandLine -match [regex]::Escape($Profile) } |
    Select-Object -First 1
  if ($child) { $harnessPid = $child.ProcessId }
}
if ($harnessPid) { Say "   宿主 pid = $harnessPid" } else { Warn '   没找到宿主子进程，稍后结束启动器（可能只关掉包装进程）' }

# --------------------------------------------------- 2. 等控制器子进程出现
Say '2) 等待控制器子进程出现（apply 被调用 → prewarm 启动子进程）…'
$appeared = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $now = Controllers | Where-Object { $before -notcontains $_ }
  if ($now) { $appeared = @($now); break }
  if ($wrapper.HasExited) { break }
}
if ($appeared) {
  Write-Host "  [OK]   控制器子进程已启动: pid=$($appeared -join ', ')" -ForegroundColor Green
  Write-Host '         → 这证明宿主行被真实 DSH 宿主加载，apply() 执行、ctx.effect 持有子进程' -ForegroundColor DarkGray
  # 两行各自的日志也会留下证据：宿主行的 host row 行、工具行注册的工具名、skill provider。
  $registered = Select-String -Path $outLog, $errLog -Pattern 'TIA Portal V17 host row|TIA Portal V17 tools|tia-openness-v17-min' -ErrorAction SilentlyContinue | Select-Object -First 4
  foreach ($line in $registered) { Write-Host ("         插件日志: " + $line.Line.Trim()) -ForegroundColor DarkGray }
} else {
  Write-Host '  [FAIL] 等待 60 秒未看到控制器子进程' -ForegroundColor Red
  Write-Host "         启动器是否已退出: $($wrapper.HasExited)；请看 $errLog" -ForegroundColor Yellow
}

# ------------------------------------------------------------- 3. 结束宿主
Say '3) 结束该 DSH 实例（结束真正的宿主进程，模拟宿主退出）…'
try {
  if ($harnessPid) { Stop-Process -Id $harnessPid -Force -ErrorAction Stop }
  else { Stop-Process -Id $wrapper.Id -Force -ErrorAction Stop }
} catch { }
$deadline = (Get-Date).AddSeconds(30)
$gone = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1
  $still = Controllers | Where-Object { $appeared -contains $_ }
  if (-not $still) { $gone = $true; break }
}

Say '4) 结果'
if ($appeared -and $gone) {
  Write-Host '  [OK]   子进程随宿主结束而退出（控制器读到 stdin EOF 后自行退出，未残留）' -ForegroundColor Green
  Say ''
  Say '这一层验证通过。剩下两项需要真人在 UI 里做：'
  Say "  * HMR disposer 路径：在该实例 (http://127.0.0.1:$Port) 的插件页里禁用/启用插件，"
  Say '    观察控制器子进程被 disposer 停掉再重新启动（这是 ctx.effect 的异步 disposer）。'
  Say '  * 功能验收：见 docs/FUNCTIONAL-TEST.md（导出→改→导入→编译）。'
  exit 0
}
if (-not $appeared) { Write-Host '  [FAIL] 子进程从未出现，无法判断退出行为' -ForegroundColor Red; exit 1 }
if (-not $gone) {
  Write-Host "  [FAIL] 宿主已结束但控制器仍在: $((Controllers) -join ', ')" -ForegroundColor Red
  Write-Host '         手动清理: Get-Process -Name TiaOpennessV17Min.Controller | Stop-Process -Force' -ForegroundColor Yellow
  exit 1
}
