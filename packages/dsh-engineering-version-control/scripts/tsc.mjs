/**
 * Run the TypeScript compiler with a copy this checkout already has.
 *
 * Why a script instead of plain `tsc`: this package has no `pnpm install`-managed
 * `node_modules` on purpose (docs/decisions.md P0-3 — a workspace install in a
 * shared working tree would also prune the sibling packages' hand-made runtime
 * links), so relying on the PATH that `npm run`/`pnpm run` would normally set up
 * is not reliable. The binary is resolved explicitly instead: this package's own
 * link first (created by `scripts/link-dsh-runtime.mjs`), then the repository
 * root's copy, which exists because the root package depends on typescript.
 *
 * @module dsh-engineering-context/scripts/tsc
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @returns {string} this package's root directory. */
export function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/**
 * @returns {string | null} the `tsc` entry point, or null when none is present.
 */
export function resolveTsc() {
  const candidates = [
    join(packageRoot(), 'node_modules', 'typescript', 'bin', 'tsc'),
    join(packageRoot(), '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/**
 * Compile with the resolved compiler.
 *
 * @param {string[]} args - arguments for `tsc`.
 * @returns {number} the exit code.
 */
export function runTsc(args) {
  const tsc = resolveTsc()
  if (tsc === null) {
    console.error(
      'typescript was not found. Run "node scripts/link-dsh-runtime.mjs", or "pnpm install" at the repository root.',
    )
    return 1
  }
  const result = spawnSync(process.execPath, [tsc, ...args], { stdio: 'inherit', cwd: packageRoot() })
  return result.status ?? 1
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (invokedDirectly) process.exit(runTsc(process.argv.slice(2)))
