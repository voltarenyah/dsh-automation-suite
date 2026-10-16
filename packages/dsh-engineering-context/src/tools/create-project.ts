/**
 * `create_engineering_project` — bring the project TIA currently has open into
 * this workspace, and rebuild its source tree.
 *
 * This is the whole workflow in one call, on purpose (docs/ARCHITECTURE.md §6):
 * "which directory, then save, then export" is an auditable orchestration, not
 * something the model should assemble out of primitives. Three facts shape it:
 *
 *   1. **This plugin never talks to TIA.** Every TIA action goes through the
 *      interface plugin's `engineeringAccess` service (docs/decisions.md D12);
 *      a composition without that plugin gets `tia_access_unavailable`, not a
 *      half-done workspace.
 *   2. **TIA decides the project's name and path.** Save-as takes only a
 *      directory and a project keeps its own name, so the folder is derived from
 *      the name TIA reports and the path TIA reports back is what the result
 *      carries — never what this tool asked for (interface-plugin D20/D21).
 *   3. **Adding is immediate, moving is not.** The save-as relocates the project
 *      TIA has open, which is the one hard-to-undo act in this plugin, so the
 *      whole call is a `dry_run` plan until the caller says otherwise
 *      (docs/decisions.md P0-4).
 *
 * @module dsh-engineering-context/tools/create-project
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { InferArgs, ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  engineeringAccess,
  normalizeRebuild,
  normalizeSave,
  normalizeSession,
  type RebuildResult,
  type TiaSession,
} from '../access.js'
import { projectDirectoryPath, sourceDirectoryPath, tiaIgnoreRule } from '../config.js'
import { EngineeringContextError } from '../errors.js'
import { canonicalizeLoose, folderName, isInside, toPortable } from '../paths.js'
import { assertInsideWith, describePath, resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { cappedList, defineOutcomeTool, failedOutcome, okOutcome, type EngineeringOutcome } from './outcome.js'

/** The tool name, in one place because tests and the registrar both match on it. */
export const CREATE_PROJECT_TOOL = 'create_engineering_project'

const CREATE_PARAMETERS = {
  dry_run: {
    type: 'boolean',
    description:
      'Default TRUE — report the plan and write nothing. Pass false to save the project into the workspace and rebuild its source ' +
      'tree. The save-as is the irreversible half: TIA moves the project it has open to the workspace copy, so read the plan first.',
  },
  overwrite: {
    type: 'boolean',
    description:
      'Default false — files that already exist in the source tree are skipped and counted in the result. Pass true to replace them, ' +
      'which is how a tree written by an earlier run is refreshed.',
  },
} as const

type CreateArgs = InferArgs<typeof CREATE_PARAMETERS>

/** What the `.gitignore` of the workspace currently says about saved projects. */
interface IgnoreFile {
  /** Absolute path of the workspace `.gitignore`. */
  file: string
  /** Portable spelling, for the result. */
  port: string
  /** The rule this plugin needs in it. */
  rule: string
  /** `missing` (no file), `absent` (file without the rule) or `present`. */
  state: 'missing' | 'absent' | 'present'
  /** The file's current text, or empty when it does not exist. */
  raw: string
}

/** The name the workspace folder is derived from, or an explicit failure. */
function projectNameOf(session: TiaSession): string {
  const reported = session.projectName?.trim()
  if (reported !== undefined && reported.length > 0) return reported
  if (session.projectPath !== null) {
    const base = basename(session.projectPath).replace(/\.[^.]+$/u, '').trim()
    if (base.length > 0) return base
  }
  throw new EngineeringContextError(
    'project_name_unavailable',
    'TIA reports an open project but no usable project name, so the workspace folder cannot be named. Save the project in TIA Portal first.',
    { projectPath: session.projectPath },
  )
}

/** Whether the open project already lives inside the directory this tool targets. */
async function alreadyInside(projectPath: string | null, targetDirectory: string): Promise<boolean> {
  if (projectPath === null) return false
  try {
    return isInside(targetDirectory, await canonicalizeLoose(projectPath))
  } catch {
    return false
  }
}

/**
 * Read the workspace `.gitignore` and decide what it needs.
 *
 * A missing file and a file without the rule are different actions (create vs
 * append), and an existing rule is left exactly as the user wrote it — this
 * plugin appends one line and never rewrites a file it did not author.
 */
async function readIgnoreFile(root: string, rule: string): Promise<IgnoreFile> {
  const file = join(root, '.gitignore')
  const port = toPortable(root, file)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file, port, rule, state: 'missing', raw: '' }
    }
    throw error
  }
  const wanted = new Set([rule, `/${rule}`, rule.replace(/\/$/u, '')])
  const present = raw.split(/\r?\n/u).some((line) => wanted.has(line.trim()))
  return { file, port, rule, state: present ? 'present' : 'absent', raw }
}

