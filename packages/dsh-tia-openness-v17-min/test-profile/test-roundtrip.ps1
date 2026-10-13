<#
.SYNOPSIS
  第 2 层核心：导出 → **改内容** → 导入（override）→ 重新导出对比 → （可选）编译。
  全程在**同一个控制器会话**内完成，即真实插件的使用方式。

.DESCRIPTION
  为什么这样设计：
    * 只比较"导入没有报错"是不够的（需求明确要求写后验证）。脚本会改一个**可观察**
      的头部字段（默认 HeaderVersion），导入后重新导出该块，再对比该字段是否真的
      变成了新值——这才是"文件内容被真正写进项目"的证据。
    * 编译报错会原样打印（这是数据，不是工具故障）；若项目本身有既有错误，这里会显示出来，
      可用未修改的项目副本再跑一次取基线。

.PARAMETER ProjectPath
  **项目副本**的 .ap17 路径（导入会修改项目，别用正式项目）。

.PARAMETER BlockXml
  一个已导出的 Simatic ML XML（用 test-controller.ps1 -ExportDir ... -Execute 产出）。
  该文件必须含 -Field 指定的元素。

.PARAMETER Field
  要修改的字段（默认 HeaderVersion）。可用值例如 HeaderVersion / HeaderAuthor。

.PARAMETER NewValue
  新值（默认 0.2）。

.PARAMETER Compile
  导入后真编译一次（会改变项目的编译状态）。

.PARAMETER WorkDir
  工作目录（放改过的文件和重新导出的文件）。

.EXAMPLE
  pwsh -NoProfile -File test-profile\test-roundtrip.ps1 `
    -ProjectPath C:\tia-openness-test\KPH_CellController_0822\KPH_CellController_0822.ap17 `
    -BlockXml C:\tia-openness-test\export\999_Kautex\FB_Array_Handling.xml -Compile
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectPath,
  [Parameter(Mandatory = $true)][string]$BlockXml,
  [string]$Field = 'HeaderVersion',
  [string]$NewValue = '0.2',
  [string]$WorkDir = 'C:\tia-openness-test\roundtrip',
  [string]$ControllerPath = '',
  [string]$TargetGroup = '',
  [switch]$Compile
)

$ErrorActionPreference = 'Stop'
$script:failures = 0
function Say([string]$t) { Write-Host $t }
function Pass([string]$w) { Write-Host "  [OK]   $w" -ForegroundColor Green }
function Info([string]$w) { Write-Host "         $w" -ForegroundColor DarkGray }
function Warn([string]$w) { Write-Host "  [WARN] $w" -ForegroundColor Yellow }
function Fail([string]$w, [string]$d = '') { $script:failures++; Write-Host "  [FAIL] $w" -ForegroundColor Red; if ($d) { Write-Host "         $d" -ForegroundColor DarkGray } }

