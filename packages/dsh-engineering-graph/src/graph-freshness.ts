/**
 * Graph freshness: the sidecar a successful ingest leaves behind, and the one rule
 * that turns it into `fresh` | `stale` | `unknown`.
 *
 * **Why a sidecar.** A knowledge database is a derived snapshot: `Ingest` reads the
 * exported source tree and writes SQLite, and nothing in the database records which
 * PLC state it came from. `knowledge_workspace` could therefore report a database's
 * size and mtime but never whether it still describes the code in `source/` — which
 * is exactly the question a caller asks before trusting an answer ("is this graph
 * from before or after the last change?"). The PLC checksum is the only honest
 * basis: the export step writes it into `source/<device>/_evidence.json`, so
 * "the graph was built from this checksum" plus "the ledger now says that checksum"
 * is a factual comparison, not a guess about timestamps.
 *
 * **Where it lives.** `<workspace>/.dsh/local/graph/<device>.json`, next to the
 * other local runtime state `.dsh/local/` (the context plugin's lock and STAGE).
 * It is local state, not a deliverable: it is never committed and it is never
 * authoritative. Deleting it costs one `knowledge_ingest` call to recreate.
 *
 * The workspace root is derived from `deviceDir` by going **up two levels**
 * (`<workspace>/source/<device>` → `<workspace>`), because the `knowledgeGraph`
 * service only receives the device directory: `process.cwd()` is the host's
 * directory, not the project's, and using it would silently write the sidecar into
 * the wrong project (or into the harness installation).
 *
 * **One writer.** The C# engine never writes this file: it knows nothing about the
 * project layout above `deviceDir`, and a second writer would be a second schema.
 * `recordGraphSidecar` is the only writer, called by the `knowledgeGraph` service
 * and by the `knowledge_ingest` tool after the engine reported a successful ingest —
 * so both entry points produce byte-identical sidecars.
 *
 * **The layout is checked, not assumed.** Two levels up only names a project when
 * the device directory really is `<workspace>/source/<device>`. Deriving blindly
 * would turn `D:\exports\PLC_1` into a write to `D:\.dsh/local/graph/PLC_1.json`,
 * i.e. a stray dot-directory at a drive root. A directory whose parent is not
 * `source/` therefore gets no sidecar and is logged as a warning; the honest
 * consequence is `graphFreshness: unknown`.
 *
 * @module dsh-engineering-graph/graph-freshness
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Schema version of the sidecar document; bumped only when its shape changes. */
export const GRAPH_SIDECAR_SCHEMA_VERSION = 1

/**
 * The exported source tree's folder name, one folder per device.
 *
 * It lives here because both sides of this module need it — the sidecar path is
 * `../source/<device>` — and `workspace.ts` re-exports it so the layout is still
 * documented in one place. It is a distribution-level contract (D20/D24), not a
 * local convention.
 */
export const SOURCE_DIR_NAME = 'source'

/**
 * The sidecar's folder inside a workspace, relative to the workspace root.
 *
 * `.dsh/local/` is already the project's local (never committed) state directory —
 * the context plugin keeps its lock and STAGE there — so the graph's provenance
 * files belong in a subfolder of it rather than in a new top-level dot directory.
 */
export const GRAPH_STATE_DIR = join('.dsh', 'local', 'graph')

/**
 * The context plugin's evidence ledger, `<deviceDir>/_evidence.json`.
 *
 * Duplicated on purpose: D10 keeps the two engineering plugins independent (no
 * shared package), so the file name is a distribution-level contract here, exactly
 * like `source/` and `knowledge/` in `workspace.ts`.
 */
export const EVIDENCE_FILE = '_evidence.json'

/**
 * How a knowledge database relates to the export it was built from.
 *
 * - `fresh` — both sides name a PLC checksum and they are equal.
 * - `stale` — both name one and they differ: the source tree changed after the
 *   database was built, so answers from it may describe code that no longer exists.
 * - `unknown` — either side is missing (no sidecar yet, an unreadable ledger, or a
 *   ledger that predates `plcChecksum`). Never guessed into `fresh`.
 */
export type GraphFreshness = 'fresh' | 'stale' | 'unknown'

/** The sidecar document, exactly as it is written. */
export interface GraphSidecar {
  schemaVersion: typeof GRAPH_SIDECAR_SCHEMA_VERSION
  /** The `source/<device>` folder name the graph was built from. */
  device: string
  /** `_evidence.json`'s `plcChecksum` at ingest time, or null when it recorded none. */
  plcChecksum: string | null
  /** `_evidence.json`'s `stateId` at ingest time, or null. */
  stateId: string | null
  /** When the ingest finished, ISO-8601 UTC. */
  builtAt: string
  /**
   * The device folder spelled relative to the workspace root, e.g. `source/Sino_PEI`.
   * Null only in a file this build did not write.
   */
  sourceDir: string | null
}

