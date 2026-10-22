/**
 * The `engineeringAccess` service: the seam the engineering-context plugin
 * uses to ask this plugin for project data.
 *
 * Why it exists: fingerprints — the only hard evidence that an engineering
 * object changed (decision D6) — can only be read with a project open, and
 * **this** is the plugin that is allowed to talk to TIA Portal. The
 * engineering-context plugin must therefore ask, not do
 * (docs/ARCHITECTURE.md §5.3 in that package, and the
 * "seam A" decision D12 in `docs/decisions.md`).
 *
 * Three properties matter more than the method list:
 *
 *   1. **It goes through the same code path as the tools.** Every method builds
 *      the same controller operation and parameters the corresponding model-facing
 *      tool builds, and reuses `runOperation`, so the two surfaces can never
 *      disagree about defaults or error shapes.
 *   2. **It never starts anything on its own**, and it keeps the tools'
 *      convention about failures: an operation-level failure (TIA refused, the
 *      block is missing) comes back as `ok: false` plus a coded `error`, while a
 *      transport failure (controller missing, timeout, protocol mismatch) is
 *      thrown — the caller decides how loudly to report that.
 *   3. **Reads are what it is for.** The only write it can perform on a project
 *      is `openProject` with `allowUpgrade` (off by default), exactly like the
 *      tool. Everything else writes files (an export) or closes a session, and
 *      `closeProject` deliberately makes the caller state `dryRun` explicitly.
 *
 * @module dsh-tia-openness-v17-min/access
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'

import type { JsonRecord } from './protocol.js'
import { runOperation, type ToolDependencies } from './tools.js'

/** The service name the engineering-context plugin looks up. It is not an import, by design (D10). */
export const ENGINEERING_ACCESS_SERVICE = 'engineeringAccess'

/**
 * The per-family cap `listObjects` asks for by default.
 *
 * The controller only ever **truncates**: its `max_items` has no offset
 * companion (`controller/OpennessHost.Plc.cs:152,166` keeps counting `total` but
 * stops adding items), so "fetch the next page" does not exist. Raising the cap
 * and reporting `truncated` honestly is the only correct behaviour; the engineering-context plugin
 * retries with a larger value when it sees one.
 */
export const DEFAULT_LIST_MAX_ITEMS = 1000

/** A failure the controller reported as data. */
export interface AccessError {
  code: string
  message: string
  details: JsonRecord | null
}

/** The outcome of one operation, in the shape this service promises. */
export interface AccessCallResult {
  ok: boolean
  operation: string
  dryRun: boolean
  summary: string
  error: AccessError | null
  /** The controller's structured payload, unchanged. */
  data: JsonRecord | null
  durationMs: number
  changes: readonly unknown[]
  diagnostics: readonly unknown[]
}

/** What a caller needs to decide whether to attempt a TIA operation at all. */
export interface AccessStatus {
  /**
   * True when a call is worth attempting: the controller executable is present
   * and Openness is not known to be unavailable. This is *not* a promise that the
   * call will succeed — a not-yet-probed controller reports `available: true`
   * with `probed: false`, because attempting the call is what starts it.
   */
  available: boolean
  /** Why it is unavailable, or what is still unknown. Null when all is well. */
  reason: string | null
  state: string
  exePath: string
  exeExists: boolean
  /** Whether the controller has actually probed the Openness installation. */
  probed: boolean
  /** The raw controller status snapshot, for diagnostics. */
  controller: JsonRecord
}

/** One fingerprint facet of an object: `id` is the facet, not an object id. */
export interface AccessFingerprint {
  id: string
  value: string | null
  /** Set instead of `value` when TIA could not read this facet. */
  error: string | null
}

/** One listed engineering object, flattened out of the controller's envelopes. */
export interface AccessObject {
  category: 'blocks' | 'types' | 'tag_tables'
  name: string
  group: string | null
  attributes: unknown
  fingerprints: AccessFingerprint[] | null
}

/** Per-family accounting, so a caller can see what a cap left out. */
export interface AccessFamilySummary {
  /** How many objects the project holds in this family. */
  count: number
  /** How many came back in this response. */
  returned: number
  /** True when `count > returned`, i.e. the cap cut this family short. */
  truncated: boolean
}

/** The outcome of a listing, with the families flattened into one row list. */
export interface AccessListResult extends AccessCallResult {
  objects: AccessObject[]
  families: Record<string, AccessFamilySummary>
  /** True when any family was cut short by the cap. */
  truncated: boolean
  /** Names that were asked for and matched nothing, when the controller says. */
  missing: unknown
}

/** The outcome of reading the PLC's compiled-program checksum. */
export interface AccessChecksumResult extends AccessCallResult {
  /**
   * The checksum TIA reports for the compiled software, or null when TIA has
   * none (not compiled yet, or edited since the last compile). Null is a state:
   * the caller must compile first, not retry.
   */
  checksum: string | null
  device: string | null
  software: string | null
}

