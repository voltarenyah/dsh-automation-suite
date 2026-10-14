/**
 * `eng_scope` — switch which engineering project the session is talking about.
 *
 * Switching is an explicit, recorded action, which is the whole point of
 * decision D5: the scope never drifts silently, and every later result can
 * answer "which project was this about". The current project is one field in the
 * workspace's registry file (`docs/decisions.md` N3 keeps a single pointer there
 * so two pointers can never disagree).
 *
 * Selecting and clearing are both immediate: neither removes any information,
 * and either is undone by the other.
 *
 * @module dsh-engineering-context/tools/scope
 */

import type { InferArgs, ToolDefinition } from '@deepseek-ai/dsh-tools'

import { EngineeringContextError } from '../errors.js'
import { writeRegistry } from '../registry.js'
import { resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

const SCOPE_PARAMETERS = {
  action: {
    type: 'string',
    enum: ['select', 'clear'],
    required: true,
    description: 'select: make a registered project the current one. clear: stop having a current project.',
  },
  project_id: {
    type: 'string',
    description: 'The project to select, for action=select. Must be registered already; use eng_project to register one.',
  },
} as const

type ScopeArgs = InferArgs<typeof SCOPE_PARAMETERS>

function registryRelative(scope: ResolvedScope): string {
  return `${scope.config.stateDirName}/projects.json`
}

async function selectProject(scope: ResolvedScope, args: ScopeArgs): Promise<ReturnType<typeof okOutcome>> {
  const requested = args.project_id?.trim()
  if (requested === undefined || requested.length === 0) {
    throw new EngineeringContextError('invalid_argument', 'action=select needs project_id.', {
      available: scope.registry.status === 'ok' ? scope.registry.document.projects.map((project) => project.id) : [],
    })
  }
  if (scope.registry.status !== 'ok') {
    throw new EngineeringContextError(
      'project_not_registered',
      'No engineering registry exists in this workspace yet, so there is nothing to select.',
      { workspace: scope.workspace.path },
    )
  }

  const document = scope.registry.document
  const record = document.projects.find((project) => project.id === requested)
  if (record === undefined) {
    throw new EngineeringContextError('project_not_found', `No project '${requested}' is registered.`, {
      available: document.projects.map((project) => project.id),
    })
  }
  if (document.current === record.id) {
    return okOutcome(
      'eng_scope',
      { ...scope.view, project: { id: record.id, title: record.title } },
      `${record.id} was already the selected project.`,
      { current: record.id, changed: false },
      { details: [`Registry: ${registryRelative(scope)} (unchanged)`], warnings: scope.view.warnings, dryRun: true },
    )
  }

  const file = await writeRegistry(scope.config, scope.workspace.path, { ...document, current: record.id })
  return okOutcome(
    'eng_scope',
    { ...scope.view, project: { id: record.id, title: record.title } },
    `Selected project ${record.id} (${record.title}).`,
    { registry: file, current: record.id, previous: document.current, changed: true },
    {
      details: [
        `Registry: ${registryRelative(scope)}`,
        document.current === null ? 'Nothing was selected before.' : `Previously selected: ${document.current}`,
        'Later results in this session will report this project until it is changed again.',
      ],
      warnings: scope.view.warnings,
      dryRun: false,
    },
  )
}

async function clearProject(scope: ResolvedScope): Promise<ReturnType<typeof okOutcome>> {
  if (scope.registry.status !== 'ok') {
    throw new EngineeringContextError('project_not_registered', 'No engineering registry exists in this workspace yet.', {})
  }
  const document = scope.registry.document
  if (document.current === null) {
    return okOutcome('eng_scope', scope.view, 'No project was selected.', { current: null, changed: false }, {
      details: [`Registry: ${registryRelative(scope)} (unchanged)`],
      warnings: scope.view.warnings,
      dryRun: true,
    })
  }

  const previous = document.current
  const file = await writeRegistry(scope.config, scope.workspace.path, { ...document, current: null })
  return okOutcome(
    'eng_scope',
    { ...scope.view, project: null },
    `Cleared the selected project (was ${previous}).`,
    { registry: file, current: null, previous, changed: true },
    {
      details: [
        `Registry: ${registryRelative(scope)}`,
        `The project ${previous} is still registered; only the selection was cleared.`,
        'With several projects registered and none selected, project-scoped tools will report project_ambiguous until you select one.',
      ],
      warnings: scope.view.warnings,
      dryRun: false,
    },
  )
}

/**
 * Build the `eng_scope` tool.
 * @param dependencies - the plugin dependencies.
 */
export function scopeTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'eng_scope',
    description:
      'Select which registered engineering project the rest of the session is about, or clear the selection. Use it ' +
      'when the user switches projects, or when another tool reported project_ambiguous. Selecting is an explicit, ' +
      'recorded action — the scope never changes on its own — and eng_status always reports the current selection. ' +
      'It only edits the workspace registry pointer, writes no engineering file, and refuses an unregistered project id.',
    parameters: SCOPE_PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        switch (args.action) {
          case 'select':
            return await selectProject(scope, args)
          case 'clear':
            return await clearProject(scope)
          default: {
            const unknown: never = args.action
            throw new EngineeringContextError('invalid_argument', `Unknown action: ${String(unknown)}`, {
              supported: ['select', 'clear'],
            })
          }
        }
      } catch (error) {
        return failedOutcome('eng_scope', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}
