/**
 * `handoff_export` — seal the open project into a TIA archive plus a marker.
 *
 * The tool is intentionally strict about what it will seal:
 *
 * - TIA must hold **this workspace's** project, saved and compiled;
 * - a **forced** sync must report `unchanged` (the checksum alone cannot see a
 *   change confined to the safety program);
 * - `HEAD` and the evidence ledger at `HEAD` must agree with the open project;
 * - the archive it just wrote must actually contain `UserFiles/_dsh-handoff.json`,
 *   the marker it wrote a moment earlier.
 *
 * Only then is anything handed off. A dirty source tree is not committed here:
 * the caller runs `project_diff` and `project_commit` first, exactly as in the
 * normal version workflow.
 *
 * @module dsh-engineering-context/tools/handoff-export
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { engineeringAccess, normalizeCall, normalizeSession, projectArchiveAccess } from '../access.js'
import { projectDirectoryPath } from '../config.js'
import { resolveDeviceFromTia } from '../device.js'
import { EngineeringContextError } from '../errors.js'
import { canonicalizeLoose, folderName, isInside, toPortable } from '../paths.js'
import { resolveScope, type ResolvedScope } from '../scope.js'
import { ensureRepository, gitPath, headCommit, runGit, showFileAtRevision, statusPaths } from '../git.js'
import { withLock } from '../lock.js'
import { runSyncUnlocked } from '../sync.js'
import { buildMarker, markerText, parseMarker, record, sameMarker, sha256Hex, text } from '../handoff/marker.js'
import {
  archiveFileName,
  ensureHandoffIgnore,
  handoffInstructions,
  handoffMarkerCopyPath,
  handoffPackageDirectory,
  handoffRecordPath,
  handoffTextPath,
  newHandoffId,
  portableRelative,
  writeRecord,
} from '../handoff/record.js'
import { parseAp17Identity, readArchive } from '../handoff/zip.js'
import {
  HANDOFF_ARCHIVE_MODE,
  HANDOFF_MARKER_FILE,
  HANDOFF_SCHEMA_VERSION,
  type HandoffExportPlan,
  type HandoffRecord,
} from '../handoff/types.js'
import type { ToolDependencies } from './deps.js'
import { defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

/** The tool name. */
export const HANDOFF_EXPORT_TOOL = 'handoff_export'

const PARAMETERS = {
  dry_run: {
    type: 'boolean',
    description:
      'Default true: read the project, the base commit and the evidence ledger, and report what would be sealed without ' +
      'writing anything. Pass false to force-sync, write the marker, archive and record the package.',
  },
  note: {
    type: 'string',
    description: 'Optional one-line note stored in handoff.json (recipient, ticket, why the project is going out).',
  },
} as const

/** Whether a path is a regular file. */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** The current branch, or null when HEAD is detached/unborn. */
async function branchOf(root: string): Promise<string | null> {
  const result = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (result.code !== 0) return null
  const value = result.stdout.trim()
  return value.length === 0 || value === 'HEAD' ? null : value
}

