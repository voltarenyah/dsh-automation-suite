/**
 * The `knowledgeGraph` seam: how this plugin asks the engineering-graph plugin to
 * turn a device's exported source files into a knowledge database.
 *
 * Same shape as the TIA seam in `access.ts` (docs/decisions.md D12 §3, D10): a
 * cordis service looked up **by name** through `ctx.get`, never imported, and
 * everything it hands back is untrusted JSON normalized here. A composition
 * without the graph plugin is legitimate — the source tree is still the
 * deliverable — so absence and engine trouble degrade to "the graph was not
 * built" instead of failing the workflow.
 *
 * Three properties shape the step:
 *
 *   1. **One call per device, after the export.** The device directory is the one
 *      `rebuildSource` returned (`devices[].directory`) — the directory holding
 *      the export manifest plus `blocks/`, `types/` and `tag_tables/` — so nothing
 *      here re-derives it.
 *   2. **The graph plugin owns the layout.** `dbPath` is deliberately not passed:
 *      the service's own convention (`<project root>/knowledge/<device>/
 *      <device>_knowledge.db`, distribution D20) is the single source of truth,
 *      and the answer carries where the database actually landed.
 *   3. **An operation failure is data, a transport failure is a degradation.**
 *      `ok: false` (a refused manifest, an empty tree) is reported per device and
 *      converted into workflow diagnostics; a thrown engine error (missing
 *      executable, timeout, missing process) means "the graph was not built" and
 *      is reported the same way as an absent service. Neither fails the workflow.
 *
 * The graph is a **full rebuild** and has no freshness check, so "call it once
 * after every export" is the only way to refresh it: that is why this runs on
 * every real run, including one where every source file was already present.
 * A large project is minutes of work and a multi-hundred-megabyte database, so
 * the caller must leave room in its own time budget (the engine's own deadline is
 * the graph plugin's `requestTimeoutMs`, not this plugin's).
 *
 * @module dsh-engineering-context/knowledge-graph
 */

import type { Context, Logger } from '@deepseek-ai/cordis'

import { isInside, toPortable } from './paths.js'

/** The service name the engineering-graph plugin registers. Not an import, by design (D10). */
export const KNOWLEDGE_GRAPH_SERVICE = 'knowledgeGraph'

/** Additional knowledge-graph warnings kept in the workflow result before capping. */
const MAX_GRAPH_NOTES = 10

/** What the graph plugin reports about whether an ingest is worth attempting. */
export interface KnowledgeGraphStatus {
  available: boolean
  reason: string | null
  enginePath: string | null
  engineExists: boolean
  source: string | null
  databaseConvention: string | null
}

/** One engine refusal, as the graph plugin's envelope spells it. */
export interface KnowledgeIngestError {
  code: string
  message: string
  remediation: string | null
}

/** What one device's ingest produced, normalized. */
export interface IngestedDevice {
  /** The device name the export reported. */
  device: string
  /** The device directory the ingest was pointed at (`devices[].directory`). */
  directory: string
  ok: boolean
  /** Where the database landed, as the engine reported it. */
  dbPath: string | null
  /** `manifest` or `crawl`: which entry point the engine used. */
  source: string | null
  filesFound: number
  filesImported: number
  nodes: number
  edges: number
  byKind: Record<string, number>
  /** The engine's own notes, including the manifest's refused objects. */
  warnings: string[]
  error: KnowledgeIngestError | null
  durationMs: number
}

/**
 * How far the knowledge step got.
 *
 * `absent`/`unavailable` mean nothing was attempted; `ingested`/`partial`/
 * `failed` describe the attempted devices; `empty` means the export reported no
 * device directory at all.
 */
export type KnowledgeGraphState = 'absent' | 'unavailable' | 'empty' | 'ingested' | 'partial' | 'failed'

/** The step's whole result: the payload plus the lines and warnings it earns. */
export interface KnowledgeIngestReport {
  state: KnowledgeGraphState
  /** True only when the engine was present and no transport failure occurred. */
  available: boolean
  /** Why the graph is not there, when it is not. */
  reason: string | null
  enginePath: string | null
  databaseConvention: string | null
  devices: IngestedDevice[]
  /** Devices that were never attempted (service unavailable or engine lost). */
  notAttempted: string[]
  totals: {
    devices: number
    ok: number
    filesFound: number
    filesImported: number
    nodes: number
    edges: number
  }
  /** Workflow-level warnings (already phrased for the model). */
  warnings: string[]
  /** Workflow-level detail lines (already phrased for the model). */
  details: string[]
}

