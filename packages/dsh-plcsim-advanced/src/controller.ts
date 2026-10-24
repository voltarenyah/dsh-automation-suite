/**
 * Lifecycle manager for the PLCSIM Advanced C# controller.
 *
 * One long-lived child process per plugin instance. The controller holds the
 * Simulation Runtime API client, so the instances live exactly as long as this
 * process; it is spawned on demand and terminated by the host row's disposer.
 *
 * Requests are serialized (the API is not thread safe), each has a hard
 * deadline, and a timed-out controller is killed so the next request starts a
 * fresh Runtime Manager client. Frames are newline-delimited JSON; requests are
 * escaped to pure ASCII so the console code page cannot corrupt the channel.
 *
 * @module dsh-plcsim-advanced/controller
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { ControllerFailure } from './errors.js'
import {
  PROTOCOL_VERSION,
  isReadyFrame,
  isResultFrame,
  parseFrame,
  type JsonRecord,
  type ReadyFrame,
  type ResultFrame,
} from './protocol.js'

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

export type ControllerState = 'stopped' | 'starting' | 'ready' | 'busy' | 'failed'

export interface ControllerOptions {
  exePath: string
  apiDir: string
  storageRoot: string
  networkMode: 'softbus' | 'tcpip'
  showControlPanel: boolean
  controlPanelPath: string
  keepInstancesOnUnload: boolean
  requestTimeoutMs: number
  startupTimeoutMs: number
  shutdownGraceMs: number
  maxQueue: number
  logControllerOutput: boolean
  log: LogSink
  launchArgs?: readonly string[]
}

export interface RequestOptions {
  signal?: AbortSignal
}

export interface ControllerStatus extends JsonRecord {
  state: ControllerState
  exePath: string
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
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
export const packageRoot = dirname(moduleDirectory)

export function bundledControllerPath(): string {
  return join(packageRoot, 'controller', 'bin', 'PlcsimAdvanced.Controller.exe')
}

export function resolveControllerPath(configured: string): { path: string; source: string } {
  if (configured.trim().length > 0) {
    return { path: isAbsolute(configured) ? configured : resolve(configured), source: 'config' }
  }
  const fromEnvironment = process.env['PLCSIM_ADVANCED_CONTROLLER']
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim().length > 0) {
    return { path: isAbsolute(fromEnvironment) ? fromEnvironment : resolve(fromEnvironment), source: 'environment' }
  }
  return { path: bundledControllerPath(), source: 'package' }
}

export function defaultApiDir(): string {
  const base = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  return join(base, 'Common Files', 'Siemens', 'PLCSIMADV', 'API', '4.0')
}

export function defaultStorageRoot(): string {
  return join(tmpdir(), 'dsh-plcsim')
}

export function asciiStringify(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

interface Pending {
  id: string
  operation: string
  timer: NodeJS.Timeout
  resolve: (frame: ResultFrame) => void
  reject: (error: Error) => void
}

interface Queued {
  operation: string
  params: JsonRecord
  resolve: (frame: ResultFrame) => void
  reject: (error: Error) => void
  signal?: AbortSignal
}

const TAIL_LIMIT = 40

export class ControllerProcess {
  readonly #options: ControllerOptions
  #child: ChildProcessWithoutNullStreams | null = null
  #state: ControllerState = 'stopped'
  #ready: ReadyFrame | null = null
  #starting: Promise<ReadyFrame> | null = null
  #startedAt: string | null = null
  #pending = new Map<string, Pending>()
  #queue: Queued[] = []
  #inflight: Queued | null = null
  #requestsServed = 0
  #restarts = 0
  #lastError: { code: string; message: string } | null = null
  #stderrTail: string[] = []
  #disposed = false

  constructor(options: ControllerOptions) {
    this.#options = options
  }

  status(): ControllerStatus {
    return {
      state: this.#state,
      exePath: this.#options.exePath,
      exeExists: existsSync(this.#options.exePath),
      pid: this.#child?.pid ?? null,
      startedAt: this.#startedAt,
      requestsServed: this.#requestsServed,
      restarts: this.#restarts,
      queueDepth: this.#queue.length,
      inflightOperation: this.#inflight?.operation ?? null,
      lastError: this.#lastError,
      ready: this.#ready,
      stderrTail: this.#stderrTail,
    }
  }

  async request(operation: string, params: JsonRecord, options: RequestOptions = {}): Promise<ResultFrame> {
    if (this.#disposed) {
      throw new ControllerFailure('controller_disposed', 'The PLCSIM controller has been disposed.')
    }
    if (this.#queue.length >= this.#options.maxQueue) {
      throw new ControllerFailure(
        'controller_queue_full',
        `The controller queue already holds ${this.#queue.length} request(s); try again after the current one settles.`,
      )
    }
    if (options.signal?.aborted === true) {
      throw new ControllerFailure('cancelled', 'The request was cancelled before it reached the controller.')
    }
    return await new Promise<ResultFrame>((resolve, reject) => {
      this.#queue.push({ operation, params, resolve, reject, signal: options.signal })
      void this.#pump()
    })
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#failAll(new ControllerFailure('controller_disposed', 'The PLCSIM controller was disposed.'))
    const child = this.#child
    this.#child = null
    this.#state = 'stopped'
    this.#ready = null
    if (child === null) return
    try {
      child.stdin.end()
    } catch {
      // already gone
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // already gone
        }
        resolve()
      }, this.#options.shutdownGraceMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async #pump(): Promise<void> {
    if (this.#inflight !== null || this.#queue.length === 0 || this.#disposed) return
    const job = this.#queue.shift() as Queued
    if (job.signal?.aborted === true) {
      job.reject(new ControllerFailure('cancelled', 'The request was cancelled before it started.'))
      void this.#pump()
      return
    }
    this.#inflight = job
    try {
      await this.#ensureStarted()
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.#lastError = { code: 'controller_timeout', message: `${job.operation} timed out after ${this.#options.requestTimeoutMs} ms` }
        this.#failAll(new ControllerFailure('controller_timeout', `${job.operation} timed out; the controller was terminated.`))
        this.#kill()
        void this.#pump()
      }, this.#options.requestTimeoutMs)
      const pending: Pending = {
        id,
        operation: job.operation,
        timer,
        resolve: (frame) => job.resolve(frame),
        reject: (error) => job.reject(error),
      }
      this.#pending.set(id, pending)
      const child = this.#child
      if (child === null) throw new ControllerFailure('controller_not_running', 'The controller process is not running.')
      child.stdin.write(asciiStringify({ type: 'operation', id, operation: job.operation, params: job.params }) + '\n')
      this.#state = 'busy'
    } catch (error) {
      this.#inflight = null
      job.reject(error instanceof Error ? error : new Error(String(error)))
      void this.#pump()
    }
  }

  async #ensureStarted(): Promise<ReadyFrame> {
    if (this.#child !== null && this.#state !== 'stopped' && this.#ready !== null) return this.#ready
    if (this.#starting !== null) return await this.#starting
    const args = this.#options.launchArgs ?? [
      '--api-dir',
      this.#options.apiDir,
      '--storage-root',
      this.#options.storageRoot,
      '--network-mode',
      this.#options.networkMode,
      '--show-control-panel',
      String(this.#options.showControlPanel),
      '--control-panel',
      this.#options.controlPanelPath,
      '--keep-on-exit',
      String(this.#options.keepInstancesOnUnload),
    ]
    this.#starting = new Promise<ReadyFrame>((resolve, reject) => {
      const child = spawn(this.#options.exePath, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      this.#child = child
      this.#state = 'starting'
      this.#startedAt = new Date().toISOString()
      const timer = setTimeout(() => {
        this.#lastError = { code: 'controller_startup_timeout', message: `The controller did not report ready within ${this.#options.startupTimeoutMs} ms` }
        this.#starting = null
        this.#kill()
        reject(new ControllerFailure('controller_startup_timeout', 'The controller did not report ready in time.'))
      }, this.#options.startupTimeoutMs)

      createInterface({ input: child.stdout }).on('line', (line) => {
        this.#handleLine(line, (ready) => {
          clearTimeout(timer)
          this.#ready = ready
          this.#state = 'ready'
          this.#starting = null
          resolve(ready)
        })
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim()
        if (text.length === 0) return
        this.#stderrTail.push(text)
        if (this.#stderrTail.length > TAIL_LIMIT) this.#stderrTail.shift()
        if (this.#options.logControllerOutput) this.#options.log.warn(`[plcsim controller] ${text}`)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        this.#lastError = { code: 'controller_spawn_failed', message: error.message }
        this.#starting = null
        this.#state = 'failed'
        reject(new ControllerFailure('controller_spawn_failed', error.message))
      })
      child.once('exit', (code) => {
        this.#child = null
        this.#ready = null
        this.#state = 'stopped'
        this.#starting = null
        const message = `The PLCSIM controller exited (code ${code ?? 'null'}).`
        this.#failAll(new ControllerFailure('controller_exited', message))
      })
    })
    return await this.#starting
  }

  #handleLine(line: string, onReady: (ready: ReadyFrame) => void): void {
    let frame: JsonRecord
    try {
      frame = parseFrame(line)
    } catch {
      return
    }
    if (isReadyFrame(frame)) {
      onReady(frame)
      return
    }
    if (!isResultFrame(frame)) return
    const pending = frame.id === null ? undefined : this.#pending.get(frame.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.#pending.delete(pending.id)
    this.#requestsServed++
    this.#inflight = null
    if (frame.ok) {
      this.#state = 'ready'
    } else {
      this.#lastError = { code: frame.error?.code ?? 'controller_error', message: frame.error?.message ?? 'unknown error' }
      this.#state = 'ready'
    }
    pending.resolve(frame)
    void this.#pump()
  }

  #kill(): void {
    const child = this.#child
    this.#child = null
    this.#ready = null
    this.#state = 'stopped'
    this.#starting = null
    this.#restarts++
    if (child !== null) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  }

  #failAll(error: Error): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    const queued = this.#queue
    this.#queue = []
    this.#inflight = null
    for (const entry of queued) entry.reject(error)
  }
}

/** Re-exported so tests can assert the wire version without importing protocol twice. */
export const WIRE_PROTOCOL_VERSION = PROTOCOL_VERSION
