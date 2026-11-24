/**
 * The evidence ledger, as this plugin reads it.
 *
 * The controller writes the ledger (it is the only side that can read TIA), and
 * the plugin commits it with the XML. This module only parses and validates the
 * document: it does not compute fingerprints and never treats a missing file as
 * "nothing changed".
 *
 * @module dsh-engineering-context/evidence
 */

import { readFile } from 'node:fs/promises'

import { EngineeringContextError } from './errors.js'

/** One object as the ledger records it. */
export interface EvidenceObject {
  key: string
  category: string
  name: string
  group: string | null
  /** Path relative to the device directory, e.g. `blocks/010_Cell/FB.xml`. */
  path: string | null
  /** Present objects have no `state`; unexportable ones say so. */
  state: 'present' | 'unexportable'
  reason: string | null
  fingerprint: Record<string, string> | null
  contentHash: string | null
}

/** One object that disappeared from the PLC. */
export interface EvidenceTombstone {
  key: string
  category: string | null
  name: string | null
  group: string | null
  removedAtChecksum: string | null
  reason: string | null
}

/** The ledger of one device. */
export interface EvidenceDocument {
  schemaVersion: number
  hashAlgo: string | null
  device: string | null
  software: string | null
  plcChecksum: string | null
  stateId: string | null
  objects: Map<string, EvidenceObject>
  tombstones: EvidenceTombstone[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function objectOf(key: string, raw: unknown): EvidenceObject | null {
  const item = record(raw)
  if (item === null) return null
  const category = text(item['category'])
  const name = text(item['name'])
  if (category === null || name === null) return null
  const fingerprint = record(item['fingerprint'])
  return {
    key,
    category,
    name,
    group: text(item['group']),
    path: text(item['path']),
    state: item['state'] === 'unexportable' ? 'unexportable' : 'present',
    reason: text(item['reason']),
    fingerprint:
      fingerprint === null
        ? null
        : Object.fromEntries(
            Object.entries(fingerprint)
              .map(([id, value]) => [id, text(value)] as const)
              .filter((entry): entry is readonly [string, string] => entry[1] !== null),
          ),
    contentHash: text(item['contentHash']),
  }
}

/**
 * Read one ledger.
 *
 * @param file - absolute path of `_evidence.json`.
 * @returns the document, or `null` when the file does not exist.
 * @throws {EngineeringContextError} `evidence_invalid` when it exists but cannot
 *   be used. A corrupt ledger must never be mistaken for an empty one.
 */
export async function readEvidence(file: string): Promise<EvidenceDocument | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new EngineeringContextError('evidence_invalid', `The evidence ledger ${file} could not be read.`, {
      file,
      cause: error instanceof Error ? error.message : String(error),
    })
  }

  return parseEvidenceDocument(raw, file)
}

/**
 * Parse one ledger that was already read into memory.
 *
 * The read-only `project_diff` tool reads a ledger with `git show` (a revision
 * that only exists inside git, never as a working file), so parsing has to be
 * separable from reading. The validation is exactly the same: a document with
 * another schema version is refused rather than treated as empty.
 *
 * @param raw - the ledger's JSON text.
 * @param file - the spelling to report in errors (a path, or `revision:path`).
 * @returns the document.
 * @throws {EngineeringContextError} `evidence_invalid` when it cannot be used.
 */
export function parseEvidenceDocument(raw: string, file: string): EvidenceDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new EngineeringContextError('evidence_invalid', `The evidence ledger ${file} is not valid JSON.`, {
      file,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const root = record(parsed)
  if (root === null) {
    throw new EngineeringContextError('evidence_invalid', `The evidence ledger ${file} is not a JSON object.`, { file })
  }
  const schemaVersion = typeof root['schemaVersion'] === 'number' ? root['schemaVersion'] : 0
  if (schemaVersion !== 1) {
    throw new EngineeringContextError(
      'evidence_invalid',
      `The evidence ledger ${file} has schemaVersion ${schemaVersion}; this plugin understands 1. Rebuild it with a full scan.`,
      { file, schemaVersion },
    )
  }

  const objects = new Map<string, EvidenceObject>()
  const rawObjects = record(root['objects']) ?? {}
  for (const [key, value] of Object.entries(rawObjects)) {
    const entry = objectOf(key, value)
    if (entry !== null) objects.set(key, entry)
  }
  if (Array.isArray(root['unexportable'])) {
    for (const value of root['unexportable']) {
      const item = record(value)
      if (item === null) continue
      const key = text(item['key']) ?? `${text(item['category']) ?? ''}||${text(item['name']) ?? ''}`
      const entry = objectOf(key, item)
      if (entry !== null) objects.set(key, { ...entry, state: 'unexportable' })
    }
  }

  const tombstones: EvidenceTombstone[] = []
  if (Array.isArray(root['tombstones'])) {
    for (const value of root['tombstones']) {
      const item = record(value)
      if (item === null) continue
      const key = text(item['key'])
      if (key === null) continue
      tombstones.push({
        key,
        category: text(item['category']),
        name: text(item['name']),
        group: text(item['group']),
        removedAtChecksum: text(item['removedAtChecksum']),
        reason: text(item['reason']),
      })
    }
  }

  return {
    schemaVersion,
    hashAlgo: text(root['hashAlgo']),
    device: text(root['device']),
    software: text(root['software']),
    plcChecksum: text(root['plcChecksum']),
    stateId: text(root['stateId']),
    objects,
    tombstones,
  }
}

/**
 * The objects that are actually present in the source tree.
 *
 * Unexportable objects are intentionally excluded: they have no fresh XML, and a
 * sync must not delete their previous file merely because TIA refused to export
 * them again.
 *
 * @param document - the ledger.
 * @returns the present objects, in key order.
 */
export function presentObjects(document: EvidenceDocument): EvidenceObject[] {
  return [...document.objects.values()]
    .filter((entry) => entry.state === 'present')
    .sort((left, right) => left.key.localeCompare(right.key))
}