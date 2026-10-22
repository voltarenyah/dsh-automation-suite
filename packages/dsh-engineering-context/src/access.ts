/**
 * The `engineeringAccess` seam: how this plugin asks the TIA interface plugin to
 * talk to TIA Portal on its behalf.
 *
 * This plugin may never open TIA itself — the interface plugin owns the
 * controller and the process (docs/ARCHITECTURE.md §5.3, distribution D12) — so
 * every TIA fact below arrives through one cordis service that is looked up
 * **by name**, never imported (D10: the two plugins do not depend on each other).
 *
 * Because the other end is another plugin, everything it hands back is treated
 * as untrusted JSON and normalized here: a service whose shape drifted must
 * degrade into "this is not available", never into a plausible-looking wrong
 * answer about which project is open.
 *
 * @module dsh-engineering-context/access
 */

import type { Context } from '@deepseek-ai/cordis'

/** The service name the TIA interface plugin registers. Not an import, by design (D10). */
export const ENGINEERING_ACCESS_SERVICE = 'engineeringAccess'

/** A failure the other plugin reported as data. */
export interface AccessError {
  code: string
  message: string
  details: unknown
}

/** One PLC software inside the open project. */
export interface TiaSoftware {
  device: string
  software: string
  /** Blocks TIA reports for it; 0 when it could not be counted. */
  blockCount: number
}

/**
 * What TIA currently holds open.
 *
 * `running` is about the controller process and `projectOpen` about TIA. The two
 * are separate on purpose: a running controller with no project is a normal
 * state, not an error.
 */
export interface TiaSession {
  running: boolean
  projectOpen: boolean
  projectName: string | null
  projectPath: string | null
  isModified: boolean | null
  software: TiaSoftware[]
  reason: string | null
}

/** The outcome of a save-as, with the two facts a caller must not guess at. */
export interface SaveResult {
  ok: boolean
  error: AccessError | null
  summary: string
  /** The directory that was requested. */
  requestedSaveAsDir: string
  /** Where TIA actually put the project (it keeps its own name). */
  savedAs: string | null
  /** The project path TIA reports after the save. */
  projectPath: string | null
  /** The project name TIA reports after the save (TIA names it after the directory). */
  projectName: string | null
}

/** One family's outcome inside one device's source tree. */
export interface RebuildFamily {
  exported: number
  failed: number
  directory: string
  manifest: string | null
}

/** What one device's rebuild produced. */
export interface RebuiltDevice {
  device: string
  software: string
  directory: string
  blockCount: number
  skipped: number
  verificationFailed: number
  blocks: RebuildFamily
  types: RebuildFamily
  tagTables: RebuildFamily
}

/** One object TIA refused to export (never silently dropped). */
export interface RebuildFailure {
  device: string
  category: string
  name: string
  code: string
  message: string
}

/**
 * Call-level totals of a rebuild, which are the only numbers a caller can trust.
 *
 * The per-family `exported` below is the **planned** count (the controller's
 * `counts` is `CountByCategory(plan)`, computed before anything is written), so it
 * counts files that were skipped as well. `written` here is the number that
 * actually reached the disk: the controller's own `summary.exported` when a failed
 * call reported one, otherwise `planned - skipped - refused`, which is exact
 * because every planned object is either written, skipped or refused
 * (`controller/Operations.cs:271-353`).
 */
export interface RebuildTotals {
  /** Objects the export calls planned to write. */
  planned: number
  /** Objects actually written to disk. */
  written: number
  /** Files left alone because they already existed. */
  skipped: number
  /** Objects TIA refused. */
  refused: number
  /** Written files that could not be read back. */
  verificationFailed: number
}

/** The outcome of a whole source rebuild. */
export interface RebuildResult {
  ok: boolean
  error: AccessError | null
  summary: string
  sourceRoot: string
  devices: RebuiltDevice[]
  failures: RebuildFailure[]
  missingDevices: string[]
  totals: RebuildTotals
}

