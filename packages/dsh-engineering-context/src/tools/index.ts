/**
 * The tool registry of this plugin.
 *
 * Six workflow-shaped tools, not one tool per TIA operation: this plugin exists
 * to answer "which engineering project is this conversation about, where does it
 * live on disk, what shape is it in, and how does it get back in sync with TIA".
 * `workspace_describe` answers the same question for a workspace that is not the
 * session's (a reference project), and `import_preflight` reports what a TIA
 * import will refuse before it starts (docs/reference-project.md §15).
 *
 * **Version history is not here any more.** `project_commit`, `project_diff` and
 * the version-store tools moved to `@automation-suite/version-control` (D41,
 * docs/version-control-plan.md): recording history is not a TIA operation, and
 * this package must not own the git write channel. `project_sync` still writes
 * the source tree and stops there — the commit belongs to the other package now.
 *
 * @module dsh-engineering-context/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { createProjectTool } from './create-project.js'
import type { ToolDependencies } from './deps.js'
import { workspaceDescribeTool } from './describe.js'
import { importPreflightTool } from './preflight.js'
import { projectTranslateTool } from './project-translate.js'
import { statusTool } from './status.js'
import { syncTool } from './sync.js'

/** The tools this build registers, in registration order. */
export const TOOL_NAMES = [
  'create_engineering_project',
  'project_status',
  'project_sync',
  'workspace_describe',
  'import_preflight',
  'project_translate',
] as const

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
  return [
    createProjectTool(dependencies),
    statusTool(dependencies),
    syncTool(dependencies),
    workspaceDescribeTool(dependencies),
    importPreflightTool(dependencies),
    projectTranslateTool(dependencies),
  ]
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
