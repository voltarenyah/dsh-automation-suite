/**
 * The visible handoff package directory and its record.
 *
 * Layout (docs/PATH-RULES.md, handoff section):
 *
 *   <workspace>/handoff/<handoffId>/
 *     <project>_<yyyyMMdd-HHmm>.zap17
 *     handoff.json
 *     HANDOFF.txt
 *     marker.json
 *
 * The directory is a deliverable, so it is deliberately **visible** at the
 * workspace root and git-ignored. The archive is the only file that leaves the
 * machine; the other three are the local record, a human-readable instruction
 * sheet, and a copy of the marker (so a lost archive can still be identified).
 *
 * @module dsh-engineering-context/handoff/record
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  handoffDirectoryPath,
  handoffIgnoreRule,
  type PluginConfig,
} from '../config.js'
import { EngineeringContextError } from '../errors.js'
import { record as asRecord, text } from './marker.js'
import {
  HANDOFF_MARKER_FILE,
  HANDOFF_RECORD_KIND,
  HANDOFF_SCHEMA_VERSION,
  type HandoffMarker,
  type HandoffRecord,
} from './types.js'

/** Zero-padded decimal. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** Local-time stamp for the archive name: `yyyyMMdd-HHmm`. */
export function archiveStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  )
}

/** Local-time id: `yyyyMMddTHHmm-xxxx`, unique enough for one directory. */
export function newHandoffId(date: Date): string {
  return `${archiveStamp(date).replace('-', 'T')}-${randomBytes(2).toString('hex')}`
}

/**
 * A Windows-safe file-name segment for the archive.
 *
 * Keep it short: the archive is extracted on another machine, and a long name
 * plus a deep extraction root is a real path-length risk. The real project name
 * lives in the marker; this is only the file the user sends.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^[._-]+|[._-]+$/gu, '')
  const capped = cleaned.slice(0, 80)
  return capped.length === 0 ? 'project' : capped
}

/** The delivered file name: `<project>_<yyyyMMdd-HHmm>.zap17`. */
export function archiveFileName(projectName: string, date: Date): string {
  return `${safeFileName(projectName)}_${archiveStamp(date)}.zap17`
}

/** The visible handoff root (`<workspace>/handoff`). */
export function handoffRoot(config: PluginConfig, workspaceRoot: string): string {
  return handoffDirectoryPath(config, workspaceRoot)
}

/** One package directory. */
export function handoffPackageDirectory(config: PluginConfig, workspaceRoot: string, handoffId: string): string {
  return join(handoffRoot(config, workspaceRoot), handoffId)
}

/** The record file of one package. */
export function handoffRecordPath(config: PluginConfig, workspaceRoot: string, handoffId: string): string {
  return join(handoffPackageDirectory(config, workspaceRoot, handoffId), 'handoff.json')
}

/** The human instruction sheet of one package. */
export function handoffTextPath(config: PluginConfig, workspaceRoot: string, handoffId: string): string {
  return join(handoffPackageDirectory(config, workspaceRoot, handoffId), 'HANDOFF.txt')
}

/** The marker copy of one package. */
export function handoffMarkerCopyPath(config: PluginConfig, workspaceRoot: string, handoffId: string): string {
  return join(handoffPackageDirectory(config, workspaceRoot, handoffId), 'marker.json')
}

/** A workspace-relative path with forward slashes. */
export function portableRelative(config: PluginConfig, handoffId: string, fileName: string): string {
  return `${config.handoffDirName}/${handoffId}/${fileName}`
}

/** Whether a path exists. */
export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** Write one record as two-space JSON plus a newline. */
export async function writeRecord(file: string, value: HandoffRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
}

/** Read one record, returning null when it is absent or unusable. */
export async function readRecord(file: string): Promise<HandoffRecord | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    const root = asRecord(parsed)
    if (root === null) return null
    if (root['schemaVersion'] !== HANDOFF_SCHEMA_VERSION) return null
    if (root['kind'] !== HANDOFF_RECORD_KIND) return null
    if (text(root['handoffId']) === null) return null
    return parsed as HandoffRecord
  } catch {
    return null
  }
}

/** The outcome of scanning the handoff directory. */
export interface RecordListing {
  records: HandoffRecord[]
  /** Per-package problems (a malformed record does not hide the others). */
  warnings: string[]
}

/**
 * List every record under `<workspace>/handoff/* /handoff.json`.
 *
 * A missing directory is an empty list, not an error. A malformed record is a
 * warning and is skipped: one bad file must not make the status tool useless.
 */
export async function listRecords(config: PluginConfig, workspaceRoot: string): Promise<RecordListing> {
  const root = handoffRoot(config, workspaceRoot)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return { records: [], warnings: [] }
  }
  const records: HandoffRecord[] = []
  const warnings: string[] = []
  for (const name of names) {
    const file = join(root, name, 'handoff.json')
    const record = await readRecord(file)
    if (record === null) {
      if (await pathExists(file)) warnings.push(`The handoff record ${file} is unreadable and was skipped.`)
      continue
    }
    records.push(record)
  }
  records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return { records, warnings }
}

