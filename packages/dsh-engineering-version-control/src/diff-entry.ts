/**
 * The `version-control-diff` entry point: `project_diff` on its own.
 *
 * Mounted for the Auditor and the Expert, never for the Leader (D30): the Leader
 * decides *whether* a version task is due, the Auditor runs it and reports what a
 * version step changed, and the Expert reads program logic. The permission lives
 * in the mount, not in the tool, so this module registers **exactly one** tool
 * and opens no resource that would need disposing.
 *
 * @module dsh-engineering-version-control/diff-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import type { ToolDependencies } from './tools/deps.js'
import { diffTool, PROJECT_DIFF_TOOL } from './tools/diff.js'

/** Plugin identity; this is a different entry id from the other rows. */
export const name = 'version-control-diff'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

export { Config }

/**
 * Register `project_diff` and nothing else.
 *
 * @param ctx - the plugin context; `ctx.tools` receives the definition and
 *   `ctx.get('gitContext')` is looked up per call.
 * @param config - the validated profile config, or undefined.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  ctx.tools.register(diffTool(dependencies))
  log.info(
    `Registered 1 version-control diff tool (${PROJECT_DIFF_TOOL}); read-only over git revisions, ` +
      'mounted for the Auditor and Expert presets.',
  )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
