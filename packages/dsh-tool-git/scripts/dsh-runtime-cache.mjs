/**
 * Materialise the DeepSeek Harness runtime packages on disk, out of the
 * installed app's `resources/app.asar`.
 *
 * Why this exists: a bare checkout of this plugin imports
 * `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`
 * and — from its test fixtures — `@deepseek-ai/dsh-system-prompt`, exactly like a
 * published plugin does, and the tests deliberately exercise the *real* runtime
 * rather than a stub. An installed plugin never needs any of this — the profile
 * resolves those packages from the running app itself. A checkout does, and plain
 * Node cannot import from inside an ASAR.
 *
 * The extraction is deliberately version-aware. The DSH runtime version is read
 * from the app's own `@deepseek-ai/dsh-app-boot` manifest, so the tests always
 * run against the runtime the installed app actually ships — never against some
 * older copy that happens to be lying around in an npm/npx cache.
 *
 * Layout written under `<DSH_HOME>/plugin-runtime`:
 *
 *   runtime.json                     { version, archive, extractedAt, packages }
 *   node_modules/<name>/…            a flat, hoisted tree
 *
 * A flat tree matters: Node resolves the real path of a linked package and then
 * walks up looking for `node_modules`, so hoisting every dependency to
 * `plugin-runtime/node_modules` is what makes the linked packages' own imports
 * resolve without a nested install.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { readAsarFile, readAsarIndex, unpackedDirFor } from './asar-read.mjs'

/**
 * The root packages to extract, as fully scoped npm names.
 * `link-dsh-runtime.mjs` derives the bare names it links locally from this list,
 * so the two can never drift apart.
 */
export const RUNTIME_ROOTS = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-system-prompt',
]

/** Directory, inside the archive, that holds the harness's hoisted node_modules. */
const ARCHIVE_MODULES = 'dsh/node_modules'

/** Name of the marker file that identifies a cache this module owns. */
const CACHE_MARKER = 'runtime.json'

