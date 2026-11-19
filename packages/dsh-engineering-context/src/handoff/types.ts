/**
 * The handoff marker and its local record.
 *
 * The **marker** travels with the `.zap17` archive, inside the TIA project's
 * `UserFiles/` directory. It answers, on the other machine: which workspace and
 * which committed source state produced this project, what the PLC checksum was,
 * and what every exported object's fingerprint was. It is the only provenance the
 * returning archive carries.
 *
 * The **record** stays in the workspace (`handoff/<id>/handoff.json`). It adds the
 * facts that cannot live inside a project folder because they describe the local
 * artifact: the archive's sha256, where the old project was moved, and how the
 * import went.
 *
 * Both are JSON documents with an explicit schema version. Nothing here talks to
 * TIA; the tools do.
 *
 * @module dsh-engineering-context/handoff/types
 */

/** Marker kind. A marker with another kind is not ours. */
export const HANDOFF_MARKER_KIND = 'dsh-tia-handoff'

/** Record kind, deliberately different from the marker kind. */
export const HANDOFF_RECORD_KIND = 'dsh-tia-handoff-record'

/** The only marker schema version this build writes and reads. */
export const HANDOFF_SCHEMA_VERSION = 1

/** Marker file name inside the TIA project's `UserFiles/` directory. */
export const HANDOFF_MARKER_FILE = '_dsh-handoff.json'

/** TIA's project folder for user files. */
export const USERFILES_DIR = 'UserFiles'

/** The only archive mode the handoff workflow uses in v1. */
export const HANDOFF_ARCHIVE_MODE = 'compressed' as const

/** One device's state at handoff time. */
export interface HandoffMarkerDevice {
  device: string
  software: string
  /** `PlcChecksumProvider.Software` at the base commit; non-empty. */
  plcChecksum: string
  /** The controller's `stateId` at the base commit (checksum + every signature). */
  stateId: string
  /** A digest of the source-only signatures, stable across a recompile. */
  sourceIdentity: string
  /** Number of objects in `evidence.objects`. */
  objectCount: number
  /** The exact `_evidence.json` document this marker was built from. */
  evidence: Record<string, unknown>
}

/** The marker written into `UserFiles/_dsh-handoff.json` and into the archive. */
export interface HandoffMarker {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION
  kind: typeof HANDOFF_MARKER_KIND
  handoffId: string
  /** ISO-8601 UTC. */
  createdAt: string
  git: {
    head: string
    branch: string | null
    sourceClean: true
  }
  project: {
    name: string
    tiaVersion: string
  }
  archive: {
    mode: typeof HANDOFF_ARCHIVE_MODE
  }
  devices: HandoffMarkerDevice[]
}

/** What a handoff record says has happened to the package. */
export type HandoffStatus =
  | 'issued'
  | 'returned'
  | 'awaiting_compile'
  | 'imported'
  | 'import_failed'
  | 'abandoned'

/** The local record, written to `handoff/<id>/handoff.json`. */
export interface HandoffRecord {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION
  kind: typeof HANDOFF_RECORD_KIND
  handoffId: string
  status: HandoffStatus
  createdAt: string
  /** Workspace display name, for a human reading the file later. */
  workspace: string
  /** The export-time note (recipient, ticket, why it went out). */
  note: string | null
  base: {
    commit: string
    branch: string | null
    sourceClean: true
  }
  project: {
    name: string
    tiaVersion: string
    device: string
    software: string
  }
  /** Paths are workspace-relative with forward slashes. */
  archive: {
    path: string
    sha256: string
    bytes: number
    mode: typeof HANDOFF_ARCHIVE_MODE
  }
  marker: {
    path: string
    sha256: string
  }
  backup: {
    path: string
    present: boolean
  } | null
  returned: {
    /** Absolute path as the user handed it back; may be outside the workspace. */
    path: string
    sha256: string
    bytes: number
    at: string
  } | null
  import: {
    /** Workspace-relative project path TIA reported after retrieval. */
    projectPath: string | null
    checksum: string | null
    changed: number | null
    added: number | null
    removed: number | null
    pendingPaths: number
    syncedAt: string | null
    note: string | null
    error: string | null
  } | null
}

/** What the export plan shows before anything is written. */
export interface HandoffExportPlan {
  project: {
    name: string
    tiaVersion: string
    device: string
    software: string
    projectPath: string
    projectDirectory: string
    userFiles: string
    markerPath: string
  }
  base: {
    commit: string
    branch: string | null
  }
  state: {
    plcChecksum: string
    stateId: string
    sourceIdentity: string
    objectCount: number
  }
  handoffId: string
  directory: string
  archivePath: string
}

/** What the import plan shows before anything is moved. */
export interface HandoffImportPlan {
  archive: {
    path: string
    bytes: number
    sha256: string
    projectName: string
    tiaVersion: string
  }
  marker: {
    handoffId: string
    createdAt: string
    baseCommit: string
    branch: string | null
    projectName: string
    devices: Array<{
      device: string
      software: string
      plcChecksum: string
      stateId: string
      objectCount: number
    }>
  }
  record: HandoffRecord | null
  current: {
    head: string | null
    sourceClean: boolean
    projectOpen: boolean
    projectName: string | null
    projectPath: string | null
    isModified: boolean | null
  }
  target: {
    projectDirectory: string
    backupDirectory: string
  }
}
