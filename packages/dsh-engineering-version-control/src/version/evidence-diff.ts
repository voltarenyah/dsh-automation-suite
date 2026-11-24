/**
 * Object-level change detection from two evidence ledgers.
 *
 * This is deliberately **not** an XML diff: a change event is "object X's
 * fingerprints moved from A to B", which is exactly what the ledger records and
 * what a commit's history needs. Reading the XML is the expert's job (bundle +
 * graph), not the version store's.
 *
 * @module dsh-engineering-context/version/evidence-diff
 */

import type { EvidenceDocument, EvidenceObject } from '../evidence.js'

/** One object's change between two revisions. */
export interface ObjectChange {
  /** The evidence key, e.g. `blocks|01_Cavity_A|100_Cycle_Selection_Cav_A`. */
  key: string
  change: 'added' | 'modified' | 'removed'
  /** The face names that differ (`Code`, `Interface`, …), or every face for added/removed. */
  faces: string[]
  /** The fingerprint before, or null for an added object. */
  before: Record<string, string> | null
  /** The fingerprint after, or null for a removed object. */
  after: Record<string, string> | null
  /** The object metadata from whichever side still has it. */
  object: EvidenceObject | null
}

/** Compare two face maps, returning the keys whose values differ. */
export function changedFaces(
  before: Record<string, string> | null,
  after: Record<string, string> | null,
): string[] {
  if (before === null && after === null) return []
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const changed: string[] = []
  for (const key of keys) {
    if ((before?.[key] ?? null) !== (after?.[key] ?? null)) changed.push(key)
  }
  return changed.sort()
}

/**
 * Compare a parent revision's ledger with a child's.
 *
 * A missing side means "the object did not exist": a new file is `added`, a
 * disappeared one is `removed`. Objects whose fingerprints are equal and whose
 * state is unchanged produce no change event.
 *
 * @param previous - the parent ledger, or null when the revision is the baseline.
 * @param current - the ledger being recorded, or null for a deletion-only step.
 * @returns the changes, sorted by key.
 */
export function diffEvidence(
  previous: EvidenceDocument | null,
  current: EvidenceDocument | null,
): ObjectChange[] {
  const before = previous?.objects ?? new Map<string, EvidenceObject>()
  const after = current?.objects ?? new Map<string, EvidenceObject>()
  const changes: ObjectChange[] = []

  for (const [key, object] of after) {
    const previousObject = before.get(key)
    if (previousObject === undefined) {
      changes.push({
        key,
        change: 'added',
        faces: Object.keys(object.fingerprint ?? {}).sort(),
        before: null,
        after: object.fingerprint,
        object,
      })
      continue
    }
    const faces = changedFaces(previousObject.fingerprint, object.fingerprint)
    const stateChanged = previousObject.state !== object.state
    if (faces.length === 0 && !stateChanged) continue
    changes.push({
      key,
      change: 'modified',
      faces: stateChanged && faces.length === 0 ? ['State'] : faces,
      before: previousObject.fingerprint,
      after: object.fingerprint,
      object,
    })
  }

  for (const [key, object] of before) {
    if (after.has(key)) continue
    changes.push({
      key,
      change: 'removed',
      faces: Object.keys(object.fingerprint ?? {}).sort(),
      before: object.fingerprint,
      after: null,
      object,
    })
  }

  changes.sort((left, right) => left.key.localeCompare(right.key))
  return changes
}

/** A stable event id for one (commit, object) pair: replaying a commit never duplicates. */
export function eventIdFor(commitSha: string, objectKey: string): string {
  // A plain deterministic spelling, not a cryptographic hash: it is an identity,
  // and readability in SQL output matters more than collision resistance here.
  return `evt:${commitSha.slice(0, 12)}:${objectKey.replace(/[|/\s]+/gu, '.').slice(0, 80)}`
}
