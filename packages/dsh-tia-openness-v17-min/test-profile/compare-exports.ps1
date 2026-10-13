<#
.SYNOPSIS
  把"本插件用 Openness 导出的块"与"另一个导出工具（AutomationWorkbench）导出的源码树"做交叉比对。

.DESCRIPTION
  输入两侧：
    -Mine  本插件的导出目录（必须含 _tia-openness-manifest.json）
    -Other   另一个导出工具的 devices\<device>\source 目录（含 metadata.json + Blocks/ + DB/ + UDT/ + Tags/）

  输出：规模对比、按类别统计、B 侧导出失败清单、双向差集（我有它没有 / 它有我没有）、以及缺口归类。
  只打印聚合与封顶清单，不会把 metadata 整份刷出来。

.EXAMPLE
  pwsh -NoProfile -File test-profile\compare-with-Other.ps1 `
    -Mine 'C:\Users\Ansel\Documents\Automation\V17\PEI_SinoARP_Master_V4.1.3\UserFiles' `
    -Other  'C:\Users\Ansel\AppData\Local\AutomationWorkbench\Project\Fix PEI Import Error\worktrees\master\devices\Sino_PEI\source'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Mine,
  [Parameter(Mandatory = $true)][string]$other,
  [int]$MaxList = 40,
  [int]$ContentSample = 0,
  [string]$Report = ''
)

$ErrorActionPreference = 'Stop'
$out = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Host $t; $out.Add($t) }
function Key([string]$n) { if ($null -eq $n) { return '' } return $n.Trim().ToLowerInvariant() }

# ---------------------------------------------------------------- 我的导出（A）
$mineManifest = Join-Path $Mine '_tia-openness-manifest.json'
if (-not (Test-Path $mineManifest)) { throw "找不到我的 manifest: $mineManifest" }
$M = Get-Content $mineManifest -Raw | ConvertFrom-Json
$mineByName = @{}
$mineByTypeNum = @{}
foreach ($b in $M.blocks) {
  $k = Key $b.name
  if ($k -and -not $mineByName.ContainsKey($k)) { $mineByName[$k] = $b }
  if ($b.declaredNumber -and $b.simaticType) { $tn = Key ("$($b.simaticType)#$($b.declaredNumber)"); if (-not $mineByTypeNum.ContainsKey($tn)) { $mineByTypeNum[$tn] = $b } }
}
$mineRefused = @{}
if ($M.failures) { foreach ($f in $M.failures) { $mineRefused[(Key $f.name)] = ("$($f.message)" -replace "`r?`n", ' | ') } }

Say '=== A) 本插件（Openness ExportBlocks）==='
Say ("  目录: $Mine")
Say ("  项目/PLC: $($M.software)   导出块: $($M.blockCount)   拒绝: $($M.failureCount)   生成时间: $($M.generatedAt)")
if ($M.failureCount -gt 0) {
  Say '  被 Openness 拒绝（无 Simatic ML 表示）:'
  foreach ($f in $M.failures) { Say ("    - $($f.name): " + (($f.message -split "`n" | Where-Object { $_ -match 'permitted|not supported|language' }) -join ' ')) }
}

# ---------------------------------------------------------------- B 侧（B）
$otherMeta = Join-Path $other 'metadata.json'
if (-not (Test-Path $otherMeta)) { throw "找不到 B 侧 metadata: $otherMeta" }
$V = Get-Content $otherMeta -Raw | ConvertFrom-Json
# metadata.json 的顶层键名不固定：找出那个"对象数组"属性
$entries = $null
foreach ($p in $V.PSObject.Properties) {
  if ($p.Value -is [System.Array] -and $p.Value.Count -gt 0 -and $p.Value[0].PSObject.Properties.Name -contains 'name') { $entries = $p.Value; break }
}
if (-not $entries) { throw 'metadata.json 里找不到对象数组（含 name 属性）' }

$otherByFolder = $entries | Group-Object folder | Sort-Object Count -Descending
Say ''
Say '=== B) TIA 版本控制接口（B 侧 / AutomationWorkbench）==='
Say ("  目录: $other")
Say ("  对象总数: $($entries.Count)   文件总数: $((Get-ChildItem $other -Recurse -File | Measure-Object).Count)")
foreach ($g in $otherByFolder) { Say ("    文件夹 {0,-8} {1,6} 个对象" -f $g.Name, $g.Count) }
$statusHist = $entries | Group-Object status | Sort-Object Count -Descending
Say '  导出状态分布:'
foreach ($g in $statusHist) { Say ("    {0,-12} {1,6}" -f $g.Name, $g.Count) }

