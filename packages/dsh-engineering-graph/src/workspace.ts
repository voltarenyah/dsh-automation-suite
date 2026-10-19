/**
 * Workspace discovery: which engineering project a session's working directory
 * holds, and where that project's knowledge databases are.
 *
 * This module exists because the engine cannot answer either question. A
 * knowledge database is a *file* the engine opens by absolute path
 * (`Operations.cs` `DefaultDbPath`, D20:
 * `<project root>/knowledge/<device>/<device>_knowledge.db`), so the model can
 * only query it by naming it — and nothing in the tool surface used to tell the
 * model what to name (see docs/decisions.md **D24**). The convention is a
 * distribution-level contract, but the *facts* (does this workspace have a
 * project? which devices? which of them already have a database? how old is
 * it?) live on disk and have to be read.
 *
 * Three deliberate properties:
 *
 *   1. **Read-only, and no engine.** Everything here is `node:fs/promises` over
 *      the workspace root, so the discovery tool still answers on a machine that
 *      has never built the C# half.
 *   2. **The directory layout is duplicated, not imported.** The engineering
 *      context plugin owns `source/` + `_dsh-engineering-context.json`, this
 *      plugin owns `knowledge/` + the database names, and D10 keeps the plugins
 *      independent (no shared package). The constants below are as much a
 *      contract as the file names themselves; they are also asserted against a
 *      real `create_engineering_project` index in the tests.
 *   3. **Nothing here decides freshness.** The database is a derived snapshot; a
 *      report carries its `modifiedAt` and the export timestamp the index
 *      recorded, and the persona forbids concluding "the code changed/did not
 *      change" from the database (D13's freshness work is still open).
 *
 * @module dsh-engineering-graph/workspace
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

/** Directory holding the exported source tree, one folder per device (the context plugin's `source/`). */
export const SOURCE_DIR_NAME = 'source'

/** Directory holding one folder per device with everything generated for it (D20). */
export const KNOWLEDGE_DIR_NAME = 'knowledge'

/** The context plugin's index of the source tree: which project it belongs to. */
export const SOURCE_INDEX_FILE = '_dsh-engineering-context.json'

/** Suffix of a device's knowledge database. */
export const DATABASE_SUFFIX = '_knowledge.db'

/** The project identity the source index recorded, or `null` when there is none. */
export interface WorkspaceProject {
  /** The project name TIA reported, as the index spelled it. */
  name: string | null
  /** The project file the run saved into the workspace, when it recorded one. */
  savedAs: string | null
  /** When the last export ran (ISO-8601), as the index recorded it. */
  exportedAt: string | null
  /** The index file this came from, absolute. */
  sourceIndex: string
}

/** One device of the project and the database it gets. */
export interface WorkspaceDevice {
  /** The device name: the `source/<device>` folder name, per D20. */
  device: string
  /**
   * Absolute path of the device's exported source folder when it can be named.
   *
   * `knowledge_ingest` takes exactly this as `device_dir`, so a report that
   * carries it is what lets a caller build a missing database without guessing.
   */
  deviceDir: string | null
  /** Absolute path of the database this device has (or should have). */
  database: string | null
  /** Whether that database file exists right now. */
  exists: boolean
  /** Size in bytes, or `null` when the file does not exist or could not be stat'ed. */
  bytes: number | null
  /** Last write time (ISO-8601), or `null` for the same reasons. */
  modifiedAt: string | null
  /**
   * Where the device came from: the source index, or a `knowledge/` folder that
   * the index does not list (reported so a stale index cannot hide a database).
   */
  origin: 'index' | 'directory'
}

/** Everything the discovery found about one workspace. */
export interface WorkspaceReport {
  /** The session working directory this was read from, absolute. */
  workspaceRoot: string
  /** The project the source index names, or `null` when there is no readable index. */
  project: WorkspaceProject | null
  /** The devices found, sorted by name. */
  devices: WorkspaceDevice[]
  /** Conditions worth the caller's attention; never a failure on its own. */
  warnings: string[]
}

