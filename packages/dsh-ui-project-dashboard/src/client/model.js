/**
 * Pure dashboard model: turn the host's workspace/session snapshots into rows,
 * filter them, and derive the tag tree. No React, no IO — the tests drive this
 * module directly.
 *
 * The shapes are the ones the shipped plugins already use:
 *  - workspace: `{ workspaceId, path, title, createdAt, sessionIds }`
 *    (from ui-workspace's `useWorkspaces` root hook)
 *  - session: `{ id, title, blank, updatedAt, running, ... }`
 *    (from ui-session's `useSessions` snapshot `{ ids, byId }`)
 *  - status: `Map<sessionId, { running, pendingInteraction?, completionUnread }>`
 *
 * @module dsh-ui-project-dashboard/client/model
 */

/** Deepest tag path the editor accepts; the host validates the same limit. */
export const MAX_TAG_DEPTH = 4

/** Longest one segment may be, in characters (host-enforced too). */
export const MAX_SEGMENT_LENGTH = 40

/**
 * Client-side tag normalization for immediate feedback. The host normalizes and
 * validates again; this function only needs to be close enough to reject typos.
 *
 * @param {unknown} raw - user input.
 * @returns {string | null} the normalized path, or null when unusable.
 */
export function normalizeTagInput(raw) {
  if (typeof raw !== 'string') return null
  const parts = raw.split('/').map((part) => part.trim()).filter((part) => part.length > 0)
  if (parts.length === 0 || parts.length > MAX_TAG_DEPTH) return null
  if (parts.some((part) => part.length > MAX_SEGMENT_LENGTH)) return null
  return parts.join('/')
}

/** Pseudo-filter for workspaces without any tag. */
export const UNTAGGED = '__untagged'

/**
 * Whether one workspace's tags satisfy one selected filter.
 *
 * @param {readonly string[]} tags - the workspace's tags.
 * @param {string} filter - a tag path, or {@link UNTAGGED}; descendants count as a match.
 * @returns {boolean} true when the workspace matches.
 */
export function tagMatches(tags, filter) {
  if (filter === UNTAGGED) return tags.length === 0
  return tags.some((tag) => tag === filter || tag.startsWith(`${filter}/`))
}

/**
 * Coerce a timestamp to epoch milliseconds.
 *
 * Session snapshots carry numbers; workspaces carry ISO text.
 *
 * @param {unknown} value - number or ISO string.
 * @returns {number} epoch milliseconds, or 0 when unusable.
 */
export function toEpoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * Build the dashboard rows.
 *
 * @param {readonly any[]} workspaces - `useWorkspaces(...).items`.
 * @param {{ ids?: readonly string[], byId?: Record<string, any> } | undefined} sessions - session snapshot.
 * @param {Map<string, any> | undefined} statuses - session status by id.
 * @param {readonly string[] | undefined} archivedSessionIds - archived set.
 * @returns {Array<object>} rows in host order.
 */
export function buildRows(workspaces, sessions, statuses, archivedSessionIds) {
  const byId = sessions?.byId ?? {}
  const archived = new Set(archivedSessionIds ?? [])
  return (workspaces ?? []).map((workspace) => {
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    const createdAt = toEpoch(workspace.createdAt)
    let lastAt = createdAt
    let archivedCount = 0
    let blankCount = 0
    let running = 0
    let pending = 0
    const sessionTimes = []
    for (const id of sessionIds) {
      const session = byId[id]
      const updatedAt = toEpoch(session?.updatedAt)
      if (updatedAt > 0) sessionTimes.push(updatedAt)
      if (updatedAt > lastAt) lastAt = updatedAt
      if (archived.has(id)) archivedCount += 1
      if (session?.blank === true) blankCount += 1
      const status = statuses instanceof Map ? statuses.get(id) : undefined
      const isRunning = status !== undefined ? status.running === true : session?.running === true
      if (isRunning) running += 1
      if (status !== undefined && status.pendingInteraction != null) pending += 1
    }
    return {
      id: workspace.workspaceId,
      title: typeof workspace.title === 'string' ? workspace.title : '',
      path: typeof workspace.path === 'string' ? workspace.path : '',
      createdAt,
      sessions: sessionIds.length,
      sessionTimes,
      archived: archivedCount,
      blank: blankCount,
      running,
      pending,
      lastAt,
      tags: [],
    }
  })
}

/**
 * Attach tags to rows.
 *
 * @param {readonly object[]} rows - rows from {@link buildRows}.
 * @param {Record<string, { tags?: readonly string[] }> | undefined} tagsById - host tag document map.
 * @returns {Array<object>} rows with `tags`.
 */
export function decorateRows(rows, tagsById) {
  return (rows ?? []).map((row) => {
    const entry = tagsById?.[row.id]
    return { ...row, tags: Array.isArray(entry?.tags) ? entry.tags : [] }
  })
}

/**
 * Whether a row matches the free-text query (title, path, tags).
 *
 * @param {object} row - one row.
 * @param {string} query - already-trimmed, case-preserved input.
 * @returns {boolean} true when it matches.
 */
export function textHit(row, query) {
  if (query.length === 0) return true
  const needle = query.toLowerCase()
  return [row.title, row.path, ...(row.tags ?? [])].join(' ').toLowerCase().includes(needle)
}

/**
 * Filter rows by query and selected tag filters (OR across tags, descendants
 * included).
 *
 * @param {readonly object[]} rows - decorated rows.
 * @param {string} query - raw search text.
 * @param {readonly string[]} filters - selected tag paths.
 * @returns {Array<object>} the visible rows.
 */
export function filterRows(rows, query, filters) {
  const needle = typeof query === 'string' ? query.trim() : ''
  const selected = Array.isArray(filters) ? filters : []
  return (rows ?? []).filter((row) => {
    if (!textHit(row, needle)) return false
    if (selected.length === 0) return true
    return selected.some((filter) => tagMatches(row.tags ?? [], filter))
  })
}

/**
 * Build the tag tree: every prefix path with the number of rows carrying it or a
 * descendant. Counts are of workspaces, not tag instances.
 *
 * @param {readonly object[]} rows - all decorated rows (unfiltered).
 * @returns {Array<{ path: string, label: string, depth: number, count: number }>}
 */
export function tagTree(rows) {
  const counts = new Map()
  for (const row of rows ?? []) {
    const seen = new Set()
    for (const tag of row.tags ?? []) {
      const parts = tag.split('/')
      for (let index = 1; index <= parts.length; index += 1) {
        const path = parts.slice(0, index).join('/')
        if (seen.has(path)) continue
        seen.add(path)
        counts.set(path, (counts.get(path) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .map(([path, count]) => {
      const parts = path.split('/')
      return { path, label: parts[parts.length - 1], depth: parts.length - 1, count }
    })
    .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
}

/**
 * Ledger totals over the visible rows.
 *
 * @param {readonly object[]} rows - filtered rows.
 * @returns {{ workspaces: number, sessions: number, archived: number, running: number, pending: number }}
 */
export function summarize(rows) {
  const totals = { workspaces: 0, sessions: 0, archived: 0, running: 0, pending: 0 }
  for (const row of rows ?? []) {
    totals.workspaces += 1
    totals.sessions += row.sessions
    totals.archived += row.archived
    totals.running += row.running
    totals.pending += row.pending
  }
  return totals
}
