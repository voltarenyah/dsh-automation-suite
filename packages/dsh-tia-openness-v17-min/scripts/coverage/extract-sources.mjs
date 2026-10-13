#!/usr/bin/env node
/**
 * Snapshots the two external sources of the coverage matrix into
 * `docs/coverage-matrix.sources.json`:
 *
 *   1. the Openness API surface  — `Siemens.Engineering.xml` of the local
 *      TIA Portal V17 installation (namespaces, type names, member counts);
 *   2. the manual's table of contents — the `.hhc` inside the official V17
 *      Openness help, extracted with `hh.exe -decompile` into a temp directory
 *      that is deleted again.
 *
 * Both live outside the repository and depend on the machine, so the generated
 * HTML is built from this snapshot instead: `build-matrix.mjs` then works
 * anywhere, and a TIA version bump has exactly one refresh step.
 *
 * The snapshot stores only facts (namespace/type names, TOC titles counts) —
 * no manual prose is copied. See AGENTS.md.
 *
 * Usage:
 *   node scripts/coverage/extract-sources.mjs [--openness-dir <dir>] [--help-dir <dir>]
 *                                             [--manual-toc <file.hhc>] [--out <file>]
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_DEFAULT = join(REPO, 'docs', 'coverage-matrix.sources.json')
const TIA_MAJOR = 17

/** Minimal command line parsing; the flags are few and stable. */
function parseArgs(argv) {
  const options = { opennessDir: process.env.TIA_OPENNESS_V17_DIR ?? null, helpDir: null, manualToc: null, out: OUT_DEFAULT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[i + 1]
    const take = () => {
      if (!arg.includes('=')) i++
      return value
    }
    if (arg.startsWith('--openness-dir')) options.opennessDir = take()
    else if (arg.startsWith('--help-dir')) options.helpDir = take()
    else if (arg.startsWith('--manual-toc')) options.manualToc = take()
    else if (arg.startsWith('--out')) options.out = take()
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

/** Reads the `Siemens.Engineering` value the official package also uses. */
function opennessDirFromRegistry() {
  if (process.platform !== 'win32') return null
  const key = `HKLM\\SOFTWARE\\Siemens\\Automation\\Openness\\${TIA_MAJOR}.0\\PublicAPI\\${TIA_MAJOR}.0.0.0`
  const result = spawnSync('reg', ['query', key, '/v', 'Siemens.Engineering'], { encoding: 'utf8' })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  const match = /REG_SZ\s+(.+?)\s*$/m.exec(result.stdout)
  return match === null ? null : dirname(match[1].trim())
}

/** Resolves the `PublicAPI\V17` directory, or explains every place it looked. */
function resolveOpennessDir(explicit) {
  const candidates = [
    explicit,
    `C:\\Program Files\\Siemens\\Automation\\Portal V${TIA_MAJOR}\\PublicAPI\\V${TIA_MAJOR}`,
    opennessDirFromRegistry(),
  ].filter((value) => typeof value === 'string' && value.length > 0)

  for (const candidate of candidates) {
    const dir = resolve(candidate)
    if (existsSync(join(dir, 'Siemens.Engineering.xml'))) return dir
  }
  throw new Error(
    `No TIA Portal V${TIA_MAJOR} Openness installation found. Looked at:\n  ` +
      candidates.join('\n  ') +
      `\nPass --openness-dir <PublicAPI\\V${TIA_MAJOR}> or set TIA_OPENNESS_V17_DIR.`,
  )
}

/** Decodes a buffer as UTF-8, falling back to latin1 for the legacy help files. */
function decode(buf) {
  const utf8 = buf.toString('utf8')
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Decodes the entities the help TOC actually uses and collapses whitespace. */
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parses a compiled help TOC (`.hhc`) into the manual's section tree.
 *
 * The file is a flat stream of `<UL>`/`</UL>`/`<param name="Name" value="…">`
 * tokens, so the nesting level is the running `<UL>` depth.
 */
function parseToc(text) {
  const token = /<ul>|<\/ul>|<param\s+name="Name"\s+value="([^"]*)"/gi
  const roots = []
  const stack = []
  let depth = 0
  let count = 0

  for (const match of text.matchAll(token)) {
    const value = match[0]
    if (/^<ul>/i.test(value)) {
      depth++
    } else if (/^<\/ul>/i.test(value)) {
      depth--
    } else {
      const node = { title: decodeEntities(match[1]), children: [] }
      while (stack.length > depth) stack.pop()
      const parent = stack[depth - 1]
      if (parent === undefined) roots.push(node)
      else parent.children.push(node)
      stack[depth] = node
      count++
    }
  }
  return { roots, count }
}

/**
 * Unpacks the manual CHM with `hh.exe -decompile`.
 *
 * The indirection through PowerShell is not cosmetic: `hh.exe` only performs
 * the extraction when it is launched through ShellExecute (which is what
 * `Start-Process` does). Started directly — `spawnSync('hh.exe', …)` or even
 * `& hh.exe …` in PowerShell — it exits with code 0 after ~75 ms and writes
 * nothing at all.
 */
function decompileChm(chm, work) {
  const quoted = (value) => `'${value.replace(/'/g, "''")}'`
  const script =
    `Start-Process -FilePath hh.exe -ArgumentList @('-decompile',${quoted(work)},${quoted(chm)}) ` +
    '-Wait -WindowStyle Hidden'
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  if (result.error !== undefined) {
    throw new Error(`hh.exe could not be started (${result.error.message}). Pass --manual-toc <file.hhc> instead.`)
  }
  const hhc = waitForEntry(work, (name) => name.toLowerCase().endsWith('.hhc'))
  if (hhc === undefined) {
    throw new Error(
      `hh.exe extracted no .hhc from ${chm}.\n` +
        'Pass --manual-toc <file.hhc> pointing at an extracted table of contents instead.',
    )
  }
  return join(work, hhc)
}

/** Locates the official help TOC, decompiling the CHM when necessary. */
function readManualToc(options, portalRoot) {
  if (options.manualToc !== null) {
    const file = resolve(options.manualToc)
    const buf = readFileSync(file)
    return { path: file, sha256: sha256(buf), ...parseToc(decode(buf)) }
  }

  const helpDir = options.helpDir !== null ? resolve(options.helpDir) : join(portalRoot, 'Help', 'en-US')
  const chm = join(helpDir, 'TIAPortalOpennessenUS.chm')
  if (!existsSync(chm)) {
    throw new Error(
      `The Openness manual was not found at ${chm}.\n` +
        'Pass --help-dir <…\\Help\\en-US>, --manual-toc <file.hhc>, or extract once on a machine that has TIA Portal installed.',
    )
  }

  const work = mkdtempSync(join(tmpdir(), 'dsh-matrix-toc-'))
  try {
    const hhc = decompileChm(chm, work)
    const buf = readFileSync(hhc)
    return { path: chm, sha256: sha256(readFileSync(chm)), tocSha256: sha256(buf), ...parseToc(decode(buf)) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Reads the API surface out of the XML documentation file. */
function readApi(opennessDir) {
  const xmlPath = join(opennessDir, 'Siemens.Engineering.xml')
  const dllPath = join(opennessDir, 'Siemens.Engineering.dll')
  const xml = readFileSync(xmlPath, 'utf8')

  const types = new Map()
  let memberCount = 0
  let typeCount = 0
  for (const match of xml.matchAll(/<member\s+name="([A-Z]):([^"]+)"/g)) {
    memberCount++
    if (match[1] !== 'T') continue
    typeCount++
    const full = match[2]
    const dot = full.lastIndexOf('.')
    const ns = dot > 0 ? full.slice(0, dot) : '(global)'
    const short = dot > 0 ? full.slice(dot + 1) : full
    const bucket = types.get(ns)
    if (bucket === undefined) types.set(ns, new Set([short]))
    else bucket.add(short)
  }

  const namespaces = {}
  for (const ns of [...types.keys()].sort()) namespaces[ns] = [...types.get(ns)].sort()

  return {
    opennessDir,
    assembly: existsSync(dllPath) ? dllPath : null,
    assemblyBytes: existsSync(dllPath) ? statSync(dllPath).size : null,
    xml: xmlPath,
    xmlSha256: sha256(Buffer.from(xml, 'utf8')),
    typeCount,
    memberCount,
    namespaceCount: types.size,
    namespaces,
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Blocking poll. `hh.exe -decompile` returns after ~75 ms while the extraction
 * keeps running in a detached process, so the output has to be waited for.
 */
function waitForEntry(dir, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = readdirSync(dir).find(predicate)
    if (found !== undefined) return found
    if (Date.now() > deadline) return undefined
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const opennessDir = resolveOpennessDir(options.opennessDir)
  const portalRoot = resolve(opennessDir, '..', '..')

  const api = readApi(opennessDir)
  const toc = readManualToc(options, portalRoot)

  const snapshot = {
    schema: 1,
    extractedAt: new Date().toISOString(),
    tia: { majorVersion: TIA_MAJOR, portalRoot, opennessDir },
    api,
    manual: {
      source: toc.path,
      sourceSha256: toc.sha256,
      tocSha256: toc.tocSha256 ?? toc.sha256,
      entryCount: toc.count,
      toc: toc.roots,
    },
  }

  mkdirSync(dirname(resolve(options.out)), { recursive: true })
  writeFileSync(resolve(options.out), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `Wrote ${resolve(options.out)}\n` +
      `  API:    ${api.typeCount} types / ${api.memberCount} members / ${api.namespaceCount} namespaces\n` +
      `  Manual: ${toc.count} TOC entries from ${toc.path}\n`,
  )
}

main()