/** @returns {string} the DeepSeek Harness home (`$DSH_HOME`, default `~/.dsh`). */
export function dshHome() {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** @returns {string} the directory this module extracts into. */
export function runtimeCacheDir() {
  return join(dshHome(), 'plugin-runtime')
}

/**
 * Candidate `@deepseek-ai` directories, best source first.
 *
 * The extracted cache comes first on purpose: `~/.dsh/profiles/<profile>/node_modules`
 * may hold projections of an older harness, and testing against those would
 * silently validate the plugin against the wrong runtime version.
 *
 * @returns {string[]} absolute candidate directories.
 */
export function runtimeCacheCandidates() {
  return [join(runtimeCacheDir(), 'node_modules', '@deepseek-ai')]
}

/**
 * Locate the installed app's ASAR archive.
 *
 * @returns {string | null} the archive path, or null when no candidate exists.
 */
export function findAppAsar() {
  const fromEnvironment = process.env['DSH_APP_ASAR']
  const candidates = [
    ...(fromEnvironment === undefined ? [] : [fromEnvironment]),
    // Running inside the app (Electron binary as process.execPath).
    join(dirname(process.execPath), 'resources', 'app.asar'),
    // Per-user install used by the desktop build.
    ...(process.env['LOCALAPPDATA'] === undefined
      ? []
      : [
          join(process.env['LOCALAPPDATA'], 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
          join(process.env['LOCALAPPDATA'], 'DeepSeek Harness', 'resources', 'app.asar'),
        ]),
    // Machine-wide install.
    ...(process.env['PROGRAMFILES'] === undefined
      ? []
      : [join(process.env['PROGRAMFILES'], 'DeepSeek Harness', 'resources', 'app.asar')]),
  ]

  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/** @returns {{version: string, archive: string, extractedAt: string, packages: string[]} | null} */
function readCacheMarker() {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeCacheDir(), CACHE_MARKER), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** @returns {string | null} the harness runtime version carried by the archive. */
function archiveRuntimeVersion(archive, index) {
  const buffer = readAsarFile(
    archive,
    index,
    `${ARCHIVE_MODULES}/@deepseek-ai/dsh-app-boot/package.json`,
    unpackedDirFor(archive),
  )
  if (buffer === null) return null
  const version = JSON.parse(buffer.toString('utf8')).version
  return typeof version === 'string' ? version : null
}

/**
 * Every package a manifest names as needed at load time.
 *
 * Peer dependencies are not optional here in practice: the harness packages
 * declare each other as peers, and they import those peers eagerly. Omitting
 * them produces a cache that looks complete but fails on the first import —
 * `@deepseek-ai/dsh-tools` reaches `@deepseek-ai/dsh-scope` the moment it loads.
 *
 * @returns {string[]} the package names to follow.
 */
function requiredPackages(manifest) {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
}

/**
 * Resolve the full load-time closure of {@link RUNTIME_ROOTS} inside the archive.
 *
 * @returns {{ located: Map<string, string>, missing: string[] }} package name →
 * archive directory, plus any named package the archive does not carry.
 */
function resolveClosure(archive, index) {
  const unpackedDir = unpackedDirFor(archive)
  const located = new Map()
  const missing = []
  const queue = [...RUNTIME_ROOTS]

  /** Find one package's directory: hoisted first, then nested under a located parent. */
  const locate = (name) => {
    const candidates = [`${ARCHIVE_MODULES}/${name}`]
    for (const dir of located.values()) candidates.push(`${dir}/node_modules/${name}`)
    for (const dir of candidates) {
      if (index.files.has(`${dir}/package.json`)) return dir
    }
    return null
  }

  while (queue.length > 0) {
    const name = queue.shift()
    if (located.has(name)) continue

    const dir = locate(name)
    if (dir === null) {
      missing.push(name)
      continue
    }

    const manifest = JSON.parse(
      readAsarFile(archive, index, `${dir}/package.json`, unpackedDir).toString('utf8'),
    )
    located.set(name, dir)
    for (const dependency of requiredPackages(manifest)) {
      if (!located.has(dependency)) queue.push(dependency)
    }
  }

  return { located, missing }
}

/** Write every file of one archived directory into the cache. */
function extractDirectory(archive, index, archiveDir, destination) {
  const prefix = `${archiveDir}/`
  const unpackedDir = unpackedDirFor(archive)
  let written = 0

  for (const path of index.files.keys()) {
    if (!path.startsWith(prefix)) continue
    const contents = readAsarFile(archive, index, path, unpackedDir)
    if (contents === null) continue
    const target = join(destination, path.slice(prefix.length))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
    written++
  }

  return written
}

/**
 * True when every {@link RUNTIME_ROOTS} package is present in the cache.
 *
 * The marker records the harness version, not the root set that produced the
 * cache: the sibling `dsh-tia-openness-v17-min` package shares this directory
 * through the same `DSH_HOME` and may have populated it from a smaller root set.
 * A cache whose version still matches but which lacks a package this plugin
 * imports would leave the link step with no source, so the roots are checked
 * explicitly before the cache is accepted.
 *
 * @returns {boolean} whether all root packages exist in the cached tree.
 */
function cachedRootsPresent() {
  const modules = join(runtimeCacheDir(), 'node_modules')
  return RUNTIME_ROOTS.every((name) => existsSync(join(modules, name, 'package.json')))
}

/**
 * Ensure `<DSH_HOME>/plugin-runtime` holds the runtime closure of the installed app.
 *
 * Re-extracts when the recorded version no longer matches the app, so a harness
 * upgrade is picked up automatically on the next run.
 *
 * @param {{ quiet?: boolean, force?: boolean }} [options] `force` re-extracts even
 * when the recorded version still matches.
 * @returns {{ ok: boolean, reason?: string, dir?: string, version?: string, archive?: string, files?: number, extracted?: string[] }}
 */
export function ensureRuntimeCache({ quiet = false, force = false } = {}) {
  const archive = findAppAsar()
  if (archive === null) {
    return { ok: false, reason: 'no-installed-app-asar (set DSH_APP_ASAR to override)' }
  }

  let index
  try {
    index = readAsarIndex(archive)
  } catch (error) {
    return { ok: false, reason: `unreadable archive ${archive}: ${error.message}` }
  }

  const version = archiveRuntimeVersion(archive, index)
  if (version === null) {
    return { ok: false, reason: `archive ${archive} carries no @deepseek-ai/dsh-app-boot manifest` }
  }

  const cached = readCacheMarker()
  if (
    !force &&
    cached !== null &&
    cached.version === version &&
    existsSync(join(runtimeCacheDir(), 'node_modules')) &&
    cachedRootsPresent()
  ) {
    return { ok: true, dir: runtimeCacheDir(), version, archive: cached.archive, files: 0, extracted: [] }
  }

  // Only ever delete a directory this module created; anything else is someone
  // else's data and a wrong guess here would be destructive.
  const cacheRoot = runtimeCacheDir()
  if (existsSync(cacheRoot) && cached === null) {
    return { ok: false, reason: `${cacheRoot} exists without ${CACHE_MARKER}; refusing to replace it` }
  }
  if (existsSync(cacheRoot)) rmSync(cacheRoot, { recursive: true, force: true })

  const { located, missing } = resolveClosure(archive, index)
  const missingRoots = missing.filter((name) => RUNTIME_ROOTS.includes(name))
  if (missingRoots.length > 0) {
    return { ok: false, reason: `archive ${archive} is missing required runtime packages: ${missingRoots.join(', ')}` }
  }
  if (missing.length > 0 && !quiet) {
    console.warn(
      `runtime cache: ${missing.length} declared peer(s) are not shipped by this app and were skipped: ${missing.join(', ')}`,
    )
  }

  const modules = join(cacheRoot, 'node_modules')
  let files = 0
  for (const [name, dir] of located) files += extractDirectory(archive, index, dir, join(modules, name))

  mkdirSync(cacheRoot, { recursive: true })
  writeFileSync(
    join(cacheRoot, CACHE_MARKER),
    `${JSON.stringify({ version, archive, extractedAt: new Date().toISOString(), packages: [...located.keys()].sort() }, undefined, 2)}\n`,
  )

  if (!quiet) {
    console.log(`runtime cache: extracted ${located.size} packages (dsh ${version}) from ${archive} → ${cacheRoot}`)
  }

  return { ok: true, dir: cacheRoot, version, archive, files, extracted: [...located.keys()].sort() }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (invokedDirectly) {
  const result = ensureRuntimeCache({ force: process.argv.includes('--force') })
  if (!result.ok) {
    console.error(`runtime cache: ${result.reason}`)
    process.exit(1)
  }
  console.log(`runtime cache ready: dsh ${result.version} in ${result.dir}`)
  console.log(`packages: ${(result.extracted.length > 0 ? result.extracted : readCacheMarker()?.packages ?? []).join(', ')}`)
}
