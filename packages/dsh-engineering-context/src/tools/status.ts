/**
 * `eng_status` — "which engineering project and which version am I talking
 * about?", plus what this build can and cannot do.
 *
 * This is the tool the model calls first whenever the scope is not already
 * established, and again after the user says they switched projects. It is
 * read-only: it never writes, never starts TIA Portal, and never touches the
 * host's workspace registry beyond reading it.
 *
 * @module dsh-engineering-context/tools/status
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { projectStateDir } from '../config.js'
import { fromPortable } from '../paths.js'
import { describePath, resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { cappedList, defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'
import { workspaceRegistry } from '../workspace.js'

/** The registry file path, relative to the workspace root. */
function registryRelative(scope: ResolvedScope): string {
  return `${scope.config.stateDirName}/projects.json`
}

/**
 * Build the `eng_status` tool.
 * @param dependencies - the plugin dependencies.
 */
export function statusTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'eng_status',
    description:
      'Report the engineering scope of this session: which workspace directory the conversation is scoped to, whether the ' +
      'host knows it as a workspace, which engineering project is selected, where that project working copy, export ' +
      'directory and state directory are, whether those paths exist, and which capabilities this build actually has. ' +
      'Call it first when you do not already know which project or which version the user means, and again after the user ' +
      'says they switched projects. Read-only: it writes nothing, does not talk to TIA Portal, and does not modify the ' +
      'host workspace registry. If it reports warnings, treat them as material — they state where the scope could not be ' +
      'confirmed.',
    parameters: {},
    async execute(_args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
      } catch (error) {
        return failedOutcome('eng_status', null, error)
      }

      const root = scope.workspace.path
      const registry = scope.registry
      const document = registry.status === 'ok' ? registry.document : null
      const projects = document?.projects ?? []
      const current = document?.current ?? null

      const rows = []
      for (const project of projects) {
        const work = await describePath(root, fromPortable(root, project.work))
        const exportDir = await describePath(root, fromPortable(root, project.export))
        const artifacts = await describePath(root, fromPortable(root, projectStateDir(scope.config, project.id)))
        rows.push({
          id: project.id,
          title: project.title,
          current: project.id === current,
          work: work.port,
          workState: work.kind,
          exportDir: exportDir.port,
          exportState: exportDir.kind,
          artifacts: artifacts.port,
          artifactsState: artifacts.kind,
          adopted: project.adoptedAt !== null,
        })
      }

      const details: string[] = [
        `Registry: ${registryRelative(scope)} (${registry.status}; ${projects.length} project(s); current: ${current ?? 'none'})`,
        `Host workspace registry: ${workspaceRegistry(dependencies.ctx) === undefined ? 'absent' : 'present'}; this directory is ${scope.workspace.registered ? 'registered' : 'NOT registered'}`,
        'Capabilities: version control (branches/history) is NOT available in this build (P1); fingerprint change detection is NOT available (needs the TIA interface plugin, P2)',
      ]
      if (rows.length > 0) {
        details.push(...cappedList(rows, (row) =>
          `${row.current ? '*' : ' '} ${row.id} (${row.title}) work=${row.work} [${row.workState}] export=${row.exportDir} [${row.exportState}]${row.adopted ? '' : ' not adopted'}`, 10))
      }
      details.push(
        rows.length === 0
          ? 'Next: eng_project action=register to register an engineering project in this workspace.'
          : 'Next: eng_project action=list for the full picture, eng_scope action=select to switch projects.',
      )

      const summary =
        scope.project === null
          ? `Scope resolved to ${root}; no engineering project selected (${projects.length} registered).`
          : `Scope resolved: ${scope.project.id} (${scope.project.title}) in ${root}; no version control in this build.`

      return okOutcome(
        'eng_status',
        scope.view,
        summary,
        {
          registry: { file: registryRelative(scope), status: registry.status, current, projects: rows },
          capabilities: {
            hostWorkspaceRegistry: workspaceRegistry(dependencies.ctx) !== undefined,
            workspaceRegistered: scope.workspace.registered,
            versionControl: false,
            tiaAccess: false,
          },
          phases: {
            implemented: ['scope', 'project-registry'],
            pending: { P1: 'git version layer', P2: 'fingerprint change detection (the TIA Openness plugin seam)', P3: 'change ledger' },
          },
        },
        { details, warnings: scope.view.warnings, dryRun: true },
      )
    },
  })
}
