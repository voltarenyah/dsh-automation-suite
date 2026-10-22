/**
 * dsh-engineering-context — engineering project context for DeepSeek Harness
 * (engineering-context plugin).
 *
 * What this build implements:
 *
 *   workspace layout      the session working directory IS the engineering scope
 *                         (`exec.agent.session.header.cwd`); the host's workspace
 *                         registry is read, never modified, for the display identity
 *   create                `create_engineering_project` — save the project TIA has open
 *                         into `<workspace>/<tia dir>/<project>/` and rebuild its
 *                         source tree into `<workspace>/<source dir>/<device>/`
 *   status                `project_status` — read the evidence ledger, manifest, git
 *                         status and lock; never writes
 *   sync                  `project_sync` — TIA → STAGE → SOURCE → one path-limited git
 *                         commit, with a plan (dry run) as the default
 *
 * What it deliberately does not do: talk to TIA Portal (the interface plugin's
 * `engineeringAccess` service owns that, docs/decisions.md D12), invent a version
 * number (the evidence ledger + checksum + git commit are the version), or keep a
 * registry of projects — the directory layout **is** the record (docs/decisions.md
 * D22, D26). The change ledger (P3) is still unimplemented.
 *
 * The plugin holds no owned resource, so `apply` registers the tools and returns:
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
 * Register the engineering-context tool.
 *
 * @param ctx - the plugin context; `ctx.tools` receives the definition,
 *   `ctx.get('workspaceRegistry')` is the optional host service and
 *   `ctx.get('engineeringAccess')` is the optional TIA seam.
 * @param config - the validated profile config, or undefined when the profile
 *   inserts the bundle without a config block.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  const registered = registerTools(ctx, dependencies)
  log.info(
    `Registered ${registered.length} engineering-context tool${registered.length === 1 ? '' : 's'} (${registered.join(', ')}); ` +
      `projects are saved into <workspace>/${settings.tiaDirName}/, their source trees into <workspace>/${settings.sourceDirName}/, ` +
      `and local sync state into <workspace>/${settings.stateDirName}/local/`,
  )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
