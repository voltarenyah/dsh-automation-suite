# Validates the doctor.ps1 JSON contract. Run before packaging a desktop build.
#
#   pwsh -NoProfile -File scripts/test-doctor-json.ps1 -DshHome <home> -Profile <profile>
#
# It is deliberately strict: the installer and shell parse this output, so a
# human-readable line on stdout is a contract break, not a cosmetic issue.
[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$Profile = '',
    [string]$DshExe = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
$doctor = Join-Path $here 'doctor.ps1'

if (-not (Test-Path -LiteralPath $doctor)) {
    throw "doctor.ps1 not found next to this test: $doctor"
}

$args = @('-NoProfile', '-File', $doctor, '-Json', '-NoFail')
if ($DshHome) { $args += @('-DshHome', $DshHome) }
if ($Profile) { $args += @('-Profile', $Profile) }
if ($DshExe) { $args += @('-DshExe', $DshExe) }

$output = & pwsh @args 2>&1
$text = ($output | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    Write-Error "doctor -Json exited $LASTEXITCODE`n$text"
}

try {
    $report = $text | ConvertFrom-Json
}
catch {
    Write-Error "doctor -Json did not emit pure JSON: $($_.Exception.Message)`n--- output ---`n$text"
}

$errors = @()
if ($report.schemaVersion -ne 1) { $errors += "schemaVersion must be 1, got '$($report.schemaVersion)'" }
if (-not $report.generatedAt) { $errors += 'generatedAt is missing' }
if (-not $report.dshHome) { $errors += 'dshHome is missing' }
if (-not $report.profile) { $errors += 'profile is missing' }
if ($null -eq $report.results -or @($report.results).Count -eq 0) {
    $errors += 'results must be a non-empty array'
}
else {
    foreach ($result in @($report.results)) {
        if (-not $result.id) { $errors += 'a result is missing id' }
        if (-not $result.capability) { $errors += "result $($result.id) is missing capability" }
        if ($result.status -notin @('ok', 'warn', 'fail')) {
            $errors += "result $($result.id) has invalid status '$($result.status)'"
        }
        if ($null -eq $result.detail) { $errors += "result $($result.id) is missing detail" }
    }
}
if ($null -eq $report.summary) {
    $errors += 'summary is missing'
}
else {
    foreach ($key in @('ok', 'warn', 'fail')) {
        if ($null -eq $report.summary.$key) { $errors += "summary.$key is missing" }
    }
}

if ($errors.Count -gt 0) {
    Write-Host 'doctor JSON contract: FAIL'
    $errors | ForEach-Object { Write-Host "  - $_" }
    exit 1
}

Write-Host ("doctor JSON contract: OK ({0} ok, {1} warn, {2} fail; schema v{3})" -f `
    $report.summary.ok, $report.summary.warn, $report.summary.fail, $report.schemaVersion)
exit 0
