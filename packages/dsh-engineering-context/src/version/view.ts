/**
 * The flat view the browser half reads.
 *
 * The renderer cannot open SQLite, so the store is projected into one JSON file
 * after every write: `<workspace>/.dsh/versions-view.json`. It carries exactly
 * what the Versions tab paints — versions, their changed objects (with face
 * fingerprints), block timelines and problem references — and nothing else.
 *
 * The file is a **derived artifact**: it can be regenerated from the store at
 * any time, and a failure to write it must never fail the commit or the replay
 * that triggered it.
 *
 * @module dsh-engineering-context/version/view
 */

import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { PluginConfig } from '../config.js'
import { openVersionStore, type VersionStore } from './store.js'

/** File name under the local state dir. */
export const VERSION_VIEW_FILE = 'versions-view.json'

/** What the view file holds, mirroring `dsh-ui-versions`' parser. */
export interface VersionViewFile {
  device: string
  workspace: string
  generatedAt: string
  counts: { versions: number; events: number; baseline: number }
  versions: {
    commit: string
    parent: string | null
    date: string
    subject: string
    op: string | null
    checksum: string | null
    checksumPrev: string | null
    acceptance: string | null
    intent: string | null
    events: {
      key: string
      change: string
      faces: string[]
      before: Record<string, string> | null
      after: Record<string, string> | null
      linesAdded: number | null
      linesRemoved: number | null
      reason: string | null
      problem: string | null
    }[]
  }[]
  timeline: {
    block: string
    seq: number
    commit: string
    date: string
    subject: string
    faces: string[]
    before: Record<string, string> | null
    after: Record<string, string> | null
    reason: string | null
    problem: string | null
  }[]
  problems: string[]
}

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

/** Build the view payload from one open store. */
export function buildVersionView(store: VersionStore, workspace: string): VersionViewFile {
  const versions = store.all<Record<string, unknown>>(
    `SELECT commit_sha, parent_sha, device, committed_at, subject, op, plc_checksum, plc_checksum_prev,
            acceptance, session_id, subject_norm
     FROM versions ORDER BY committed_at`,
  )
  const events = store.all<Record<string, unknown>>(
    `SELECT commit_sha, object_key, change, faces_json, fingerprint_before, fingerprint_after,
            lines_added, lines_removed, reason, problem_ref
     FROM change_events ORDER BY occurred_at`,
  )
  const timeline = store.all<Record<string, unknown>>(
    `SELECT block_key, seq, commit_sha, occurred_at, subject, faces, fingerprint_before,
            fingerprint_after, reason, problem_ref
     FROM block_timeline ORDER BY block_key, seq`,
  )
  const problems = store.all<Record<string, unknown>>("SELECT name FROM graph_nodes WHERE kind='Problem' ORDER BY name")
  const counts = {
    versions: (store.get<{ n: number }>('SELECT COUNT(*) AS n FROM versions')?.n ?? 0) as number,
    events: (store.get<{ n: number }>('SELECT COUNT(*) AS n FROM change_events')?.n ?? 0) as number,
    baseline: (store.get<{ n: number }>('SELECT COUNT(*) AS n FROM baseline_snapshots')?.n ?? 0) as number,
  }
  const device = typeof versions[0]?.['device'] === 'string' ? String(versions[0]['device']) : ''

  return {
    device,
    workspace,
    generatedAt: new Date().toISOString(),
    counts,
    versions: versions.map((row) => ({
      commit: String(row['commit_sha'] ?? ''),
      parent: typeof row['parent_sha'] === 'string' ? row['parent_sha'] : null,
      date: String(row['committed_at'] ?? ''),
      subject: String(row['subject'] ?? ''),
      op: typeof row['op'] === 'string' ? row['op'] : null,
      checksum: typeof row['plc_checksum'] === 'string' ? row['plc_checksum'] : null,
      checksumPrev: typeof row['plc_checksum_prev'] === 'string' ? row['plc_checksum_prev'] : null,
      acceptance: typeof row['acceptance'] === 'string' ? row['acceptance'] : null,
      intent: typeof row['subject_norm'] === 'string' ? row['subject_norm'] : null,
      events: events
        .filter((event) => event['commit_sha'] === row['commit_sha'])
        .map((event) => ({
          key: String(event['object_key'] ?? ''),
          change: String(event['change'] ?? 'modified'),
          faces: parseArray(event['faces_json']),
          before: parseJson(event['fingerprint_before']),
          after: parseJson(event['fingerprint_after']),
          linesAdded: typeof event['lines_added'] === 'number' ? event['lines_added'] : null,
          linesRemoved: typeof event['lines_removed'] === 'number' ? event['lines_removed'] : null,
          reason: typeof event['reason'] === 'string' ? event['reason'] : null,
          problem: typeof event['problem_ref'] === 'string' ? event['problem_ref'] : null,
        })),
    })),
    timeline: timeline.map((row) => ({
      block: String(row['block_key'] ?? ''),
      seq: Number(row['seq'] ?? 0),
      commit: String(row['commit_sha'] ?? ''),
      date: String(row['occurred_at'] ?? ''),
      subject: String(row['subject'] ?? ''),
      faces: parseArray(row['faces']),
      before: parseJson(row['fingerprint_before']),
      after: parseJson(row['fingerprint_after']),
      reason: typeof row['reason'] === 'string' ? row['reason'] : null,
      problem: typeof row['problem_ref'] === 'string' ? row['problem_ref'] : null,
    })),
    problems: problems.map((row) => String(row['name'] ?? '')),
  }
}

/**
 * Regenerate the browser view from the store.
 *
 * Never throws: the caller's commit/replay has already succeeded, and a stale
 * view is a display problem, not a data problem.
 *
 * @param config - the resolved plugin configuration.
 * @param root - the workspace root.
 * @returns the path written, or null when the store could not be read.
 */
export async function writeVersionView(config: PluginConfig, root: string): Promise<string | null> {
  let store: VersionStore | null = null
  try {
    store = openVersionStore(config, root)
    const view = buildVersionView(store, basename(root))
    const file = join(root, config.stateDirName, VERSION_VIEW_FILE)
    await writeFile(file, `${JSON.stringify(view, null, 2)}\n`, 'utf8')
    return file
  } catch {
    return null
  } finally {
    store?.close()
  }
}
