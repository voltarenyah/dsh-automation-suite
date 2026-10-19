/**
 * The `/tools` row: the three model-facing tools as a Loader entry of their own.
 *
 * DSH resolves tool visibility per **declaration scope**. Registering the tools
 * in the same row that owns the engine would put them in the host (global)
 * plane, so every agent — delegated subagents included — would inherit all
 * three. The tools therefore live behind this second entry, reachable as the
 * package's `./tools` subpath export, and each agent preset decides whether to
 * declare it and with which config:
 *
 *   - `leader` (main agent): declares the row with the default config and keeps
 *     all three tools;
 *   - `expert` (subagent): declares the same row with `includeIngest: false`, so
 *     it sees `knowledge_schema` and `knowledge_query` but not
 *     `knowledge_ingest` — a full graph rebuild is a heavy write that belongs to
 *     the main agent's project workflow, not to a read-only investigation.
 *
 * This row owns nothing durable. It reads the host row's internal
 * `knowledgeEngine` seam (`runtime-service.ts`), registers `tools.ts`'s tool
 * bodies against it, and logs the names. The engine subprocess, the
 * `knowledgeGraph` service and the configuration all stay on the host row, so a
 * composition still has exactly one engine no matter how many agents declare
 * this row.
 *
 * `inject` is what makes the ordering safe: the loader waits for both the tool
 * registry and the runtime seam before calling `apply`, so this row may be
 * declared before the host row in a composition without racing it.
 *
 * @module dsh-engineering-graph/tools-entry
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

import { registerTools } from './tools.js'
import { knowledgeEngineOf, KNOWLEDGE_ENGINE_SERVICE } from './runtime-service.js'

/**
 * Loader entry id of the tools row.
 *
 * Distinct from the host row's `engineering-graph`, so a profile can declare,
 * disable or move the two rows independently.
 */
export const name = 'engineering-graph-tools'

/**
 * The tool registry is where the tools are registered; `knowledgeEngine` is the
 * host row's seam to the engine. Declaring both makes the loader wait for them
 * instead of failing, whatever the composition order.
 */
export const inject = ['tools', KNOWLEDGE_ENGINE_SERVICE]

/** The tools row's configuration, as the profile sees it. */
export interface ToolsEntryConfig {
  /**
   * Whether `knowledge_ingest` is registered. `true` (the default) gives the
   * full three-tool surface; `false` keeps `knowledge_schema` and
   * `knowledge_query` only.
   */
  includeIngest: boolean
  /**
   * Whether the four drill-down tools are registered (`knowledge_search`,
   * `knowledge_block`, `knowledge_network`, `knowledge_variable_usage`).
   * `false` (the default) keeps the row to the orientation tools; the `expert`
   * preset turns it on, because reading program logic is that agent's job
   * (docs/decisions.md D24 §4).
   */
  includeDrilldown: boolean
}

/** Default values, applied both by the schema and by {@link resolveToolsEntryConfig}. */
export const toolsEntryConfigDefaults: ToolsEntryConfig = {
  includeIngest: true,
  includeDrilldown: false,
}

/** Schemastery configuration schema for this row. */
export const Config = Schema.object({
  includeIngest: Schema.boolean().default(toolsEntryConfigDefaults.includeIngest),
  includeDrilldown: Schema.boolean().default(toolsEntryConfigDefaults.includeDrilldown),
})

/**
 * A boolean, or the default when the value is anything else.
 *
 * The same rule as `config.ts`'s `flag()`, for the same reason: rejecting the
 * whole config would make the row unloadable over a typo, and trusting a
 * truthy-looking string (`"false"`) would silently remove a tool from an agent
 * that was supposed to have it. Only a real boolean counts.
 *
 * @param value - whatever the caller supplied.
 * @param fallback - the default when the value is not a boolean.
 */
function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalizes whatever the loader (or a test) handed to `apply` into a complete
 * configuration. Never throws.
 *
 * @param config - the raw config, or undefined when the preset declares the row
 *   without a config block.
 * @returns a complete configuration.
 */
export function resolveToolsEntryConfig(config?: Partial<ToolsEntryConfig>): ToolsEntryConfig {
  const source: Partial<ToolsEntryConfig> = config ?? {}
  return {
    includeIngest: flag(source.includeIngest, toolsEntryConfigDefaults.includeIngest),
    includeDrilldown: flag(source.includeDrilldown, toolsEntryConfigDefaults.includeDrilldown),
  }
}

/**
 * Registers this plugin's tools against the host row's runtime seam.
 *
 * The tool names, their order, parameters and descriptions are exactly the ones
 * the host row used to register: `tools.ts` is unchanged and remains the single
 * implementation both rows share, so this row only decides *where* they become
 * visible and whether the heavy write tool is among them.
 *
 * @param ctx - the tools row's context; `ctx.tools` receives the definitions.
 * @param config - the preset's config block; `includeIngest` defaults to `true`.
 */
export function apply(ctx: Context, config?: Partial<ToolsEntryConfig>): void {
  const settings = resolveToolsEntryConfig(config)
  const runtime = knowledgeEngineOf(ctx)
  const log = ctx.logger(name)

  const registered = registerTools(
    ctx,
    { request: runtime.request, log },
    { includeIngest: settings.includeIngest, includeDrilldown: settings.includeDrilldown },
  )

  log.info(
    `Registered ${registered.length} engineering-graph tools (${registered.join(', ')}); ` +
      `the engine subprocess and the knowledgeGraph service are owned by the host row.` +
      (settings.includeIngest ? '' : ' knowledge_ingest is disabled by this row\'s includeIngest config.') +
      (settings.includeDrilldown ? '' : ' The drill-down tools are off: this row left includeDrilldown at its default.'),
  )
}
