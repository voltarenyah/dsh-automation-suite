/**
 * Path helpers: containment, canonicalization and folder naming.
 *
 * Containment is the plugin's single safety gate (every write goes through it),
 * so it gets its own tests: the interesting cases are the ones a string prefix
 * test gets wrong — a sibling directory sharing a prefix, `..`, and a path that
 * does not exist yet.
 *
 * `folderName` is the other half of the same safety story: the folder comes from
 * a name TIA reports, so nothing may reach the filesystem as a path rather than a
 * segment.
 */

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadPathsModule, tempWorkspace } from './helpers/harness.mjs'

const paths = await loadPathsModule()

test('isInside accepts the root and descendants, rejects everything else', async (t) => {
  const root = await tempWorkspace(t)
  const child = join(root, 'a', 'b')
  await mkdir(child, { recursive: true })

  assert.equal(paths.isInside(root, root), true)
  assert.equal(paths.isInside(root, child), true)
  assert.equal(paths.isInside(root, join(root, 'a')), true)
  assert.equal(paths.isInside(root, join(root, '..')), false)
  assert.equal(paths.isInside(root, `${root}-sibling`), false)
  assert.equal(paths.isInside(root, join(root, 'a', '..', '..')), false)
})

test('canonicalizeLoose resolves a not-yet-created target through its existing ancestor', async (t) => {
  const root = await tempWorkspace(t)
  const target = join(root, 'tia', 'PEI', 'PEI.ap17')
  const canonical = await paths.canonicalizeLoose(target)
  assert.equal(canonical, target)
  assert.equal(paths.isInside(root, canonical), true)

  // A `..` that escapes is resolved, not taken literally.
  const escaping = await paths.canonicalizeLoose(join(root, 'tia', '..', '..', 'outside'))
  assert.equal(paths.isInside(root, escaping), false)
})

test('toPortable spells a Windows path with forward slashes only', async (t) => {
  const root = await tempWorkspace(t)
  const portable = paths.toPortable(root, join(root, 'source', 'PEI', 'S7-1500'))
  assert.equal(portable, 'source/PEI/S7-1500')
  assert.equal(portable.includes('\\'), false)
})

test('folderName keeps a TIA name readable and turns anything else into a segment', () => {
  // The engineering name survives verbatim, including spaces, dots and CJK —
  // only what a filesystem cannot hold is replaced.
  assert.equal(paths.folderName('PEI SinoARP V4.1.3'), 'PEI SinoARP V4.1.3')
  assert.equal(paths.folderName('电机启停控制'), '电机启停控制')

  assert.equal(paths.folderName('a/b'), 'a_b')
  assert.equal(paths.folderName('a\\b'), 'a_b')
  assert.equal(paths.folderName('a:b*c?d"e<f>g|h'), 'a_b_c_d_e_f_g_h')
  assert.equal(paths.folderName('line\nbreak'), 'line_break')
})

test('folderName refuses to produce a path or a Windows-special name', () => {
  // A trailing dot or space is silently stripped by Windows, which would make
  // the name and the directory on disk disagree.
  assert.equal(paths.folderName('trailing. '), 'trailing')
  assert.equal(paths.folderName('  leading  '), 'leading')
  assert.equal(paths.folderName('.'), 'project')
  assert.equal(paths.folderName('..'), 'project')
  assert.equal(paths.folderName('   '), 'project')
  assert.equal(paths.folderName(''), 'project')

  // Reserved device names are prefixed rather than passed through.
  assert.equal(paths.folderName('nul'), '_nul')
  assert.equal(paths.folderName('COM1'), '_COM1')
  assert.equal(paths.folderName('con.txt'), '_con.txt')
  assert.ok(paths.folderName('x'.repeat(400)).length <= 120)
})
