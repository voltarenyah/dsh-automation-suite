#!/usr/bin/env node
// Build a public, self-contained release folder for the dsh-automation-suite edition.
//
// Why a profile package instead of a single bundle: DSH has no "install a profile"
// command, and `dsh plugin add` only accepts bundles. A profile directory is
// package.json + cordis.patch.yml + pnpm-workspace.yaml, so a release can ship those
// three files plus an installer; the installer copies them into
// <DSH_HOME>/profiles/<name>/ and runs the profile's pnpm install.
//
// Plugin tarballs are published as GitHub Release assets and referenced as *direct*
// URL dependencies of the profile. Direct URL deps are allowed by pnpm 11; the same
// URLs nested inside an umbrella bundle are rejected (ERR_PNPM_EXOTIC_SUBDEP).
//
// Usage:
//   node scripts/build-distribution.mjs [--version 0.1.0] [--tag v0.1.0]
//        [--repo voltarenyah/dsh-automation-suite] [--out dist/release]
//        [--base-url <url>] [--no-pack] [--pnpm <path-to-pnpm.mjs>]
//        [--dotnet <path-to-dotnet>] [--no-self-contained]
//        [--min-dsh 0.2.1-rc.1] [--tested-dsh 0.2.1-rc.2]
//
// --base-url overrides the asset URL prefix (default: the GitHub Release URL).
// --no-pack reuses tarballs already present in <out>/<version>/assets.
// --dotnet selects the .NET 10 SDK used to build the self-contained graph engine.
// --no-self-contained packs the framework-dependent engine instead (developer
// testing only; users would then need the .NET 10 runtime).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (key === 'no-pack') {
      out.pack = false
      continue
    }
    if (key === 'no-self-contained') {
      out.selfContained = false
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    out[key] = value
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const blueprintDir = join(root, 'profile', 'dsh-automation-suite')
const blueprint = JSON.parse(readFileSync(join(blueprintDir, 'package.json'), 'utf8'))

// The distribution version is independent of the plugin versions. When --version
// is omitted, reuse the latest release tag instead of silently falling back to
// the blueprint's 0.1.0 (which would rebuild an already-published release).
function gitTags() {
  try {
    return execFileSync('git', ['tag', '--sort=-v:refname'], { cwd: root, encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    return []
  }
}
const tags = gitTags()
const latestTag = tags.find((name) => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(name))
const version = args.version ?? (latestTag === undefined ? undefined : latestTag.slice(1)) ?? blueprint.version ?? '0.1.0'
const tag = args.tag ?? `v${version}`

if (args.version === undefined && latestTag !== undefined) {
  process.stdout.write(`build-distribution: no --version; rebuilding latest tag ${latestTag}\n`)
}
if (tags.includes(`v${version}`)) {
  process.stdout.write(`build-distribution: note: tag v${version} already exists; a new release needs a new --version\n`)
}
// One profile per release, so installing a newer release never collides with the
// previous one (and a development profile of the same edition keeps the plain
// 'dsh-automation-suite' name).
const defaultProfile = `dsh-automation-suite-v${version}`
// A release-private DSH_HOME. Workspace lists, sessions, settings, and model
// credentials live under DSH_HOME, so sharing the everyday ~/.dsh would make the
// edition show (and write) the desktop app's workspace registry.
const defaultHomeName = 'dsh-automation-suite-home'
const repo = args.repo ?? 'voltarenyah/dsh-automation-suite'
const outRoot = resolve(root, args.out ?? 'dist/release')
const outDir = join(outRoot, version)
const assetsDir = join(outDir, 'assets')
const profileOut = join(outDir, 'profile')
const baseUrl = (args['base-url'] ?? `https://github.com/${repo}/releases/download/${tag}`).replace(/\/$/, '')
const doPack = args.pack !== false

// ---------------------------------------------------------------------------
// Local packages: map package name -> directory, from packages/*/package.json.
// ---------------------------------------------------------------------------
const packagesDir = join(root, 'packages')
const localPackages = new Map()
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const manifestPath = join(packagesDir, entry.name, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh?.bundle?.patch === undefined) continue
  localPackages.set(manifest.name, { dir: join(packagesDir, entry.name), manifest })
}

for (const name of Object.keys(blueprint.dependencies ?? {})) {
  const local = localPackages.get(name)
  if (local === undefined) continue
  if (!existsSync(join(local.dir, 'lib'))) {
    throw new Error(`${name} has no lib/: run the repo build first (pnpm -r build, or pwsh scripts/start-env.ps1 -SkipBuild:off)`)
  }
}

// ---------------------------------------------------------------------------
// pnpm discovery: PATH first, then the copy shipped inside the DSH installation.
// A .mjs file is run with the current Node; a bare command is used as-is.
// ---------------------------------------------------------------------------
function findPnpm() {
  if (args.pnpm !== undefined) return { command: process.execPath, prefix: [resolve(args.pnpm)] }
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: process.execPath, prefix: [candidate] }
  }
  return { command: 'pnpm', prefix: [] }
}

