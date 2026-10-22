/**
 * The `knowledgeGraph` service: the seam the engineering-context plugin calls
 * once it has written a device's source tree.
 *
 * Same shape as the interface plugin's `engineeringAccess` (D12 §3): a cordis
 * `Service` whose name is a plain string the consumer looks up with `ctx.get` and
 * never imports — D10 keeps the plugins independent, so the two sides agree on a
 * string and a contract, not on a package. Construct it inside `apply` so the
 * registration is owned by this plugin's fiber and disappears on unload.
 *
 * Two properties matter more than the method list:
 *
 *   1. **It goes through the same conversion the tools use.** `ingestDevice` and
 *      `updateDevice` issue the same `Ingest` / `Update` requests with the same
 *      parameter names and run the reply through the same `outcomeOf`, so this
 *      service and the `knowledge_ingest` / `knowledge_update` tools can never
 *      disagree about defaults or error shape.
 *   2. **An operation failure is data; a transport failure throws.** A missing
 *      device directory, an unreadable manifest or an empty tree comes back as
 *      `ok:false` with a coded error; a missing engine executable, a timeout or a
 *      protocol mismatch is thrown, and the caller decides how loudly to report it.
 *   3. **A successful write leaves a freshness sidecar.** After the engine wrote or
 *      updated the database, the service records the PLC checksum the export ledger
 *      names in `<workspace>/.dsh/local/graph/<device>.json` (`graph-freshness.ts`),
 *      which is what lets `knowledge_workspace` answer "was this graph built from
 *      the source tree I am looking at?". The engine never writes it, and a failed
 *      operation never touches it.
 *
 * @module dsh-engineering-graph/service
 */

import { existsSync } from 'node:fs'

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import { resolveEnginePath } from './engine-path.js'
import { recordGraphSidecar } from './graph-freshness.js'
import { outcomeOf, type ToolDependencies } from './tools.js'
import type { JsonRecord, ToolOutcome } from './protocol.js'

/**
 * The service name the engineering-context plugin looks up.
 *
 * Deliberately a bare string rather than a shared export (D10): the consumer must
 * keep working when this plugin is absent from the composition.
 */
export const KNOWLEDGE_GRAPH_SERVICE = 'knowledgeGraph'

export interface IngestDeviceOptions {
  /**
   * Absolute path of the database to write. Omit for the agreed convention,
   * `<project root>/knowledge/<device>/<device>_knowledge.db` (D20).
   */
  dbPath?: string
  /** Cancels the call. The engine is terminated, because an ingest cannot be interrupted. */
  signal?: AbortSignal
  /** Receives the engine's progress frames while the ingest runs. */
  onProgress?: (message: string) => void
}

/**
 * What changed in the export tree since the database was built.
 *
 * Paths are **device-relative**, spelled the way the export wrote them
 * (`blocks/010_Cell/FC.xml`) — forward or back slashes are both accepted, and the
 * engine normalizes them. They are matched against the database's component
 * provenance exactly; a path it never imported is refused rather than guessed at.
 */
export interface UpdateDeviceOptions {
  /** Device-relative paths of files whose content changed. May be empty when only removals happened. */
  changedPaths: string[]
  /** Device-relative paths of files deleted from the tree. An unknown one is reported and ignored. */
  removedPaths?: string[]
  /**
   * Absolute path of the database to update. Omit for the agreed convention,
   * `<project root>/knowledge/<device>/<device>_knowledge.db` (D20).
   */
  dbPath?: string
  /** Cancels the call. The engine is terminated, because an operation cannot be interrupted. */
  signal?: AbortSignal
}

/** What a caller needs to decide whether calling is worth attempting. */
export interface KnowledgeGraphStatus {
  /** True when the engine executable is present. Attempting the call is what starts it. */
  available: boolean
  /** Why it is unavailable. Null when all is well. */
  reason: string | null
  enginePath: string
  engineExists: boolean
  /** Where `enginePath` came from: the plugin's config, or the packaged default. */
  source: 'config' | 'package'
  /** The documented default database location, for callers that omit `dbPath`. */
  databaseConvention: string
}

/**
 * The `knowledgeGraph` service.
 *
 * The database location convention is stated here as one string so callers do not
 * have to re-derive it: `<project root>/knowledge/<device>/<device>_knowledge.db`,
 * where the project root is the directory holding `source/`.
 */
export class KnowledgeGraph extends Service {
  private readonly dependencies: ToolDependencies
  private readonly configuredEnginePath: string

  /**
   * @param ctx - the context the service is registered on.
   * @param dependencies - the engine seam the tools use, reused as-is.
   * @param configuredEnginePath - the plugin's `enginePath` config (empty = packaged default).
   */
  constructor(ctx: Context, dependencies: ToolDependencies, configuredEnginePath: string) {
    super(ctx, KNOWLEDGE_GRAPH_SERVICE)
    this.dependencies = dependencies
    this.configuredEnginePath = configuredEnginePath
  }

