/**
 * Wire types shared by the controller process manager and the model-facing
 * tools. The controller speaks one JSON object per line, exactly like the TIA
 * plugin: a `ready` frame once, then one `result` frame per request.
 *
 * @module dsh-plcsim-advanced/protocol
 */

export const PROTOCOL_VERSION = 1

export type JsonRecord = Record<string, unknown>

export interface ReadyFrame extends JsonRecord {
  type: 'ready'
  protocol: number
  controller: string
  version: string
  apiDir: string
  api: JsonRecord
}

export interface ResultFrame extends JsonRecord {
  type: 'result'
  protocol: number
  id: string | null
  operation: string | null
  ok: boolean
  data: JsonRecord | null
  error: { code: string; message: string; details?: unknown } | null
  durationMs: number
}

export function parseFrame(line: string): JsonRecord {
  const value: unknown = JSON.parse(line)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the controller sent a frame that is not a JSON object')
  }
  return value as JsonRecord
}

export function isReadyFrame(value: JsonRecord): value is ReadyFrame {
  return value['type'] === 'ready' && value['protocol'] === PROTOCOL_VERSION
}

export function isResultFrame(value: JsonRecord): value is ResultFrame {
  return value['type'] === 'result' && value['protocol'] === PROTOCOL_VERSION
}

/** The four operations the controller accepts; anything else is refused. */
export const OPERATIONS = ['Status', 'Instance', 'Run', 'Tags'] as const
export type Operation = (typeof OPERATIONS)[number]

export function isOperation(value: string): value is Operation {
  return (OPERATIONS as readonly string[]).includes(value)
}
