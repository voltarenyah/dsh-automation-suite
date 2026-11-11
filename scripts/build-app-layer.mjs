#!/usr/bin/env node
// Build a materialized desktop app layer from the current workspace.
//
// The web release ships a profile whose dependencies are GitHub tarball URLs and
// runs `pnpm install` on the user's machine. The desktop installer must not run
// pnpm or reach the npm registry at install time, so this script produces:
//
//   dist/desktop/<version>/app/
//     profile/              package.json + cordis.patch.yml + node_modules/
//     doctor.ps1
//     manifest.json         (doctor contract: testedDshVersion, ...)
//     app-manifest.json     (build provenance: commit, package versions, hashes)
//
// The tarballs are packed by scripts/build-distribution.mjs (so the graph engine
// is the self-contained .NET 10 build), installed into a staging profile with
// pnpm's hoisted linker, then checked for symlinks/junctions and for a stray
// @deepseek-ai runtime. The final profile's dependencies are rewritten from
// `file:` specs to versions; node_modules is already present.
//
// Usage:
//   node scripts/build-app-layer.mjs --version 0.2.0
//   node scripts/build-app-layer.mjs --version 0.2.0 --out dist/desktop --skip-build
//   node scripts/build-app-layer.mjs --version 0.2.0 --skip-pack --no-verify
//
// Requirements: pnpm (DSH's copy is auto-discovered), .NET 10 SDK for the graph
// engine (build-distribution finds it), and the current workspace built.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, cpSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findDshCommand } from './dsh-launch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (key === 'skip-build' || key === 'skip-pack' || key === 'no-verify') {
      out[key] = true
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
const version = args.version
if (!version) throw new Error('--version is required (for example: --version 0.2.0)')
const outRoot = resolve(root, args.out ?? 'dist/desktop')
const outDir = join(outRoot, version)
const releaseOut = join(outDir, 'release')
const releaseDir = join(releaseOut, version)
const assetsDir = join(releaseDir, 'assets')
const appDir = join(outDir, 'app')
const appProfile = join(appDir, 'profile')
const staging = join(outDir, '.app-layer-build')
const stagingProfile = join(staging, 'profile')

function findPnpm() {
  const candidates = [
    process.env.DSH_PNPM,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
  ].filter((candidate) => candidate && existsSync(candidate))
  if (candidates.length > 0) return { command: process.execPath, prefix: [candidates[0]] }
  return { command: 'pnpm', prefix: [] }
}

const pnpm = findPnpm()
function runPnpm(cwd, argv, options = {}) {
  return execFileSync(pnpm.command, [...pnpm.prefix, ...argv], {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_update_notifier: 'false', ...(options.env ?? {}) },
  })
}

/**
 * Run the DSH CLI the way the desktop app launches it, capturing output through
 * temp files (a confined shell cannot give a child process a pipe).
 */
function runDshCaptured(argv, options = {}) {
  const launch = findDshCommand()
  return runCaptured(launch.command, [...launch.prefix, ...argv], {
    cwd: options.cwd,
    env: { ...launch.env, ...(options.env ?? {}) },
  })
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    total += entry.isDirectory() ? dirSize(path) : statSync(path).size
  }
  return total
}

/**
 * Create a scratch directory for capturing a child process's output.
 * %TEMP% is the normal place; a confined shell can deny directory creation
 * there, so fall back to a directory inside the build output.
 */
function makeScratchDir(prefix) {
  try {
    return mkdtempSync(join(tmpdir(), prefix))
  } catch {
    mkdirSync(outDir, { recursive: true })
    return mkdtempSync(join(outDir, prefix))
  }
}

/**
 * Run a native command and capture its output through temp files.
 * Pipes are not usable here: a confined DSH shell denies a child process its
 * pipe (EPERM), and this script runs under both shells.
 */