/** Find one record by id, or null. */
export async function findRecord(
  config: PluginConfig,
  workspaceRoot: string,
  handoffId: string,
): Promise<HandoffRecord | null> {
  return await readRecord(handoffRecordPath(config, workspaceRoot, handoffId))
}

/** Human instructions shipped beside the archive. */
export function handoffInstructions(record: HandoffRecord): string {
  const lines = [
    'DSH TIA handoff package',
    '======================',
    '',
    `Handoff id:      ${record.handoffId}`,
    `Created:         ${record.createdAt}`,
    `Project:         ${record.project.name} (TIA Portal ${record.project.tiaVersion})`,
    ...(record.nameChange === null || record.nameChange === undefined
      ? []
      : [`Name change:    ${record.nameChange.from} → ${record.nameChange.to} (TIA rename accepted)`]),
    `PLC:             ${record.project.device} / ${record.project.software}`,
    `Base commit:     ${record.base.commit}`,
    `PLC checksum:    ${record.import?.checksum ?? 'see marker.json'}`,
    `Archive:         ${record.archive.path}`,
    `Archive sha256:  ${record.archive.sha256}`,
    '',
    'SEND THIS FILE TO THE COLLEAGUE',
    '-------------------------------',
    `  ${record.archive.path}`,
    '',
    'The .zap17 is a TIA Portal V17 archive. Only the archive needs to be sent;',
    `the provenance marker is inside it at UserFiles\\${HANDOFF_MARKER_FILE}.`,
    '',
    'INSTRUCTIONS FOR THE COLLEAGUE',
    '------------------------------',
    '  1. Use TIA Portal V17 only. A V18/V20 archive cannot be retrieved by V17.',
    '  2. Retrieve/open the project, make the changes, and compile the PLC.',
    '  3. Do not delete UserFiles\\_dsh-handoff.json.',
    '  4. Archive the project as a COMPRESSED TIA Portal project archive',
    '     (do not use "minimize" or a folder copy).',
    '  5. Return the .zap17 file to the owner.',
    '',
    'WHEN IT COMES BACK',
    '------------------',
    '  Tell the agent (or the app) the path of the returned .zap17.',
    `  It will verify this handoff (${record.handoffId}) against git before`,
    '  replacing the managed project.',
    '',
    `Old project backup: ${record.backup?.path ?? '(none yet)'}`,
    '',
  ]
  return lines.join('\n')
}

/** What appending the handoff ignore rule did. */
export interface IgnoreResult {
  file: string
  action: 'created' | 'appended' | 'unchanged'
  rule: string
  added: boolean
}

/**
 * Make sure the workspace `.gitignore` ignores the handoff directory.
 *
 * It follows the same discipline as `create_engineering_project`: read, append
 * only the missing line, never rewrite the user's file. The rule counts as
 * present in the three spellings a user may have written.
 */
export async function ensureHandoffIgnore(root: string, config: PluginConfig): Promise<IgnoreResult> {
  const file = join(root, '.gitignore')
  const rule = handoffIgnoreRule(config)
  const spellings = new Set([rule, `/${rule}`, rule.replace(/\/$/u, '')])
  let raw = ''
  let exists = true
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    exists = false
  }
  const lines = new Set(raw.split(/\r?\n/u).map((line) => line.trim()))
  if ([...spellings].some((spelling) => lines.has(spelling))) {
    return { file, action: 'unchanged', rule, added: false }
  }

  const block = [
    '# Handoff packages: .zap17 archives and their records are deliverables to send,',
    '# not source; a project archive is a 100+ MB binary.',
    rule,
  ].join('\n')
  if (!exists) {
    await writeFile(file, `${block}\n`, 'utf8')
    return { file, action: 'created', rule, added: true }
  }
  const prefix = raw.length === 0 || raw.endsWith('\n') ? raw : `${raw}\n`
  await writeFile(file, `${prefix}${prefix.length === 0 ? '' : '\n'}${block}\n`, 'utf8')
  return { file, action: 'appended', rule, added: true }
}

/** A human package line for `handoff_status` / the export result. */
export function describeRecord(record: HandoffRecord): string {
  const state =
    record.status === 'awaiting_compile'
      ? 'awaiting compile'
      : record.status === 'imported'
        ? 'imported (commit pending)'
        : record.status
  return `${record.handoffId} — ${state} — ${record.archive.path} (${formatBytes(record.archive.bytes)})`
}

/** Bytes as a short human string. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The marker copy path inside a package, for a marker written by the export. */
export function markerCopyFileName(): string {
  return 'marker.json'
}

/** Exposed for tests: the marker copy path builder needs the same file name. */
export { HANDOFF_MARKER_FILE }
