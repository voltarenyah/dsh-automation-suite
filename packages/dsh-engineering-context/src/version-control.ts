/**
 * The `versionControl` seam: the mirror of the version-control plugin's service.
 *
 * Version history left this package in the split (root
 * `docs/version-control-plan.md` §5). What remains here is the **caller** side:
 * `create_engineering_project` imports a project and then asks the other plugin to
 * record it. The mirror stays small on purpose — two calls — because D10 forbids a
 * shared package and every mirrored method is a contract that must not drift.
 *
 * The service is optional. Without it the import still completes: the project, the
 * source tree and the evidence ledger are on disk. What is missing is history, and
 * the tool says so instead of failing.
 *
 * @module dsh-engineering-context/version-control
 */

import type { Context } from '@deepseek-ai/cordis'

/** The cordis service name the version-control plugin provides. */
export const VERSION_CONTROL_SERVICE = 'versionControl'

/** The PLC a baseline belongs to. */
export interface BaselineDevice {
  device: string
  software: string
  /** Absolute device directory. */
  directory: string
}

/** The preflight answer: may this workspace be initialized and committed into, and what would the plan say. */
export interface BaselinePlan {
  state: 'none' | 'reuse'
  initialize: boolean
  repoRoot: string | null
  description: string
}

/** One baseline commit to record. Every path must be absolute. */
export interface BaselineRequest {
  workspace: string
  sourceRoot: string
  device: BaselineDevice
  label: string
  checksum: string
  stateId: string
  /** This package's layout names, so the marker lands where this package expects. */
  stateDirName?: string
  sourceDirName?: string
}

/** What the baseline commit did, and what the derived indexes said. */
export interface BaselineResult {
  root: string
  initialized: boolean
  committed: boolean
  hash: string | null
  versionNote: string | null
  warnings: string[]
}

/** The two calls this package makes on the version-control plugin. */
export interface VersionControlLike {
  planBaseline(request: {
    workspace: string
    stateDirName?: string
    sourceDirName?: string
  }): Promise<BaselinePlan>
  recordBaseline(request: BaselineRequest): Promise<BaselineResult>
}

/**
 * The service when this composition has it, else undefined.
 *
 * Both members are checked: a half-installed plugin must look absent rather than
 * fail halfway through an import.
 *
 * @param ctx - the plugin context.
 * @returns the service, or undefined.
 */
export function versionControl(ctx: Context): VersionControlLike | undefined {
  const service = ctx.get(VERSION_CONTROL_SERVICE)
  if (service === null || typeof service !== 'object') return undefined
  const candidate = service as Record<string, unknown>
  for (const member of ['planBaseline', 'recordBaseline']) {
    if (typeof candidate[member] !== 'function') return undefined
  }
  return service as VersionControlLike
}
