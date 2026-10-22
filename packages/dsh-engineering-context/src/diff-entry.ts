/**
 * The `engineering-context-diff` entry point: `project_diff` on its own.
 *
 * Why a separate entry: the main entry registers the three workflow tools
 * (create / status / sync) and is mounted whole into the Leader and Auditor
 * presets. The structural diff is a different audience — Leader and Expert read
 * program logic, the Auditor only reports that something changed — so it needs a
 * row the presets can mount independently. This module therefore registers
 * **exactly one tool** and nothing else; it never registers create, status or
 * sync, and it opens no resource that would need disposing.
 *
 * The profile mounts it as `@voltarenyah/dsh-engineering-context/diff`.
 *
 * @module dsh-engineering-context/diff-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import type { ToolDependencies } from './tools/deps.js'
import { diffTool, PROJECT_DIFF_TOOL } from './tools/diff.js'

/** Plugin identity; this is a different entry id from the main plugin. */
export const name = 'engineering-context-diff'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

export { Config }

/**
 * Register `project_diff` and nothing else.
 *
 * @param ctx - the plugin context; `ctx.tools` receives the definition and
 *   `ctx.get('gitContext')` is looked up per call.
 * @param config - the validated profile config, or undefined when the profile
 *   mounts the entry without a config block.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  ctx.tools.register(diffTool(dependencies))
  log.info(
    `Registered 1 engineering-context diff tool (${PROJECT_DIFF_TOOL}); read-only over git revisions, `
      + `mounted for Leader and Expert only.`,
  )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
