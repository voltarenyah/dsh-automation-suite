/**
 * Host half of the plugin.
 *
 * Registers the read-only status route the Changes panel polls
 * (`GET /changes/api/status?session=<id>`) and wires it to two host services:
 *
 *  - `sessions` (from `dsh-session`) maps the session id to its `header.cwd` —
 *    the request never carries a path, so the route cannot be pointed at an
 *    arbitrary directory;
 *  - `gitContext` (from `dsh-tool-git`) binds that cwd to a repository and runs
 *    `status` / `diff --numstat`. The package is **not imported**: a composition
 *    without `dsh-tool-git` answers `changes/no-git-service` instead of failing
 *    to load.
 *
 * The route carries **no authentication** (only `/api` does): see the security
 * posture in `route.ts` before widening what it returns.
 *
 * @module dsh-ui-changes
 */

import { readFile, stat } from 'node:fs/promises'

import { createHandler, ROUTE_PREFIX, STATUS_PATH, type RequestLike, type ResponseLike } from './route.js'
import { createStatusService, type GitServiceLike } from './service.js'

/** Cordis plugin name, kept in step with the row id in `cordis.patch.yml`. */
export const name = 'ui-changes'

/** The host services this half needs. */
export const inject = ['webServer']

/** A file larger than this is not read for its line count. */
const MAX_UNTRACKED_BYTES = 1_048_576

/** The slice of the host context this half touches. */
export interface HostContext {
  logger?: {
    info?(message: string): void
    warn?(message: string): void
  }
  webServer: {
    register(route: {
      kind: 'prefix'
      path: string
      handler: (request: RequestLike, response: ResponseLike) => void | Promise<void>
    }): () => void
  }
  effect?(fn: () => (() => void) | void, label?: string): void
  /** Cordis service lookup (`ctx.get(name)`). */
  get?(name: string): unknown
}

/** The little of a live Session this half reads. */
interface SessionLike {
  header?: { cwd?: unknown }
}

/** The little of the `sessions` service this half reads. */
interface SessionsLike {
  get?(sessionId: string): SessionLike | undefined
}

/**
 * Register the status route.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx: HostContext): void {
  const service = createStatusService({
    git: () => asGitService(ctx.get?.('gitContext')),
    sessionCwd: (sessionId) => sessionCwdOf(ctx, sessionId),
    limits: { maxUntrackedBytes: MAX_UNTRACKED_BYTES },
    readTextFile,
  })
  const handler = createHandler(service, ctx.logger)

  const register = () =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler,
    })

  if (typeof ctx.effect === 'function') ctx.effect(register, `${name}: status route`)
  else register()

  ctx.logger?.info?.(`${name}: ${STATUS_PATH} registered (gitContext + sessions; read-only)`)
}

/**
 * @param value - whatever `ctx.get('gitContext')` returned.
 * @returns the service when it looks usable, else undefined.
 */
function asGitService(value: unknown): GitServiceLike | undefined {
  const candidate = value as GitServiceLike | undefined
  return candidate !== undefined && candidate !== null && typeof candidate.create === 'function' ? candidate : undefined
}

/**
 * Resolve one session's working directory through the session store.
 *
 * @param ctx - host plugin context.
 * @param sessionId - the id from the request.
 * @returns the recorded cwd, or null when the session is unknown or cold.
 */
function sessionCwdOf(ctx: HostContext, sessionId: string): string | null {
  try {
    const sessions = ctx.get?.('sessions') as SessionsLike | undefined
    const session = sessions?.get?.(sessionId)
    const cwd = session?.header?.cwd
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : null
  } catch {
    return null
  }
}

/**
 * Read one file as UTF-8 under a byte cap.
 *
 * @param path - absolute path.
 * @param maxBytes - the cap already applied by the service's limits.
 * @returns the text, or null when the file is too large or unreadable.
 */
async function readTextFile(path: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > maxBytes) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
