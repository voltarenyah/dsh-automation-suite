#!/usr/bin/env node
// Rewrite the pnpm metadata a materialized app-layer profile carries over from
// the machine that built it, so this machine can run install commands in it.
//
// Why this exists
// ---------------
// scripts/build-app-layer.mjs materializes the profile by running pnpm in a
// staging directory (dist/desktop/<ver>/.app-layer-build/profile) and copying
// the result into the app layer. pnpm records the absolute store paths it used:
//
//   <profile>/node_modules/.modules.yaml
//     storeDir:         <build machine>/.pnpm/store/v11  (or the build user's
//                       %LOCALAPPDATA%\pnpm\store\v11)
//     virtualStoreDir:  <build repo>/dist/desktop/<ver>/.app-layer-build/...
//
// The desktop installer copies that profile to
// %LOCALAPPDATA%\dsh-automation-suite\... and %DSH_HOME%\profiles\<name>, where
// both paths are wrong. pnpm's checkCompatibility() runs before dependency
// resolution on every install command — and the Plugins page is exactly
// `dsh plugin --profile <p> add <pkg>` → `pnpm add <pkg>` — so the user sees:
//
//   ERR_PNPM_UNEXPECTED_VIRTUAL_STORE  (virtualStoreDir differs)
//   ERR_PNPM_UNEXPECTED_STORE          (storeDir differs)
//
// Both are fatal, and pnpm's own advice ("reinstall your dependencies") is
// impossible here because the suite's 15 plugin tarballs are not on any
// registry: the profile's dependencies are file:./tarballs/*.tgz.
//
// So the installer rewrites the two paths for the machine it installs on. The
// virtual store is deterministic (<profile>/node_modules/.pnpm); the store has
// to be asked of pnpm itself, because pnpm may fall back from the configured
// global store to a project-local one (it does when hard links are not
// available between the two locations).
//
// Usage
// -----
//   node scripts/normalize-profile-pnpm.mjs --profile <dir> --dsh <dsh.cmd>
//   node scripts/normalize-profile-pnpm.mjs --profile <dir> --pnpm <pnpm.mjs>
//   node scripts/normalize-profile-pnpm.mjs --profile <dir> --dsh <dsh.cmd> --check
//
// --check changes nothing; it prints the same JSON report and exits 1 when the
// recorded paths do not match this machine (doctor.ps1 uses it). Without
// --check the file is rewritten in place (install-profile.ps1 uses it).

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (key === 'check') {
      out.check = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    out[key] = value
    i += 1
  }
  return out
}

