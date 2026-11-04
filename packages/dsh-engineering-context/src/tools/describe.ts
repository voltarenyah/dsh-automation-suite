/**
 * `workspace_describe` — describe any engineering workspace on disk, without TIA.
 *
 * Why it exists: the natural way to look at another workspace (a "reference
 * project" that is itself managed by this deployment) is to open its TIA
 * project, which is exactly what a read-only reference must not require. The
 * facts are all on disk — the source index, the export manifests and evidence
 * ledgers, the knowledge databases, the hardware export and the git history —
 * so this tool reads them directly and answers with one report.
 *
 * It is the read-only half of the cross-workspace workflow documented in
 * `docs/reference-project.md` §15: `workspace_describe` says what is there,
 * `knowledge_query`/`read` use it, and `import_blocks` brings an object over.
 *
 * Two properties matter:
 *
 *   1. **No TIA.** A stopped controller, no open project and no `engineeringAccess`
 *      service are all fine: they are exactly the states a reference workspace is
 *      in. Nothing here calls a service.
 *   2. **Tolerant.** A missing index, a half-written manifest or an unreadable
 *      database is reported as a warning beside whatever *is* readable, never as
 *      a failure of the whole report. The one hard failure is "that path is not
 *      a directory".
 *
 * @module dsh-engineering-context/tools/describe
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import type { InferArgs, ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  KNOWLEDGE_DIR_NAME,
  sourceDirectoryPath,
  sourceIndexPath,
  type PluginConfig,
} from '../config.js'
import { EngineeringContextError } from '../errors.js'
import { runGit } from '../git.js'
import { canonicalize, folderName, toPortable } from '../paths.js'
import { type ScopeView } from '../scope.js'
import { sessionCwd } from '../workspace.js'
import type { ToolDependencies } from './deps.js'
import { cappedList, defineOutcomeTool, failedOutcome, okOutcome, type EngineeringOutcome } from './outcome.js'

/** The tool name, in one place because tests and the registrar both match on it. */
export const WORKSPACE_DESCRIBE_TOOL = 'workspace_describe'

const PARAMETERS = {
  workspace_path: {
    type: 'string',
    description:
      'Absolute path of the workspace to describe, for example another project on this machine. Omit to describe the ' +
      "session's own workspace. Relative paths resolve against the session workspace. Nothing is opened and nothing is written.",
  },
} as const

type DescribeArgs = InferArgs<typeof PARAMETERS>

/** The index document as far as this tool reads it. */
interface SourceIndexView {
  role: 'primary' | 'reference' | null
  project: {
    name: string | null
    path: string | null
    savedAs: string | null
    archive: string | null
  } | null
  exportedAt: string | null
  devices: { device: string | null; software: string | null; directory: string | null }[]
}

/** A JSON file read tolerantly: the value, or the reason it is not usable. */
interface JsonRead<T> {
  ok: boolean
  value: T | null
  error: string | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

async function readJson<T = unknown>(file: string): Promise<JsonRead<T>> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, value: null, error: code === 'ENOENT' ? 'missing' : String(error) }
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T, error: null }
  } catch (error) {
    return { ok: false, value: null, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function statFile(file: string): Promise<{ bytes: number; modifiedAt: string } | null> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return null
    return { bytes: info.size, modifiedAt: info.mtime.toISOString() }
  } catch {
    return null
  }
}

/** Whether a path is a directory (used for the target itself). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Directory entries of `parent`, or an empty list when it cannot be listed. */
async function listDirectories(parent: string): Promise<{ name: string; error: string | null }[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, error: null }))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? [] : [{ name: '', error: String(error) }]
  }
}

/** Count XML files below a directory, one level of recursion per call. */
async function countXml(directory: string): Promise<number> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (entry.isDirectory()) total += await countXml(join(directory, entry.name))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) total += 1
  }
  return total
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** The index written by `create_engineering_project`, read tolerantly. */
async function readIndex(file: string): Promise<{ view: SourceIndexView | null; warning: string | null }> {
  const read = await readJson<Record<string, unknown>>(file)
  if (!read.ok) {
    if (read.error === 'missing') return { view: null, warning: null }
    return { view: null, warning: `The source index ${file} could not be read (${read.error}).` }
  }
  const parsed = record(read.value)
  const project = record(parsed?.['project'])
  const role = text(parsed?.['role'])
  const devices: SourceIndexView['devices'] = []
  if (Array.isArray(parsed?.['devices'])) {
    for (const entry of parsed['devices'] as unknown[]) {
      const item = record(entry)
      if (item === null) continue
      devices.push({
        device: text(item['device']),
        software: text(item['software']),
        directory: text(item['directory']),
      })
    }
  }
  return {
    view: {
      role: role === 'reference' ? 'reference' : role === 'primary' ? 'primary' : null,
      project:
        project === null
          ? null
          : {
              name: text(project['name']),
              path: text(project['path']),
              savedAs: text(project['savedAs']),
              archive: text(project['archive']),
            },
      exportedAt: text(parsed?.['exportedAt']),
      devices,
    },
    warning: null,
  }
}

