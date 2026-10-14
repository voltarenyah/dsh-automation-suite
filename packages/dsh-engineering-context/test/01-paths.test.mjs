/**
 * Path helpers: ids, containment and canonicalization.
 *
 * Containment is the plugin's single safety gate (every write goes through it),
 * so it gets its own tests: the interesting cases are the ones a string prefix
 * test gets wrong — a sibling directory sharing a prefix, `..`, and a path that
 * does not exist yet.
 */

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadPathsModule, tempWorkspace } from './helpers/harness.mjs'

const paths = await loadPathsModule()

test('slugify produces stable directory-safe ids', () => {
  assert.equal(paths.slugify('PEI SinoARP V4.1.3'), 'pei-sinoarp-v4-1-3')
  assert.equal(paths.slugify('  spaced  '), 'spaced')
  assert.equal(paths.slugify('a___b'), 'a-b')
  assert.equal(paths.slugify('--leading-and-trailing--'), 'leading-and-trailing')
  assert.ok(paths.slugify('x'.repeat(200)).length <= 60)
})

test('slugify is deterministic for titles that slug to nothing', () => {
  const first = paths.slugify('电机启停控制')
  const second = paths.slugify('电机启停控制')
  assert.equal(first, second)
  // A digest, not a fixed placeholder: two different non-Latin titles must not collide.
  assert.notEqual(first, paths.slugify('安全程序'))
  assert.match(first, /^project-[0-9a-f]{8}$/u)
})

test('uniqueId suffixes instead of overwriting', () => {
  const taken = new Set(['motor', 'motor-2'])
  assert.equal(paths.uniqueId(taken, 'pump'), 'pump')
  assert.equal(paths.uniqueId(taken, 'motor'), 'motor-3')
})

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
  const target = join(root, 'projects', 'p', 'work', 'tia.ap17')
  const canonical = await paths.canonicalizeLoose(target)
  assert.equal(canonical, target)
  assert.equal(paths.isInside(root, canonical), true)

  // A `..` that escapes is resolved, not taken literally.
  const escaping = await paths.canonicalizeLoose(join(root, 'projects', '..', '..', 'outside'))
  assert.equal(paths.isInside(root, escaping), false)
})

test('portable paths round-trip against the workspace root', async (t) => {
  const root = await tempWorkspace(t)
  const absolute = join(root, 'projects', 'p', 'export')
  const portable = paths.toPortable(root, absolute)
  assert.equal(portable, 'projects/p/export')
  assert.equal(paths.fromPortable(root, portable), absolute)
})

test('toPortable spells a Windows path with forward slashes only', async (t) => {
  const root = await tempWorkspace(t)
  const portable = paths.toPortable(root, join(root, 'a', 'b'))
  assert.equal(portable.includes('\\'), false)
})
