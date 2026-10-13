/**
 * Makes the DSH runtime packages resolvable from this checkout.
 *
 * An installed plugin never needs this: the profile's runtime resolution maps
 * `@deepseek-ai/*` to the harness's own copies. A bare checkout does, because
 * the plugin imports `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis` and
 * `@deepseek-ai/schemastery` exactly like a published plugin does.
 *
 * The helper links those three packages from the local harness installation into
 * `node_modules/@deepseek-ai/`. Node resolves the real path, so the linked
 * packages keep their own dependencies available.
 *
 * Usage:
 *   node scripts/link-dsh-runtime.mjs            # link what is missing
 *   node scripts/link-dsh-runtime.mjs --force    # re-link
 */

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGES = ['dsh-tools', 'cordis', 'schemastery']

export function dshHome() {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** Candidate folders that hold the harness runtime packages. */
export function runtimeCandidates() {
  const home = dshHome()
  return [
    join(home, 'profiles', 'node_modules', '@deepseek-ai'),
    join(home, 'profiles', 'desktop', 'node_modules', '@deepseek-ai'),
    join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai'),
  ]
}

function findSource(packageName) {
  for (const directory of runtimeCandidates()) {
    const candidate = join(directory, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

/**
 * @returns {{ linked: string[], present: string[], missing: string[] }}
 */
export function linkRuntime({ force = false, quiet = false } = {}) {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const scope = join(packageRoot, 'node_modules', '@deepseek-ai')
  mkdirSync(scope, { recursive: true })

  const linked = []
  const present = []
  const missing = []

  for (const packageName of PACKAGES) {
    const target = join(scope, packageName)
    const source = findSource(packageName)

    if (existsSync(join(target, 'package.json'))) {
      if (!force) {
        present.push(packageName)
        continue
      }
      rmSync(target, { recursive: true, force: true })
    }

    if (source === null) {
      missing.push(packageName)
      continue
    }

    try {
      // A Windows junction needs no elevation and behaves like a directory link.
      symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(packageName)
      if (!quiet) console.log(`linked @deepseek-ai/${packageName} -> ${source}`)
    } catch (error) {
      missing.push(packageName)
      if (!quiet) console.error(`could not link @deepseek-ai/${packageName}: ${error.message}`)
    }
  }

  return { linked, present, missing }
}

/** @returns {string[]} the runtime packages that are still unresolvable. */
export function unresolvedRuntimePackages() {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  return PACKAGES.filter((packageName) => {
    const local = join(packageRoot, 'node_modules', '@deepseek-ai', packageName, 'package.json')
    if (existsSync(local)) return false
    return findSource(packageName) === null
  })
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const force = process.argv.includes('--force')
  const result = linkRuntime({ force })
  if (result.missing.length > 0) {
    console.error(
      `\nCould not resolve: ${result.missing.join(', ')}\n` +
        `Searched: ${runtimeCandidates().join(', ')}\n` +
        'Install DeepSeek Harness, or set DSH_HOME to the folder that holds its profiles.',
    )
    process.exit(1)
  }
  console.log(`\nReady: ${readdirSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules', '@deepseek-ai')).join(', ')}`)
}
