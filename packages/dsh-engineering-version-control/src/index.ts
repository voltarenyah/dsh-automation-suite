/**
 * dsh-engineering-version-control — the ③ management layer of the suite.
 *
 * What this package owns: **engineering history**. It records the exported source
 * tree as git commits whose messages carry an evidence trailer block, keeps a
 * queryable index of those commits beside git (`<workspace>/.dsh/versions.db`),
 * and answers "which block changed, in which version, why".
 *
 * What it deliberately does not do (root `docs/version-control-plan.md` §1):
 * it never talks to TIA Portal, never opens a project, never decides the
 * workspace layout, and never parses XML for semantics. Its inputs are files the
 * other plugins already wrote — `source/<device>/` and the creation index.
 *
 * **The host row registers no model tools.** A tool registered here would be
 * inherited by every agent, including subagents; the tools live on the `/record`,
 * `/read` and `/diff` rows so a preset can hand out "read the history" without
 * handing out "record a version" (root AGENTS.md §1, D23). What the host row does
 * provide is the `versionControl` service: the one call `engineering-context`
 * makes when it imports a project and needs a baseline commit.
 *
 * @module dsh-engineering-version-control
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { createVersionControlService, VERSION_CONTROL_SERVICE } from './service.js'

/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'version-control'

export { Config }

/**
 * Provide the `versionControl` service.
 *
 * The service writes history, so it is the **only** write channel another plugin
 * gets: `planBaseline` (a preflight that refuses foreign repositories) and
 * `recordBaseline` (marker → init or reuse → one commit → replay into the store).
 * It does not register model tools; those are on the three `/…` rows.
 *
 * @param ctx - the plugin context.
 * @param config - the validated profile config, or undefined.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)

  ctx.provide(VERSION_CONTROL_SERVICE, createVersionControlService(ctx, settings))

  log.info(
    `Provided the ${VERSION_CONTROL_SERVICE} service: history in <workspace>/${settings.stateDirName}/, ` +
      `source trees read from <workspace>/${settings.sourceDirName}/; no model tools are registered on this row.`,
  )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