/** Read the committed ledger of one device at one revision. */
async function evidenceAt(root: string, head: string, deviceDirectory: string): Promise<Record<string, unknown>> {
  const relative = `${gitPath(root, deviceDirectory)}/_evidence.json`
  const raw = await showFileAtRevision(root, head, relative)
  if (raw === null) {
    throw new EngineeringContextError(
      'not_synced',
      `Commit ${head} has no ${relative}. Sync and commit the source tree before handing it off.`,
      { head, path: relative },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new EngineeringContextError('evidence_invalid', `${relative} at ${head} is not valid JSON.`, {
      head,
      path: relative,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const document = record(parsed)
  if (document === null) {
    throw new EngineeringContextError('evidence_invalid', `${relative} at ${head} is not a JSON object.`, {
      head,
      path: relative,
    })
  }
  return document
}

/**
 * Build the export tool.
 *
 * @param dependencies - the plugin dependencies.
 */
export function handoffExportTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: HANDOFF_EXPORT_TOOL,
    description:
      'Seal the project TIA has open into a TIA Portal V17 archive for another engineer, together with a provenance ' +
      'marker at UserFiles/_dsh-handoff.json. It first proves the open project is this workspace project, saved and ' +
      'compiled, then runs a forced sync and refuses if the source tree differs from HEAD. The archive is written to ' +
      '<workspace>/handoff/<handoffId>/<project>_<yyyyMMdd-HHmm>.zap17 with mode "compressed"; the same directory gets ' +
      'handoff.json, HANDOFF.txt and marker.json. It verifies the marker is readable from the archive before reporting ' +
      'success. It does not commit a dirty source tree: run project_diff and project_commit first if the forced sync ' +
      'reports changes. Defaults to a plan (dry_run: true).',
    parameters: PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const resolvedScope: ResolvedScope = scope
        const root = resolvedScope.workspace.path
        const service = engineeringAccess(dependencies.ctx)
        if (service === undefined) {
          throw new EngineeringContextError(
            'tia_access_unavailable',
            'This composition has no engineeringAccess service, so TIA cannot be reached.',
            { service: 'engineeringAccess' },
          )
        }
        const texts = projectArchiveAccess(dependencies.ctx)
        if (texts === undefined || typeof texts.archiveProject !== 'function') {
          throw new EngineeringContextError(
            'project_text_access_unavailable',
            'This composition has no projectTextAccess service with archiveProject, so the project cannot be archived.',
            { service: 'projectTextAccess' },
          )
        }

        const session = normalizeSession(await service.readTiaSession({ signal: exec.signal }))
        if (!session.running) {
          throw new EngineeringContextError('tia_controller_not_running', session.reason ?? 'The TIA controller is not running.')
        }
        if (!session.projectOpen) {
          throw new EngineeringContextError('tia_project_not_open', 'TIA Portal has no project open, so there is nothing to hand off.')
        }
        if (session.isModified !== false) {
          throw new EngineeringContextError(
            'handoff_project_modified',
            'TIA reports the open project as modified (or does not report its saved state). Save it, compile the PLC and ' +
              'sync the source tree before handing it off.',
            { projectName: session.projectName, isModified: session.isModified },
          )
        }
        const projectPath = session.projectPath
        if (projectPath === null) {
          throw new EngineeringContextError('project_name_unavailable', 'TIA did not report the open project path.')
        }
        const projectDirectory = dirname(projectPath)
        const workspaceName = folderName((resolvedScope.workspace.title ?? '').trim() || basename(root))
        const managedRoot = await canonicalizeLoose(projectDirectoryPath(dependencies.config, root, workspaceName))
        const canonicalProject = await canonicalizeLoose(projectPath)
        if (!isInside(managedRoot, canonicalProject)) {
          throw new EngineeringContextError(
            'handoff_project_outside_workspace',
            `The project TIA has open is ${projectPath}, which is not inside this workspace's managed project directory ` +
              `${managedRoot}. This tool only hands off the project this workspace manages.`,
            { projectPath, managedRoot },
          )
        }

        const ap17Text = await readFile(projectPath, 'utf8')
        const ap17 = parseAp17Identity(ap17Text, projectPath)
        if (ap17.majorVersion !== 17) {
          throw new EngineeringContextError(
            'handoff_version_unsupported',
            `${ap17.name} is a TIA Portal ${ap17.tiaVersion} project. This interface plugin can only hand off and retrieve V17 ` +
              'projects.',
            { project: ap17.name, tiaVersion: ap17.tiaVersion },
          )
        }

        await ensureRepository(root)
        const head = await headCommit(root)
        if (head === null) {
          throw new EngineeringContextError('repository_not_found', 'The workspace repository has no commit yet; create and commit the project first.')
        }
        const device = await resolveDeviceFromTia(scope, service, exec)
        const deviceRelative = gitPath(root, device.directory)
        const dirty = await statusPaths(root, [deviceRelative])
        if (dirty.length > 0) {
          throw new EngineeringContextError(
            'handoff_source_dirty',
            `The source tree ${deviceRelative} has uncommitted changes. Run project_diff and project_commit first; the ` +
              'handoff must describe a committed base.',
            { paths: dirty },
          )
        }
        const evidence = await evidenceAt(root, head, device.directory)
        const now = new Date()
        const branch = await branchOf(root)
        const handoffId = newHandoffId(now)
        const marker = buildMarker({
          handoffId,
          createdAt: now.toISOString(),
          head,
          branch,
          projectName: ap17.name,
          tiaVersion: ap17.tiaVersion,
          devices: [{ device: device.device, software: device.software, evidence }],
        })
        const packageDirectory = handoffPackageDirectory(dependencies.config, root, handoffId)
        const archiveName = archiveFileName(marker.project.name, now)
        const archivePath = join(packageDirectory, archiveName)
        const userFiles = join(projectDirectory, 'UserFiles')
        const markerPath = join(userFiles, HANDOFF_MARKER_FILE)

        const plan: HandoffExportPlan = {
          project: {
            name: marker.project.name,
            tiaVersion: marker.project.tiaVersion,
            device: device.device,
            software: device.software,
            projectPath,
            projectDirectory,
            userFiles,
            markerPath,
          },
          base: { commit: head, branch },
          state: {
            plcChecksum: marker.devices[0]?.plcChecksum ?? '',
            stateId: marker.devices[0]?.stateId ?? '',
            sourceIdentity: marker.devices[0]?.sourceIdentity ?? '',
            objectCount: marker.devices[0]?.objectCount ?? 0,
          },
          handoffId,
          directory: packageDirectory,
          archivePath,
        }

        if (args.dry_run !== false) {
          return okOutcome(
            HANDOFF_EXPORT_TOOL,
            scope.view,
            `Dry run: would seal ${marker.project.name} at ${head.slice(0, 12)} into ${toPortable(root, archivePath)}.`,
            {
              plan,
              marker: { path: toPortable(root, markerPath), bytes: Buffer.byteLength(markerText(marker), 'utf8') },
              note: args.note ?? null,
            },
            {
              dryRun: true,
              details: [
                `Project: ${marker.project.name} (${marker.project.tiaVersion}) — ${device.device} / ${device.software}`,
                `Base: ${head}${branch === null ? '' : ` on ${branch}`}`,
                `State: ${plan.state.objectCount} object(s), checksum ${plan.state.plcChecksum || 'unknown'}, state ${plan.state.stateId || 'unknown'}.`,
                `Marker: ${toPortable(root, markerPath)} (inside UserFiles; travels with the archive).`,
                `Archive: ${toPortable(root, archivePath)} — mode ${HANDOFF_ARCHIVE_MODE}.`,
                'Run: a forced sync must report unchanged; then the marker is written, the archive is created, and the marker is read back from the ZIP.',
              ],
            },
          )
        }

        const finished = await withLock(root, 'handoff-export', async () => {
          const currentHead = await headCommit(root)
          if (currentHead !== head) {
            throw new EngineeringContextError(
              'handoff_workspace_advanced',
              `HEAD moved from ${head} to ${currentHead ?? 'none'} while export was starting. Nothing was written.`,
              { expected: head, head: currentHead },
            )
          }
          const sync = await runSyncUnlocked(resolvedScope, service, device, exec, { forceScan: true })
          // The controller's full-scan path reports `unchanged:false` even when it
          // found nothing: `force_scan` deliberately bypasses the checksum fast
          // path, and the scan always writes its STAGE ledger. The truth that
          // matters here is "no object changed and no path is dirty", not the
          // controller's execution-mode flag. A forced scan of an identical tree
          // therefore counts as verified when all three deltas are zero and the
          // promoted ledger left the working tree clean.
          const scannedClean =
            sync.counts.changed === 0 &&
            sync.counts.added === 0 &&
            sync.counts.removed === 0 &&
            sync.pending.paths.length === 0
          if (!sync.unchanged && !scannedClean) {
            throw new EngineeringContextError(
              'handoff_source_dirty',
              'The forced sync found changes that are not in the commit being handed off. Run project_diff and ' +
                'project_commit, then export again.',
              {
                counts: sync.counts,
                pending: sync.pending.paths,
                suggestedMessage: sync.pending.suggestedMessage,
              },
            )
          }
          if (sync.scanSkipped) {
            throw new EngineeringContextError(
              'handoff_force_scan_unsupported',
              'The installed TIA interface plugin skipped the scan even though force=true was requested. A change confined ' +
                'to the safety program would not be visible, so this build refuses to seal the project as verified.',
              { project: marker.project.name, checksum: sync.checksum },
            )
          }

          const ignore = await ensureHandoffIgnore(root, dependencies.config)
          await mkdir(userFiles, { recursive: true })
          const markerDocument = markerText(marker)
          await writeFile(markerPath, markerDocument, 'utf8')
          await mkdir(packageDirectory, { recursive: true })
          const canonicalPackage = await canonicalizeLoose(packageDirectory)

          const archived = normalizeCall(
            await texts.archiveProject({
              targetDir: packageDirectory,
              targetName: archiveName,
              mode: HANDOFF_ARCHIVE_MODE,
              signal: exec.signal,
            }),
          )
          if (!archived.ok) {
            throw new EngineeringContextError(
              'handoff_archive_failed',
              `TIA refused to archive ${marker.project.name}: ${(archived.error?.message ?? archived.summary) || 'no reason reported'}. ` +
                'The marker is in UserFiles; nothing was recorded as a handoff.',
              { project: marker.project.name, archivePath },
            )
          }
          const reported = text(archived.data?.['archivedPath'])
          const actualArchive =
            reported === null ? archivePath : isAbsolute(reported) ? reported : join(packageDirectory, reported)
          const canonicalArchive = await canonicalizeLoose(actualArchive)
          if (!isInside(canonicalPackage, canonicalArchive)) {
            throw new EngineeringContextError(
              'handoff_archive_failed',
              `TIA reported the archive at ${actualArchive}, outside the handoff package ${packageDirectory}.`,
              { reported: actualArchive, packageDirectory },
            )
          }
          if (!(await isFile(canonicalArchive))) {
            throw new EngineeringContextError(
              'handoff_archive_failed',
              `TIA did not write a file at ${canonicalArchive}. Use archive mode "${HANDOFF_ARCHIVE_MODE}" (a folder is not a ` +
                '`.zap17`).',
              { archivePath: canonicalArchive, mode: HANDOFF_ARCHIVE_MODE },
            )
          }
          const read = await readArchive(canonicalArchive)
          if (read.marker === null) {
            throw new EngineeringContextError(
              'handoff_marker_missing',
              `The archive ${canonicalArchive} does not contain UserFiles/${HANDOFF_MARKER_FILE}. TIA did not carry the marker; ` +
                'this package is not safe to hand off. The archive is kept for inspection.',
              { archivePath: canonicalArchive, entries: read.entries.slice(0, 20) },
            )
          }
          const fromArchive = parseMarker(read.marker.text, read.marker.entry)
          if (!sameMarker(fromArchive, marker)) {
            throw new EngineeringContextError(
              'handoff_marker_invalid',
              `The marker read back from ${read.marker.entry} differs from the one written to ${markerPath}.`,
              { archivePath: canonicalArchive, entry: read.marker.entry },
            )
          }
          if (read.project === null) {
            throw new EngineeringContextError(
              'handoff_archive_invalid',
              `The archive ${canonicalArchive} contains no root .ap17 project file.`,
              { archivePath: canonicalArchive },
            )
          }
          const archivedAp17 = parseAp17Identity(read.project.text, read.project.entry)
          if (archivedAp17.name !== marker.project.name || archivedAp17.majorVersion !== 17) {
            throw new EngineeringContextError(
              'handoff_project_mismatch',
              `The archive's project is ${archivedAp17.name} (TIA ${archivedAp17.tiaVersion}), but the marker says ` +
                `${marker.project.name} (TIA ${marker.project.tiaVersion}).`,
              { project: archivedAp17, marker: marker.project },
            )
          }

          const archiveBase = basename(canonicalArchive)
          const archiveRelative = portableRelative(dependencies.config, handoffId, archiveBase)
          const markerRelative = portableRelative(dependencies.config, handoffId, 'marker.json')
          const recordDocument: HandoffRecord = {
            schemaVersion: HANDOFF_SCHEMA_VERSION,
            kind: 'dsh-tia-handoff-record',
            handoffId,
            status: 'issued',
            createdAt: marker.createdAt,
            workspace: resolvedScope.workspace.title ?? basename(root),
            note: typeof args.note === 'string' && args.note.trim().length > 0 ? args.note.trim() : null,
            nameChange: null,
            base: { commit: head, branch, sourceClean: true },
            project: {
              name: marker.project.name,
              tiaVersion: marker.project.tiaVersion,
              device: device.device,
              software: device.software,
            },
            archive: {
              path: archiveRelative,
              sha256: read.sha256,
              bytes: read.bytes.length,
              mode: HANDOFF_ARCHIVE_MODE,
            },
            marker: {
              path: markerRelative,
              sha256: sha256Hex(markerDocument),
            },
            backup: null,
            returned: null,
            import: null,
          }
          await writeRecord(handoffRecordPath(dependencies.config, root, handoffId), recordDocument)
          await writeFile(handoffMarkerCopyPath(dependencies.config, root, handoffId), markerDocument, 'utf8')
          await writeFile(handoffTextPath(dependencies.config, root, handoffId), handoffInstructions(recordDocument), 'utf8')
          return { record: recordDocument, ignore, archivePath: canonicalArchive, entries: read.entries.length }
        })

        return okOutcome(
          HANDOFF_EXPORT_TOOL,
          scope.view,
          `Sealed ${marker.project.name} into ${toPortable(root, finished.archivePath)} (handoff ${handoffId}).`,
          {
            handoffId,
            plan,
            archive: {
              path: toPortable(root, finished.archivePath),
              name: basename(finished.archivePath),
              sha256: finished.record.archive.sha256,
              bytes: finished.record.archive.bytes,
              mode: HANDOFF_ARCHIVE_MODE,
              entries: finished.entries,
            },
            record: finished.record,
            ignore: {
              file: toPortable(root, finished.ignore.file),
              action: finished.ignore.action,
              rule: finished.ignore.rule,
              added: finished.ignore.added,
            },
            next: 'Send the .zap17 file. When it comes back, give handoff_import its path.',
          },
          {
            details: [
              `Archive: ${toPortable(root, finished.archivePath)} (${finished.record.archive.bytes} bytes, sha256 ${finished.record.archive.sha256.slice(0, 16)}…).`,
              `Package: ${toPortable(root, packageDirectory)}/`,
              `Base: ${head} — ${marker.devices[0]?.objectCount ?? 0} object(s), checksum ${marker.devices[0]?.plcChecksum ?? 'unknown'}.`,
              `Marker verified inside the archive at ${HANDOFF_MARKER_FILE} under UserFiles.`,
              `Ignore: ${finished.ignore.action} ${toPortable(root, finished.ignore.file)} (${finished.ignore.rule}).`,
              'Keep the workspace at this commit until the project comes back; v1 does not merge local changes.',
            ],
          },
        )
      } catch (error) {
        return failedOutcome(HANDOFF_EXPORT_TOOL, scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}


