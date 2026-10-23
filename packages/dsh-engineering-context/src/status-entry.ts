/**
 * The `engineering-context-status` entry point: `project_status` on its own.
 *
 * Why a separate entry: the main entry registers the version workflow (create /
 * status / sync / commit) and is mounted whole into the **auditor**, which owns
 * the slow version work. The leader still needs to know the workspace state to
 * decide whether a version task is due at all — "is a project open, is the PLC
 * compiled, does the source tree drift, is a commit pending" — and that question
 * costs one cached checksum read, not a scan. Mounting the whole workflow into the
 * leader would hand it the very operations it is supposed to delegate
 * (docs/decisions.md D30).
 *
 * So this module registers **exactly one tool** and nothing else; it never
 * registers create, sync or commit, and it opens no resource that would need
 * disposing.
 *
 * The profile mounts it as `@voltarenyah/dsh-engineering-context/status`.
 *
 * @module dsh-engineering-context/status-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import type { ToolDependencies } from './tools/deps.js'
import { PROJECT_STATUS_TOOL, statusTool } from './tools/status.js'

/** Plugin identity; this is a different entry id from the main plugin. */
export const name = 'engineering-context-status'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

export { Config }

/**
 * Register `project_status` and nothing else.
 *
 * @param ctx - the plugin context; `ctx.tools` receives the definition and
 *   `ctx.get('engineeringAccess')` is looked up per call.
 * @param config - the validated profile config, or undefined when the profile
 *   mounts the entry without a config block.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  ctx.tools.register(statusTool(dependencies))
  log.info(
    `Registered 1 engineering-context status tool (${PROJECT_STATUS_TOOL}); read-only preflight, mounted for the Leader only.`,
  )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
