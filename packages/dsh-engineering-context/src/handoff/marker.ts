/**
 * Build, serialize and validate the handoff marker.
 *
 * The marker is deliberately a **projection of the committed evidence ledger**,
 * not a new set of facts: the controller already wrote one fingerprint per
 * object, the PLC checksum and the state id, and the plugin already committed
 * that document. Re-using it means "what was handed out" and "what git says"
 * can be compared byte for byte (after canonicalization), instead of trusting
 * two independently computed values.
 *
 * @module dsh-engineering-context/handoff/marker
 */

import { createHash } from 'node:crypto'

import { EngineeringContextError } from '../errors.js'
import {
  HANDOFF_ARCHIVE_MODE,
  HANDOFF_MARKER_KIND,
  HANDOFF_SCHEMA_VERSION,
  type HandoffMarker,
  type HandoffMarkerDevice,
} from './types.js'

/** A JSON object, as untrusted input. */
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A non-empty string, or null. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A finite non-negative integer, or null. */
export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** SHA-256 of UTF-8 text, lowercase hex. */
export function sha256Hex(textValue: string): string {
  return createHash('sha256').update(textValue, 'utf8').digest('hex')
}

/** A `sha256:`-prefixed digest, matching the controller's spelling. */
export function sha256Digest(textValue: string): string {
  return `sha256:${sha256Hex(textValue)}`
}

/** Sort by UTF-16 code unit, the JS equivalent of `StringComparer.Ordinal`. */
function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Stable JSON: object keys sorted recursively, arrays kept in order.
 *
 * Two ledgers that say the same thing must compare equal regardless of the
 * property order TIA or `JSON.stringify` happened to use.
 *
 * @param value - any JSON value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const object = record(value)
  if (object === null) return 'null'
  const keys = Object.keys(object).sort(ordinal)
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

/** True when two values are the same canonical JSON. */
export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

/**
 * The source-only identity of one ledger.
 *
 * It covers what the engineer edited (fingerprints, content hashes, F-signatures)
 * and excludes what a recompile legitimately changes (`plcChecksum`, `stateId`)
 * and what is machine-specific (`path`, `reason`). That makes it useful for a
 * quick "is this the same source?" comparison; the full embedded ledger is still
 * what the import compares against git.
 *
 * @param evidence - one parsed `_evidence.json` document.
 */
export function sourceIdentityOf(evidence: Record<string, unknown>): string {
  const objects = record(evidence['objects']) ?? {}
  const keys = Object.keys(objects).sort(ordinal)
  const projection = keys.map((key) => {
    const object = record(objects[key]) ?? {}
    const safety = record(object['safetySignature'])
    return {
      key,
      category: object['category'] ?? null,
      name: object['name'] ?? null,
      group: object['group'] ?? null,
      state: object['state'] ?? null,
      fingerprint: object['fingerprint'] ?? null,
      contentHash: object['contentHash'] ?? null,
      isSafetyBlock: object['isSafetyBlock'] === true,
      safetySignature:
        object['isSafetyBlock'] === true
          ? {
              type: safety?.['type'] ?? null,
              value: safety?.['value'] ?? null,
              error: typeof safety?.['reason'] === 'string' && safety['reason'].length > 0,
            }
          : null,
    }
  })
  const unexportable = Array.isArray(evidence['unexportable'])
    ? evidence['unexportable']
        .map((entry) => record(entry)?.['key'])
        .filter((key): key is string => typeof key === 'string')
        .sort(ordinal)
    : []
  const tombstones = Array.isArray(evidence['tombstones'])
    ? evidence['tombstones']
        .map((entry) => record(entry)?.['key'])
        .filter((key): key is string => typeof key === 'string')
        .sort(ordinal)
    : []
  return sha256Digest(canonicalJson({ objects: projection, unexportable, tombstones }))
}

/** One device's validated marker part. */
export function markerDevice(device: string, software: string, evidence: Record<string, unknown>): HandoffMarkerDevice {
  const plcChecksum = text(evidence['plcChecksum'])
  const stateId = text(evidence['stateId'])
  const objects = record(evidence['objects'])
  if (plcChecksum === null) {
    throw new EngineeringContextError(
      'handoff_marker_invalid',
      `The evidence ledger for ${device} has no compiled PLC checksum. Compile the PLC and sync before handing it off.`,
      { device, software },
    )
  }
  if (stateId === null) {
    throw new EngineeringContextError(
      'handoff_marker_invalid',
      `The evidence ledger for ${device} has no state id; it was written by an older build. Sync again before handing it off.`,
      { device, software },
    )
  }
  if (objects === null) {
    throw new EngineeringContextError(
      'handoff_marker_invalid',
      `The evidence ledger for ${device} has no objects map.`,
      { device, software },
    )
  }
  return {
    device,
    software,
    plcChecksum,
    stateId,
    sourceIdentity: sourceIdentityOf(evidence),
    objectCount: Object.keys(objects).length,
    evidence,
  }
}

/** Everything the export knows when it builds a marker. */
export interface MarkerInput {
  handoffId: string
  createdAt: string
  head: string
  branch: string | null
  projectName: string
  tiaVersion: string
  devices: Array<{ device: string; software: string; evidence: Record<string, unknown> }>
}

