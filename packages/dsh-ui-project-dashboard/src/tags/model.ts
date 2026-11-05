/**
 * The tag document: shape, validation, and the pure mutation the store applies.
 *
 * Multi-level tags are stored as `/`-joined paths (`客户/PEI`, `产线/焊装/HF48e`).
 * The browser validates before sending so the UI can react immediately, but this
 * module is the authority: every read re-coerces the file, every write validates
 * the operation again.
 *
 * Entries are keyed by **workspace id** (the user's choice, 2026-11-05) and also
 * carry the canonical `path` the host learned from `workspaceRegistry`. The path
 * never participates in matching; it exists so an orphaned entry can be
 * re-attached to a re-registered directory later, and so the file is readable by
 * a human.
 *
 * @module dsh-ui-project-dashboard/tags/model
 */

/** Document version; a mismatch is treated as corrupt on read. */
export const TAGS_VERSION = 1

/** Marker so the file explains its owner when found in `storages/`. */
export const TAGS_OWNER = 'dsh-ui-project-dashboard'

/** Deepest tag path the UI accepts (segments, not characters). */
export const MAX_TAG_DEPTH = 4

/** Longest one segment may be, in characters. */
export const MAX_SEGMENT_LENGTH = 40

/** Longest whole path may be, in characters. */
export const MAX_TAG_LENGTH = 120

/** Most tags one workspace may carry. */
export const MAX_TAGS_PER_WORKSPACE = 64

/** One workspace's tags. */
export interface TagEntry {
  /** Canonical directory the id pointed at when last written; informational. */
  path: string
  /** Normalized, de-duplicated tag paths. */
  tags: string[]
  /** ISO timestamp of the last successful write. */
  updatedAt: string
}

/** The whole file. */
export interface TagDocument {
  version: number
  revision: number
  owner: string
  workspaces: Record<string, TagEntry>
}

/** One requested change. */
export type TagOperation =
  | { op: 'add'; workspaceId: string; tag: string }
  | { op: 'remove'; workspaceId: string; tag: string }
  | { op: 'set'; workspaceId: string; tags: string[] }

/** A rejected request: the route maps this to 400 with the code. */
export class TagInputError extends Error {
  /**
   * @param code - stable machine code (`tag/empty`, `tag/too-deep`, …).
   * @param message - human explanation.
   */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TagInputError'
  }
}

/** A write whose `expectedRevision` no longer matches; maps to 409. */
export class TagConflictError extends Error {
  /**
   * @param revision - the revision the caller was working from.
   * @param current - the revision on disk now.
   */
  constructor(
    readonly revision: number,
    readonly current: number,
  ) {
    super(`tags changed (expected revision ${revision}, found ${current})`)
    this.name = 'TagConflictError'
  }
}

/** @returns a fresh empty document. */
export function emptyDocument(): TagDocument {
  return { version: TAGS_VERSION, revision: 0, owner: TAGS_OWNER, workspaces: {} }
}

/**
 * Validate and normalize one tag path.
 *
 * @param raw - user input, e.g. `" 产线 / 焊装 / HF48e "`.
 * @returns the normalized path (`产线/焊装/HF48e`).
 * @throws {TagInputError} when empty, too deep, or a segment is too long.
 */
export function normalizeTag(raw: unknown): string {
  if (typeof raw !== 'string') throw new TagInputError('tag/not-string', 'tag must be a string')
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) throw new TagInputError('tag/empty', 'tag must not be empty')
  if (parts.length > MAX_TAG_DEPTH) {
    throw new TagInputError('tag/too-deep', `tag may have at most ${MAX_TAG_DEPTH} levels`)
  }
  for (const part of parts) {
    if (part.length > MAX_SEGMENT_LENGTH) {
      throw new TagInputError('tag/segment-too-long', `one tag level may have at most ${MAX_SEGMENT_LENGTH} characters`)
    }
    if (/[\u0000-\u001f]/.test(part)) throw new TagInputError('tag/control-character', 'tag may not contain control characters')
  }
  const joined = parts.join('/')
  if (joined.length > MAX_TAG_LENGTH) {
    throw new TagInputError('tag/too-long', `a tag may have at most ${MAX_TAG_LENGTH} characters`)
  }
  return joined
}

/**
 * Normalize a whole list, de-duplicating while keeping first-seen order.
 *
 * @param raw - candidate tags.
 * @returns normalized tags.
 * @throws {TagInputError} on the first invalid tag.
 */