/** Which PLC to read the checksum from; both default to the only PLC. */
export interface AccessChecksumQuery {
  deviceName?: string
  softwareName?: string
  signal?: AbortSignal
}

/** One object the scan reports in `changed` / `added` / `removed`. */
export interface AccessSyncObject {
  key: string
  category: string
  name: string
  group: string | null
  /** Fingerprint faces that differ, when the scan can attribute the change. */
  faces?: string[]
}

/** One object TIA refused to export. It is never reported as removed. */
export interface AccessSyncUnexportable {
  key: string
  category: string
  name: string
  group: string | null
  reason: string
}

/** Where the scan wrote its files. `files` is how many XML files were written. */
export interface AccessSyncStage {
  root: string | null
  evidence: string | null
  manifest: string | null
  files: number
}

/** Complete per-family and per-delta counts; the object rows are capped. */
export interface AccessSyncCounts {
  blocks: number
  types: number
  tagTables: number
  changed: number
  added: number
  removed: number
  unexportable: number
}

/** The outcome of one evidence-ledger scan. */
export interface AccessSyncResult extends AccessCallResult {
  device: string | null
  software: string | null
  checksum: string | null
  /** True when the PLC checksum matched the ledger: nothing was listed or written. */
  unchanged: boolean
  counts: AccessSyncCounts
  changed: AccessSyncObject[]
  added: AccessSyncObject[]
  removed: AccessSyncObject[]
  unexportable: AccessSyncUnexportable[]
  /** Null on the unchanged fast path. */
  stage: AccessSyncStage | null
  /** True when the scan had to rebuild the manifest, even if the state was unchanged. */
  manifestRebuilt: boolean
  /** Identity of the ledger this scan produced or confirmed. */
  stateId: string | null
}

/** What to compare against the open project. Every path is absolute. */
export interface SyncScanQuery {
  /** The source-tree root the ledger describes (only echoed; the files go to stageDir). */
  sourceRoot: string
  /** Empty or per-operation directory the changed XML and the next ledger are written to. */
  stageDir: string
  /** The previous ledger, normally `<sourceRoot>/<device>/_evidence.json`. */
  evidencePath: string
  /**
   * The previous inventory, normally `<sourceRoot>/<device>/_manifest.json`.
   * Missing or unreadable means "rebuild it": the scan exports every object once
   * and builds the manifest from the same export records.
   */
  manifestPath?: string
  deviceName?: string
  softwareName?: string
  exportOptions?: 'none' | 'with_defaults' | 'with_read_only'
  signal?: AbortSignal
}

/** The object families a listing or export may name. */
export type AccessCategory =
  | 'blocks'
  | 'types'
  | 'tag_tables'
  | 'external_sources'
  | 'watch_tables'
  | 'force_tables'
  | 'units'

export interface OpenProjectOptions {
  /** True to attach to a running TIA Portal or start a visible one. */
  withWindow?: boolean
  /**
   * True to let TIA rewrite a project created by an older version. Off by
   * default: it is the only irreversible write opening can perform.
   */
  allowUpgrade?: boolean
  dryRun?: boolean
  signal?: AbortSignal
}

export interface CloseProjectOptions {
  /**
   * Required, not defaulted: the tool defaults to a dry run, and a service
   * caller must not inherit that silently in either direction.
   */
  dryRun: boolean
  /** True to save before closing; false discards unsaved changes. */
  save?: boolean
  /** True to shut the TIA Portal instance down as well. */
  closePortal?: boolean
  signal?: AbortSignal
}

export interface ListObjectsQuery {
  categories?: readonly AccessCategory[]
  blockNames?: readonly string[]
  typeNames?: readonly string[]
  tagTableNames?: readonly string[]
  deviceName?: string
  softwareName?: string
  recursive?: boolean
  nameFilter?: string
  includeFingerprints?: boolean
  includeAttributes?: boolean
  includeTags?: boolean
  includeConstants?: boolean
  /** Per-family cap; defaults to {@link DEFAULT_LIST_MAX_ITEMS}. */
  maxItems?: number
  signal?: AbortSignal
}

export interface ExportObjectsQuery {
  /** Absolute directory the XML files are written to. */
  outputDir: string
  categories?: readonly AccessCategory[]
  blockNames?: readonly string[]
  typeNames?: readonly string[]
  tagTableNames?: readonly string[]
  deviceName?: string
  softwareName?: string
  recursive?: boolean
  overwrite?: boolean
  exportOptions?: 'none' | 'with_defaults' | 'with_read_only'
  writeManifest?: boolean
  signal?: AbortSignal
}

export interface SaveProjectAsOptions {
  signal?: AbortSignal
}

