/**
 * Refresh the knowledge graph after a sync, incrementally when the change set is
 * small and structurally safe, otherwise by a full rebuild.
 *
 * The graph plugin owns the engine and the database; this module only decides
 * **which** of its two entry points to call and normalizes the answer into the
 * sync result. Two rules keep the decision honest:
 *
 *   1. A change to a PLC type or a tag table can affect every block, so it forces
 *      a full rebuild; so does a change set larger than {@link MAX_INCREMENTAL}.
 *   2. An incremental update that the engine refuses because the database lacks
 *      component provenance (or the update is too large) is retried as a full
 *      rebuild, and the retry is visible in the result.
 *
 * A graph failure never fails the sync: the commit is the deliverable, the graph
 * is a derived view. The failure is reported as data and leaves the freshness
 * sidecar untouched (the graph plugin's own rule).
 *
 * @module dsh-engineering-context/knowledge-refresh
 */

import type { Context, Logger } from '@deepseek-ai/cordis'

import type { DeviceInfo } from './device.js'
import { ingestKnowledgeGraph, knowledgeGraph, type KnowledgeGraphLike } from './knowledge-graph.js'

/** Above this many changed XML files an incremental update is not attempted. */
export const MAX_INCREMENTAL = 20

/** What the refresh did, for the sync result. */
export interface KnowledgeRefreshReport {
  /** `none` when there was nothing to refresh. */
  state: 'none' | 'absent' | 'unavailable' | 'updated' | 'rebuilt' | 'failed'
  /** Which entry point was used (or would have been). */
  mode: 'none' | 'incremental' | 'full'
  device: string
  changed: number
  removed: number
  /** True when a full rebuild was chosen because of the change set. */
  forcedFull: boolean
  /** The engine's own code when it refused, or null. */
  errorCode: string | null
  errorMessage: string | null
  details: string[]
  warnings: string[]
}