function runCaptured(command, argv, options = {}) {
  const scratch = makeScratchDir('dsh-app-layer-run-')
  const outFile = join(scratch, 'stdout.txt')
  const errFile = join(scratch, 'stderr.txt')
  const fdOut = openSync(outFile, 'w')
  const fdErr = openSync(errFile, 'w')
  let result
  try {
    result = spawnSync(command, argv, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', fdOut, fdErr],
      windowsHide: true,
    })
  } finally {
    closeSync(fdOut)
    closeSync(fdErr)
  }
  const output = `${readFileSync(outFile, 'utf8')}\n${readFileSync(errFile, 'utf8')}`
  rmSync(scratch, { recursive: true, force: true })
  if (result.error) return { status: result.status, output: `${output}\nspawn error: ${result.error.message}` }
  return { status: result.status, output }
}

/** pnpm state files that must not name the build machine's directories. */
function findBuildMachinePaths(profileDir) {
  const markers = ['app-layer-build', 'dist\\\\desktop', 'dist/desktop']
  const hits = []
  for (const relative of [
    join('node_modules', '.modules.yaml'),
    join('node_modules', '.pnpm-workspace-state-v1.json'),
  ]) {
    const file = join(profileDir, relative)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const marker of markers) {
      if (text.includes(marker)) {
        hits.push(`${file} (${marker})`)
        break
      }
    }
  }
  return hits
}

function findReparsePoints(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) {
      found.push(path)
      continue
    }
    if (stat.isDirectory()) findReparsePoints(path, found)
  }
  return found
}

function localPackages() {
  const map = new Map()
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(root, 'packages', entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.dsh?.bundle?.patch === undefined) continue
    map.set(manifest.name, { dir: join(root, 'packages', entry.name), manifest })
  }
  return map
}

function tarballFor(name, manifest) {
  const prefix = name.replace(/^@/, '').replace('/', '-')
  const file = `${prefix}-${manifest.version}.tgz`
  if (!existsSync(join(assetsDir, file))) {
    throw new Error(`missing release asset for ${name}: ${file}`)
  }
  return file
}

function buildRelease() {
  if (args['skip-pack']) {
    if (!existsSync(join(releaseDir, 'profile', 'package.json'))) {
      throw new Error(`--skip-pack needs an existing release at ${releaseDir}`)
    }
    process.stdout.write(`using existing release at ${releaseDir}\n`)
    return
  }
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(releaseOut, { recursive: true })
  process.stdout.write(`packing release ${version} ...\n`)
  execFileSync(
    process.execPath,
    [
      join(root, 'scripts', 'build-distribution.mjs'),
      '--version', version,
      '--out', releaseOut,
      '--base-url', 'http://127.0.0.1:9',
    ],
    { cwd: root, stdio: 'inherit' },
  )
  rmSync(join(releaseDir, '.pack-staging'), { recursive: true, force: true })
}

function writeStagingProfile() {
  const releaseManifest = JSON.parse(readFileSync(join(releaseDir, 'profile', 'package.json'), 'utf8'))
  const locals = localPackages()
  const deps = {}
  for (const [name, recorded] of Object.entries(releaseManifest.dependencies ?? {})) {
    if (locals.has(name)) {
      deps[name] = `file:./tarballs/${tarballFor(name, locals.get(name).manifest)}`
    } else {
      deps[name] = recorded
    }
  }

  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(stagingProfile, 'tarballs'), { recursive: true })
  for (const [name, local] of locals) {
    const file = tarballFor(name, local.manifest)
    cpSync(join(assetsDir, file), join(stagingProfile, 'tarballs', file))
  }
  writeFileSync(
    join(stagingProfile, 'package.json'),
    `${JSON.stringify({ ...releaseManifest, dependencies: deps }, undefined, 2)}\n`,
  )
  cpSync(join(releaseDir, 'profile', 'cordis.patch.yml'), join(stagingProfile, 'cordis.patch.yml'))
  writeFileSync(
    join(stagingProfile, 'pnpm-workspace.yaml'),
    `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nstrictPeerDependencies: false\n\nallowBuilds:\n  '@google/genai': false\n  protobufjs: false\n`,
  )
  return { releaseManifest, locals }
}