$otherFailed = @($entries | Where-Object { $_.status -ne 'Exported' -or ($_.message -and "$($_.message)".Trim().Length -gt 0) })
Say ("  B 侧未导出的对象: $($otherFailed.Count)")
foreach ($f in ($otherFailed | Select-Object -First $MaxList)) {
  Say ("    - {0} [{1}] ({2}/{3}): {4}" -f $f.name, $f.siemensTypeName, $f.folder, $f.category, ("$($f.message)" -replace "`r?`n", ' | '))
}
if ($otherFailed.Count -gt $MaxList) { Say "    … 其余 $($otherFailed.Count - $MaxList) 项省略" }

# ------------------------------------------------- 只比较"块类"（Blocks + DB）
$otherBlockLike = @($entries | Where-Object { $_.folder -in @('Blocks', 'DB') })
$otherBlocksOnly = @($entries | Where-Object { $_.folder -eq 'Blocks' })
$otherDbOnly = @($entries | Where-Object { $_.folder -eq 'DB' })
Say ''
Say '=== C) 块类对比（A 的块 vs B 的 Blocks+DB）==='
Say ("  A: $($M.blockCount) 个块（含 DB）；B: $($otherBlockLike.Count) 个块类对象（Blocks $($otherBlocksOnly.Count) + DB $($otherDbOnly.Count)）")
$otherByName = @{}
foreach ($e in $otherBlockLike) { $k = Key $e.name; if ($k -and -not $otherByName.ContainsKey($k)) { $otherByName[$k] = $e } }

$onlyMine = @(); $onlyOther = @(); $both = 0
foreach ($k in $mineByName.Keys) { if ($otherByName.ContainsKey($k)) { $both++ } else { $onlyMine += $mineByName[$k] } }
foreach ($k in $otherByName.Keys) { if (-not $mineByName.ContainsKey($k)) { $onlyOther += $otherByName[$k] } }
Say ("  交集: $both   仅 A 有: $($onlyMine.Count)   仅 B 有: $($onlyOther.Count)")

Say ''
Say "  --- 仅 A 有（我导出了、B 侧没有）: $($onlyMine.Count) ---"
$otherAllByName = @{}
foreach ($e in $entries) { $k = Key $e.name; if ($k -and -not $otherAllByName.ContainsKey($k)) { $otherAllByName[$k] = $e } }
foreach ($b in ($onlyMine | Sort-Object name | Select-Object -First $MaxList)) {
  $k = Key $b.name
  $explain = 'B 侧完全没有这个对象'
  if ($otherAllByName.ContainsKey($k)) {
    $e = $otherAllByName[$k]
    $explain = "B 侧存在但 status=$($e.status) folder=$($e.folder) message=$("$($e.message)" -replace "`r?`n",' | ')"
  }
  Say ("    {0}  [{1} #{2} {3}]  → {4}" -f $b.name, $b.simaticType, $b.declaredNumber, $b.programmingLanguage, $explain)
}
if ($onlyMine.Count -gt $MaxList) { Say "    … 其余 $($onlyMine.Count - $MaxList) 项省略" }

Say ''
Say "  --- 仅 B 有（B 侧有、我没有）: $($onlyOther.Count) ---"
$nonBlockFolders = @($onlyOther | Group-Object folder | Sort-Object Count -Descending)
foreach ($g in $nonBlockFolders) { Say ("    按 B 侧 folder 统计: {0} = {1}" -f $g.Name, $g.Count) }
foreach ($e in ($onlyOther | Sort-Object name | Select-Object -First $MaxList)) {
  $k = Key $e.name
  $explain = ''
  if ($mineRefused.ContainsKey($k)) { $explain = '我这边被 Openness 拒绝: ' + $mineRefused[$k] }
  elseif ($e.folder -eq 'UDT') { $explain = 'UDT（PLC 类型）—— 本插件不导出类型，只导出块' }
  elseif ($e.folder -eq 'Tags') { $explain = '标签表 —— 本插件不涉及' }
  else { $explain = '块类但 A 未导出（需人工确认原因）' }
  Say ("    {0}  [{1} #{2}]  → {3}" -f $e.name, $e.siemensTypeName, $e.number, $explain)
}
if ($onlyOther.Count -gt $MaxList) { Say "    … 其余 $($onlyOther.Count - $MaxList) 项省略" }

