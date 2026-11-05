/**
 * Host half: the tag file and the one route that serves it.
 *
 * The dashboard is otherwise pure client code. This half exists because the
 * browser cannot read or write `<DSH_HOME>/storages/project-dashboard/tags.json`;
 * it owns the file, the atomic write, and a loopback-only tags endpoint (see
 * `route.ts` for the fence). It never touches the workspaces themselves, never
 * runs a background sweep, and never runs a command.
 *
 * `DSH_HOME` resolution: the environment variable the launcher sets, else
 * `~/.dsh` (the host's own default). The official `@deepseek-ai/dsh-home-paths`
 * helper is not imported on purpose: this package carries no runtime dependency
 * links, so the two-line fallback is the honest contract. A composition with a
 * non-default home must export `DSH_HOME` (the launcher does).
 *
 * @module dsh-ui-project-dashboard
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createHandler, ROUTE_PREFIX, type RequestLike, type ResponseLike, type TagsService } from './route.js'
import { TagStore } from './tags/store.js'

/** Cordis plugin name, kept in step with the row id in `cordis.patch.yml`. */
export const name = 'project-dashboard'

/** The host services this half needs. */
export const inject = ['webServer']

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
  get(name: string): unknown
}

/** The workspace registry service, as far as tags need it. */
export interface WorkspaceRegistryLike {
  list(): Array<{ id: string; path: string }>
}

/**
 * Resolve the harness home the launcher is using.
 *
 * @returns the absolute home path.
 */
export function resolveHome(): string {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * The canonical directory for one workspace id, or `''` when the registry is
 * absent or does not know the id. Never throws: a composition without
 * `@deepseek-ai/dsh-workspace` still gets working tags, just without paths.
 *
 * @param ctx - host plugin context.
 * @param workspaceId - the id from the browser.
 * @returns the canonical path, or `''`.
 */
export function lookupWorkspacePath(ctx: HostContext, workspaceId: string): string {
  let registry: unknown
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    return ''
  }
  if (registry === null || typeof registry !== 'object') return ''
  const list = (registry as { list?: unknown }).list
  if (typeof list !== 'function') return ''
  try {
    const found = (list.call(registry) as Array<{ id?: unknown; path?: unknown }>).find(
      (entity) => entity.id === workspaceId,
    )
    return found !== undefined && typeof found.path === 'string' ? found.path : ''
  } catch {
    return ''
  }
}

/**
 * Register the tag file route.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx: HostContext): void {
  const file = join(resolveHome(), 'storages', 'project-dashboard', 'tags.json')
  const store = new TagStore(file)
  const service: TagsService = {
    snapshot: () => store.snapshot(),
    mutate: (operation, path, expectedRevision) => store.mutate(operation, path, expectedRevision),
    resolvePath: (workspaceId) => lookupWorkspacePath(ctx, workspaceId),
  }
  const handler = createHandler(service, ctx.logger)

  const register = () =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler,
    })

  if (typeof ctx.effect === 'function') ctx.effect(register, `${name}: tags route`)
  else register()

  ctx.logger?.info?.(`${name}: workspace tags at ${file} (route ${ROUTE_PREFIX}/api/tags)`)
}
