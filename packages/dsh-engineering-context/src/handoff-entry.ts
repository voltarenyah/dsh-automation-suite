/**
 * The `engineering-context-handoff` entry point: handoff export / import / status.
 *
 * Separate from the main version workflow for the same reason `project_diff` is:
 * the leader owns the conversation and delegates the slow version work to the
 * auditor. Seal and import both move TIA and a multi-hundred-megabyte directory,
 * so they belong to the auditor's surface; the read-only `handoff_status` is also
 * mounted into the leader through the `/status` entry.
 *
 * The profile mounts this entry as
 * `@voltarenyah/dsh-engineering-context/handoff`.
 *
 * @module dsh-engineering-context/handoff-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import type { ToolDependencies } from './tools/deps.js'
import { HANDOFF_EXPORT_TOOL, handoffExportTool } from './tools/handoff-export.js'
import { HANDOFF_IMPORT_TOOL, handoffImportTool } from './tools/handoff-import.js'
import { HANDOFF_STATUS_TOOL, handoffStatusTool } from './tools/handoff-status.js'

/** Plugin identity; this is a different entry id from the main plugin. */
export const name = 'engineering-context-handoff'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

export { Config }

/**
 * Register the handoff tools.
 *
 * @param ctx - the plugin context.
 * @param config - the validated profile config, or undefined.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const dependencies: ToolDependencies = { ctx, config: settings, log }

  ctx.tools.register(handoffExportTool(dependencies))
  ctx.tools.register(handoffImportTool(dependencies))
  ctx.tools.register(handoffStatusTool(dependencies))
  log.info(
    `Registered 3 engineering-context handoff tools (${HANDOFF_EXPORT_TOOL}, ${HANDOFF_IMPORT_TOOL}, ` +
      `${HANDOFF_STATUS_TOOL}); they write under handoff/ and never commit.`,
  )
}

/** Exposed for the tests. */
export { resolveConfig }
export type { PluginConfig }