const pnpm = findPnpm()
function runPnpm(cwd, argv) {
  return execFileSync(pnpm.command, [...pnpm.prefix, ...argv], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_update_notifier: 'false' },
  })
}

// ---------------------------------------------------------------------------
// .NET 10 SDK discovery for the self-contained graph engine. Users must not
// install a .NET runtime for this plugin (TIA ships .NET Framework 4.8 and DSH
// ships Node, neither is a .NET 8/10 runtime), so the release tarball carries a
// self-contained win-x64 engine instead.
// ---------------------------------------------------------------------------
const doSelfContained = args.selfContained !== false
let dotnetPath
function findDotnet() {
  if (dotnetPath !== undefined) return dotnetPath
  const candidates = [
    args.dotnet,
    process.env.DOTNET_EXE,
    join(homedir(), '.dotnet10', 'dotnet.exe'),
    join(homedir(), '.dotnet10', 'dotnet'),
    'dotnet',
  ].filter((candidate) => candidate !== undefined && candidate !== '')
  const seen = new Set()
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    try {
      const sdks = execFileSync(candidate, ['--list-sdks'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (/^\s*10\./m.test(sdks)) {
        dotnetPath = candidate
        return dotnetPath
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    'the self-contained graph engine needs the .NET 10 SDK. Install it, put dotnet on PATH, ' +
      'or pass --dotnet <path-to-dotnet> (for a per-user install: %USERPROFILE%\\.dotnet10\\dotnet.exe). ' +
      'Use --no-self-contained only for local developer testing.',
  )
}

// ---------------------------------------------------------------------------
// 1. Pack every local bundle into assets/.
// ---------------------------------------------------------------------------
mkdirSync(profileOut, { recursive: true })

function packDirectory(dir) {
  const output = runPnpm(dir, ['pack', '--pack-destination', assetsDir, '--silent'])
  const printed = output.trim().split(/\r?\n/).filter(Boolean).at(-1)
  const filename = printed === undefined ? undefined : basename(printed)
  if (!filename || !existsSync(join(assetsDir, filename))) {
    throw new Error(`pnpm pack in ${dir} did not produce a tarball (output: ${JSON.stringify(output)})`)
  }
  return filename
}

// The shipped graph engine must run on a machine that has neither .NET 8 nor
// .NET 10: TIA Portal only provides .NET Framework 4.8, and the DSH runtime only
// provides Node. Pack a staging copy of the package whose engine/bin is a
// self-contained single-file win-x64 executable, so a normal user never installs
// a .NET runtime for this plugin. The repository keeps the small
// framework-dependent developer build in engine/bin.
function packGraphSelfContained(local) {
  const staging = join(outDir, '.pack-staging', 'dsh-engineering-graph')
  const bin = join(staging, 'engine', 'bin')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml', 'README.md']) {
    copyFileSync(join(local.dir, file), join(staging, file))
  }
  cpSync(join(local.dir, 'lib'), join(staging, 'lib'), { recursive: true })

  const dotnet = findDotnet()
  process.stdout.write('building self-contained graph engine ... ')
  try {
    execFileSync(
      dotnet,
      [
        'publish',
        join(local.dir, 'engine', 'EngineeringGraph.Engine.csproj'),
        '-c', 'Release',
        '-r', 'win-x64',
        '--self-contained', 'true',
        '-p:PublishSingleFile=true',
        '-p:IncludeNativeLibrariesForSelfExtract=true',
        '-p:EnableCompressionInSingleFile=true',
        '-p:DebugType=None',
        '-o', bin,
        '--nologo', '-v', 'minimal',
      ],
      { stdio: 'inherit', env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } },
    )
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`dotnet publish failed for the self-contained graph engine: ${error.message}`)
  }

  rmSync(join(bin, 'fixtures'), { recursive: true, force: true })
  rmSync(join(bin, 'EngineeringGraph.Engine.pdb'), { force: true })
  const exe = join(bin, 'EngineeringGraph.Engine.exe')
  if (!existsSync(exe)) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`the self-contained graph engine produced no executable at ${exe}`)
  }
  process.stdout.write(`(${Math.round(statSync(exe).size / (1024 * 1024))} MiB) `)
  try {
    return packDirectory(staging)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

const tarballs = new Map()
if (doPack) {
  rmSync(assetsDir, { recursive: true, force: true })
  mkdirSync(assetsDir, { recursive: true })
  for (const [name, local] of localPackages) {
    process.stdout.write(`packing ${name} ... `)
    const filename =
      doSelfContained && name === '@voltarenyah/dsh-engineering-graph'
        ? packGraphSelfContained(local)
        : packDirectory(local.dir)
    tarballs.set(name, filename)
    process.stdout.write(`${filename}\n`)
  }
} else {
  // --no-pack: recover filenames from the assets directory.
  for (const name of localPackages.keys()) {
    const prefix = name.replace(/^@/, '').replace('/', '-')
    const manifest = localPackages.get(name).manifest
    const expected = `${prefix}-${manifest.version}.tgz`
    if (!existsSync(join(assetsDir, expected))) throw new Error(`--no-pack: missing ${expected} in ${assetsDir}`)
    tarballs.set(name, expected)
  }
}

// ---------------------------------------------------------------------------
// 2. Profile manifest: same bundle order as the blueprint, URL deps for local
//    bundles, registry deps for anything public (dsh-opencode-go).
// ---------------------------------------------------------------------------
const profileDependencies = {}
for (const [name, recorded] of Object.entries(blueprint.dependencies ?? {})) {
  const filename = tarballs.get(name)
  profileDependencies[name] = filename === undefined ? recorded : `${baseUrl}/${filename}`
}

const profileManifest = {
  name: blueprint.name,
  private: true,
  description: blueprint.description,
  dependencies: profileDependencies,
  dsh: blueprint.dsh,
}
writeFileSync(join(profileOut, 'package.json'), `${JSON.stringify(profileManifest, undefined, 2)}\n`)

// Policy layer: copied verbatim; it is the whole point of the edition.
copyFileSync(join(blueprintDir, 'cordis.patch.yml'), join(profileOut, 'cordis.patch.yml'))

// pnpm settings the profile needs: hoisted linking (bundles resolve by package name)
// and an explicit decision for the two transitive build scripts.
const workspaceYaml = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

# pnpm 11 refuses the whole install (ERR_PNPM_IGNORED_BUILDS) when a transitive
# dependency has a build script without an explicit decision. These two are
# optional codegen/download steps in dsh-opencode-go's dependency tree.
allowBuilds:
  '@google/genai': false
  protobufjs: false
`
writeFileSync(join(profileOut, 'pnpm-workspace.yaml'), workspaceYaml)

// ---------------------------------------------------------------------------
// 3. manifest.json with checksums.
// ---------------------------------------------------------------------------
const assetRows = []
for (const filename of [...tarballs.values()].sort()) {
  const full = join(assetsDir, filename)
  const bytes = readFileSync(full)
  assetRows.push({
    file: filename,
    bytes: statSync(full).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}
const manifest = {
  name: profileManifest.name,
  version,
  tag,
  repo,
  baseUrl,
  minDshVersion: args['min-dsh'] ?? '0.2.1-rc.1',
  testedDshVersion: args['tested-dsh'] ?? '0.2.1-rc.2',
  engine: doSelfContained ? 'self-contained single-file win-x64' : 'framework-dependent (developer build)',
  doctor: 'doctor.ps1',
  generatedAt: new Date().toISOString(),
  profile: {
    dependencyCount: Object.keys(profileDependencies).length,
    bundles: blueprint.dsh?.profile?.bundles ?? [],
  },
  assets: assetRows,
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

// ---------------------------------------------------------------------------
// 4. install.ps1: copy the three profile files into DSH_HOME and install.
// ---------------------------------------------------------------------------
const installer = String.raw`# Install the dsh-automation-suite edition into an existing DeepSeek Harness install.
#
#   pwsh -NoProfile -File install.ps1
#   pwsh -NoProfile -File install.ps1 -Profile my-suite -DshHome C:\temp\dsh-home
#
# The profile is a normal DSH profile directory; nothing outside
# <DshHome>/profiles/<Profile>/ is written.
#
# The default DSH_HOME is a release-private directory
# (%USERPROFILE%\__HOME__), not the everyday ~/.dsh. Workspace
# lists, sessions, settings, and model credentials all live under DSH_HOME; a
# private home keeps this edition's workspace list free of the projects opened
# in the everyday DeepSeek Harness desktop app, and stops the two apps from
# writing the same workspace registry.
#
# The default profile name carries the release version (for example
# 'dsh-automation-suite-v0.1.1'), so:
#   - a development profile of the same edition (normally 'dsh-automation-suite'
#     in the isolated DSH_HOME used by scripts/start-env.ps1) can coexist, and
#   - installing a newer release never collides with an older one - each release
#     gets its own profile directory.
# Pass -Profile to use a stable name instead and upgrade it in place with
# -Force; the replaced profile's package.json and cordis.patch.yml are backed up
# next to them before they are overwritten. A junction/symlink is always
# refused, because writing through one would modify whatever it points at.
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '__HOME__'),
  [string]$Profile = '__PROFILE__',
  [string]$DshExe = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
