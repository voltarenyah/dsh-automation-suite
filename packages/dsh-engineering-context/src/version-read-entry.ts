/**
 * The `engineering-context-version-read` entry point: the read-only half.
 *
 * The expert gets history answers without the ability to annotate or rebuild
 * anything: the tool surface is the permission boundary (`docs/decisions.md`
 * D23/D29), so "read the history" is a separate mount from "record background".
 *
 * @module dsh-engineering-context/version-read-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import {
  docSearchTool,
  historyTool,
  problemTool,
  queryTool,
  verifyTool,
} from './tools/version.js'
import type { ToolDependencies } from './tools/deps.js'

/** Plugin identity; a different entry id from the writing half. */
export const name = 'engineering-context-version-read'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

export { Config }

/**
 * Register the read-only version-store tools.
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
  log.info(`Registered ${tools.length} read-only version-store tool(s) (${tools.map((tool) => tool.name).join(', ')}).`)
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