/** One PLC software the open project holds. */
export interface AccessPlcSoftware {
  /** Device that owns it (TIA's own device name). */
  device: string
  /** The PLC software name inside that device. */
  software: string
  /** Blocks TIA reports for it; 0 when it could not be counted. */
  blockCount: number
}

/**
 * What the controller currently has open.
 *
 * `running` is about the controller process; `projectOpen` is about TIA. The two
 * are separate on purpose — a running controller with no project is a normal state
 * — and reading this **never starts** anything.
 */
export interface AccessTiaSession {
  running: boolean
  projectOpen: boolean
  projectName: string | null
  projectPath: string | null
  /** Null when the project state could not be read. */
  isModified: boolean | null
  software: AccessPlcSoftware[]
  /** Why the session could not be read, when it could not. */
  reason: string | null
}

export interface RebuildSourceOptions {
  /** True to replace existing files; false (the default) skips them and reports. */
  overwrite?: boolean
  /** Limit the rebuild to these device names; omit for every PLC software. */
  deviceNames?: readonly string[]
  signal?: AbortSignal
}

/** One family's outcome inside one device's source tree. */
export interface RebuiltFamily {
  /** Objects TIA wrote for this family. */
  exported: number
  /** Objects TIA refused for this family (also listed in `failures`). */
  failed: number
  /** Absolute directory the family landed in. */
  directory: string
  /** Absolute path of the manifest describing it, when one was written. */
  manifest: string | null
}

/** What one device's rebuild produced. */
export interface RebuiltDevice {
  device: string
  software: string
  /** `<sourceRoot>/<device>` — the directory everything below belongs to. */
  directory: string
  /** Blocks TIA reported before the export. */
  blockCount: number
  /** Files left alone because they already existed (both export calls). */
  skipped: number
  /** Objects the controller failed to verify after writing. */
  verificationFailed: number
  blocks: RebuiltFamily
  types: RebuiltFamily
  tagTables: RebuiltFamily
}

/** One object TIA refused to export (never silently dropped). */
export interface RebuildFailure {
  device: string
  category: string
  name: string
  code: string
  message: string
}

/** The outcome of a whole `rebuildSource` run. */
export interface RebuildSourceResult extends AccessCallResult {
  /** The directory the caller passed; everything below it is TIA's output. */
  sourceRoot: string
  devices: RebuiltDevice[]
  /** Every object TIA refused, across all devices. */
  failures: RebuildFailure[]
  /** Devices that were asked for but are not in the project. */
  missingDevices: string[]
}

/**
 * One path segment safe for the source tree.
 *
 * TIA device names may contain characters a filesystem rejects, and two names may
 * collapse onto the same segment. This mirrors what the controller's own exporter
 * does to object names, so the two never disagree about a folder.
 *
 * @param name - the raw name (usually a device name).
 * @returns a segment that can be created on disk.
 */
function sanitizeSegment(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
    .replace(/^[. ]+|[. ]+$/gu, '')
  if (cleaned.length === 0) return '_'
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(cleaned.split('.')[0] ?? cleaned)) return `_${cleaned}`
  return cleaned
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The three families this service flattens, and the category each maps to. */
const FAMILIES: ReadonlyArray<readonly [string, AccessObject['category']]> = [
  ['blocks', 'blocks'],
  ['types', 'types'],
  ['tagTables', 'tag_tables'],
]

/**
 * Turn one controller outcome into the shape this service promises.
 *
 * @param outcome - the result of `runOperation`.
 * @returns the call result, with the error flattened and `details` kept.
 */
function toCallResult(outcome: {
  ok: boolean
  operation: string
  dryRun: boolean
  summary: string
  data: JsonRecord | null
  error: { code: string; message: string; details?: unknown } | null
  durationMs: number
  changes: readonly unknown[]
  diagnostics: readonly unknown[]
}): AccessCallResult {
  const error = outcome.error
  return {
    ok: outcome.ok,
    operation: outcome.operation,
    dryRun: outcome.dryRun,
    summary: outcome.summary,
    error:
      error === null
        ? null
        : { code: error.code, message: error.message, details: record(error.details) ?? null },
    data: outcome.data,
    durationMs: outcome.durationMs,
    changes: outcome.changes,
    diagnostics: outcome.diagnostics,
  }
}

function fingerprintsOf(item: JsonRecord): AccessFingerprint[] | null {
  const raw = item['fingerprints']
  if (!Array.isArray(raw)) return null
  const result: AccessFingerprint[] = []
  for (const entry of raw) {
    const pair = record(entry)
    if (pair === null) continue
    result.push({
      id: text(pair['id']) ?? '?',
      value: text(pair['value']) ?? null,
      error: text(pair['error']) ?? null,
    })
  }
  return result
}

