# Generates a LAD reading question set with ground truth from a knowledge database.
#
# The answers are computed from the database the tools serve (ladderText, accesses), so the set is
# reproducible and does not depend on a human writing expected answers. Scoring is separate: see
# score.md in this directory.
#
#   pwsh -NoProfile -File scripts/eval/lad-qa/generate.ps1 -Database <db> -Out <questions.json> -Limit 60
param(
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Limit = 60,
    [string]$Engine = ''
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Database)) { throw "database not found: $Database" }

if ([string]::IsNullOrWhiteSpace($Engine)) {
    $candidate = Join-Path $PSScriptRoot '..\..\..\packages\dsh-engineering-graph\engine\bin\EngineeringGraph.Engine.dll'
    $Engine = (Resolve-Path -LiteralPath $candidate).Path
}

$dotnet = if ($env:DOTNET_ROOT -and (Test-Path "$env:DOTNET_ROOT\dotnet.exe")) { "$env:DOTNET_ROOT\dotnet.exe" } else { 'dotnet' }

function Invoke-Sql([string]$Sql) {
    $json = @{ dbPath = $Database; sql = $Sql } | ConvertTo-Json -Compress
    $frame = & $dotnet $Engine --call Query $json 2>&1 | Out-String
    $parsed = $frame | ConvertFrom-Json
    if (-not $parsed.ok) { throw "query failed: $($parsed.error.message)" }
    return $parsed.data.rows
}

# ---------------------------------------------------------------- coil conditions
$networks = Invoke-Sql @"
SELECT n.block_id, n.network_index, p.value
FROM knowledge_networks n
JOIN graph_node_properties p ON p.node_id = n.network_id
WHERE p.name = 'ladderText'
ORDER BY n.block_id, n.network_index
"@

$questions = New-Object System.Collections.ArrayList

foreach ($row in $networks) {
    if ($questions.Count -ge $Limit) { break }
    $blockId = [string]$row[0]
    $index = [int]$row[1]
    $text = [string]$row[2]

    # One line per path: "<marker> <coil>   <-  <condition>".
    $byCoil = @{}
    foreach ($line in ($text -split "`n")) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0) { continue }
        $parts = $trimmed -split '\s+<-\s+', 2
        if ($parts.Count -ne 2) { continue }
        $left = $parts[0]
        $condition = $parts[1]
        $tokens = $left -split '\s+', 2
        if ($tokens.Count -ne 2) { continue }
        $marker = $tokens[0]
        $coil = $tokens[1]
        if ($marker -notmatch '^\(') { continue }
        if (-not $byCoil.ContainsKey($coil)) { $byCoil[$coil] = New-Object System.Collections.ArrayList }
        [void]$byCoil[$coil].Add($condition)
    }

    foreach ($coil in ($byCoil.Keys | Sort-Object)) {
        if ($questions.Count -ge $Limit) { break }
        # Skip networks whose condition contains an opaque step ("[Move]", "[Eq]", "[Call]"):
        # its real condition lives in another network, so a string answer would be misleading.
        $opaque = ($byCoil[$coil] | Where-Object { $_ -match '\[' }).Count -gt 0
        if ($opaque) { continue }
        # More than six alternatives is a reading exercise in itself, not a check of understanding.
        if ($byCoil[$coil].Count -gt 6) { continue }
        [void]$questions.Add([ordered]@{
            id       = "cond-$($questions.Count + 1)"
            type     = 'condition'
            block    = $blockId
            network  = $index
            question = "In $blockId network ${index}, under what condition is '$coil' written? Give the alternatives exactly."
            answer   = @($byCoil[$coil])
        })
    }
}

# ---------------------------------------------------------------- writers per variable
$writes = Invoke-Sql @"
SELECT a.variable_name, w.block_id, w.network_index
FROM knowledge_network_accesses a
JOIN knowledge_networks w ON w.network_id = a.network_id
WHERE a.access = 'WRITES'
ORDER BY a.variable_name, w.block_id, w.network_index
"@

$byVariable = @{}
foreach ($row in $writes) {
    $name = [string]$row[0]
    if (-not $byVariable.ContainsKey($name)) { $byVariable[$name] = New-Object System.Collections.ArrayList }
    [void]$byVariable[$name].Add("$($row[1])#$($row[2])")
}

foreach ($name in ($byVariable.Keys | Sort-Object)) {
    if ($questions.Count -ge $Limit * 2) { break }
    $sites = @($byVariable[$name] | Sort-Object -Unique)
    [void]$questions.Add([ordered]@{
        id       = "write-$($questions.Count + 1)"
        type     = 'writers'
        variable = $name
        question = "Which network(s) write '$name' in this project? Answer with the block and network index."
        answer   = $sites
    })
}

$document = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    database    = $Database
    count       = $questions.Count
    questions   = $questions
}
$document | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Out -Encoding utf8
"wrote $($questions.Count) question(s) to $Out"
