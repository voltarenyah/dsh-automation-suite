/**
 * One `sync`: TIA → STAGE → SOURCE → git.
 *
 * The controller produces the ledger, the manifest and only the changed XML in a
 * private STAGE directory. This module copies the promoted files into the device
 * directory, deletes what disappeared, writes both JSON documents, and commits
 * the device directory with trailers. It never opens TIA and never asks the model
 * to assemble the steps.
 *
 * @module dsh-engineering-context/sync
 */

import { copyFile, mkdir, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { EngineeringAccessLike, SyncScanCounts, SyncScanReport } from './access.js'
import { normalizeSyncScan } from './access.js'
import { evidencePathForDevice, manifestPathForDevice, stageRootPath } from './config.js'
import type { DeviceInfo } from './device.js'
import { EngineeringContextError } from './errors.js'
import { presentObjects, readEvidence, type EvidenceDocument, type EvidenceObject } from './evidence.js'
import { commitPaths, ensureRepository, gitPath, statusPaths } from './git.js'
import { withLock } from './lock.js'
import type { ResolvedScope } from './scope.js'

/** What one sync did. */
export interface SyncRunResult {
  device: DeviceInfo
  unchanged: boolean
  manifestRebuilt: boolean
  counts: SyncScanCounts
  /** Files copied into SOURCE (promoted by the scan). */
  copied: number
  /** Source files removed because their objects disappeared. */
  removedFiles: number
  stageDir: string | null
  commit: { committed: boolean; hash: string | null }
  stateId: string | null
  checksum: string | null
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

function syncMessage(result: {
  device: DeviceInfo
  counts: SyncScanCounts
  manifestRebuilt: boolean
  checksum: string | null
  stateId: string | null
}): string {
  const counts = result.counts
  const first =
    `sync: ${result.device.device} — ${counts.changed} changed, ${counts.added} added, ${counts.removed} removed` +
    (result.manifestRebuilt ? ', manifest rebuilt' : '')
  return [
    first,
    '',
    'Tia-Op: sync',
    `Tia-Checksum: ${result.checksum ?? 'unknown'}`,
    `Tia-State: ${result.stateId ?? 'unknown'}`,
    `Tia-Manifest: ${result.manifestRebuilt ? 'rebuilt' : 'updated'}`,
  ].join('\n')
}

/**
 * Run one sync under the workspace lock.
 *
 * @param scope - the resolved workspace.
 * @param access - the interface plugin's service.
 * @param device - the PLC and its source directory.
 * @param exec - the per-call execution context.
 * @returns what was written and committed.
 * @throws {EngineeringContextError} when the scan fails, the repository is
 *   missing, or the lock is held. Nothing is committed in those cases.
 */
export async function runSync(
  scope: ResolvedScope,
  access: EngineeringAccessLike,
  device: DeviceInfo,
  exec: ToolRunContext,
): Promise<SyncRunResult> {
  if (typeof access.syncScan !== 'function') {
    throw new EngineeringContextError(
      'tia_access_unavailable',
      'The installed TIA interface plugin has no syncScan method. Update dsh-tia-openness-v17-min to a build that has PlcChecksum and SyncScan.',
      { service: 'engineeringAccess', method: 'syncScan' },
    )
  }

  return await withLock(scope.workspace.path, 'sync', async () => {
    const root = scope.workspace.path
    await ensureRepository(root)

    const evidenceFile = evidencePathForDevice(device.directory)
    const manifestFile = manifestPathForDevice(device.directory)
    // A corrupt ledger must force a full scan, not abort the sync: without it the
    // scan exports everything and simply rewrites the document. Deletions are then
    // skipped (no previous object list), which is the safe direction.
    let previous: EvidenceDocument | null = null
    try {
      previous = await readEvidence(evidenceFile)
    } catch {
      previous = null
    }
    const stageDir = join(stageRootPath(scope.config, root), `${Date.now()}-${process.pid}`)
    await mkdir(stageDir, { recursive: true })

    let report: SyncScanReport
    try {
      report = normalizeSyncScan(
        await access.syncScan!({
          // The controller resolves manifest entries (which are relative to the
          // device directory) against this root, so it is the device directory,
          // not the source tree above it.
          sourceRoot: device.directory,
          stageDir,
          evidencePath: evidenceFile,
          manifestPath: manifestFile,
          deviceName: device.device,
          softwareName: device.software,
          signal: exec.signal,
        }),
      )
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
      throw new EngineeringContextError(
        'sync_failed',
        `The SyncScan call failed: ${error instanceof Error ? error.message : String(error)}`,
        { stageDir },
      )
    }

    if (!report.ok) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
      if (report.error?.code === 'checksum_unavailable') {
        throw new EngineeringContextError(
          'needs_compile',
          'The PLC has no compiled checksum (it was edited since the last compile). Compile it in TIA Portal, then sync again.',
          { device: device.device, stageDir },
        )
      }
      throw new EngineeringContextError('sync_failed', report.summary || 'SyncScan failed.', {
        device: device.device,
        code: report.error?.code ?? null,
        stageDir,
      })
    }

    // Nothing below may leave the STAGE directory behind: it is scratch space, and
    // a failed copy or commit must not turn it into a permanent artifact.
    try {
      if (report.unchanged) {
        return {
          device,
          unchanged: true,
          manifestRebuilt: false,
          counts: report.counts,
          copied: 0,
          removedFiles: 0,
          stageDir: null,
          commit: { committed: false, hash: null },
          stateId: report.stateId,
          checksum: report.checksum,
        }
      }
      if (report.stage === null) {
        throw new EngineeringContextError('sync_failed', 'The scan reported changes but wrote no STAGE directory.', {
          device: device.device,
          stageDir,
        })
      }

      const next = await readEvidence(report.stage.evidence)
      if (next === null) {
        throw new EngineeringContextError('sync_failed', 'The scan did not write an evidence ledger.', {
          stageDir,
          evidence: report.stage.evidence,
        })
      }

      // Only promoted files exist in STAGE; unchanged objects are not copied and
      // therefore keep their previous bytes (and their previous manifest entry).
      let copied = 0
      for (const entry of presentObjects(next)) {
        if (entry.path === null) continue
        const from = join(report.stage.root, entry.path)
        if (!(await exists(from))) continue
        const to = join(device.directory, entry.path)
        await mkdir(dirname(to), { recursive: true })
        await copyFile(from, to)
        copied += 1
      }

      // Deletions: an object that has no entry at all disappeared; an object that is
      // now unexportable still exists in TIA, so its previous file is kept.
      const nextAll = next.objects
      let removedFiles = 0
      if (previous !== null) {
        for (const entry of presentObjects(previous)) {
          if (entry.path === null) continue
          if (nextAll.has(entry.key)) continue
          const file = join(device.directory, entry.path)
          if (await exists(file)) {
            await unlink(file)
            removedFiles += 1
          }
        }
      }

      if (report.stage.manifest.length === 0) {
        throw new EngineeringContextError('sync_failed', 'The scan reported changes but wrote no manifest.', {
          stageDir,
        })
      }
      await copyFile(report.stage.evidence, evidenceFile)
      await copyFile(report.stage.manifest, manifestFile)

      const relative = gitPath(root, device.directory)
      const dirty = await statusPaths(root, [relative])
      let commit: { committed: boolean; hash: string | null } = { committed: false, hash: null }
      if (dirty.length > 0) {
        commit = await commitPaths(
          root,
          [relative],
          syncMessage({
            device,
            counts: report.counts,
            manifestRebuilt: report.manifestRebuilt,
            checksum: report.checksum,
            stateId: report.stateId,
          }),
        )
      }

      return {
        device,
        unchanged: false,
        manifestRebuilt: report.manifestRebuilt,
        counts: report.counts,
        copied,
        removedFiles,
        stageDir,
        commit,
        stateId: report.stateId,
        checksum: report.checksum,
      }
    } finally {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, scope.config.stateDirName)
}

/** Re-exported for callers that want the entry type without importing the module. */
export type { EvidenceObject }