/** The two ledger fields freshness is decided from. */
export interface EvidenceSummary {
  plcChecksum: string | null
  stateId: string | null
}

/**
 * The four values `knowledge_workspace` reports per device.
 *
 * Named exactly like the fields in its `data.devices`, so a report can spread them
 * without a mapping that could drift from the schema.
 */
export interface GraphFacts {
  /** The checksum the database was built from (the sidecar), or null. */
  graphChecksum: string | null
  /** The ledger state id recorded at build time, or null. */
  graphStateId: string | null
  /** When the database was built (ISO-8601), or null. */
  graphBuiltAt: string | null
  /** The comparison described by {@link GraphFreshness}. */
  graphFreshness: GraphFreshness
}

/** Every field null and the verdict honest: nothing is known, so nothing is claimed. */
const UNKNOWN_FACTS: GraphFacts = {
  graphChecksum: null,
  graphStateId: null,
  graphBuiltAt: null,
  graphFreshness: 'unknown',
}

/** A tolerant string: anything that is not a non-empty string becomes `null`. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** The workspace root implied by a device directory: `<workspace>/source/<device>`. */
export function workspaceRootOfDeviceDir(deviceDir: string): string {
  return dirname(dirname(deviceDir))
}

/** The device name a `source/<device>` directory implies. */
export function deviceNameOfDeviceDir(deviceDir: string): string {
  return basename(deviceDir)
}

/**
 * The sidecar path for a device directory: the one derivation both the writer and
 * `knowledge_workspace` use.
 *
 * @param deviceDir - absolute path of `<workspace>/source/<device>`.
 * @returns `<workspace>/.dsh/local/graph/<device>.json`.
 */
export function graphSidecarPath(deviceDir: string): string {
  return graphSidecarPathIn(workspaceRootOfDeviceDir(deviceDir), deviceNameOfDeviceDir(deviceDir))
}

/**
 * The same path, spelled from a known workspace root and device name.
 *
 * Used by the report for a device whose source folder is gone: the sidecar's
 * location does not depend on the folder existing.
 *
 * @param workspaceRoot - the project root holding `source/`.
 * @param device - the device name (the `source/<device>` folder name).
 */
export function graphSidecarPathIn(workspaceRoot: string, device: string): string {
  return join(workspaceRoot, GRAPH_STATE_DIR, `${device}.json`)
}

/** The `source/<device>` spelling recorded in the sidecar, forward-slashed. */
function sourceDirOfDeviceDir(deviceDir: string): string {
  return `${SOURCE_DIR_NAME}/${deviceNameOfDeviceDir(deviceDir)}`
}

/**
 * Read `plcChecksum` / `stateId` out of a device's evidence ledger.
 *
 * Deliberately tolerant: the ledger is the context plugin's file and this plugin
 * only borrows two fields. A missing, unreadable or malformed ledger is **not** an
 * ingest failure — the graph is still buildable, it just cannot claim freshness
 * afterwards — so everything degrades to `null`.
 *
 * @param deviceDir - the device directory holding `_evidence.json`.
 */
export async function readEvidenceSummary(deviceDir: string): Promise<EvidenceSummary> {
  let raw: string
  try {
    raw = await readFile(join(deviceDir, EVIDENCE_FILE), 'utf8')
  } catch {
    return { plcChecksum: null, stateId: null }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { plcChecksum: null, stateId: null }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { plcChecksum: null, stateId: null }
  }
  const root = parsed as Record<string, unknown>
  return { plcChecksum: text(root['plcChecksum']), stateId: text(root['stateId']) }
}

/**
 * Read one sidecar, or `null` when there is nothing trustworthy to read.
 *
 * A sidecar from a different `schemaVersion` is refused rather than reinterpreted:
 * a stale shape read as the current one is exactly how a wrong "fresh" verdict
 * would appear, and `unknown` is the honest answer for a file this build cannot
 * understand.
 *
 * @param path - absolute path of the sidecar.
 */
export async function readGraphSidecar(path: string): Promise<GraphSidecar | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const document = parsed as Record<string, unknown>
  if (document['schemaVersion'] !== GRAPH_SIDECAR_SCHEMA_VERSION) return null
  const device = text(document['device'])
  const builtAt = text(document['builtAt'])
  // Both fields are required by the schema this file writes. A document missing one
  // is not partially trusted: a freed-form "maybe" timestamp would end up in the
  // report, and the checksum comparison alone is still available as `unknown`.
  if (device === null || builtAt === null) return null

  return {
    schemaVersion: GRAPH_SIDECAR_SCHEMA_VERSION,
    device,
    plcChecksum: text(document['plcChecksum']),
    stateId: text(document['stateId']),
    builtAt,
    sourceDir: text(document['sourceDir']),
  }
}