# ------------------------------------------------------------- D) UDT / Tags
$udt = @($entries | Where-Object { $_.folder -eq 'UDT' })
$tags = @($entries | Where-Object { $_.folder -eq 'Tags' })
Say ''
Say '=== D) 我这边完全没有的类别（能力缺口）==='
Say ("  UDT/PLC 类型: $($udt.Count) 个（B 侧有，本插件不导出 —— PlcSoftware.TypeGroup 未实现）")
Say ("  标签表:      $($tags.Count) 个（B 侧有，本插件不涉及）")
if ($udt.Count -gt 0) { Say ("    UDT 示例: " + (($udt | Sort-Object name | Select-Object -First 8 | ForEach-Object { $_.name }) -join ', ')) }
if ($tags.Count -gt 0) { Say ("    标签表示例: " + (($tags | Sort-Object name | Select-Object -First 8 | ForEach-Object { $_.name }) -join ', ')) }

# ------------------------------------------------------- E) 按编程语言统计
Say ''
Say '=== E) 我的导出按编程语言统计（看清"多出来的块"是什么）==='
$langHist = $M.blocks | Group-Object programmingLanguage | Sort-Object Count -Descending
foreach ($g in $langHist) { Say ("    {0,-14} {1,5}" -f $(if ($g.Name) { $g.Name } else { '(未标注)' }), $g.Count) }
$fLangs = @($M.blocks | Where-Object { $_.programmingLanguage -like 'F_*' })
Say ("    其中 Safety(F-)语言块: $($fLangs.Count) 个（" + (($fLangs | Group-Object programmingLanguage | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ', ') + "）")
Say ("    B 侧块类对象: $($otherBlockLike.Count) 个 → 差值 $($M.blockCount - $otherBlockLike.Count)")
$onlyMineF = @($onlyMine | Where-Object { $_.programmingLanguage -like 'F_*' })
Say ("    仅 A 有的 $($onlyMine.Count) 个块里，Safety(F-)语言占: $($onlyMineF.Count) 个")

# ------------------------------------------------------- F) 同一块的内容对比
if ($ContentSample -gt 0) {
  Say ''
  Say "=== F) 同一块的内容对比（抽样 $ContentSample 个共有块）==="
  $shared = @($mineByName.Values | Where-Object { $otherByName.ContainsKey((Key $_.name)) } | Sort-Object name)
  $step = [Math]::Max(1, [int]($shared.Count / $ContentSample))
  $picked = @(); for ($i = 0; $i -lt $shared.Count -and $picked.Count -lt $ContentSample; $i += $step) { $picked += $shared[$i] }
  foreach ($b in $picked) {
    $e = $otherByName[(Key $b.name)]
    $otherFile = Join-Path $other ($e.exportedFile -replace '/', '\')
    # B 侧文件名带 [FB106] 这类后缀，PowerShell 会把 [] 当通配符字符类，
    # 所以这里必须用 -LiteralPath。
    if (-not (Test-Path -LiteralPath $otherFile)) { Say ("  {0}: B 侧文件缺失 {1}" -f $b.name, $otherFile); continue }
    $mineLines = @(Get-Content -LiteralPath $b.file)
    $otherLines = @(Get-Content -LiteralPath $otherFile)
    $diff = @(Compare-Object $mineLines $otherLines)
    Say ("  {0,-34} 我 {1,8} B/{2,5} 行   B 侧 {3,8} B/{4,5} 行   差异行 {5}" -f `
        $b.name, (Get-Item -LiteralPath $b.file).Length, $mineLines.Count, (Get-Item -LiteralPath $otherFile).Length, $otherLines.Count, $diff.Count)
    foreach ($tag in @('<Engineering version', '<ExportSetting', '<Created>', '<InstalledProducts', '<Name>', '<ProgrammingLanguage', '<Number>', '<Comment>', '<Title>')) {
      $mh = @($mineLines | Select-String -SimpleMatch $tag).Count
      $vh = @($otherLines | Select-String -SimpleMatch $tag).Count
      if ($mh -ne $vh) { Say ("        仅出现次数不同: {0}  我 {1} / B 侧 {2}" -f $tag, $mh, $vh) }
    }
    foreach ($d in (@($diff) | Select-Object -First 4)) {
      $line = "$($d.InputObject)".Trim(); if ($line.Length -gt 150) { $line = $line.Substring(0, 150) + '…' }
      Say ("        {0} {1}" -f $d.SideIndicator, $line)
    }
  }
}

if ($Report) { $out -join "`n" | Set-Content -Path $Report -Encoding utf8; Say ''; Say "报告已写入: $Report" }