/** Normalize the scan's complete counts; every missing number is a zero, never a guess. */
function syncCounts(value: unknown): AccessSyncCounts {
  const raw = record(value)
  return {
    blocks: numberOf(raw?.['blocks']) ?? 0,
    types: numberOf(raw?.['types']) ?? 0,
    tagTables: numberOf(raw?.['tagTables']) ?? 0,
    changed: numberOf(raw?.['changed']) ?? 0,
    added: numberOf(raw?.['added']) ?? 0,
    removed: numberOf(raw?.['removed']) ?? 0,
    unexportable: numberOf(raw?.['unexportable']) ?? 0,
  }
}

function syncObjects(value: unknown): AccessSyncObject[] {
  const result: AccessSyncObject[] = []
  for (const entry of list(value)) {
    const item = record(entry)
    if (item === null) continue
    const row: AccessSyncObject = {
      key: text(item['key']) ?? '',
      category: text(item['category']) ?? '',
      name: text(item['name']) ?? '',
      group: text(item['group']) ?? null,
    }
    const rawFaces = item['faces']
    if (Array.isArray(rawFaces)) {
      const faces: string[] = []
      for (const face of rawFaces) {
        const label = text(face)
        if (label !== undefined) faces.push(label)
      }
      if (faces.length > 0) row.faces = faces
    }
    result.push(row)
  }
  return result
}

function syncUnexportable(value: unknown): AccessSyncUnexportable[] {
  const result: AccessSyncUnexportable[] = []
  for (const entry of list(value)) {
    const item = record(entry)
    if (item === null) continue
    result.push({
      key: text(item['key']) ?? '',
      category: text(item['category']) ?? '',
      name: text(item['name']) ?? '',
      group: text(item['group']) ?? null,
      reason: text(item['reason']) ?? 'TIA refused the export',
    })
  }
  return result
}

function syncStage(value: unknown): AccessSyncStage | null {
  const raw = record(value)
  if (raw === null) return null
  return {
    root: text(raw['root']) ?? null,
    evidence: text(raw['evidence']) ?? null,
    manifest: text(raw['manifest']) ?? null,
    files: numberOf(raw['files']) ?? 0,
  }
}

/**
 * The `engineeringAccess` service.
 *
 * Construct it inside `apply` so the runtime ties its lifetime to this plugin's
 * fiber: `Service`'s constructor registers it with
 * `ctx.reflect.provide(name, this, …)`, whose disposer runs when the plugin
 * unloads.
 */
export class EngineeringAccess extends Service {
  private readonly dependencies: ToolDependencies

  /**
   * @param ctx - the plugin context the service is registered on.
   * @param dependencies - the controller seam the tools use, reused as-is.
   */
  constructor(ctx: Context, dependencies: ToolDependencies) {
    super(ctx, ENGINEERING_ACCESS_SERVICE)
    this.dependencies = dependencies
  }

  /**
   * Report whether a TIA operation is worth attempting. Never starts anything.
   *
   * @returns the availability snapshot described by {@link AccessStatus}.
   */
  status(): AccessStatus {
    const snapshot = this.dependencies.status() as unknown as JsonRecord
    const ready = record(snapshot['ready'])
    const openness = ready === null ? null : record(ready['openness'])
    const probed = ready !== null
    const exeExists = snapshot['exeExists'] === true
    const opennessAvailable = openness === null ? null : openness['available'] === true

    const available = exeExists && opennessAvailable !== false
    const reason = !exeExists
      ? 'the controller executable is missing; build it with build:controller or point controllerPath at it'
      : opennessAvailable === false
        ? (text(openness?.['message']) ?? 'the Openness installation is not available to this user')
        : probed
          ? null
          : 'the controller has not been started yet, so Openness has not been probed'

    return {
      available,
      reason,
      state: text(snapshot['state']) ?? 'unknown',
      exePath: text(snapshot['exePath']) ?? '',
      exeExists,
      probed,
      controller: snapshot,
    }
  }

