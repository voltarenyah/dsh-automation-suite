#!/usr/bin/env node
// Regression test: a materialized app-layer profile must accept a plugin
// install on a *different* machine — different user name, different install
// path, different pnpm store.
//
// The bug this covers (0.2.0–0.2.5): scripts/build-app-layer.mjs runs pnpm in a
// staging directory and copies the result into the app layer. pnpm records the
// absolute store paths it used in node_modules/.modules.yaml, and its
// checkCompatibility() compares them before any dependency resolution, so the
// first `dsh plugin --profile <p> add <pkg>` on a user machine died with
//
//   ERR_PNPM_UNEXPECTED_VIRTUAL_STORE   (virtualStoreDir is the build path)
//   ERR_PNPM_UNEXPECTED_STORE           (storeDir is the build user's store)
//
// A second, independent blocker sat behind it: the profile's dependencies were
// rewritten from file:./tarballs/*.tgz to bare versions, so pnpm could not
// resolve the suite's 15 private plugins at all (they are not on any registry).
//
// What this test does
// -------------------
// 1. builds a synthetic app layer the same way the real one is built (staging
//    directory + pnpm install + copy), so the recorded paths point at a build
//    machine that the "user" environment does not have;
// 2. copies it to a *user* profile under a different root, with a private pnpm
//    store, and asserts the raw copy is still rejected (the bug reproduces);
// 3. runs the same normalization the installer runs
//    (scripts/normalize-profile-pnpm.mjs) and asserts the metadata now agrees;
// 4. runs `dsh plugin --profile <p> add <local-dir>` in the user profile and
//    asserts the plugin lands in package.json + node_modules, the shipped
//    dependency survives, and the profile still loads (--dump-config).
//
// The installed spec is a local directory, so the run needs no registry access.
// Third-party *publishing* is not what this covers; it covers "pnpm can install
// into this profile at all", which is what the Plugins page needs.
//
// Usage:
//   node scripts/test-plugin-add.mjs                 # build the synthetic layer and run
//   node scripts/test-plugin-add.mjs --keep          # keep the temp tree for inspection
//   node scripts/test-plugin-add.mjs --scratch <dir> # build the temp tree here instead of %TEMP%
//   node scripts/test-plugin-add.mjs --dsh <dsh.cmd> # use a specific DSH installation
//
// Requirements: a DeepSeek Harness installation (its pnpm and its dsh CLI).

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findDshCommand } from './dsh-launch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const normalizeScript = join(root, 'scripts', 'normalize-profile-pnpm.mjs')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--keep') {
      out.keep = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    out[arg.slice(2)] = value
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const failures = []
// Some confined shells deny directory creation under %TEMP%, so the log files
// live wherever --scratch (or %TEMP%) points.
let logRoot = args.scratch ? resolve(args.scratch) : tmpdir()
function check(name, ok, detail) {
  if (!ok) failures.push({ name, detail })
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`)
  return ok
}

/** Locate DSH, honoring --dsh and DSH_EXE. */
function findDsh() {
  if (args.dsh) {
    if (!existsSync(args.dsh)) throw new Error(`--dsh not found: ${args.dsh}`)
    process.env.DSH_EXE = resolve(args.dsh)
  }
  return findDshCommand()
}

function findPnpm(launch) {
  const appRoot = launch.appRoot
  const candidates = [
    join(appRoot, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    join(appRoot, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`pnpm.mjs not found next to ${launch.command}`)
  return found
}

/** Run a command and return { status, stdout, stderr, text } without pipes. */
function run(command, argv, options = {}) {
  // Output goes through temp files, not pipes: a confined DSH shell cannot open
  // a pipe for a child process (EPERM), and this test must run under both. The
  // descriptors are opened here because spawnSync only honors stdio *fds* — a
  // path entry is accepted but never receives the child's output.
  const dir = mkdtempSync(join(logRoot, 'dsh-plugin-add-log-'))
  const outFile = join(dir, 'stdout.txt')
  const errFile = join(dir, 'stderr.txt')
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
  const stdout = readFileSync(outFile, 'utf8')
  const stderr = readFileSync(errFile, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  const error = result.error ? `spawn error: ${result.error.message}` : ''
  return { status: result.status, error, stdout, stderr, text: `${stdout}\n${stderr}\n${error}` }
}

/** Run the dsh CLI the way the desktop app launches it. */
function runDsh(launch, argv, options = {}) {
  return run(launch.command, [...launch.prefix, ...argv], {
    ...options,
    env: { ...launch.env, ...(options.env ?? {}) },
  })
}

/** The pnpm command a user's install runs: `pnpm <args>` in the profile. */
function runPnpm(pnpm, argv, options = {}) {
  return run(process.execPath, [pnpm, ...argv], options)
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** Build a synthetic "app layer" the way scripts/build-app-layer.mjs does. */
function buildSyntheticAppLayer(pnpm, buildRoot) {
  const staging = join(buildRoot, 'staging', 'profile')
  const appProfile = join(buildRoot, 'app', 'profile')
  // The real layer vendors the suite's plugins as tarballs and keeps them in
  // the profile; a local directory dependency has the same pnpm semantics and
  // needs no packing step.
  mkdirSync(join(staging, 'vendor', 'suite-plugin'), { recursive: true })
  writeJson(join(staging, 'vendor', 'suite-plugin', 'package.json'), {
    name: 'suite-plugin',
    version: '0.1.0',
    main: 'index.js',
  })
  writeFileSync(join(staging, 'vendor', 'suite-plugin', 'index.js'), 'export const suite = true\n')
  writeJson(join(staging, 'package.json'), {
    name: 'dsh-profile-synthetic',
    private: true,
    dependencies: { 'suite-plugin': 'file:./vendor/suite-plugin' },
  })
  writeFileSync(
    join(staging, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nstrictPeerDependencies: false\n',
  )
  const install = runPnpm(pnpm, ['install', '--prod', '--node-linker=hoisted', '--no-frozen-lockfile'], {
    cwd: staging,
    env: { CI: 'true' },
  })
  if (install.status !== 0) throw new Error(`staging pnpm install failed:\n${install.text}`)
  // Copy exactly like the build does: node_modules included, no re-link.
  mkdirSync(appProfile, { recursive: true })
  cpSync(staging, appProfile, { recursive: true, dereference: false })
  return appProfile
}

function test() {
  const launch = findDsh()
  const pnpm = findPnpm(launch)
  // --scratch lets a caller point the tree at a writable directory (some
  // confined shells cannot create directories under %TEMP%).
  const scratchRoot = args.scratch ? resolve(args.scratch) : tmpdir()
  if (args.scratch) mkdirSync(scratchRoot, { recursive: true })
  const scratch = mkdtempSync(join(scratchRoot, 'dsh-plugin-add-'))
  process.stdout.write(`scratch: ${scratch}\n`)
  process.stdout.write(`dsh:     ${launch.command}\n`)
  process.stdout.write(`pnpm:    ${pnpm}\n`)
  try {
    // 1. Build under a "build machine" root.
    const appProfile = buildSyntheticAppLayer(pnpm, join(scratch, 'build'))
    const raw = readFileSync(join(appProfile, 'node_modules', '.modules.yaml'), 'utf8')
    check(
      'app layer records a build-machine virtual store',
      /virtualStoreDir/u.test(raw) && raw.includes('staging'),
      'pnpm must record the path for this test to mean anything',
    )

    // 2. "Install" on the user machine: different root, different user name,
    //    different pnpm store. LOCALAPPDATA is where pnpm keeps its default
    //    store, so overriding it (together with DSH_HOME) emulates a machine
    //    whose user is not the one that built the layer — the real situation
    //    behind the reported failure.
    const dshHome = join(scratch, 'users', 'another-user', 'dsh-automation-suite-home')
    const userProfile = join(dshHome, 'profiles', 'synthetic')
    const storeDir = join(scratch, 'users', 'another-user', 'AppData', 'Local', 'pnpm', 'store')
    mkdirSync(userProfile, { recursive: true })
    mkdirSync(storeDir, { recursive: true })
    cpSync(appProfile, userProfile, { recursive: true, dereference: false })
    const userEnv = {
      DSH_HOME: dshHome,
      LOCALAPPDATA: join(scratch, 'users', 'another-user', 'AppData', 'Local'),
      USERPROFILE: join(scratch, 'users', 'another-user'),
      npm_config_store_dir: storeDir,
      CI: 'true',
    }

    // The plugin the user installs. A local directory keeps this offline; the
    // pnpm resolution, lockfile and node_modules path are the real ones.
    const pluginDir = join(scratch, 'third-party-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeJson(join(pluginDir, 'package.json'), {
      name: 'third-party-plugin',
      version: '1.0.0',
      main: 'index.js',
      // A bundle patch turns it into a profile layer, like a real plugin.
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    writeFileSync(join(pluginDir, 'index.js'), 'export const plugin = true\n')
    writeFileSync(
      join(pluginDir, 'cordis.patch.yml'),
      '- insert:\n    - id: third-party-plugin\n      name: third-party-plugin\n',
    )

    // 3. The bug must still reproduce before normalization, otherwise this test
    //    would pass simply because pnpm happens to tolerate the stale paths.
    const stale = runPnpm(pnpm, ['add', pluginDir], { cwd: userProfile, env: userEnv })
    check(
      'un-normalized profile is still rejected by pnpm',
      stale.status !== 0 && /ERR_PNPM_UNEXPECTED_(VIRTUAL_)?STORE/u.test(stale.text),
      stale.status === 0
        ? 'pnpm accepted the copied metadata'
        : (stale.text.match(/ERR_PNPM_\w+/u)?.[0] ?? `unexpected error: ${stale.text.trim().split('\n').slice(0, 3).join(' / ')}`),
    )

    // 4. Normalize the way the installer does, then confirm the metadata agrees
    //    with this machine and no build path survives.
    const normalized = run(process.execPath, [normalizeScript, '--profile', userProfile, '--pnpm', pnpm], {
      env: userEnv,
    })
    check(
      'installer normalization succeeds',
      normalized.status === 0,
      normalized.status === 0 ? normalized.stdout.trim().split('\n')[0] : normalized.text.trim().split('\n').at(-1),
    )
    const recheck = run(process.execPath, [normalizeScript, '--profile', userProfile, '--pnpm', pnpm, '--check'], {
      env: userEnv,
    })
    check(
      'normalized metadata matches this machine',
      recheck.status === 0,
      recheck.status === 0 ? 'store paths agree' : recheck.text.trim().split('\n').slice(0, 3).join(' / '),
    )
    const afterNormalize = readFileSync(join(userProfile, 'node_modules', '.modules.yaml'), 'utf8')
    check(
      'no build-machine path survives normalization',
      !/staging/iu.test(afterNormalize) &&
        !/staging/iu.test(readFileSync(join(userProfile, 'node_modules', '.pnpm-workspace-state-v1.json'), 'utf8')),
      'the profile must not name the staging directory',
    )

    // 5. The install the Plugins page performs.
    const add = runDsh(launch, ['plugin', '--profile', 'synthetic', 'add', pluginDir], {
      cwd: dshHome,
      env: userEnv,
    })
    check('dsh plugin add succeeds', add.status === 0, add.text.trim().split('\n').filter(Boolean).at(-1))
    const manifest = JSON.parse(readFileSync(join(userProfile, 'package.json'), 'utf8'))
    check(
      'the added plugin is a dependency of the profile',
      manifest.dependencies?.['third-party-plugin'] !== undefined,
      String(manifest.dependencies?.['third-party-plugin']),
    )
    check(
      'the added plugin is installed',
      existsSync(join(userProfile, 'node_modules', 'third-party-plugin', 'package.json')),
    )
    check(
      'the profile still depends on the shipped plugin',
      manifest.dependencies?.['suite-plugin'] !== undefined,
      'an install must not drop the shipped dependencies',
    )
    check(
      'the shipped plugin is still installed',
      existsSync(join(userProfile, 'node_modules', 'suite-plugin', 'package.json')),
    )

    // 6. The profile still loads after the install.
    const dump = runDsh(launch, ['--profile', 'synthetic', '--dump-config'], { cwd: dshHome, env: userEnv })
    check('profile still loads after the install', dump.status === 0, dump.text.trim().split('\n')[0])

    // 7. A second install must also work (the state the first one left behind
    //    has to stay usable — this is what a user hits on the second plugin).
    const second = join(scratch, 'second-plugin')
    mkdirSync(second, { recursive: true })
    writeJson(join(second, 'package.json'), { name: 'second-plugin', version: '1.0.0', main: 'index.js' })
    writeFileSync(join(second, 'index.js'), 'export const second = true\n')
    const add2 = runDsh(launch, ['plugin', '--profile', 'synthetic', 'add', second], { cwd: dshHome, env: userEnv })
    check('a second plugin add succeeds', add2.status === 0, add2.text.trim().split('\n').filter(Boolean).at(-1))
    const manifest2 = JSON.parse(readFileSync(join(userProfile, 'package.json'), 'utf8'))
    check(
      'both installed plugins are declared',
      manifest2.dependencies?.['third-party-plugin'] !== undefined && manifest2.dependencies?.['second-plugin'] !== undefined,
    )
  } finally {
    if (args.keep) process.stdout.write(`kept: ${scratch}\n`)
    else rmSync(scratch, { recursive: true, force: true })
  }
}

try {
  test()
} catch (error) {
  process.stderr.write(`test-plugin-add: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} check(s) failed:\n`)
  for (const failure of failures) {
    process.stdout.write(`  - ${failure.name}${failure.detail ? `: ${failure.detail}` : ''}\n`)
  }
  process.exitCode = 1
} else if (process.exitCode !== 1) {
  process.stdout.write('\nplugin install acceptance: OK\n')
}