/** The outcome of reading the PLC's compiled-program checksum. */
export interface ChecksumReport {
  ok: boolean
  checksum: string | null
  device: string | null
  software: string | null
  error: AccessError | null
  summary: string
}

/** One object reported by a scan. */
export interface SyncScanObject {
  key: string
  category: string
  name: string
  group: string | null
  faces: string[]
}

/** One object TIA refused to export. */
export interface SyncScanUnexportable {
  key: string
  category: string
  name: string
  group: string | null
  reason: string
}

/** Complete counts of one scan; the object rows are capped by the provider. */
export interface SyncScanCounts {
  blocks: number
  types: number
  tagTables: number
  changed: number
  added: number
  removed: number
  unexportable: number
}

/** Where a scan wrote its files. */
export interface SyncScanStage {
  root: string
  evidence: string
  manifest: string
  files: number
}

/** The outcome of one evidence-ledger scan, normalized for this plugin. */
export interface SyncScanReport {
  ok: boolean
  checksum: string | null
  unchanged: boolean
  manifestRebuilt: boolean
  counts: SyncScanCounts
  changed: SyncScanObject[]
  added: SyncScanObject[]
  removed: SyncScanObject[]
  unexportable: SyncScanUnexportable[]
  stage: SyncScanStage | null
  stateId: string | null
  /**
   * Objects the scan adopted from the existing source tree instead of exporting
   * them again (bootstrap mode). 0 when the interface plugin does not report it,
   * which is why callers compute a fallback rather than trusting it blindly.
   */
  adopted: number
  error: AccessError | null
  summary: string
}

/**
 * What one `syncScan` call compares against, and where it may write.
 *
 * Every path is absolute: the controller resolves manifest entries against
 * `sourceRoot` and never against the process working directory.
 */
export interface SyncScanQuery {
  /**
   * The source-tree root the ledger describes. It is the **device directory**,
   * because manifest entries are relative to it, not to the source tree above it.
   */
  sourceRoot: string
  /** Scratch directory the scan writes the changed XML, the ledger and the manifest into. */
  stageDir: string
  /** Where the previous ledger lives (also the ledger this plugin copies out of STAGE). */
  evidencePath: string
  /** Where the previous inventory lives (also the manifest this plugin copies out of STAGE). */
  manifestPath?: string
  deviceName?: string
  softwareName?: string
  /**
   * Bootstrap mode (wire name `adopt_existing`): when there is no previous ledger
   * but the source tree and its manifest exist, files that still hash to their
   * manifest row are **adopted** as evidence instead of being exported again.
   * `create_engineering_project` sets it so a tree it just exported is recorded
   * without a second export; `project_sync` leaves it unset.
   */
  adoptExisting?: boolean
  signal?: AbortSignal
}

