<#
.SYNOPSIS
  第 0/2 层验证：直接测 C# 控制器，全程不启动 DSH、不碰任何 DSH profile。

.DESCRIPTION
  分两段：

  A. 无项目段（永远是只读的）
     1. `--self-test`（14 项，无需 TIA Portal）
     2. `--version` / `--help` / 越权操作被拒
     3. 一条 NDJSON 会话：ready 帧、非法参数、无项目时的 project_not_open
  B. 真实项目段（需要 -ProjectPath；整段在**同一个控制器会话**内串行执行，
     因为项目是会话状态——这正是 sidecar 架构的意义）

        p1  OpenProject dry_run=true   ← 只校验路径，不启动 TIA
        o1  OpenProject                ← 启动 headless TIA 打开项目
        b1  ExportBlocks dry_run=true  ← 列出将写出的文件（不写）
        e1  ExportBlocks               ← 仅当给了 -ExportDir：真导出
        d1  ImportBlocks dry_run=true  ← 仅当给了 -ImportPath：预演导入、报告冲突
        i1  ImportBlocks               ← 仅当 -ImportPath 且 -Execute：真导入（override + 写后验证）
        c1  CompilePlc dry_run=true    ← 列出将编译的块
        c2  CompilePlc                 ← 仅当 -Compile：真编译
        x1  CloseProject dry_run=true

  写操作只在 -Execute 时才发生（真导出 / 真导入 / 真编译）。**建议对项目副本执行**。

.PARAMETER ProjectPath
  TIA Portal V17 项目的 .ap17 路径。

.PARAMETER ExportDir
  导出目录；给了就做真导出（受 -Execute 控制）。

.PARAMETER ImportPath
  要导入的 Simatic ML XML 或 SCL/STL 外部源（文件或目录）。给了就先 dry-run 预演。

.PARAMETER Compile
  真编译（需要本机装 TIA；编译会改变项目的编译状态）。

.PARAMETER TimeoutSec
  单个请求的等待时间上限（默认 600 秒；打开/编译大项目可能更久）。

.EXAMPLE
  pwsh -NoProfile -File test-profile\test-controller.ps1
  pwsh -NoProfile -File test-profile\test-controller.ps1 -ProjectPath C:\tia-openness-test\KPH_CellController_0822\KPH_CellController_0822.ap17
  pwsh -NoProfile -File test-profile\test-controller.ps1 -ProjectPath <copy>.ap17 -ExportDir C:\temp\exp -Execute
#>
[CmdletBinding()]
param(
  [string]$ControllerPath = '',
  [string]$ProjectPath = '',
  [string]$ExportDir = '',
  [string]$ImportPath = '',
  [switch]$Compile,
  [switch]$Execute,
  [int]$TimeoutSec = 600
)

$ErrorActionPreference = 'Stop'
$script:failures = 0
$script:controller = $null

function Say([string]$t) { Write-Host $t }
function Pass([string]$what) { Write-Host "  [OK]   $what" -ForegroundColor Green }
function Info([string]$what) { Write-Host "         $what" -ForegroundColor DarkGray }
function Fail([string]$what, [string]$detail = '') {
  $script:failures++
  Write-Host "  [FAIL] $what" -ForegroundColor Red
  if ($detail) { Write-Host "         $detail" -ForegroundColor DarkGray }
}
function Warn([string]$what) { Write-Host "  [WARN] $what" -ForegroundColor Yellow }

