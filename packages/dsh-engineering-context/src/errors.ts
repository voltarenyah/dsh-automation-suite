/**
 * The plugin's own failure vocabulary.
 *
 * Every one of these is reported to the model **as data** (`ok: false` plus a
 * structured `error`) rather than thrown: the model acts on the code and the
 * details, and an exception would only reach it as a generic tool failure. The
 * codes are stable — callers and tests match on them.
 *
 * @module dsh-engineering-context/errors
 */

/** Stable failure codes of this plugin. */
export type EngineeringErrorCode =
  /** No session working directory was supplied, so no workspace can be established. */
  | 'scope_unavailable'
  /** A write target is not inside the workspace root (fail-closed). */
  | 'path_outside_workspace'
  /** No `engineeringAccess` service in this composition, so TIA cannot be reached at all. */
  | 'tia_access_unavailable'
  /** The service exists but the call itself failed (controller missing, timeout, protocol). */
  | 'tia_unreachable'
  /** No TIA Openness controller is running, so there is no open project to save. */
  | 'tia_controller_not_running'
  /** The controller is running but TIA holds no project. */
  | 'tia_project_not_open'
  /** The controller is running but TIA holds no project, and no path was given to open one. */
  | 'source_project_required'
  /** Another project is already open; this tool will not silently act on it. */
  | 'project_already_open'
  /** TIA refused to open the requested project. */
  | 'open_failed'
  /** The workspace's source tree already belongs to a different project. */
  | 'source_belongs_to_another_project'
  /** TIA reported no usable project name, so the workspace folder cannot be named. */
  | 'project_name_unavailable'
  /** The save-as operation was attempted and TIA refused it. */
  | 'save_failed'
  /** The source rebuild was attempted and failed; anything already written is kept. */
  | 'rebuild_failed'
  /** The PLC has no compiled checksum: compile it before scanning. */
  | 'needs_compile'
  /** The checksum read failed; the project is not in a compiled state. */
  | 'checksum_unavailable'
  /** Another process holds the workspace lock. */
  | 'lock_held'
  /** The workspace is not a git repository (this plugin never creates one). */
  | 'repository_not_found'
  /** A git command failed for a reason other than "no repository". */
  | 'git_failed'
  /** The evidence ledger is present but cannot be read. */
  | 'evidence_invalid'
  /** No PLC software was found in the open project. */
  | 'device_not_found'
  /** More than one PLC is present; the first slice supports one device per workspace. */
  | 'multiple_plc_unsupported'
  /** The scan itself failed; the project and the existing source tree are unchanged. */
  | 'sync_failed'
  /** An argument is missing or malformed. */
  | 'invalid_argument'

/**
 * A failure with a stable code and machine-readable details.
 *
 * @example
 * throw new EngineeringContextError('tia_project_not_open', 'TIA holds no project', { reason })
 */
export class EngineeringContextError extends Error {
  /** Stable failure code. */
  readonly code: EngineeringErrorCode
  /** Machine-readable context for the failure (never secrets, never payloads). */
  readonly details: Record<string, unknown>

  constructor(code: EngineeringErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'EngineeringContextError'
    this.code = code
    this.details = details
  }
}

/**
 * Normalizes anything thrown into the envelope's `error` shape.
 *
 * An unexpected error is reported as `internal_error` with its message, so a bug
 * in this plugin never looks like a TIA or path problem to the model.
 *
 * @param error - whatever was thrown.
 * @returns the code, message and details to place in the result.
 */
export function describeFailure(error: unknown): {
  code: string
  message: string
  details: Record<string, unknown>
} {
  if (error instanceof EngineeringContextError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}