$source = Join-Path $here 'profile'
$version = '__VERSION__'
$repo = '__REPO__'

if (-not (Test-Path (Join-Path $source 'package.json'))) {
  throw "install.ps1 must stay next to its profile/ folder (expected $source)"
}

if (-not $DshExe) {
  $candidates = @()
  if ($env:DSH_EXE) { $candidates += $env:DSH_EXE }
  $appRoots = @()
  if ($env:DSH_APP_ROOT) { $appRoots += $env:DSH_APP_ROOT }
  $appRoots += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')
  foreach ($appRoot in $appRoots) {
    $candidates += (Join-Path $appRoot 'resources\runtime\cli\bin\dsh.cmd')
  }
  $onPath = Get-Command dsh -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  $DshExe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $DshExe) {
  throw 'cannot find dsh. Pass -DshExe <path\to\dsh.cmd> or set DSH_EXE.'
}

$profileDir = Join-Path $DshHome "profiles\$Profile"
$existing = Get-Item -LiteralPath $profileDir -Force -ErrorAction SilentlyContinue
if ($existing) {
  if (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    $target = if ($existing.Target) { $existing.Target -join ', ' } else { 'unknown target' }
    $hint = 'Remove the link first with: cmd /c rmdir "' + $profileDir + '"'
    throw ('refusing to install into ' + $profileDir + ': it is a junction/symlink (-> ' + $target + '). ' +
      'Writing through it would modify another directory. ' + $hint + ', or choose another -Profile.')
  }
  if (-not $Force) {
    throw ("profile '" + $Profile + "' already exists at " + $profileDir + '. ' +
      'Release profiles are versioned by default, so installing another release does not collide; ' +
      'pick another name with -Profile <name>, or pass -Force to replace this profile - ' +
      'its package.json and cordis.patch.yml are backed up first, but profile-local settings still take effect from the new files.')
  }
  # Keep the previous manifests recoverable before the new release overwrites them.
  # Model credentials live in <DshHome>/.credentials.yaml, not in the profile.
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($name in @('package.json', 'cordis.patch.yml')) {
    $path = Join-Path $profileDir $name
    if (Test-Path $path) {
      Copy-Item -LiteralPath $path -Destination ($path + '.bak-' + $stamp) -Force
    }
  }
  # The profile may contain junctions owned by pnpm; remove only the files this
  # installer owns and let pnpm prune the rest. Never delete the directory itself
  # with a recursive delete.
  Get-ChildItem -LiteralPath $profileDir -File -Force |
    Where-Object { $_.Name -in @('package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml') } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
} else {
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
}

Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $profileDir -Force
Copy-Item -LiteralPath (Join-Path $source 'cordis.patch.yml') -Destination $profileDir -Force
Copy-Item -LiteralPath (Join-Path $source 'pnpm-workspace.yaml') -Destination $profileDir -Force