/** Write the rule, preserving everything the user already had. */
async function applyIgnoreRule(ignore: IgnoreFile): Promise<'created' | 'appended' | 'unchanged'> {
  if (ignore.state === 'present') return 'unchanged'
  if (ignore.state === 'missing') {
    const header = [
      '# Written by @voltarenyah/dsh-engineering-context (create_engineering_project).',
      `# ${ignore.rule} holds the TIA projects this workspace saved into it: binary, and edited`,
      '# in TIA Portal rather than here, so it is not versioned. The rebuilt source tree',
      '# beside it is the text artifact that belongs in version control.',
      `${ignore.rule}`,
      '',
    ].join('\n')
    await writeFile(ignore.file, header, 'utf8')
    return 'created'
  }
  const prefix = ignore.raw.length === 0 || ignore.raw.endsWith('\n') ? ignore.raw : `${ignore.raw}\n`
  await writeFile(ignore.file, `${prefix}\n# Saved TIA projects: binary, edited in TIA, not versioned here.\n${ignore.rule}\n`, 'utf8')
  return 'appended'
}

/** One line per device, for the model-facing detail block. */
function deviceLines(devices: readonly { device: string; software: string }[]): string[] {
  return devices.map((entry) => `${entry.device} / ${entry.software}`)
}

/**
 * Run one service call, converting a transport failure into a coded error.
 *
 * The service returns operation-level failures as data and throws transport ones
 * (controller missing, timeout, protocol mismatch); both end up as `ok: false`
 * for the model, but with different codes so it can tell them apart.
 */
async function callService<T>(what: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new EngineeringContextError(
      'tia_unreachable',
      `The ${what} call to the TIA interface plugin failed: ${message}`,
      { cause: message },
    )
  }
}

/**
 * Build the `create_engineering_project` tool.
 * @param dependencies - the plugin dependencies.
 */
