/**
 * Plugin configuration.
 *
 * Every field has a default, so a profile may insert this bundle without any
 * `config` block at all. The schema is the single source of truth for the
 * user-facing names and defaults; {@link resolveConfig} re-applies the same
 * defaults and the same range checks, so the plugin behaves identically when it
 * is loaded without the loader's schema resolution (for example by a test
 * harness).
 *
 * The conventions are the TIA Openness plugin's (`dsh-tia-openness-v17-min/src/config.ts`),
 * because this plugin will own a subprocess for the C# engine the same way that
 * one owns the TIA controller: timeouts are non-negative natural numbers with a
 * floor rather than a rejection, an empty path means "the copy shipped with this
 * package", and a boolean is only trusted when it really is a boolean.
 *
 * @module dsh-engineering-graph/config
 */

import Schema from '@deepseek-ai/schemastery'

/** The plugin configuration, as the profile sees it. */
export interface PluginConfig {
  /**
   * Path of the engineering-graph engine executable. Empty means the copy
   * shipped with this package (`engine/bin/EngineeringGraph.Engine.exe`,
   * docs/decisions.md D17); a relative path is resolved against the process
   * working directory.
   */
  enginePath: string
  /** Deadline for one engine operation, in milliseconds. */
  requestTimeoutMs: number
  /** Deadline for the engine's ready handshake, in milliseconds. */
  startupTimeoutMs: number
  /** Forward the engine's own stdout/stderr notes to the plugin logger. */
  logEngineOutput: boolean
}

/** Default values, applied both by the schema and by {@link resolveConfig}. */
export const configDefaults: PluginConfig = {
  enginePath: '',
  requestTimeoutMs: 300_000,
  startupTimeoutMs: 30_000,
  logEngineOutput: false,
}

/** Schemastery configuration schema for the plugin consumer. */
export const Config = Schema.object({
  enginePath: Schema.string().default(configDefaults.enginePath),
  requestTimeoutMs: Schema.natural().default(configDefaults.requestTimeoutMs),
  startupTimeoutMs: Schema.natural().default(configDefaults.startupTimeoutMs),
  logEngineOutput: Schema.boolean().default(configDefaults.logEngineOutput),
})

/**
 * A number clamped up to `minimum` instead of rejected.
 *
 * Rejecting the whole config would make the plugin unloadable over a typo, and
 * silently accepting zero would turn a timeout into "no deadline": clamping is
 * the one behaviour that is both safe and forgiving. Non-numbers, `NaN` and
 * infinities fall back to the default.
 *
 * @param value - whatever the caller supplied.
 * @param fallback - the default to use when the value is not usable.
 * @param minimum - the smallest accepted value.
 */
function positive(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value < minimum ? minimum : Math.floor(value)
}

/**
 * A non-empty string, trimmed.
 *
 * `enginePath` deliberately accepts an empty result: the empty string is the
 * documented "resolve the packaged engine" value, so a whitespace-only setting
 * must fall back to it rather than to something else.
 *
 * @param value - whatever the caller supplied.
 * @param fallback - the default when the value is unusable.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * A boolean, or the default when the value is anything else.
 *
 * @param value - whatever the caller supplied.
 * @param fallback - the default when the value is not a boolean.
 */
function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalizes whatever the loader (or a test) handed to `apply` into a complete,
 * range-checked configuration.
 *
 * @param config - the raw config, or undefined when the profile inserts the
 *   bundle without a config block.
 * @returns a complete configuration.
 */
export function resolveConfig(config?: Partial<PluginConfig>): PluginConfig {
  const source: Partial<PluginConfig> = config ?? {}
  return {
    enginePath: text(source.enginePath, configDefaults.enginePath),
    requestTimeoutMs: positive(source.requestTimeoutMs, configDefaults.requestTimeoutMs, 1_000),
    startupTimeoutMs: positive(source.startupTimeoutMs, configDefaults.startupTimeoutMs, 1_000),
    logEngineOutput: flag(source.logEngineOutput, configDefaults.logEngineOutput),
  }
}
