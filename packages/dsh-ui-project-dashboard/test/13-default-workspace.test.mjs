/**
 * Tests for the first-use workspace helpers: reading the durable marker,
 * reporting whether it is still registered, and unregistering it.
 *
 * @module dsh-ui-project-dashboard/test/default-workspace
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  defaultWorkspaceStatus,
  pruneDefaultWorkspace,
  readDefaultWorkspaceId,
} from '../lib/default-workspace.js'

/** @returns a temp home with a workspace registry file. */
async function homeFixture(global = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-default-'))
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({ version: 2, global, tables: {} }), 'utf8')
  return home
}

/** @returns a registry stub over a mutable id list. */
function registryFixture(ids = []) {
  const calls = []
  return {
    calls,
    registry: {
      list: () => ids.map((id) => ({ id })),
      delete: async (id) => {
        calls.push(id)
        const index = ids.indexOf(id)
        if (index === -1) return false
        ids.splice(index, 1)
        return true
      },
    },
  }
}

test('the marker is read from the registry file', async () => {
  const home = await homeFixture({ defaultWorkspaceId: 'default-1' })
  assert.equal(await readDefaultWorkspaceId(home), 'default-1')
})

test('a missing, malformed or unmarked file reads as no marker', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'dsh-default-empty-'))
  assert.equal(await readDefaultWorkspaceId(empty), null)

  const broken = await homeFixture()
  await writeFile(join(broken, 'storages', 'workspace.json'), '{ nope', 'utf8')
  assert.equal(await readDefaultWorkspaceId(broken), null)

  const unmarked = await homeFixture({})
  assert.equal(await readDefaultWorkspaceId(unmarked), null)
})

test('status reports whether the recorded id is still registered', async () => {
  const home = await homeFixture({ defaultWorkspaceId: 'default-1' })
  const present = registryFixture(['ws-a', 'default-1'])
  assert.deepEqual(await defaultWorkspaceStatus(home, present.registry), { id: 'default-1', registered: true })

  const absent = registryFixture(['ws-a'])
  assert.deepEqual(await defaultWorkspaceStatus(home, absent.registry), { id: 'default-1', registered: false })

  assert.deepEqual(await defaultWorkspaceStatus(home, undefined), { id: 'default-1', registered: false })
})

test('prune unregisters the default workspace once', async () => {
  const home = await homeFixture({ defaultWorkspaceId: 'default-1' })
  const { registry, calls } = registryFixture(['default-1', 'ws-a'])
  assert.deepEqual(await pruneDefaultWorkspace(home, registry), { deleted: true })
  assert.deepEqual(calls, ['default-1'])
  assert.deepEqual(await defaultWorkspaceStatus(home, registry), { id: 'default-1', registered: false })
  assert.deepEqual(await pruneDefaultWorkspace(home, registry), { deleted: false, reason: 'not-registered' })
})

test('prune degrades when there is no marker or no registry', async () => {
  const unmarked = await homeFixture({})
  const { registry } = registryFixture(['ws-a'])
  assert.deepEqual(await pruneDefaultWorkspace(unmarked, registry), { deleted: false, reason: 'not-initialized' })

  const marked = await homeFixture({ defaultWorkspaceId: 'default-1' })
  assert.deepEqual(await pruneDefaultWorkspace(marked, undefined), { deleted: false, reason: 'no-registry' })
})
