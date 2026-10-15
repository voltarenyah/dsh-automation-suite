/**
 * Lifecycle manager for the C# engineering-graph engine subprocess.
 *
 * The engine is one long-lived child process per plugin instance. It is spawned on
 * demand — the first request pays for it — and it is terminated by the disposer
 * the plugin registers through `ctx.effect`, so unloading the plugin never leaves
 * the engine behind. The mechanics mirror family 1's controller client
 * (`dsh-tia-openness-v17-min/src/controller.ts`) deliberately: the two plugins own
 * the same kind of resource, and one of them being subtly different would be a
 * defect, not a feature.
 *
 * Design rules implemented here:
 *
 * - **Serialized requests.** The engine is single-threaded and answers one line at
 *   a time (`engine/Program.cs:ServeStdio`), so at most one operation is in flight.
 *   Further requests queue and are sent in order; none is ever interleaved.
 * - **Hard deadlines.** A request that cannot be cancelled is abandoned by
 *   terminating the process. The next request starts a fresh engine, and because
 *   every operation is a pure function of its parameters (no session state), that
 *   costs only the process start — unlike family 1, nothing is lost.
 * - **ASCII-safe framing.** Request lines escape every non-ASCII code point, which
 *   makes the channel immune to the console code page the child inherited. The
 *   engine's own output is UTF-8 and is decoded as such.
 * - **Nothing is trusted.** Frames are validated before use; unknown output from
 *   the .NET runtime is collected as diagnostics instead of corrupting a result.
 *
 * @module dsh-engineering-graph/engine-client
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import { resolveEnginePath, type EnginePathSource } from './engine-path.js'
import { ToolFailure } from './errors.js'
import {
  OPERATIONS,
  PROTOCOL_VERSION,
  isProgressFrame,
  isReadyFrame,
  isResultFrame,
  operationsOf,
  parseFrame,
  type JsonRecord,
  type Operation,
  type ProgressFrame,
  type ReadyFrame,
  type ResultFrame,
} from './protocol.js'

/** Minimal logger surface; satisfied by `ctx.logger(name)`. */
export interface LogSink {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const silentLog: LogSink = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export type EngineState = 'stopped' | 'starting' | 'ready' | 'busy' | 'stopping' | 'failed'

export interface EngineClientOptions {
  /**
   * The configured `enginePath`. Empty means "the copy shipped with this package";
   * the resolution happens here (not in `apply`) so `status()` can report the same
   * path and source the warning named.
   */
  enginePath: string
  requestTimeoutMs: number
  startupTimeoutMs: number
  logEngineOutput: boolean
  log: LogSink
  /**
   * Complete argument list the engine is launched with. Omitted in production,
   * where it becomes no arguments at all (`Program.Main` then serves the stdio
   * protocol). Tests substitute a stub peer here to exercise the transport
   * failures — a protocol mismatch, a silent handshake, a stalled request, a
   * process that dies mid-request — that a working engine never produces. This is
   * family 1's `launchArgs`, for the same reason.
   */
  launchArgs?: readonly string[]
}

export interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (frame: ProgressFrame) => void
}

export interface EngineClientStatus extends JsonRecord {
  state: EngineState
  exePath: string
  exePathSource: EnginePathSource
  exeExists: boolean
  pid: number | null
  startedAt: string | null
  requestsServed: number
  restarts: number
  queueDepth: number
  inflightOperation: string | null
  lastError: { code: string; message: string } | null
  ready: ReadyFrame | null
  stderrTail: string[]
  unexpectedOutput: string[]
}

interface PendingRequest {
  id: string
  operation: string
  resolve: (frame: ResultFrame) => void
  reject: (error: Error) => void
  /** Assigned immediately after the entry is constructed. */
  timer?: NodeJS.Timeout
  onProgress?: (frame: ProgressFrame) => void
  detachAbort?: () => void
  settled: boolean
}

const TAIL_LIMIT = 40

