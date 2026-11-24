/**
 * The `version-control-read` entry point: the read-only half.
 *
 * Mounted for the Leader, the Auditor and the Expert (root
 * `docs/version-control-plan.md` §6): answering "which block changed, in which
 * version, why" costs one query and writes nothing, so it is safe for every
 * agent. The Expert gets exactly this and `/diff` — never the recording row.
 *
 * @module dsh-engineering-version-control/read-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import type { ToolDependencies } from './tools/deps.js'
import { docSearchTool, historyTool, problemTool, queryTool, verifyTool } from './tools/version.js'

/** Plugin identity; a different entry id from the writing half. */
export const name = 'version-control-read'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

export { Config }

/**
 * Register the read-only tools.
 *
 * @param ctx - the plugin context.
 * @param config - the validated profile config, or undefined.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  const tools = [
    historyTool(dependencies),
    verifyTool(dependencies),
    docSearchTool(dependencies),
    problemTool(dependencies),
    queryTool(dependencies),
  ]
  for (const definition of tools) ctx.tools.register(definition)
  log.info(`Registered ${tools.length} read-only version-control tool(s) (${tools.map((tool) => tool.name).join(', ')}).`)
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
