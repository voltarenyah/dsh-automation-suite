/**
 * The TIA seam, trimmed to what this plugin needs.
 *
 * The version-control plugin is **not** allowed to talk to TIA (root
 * `docs/version-control-plan.md` §1): recording history is a git + filesystem
 * operation. The one exception is a **cross-check** when `project_commit` runs
 * inside a composition that happens to have the interface plugin: it asks which
 * project is open only so it can *warn* that the workspace and the open project
 * disagree. It never opens, saves or rebuilds anything.
 *
 * Therefore this module carries the smallest slice of the interface plugin's
 * service shape: the four functions `engineeringAccess()` probes for (so a
 * half-installed plugin is not mistaken for a full one), plus the session
 * normaliser the warning needs. It is deliberately **not** a copy of
 * `@automation-suite/engineering-context/src/access.ts`: the 12-method mirror
 * lives there, and duplicating it here would be a contract with no consumer.
 *
 * @module dsh-engineering-version-control/access
 */

import type { Context } from '@deepseek-ai/cordis'

/** The cordis service name the interface plugin provides. */
export const ENGINEERING_ACCESS_SERVICE = 'engineeringAccess'

/** One PLC software, as the session report lists it. */
export interface TiaSoftware {
  device: string
  software: string
  blockCount: number | null
}

/** What the interface plugin reports about TIA Portal, normalized. */
export interface TiaSession {
  running: boolean
  projectOpen: boolean
  projectName: string | null
  projectPath: string | null
  isModified: boolean | null
  software: TiaSoftware[]
  reason: string | null
}

/**
 * The members this plugin probes for.
 *
 * The other three are never called; they are checked because a service that
 * cannot open or rebuild a project is not the interface plugin, and a warning
 * based on a half-installed plugin would be noise.
 */
export interface EngineeringAccessLike {
  readTiaSession(options?: { signal?: AbortSignal }): Promise<unknown>
  openProject(...args: unknown[]): Promise<unknown>
  saveProjectAs(...args: unknown[]): Promise<unknown>
  rebuildSource(...args: unknown[]): Promise<unknown>
}

/** The service when it looks like the interface plugin's, else undefined. */
export function engineeringAccess(ctx: Context): EngineeringAccessLike | undefined {
  const service = ctx.get(ENGINEERING_ACCESS_SERVICE)
  if (service === null || typeof service !== 'object') return undefined
  const candidate = service as Record<string, unknown>
  for (const member of ['readTiaSession', 'openProject', 'saveProjectAs', 'rebuildSource']) {
    if (typeof candidate[member] !== 'function') return undefined
  }
  return service as EngineeringAccessLike
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** One PLC software, read out of the session report. */
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
