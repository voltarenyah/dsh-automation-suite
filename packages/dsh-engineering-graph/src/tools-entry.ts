/**
 * The `/tools` row: the model-facing tools as a Loader entry of their own.
 *
 * DSH resolves tool visibility per **declaration scope**. Registering the tools
 * in the same row that owns the engine would put them in the host (global)
 * plane, so every agent — delegated subagents included — would inherit all of
 * them. The tools therefore live behind this second entry, reachable as the
 * package's `./tools` subpath export, and each agent preset decides whether to
 * declare it and with which config:
 *
 *   - `leader` (main agent): declares the row with the default config and keeps
 *     every tool, including the two database writers (`knowledge_ingest` and
 *     `knowledge_update`);
 *   - `expert` (subagent): declares the same row with `includeIngest: false`, so
 *     it sees `knowledge_schema` and `knowledge_query` but neither writer — a
 *     graph rebuild and an incremental graph update are both heavy writes that
 *     belong to the main agent's project workflow, not to a read-only
 *     investigation. The `auditor` preset does not mount this row at all.
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

import { registerTools, normalizeDrilldown, type DrilldownSurface } from './tools.js'
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
   * Whether the two database writers are registered: `knowledge_ingest` (a full
   * rebuild) and `knowledge_update` (the incremental refresh). `true` (the default)
   * gives the full surface; `false` keeps `knowledge_workspace`,
   * `knowledge_schema` and `knowledge_query` only.
   */
  includeIngest: boolean
  /**
   * How much of the drill-down surface is registered: `none` (the default),
   * `inspect` (`knowledge_block` + `knowledge_network`, enough for a main agent
   * to brief a delegation) or `all` (also `knowledge_search` and
   * `knowledge_variable_usage`, the expert's investigation tools). The old
   * booleans still work: `true` = `all`, `false` = `none`
   * (docs/decisions.md D25).
   */
  includeDrilldown: DrilldownSurface
}

/** Default values, applied both by the schema and by {@link resolveToolsEntryConfig}. */
export const toolsEntryConfigDefaults: ToolsEntryConfig = {
  includeIngest: true,
  includeDrilldown: 'none',
}

/** Schemastery configuration schema for this row. */
export const Config = Schema.object({
  includeIngest: Schema.boolean().default(toolsEntryConfigDefaults.includeIngest),
  includeDrilldown: Schema.string().default(toolsEntryConfigDefaults.includeDrilldown),
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
    includeDrilldown: normalizeDrilldown(source.includeDrilldown as DrilldownSurface | boolean | undefined),
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

  // A value the schema accepted but the registry could not use (a typo'd surface
  // name) would otherwise change an agent's tools without a trace anywhere.
  const raw: unknown = config?.includeDrilldown
  if (raw !== undefined && raw !== settings.includeDrilldown && raw !== true && raw !== false) {
    log.warn(
      `includeDrilldown ${JSON.stringify(raw)} is not one of 'none', 'inspect' or 'all'; ` +
        `this row registered '${settings.includeDrilldown}' instead.`,
    )
  }

  log.info(
    `Registered ${registered.length} engineering-graph tools (${registered.join(', ')}); ` +
      `the engine subprocess and the knowledgeGraph service are owned by the host row.` +
      (settings.includeIngest ? '' : ' knowledge_ingest and knowledge_update are disabled by this row\'s includeIngest config.') +
      (settings.includeDrilldown === 'none'
        ? ' The drill-down tools are off: this row left includeDrilldown at its default.'
        : ` Drill-down surface: ${settings.includeDrilldown}.`),
  )
}