/** What {@link ingestKnowledgeGraph} needs from the caller. */
export interface KnowledgeIngestRequest {
  /** The plugin context; the service is looked up through it. */
  ctx: Context
  /** The plugin logger, for the slow ingest's progress and its failures. */
  log: Logger
  /** The canonical workspace root, used only to spell database paths portably. */
  root: string
  /** The devices the rebuild produced, in its own order. */
  devices: readonly { device: string; directory: string }[]
  /** The tool call's signal. Cancellation is rethrown, never reported as success. */
  signal?: AbortSignal
}

/** The members of the service this plugin uses. */
export interface KnowledgeGraphLike {
  status(): unknown
  ingestDevice(
    deviceDir: string,
    options?: { dbPath?: string; signal?: AbortSignal; onProgress?: (message: string) => void },
  ): Promise<unknown>
}

// ------------------------------------------------------------------ the lookup

/**
 * The host's `knowledgeGraph` service, or `undefined` when this composition has
 * none.
 *
 * A composition without the engineering-graph plugin is legitimate (this plugin
 * still produces the source tree), so an absent or unexpected service is
 * reported as absent rather than as an error — the same rule
 * `engineeringAccess()` follows.
 *
 * @param ctx - the plugin context.
 * @returns the service, when it is present and looks usable.
 */
export function knowledgeGraph(ctx: Context): KnowledgeGraphLike | undefined {
  const service = ctx.get(KNOWLEDGE_GRAPH_SERVICE)
  if (service === null || typeof service !== 'object') return undefined
  const candidate = service as Record<string, unknown>
  for (const member of ['status', 'ingestDevice']) {
    if (typeof candidate[member] !== 'function') return undefined
  }
  return service as KnowledgeGraphLike
}

// ------------------------------------------------------------- tolerant readers

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => text(entry)).filter((entry): entry is string => entry !== null) : []
}

function numberRecord(value: unknown): Record<string, number> {
  const raw = record(value)
  if (raw === null) return {}
  const counts: Record<string, number> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) counts[key] = entry
  }
  return counts
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Normalize the service's availability snapshot; anything unreadable is "not available". */
function normalizeStatus(raw: unknown): KnowledgeGraphStatus {
  const source = record(raw) ?? {}
  return {
    available: source['available'] === true,
    reason: text(source['reason']),
    enginePath: text(source['enginePath']),
    engineExists: source['engineExists'] === true,
    source: text(source['source']),
    databaseConvention: text(source['databaseConvention']),
  }
}

/** The per-device facts the graph plugin's envelope carries in `data`. */
interface IngestedDeviceFacts {
  dbPath: string | null
  source: string | null
  filesFound: number
  filesImported: number
  nodes: number
  edges: number
  byKind: Record<string, number>
  warnings: string[]
}

/**
 * Normalize the graph plugin's canonical envelope into the facts this step reports.
 *
 * A success envelope whose `data` is not an object is **downgraded to a failure**:
 * reporting zero nodes and no database path for it would be a plausible-looking
 * wrong answer about a graph that may well exist, which is exactly the drift this
 * seam must never produce.
 */
function normalizeIngest(raw: unknown): {
  ok: boolean
  durationMs: number
  data: IngestedDeviceFacts
  error: KnowledgeIngestError | null
} {
  const source = record(raw) ?? {}
  const data = record(source['data'])
  const claimedOk = source['ok'] === true
  const ok = claimedOk && data !== null
  const facts = data ?? {}
  return {
    ok,
    durationMs: numberOf(source['durationMs']),
    data: {
      dbPath: text(facts['dbPath']),
      source: text(facts['source']),
      filesFound: numberOf(facts['filesFound']),
      filesImported: numberOf(facts['filesImported']),
      nodes: numberOf(facts['nodes']),
      edges: numberOf(facts['edges']),
      byKind: numberRecord(facts['byKind']),
      warnings: strings(facts['warnings']),
    },
    error: ok
      ? null
      : (ingestError(source['error']) ??
        (claimedOk
          ? {
              code: 'knowledge_envelope_invalid',
              message: 'the knowledgeGraph service reported success without a usable data payload',
              remediation: null,
            }
          : null)),
  }
}

/**
 * Read the envelope's structured failure.
 *
 * `details.remediation` is where the graph plugin's envelope documents the next
 * step, but a drifted producer might put it at the top level, so both are read.
 */
