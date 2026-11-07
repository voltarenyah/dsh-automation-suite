// Shared DSH launch contract.
//
// `dsh.cmd` is a batch wrapper whose path contains spaces, so spawning it from
// Node needs a cmd.exe quoting dance. The shell and installer use the same
// direct Electron invocation the wrapper itself uses:
//
//   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals <cli.js> ...
//
// This module is deliberately dependency-free: it is also copied/borrowed by the
// desktop shell's startup probe.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Find dsh.cmd (or an explicit DSH_EXE) and derive the direct launch command. */
export function findDshCommand() {
  const candidates = [
    process.env.DSH_EXE,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  ].filter((candidate) => candidate && existsSync(candidate))
  const dsh = candidates[0]
  if (!dsh) throw new Error('dsh.cmd not found; pass DSH_EXE or install DeepSeek Harness')

  const appRoot = resolve(dirname(dsh), '..', '..', '..', '..')
  const exe = join(appRoot, 'DeepSeek Harness.exe')
  const cli = join(appRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  if (existsSync(exe)) {
    return { command: exe, prefix: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' }, appRoot }
  }
  if (basename(dsh).toLowerCase() === 'dsh.cmd' || dsh.toLowerCase().endsWith('.cmd')) {
    throw new Error(`cannot derive the DSH Electron executable from ${dsh}`)
  }
  return { command: dsh, prefix: [], env: {}, appRoot: dirname(dsh) }
}

/** Spawn a DSH command synchronously. */
export function runDshSync(argv, options = {}) {
  const launch = findDshCommand()
  return execFileSync(launch.command, [...launch.prefix, ...argv], {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: { ...process.env, ...launch.env, ...(options.env ?? {}) },
  })
}

/** Spawn a long-running DSH command (for the web probe / shell). */
export function spawnDsh(argv, options = {}) {
  const launch = findDshCommand()
  return spawn(launch.command, [...launch.prefix, ...argv], {
    cwd: options.cwd,
    env: { ...process.env, ...launch.env, ...(options.env ?? {}) },
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}