/**
 * Build the marker document.
 *
 * @param input - the committed base and one evidence document per device.
 * @returns the marker, ready to serialize.
 */
export function buildMarker(input: MarkerInput): HandoffMarker {
  if (input.devices.length === 0) {
    throw new EngineeringContextError('handoff_marker_invalid', 'A handoff needs at least one PLC device.')
  }
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    kind: HANDOFF_MARKER_KIND,
    handoffId: input.handoffId,
    createdAt: input.createdAt,
    git: {
      head: input.head,
      branch: input.branch,
      sourceClean: true,
    },
    project: {
      name: input.projectName,
      tiaVersion: input.tiaVersion,
    },
    archive: { mode: HANDOFF_ARCHIVE_MODE },
    devices: input.devices.map((entry) => markerDevice(entry.device, entry.software, entry.evidence)),
  }
}

/** The canonical on-disk spelling: two-space JSON plus one trailing newline. */
export function markerText(marker: HandoffMarker): string {
  return `${JSON.stringify(marker, undefined, 2)}\n`
}

function invalid(message: string, details: Record<string, unknown> = {}): EngineeringContextError {
  return new EngineeringContextError('handoff_marker_invalid', message, details)
}

/**
 * Validate a marker read from an archive.
 *
 * This validates the **shape**; the cross-check against git happens in
 * `verifyMarkerAgainstGit`. Everything is treated as untrusted JSON.
 *
 * @param value - the parsed marker.
 * @param origin - where it came from, for the message.
 */
export function validateMarker(value: unknown, origin: string): HandoffMarker {
  const marker = record(value)
  if (marker === null) throw invalid(`${origin} is not a JSON object.`)
  if (marker['schemaVersion'] !== HANDOFF_SCHEMA_VERSION) {
    throw invalid(`${origin} has schemaVersion ${String(marker['schemaVersion'])}; this build reads ${HANDOFF_SCHEMA_VERSION}.`)
  }
  if (marker['kind'] !== HANDOFF_MARKER_KIND) {
    throw invalid(`${origin} is not a ${HANDOFF_MARKER_KIND} marker.`)
  }
  const handoffId = text(marker['handoffId'])
  const createdAt = text(marker['createdAt'])
  const git = record(marker['git'])
  const project = record(marker['project'])
  const archive = record(marker['archive'])
  const head = text(git?.['head'])
  if (handoffId === null) throw invalid(`${origin} has no handoffId.`)
  if (createdAt === null) throw invalid(`${origin} has no createdAt.`)
  if (head === null) throw invalid(`${origin} has no git.head commit.`)
  if (git?.['sourceClean'] !== true) throw invalid(`${origin} was not recorded from a clean source tree.`)
  const projectName = text(project?.['name'])
  const tiaVersion = text(project?.['tiaVersion'])
  if (projectName === null) throw invalid(`${origin} has no project name.`)
  if (tiaVersion === null) throw invalid(`${origin} has no TIA version.`)
  if (archive?.['mode'] !== HANDOFF_ARCHIVE_MODE) {
    throw invalid(`${origin} was archived with mode ${String(archive?.['mode'])}; only ${HANDOFF_ARCHIVE_MODE} is supported.`)
  }
  const devices = Array.isArray(marker['devices']) ? marker['devices'] : []
  if (devices.length === 0) throw invalid(`${origin} names no device.`)
  const parsed: HandoffMarkerDevice[] = devices.map((entry, index) => {
    const device = record(entry)
    const name = text(device?.['device'])
    const software = text(device?.['software'])
    const plcChecksum = text(device?.['plcChecksum'])
    const stateId = text(device?.['stateId'])
    const sourceIdentity = text(device?.['sourceIdentity'])
    const objectCount = count(device?.['objectCount'])
    const evidence = record(device?.['evidence'])
    if (name === null || software === null) throw invalid(`${origin} device #${index + 1} has no device/software name.`)
    if (plcChecksum === null) throw invalid(`${origin} device ${name} has no PLC checksum.`)
    if (stateId === null) throw invalid(`${origin} device ${name} has no state id.`)
    if (sourceIdentity === null) throw invalid(`${origin} device ${name} has no source identity.`)
    if (objectCount === null) throw invalid(`${origin} device ${name} has no object count.`)
    if (evidence === null) throw invalid(`${origin} device ${name} embeds no evidence ledger.`)
    return { device: name, software, plcChecksum, stateId, sourceIdentity, objectCount, evidence }
  })
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    kind: HANDOFF_MARKER_KIND,
    handoffId,
    createdAt,
    git: { head, branch: text(git?.['branch']), sourceClean: true },
    project: { name: projectName, tiaVersion },
    archive: { mode: HANDOFF_ARCHIVE_MODE },
    devices: parsed,
  }
}

/** Parse marker JSON, with the archive/marker spelling in the error. */
export function parseMarker(textValue: string, origin: string): HandoffMarker {
  let parsed: unknown
  try {
    parsed = JSON.parse(textValue)
  } catch (error) {
    throw invalid(`${origin} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`)
  }
  return validateMarker(parsed, origin)
}

/** True when two markers carry the same canonical content. */
export function sameMarker(left: HandoffMarker, right: HandoffMarker): boolean {
  return sameJson(left, right)
}