function installStaging() {
  process.stdout.write('installing materialized profile ...\n')
  runPnpm(stagingProfile, ['install', '--prod', '--node-linker=hoisted', '--no-frozen-lockfile'], {
    stdio: 'inherit',
  })
}

function rewriteFinalProfile(releaseManifest, locals) {
  rmSync(appDir, { recursive: true, force: true })
  mkdirSync(appDir, { recursive: true })
  // tarballs/ and pnpm-lock.yaml stay in the installed app layer on purpose.
  //
  // The suite's 15 plugins are not on any registry, so the installed profile
  // must carry their tarballs and resolve them as file:./tarballs/*.tgz. The
  // Plugins page installs plugins with `dsh plugin --profile <p> add <pkg>`,
  // i.e. `pnpm add`, which re-resolves every direct dependency of the profile:
  // with bare version specs and no tarballs that fails with FETCH_404 for the
  // suite's own plugins, so no user could install anything (0.2.0–0.2.5).
  //
  // The dependency specs therefore stay as written for staging; only the
  // machine-specific pnpm metadata (node_modules/.modules.yaml store paths) is
  // rewritten, and the installer does that after copying (see
  // scripts/normalize-profile-pnpm.mjs).
  const finalManifest = {
    ...releaseManifest,
    dependencies: Object.fromEntries(
      Object.entries(releaseManifest.dependencies ?? {}).map(([name, recorded]) => [
        name,
        locals.has(name) ? `file:./tarballs/${tarballFor(name, locals.get(name).manifest)}` : recorded,
      ]),
    ),
  }
  writeFileSync(join(stagingProfile, 'package.json'), `${JSON.stringify(finalManifest, undefined, 2)}\n`)
  if (!existsSync(join(stagingProfile, 'pnpm-lock.yaml'))) {
    throw new Error(`staging profile has no pnpm-lock.yaml; the Plugins page needs it: ${stagingProfile}`)
  }
  cpSync(stagingProfile, appProfile, { recursive: true, dereference: false })
  cpSync(join(root, 'scripts', 'doctor.ps1'), join(appDir, 'doctor.ps1'))
  cpSync(join(root, 'scripts', 'test-doctor-json.ps1'), join(appDir, 'test-doctor-json.ps1'))
  cpSync(join(root, 'scripts', 'merge-profile.mjs'), join(appDir, 'merge-profile.mjs'))
  cpSync(join(root, 'scripts', 'normalize-profile-pnpm.mjs'), join(appDir, 'normalize-profile-pnpm.mjs'))
  cpSync(join(releaseDir, 'manifest.json'), join(appDir, 'manifest.json'))
  return finalManifest
}