/** What one device directory holds, as reported to the caller. */
interface DeviceReport {
  device: string
  software: string | null
  directory: string
  directoryExists: boolean
  xml: { blocks: number; types: number; tagTables: number; total: number }
  manifest: {
    present: boolean
    rows: number | null
    failures: number | null
    byCategory: Record<string, number>
  }
  evidence: {
    present: boolean
    objects: number | null
    stateId: string | null
    checksum: string | null
    tombstones: number | null
    unexportable: number | null
  }
  knowledge: {
    path: string
    present: boolean
    bytes: number | null
    modifiedAt: string | null
    builtAt: string | null
    checksum: string | null
    freshness: 'fresh' | 'stale' | 'unknown' | 'missing'
  }
}

/**
 * Describe one device directory. Tolerant by construction: every unreadable
 * piece becomes `null`/`present: false` and the rest is still reported.
 */
async function describeDevice(
  config: PluginConfig,
  root: string,
  directory: string,
  device: string,
  software: string | null,
  warnings: string[],
): Promise<DeviceReport> {
  const directoryExists = await isDirectory(directory)
  const xml = directoryExists
    ? {
        blocks: await countXml(join(directory, 'blocks')),
        types: await countXml(join(directory, 'types')),
        tagTables: await countXml(join(directory, 'tag_tables')),
        total: 0,
      }
    : { blocks: 0, types: 0, tagTables: 0, total: 0 }
  xml.total = xml.blocks + xml.types + xml.tagTables

  const manifestRead = directoryExists
    ? await readJson<Record<string, unknown>>(join(directory, '_manifest.json'))
    : { ok: false, value: null, error: 'missing' as string | null }
  const manifestRows = manifestRead.ok ? countOf(manifestRead.value?.['blocks']) : null
  const byCategory: Record<string, number> = {}
  let manifestFailures: number | null = null
  if (manifestRead.ok && manifestRead.value !== null) {
    const entries = Array.isArray(manifestRead.value['blocks']) ? (manifestRead.value['blocks'] as unknown[]) : []
    for (const entry of entries) {
      const item = record(entry)
      const category = text(item?.['category']) ?? 'unknown'
      byCategory[category] = (byCategory[category] ?? 0) + 1
    }
    const failures = manifestRead.value['failures']
    manifestFailures =
      Array.isArray(failures) ? failures.length : (numberOf(manifestRead.value['failureCount']) ?? 0)
  } else if (directoryExists) {
    warnings.push(`The manifest of ${device} is missing or unreadable (${manifestRead.error ?? 'unknown'}).`)
  }

  const evidenceRead = directoryExists
    ? await readJson<Record<string, unknown>>(join(directory, '_evidence.json'))
    : { ok: false, value: null, error: 'missing' as string | null }
  const evidence = { present: false, objects: null, stateId: null, checksum: null, tombstones: null, unexportable: null } as DeviceReport['evidence']
  if (evidenceRead.ok && evidenceRead.value !== null) {
    const objects = record(evidenceRead.value['objects'])
    evidence.present = true
    evidence.objects = objects === null ? 0 : Object.keys(objects).length
    evidence.stateId = text(evidenceRead.value['stateId'])
    evidence.checksum = text(evidenceRead.value['plcChecksum'])
    evidence.tombstones = countOf(evidenceRead.value['tombstones'])
    evidence.unexportable = countOf(evidenceRead.value['unexportable'])
  } else if (directoryExists) {
    warnings.push(`The evidence ledger of ${device} is missing or unreadable (${evidenceRead.error ?? 'unknown'}).`)
  }

  const deviceFolder = basename(directory)
  const database = join(root, KNOWLEDGE_DIR_NAME, deviceFolder, `${deviceFolder}_knowledge.db`)
  const databaseStat = await statFile(database)
  const sidecarRead = await readJson<Record<string, unknown>>(
    join(root, config.stateDirName, 'local', 'graph', `${deviceFolder}.json`),
  )
  const sidecar = sidecarRead.ok ? record(sidecarRead.value) : null
  let freshness: DeviceReport['knowledge']['freshness'] = databaseStat === null ? 'missing' : 'unknown'
  if (databaseStat !== null && sidecar !== null) {
    const built = text(sidecar['plcChecksum'])
    if (built !== null && evidence.checksum !== null) {
      freshness = built.trim().toUpperCase() === evidence.checksum.trim().toUpperCase() ? 'fresh' : 'stale'
    }
  }

  return {
    device,
    software,
    directory,
    directoryExists,
    xml,
    manifest: { present: manifestRead.ok, rows: manifestRows, failures: manifestFailures, byCategory },
    evidence,
    knowledge: {
      path: database,
      present: databaseStat !== null,
      bytes: databaseStat?.bytes ?? null,
      modifiedAt: databaseStat?.modifiedAt ?? null,
      builtAt: sidecar === null ? null : text(sidecar['builtAt']),
      checksum: sidecar === null ? null : text(sidecar['plcChecksum']),
      freshness,
    },
  }
}

