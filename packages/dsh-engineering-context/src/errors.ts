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
  /** No session working directory was supplied, so no scope can be established. */
  | 'scope_unavailable'
  /** A target path is not inside the workspace root (fail-closed). */
  | 'path_outside_workspace'
  /** The workspace has no engineering registry yet. */
  | 'project_not_registered'
  /** The registry has no project with that id. */
  | 'project_not_found'
  /** A project with that id is already registered. */
  | 'project_already_registered'
  /** The registry file exists but does not parse or validate. */
  | 'registry_invalid'
  /** Several projects exist and none is selected, so the target is ambiguous. */
  | 'project_ambiguous'
  /** An argument is missing or malformed. */
  | 'invalid_argument'
  /** The recorded source project file does not exist. */
  | 'source_not_found'
  /** The write target already exists and overwrite was not requested. */
  | 'target_exists'
  /** The requested action is not implemented in this phase. */
  | 'unsupported'
  /** The workspace is not inside a git repository (the plugin never creates one). */
  | 'repository_not_found'
  /** The configured git executable could not be started. */
  | 'git_not_found'
  /** git ran and failed; `details.stderr` carries its message. */
  | 'git_failed'

/**
 * A failure with a stable code and machine-readable details.
 *
 * @example
 * throw new EngineeringContextError('project_not_found', `no project '${id}'`, { available: ['a', 'b'] })
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
 * in this plugin never looks like a scope or path problem to the model.
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
