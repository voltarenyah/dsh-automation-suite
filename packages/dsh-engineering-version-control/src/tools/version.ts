/**
 * The version-store tools.
 *
 * `project_history` is the one a user actually asks for ("show me this block's
 * history"); `project_version_reindex` and `project_version_verify` keep the
 * store honest. All of them work with TIA closed: the device is resolved from
 * `source/<device>/`, not from the open project.
 *
 * @module dsh-engineering-context/tools/version
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { parseEvidenceDocument } from '../evidence.js'
import { gitPath, logCommits, showFileAtRevision } from '../git.js'
import { resolveScope } from '../scope.js'
import {
  blockHistory,
  clampLimit,
  documentsForBlock,
  problemView,
  resolveCommit,
  searchVersions,
  versionChanges,
  versionSummary,
  versionsByChecksum,
  type TimelineEntry,
} from '../version/read.js'
import { indexDocuments, searchDocuments } from '../version/docs.js'
import { resolveSourceDevice } from '../version/device.js'
import { openVersionStore } from '../version/store.js'
import { writeVersionView } from '../version/view.js'
import { reindexVersionStore, type ReindexReport } from '../version/write.js'
import type { ToolDependencies } from './deps.js'
import { defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

/** Tool names, exported for tests and the registrar. */
export const VERSION_TOOLS = ['project_history', 'project_version_reindex', 'project_version_verify'] as const

function short(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '—'
  return value.length <= 10 ? value : value.slice(0, 10)
}

