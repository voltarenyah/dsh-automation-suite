/**
 * `project_status` — where the workspace stands, without writing anything.
 *
 * The expensive checksum read is opt-in (`verify: true`): a status call is cheap
 * unless the caller explicitly asks whether TIA still matches the ledger. The
 * result always says which of the three views (TIA / source / git) is known, so a
 * model cannot mistake "not checked" for "clean".
 *
 * @module dsh-engineering-context/tools/status
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { engineeringAccess, normalizeChecksum, type EngineeringAccessLike } from '../access.js'
import { evidencePathForDevice, manifestPathForDevice } from '../config.js'
import type { DeviceInfo } from '../device.js'
import { resolveDevice } from '../device.js'
import { EngineeringContextError } from '../errors.js'
import { presentObjects, readEvidence, type EvidenceDocument } from '../evidence.js'
import { gitPath, runGit, statusPaths } from '../git.js'
import { readLock } from '../lock.js'
import { describePath, resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

/** The tool name, used by the registrar and the tests. */
export const PROJECT_STATUS_TOOL = 'project_status'

const PARAMETERS = {
  verify: {
    type: 'boolean',
    description:
      'Default false. True reads the PLC checksum from TIA (about 3–8 s) and reports whether TIA still matches the evidence ledger; ' +
      'false reports the last known checksum and marks it as not checked.',
  },
} as const

function evidenceSummary(document: EvidenceDocument | null): Record<string, unknown> | null {
  if (document === null) return null
  const present = presentObjects(document)
  return {
    device: document.device,
    software: document.software,
    plcChecksum: document.plcChecksum,
    stateId: document.stateId,
    objects: document.objects.size,
    present: present.length,
    unexportable: document.objects.size - present.length,
    tombstones: document.tombstones.length,
  }
}

async function readEvidenceOrInvalid(file: string): Promise<{ document: EvidenceDocument | null; error: unknown }> {
  try {
    return { document: await readEvidence(file), error: null }
  } catch (error) {
    return { document: null, error }
  }
}

/**
 * Build the status tool.
 * @param dependencies - the plugin dependencies.
 */
