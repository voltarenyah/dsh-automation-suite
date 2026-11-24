/**
 * Writing the version store: one commit at a time, or a full replay.
 *
 * The authoritative inputs are git and `_evidence.json`; this module turns them
 * into three synchronized views:
 *
 *   change_events   one row per changed object (the record)
 *   graph_*         Version / ChangeEvent / Object / Checksum / Session / … nodes and edges
 *   block_timeline  one row per event, ordered per block (the read model)
 *
 * All three are written in ONE transaction. When they disagree, the store is
 * rebuilt from git (`reindex`); nothing here is a second source of truth.
 *
 * @module dsh-engineering-context/version/write
 */

import type { Logger } from '@deepseek-ai/cordis'

import type { PluginConfig } from '../config.js'
import { parseEvidenceDocument, readEvidence, type EvidenceDocument } from '../evidence.js'
import { evidencePathForDevice } from '../config.js'
import type { DeviceInfo } from '../device.js'
import { gitPath, logCommits, numstatBetween, showFileAtRevision, type CommitMeta, type FileStat } from '../git.js'
import { diffEvidence, eventIdFor, type ObjectChange } from './evidence-diff.js'
import { openVersionStore, type VersionStore } from './store.js'
import { writeVersionView } from './view.js'

/** One version to record. */
export interface VersionRecordInput {
  commit: string
  parent: string | null
  device: string
  committedAt: string
  subject: string
  body: string
  op: 'create' | 'sync' | 'manual'
  checksum: string | null
  checksumPrev: string | null
  stateId: string | null
  stateIdPrev: string | null
  sessionId: string | null
  bundleDir: string | null
  changes: readonly ObjectChange[]
  lines: Map<string, FileStat>
}

/** What one write produced. */
export interface WriteReport {
  events: number
  /** True when the whole history was replayed instead of recording one commit. */
  replayed?: boolean
}

// ---------------------------------------------------------------------------
// Node / edge identities (deterministic, so a replay upserts instead of duplicating)
// ---------------------------------------------------------------------------

export const versionNode = (sha: string): string => `version:${sha}`
export const objectNode = (key: string): string => `object:${key}`
export const eventNode = (eventId: string): string => `event:${eventId}`
export const checksumNode = (value: string): string => `checksum:${value}`
export const stateNode = (value: string): string => `state:${value}`
export const sessionNode = (id: string): string => `session:${id}`
export const intentNode = (sha: string): string => `intent:${sha}`
export const bundleNode = (dir: string): string => `bundle:${dir}`
export const faceNode = (name: string): string => `face:${name}`
export const problemNode = (ref: string): string => `problem:${ref}`