/**
 * The freshness rule, stated once.
 *
 * Timestamps are deliberately not part of it: an export can run without changing
 * the PLC, so an old `builtAt` is not staleness, and a new one is not freshness.
 * Only the two checksums answer the question.
 *
 * @param recordedChecksum - the checksum stored in the sidecar, or null.
 * @param currentChecksum - the checksum in the device's ledger right now, or null.
 */
export function graphFreshness(recordedChecksum: string | null, currentChecksum: string | null): GraphFreshness {
  if (recordedChecksum === null || currentChecksum === null) return 'unknown'
  return recordedChecksum === currentChecksum ? 'fresh' : 'stale'
}

/**
 * Read both sides for one device and decide the four reported facts.
 *
 * A device with no source folder cannot have a readable ledger, so it is `unknown`
 * without touching the disk: that is the common state of a database copied into a
 * workspace (or left behind after the export tree was removed), and reporting it as
 * fresh would be a fabrication.
 *
 * @param deviceDir - absolute device directory, or null when it is unknown.
 */
export async function readGraphFacts(deviceDir: string | null): Promise<GraphFacts> {
  if (deviceDir === null) return UNKNOWN_FACTS

  const sidecar = await readGraphSidecar(graphSidecarPath(deviceDir))
  const evidence = await readEvidenceSummary(deviceDir)
  const recorded = sidecar?.plcChecksum ?? null

  return {
    graphChecksum: recorded,
    graphStateId: sidecar?.stateId ?? null,
    graphBuiltAt: sidecar?.builtAt ?? null,
    graphFreshness: graphFreshness(recorded, evidence.plcChecksum),
  }
}

/** Options for {@link recordGraphSidecar}. */
export interface RecordGraphSidecarOptions {
  /** Clock injection for the tests; defaults to now. */
  now?: Date
  /**
   * Receives a write failure. It is a warning, never a thrown error: the database
   * itself was built successfully, so the ingest must not be reported as failed
   * just because its provenance file could not be written — the consequence is an
   * `unknown` verdict, which is the truth.
   */
  log?: { warn(message: string): void }
}

/**
 * Write the freshness sidecar for one device after a **successful** ingest.
 *
 * Atomic on purpose (write a sibling temporary file, then rename): a reader such as
 * `knowledge_workspace` must never observe a half-written JSON document, and a
 * crash mid-write must not leave one behind under the real name. The rename is the
 * commit point, so a failed ingest — which never reaches this function — cannot
 * touch the sidecar, and an aborted write keeps the previous one intact.
 *
 * @param deviceDir - the device directory that was just ingested.
 * @param options - clock and failure sink.
 * @returns the document as written, or null when it could not be written.
 * @throws TypeError for an empty `deviceDir`, matching `ingestDevice`'s own guard.
 */
export async function recordGraphSidecar(
  deviceDir: string,
  options: RecordGraphSidecarOptions = {},
): Promise<GraphSidecar | null> {
  if (typeof deviceDir !== 'string' || deviceDir.trim().length === 0) {
    throw new TypeError('recordGraphSidecar needs a non-empty device directory')
  }

  // Only `<workspace>/source/<device>` implies a workspace two levels up. Anything
  // else is refused rather than guessed: writing `D:\.dsh/...` for an export folder
  // outside a project would create state nobody asked for, at a path nobody reads.
  if (basename(dirname(deviceDir)) !== SOURCE_DIR_NAME) {
    options.log?.warn(
      `The graph freshness sidecar was not written: ${deviceDir} is not <workspace>/${SOURCE_DIR_NAME}/<device>, ` +
        'so the workspace root cannot be derived from it. knowledge_workspace will report graphFreshness=unknown ' +
        'for this device until it is ingested from a project source folder.',
    )
    return null
  }

  const evidence = await readEvidenceSummary(deviceDir)
  const document: GraphSidecar = {
    schemaVersion: GRAPH_SIDECAR_SCHEMA_VERSION,
    device: deviceNameOfDeviceDir(deviceDir),
    plcChecksum: evidence.plcChecksum,
    stateId: evidence.stateId,
    builtAt: (options.now ?? new Date()).toISOString(),
    sourceDir: sourceDirOfDeviceDir(deviceDir),
  }

  const path = graphSidecarPath(deviceDir)
  const temporary = `${path}.${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.tmp`

  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    // The rename never happened, so the real name still holds the previous
    // sidecar (or none). Drop the temporary file; failing to do so is harmless
    // and must not mask the original error.
    try {
      await unlink(temporary)
    } catch {
      // deliberately ignored
    }
    const reason = error instanceof Error ? error.message : String(error)
    options.log?.warn(
      `The graph freshness sidecar could not be written (${path}): ${reason}. The ingest itself succeeded; ` +
        'knowledge_workspace will report this device as graphFreshness=unknown until the next successful ingest.',
    )
    return null
  }

  return document
}
