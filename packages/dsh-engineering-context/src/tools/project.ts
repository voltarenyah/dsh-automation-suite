/**
 * `eng_project` — the engineering project registry of one workspace.
 *
 * Four actions: `list`, `register`, `adopt`, `forget`.
 *
 * The dry-run rule is deliberately not uniform, and the description states it:
 * **adding** information (`register`) takes effect immediately because it is
 * undone by `forget`; **overwriting or removing** information (`adopt` with an
 * existing target, `forget`) defaults to `dry_run: true` and needs an explicit
 * `dry_run: false`. Every write this tool performs is either the registry file
 * itself (inside the workspace, tracked by git) or the working copy — never the
 * user's source project, which is read at most once and never modified
 * (`docs/PATH-RULES.md` §3).
 *
 * @module dsh-engineering-context/tools/project
 */

import { constants } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type { InferArgs, ToolDefinition } from '@deepseek-ai/dsh-tools'

import { projectContentDir, projectStateDir, type PluginConfig } from '../config.js'
import { EngineeringContextError } from '../errors.js'
import { canonicalize, canonicalizeLoose, fromPortable, isInside, slugify, toPortable, uniqueId } from '../paths.js'
import { REGISTRY_SCHEMA_VERSION, writeRegistry, type ProjectRecord, type RegistryFile } from '../registry.js'
import { describePath, requireProject, resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { cappedList, defineOutcomeTool, failedOutcome, okOutcome, type EngineeringOutcome } from './outcome.js'

/** An id is one path segment: safe characters only, never a dot-file. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

const PROJECT_PARAMETERS = {
  action: {
    type: 'string',
    enum: ['list', 'register', 'adopt', 'forget'],
    required: true,
    description:
      'list: show every registered project and whether its paths exist. register: add a project to this workspace. ' +
      'adopt: copy the recorded source project into the workspace as the working copy (dry-run by default). ' +
      'forget: remove a registration from the registry without touching any file (dry-run by default).',
  },
  project_id: {
    type: 'string',
    description:
      'Project to act on, for adopt and forget; the id to use, for register. Omit to use the selected project ' +
      '(eng_scope), which is also how register derives one from the title.',
  },
  title: {
    type: 'string',
    description: 'Human title, for register. Defaults to the source file name without its extension, or to the id.',
  },
  source_path: {
    type: 'string',
    description:
      'Absolute path of the user-owned source .ap17, for register. Recorded as provenance and read once by adopt; ' +
      'after that this plugin never reads or writes it again.',
  },
  work_path: {
    type: 'string',
    description:
      'Where the working copy belongs, for register: relative to the workspace root, or absolute inside it. ' +
      'Defaults to <projects dir>/<id>/work/<source file name>. Must stay inside the workspace.',
  },
  export_dir: {
    type: 'string',
    description:
      'Where exported objects belong, for register. Defaults to <projects dir>/<id>/export. Must stay inside the workspace.',
  },
  overwrite: {
    type: 'boolean',
    description: 'adopt: replace an existing working copy. Default false, which fails with target_exists instead.',
  },
  dry_run: {
    type: 'boolean',
    description:
      'adopt and forget: default TRUE — plan only. Pass false to perform the copy or the removal. list and register ' +
      'ignore this parameter: list writes nothing, and register is undone by forget.',
  },
} as const

type ProjectArgs = InferArgs<typeof PROJECT_PARAMETERS>

/** The registry path shown in results. */
function registryRelative(scope: ResolvedScope): string {
  return `${scope.config.stateDirName}/projects.json`
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const result = value.trim()
  return result.length === 0 ? undefined : result
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function targetPath(scope: ResolvedScope, value: string): string {
  return isAbsolute(value) ? value : fromPortable(scope.workspace.path, value)
}

/**
 * Fail closed when a write target is not inside the workspace.
 *
 * `config.requireWorkspace` exists only for a test harness; on every real
 * configuration this refuses.
 */
function assertInside(config: PluginConfig, root: string, target: string, what: string): void {
  if (!config.requireWorkspace) return
  if (isInside(root, target)) return
  throw new EngineeringContextError(
    'path_outside_workspace',
    `${what} must stay inside the workspace root ${root}, but it resolves to ${target}.`,
    { workspace: root, target },
  )
}

/** The project named by `project_id`, or the selected one. */
function pickProject(scope: ResolvedScope, projectId: string | undefined): ProjectRecord {
  const requested = trimmed(projectId)
  if (requested === undefined) return requireProject(scope)
  if (scope.registry.status !== 'ok') {
    throw new EngineeringContextError(
      'project_not_registered',
      'No engineering registry exists in this workspace yet, so no project can be looked up.',
      { workspace: scope.workspace.path },
    )
  }
  const found = scope.registry.document.projects.find((project) => project.id === requested)
  if (found === undefined) {
    throw new EngineeringContextError('project_not_found', `No project '${requested}' is registered.`, {
      available: scope.registry.document.projects.map((project) => project.id),
    })
  }
  return found
}

interface ProjectRow {
  id: string
  title: string
  current: boolean
  adopted: boolean
  source: string | null
  work: string
  workState: string
  exportDir: string
  exportState: string
  artifacts: string
  artifactsState: string
}

/** Describe every registered project, including whether its paths exist. */
async function projectRows(scope: ResolvedScope): Promise<ProjectRow[]> {
  const root = scope.workspace.path
  const document = scope.registry.status === 'ok' ? scope.registry.document : null
  const rows: ProjectRow[] = []
  for (const project of document?.projects ?? []) {
    const work = await describePath(root, fromPortable(root, project.work))
    const exportDir = await describePath(root, fromPortable(root, project.export))
    const artifacts = await describePath(root, fromPortable(root, projectStateDir(scope.config, project.id)))
    rows.push({
      id: project.id,
      title: project.title,
      current: document?.current === project.id,
      adopted: project.adoptedAt !== null,
      source: project.source,
      work: work.port,
      workState: work.kind,
      exportDir: exportDir.port,
      exportState: exportDir.kind,
      artifacts: artifacts.port,
      artifactsState: artifacts.kind,
    })
  }
  return rows
}

function rowLine(row: ProjectRow): string {
  return (
    `${row.current ? '*' : ' '} ${row.id} (${row.title}) work=${row.work} [${row.workState}]` +
    ` export=${row.exportDir} [${row.exportState}]${row.adopted ? '' : ' (source not adopted yet)'}`
  )
}

async function listProjects(scope: ResolvedScope): Promise<EngineeringOutcome> {
  const rows = await projectRows(scope)
  const current = scope.registry.status === 'ok' ? scope.registry.document.current : null
  const details = rows.length === 0
    ? ['No project is registered in this workspace yet.']
    : cappedList(rows, rowLine)
  details.push('Select one with eng_scope action=select; adopt a source with eng_project action=adopt.')
  return okOutcome(
    'eng_project',
    scope.view,
    rows.length === 0
      ? 'No engineering project is registered in this workspace.'
      : `${rows.length} project(s) registered; current: ${current ?? 'none'}.`,
    { registry: registryRelative(scope), current, projects: rows },
    { details, warnings: scope.view.warnings, dryRun: true },
  )
}

async function registerProject(scope: ResolvedScope, args: ProjectArgs): Promise<EngineeringOutcome> {
  const config = scope.config
  const root = scope.workspace.path
  const document = scope.registry.status === 'ok' ? scope.registry.document : null
  const existing = document?.projects ?? []
  const taken = new Set(existing.map((project) => project.id))

  const requestedId = trimmed(args.project_id)
  if (requestedId !== undefined) {
    if (!ID_PATTERN.test(requestedId)) {
      throw new EngineeringContextError(
        'invalid_argument',
        `project_id '${requestedId}' is not usable as a directory name: use letters, digits, dot, underscore or hyphen, and do not start with a dot.`,
        {},
      )
    }
    if (taken.has(requestedId)) {
      throw new EngineeringContextError('project_already_registered', `A project with id '${requestedId}' is already registered.`, {
        available: [...taken],
      })
    }
  }

  const sourceInput = trimmed(args.source_path)
  let source: string | null = null
  let sourceWarning: string | null = null
  if (sourceInput !== undefined) {
    try {
      source = await canonicalize(sourceInput)
    } catch {
      throw new EngineeringContextError('source_not_found', `The source project path does not resolve: ${sourceInput}`, {
        source: sourceInput,
      })
    }
    if (!(await fileExists(source))) {
      throw new EngineeringContextError('source_not_found', `The source project is not a file: ${source}`, { source })
    }
    if (!/\.(ap|zap)\d+$/iu.test(source)) {
      sourceWarning = `The source path does not end in a TIA project extension (.ap17 or similar): ${source}`
    }
  }

  const title = trimmed(args.title) ?? (source === null ? undefined : basename(source).replace(/\.[^.]+$/u, '')) ?? requestedId ?? 'project'
  const id = requestedId ?? uniqueId(taken, slugify(title))
  const defaultName = source === null ? `${id}.ap17` : basename(source)

  const workInput = trimmed(args.work_path)
  const workCandidate = workInput === undefined
    ? join(root, projectContentDir(config, id), 'work', defaultName)
    : targetPath(scope, workInput)
  const work = await canonicalizeLoose(workCandidate)
  assertInside(config, root, work, 'The working copy path')

  const exportInput = trimmed(args.export_dir)
  const exportCandidate = exportInput === undefined
    ? join(root, projectContentDir(config, id), 'export')
    : targetPath(scope, exportInput)
  const exportDir = await canonicalizeLoose(exportCandidate)
  assertInside(config, root, exportDir, 'The export directory')

  const record: ProjectRecord = {
    id,
    title,
    source,
    work: toPortable(root, work),
    export: toPortable(root, exportDir),
    createdAt: new Date().toISOString(),
    adoptedAt: null,
  }
  const next: RegistryFile = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    workspacePath: root,
    current: document?.current ?? id,
    projects: [...existing, record],
  }
  const file = await writeRegistry(config, root, next)

  const details = [
    `Registered ${id} (${title}) in ${registryRelative(scope)}`,
    `Work: ${record.work}${source === null ? ' (nothing to adopt: no source_path was given)' : ' (not created yet; run action=adopt)'}`,
    `Export: ${record.export}`,
    `State: ${projectStateDir(config, id)}/ — fingerprint baseline, change-sets and change ledger (P2/P3)`,
    source === null
      ? 'Without a source_path, adopt has nothing to copy. Re-register with source_path if the project has one.'
      : `Source (provenance only, never modified by this plugin): ${source}`,
    `Selected project is now ${next.current ?? 'none'}`,
  ]
  const warnings = [...scope.view.warnings]
  if (sourceWarning !== null) warnings.push(sourceWarning)
  return okOutcome(
    'eng_project',
    scope.view,
    `Registered project ${id}.`,
    { registry: file, project: record },
    { details, warnings, dryRun: false },
  )
}

async function adoptProject(scope: ResolvedScope, args: ProjectArgs): Promise<EngineeringOutcome> {
  const root = scope.workspace.path
  const record = pickProject(scope, args.project_id)
  const source = record.source
  if (source === null) {
    throw new EngineeringContextError(
      'invalid_argument',
      `Project '${record.id}' has no recorded source path, so adopt has nothing to copy. Re-register it with source_path, or place the working copy at ${record.work} yourself.`,
      { project: record.id },
    )
  }
  if (!(await fileExists(source))) {
    throw new EngineeringContextError('source_not_found', `The recorded source project no longer exists: ${source}`, {
      source,
      project: record.id,
    })
  }

  const target = fromPortable(root, record.work)
  assertInside(scope.config, root, target, 'The working copy path')
  const overwrite = args.overwrite === true
  const targetExists = await fileExists(target)
  if (targetExists && !overwrite) {
    throw new EngineeringContextError(
      'target_exists',
      `The working copy already exists at ${record.work}. Pass overwrite=true to replace it.`,
      { target: record.work },
    )
  }

  const plan = [
    `Copy ${source} to ${record.work}`,
    targetExists ? 'The target exists; overwrite=true was given, so it will be replaced.' : 'The target does not exist yet.',
    'This build performs a plain byte copy. The TIA-side "save as" is the family 1 seam and lands in P2, so if the project is open in TIA Portal, save it there first or the copy may be stale.',
  ]

  if (args.dry_run !== false) {
    return okOutcome(
      'eng_project',
      scope.view,
      `Dry run: adopt would copy the source into ${record.work}. Pass dry_run=false to do it.`,
      { project: record.id, source, target: record.work, overwrite, targetExists },
      { details: plan, warnings: scope.view.warnings, dryRun: true },
    )
  }

  const document = scope.registry.status === 'ok' ? scope.registry.document : null
  if (document === null) {
    throw new EngineeringContextError(
      'registry_invalid',
      'The registry could not be read when it was time to record the adoption, so the copy was not made. Re-run eng_status.',
      {},
    )
  }

  await mkdir(dirname(target), { recursive: true })
  // COPYFILE_EXCL closes the race between the existence check above and the copy;
  // without it a target that appeared in between would be clobbered silently.
  await copyFile(source, target, overwrite ? 0 : constants.COPYFILE_EXCL)

  const updated: ProjectRecord = { ...record, adoptedAt: new Date().toISOString() }
  const file = await writeRegistry(scope.config, root, {
    ...document,
    projects: document.projects.map((entry) => (entry.id === record.id ? updated : entry)),
  })

  return okOutcome(
    'eng_project',
    scope.view,
    `Adopted the source into ${record.work}.`,
    { registry: file, project: updated },
    {
      details: [...plan, `Recorded adoptedAt=${updated.adoptedAt ?? ''}`],
      warnings: scope.view.warnings,
      dryRun: false,
    },
  )
}

async function forgetProject(scope: ResolvedScope, args: ProjectArgs): Promise<EngineeringOutcome> {
  const root = scope.workspace.path
  const record = pickProject(scope, args.project_id)
  const document = scope.registry.status === 'ok' ? scope.registry.document : null
  if (document === null) {
    throw new EngineeringContextError('project_not_registered', 'No engineering registry exists in this workspace.', {})
  }

  const remaining = document.projects.filter((project) => project.id !== record.id)
  const nextCurrent = document.current === record.id ? null : document.current
  const paths = [record.work, record.export, `${projectStateDir(scope.config, record.id)}/`]

  const details = [
    `Remove the registration ${record.id} (${record.title}) from ${registryRelative(scope)}`,
    `No file is deleted or moved. Left on disk: ${paths.join(', ')}`,
    remaining.length === 0 ? 'No project would remain registered.' : `${remaining.length} project(s) would remain registered.`,
    nextCurrent === null ? 'No project would be selected afterwards.' : `The selected project stays ${nextCurrent}.`,
    'To unregister and also delete the working copy, do it yourself: this plugin never deletes engineering files.',
  ]

  if (args.dry_run !== false) {
    return okOutcome(
      'eng_project',
      scope.view,
      `Dry run: forget would unregister ${record.id} and touch no file. Pass dry_run=false to do it.`,
      { project: record.id, remaining: remaining.map((project) => project.id), nextCurrent },
      { details, warnings: scope.view.warnings, dryRun: true },
    )
  }

  const file = await writeRegistry(scope.config, root, { ...document, current: nextCurrent, projects: remaining })
  return okOutcome(
    'eng_project',
    scope.view,
    `Unregistered ${record.id}; no file was touched.`,
    { registry: file, project: record.id, remaining: remaining.map((project) => project.id), nextCurrent },
    { details, warnings: scope.view.warnings, dryRun: false },
  )
}

/**
 * Build the `eng_project` tool.
 * @param dependencies - the plugin dependencies.
 */
export function projectTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'eng_project',
    description:
      'Manage the engineering projects registered in this workspace: list them, register one, adopt (copy) its source ' +
      'project into the workspace as the working copy, or forget a registration. Register a project before any ' +
      'project-scoped work; the registry lives in the workspace at <state dir>/projects.json and is meant to be ' +
      'committed. Scope comes from the session working directory, so register in the workspace you mean. Actions that ' +
      'add information (list, register) take effect immediately because forget undoes them; actions that overwrite or ' +
      'remove information (adopt, forget) default to dry_run=true and need dry_run=false. It never modifies the ' +
      'source .ap17, never deletes engineering files, never talks to TIA Portal, and refuses any path outside the ' +
      'workspace.',
    parameters: PROJECT_PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        switch (args.action) {
          case 'list':
            return await listProjects(scope)
          case 'register':
            return await registerProject(scope, args)
          case 'adopt':
            return await adoptProject(scope, args)
          case 'forget':
            return await forgetProject(scope, args)
          default: {
            const unknown: never = args.action
            throw new EngineeringContextError('invalid_argument', `Unknown action: ${String(unknown)}`, {
              supported: ['list', 'register', 'adopt', 'forget'],
            })
          }
        }
      } catch (error) {
        return failedOutcome('eng_project', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}