Write-Host "dsh-automation-suite $version -> $profileDir"
Write-Host "installing plugin tarballs (first run downloads them from the $repo release) ..."
$env:DSH_HOME = $DshHome
& $DshExe plugin --profile $Profile install
if ($LASTEXITCODE -ne 0) { throw "dsh plugin install failed with exit code $LASTEXITCODE" }

# Remember where this copy was installed so start.ps1 needs no arguments.
# It lives next to install.ps1 in the extracted release folder.
try {
  $state = [ordered]@{ dshHome = $DshHome; profile = $Profile; dshExe = $DshExe } | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $here 'install.json') -Value $state -Encoding utf8
} catch {
  Write-Host ('warning: could not write install.json next to install.ps1: ' + $_.Exception.Message)
}

Write-Host ''
Write-Host 'installed. start it with:'
Write-Host ('  "' + $here + '\start.cmd"')
Write-Host '(or: start.cmd -DshHome ... -Profile ... to override; start.ps1 accepts -Port / -NoOpen)'
Write-Host ''
Write-Host ('upgrade this same profile later with: install.ps1 -Profile ' + $Profile + ' -Force')

# Report capability gaps now, not the first time a TIA/graph/git tool is called.
# Warnings do not fail the install; a hard failure means the profile will not load.
$doctor = Join-Path $here 'doctor.ps1'
if (Test-Path -LiteralPath $doctor) {
  Write-Host ''
  & $doctor -DshHome $DshHome -Profile $Profile -DshExe $DshExe
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'doctor reported a fatal problem; fix it before starting the app.'
  }
}
`
writeFileSync(join(outDir, 'install.ps1'), installer.replace('__VERSION__', version).replace('__REPO__', repo).replaceAll('__PROFILE__', defaultProfile).replaceAll('__HOME__', defaultHomeName))

// Double-clickable entry point. Files extracted from a downloaded zip carry the
// mark-of-the-web (ZoneId=3), and the default RemoteSigned execution policy then
// refuses the unsigned install.ps1 with "cannot be loaded ... not digitally
// signed" - the window closes before anyone can read it. A .cmd is not subject to
// the execution policy, so this wrapper runs the script with -ExecutionPolicy
// Bypass (leaving the machine-wide policy untouched) and pauses at the end.
const installerCmd = String.raw`@echo off
setlocal
rem Double-click this file to install. It runs install.ps1 with a per-process
rem execution-policy bypass, then keeps the window open so errors stay readable.
set "PS=powershell"
where pwsh >nul 2>nul
if %errorlevel%==0 set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "CODE=%errorlevel%"
echo.
if not "%CODE%"=="0" echo install failed with exit code %CODE%.
pause
exit /b %CODE%
`
writeFileSync(join(outDir, 'install.cmd'), installerCmd)

// doctor.ps1 is copied from the repository; doctor.cmd makes it double-clickable
// (same MOTW/execution-policy wrapper as install.cmd). install.ps1 runs the same
// script at the end, so there is one implementation, not one per entry point.
copyFileSync(join(root, 'scripts', 'doctor.ps1'), join(outDir, 'doctor.ps1'))
const doctorCmd = String.raw`@echo off
setlocal
rem Double-click to re-check which capabilities this machine has.
set "PS=powershell"
where pwsh >nul 2>nul
if %errorlevel%==0 set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor.ps1" %*
set "CODE=%errorlevel%"
echo.
pause
exit /b %CODE%
`
writeFileSync(join(outDir, 'doctor.cmd'), doctorCmd)

// start.ps1 / start.cmd: launch the installed release with its own DSH_HOME and
// a free port. install.json (written by install.ps1) records the chosen home and
// profile, so the double-click entry point needs no arguments.
const starter = String.raw`# Start the installed dsh-automation-suite release.
#
#   start.cmd                  double-click; picks a free port
#   start.cmd -NoOpen          do not open a browser
#   start.cmd -Port 3093       pin the port
#
# install.json, written by install.ps1, records the DSH_HOME and profile this
# copy was installed with; -DshHome / -Profile override them.
param(
  [string]$DshHome = '',
  [string]$Profile = '',
  [int]$Port = 0,
  [switch]$NoOpen,
  [string]$DshExe = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath

$state = $null
$statePath = Join-Path $here 'install.json'
if (Test-Path $statePath) {
  try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { }
}
if (-not $DshHome -and $state) { $DshHome = $state.dshHome }
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '__HOME__' }
if (-not $Profile -and $state) { $Profile = $state.profile }
if (-not $Profile) { $Profile = '__PROFILE__' }

