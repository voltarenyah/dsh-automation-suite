/**
 * Remove this monorepo's build output without ever touching node_modules.
 *
 * Deliberately NOT `rm -rf` / `Directory.Delete`: `packages/*\/node_modules`
 * can hold junctions created by `pnpm run link:runtime` that point into the
 * DeepSeek Harness installation. A recursive delete that follows such a link
 * destroys the *target* — see dsh-tia-openness-v17-min `docs/ECOSYSTEM-COMPAT.md`,
 * where exactly that incident cost a repository its `.git` metadata.
 *
 * This script only ever inspects `lib/` and `dist/` directly inside the
 * workspace members, and when a target is itself a symlink/junction it unlinks
 * the link instead of descending into it.
 */

import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const GROUPS = ['packages', 'profile']
const TARGETS = ['lib', 'dist']

/** @returns {import('node:fs').Stats | null} */
function statOrNull(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** @returns {string[]} the workspace member directories under one group. */
function membersOf(group) {
  try {
    return readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(group, entry.name))
  } catch {
    return []
  }
}

const removed = []
for (const group of GROUPS) {
  for (const member of membersOf(group)) {
    for (const target of TARGETS) {
      const path = join(root, member, target)
      const stats = statOrNull(path)
      if (stats === null) continue
      if (stats.isSymbolicLink()) {
        unlinkSync(path)
        removed.push(`${member}/${target} (link unlinked, target untouched)`)
      } else {
        rmSync(path, { recursive: true, force: true })
        removed.push(`${member}/${target}`)
      }
    }
  }
}

if (removed.length === 0) console.log('clean:build: nothing to remove')
else for (const item of removed) console.log(`clean:build: removed ${item}`)
