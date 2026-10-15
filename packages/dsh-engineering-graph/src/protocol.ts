/**
 * Wire types of the engineering-graph engine protocol.
 *
 * The engine (`engine/`, C#) speaks newline-delimited JSON on stdin/stdout: one
 * request per line, one `result` frame per request, plus a `ready` frame when the
 * channel comes up and any number of `progress` frames in between. This module is
 * the TypeScript view of that contract, plus the tolerant readers used to validate
 * frames that arrive from the child process. It mirrors the TIA Openness plugin's
 * `dsh-tia-openness-v17-min/src/protocol.ts`, with two deliberate differences:
 *
 * - Failures carry `remediation` as its own field, because that is what the
 *   engine's `EngineException` serializes (`engine/Protocol.cs`) and what the
 *   engineering-graph tool envelope rendered.
 * - There is no `log` frame and no `changes` / `diagnostics` list: the engine's
 *   human-readable notes go to stderr, and no operation reports either today. The
 *   canonical envelope below keeps both keys anyway, empty, so a consumer of this
 *   plugin sees one shape whether the payload is full or not.
 *
 * @module dsh-engineering-graph/protocol
 */

/** Protocol revision implemented by both sides (`Protocol.Version`). */
export const PROTOCOL_VERSION = 1

/**
 * The complete operation whitelist, mirroring the C# `OperationCatalog`.
 *
 * Duplicated on purpose: the plugin refuses to send anything else and the engine
 * independently refuses to execute anything else. Neither side trusts the other's
 * validation. **The order is part of the contract too** — the ready frame prints
 * this list in declaration order, and `test/05-protocol.test.mjs` compares the two
 * entry by entry (the C# catalog documents that requirement on its side as well).
 */
export const OPERATIONS = ['GetSchema', 'Ingest', 'Query'] as const

export type Operation = (typeof OPERATIONS)[number]

export const OPERATION_SET: ReadonlySet<string> = new Set<string>(OPERATIONS)

export function isOperation(value: string): value is Operation {
  return OPERATION_SET.has(value)
}

/** Extra context attached to a structured failure. */
export type JsonRecord = Record<string, unknown>

/** The engine's structured failure, exactly as `EngineException` serializes it. */
export interface EngineError {
  readonly code: string
  readonly message: string
  readonly remediation?: string
}

/** What an operation changed. The engine reports none today; the envelope keeps the key. */
export interface ChangeRecord {
  readonly kind?: string
  readonly target?: string
  readonly action?: string
  readonly detail?: string
}

/** A diagnostic note. The engine reports none on stdout today; the envelope keeps the key. */
export interface DiagnosticRecord {
  readonly level?: string
  readonly message?: string
  readonly source?: string
}

/** First frame of the channel: the engine is listening and ready for requests. */
export interface ReadyFrame {
  readonly type: 'ready'
  readonly protocol: number
  readonly engine: string
  readonly runtime: string
  readonly processArchitecture: string
  readonly pid: number
  readonly operations: readonly string[]
}

/** A progress notification for an in-flight request. */
export interface ProgressFrame {
  readonly type: 'progress'
  readonly id?: string
  readonly phase: string
  readonly message: string
}

/** The outcome of one request. */
export interface ResultFrame {
  readonly type: 'result'
  readonly protocol: number
  readonly id?: string
  readonly operation?: string
  readonly ok: boolean
  readonly durationMs: number
  readonly data?: JsonRecord | null
  readonly error?: EngineError
}

export type Frame = ReadyFrame | ProgressFrame | ResultFrame

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses one line of engine output. Returns `null` for anything that is not a JSON
 * object with a frame `type`, which is how stray output from the .NET runtime is
 * tolerated instead of breaking the channel.
 */
export function parseFrame(line: string): Frame | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const type = parsed['type']
  if (type !== 'ready' && type !== 'result' && type !== 'progress') return null
  return parsed as unknown as Frame
}

export function isReadyFrame(frame: Frame): frame is ReadyFrame {
  return frame.type === 'ready'
}

export function isProgressFrame(frame: Frame): frame is ProgressFrame {
  return frame.type === 'progress'
}

export function isResultFrame(frame: Frame): frame is ResultFrame {
  return frame.type === 'result'
}

/**
 * The ready frame's operation list, normalized.
 *
 * A malformed ready frame must not make `start()` crash with a `TypeError` deep in
 * a handler: `operations` is read here, where a non-list simply becomes an empty
 * list and the caller's own comparison reports the difference.
 */
export function operationsOf(frame: ReadyFrame): string[] {
  return Array.isArray(frame.operations) ? [...frame.operations] : []
}

/** The uniform canonical value every tool of this plugin returns to the model. */
export interface ToolOutcome {
  readonly ok: boolean
  /** The engine operation that ran, spelled as the engine spells it. */
  readonly operation: string
  /**
   * Always false: the engine has no dry-run mode (nothing in `GetSchema`,
   * `Ingest` or `Query` is a simulation), so the envelope keeps the TIA Openness plugin's field
   * without pretending otherwise.
   */
  readonly dryRun: boolean
  readonly summary: string
  readonly data: JsonRecord | null
  readonly changes: readonly ChangeRecord[]
  readonly diagnostics: readonly DiagnosticRecord[]
  readonly error: ToolError | null
  /** Milliseconds the engine reported for the operation. */
  readonly durationMs: number
}

/** The envelope's error member: the engine's code/message plus a `remediation` detail. */
export interface ToolError {
  readonly code: string
  readonly message: string
  readonly details?: JsonRecord
}