function verifyLayer(finalManifest, locals) {
  const nodeModules = join(appProfile, 'node_modules')
  if (!existsSync(nodeModules)) throw new Error(`no node_modules at ${nodeModules}`)
  const links = findReparsePoints(nodeModules)
  if (links.length > 0) {
    throw new Error(`app layer contains ${links.length} symlink/junction(s), first: ${links[0]}`)
  }
  // dsh-opencode-go legitimately depends on three small @deepseek-ai utility
  // packages. Everything else under that scope is a host-runtime package and
  // must come from DSH, not from this profile (D19).
  const allowedDeepseek = new Set(['cosmokit', 'dsh-brand', 'schemastery'])
  const deepseekScope = join(nodeModules, '@deepseek-ai')
  if (existsSync(deepseekScope)) {
    const unexpected = readdirSync(deepseekScope).filter((name) => !allowedDeepseek.has(name))
    if (unexpected.length > 0) {
      throw new Error(
        `app layer contains host-runtime package(s) under @deepseek-ai: ${unexpected.join(', ')} (D19)`,
      )
    }
  }
  for (const name of Object.keys(finalManifest.dependencies ?? {})) {
    if (!existsSync(join(nodeModules, name))) throw new Error(`dependency not installed: ${name}`)
  }
  // The Plugins page runs `pnpm add` in this profile, which re-resolves every
  // direct dependency. The suite's plugins only exist as file: tarballs, so the
  // layer must ship them together with the lockfile (see rewriteFinalProfile).
  if (!existsSync(join(appProfile, 'pnpm-lock.yaml'))) {
    throw new Error(`app layer has no pnpm-lock.yaml: ${appProfile}`)
  }
  const bareSpecs = Object.entries(finalManifest.dependencies ?? {})
    .filter(([name, spec]) => locals.has(name) && !String(spec).startsWith('file:'))
    .map(([name]) => name)
  if (bareSpecs.length > 0) {
    throw new Error(`local plugin(s) must keep file: tarball specs: ${bareSpecs.join(', ')}`)
  }
  for (const [name, spec] of Object.entries(finalManifest.dependencies ?? {})) {
    if (!String(spec).startsWith('file:')) continue
    const tarball = join(appProfile, String(spec).replace(/^file:\.\//u, ''))
    if (!existsSync(tarball)) throw new Error(`tarball for ${name} is missing from the app layer: ${tarball}`)
  }
  // node_modules/.modules.yaml still names this build machine's staging
  // directories; that is expected (the installer rewrites it after copying), and
  // the runtime check below proves the rewrite yields a profile pnpm accepts.

  const engine = join(nodeModules, '@voltarenyah', 'dsh-engineering-graph', 'engine', 'bin', 'EngineeringGraph.Engine.exe')
  if (!existsSync(engine)) throw new Error(`graph engine missing: ${engine}`)
  // The published engine is a self-contained single file: it unpacks native
  // libraries into %TEMP% and opens its self-test database there. Point both at
  // the build output so a restricted %TEMP% cannot break the check.
  const bundleExtract = join(outDir, '.dotnet-bundle')
  mkdirSync(bundleExtract, { recursive: true })
  const selfTest = runCaptured(engine, ['--self-test'], {
    env: { DOTNET_BUNDLE_EXTRACT_BASE_DIR: bundleExtract, TMP: bundleExtract, TEMP: bundleExtract },
  })
  if (selfTest.status !== 0 || !/self-test: OK/u.test(selfTest.output)) {
    throw new Error(`graph engine self-test failed:\n${selfTest.output}`)
  }

  if (args['no-verify']) {
    process.stdout.write('app layer structure OK; runtime verification skipped (--no-verify)\n')
    return { selfTest: selfTest.output.trim().split('\n').at(-1) }
  }

  const verifyHome = makeScratchDir('dsh-app-layer-verify-')
  const profileDir = join(verifyHome, 'profiles', 'dsh-automation-suite')
  mkdirSync(profileDir, { recursive: true })
  cpSync(appProfile, profileDir, { recursive: true, dereference: false })
  const env = { ...process.env, DSH_HOME: verifyHome }
  try {
    // The installer normalizes the copied profile (store paths from this build
    // machine are wrong everywhere else). Verify the shape the user ends up
    // with, not the build-machine one.
    const pnpmBinary = pnpm.prefix[0]
    if (pnpmBinary) {
      const normalized = runCaptured(process.execPath, [
        join(appDir, 'normalize-profile-pnpm.mjs'),
        '--profile', profileDir,
        '--pnpm', pnpmBinary,
      ], { env })
      if (normalized.status !== 0 || !/"ok": true/u.test(normalized.output)) {
        throw new Error(`normalizer did not succeed:\n${normalized.output}`)
      }
    }
    else {
      process.stdout.write('warning: pnpm was found on PATH, not as pnpm.mjs; skipping the normalization check\n')
    }

    const dumpRun = runDshCaptured(['--profile', 'dsh-automation-suite', '--dump-config'], { env })
    const dump = dumpRun.output
    if (dumpRun.status !== 0) throw new Error(`dsh --dump-config exited ${dumpRun.status}:\n${dump}`)
    const rows = (dump.match(/^# == /gmu) ?? []).length
    if (rows < 5) throw new Error(`dump-config has too few bundle rows: ${rows}`)
    for (const name of finalManifest.dsh?.profile?.bundles ?? []) {
      if (!dump.includes(`# == ${name}`)) throw new Error(`dump-config is missing bundle ${name}`)
    }

    const doctorRun = runCaptured('pwsh', [
      '-NoProfile', '-File', join(appDir, 'doctor.ps1'),
      '-DshHome', verifyHome,
      '-Profile', 'dsh-automation-suite',
      '-Json',
      '-NoFail',
    ], { env })
    const doctorJson = doctorRun.output
    let doctor
    try {
      doctor = JSON.parse(doctorJson)
    } catch {
      throw new Error(`doctor did not emit JSON (exit ${doctorRun.status}):\n${doctorJson}`)
    }
    if (doctor.schemaVersion !== 1) throw new Error(`doctor schemaVersion is ${doctor.schemaVersion}`)
    if (doctor.summary.fail > 0) {
      throw new Error(`doctor reported ${doctor.summary.fail} failure(s):\n${doctorJson}`)
    }
    process.stdout.write(
      `runtime verification OK: dump-config ${dump.split(/\r?\n/u).length} lines, ` +
        `${rows} '# ==' rows; doctor ${doctor.summary.ok} ok / ${doctor.summary.warn} warn / ${doctor.summary.fail} fail\n`,
    )
    return {
      selfTest: selfTest.output.trim().split('\n').at(-1),
      dumpLines: dump.split(/\r?\n/u).length,
      rows,
      doctor: { ok: doctor.summary.ok, warn: doctor.summary.warn, fail: doctor.summary.fail },
    }
  } finally {
    rmSync(verifyHome, { recursive: true, force: true })
  }
}



function packageVersions(locals) {
  const versions = {}
  for (const [name, local] of locals) versions[name] = local.manifest.version
  return versions
}

function writeAppManifest(releaseManifest, finalManifest, locals) {
  const manifest = JSON.parse(readFileSync(join(appDir, 'manifest.json'), 'utf8'))
  manifest.distributionVersion = version
  manifest.appLayerVersion = version
  manifest.fixedProfile = 'dsh-automation-suite'
  manifest.sourceCommit = runCaptured('git', ['rev-parse', 'HEAD'], { cwd: root }).output.trim()
  manifest.packages = packageVersions(locals)
  manifest.appLayer = {
    profile: 'profile',
    doctor: 'doctor.ps1',
    dependencies: Object.keys(finalManifest.dependencies ?? {}).length,
    nodeModulesBytes: dirSize(join(appProfile, 'node_modules')),
  }
  writeFileSync(join(appDir, 'app-manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  // Keep the doctor-facing manifest.json next to doctor.ps1, with the tested
  // DSH version and the same asset provenance as the release.
  writeFileSync(join(appDir, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

function main() {
  if (!args['skip-build']) {
    process.stdout.write('building workspace ...\n')
    runPnpm(root, ['-r', 'build'], { stdio: 'inherit' })
  }
  buildRelease()
  const { releaseManifest, locals } = writeStagingProfile()
  installStaging()
  const finalManifest = rewriteFinalProfile(releaseManifest, locals)
  const verification = verifyLayer(finalManifest, locals)
  writeAppManifest(releaseManifest, finalManifest, locals)
  // The staging profile is a duplicate of app/profile (including its 100 MiB
  // node_modules). Keep it only when verification failed, where it is useful for
  // debugging; a successful build cleans it up.
  rmSync(staging, { recursive: true, force: true })
  const result = {
    ok: true,
    version,
    appDir,
    profile: appProfile,
    dependencies: Object.keys(finalManifest.dependencies ?? {}).length,
    nodeModulesBytes: dirSize(join(appProfile, 'node_modules')),
    appBytes: dirSize(appDir),
    verification,
  }
  writeFileSync(join(outDir, 'build-result.json'), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`\napp layer built: ${appDir}\n`)
  process.stdout.write(`  dependencies: ${result.dependencies}\n`)
  process.stdout.write(`  app layer:    ${(result.appBytes / 1024 / 1024).toFixed(1)} MiB\n`)
  process.stdout.write(`  profile:      ${(result.nodeModulesBytes / 1024 / 1024).toFixed(1)} MiB node_modules\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`build-app-layer: ${error.message}\n`)
  process.exit(1)
}
