/**
 * What a tool body needs from the plugin.
 *
 * Kept in its own module so the tool modules and the registrar can share the
 * type without importing each other.
 *
 * @module dsh-engineering-context/tools/deps
 */

import type { Context, Logger } from '@deepseek-ai/cordis'

import type { PluginConfig } from '../config.js'

/** The runtime dependencies of every tool of this plugin. */
export interface ToolDependencies {
  /** The plugin context; the workspace registry is looked up through it. */
  ctx: Context
  /** The resolved configuration. */
  config: PluginConfig
  /** The plugin logger. */
  log: Logger
}
