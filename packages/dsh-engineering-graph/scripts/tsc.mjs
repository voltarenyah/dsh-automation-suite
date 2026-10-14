/**
 * Run the TypeScript compiler with a copy this checkout already has.
 *
 * Why a script instead of plain `tsc`: this package's `node_modules` is not a
 * normal install — `scripts/link-dsh-runtime.mjs` puts the `@deepseek-ai/*`
 * runtime links there by hand, while `typescript` and `@types/node` come from the
 * repository root's `pnpm install`. Relying on the PATH that `npm run` / `pnpm
 * run` would normally set up is therefore not reliable, so the binary is resolved
 * explicitly instead: this package's own copy first, then the repository root's.
 *
 * @module dsh-engineering-graph/scripts/tsc
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
