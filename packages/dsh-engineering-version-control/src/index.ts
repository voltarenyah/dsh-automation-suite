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
 * handing out "record a version" (root AGENTS.md §1, D23).
 *
 * @module dsh-engineering-version-control
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'

/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'version-control'

export { Config }

/**
 * Prepare the host row.
 *
 * Nothing is registered yet: the store, the service and the three tool entries
 * arrive in the next step of the split (root `docs/version-control-plan.md` §7).
 * The row exists now so the profile, the doctor and the packaging all have a
 * package to point at while the code moves.
 *
 * @param ctx - the plugin context.
 * @param config - the validated profile config, or undefined.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  ctx
    .logger(name)
    .info(
      `version-control host row ready: history in <workspace>/${settings.stateDirName}/, ` +
        `source trees read from <workspace>/${settings.sourceDirName}/; no model tools are registered on this row.`,
    )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
