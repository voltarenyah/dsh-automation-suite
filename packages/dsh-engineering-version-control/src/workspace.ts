/**
 * Workspace resolution: which directory this call is scoped to, and whether the
 * host knows it as a workspace.
 *
 * The root is the **session working directory** (`exec.agent.session.header.cwd`)
 * — that is the one fact that ties a conversation to an engineering project, and
 * it is what the host's own workspace registry validates session membership
 * against. The registry is consulted only for the display identity, and only
 * through non-mutating members: this plugin never creates, reorders, deletes,
 * attaches or archives anything in it (docs/decisions.md D1/D2).
 *
 * @module dsh-engineering-context/workspace
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { EngineeringContextError } from './errors.js'
import { canonicalize } from './paths.js'

/** The workspace a tool call runs in, and how that was established. */
export interface WorkspaceRoot {
  /** Canonical absolute path of the workspace root. */
  path: string
  /** True when the host's workspace registry owns this path. */
  registered: boolean
  /** The registry's display title, when it owns the path. */
  title: string | null
}

/**
 * The host service this plugin reads for workspace identity.
 *
 * Duck-typed on purpose rather than imported from `@deepseek-ai/dsh-workspace`:
 * that package is not a dependency of this one (docs/decisions.md D10), so the
 * shape is declared here and the service is discovered by name. Only the
 * non-mutating members are declared.
 */
export interface WorkspaceRegistryLike {
  /** @returns the workspace owning this canonical path, or undefined. */
  resolveByPath(path: string): Promise<{ path: string; title: string } | undefined>
}

/** The service name `@deepseek-ai/dsh-workspace` registers itself under. */
export const WORKSPACE_REGISTRY_SERVICE = 'workspaceRegistry'

/**
 * The host's workspace registry, or `undefined` when this composition has none.
 *
 * A composition without `@deepseek-ai/dsh-workspace` is legitimate (the plugin
 * is independently useful), so an absent or unexpected service is reported as
 * absent rather than as an error.
 *
 * @param ctx - the plugin context.
 * @returns the registry, when it is present and looks usable.
 */
export function workspaceRegistry(ctx: Context): WorkspaceRegistryLike | undefined {
  const service = ctx.get(WORKSPACE_REGISTRY_SERVICE)
  if (service === null || typeof service !== 'object') return undefined
  const resolve = (service as { resolveByPath?: unknown }).resolveByPath
  if (typeof resolve !== 'function') return undefined
  return service as WorkspaceRegistryLike
}

/**
 * The session working directory, which is this plugin's scope root.
 *
 * @param exec - the per-call execution context.
 * @returns the recorded cwd, or undefined when the harness supplied none.
 */
export function sessionCwd(exec: ToolRunContext): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
}

/**
 * Resolve the workspace root for one call.
 *
 * A cwd the registry does not own is still used, with `registered: false`.
 * Refusing to work would make the plugin useless in exactly the situation it is
 * meant to help with — before a workspace has been registered — while the flag
 * keeps the result honest about the identity it could not confirm
 * (docs/decisions.md N2).
 *
 * @param ctx - the plugin context.
 * @param exec - the per-call execution context.
 * @returns the canonical root and its registry identity.
 * @throws {EngineeringContextError} `scope_unavailable` when there is no
 *   resolvable working directory.
 */
export async function resolveWorkspaceRoot(ctx: Context, exec: ToolRunContext): Promise<WorkspaceRoot> {
  const cwd = sessionCwd(exec)
  if (cwd === undefined) {
    throw new EngineeringContextError(
      'scope_unavailable',
      'The harness supplied no session working directory, so the engineering scope cannot be established. Use a session that has a working directory.',
    )
  }

  let path: string
  try {
    path = await canonicalize(cwd)
  } catch (error) {
    throw new EngineeringContextError(
      'scope_unavailable',
      `The session working directory does not resolve: ${cwd}`,
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }

  const registry = workspaceRegistry(ctx)
  if (registry === undefined) return { path, registered: false, title: null }

  const workspace = await registry.resolveByPath(path)
  if (workspace === undefined) return { path, registered: false, title: null }
  return { path, registered: true, title: workspace.title }
}
