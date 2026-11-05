/**
 * Tests for the durable tag file: normalization limits, revisions, conflict
 * detection, atomic replacement, backup, and corrupt-file recovery.
 *
 * @module dsh-ui-project-dashboard/test/store
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { TagInputError, TagConflictError } from '../lib/tags/model.js'
import { TagStore } from '../lib/tags/store.js'

/** @returns a fresh store in a temp directory. */
async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tags-'))
  const file = join(root, 'storages', 'project-dashboard', 'tags.json')
  return { root, file, store: new TagStore(file, () => '2026-11-05T06:00:00.000Z') }
}

test('a missing file reads as an empty document', async () => {
  const { store } = await storeFixture()
  const snapshot = await store.snapshot()
  assert.equal(snapshot.corrupt, false)
  assert.equal(snapshot.doc.revision, 0)
  assert.deepEqual(snapshot.doc.workspaces, {})
})

test('add writes the file atomically and bumps the revision', async () => {
  const { root, file, store } = await storeFixture()
  const result = await store.mutate({ op: 'add', workspaceId: 'ws-a', tag: ' 客户 / PEI ' }, 'C:\\p\\A')
  assert.equal(result.doc.revision, 1)
  assert.deepEqual(result.entry.tags, ['客户/PEI'])
  assert.equal(result.entry.path, 'C:\\p\\A')

  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.owner, 'dsh-ui-project-dashboard')
  assert.deepEqual(onDisk.workspaces['ws-a'].tags, ['客户/PEI'])
  assert.equal(onDisk.workspaces['ws-a'].path, 'C:\\p\\A')
  assert.equal(onDisk.revision, 1)

  const leftovers = (await readdir(join(root, 'storages', 'project-dashboard'))).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('adding an existing tag is a no-op that keeps the revision', async () => {
  const { store } = await storeFixture()
  await store.mutate({ op: 'add', workspaceId: 'ws-a', tag: '阶段/试产' }, '')
  const again = await store.mutate({ op: 'add', workspaceId: 'ws-a', tag: '阶段/试产' }, '')
  assert.equal(again.doc.revision, 1)
  assert.deepEqual(again.entry.tags, ['阶段/试产'])
})

test('remove and set replace the list; set de-duplicates', async () => {
  const { store } = await storeFixture()
  await store.mutate({ op: 'set', workspaceId: 'ws-a', tags: ['a', 'a/b', 'a'] }, '')
  let snapshot = await store.snapshot()
  assert.deepEqual(snapshot.doc.workspaces['ws-a'].tags, ['a', 'a/b'])
  await store.mutate({ op: 'remove', workspaceId: 'ws-a', tag: 'a' }, '')
  snapshot = await store.snapshot()
  assert.deepEqual(snapshot.doc.workspaces['ws-a'].tags, ['a/b'])
  assert.equal(snapshot.doc.revision, 2)
})

test('a stale expectedRevision throws TagConflictError and leaves the file', async () => {
  const { store } = await storeFixture()
  await store.mutate({ op: 'add', workspaceId: 'ws-a', tag: 'a' }, '')
  await assert.rejects(
    () => store.mutate({ op: 'add', workspaceId: 'ws-a', tag: 'b' }, '', 0),
    (error) => error instanceof TagConflictError && error.revision === 0 && error.current === 1,
  )
  const snapshot = await store.snapshot()
  assert.deepEqual(snapshot.doc.workspaces['ws-a'].tags, ['a'])
})

test('the previous good file is kept as .bak', async () => {
  const { file, store } = await storeFixture()
  await store.mutate({ op: 'add', workspaceId: 'ws-a', tag: 'first' }, '')
  await store.mutate({ op: 'add', workspaceId: 'ws-a', tag: 'second' }, '')
  const backup = JSON.parse(await readFile(`${file}.bak`, 'utf8'))
  assert.deepEqual(backup.workspaces['ws-a'].tags, ['first'])
})

test('invalid tags are rejected before anything is written', async () => {
  const { store } = await storeFixture()
  await assert.rejects(() => store.mutate({ op: 'add', workspaceId: 'ws-a', tag: '   ' }, ''), TagInputError)
  await assert.rejects(() => store.mutate({ op: 'add', workspaceId: 'ws-a', tag: 'a/b/c/d/e' }, ''), TagInputError)
  await assert.rejects(() => store.mutate({ op: 'add', workspaceId: '', tag: 'a' }, ''), TagInputError)
  const snapshot = await store.snapshot()
  assert.equal(snapshot.doc.revision, 0)
})

test('a corrupt file is reported, preserved on next write, and replaced', async () => {
  const { root, file, store } = await storeFixture()
  await mkdir(join(root, 'storages', 'project-dashboard'), { recursive: true })
  await writeFile(file, '{ not json', 'utf8')
  const snapshot = await store.snapshot()
  assert.equal(snapshot.corrupt, true)
  assert.equal(snapshot.doc.revision, 0)

  const result = await store.mutate({ op: 'add', workspaceId: 'ws-a', tag: 'a' }, '')
  assert.equal(result.doc.revision, 1)
  const names = await readdir(join(root, 'storages', 'project-dashboard'))
  assert.ok(names.some((name) => name.startsWith('tags.json.corrupt-')))
  const rewritten = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(rewritten.workspaces['ws-a'].tags, ['a'])
})

test('concurrent mutations serialize and both land', async () => {
  const { store } = await storeFixture()
  await Promise.all([
    store.mutate({ op: 'add', workspaceId: 'ws-a', tag: 'a' }, ''),
    store.mutate({ op: 'add', workspaceId: 'ws-b', tag: 'b' }, ''),
  ])
  const snapshot = await store.snapshot()
  assert.deepEqual(snapshot.doc.workspaces['ws-a'].tags, ['a'])
  assert.deepEqual(snapshot.doc.workspaces['ws-b'].tags, ['b'])
  assert.equal(snapshot.doc.revision, 2)
})
