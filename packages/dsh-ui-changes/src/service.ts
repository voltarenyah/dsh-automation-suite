/**
 * The git-backed status service.
 *
 * It answers one question — "what does `git status` say for this session's
 * working tree, right now?" — by asking the `gitContext` service that
 * `dsh-tool-git` provides. The plugin never imports that package: a missing
 * service is a visible `changes/no-git-service`, not a crash.
 *
 * The repository root always comes from the session header, never from
 * `process.cwd()` and never from the request: the route only carries a session
 * id, and the host resolves the directory (see `index.ts`).
 *
 * Every git invocation runs under one deadline; a non-zero exit that the read
 * cannot tolerate becomes `changes/git-failed`, an aborted run becomes
 * `changes/timeout`. Results are cached per repository for `cacheMs`, because a
 * panel that refetches on every tool result would otherwise spawn four `git`
 * processes per edit.
 *
 * @module dsh-ui-changes/service
 */

import { join } from 'node:path'

import {
  buildFiles,
  countLines,
  normalizePath,
  parseNumstat,
  parsePorcelain,
  totalsOf,
  type PorcelainEntry,
} from './changes.js'
import { StatusError, isAbortError } from './errors.js'
import type { StatusPayload, StatusService } from './types.js'

/** One completed `git` invocation; a non-zero exit is data, not a throw. */
export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/** The bound repository, as much of `gitContext.create()`'s result as we use. */
export interface GitContextLike {
  readonly repoDir: string
  run(args: string[], options?: { signal?: AbortSignal }): Promise<GitRunResult>
}

/** The `gitContext` service surface this plugin consumes. */
export interface GitServiceLike {
  create(root: string): Promise<GitContextLike>
}

/** Per-deployment knobs (host config in P2; defaults today). */
export interface StatusLimits {
  /** One request's git budget, in milliseconds. */
  timeoutMs: number
  /** Files carried by one payload; `totals.files` still reports the full count. */
  maxFiles: number
  /** Untracked files whose line counts are computed; beyond this they show no count. */
  maxUntrackedFiles: number
  /** A file larger than this is not counted (no count beats reading megabytes). */
  maxUntrackedBytes: number
  /** How long one repository's payload may be reused. */
  cacheMs: number
}

/** The defaults; the plan's §4.3 numbers. */
export const DEFAULT_LIMITS: StatusLimits = {
  timeoutMs: 10_000,
  maxFiles: 1_000,
  maxUntrackedFiles: 200,
  maxUntrackedBytes: 1_048_576,
  cacheMs: 750,
}

/** Everything the service needs from its host. */
export interface StatusDeps {
  /** The `gitContext` service, or undefined when `dsh-tool-git` is not loaded. */
  git(): GitServiceLike | undefined
  /** The session's working directory, or null when the session is unknown. */
  sessionCwd(sessionId: string): string | null | undefined
  /** Overrides on top of {@link DEFAULT_LIMITS}. */
  limits?: Partial<StatusLimits>
  /** Clock, injectable for the cache tests. */
  now?(): number
  /**
   * Read one file as UTF-8, or null when it is too large or unreadable.
   *
   * @param path - absolute path.
   * @param maxBytes - the size cap the caller already applied in `limits`.
   */
  readTextFile?(path: string, maxBytes: number): Promise<string | null>
}

/**
 * Build the service the route calls.
 *
 * @param deps - host seams (git, sessions, clock, file reads).
 * @returns the status service.
 */
export function createStatusService(deps: StatusDeps): StatusService {
  const limits: StatusLimits = { ...DEFAULT_LIMITS, ...deps.limits }
  const now = deps.now ?? (() => Date.now())
  let cached: { repo: string; at: number; payload: StatusPayload } | null = null

  return {
    async status(sessionId: string): Promise<StatusPayload> {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id.length === 0) throw new StatusError('changes/session-unknown', 404, 'the request carries no session id')

      const cwd = readCwd(deps, id)
      if (cwd === null) throw new StatusError('changes/session-unknown', 404, `session ${id} has no working directory`)

      const git = deps.git()
      if (git === undefined) throw new StatusError('changes/no-git-service', 503, 'the gitContext service is not loaded')

      const context = await bindRepository(git, cwd, limits.timeoutMs)

      const hit = cached
      if (hit !== null && hit.repo === context.repoDir && now() - hit.at < limits.cacheMs) return hit.payload

      const payload = await collect(context, deps, limits)
      cached = { repo: context.repoDir, at: now(), payload }
      return payload
    },
  }
}

/** @returns the session cwd, or null when absent or unreadable. */
function readCwd(deps: StatusDeps, sessionId: string): string | null {
  try {
    const cwd = deps.sessionCwd(sessionId)
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : null
  } catch {
    return null
  }
}

/**
 * Bind the repository, mapping `gitContext`'s plain throws onto route codes.
 *
 * @param git - the git service.
 * @param cwd - the session working directory.
 * @param timeoutMs - the request budget.
 * @returns the bound context.
 */