/** The members of the service this plugin uses. */
export interface EngineeringAccessLike {
  readTiaSession(options?: { signal?: AbortSignal }): Promise<unknown>
  /** Opens a project by absolute path; TIA refuses when one is already open. */
  openProject(
    projectPath: string,
    options?: { withWindow?: boolean; allowUpgrade?: boolean; signal?: AbortSignal },
  ): Promise<unknown>
  saveProjectAs(directory: string, options?: { signal?: AbortSignal }): Promise<unknown>
  /**
   * There is deliberately no `dryRun` here: this plugin never asks TIA to plan a
   * rebuild — its own plan-only mode is computed from `readTiaSession` — so it
   * must not start depending on an option the interface plugin is free to drop.
   */
  rebuildSource(
    sourceRoot: string,
    options?: { overwrite?: boolean; deviceNames?: readonly string[]; signal?: AbortSignal },
  ): Promise<unknown>
  /**
   * Optional: an interface plugin built before the versioning workflow has no
   * checksum/scan methods. A caller that needs them must check for the method
   * and report a coded absence instead of assuming they exist.
   */
  readPlcChecksum?(options?: { deviceName?: string; softwareName?: string; signal?: AbortSignal }): Promise<unknown>
  syncScan?(query: SyncScanQuery): Promise<unknown>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function errorOf(value: unknown): AccessError | null {
  const raw = record(value)
  if (raw === null) return null
  const code = text(raw['code'])
  if (code === undefined) return null
  return { code, message: text(raw['message']) ?? code, details: raw['details'] ?? null }
}

/**
 * The host's `engineeringAccess` service, or `undefined` when this composition
 * has none.
 *
 * A composition without the TIA interface plugin is legitimate (this plugin
 * simply cannot do its one job there), so an absent or unexpected service is
 * reported as absent rather than as an error.
 *
 * @param ctx - the plugin context.
 * @returns the service, when it is present and looks usable.
 */
export function engineeringAccess(ctx: Context): EngineeringAccessLike | undefined {
  const service = ctx.get(ENGINEERING_ACCESS_SERVICE)
  if (service === null || typeof service !== 'object') return undefined
  const candidate = service as Record<string, unknown>
  for (const member of ['readTiaSession', 'openProject', 'saveProjectAs', 'rebuildSource']) {
    if (typeof candidate[member] !== 'function') return undefined
  }
  return service as EngineeringAccessLike
}

/** One PLC software, read out of either the session report or an open result. */
function softwareOf(value: unknown): TiaSoftware[] {
  const software: TiaSoftware[] = []
  for (const entry of list(value)) {
    const item = record(entry)
    if (item === null) continue
    software.push({
      device: text(item['device']) ?? '?',
      software: text(item['software']) ?? '?',
      blockCount: numberOf(item['blockCount']),
    })
  }
  return software
}

/**
 * Normalize whatever the service reported about the TIA session.
 *
 * @param raw - the service's return value.
 * @returns the session, with anything unreadable reported as unknown.
 */
export function normalizeSession(raw: unknown): TiaSession {
  const source = record(raw) ?? {}
  const isModified = source['isModified']
  return {
    running: boolOr(source['running'], false),
    projectOpen: boolOr(source['projectOpen'], false),
    projectName: text(source['projectName']) ?? null,
    projectPath: text(source['projectPath']) ?? null,
    isModified: typeof isModified === 'boolean' ? isModified : null,
    software: softwareOf(source['software']),
    reason: text(source['reason']) ?? null,
  }
}

/** The outcome of an `openProject` call. */
export interface OpenResult {
  ok: boolean
  error: AccessError | null
  summary: string
  /** The path that was asked for. */
  requestedPath: string
  /** The project name TIA reports — the authority for everything downstream. */
  projectName: string | null
  projectPath: string | null
  /** True when TIA rewrote an older project to V17 (irreversible). */
  upgraded: boolean
  isModified: boolean | null
  /** The PLC software the opened project holds. */
  software: TiaSoftware[]
}

/**
 * Normalize an `openProject` return value.
 *
 * The controller reports `plcSoftware` (the same `{count, items}` shape the
 * session report uses), so a caller that just opened a project does not have to
 * ask for the session a second time to learn what is in it.
 *
 * @param raw - the service's return value.
 * @param requested - the path that was asked for.
 */
export function normalizeOpen(raw: unknown, requested: string): OpenResult {
  const source = record(raw) ?? {}
  const data = record(source['data']) ?? {}
  const isModified = data['isModified']
  return {
    ok: boolOr(source['ok'], false),
    error: errorOf(source['error']),
    summary: text(source['summary']) ?? '',
    requestedPath: text(data['requestedPath']) ?? requested,
    projectName: text(data['projectName']) ?? null,
    projectPath: text(data['projectPath']) ?? null,
    upgraded: data['upgraded'] === true,
    isModified: typeof isModified === 'boolean' ? isModified : null,
    software: softwareOf(record(data['plcSoftware'])?.['items']),
  }
}

/**
 * Normalize a `saveProjectAs` return value.
 *
 * @param raw - the service's return value.
 * @param requested - the directory that was asked for.
 */
export function normalizeSave(raw: unknown, requested: string): SaveResult {
  const source = record(raw) ?? {}
  const data = record(source['data']) ?? {}
  return {
    ok: boolOr(source['ok'], false),
    error: errorOf(source['error']),
    summary: text(source['summary']) ?? '',
    requestedSaveAsDir: text(data['requestedSaveAsDir']) ?? requested,
    savedAs: text(data['savedAs']) ?? null,
    projectPath: text(data['projectPath']) ?? null,
    projectName: text(data['projectName']) ?? null,
  }
}

function normalizeFamily(value: unknown, fallbackDirectory: string): RebuildFamily {
  const raw = record(value) ?? {}
  return {
    exported: numberOf(raw['exported']),
    failed: numberOf(raw['failed']),
    directory: text(raw['directory']) ?? fallbackDirectory,
    manifest: text(raw['manifest']) ?? null,
  }
}

/**
 * Normalize a `rebuildSource` return value.
 *
 * The interesting case is a **failed** rebuild: the interface plugin returns at
 * the first call it cannot finish, so `devices`/`failures` describe only the
 * devices before it, while the failing call's own numbers live in `data` (the
 * controller's partial payload). Both have to be folded together, or "everything
 * was already present" is indistinguishable from "TIA refused everything".
 *
 * @param raw - the service's return value.
 * @param sourceRoot - the root that was asked for.
 */
export function normalizeRebuild(raw: unknown, sourceRoot: string): RebuildResult {
  const source = record(raw) ?? {}
  const devices: RebuiltDevice[] = []
  for (const entry of list(source['devices'])) {
    const item = record(entry)
    if (item === null) continue
    const directory = text(item['directory']) ?? sourceRoot
    devices.push({
      device: text(item['device']) ?? '?',
      software: text(item['software']) ?? '?',
      directory,
      blockCount: numberOf(item['blockCount']),
      skipped: numberOf(item['skipped']),
      verificationFailed: numberOf(item['verificationFailed']),
      blocks: normalizeFamily(item['blocks'], directory),
      types: normalizeFamily(item['types'], directory),
      tagTables: normalizeFamily(item['tagTables'], directory),
    })
  }
  const failures: RebuildFailure[] = []
  for (const entry of list(source['failures'])) {
    const item = record(entry)
    if (item === null) continue
    failures.push({
      device: text(item['device']) ?? '?',
      category: text(item['category']) ?? '?',
      name: text(item['name']) ?? '?',
      code: text(item['code']) ?? 'export_failed',
      message: text(item['message']) ?? '',
    })
  }

  const plannedOfDevices = devices.reduce(
    (total, device) => total + device.blocks.exported + device.types.exported + device.tagTables.exported,
    0,
  )
  const skippedOfDevices = devices.reduce((total, device) => total + device.skipped, 0)
  const verificationOfDevices = devices.reduce((total, device) => total + device.verificationFailed, 0)

  // A failed call carries the **controller's** partial payload in `data`; a
  // successful one carries the **service's own** summary, whose `failures` is the
  // very same array as `source.failures`. Only the controller payload holds
  // failures that are not already in the top-level list, so counting them is
  // gated on `hasSummary` — otherwise every refusal is counted twice (found in a
  // live session: 1 refused object was reported as 2).
  const partial = record(source['data']) ?? {}
  const partialSummary = record(partial['summary'])
  const partialCounts = record(partial['counts'])
  const hasSummary = partialSummary !== null && Object.keys(partialSummary).length > 0
  const partialFailures = hasSummary ? list(partial['failures']).length : 0

  const planned = plannedOfDevices + (partialCounts === null ? 0 : numberOf(partialCounts['blocks']) + numberOf(partialCounts['types']) + numberOf(partialCounts['tagTables']))
  const skipped = skippedOfDevices + (hasSummary ? numberOf(partialSummary['skipped']) : 0)
  const refused = failures.length + partialFailures
  const verificationFailed = verificationOfDevices + (hasSummary ? numberOf(partialSummary['verificationFailed']) : 0)
  const written = hasSummary
    ? Math.max(0, plannedOfDevices - skippedOfDevices - failures.length) + numberOf(partialSummary['exported'])
    : Math.max(0, planned - skipped - refused)

  return {
    ok: boolOr(source['ok'], false),
    error: errorOf(source['error']),
    summary: text(source['summary']) ?? '',
    sourceRoot: text(source['sourceRoot']) ?? sourceRoot,
    devices,
    failures,
    missingDevices: list(source['missingDevices']).map((entry) => text(entry) ?? '?'),
    totals: { planned, written, skipped, refused, verificationFailed },
  }
}

/**
 * Normalize the interface plugin's `readPlcChecksum` result.
 *
 * An empty checksum is a state, not a transport failure: the provider returns
 * `ok:false` with `checksum_unavailable`, which is exactly what the caller has to
 * tell apart from "no controller".
 *
 * @param raw - the service's return value.
 */
export function normalizeChecksum(raw: unknown): ChecksumReport {
  const source = record(raw) ?? {}
  const data = record(source['data']) ?? {}
  return {
    ok: boolOr(source['ok'], false),
    checksum: text(data['checksum']) ?? null,
    device: text(data['device']) ?? null,
    software: text(data['software']) ?? null,
    error: errorOf(source['error']),
    summary: text(source['summary']) ?? '',
  }
}

function scanObject(value: unknown): SyncScanObject | null {
  const item = record(value)
  if (item === null) return null
  const faces: string[] = []
  for (const face of list(item['faces'])) {
    const label = text(face)
    if (label !== undefined) faces.push(label)
  }
  return {
    key: text(item['key']) ?? '',
    category: text(item['category']) ?? '',
    name: text(item['name']) ?? '',
    group: text(item['group']) ?? null,
    faces,
  }
}

function scanObjects(value: unknown): SyncScanObject[] {
  const result: SyncScanObject[] = []
  for (const entry of list(value)) {
    const item = scanObject(entry)
    if (item !== null) result.push(item)
  }
  return result
}

function scanUnexportable(value: unknown): SyncScanUnexportable[] {
  const result: SyncScanUnexportable[] = []
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

/**
 * Normalize the interface plugin's `syncScan` result.
 *
 * @param raw - the service's return value.
 */
export function normalizeSyncScan(raw: unknown): SyncScanReport {
  const source = record(raw) ?? {}
  const data = record(source['data']) ?? {}
  const counts = record(data['counts']) ?? {}
  const rawStage = record(data['stage'])
  const stage: SyncScanStage | null =
    rawStage === null
      ? null
      : {
          root: text(rawStage['root']) ?? '',
          evidence: text(rawStage['evidence']) ?? '',
          manifest: text(rawStage['manifest']) ?? '',
          files: numberOf(rawStage['files']),
        }

  return {
    ok: boolOr(source['ok'], false),
    checksum: text(data['checksum']) ?? null,
    unchanged: data['unchanged'] === true,
    manifestRebuilt: data['manifestRebuilt'] === true,
    counts: {
      blocks: numberOf(counts['blocks']),
      types: numberOf(counts['types']),
      tagTables: numberOf(counts['tagTables']),
      changed: numberOf(counts['changed']),
      added: numberOf(counts['added']),
      removed: numberOf(counts['removed']),
      unexportable: numberOf(counts['unexportable']),
    },
    changed: scanObjects(data['changed']),
    added: scanObjects(data['added']),
    removed: scanObjects(data['removed']),
    unexportable: scanUnexportable(data['unexportable']),
    stage,
    stateId: text(data['stateId']) ?? null,
    adopted: numberOf(data['adopted']),
    error: errorOf(source['error']),
    summary: text(source['summary']) ?? '',
  }
}