function ingestError(value: unknown): KnowledgeIngestError | null {
  const raw = record(value)
  if (raw === null) return null
  const code = text(raw['code'])
  if (code === null) return null
  const details = record(raw['details'])
  return {
    code,
    message: text(raw['message']) ?? code,
    remediation: details === null ? text(raw['remediation']) : (text(details['remediation']) ?? text(raw['remediation'])),
  }
}

// ------------------------------------------------------------------- the step

function emptyTotals(devices = 0): KnowledgeIngestReport['totals'] {
  return { devices, ok: 0, filesFound: 0, filesImported: 0, nodes: 0, edges: 0 }
}

/** The report for "the engine is not there", which is a state rather than a failure. */
function unavailableReport(reason: string, devices: readonly { device: string }[], status: KnowledgeGraphStatus | null): KnowledgeIngestReport {
  return {
    state: 'unavailable',
    available: false,
    reason,
    enginePath: status === null ? null : status.enginePath,
    databaseConvention: status === null ? null : status.databaseConvention,
    devices: [],
    notAttempted: devices.map((device) => device.device),
    totals: emptyTotals(devices.length),
    warnings: [
      `The knowledge graph was not built: ${reason}. The source tree is on disk, but there is no database to query — ` +
        'rebuild the graph engine, or call knowledge_ingest yourself once it is available.',
    ],
    details: [`Knowledge graph: not built — ${reason}.`],
  }
}

/**
 * Rebuild every device's knowledge database, one call per device.
 *
 * Never throws for a graph-side problem: an absent service, an unavailable
 * engine and a transport failure all come back as a report whose state says so,
 * because the export that preceded this step is the workflow's deliverable. The
 * one exception is cancellation: an aborted call is rethrown so a cancelled tool
 * never looks like a completed run.
 *
 * @param request - the context, logger, workspace root, devices and signal.
 * @returns the normalized per-device results plus the workflow lines they earn.
 */