/** A resolved database, or the reason the caller has to name one itself. */
export type DatabaseResolution =
  | { ok: true; path: string; device: string | null }
  | {
      ok: false
      code: 'DB_NOT_FOUND' | 'DB_AMBIGUOUS'
      message: string
      remediation: string
      /** The databases that *do* exist, absolute. Empty for `DB_NOT_FOUND`. */
      candidates: string[]
    }

/** The device name a `knowledge/<folder>/<file>.db` path implies. */
function deviceFromDatabase(file: string): string {
  const name = file.replace(/\.db$/i, '')
  return name.endsWith(DATABASE_SUFFIX) ? name.slice(0, -DATABASE_SUFFIX.length) : name
}

/** A safe `stat`, or `null` for anything that is not a readable regular file. */
async function statFile(path: string): Promise<{ bytes: number; modifiedAt: string } | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return { bytes: info.size, modifiedAt: info.mtime.toISOString() }
  } catch {
    return null
  }
}

/** A tolerant string: anything that is not a non-empty string becomes `null`. */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** The device names and source directories the index recorded. */
interface IndexedDevice {
  device: string
  directory: string | null
}

/** The index, as far as this module needs it. */
interface ParsedIndex {
  project: { name: string | null; savedAs: string | null; exportedAt: string | null }
  devices: IndexedDevice[]
}

/**
 * Read the context plugin's index, tolerantly.
 *
 * A missing file is the normal state of a workspace whose project was never
 * created here; a corrupt one is reported as a warning and treated as missing,
 * because refusing to describe the databases on disk over a broken index would
 * hide the very thing the caller asked for.
 */
