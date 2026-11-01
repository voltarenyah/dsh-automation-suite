/**
 * The `engineering-context-version` entry point: the version store's tools.
 *
 * Mounted wherever history questions are asked (leader, auditor, expert). It is
 * separate from the main entry so a composition can hand out "read the history"
 * without handing out "sync and commit" (`docs/decisions.md` D30).
 *
 * @module dsh-engineering-context/version-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { versionTools } from './tools/version.js'
import type { ToolDependencies } from './tools/deps.js'

/** Plugin identity; this is a different entry id from the main plugin. */
export const name = 'engineering-context-version'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

export { Config }

/**
 * Register the version-store tools.
 *
 * @param ctx - the plugin context.
 * @param config - the validated profile config, or undefined.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  const registered: string[] = []
  for (const definition of versionTools(dependencies)) {
    ctx.tools.register(definition)
    registered.push(definition.name)
  }
  log.info(`Registered ${registered.length} version-store tool(s) (${registered.join(', ')}).`)
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
