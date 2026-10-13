/**
 * Wire types of the controller protocol.
 *
 * The controller speaks newline-delimited JSON on stdin/stdout: one request per
 * line, one `result` frame per request, plus `ready`, `progress` and `log`
 * frames. `docs/PROTOCOL.md` is the authoritative description; this module is the
 * TypeScript view of it plus the tolerant readers used to validate frames that
 * arrive from the child process.
 */

/** Protocol revision implemented by both sides. */
export const PROTOCOL_VERSION = 1

/**
 * The complete operation whitelist, mirroring the C# `OperationCatalog`.
 *
 * This list is duplicated on purpose: the plugin refuses to send anything else,
 * and the controller independently refuses to execute anything else. Neither side
 * trusts the other's validation.
 */
export const OPERATIONS = ['OpenProject', 'ExportBlocks', 'ImportBlocks', 'CompilePlc', 'CloseProject'] as const

export type Operation = (typeof OPERATIONS)[number]

export const OPERATION_SET: ReadonlySet<string> = new Set<string>(OPERATIONS)

export function isOperation(value: string): value is Operation {
  return OPERATION_SET.has(value)
}

/** Extra context attached to a structured failure. */
export type JsonRecord = Record<string, unknown>

export interface ControllerError {
  readonly code: string
  readonly message: string
  readonly details?: JsonRecord
}

export interface ChangeRecord {
  readonly kind?: string
  readonly target?: string
  readonly action?: string
  readonly detail?: string
}

export interface DiagnosticRecord {
  readonly level?: string
  readonly message?: string
  readonly source?: string
}

/** Describes the Openness installation as the controller found it. */
export interface OpennessProbe {
  readonly opennessDir?: string
  readonly assemblyPath?: string
  readonly available?: boolean
  readonly reason?: string
  readonly message?: string
  readonly fileVersion?: string
  readonly assemblyVersion?: string
  readonly processorArchitecture?: string
  readonly probeDirectories?: readonly string[]
}

/** Reports whether the current Windows user may use Openness at all. */
export interface OpennessUserGroup {
  readonly group?: string
  readonly isMember?: boolean | null
  readonly message?: string
}

/** First frame of the channel: the controller is listening. */
export interface ReadyFrame {
  readonly type: 'ready'
  readonly protocol: number
  readonly controller: string
  readonly controllerVersion: string
  readonly pid: number
  readonly startedAt: string
  readonly runtime: string
  readonly framework: string
  readonly processArchitecture: string
  readonly userName: string
  readonly machineName: string
  readonly openness: OpennessProbe
  readonly opennessUserGroup: OpennessUserGroup
  readonly operations: readonly string[]
  readonly notes?: readonly string[]
}

/** A progress notification for an in-flight request. */
export interface ProgressFrame {
  readonly type: 'progress'
  readonly id?: string
  readonly phase: string
  readonly message: string
  readonly time?: string
}

/** An asynchronous controller note, not tied to a request. */
export interface LogFrame {
  readonly type: 'log'
  readonly level?: string
  readonly message?: string
}

/** The outcome of one request. */
export interface ResultFrame {
  readonly type: 'result'
  readonly protocol: number
  readonly id?: string
  readonly operation?: string
  readonly ok: boolean
  readonly dryRun?: boolean
  readonly startedAt?: string
  readonly durationMs?: number
  readonly data?: JsonRecord | null
  readonly changes?: readonly ChangeRecord[]
  readonly diagnostics?: readonly DiagnosticRecord[]
  readonly error?: ControllerError
}

export type Frame = ReadyFrame | ProgressFrame | LogFrame | ResultFrame

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Parses one line of controller output. Returns `null` for anything that is not
 * a JSON object, which is how stray output from the .NET runtime is tolerated
 * instead of breaking the channel.
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
  if (type !== 'ready' && type !== 'result' && type !== 'progress' && type !== 'log') return null
  return parsed as unknown as Frame
}

export function isResultFrame(frame: Frame): frame is ResultFrame {
  return frame.type === 'result'
}

export function isReadyFrame(frame: Frame): frame is ReadyFrame {
  return frame.type === 'ready'
}

export function isProgressFrame(frame: Frame): frame is ProgressFrame {
  return frame.type === 'progress'
}

/**
 * Normalizes the change and diagnostic lists so a renderer never has to defend
 * against a malformed frame.
 */
export function changesOf(frame: ResultFrame): ChangeRecord[] {
  return asArray(frame.changes).filter(isRecord) as ChangeRecord[]
}

export function diagnosticsOf(frame: ResultFrame): DiagnosticRecord[] {
  return asArray(frame.diagnostics).filter(isRecord) as DiagnosticRecord[]
}

/** The uniform canonical value every TIA tool returns to the model. */
export interface ToolOutcome {
  readonly ok: boolean
  readonly operation: string
  readonly dryRun: boolean
  readonly summary: string
  readonly data: JsonRecord | null
  readonly changes: readonly ChangeRecord[]
  readonly diagnostics: readonly DiagnosticRecord[]
  readonly error: ControllerError | null
  /** Milliseconds the controller reported for the operation. */
  readonly durationMs: number
}

/** Builds the canonical outcome of a failed request that never reached Openness. */
export function localFailure(operation: string, code: string, message: string, details?: JsonRecord): ToolOutcome {
  return {
    ok: false,
    operation,
    dryRun: false,
    summary: `${operation} was not executed: ${message}`,
    data: null,
    changes: [],
    diagnostics: [],
    error: details === undefined ? { code, message } : { code, message, details },
    durationMs: 0,
  }
}