/** The git view of the described workspace. */
async function describeGit(root: string): Promise<{
  repository: boolean
  repoRoot: string | null
  head: { sha: string; short: string; subject: string; committedAt: string } | null
  dirty: string[]
  dirtyCount: number
}> {
  const top = await runGit(root, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return { repository: false, repoRoot: null, head: null, dirty: [], dirtyCount: 0 }
  const repoRoot = top.stdout.trim()

  let head: { sha: string; short: string; subject: string; committedAt: string } | null = null
  const log = await runGit(root, ['log', '-1', '--format=%H%x1f%h%x1f%s%x1f%cI'])
  if (log.code === 0) {
    const fields = log.stdout.trim().split('\x1f')
    if (fields.length >= 4 && (fields[0] ?? '').length > 0) {
      head = {
        sha: fields[0] ?? '',
        short: fields[1] ?? '',
        subject: fields[2] ?? '',
        committedAt: fields[3] ?? '',
      }
    }
  }

  const status = await runGit(root, ['status', '--porcelain'])
  const dirty = status.code === 0 ? status.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0) : []
  return { repository: true, repoRoot, head, dirty, dirtyCount: dirty.length }
}

/** One-line state of a described workspace, for the tool summary. */
function summaryOf(data: {
  index: SourceIndexView | null
  devices: DeviceReport[]
  git: { repository: boolean; head: { short: string } | null; dirtyCount: number }
}): string {
  const name = data.index?.project?.name ?? '(unnamed project)'
  const deviceCount = data.devices.length
  const deviceNames = data.devices.map((entry) => entry.device).slice(0, 4).join(', ')
  const xml = data.devices.reduce((sum, entry) => sum + entry.xml.total, 0)
  const graph = data.devices.map((entry) => entry.knowledge.freshness)
  const graphText =
    graph.length === 0
      ? 'no graph'
      : graph.every((state) => state === 'fresh')
        ? 'graph fresh'
        : graph.some((state) => state === 'stale')
          ? 'graph STALE'
          : graph.some((state) => state === 'missing')
            ? 'graph missing'
            : 'graph unknown'
  const gitText =
    data.git.repository === false
      ? 'no git repo'
      : data.git.head === null
        ? 'empty repo'
        : `${data.git.head.short}${data.git.dirtyCount === 0 ? ' (clean)' : ` (${data.git.dirtyCount} uncommitted)`}`
  return `${name}: ${deviceCount} device${deviceCount === 1 ? '' : 's'}${deviceNames.length === 0 ? '' : ` (${deviceNames})`}, ${xml} XML, ${graphText}, ${gitText}`
}

/**
 * Build the definition of `workspace_describe`.
 *
 * @param dependencies - the plugin context (only its optional workspace registry
 *   is used, for the display identity).
 * @returns a registry-ready definition.
 */
