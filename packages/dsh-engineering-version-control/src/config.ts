/**
 * Plugin configuration.
 *
 * Three names decide **where this plugin reads and writes inside the user's
 * workspace**:
 *
 *   <workspace>/<source dir>/            the exported source tree (read-only here)
 *   <workspace>/<source dir>/<index>     the creation index that names the devices
 *   <workspace>/<state dir>/             the version store and the local state
 *
 * The workspace layout belongs to `@automation-suite/engineering-context`; this
 * plugin only reads it (root `docs/version-control-plan.md` §4). The names are
 * configurable because a user may have moved them, but nothing here creates a
 * layout of its own.
 *
 * `resolveConfig` validates every name instead of trusting it: a value with a
 * separator or `..` would move the version store out of the workspace. Invalid
 * values fall back to the default rather than making the plugin unloadable over
 * a typo.
 *
 * @module dsh-engineering-version-control/config
 */

import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

/** The plugin configuration, as the profile sees it. */
export interface PluginConfig {
  /** Local state directory (version store, lock, stage), relative to the workspace root. */
  stateDirName: string
  /** Directory holding the exported source trees, relative to the workspace root. */
  sourceDirName: string
  /** File name of the creation index, inside the source directory. */
  sourceIndexFile: string
}

/** Default values, applied both by the schema and by {@link resolveConfig}. */
export const configDefaults: PluginConfig = {
  stateDirName: '.dsh',
  sourceDirName: 'source',
  sourceIndexFile: '_dsh-engineering-context.json',
}

/** Schemastery configuration schema for the plugin consumer. */
export const Config = Schema.object({
  stateDirName: Schema.string().default(configDefaults.stateDirName),
  sourceDirName: Schema.string().default(configDefaults.sourceDirName),
  sourceIndexFile: Schema.string().default(configDefaults.sourceIndexFile),
})

/** Device names Windows reserves in every directory, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu

/** Characters Windows refuses in a file name. */
const ILLEGAL_NAME = /[<>:"|?*\u0000-\u001f]/u

/**
 * A directory name must be exactly one path segment.
 *
 * @param value - the raw configured value.
 * @param fallback - the default to use when the value cannot be a segment.
 * @returns the usable name.
 */
function directoryName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0) return fallback
  if (trimmed === '.' || trimmed === '..') return fallback
  if (/[\\/]/u.test(trimmed)) return fallback
  if (ILLEGAL_NAME.test(trimmed)) return fallback
  if (WINDOWS_RESERVED.test(trimmed)) return fallback
  return trimmed
}

/**
 * A file name must be exactly one path segment, and must not be a directory.
 *
 * @param value - the raw configured value.
 * @param fallback - the default to use when the value cannot be a file name.
 * @returns the usable name.
 */
function fileName(value: unknown, fallback: string): string {
  const name = directoryName(value, fallback)
  return name === fallback ? fallback : name
}

/**
 * Apply defaults and validation to a profile config block.
 *
 * @param config - the validated profile config, or undefined.
 * @returns a complete configuration.
 */
export function resolveConfig(config?: Partial<PluginConfig>): PluginConfig {
  const raw: Partial<PluginConfig> = config ?? {}
  return {
    stateDirName: directoryName(raw.stateDirName, configDefaults.stateDirName),
    sourceDirName: directoryName(raw.sourceDirName, configDefaults.sourceDirName),
    sourceIndexFile: fileName(raw.sourceIndexFile, configDefaults.sourceIndexFile),
  }
}

/** File name of the per-device evidence ledger, written by the interface plugin. */
export const EVIDENCE_FILE = '_evidence.json'

/** File name of the version store, inside the state directory. */
export const VERSION_STORE_FILE = 'versions.db'

/** Directory of the exported source trees. */
export function sourceDirectoryPath(config: PluginConfig, workspaceRoot: string): string {
  return join(workspaceRoot, config.sourceDirName)
}

/** The creation index that names the devices of this workspace. */
export function sourceIndexPath(config: PluginConfig, workspaceRoot: string): string {
  return join(sourceDirectoryPath(config, workspaceRoot), config.sourceIndexFile)
}

/** The local state directory (version store, lock, stage). */
export function localStateDirectoryPath(config: PluginConfig, workspaceRoot: string): string {
  return join(workspaceRoot, config.stateDirName, 'local')
}

/** The evidence ledger of one device directory. */
export function evidencePathForDevice(deviceDir: string): string {
  return join(deviceDir, EVIDENCE_FILE)
}

/** The version store of one workspace. */
export function versionStorePath(config: PluginConfig, workspaceRoot: string): string {
  return join(workspaceRoot, config.stateDirName, VERSION_STORE_FILE)
}
