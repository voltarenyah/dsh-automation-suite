/**
 * Plugin configuration.
 *
 * Every field has a default, so a profile may insert this bundle without any
 * `config` block at all. The schema is the single source of truth for the
 * user-facing names and defaults; {@link resolveConfig} re-applies the same
 * defaults and the same validation, so the plugin behaves identically when it is
 * loaded without the loader's schema resolution (for example by a test harness).
 *
 * The two directory names decide **where this plugin writes inside the user's
 * workspace**, which is why `resolveConfig` validates them instead of trusting
 * them: a value containing a separator or `..` would move every write.
 *
 * @module dsh-engineering-context/config
 */

import Schema from '@deepseek-ai/schemastery'

/** The plugin configuration, as the profile sees it. */
export interface PluginConfig {
  /** Directory holding engineering project content, relative to the workspace root. */
  projectsDirName: string
  /** Directory holding this plugin's own state, relative to the workspace root. */
  stateDirName: string
  /**
   * When true (the default) any path outside the workspace root is refused.
   * Only a test harness has a reason to set it to false.
   */
  requireWorkspace: boolean
}

/** Default values, applied both by the schema and by {@link resolveConfig}. */
export const configDefaults: PluginConfig = {
  projectsDirName: 'projects',
  stateDirName: '_dsh-eng',
  requireWorkspace: true,
}

/** Schemastery configuration schema for the plugin consumer. */
export const Config = Schema.object({
  projectsDirName: Schema.string().default(configDefaults.projectsDirName),
  stateDirName: Schema.string().default(configDefaults.stateDirName),
  requireWorkspace: Schema.boolean().default(configDefaults.requireWorkspace),
})

/**
 * Device names Windows reserves in every directory, with or without an
 * extension: `nul\projects.json` is not a file one can create.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu

/**
 * A directory name must be exactly one path segment.
 *
 * Anything else (a separator, a drive letter, `..`, a Windows-reserved
 * character or device name, an empty string) falls back to the default:
 * silently reinterpreting it would put this plugin's writes somewhere the user
 * did not choose, and rejecting the whole config would make the plugin
 * unloadable over a typo.
 *
 * @param value - whatever the caller supplied.
 * @param fallback - the default to use when the value is unusable.
 * @returns a single safe path segment.
 */
function segment(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0) return fallback
  if (trimmed === '.' || trimmed === '..') return fallback
  if (/[\\/]/u.test(trimmed)) return fallback
  if (/[:*?"<>|]/u.test(trimmed)) return fallback
  // Windows silently strips a trailing dot or space, which would make the
  // configured name and the directory on disk disagree.
  if (trimmed.endsWith('.')) return fallback
  const base = trimmed.split('.')[0] ?? trimmed
  if (WINDOWS_RESERVED.test(base)) return fallback
  return trimmed
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
  const source = config ?? {}
  return {
    projectsDirName: segment(source.projectsDirName, configDefaults.projectsDirName),
    stateDirName: segment(source.stateDirName, configDefaults.stateDirName),
    requireWorkspace:
      typeof source.requireWorkspace === 'boolean' ? source.requireWorkspace : configDefaults.requireWorkspace,
  }
}

/**
 * Where one project's content lives, relative to the workspace root.
 * @param config - the resolved configuration.
 * @param projectId - the project id.
 */
export function projectContentDir(config: PluginConfig, projectId: string): string {
  return `${config.projectsDirName}/${projectId}`
}

/**
 * Where one project's plugin state lives, relative to the workspace root:
 * fingerprint baseline, change-sets and the change ledger all sit under it
 * (docs/decisions.md N3).
 * @param config - the resolved configuration.
 * @param projectId - the project id.
 */
export function projectStateDir(config: PluginConfig, projectId: string): string {
  return `${config.stateDirName}/${projectId}`
}

/**
 * The engineering registry file, relative to the workspace root.
 * @param config - the resolved configuration.
 */
export function registryRelativePath(config: PluginConfig): string {
  return `${config.stateDirName}/projects.json`
}
