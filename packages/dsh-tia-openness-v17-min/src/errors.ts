/**
 * Structured failures raised by the plugin itself.
 *
 * A `ToolFailure` means the request never produced a controller outcome: the
 * controller is missing, could not start, did not answer in time, or answered
 * with something that is not a protocol frame. Operations that did run and
 * reported a problem are returned as an ordinary outcome with `ok: false`
 * instead, so the model keeps the structured error codes.
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