function ConvertTo-AsciiJson($v) {
  ([regex]::Replace(($v | ConvertTo-Json -Compress -Depth 12), '[\u007f-\uffff]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
}

if ([string]::IsNullOrWhiteSpace($ControllerPath)) {
  $ControllerPath = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'controller\bin\TiaOpennessV17Min.Controller.exe'
}
$controller = (Resolve-Path $ControllerPath).Path
if (-not (Test-Path $BlockXml)) { Say "找不到块文件: $BlockXml" -ForegroundColor Red; exit 2 }

# ---------------------------------------------------------------- 1. 改内容
Say "1) 准备'改过的'块文件"
$original = Get-Content $BlockXml -Raw
$nameMatch = [regex]::Match($original, '<Name>([^<]*)</Name>')
if (-not $nameMatch.Success) { Say '块文件里找不到 <Name>' -ForegroundColor Red; exit 2 }
$blockName = $nameMatch.Groups[1].Value
$before = [regex]::Match($original, "<$Field>([^<]*)</$Field>")
if (-not $before.Success) { Say "块文件里没有 <$Field>，换一个 -Field（例如 HeaderAuthor 或 Name）" -ForegroundColor Red; exit 2 }
$beforeValue = $before.Groups[1].Value

$modDir = Join-Path $WorkDir 'modified'
$verifyDir = Join-Path $WorkDir 'reverify'
New-Item -ItemType Directory -Force -Path $modDir, $verifyDir | Out-Null
$modifiedPath = Join-Path $modDir (Split-Path -Leaf $BlockXml)
$modified = $original -replace "<$Field>$([regex]::Escape($beforeValue))</$Field>", "<$Field>$NewValue</$Field>"
if ($modified -eq $original) { Say '替换没有生效（值未变化）' -ForegroundColor Red; exit 2 }
Set-Content -Path $modifiedPath -Value $modified -NoNewline -Encoding utf8
Pass "块 '$blockName'：<$Field> '$beforeValue' → '$NewValue'  已写入 $modifiedPath"

# ------------------------------------------------- 2. 一个会话：导入 + 重新导出
Say '2) 同一控制器会话：打开 → 导入预演 → 真导入(override) → 重新导出 → （编译）→ 关闭'
# 目标组：默认从源文件所在目录推断（导出时目录 = 用户组路径），也可用 -TargetGroup 指定。
# 这一步是必须的：导入按"全 PLC 的名字/编号唯一性"判断，块必须回到它原来的组，
# 否则即使 ImportOptions.Override 也会失败（同名或同号已存在）。
if ([string]::IsNullOrWhiteSpace($TargetGroup)) {
  $srcDir = Split-Path -Parent (Resolve-Path $BlockXml).Path
  if ($srcDir -match 'export\\(.+)$') { $TargetGroup = ($Matches[1] -replace '\\', '/') }
}
Say ("目标组: " + $(if ($TargetGroup) { $TargetGroup } else { '(根组)' }))
Say '  说明：导入按"全 PLC 名字/编号唯一"判断，块必须导入回它原来所在的组；'
Say '        进根组时即使 import_options=override 也会报 "An object with this name or this number already exists"（已实测复现）。'

$requests = [System.Collections.Generic.List[hashtable]]::new()
$requests.Add(@{ id = 'o1'; operation = 'OpenProject'; params = @{ project_path = $ProjectPath } })
$importParams = @{ import_paths = @($modifiedPath); dry_run = $true }
if ($TargetGroup) { $importParams['target_group'] = $TargetGroup }
$requests.Add(@{ id = 'd1'; operation = 'ImportBlocks'; params = $importParams })
$realImport = @{ import_paths = @($modifiedPath); import_options = 'override'; dry_run = $false; verify = $true }
if ($TargetGroup) { $realImport['target_group'] = $TargetGroup }
$requests.Add(@{ id = 'i1'; operation = 'ImportBlocks'; params = $realImport })
# 编译必须放在重新导出之前：实测"导入后立刻 export 该块"会被 Openness 拒绝，
# 编译（errors=0）之后同一导出就成功。
if ($Compile) { $requests.Add(@{ id = 'c1'; operation = 'CompilePlc'; params = @{ dry_run = $false } }) }
$requests.Add(@{ id = 'e1'; operation = 'ExportBlocks'; params = @{ output_dir = $verifyDir; block_names = @($blockName); overwrite = $true } })
$requests.Add(@{ id = 'x1'; operation = 'CloseProject'; params = @{ dry_run = $true } })

$lines = ($requests | ForEach-Object { ConvertTo-AsciiJson $_ }) -join "`n"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$raw = @($lines | & $controller 2>&1)
$sw.Stop()
$frames = @(); foreach ($l in $raw) { if ("$l".Trim().StartsWith('{')) { try { $frames += ("$l" | ConvertFrom-Json) } catch { } } }
$res = @{}; foreach ($f in ($frames | Where-Object { $_.type -eq 'result' -and $_.id })) { $res[[string]$f.id] = $f }
Info ("收到 {0} 帧（{1} 个 progress），耗时 {2:N1} s" -f $frames.Count, (@($frames | Where-Object { $_.type -eq 'progress' }).Count), $sw.Elapsed.TotalSeconds)

function Step([string]$id, [string]$label, [switch]$Data) {
  $r = $res[$id]
  if ($null -eq $r) { Fail "$label（$id）无返回帧"; return $null }
  if ($r.ok) { Pass $label } else {
    Fail $label ("$($r.error.code): " + (($r.error.message -split "`n")[0]))
    # 每个块的拒绝原因在 error.details.failures 里（导出）/ 整段在 message 里（导入）
    if ($r.error.details -and $r.error.details.failures) {
      foreach ($x in $r.error.details.failures) {
        $reason = if ($x.message) { $x.message } else { $x }
        Info ("    拒绝 " + $(if ($x.name) { $x.name } else { '?' }) + ": " + ("$reason" -replace "`r?`n", ' | '))
      }
    }
  }
  return $r
}

$null = Step 'o1' "o1 打开项目（$(Split-Path -Leaf $ProjectPath)）"
$d1 = Step 'd1' 'd1 导入预演'
if ($d1 -and $d1.ok -and $d1.data.plan.Count -gt 0) {
  $p = $d1.data.plan[0]
  Info "  目标块=$($p.blockName) 类型=$($p.simaticType) exists=$($p.existsInProject) action=$($p.action) 冲突=$($d1.data.conflicts.Count)"
}
$i1 = Step 'i1' 'i1 真导入（事务 + 写后读回验证）'
if ($i1 -and $i1.ok) {
  Info "  committed=$($i1.data.committed) 导入文件数=$($i1.data.applied.Count)"
  $v = $i1.data.verification
  if ($v) {
    Info "  写后验证: passed=$($v.passed) checked=$($v.checked) confirmed=$($v.confirmedCount) missing=$($v.missing -join ',')"
    foreach ($b in $v.blocks) {
      Info "    $($b.name): found=$($b.found) group='$($b.group)' expected='$($b.expectedGroup)' replacedExisting=$($b.replacedExisting) changed=$($b.changed)"
      Info "      ModifiedDate: $($b.modifiedDateBefore)  →  $($b.modifiedDateAfter)"
      if ($b.differences) { foreach ($d in $b.differences) { Warn "  差异: $d" } }
    }
    if ($v.passed -ne $true) { Fail '写后验证未通过（导入的块没在项目里找到）' }
  }
}
$e1 = Step 'e1' 'e1 重新导出该块'
if ($e1 -and $e1.ok) { Info "  导出 $($e1.data.summary.exported) 个，文件=$($e1.data.files[0].file) verified=$($e1.data.files[0].verified)" }
if ($Compile) {
  $c1 = Step 'c1' 'c1 真编译'
  if ($c1 -and $c1.ok) {
    Info "  state=$($c1.data.state) errors=$($c1.data.errorCount) warnings=$($c1.data.warningCount) messages=$($c1.data.messageCount)"
    foreach ($m in ($c1.data.messages | Select-Object -First 10)) { Info "    [$($m.level)] $($m.description) $($m.path)" }
    if ($c1.data.errorCount -eq 0) { Pass '编译通过（errorCount=0）' }
    else { Warn "编译报 $($c1.data.errorCount) 个错误：这是编译结果数据，不是工具故障；请与未修改副本的基线对比" }
  }
}
$null = Step 'x1' 'x1 关闭预演'

# ------------------------------------------------------- 3. 对比内容是否真的写回
Say '3) 内容对比（证明文件内容真的进了项目）'
$reExported = Get-ChildItem $verifyDir -Recurse -Filter (Split-Path -Leaf $BlockXml) -File | Select-Object -First 1
if (-not $reExported) { Fail '重新导出的目录里找不到该块文件' $verifyDir }
else {
  $after = [regex]::Match((Get-Content $reExported.FullName -Raw), "<$Field>([^<]*)</$Field>")
  $afterValue = if ($after.Success) { $after.Groups[1].Value } else { '<缺失>' }
  Say "  <$Field>: 原始导出 '$beforeValue'  →  改后的文件 '$NewValue'  →  导入后重新导出 '$afterValue'"
  if ($afterValue -eq $NewValue) {
    Pass "改动被真正写进项目：重新导出的 <$Field> 等于新值 '$NewValue'"
  } else {
    Fail "重新导出的 <$Field> 是 '$afterValue'，不等于新值 '$NewValue'（改动未被应用/TIA 忽略了该字段）"
  }
  $diff = Compare-Object (Get-Content $BlockXml) (Get-Content $reExported.FullName)
  Info ("  与原始导出的差异行数: {0}" -f (@($diff).Count))
  foreach ($d in (@($diff) | Select-Object -First 6)) { Info ("    {0} {1}" -f $d.SideIndicator, "$($d.InputObject)".Trim()) }
}

Say ''
Say ("结果: {0}" -f $(if ($script:failures -eq 0) { '往返测试通过' } else { "$script:failures 项失败" }))
exit $(if ($script:failures -eq 0) { 0 } else { 1 })
