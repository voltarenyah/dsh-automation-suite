/**
 * `project_sync` — make the committed source tree match the compiled PLC.
 *
 * The default is a plan: read the checksum (a few seconds) and report whether a
 * sync is needed, without writing. A plan reuses the checksum a recent read-only
 * call cached (checksum-cache.ts) and says so via `checksumCached`; a real run
 * (`dry_run: false`) never consults that cache, always scans, and then refreshes
 * it. `dry_run: false` runs the whole scan, copies the promoted XML, writes
 * evidence + manifest, and commits the device directory.
 *
 * @module dsh-engineering-context/tools/sync
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { engineeringAccess, normalizeChecksum, type EngineeringAccessLike } from '../access.js'
import { checksumCacheKey, readCachedChecksum, writeCachedChecksum } from '../checksum-cache.js'
import { evidencePathForDevice, manifestPathForDevice } from '../config.js'
import type { DeviceInfo } from '../device.js'
import { resolveDevice } from '../device.js'
import { EngineeringContextError } from '../errors.js'
import { readEvidence, type EvidenceDocument } from '../evidence.js'
import { describePath, resolveScope, type ResolvedScope } from '../scope.js'
import { runSync } from '../sync.js'
import type { ToolDependencies } from './deps.js'
import { defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

/** The tool name, used by the registrar and the tests. */
export const PROJECT_SYNC_TOOL = 'project_sync'

const PARAMETERS = {
  dry_run: {
    type: 'boolean',
    description:
      'Default true: read the PLC checksum (a few seconds) and report whether a sync is needed, writing nothing. Pass false to run the ' +
      'scan, update the source tree and commit it. Only the controller writes files; this tool never modifies the TIA project.',
  },
} as const

/**
 * Build the sync tool.
 * @param dependencies - the plugin dependencies.
 */