/**
 * How long the engine gets to exit after its stdin is closed.
 *
 * `ServeStdio` returns as soon as `ReadLine` reports EOF, so the graceful path is
 * immediate; the grace period only covers a process that is busy finishing a
 * write. Deliberately not a config field: a profile has no reason to tune it, and
 * family 1's equivalent (`shutdownGraceMs`) exists for a controller that holds a
 * TIA Portal session, which this engine does not.
 */
export const SHUTDOWN_GRACE_MS = 5_000

/**
 * Escapes every non-ASCII code point so a request line is pure ASCII, which keeps
 * the channel correct regardless of the console code page the child process
 * inherited. JSON happens to allow the escapes, so the engine decodes them into
 * the same strings.
 */
export function asciiStringify(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

export class EngineClient {
  readonly #options: EngineClientOptions
  #child: ChildProcessWithoutNullStreams | null = null
  #state: EngineState = 'stopped'
  #ready: ReadyFrame | null = null
  #starting: Promise<ReadyFrame> | null = null
  #startedAt: string | null = null
  #pending = new Map<string, PendingRequest>()
  #stdoutBuffer = ''
  #stderrTail: string[] = []
  #unexpectedOutput: string[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #queueDepth = 0
  #requestsServed = 0
  #restarts = 0
  #lastError: { code: string; message: string } | null = null
  #stopRequested = false
  #exitWaiters: Array<() => void> = []
  #readyWaiters: Array<(outcome: ReadyFrame | ToolFailure) => void> = []

  constructor(options: EngineClientOptions) {
    this.#options = options
  }

  get state(): EngineState {
    return this.#state
  }

  get pid(): number | null {
    return this.#child?.pid ?? null
  }

  /** Starts the engine if it is not running; resolves with the ready frame. */
  async start(): Promise<ReadyFrame> {
    if (this.#ready !== null && (this.#state === 'ready' || this.#state === 'busy')) return this.#ready
    if (this.#starting !== null) return await this.#starting
    const starting = this.#doStart()
    this.#starting = starting
    try {
      return await starting
    } finally {
      if (this.#starting === starting) this.#starting = null
    }
  }

  /**
   * Performs one whitelisted operation and resolves with the result frame.
   *
   * The promise rejects only for transport failures — the engine is missing, did
   * not come up, timed out, died, or wrote something that is not a frame. An
   * operation that ran and failed resolves with `ok: false` and the engine's own
   * error code, which is what the tools turn into the canonical envelope.
   */
  async request(operation: Operation, params: JsonRecord, options: RequestOptions = {}): Promise<ResultFrame> {
    this.#queueDepth += 1
    const run = this.#queue.then(
      async () => await this.#execute(operation, params, options),
      async () => await this.#execute(operation, params, options),
    )
    // Keep the chain alive after a rejection so one failure cannot poison the queue.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await run
    } finally {
      this.#queueDepth -= 1
    }
  }

  async #execute(operation: Operation, params: JsonRecord, options: RequestOptions): Promise<ResultFrame> {
    await this.start()

    const child = this.#child
    if (child === null || child.stdin.destroyed || !child.stdin.writable) {
      throw new ToolFailure('engine_unavailable', 'The engine process is not accepting requests.', { operation })
    }

    const id = randomUUID()
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs
    this.#state = 'busy'

    return await new Promise<ResultFrame>((resolvePromise, rejectPromise) => {
      const pending: PendingRequest = {
        id,
        operation,
        settled: false,
        resolve: resolvePromise,
        reject: rejectPromise,
      }
      if (options.onProgress !== undefined) pending.onProgress = options.onProgress

      const settle = (): boolean => {
        if (pending.settled) return false
        pending.settled = true
        clearTimeout(pending.timer)
        pending.detachAbort?.()
        this.#pending.delete(id)
        if (this.#pending.size === 0 && this.#state === 'busy') this.#state = 'ready'
        return true
      }

      pending.resolve = (frame: ResultFrame): void => {
        if (!settle()) return
        resolvePromise(frame)
      }
      pending.reject = (error: Error): void => {
        if (!settle()) return
        rejectPromise(error)
      }

      pending.timer = setTimeout(() => {
        if (pending.settled) return
        const message =
          `The engine did not answer ${operation} within ${timeoutMs} ms. An engine operation cannot be interrupted, ` +
          'so the engine was terminated; the next call starts a new one and nothing is lost, because every operation ' +
          'is a pure function of its parameters.'
        this.#options.log.error(message)
        pending.reject(new ToolFailure('engine_timeout', message, { operation, timeoutMs, pid: this.#child?.pid ?? null }))
        this.#hardAbort('engine_timeout', message)
      }, timeoutMs)

      const signal = options.signal
      if (signal !== undefined) {
        const onAbort = (): void => {
          if (pending.settled) return
          const message = `The ${operation} request was cancelled. The engine was terminated because an engine operation cannot be interrupted.`
          pending.reject(new ToolFailure('engine_cancelled', message, { operation }))
          this.#hardAbort('engine_cancelled', message)
        }
        if (signal.aborted) {
          // Nothing has been written yet, so the engine is idle and is left alone:
          // killing a healthy process here would be a side effect of a request that
          // never happened.
          pending.reject(
            new ToolFailure('engine_cancelled', `The ${operation} request was cancelled before it was sent.`, { operation }),
          )
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pending.detachAbort = () => signal.removeEventListener('abort', onAbort)
      }

      this.#pending.set(id, pending)

      try {
        child.stdin.write(`${asciiStringify({ id, type: 'operation', operation, params })}\n`, 'utf8')
        this.#options.log.debug(`engine <- ${operation} (${id})`)
      } catch (error) {
        pending.reject(
          new ToolFailure(
            'engine_write_failed',
            `The request could not be written to the engine: ${error instanceof Error ? error.message : String(error)}`,
            { operation },
          ),
        )
      }
    })
  }

  /** Stops the engine gracefully, then by force if it does not exit in time. */
  async stop(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    // A start that is still in flight must finish first, otherwise stopping here
    // would leave a freshly spawned child behind.
    if (this.#starting !== null) {
      try {
        await this.#starting
      } catch {
        // A failed start has nothing to stop.
      }
    }

    const child = this.#child
    if (child === null) {
      this.#state = 'stopped'
      this.#ready = null
      return
    }

    this.#stopRequested = true
    this.#state = 'stopping'

    // Closing stdin is the documented graceful path: `ServeStdio` reads EOF,
    // returns from `Main`, and the process exits.
    try {
      child.stdin.end()
    } catch {
      // The pipe is already gone; fall through to the forced path.
    }

    const exited = await this.#waitForExit(graceMs)
    if (!exited) {
      this.#options.log.warn(`The engine did not exit within ${graceMs} ms; terminating it.`)
      this.#kill()
      await this.#waitForExit(2_000)
      if (this.#child !== null) {
        this.#kill('SIGKILL')
        await this.#waitForExit(2_000)
      }
    }

    // The kill has been issued even if its `exit` event has not arrived yet.
    // Forgetting the handle here is what makes "stop never leaves the child
    // behind" true: a late `exit` event for a detached child is ignored (see
    // `isCurrent`), and a later `start()` can never adopt a process that is only
    // now dying.
    if (this.#child !== null) {
      this.#child = null
      this.#options.log.warn('The engine process did not report its exit before stop() returned; it was forgotten and is being terminated.')
    }

    this.#state = 'stopped'
    this.#ready = null
  }

  /** Immediate termination; used on unload and on unrecoverable transport errors. */
  #hardAbort(code: string, message: string): void {
    this.#lastError = { code, message }
    this.#state = 'failed'
    this.#kill()
  }

  #kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    const child = this.#child
    if (child === null) return
    this.#killChild(child, signal)
  }

  /**
   * Terminates one specific child, whether or not it is still the current one.
   * The engine has no children of its own: it is a single .NET process that reads
   * stdin, queries SQLite and writes stdout.
   */
  #killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGKILL'): void {
    try {
      // On Windows any signal terminates the process.
      child.kill(signal)
    } catch (error) {
      this.#options.log.warn(`Terminating the engine failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#child === null) return true
    if (timeoutMs <= 0) return this.#child === null
    return await new Promise<boolean>((resolvePromise) => {
      const waiter = (): void => {
        clearTimeout(timer)
        resolvePromise(true)
      }
      const timer = setTimeout(() => {
        const index = this.#exitWaiters.indexOf(waiter)
        if (index >= 0) this.#exitWaiters.splice(index, 1)
        resolvePromise(this.#child === null)
      }, timeoutMs)
      this.#exitWaiters.push(waiter)
    })
  }

  /** Current lifecycle and diagnostics snapshot. */
  status(): EngineClientStatus {
    const { path: exePath, source } = resolveEnginePath(this.#options.enginePath)
    const firstPending = [...this.#pending.values()][0]
    return {
      state: this.#state,
      exePath,
      exePathSource: source,
      exeExists: existsSync(exePath),
      pid: this.pid,
      startedAt: this.#startedAt,
      requestsServed: this.#requestsServed,
      restarts: this.#restarts,
      queueDepth: this.#queueDepth,
      inflightOperation: firstPending?.operation ?? null,
      lastError: this.#lastError,
      ready: this.#ready,
      stderrTail: [...this.#stderrTail],
      unexpectedOutput: [...this.#unexpectedOutput],
    }
  }

  // ------------------------------------------------------------------ internals

  async #doStart(): Promise<ReadyFrame> {
    const { path: exePath, source } = resolveEnginePath(this.#options.enginePath)
    if (!existsSync(exePath)) {
      const failure = new ToolFailure(
        'engine_not_found',
        `The engineering-graph engine was not found at ${exePath}. Build it with ` +
          '"dotnet build engine/EngineeringGraph.Engine.csproj -c Release" (the default output is ' +
          'engine/bin/EngineeringGraph.Engine.exe, Windows x64), install the package including engine/bin, or point ' +
          'the plugin\'s enginePath config at an existing executable.',
        { exePath, exePathSource: source, platform: process.platform, arch: process.arch },
      )
      // Recording the failure makes status() explain it without the caller having
      // to retry a failing operation.
      this.#lastError = { code: failure.code, message: failure.message }
      this.#state = 'failed'
      throw failure
    }

    if (this.#restarts > 0 || this.#state === 'failed') this.#options.log.info('Starting a new engineering-graph engine process.')

    // A previous child may still be dying (its `exit` event has not arrived yet).
    // Detaching it first means its late events are ignored, and killing it here
    // means a replacement can never leave an untracked process behind.
    const previousChild = this.#child
    if (previousChild !== null) {
      this.#child = null
      this.#killChild(previousChild)
    }

    let child: ChildProcessWithoutNullStreams
    const args = this.#options.launchArgs === undefined ? [] : [...this.#options.launchArgs]
    try {
      // With no arguments, Program.Main falls through to ServeStdio(), which is the
      // NDJSON channel. cwd is the engine directory so its own relative defaults
      // (and any native SQLite resolution) behave the same wherever the host runs.
      child = spawn(exePath, args, {
        cwd: dirname(exePath),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new ToolFailure(
        'engine_spawn_failed',
        `The engine could not be started: ${error instanceof Error ? error.message : String(error)}`,
        { exePath },
      )
    }

    this.#child = child
    this.#state = 'starting'
    this.#stopRequested = false
    this.#stdoutBuffer = ''

    // Every handler checks that the event still belongs to the current child.
    // Without that check a late event from a replaced child would clear the new
    // child's reference (orphaning it), or feed stale output into a live request.
    const isCurrent = (): boolean => this.#child === child

    // The engine's output is UTF-8 *by design* (`engine/Protocol.cs` deliberately
    // does not \uXXXX-escape non-ASCII payloads, because translated logic and
    // Chinese network titles are routine), so that is how it is decoded here.
    //
    // One verified caveat belongs on the record: when this process is itself
    // attached to a console, the child inherits that console's code page and
    // `Console.Out` mangles non-ASCII into '?'. Requests are immune (they are
    // ASCII-escaped on the way out, see `asciiStringify`), and the fixtures are
    // ASCII apart from a BOM, so the test suite does not depend on it — but a
    // payload that *is* non-ASCII comes back lossy from such a parent. The fix
    // belongs in the engine (`Console.OutputEncoding = new UTF8Encoding(false)`
    // before the first frame), not in a guess here about which code page it chose.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (isCurrent()) this.#onStdout(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      if (isCurrent()) this.#onStderr(chunk)
    })
    child.on('error', (error) => {
      if (isCurrent()) this.#onChildError(error)
    })
    child.on('exit', (code, signal) => {
      if (isCurrent()) this.#onExit(code, signal)
    })
    // A write to a child that has just died fails *asynchronously*, as an `error`
    // event on the pipe, not as a throw from `write()`. Node treats an unhandled
    // `error` event as an uncaught exception, so without this listener a request
    // queued behind a dying engine would take the host process down instead of
    // failing that one request.
    child.stdin.on('error', (error: Error) => {
      if (isCurrent()) this.#onStdinError(error)
    })

    try {
      const ready = await this.#awaitReady()
      if (!isCurrent()) {
        throw new ToolFailure('engine_restarted', 'The engine was replaced while it was starting.', { exePath })
      }
      this.#ready = ready
      this.#state = 'ready'
      this.#startedAt = new Date().toISOString()
      return ready
    } catch (error) {
      if (isCurrent()) {
        this.#child = null
        this.#state = 'failed'
      }
      // Every start failure — a silent handshake, a protocol mismatch, a peer that
      // speaks another catalog — is recorded, so status() explains it without the
      // caller having to retry a failing operation.
      if (error instanceof ToolFailure) this.#lastError = { code: error.code, message: error.message }
      this.#killChild(child)
      throw error
    }
  }

  async #awaitReady(): Promise<ReadyFrame> {
    const deadline = this.#options.startupTimeoutMs
    return await new Promise<ReadyFrame>((resolvePromise, rejectPromise) => {
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#readyWaiters = this.#readyWaiters.filter((waiter) => waiter !== onReady)
        action()
      }

      const onReady = (outcome: ReadyFrame | ToolFailure): void => {
        if (outcome instanceof ToolFailure) {
          finish(() => rejectPromise(outcome))
          return
        }
        if (outcome.protocol !== PROTOCOL_VERSION) {
          finish(() =>
            rejectPromise(
              new ToolFailure(
                'engine_protocol_mismatch',
                `The engine speaks protocol ${String(outcome.protocol)} but this plugin expects ${PROTOCOL_VERSION}. ` +
                  'Rebuild the engine from this package.',
                { engineProtocol: outcome.protocol, pluginProtocol: PROTOCOL_VERSION },
              ),
            ),
          )
          return
        }
        // The engine prints its catalog in the ready frame, so a disagreement with
        // this plugin's copy is detectable here instead of surfacing later as an
        // `unsupported_operation` on an operation the plugin believed existed. It is
        // a warning, not a failure: a newer engine that grew an operation is still
        // usable for the three this plugin sends.
        const announced = operationsOf(outcome)
        if (announced.join(',') !== OPERATIONS.join(',')) {
          this.#options.log.warn(
            `The engine announced operations [${announced.join(', ')}] but this plugin expects [${OPERATIONS.join(', ')}]. ` +
              'The two halves are out of sync; rebuild the engine from this package.',
          )
        }
        finish(() => resolvePromise(outcome))
      }

      const timer = setTimeout(() => {
        finish(() =>
          rejectPromise(
            new ToolFailure(
              'engine_handshake_timeout',
              `The engine did not report readiness within ${deadline} ms. The captured stderr is attached.`,
              { stderr: [...this.#stderrTail] },
            ),
          ),
        )
      }, deadline)

      this.#readyWaiters.push(onReady)
    })
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk
    let index = this.#stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#stdoutBuffer.slice(0, index).replace(/\r$/, '')
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1)
      if (line.trim().length > 0) this.#onLine(line)
      index = this.#stdoutBuffer.indexOf('\n')
    }
  }

  #onLine(line: string): void {
    const frame = parseFrame(line)
    if (frame === null) {
      // Anything the .NET runtime writes to stdout that is not a frame is kept as a
      // diagnostic instead of being mistaken for a protocol message.
      this.#pushTail(this.#unexpectedOutput, line)
      if (this.#options.logEngineOutput) this.#options.log.info(`engine stdout: ${line}`)
      return
    }

    switch (frame.type) {
      case 'ready':
        if (isReadyFrame(frame)) {
          this.#options.log.debug(`engine ready (pid ${frame.pid}, ${frame.engine} on ${frame.runtime}, ${frame.processArchitecture})`)
          for (const waiter of [...this.#readyWaiters]) waiter(frame)
        }
        return
      case 'progress':
        if (isProgressFrame(frame)) this.#onProgress(frame)
        return
      case 'result':
        if (isResultFrame(frame)) this.#onResult(frame)
        return
    }
  }

  #onProgress(frame: ProgressFrame): void {
    if (this.#options.logEngineOutput) this.#options.log.info(`engine progress [${frame.phase}] ${frame.message}`)
    const pending = frame.id === undefined ? undefined : this.#pending.get(frame.id)
    pending?.onProgress?.(frame)
  }

  #onResult(frame: ResultFrame): void {
    this.#requestsServed += 1
    const id = frame.id
    if (id === undefined) {
      this.#pushTail(this.#unexpectedOutput, `A result frame without a correlation id: ${JSON.stringify(frame).slice(0, 200)}`)
      return
    }
    const pending = this.#pending.get(id)
    if (pending === undefined) {
      this.#pushTail(this.#unexpectedOutput, `A result frame for an unknown request id ${id}.`)
      return
    }
    pending.resolve(frame)
  }

  #onStderr(chunk: string): void {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      this.#pushTail(this.#stderrTail, line)
      if (this.#options.logEngineOutput) this.#options.log.info(`engine stderr: ${line}`)
    }
  }

  #onChildError(error: Error): void {
    const failure = new ToolFailure('engine_spawn_failed', `The engine process reported an error: ${error.message}`, {
      exePath: this.#options.enginePath,
      platform: process.platform,
    })
    this.#lastError = { code: failure.code, message: failure.message }
    this.#rejectReadyWaiters(failure)
    this.#failPending(failure)
  }

  /**
   * The engine's stdin pipe failed (the child died, or closed its input). The
   * in-flight requests can never be answered, so they are failed here rather than
   * left to their timeouts.
   */
  #onStdinError(error: Error): void {
    const failure = new ToolFailure('engine_write_failed', `The engine's stdin pipe failed: ${error.message}`, {
      exePath: this.#options.enginePath,
    })
    this.#lastError = { code: failure.code, message: failure.message }
    this.#failPending(failure)
  }

  #rejectReadyWaiters(failure: ToolFailure): void {
    for (const waiter of [...this.#readyWaiters]) waiter(failure)
    this.#readyWaiters = []
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStopping = this.#stopRequested || this.#state === 'stopping'
    this.#child = null
    this.#ready = null
    this.#startedAt = null

    for (const waiter of [...this.#exitWaiters]) waiter()
    this.#exitWaiters = []

    if (wasStopping) {
      this.#state = 'stopped'
      return
    }

    this.#state = 'failed'
    const detail = `exit code ${code ?? 'none'}${signal === null ? '' : `, signal ${signal}`}`
    const failure = new ToolFailure(
      'engine_exited',
      `The engine exited unexpectedly (${detail}). Captured stderr: ${this.#stderrTail.slice(-5).join(' | ') || 'none'}`,
      { code, signal, stderr: [...this.#stderrTail], servedOperations: this.#requestsServed },
    )
    this.#lastError = { code: failure.code, message: failure.message }

    // A restart is only counted when a request had to be abandoned; the next
    // request spawns a fresh engine automatically.
    if (this.#pending.size > 0) this.#restarts += 1
    this.#rejectReadyWaiters(failure)
    this.#failPending(failure)
  }

  #failPending(error: Error): void {
    for (const pending of [...this.#pending.values()]) {
      pending.reject(error)
    }
    // Rejections above settle their entries; drop anything left for safety.
    this.#pending.clear()
  }

  #pushTail(target: string[], line: string): void {
    target.push(line)
    if (target.length > TAIL_LIMIT) target.splice(0, target.length - TAIL_LIMIT)
  }
}
