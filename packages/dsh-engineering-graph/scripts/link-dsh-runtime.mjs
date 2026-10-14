/**
 * Make the harness runtime resolvable from this checkout.
 *
 * An installed plugin never needs this: the profile's runtime resolution maps
 * `@deepseek-ai/*` to the harness's own copies. A bare checkout does, because the
 * plugin imports `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` exactly
 * like a published plugin does — and the test suite deliberately runs against
 * that **real** runtime, never a stub.
 *
 * The dev dependencies (`typescript`, `@types/node`) are **not** this script's
 * business: `pnpm install` at the repository root provides them. Linking them by
 * hand would fight the package manager, which cannot relink a directory another
 * project is reaching into (the incident family 2 recorded as P0-14).
 *
 * This script **never writes outside this package**. In particular it never
 * extracts the runtime cache: the sibling package's extractor deletes and
 * rebuilds `<DSH_HOME>/plugin-runtime`, which lives outside the repository and
 * cannot be recovered with git. This one only reads that cache, and fails with
 * instructions when a package is missing.
 *
 * Usage:
 *   node scripts/link-dsh-runtime.mjs            # link whatever is missing
 *   node scripts/link-dsh-runtime.mjs --force    # re-link, but never delete a real directory
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The harness runtime packages this plugin imports directly.
 *
 * Every `@deepseek-ai/*` this package's `src/` imports must be listed here, or a
 * bare checkout resolves it from nothing (root AGENTS.md §4).
 *
 * Deliberately absent: `@deepseek-ai/dsh-tools`. The plugin declares
 * `inject = ['tools']` but does not *import* the registry module — it registers
 * no tools yet, so nothing here would import it (family 2 lists it because its
 * tools module imports `defineTool`). Add it the moment a tool lands.
 */
export const RUNTIME_ROOTS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
]

/** @returns {string} the DeepSeek Harness home (`$DSH_HOME`, default `~/.dsh`). */
export function dshHome() {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** @returns {string} this package's root directory. */
export function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/**
 * Directories that may hold the harness runtime packages, best source first.
 *
 * The installed app's extracted cache comes first: it is the only source
 * guaranteed to match the harness version the app actually runs. The projection
 * folders under `profiles/` are kept as a last resort and may be stale — the root
 * AGENTS.md records an incident where such a projection was a dangling
 * `npm-cache` junction.
 *
 * @returns {string[]} candidate `@deepseek-ai` directories.
 */
export function runtimeCandidates() {
  const home = dshHome()
  return [
    join(home, 'plugin-runtime', 'node_modules', '@deepseek-ai'),
    join(home, 'profiles', 'node_modules', '@deepseek-ai'),
    join(home, 'profiles', 'desktop', 'node_modules', '@deepseek-ai'),
    join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai'),
  ]
}

/** @returns {string | null} the first candidate that really holds this package. */
function findPackageSource(candidates) {
  for (const candidate of candidates) if (existsSync(join(candidate, 'package.json'))) return candidate
  return null
}

/**
 * Remove a link without ever traversing it.
 *
 * A link here may point into the harness installation, and a recursive delete
 * that follows the link destroys the *target* (the incident recorded in
 * `dsh-tia-openness-v17-min/docs/ECOSYSTEM-COMPAT.md` cost a repository its
 * `.git` metadata). Node reports junctions as symlinks, so those are unlinked;
 * only a real directory is removed recursively.
 */
function removeLink(target) {
  const stats = lstatSync(target)
  if (stats.isSymbolicLink()) unlinkSync(target)
  else rmSync(target, { recursive: true, force: true })
}

/**
 * Link one runtime package into this package's `node_modules`.
 *
 * @returns {'present' | 'linked' | 'missing' | 'skipped'}
 */
function linkOne(root, name, sources, force) {
  const target = join(root, 'node_modules', ...name.split('/'))
  if (existsSync(target)) {
    if (!force) return 'present'
    const stats = lstatSync(target)
    // A real directory is somebody's install: refuse to delete it rather than
    // guess. A link is always ours to replace.
    if (!stats.isSymbolicLink()) {
      console.warn(`kept ${name}: it is a real directory, not a link — remove it yourself if you want it relinked`)
      return 'skipped'
    }
    removeLink(target)
  }
  const source = findPackageSource(sources)
  if (source === null) return 'missing'
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  return 'linked'
}

/**
 * Link every runtime package this plugin needs.
 *
 * @param {{ force?: boolean, quiet?: boolean }} [options]
 * @returns {{ linked: string[], present: string[], missing: string[], skipped: string[] }}
 */
export function linkRuntime({ force = false, quiet = false } = {}) {
  const root = packageRoot()
  const scope = join(root, 'node_modules', '@deepseek-ai')
  mkdirSync(scope, { recursive: true })

  const result = { linked: [], present: [], missing: [], skipped: [] }
  for (const name of RUNTIME_ROOTS) {
    const sources = runtimeCandidates().map((directory) => join(directory, name.replace('@deepseek-ai/', '')))
    const outcome = linkOne(root, name, sources, force)
    result[outcome === 'missing' ? 'missing' : outcome === 'skipped' ? 'skipped' : outcome].push(name)
    if (!quiet && outcome === 'linked') console.log(`linked ${name} -> ${findPackageSource(sources)}`)
  }
  return result
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (invokedDirectly) {
  const result = linkRuntime({ force: process.argv.includes('--force') })
  if (result.missing.length > 0) {
    console.error(
      `\nCould not resolve: ${result.missing.join(', ')}\n` +
        `Harness runtime searched in: ${runtimeCandidates().join(', ')}\n` +
        'Install DeepSeek Harness and/or set DSH_HOME to its home folder. This script never extracts the runtime ' +
        "cache, because that directory is outside the repository. To (re)build the cache, run the sibling package's " +
        'extractor deliberately: pnpm --filter @voltarenyah/dsh-tia-openness-v17-min run link:runtime\n',
    )
    process.exit(1)
  }
  const scope = join(packageRoot(), 'node_modules', '@deepseek-ai')
  console.log(
    `\nLinked: ${result.linked.join(', ') || 'nothing new'}` +
      `\nAlready present: ${result.present.join(', ') || 'none'}` +
      (result.skipped.length > 0 ? `\nKept as-is: ${result.skipped.join(', ')}` : '') +
      `\n@deepseek-ai: ${readdirSync(scope).join(', ')}\n`,
  )
}
