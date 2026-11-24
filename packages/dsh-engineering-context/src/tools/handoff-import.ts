/**
 * `handoff_import` — verify a returned archive, replace the managed project and
 * let the normal sync workflow describe what changed.
 *
 * The order is deliberate:
 *
 * 1. read the ZIP and its marker **without touching TIA**;
 * 2. prove the marker against the committed evidence at its base commit;
 * 3. refuse if the workspace moved past that base or the source tree is dirty;
 * 4. close the old project, move the old `tia/<workspace>/` aside, retrieve;
 * 5. update the index, then either sync (compiled) or stop at
 *    `awaiting_compile` (the user compiles in TIA, then runs `project_sync`).
 *
 * It never compiles and never commits. The old project directory is moved, not
 * deleted, and a failed retrieval is rolled back.
 *
 * @module dsh-engineering-context/tools/handoff-import
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  engineeringAccess,
  normalizeCall,
  normalizeChecksum,
  normalizeRetrieve,
  normalizeSession,
  type ChecksumReport,
  type EngineeringAccessLike,
} from '../access.js'
import {
  localStateDirectoryPath,
  projectDirectoryPath,
  sourceDirectoryPath,
  sourceIndexPath,
  type PluginConfig,
} from '../config.js'
import type { DeviceInfo } from '../device.js'
import { resolveDeviceFromTia } from '../device.js'
import { EngineeringContextError } from '../errors.js'
import { canonicalizeLoose, folderName, isInside, toPortable } from '../paths.js'
import { resolveScope, type ResolvedScope } from '../scope.js'
import { ensureRepository, headCommit } from '../git.js'
import { withLock } from '../lock.js'
import { runSyncUnlocked } from '../sync.js'
import { parseMarker, record, sha256Hex, text } from '../handoff/marker.js'
import {
  ensureHandoffIgnore,
  findRecord,
  handoffInstructions,
  handoffMarkerCopyPath,
  handoffPackageDirectory,
  handoffRecordPath,
  handoffTextPath,
  writeRecord,
} from '../handoff/record.js'
import { parseAp17Identity, readArchive } from '../handoff/zip.js'
import { verifyMarkerAgainstGit } from '../handoff/verify.js'
import {
  HANDOFF_ARCHIVE_MODE,
  HANDOFF_MARKER_FILE,
  HANDOFF_SCHEMA_VERSION,
  USERFILES_DIR,
  type HandoffImportPlan,
  type HandoffRecord,
} from '../handoff/types.js'
import type { ToolDependencies } from './deps.js'
import { defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

/** The tool name. */
export const HANDOFF_IMPORT_TOOL = 'handoff_import'

const PARAMETERS = {
  archive_path: {
    type: 'string',
    required: true,
    description:
      'Absolute path of the returned .zap17 archive. This tool reads its marker and .ap17 before touching TIA, and ' +
      'refuses the import if the marker does not match the committed evidence at its base commit.',
  },
  dry_run: {
    type: 'boolean',
    description:
      'Default true: read and verify the archive, report the base, the package record and what would be closed/moved, ' +
      'writing nothing. Pass false to perform the import.',
  },
  with_window: {
    type: 'boolean',
    description: 'Default true: retrieve into a visible TIA Portal instance (the user may have to compile there).',
  },
  accept_renamed_project: {
    type: 'boolean',
    description:
      'Default false. If the archive project name differs from the marker (TIA renamed it because the other machine already ' +
      'had a project with that name), the import stops with handoff_project_name_changed. Set this to true only after the ' +
      'user explicitly confirms it is the same project and accepts the archive name as the new managed project name.',
  },
  note: {
    type: 'string',
    description: 'Optional one-line note about the returned changes, stored in handoff.json and shown in the result.',
  },
} as const

/** A path's existence. */
async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** Rename with a few retries: TIA can release the last handle a moment after close. */
async function moveWithRetry(from: string, to: string): Promise<void> {
  let last: unknown = null
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      last = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
  throw new EngineeringContextError(
    'handoff_backup_failed',
    `Could not move ${from} to ${to}; TIA may still hold the project folder. Close TIA Portal and retry.`,
    { from, to, cause: last instanceof Error ? last.message : String(last) },
  )
}