export async function ingestKnowledgeGraph(request: KnowledgeIngestRequest): Promise<KnowledgeIngestReport> {
  const { ctx, log, root, devices, signal } = request
  const service = knowledgeGraph(ctx)

  if (service === undefined) {
    return {
      state: 'absent',
      available: false,
      reason: 'this composition has no knowledgeGraph service',
      enginePath: null,
      databaseConvention: null,
      devices: [],
      notAttempted: devices.map((device) => device.device),
      totals: emptyTotals(devices.length),
      warnings: [
        'The knowledge graph was not built: this composition has no knowledgeGraph service (the engineering-graph plugin is not ' +
          'loaded), so no knowledge database was written. The source tree is complete and is the artifact to work from.',
      ],
      details: [
        'Knowledge graph: not built — no knowledgeGraph service in this composition (install @voltarenyah/dsh-engineering-graph ' +
          'to build it).',
      ],
    }
  }

  let status: KnowledgeGraphStatus
  try {
    status = normalizeStatus(service.status())
  } catch (error) {
    const message = messageOf(error)
    log.warn(`knowledgeGraph.status() failed: ${message}`)
    return unavailableReport(`the knowledgeGraph service could not report its status (${message})`, devices, null)
  }

  if (!status.available) {
    const reason = status.reason ?? `the knowledge engine was not found at ${status.enginePath ?? 'an unknown path'}`
    log.warn(`The knowledge graph was not built: ${reason}`)
    return unavailableReport(reason, devices, status)
  }

  const results: IngestedDevice[] = []
  const notAttempted: string[] = []
  let transportFailure: string | null = null
  let transportDevice: string | null = null

  for (const device of devices) {
    if (transportFailure !== null) {
      notAttempted.push(device.device)
      continue
    }
    try {
      const outcome = normalizeIngest(
        await service.ingestDevice(device.directory, {
          signal,
          // The engine reports what it is crawling; making that visible in the
          // plugin log is what keeps a minutes-long ingest from looking hung.
          onProgress: (message) => log.debug(`knowledge ingest [${device.device}] ${message}`),
        }),
      )
      results.push({
        device: device.device,
        directory: device.directory,
        ok: outcome.ok,
        error: outcome.error,
        ...outcome.data,
        durationMs: outcome.durationMs,
      })
      if (!outcome.ok) {
        log.warn(
          `The knowledge graph did not ingest ${device.device}: ${outcome.error?.code ?? 'unknown'} — ${outcome.error?.message ?? 'no reason reported'}`,
        )
      }
    } catch (error) {
      // A cancelled call is not a degradation: rethrow so the tool reports the
      // cancellation instead of a finished workflow (the service terminates the
      // engine on abort, so continuing would be meaningless anyway).
      if (signal?.aborted === true) throw error
      transportFailure = messageOf(error)
      transportDevice = device.device
      log.warn(`The knowledge engine failed while ingesting ${device.device}: ${transportFailure}`)
      results.push({
        device: device.device,
        directory: device.directory,
        ok: false,
        dbPath: null,
        source: null,
        filesFound: 0,
        filesImported: 0,
        nodes: 0,
        edges: 0,
        byKind: {},
        warnings: [],
        error: { code: 'knowledge_engine_unreachable', message: transportFailure, remediation: null },
        durationMs: 0,
      })
    }
  }

  const succeeded = results.filter((result) => result.ok)
  const attemptedFailures = results.length - succeeded.length
  const state: KnowledgeGraphState =
    devices.length === 0
      ? 'empty'
      : transportFailure !== null
        ? succeeded.length > 0
          ? 'partial'
          : 'unavailable'
        : attemptedFailures === 0
          ? 'ingested'
          : succeeded.length === 0
            ? 'failed'
            : 'partial'

  const totals = {
    devices: devices.length,
    ok: succeeded.length,
    filesFound: results.reduce((sum, result) => sum + result.filesFound, 0),
    filesImported: results.reduce((sum, result) => sum + result.filesImported, 0),
    nodes: results.reduce((sum, result) => sum + result.nodes, 0),
    edges: results.reduce((sum, result) => sum + result.edges, 0),
  }

  const details: string[] = []
  for (const result of results) {
    if (result.ok) {
      details.push(
        `Knowledge graph: ${result.device} → ${portable(root, result.dbPath)} — ${result.filesImported}/${result.filesFound} file(s) ` +
          `parsed into ${result.nodes} node(s) and ${result.edges} edge(s)` +
          `${result.durationMs > 0 ? ` in ${result.durationMs} ms` : ''}.`,
      )
    } else {
      details.push(
        `Knowledge graph: ${result.device} — not built: ${result.error?.code ?? 'unknown'} ` +
          `${result.error?.message ?? 'no reason reported'}${result.error?.remediation === null || result.error?.remediation === undefined ? '' : ` (${result.error.remediation})`}.`,
      )
    }
  }
  if (transportFailure !== null) {
    details.push(
      `Knowledge graph: the engine failed after ${results.length} device(s) (${transportDevice ?? 'unknown'}): ${transportFailure} — ` +
        'the source tree is exported, and the remaining devices were not attempted.',
    )
  }
  if (notAttempted.length > 0) {
    details.push(`Knowledge graph: not attempted for ${notAttempted.length} device(s): ${notAttempted.join(', ')}`)
  }
  if (state === 'empty') {
    details.push('Knowledge graph: nothing to ingest — the export reported no device directory.')
  }

  const warnings: string[] = []
  for (const result of results) {
    if (result.ok || result.error === null || result.error.code === 'knowledge_engine_unreachable') continue
    warnings.push(
      `The knowledge graph could not ingest ${result.device}: ${result.error.code} — ${result.error.message}` +
        `${result.error.remediation === null ? '' : ` Remediation: ${result.error.remediation}`}` +
        '. The source tree of that device is still on disk.',
    )
  }
  if (transportFailure !== null) {
    warnings.push(
      `The knowledge engine failed while ingesting ${transportDevice ?? 'a device'} (${transportFailure}), so the knowledge graph ` +
        `${succeeded.length === 0 ? 'was not built' : 'is incomplete'}. The exported source tree is unaffected.`,
    )
  }
  const notes = results.flatMap((result) => result.warnings.map((warning) => `Knowledge graph (${result.device}): ${warning}`))
  warnings.push(...notes.slice(0, MAX_GRAPH_NOTES))
  if (notes.length > MAX_GRAPH_NOTES) {
    warnings.push(`… and ${notes.length - MAX_GRAPH_NOTES} more knowledge-graph warning(s); see data.knowledge.devices[].warnings.`)
  }

  return {
    state,
    available: transportFailure === null,
    reason: transportFailure,
    enginePath: status.enginePath,
    databaseConvention: status.databaseConvention,
    devices: results,
    notAttempted,
    totals,
    warnings,
    details,
  }
}

/** A workspace-relative spelling for a database path, or the absolute one when it is outside. */
function portable(root: string, path: string | null): string {
  if (path === null) return '?'
  try {
    return isInside(root, path) ? toPortable(root, path) : path
  } catch {
    return path
  }
}