  /**
   * Report whether an ingest is worth attempting. Never starts anything.
   *
   * @returns the availability snapshot described by {@link KnowledgeGraphStatus}.
   */
  status(): KnowledgeGraphStatus {
    const { path: enginePath, source } = resolveEnginePath(this.configuredEnginePath)
    const engineExists = existsSync(enginePath)
    return {
      available: engineExists,
      reason: engineExists
        ? null
        : `the knowledge engine was not found at ${enginePath}; build it with engine/build.ps1 or point enginePath at it`,
      enginePath,
      engineExists,
      source,
      databaseConvention: '<project root>/knowledge/<device>/<device>_knowledge.db',
    }
  }

  /**
   * Build (or rebuild) one device's knowledge database from its source directory.
   *
   * `deviceDir` is `<project root>/source/<device>`: the directory holding
   * `_manifest.json` plus `blocks/`, `types/` and `tag_tables/`. The
   * interface plugin's `rebuildSource` returns exactly that directory per device
   * (`devices[].directory`), so a caller does not have to construct it.
   *
   * It is a **full rebuild** every time. Its provenance is recorded, not checked:
   * a successful call writes the freshness sidecar from the device's
   * `_evidence.json` (`graph-freshness.ts`), and the caller decides when a rebuild
   * is worth doing by comparing that sidecar with the ledger —
   * `knowledge_workspace` reports the comparison as `graphFreshness`.
   *
   * @param deviceDir - absolute path of one device's source directory.
   * @param options - database path override and cancellation.
   * @returns the engine's outcome; a failed ingest writes no sidecar.
   * @throws when the engine cannot be reached at all (transport failure).
   */
  async ingestDevice(deviceDir: string, options: IngestDeviceOptions = {}): Promise<ToolOutcome> {
    if (typeof deviceDir !== 'string' || deviceDir.trim().length === 0) {
      throw new TypeError('ingestDevice needs a non-empty device directory')
    }

    const params: JsonRecord = { deviceDir }
    if (options.dbPath !== undefined) params['dbPath'] = options.dbPath

    const frame = await this.dependencies.request('Ingest', params, {
      signal: options.signal,
      ...(options.onProgress === undefined
        ? {}
        : { onProgress: (progress) => options.onProgress?.(progress.message) }),
    })

    const outcome = outcomeOf('Ingest', frame)

    // Only a successful ingest may claim provenance. `recordGraphSidecar` reports a
    // write failure as a warning and returns null: the database exists, so the
    // caller must not see the ingest as failed because its sidecar was not writable
    // — the honest consequence is `graphFreshness: unknown`.
    if (outcome.ok) {
      await recordGraphSidecar(deviceDir, { log: this.dependencies.log })
    }

    return outcome
  }

  /**
   * Refresh only the components a sync touched, instead of rebuilding the device.
   *
   * A full `ingestDevice` re-parses every exported file (measured: 1376 files, ~30 s,
   * ~450 MB). This is the incremental path over the provenance that ingest recorded:
   * each named component is re-imported and replaced, plus one dependency hop —
   * every component that owns an edge pointing at a node of a changed/removed
   * component — because replacing a component can otherwise strip a neighbour's
   * edge. The whole batch is one database transaction, so a failure leaves the
   * previous database intact.
   *
   * It is deliberately conservative: a database without component provenance, a
   * path it never imported, a component whose identity moved, or a batch larger than
   * the engine's cap (50 components by default) comes back as `ok:false` with a code
   * whose remediation is "run Ingest". **The caller decides to fall back** — this
   * method never silently performs a full rebuild.
   *
   * @param deviceDir - absolute path of one device's source directory.
   * @param options - what changed, the database path override, and cancellation.
   * @returns the engine's outcome, including `data.changed` / `data.removed` /
   *   `data.closure` counts; a failed update writes no sidecar.
   * @throws when the engine cannot be reached at all (transport failure).
   */
  async updateDevice(deviceDir: string, options: UpdateDeviceOptions): Promise<ToolOutcome> {
    if (typeof deviceDir !== 'string' || deviceDir.trim().length === 0) {
      throw new TypeError('updateDevice needs a non-empty device directory')
    }

    if (options === undefined || !Array.isArray(options.changedPaths)) {
      throw new TypeError('updateDevice needs { changedPaths: string[] } naming the device-relative files that changed')
    }

    const params: JsonRecord = { deviceDir, changedPaths: options.changedPaths }
    if (options.removedPaths !== undefined) params['removedPaths'] = options.removedPaths
    if (options.dbPath !== undefined) params['dbPath'] = options.dbPath

    const frame = await this.dependencies.request('Update', params, { signal: options.signal })
    const outcome = outcomeOf('Update', frame)

    // A refresh is as much a provenance claim as a rebuild: the sidecar records the
    // ledger state the database now describes, and only a successful update may.
    if (outcome.ok) {
      await recordGraphSidecar(deviceDir, { log: this.dependencies.log })
    }

    return outcome
  }
}