async function readSourceIndex(
  workspaceRoot: string,
  sourceIndex: string,
  warnings: string[],
): Promise<ParsedIndex | null> {
  let raw: string
  try {
    raw = await readFile(sourceIndex, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') warnings.push(`The source index could not be read (${sourceIndex}): ${String(error)}`)
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warnings.push(`The source index is not valid JSON (${sourceIndex}): ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  const document = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const project = typeof document['project'] === 'object' && document['project'] !== null
    ? (document['project'] as Record<string, unknown>)
    : {}

  const devices: IndexedDevice[] = []
  const listed = Array.isArray(document['devices']) ? document['devices'] : []
  for (const entry of listed) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const device = readText(record['device'])
    if (device === null) continue
    devices.push({ device, directory: readText(record['directory']) })
  }

  void workspaceRoot
  return {
    project: {
      name: readText(project['name']),
      savedAs: readText(project['savedAs']),
      exportedAt: readText(document['exportedAt']),
    },
    devices,
  }
}

/** One database file found under `knowledge/`. */
interface FoundDatabase {
  device: string
  folder: string
  path: string
}

/**
 * Enumerate `knowledge/<folder>/<file>.db`, ignoring SQLite's side files.
 *
 * `.db-wal` / `.db-shm` / `.db-journal` do not end in `.db`, so they never match.
 * A `.db` sitting directly in `knowledge/` is off-convention; it is reported as a
 * warning instead of being silently dropped.
 */
async function findDatabases(workspaceRoot: string, warnings: string[]): Promise<FoundDatabase[]> {
  const knowledgeDir = join(workspaceRoot, KNOWLEDGE_DIR_NAME)
  let entries: Dirent[]
  try {
    entries = await readdir(knowledgeDir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      warnings.push(`The knowledge directory could not be listed (${knowledgeDir}): ${String(error)}`)
    }
    return []
  }

  const found: FoundDatabase[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      if (/\.db$/i.test(entry.name)) {
        warnings.push(`Ignoring ${join(knowledgeDir, entry.name)}: databases belong in knowledge/<device>/, one folder per device.`)
      }
      continue
    }
    const folder = join(knowledgeDir, entry.name)
    let files: Dirent[]
    try {
      files = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      warnings.push(`The device folder could not be listed (${folder}): ${String(error)}`)
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !/\.db$/i.test(file.name)) continue
      found.push({ device: entry.name, folder, path: join(folder, file.name) })
    }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

/** Whether a directory exists (used only to decide if a device folder can be named). */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Read everything the workspace tells us about the project and its databases.
 *
 * Never throws for a missing project, a missing `knowledge/` or a corrupt index:
 * an empty report with warnings is the honest answer for "this workspace has no
 * engineering project yet", which is the normal state of most sessions.
 *
 * @param workspaceRoot - the session working directory, absolute.
 * @returns the report described by {@link WorkspaceReport}.
 */
export async function discoverWorkspace(workspaceRoot: string): Promise<WorkspaceReport> {
  const warnings: string[] = []
  const sourceIndex = join(workspaceRoot, SOURCE_DIR_NAME, SOURCE_INDEX_FILE)
  const index = await readSourceIndex(workspaceRoot, sourceIndex, warnings)
  const databases = await findDatabases(workspaceRoot, warnings)

  const claimed = new Set<string>()
  const devices: WorkspaceDevice[] = []

  for (const entry of index?.devices ?? []) {
    claimed.add(entry.device)
    const own = databases.filter((database) => database.device === entry.device)
    const expected = join(workspaceRoot, KNOWLEDGE_DIR_NAME, entry.device, `${entry.device}${DATABASE_SUFFIX}`)
    const chosen = own.find((database) => database.path === expected) ?? own[0]
    const deviceDir = entry.directory !== null && isAbsolute(entry.directory)
      ? entry.directory
      : join(workspaceRoot, SOURCE_DIR_NAME, entry.device)
    const info = chosen === undefined ? null : await statFile(chosen.path)
    if (chosen !== undefined && chosen.path !== expected) {
      warnings.push(
        `Device ${entry.device}: the convention names ${expected}, but ${chosen.path} is what exists; the report uses the file on disk.`,
      )
    }
    devices.push({
      device: entry.device,
      deviceDir,
      database: chosen?.path ?? expected,
      exists: chosen !== undefined && info !== null,
      bytes: info?.bytes ?? null,
      modifiedAt: info?.modifiedAt ?? null,
      origin: 'index',
    })
  }

  // A database the index does not list must not be invisible: a stale index (or a
  // device someone ingested by hand) is exactly when the caller needs to know.
  for (const database of databases) {
    if (claimed.has(database.device)) continue
    claimed.add(database.device)
    const info = await statFile(database.path)
    const candidateDir = join(workspaceRoot, SOURCE_DIR_NAME, database.device)
    warnings.push(
      `Device ${database.device} has a database (${database.path}) but is not listed in ${sourceIndex}; the index may be stale.`,
    )
    devices.push({
      device: database.device,
      deviceDir: (await directoryExists(candidateDir)) ? candidateDir : null,
      database: database.path,
      exists: info !== null,
      bytes: info?.bytes ?? null,
      modifiedAt: info?.modifiedAt ?? null,
      origin: 'directory',
    })
  }

  devices.sort((left, right) => left.device.localeCompare(right.device, 'en'))

  return {
    workspaceRoot,
    project:
      index === null
        ? null
        : {
            name: index.project.name,
            savedAs: index.project.savedAs,
            exportedAt: index.project.exportedAt,
            sourceIndex,
          },
    devices,
    warnings,
  }
}

/**
 * Pick the database a caller meant when it did not name one.
 *
 * The rule is deliberately strict: one existing database is used, **zero and two
 * or more are refusals**. Guessing between devices would answer questions about
 * the wrong PLC with total confidence, and this distribution's standing rule is
 * that a wrong answer costs more than a named refusal (see `tool-surface.md`
 * §5.1 on why the controller's caps are never silently paged).
 *
 * @param report - the discovery result for the session's workspace.
 * @returns the database to query, or a coded refusal naming the alternatives.
 */
export function resolveDatabasePath(report: WorkspaceReport): DatabaseResolution {
  const existing = report.devices.filter(
    (device): device is WorkspaceDevice & { database: string } => device.exists && device.database !== null,
  )

  if (existing.length === 1) {
    const only = existing[0]!
    return { ok: true, path: only.database, device: only.device }
  }

  if (existing.length === 0) {
    const buildable = report.devices.filter((device) => device.deviceDir !== null)
    const hint = buildable.length === 0
      ? 'This workspace holds no engineering project: run create_engineering_project first, or pass db_path explicitly.'
      : `Build one with knowledge_ingest (device_dir: ${buildable.map((device) => `'${device.deviceDir}'`).join(', ')}), ` +
        'or ask the agent that owns the project to rebuild it.'
    return {
      ok: false,
      code: 'DB_NOT_FOUND',
      message:
        report.devices.length === 0
          ? `No knowledge database was found under ${report.workspaceRoot}.`
          : `No knowledge database exists yet for ${report.devices.length} device(s) under ${report.workspaceRoot}.`,
      remediation: `${hint} Call knowledge_workspace for the full list.`,
      candidates: [],
    }
  }

  const paths = existing.map((device) => device.database)
  return {
    ok: false,
    code: 'DB_AMBIGUOUS',
    message:
      `This workspace has ${existing.length} knowledge databases (one per device: ` +
      `${existing.map((device) => device.device).join(', ')}), so db_path is required.`,
    remediation: `Pass db_path explicitly, for example '${paths[0]}'. Call knowledge_workspace to see every device.`,
    candidates: paths,
  }
}

/**
 * Spell a path the way the model should read it: relative to the workspace when
 * it is inside, forward-slashed, and absolute otherwise.
 *
 * @param workspaceRoot - the session working directory.
 * @param path - the absolute path to spell.
 */
export function portablePath(workspaceRoot: string, path: string): string {
  const inside = relative(workspaceRoot, path)
  if (inside.length === 0) return '.'
  if (inside.startsWith('..') || isAbsolute(inside)) return path
  return inside.split('\\').join('/')
}

/**
 * Bytes as the one number a model needs, in MB with one decimal.
 *
 * @param bytes - the size, or `null`.
 * @returns the human spelling, or `null` when there is nothing to spell.
 */
export function renderBytes(bytes: number | null): string | null {
  if (bytes === null) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The database a call will run against, or why there is none to use. */
export type DatabaseChoice =
  | { ok: true; path: string }
  | { ok: false; code: string; message: string; remediation: string }

/**
 * Decide the database a read-only call runs against, shared by every tool that
 * needs one (`knowledge_query` and the drill-down tools).
 *
 * An explicit path always wins: absolute is taken verbatim, relative is resolved
 * against the session working directory — the engine resolves relative paths
 * against its **own** process directory, which is never what a caller means.
 * Without one, the workspace is inspected and the single existing device database
 * is used; none or several is a refusal naming the alternatives, because
 * answering a question about the wrong PLC with full confidence is worse than
 * asking for a path (D24).
 *
 * @param explicitPath - the tool argument, if the model supplied one.
 * @param cwd - the session working directory, if the harness supplied one.
 * @returns the absolute path, or a coded refusal the caller renders.
 */
export async function chooseDatabase(explicitPath: string | undefined, cwd: string | undefined): Promise<DatabaseChoice> {
  const spelled = explicitPath?.trim() ?? ''
  if (spelled.length > 0) {
    if (isAbsolute(spelled)) return { ok: true, path: spelled }
    if (cwd === undefined || cwd.trim().length === 0) {
      return {
        ok: false,
        code: 'WORKSPACE_UNAVAILABLE',
        message: `The relative db_path '${spelled}' cannot be resolved: the harness supplied no session working directory.`,
        remediation: 'Pass an absolute db_path.',
      }
    }
    return { ok: true, path: join(cwd, spelled) }
  }

  if (cwd === undefined || cwd.trim().length === 0) {
    return {
      ok: false,
      code: 'WORKSPACE_UNAVAILABLE',
      message:
        'db_path was omitted and the harness supplied no session working directory, so there is no workspace to resolve it in.',
      remediation: 'Pass an absolute db_path, or run this tool from a session that has a working directory.',
    }
  }

  const resolution = resolveDatabasePath(await discoverWorkspace(cwd))
  if (resolution.ok) return { ok: true, path: resolution.path }
  return {
    ok: false,
    code: resolution.code,
    message: resolution.message,
    remediation: resolution.remediation,
  }
}
