/**
 * The pure half of the git read: parse `status --porcelain=v1 -z` and
 * `diff --numstat -z -M` output and merge them into the panel's rows.
 *
 * Two details this module exists to get right, both verified against real git
 * output (see `test/01-changes.test.mjs`):
 *
 *  - with `-z`, a rename in `status` puts the **new** path in the entry and the
 *    **old** path in the next NUL-separated token;
 *  - with `-z`, a rename in `numstat` leaves the path field **empty** and then
 *    emits two tokens: the old path, then the new one.
 *
 * Paths are normalised to forward slashes so a Windows backslash never splits
 * one file into two rows (`git` itself always reports `/`).
 *
 * @module dsh-ui-changes/changes
 */

import type { ChangedFile, ChangesTotals } from './types.js'

/** One `git status --porcelain=v1 -z` entry. */
export interface PorcelainEntry {
  /** Index status letter. */
  x: string
  /** Work-tree status letter. */
  y: string
  /** The path as reported (already `/`-separated). */
  path: string
  /** Original path when this entry is a rename/copy. */
  renamedFrom: string | null
}

/** One `git diff --numstat -z` count. */
export interface NumstatCount {
  /** Added lines, or null for a binary side. */
  adds: number | null
  /** Removed lines, or null for a binary side. */
  dels: number | null
  /** Whether git called either side binary (`-` counts). */
  binary: boolean
}

/** @returns the path with forward slashes. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * @param stdout - raw `-z` output (NUL separators, no quoting).
 * @returns one entry per changed path, in git's order.
 */
export function parsePorcelain(stdout: string): PorcelainEntry[] {
  const tokens = stdout.split('\0')
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    // `XY path` is the shortest possible entry (`XY` + one space + one byte).
    if (token === undefined || token.length < 4) continue
    const x = token.charAt(0)
    const y = token.charAt(1)
    const path = token.slice(3)
    let renamedFrom: string | null = null
    if (isRenameOrCopy(x) || isRenameOrCopy(y)) {
      const original = tokens[i + 1]
      if (original !== undefined && original.length > 0) {
        renamedFrom = original
        i += 1
      }
    }
    entries.push({ x, y, path, renamedFrom })
  }
  return entries
}

/**
 * Parse `git diff --numstat -z -M <rev>` (or `--cached`).
 *
 * @param stdout - raw `-z` output.
 * @returns counts keyed by normalised path (renames keyed by the new path).
 */
export function parseNumstat(stdout: string): Map<string, NumstatCount> {
  const tokens = stdout.split('\0')
  const counts = new Map<string, NumstatCount>()
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined || token.length === 0) continue
    const first = token.indexOf('\t')
    const second = first < 0 ? -1 : token.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const added = token.slice(0, first)
    const deleted = token.slice(first + 1, second)
    let path = token.slice(second + 1)
    if (path.length === 0) {
      // Rename shape: `\t\t\0old\0new\0` — the entry names its paths in the next
      // two tokens, new path last.
      const to = tokens[i + 2]
      if (to === undefined) continue
      path = to
      i += 2
    }
    const binary = added === '-' || deleted === '-'
    counts.set(normalizePath(path), {
      adds: binary ? null : toCount(added),
      dels: binary ? null : toCount(deleted),
      binary,
    })
  }
  return counts
}

/**
 * The one-letter badge for an `XY` pair.
 *
 * Conflicts win over everything; then the order `?`, `D`, `A`, `R`/`C`, `M`,
 * with `T` (type change) folded into `M`. The panel's CSS has a colour for each.
 *
 * @param x - index letter.
 * @param y - work-tree letter.
 * @returns the badge code.
 */
export function codeOf(x: string, y: string): string {
  if (x === '?' && y === '?') return '?'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return '!'
  if (y === 'D' || x === 'D') return 'D'
  if (y === 'A' || x === 'A') return 'A'
  if (isRenameOrCopy(x) || isRenameOrCopy(y)) return x === 'C' || y === 'C' ? 'C' : 'R'
  return 'M'
}

/**
 * Merge the status list with the counts into the rows the panel renders.
 *
 * Untracked entries have no `numstat` line at all; their only count is the one
 * computed from the file itself (when the host was allowed to read it).
 *
 * @param entries - parsed status entries.
 * @param counts - parsed numstat counts, keyed by normalised path.
 * @param untrackedLines - added-line counts for untracked paths, keyed the same way.
 * @returns the rows, sorted by path.
 */
export function buildFiles(
  entries: PorcelainEntry[],
  counts: Map<string, NumstatCount>,
  untrackedLines: Map<string, number> = new Map(),
): ChangedFile[] {
  return entries
    .map((entry): ChangedFile => {
      const key = normalizePath(entry.path)
      const count = counts.get(key)
      const untracked = entry.x === '?' && entry.y === '?'
      const lines = untrackedLines.get(key)
      return {
        path: entry.path,
        x: entry.x,
        y: entry.y,
        code: codeOf(entry.x, entry.y),
        adds: untracked ? (lines === undefined ? null : lines) : (count?.adds ?? null),
        dels: untracked ? null : (count?.dels ?? null),
        binary: count?.binary ?? false,
        untracked,
        renamedFrom: entry.renamedFrom,
      }
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * Sum one list.
 *
 * @param files - every changed file (not the truncated list).
 * @param truncated - whether the list the caller renders was cut.
 * @returns the totals block.
 */
export function totalsOf(files: ChangedFile[], truncated: boolean): ChangesTotals {
  let adds = 0
  let dels = 0
  for (const file of files) {
    if (typeof file.adds === 'number') adds += file.adds
    if (typeof file.dels === 'number') dels += file.dels
  }
  return { files: files.length, adds, dels, truncated }
}

/**
 * @param text - a file's decoded content.
 * @returns its line count, with a missing final newline still counting its line.
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  const breaks = text.split('\n').length - 1
  return text.endsWith('\n') ? breaks : breaks + 1
}

/** @returns whether a porcelain letter means rename or copy. */
function isRenameOrCopy(letter: string): boolean {
  return letter === 'R' || letter === 'C'
}

/** @returns a non-negative integer, or 0 for anything unparsable. */
function toCount(text: string): number {
  const value = Number.parseInt(text, 10)
  return Number.isFinite(value) && value >= 0 ? value : 0
}