export function syncTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: PROJECT_SYNC_TOOL,
    description:
      'Synchronize the workspace source tree with the project TIA has open. It compares the PLC checksum and, when it differs, scans the ' +
      'whole PLC (blocks, PLC types, tag tables), exports only the changed objects, updates the evidence ledger and the manifest, and commits ' +
      'the device directory. Defaults to a plan: pass dry_run=false to write. Requires an open project and a compiled PLC (a missing checksum ' +
      'means "compile first"). One workspace syncs one PLC; it never opens TIA, never creates a git repository and never modifies the project.',
    parameters: PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const service: EngineeringAccessLike | undefined = engineeringAccess(dependencies.ctx)
        if (service === undefined) {
          throw new EngineeringContextError(
            'tia_access_unavailable',
            'This composition has no engineeringAccess service, so TIA cannot be reached. Install the TIA interface plugin.',
            { service: 'engineeringAccess' },
          )
        }
        const device = await resolveDevice(scope, service, exec)
        const evidenceFile = evidencePathForDevice(device.directory)
        const manifestFile = manifestPathForDevice(device.directory)
        const cacheKey = checksumCacheKey(scope.workspace.path, device.device, device.software)

        if (args.dry_run !== false) {
          let evidence: EvidenceDocument | null = null
          let evidenceInvalid = false
          try {
            evidence = await readEvidence(evidenceFile)
          } catch {
            // A corrupt ledger is a reason to sync, not a reason to refuse the plan.
            evidenceInvalid = true
          }

          // A plan only needs "what does TIA say right now". A checksum another
          // read-only call fetched moments ago answers that, so reuse it instead
          // of paying for the same TIA round trip twice.
          const cached = readCachedChecksum(cacheKey)
          let checksum: string | null
          let checksumCached = false
          if (cached !== null) {
            checksum = cached.checksum
            checksumCached = true
          } else {
            if (typeof service.readPlcChecksum !== 'function') {
              throw new EngineeringContextError(
                'tia_access_unavailable',
                'The installed TIA interface plugin has no readPlcChecksum method. Update dsh-tia-openness-v17-min.',
                { service: 'engineeringAccess', method: 'readPlcChecksum' },
              )
            }
            const report = normalizeChecksum(
              await service.readPlcChecksum({
                deviceName: device.device,
                softwareName: device.software,
                signal: exec.signal,
              }),
            )
            if (!report.ok) {
              if (report.error?.code === 'checksum_unavailable') {
                throw new EngineeringContextError(
                  'needs_compile',
                  'The PLC has no compiled checksum (it was edited since the last compile). Compile it in TIA Portal, then sync.',
                  { device: device.device },
                )
              }
              throw new EngineeringContextError('sync_failed', report.summary || 'Reading the checksum failed.', {
                device: device.device,
                code: report.error?.code ?? null,
              })
            }
            checksum = report.checksum
            if (checksum !== null) writeCachedChecksum(cacheKey, checksum)
          }

          const manifest = await describePath(scope.workspace.path, manifestFile)
          const wouldSync = evidence === null || evidence.plcChecksum !== checksum || manifest.kind !== 'file'
          const reason =
            evidenceInvalid
              ? 'the evidence ledger is unreadable'
              : evidence === null
                ? 'no evidence ledger'
                : manifest.kind !== 'file'
                  ? 'no manifest'
                  : 'checksum differs'
          return okOutcome(
            PROJECT_SYNC_TOOL,
            scope.view,
            wouldSync
              ? `Dry run: a sync is needed (${reason}). Pass dry_run=false to run it.`
              : 'Dry run: the source tree already matches the compiled PLC; nothing to do.',
            {
              device,
              checksum,
              checksumCached,
              lastKnownChecksum: evidence?.plcChecksum ?? null,
              evidence: {
                path: evidenceFile,
                present: evidence !== null,
                invalid: evidenceInvalid,
                stateId: evidence?.stateId ?? null,
              },
              manifest: { path: manifestFile, present: manifest.kind === 'file' },
              wouldSync,
            },
            {
              dryRun: true,
              details: [
                `PLC: ${device.device} / ${device.software} → ${device.directory}`,
                `Checksum: ${checksum ?? 'unavailable'}${checksumCached ? ' (reused from the checksum cache)' : ''}`,
                evidenceInvalid
                  ? 'Evidence: unreadable (a full scan will rewrite it).'
                  : evidence === null
                    ? 'Evidence: missing (a full scan will be needed).'
                    : `Evidence: ${evidence.objects.size} object(s).`,
                `Manifest: ${manifest.kind === 'file' ? 'present' : 'missing'}.`,
              ],
            },
          )
        }

        const result = await runSync(scope, service, device, exec)
        // A real sync always scanned; its own checksum is the freshest fact, so
        // refresh the cache with it (never the other way around).
        if (result.checksum !== null) writeCachedChecksum(cacheKey, result.checksum)
        const details = [
          `PLC: ${result.device.device} / ${result.device.software} → ${result.device.directory}`,
          result.unchanged
            ? 'Nothing changed: the checksum matches the ledger.'
            : `Scan: ${result.counts.changed} changed, ${result.counts.added} added, ${result.counts.removed} removed, ${result.counts.unexportable} unexportable.`,
          `Files: ${result.copied} copied, ${result.removedFiles} removed.`,
          result.manifestRebuilt ? 'Manifest: rebuilt from this scan.' : 'Manifest: updated.',
          result.commit.committed
            ? `Commit: ${result.commit.hash ?? 'unknown'}.`
            : 'Commit: nothing to commit (the working tree already matched).',
        ]
        return okOutcome(
          PROJECT_SYNC_TOOL,
          scope.view,
          result.unchanged
            ? 'Already in sync: the PLC checksum matches the evidence ledger.'
            : `Synchronized ${device.device}: ${result.counts.changed} changed, ${result.counts.added} added, ${result.counts.removed} removed` +
                `${result.commit.committed ? `, committed ${result.commit.hash ?? ''}` : ''}.`,
          {
            device: result.device,
            unchanged: result.unchanged,
            manifestRebuilt: result.manifestRebuilt,
            counts: result.counts,
            copied: result.copied,
            removedFiles: result.removedFiles,
            commit: result.commit,
            stateId: result.stateId,
            checksum: result.checksum,
          },
          { details, dryRun: false },
        )
      } catch (error) {
        return failedOutcome(PROJECT_SYNC_TOOL, scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}