export function createProjectTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: CREATE_PROJECT_TOOL,
    description:
      'Bring the engineering project that TIA Portal currently has open into this workspace: save it into the workspace copy and ' +
      'rebuild its source tree, so the conversation has a project on disk to talk about. Derived from the workspace root (the session ' +
      'working directory), the TIA project name and the configured directory names — this tool takes no path. Defaults to a plan ' +
      '(`dry_run: true`): the save-as moves the project TIA has open, so pass `dry_run: false` deliberately. It never starts TIA ' +
      'Portal, never opens a project, never deletes anything, and never modifies the user\'s original project files; if the project is ' +
      'already inside the workspace it skips the save-as and only refreshes the source tree. TIA refusals are reported per object, ' +
      'never dropped.',
    parameters: CREATE_PARAMETERS,
    async execute(args: CreateArgs, exec): Promise<EngineeringOutcome> {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const root = scope.workspace.path
        const config = scope.config
        const dryRun = args.dry_run !== false

        const service = engineeringAccess(dependencies.ctx)
        if (service === undefined) {
          throw new EngineeringContextError(
            'tia_access_unavailable',
            'This composition has no engineeringAccess service, so TIA Portal cannot be reached. Install the TIA interface plugin ' +
              '(dsh-tia-openness-v17-min) in this profile — this plugin never talks to TIA itself.',
            { service: 'engineeringAccess' },
          )
        }

        const session = normalizeSession(
          await callService('readTiaSession', () => service.readTiaSession({ signal: exec.signal })),
        )
        if (!session.running) {
          throw new EngineeringContextError(
            'tia_controller_not_running',
            `No TIA Openness controller is running, so there is no open project to save. ${session.reason ?? ''}Open the project in TIA Portal, ` +
              'then call this tool again (this plugin never starts the controller or TIA).',
            { reason: session.reason },
          )
        }
        if (!session.projectOpen) {
          throw new EngineeringContextError(
            'tia_project_not_open',
            `The controller is running but TIA Portal has no project open, so there is nothing to save. ${session.reason ?? ''}` +
              'Open the project in TIA Portal first.',
            { reason: session.reason },
          )
        }

        const name = projectNameOf(session)
        const folder = folderName(name)
        const projectDir = await canonicalizeLoose(projectDirectoryPath(config, root, folder))
        const sourceRoot = await canonicalizeLoose(sourceDirectoryPath(config, root, folder))
        assertInsideWith(config, root, projectDir, 'The project directory')
        assertInsideWith(config, root, sourceRoot, 'The source tree root')

        const skipSave = await alreadyInside(session.projectPath, projectDir)
        const ignore = await readIgnoreFile(root, tiaIgnoreRule(config))
        const projectDirStatus = await describePath(root, projectDir)
        const sourceStatus = await describePath(root, sourceRoot)

        const warnings = [...scope.view.warnings]
        if (session.isModified === true) {
          warnings.push(
            'TIA reports the open project as modified; the save-as writes those unsaved changes into the workspace copy.',
          )
        }
        if (!skipSave && projectDirStatus.kind !== 'missing') {
          warnings.push(
            `The directory ${projectDirStatus.port}/ already exists, so TIA may refuse the save-as or write beside what is there. ` +
              'Nothing is deleted either way.',
          )
        }
        if (sourceStatus.kind !== 'missing' && args.overwrite !== true) {
          warnings.push(
            `The source tree ${sourceStatus.port}/ already exists; files that are already there are skipped and counted. ` +
              'Pass overwrite=true to replace them.',
          )
        }

        const ignoreLine =
          ignore.state === 'present'
            ? `Ignore rule: ${ignore.rule} is already in ${ignore.port} — left untouched.`
            : ignore.state === 'missing'
              ? `Ignore rule: ${ignore.port} does not exist yet; it will be created with "${ignore.rule}" (the saved project is binary and TIA owns it).`
              : `Ignore rule: ${ignore.port} exists; "${ignore.rule}" will be appended to it.`

        const plan = [
          `Project: ${name} → ${projectDirStatus.port}/ (TIA keeps its own project name; save-as only chooses the directory)`,
          skipSave
            ? `Save-as: not needed — TIA already has this project at ${session.projectPath ?? '?'}, inside that directory.`
            : `Save-as: TIA will save the open project into ${projectDirStatus.port}/ (currently ${session.projectPath ?? 'unknown'}; its files there are not touched).`,
          `Source tree: ${sourceStatus.port}/ ← ${session.software.length} PLC software (${deviceLines(session.software).join(', ') || 'none'})`,
          'Layout below the source root is written by the interface plugin: <device>/blocks|types|tag_tables/, one manifest per export call.',
          ignoreLine,
        ]

        if (dryRun) {
          return okOutcome(
            CREATE_PROJECT_TOOL,
            scope.view,
            `Dry run: would ${skipSave ? 'refresh the source tree of' : 'save'} ${name} in ${projectDirStatus.port}/ (${session.software.length} device(s)). Pass dry_run=false to do it.`,
            {
              plan: {
                name,
                folder,
                projectDirectory: projectDirStatus,
                sourceRoot: sourceStatus,
                skipSave,
                projectPath: session.projectPath,
                devices: session.software,
              },
              ignore: { file: ignore.port, rule: ignore.rule, action: 'none (dry run)' },
              rebuild: null,
            },
            { details: plan, warnings, dryRun: true },
          )
        }

        // ---- the real run -------------------------------------------------

        let savedAs: string | null = null
        let projectPath = session.projectPath
        if (!skipSave) {
          const save = normalizeSave(
            await callService('saveProjectAs', () => service.saveProjectAs(projectDir, { signal: exec.signal })),
            projectDir,
          )
          if (!save.ok) {
            throw new EngineeringContextError(
              'save_failed',
              `TIA refused to save the project into ${projectDir}: ${save.error?.message ?? (save.summary || 'no reason reported')}. ` +
                'Nothing was written by this plugin, and the project TIA has open is unchanged.',
              { requestedSaveAsDir: save.requestedSaveAsDir, code: save.error?.code ?? null },
            )
          }
          savedAs = save.savedAs
          projectPath = save.projectPath ?? projectPath
        }

        // Before the (slow) export: the moment `tia/` holds a project, the ignore
        // rule has to be there, or the next `git add -A` stages a binary project.
        const ignoreAction = await applyIgnoreRule(ignore)

        const rebuilt: RebuildResult = normalizeRebuild(
          await callService('rebuildSource', () =>
            service.rebuildSource(sourceRoot, { overwrite: args.overwrite === true, signal: exec.signal }),
          ),
          sourceRoot,
        )

        // The controller reports "every file already existed, so nothing was
        // written" as `export_failed` with the message "Openness refused all N
        // object(s)" (`controller/Operations.cs:346` does not separate the two).
        // That is not a refusal and nothing is broken: the files and manifests on
        // disk are the ones this run found. Reporting it as a hard failure would
        // make the ordinary re-run — the whole point of the skip-save path — look
        // like a TIA error, so it is reported for what it is, with the staleness
        // spelled out.
        const nothingWritten =
          !rebuilt.ok && rebuilt.totals.written === 0 && rebuilt.totals.skipped > 0 && rebuilt.totals.refused === 0
        if (!rebuilt.ok && !nothingWritten) {
          throw new EngineeringContextError(
            'rebuild_failed',
            `The source tree could not be rebuilt: ${rebuilt.error?.message ?? (rebuilt.summary || 'no reason reported')}. ` +
              `The project itself is saved (${toPortable(root, projectDir)}/) and the ignore rule is in place, so calling this tool again only redoes the export.`,
            {
              code: rebuilt.error?.code ?? null,
              devices: rebuilt.devices.length,
              failures: rebuilt.failures.slice(0, 10),
              totals: rebuilt.totals,
            },
          )
        }

        const totals = rebuilt.totals
        const details = [
          ...plan,
          skipSave
            ? `Save-as: skipped — the project was already inside ${projectDirStatus.port}/.`
            : `Saved by TIA as: ${savedAs ?? projectPath ?? 'unknown'} (requested directory: ${projectDirStatus.port}/)`,
          `Ignore rule: ${ignoreAction} in ${ignore.port}.`,
          `Source rebuild: ${totals.planned} object(s) planned — ${totals.written} written, ${totals.skipped} already present, ` +
            `${totals.refused} refused by TIA${totals.verificationFailed === 0 ? '' : `, ${totals.verificationFailed} written but unreadable`}.`,
          ...deviceLines(rebuilt.devices).map(
            (line, index) =>
              `${line}: blocks ${rebuilt.devices[index]?.blocks.exported ?? 0}, types ${rebuilt.devices[index]?.types.exported ?? 0}, ` +
              `tag tables ${rebuilt.devices[index]?.tagTables.exported ?? 0} (planned; ${rebuilt.devices[index]?.skipped ?? 0} skipped)` +
              `${rebuilt.devices[index]?.blocks.manifest === null ? '' : `, manifest ${rebuilt.devices[index]?.blocks.manifest}`}`,
          ),
          ...cappedList(rebuilt.failures, (failure) => `Refused: ${failure.device}/${failure.category}/${failure.name} — ${failure.code}: ${failure.message}`),
        ]
        if (rebuilt.missingDevices.length > 0) {
          details.push(`Devices that were asked for but not found: ${rebuilt.missingDevices.join(', ')}`)
        }
        if (nothingWritten) {
          warnings.push(
            `Nothing was written: every file the export reached was already present, so the source tree is exactly what it was and may be stale. ` +
              'Pass overwrite=true to replace the existing files.',
          )
          const reached = rebuilt.devices.length
          if (reached < session.software.length) {
            warnings.push(
              `The interface plugin stops at the first device it cannot finish, so ${session.software.length - reached} of ` +
                `${session.software.length} device(s) were not examined at all — its numbers and device list describe only the ones before that point.`,
            )
          }
        }
        if (totals.refused > 0) {
          warnings.push(
            `${totals.refused} object(s) were refused by TIA; they are listed in the result and in each export call's manifest. The export did not abort because of them.`,
          )
        }

        // Re-describe the two directories: the payload has to say what is on disk
        // *after* the run, while the plan lines above state what was there before.
        const projectDirNow = await describePath(root, projectDir)
        const sourceNow = await describePath(root, sourceRoot)

        return okOutcome(
          CREATE_PROJECT_TOOL,
          scope.view,
          nothingWritten
            ? `Nothing was written: all ${totals.skipped} file(s) the export reached were already present. ${name} is in ${toPortable(root, projectDir)}/; pass overwrite=true to refresh the source tree.`
            : `Saved ${name} into ${toPortable(root, projectDir)}/ and wrote ${totals.written} object(s) into ${toPortable(root, sourceRoot)}/` +
              `${totals.skipped === 0 ? '' : `, ${totals.skipped} already present`}${totals.refused === 0 ? '' : `, ${totals.refused} refused by TIA`}.`,
          {
            project: {
              name,
              folder,
              directory: projectDirNow,
              sourceRoot: sourceNow,
              skipSave,
              requestedSaveAsDir: projectDirStatus.port,
              savedAs,
              projectPath,
            },
            ignore: { file: ignore.port, rule: ignore.rule, action: ignoreAction },
            rebuild: {
              sourceRoot: rebuilt.sourceRoot,
              devices: rebuilt.devices,
              failures: rebuilt.failures,
              missingDevices: rebuilt.missingDevices,
              totals,
              nothingWritten,
            },
          },
          { details, warnings, dryRun: false },
        )
      } catch (error) {
        return failedOutcome(CREATE_PROJECT_TOOL, scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}