/** What {@link refreshKnowledgeGraph} needs. */
export interface KnowledgeRefreshRequest {
  ctx: Context
  log: Logger
  root: string
  device: DeviceInfo
  changedPaths: readonly string[]
  removedPaths: readonly string[]
  fullRebuildRequired: boolean
  signal?: AbortSignal
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function errorOf(value: unknown): { code: string; message: string } | null {
  const raw = record(value)
  if (raw === null) return null
  const code = text(raw['code'])
  return code === null ? null : { code, message: text(raw['message']) ?? code }
}

/** Codes that mean "this database cannot be updated in place; rebuild it". */
const FALLBACK_CODES = new Set(['UPDATE_REQUIRES_FULL_REBUILD', 'UPDATE_TOO_LARGE', 'UPDATE_UNKNOWN_COMPONENT'])

function baseReport(device: DeviceInfo, changed: number, removed: number): KnowledgeRefreshReport {
  return {
    state: 'none',
    mode: 'none',
    device: device.device,
    changed,
    removed,
    forcedFull: false,
    errorCode: null,
    errorMessage: null,
    details: [],
    warnings: [],
  }
}

/**
 * Refresh one device's graph after a successful sync.
 *
 * @param request - the service seams, the device, the changed/removed paths and
 *   whether the change set requires a full rebuild.
 * @returns what was attempted and what happened. Never throws for a graph-side
 *   failure; a cancelled call is rethrown by the underlying ingest helper.
 */
export async function refreshKnowledgeGraph(request: KnowledgeRefreshRequest): Promise<KnowledgeRefreshReport> {
  const { ctx, log, root, device, changedPaths, removedPaths, signal } = request
  const changed = changedPaths.length
  const removed = removedPaths.length
  const report = baseReport(device, changed, removed)

  if (changed === 0 && removed === 0) {
    report.details.push(`Knowledge graph: ${device.device} — no changed block XML to refresh.`)
    return report
  }

  const service: KnowledgeGraphLike | undefined = knowledgeGraph(ctx)
  if (service === undefined) {
    report.state = 'absent'
    report.warnings.push(
      'The knowledge graph was not refreshed: this composition has no knowledgeGraph service. ' +
        'The source tree and commit are complete; rebuild the graph when the plugin is available.',
    )
    report.details.push('Knowledge graph: not refreshed — no knowledgeGraph service.')
    return report
  }

  const tooMany = changed + removed > MAX_INCREMENTAL
  const forceFull = request.fullRebuildRequired || tooMany || typeof service.updateDevice !== 'function'
  const why = request.fullRebuildRequired
    ? 'a type or tag table changed'
    : tooMany
      ? `${changed + removed} changed file(s) exceed the incremental limit (${MAX_INCREMENTAL})`
      : typeof service.updateDevice !== 'function'
        ? 'the installed graph plugin has no updateDevice method'
        : null

  if (forceFull) {
    report.mode = 'full'
    report.forcedFull = true
    if (why !== null) report.details.push(`Knowledge graph: full rebuild chosen — ${why}.`)
    return await fullRebuild(request, report, why)
  }

  report.mode = 'incremental'
  try {
    const outcome = record(await service.updateDevice!(device.directory, {
      changedPaths: [...changedPaths],
      removedPaths: [...removedPaths],
      signal,
    }))
    if (outcome === null || outcome['ok'] !== true) {
      const failure = errorOf(outcome?.['error'])
      report.state = 'failed'
      report.errorCode = failure?.code ?? 'knowledge_update_failed'
      report.errorMessage = failure?.message ?? 'the graph service did not report success'
      if (failure !== null && FALLBACK_CODES.has(failure.code)) {
        // The incremental base is unusable; do what a rebuild would have done,
        // but say so instead of hiding the extra work.
        report.details.push(
          `Knowledge graph: incremental update refused (${failure.code}); falling back to a full rebuild.`,
        )
        const rebuilt = await fullRebuild(request, report, failure.code)
        rebuilt.mode = 'full'
        rebuilt.forcedFull = true
        return rebuilt
      }
      report.warnings.push(
        `The knowledge graph was not refreshed for ${device.device}: ${report.errorCode} — ${report.errorMessage}. ` +
          'The source tree and commit are complete; the graph is now stale.',
      )
      report.details.push(`Knowledge graph: not refreshed — ${report.errorCode}: ${report.errorMessage}.`)
      return report
    }

    const data = record(outcome['data']) ?? {}
    report.state = 'updated'
    report.details.push(
      `Knowledge graph: ${device.device} — updated ${changed} changed and ${removed} removed component(s) ` +
        `(${numberOf(data['nodes'])} node(s), ${numberOf(data['edges'])} edge(s)).`,
    )
    return report
  } catch (error) {
    if (signal?.aborted === true) throw error
    report.state = 'failed'
    report.errorCode = 'knowledge_update_unreachable'
    report.errorMessage = error instanceof Error ? error.message : String(error)
    log.warn(`Knowledge graph update failed for ${device.device}: ${report.errorMessage}`)
    report.warnings.push(
      `The knowledge graph was not refreshed for ${device.device}: ${report.errorMessage}. ` +
        'The source tree and commit are complete; the graph is now stale.',
    )
    report.details.push(`Knowledge graph: not refreshed — ${report.errorMessage}.`)
    return report
  }
}

/** Full rebuild through the existing ingest helper. */
async function fullRebuild(
  request: KnowledgeRefreshRequest,
  report: KnowledgeRefreshReport,
  why: string | null,
): Promise<KnowledgeRefreshReport> {
  const ingest = await ingestKnowledgeGraph({
    ctx: request.ctx,
    log: request.log,
    root: request.root,
    devices: [{ device: request.device.device, directory: request.device.directory }],
    signal: request.signal,
  })

  report.details.push(...ingest.details)
  report.warnings.push(...ingest.warnings)
  if (ingest.state === 'ingested') {
    report.state = 'rebuilt'
    report.details.push(
      `Knowledge graph: ${request.device.device} — full rebuild completed${why === null ? '' : ` (${why})`}.`,
    )
  } else {
    report.state = ingest.state === 'absent' || ingest.state === 'unavailable' ? ingest.state : 'failed'
    report.errorCode = report.errorCode ?? (ingest.state === 'absent' ? 'knowledge_service_absent' : 'knowledge_ingest_failed')
    report.errorMessage = report.errorMessage ?? ingest.reason
  }
  return report
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
