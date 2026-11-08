$ErrorActionPreference = 'Stop'
$out = Join-Path $env:USERPROFILE 'dsh-sandbox-output'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$feedUrl = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml'
$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri $feedUrl
$text = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
$version = [regex]::Match($text, '(?m)^version:\s*([^\r\n]+)').Groups[1].Value.Trim()
$url = [regex]::Match($text, 'url:\s*(?:>-)?\s*\r?\n?\s*(https://\S+)').Groups[1].Value.Trim()
$sha512 = [regex]::Match($text, 'sha512:\s*(?:>-)?\s*\r?\n?\s*([^\s]+)').Groups[1].Value.Trim()
$size = [regex]::Match($text, 'size:\s*(\d+)').Groups[1].Value.Trim()
if (-not $version -or -not $url) { throw 'feed parse failed' }
$target = Join-Path $out 'dsh-official-setup.exe'
Write-Host "downloading $version -> $target"
Invoke-WebRequest -UseBasicParsing -TimeoutSec 1800 -Uri $url -OutFile $target
$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA512).Hash
$bytes = New-Object byte[] ($hash.Length / 2)
for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hash.Substring($i * 2, 2), 16) }
$actual = [Convert]::ToBase64String($bytes)
if ($sha512 -and $actual -ne $sha512) { throw 'sha512 mismatch' }
[ordered]@{ version=$version; url=$url; size=if($size){[long]$size}else{(Get-Item $target).Length}; sha512=$sha512; file='dsh-official-setup.exe'; fetchedAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content (Join-Path $out 'dsh-feed.json') -Encoding utf8
Write-Host ("ready: {0:N1} MiB" -f ((Get-Item $target).Length / 1MB))