# 与 TS 客户端一致：把所有非 ASCII 码点转义，避免 console 代码页影响中文路径。
function ConvertTo-AsciiJson($value) {
  $json = $value | ConvertTo-Json -Compress -Depth 12
  return [regex]::Replace($json, '[\u007f-\uffff]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

function Invoke-Controller([string[]]$arguments) { (& $script:controller @arguments 2>&1) -join "`n" }

# 把一组请求塞进**同一个**控制器进程，返回 { id -> result 帧 }
function Invoke-Session([hashtable[]]$requests) {
  $lines = ($requests | ForEach-Object { ConvertTo-AsciiJson $_ }) -join "`n"
  $raw = @($lines | & $script:controller 2>&1)
  $frames = @()
  foreach ($line in $raw) { if ("$line".Trim().StartsWith('{')) { try { $frames += ("$line" | ConvertFrom-Json) } catch { } } }
  $results = @{}
  foreach ($f in ($frames | Where-Object { $_.type -eq 'result' -and $_.id })) { $results[[string]$f.id] = $f }
  return @{ Frames = $frames; Results = $results }
}

# ------------------------------------------------------------------ 定位 exe
if ([string]::IsNullOrWhiteSpace($ControllerPath)) {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $ControllerPath = Join-Path (Split-Path -Parent $here) 'controller\bin\TiaOpennessV17Min.Controller.exe'
}
if (-not (Test-Path $ControllerPath)) {
  Say "找不到控制器: $ControllerPath" -ForegroundColor Red
  Say '先构建： npm run build:controller'
  exit 2
}
$script:controller = (Resolve-Path $ControllerPath).Path
Say "控制器: $script:controller"
Say ''

# ================================================== A. 无项目段（只读）
Say 'A1) 控制器自检（--self-test，无需 TIA Portal）'
$report = $null
try { $report = (Invoke-Controller @('--self-test')) | ConvertFrom-Json } catch { }
if ($null -eq $report) { Fail '解析自检输出' '控制器没有输出可解析的 JSON' }
elseif ($report.ok -and $report.failedCount -eq 0) {
  Pass "self-test $($report.checkCount)/$($report.checkCount) 通过（协议 $($report.protocol)）"
  $o = $report.openness
  Info ("Openness: available={0} version={1} resolvedFrom={2} resolver={3}" -f $o.available, $o.assemblyVersion, $o.resolvedFrom, $o.resolverVersion)
  Info ("用户组 '{0}' 成员: {1}" -f $report.opennessUserGroup.group, $report.opennessUserGroup.isMember)
  if ($o.available -ne $true) { Fail 'Openness 可用性' ([string]$o.message) }
} else {
  Fail 'self-test' (($report.checks | Where-Object { -not $_.ok } | ForEach-Object { "$($_.name): $($_.detail)" }) -join ' | ')
}
Say ''

Say 'A2) --version / --help / 越权操作'
$version = (Invoke-Controller @('--version')) | ConvertFrom-Json
# 不写死条数：白名单随插件能力增长（v0.2 起 25 个），只断言五个基础操作都在。
$requiredOperations = @('OpenProject', 'ExportBlocks', 'ImportBlocks', 'CompilePlc', 'CloseProject')
$missingOperations = @($requiredOperations | Where-Object { $version.operations -notcontains $_ })
if ($missingOperations.Count -eq 0) { Pass "白名单 $($version.operations.Count) 个操作 = $($version.operations -join ', ')" }
else { Fail "白名单缺少操作: $($missingOperations -join ', ')" }
$help = Invoke-Controller @('--help')
if ($help -match 'OpenProject' -and $help -match 'TIA_OPENNESS_V17_DIR') { Pass '--help 描述白名单与环境变量' } else { Fail '--help 内容不完整' }
$priv = (Invoke-Controller @('--operation', 'RunScript', '--param', 'code=x()')).Trim() -split "`n" | Select-Object -Last 1 | ConvertFrom-Json
if ($priv.ok -eq $false -and $priv.error.code -eq 'unsupported_operation') { Pass '越权操作 RunScript 被拒绝（unsupported_operation）' }
else { Fail '越权操作没有被拒绝' }
Say ''

Say 'A3) NDJSON 会话（ready 帧 / 参数校验 / 白名单）'
$s = Invoke-Session @(
  @{ id = 'r1'; operation = 'RunScript'; params = @{ code = 'arbitrary()' } },
  @{ id = 'r2'; operation = 'ExportBlocks'; params = @{} },
  @{ id = 'r3'; operation = 'CompilePlc'; params = @{ dry_run = $false } }
)
$ready = $s.Frames | Where-Object { $_.type -eq 'ready' } | Select-Object -First 1
if ($ready) { Pass "ready 帧：protocol=$($ready.protocol) pid=$($ready.pid) Openness=$($ready.openness.available) resolvedFrom=$($ready.openness.resolvedFrom)" }
else { Fail '未收到 ready 帧' }
if ($s.Results['r1'] -and $s.Results['r1'].error.code -eq 'unsupported_operation') { Pass 'r1 越权帧被拒' } else { Fail 'r1 期望 unsupported_operation' }
if ($s.Results['r2'] -and $s.Results['r2'].error.code -eq 'invalid_params') { Pass 'r2 缺少 output_dir → invalid_params' } else { Fail 'r2 期望 invalid_params' }
if ($s.Results['r3'] -and $s.Results['r3'].error.code -eq 'project_not_open') { Pass 'r3 无项目 → project_not_open' } else { Fail 'r3 期望 project_not_open' ([string]$s.Results['r3'].error.message) }
Say ''

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
  Say '未提供 -ProjectPath：只读检查完成。' -ForegroundColor Yellow
  Say '接着测真实项目： -ProjectPath <你的.ap17>  （加 -ExportDir <目录> -Execute 才真导出）'
  Say ''
  Say ("结果: {0}" -f $(if ($script:failures -eq 0) { 'A 段全部通过' } else { "$script:failures 项失败" }))
  exit $(if ($script:failures -eq 0) { 0 } else { 1 })
}

# ================================================== B. 真实项目段（一个会话）
Say "B) 真实项目（同一控制器会话内串行执行）: $ProjectPath"
if (-not (Test-Path $ProjectPath)) { Fail '项目文件不存在' $ProjectPath; exit 1 }

$requests = [System.Collections.Generic.List[hashtable]]::new()
$requests.Add(@{ id = 'p1'; operation = 'OpenProject'; params = @{ project_path = $ProjectPath; dry_run = $true } })
$requests.Add(@{ id = 'o1'; operation = 'OpenProject'; params = @{ project_path = $ProjectPath } })
$requests.Add(@{ id = 'b1'; operation = 'ExportBlocks'; params = @{ output_dir = $(if ($ExportDir) { $ExportDir } else { Join-Path $env:TEMP 'tia-openness-plan' }); dry_run = $true } })
if ($ExportDir -and $Execute) {
  $requests.Add(@{ id = 'e1'; operation = 'ExportBlocks'; params = @{ output_dir = $ExportDir } })
}
if ($ImportPath) {
  $requests.Add(@{ id = 'd1'; operation = 'ImportBlocks'; params = @{ import_paths = @($ImportPath); dry_run = $true } })
  if ($Execute) {
    $requests.Add(@{ id = 'i1'; operation = 'ImportBlocks'; params = @{ import_paths = @($ImportPath); import_options = 'override'; dry_run = $false } })
  }
}
$requests.Add(@{ id = 'c1'; operation = 'CompilePlc'; params = @{ dry_run = $true } })
if ($Compile) { $requests.Add(@{ id = 'c2'; operation = 'CompilePlc'; params = @{ dry_run = $false } }) }
$requests.Add(@{ id = 'x1'; operation = 'CloseProject'; params = @{ dry_run = $true } })

Info ("会话请求序列: " + (($requests | ForEach-Object { $_.id }) -join ' → '))
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$session = Invoke-Session $requests
$sw.Stop()

$progress = @($session.Frames | Where-Object { $_.type -eq 'progress' })
Info ("收到 {0} 帧（含 {1} 个 progress 帧），总耗时 {2:N1} s" -f $session.Frames.Count, $progress.Count, $sw.Elapsed.TotalSeconds)
if ($progress.Count -gt 0) { Info ("  最后一条进度: [" + $progress[-1].phase + "] " + $progress[-1].message) }

function Step([string]$id, [string]$label) {
  $r = $session.Results[$id]
  if ($null -eq $r) { Fail "$label（$id）无返回帧"; return $null }
  if ($r.ok) { Pass "$label" } else { Fail "$label" ("$($r.error.code): $($r.error.message)") }
  return $r
}

$p1 = Step 'p1' 'p1 打开预演（dry-run，不启动 TIA）'
$o1 = Step 'o1' 'o1 真打开项目'
if ($o1 -and $o1.ok) {
  Info ("项目 '{0}'，PLC 软件 {1} 个，块 {2} 个，打开耗时 {3} ms" -f $o1.data.projectName, $o1.data.plcSoftware.count, $o1.data.blockSummary.count, $o1.data.openDurationMs)
  foreach ($sw_ in $o1.data.plcSoftware.items) { Info ("  - {0} / {1}（{2} 块）" -f $sw_.device, $sw_.software, $sw_.blockCount) }
  if ($o1.data.plcSoftware.count -lt 1) { Fail '项目里没有 PLC 软件' }
} elseif ($o1) {
  Warn '打开失败时请确认：项目是 V17 的（.ap17）、没有被其它 TIA 实例占用；旧版本项目需要 allow_upgrade（本脚本不升级项目）。'
}
$b1 = Step 'b1' 'b1 导出预演（列出将写出的文件）'
if ($b1 -and $b1.ok) { Info ("计划写出 {0} 个文件，首个: {1}" -f $b1.data.blockCount, $b1.data.files[0].file) }

if ($session.Results['e1']) {
  $e1 = Step 'e1' 'e1 真导出（只写文件系统，不改项目）'
  if ($e1 -and $e1.ok) {
    Info ("导出 {0}，跳过 {1}，Openness 拒绝 {2}，写出后读回失败 {3}；manifest={4}" -f `
        $e1.data.summary.exported, $e1.data.summary.skipped, $e1.data.summary.failed, $e1.data.summary.verificationFailed, $e1.data.manifest)
    foreach ($f in ($e1.data.files | Select-Object -First 5)) { Info ("  {0}  {1} bytes  verified={2}" -f $f.file, $f.bytes, $f.verified) }
    if ($e1.data.summary.verificationFailed -gt 0) { Fail '有文件写出后无法读回（verificationFailed > 0）' }
    if ($e1.data.summary.failed -gt 0) {
      Warn "$($e1.data.summary.failed) 个块没有 Simatic ML 表示，Openness 直接拒绝（逐块记录，不影响其余导出）："
      foreach ($f in $e1.data.failures) { Info ("  {0}: {1}" -f $f.name, (($f.message -split "`n")[0])) }
    }
  }
} else { Info '未启用真导出（-ExportDir + -Execute 才写文件）' }

if ($session.Results['d1']) {
  $d1 = Step 'd1' 'd1 导入预演（解析目标块名、报告冲突，不改项目）'
  if ($d1 -and $d1.ok) {
    foreach ($item in $d1.data.plan) { Info ("  {0}  {1}  exists={2}  action={3}" -f $item.format, $item.blockName, $item.existsInProject, $item.action) }
    if ($d1.data.conflicts.Count -gt 0) { Info ("冲突: " + ($d1.data.conflicts -join ', ') + "（真导入需要 import_options=override）") }
  }
}
if ($session.Results['i1']) {
  $i1 = Step 'i1' 'i1 真导入（事务 + 写后读回验证）'
  if ($i1 -and $i1.ok) {
    Info ("committed={0}，已导入 {1} 个文件" -f $i1.data.committed, $i1.data.applied.Count)
    if ($i1.data.verification) {
      Info ("写后验证: passed={0}，checked={1}，confirmed={2}，missing={3}" -f $i1.data.verification.passed, $i1.data.verification.checked, $i1.data.verification.confirmedCount, ($i1.data.verification.missing -join ','))
      foreach ($b in $i1.data.verification.blocks) {
        Info ("  {0}: found={1} changed={2} before={3} after={4}" -f $b.name, $b.found, $b.changed, $b.modifiedDateBefore, $b.modifiedDateAfter)
      }
      if ($i1.data.verification.passed -ne $true) { Fail '写后验证未通过' }
    }
  }
}
$c1 = Step 'c1' 'c1 编译预演（列出将编译的块）'
if ($c1 -and $c1.ok) { Info ("将编译 {0} 个块" -f $c1.data.blockCount) }
if ($session.Results['c2']) {
  $c2 = Step 'c2' 'c2 真编译'
  if ($c2 -and $c2.ok) {
    Info ("state={0} errors={1} warnings={2} messages={3} 耗时 {4} ms" -f $c2.data.state, $c2.data.errorCount, $c2.data.warningCount, $c2.data.messageCount, $c2.data.durationMs)
    foreach ($m in ($c2.data.messages | Select-Object -First 8)) { Info ("  [{0}] {1} {2}" -f $m.level, $m.description, $m.path) }
    if ($c2.data.errorCount -gt 0) { Warn "编译报 $($c2.data.errorCount) 个错误（这是数据，不是工具故障）" }
  }
} else { Info '未启用真编译（加 -Compile）' }
$x1 = Step 'x1' 'x1 关闭预演（dry-run）'

Say ''
Say 'B 段摘要'
Say ("  打开: {0}  导出预演: {1}  真导出: {2}  导入预演: {3}  真导入: {4}  编译: {5}  关闭预演: {6}" -f `
    $o1.ok, $b1.ok, $(if ($session.Results['e1']) { $session.Results['e1'].ok } else { '-' }), `
    $(if ($session.Results['d1']) { $session.Results['d1'].ok } else { '-' }), `
    $(if ($session.Results['i1']) { $session.Results['i1'].ok } else { '-' }), `
    $(if ($session.Results['c2']) { $session.Results['c2'].ok } else { '-' }), $x1.ok)
Say ''
Say ("结果: {0}" -f $(if ($script:failures -eq 0) { '全部通过' } else { "$script:failures 项失败" }))
Say '提示：控制器退出后若仍有 headless TiaPortal.exe 残留，用 close_project(save:false) 或手动结束它。'
exit $(if ($script:failures -eq 0) { 0 } else { 1 })
