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

import {
  defaultWorkspaceStatus,
  pruneDefaultWorkspace,
  type WorkspaceRegistryLike as DefaultRegistryShape,
} from './default-workspace.js'
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
  delete(id: string): Promise<boolean>
}

/**
 * The workspace registry, or `undefined` when this composition has none.
 *
 * @param ctx - host plugin context.
 * @returns the registry, when present and usable.
 */
export function workspaceRegistry(ctx: HostContext): WorkspaceRegistryLike | undefined {
  let service: unknown
  try {
    service = ctx.get('workspaceRegistry')
  } catch {
    return undefined
  }
  if (service === null || typeof service !== 'object') return undefined
  const list = (service as { list?: unknown }).list
  const remove = (service as { delete?: unknown }).delete
  if (typeof list !== 'function' || typeof remove !== 'function') return undefined
  return service as WorkspaceRegistryLike
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
 * @param registry - the workspace registry, when present.
 * @param workspaceId - the id from the browser.
 * @returns the canonical path, or `''`.
 */
export function lookupWorkspacePath(registry: WorkspaceRegistryLike | undefined, workspaceId: string): string {
  if (registry === undefined) return ''
  try {
    const found = registry.list().find((entity) => entity.id === workspaceId)
    return found !== undefined && typeof found.path === 'string' ? found.path : ''
  } catch {
    return ''
  }
}

/**
 * Register the tag file route and the default-workspace endpoint.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx: HostContext): void {
  const home = resolveHome()
  const file = join(home, 'storages', 'project-dashboard', 'tags.json')
  const store = new TagStore(file)
  const service: TagsService = {
    snapshot: () => store.snapshot(),
    mutate: (operation, path, expectedRevision) => store.mutate(operation, path, expectedRevision),
    resolvePath: (workspaceId) => lookupWorkspacePath(workspaceRegistry(ctx), workspaceId),
    defaultWorkspace: () =>
      defaultWorkspaceStatus(home, workspaceRegistry(ctx) as DefaultRegistryShape | undefined),
    pruneDefaultWorkspace: () =>
      pruneDefaultWorkspace(home, workspaceRegistry(ctx) as DefaultRegistryShape | undefined),
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

  ctx.logger?.info?.(
    `${name}: workspace tags at ${file}; routes ${ROUTE_PREFIX}/api/tags and ${ROUTE_PREFIX}/api/default-workspace`,
  )
}
