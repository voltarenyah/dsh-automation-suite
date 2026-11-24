/**
 * The `version-control-record` entry point: the tools that **write** history.
 *
 * Mounted for the Auditor only (root `docs/version-control-plan.md` §6): the
 * Leader decides whether a version task is due, the Auditor runs it. The split
 * from `read` is deliberate — the tool surface **is** the permission boundary
 * (D23/D29), so "read the history" is a separate mount from "record a version".
 *
 * @module dsh-engineering-version-control/record-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { commitTool } from './tools/commit.js'
import type { ToolDependencies } from './tools/deps.js'
import { annotateTool, docIndexTool, reindexTool } from './tools/version.js'

/** Plugin identity; this is a different entry id from the other rows. */
export const name = 'version-control-record'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

export { Config }

/**
 * Register the recording tools.
 *
 * @param ctx - the plugin context.
 * @param config - the validated profile config, or undefined.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  const tools = [commitTool(dependencies), reindexTool(dependencies), annotateTool(dependencies), docIndexTool(dependencies)]
  for (const definition of tools) ctx.tools.register(definition)
  log.info(
    `Registered ${tools.length} version-control recording tool(s) (${tools
      .map((tool) => tool.name)
      .join(', ')}); they write git commits and the version store under <workspace>/${settings.stateDirName}/.`,
  )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
