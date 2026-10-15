/**
 * dsh-engineering-context — engineering project context for DeepSeek Harness
 * (engineering-context plugin).
 *
 * What this build implements (P0 of `docs/ARCHITECTURE.md` §10):
 *
 *   scope resolution      the session working directory IS the engineering
 *                         scope; the host's workspace registry is read, never
 *                         modified, for the display identity
 *   project registry      `_dsh-eng/projects.json` inside the workspace:
 *                         register / adopt / forget / list engineering projects
 *   three workflow tools  eng_status, eng_project, eng_scope
 *
 * What it deliberately does not do yet: version control (P1), fingerprint change
 * detection (P2 — the TIA Openness plugin's seam), and the change ledger (P3). It never touches
 * TIA Portal, never starts a process, and never parses engineering content.
 *
 * The plugin holds no owned resource, so `apply` registers tools and returns:
 * there is nothing for `ctx.effect` to dispose. A session working directory that
 * cannot be resolved is reported per call as `scope_unavailable` rather than
 * preventing the plugin from loading.
 *
 * @module dsh-engineering-context
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { registerTools, type ToolDependencies } from './tools/index.js'

/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'engineering-context'

/**
 * The plugin registers tools, so the tool registry must exist before `apply`
 * runs. Declaring it here makes the loader wait for it instead of failing.
 */
export const inject = ['tools']

export { Config }

/**
 * Register the engineering-context tools.
 *
 * @param ctx - the plugin context; `ctx.tools` receives the definitions and
 *   `ctx.get('workspaceRegistry')` is the optional host service.
 * @param config - the validated profile config, or undefined when the profile
 *   inserts the bundle without a config block.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  const registered = registerTools(ctx, dependencies)
  log.info(
    `Registered ${registered.length} engineering-context tools (${registered.join(', ')}); ` +
      `project registry: <workspace>/${settings.stateDirName}/projects.json`,
  )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
