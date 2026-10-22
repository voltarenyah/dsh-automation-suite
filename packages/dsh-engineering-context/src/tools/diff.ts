/**
 * `project_diff` — explain a revision difference structurally, without writing.
 *
 * The tool is one thin envelope over `src/diff.ts`: scope resolution, the
 * outcome envelope and the model-facing detail lines live here; the parsing and
 * the git read path live in the module, so they are testable without a registry.
 *
 * It is registered by the separate `engineering-context-diff` entry point
 * (`src/diff-entry.ts`) and mounted only into the Leader and Expert presets. The
 * Auditor preset deliberately has no context row with this entry: the auditor
 * reports *that* something changed, Leader/Expert explain *what* changed.
 *
 * @module dsh-engineering-context/tools/diff
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { projectDiff } from '../diff.js'
import { resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

/** The tool name, used by the registrar and the tests. */
export const PROJECT_DIFF_TOOL = 'project_diff'

const PARAMETERS = {
  block: {
    type: 'string',
    description:
      'Optional block (or type) name exactly as project_status reports it, e.g. "MotorStart". Its file path is resolved from the ' +
      'current evidence ledger; omit it to diff every changed XML file under the device\'s blocks/ and types/ directories.',
  },
  device: {
    type: 'string',
    description:
      'Optional device name. Required only when the workspace holds more than one device directory under source/; ' +
      'the tool never guesses which PLC to analyse.',
  },
  from: {
    type: 'string',
    description: 'Committed revision to compare from. Default HEAD~1. Must exist in the repository; WORKTREE is not allowed here.',
  },
  to: {
    type: 'string',
    description:
      'Revision to compare to. Default HEAD. Pass "WORKTREE" to compare the working tree (uncommitted and untracked XML included) ' +
      'against `from`.',
  },
  max_items: {
    type: 'integer',
    description:
      'Default 10, clamped to 1–50. Caps every listed set (files, units, members, text items) while all counts stay exact; ' +
      'the result says when a list or the file set was truncated.',
  },
} as const

/**
 * Build the `project_diff` tool.
 *
 * @param dependencies - the plugin dependencies.
 * @returns a registry-ready definition.
 */
export function diffTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: PROJECT_DIFF_TOOL,
    description:
      'Explain which exported Simatic ML block XML changed between two committed revisions (or between a revision and the working ' +
      'tree) and what changed inside each block: compile units/networks added, removed or changed with Part/Wire/Access count ' +
      'deltas; interface members added/removed/changed datatype; multilingual text added/removed; and the evidence-ledger faces ' +
      '(Code/Interface/Comments/Properties) that changed, or "unknown" when no ledger exists on both sides. ' +
      'Read-only: it never writes, never runs TIA, never creates or commits a repository, and returns bounded counts plus the first ' +
      'N entries instead of XML. Default from=HEAD~1, to=HEAD; pass to="WORKTREE" for uncommitted changes. ' +
      'This tool is available to Leader and Expert only — it is deliberately NOT available to the Auditor, so never delegate a ' +
      'project_diff call to the Auditor.',
    parameters: PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const result = await projectDiff({
          ctx: dependencies.ctx,
          config: dependencies.config,
          root: scope.workspace.path,
          block: args.block,
          device: args.device,
          from: args.from,
          to: args.to,
          maxItems: args.max_items,
        })
        return okOutcome(PROJECT_DIFF_TOOL, scope.view, result.summary, result.data, {
          details: result.details,
          warnings: [...scope.view.warnings, ...result.warnings],
          dryRun: true,
        })
      } catch (error) {
        return failedOutcome(PROJECT_DIFF_TOOL, scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}
