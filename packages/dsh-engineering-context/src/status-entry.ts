/**
 * The `engineering-context-status` entry point: the read-only engineering-context
 * surface of the **leader**.
 *
 * Why a separate entry: the main entry registers the version workflow (create /
 * status / sync / commit) plus the two read-only helpers below, and is mounted
 * whole into the **auditor**, which owns the slow version work. The leader still
 * needs to know the workspace state to decide whether a version task is due at
 * all — "is a project open, is the PLC compiled, does the source tree drift, is a
 * commit pending" — and that question costs one cached checksum read, not a scan.
 * Mounting the whole workflow into the leader would hand it the very operations
 * it is supposed to delegate (docs/decisions.md D30).
 *
 * The two helpers are here for the same reason they are read-only:
 *
 *   - `workspace_describe` answers "what does this workspace hold" without TIA,
 *     which is how the leader looks at a reference workspace;
 *   - `import_preflight` says what TIA will refuse **before** the leader (which
 *     owns `import_blocks`) opens the import transaction.
 *
 * None of the three writes anything. The profile mounts this entry as
 * `@voltarenyah/dsh-engineering-context/status`.
 *
 * @module dsh-engineering-context/status-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import type { ToolDependencies } from './tools/deps.js'
import { WORKSPACE_DESCRIBE_TOOL, workspaceDescribeTool } from './tools/describe.js'
import { IMPORT_PREFLIGHT_TOOL, importPreflightTool } from './tools/preflight.js'
import { PROJECT_STATUS_TOOL, statusTool } from './tools/status.js'

/** Plugin identity; this is a different entry id from the main plugin. */
export const name = 'engineering-context-status'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

export { Config }

/**
 * Register the three read-only tools and nothing else.
 *
 * @param ctx - the plugin context; `ctx.tools` receives the definitions and
 *   `ctx.get('engineeringAccess')` is looked up per call.
 * @param config - the validated profile config, or undefined when the profile
 *   mounts the entry without a config block.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  ctx.tools.register(statusTool(dependencies))
  ctx.tools.register(workspaceDescribeTool(dependencies))
  ctx.tools.register(importPreflightTool(dependencies))
  log.info(
    `Registered 3 read-only engineering-context tools (${PROJECT_STATUS_TOOL}, ${WORKSPACE_DESCRIBE_TOOL}, ` +
      `${IMPORT_PREFLIGHT_TOOL}); the version workflow stays on the auditor.`,
  )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