/** Find the root `.ap17` below a directory, at most three levels deep. */
export async function findProjectFile(directory: string): Promise<string | null> {
  const queue: Array<{ path: string; depth: number }> = [{ path: directory, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    let entries
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current.path, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.ap17')) return full
      if (entry.isDirectory() && current.depth < 3) queue.push({ path: full, depth: current.depth + 1 })
    }
  }
  return null
}

/** The index document, loosely typed: the import only rewrites the project block. */
interface SourceIndexDocument {
  schemaVersion?: unknown
  project?: Record<string, unknown>
  exportedAt?: unknown
  devices?: unknown
  totals?: unknown
  [key: string]: unknown
}

/** Read the source index, or throw a coded error. */
async function readIndex(config: PluginConfig, root: string): Promise<{ file: string; document: SourceIndexDocument }> {
  const file = sourceIndexPath(config, root)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    throw new EngineeringContextError(
      'not_synced',
      `This workspace has no ${file}; create the engineering project before importing a handoff.`,
      { file, cause: error instanceof Error ? error.message : String(error) },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new EngineeringContextError('not_synced', `The source index ${file} is not valid JSON.`, {
      file,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const document = record(parsed)
  if (document === null) {
    throw new EngineeringContextError('not_synced', `The source index ${file} is not a JSON object.`, { file })
  }
  return { file, document: document as SourceIndexDocument }
}

/** Resolve the device directory the index records for the marker's device. */
async function deviceFromIndex(
  config: PluginConfig,
  root: string,
  deviceName: string,
  softwareName: string,
): Promise<DeviceInfo> {
  const { document } = await readIndex(config, root)
  const sourceRoot = await canonicalizeLoose(sourceDirectoryPath(config, root))
  const devices = Array.isArray(document.devices) ? document.devices : []
  for (const entry of devices) {
    const item = record(entry)
    if (item === null) continue
    if (item['device'] !== deviceName) continue
    if (typeof item['software'] === 'string' && item['software'] !== softwareName) continue
    if (typeof item['directory'] !== 'string' || item['directory'].length === 0) continue
    const absolute =
      /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(item['directory']) ? item['directory'] : join(root, item['directory'])
    const candidate = await canonicalizeLoose(absolute)
    if (isInside(sourceRoot, candidate)) {
      return { device: deviceName, software: softwareName, directory: candidate, sourceRoot }
    }
  }
  const fallback = await canonicalizeLoose(join(sourceRoot, folderName(deviceName)))
  return { device: deviceName, software: softwareName, directory: fallback, sourceRoot }
}

/** The workspace's managed project directory. */
async function managedDirectory(config: PluginConfig, root: string, workspaceTitle: string | null): Promise<string> {
  const name = folderName((workspaceTitle ?? '').trim() || basename(root))
  return await canonicalizeLoose(projectDirectoryPath(config, root, name))
}

/** Whether the current open project is the one this handoff already imported. */
function isTheImportedProject(sessionPath: string | null, managedRoot: string, projectName: string): boolean {
  if (sessionPath === null) return false
  if (!isInside(managedRoot, sessionPath)) return false
  return basename(dirname(sessionPath)) === projectName || basename(sessionPath, '.ap17') === projectName
}

/** Update the source index after retrieval; returns the backup path of the old index. */
async function updateIndex(
  config: PluginConfig,
  root: string,
  handoffId: string,
  input: {
    projectName: string
    projectPath: string
    archivePath: string
    projectDirectory: string
  },
): Promise<{ file: string; backup: string | null }> {
  const { file, document } = await readIndex(config, root)
  const backupRoot = join(localStateDirectoryPath(config, root), 'handoff-backups', handoffId)
  await mkdir(backupRoot, { recursive: true })
  const backup = join(backupRoot, 'source-index.json')
  await writeFile(backup, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
  const project = record(document.project) ?? {}
  document.project = {
    ...project,
    name: input.projectName,
    path: null,
    savedAs: input.projectPath,
    archive: input.archivePath,
    directory: toPortable(root, input.projectDirectory),
    sourceRoot: typeof project['sourceRoot'] === 'string' ? project['sourceRoot'] : 'source',
  }
  await writeFile(file, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
  return { file, backup }
}

/** Restore the source index after a rollback. */
async function restoreIndex(file: string, backup: string | null): Promise<void> {
  if (backup === null || !(await pathExists(backup))) return
  await writeFile(file, await readFile(backup, 'utf8'), 'utf8')
}

/**
 * Build the import tool.
 *
 * @param dependencies - the plugin dependencies.
 */
export function handoffImportTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: HANDOFF_IMPORT_TOOL,
    description:
      'Import a returned TIA Portal V17 .zap17 produced from this workspace. It reads the marker at ' +
      'UserFiles/_dsh-handoff.json from the ZIP, verifies it against the evidence committed at its base commit, and ' +
      'refuses if HEAD moved past that base or the source tree is dirty (v1 does not merge). On a real run it closes the ' +
      'open project, moves the old tia/<workspace>/ to .dsh/local/handoff-backups/<id>/previous-tia/, retrieves the ' +
      'archive, updates the source index and then: if the PLC is compiled, runs a forced sync and reports the pending ' +
      'change set for project_diff/project_commit; if it is not compiled, stops at awaiting_compile and leaves the ' +
      'project open for the user to compile. If TIA renamed the project because the other machine already had one with ' +
      'that name, it stops with handoff_project_name_changed before touching TIA; only after the user confirms may the ' +
      'caller re-run with accept_renamed_project: true, which keeps the archive name and records the change. It never ' +
      'compiles and never commits. Defaults to a plan (dry_run: true).',
    parameters: PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const resolvedScope: ResolvedScope = scope
        const root = resolvedScope.workspace.path
        const config = dependencies.config
        const service = engineeringAccess(dependencies.ctx)
        if (service === undefined) {
          throw new EngineeringContextError('tia_access_unavailable', 'This composition has no engineeringAccess service.', {
            service: 'engineeringAccess',
          })
        }
        if (typeof args.archive_path !== 'string' || args.archive_path.trim().length === 0) {
          throw new EngineeringContextError('invalid_argument', 'archive_path is required.')
        }
        const archivePath = await canonicalizeLoose(args.archive_path.trim())
        const archive = await readArchive(archivePath)
        if (archive.marker === null) {
          throw new EngineeringContextError(
            'handoff_marker_missing',
            `${archivePath} does not contain ${USERFILES_DIR}/${HANDOFF_MARKER_FILE}. Without the marker this build cannot ` +
              'tell which committed base the archive belongs to, so it refuses to import it.',
            { archive: archivePath },
          )
        }
        const archiveMarker = archive.marker
        const archiveMarkerText = archiveMarker.text
        const marker = parseMarker(archiveMarkerText, archiveMarker.entry)
        if (!/^17(?:\.|$)/u.test(marker.project.tiaVersion)) {
          throw new EngineeringContextError(
            'handoff_version_unsupported',
            `The marker names TIA Portal ${marker.project.tiaVersion}; this interface plugin only imports V17 handoffs.`,
            { tiaVersion: marker.project.tiaVersion },
          )
        }
        if (marker.devices.length !== 1) {
          throw new EngineeringContextError(
            'handoff_marker_invalid',
            `The archive carries ${marker.devices.length} devices; this build imports one PLC per workspace.`,
            { devices: marker.devices.map((entry) => entry.device) },
          )
        }
        const markerDevice = marker.devices[0]
        if (markerDevice === undefined) {
          throw new EngineeringContextError('handoff_marker_invalid', 'The marker names no device.')
        }
        if (archive.project === null) {
          throw new EngineeringContextError(
            'handoff_archive_invalid',
            `${archivePath} contains no root .ap17 project file; it is not a TIA project archive.`,
            { archive: archivePath },
          )
        }
        const ap17 = parseAp17Identity(archive.project.text, archive.project.entry)
        if (ap17.majorVersion !== 17) {
          throw new EngineeringContextError(
            'handoff_version_unsupported',
            `The archive is a TIA Portal ${ap17.tiaVersion} project. This interface plugin can only retrieve V17 archives.`,
            { project: ap17.name, tiaVersion: ap17.tiaVersion },
          )
        }
        const renamed = ap17.name.toLowerCase() !== marker.project.name.toLowerCase()
        if (renamed && args.accept_renamed_project !== true) {
          throw new EngineeringContextError(
            'handoff_project_name_changed',
            `The archive's project is ${ap17.name}, but its marker says ${marker.project.name}. TIA renames a project ` +
              'when the other machine already has one with that name; the evidence and device still belong to this ' +
              'handoff. If the user confirms this is the same project, re-run with accept_renamed_project: true. The ' +
              'imported project will use the archive name, and the workspace index will record the change.',
            {
              markerProject: marker.project.name,
              archiveProject: ap17.name,
              archive: archivePath,
              hint: 'Ask the user to confirm the rename; only then pass accept_renamed_project: true.',
            },
          )
        }

        await ensureRepository(root)
        const headNow = await headCommit(root)
        const session = normalizeSession(await service.readTiaSession({ signal: exec.signal }))
        const managedRoot = await managedDirectory(config, root, resolvedScope.workspace.title)
        if (session.projectOpen && session.projectPath !== null) {
          const current = await canonicalizeLoose(session.projectPath)
          if (!isInside(managedRoot, current)) {
            throw new EngineeringContextError(
              'handoff_project_outside_workspace',
              `TIA has ${session.projectPath} open, which is not this workspace's managed project (${managedRoot}). ` +
                'Close it before importing a handoff.',
              { openProject: session.projectPath, managedRoot },
            )
          }
          if (session.isModified !== false) {
            throw new EngineeringContextError(
              'handoff_project_modified',
              'TIA reports the open project as modified. Save it, or close it without saving, before replacing it with the ' +
                'returned archive.',
              { projectName: session.projectName, isModified: session.isModified },
            )
          }
        }

        const device = await deviceFromIndex(config, root, markerDevice.device, markerDevice.software)
        const existingRecord = await findRecord(config, root, marker.handoffId)
        const alreadyImported =
          existingRecord !== null &&
          (existingRecord.status === 'awaiting_compile' || existingRecord.status === 'imported') &&
          (session.projectPath === null ||
            isTheImportedProject(session.projectPath, managedRoot, existingRecord.project.name))

        const backupDirectory = join(localStateDirectoryPath(config, root), 'handoff-backups', marker.handoffId, 'previous-tia')
        const plan: HandoffImportPlan = {
          renamed,
          nameAccepted: args.accept_renamed_project === true,
          archive: {
            path: archivePath,
            bytes: archive.bytes.length,
            sha256: archive.sha256,
            projectName: ap17.name,
            tiaVersion: ap17.tiaVersion,
          },
          marker: {
            handoffId: marker.handoffId,
            createdAt: marker.createdAt,
            baseCommit: marker.git.head,
            branch: marker.git.branch,
            projectName: marker.project.name,
            devices: marker.devices.map((entry) => ({
              device: entry.device,
              software: entry.software,
              plcChecksum: entry.plcChecksum,
              stateId: entry.stateId,
              objectCount: entry.objectCount,
            })),
          },
          record: existingRecord,
          current: {
            head: headNow,
            sourceClean: true,
            projectOpen: session.projectOpen,
            projectName: session.projectName,
            projectPath: session.projectPath,
            isModified: session.isModified,
          },
          target: { projectDirectory: managedRoot, backupDirectory },
        }

        if (alreadyImported) {
          if (args.dry_run === false) {
            throw new EngineeringContextError(
              'handoff_already_imported',
              `Handoff ${marker.handoffId} was already imported (${existingRecord?.status}); this build will not move the ` +
                'returned project aside a second time.',
              { handoffId: marker.handoffId, status: existingRecord?.status },
            )
          }
          return okOutcome(
            HANDOFF_IMPORT_TOOL,
            scope.view,
            `Handoff ${marker.handoffId} is already imported (${existingRecord?.status}); do not import it again.`,
            {
              plan,
              alreadyImported: true,
              next:
                existingRecord?.status === 'awaiting_compile'
                  ? 'Compile the PLC in TIA, then run project_sync with force=true.'
                  : `The source tree is already synced; run project_diff and project_commit with reference: "handoff:${marker.handoffId}".`,
            },
            {
              dryRun: true,
              details: [
                `Handoff: ${marker.handoffId} — already ${existingRecord?.status}.`,
                `Project: ${session.projectName ?? marker.project.name} at ${session.projectPath ?? 'unknown'}.`,
                'Re-importing would move the returned project aside again; this build refuses that.',
              ],
              warnings: existingRecord?.status === 'awaiting_compile' ? ['The PLC is still uncompiled; project_sync will refuse until it is compiled.'] : [],
            },
          )
        }

        const verified = await verifyMarkerAgainstGit(root, marker, device)

        if (args.dry_run !== false) {
          return okOutcome(
            HANDOFF_IMPORT_TOOL,
            scope.view,
            `Dry run: would import ${marker.project.name} from ${headNow ?? 'no commit'} → base ${marker.git.head.slice(0, 12)}.`,
            { plan },
            {
              dryRun: true,
              details: [
                `Archive: ${toPortable(root, archivePath)} (${archive.bytes.length} bytes) — project ${ap17.name} (TIA ${ap17.tiaVersion}).`,
                `Marker: ${marker.handoffId}, base ${marker.git.head}${verified.branch === null ? '' : ` on ${verified.branch}`}, ${markerDevice.objectCount} object(s), checksum ${markerDevice.plcChecksum}.`,
                `Workspace: HEAD ${headNow ?? 'none'} — matches base.`,
                plan.renamed
                  ? `Name: marker ${marker.project.name} → archive ${ap17.name}; accepted by the user (the archive name becomes the managed name).`
                  : `Name: ${ap17.name} — matches the marker.`,
                `Close: ${session.projectOpen ? `TIA's ${session.projectName ?? 'open project'} (${session.projectPath ?? '?'})` : 'no project is open'}.`,
                `Backup: ${toPortable(root, backupDirectory)}/ (the old tia/<workspace>/ is moved, never deleted).`,
                'After retrieval: if the PLC is compiled, a forced sync writes the source tree and stops before commit; if not, the import stops at awaiting_compile.',
              ],
            },
          )
        }

        const outcome = await withLock(root, 'handoff-import', async () => {
          // Re-read the base under the lock: another turn may have committed since the plan.
          const liveHead = await headCommit(root)
          if (liveHead !== marker.git.head) {
            throw new EngineeringContextError(
              'handoff_workspace_advanced',
              `HEAD moved from the handoff base ${marker.git.head} to ${liveHead ?? 'none'} before the import could run.`,
              { base: marker.git.head, head: liveHead },
            )
          }
          // Re-read the session under the lock: the user may have changed it since the plan.
          const live = normalizeSession(await service.readTiaSession({ signal: exec.signal }))
          if (live.projectOpen) {
            if (live.isModified !== false) {
              throw new EngineeringContextError('handoff_project_modified', 'The open project changed to modified while the import was starting.', {
                projectName: live.projectName,
              })
            }
            if (typeof service.closeProject !== 'function') {
              throw new EngineeringContextError(
                'handoff_close_failed',
                'The TIA interface plugin has no closeProject method, so the open project cannot be closed before replacement.',
                { projectName: live.projectName },
              )
            }
            const closed = normalizeCall(
              await service.closeProject({ dryRun: false, save: false, closePortal: false, signal: exec.signal }),
            )
            if (!closed.ok) {
              throw new EngineeringContextError(
                'handoff_close_failed',
                `TIA refused to close the open project: ${(closed.error?.message ?? closed.summary) || 'no reason reported'}.`,
                { projectName: live.projectName },
              )
            }
          }

          const oldProjectExists = await pathExists(managedRoot)
          let backedUp = false
          if (oldProjectExists) {
            if (await pathExists(backupDirectory)) {
              throw new EngineeringContextError(
                'handoff_already_imported',
                `The backup ${backupDirectory} already exists for handoff ${marker.handoffId}. This build will not ` +
                  'overwrite a previous import; use a fresh handoff or inspect the existing package.',
                { handoffId: marker.handoffId, backupDirectory },
              )
            }
            await mkdir(dirname(backupDirectory), { recursive: true })
            await moveWithRetry(managedRoot, backupDirectory)
            backedUp = true
          }
          await mkdir(managedRoot, { recursive: true })

          let retrievedRaw: unknown
          try {
            retrievedRaw = await service.retrieveProject?.(archivePath, managedRoot, {
              withWindow: args.with_window !== false,
              upgrade: false,
              openMode: 'primary',
              signal: exec.signal,
            })
          } catch (error) {
            await restoreOld()
            throw new EngineeringContextError(
              'handoff_retrieve_failed',
              `Retrieving ${archivePath} failed at the transport level: ${error instanceof Error ? error.message : String(error)}. ` +
                'The old project was restored.',
              { archive: archivePath },
            )
          }
          if (retrievedRaw === undefined) {
            await restoreOld()
            throw new EngineeringContextError(
              'retrieve_unsupported',
              'The TIA interface plugin has no retrieveProject method, so the archive cannot be retrieved.',
              { method: 'engineeringAccess.retrieveProject' },
            )
          }
          const retrieved = normalizeRetrieve(retrievedRaw, archivePath, managedRoot)
          if (!retrieved.ok) {
            await restoreOld()
            throw new EngineeringContextError(
              'handoff_retrieve_failed',
              `TIA refused to retrieve ${archivePath}: ${(retrieved.error?.message ?? retrieved.summary) || 'no reason reported'}. ` +
                'The old project was restored.',
              { archive: archivePath, code: retrieved.error?.code ?? null },
            )
          }
          const projectPath = retrieved.projectPath ?? (await findProjectFile(managedRoot))
          if (projectPath === null) {
            await restoreOld()
            throw new EngineeringContextError(
              'handoff_retrieve_failed',
              `TIA reported a successful retrieval of ${archivePath}, but no .ap17 file exists below ${managedRoot}.`,
              { archive: archivePath, managedRoot },
            )
          }
          const canonicalProject = await canonicalizeLoose(projectPath)
          if (!isInside(managedRoot, canonicalProject)) {
            await restoreOld()
            throw new EngineeringContextError(
              'handoff_project_mismatch',
              `TIA extracted the project to ${canonicalProject}, outside ${managedRoot}.`,
              { projectPath: canonicalProject, managedRoot },
            )
          }
          const projectName = retrieved.projectName ?? basename(canonicalProject, '.ap17')
          const acceptAnyName = args.accept_renamed_project === true
          if (projectName.length === 0) {
            await restoreOld()
            throw new EngineeringContextError(
              'project_name_unavailable',
              'TIA retrieved the project but reported no usable project name. The old project was restored.',
              { projectPath: canonicalProject },
            )
          }
          if (!acceptAnyName && projectName.toLowerCase() !== marker.project.name.toLowerCase()) {
            await restoreOld()
            throw new EngineeringContextError(
              'handoff_project_name_changed',
              `TIA retrieved ${projectName}, but the handoff marker says ${marker.project.name}. If the user confirms this ` +
                'is a TIA rename of the same project, re-run with accept_renamed_project: true; the old project was restored.',
              { retrieved: projectName, marker: marker.project.name, hint: 'Ask the user, then pass accept_renamed_project: true.' },
            )
          }

          // Restore the marker into the extracted project if TIA did not carry it.
          const userFiles = join(dirname(canonicalProject), USERFILES_DIR)
          await mkdir(userFiles, { recursive: true })
          const extractedMarker = join(userFiles, HANDOFF_MARKER_FILE)
          if (!(await pathExists(extractedMarker))) {
            await writeFile(extractedMarker, archiveMarkerText, 'utf8')
          }

          let indexBackup: string | null = null
          const indexFile = sourceIndexPath(config, root)
          try {
            const updated = await updateIndex(config, root, marker.handoffId, {
              projectName,
              projectPath: canonicalProject,
              archivePath,
              projectDirectory: managedRoot,
            })
            indexBackup = updated.backup
          } catch (error) {
            await restoreOld(indexFile, indexBackup)
            throw error
          }

          // Resolve the device from the now-open retrieved project. If this fails,
          // the project is not usable for the workflow; restore the old one.
          let nextDevice: DeviceInfo
          try {
            nextDevice = await resolveDeviceFromTia(resolvedScope, service, exec)
          } catch (error) {
            await restoreOld(indexFile, indexBackup)
            throw error
          }

          let checksumReport: ChecksumReport
          try {
            checksumReport = normalizeChecksum(
              await (service.readPlcChecksum?.({
                deviceName: nextDevice.device,
                softwareName: nextDevice.software,
                signal: exec.signal,
              }) ?? Promise.resolve({ ok: false, error: { code: 'checksum_unavailable', message: 'no readPlcChecksum' } })),
            )
          } catch (error) {
            checksumReport = {
              ok: false,
              checksum: null,
              device: nextDevice.device,
              software: nextDevice.software,
              error: { code: 'tia_unreachable', message: error instanceof Error ? error.message : String(error), details: null },
              summary: '',
            }
          }

          let syncResult: Awaited<ReturnType<typeof runSyncUnlocked>> | null = null
          let status: HandoffRecord['status'] = 'awaiting_compile'
          let syncError: string | null = null
          if (checksumReport.ok && checksumReport.checksum !== null) {
            try {
              syncResult = await runSyncUnlocked(resolvedScope, service, nextDevice, exec, { forceScan: true })
              status = 'imported'
            } catch (error) {
              if (error instanceof EngineeringContextError && error.code === 'needs_compile') {
                status = 'awaiting_compile'
              } else {
                status = 'import_failed'
                syncError = error instanceof Error ? error.message : String(error)
              }
            }
          } else if (checksumReport.error?.code !== 'checksum_unavailable') {
            status = 'import_failed'
            syncError = checksumReport.error?.message ?? checksumReport.summary ?? 'the PLC checksum could not be read'
          }

          const archiveRelative = isInside(root, archivePath) ? toPortable(root, archivePath) : archivePath
          const baseRecord: HandoffRecord =
            existingRecord ?? {
              schemaVersion: HANDOFF_SCHEMA_VERSION,
              kind: 'dsh-tia-handoff-record',
              handoffId: marker.handoffId,
              status: 'returned',
              createdAt: marker.createdAt,
              workspace: resolvedScope.workspace.title ?? basename(root),
              note: null,
              nameChange: null,
              base: { commit: marker.git.head, branch: verified.branch, sourceClean: true },
              project: {
                name: marker.project.name,
                tiaVersion: marker.project.tiaVersion,
                device: markerDevice.device,
                software: markerDevice.software,
              },
              archive: {
                path: archiveRelative,
                sha256: archive.sha256,
                bytes: archive.bytes.length,
                mode: HANDOFF_ARCHIVE_MODE,
              },
              marker: { path: '', sha256: sha256Hex(archiveMarkerText) },
              backup: null,
              returned: null,
              import: null,
            }
          const nameChanged = projectName.toLowerCase() !== marker.project.name.toLowerCase()
          const updatedRecord: HandoffRecord = {
            ...baseRecord,
            status,
            nameChange: nameChanged
              ? { from: marker.project.name, to: projectName, acceptedAt: new Date().toISOString() }
              : (existingRecord?.nameChange ?? null),
            returned: {
              path: archivePath,
              sha256: archive.sha256,
              bytes: archive.bytes.length,
              at: new Date().toISOString(),
            },
            backup: backedUp ? { path: toPortable(root, backupDirectory), present: true } : null,
            import: {
              projectPath: toPortable(root, canonicalProject),
              checksum: checksumReport.checksum ?? null,
              changed: syncResult?.counts.changed ?? null,
              added: syncResult?.counts.added ?? null,
              removed: syncResult?.counts.removed ?? null,
              pendingPaths: syncResult?.pending.paths.length ?? 0,
              syncedAt: syncResult === null ? null : new Date().toISOString(),
              note: typeof args.note === 'string' && args.note.trim().length > 0 ? args.note.trim() : null,
              error: syncError,
            },
          }
          const packageDirectory = handoffPackageDirectory(config, root, marker.handoffId)
          await mkdir(packageDirectory, { recursive: true })
          await writeRecord(handoffRecordPath(config, root, marker.handoffId), updatedRecord)
          await writeFile(handoffMarkerCopyPath(config, root, marker.handoffId), archiveMarkerText, 'utf8')
          await writeFile(handoffTextPath(config, root, marker.handoffId), handoffInstructions(updatedRecord), 'utf8')
          const ignore = await ensureHandoffIgnore(root, dependencies.config)
          return {
            record: updatedRecord,
            status,
            projectPath: canonicalProject,
            projectName,
            device: nextDevice,
            checksum: checksumReport.checksum,
            sync: syncResult,
            syncError,
            backup: backedUp ? backupDirectory : null,
            ignore,
          }

          async function restoreOld(restoreIndexFile?: string, restoreIndexBackup?: string | null): Promise<void> {
            try {
              if (await pathExists(managedRoot)) {
                const failed = join(dirname(backupDirectory), `failed-import-${Date.now()}`)
                await moveWithRetry(managedRoot, failed)
              }
              if (backedUp && (await pathExists(backupDirectory))) {
                await moveWithRetry(backupDirectory, managedRoot)
              }
              if (restoreIndexFile !== undefined) await restoreIndex(restoreIndexFile, restoreIndexBackup ?? null)
            } catch (error) {
              throw new EngineeringContextError(
                'handoff_restore_failed',
                `The retrieval failed and the old project could not be restored from ${backupDirectory}: ` +
                  `${error instanceof Error ? error.message : String(error)}. The backup is still on disk.`,
                { backupDirectory, managedRoot },
              )
            }
          }
        })

        const details = [
          `Project: ${outcome.projectName} at ${toPortable(root, outcome.projectPath)}.`,
          `Handoff: ${marker.handoffId} — base ${marker.git.head}, archive ${archive.sha256.slice(0, 16)}….`,
          `PLC: ${outcome.device.device} / ${outcome.device.software}; checksum ${outcome.checksum ?? 'unavailable'}.`,
          outcome.record.nameChange === null || outcome.record.nameChange === undefined
            ? `Name: ${outcome.projectName}.`
            : `Name: ${outcome.record.nameChange.from} → ${outcome.record.nameChange.to} (TIA rename accepted; index updated).`,
          outcome.backup === null
            ? 'Backup: no previous project directory was present.'
            : `Backup: ${toPortable(root, outcome.backup)}/ (kept; never deleted automatically).`,
          `Ignore: ${outcome.ignore.action} ${toPortable(root, outcome.ignore.file)} (${outcome.ignore.rule}).`,
        ]
        let summary: string
        if (outcome.status === 'awaiting_compile') {
          summary = `Imported ${outcome.projectName}, but the PLC is not compiled. Compile it in TIA, then run project_sync with force=true.`
          details.push('Stopped before project_sync: the PLC has no compiled checksum. This build does not compile automatically.')
        } else if (outcome.status === 'imported') {
          const sync = outcome.sync
          summary =
            sync !== null && sync.unchanged
              ? `Imported ${outcome.projectName}; the source tree already matched the returned project.`
              : `Imported ${outcome.projectName} and synced the source tree; the change set is pending review and commit.`
          details.push(
            sync === null
              ? 'Sync: no scan was run.'
              : `Sync: ${sync.counts.changed} changed, ${sync.counts.added} added, ${sync.counts.removed} removed; ${sync.pending.paths.length} path(s) pending.`,
            ...(sync === null ? [] : [`Suggested message: ${sync.pending.suggestedMessage.split(/\r?\n/u)[0] ?? ''}`]),
            'Next: run project_diff on the WORKTREE, read the change set, then project_commit with the reason AND ' +
              `reference: "handoff:${marker.handoffId}" so the commit's Reference trailer records which handoff produced it.`,
          )
        } else {
          summary = `Imported ${outcome.projectName}, but syncing failed: ${outcome.syncError ?? 'unknown error'}. The old project is backed up.`
          details.push('The new project is left in place for inspection; the backup is kept.')
        }
        return okOutcome(
          HANDOFF_IMPORT_TOOL,
          scope.view,
          summary,
          {
            handoffId: marker.handoffId,
            status: outcome.status,
            project: { name: outcome.projectName, path: toPortable(root, outcome.projectPath) },
            device: outcome.device,
            checksum: outcome.checksum,
            backup: outcome.backup === null ? null : { path: toPortable(root, outcome.backup), present: true },
            sync:
              outcome.sync === null
                ? null
                : {
                    unchanged: outcome.sync.unchanged,
                    counts: outcome.sync.counts,
                    pending: outcome.sync.pending,
                    stateId: outcome.sync.stateId,
                  },
            record: outcome.record,
            error: outcome.syncError,
          },
          {
            details,
            warnings: [
              ...(outcome.status === 'import_failed' ? [outcome.syncError ?? 'The import did not complete cleanly.'] : []),
              ...(outcome.sync?.scanSkipped === true
                ? ['The TIA interface plugin skipped the scan even though force=true was requested; safety-program-only changes may not be in this diff.']
                : []),
            ],
          },
        )
      } catch (error) {
        return failedOutcome(HANDOFF_IMPORT_TOOL, scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}
