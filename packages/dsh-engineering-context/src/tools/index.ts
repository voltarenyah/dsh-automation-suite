/**
 * The tool registry of this plugin.
 *
 * One workflow-shaped tool, not one tool per TIA operation: this plugin exists to
 * answer "which engineering project is this conversation about, and where does it
 * live on disk", and that is a single auditable orchestration. The count is
 * deliberately small because every tool's name, description and parameter schema
 * is paid for in every session (docs/ARCHITECTURE.md §6).
 *
 * @module dsh-engineering-context/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { createProjectTool } from './create-project.js'
import type { ToolDependencies } from './deps.js'

/** The tools this build registers, in registration order. */
export const TOOL_NAMES = ['create_engineering_project'] as const

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
  return [createProjectTool(dependencies)]
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
