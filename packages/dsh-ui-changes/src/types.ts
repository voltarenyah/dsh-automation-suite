/**
 * The payload shapes shared by the route, the git-backed service and the tests.
 *
 * Kept in one module so the wire contract has a single definition: the host
 * serialises {@link StatusPayload}, the panel renders it, and both the route
 * tests and the service tests build it.
 *
 * @module dsh-ui-changes/types
 */

import type { StatusError } from './errors.js'

/** One changed path, as git reports it plus the count we can attribute to it. */
export interface ChangedFile {
  /** Repository-root-relative path, forward slashes. */
  path: string
  /** Index status letter (` ` when clean in the index). */
  x: string
  /** Work-tree status letter (` ` when clean in the work tree). */
  y: string
  /** One-letter badge: `M` / `A` / `D` / `R` / `C` / `?` / `!`. */
  code: string
  /** Added lines, or null when unknown (binary, oversized, or not counted). */
  adds: number | null
  /** Removed lines, or null when unknown. */
  dels: number | null
  /** A side git called binary. */
  binary: boolean
  /** Never tracked: `git status` reported `??`. */
  untracked: boolean
  /** Original path for a rename, or null. */
  renamedFrom: string | null
}

/** The summary line's numbers. */
export interface ChangesTotals {
  /** Every changed file, including the ones truncated out of `files`. */
  files: number
  adds: number
  dels: number
  /** The list was cut at `limits.maxFiles`. */
  truncated: boolean
}

/** The complete answer for one successful request. */
export interface StatusPayload {
  ok: true
  generatedAt: string
  /** Absolute repository root. */
  repo: string
  branch: string
  detached: boolean
  /** Full HEAD commit hash, or null on an unborn branch. */
  head: string | null
  files: ChangedFile[]
  totals: ChangesTotals
  limits: { maxFiles: number; timeoutMs: number }
}

/** What the route needs from the host side. */
export interface StatusService {
  /**
   * Read the working-tree status for one session's repository.
   *
   * @param sessionId - the session whose `header.cwd` names the repository.
   * @returns the payload to serialise.
   * @throws {@link StatusError} for every expected failure.
   */
  status(sessionId: string): Promise<StatusPayload>
}
