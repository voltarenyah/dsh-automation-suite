# LAD 语料文本级普查（阶段 0）。
#
# 只做正则计数，不解析 XML 结构：用于判断"真实语料里有哪些元素与连线"，
# 不用于逻辑正确性判断。结构级分类由阶段 1/2 的 C# 解析完成。
#
#   pwsh -NoProfile -File scripts/research/lad-census.ps1 -Root <导出根目录> -Name <标签>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Name
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Root)) { throw "root not found: $Root" }

$files = Get-ChildItem -LiteralPath $Root -Recurse -Filter *.xml -File | Sort-Object FullName
$parts = @{}; $wires = @{}; $scopes = @{}; $tv = @{}; $lang = @{}
$negated = 0; $calls = 0; $compileUnits = 0

foreach ($f in $files) {
    $s = [IO.File]::ReadAllText($f.FullName)
    foreach ($m in [regex]::Matches($s, '<Part Name="([^"]+)"')) { $parts[$m.Groups[1].Value]++ }
    foreach ($m in [regex]::Matches($s, '<(IdentCon|NameCon|OpenCon|Powerrail)\b')) { $wires[$m.Groups[1].Value]++ }
    foreach ($m in [regex]::Matches($s, 'Scope="([A-Za-z]+)"')) { $scopes[$m.Groups[1].Value]++ }
    foreach ($m in [regex]::Matches($s, '<TemplateValue Name="([^"]+)"')) { $tv[$m.Groups[1].Value]++ }
    foreach ($m in [regex]::Matches($s, '<ProgrammingLanguage>([A-Za-z_]+)</ProgrammingLanguage>')) { $lang[$m.Groups[1].Value]++ }
    $negated += ([regex]::Matches($s, '<Negated ')).Count
    $calls += ([regex]::Matches($s, '<Call ')).Count
    $compileUnits += ([regex]::Matches($s, '<SW\.Blocks\.CompileUnit ')).Count
}

"== $Name : xml=$($files.Count) compileUnits=$compileUnits calls=$calls negated=$negated"
# 排序必须是确定的：计数降序，计数相同时名称升序（哈希表枚举顺序不稳定）。
function Show-Counts($title, $table, [switch]$ByCount) {
    $title
    $rows = $table.GetEnumerator() | ForEach-Object { [pscustomobject]@{ K = [string]$_.Key; V = [int]$_.Value } }
    if ($ByCount) { $rows = $rows | Sort-Object -Property @{ Expression = 'V'; Descending = $true }, @{ Expression = 'K'; Descending = $false } }
    else { $rows = $rows | Sort-Object -Property K }
    foreach ($r in $rows) { "  $($r.K)=$($r.V)" }
}
Show-Counts 'languages:' $lang -ByCount
Show-Counts 'parts:' $parts -ByCount
Show-Counts 'wire tags:' $wires
Show-Counts 'scopes:' $scopes
Show-Counts 'templateValues:' $tv
