/**
 * The tool registry of this plugin.
 *
 * Three workflow-shaped tools, not one tool per controller operation: this phase
 * implements scope and project registry only, and the count is deliberately small
 * because every tool's name, description and parameter schema is paid for in
 * every session (docs/ARCHITECTURE.md §6).
 *
 * @module dsh-engineering-context/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ToolDependencies } from './deps.js'
import { projectTool } from './project.js'
import { scopeTool } from './scope.js'
import { statusTool } from './status.js'
import { versionTool } from './version.js'

/** The tools this build registers, in registration order. */
export const TOOL_NAMES = ['eng_status', 'eng_project', 'eng_scope', 'eng_version'] as const

/** One of the registered tool names. */
export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * Build every tool definition.
 *
 * Exported separately from {@link registerTools} so tests can drive the bodies
 * without a registry.
 *
 * @param dependencies - the plugin dependencies.
 * @returns the definitions, in registration order.
 */
export function toolDefinitions(dependencies: ToolDependencies): ToolDefinition[] {
  return [statusTool(dependencies), projectTool(dependencies), scopeTool(dependencies), versionTool(dependencies)]
}

/**
 * Register every tool on the composition's tool registry.
 *
 * @param ctx - the plugin context.
 * @param dependencies - the plugin dependencies.
 * @returns the registered tool names, in registration order.
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