/** A deterministic edge id. */
export function edgeId(type: string, from: string, to: string): string {
  return `edge:${type}:${from}:${to}`
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function upsertNode(store: VersionStore, id: string, kind: string, name: string): void {
  store.run(
    `INSERT INTO graph_nodes(id, kind, name) VALUES(?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name`,
    id,
    kind,
    name,
  )
}

function setProperty(store: VersionStore, nodeId: string, name: string, value: string | null): void {
  if (value === null) return
  store.run(
    `INSERT INTO graph_node_properties(node_id, name, value) VALUES(?, ?, ?)
     ON CONFLICT(node_id, name) DO UPDATE SET value = excluded.value`,
    nodeId,
    name,
    value,
  )
}

function upsertEdge(store: VersionStore, type: string, from: string, to: string): void {
  store.run(
    `INSERT INTO graph_edges(id, type, from_node_id, to_node_id) VALUES(?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET type = excluded.type, from_node_id = excluded.from_node_id, to_node_id = excluded.to_node_id`,
    edgeId(type, from, to),
    type,
    from,
    to,
  )
}

function setEdgeProperty(store: VersionStore, type: string, from: string, to: string, name: string, value: string | null): void {
  if (value === null) return
  store.run(
    `INSERT INTO graph_edge_properties(edge_id, name, value) VALUES(?, ?, ?)
     ON CONFLICT(edge_id, name) DO UPDATE SET value = excluded.value`,
    edgeId(type, from, to),
    name,
    value,
  )
}

/** The subject with the trailer block removed (the intent as the caller wrote it). */
export function intentFromMessage(body: string): string {
  const lines = body.split(/\r?\n/u)
  const kept: string[] = []
  for (const line of lines) {
    if (/^Tia-(Op|Checksum|State|Manifest|Changed|Checksum-Prev|State-Prev):/u.test(line.trim())) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/**
 * Record the full baseline snapshot of one commit (the first one that has a ledger).
 *
 * @param store - the open store.
 * @param input - the commit and its ledger.
 * @returns the number of objects recorded.
 */
export function recordBaseline(
  store: VersionStore,
  input: { commit: string; device: string; committedAt: string; evidence: EvidenceDocument; subject?: string },
): number {
  const { commit, device, committedAt, evidence } = input
  let count = 0
  store.transaction(() => {
    upsertNode(store, versionNode(commit), 'Version', commit)
    setProperty(store, versionNode(commit), 'commitSha', commit)
    setProperty(store, versionNode(commit), 'committedAt', committedAt)
    setProperty(store, versionNode(commit), 'device', device)
    setProperty(store, versionNode(commit), 'op', 'create')
    setProperty(store, versionNode(commit), 'subject', input.subject ?? null)
    if (evidence.plcChecksum !== null) {
      upsertNode(store, checksumNode(evidence.plcChecksum), 'Checksum', evidence.plcChecksum)
      setProperty(store, checksumNode(evidence.plcChecksum), 'value', evidence.plcChecksum)
      upsertEdge(store, 'HAS_CHECKSUM', versionNode(commit), checksumNode(evidence.plcChecksum))
    }
    if (evidence.stateId !== null) {
      upsertNode(store, stateNode(evidence.stateId), 'State', evidence.stateId)
      setProperty(store, stateNode(evidence.stateId), 'value', evidence.stateId)
      upsertEdge(store, 'HAS_STATE', versionNode(commit), stateNode(evidence.stateId))
    }

    for (const [key, object] of evidence.objects) {
      const id = objectNode(key)
      upsertNode(store, id, 'Object', key)
      setProperty(store, id, 'key', key)
      setProperty(store, id, 'name', object.name)
      setProperty(store, id, 'category', object.category)
      setProperty(store, id, 'group', object.group)
      setProperty(store, id, 'path', object.path)

      store.run(
        `INSERT INTO baseline_snapshots(object_key, name, category, group_path, source_path, state, fingerprint_json, commit_sha)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(object_key) DO UPDATE SET
           name = excluded.name, category = excluded.category, group_path = excluded.group_path,
           source_path = excluded.source_path, state = excluded.state,
           fingerprint_json = excluded.fingerprint_json, commit_sha = excluded.commit_sha`,
        key,
        object.name,
        object.category,
        object.group,
        object.path,
        object.state,
        object.fingerprint === null ? null : json(object.fingerprint),
        commit,
      )
      upsertEdge(store, 'CONTAINS', versionNode(commit), id)
      setEdgeProperty(store, 'CONTAINS', versionNode(commit), id, 'fingerprintJson',
        object.fingerprint === null ? null : json(object.fingerprint))
      setEdgeProperty(store, 'CONTAINS', versionNode(commit), id, 'state', object.state)
      setEdgeProperty(store, 'CONTAINS', versionNode(commit), id, 'path', object.path)
      count += 1
    }
  })
  return count
}

// ---------------------------------------------------------------------------
// One commit
// ---------------------------------------------------------------------------

/**
 * Record one commit's change set.
 *
 * @param store - the open store.
 * @param input - the version facts and the object changes.
 * @returns what was written.
 */
export function recordVersion(store: VersionStore, input: VersionRecordInput): WriteReport {
  const reason = intentFromMessage(input.body)
  let events = 0

  store.transaction(() => {
    store.run(
      `INSERT INTO versions(commit_sha, parent_sha, device, committed_at, subject, op,
         plc_checksum, plc_checksum_prev, state_id, state_id_prev, session_id, bundle_dir, acceptance, subject_norm)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(commit_sha) DO UPDATE SET
         parent_sha = excluded.parent_sha, committed_at = excluded.committed_at,
         subject = excluded.subject, op = excluded.op,
         plc_checksum = excluded.plc_checksum, plc_checksum_prev = excluded.plc_checksum_prev,
         state_id = excluded.state_id, state_id_prev = excluded.state_id_prev,
         session_id = excluded.session_id, bundle_dir = excluded.bundle_dir,
         subject_norm = excluded.subject_norm`,
      input.commit,
      input.parent,
      input.device,
      input.committedAt,
      input.subject,
      input.op,
      input.checksum,
      input.checksumPrev,
      input.stateId,
      input.stateIdPrev,
      input.sessionId,
      input.bundleDir,
      reason.length > 0 ? reason : null,
    )

    const version = versionNode(input.commit)
    upsertNode(store, version, 'Version', input.commit)
    setProperty(store, version, 'commitSha', input.commit)
    setProperty(store, version, 'subject', input.subject)
    setProperty(store, version, 'op', input.op)
    setProperty(store, version, 'committedAt', input.committedAt)
    setProperty(store, version, 'plcChecksum', input.checksum)
    setProperty(store, version, 'stateId', input.stateId)
    setProperty(store, version, 'device', input.device)

    if (input.parent !== null) upsertEdge(store, 'PARENT', version, versionNode(input.parent))
    if (input.checksum !== null) {
      upsertNode(store, checksumNode(input.checksum), 'Checksum', input.checksum)
      setProperty(store, checksumNode(input.checksum), 'value', input.checksum)
      upsertEdge(store, 'HAS_CHECKSUM', version, checksumNode(input.checksum))
    }
    if (input.stateId !== null) {
      upsertNode(store, stateNode(input.stateId), 'State', input.stateId)
      setProperty(store, stateNode(input.stateId), 'value', input.stateId)
      upsertEdge(store, 'HAS_STATE', version, stateNode(input.stateId))
    }
    if (input.sessionId !== null) {
      upsertNode(store, sessionNode(input.sessionId), 'Session', input.sessionId)
      setProperty(store, sessionNode(input.sessionId), 'id', input.sessionId)
      upsertEdge(store, 'IN_SESSION', version, sessionNode(input.sessionId))
    }
    if (reason.length > 0) {
      upsertNode(store, intentNode(input.commit.slice(0, 12)), 'Intent', input.subject)
      setProperty(store, intentNode(input.commit.slice(0, 12)), 'text', reason)
      upsertEdge(store, 'HAS_INTENT', version, intentNode(input.commit.slice(0, 12)))
    }
    if (input.bundleDir !== null) {
      upsertNode(store, bundleNode(input.bundleDir), 'Bundle', input.bundleDir)
      setProperty(store, bundleNode(input.bundleDir), 'dir', input.bundleDir)
      upsertEdge(store, 'HAS_BUNDLE', version, bundleNode(input.bundleDir))
    }

    for (const change of input.changes) {
      const objectId = objectNode(change.key)
      const object = change.object
      upsertNode(store, objectId, 'Object', change.key)
      setProperty(store, objectId, 'key', change.key)
      if (object !== null) {
        setProperty(store, objectId, 'name', object.name)
        setProperty(store, objectId, 'category', object.category)
        setProperty(store, objectId, 'group', object.group)
        setProperty(store, objectId, 'path', object.path)
      }

      const eventId = eventIdFor(input.commit, change.key)
      const event = eventNode(eventId)
      const stat = input.lines.get(change.key)

      store.run(
        `INSERT INTO change_events(event_id, commit_sha, object_key, change, faces_json,
           fingerprint_before, fingerprint_after, lines_added, lines_removed,
           occurred_at, reason, session_id, problem_ref, diff_path, op)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           change = excluded.change, faces_json = excluded.faces_json,
           fingerprint_before = excluded.fingerprint_before, fingerprint_after = excluded.fingerprint_after,
           lines_added = excluded.lines_added, lines_removed = excluded.lines_removed,
           reason = excluded.reason, session_id = excluded.session_id, op = excluded.op`,
        eventId,
        input.commit,
        change.key,
        change.change,
        json(change.faces),
        change.before === null ? null : json(change.before),
        change.after === null ? null : json(change.after),
        stat?.added ?? null,
        stat?.removed ?? null,
        input.committedAt,
        reason.length > 0 ? reason : null,
        input.sessionId,
        input.op,
      )

      upsertNode(store, event, 'ChangeEvent', `${change.key} @ ${input.commit.slice(0, 8)}`)
      setProperty(store, event, 'eventId', eventId)
      setProperty(store, event, 'change', change.change)
      setProperty(store, event, 'faces', json(change.faces))
      setProperty(store, event, 'fingerprintBefore', change.before === null ? null : json(change.before))
      setProperty(store, event, 'fingerprintAfter', change.after === null ? null : json(change.after))
      setProperty(store, event, 'occurredAt', input.committedAt)

      upsertEdge(store, 'PRODUCED', version, event)
      upsertEdge(store, 'CHANGED', event, objectId)
      for (const face of change.faces) {
        upsertNode(store, faceNode(face), 'Face', face)
        setProperty(store, faceNode(face), 'name', face)
        upsertEdge(store, 'TOUCHED', event, faceNode(face))
      }
      if (input.sessionId !== null) upsertEdge(store, 'IN_SESSION', event, sessionNode(input.sessionId))

      const maxSeq = store.get<{ seq: number | null }>(
        'SELECT MAX(seq) AS seq FROM block_timeline WHERE block_key = ?',
        change.key,
      )
      const seq = (maxSeq?.seq ?? 0) + 1
      store.run(
        `INSERT INTO block_timeline(block_key, seq, event_id, commit_sha, occurred_at, subject, reason,
           problem_ref, session_id, faces, fingerprint_before, fingerprint_after, diff_path, lines_added, lines_removed)
         VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(block_key, seq) DO UPDATE SET
           event_id = excluded.event_id, commit_sha = excluded.commit_sha, occurred_at = excluded.occurred_at,
           subject = excluded.subject, reason = excluded.reason, session_id = excluded.session_id,
           faces = excluded.faces, fingerprint_before = excluded.fingerprint_before,
           fingerprint_after = excluded.fingerprint_after, lines_added = excluded.lines_added,
           lines_removed = excluded.lines_removed`,
        change.key,
        seq,
        eventId,
        input.commit,
        input.committedAt,
        input.subject,
        reason.length > 0 ? reason : null,
        input.sessionId,
        json(change.faces),
        change.before === null ? null : json(change.before),
        change.after === null ? null : json(change.after),
        stat?.added ?? null,
        stat?.removed ?? null,
      )
      events += 1
    }
  })

  return { events }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** What a replay did. */
export interface ReindexReport {
  versions: number
  events: number
  baseline: number
  skipped: string[]
  warnings: string[]
}

/** Delete every version-domain row (the store is a derived index). */
export function clearVersionStore(store: VersionStore): void {
  store.transaction(() => {
    store.run('DELETE FROM block_timeline')
    store.run('DELETE FROM change_events')
    store.run('DELETE FROM baseline_snapshots')
    store.run('DELETE FROM graph_edge_properties')
    store.run('DELETE FROM graph_edges')
    store.run('DELETE FROM graph_node_properties')
    store.run('DELETE FROM graph_nodes')
    store.run('DELETE FROM versions')
  })
}

/**
 * Rebuild the store from the repository's history.
 *
 * Every commit is replayed in order; a commit without a readable ledger is
 * skipped and reported (an early commit before the first export has none).
 *
 * @param input - the store, the workspace, the device and a logger.
 * @returns what was replayed.
 */
export async function reindexVersionStore(input: {
  root: string
  config: PluginConfig
  device: DeviceInfo
  log: Logger
}): Promise<ReindexReport> {
  const { root, config, device, log } = input
  const report: ReindexReport = { versions: 0, events: 0, baseline: 0, skipped: [], warnings: [] }
  const commits = await logCommits(root)
  if (commits.length === 0) {
    report.warnings.push('The workspace is not a git repository, so there is no version history to replay.')
    return report
  }

  const deviceRel = gitPath(root, device.directory)
  const store = openVersionStore(config, root)
  try {
    clearVersionStore(store)

    let previous: EvidenceDocument | null = null
    let previousMeta: CommitMeta | null = null
    let baselineDone = false

    for (const meta of commits) {
      const raw = await showFileAtRevision(root, meta.sha, `${deviceRel}/_evidence.json`)
      if (raw === null) {
        report.skipped.push(meta.sha.slice(0, 8))
        continue
      }
      let current: EvidenceDocument
      try {
        current = parseEvidenceDocument(raw, `${meta.sha}:${deviceRel}/_evidence.json`)
      } catch (error) {
        report.skipped.push(meta.sha.slice(0, 8))
        report.warnings.push(`Ledger of ${meta.sha.slice(0, 8)} could not be parsed: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }

      if (!baselineDone) {
        report.baseline = recordBaseline(store, {
          commit: meta.sha,
          device: device.device,
          committedAt: meta.committedAt,
          evidence: current,
          subject: meta.subject,
        })
        store.run(
          `INSERT INTO versions(commit_sha, parent_sha, device, committed_at, subject, op,
             plc_checksum, plc_checksum_prev, state_id, state_id_prev, session_id, bundle_dir, acceptance, subject_norm)
           VALUES(?, NULL, ?, ?, ?, 'create', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL)
           ON CONFLICT(commit_sha) DO UPDATE SET subject = excluded.subject, committed_at = excluded.committed_at`,
          meta.sha,
          device.device,
          meta.committedAt,
          meta.subject,
          current.plcChecksum,
          current.stateId,
        )
        report.versions += 1
        baselineDone = true
        previous = current
        previousMeta = meta
        continue
      }

      const changes = diffEvidence(previous, current)
      const lines = new Map<string, FileStat>()
      if (previousMeta !== null && changes.length > 0) {
        const stats = await numstatBetween(root, previousMeta.sha, meta.sha, [deviceRel])
        for (const change of changes) {
          const path = change.object?.path
          if (path === null || path === undefined) continue
          const stat = stats.get(`${deviceRel}/${path}`)
          if (stat !== undefined) lines.set(change.key, stat)
        }
      }

      recordVersion(store, {
        commit: meta.sha,
        parent: previousMeta?.sha ?? null,
        device: device.device,
        committedAt: meta.committedAt,
        subject: meta.subject,
        body: meta.body,
        op: 'sync',
        checksum: current.plcChecksum,
        checksumPrev: previous?.plcChecksum ?? null,
        stateId: current.stateId,
        stateIdPrev: previous?.stateId ?? null,
        sessionId: null,
        bundleDir: null,
        changes,
        lines,
      })
      report.versions += 1
      report.events += changes.length
      previous = current
      previousMeta = meta
    }

    log.info(
      `Version store replayed: ${report.versions} version(s), ${report.events} change event(s), ` +
        `${report.baseline} baseline object(s), ${report.skipped.length} commit(s) without a ledger.`,
    )
  } finally {
    store.close()
  }

  // The browser tab reads a flat projection; regenerate it after every replay.
  await writeVersionView(config, root)
  return report
}

/**
 * Record the commit that was just created, or replay the whole history when the
 * store is empty (the first commit after this feature lands).
 *
 * Never throws for a store-side problem: the commit already exists, and the
 * caller reports the failure as a warning.
 *
 * @param input - workspace, device, commit id and the created commit's metadata.
 * @returns what was written, or null when the commit was already recorded.
 */
export async function recordCommitAfterWrite(input: {
  root: string
  config: PluginConfig
  device: DeviceInfo
  commit: CommitMeta
  sessionId: string | null
  bundleDir: string | null
  log: Logger
}): Promise<WriteReport | null> {
  const { root, config, device, commit, sessionId, bundleDir, log } = input
  const store = openVersionStore(config, root)
  let closed = false
  try {
    const existing = store.get<{ commit_sha: string }>('SELECT commit_sha FROM versions WHERE commit_sha = ?', commit.sha)
    if (existing !== undefined) return null

    // The first commit recorded after this feature lands has no history yet:
    // replay instead of recording one version in isolation.
    const total = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM versions')
    if ((total?.n ?? 0) === 0) {
      store.close()
      closed = true
      await reindexVersionStore({ root, config, device, log })
      return { events: 0, replayed: true }
    }

    const deviceRel = gitPath(root, device.directory)
    const parent = commit.parents[0] ?? null
    if (parent === null) {
      // A root commit: nothing to diff against; replay instead (this is the
      // baseline import, normally done by create_engineering_project).
      return { events: 0 }
    }

    const current = await readEvidence(evidencePathForDevice(device.directory))
    if (current === null) {
      log.warn(`No evidence ledger at ${evidencePathForDevice(device.directory)}; the commit was not recorded in the version store.`)
      return null
    }
    const parentRaw = await showFileAtRevision(root, parent, `${deviceRel}/_evidence.json`)
    const previous = parentRaw === null ? null : parseEvidenceDocument(parentRaw, `${parent}:${deviceRel}/_evidence.json`)

    const changes = diffEvidence(previous, current)
    const lines = new Map<string, FileStat>()
    if (changes.length > 0) {
      const stats = await numstatBetween(root, parent, commit.sha, [deviceRel])
      for (const change of changes) {
        const path = change.object?.path
        if (path === null || path === undefined) continue
        const stat = stats.get(`${deviceRel}/${path}`)
        if (stat !== undefined) lines.set(change.key, stat)
      }
    }

    const written = recordVersion(store, {
      commit: commit.sha,
      parent,
      device: device.device,
      committedAt: commit.committedAt,
      subject: commit.subject,
      body: commit.body,
      op: 'sync',
      checksum: current.plcChecksum,
      checksumPrev: previous?.plcChecksum ?? null,
      stateId: current.stateId,
      stateIdPrev: previous?.stateId ?? null,
      sessionId,
      bundleDir,
      changes,
      lines,
    })
    await writeVersionView(config, root)
    return written
  } finally {
    if (!closed) store.close()
  }
}