if (-not (Test-Path (Join-Path $DshHome "profiles\$Profile\package.json"))) {
  throw "profile '$Profile' is not installed under '$DshHome'. Run install.cmd first, or pass -DshHome/-Profile."
}

# Same resolution order as install.ps1: explicit/env, shipped installation, PATH.
if (-not $DshExe) {
  $candidates = @()
  if ($env:DSH_EXE) { $candidates += $env:DSH_EXE }
  $appRoots = @()
  if ($env:DSH_APP_ROOT) { $appRoots += $env:DSH_APP_ROOT }
  $appRoots += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')
  foreach ($appRoot in $appRoots) {
    $candidates += (Join-Path $appRoot 'resources\runtime\cli\bin\dsh.cmd')
  }
  $onPath = Get-Command dsh -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  $DshExe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $DshExe) { throw 'cannot find dsh. Pass -DshExe <path\to\dsh.cmd> or set DSH_EXE.' }

# DSH's web server defaults to 3080, which is taken on some machines (for
# example by the Windows IP Helper service), so pick a free port unless pinned.
if ($Port -le 0) {
  $candidate = 3093
  while ($candidate -lt 3200) {
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
      $listener.Start()
      $listener.Stop()
      break
    } catch {
      $candidate += 1
    }
  }
  if ($candidate -ge 3200) { $candidate = 0 }
  $Port = $candidate
}