  /**
   * Open (or attach to) a project and keep it open for later calls.
   *
   * @param projectPath - absolute path of the `.ap17`.
   * @param options - window, upgrade consent, dry run and cancellation.
   */
  async openProject(projectPath: string, options: OpenProjectOptions = {}): Promise<AccessCallResult> {
    if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
      throw new TypeError('openProject needs a non-empty project path')
    }
    const params: JsonRecord = { project_path: projectPath }
    if (options.withWindow !== undefined) params['with_window'] = options.withWindow
    if (options.allowUpgrade !== undefined) params['allow_upgrade'] = options.allowUpgrade
    if (options.dryRun !== undefined) params['dry_run'] = options.dryRun
    return toCallResult(await runOperation(this.dependencies, 'OpenProject', params, options.signal))
  }

  /**
   * Close the project the controller holds.
   *
   * @param options - `dryRun` is required; see {@link CloseProjectOptions}.
   */
  async closeProject(options: CloseProjectOptions): Promise<AccessCallResult> {
    if (options === undefined || typeof options.dryRun !== 'boolean') {
      throw new TypeError('closeProject needs an explicit dryRun: true (plan) or false (close)')
    }
    const params: JsonRecord = {
      save: options.save ?? false,
      close_portal: options.closePortal ?? false,
      dry_run: options.dryRun,
    }
    return toCallResult(await runOperation(this.dependencies, 'CloseProject', params, options.signal))
  }

  /**
   * List engineering objects, flattened across families, with fingerprints when
   * asked for.
   *
   * The defaults mirror the `list_plc_objects` tool exactly, except for the cap:
   * this asks for {@link DEFAULT_LIST_MAX_ITEMS} instead of the controller's 200,
   * because there is no way to fetch a second page.
   *
   * @param query - families, names, detail flags and the cap.
   */
  async listObjects(query: ListObjectsQuery = {}): Promise<AccessListResult> {
    const params: JsonRecord = {
      recursive: query.recursive ?? true,
      include_tags: query.includeTags ?? false,
      include_constants: query.includeConstants ?? false,
      include_attributes: query.includeAttributes ?? false,
      include_fingerprints: query.includeFingerprints ?? false,
      max_items: query.maxItems ?? DEFAULT_LIST_MAX_ITEMS,
    }
    // Left out when the caller named no family: the controller then lists exactly
    // the families the requested names select. Sending a default would defeat it.
    if (query.categories !== undefined) params['categories'] = [...query.categories]
    if (query.deviceName !== undefined) params['device_name'] = query.deviceName
    if (query.softwareName !== undefined) params['software_name'] = query.softwareName
    if (query.nameFilter !== undefined) params['name_filter'] = query.nameFilter
    if (query.blockNames !== undefined) params['block_names'] = [...query.blockNames]
    if (query.typeNames !== undefined) params['type_names'] = [...query.typeNames]
    if (query.tagTableNames !== undefined) params['tag_table_names'] = [...query.tagTableNames]

    const outcome = await runOperation(this.dependencies, 'ListPlcObjects', params, query.signal)
    const base = toCallResult(outcome)
    const data = outcome.data

    const objects: AccessObject[] = []
    const families: Record<string, AccessFamilySummary> = {}
    let truncated = false

    if (data !== null) {
      for (const [key, category] of FAMILIES) {
        const envelope = record(data[key])
        if (envelope === null) continue
        const items = list(envelope['items'])
        const count = numberOf(envelope['count']) ?? items.length
        const familyTruncated = envelope['truncated'] === true
        if (familyTruncated) truncated = true
        families[category] = { count, returned: items.length, truncated: familyTruncated }
        for (const entry of items) {
          const item = record(entry)
          if (item === null) continue
          objects.push({
            category,
            name: text(item['name']) ?? '?',
            group: text(item['group']) ?? null,
            attributes: item['attributes'] ?? null,
            fingerprints: fingerprintsOf(item),
          })
        }
      }
    }

    return {
      ...base,
      objects,
      families,
      // The top-level flag exists too; either source reporting truncation is
      // enough for the caller to retry with a larger cap.
      truncated: truncated || data?.['truncated'] === true,
      missing: data?.['missing'] ?? null,
    }
  }

  /**
   * Export objects as Simatic ML into a directory.
   *
   * Writes files only; it never modifies the project.
   *
   * @param query - target directory, families, name selection and options.
   */
  async exportObjects(query: ExportObjectsQuery): Promise<AccessCallResult> {
    if (typeof query.outputDir !== 'string' || query.outputDir.trim().length === 0) {
      throw new TypeError('exportObjects needs a non-empty outputDir')
    }
    const params: JsonRecord = {
      output_dir: query.outputDir,
      categories: query.categories === undefined ? ['blocks'] : [...query.categories],
      recursive: query.recursive ?? true,
      overwrite: query.overwrite ?? false,
      export_options: query.exportOptions ?? 'with_defaults',
      write_manifest: query.writeManifest ?? true,
    }
    if (query.blockNames !== undefined) params['block_names'] = [...query.blockNames]
    if (query.typeNames !== undefined) params['type_names'] = [...query.typeNames]
    if (query.tagTableNames !== undefined) params['tag_table_names'] = [...query.tagTableNames]
    if (query.deviceName !== undefined) params['device_name'] = query.deviceName
    if (query.softwareName !== undefined) params['software_name'] = query.softwareName
    return toCallResult(await runOperation(this.dependencies, 'ExportBlocks', params, query.signal))
  }

  /**
   * Read the compiled-program checksum of one PLC.
   *
   * This is the cheap gate the versioning workflow uses: a checksum that is
   * unchanged since the last scan means no block, PLC type or tag table changed,
   * and a checksum that is empty means the software has not been compiled since
   * its last edit. The controller reports both as data (`ok:false` with
   * `checksum_unavailable` for the empty case), so a caller can tell "compile
   * first" apart from a transport failure.
   *
   * @param query - which PLC and a cancellation signal.
   */
  async readPlcChecksum(query: AccessChecksumQuery = {}): Promise<AccessChecksumResult> {
    const params: JsonRecord = {}
    if (query.deviceName !== undefined) params['device_name'] = query.deviceName
    if (query.softwareName !== undefined) params['software_name'] = query.softwareName

    const outcome = await runOperation(this.dependencies, 'PlcChecksum', params, query.signal)
    const base = toCallResult(outcome)
    const data = outcome.data
    return {
      ...base,
      checksum: text(data?.['checksum']) ?? null,
      device: text(data?.['device']) ?? null,
      software: text(data?.['software']) ?? null,
    }
  }

  /**
   * Compare the open project with an evidence ledger and export the differences.
   *
   * The controller reads the checksum once, enumerates the whole composition
   * itself (the 1000-item `listObjects` cap does not apply), compares fingerprints
   * and tag-table content hashes with the previous ledger, writes only the
   * changed XML plus the next `_evidence.json` into `stageDir`, and returns a
   * bounded summary. It writes no project object and touches no git repository.
   *
   * @param query - the source root, the STAGE directory and the previous ledger.
   */
  async syncScan(query: SyncScanQuery): Promise<AccessSyncResult> {
    if (typeof query.sourceRoot !== 'string' || query.sourceRoot.trim().length === 0) {
      throw new TypeError('syncScan needs a non-empty sourceRoot')
    }
    if (typeof query.stageDir !== 'string' || query.stageDir.trim().length === 0) {
      throw new TypeError('syncScan needs a non-empty stageDir')
    }
    if (typeof query.evidencePath !== 'string' || query.evidencePath.trim().length === 0) {
      throw new TypeError('syncScan needs a non-empty evidencePath')
    }

    const params: JsonRecord = {
      source_root: query.sourceRoot,
      stage_dir: query.stageDir,
      evidence_path: query.evidencePath,
      export_options: query.exportOptions ?? 'with_defaults',
    }
    if (query.manifestPath !== undefined) params['manifest_path'] = query.manifestPath
    if (query.deviceName !== undefined) params['device_name'] = query.deviceName
    if (query.softwareName !== undefined) params['software_name'] = query.softwareName

    const outcome = await runOperation(this.dependencies, 'SyncScan', params, query.signal)
    const base = toCallResult(outcome)
    const data = outcome.data
    return {
      ...base,
      device: text(data?.['device']) ?? null,
      software: text(data?.['software']) ?? null,
      checksum: text(data?.['checksum']) ?? null,
      unchanged: data?.['unchanged'] === true,
      counts: syncCounts(data?.['counts']),
      changed: syncObjects(data?.['changed']),
      added: syncObjects(data?.['added']),
      removed: syncObjects(data?.['removed']),
      unexportable: syncUnexportable(data?.['unexportable']),
      stage: syncStage(data?.['stage']),
      manifestRebuilt: data?.['manifestRebuilt'] === true,
      stateId: text(data?.['stateId']) ?? null,
    }
  }

  /**
   * Save the open project into another directory ("save as").
   *
   * The directory is the caller's decision — this method knows nothing about
   * workspaces or projects. Two TIA facts the caller must live with, both from the
   * `save_project` tool's verified behaviour: SaveAs takes **only a directory**, and
   * the project **keeps its own name** (`Project.Name` is read-only and there is no
   * `SaveAs(folder, newName)` overload). So the requested directory and the path TIA
   * actually produces can differ, and the caller must record what came back
   * (`savedAs` / `projectPath`), never what it asked for.
   *
   * @param directory - target directory; TIA decides the layout below it.
   * @param options - cancellation.
   */
  async saveProjectAs(directory: string, options: SaveProjectAsOptions = {}): Promise<AccessCallResult> {
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      throw new TypeError('saveProjectAs needs a non-empty target directory')
    }
    const params: JsonRecord = { save_as_dir: directory }
    const outcome = await runOperation(this.dependencies, 'SaveProject', params, options.signal)
    const result = toCallResult(outcome)
    const data = outcome.data
    return {
      ...result,
      // Surfaced explicitly: these are the two facts a caller must not guess at.
      data:
        data === null
          ? null
          : {
              ...data,
              savedAs: data['savedAs'] ?? null,
              requestedSaveAsDir: data['requestedSaveAsDir'] ?? directory,
              projectPath: data['projectPath'] ?? null,
            },
    }
  }

  /**
   * Report what the controller and TIA currently have open.
   *
   * Never starts anything: a stopped controller is reported as `running: false`.
   * When the controller is running but TIA holds no project, that comes back as
   * `projectOpen: false` with a reason — the `project_not_open` failure the
   * controller reports is a **state**, not an error to throw.
   *
   * @param options - cancellation.
   */
  async readTiaSession(options: { signal?: AbortSignal } = {}): Promise<AccessTiaSession> {
    const snapshot = this.dependencies.status() as unknown as JsonRecord
    const state = text(snapshot['state']) ?? 'unknown'
    const pid = snapshot['pid']
    const running = state !== 'stopped' && pid !== null && pid !== undefined

    const empty: AccessTiaSession = {
      running,
      projectOpen: false,
      projectName: null,
      projectPath: null,
      isModified: null,
      software: [],
      reason: running ? null : 'the controller is not running, so no TIA session is open',
    }
    if (!running) return empty

    const outcome = await runOperation(
      this.dependencies,
      'ProjectInfo',
      { sections: ['attributes', 'software'], max_objects: 500 },
      options.signal,
    )
    if (!outcome.ok) {
      const code = outcome.error?.code ?? 'unknown'
      return {
        ...empty,
        reason: code === 'project_not_open' ? 'the controller is running but no project is open' : (outcome.error?.message ?? code),
      }
    }

    const data = outcome.data
    const attributes = record(data?.['attributes'])
    const software = record(data?.['software'])
    const items: AccessPlcSoftware[] = []
    for (const entry of list(software?.['items'])) {
      const item = record(entry)
      if (item === null) continue
      items.push({
        device: text(item['device']) ?? '?',
        software: text(item['software']) ?? '?',
        blockCount: numberOf(item['blockCount']) ?? 0,
      })
    }

    return {
      running: true,
      projectOpen: true,
      projectName: text(attributes?.['name']) ?? null,
      projectPath: text(attributes?.['path']) ?? null,
      isModified: typeof attributes?.['isModified'] === 'boolean' ? attributes['isModified'] : null,
      software: items,
      reason: null,
    }
  }

  /**
   * Materialize the **complete** source tree of every PLC software into one root.
   *
   * This is the operation that owns the `source/` layout, which is why the layout
   * lives here in code and not in a prompt: callers pass only the root, and
   * everything below it is decided by this method (and documented in
   * `docs/decisions.md` D21/D24). **One export call per device** produces it,
   * because the controller writes each family into its own folder:
   *
   *   <sourceRoot>/<device>/blocks/<group>/<name>.xml
   *   <sourceRoot>/<device>/types/<group>/<name>.xml
   *   <sourceRoot>/<device>/tag_tables/<name>.xml
   *
   * That call writes exactly one `_manifest.json` at
   * `<sourceRoot>/<device>/`, and it covers all three families — which is what a
   * consumer should read instead of reconstructing paths.
   *
   * A device that TIA refuses objects on is **not** skipped silently: its failures
   * come back in `failures`, one entry per object.
   *
   * @param sourceRoot - directory to build the tree under (created by TIA's export).
   * @param options - overwrite, device filter and cancellation.
   */
  async rebuildSource(sourceRoot: string, options: RebuildSourceOptions = {}): Promise<RebuildSourceResult> {
    if (typeof sourceRoot !== 'string' || sourceRoot.trim().length === 0) {
      throw new TypeError('rebuildSource needs a non-empty source root')
    }

    const session = await this.readTiaSession({ signal: options.signal })
    if (!session.running) {
      return {
        ok: false,
        operation: 'ExportBlocks',
        dryRun: true,
        summary: 'Nothing was exported: the controller is not running, so no project is open.',
        error: { code: 'controller_not_running', message: session.reason ?? 'the controller is not running', details: null },
        data: null,
        durationMs: 0,
        changes: [],
        diagnostics: [],
        sourceRoot,
        devices: [],
        failures: [],
        missingDevices: [],
      }
    }
    if (!session.projectOpen) {
      return {
        ok: false,
        operation: 'ExportBlocks',
        dryRun: true,
        summary: 'Nothing was exported: the controller has no project open.',
        error: { code: 'project_not_open', message: session.reason ?? 'no project is open', details: null },
        data: null,
        durationMs: 0,
        changes: [],
        diagnostics: [],
        sourceRoot,
        devices: [],
        failures: [],
        missingDevices: [],
      }
    }

    const devices = session.software
    const wanted = options.deviceNames
    const selected = wanted === undefined ? devices : devices.filter((entry) => wanted.includes(entry.device))
    const missingDevices = wanted === undefined ? [] : wanted.filter((name) => !devices.some((entry) => entry.device === name))

    const failures: RebuildFailure[] = []
    const rebuilt: RebuiltDevice[] = []
    const used = new Set<string>()

    for (const entry of selected) {
      let folder = sanitizeSegment(entry.device)
      // Two device names can collapse onto one folder; make the second distinct
      // instead of letting one overwrite the other.
      if (used.has(folder.toLowerCase())) {
        let index = 2
        while (used.has(`${folder}~${index}`.toLowerCase())) index += 1
        folder = `${folder}~${index}`
      }
      used.add(folder.toLowerCase())

      const deviceDirectory = join(sourceRoot, folder)
      const emptyFamily = (directory: string): RebuiltFamily => ({
        exported: 0,
        failed: 0,
        directory,
        manifest: null,
      })
      // Each family lands in its own folder, blocks included, so all three go out in
      // ONE call and the device gets ONE manifest (docs/decisions.md D24).
      const blocksFamily = emptyFamily(join(deviceDirectory, 'blocks'))
      const typesFamily = emptyFamily(join(deviceDirectory, 'types'))
      const tagTablesFamily = emptyFamily(join(deviceDirectory, 'tag_tables'))

      const outcome = await runOperation(
        this.dependencies,
        'ExportBlocks',
        {
          output_dir: deviceDirectory,
          categories: ['blocks', 'types', 'tag_tables'],
          recursive: true,
          overwrite: options.overwrite ?? false,
          export_options: 'with_defaults',
          write_manifest: true,
          device_name: entry.device,
          software_name: entry.software,
        },
        options.signal,
      )
      if (!outcome.ok) {
        return {
          ...toCallResult(outcome),
          sourceRoot,
          devices: rebuilt,
          failures,
          missingDevices,
        }
      }
      applyFamily(blocksFamily, outcome.data, entry.device, failures, 'blocks')
      applyFamily(typesFamily, outcome.data, entry.device, failures, 'types')
      applyFamily(tagTablesFamily, outcome.data, entry.device, failures, 'tagTables')

      rebuilt.push({
        device: entry.device,
        software: entry.software,
        directory: deviceDirectory,
        blockCount: entry.blockCount,
        ...callTotals(outcome.data),
        blocks: blocksFamily,
        types: typesFamily,
        tagTables: tagTablesFamily,
      })
    }

    const exported = rebuilt.reduce(
      (total, device) => total + device.blocks.exported + device.types.exported + device.tagTables.exported,
      0,
    )
    const failed = rebuilt.reduce(
      (total, device) => total + device.blocks.failed + device.types.failed + device.tagTables.failed,
      0,
    )

    return {
      ok: true,
      operation: 'ExportBlocks',
      dryRun: false,
      summary:
        selected.length === 0
          ? 'No PLC software was selected, so nothing was exported.'
          : `Rebuilt the source tree of ${selected.length} device(s) under ${sourceRoot}: ${exported} object(s) exported, ${failed} refused by TIA.`,
      error: null,
      data: { sourceRoot, devices: rebuilt, failures, missingDevices },
      durationMs: 0,
      changes: [],
      diagnostics: [],
      sourceRoot,
      devices: rebuilt,
      failures,
      missingDevices,
    }
  }
}

