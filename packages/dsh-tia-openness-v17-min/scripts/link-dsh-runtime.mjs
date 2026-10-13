/**
 * Makes the DSH runtime packages resolvable from this checkout.
 *
 * An installed plugin never needs this: the profile's runtime resolution maps
 * `@deepseek-ai/*` to the harness's own copies. A bare checkout does, because
 * the plugin imports `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis` and
 * `@deepseek-ai/schemastery` exactly like a published plugin does.
 *
 * Two sources are tried, in this order:
 *
 *   1. `<DSH_HOME>/plugin-runtime` — the installed app's own runtime, extracted
 *      out of its `resources/app.asar` on demand by `dsh-runtime-cache.mjs`.
 *      This is the only source that is guaranteed to match the harness version
 *      the app actually runs.
 *   2. `~/.dsh/profiles/<profile>/node_modules/@deepseek-ai` — folders older harness
 *      releases projected packages into. Only kept as a fallback: on a machine
 *      where those are stale or dangling, using them would silently validate
 *      the plugin against the wrong runtime version.
 *
 * The packages are linked into `node_modules/@deepseek-ai/`. Node resolves the
 * real path, so the linked packages keep their own dependencies available —
 * which works because the extraction writes one flat, hoisted tree.
 *
 * Usage:
 *   node scripts/link-dsh-runtime.mjs            # link what is missing
 *   node scripts/link-dsh-runtime.mjs --force    # re-link from scratch
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RUNTIME_ROOTS, dshHome, ensureRuntimeCache, runtimeCacheCandidates } from './dsh-runtime-cache.mjs'

export { dshHome }

/** The scope that holds the harness runtime packages. */
const RUNTIME_SCOPE = '@deepseek-ai'

/**
 * Bare package names to link, derived from the extraction roots so the cache and
 * the links can never disagree about which packages this plugin needs.
 */
const PACKAGES = RUNTIME_ROOTS.map((name) =>
  name.startsWith(`${RUNTIME_SCOPE}/`) ? name.slice(RUNTIME_SCOPE.length + 1) : name,
)

/** Candidate folders that hold the harness runtime packages, best source first. */
export function runtimeCandidates() {
  const home = dshHome()
  return [
    ...runtimeCacheCandidates(),
    join(home, 'profiles', 'node_modules', RUNTIME_SCOPE),
    join(home, 'profiles', 'desktop', 'node_modules', RUNTIME_SCOPE),
    join(home, 'profiles', 'web', 'node_modules', RUNTIME_SCOPE),
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
 * Remove a previous link without ever traversing it.
 *
 * A link here may point into the harness installation, and a recursive delete
 * that follows the link destroys the *target* — the incident recorded in
 * `docs/ECOSYSTEM-COMPAT.md` cost a repository its `.git` metadata that way.
 * Node reports junctions as symlinks, so those are unlinked; only a real
 * directory is removed recursively.
 */
function removeLinkOrDirectory(path) {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return
  }
  if (stats.isSymbolicLink()) unlinkSync(path)
  else rmSync(path, { recursive: true, force: true })
}

/**
 * @returns {{ linked: string[], present: string[], missing: string[] }}
 */
export function linkRuntime({ force = false, quiet = false } = {}) {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const scope = join(packageRoot, 'node_modules', RUNTIME_SCOPE)
  mkdirSync(scope, { recursive: true })

  const linked = []
  const present = []
  const missing = []
  let cacheAttempted = false

  /** Populate the app-derived cache once, the first time a source is missing. */
  const tryCache = () => {
    if (cacheAttempted) return
    cacheAttempted = true
    const result = ensureRuntimeCache({ quiet: true })
    if (quiet) return
    if (result.ok && result.extracted.length > 0) {
      console.log(`extracted ${result.extracted.length} runtime packages (dsh ${result.version}) -> ${result.dir}`)
    } else if (!result.ok) {
      console.error(`runtime cache unavailable: ${result.reason}`)
    }
  }

  for (const packageName of PACKAGES) {
    const target = join(scope, packageName)

    if (existsSync(join(target, 'package.json'))) {
      if (!force) {
        present.push(packageName)
        continue
      }
      removeLinkOrDirectory(target)
    }

    let source = findSource(packageName)
    if (source === null) {
      tryCache()
      source = findSource(packageName)
    }

    if (source === null) {
      missing.push(packageName)
      continue
    }

    try {
      // A Windows junction needs no elevation and behaves like a directory link.
      symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(packageName)
      if (!quiet) console.log(`linked ${RUNTIME_SCOPE}/${packageName} -> ${source}`)
    } catch (error) {
      missing.push(packageName)
      if (!quiet) console.error(`could not link ${RUNTIME_SCOPE}/${packageName}: ${error.message}`)
    }
  }

  return { linked, present, missing }
}

/**
 * The runtime packages this package still has to link.
 *
 * A package counts as unresolved as soon as its local link is missing, whether
 * or not a source can be found: the callers use this to decide whether to link
 * at all, so "a source exists" must not answer the question. Reporting an
 * available-but-unlinked package as resolved would skip linking and surface a
 * bare module-resolution error instead of the actionable message below.
 *
 * @returns {string[]} the runtime packages that are not linked into this package yet.
 */
export function unresolvedRuntimePackages() {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  return PACKAGES.filter((packageName) => {
    const local = join(packageRoot, 'node_modules', RUNTIME_SCOPE, packageName, 'package.json')
    return !existsSync(local)
  })
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (invokedDirectly) {
  const result = linkRuntime({ force: process.argv.includes('--force') })
  if (result.missing.length > 0) {
    console.error(
      `\nCould not resolve: ${result.missing.join(', ')}\n` +
        `Searched: ${runtimeCandidates().join(', ')}\n` +
        'Install DeepSeek Harness, set DSH_HOME to its home folder, or point DSH_APP_ASAR at its resources/app.asar.',
    )
    process.exit(1)
  }
  const scope = join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules', RUNTIME_SCOPE)
  console.log(`\nReady: ${readdirSync(scope).join(', ')}`)
}
