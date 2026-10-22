/**
 * One `syncScan` call, shared by the two workflow tools.
 *
 * `project_sync` and `create_engineering_project` both need the same scan, but
 * for different reasons: the sync diffing a tree against TIA, the import
 * recording the tree it just exported (`adoptExisting: true`, so the controller
 * verifies the existing files against their manifest instead of exporting them a
 * second time). The call, the transport-failure mapping and the method check are
 * identical, so they live here; what each caller does with the report stays in
 * the caller.
 *
 * @module dsh-engineering-context/scan
 */

import {
  normalizeSyncScan,
  type EngineeringAccessLike,
  type SyncScanQuery,
  type SyncScanReport,
} from './access.js'
import { EngineeringContextError } from './errors.js'

/** The message for an interface plugin that predates the versioning workflow. */
const NO_SYNC_SCAN =
  'The installed TIA interface plugin has no syncScan method. Update dsh-tia-openness-v17-min to a build that has ' +
  'PlcChecksum and SyncScan.'

/**
 * Run one scan and return its normalized report.
 *
 * @param access - the interface plugin's service.
 * @param query - what to compare, where to write, and whether to adopt existing files.
 * @returns the report; operation-level failures are in `report.ok` / `report.error`.
 * @throws {EngineeringContextError} `tia_access_unavailable` when the service has no
 *   `syncScan`, and `sync_failed` when the call itself failed (controller missing,
 *   timeout, protocol mismatch).
 */
export async function callSyncScan(
  access: EngineeringAccessLike,
  query: SyncScanQuery,
): Promise<SyncScanReport> {
  if (typeof access.syncScan !== 'function') {
    throw new EngineeringContextError('tia_access_unavailable', NO_SYNC_SCAN, {
      service: 'engineeringAccess',
      method: 'syncScan',
    })
  }
  try {
    return normalizeSyncScan(await access.syncScan(query))
  } catch (error) {
    if (error instanceof EngineeringContextError) throw error
    throw new EngineeringContextError(
      'sync_failed',
      `The SyncScan call failed: ${error instanceof Error ? error.message : String(error)}`,
      { sourceRoot: query.sourceRoot, stageDir: query.stageDir },
    )
  }
}