async function bindRepository(git: GitServiceLike, cwd: string, timeoutMs: number): Promise<GitContextLike> {
  try {
    return await withDeadline(timeoutMs, async () => git.create(cwd))
  } catch (error) {
    if (error instanceof StatusError) throw error
    if (isAbortError(error)) throw new StatusError('changes/timeout', 504, `git did not answer within ${timeoutMs} ms`)
    const message = describe(error)
    if (/not inside a git repository/i.test(message)) {
      throw new StatusError('changes/not-a-repository', 409, message)
    }
    throw new StatusError('changes/git-failed', 502, message)
  }
}

/**
 * Read one repository and build the payload.
 *
 * @param context - the bound repository.
 * @param deps - host seams (only the file reader is used here).
 * @param limits - the request's limits.
 * @returns the payload.
 */
async function collect(context: GitContextLike, deps: StatusDeps, limits: StatusLimits): Promise<StatusPayload> {
  try {
    return await withDeadline(limits.timeoutMs, async (signal) => {
      const headProbe = await context.run(['rev-parse', '--verify', 'HEAD'], { signal })
      const head = headProbe.code === 0 ? headProbe.stdout.trim() : null

      const symbolic = await context.run(['symbolic-ref', '--short', 'HEAD'], { signal })
      const detached = symbolic.code !== 0
      const branchName = detached ? 'HEAD' : symbolic.stdout.trim()

      const status = await require(context, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)
      const diffArgs =
        head === null
          ? ['diff', '--numstat', '-z', '-M', '--cached']
          : ['diff', '--numstat', '-z', '-M', 'HEAD']
      const diff = await require(context, diffArgs, signal)

      const entries = parsePorcelain(status.stdout)
      const counts = parseNumstat(diff.stdout)
      const untrackedLines = await countUntracked(entries, context.repoDir, deps, limits, signal)

      const all = buildFiles(entries, counts, untrackedLines)
      const kept = all.length > limits.maxFiles ? all.slice(0, limits.maxFiles) : all

      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        repo: context.repoDir,
        branch: branchName.length > 0 ? branchName : 'HEAD',
        detached,
        head,
        files: kept,
        totals: totalsOf(all, kept.length < all.length),
        limits: { maxFiles: limits.maxFiles, timeoutMs: limits.timeoutMs },
      }
    })
  } catch (error) {
    if (error instanceof StatusError) throw error
    if (isAbortError(error)) throw new StatusError('changes/timeout', 504, `git did not answer within ${limits.timeoutMs} ms`)
    throw new StatusError('changes/git-failed', 502, describe(error))
  }
}

/**
 * Run one git command that must succeed.
 *
 * @param context - the bound repository.
 * @param args - argument array.
 * @param signal - the request's cancellation signal.
 * @returns the completed run.
 */
async function require(context: GitContextLike, args: string[], signal: AbortSignal): Promise<GitRunResult> {
  const result = await context.run(args, { signal })
  if (result.code !== 0) {
    throw new StatusError('changes/git-failed', 502, `git ${args[0] ?? ''} failed: ${result.stderr.trim().slice(0, 300)}`)
  }
  return result
}

/**
 * Count the lines of untracked files, within the payload's limits.
 *
 * Untracked files have no `numstat` line; the only honest count is the file's
 * own line count, and reading every file in a fresh repository is exactly the
 * trap the caps exist for.
 *
 * @param entries - parsed status entries.
 * @param repoDir - repository root.
 * @param deps - host seams (the reader).
 * @param limits - caps.
 * @param signal - the request's cancellation signal.
 * @returns line counts keyed by normalised path (absent = not counted).
 */
async function countUntracked(
  entries: PorcelainEntry[],
  repoDir: string,
  deps: StatusDeps,
  limits: StatusLimits,
  signal: AbortSignal,
): Promise<Map<string, number>> {
  const lines = new Map<string, number>()
  if (deps.readTextFile === undefined) return lines
  const untracked = entries.filter((entry) => entry.x === '?' && entry.y === '?')
  if (untracked.length === 0 || untracked.length > limits.maxUntrackedFiles) return lines
  for (const entry of untracked) {
    if (signal.aborted) break
    const text = await deps.readTextFile(join(repoDir, entry.path), limits.maxUntrackedBytes)
    if (text === null) continue
    lines.set(normalizePath(entry.path), countLines(text))
  }
  return lines
}

/**
 * Race a promise against one deadline.
 *
 * @param ms - budget in milliseconds.
 * @param run - the work, given the signal that fires on expiry.
 * @returns the work's result.
 * @throws {@link StatusError} `changes/timeout` on expiry.
 */
async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new StatusError('changes/timeout', 504, `git did not answer within ${ms} ms`))
    }, ms)
  })
  try {
    return await Promise.race([run(controller.signal), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** @returns a readable message for a thrown value. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
