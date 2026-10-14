/**
 * Scope resolution: the four-tuple every result carries, plus the consistency
 * facts the model needs to know whether that scope is trustworthy.
 *
 *   workspace → project → branch → version
 *
 * In this phase only the first two are populated: the git layer that fills
 * `branch`/`version` is P1, and the version fields exist now so the shape does
 * not change under the model later. The plugin never guesses a scope it cannot
 * establish — a missing cwd, an unusable registry or an unselected project among
 * several produces an explicit failure instead of a default
 * (`docs/ARCHITECTURE.md` §4.3).
 *
 * @module dsh-engineering-context/scope
 */

import { stat } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { projectStateDir, type PluginConfig } from './config.js'
import { EngineeringContextError } from './errors.js'
import { fromPortable, toPortable } from './paths.js'
import { readRegistry, selectProject, type ProjectRecord, type RegistryState } from './registry.js'
import { resolveWorkspaceRoot, type WorkspaceRoot } from './workspace.js'

/** What exists at one recorded path. */
export interface PathStatus {
  /** Portable spelling (relative to the workspace root, forward slashes). */
  port: string
  /** Absolute spelling, for the plugin's own use and for host-side debugging. */
  absolute: string
  /** `file`, `directory` or `missing`. */
  kind: 'file' | 'directory' | 'missing'
}

/** How a version is identified. P0 has no version control, so only `none`. */
export type ScopeVersion = { kind: 'none' } | { kind: 'pin'; id: string; verified: boolean }

/** The scope a result belongs to. */
export interface ScopeView {
  workspace: { path: string; registered: boolean; title: string | null }
  project: { id: string; title: string } | null
  branch: string | null
  version: ScopeVersion
  /** How many projects the registry holds. */
  projectCount: number
  /** Paths of the selected project, or null when none is selected. */
  paths: {
    work: PathStatus
    export: PathStatus
    artifacts: PathStatus
    source: PathStatus | null
  } | null
  /** Everything about this scope that the model should not have to guess. */
  warnings: string[]
}

/** A fully resolved scope, with the pieces the tools need. */
export interface ResolvedScope {
  workspace: WorkspaceRoot
  config: PluginConfig
  registry: RegistryState
  /** The selected (or only) project, when one could be determined. */
  project: ProjectRecord | null
  view: ScopeView
  /** Absolute path of the registry file, whether or not it exists. */
  registryFile: string
}

/**
 * What exists at one path, described relative to the workspace root.
 *
 * @param root - the canonical workspace root.
 * @param absolute - the absolute path to inspect.
 * @returns the portable spelling, the absolute spelling and the kind present.
 */
export async function describePath(root: string, absolute: string): Promise<PathStatus> {
  let kind: PathStatus['kind'] = 'missing'
  try {
    const stats = await stat(absolute)
    kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'missing'
  } catch {
    kind = 'missing'
  }
  return { port: toPortable(root, absolute), absolute, kind }
}

/**
 * Resolve everything one tool call needs to know about its scope.
 *
 * @param ctx - the plugin context.
 * @param exec - the per-call execution context.
 * @param config - the resolved configuration.
 * @returns the resolved scope.
 * @throws {EngineeringContextError} `scope_unavailable` when there is no usable
 *   working directory, `registry_invalid` when the registry does not validate.
 */
export async function resolveScope(
  ctx: Context,
  exec: ToolRunContext,
  config: PluginConfig,
): Promise<ResolvedScope> {
  const workspace = await resolveWorkspaceRoot(ctx, exec)
  const registry = await readRegistry(config, workspace.path)

  if (registry.status === 'invalid') {
    throw new EngineeringContextError(
      'registry_invalid',
      `The engineering registry is unusable: ${registry.reason}. It was left untouched — repair or remove it deliberately.`,
      { file: registry.file },
    )
  }

  const warnings: string[] = []
  if (!workspace.registered) {
    warnings.push(
      `The working directory is not registered as a workspace in this host, so the scope identifies it by path only: ${workspace.path}`,
    )
  }

  let project: ProjectRecord | null = null
  let paths: ScopeView['paths'] = null

  if (registry.status === 'ok') {
    const document = registry.document
    if (document.workspacePath !== workspace.path) {
      warnings.push(
        `The registry was created in ${document.workspacePath} but is being read from ${workspace.path}. ` +
          'Project paths are stored relative to the workspace root, so they still resolve; the recorded provenance path may not.',
      )
    }

    const selected = selectProject(document)
    if ('record' in selected) project = selected.record
    else if ('ambiguous' in selected) {
      warnings.push(
        `${document.projects.length} projects are registered and none is selected. Use eng_scope to select one, or pass project_id explicitly.`,
      )
    }

    if (project !== null) {
      const work = fromPortable(workspace.path, project.work)
      const exportDir = fromPortable(workspace.path, project.export)
      const artifacts = fromPortable(workspace.path, projectStateDir(config, project.id))
      const workStatus = await describePath(workspace.path, work)
      const exportStatus = await describePath(workspace.path, exportDir)
      const artifactsStatus = await describePath(workspace.path, artifacts)
      paths = {
        work: workStatus,
        export: exportStatus,
        artifacts: artifactsStatus,
        source: project.source === null ? null : await describePath(workspace.path, project.source),
      }
      if (workStatus.kind === 'missing') {
        warnings.push(
          `The working copy is missing at ${workStatus.port}. Register a source path and run eng_project adopt to materialize it.`,
        )
      }
      if (paths.source !== null && paths.source.kind === 'missing') {
        warnings.push(`The recorded source project no longer exists: ${project.source ?? ''}`)
      }
      if (exportStatus.kind === 'missing') {
        warnings.push(
          `Nothing has been exported yet (${exportStatus.port} does not exist). Exporting is the TIA interface plugin's job and lands in P2.`,
        )
      }
    }
  } else {
    warnings.push(`No engineering registry exists yet (${registryRelative(config)}). Register a project first.`)
  }

  const view: ScopeView = {
    workspace: { path: workspace.path, registered: workspace.registered, title: workspace.title },
    project: project === null ? null : { id: project.id, title: project.title },
    branch: null,
    version: { kind: 'none' },
    projectCount: registry.status === 'ok' ? registry.document.projects.length : 0,
    paths,
    warnings,
  }

  return {
    workspace,
    config,
    registry,
    project,
    view,
    registryFile: registry.file,
  }
}

function registryRelative(config: PluginConfig): string {
  return `${config.stateDirName}/projects.json`
}

/**
 * Require a project, failing with the reason it could not be determined.
 *
 * @param scope - a resolved scope.
 * @returns the selected project.
 * @throws {EngineeringContextError} `project_not_registered` when there is no
 *   registry or no project, `project_ambiguous` when several exist and none is
 *   selected.
 */
export function requireProject(scope: ResolvedScope): ProjectRecord {
  if (scope.project !== null) return scope.project
  if (scope.registry.status !== 'ok' || scope.registry.document.projects.length === 0) {
    throw new EngineeringContextError(
      'project_not_registered',
      'No engineering project is registered in this workspace yet. Use eng_project with action=register first.',
      { workspace: scope.workspace.path },
    )
  }
  throw new EngineeringContextError(
    'project_ambiguous',
    'Several projects are registered and none is selected, so the target is ambiguous. Use eng_scope with action=select, or pass project_id explicitly.',
    { available: scope.registry.document.projects.map((project) => project.id) },
  )
}
