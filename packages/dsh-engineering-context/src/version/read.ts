/**
 * Reading the version store.
 *
 * Queries are bounded (`limit`) and never touch `_evidence.json`: the timeline
 * and the graph already carry what a history question needs. The one exception
 * is `--deep` verification, which explicitly cross-checks against the ledger.
 *
 * @module dsh-engineering-context/version/read
 */

import type { VersionStore } from './store.js'

/** One row of a block's history. */
export interface TimelineEntry {
  seq: number
  commit: string
  occurredAt: string
  subject: string | null
  reason: string | null
  problem: string | null
  session: string | null
  faces: string[]
  fingerprintBefore: Record<string, string> | null
  fingerprintAfter: Record<string, string> | null
  diffPath: string | null
  linesAdded: number | null
  linesRemoved: number | null
}

/** One version's summary. */
export interface VersionSummary {
  commit: string
  parent: string | null
  committedAt: string
  subject: string
  op: string | null
  checksum: string | null
  checksumPrev: string | null
  stateId: string | null
  session: string | null
  acceptance: string | null
  intent: string | null
}

/** One changed object inside a version. */
export interface VersionChange {
  key: string
  change: string
  faces: string[]
  fingerprintBefore: Record<string, string> | null
  fingerprintAfter: Record<string, string> | null
  linesAdded: number | null
  linesRemoved: number | null
}

/** Parse a JSON column, tolerating NULL and malformed values. */
function parseJson(value: unknown): Record<string, string> | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : null
  } catch {
    return null
  }
}

function parseArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : []
  } catch {
    return []
  }
}

/** Clamp a requested limit into 1..100. */
export function clampLimit(value: unknown, fallback = 20): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(100, Math.max(1, number))
}

/**
 * A block's full history, oldest first.
 *
 * A key (`blocks|01_Cavity_A|100_Cycle`) matches exactly; a bare block name
 * (`100_Cycle`) matches the last segment of every key.
 *
 * @param store - the open store.
 * @param block - the evidence key or the block name.
 * @param limit - maximum rows.
 * @returns the timeline rows.
 */
export function blockHistory(store: VersionStore, block: string, limit = 100): TimelineEntry[] {
  const exact = block.includes('|')
  const rows = store.all<Record<string, unknown>>(
    `SELECT seq, commit_sha, occurred_at, subject, reason, problem_ref, session_id, faces,
            fingerprint_before, fingerprint_after, diff_path, lines_added, lines_removed
     FROM block_timeline WHERE ${exact ? 'block_key = ?' : 'block_key LIKE ?'} ORDER BY seq LIMIT ?`,
    exact ? block : `%|${block}`,
    limit,
  )
  return rows.map((row) => ({
    seq: Number(row['seq'] ?? 0),
    commit: String(row['commit_sha'] ?? ''),
    occurredAt: String(row['occurred_at'] ?? ''),
    subject: typeof row['subject'] === 'string' ? row['subject'] : null,
    reason: typeof row['reason'] === 'string' ? row['reason'] : null,
    problem: typeof row['problem_ref'] === 'string' ? row['problem_ref'] : null,
    session: typeof row['session_id'] === 'string' ? row['session_id'] : null,
    faces: parseArray(row['faces']),
    fingerprintBefore: parseJson(row['fingerprint_before']),
    fingerprintAfter: parseJson(row['fingerprint_after']),
    diffPath: typeof row['diff_path'] === 'string' ? row['diff_path'] : null,
    linesAdded: typeof row['lines_added'] === 'number' ? row['lines_added'] : null,
    linesRemoved: typeof row['lines_removed'] === 'number' ? row['lines_removed'] : null,
  }))
}

/** Read one version row. */
export function versionSummary(store: VersionStore, commit: string): VersionSummary | null {
  const row = store.get<Record<string, unknown>>(
    `SELECT commit_sha, parent_sha, committed_at, subject, op, plc_checksum, plc_checksum_prev,
            state_id, session_id, acceptance, subject_norm
     FROM versions WHERE commit_sha = ?`,
    commit,
  )
  if (row === undefined) return null
  return {
    commit: String(row['commit_sha'] ?? ''),
    parent: typeof row['parent_sha'] === 'string' ? row['parent_sha'] : null,
    committedAt: String(row['committed_at'] ?? ''),
    subject: String(row['subject'] ?? ''),
    op: typeof row['op'] === 'string' ? row['op'] : null,
    checksum: typeof row['plc_checksum'] === 'string' ? row['plc_checksum'] : null,
    checksumPrev: typeof row['plc_checksum_prev'] === 'string' ? row['plc_checksum_prev'] : null,
    stateId: typeof row['state_id'] === 'string' ? row['state_id'] : null,
    session: typeof row['session_id'] === 'string' ? row['session_id'] : null,
    acceptance: typeof row['acceptance'] === 'string' ? row['acceptance'] : null,
    intent: typeof row['subject_norm'] === 'string' ? row['subject_norm'] : null,
  }
}