export function statusTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: PROJECT_STATUS_TOOL,
    description:
      'Report the state of the workspace engineering project without writing anything: which PLC the source tree belongs to, whether the ' +
      'evidence ledger and manifest are present, what git sees for the device directory, and whether a lock is held. ' +
      'Pass verify=true to also read the PLC checksum from TIA (a few seconds) and learn whether TIA still matches the ledger; ' +
      'without it the checksum is reported as NOT CHECKED, never as clean. The result names the next action (open_project, compile, sync, ' +
      'commit, clean) — this tool never performs it.',
    parameters: PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const root = scope.workspace.path
        const service: EngineeringAccessLike | undefined = engineeringAccess(dependencies.ctx)
        if (service === undefined) {
          throw new EngineeringContextError(
            'tia_access_unavailable',
            'This composition has no engineeringAccess service, so TIA cannot be reached. Install the TIA interface plugin.',
            { service: 'engineeringAccess' },
          )
        }

        let device: DeviceInfo | null = null
        let tia: Record<string, unknown> = { projectOpen: false }
        try {
          device = await resolveDevice(scope, service, exec)
          tia = { projectOpen: true, device: device.device, software: device.software }
        } catch (error) {
          if (!(error instanceof EngineeringContextError)) throw error
          if (!['tia_project_not_open', 'tia_controller_not_running', 'device_not_found', 'multiple_plc_unsupported'].includes(error.code)) {
            throw error
          }
          // "No usable PLC" is not the same as "no project open": a multi-PLC
          // project is open, this slice just refuses to choose one.
          const projectOpen = error.code === 'device_not_found' || error.code === 'multiple_plc_unsupported'
          tia = { projectOpen, code: error.code, reason: error.message }
        }

        const evidenceFile = device === null ? null : evidencePathForDevice(device.directory)
        const manifestFile = device === null ? null : manifestPathForDevice(device.directory)
        const evidenceRead = evidenceFile === null
          ? { document: null, error: null }
          : await readEvidenceOrInvalid(evidenceFile)
        const evidence = evidenceRead.document
        const evidenceInvalid = evidenceRead.error !== null
        const manifestPresent = manifestFile !== null ? (await describePath(root, manifestFile)).kind === 'file' : false

        let checksum: Record<string, unknown> = {
          state: 'not-checked',
          value: null,
          lastKnown: evidence?.plcChecksum ?? null,
          error: null,
        }
        if (args.verify === true && device !== null) {
          if (typeof service.readPlcChecksum !== 'function') {
            checksum = {
              state: 'unavailable',
              value: null,
              lastKnown: evidence?.plcChecksum ?? null,
              error: { code: 'tia_access_unavailable', message: 'the interface plugin has no readPlcChecksum method' },
            }
          } else {
            const report = normalizeChecksum(
              await service.readPlcChecksum({
                deviceName: device.device,
                softwareName: device.software,
                signal: exec.signal,
              }),
            )
            checksum = report.ok
              ? { state: 'available', value: report.checksum, lastKnown: evidence?.plcChecksum ?? null, error: null }
              : {
                  state: 'unavailable',
                  value: null,
                  lastKnown: evidence?.plcChecksum ?? null,
                  error: report.error ?? { code: 'checksum_unavailable', message: report.summary },
                }
          }
        }

        let repository = false
        let dirty: string[] = []
        if (device !== null) {
          const repo = await runGit(root, ['rev-parse', '--show-toplevel'])
          repository = repo.code === 0
          if (repository) dirty = await statusPaths(root, [gitPath(root, device.directory)])
        }

        const lock = await readLock(root, scope.config.stateDirName)
        const checksumState = String(checksum['state'] ?? 'not-checked')
        const checksumValue = typeof checksum['value'] === 'string' ? checksum['value'] : null
        const lastKnown = evidence?.plcChecksum ?? null
        const drift =
          checksumState === 'available' && checksumValue !== null && lastKnown !== null
            ? checksumValue !== lastKnown
            : null

        let nextAction: string
        if (device === null) nextAction = 'open_project'
        else if (checksumState === 'unavailable') nextAction = 'compile'
        else if (evidence === null) nextAction = 'sync'
        else if (drift === true) nextAction = 'sync'
        else if (!manifestPresent) nextAction = 'sync'
        else if (!repository) nextAction = 'git_init'
        else if (dirty.length > 0) nextAction = 'commit'
        else nextAction = 'clean'

        const details = [
          device === null
            ? `TIA: no project / no PLC (${String(tia['code'] ?? 'unknown')}).`
            : `PLC: ${device.device} / ${device.software} → ${device.directory}`,
          evidence === null
            ? `Evidence: ${evidenceFile === null ? 'no device' : `${evidenceFile} is missing`}.`
            : `Evidence: ${evidence.objects.size} object(s), state ${evidence.stateId ?? 'unknown'}.`,
          `Manifest: ${manifestPresent ? 'present' : 'missing'}.`,
          `Checksum: ${checksumState}${checksumValue === null ? '' : ` (${checksumValue})`}${drift === null ? '' : drift ? ' — DIFFERS from the ledger' : ' — matches the ledger'}.`,
          `Git: ${repository ? `${dirty.length} change(s) in the device directory` : 'not a repository'}.`,
          lock === null ? 'Lock: free.' : `Lock: held by ${lock.operation} (pid ${lock.pid}).`,
        ]

        return okOutcome(
          PROJECT_STATUS_TOOL,
          scope.view,
          `Workspace status: ${nextAction}.` +
            (checksumState === 'not-checked' ? ' The checksum was NOT checked (verify=true to read it).' : ''),
          {
            device,
            tia,
            checksum: { ...checksum, drift },
            evidence: evidence === null
              ? { path: evidenceFile, present: false, invalid: evidenceInvalid }
              : { path: evidenceFile, present: true, invalid: false, ...evidenceSummary(evidence) },
            manifest: { path: manifestFile, present: manifestPresent },
            git: { repository, dirty },
            lock: lock === null ? null : { held: true, operation: lock.operation, pid: lock.pid, startedAt: lock.startedAt },
            nextAction,
          },
          { details },
        )
      } catch (error) {
        return failedOutcome(PROJECT_STATUS_TOOL, scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}