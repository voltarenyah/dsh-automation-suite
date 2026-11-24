/**
 * Path canonicalization, workspace containment and folder naming.
 *
 * This is the plugin's whole path vocabulary. Every path it writes is checked
 * with {@link isInside} against a **canonicalized** workspace root — never with a
 * string prefix: Windows path comparison is case-insensitive, and `..` segments,
 * symlinks and junctions all defeat a naive prefix test. The recursive-delete
 * incident recorded in the sibling package's `docs/ECOSYSTEM-COMPAT.md` is the
 * standing reminder that link-following mistakes here are expensive.
 *
 * @module dsh-engineering-context/paths
 */

import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Canonicalize a path that is expected to exist.
 *
 * @param target - any path spelling.
 * @returns the absolute, symlink-resolved, on-disk-cased path.
 * @throws when the path does not resolve (including `ENOENT`).
 */
export async function canonicalize(target: string): Promise<string> {
  return await realpath(resolve(target))
}

/**
 * Canonicalize a path that may not exist yet.
 *
 * The nearest existing ancestor is canonicalized and the remaining segments are
 * re-attached, so a not-yet-created target is still validated against the real
 * path of whatever does exist. "It does not exist yet" is never a reason to skip
 * the check.
 *
 * @param target - any path spelling.
 * @returns the canonical path the target will have once created.
 * @throws when no ancestor resolves (for example, a path off a missing drive).
 */
export async function canonicalizeLoose(target: string): Promise<string> {
  let current = resolve(target)
  const tail: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch (error) {
      const parent = dirname(current)
      if (parent === current) throw error
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Whether `candidate` is `root` itself or a descendant of it.
 *
 * Both arguments must already be canonical: this is a comparison of real paths,
 * and it is the only containment test this plugin uses.
 *
 * @param root - the canonical workspace root.
 * @param candidate - the canonical path to test.
 * @returns true when the candidate stays inside the root.
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * Store a workspace-internal path portably: relative to the root, forward
 * slashes. Results are meant to be read by a human or a model, and an absolute
 * Windows path in a log line is noise.
 *
 * @param root - the canonical workspace root.
 * @param absolute - a canonical absolute path.
 * @returns the portable spelling.
 */
export function toPortable(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

/** Device names Windows reserves in every directory, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu

/**
 * One path segment safe for a project folder.
 *
 * The name comes from TIA, not from the model, so this is a sanitizer and never
 * an escape hatch: a character a filesystem rejects becomes `_`, a trailing dot
 * or space is dropped (Windows would silently strip it, leaving the name and the
 * directory disagreeing), and a reserved device name is prefixed rather than
 * passed through. It mirrors what the TIA plugin does to device names
 * (`packages/dsh-tia-openness-v17-min/src/access.ts`), so a workspace never shows
 * two different spellings of the same engineering name.
 *
 * @param name - the raw name (usually the TIA project name).
 * @returns a segment that can be created on disk.
 */
export function folderName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
    .replace(/^[. ]+|[. ]+$/gu, '')
    .slice(0, 120)
  if (cleaned.length === 0) return 'project'
  const base = cleaned.split('.')[0] ?? cleaned
  return WINDOWS_RESERVED.test(base) ? `_${cleaned}` : cleaned
}
