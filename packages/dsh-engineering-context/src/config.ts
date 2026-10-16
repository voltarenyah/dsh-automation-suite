/**
 * Plugin configuration.
 *
 * Two directory names decide **where this plugin writes inside the user's
 * workspace** (docs/PATH-RULES.md §2):
 *
 *   <workspace>/<tia dir>/<project>/       the project TIA saved into the workspace
 *   <workspace>/<source dir>/<project>/    the rebuilt source tree of that project
 *
 * Because they decide every write, `resolveConfig` validates them instead of
 * trusting them: a value containing a separator or `..` would move every write.
 * Every field has a default, so a profile may insert this bundle without any
 * `config` block at all, and `resolveConfig` re-applies the same defaults and the
 * same checks the schema does, so the plugin behaves identically when a test
 * harness constructs it.
 *
 * @module dsh-engineering-context/config
 */

import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

/** The plugin configuration, as the profile sees it. */
export interface PluginConfig {
  /** Directory holding the TIA projects saved into this workspace, relative to its root. */
  tiaDirName: string
  /** Directory holding the source trees rebuilt from those projects, relative to the workspace root. */
  sourceDirName: string
  /**
   * When true (the default) any path outside the workspace root is refused.
   * Only a test harness has a reason to set it to false.
   */
  requireWorkspace: boolean
}

/** Default values, applied both by the schema and by {@link resolveConfig}. */
export const configDefaults: PluginConfig = {
  tiaDirName: 'tia',
  sourceDirName: 'source',
  requireWorkspace: true,
}

/** Schemastery configuration schema for the plugin consumer. */
export const Config = Schema.object({
  tiaDirName: Schema.string().default(configDefaults.tiaDirName),
  sourceDirName: Schema.string().default(configDefaults.sourceDirName),
  requireWorkspace: Schema.boolean().default(configDefaults.requireWorkspace),
})

/**
 * Device names Windows reserves in every directory, with or without an
 * extension: `nul\.gitignore` is not a file one can create.
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
    tiaDirName: segment(source.tiaDirName, configDefaults.tiaDirName),
    sourceDirName: segment(source.sourceDirName, configDefaults.sourceDirName),
    requireWorkspace:
      typeof source.requireWorkspace === 'boolean' ? source.requireWorkspace : configDefaults.requireWorkspace,
  }
}

/**
 * Absolute directory the project of one workspace belongs in.
 * @param config - the resolved configuration.
 * @param workspaceRoot - the canonical workspace root.
 * @param folder - the folder name derived from the TIA project name.
 */
export function projectDirectoryPath(config: PluginConfig, workspaceRoot: string, folder: string): string {
  return join(workspaceRoot, config.tiaDirName, folder)
}

/**
 * Absolute directory the rebuilt source tree of one project belongs in.
 * @param config - the resolved configuration.
 * @param workspaceRoot - the canonical workspace root.
 * @param folder - the folder name derived from the TIA project name.
 */
export function sourceDirectoryPath(config: PluginConfig, workspaceRoot: string, folder: string): string {
  return join(workspaceRoot, config.sourceDirName, folder)
}

/**
 * The `.gitignore` line that keeps the saved projects out of version control.
 *
 * A TIA project is binary, so versioning it would only ever report "changed"
 * (`docs/PATH-RULES.md` §6.1); the rebuilt source tree under
 * `<source dir>/` is the text artifact that belongs in git.
 *
 * @param config - the resolved configuration.
 */
export function tiaIgnoreRule(config: PluginConfig): string {
  return `${config.tiaDirName}/`
}