/**
 * Fold one export call's payload into the family it produced.
 *
 * Only exactly attributable numbers are taken: `exported` from `counts[family]`,
 * `failed` from the `failures` entries whose `category` matches, and the manifest
 * path the controller wrote. Call-level totals (`skipped`, `verificationFailed`)
 * are summed by {@link callTotals} instead, because they cannot honestly be split
 * across families.
 *
 * @param family - the family record to fill in (mutated).
 * @param data - the controller payload of one `ExportBlocks` call.
 * @param device - device name, used to label the failures.
 * @param failures - the run's failure list (appended to).
 * @param countKey - which key of `counts` this call populates.
 */
function applyFamily(
  family: RebuiltFamily,
  data: JsonRecord | null,
  device: string,
  failures: RebuildFailure[],
  countKey: 'blocks' | 'types' | 'tagTables' = 'blocks',
): void {
  const counts = record(data?.['counts'])
  family.exported = numberOf(counts?.[countKey]) ?? 0
  family.manifest = text(data?.['manifest']) ?? null

  const wantedCategory = countKey === 'blocks' ? 'blocks' : countKey === 'types' ? 'types' : 'tag_tables'
  for (const entry of list(data?.['failures'])) {
    const item = record(entry)
    if (item === null) continue
    const category = text(item['category']) ?? ''
    if (category !== wantedCategory) continue
    family.failed += 1
    failures.push({
      device,
      category,
      name: text(item['name']) ?? '?',
      code: text(item['code']) ?? 'export_failed',
      message: text(item['message']) ?? '',
    })
  }
}

/**
 * The call-level totals of the device's export call, which are the only numbers
 * that cannot be attributed to one family.
 *
 * @param payloads - the controller payloads to sum over (one per device today).
 */
function callTotals(...payloads: ReadonlyArray<JsonRecord | null>): {
  skipped: number
  verificationFailed: number
} {
  let skipped = 0
  let verificationFailed = 0
  for (const payload of payloads) {
    const summary = record(payload?.['summary'])
    skipped += numberOf(summary?.['skipped']) ?? 0
    verificationFailed += numberOf(summary?.['verificationFailed']) ?? 0
  }
  return { skipped, verificationFailed }
}
