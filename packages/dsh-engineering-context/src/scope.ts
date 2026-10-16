/**
 * Scope resolution: which workspace directory this call is scoped to, and what
 * exists there.
 *
 * The root is the **session working directory** (`exec.agent.session.header.cwd`)
 * — that is the one fact that ties a conversation to an engineering project, and
 * it is what the host's own workspace registry validates session membership
 * against. The registry is consulted only for the display identity, and only
 * through non-mutating members: this plugin never creates, reorders, deletes,
 * attaches or archives anything in it (docs/decisions.md D1/D2).
 *
 * The plugin never guesses a scope it cannot establish: a missing cwd produces an
 * explicit failure instead of a default.
 *
 * @module dsh-engineering-context/scope
 */

import { stat } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { PluginConfig } from './config.js'
import { EngineeringContextError } from './errors.js'
import { isInside, toPortable } from './paths.js'
import { resolveWorkspaceRoot, type WorkspaceRoot } from './workspace.js'

/** What exists at one path. */
export interface PathStatus {
  /** Portable spelling (relative to the workspace root, forward slashes). */
  port: string
  /** Absolute spelling, for the plugin's own use and for host-side debugging. */
  absolute: string
  /** `file`, `directory` or `missing`. */
  kind: 'file' | 'directory' | 'missing'
}

/** The scope a result belongs to: where it ran, and what could not be confirmed. */
export interface ScopeView {
  workspace: { path: string; registered: boolean; title: string | null }
  /** Everything about this scope the model should not have to guess. */
  warnings: string[]
}

/** A fully resolved scope, with the pieces the tool needs. */
export interface ResolvedScope {
  workspace: WorkspaceRoot
  config: PluginConfig
  view: ScopeView
}

/**
 * What exists at one path, described relative to the workspace root.
 *
 * @param root - the canonical workspace root.
 * @param absolute - the absolute path to inspect.
 * @returns the portable spelling, the absolute spelling and the kind present.
 */
export async function describePath(root: string, absolute: string): Promise<PathStatus> {
  let kind: PathStatus['kind'] = 'missing'
  try {
    const stats = await stat(absolute)
    kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'missing'
  } catch {
    kind = 'missing'
  }
  return { port: toPortable(root, absolute), absolute, kind }
}

/**
 * Resolve everything one tool call needs to know about its scope.
 *
 * @param ctx - the plugin context.
 * @param exec - the per-call execution context.
 * @param config - the resolved configuration.
 * @returns the resolved scope.
 * @throws {EngineeringContextError} `scope_unavailable` when there is no usable
 *   working directory.
 */
export async function resolveScope(
  ctx: Context,
  exec: ToolRunContext,
  config: PluginConfig,
): Promise<ResolvedScope> {
  const workspace = await resolveWorkspaceRoot(ctx, exec)

  const warnings: string[] = []
  if (!workspace.registered) {
    warnings.push(
      `The working directory is not registered as a workspace in this host, so the scope identifies it by path only: ${workspace.path}`,
    )
  }

  return {
    workspace,
    config,
    view: {
      workspace: { path: workspace.path, registered: workspace.registered, title: workspace.title },
      warnings,
    },
  }
}

/**
 * Fail closed when a write target is not inside the workspace.
 *
 * `config.requireWorkspace` exists only for a test harness; on every real
 * configuration this refuses.
 *
 * @param config - the resolved configuration.
 * @param root - the canonical workspace root.
 * @param target - the canonical target path.
 * @param what - what the path is, for the message.
 * @throws {EngineeringContextError} `path_outside_workspace`.
 */
export function assertInsideWith(config: PluginConfig, root: string, target: string, what: string): void {
  if (!config.requireWorkspace) return
  if (isInside(root, target)) return
  throw new EngineeringContextError(
    'path_outside_workspace',
    `${what} must stay inside the workspace root ${root}, but it resolves to ${target}.`,
    { workspace: root, target },
  )
}