export function workspaceDescribeTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: WORKSPACE_DESCRIBE_TOOL,
    description:
      'Describe an engineering workspace on disk WITHOUT opening TIA: the project identity recorded in its source index, ' +
      'each device with its XML counts, manifest and evidence ledger, the knowledge databases with their size and freshness, ' +
      'the hardware export, and the git head/working tree. Use it when another workspace (for example a reference project you ' +
      'are borrowing code from) is not your session workspace, or when project_status says "no open project" and you still ' +
      'need the on-disk facts. It also works on the current workspace. Read-only: it never opens TIA, never starts a controller ' +
      'and never writes. It does not replace project_sync/project_status for the session workspace — those also talk to TIA.',
    parameters: PARAMETERS,
    async execute(args: DescribeArgs, exec): Promise<EngineeringOutcome> {
      try {
      const spelled = typeof args.workspace_path === 'string' ? args.workspace_path.trim() : ''
      const cwd = sessionCwd(exec)
      if (spelled.length === 0 && cwd === undefined) {
        throw new EngineeringContextError(
          'scope_unavailable',
          'No workspace_path was given and the harness supplied no session working directory, so there is nothing to describe.',
        )
      }

      const target = spelled.length === 0 ? (cwd as string) : isAbsolute(spelled) ? spelled : join(cwd ?? '.', spelled)
      let root: string
      try {
        root = await canonicalize(target)
      } catch (error) {
        throw new EngineeringContextError(
          'workspace_not_found',
          `The workspace ${target} does not exist or cannot be resolved.`,
          { target, cause: error instanceof Error ? error.message : String(error) },
        )
      }
      if (!(await isDirectory(root))) {
        throw new EngineeringContextError('workspace_not_found', `${root} is not a directory.`, { target: root })
      }

      const view: ScopeView = {
        workspace: { path: root, registered: false, title: null },
        warnings: [],
      }
      const registry = dependencies.ctx.get('workspaceRegistry') as
        | { resolveByPath?: (path: string) => Promise<{ path: string; title: string } | undefined> }
        | null
        | undefined
      if (registry !== undefined && registry !== null && typeof registry.resolveByPath === 'function') {
        try {
          const workspace = await registry.resolveByPath(root)
          if (workspace !== undefined) {
            view.workspace = { path: root, registered: true, title: workspace.title }
          }
        } catch {
          // The registry is optional identity; a failure here is not a failure of the report.
        }
      }

      const warnings: string[] = []
      const config = dependencies.config
      const indexRead = await readIndex(sourceIndexPath(config, root))
      if (indexRead.warning !== null) warnings.push(indexRead.warning)
      const index = indexRead.view

      const sourceRoot = sourceDirectoryPath(config, root)
      const sourceExists = await isDirectory(sourceRoot)
      const diskDirs = sourceExists ? await listDirectories(sourceRoot) : []
      if (!sourceExists) {
        warnings.push(`This workspace has no source tree at ${sourceRoot}/ (no export has run there).`)
      }

      const byFolder = new Map<string, { device: string | null; software: string | null }>()
      for (const entry of index?.devices ?? []) {
        const folder =
          entry.directory === null
            ? entry.device === null
              ? null
              : folderName(entry.device)
            : basename(entry.directory)
        if (folder !== null) byFolder.set(folder.toLowerCase(), { device: entry.device, software: entry.software })
      }

      const devices: DeviceReport[] = []
      for (const entry of diskDirs) {
        if (entry.name.length === 0) {
          if (entry.error !== null) warnings.push(`The source tree could not be listed (${entry.error}).`)
          continue
        }
        const known = byFolder.get(entry.name.toLowerCase())
        const device = known?.device ?? entry.name
        const software = known?.software ?? null
        devices.push(
          await describeDevice(config, root, join(sourceRoot, entry.name), device, software, warnings),
        )
      }
      // Index devices whose directory is gone are reported, not silently dropped.
      const onDisk = new Set(diskDirs.map((entry) => entry.name.toLowerCase()))
      for (const [folder, known] of byFolder) {
        if (onDisk.has(folder)) continue
        warnings.push(
          `The index lists the device ${known.device ?? folder}, but its directory source/${folder}/ is missing.`,
        )
      }
      devices.sort((left, right) => left.device.localeCompare(right.device))

      const hardwarePath = join(root, 'hardware', 'globalHardware.aml')
      const hardwareStat = await statFile(hardwarePath)
      const tiaDirectory = join(root, config.tiaDirName)
      const tiaExists = await isDirectory(tiaDirectory)

      const git = await describeGit(root)

      const projectFile = index?.project?.savedAs ?? index?.project?.path ?? null
      const projectFileStat = projectFile === null || !isAbsolute(projectFile) ? null : await statFile(projectFile)

      const data = {
        workspace: { path: root, registered: view.workspace.registered, title: view.workspace.title },
        index: {
          path: sourceIndexPath(config, root),
          present: index !== null,
          role: index === null ? null : (index.role ?? 'primary'),
          project: index?.project ?? null,
          exportedAt: index?.exportedAt ?? null,
          deviceCount: index?.devices.length ?? 0,
        },
        source: { path: sourceRoot, exists: sourceExists, devices },
        hardware: {
          path: hardwarePath,
          exists: hardwareStat !== null,
          bytes: hardwareStat?.bytes ?? null,
          modifiedAt: hardwareStat?.modifiedAt ?? null,
        },
        tia: { path: tiaDirectory, exists: tiaExists, projectFile, projectFileExists: projectFileStat !== null },
        git,
      }

      const details: string[] = []
      const projectName = index?.project?.name ?? null
      const role = index?.role ?? 'primary'
      details.push(
        projectName === null
          ? 'Project: no source index, so the project identity is unknown (the tree may predate create_engineering_project).'
          : `Project: ${projectName} (${role})${index?.exportedAt === null || index?.exportedAt === undefined ? '' : ` — last export ${index.exportedAt}`}`,
      )
      if (projectFile !== null) {
        details.push(
          `Project file: ${projectFile} (${projectFileStat === null ? 'NOT found' : `exists, ${formatBytes(projectFileStat.bytes)}`})`,
        )
      }
      const totals = devices.reduce(
        (acc, entry) => ({
          blocks: acc.blocks + entry.xml.blocks,
          types: acc.types + entry.xml.types,
          tagTables: acc.tagTables + entry.xml.tagTables,
          xml: acc.xml + entry.xml.total,
        }),
        { blocks: 0, types: 0, tagTables: 0, xml: 0 },
      )
      details.push(
        sourceExists
          ? `Source: ${toPortable(root, sourceRoot)}/ — ${devices.length} device(s), ${totals.xml} XML (${totals.blocks} blocks, ${totals.types} types, ${totals.tagTables} tag tables)`
          : `Source: missing (${toPortable(root, sourceRoot)}/)`,
      )
      for (const entry of devices) {
        const manifest =
          entry.manifest.present
            ? `manifest ${entry.manifest.rows ?? 0} row(s), ${entry.manifest.failures ?? 0} refused`
            : 'manifest missing'
        const ledger = entry.evidence.present
          ? `evidence ${entry.evidence.objects ?? 0} object(s), state ${entry.evidence.stateId ?? 'unknown'}`
          : 'evidence missing'
        details.push(
          `- ${entry.device}${entry.software === null || entry.software === entry.device ? '' : ` / ${entry.software}`}: ` +
            `${entry.xml.total} XML; ${manifest}; ${ledger}`,
        )
        const knowledge = entry.knowledge
        details.push(
          `  knowledge: ${toPortable(root, knowledge.path)} — ${knowledge.present ? formatBytes(knowledge.bytes) : 'MISSING'}` +
            `${knowledge.present ? `, ${knowledge.freshness}${knowledge.builtAt === null ? '' : ` (built ${knowledge.builtAt})`}` : ''}`,
        )
      }
      details.push(
        hardwareStat === null
          ? 'Hardware: no hardware/globalHardware.aml.'
          : `Hardware: ${toPortable(root, hardwarePath)} — ${formatBytes(hardwareStat.bytes)}, ${hardwareStat.modifiedAt}`,
      )
      details.push(
        git.repository
          ? `Git: ${git.head === null ? 'repository with no commits' : `${git.head.short} "${git.head.subject}" (${git.head.committedAt})`}, ` +
              `${git.dirtyCount === 0 ? 'clean' : `${git.dirtyCount} uncommitted change(s)`}`
          : 'Git: not a repository',
      )
      const capped = cappedList(git.dirty, (line) => `  ${line}`)
      details.push(...capped)

      return okOutcome(WORKSPACE_DESCRIBE_TOOL, view, summaryOf({ index, devices, git }), data, {
        details,
        warnings,
        dryRun: true,
      })
      } catch (error) {
        return failedOutcome(WORKSPACE_DESCRIBE_TOOL, null, error)
      }
    },
  })
}