/** One line, whitespace collapsed, truncated. */
function oneLine(text: string | null, max = 160): string {
  if (text === null) return ''
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** One changed face as its own line: `Code       CVt2YE+d0L → E4pUnyy/ld`. */
function fingerprintLine(
  face: string,
  before: Record<string, string> | null,
  after: Record<string, string> | null,
): string {
  return `${face.padEnd(10)} ${short(before?.[face])} → ${short(after?.[face])}`
}

function timelineLine(entry: TimelineEntry): string {
  const stat =
    entry.linesAdded === null && entry.linesRemoved === null
      ? ''
      : ` (+${entry.linesAdded ?? 0}/-${entry.linesRemoved ?? 0})`
  const lines: string[] = [
    `#${entry.seq} ${short(entry.commit)} ${entry.occurredAt.slice(0, 10)} ${entry.subject ?? ''}${stat}`.trimEnd(),
  ]
  lines.push(`    faces: ${entry.faces.length === 0 ? '(none)' : entry.faces.join(', ')}`)
  for (const face of entry.faces) {
    lines.push(`    ${fingerprintLine(face, entry.fingerprintBefore, entry.fingerprintAfter)}`)
  }
  if (entry.reason !== null && entry.reason.length > 0) {
    lines.push(`    reason: ${oneLine(entry.reason)}`)
  }
  return lines.join('\n')
}

/** The `project_history` tool. */
export function historyTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'project_history',
    description:
      'Answer history questions from the version store (works with TIA closed). Modes, by the parameter you pass: block = one block\'s ' +
      'change timeline (oldest first, with fingerprint before/after and reason); commit = one version\'s details and changed objects ' +
      '(short shas are accepted); checksum = every version that ever carried that PLC checksum (repeats are normal); face/since = ' +
      'matching versions. Report the detail lines as they come — one fingerprint per line, no HTML tags such as <br> — and do not ' +
      're-derive them with SQL unless a fact is genuinely missing. Never reads the exported XML.',
    parameters: {
      block: {
        type: 'string',
        description:
          'Block key (`blocks|01_Cavity_A|100_Cycle_Selection_Cav_A`) or just the block name. Selects the timeline mode.',
      },
      commit: {
        type: 'string',
        description: 'A commit sha (short or long). Selects the version-details mode.',
      },
      checksum: {
        type: 'string',
        description: 'A PLC checksum exactly as the trailers record it, e.g. "71 2D DC D7 F9 DF 81 90".',
      },
      face: {
        type: 'string',
        description: 'Only versions whose change touched this fingerprint face (Code / Interface / Comments / Properties).',
      },
      search: {
        type: 'string',
        description:
          'Free text over commit subjects, reasons and object keys (e.g. "cooling"). Use this instead of writing SQL for "which ' +
          'changes mention X".',
      },
      since: {
        type: 'string',
        description: 'Only versions committed at or after this ISO date, e.g. "2026-10-01".',
      },
      limit: {
        type: 'integer',
        description: 'Maximum rows (default 20, clamped to 1..100).',
      },
    },
    async execute(args, exec) {
      let scope = null as Awaited<ReturnType<typeof resolveScope>> | null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const device = await resolveSourceDevice(dependencies.config, scope.workspace.path)
        const store = openVersionStore(dependencies.config, scope.workspace.path)
        try {
          if (typeof args.block === 'string' && args.block.length > 0) {
            const limit = clampLimit(args.limit, 100)
            const rows = blockHistory(store, args.block, limit)
            const docs = documentsForBlock(store, args.block)
            return okOutcome(
              'project_history',
              scope.view,
              rows.length === 0
                ? `No recorded change for ${args.block} in ${device.device}.`
                : `${args.block}: ${rows.length} change(s).`,
              { device: device.device, block: args.block, entries: rows, documents: docs },
              {
                dryRun: true,
                details: [
                  `Device: ${device.device} — ${device.directory}`,
                  ...(rows.length === 0 ? ['No change events recorded for this block.'] : rows.map(timelineLine)),
                  ...(docs.length === 0 ? [] : [`Documents: ${docs.map((doc) => doc.path).join(', ')}`]),
                ],
              },
            )
          }

          if (typeof args.commit === 'string' && args.commit.length > 0) {
            const resolution = resolveCommit(store, args.commit)
            if (resolution.sha === null) {
              const ambiguous = resolution.candidates.length > 0
              return okOutcome(
                'project_history',
                scope.view,
                ambiguous
                  ? `Commit ${args.commit} is ambiguous (${resolution.candidates.length} matches).`
                  : `No version ${args.commit} in the store.`,
                { commit: args.commit, found: false, candidates: resolution.candidates },
                {
                  dryRun: true,
                  details: ambiguous
                    ? ['Candidates:', ...resolution.candidates.map((sha) => `  ${short(sha)}`)]
                    : [],
                },
              )
            }
            const sha = resolution.sha
            const version = versionSummary(store, sha)
            if (version === null) {
              return okOutcome('project_history', scope.view, `No version ${args.commit} in the store.`, { commit: args.commit, found: false }, { dryRun: true })
            }
            const changes = versionChanges(store, sha)
            return okOutcome(
              'project_history',
              scope.view,
              `${short(version.commit)}: ${changes.length} changed object(s).`,
              { version, changes },
              {
                dryRun: true,
                details: [
                  `Commit: ${version.commit}`,
                  `Parent: ${version.parent ?? '(root)'}`,
                  `When: ${version.committedAt}`,
                  `Subject: ${version.subject}`,
                  `Checksum: ${version.checksumPrev ?? '—'} → ${version.checksum ?? '—'}`,
                  ...(version.intent === null ? [] : [`Intent: ${oneLine(version.intent, 200)}`]),
                  ...(changes.length === 0 ? ['Changed objects: none'] : ['Changed objects:']),
                  ...changes.flatMap((change) => [
                    `  · ${change.key} (${change.change})`,
                    ...change.faces.map((face) => `      ${fingerprintLine(face, change.fingerprintBefore, change.fingerprintAfter)}`),
                  ]),
                ],
              },
            )
          }

          if (typeof args.checksum === 'string' && args.checksum.length > 0) {
            const versions = versionsByChecksum(store, args.checksum, clampLimit(args.limit, 50))
            return okOutcome(
              'project_history',
              scope.view,
              `${versions.length} version(s) carry checksum ${args.checksum}.`,
              { checksum: args.checksum, versions },
              {
                dryRun: true,
                details: versions.map((version) => `${short(version.commit)} ${version.committedAt.slice(0, 10)} ${version.subject}`),
              },
            )
          }

          const versions = searchVersions(store, {
            search: typeof args.search === 'string' ? args.search : undefined,
            face: typeof args.face === 'string' ? args.face : undefined,
            since: typeof args.since === 'string' ? args.since : undefined,
            limit: args.limit,
          })
          return okOutcome(
            'project_history',
            scope.view,
            `${versions.length} version(s) match.`,
            { versions },
            {
              dryRun: true,
              details: versions.map((version) => `${short(version.commit)} ${version.committedAt.slice(0, 10)} ${version.subject}`),
            },
          )
        } finally {
          store.close()
        }
      } catch (error) {
        return failedOutcome('project_history', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}

/** The `project_version_reindex` tool. */
export function reindexTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'project_version_reindex',
    description:
      'Rebuild the version store from the repository history (git log + each commit\'s _evidence.json). Use after deleting the store, ' +
      'after importing an existing workspace, or when the store is suspected stale. Read-only with respect to git; the store is local ' +
      'and can be rebuilt at any time.',
    parameters: {
      device: {
        type: 'string',
        description: 'Optional device name; needed only when the workspace holds more than one source tree.',
      },
    },
    async execute(args, exec) {
      let scope = null as Awaited<ReturnType<typeof resolveScope>> | null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const device = await resolveSourceDevice(dependencies.config, scope.workspace.path, args.device)
        const report: ReindexReport = await reindexVersionStore({
          root: scope.workspace.path,
          config: dependencies.config,
          device,
          log: dependencies.log,
        })
        return okOutcome(
          'project_version_reindex',
          scope.view,
          `Replayed ${report.versions} version(s), ${report.events} change event(s), ${report.baseline} baseline object(s).`,
          report,
          {
            dryRun: false,
            warnings: report.warnings,
            details: [
              `Device: ${device.device} — ${device.directory}`,
              `Versions: ${report.versions}`,
              `Change events: ${report.events}`,
              `Baseline objects: ${report.baseline}`,
              ...(report.skipped.length === 0
                ? []
                : [`Commit(s) without a ledger (skipped): ${report.skipped.join(', ')}`]),
            ],
          },
        )
      } catch (error) {
        return failedOutcome('project_version_reindex', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}

/** The `project_version_verify` tool. */
export function verifyTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'project_version_verify',
    description:
      'Check that the version store matches git: every recorded commit exists, parent links agree, each block\'s timeline has no gaps, ' +
      'and every event has a graph node. With deep=true it also re-reads each commit\'s _evidence.json and compares checksums. ' +
      'Read-only.',
    parameters: {
      deep: {
        type: 'boolean',
        description: 'Also compare each version\'s PLC checksum with the evidence ledger stored in that commit. Slower.',
      },
    },
    async execute(args, exec) {
      let scope = null as Awaited<ReturnType<typeof resolveScope>> | null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const device = await resolveSourceDevice(dependencies.config, scope.workspace.path)
        const root = scope.workspace.path
        const store = openVersionStore(dependencies.config, root)
        try {
          const problems: string[] = []
          const commits = await logCommits(root)
          const gitShas = new Set(commits.map((commit) => commit.sha))
          const versions = store.all<{ commit_sha: string; parent_sha: string | null; plc_checksum: string | null }>(
            'SELECT commit_sha, parent_sha, plc_checksum FROM versions',
          )
          for (const version of versions) {
            if (!gitShas.has(version.commit_sha)) problems.push(`version ${short(version.commit_sha)} is not a commit in git`)
            const meta = commits.find((commit) => commit.sha === version.commit_sha)
            if (meta !== undefined && version.parent_sha !== null && meta.parents[0] !== version.parent_sha) {
              problems.push(`version ${short(version.commit_sha)} parent ${short(version.parent_sha)} ≠ git parent ${short(meta.parents[0] ?? '')}`)
            }
          }

          const timelineCounts = store.all<{ block_key: string; count: number; min_seq: number; max_seq: number }>(
            'SELECT block_key, COUNT(*) AS count, MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM block_timeline GROUP BY block_key',
          )
          for (const row of timelineCounts) {
            if (row.min_seq !== 1 || row.max_seq !== row.count) {
              problems.push(`timeline of ${row.block_key} has a gap or bad start (${row.min_seq}..${row.max_seq}, ${row.count} row(s))`)
            }
          }

          const eventCount = store.get<{ count: number }>('SELECT COUNT(*) AS count FROM change_events')
          const timelineCount = store.get<{ count: number }>('SELECT COUNT(*) AS count FROM block_timeline')
          if ((eventCount?.count ?? 0) !== (timelineCount?.count ?? 0)) {
            problems.push(`change_events has ${eventCount?.count ?? 0} row(s) but block_timeline has ${timelineCount?.count ?? 0}`)
          }

          if (args.deep === true) {
            const deviceRel = gitPath(root, device.directory)
            for (const version of versions) {
              const raw = await showFileAtRevision(root, version.commit_sha, `${deviceRel}/_evidence.json`)
              if (raw === null) {
                problems.push(`version ${short(version.commit_sha)} has no evidence ledger in git`)
                continue
              }
              try {
                const evidence = parseEvidenceDocument(raw, `${version.commit_sha}:${deviceRel}/_evidence.json`)
                if (evidence.plcChecksum !== version.plc_checksum) {
                  problems.push(
                    `version ${short(version.commit_sha)} checksum ${version.plc_checksum ?? '—'} ≠ ledger ${evidence.plcChecksum ?? '—'}`,
                  )
                }
              } catch (error) {
                problems.push(`version ${short(version.commit_sha)} ledger unreadable: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          }

          return okOutcome(
            'project_version_verify',
            scope.view,
            problems.length === 0 ? `Version store is consistent (${versions.length} version(s)).` : `${problems.length} problem(s) found.`,
            { ok: problems.length === 0, versions: versions.length, problems },
            {
              dryRun: true,
              details: [
                `Device: ${device.device} — ${device.directory}`,
                `Versions: ${versions.length}`,
                `Events: ${eventCount?.count ?? 0} / timeline rows: ${timelineCount?.count ?? 0}`,
                ...(problems.length === 0 ? ['No problem found.'] : problems),
              ],
            },
          )
        } finally {
          store.close()
        }
      } catch (error) {
        return failedOutcome('project_version_verify', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}

/** The `project_doc_index` tool. */
export function docIndexTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'project_doc_index',
    description:
      'Index markdown design/change documents into the version store so a block can be linked to the documents that explain it. ' +
      'Reads `.dsh/docs/**` (or the directory you pass), parses optional YAML front matter (`affects:` block keys, `problems:`), ' +
      'extracts heading spans, and builds DOCUMENTS edges to those objects. The files stay the truth; the store keeps their hash, ' +
      'spans and searchable text.',
    parameters: {
      dir: {
        type: 'string',
        description: 'Optional directory to index instead of `.dsh/docs`.',
      },
    },
    async execute(args, exec) {
      let scope = null as Awaited<ReturnType<typeof resolveScope>> | null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const store = openVersionStore(dependencies.config, scope.workspace.path)
        try {
          const report = await indexDocuments({
            store,
            config: dependencies.config,
            root: scope.workspace.path,
            dir: args.dir,
          })
          return okOutcome(
            'project_doc_index',
            scope.view,
            `Indexed ${report.indexed}/${report.scanned} document(s), ${report.linked} link(s).`,
            report,
            {
              dryRun: false,
              details: [
                `Scanned: ${report.scanned}`,
                `Indexed: ${report.indexed}`,
                `Links (DOCUMENTS edges): ${report.linked}`,
                `Full-text search: ${report.fts ? 'available' : 'unavailable (LIKE fallback)'}`,
                ...(report.skipped === 0 ? [] : [`Skipped: ${report.skipped}`]),
              ],
            },
          )
        } finally {
          store.close()
        }
      } catch (error) {
        return failedOutcome('project_doc_index', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}

/** The `project_doc_search` tool. */
export function docSearchTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'project_doc_search',
    description:
      'Search the indexed design/change documents (full text). Use it to find the document behind a change; then follow the ' +
      'DOCUMENTS edges with project_history. FTS5 trigram needs >=3 characters; shorter terms fall back to LIKE.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Text to find in titles or bodies.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum hits (default 20, clamped to 1..100).',
      },
    },
    async execute(args, exec) {
      let scope = null as Awaited<ReturnType<typeof resolveScope>> | null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const store = openVersionStore(dependencies.config, scope.workspace.path)
        try {
          const hits = searchDocuments(store, args.query, clampLimit(args.limit, 20))
          return okOutcome(
            'project_doc_search',
            scope.view,
            `${hits.length} document(s) match ${JSON.stringify(args.query)}.`,
            { query: args.query, hits },
            {
              dryRun: true,
              details: hits.map((hit) => `${hit.path} — ${hit.title ?? '(untitled)'}`),
            },
          )
        } finally {
          store.close()
        }
      } catch (error) {
        return failedOutcome('project_doc_search', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}

/** The `project_version_annotate` tool. */
export function annotateTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'project_version_annotate',
    description:
      'Attach engineering background to an existing version: the reason, the problem it resolves, an acceptance state, or ' +
      'reference ids. Updates the event rows, the timeline projection and the graph together. Use it after a change was ' +
      'explained or accepted; the store already has the mechanical facts.',
    parameters: {
      commit: {
        type: 'string',
        required: true,
        description: 'The commit sha to annotate.',
      },
      reason: {
        type: 'string',
        description: 'Why the change exists, in the user\'s words.',
      },
      problem: {
        type: 'string',
        description: 'A problem reference (e.g. "cooling-table-blocked").',
      },
      acceptance: {
        type: 'string',
        description: 'pending | accepted | rejected',
      },
      references: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reference ids to attach (requirement, ticket, test).',
      },
    },
    async execute(args, exec) {
      let scope = null as Awaited<ReturnType<typeof resolveScope>> | null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const store = openVersionStore(dependencies.config, scope.workspace.path)
        try {
          const resolution = resolveCommit(store, args.commit)
          if (resolution.sha === null) {
            const ambiguous = resolution.candidates.length > 0
            return okOutcome(
              'project_version_annotate',
              scope.view,
              ambiguous ? `Commit ${args.commit} is ambiguous.` : `No version ${args.commit} in the store.`,
              { commit: args.commit, found: false, candidates: resolution.candidates },
              { dryRun: true },
            )
          }
          const target = resolution.sha
          const applied: string[] = []
          store.transaction(() => {
            if (typeof args.reason === 'string' && args.reason.length > 0) {
              store.run('UPDATE versions SET subject_norm = ? WHERE commit_sha = ?', args.reason, target)
              store.run('UPDATE change_events SET reason = ? WHERE commit_sha = ?', args.reason, target)
              store.run('UPDATE block_timeline SET reason = ? WHERE commit_sha = ?', args.reason, target)
              applied.push('reason')
            }
            if (typeof args.problem === 'string' && args.problem.length > 0) {
              store.run('UPDATE change_events SET problem_ref = ? WHERE commit_sha = ?', args.problem, target)
              store.run('UPDATE block_timeline SET problem_ref = ? WHERE commit_sha = ?', args.problem, target)
              store.run(
                `INSERT INTO graph_nodes(id, kind, name) VALUES(?, 'Problem', ?)
                 ON CONFLICT(id) DO NOTHING`,
                `problem:${args.problem}`,
                args.problem,
              )
              applied.push('problem')
            }
            if (typeof args.acceptance === 'string' && args.acceptance.length > 0) {
              store.run('UPDATE versions SET acceptance = ? WHERE commit_sha = ?', args.acceptance, target)
              applied.push(`acceptance=${args.acceptance}`)
            }
            const references = Array.isArray(args.references) ? args.references : []
            for (const ref of references) {
              if (typeof ref !== 'string' || ref.length === 0) continue
              const referenceId = `reference:${ref}`
              store.run(
                `INSERT INTO graph_nodes(id, kind, name) VALUES(?, 'Reference', ?)
                 ON CONFLICT(id) DO NOTHING`,
                referenceId,
                ref,
              )
              store.run(
                `INSERT INTO graph_edges(id, type, from_node_id, to_node_id)
                 VALUES(?, 'REFERENCES', ?, ?) ON CONFLICT(id) DO NOTHING`,
                `edge:REFERENCES:version:${target}:${referenceId}`,
                `version:${target}`,
                referenceId,
              )
            }
            if (references.length > 0) applied.push(`${references.length} reference(s)`)
          })
          // The browser tab reads a flat projection; keep it in step.
          await writeVersionView(dependencies.config, scope.workspace.path)
          return okOutcome(
            'project_version_annotate',
            scope.view,
            applied.length === 0 ? 'Nothing to annotate.' : `Annotated ${short(target)}: ${applied.join(', ')}.`,
            { commit: target, applied },
            { dryRun: false, details: applied.map((entry) => `· ${entry}`) },
          )
        } finally {
          store.close()
        }
      } catch (error) {
        return failedOutcome('project_version_annotate', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}

/** The `project_problem` tool. */
export function problemTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'project_problem',
    description:
      'Show what one engineering problem touched: every version/object/session recorded with that problem reference. ' +
      'Works with TIA closed.',
    parameters: {
      ref: {
        type: 'string',
        required: true,
        description: 'The problem reference, e.g. "cooling-table-blocked".',
      },
    },
    async execute(args, exec) {
      let scope = null as Awaited<ReturnType<typeof resolveScope>> | null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const store = openVersionStore(dependencies.config, scope.workspace.path)
        try {
          const rows = problemView(store, args.ref)
          return okOutcome(
            'project_problem',
            scope.view,
            `${rows.length} recorded change(s) for problem ${args.ref}.`,
            { ref: args.ref, changes: rows },
            {
              dryRun: true,
              details: rows.map((row) => `${short(row.commit)} ${row.occurredAt.slice(0, 10)} ${row.object}`),
            },
          )
        } finally {
          store.close()
        }
      } catch (error) {
        return failedOutcome('project_problem', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}

/** The `project_version_query` tool. */
export function queryTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'project_version_query',
    description:
      'Run one read-only SELECT/WITH against the version store for a question the other tools do not cover. Refuses anything ' +
      'that is not a single read statement. Tables: versions, change_events, block_timeline, baseline_snapshots, documents, ' +
      'doc_spans, graph_nodes, graph_node_properties, graph_edges, graph_edge_properties.',
    parameters: {
      sql: {
        type: 'string',
        required: true,
        description: 'One SELECT/WITH statement.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum rows returned (default 50, clamped to 1..200).',
      },
    },
    async execute(args, exec) {
      let scope = null as Awaited<ReturnType<typeof resolveScope>> | null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const sql = String(args.sql ?? '')
        if (!/^\s*(select|with|explain)\b/iu.test(sql)) {
          return okOutcome('project_version_query', scope.view, 'Refused: only one SELECT/WITH statement is allowed.', { refused: true }, { dryRun: true })
        }
        if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum)\b/iu.test(sql.replace(/'[^']*'/gu, "''"))) {
          return okOutcome('project_version_query', scope.view, 'Refused: the statement contains a write keyword.', { refused: true }, { dryRun: true })
        }
        const store = openVersionStore(dependencies.config, scope.workspace.path)
        try {
          const limit = Math.min(200, Math.max(1, typeof args.limit === 'number' ? Math.trunc(args.limit) : 50))
          const rows = store.all<Record<string, unknown>>(sql)
          const bounded = rows.slice(0, limit)
          return okOutcome(
            'project_version_query',
            scope.view,
            `${bounded.length} row(s)${rows.length > bounded.length ? ` (of ${rows.length})` : ''}.`,
            { rows: bounded, total: rows.length },
            {
              dryRun: true,
              details: bounded.slice(0, 20).map((row) => JSON.stringify(row)),
            },
          )
        } finally {
          store.close()
        }
      } catch (error) {
        return failedOutcome('project_version_query', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}

/** Every version-store tool, in registration order. */
export function versionTools(dependencies: ToolDependencies): ToolDefinition[] {
  return [
    historyTool(dependencies),
    reindexTool(dependencies),
    verifyTool(dependencies),
    docIndexTool(dependencies),
    docSearchTool(dependencies),
    annotateTool(dependencies),
    problemTool(dependencies),
    queryTool(dependencies),
  ]
}