export function normalizeTagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new TagInputError('tags/not-array', 'tags must be an array')
  if (raw.length > MAX_TAGS_PER_WORKSPACE) {
    throw new TagInputError('tags/too-many', `a workspace may carry at most ${MAX_TAGS_PER_WORKSPACE} tags`)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const tag = normalizeTag(item)
    if (seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

/**
 * Coerce whatever is on disk into a document, dropping bad entries instead of
 * failing the whole file. Used only for reads; a parse failure is reported as
 * corruption by the store.
 *
 * @param value - parsed JSON.
 * @returns a document that is safe to serve and to mutate.
 */
export function coerceDocument(value: unknown): TagDocument {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const rawWorkspaces =
    source.workspaces !== null && typeof source.workspaces === 'object' && !Array.isArray(source.workspaces)
      ? (source.workspaces as Record<string, unknown>)
      : {}
  const workspaces: Record<string, TagEntry> = {}
  for (const [id, raw] of Object.entries(rawWorkspaces)) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) continue
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const tags: string[] = []
    for (const candidate of Array.isArray(entry.tags) ? entry.tags : []) {
      try {
        const tag = normalizeTag(candidate)
        if (!tags.includes(tag)) tags.push(tag)
      } catch {
        /* drop one bad tag, keep the rest */
      }
      if (tags.length >= MAX_TAGS_PER_WORKSPACE) break
    }
    workspaces[id] = {
      path: typeof entry.path === 'string' ? entry.path : '',
      tags,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    }
  }
  const revision = typeof source.revision === 'number' && Number.isFinite(source.revision) && source.revision >= 0
    ? Math.floor(source.revision)
    : 0
  return { version: TAGS_VERSION, revision, owner: TAGS_OWNER, workspaces }
}

/**
 * Parse one file's text. A different `version` is corruption, not data.
 *
 * @param text - file contents.
 * @returns the document.
 * @throws {Error} when the text is not a v1 document.
 */
export function parseDocument(text: string): TagDocument {
  const value = JSON.parse(text) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('tag document is not an object')
  const version = (value as { version?: unknown }).version
  if (version !== TAGS_VERSION) throw new Error(`tag document version ${String(version)} is not ${TAGS_VERSION}`)
  return coerceDocument(value)
}

/**
 * Apply one operation to a document, returning a new document. Pure: the store
 * owns IO and serialization.
 *
 * @param doc - current document.
 * @param operation - validated-ish request (validated here).
 * @param path - canonical directory of the workspace, when known; `''` keeps the stored one.
 * @param now - ISO timestamp for the write.
 * @returns the next document, the touched entry, and whether anything changed.
 * @throws {TagInputError} when the request is invalid.
 */
export function applyOperation(
  doc: TagDocument,
  operation: TagOperation,
  path: string,
  now: string,
): { doc: TagDocument; entry: TagEntry; changed: boolean } {
  const workspaceId = operation.workspaceId
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    throw new TagInputError('workspace/invalid-id', 'workspaceId must be a non-empty string')
  }
  if (workspaceId.length > 200) throw new TagInputError('workspace/invalid-id', 'workspaceId is too long')

  const previous = doc.workspaces[workspaceId] ?? { path: '', tags: [], updatedAt: '' }
  const tags = [...previous.tags]
  let changed = false

  if (operation.op === 'add') {
    const tag = normalizeTag(operation.tag)
    if (!tags.includes(tag)) {
      if (tags.length >= MAX_TAGS_PER_WORKSPACE) {
        throw new TagInputError('tags/too-many', `a workspace may carry at most ${MAX_TAGS_PER_WORKSPACE} tags`)
      }
      tags.push(tag)
      changed = true
    }
  } else if (operation.op === 'remove') {
    const tag = normalizeTag(operation.tag)
    const next = tags.filter((candidate) => candidate !== tag)
    if (next.length !== tags.length) {
      tags.splice(0, tags.length, ...next)
      changed = true
    }
  } else if (operation.op === 'set') {
    const next = normalizeTagList(operation.tags)
    changed = next.length !== tags.length || next.some((tag, index) => tag !== tags[index])
    tags.splice(0, tags.length, ...next)
  } else {
    throw new TagInputError('op/unknown', 'op must be add, remove or set')
  }

  const nextPath = typeof path === 'string' && path.length > 0 ? path : previous.path
  const entry: TagEntry = {
    path: nextPath,
    tags,
    updatedAt: changed ? now : previous.updatedAt,
  }
  if (!changed) return { doc, entry, changed }

  const workspaces = { ...doc.workspaces, [workspaceId]: entry }
  return {
    doc: { version: TAGS_VERSION, revision: doc.revision + 1, owner: TAGS_OWNER, workspaces },
    entry,
    changed,
  }
}
