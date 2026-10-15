/**
 * Structured failures raised by the plugin itself.
 *
 * A `ToolFailure` means the request never produced an engine outcome: the engine
 * executable is missing, could not be started, did not answer in time, died
 * mid-request, or answered with something that is not a protocol frame.
 * Operations that did run and reported a problem come back as an ordinary result
 * frame with `ok: false` instead, so the model keeps the engine's own error codes.
 *
 * The message always begins with the code (`<code>: <message>`), so a caller that
 * only has the text — a log line, a tool error surfaced by the framework — still
 * sees the stable classification first. This mirrors family 1's
 * `dsh-tia-openness-v17-min/src/errors.ts`, deliberately: the two plugins use the
 * same failure style for the same kind of event.
 *
 * @module dsh-engineering-graph/errors
 */

import type { JsonRecord } from './protocol.js'

export class ToolFailure extends Error {
  /** Stable machine-readable code, also used as the message prefix. */
  readonly code: string

  /** Extra context for the failure. */
  readonly details?: JsonRecord

  constructor(code: string, message: string, details?: JsonRecord) {
    super(`${code}: ${message}`)
    this.name = 'ToolFailure'
    this.code = code
    this.details = details
  }
}