/** The pnpm entry point shipped inside a DeepSeek Harness installation. */
function pnpmFromDsh(dsh) {
  // <app>\resources\runtime\cli\bin\dsh.cmd → <app>
  const appRoot = resolve(dirname(dsh), '..', '..', '..', '..')
  const candidates = [
    join(appRoot, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    join(appRoot, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? ''
}

/** The store directory pnpm will use for this project on this machine. */
function resolveStoreDir(pnpmPath, profileDir) {
  // stdout goes through a temp file, not a pipe: under a confined DSH shell a
  // child process cannot open a pipe (EPERM), and the installer itself runs
  // this script from a plain PowerShell so either path must work. The scratch
  // directory falls back to the profile when the system temp is unwritable
  // (a confined shell may deny directory creation there).
  let scratch
  try {
    scratch = mkdtempSync(join(tmpdir(), 'dsh-store-path-'))
  } catch {
    scratch = mkdtempSync(join(profileDir, '.normalize-'))
  }
  const outFile = join(scratch, 'stdout.txt')
  const errFile = join(scratch, 'stderr.txt')
  const fdOut = openSync(outFile, 'w')
  const fdErr = openSync(errFile, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [pnpmPath, 'store', 'path'], {
      cwd: profileDir,
      stdio: ['ignore', fdOut, fdErr],
      env: { ...process.env, npm_config_update_notifier: 'false' },
    })
  } finally {
    closeSync(fdOut)
    closeSync(fdErr)
  }
  const output = readFileSync(outFile, 'utf8')
  const errors = readFileSync(errFile, 'utf8')
  rmSync(scratch, { recursive: true, force: true })
  if (result.status !== 0) {
    throw new Error(`pnpm store path exited ${String(result.status)}:\n${output}\n${errors}`)
  }
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const path = lines.at(-1) ?? ''
  if (!path || !/^[A-Za-z]:[\\/]/u.test(path)) {
    throw new Error(`pnpm store path printed no usable path:\n${output}\n${errors}`)
  }
  return path
}

/**
 * Read one scalar from the pnpm modules manifest. pnpm writes it either as
 * JSON-like YAML (`"storeDir": "C:\\…"`) or as plain YAML (`storeDir: C:\…`),
 * depending on how much of the state got serialized as JSON; support both and
 * remember which so the value can be written back in the same shape.
 */
function readScalar(text, key) {
  const json = new RegExp(`^(\\s*)"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'mu').exec(text)
  if (json) {
    const indent = json[1]
    const raw = JSON.parse(`"${json[2]}"`)
    return { style: 'json', indent, raw, index: json.index, length: json[0].length }
  }
  const yaml = new RegExp(`^(\\s*)${key}\\s*:\\s*([^\\r\\n]*)`, 'mu').exec(text)
  if (yaml) {
    const indent = yaml[1]
    let raw = yaml[2].trim()
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      raw = raw.slice(1, -1)
    }
    return { style: 'yaml', indent, raw, index: yaml.index, length: yaml[0].length }
  }
  return undefined
}

function samePath(a, b) {
  const normalize = (value) => resolve(value).replace(/[\\/]+$/u, '').toLowerCase()
  return normalize(a) === normalize(b)
}

function replaceScalar(text, found, key, value) {
  const rendered = found.style === 'json'
    ? `${found.indent}"${key}": ${JSON.stringify(value)}`
    : `${found.indent}${key}: ${value}`
  return text.slice(0, found.index) + rendered + text.slice(found.index + found.length)
}

/** pnpm remembers which project directories the workspace state describes. */
function rewriteWorkspaceState(profileDir) {
  const file = join(profileDir, 'node_modules', '.pnpm-workspace-state-v1.json')
  if (!existsSync(file)) return { changed: false }
  const state = JSON.parse(readFileSync(file, 'utf8'))
  const projects = state.projects ?? {}
  const next = {}
  let changed = false
  for (const [key, value] of Object.entries(projects)) {
    const target = /^[A-Za-z]:[\\/]/u.test(key) || key.includes('\\') || key.includes('/') ? profileDir : key
    if (target !== key) changed = true
    next[target] = value
  }
  if (changed) {
    state.projects = next
    writeFileSync(file, `${JSON.stringify(state, undefined, 2)}\n`)
  }
  return { changed }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.profile) throw new Error('--profile is required')
  const profileDir = resolve(args.profile)
  if (!existsSync(join(profileDir, 'package.json'))) {
    throw new Error(`not a profile directory (no package.json): ${profileDir}`)
  }
  const modulesFile = join(profileDir, 'node_modules', '.modules.yaml')
  if (!existsSync(modulesFile)) {
    throw new Error(`no pnpm modules manifest at ${modulesFile}; reinstall the profile`)
  }

  const pnpmPath = args.pnpm
    ? resolve(args.pnpm)
    : args.dsh
      ? pnpmFromDsh(resolve(args.dsh))
      : ''
  if (!pnpmPath || !existsSync(pnpmPath)) {
    throw new Error('cannot find pnpm; pass --pnpm <pnpm.mjs> or --dsh <dsh.cmd>')
  }

  const expected = {
    storeDir: args['store-dir'] ? resolve(args['store-dir']) : resolveStoreDir(pnpmPath, profileDir),
    virtualStoreDir: join(profileDir, 'node_modules', '.pnpm'),
  }

  const text = readFileSync(modulesFile, 'utf8')
  const current = {}
  for (const key of Object.keys(expected)) {
    const found = readScalar(text, key)
    current[key] = found?.raw ?? ''
  }

  const mismatches = Object.keys(expected).filter((key) => !samePath(current[key], expected[key]))
  const leaksBuildPath = /\.app-layer-build/iu.test(text)
  const report = {
    ok: mismatches.length === 0 && !leaksBuildPath,
    profile: profileDir,
    pnpm: pnpmPath,
    mismatches,
    leaksBuildPath,
    storeDir: { current: current.storeDir, expected: expected.storeDir },
    virtualStoreDir: { current: current.virtualStoreDir, expected: expected.virtualStoreDir },
  }

  if (args.check) {
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`)
    return report.ok ? 0 : 1
  }

  let rewritten = text
  for (const key of mismatches) {
    const found = readScalar(rewritten, key)
    if (!found) throw new Error(`cannot locate "${key}" in ${modulesFile}`)
    rewritten = replaceScalar(rewritten, found, key, expected[key])
  }
  // The staging path is also recorded in .modules.yaml's hoisted-location table
  // (and sometimes in the workspace state), so rewriting the two scalars is not
  // proof the leak is gone. Refuse to ship a profile that still names it.
  if (/\.app-layer-build/iu.test(rewritten)) {
    throw new Error(
      `${modulesFile} still references a build-machine staging directory after the rewrite; ` +
        'the app layer looks corrupt — rebuild it with scripts/build-app-layer.mjs',
    )
  }
  if (mismatches.length > 0) writeFileSync(modulesFile, rewritten)
  const state = rewriteWorkspaceState(profileDir)
  process.stdout.write(
    `${JSON.stringify({ ...report, ok: true, rewritten: mismatches.length, workspaceState: state.changed }, undefined, 2)}\n`,
  )
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`normalize-profile-pnpm: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
