/**
 * Path canonicalization, workspace containment and id derivation.
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

import { createHash } from 'node:crypto'
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
 * A filesystem-safe, deterministic project id derived from a title.
 *
 * Deterministic matters: the id is a directory name, and a random or
 * timestamped one could not be re-derived from the same title. Titles that slug
 * to nothing (for example an all-CJK title) fall back to a title digest rather
 * than to a fixed placeholder, so two different titles cannot collide.
 *
 * @param title - the human title.
 * @returns a lowercase id of `[a-z0-9-]`, at most 60 characters.
 */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    .replace(/-+$/u, '')
  if (base.length > 0) return base
  return `project-${createHash('sha256').update(title, 'utf8').digest('hex').slice(0, 8)}`
}

/**
 * `id`, or `id-2`, `id-3`… when it is already taken.
 *
 * @param taken - the ids already in use.
 * @param id - the desired id.
 * @returns an id not present in `taken`.
 */
export function uniqueId(taken: ReadonlySet<string>, id: string): string {
  if (!taken.has(id)) return id
  for (let index = 2; ; index += 1) {
    const candidate = `${id}-${index}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Store a workspace-internal path portably: relative to the root, forward
 * slashes. The registry file is meant to be committed and carried, and an
 * absolute Windows path in it would break on the next machine.
 *
 * @param root - the canonical workspace root.
 * @param absolute - a canonical absolute path.
 * @returns the portable spelling.
 */
export function toPortable(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

/**
 * Resolve a portable path back against the workspace root.
 *
 * @param root - the canonical workspace root.
 * @param portable - the stored spelling.
 * @returns the absolute path.
 */
export function fromPortable(root: string, portable: string): string {
  return resolve(root, ...portable.split('/'))
}
