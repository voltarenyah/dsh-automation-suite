/**
 * The one error type the status service throws.
 *
 * Every expected failure — an unknown session, a missing git service, a
 * directory outside any repository, a git command that timed out — is a
 * {@link StatusError}: it carries the dictionary code the panel renders and the
 * HTTP status the route answers. Anything else is a bug and surfaces as a 500.
 *
 * @module dsh-ui-changes/errors
 */

/** An expected failure with a stable code and an HTTP status. */
export class StatusError extends Error {
  /** Dictionary code, e.g. `changes/not-a-repository`. */
  readonly code: string
  /** HTTP status the route answers with. */
  readonly status: number

  /**
   * @param code - dictionary code shared with the panel.
   * @param status - HTTP status for the route.
   * @param message - human-readable detail (never rendered verbatim).
   */
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'StatusError'
    this.code = code
    this.status = status
  }
}

/** @returns whether a thrown value is an aborted `git` invocation. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: unknown }).name === 'AbortError' ||
      (error as { code?: unknown }).code === 'ABORT_ERR')
  )
}