$env:DSH_HOME = $DshHome
Write-Host "dsh-automation-suite $Profile"
Write-Host "  DSH_HOME = $DshHome"
Write-Host "  port     = $Port"
$launchArgs = @('--profile', $Profile, '--port', "$Port")
if ($NoOpen) { $launchArgs += '--no-open' }
& $DshExe @launchArgs
exit $LASTEXITCODE
`
writeFileSync(join(outDir, 'start.ps1'), starter.replaceAll('__HOME__', defaultHomeName).replaceAll('__PROFILE__', defaultProfile))

const starterCmd = String.raw`@echo off
setlocal
rem Double-click to start the installed release with its own DSH_HOME and a free
rem port. The per-process execution-policy bypass avoids the mark-of-the-web
rem block on start.ps1; errors keep the window open.
set "PS=powershell"
where pwsh >nul 2>nul
if %errorlevel%==0 set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
`
writeFileSync(join(outDir, 'start.cmd'), starterCmd)

// ---------------------------------------------------------------------------
// 5. Report.
// ---------------------------------------------------------------------------
process.stdout.write(`\nrelease ${version} built at ${outDir}\n`)
process.stdout.write(`  base URL: ${baseUrl}\n`)
process.stdout.write(`  assets:   ${assetRows.length} tarballs (${(assetRows.reduce((n, row) => n + row.bytes, 0) / 1024 / 1024).toFixed(1)} MiB)\n`)
process.stdout.write(`  profile:  ${Object.keys(profileDependencies).length} dependencies\n`)
process.stdout.write('\nnext: upload assets/ + install.ps1 + profile/ to the GitHub release,\n')
process.stdout.write('or run install.ps1 directly from this folder.\n')


