/**
 * `handoff_status` — where the handoff packages are and what state they are in.
 *
 * Read-only and TIA-free: it reads `<workspace>/handoff/* /handoff.json` and checks
 * whether the archive and the old-project backup still exist. The leader uses it
 * to answer "is a project out with somebody?" before deciding to delegate the
 * version workflow.
 *
 * @module dsh-engineering-context/tools/handoff-status
 */

import { isAbsolute, join } from 'node:path'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { EngineeringContextError } from '../errors.js'
import { formatBytes, handoffRoot, listRecords, findRecord, pathExists } from '../handoff/record.js'
import type { HandoffRecord } from '../handoff/types.js'
import { resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

/** The tool name. */
export const HANDOFF_STATUS_TOOL = 'handoff_status'

const PARAMETERS = {
  handoff_id: {
    type: 'string',
    description: 'Optional handoff id. Omit to list every package in this workspace.',
  },
} as const

/** One record plus the on-disk facts that make it actionable. */
async function describe(root: string, record: HandoffRecord): Promise<Record<string, unknown>> {
  const archive = isAbsolute(record.archive.path) ? record.archive.path : join(root, record.archive.path)
  const backup =
    record.backup === null ? null : isAbsolute(record.backup.path) ? record.backup.path : join(root, record.backup.path)
  return {
    handoffId: record.handoffId,
    status: record.status,
    createdAt: record.createdAt,
    note: record.note ?? null,
    nameChange: record.nameChange ?? null,
    project: record.project,
    base: record.base,
    archive: {
      path: archive,
      bytes: record.archive.bytes,
      size: formatBytes(record.archive.bytes),
      present: await pathExists(archive),
      sha256: record.archive.sha256,
    },
    backup: record.backup === null ? null : { path: backup, present: backup === null ? false : await pathExists(backup) },
    returned: record.returned,
    import: record.import,
  }
}

/**
 * Build the status tool.
 *
 * @param dependencies - the plugin dependencies.
 */
export function handoffStatusTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: HANDOFF_STATUS_TOOL,
    description:
      'List the handoff packages of this workspace (handoff/<id>/) with their status, base commit, archive size/path, ' +
      'whether the archive and the old-project backup are still present, and whether an import is waiting for a manual ' +
      'compile. Read-only: it never touches TIA and never writes. Pass handoff_id for one package.',
    parameters: PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const root = scope.workspace.path
        if (typeof args.handoff_id === 'string' && args.handoff_id.trim().length > 0) {
          const id = args.handoff_id.trim()
          const record = await findRecord(dependencies.config, root, id)
          if (record === null) {
            throw new EngineeringContextError('handoff_record_not_found', `No handoff record ${id} exists in ${handoffRoot(dependencies.config, root)}.`, {
              handoffId: id,
              root: handoffRoot(dependencies.config, root),
            })
          }
          const described = await describe(root, record)
          return okOutcome(
            HANDOFF_STATUS_TOOL,
            scope.view,
            `${record.handoffId}: ${record.status} — ${record.archive.path}`,
            { handoff: described },
            {
              dryRun: true,
              details: [
                `Handoff: ${record.handoffId} (${record.status}) — ${record.project.name} / ${record.project.device}.`,
                `Base: ${record.base.commit}${record.base.branch === null ? '' : ` on ${record.base.branch}`}.`,
                `Archive: ${join(root, record.archive.path)} (${formatBytes(record.archive.bytes)}).`,
                record.backup === null ? 'Backup: none recorded.' : `Backup: ${join(root, record.backup.path)}.`,
                record.import?.error === null || record.import?.error === undefined ? '' : `Import error: ${record.import.error}`,
              ].filter((line) => line.length > 0),
            },
          )
        }

        const listing = await listRecords(dependencies.config, root)
        const records = await Promise.all(listing.records.map((record) => describe(root, record)))
        const awaiting = listing.records.filter((record) => record.status === 'awaiting_compile').length
        const open = listing.records.filter((record) => record.status === 'issued' || record.status === 'returned').length
        return okOutcome(
          HANDOFF_STATUS_TOOL,
          scope.view,
          listing.records.length === 0
            ? 'No handoff packages in this workspace.'
            : `${listing.records.length} handoff package(s): ${open} outstanding, ${awaiting} awaiting compile.`,
          {
            root: handoffRoot(dependencies.config, root),
            count: listing.records.length,
            outstanding: open,
            awaitingCompile: awaiting,
            handoffs: records,
          },
          {
            dryRun: true,
            details: [
              `Directory: ${handoffRoot(dependencies.config, root)}`,
              ...listing.records.slice(0, 10).map((record) => `${record.handoffId} — ${record.status} — ${record.project.name} — ${record.archive.path}`),
            ],
            warnings: listing.warnings,
          },
        )
      } catch (error) {
        return failedOutcome(HANDOFF_STATUS_TOOL, scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}
