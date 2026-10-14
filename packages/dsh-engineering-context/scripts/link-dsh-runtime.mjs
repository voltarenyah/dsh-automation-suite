/**
 * Make a bare checkout of this package resolvable, without running a workspace
 * install.
 *
 * An installed plugin needs none of this: the profile's runtime resolution maps
 * `@deepseek-ai/*` to the harness's own copies, and the profile install provides
 * the dev dependencies. A bare checkout needs both, so this script creates
 * junctions under this package's `node_modules/`:
 *
 *   1. `@deepseek-ai/{dsh-tools,cordis,schemastery}` — the harness runtime the
 *      plugin imports exactly like a published plugin does, and which the test
 *      suite runs against for real (never a stub).
 *   2. `typescript` and `@types` — the two packages `tsc` needs, taken from the
 *      copies this repository already has. `pnpm install` would be the normal
 *      way to get them; it is skipped on purpose here (docs/decisions.md P0-3),
 *      because a workspace install in a shared working tree also prunes the
 *      hand-made `@deepseek-ai/*` links of the sibling packages.
 *
 * This script **never writes outside this package**, and in particular it never
 * extracts the harness runtime: the sibling package's extractor deletes and
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
 */
export const RUNTIME_ROOTS = [
  '@deepseek-ai/dsh-tools',
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
 * folders under `profiles/` are kept as a last resort and may be stale — the
 * root AGENTS.md records an incident where a projection pointed at a dangling
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

/**
 * The development packages `tsc` needs, with the copies this repository
 * already has, best source first.
 *
 * `@types` is a *scope* directory, not a package: it has no `package.json` of
 * its own, which is why the entries below carry a `kind`.
 *
 * @param {string} repoRoot - the monorepo root.
 * @returns {{ name: string, kind: 'package' | 'scope', sources: string[] }[]} links to create.
 */
function developmentLinks(repoRoot) {
  return [
    { name: 'typescript', kind: 'package', sources: [join(repoRoot, 'node_modules', 'typescript')] },
    {
      name: '@types',
      kind: 'scope',
      sources: [
        join(repoRoot, 'packages', 'dsh-tia-openness-v17-min', 'node_modules', '@types'),
        join(repoRoot, 'packages', 'dsh-tool-git', 'node_modules', '@types'),
      ],
    },
  ]
}

function findSource(entry) {
  for (const candidate of entry.sources) {
    if (entry.kind === 'package') {
      if (existsSync(join(candidate, 'package.json'))) return candidate
      continue
    }
    // A scope is usable when it exists and actually holds a package.
    if (!existsSync(candidate)) continue
    try {
      if (readdirSync(candidate).some((child) => existsSync(join(candidate, child, 'package.json')))) return candidate
    } catch {
      // Unreadable directory: treat as absent.
    }
  }
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
 * Link one package (or scope directory) into this package's `node_modules`.
 *
 * @returns {'present' | 'linked' | 'missing' | 'skipped'}
 */
function linkOne(root, entry, force) {
  const target = join(root, 'node_modules', ...entry.name.split('/'))
  if (existsSync(target)) {
    if (!force) return 'present'
    const stats = lstatSync(target)
    // A real directory is somebody's install: refuse to delete it rather than
    // guess. A link is always ours to replace.
    if (!stats.isSymbolicLink()) {
      console.warn(`kept ${entry.name}: it is a real directory, not a link — remove it yourself if you want it relinked`)
      return 'skipped'
    }
    removeLink(target)
  }
  const source = findSource(entry)
  if (source === null) return 'missing'
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  return 'linked'
}

/**
 * Link everything this package needs.
 *
 * @param {{ force?: boolean, quiet?: boolean }} [options]
 * @returns {{ linked: string[], present: string[], missing: string[], skipped: string[], missingRuntime: string[] }}
 */
export function linkRuntime({ force = false, quiet = false } = {}) {
  const root = packageRoot()
  const repoRoot = dirname(dirname(root))
  const scope = join(root, 'node_modules', '@deepseek-ai')
  mkdirSync(scope, { recursive: true })

  const result = { linked: [], present: [], missing: [], skipped: [], missingRuntime: [] }
  const runtime = RUNTIME_ROOTS.map((name) => ({
    name,
    kind: /** @type {'package'} */ ('package'),
    sources: runtimeCandidates().map((directory) => join(directory, name.replace('@deepseek-ai/', ''))),
  }))
  const runtimeNames = new Set(runtime.map((entry) => entry.name))

  for (const entry of [...runtime, ...developmentLinks(repoRoot)]) {
    const outcome = linkOne(root, entry, force)
    if (outcome === 'missing' && runtimeNames.has(entry.name)) result.missingRuntime.push(entry.name)
    result[outcome === 'missing' ? 'missing' : outcome === 'skipped' ? 'skipped' : outcome].push(entry.name)
    if (!quiet && outcome === 'linked') {
      console.log(`linked ${entry.name} -> ${findSource(entry)}`)
    }
  }
  return result
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (invokedDirectly) {
  const force = process.argv.includes('--force')
  const result = linkRuntime({ force })
  if (result.missing.length > 0) {
    const lines = [`\nCould not resolve: ${result.missing.join(', ')}`]
    if (result.missingRuntime.length > 0) {
      lines.push(
        `Harness runtime searched in: ${runtimeCandidates().join(', ')}`,
        'Install DeepSeek Harness and/or set DSH_HOME to its home folder. This script never extracts the runtime cache, ' +
          'because that directory is outside the repository. To (re)build the cache, run the sibling package\'s extractor ' +
          'deliberately: pnpm --filter @voltarenyah/dsh-tia-openness-v17-min run link:runtime',
      )
    }
    const missingDevelopment = result.missing.filter((name) => !result.missingRuntime.includes(name))
    if (missingDevelopment.length > 0) {
      lines.push(
        `Development packages not found (${missingDevelopment.join(', ')}). Run "pnpm install" at the repository root — ` +
          'that is the normal way to get them; this script only avoids it while a workspace install in a shared working ' +
          "tree would also prune the sibling packages' hand-made runtime links.",
      )
    }
    console.error(`${lines.join('\n')}\n`)
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