/** The objects one version changed. */
export function versionChanges(store: VersionStore, commit: string, limit = 100): VersionChange[] {
  const rows = store.all<Record<string, unknown>>(
    `SELECT object_key, change, faces_json, fingerprint_before, fingerprint_after, lines_added, lines_removed
     FROM change_events WHERE commit_sha = ? ORDER BY object_key LIMIT ?`,
    commit,
    limit,
  )
  return rows.map((row) => ({
    key: String(row['object_key'] ?? ''),
    change: String(row['change'] ?? ''),
    faces: parseArray(row['faces_json']),
    fingerprintBefore: parseJson(row['fingerprint_before']),
    fingerprintAfter: parseJson(row['fingerprint_after']),
    linesAdded: typeof row['lines_added'] === 'number' ? row['lines_added'] : null,
    linesRemoved: typeof row['lines_removed'] === 'number' ? row['lines_removed'] : null,
  }))
}

/** Every version that ever carried one PLC checksum (repeats are normal). */
export function versionsByChecksum(store: VersionStore, checksum: string, limit = 50): VersionSummary[] {
  const rows = store.all<Record<string, unknown>>(
    `SELECT commit_sha FROM versions WHERE plc_checksum = ? ORDER BY committed_at LIMIT ?`,
    checksum,
    limit,
  )
  return rows
    .map((row) => versionSummary(store, String(row['commit_sha'] ?? '')))
    .filter((entry): entry is VersionSummary => entry !== null)
}

/** Search versions by face, since, subject or acceptance. */
export function searchVersions(
  store: VersionStore,
  filters: { face?: string; since?: string; problem?: string; limit?: number },
): VersionSummary[] {
  const limit = clampLimit(filters.limit, 20)
  if (filters.face !== undefined) {
    const rows = store.all<Record<string, unknown>>(
      `SELECT DISTINCT v.commit_sha
       FROM versions v
       JOIN change_events e ON e.commit_sha = v.commit_sha
       WHERE e.faces_json LIKE ? ORDER BY v.committed_at DESC LIMIT ?`,
      `%${JSON.stringify(filters.face)}%`,
      limit,
    )
    return rows
      .map((row) => versionSummary(store, String(row['commit_sha'] ?? '')))
      .filter((entry): entry is VersionSummary => entry !== null)
  }
  if (filters.problem !== undefined) {
    const rows = store.all<Record<string, unknown>>(
      `SELECT DISTINCT commit_sha FROM change_events WHERE problem_ref = ? ORDER BY occurred_at DESC LIMIT ?`,
      filters.problem,
      limit,
    )
    return rows
      .map((row) => versionSummary(store, String(row['commit_sha'] ?? '')))
      .filter((entry): entry is VersionSummary => entry !== null)
  }
  if (filters.since !== undefined) {
    const rows = store.all<Record<string, unknown>>(
      `SELECT commit_sha FROM versions WHERE committed_at >= ? ORDER BY committed_at DESC LIMIT ?`,
      filters.since,
      limit,
    )
    return rows
      .map((row) => versionSummary(store, String(row['commit_sha'] ?? '')))
      .filter((entry): entry is VersionSummary => entry !== null)
  }
  const rows = store.all<Record<string, unknown>>(
    'SELECT commit_sha FROM versions ORDER BY committed_at DESC LIMIT ?',
    limit,
  )
  return rows
    .map((row) => versionSummary(store, String(row['commit_sha'] ?? '')))
    .filter((entry): entry is VersionSummary => entry !== null)
}

/** A block's documents, via the DOCUMENTS edges (P3). Accepts a key or a bare name. */
export function documentsForBlock(store: VersionStore, block: string): { path: string; title: string | null; anchor: string | null }[] {
  const exact = block.includes('|')
  const rows = store.all<Record<string, unknown>>(
    `SELECT p.value AS path, t.value AS title, ep.value AS anchor
     FROM graph_nodes o
     JOIN graph_edges e ON e.to_node_id = o.id AND e.type = 'DOCUMENTS'
     JOIN graph_nodes d ON d.id = e.from_node_id AND d.kind = 'Doc'
     LEFT JOIN graph_node_properties p ON p.node_id = d.id AND p.name = 'path'
     LEFT JOIN graph_node_properties t ON t.node_id = d.id AND t.name = 'title'
     LEFT JOIN graph_edge_properties ep ON ep.edge_id = e.id AND ep.name = 'anchor'
     WHERE o.kind = 'Object' AND (${exact ? 'o.name = ?' : 'o.name LIKE ?'})`,
    exact ? block : `%|${block}`,
  )
  return rows.map((row) => ({
    path: String(row['path'] ?? ''),
    title: typeof row['title'] === 'string' ? row['title'] : null,
    anchor: typeof row['anchor'] === 'string' ? row['anchor'] : null,
  }))
}

/** A problem's affected blocks, sessions and commits (P4). */
export function problemView(store: VersionStore, ref: string): {
  commit: string
  object: string
  occurredAt: string
  session: string | null
}[] {
  const rows = store.all<Record<string, unknown>>(
    `SELECT commit_sha, object_key, occurred_at, session_id
     FROM change_events WHERE problem_ref = ? ORDER BY occurred_at`,
    ref,
  )
  return rows.map((row) => ({
    commit: String(row['commit_sha'] ?? ''),
    object: String(row['object_key'] ?? ''),
    occurredAt: String(row['occurred_at'] ?? ''),
    session: typeof row['session_id'] === 'string' ? row['session_id'] : null,
  }))
}
