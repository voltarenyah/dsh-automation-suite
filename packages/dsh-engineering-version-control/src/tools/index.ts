/**
 * The whole tool surface of this plugin, in one list.
 *
 * The three Loader entries register **subsets** (`/record`, `/read`, `/diff`), so
 * a preset can hand out "read the history" without handing out "record a
 * version". This module composes the full surface for the tests and for any
 * composition that wants all of it at once.
 *
 * @module dsh-engineering-version-control/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { commitTool } from './commit.js'
import type { ToolDependencies } from './deps.js'
import { diffTool } from './diff.js'
import { versionTools } from './version.js'

/** Every tool this package can register, in a stable order. */
export const TOOL_NAMES = [
  'project_commit',
  'project_diff',
  'project_history',
  'project_version_reindex',
  'project_version_verify',
  'project_doc_index',
  'project_doc_search',
  'project_version_annotate',
  'project_problem',
  'project_version_query',
] as const

/** One of the registered tool names. */
export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * Build every tool definition.
 *
 * @param dependencies - the plugin dependencies.
 * @returns the definitions, in a stable order.
 */
export function toolDefinitions(dependencies: ToolDependencies): ToolDefinition[] {
  return [commitTool(dependencies), diffTool(dependencies), ...versionTools(dependencies)]
}

/**
 * Register every tool on the composition's tool registry.
 *
 * @param ctx - the plugin context.
 * @param dependencies - the plugin dependencies.
 * @returns the registered tool names.
 */
export function registerTools(ctx: Context, dependencies: ToolDependencies): string[] {
  const registered: string[] = []
  for (const definition of toolDefinitions(dependencies)) {
    ctx.tools.register(definition)
    registered.push(definition.name)
  }
  return registered
}

export type { ToolDependencies }
