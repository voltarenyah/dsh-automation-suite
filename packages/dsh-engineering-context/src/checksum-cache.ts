/**
 * A short-lived, in-memory cache of the PLC checksum.
 *
 * Reading the checksum costs a TIA round trip (about 3–8 s), and the two
 * read-only workflows — `project_status(verify: true)` and the default
 * `project_sync` plan — ask the very same question seconds apart. This cache
 * lets the second call reuse the first call's answer, which is what stops the
 * duplicate read.
 *
 * Two deliberate limits keep it from becoming a second source of truth:
 *
 * - **Memory only, never disk.** A plugin restart loses it, so no stale checksum
 *   can survive a reload. It is keyed by workspace root + device + software, so
 *   two workspaces (or two PLCs in one workspace) never share an answer.
 * - **It is an optimization for plans only.** A real sync (`dry_run: false`)
 *   always runs a fresh `syncScan` and never consults this cache to decide what
 *   to write (docs/decisions.md D26).
 *
 * @module dsh-engineering-context/checksum-cache
 */

/** How long a cached checksum is considered fresh. */
export const CHECKSUM_TTL_MS = 30_000

/** What one cache entry is keyed by: the workspace root and the PLC's identity. */
export interface ChecksumCacheKey {
  /** Canonical workspace root (the scope's workspace path). */
  workspaceRoot: string
  /** PLC device name as TIA reports it. */
  device: string
  /** PLC software name as TIA reports it. */
  software: string
}

/**
 * A fresh cache hit.
 *
 * It carries `cached: true` because the caller must be able to tell the model
 * whether the checksum was read now or reused, and `ageMs` so the caller can
 * explain how fresh it is.
 */
export interface CachedChecksum {
  checksum: string
  /** Local clock time the entry was written. */
  storedAt: number
  /** How old the entry was at the moment it was read. */
  ageMs: number
  cached: true
}

interface CacheEntry {
  checksum: string
  storedAt: number
}

/** Bounded so a long session cannot accumulate one entry per PLC forever. */
const MAX_ENTRIES = 64

const entries = new Map<string, CacheEntry>()

/**
 * Build the cache key for one PLC in one workspace.
 *
 * @param workspaceRoot - the canonical workspace root.
 * @param device - the PLC device name.
 * @param software - the PLC software name.
 */
export function checksumCacheKey(workspaceRoot: string, device: string, software: string): ChecksumCacheKey {
  return { workspaceRoot, device, software }
}

/**
 * The map key. `JSON.stringify` keeps a device name containing the separator
 * from colliding with another key, which a hand-joined string would allow.
 */
function serialize(key: ChecksumCacheKey): string {
  return JSON.stringify([key.workspaceRoot, key.device, key.software])
}

function isExpired(entry: CacheEntry, now: number): boolean {
  const ageMs = now - entry.storedAt
  // A clock that went backwards makes the entry's age unknowable: treat it as
  // stale rather than trusting a timestamp from the future.
  return ageMs < 0 || ageMs > CHECKSUM_TTL_MS
}

/**
 * Read a checksum if it is still fresh.
 *
 * @param key - the workspace + PLC identity.
 * @param now - the clock to evaluate the TTL against; defaults to `Date.now()`.
 * @returns the hit, or `null` when absent or older than {@link CHECKSUM_TTL_MS}.
 */
export function readCachedChecksum(key: ChecksumCacheKey, now: number = Date.now()): CachedChecksum | null {
  const id = serialize(key)
  const entry = entries.get(id)
  if (entry === undefined) return null
  if (isExpired(entry, now)) {
    // Drop it on the way out: an expired entry is never useful again.
    entries.delete(id)
    return null
  }
  return { checksum: entry.checksum, storedAt: entry.storedAt, ageMs: now - entry.storedAt, cached: true }
}

/**
 * Record a successfully read checksum.
 *
 * An empty or non-string checksum is ignored: "no compiled checksum" is a state
 * the caller must keep reporting, not something to cache as an answer.
 *
 * @param key - the workspace + PLC identity.
 * @param checksum - the checksum TIA just reported.
 */
export function writeCachedChecksum(key: ChecksumCacheKey, checksum: string): void {
  if (typeof checksum !== 'string' || checksum.length === 0) return
  const now = Date.now()
  if (entries.size >= MAX_ENTRIES) {
    for (const [id, entry] of entries) {
      if (isExpired(entry, now)) entries.delete(id)
    }
  }
  entries.set(serialize(key), { checksum, storedAt: now })
}

/** Drop every entry. Used by tests, and after a real sync if a hard reset is ever needed. */
export function clearChecksumCache(): void {
  entries.clear()
}
