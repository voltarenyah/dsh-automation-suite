/**
 * Tests for the tags route: the fence, method/path handling, the document
 * shape, validation, conflicts, and the body cap.
 *
 * @module dsh-ui-project-dashboard/test/route
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { createHandler, DEFAULT_WORKSPACE_PATH, fenceFailure, handleRequest, ROUTE_PATH } from '../lib/route.js'
import { TagStore } from '../lib/tags/store.js'

/** @returns a service over a temp file plus the store for assertions. */
async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tags-route-'))
  const store = new TagStore(join(root, 'storages', 'project-dashboard', 'tags.json'), () => '2026-11-05T06:00:00.000Z')
  const calls = { pruned: 0 }
  return {
    store,
    calls,
    service: {
      snapshot: () => store.snapshot(),
      mutate: (operation, path, expectedRevision) => store.mutate(operation, path, expectedRevision),
      resolvePath: (workspaceId) => (workspaceId === 'ws-a' ? 'C:\\p\\A' : ''),
      defaultWorkspace: async () => ({ id: 'default-id', registered: true }),
      pruneDefaultWorkspace: async () => {
        calls.pruned += 1
        return { deleted: true }
      },
    },
  }
}

/** @returns request headers a local browser sends. */
function localHeaders() {
  return { host: '127.0.0.1:3095', origin: 'http://127.0.0.1:3095', 'sec-fetch-site': 'same-origin' }
}

/** @returns a fake response that records what was written. */
function fakeResponse() {
  const record = { status: 0, headers: {}, body: '' }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers ?? {}
    },
    end(body) {
      record.body = typeof body === 'string' ? body : body === undefined ? '' : String(body)
    },
  }
}

test('the fence refuses cross-site, foreign hosts and mismatched origins', () => {
  assert.equal(fenceFailure(localHeaders()), null)
  assert.equal(fenceFailure({ host: 'localhost:3095' }), null)
  assert.equal(fenceFailure({ host: '127.0.0.1:3095', 'sec-fetch-site': 'cross-site' }), 'cross-site request refused')
  assert.ok(fenceFailure({ host: 'evil.example:80' }))
  assert.ok(fenceFailure({}))
  assert.ok(fenceFailure({ host: '127.0.0.1:3095', origin: 'http://evil.example' }))
  assert.equal(fenceFailure({ host: 'evil.example:80' }, ['evil.example']), null)
})

test('GET returns an empty document before the first write', async () => {
  const { service } = await serviceFixture()
  const result = await handleRequest(service, { method: 'GET', url: ROUTE_PATH, headers: localHeaders() })
  assert.equal(result.status, 200)
  const body = JSON.parse(result.body)
  assert.equal(body.ok, true)
  assert.equal(body.revision, 0)
  assert.deepEqual(body.workspaces, {})
})

test('wrong methods, paths and fences are refused before any IO', async () => {
  const { service } = await serviceFixture()
  const put = await handleRequest(service, { method: 'PUT', url: ROUTE_PATH, headers: localHeaders() })
  assert.equal(put.status, 405)
  const missing = await handleRequest(service, { method: 'GET', url: '/other', headers: localHeaders() })
  assert.equal(missing.status, 404)
  const cross = await handleRequest(service, { method: 'GET', url: ROUTE_PATH, headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' } })
  assert.equal(cross.status, 403)
})

test('POST add stores the tag with the registry path, GET reads it back', async () => {
  const { service } = await serviceFixture()
  const add = await handleRequest(
    service,
    { method: 'POST', url: ROUTE_PATH, headers: localHeaders() },
    JSON.stringify({ workspaceId: 'ws-a', op: 'add', tag: '客户/PEI', expectedRevision: 0 }),
  )
  assert.equal(add.status, 200)
  const added = JSON.parse(add.body)
  assert.equal(added.revision, 1)
  assert.deepEqual(added.entry.tags, ['客户/PEI'])
  assert.equal(added.entry.path, 'C:\\p\\A')

  const read = await handleRequest(service, { method: 'GET', url: ROUTE_PATH, headers: localHeaders() })
  const document = JSON.parse(read.body)
  assert.equal(document.revision, 1)
  assert.deepEqual(document.workspaces['ws-a'].tags, ['客户/PEI'])
})

test('POST validates the body and the tag', async () => {
  const { service } = await serviceFixture()
  const notJson = await handleRequest(service, { method: 'POST', url: ROUTE_PATH, headers: localHeaders() }, 'no')
  assert.equal(notJson.status, 400)
  assert.equal(JSON.parse(notJson.body).code, 'body/not-json')

  const missingId = await handleRequest(service, { method: 'POST', url: ROUTE_PATH, headers: localHeaders() }, JSON.stringify({ op: 'add', tag: 'a' }))
  assert.equal(missingId.status, 400)

  const badOp = await handleRequest(service, { method: 'POST', url: ROUTE_PATH, headers: localHeaders() }, JSON.stringify({ workspaceId: 'ws-a', op: 'frobnicate' }))
  assert.equal(badOp.status, 400)

  const deep = await handleRequest(service, { method: 'POST', url: ROUTE_PATH, headers: localHeaders() }, JSON.stringify({ workspaceId: 'ws-a', op: 'add', tag: 'a/b/c/d/e' }))
  assert.equal(deep.status, 400)
  assert.equal(JSON.parse(deep.body).code, 'tag/too-deep')
})

test('a stale expectedRevision answers 409 with the current revision', async () => {
  const { service } = await serviceFixture()
  await handleRequest(service, { method: 'POST', url: ROUTE_PATH, headers: localHeaders() }, JSON.stringify({ workspaceId: 'ws-a', op: 'add', tag: 'a' }))
  const conflict = await handleRequest(
    service,
    { method: 'POST', url: ROUTE_PATH, headers: localHeaders() },
    JSON.stringify({ workspaceId: 'ws-a', op: 'add', tag: 'b', expectedRevision: 0 }),
  )
  assert.equal(conflict.status, 409)
  const body = JSON.parse(conflict.body)
  assert.equal(body.code, 'tags/conflict')
  assert.equal(body.revision, 1)
})

test('the default-workspace endpoint reports status and prunes on POST', async () => {
  const { service, calls } = await serviceFixture()
  const status = await handleRequest(service, { method: 'GET', url: DEFAULT_WORKSPACE_PATH, headers: localHeaders() })
  assert.equal(status.status, 200)
  assert.deepEqual(JSON.parse(status.body), { ok: true, id: 'default-id', registered: true })

  const pruned = await handleRequest(service, { method: 'POST', url: DEFAULT_WORKSPACE_PATH, headers: localHeaders() })
  assert.equal(pruned.status, 200)
  assert.deepEqual(JSON.parse(pruned.body), { ok: true, deleted: true })
  assert.equal(calls.pruned, 1)

  const foreign = await handleRequest(service, { method: 'POST', url: DEFAULT_WORKSPACE_PATH, headers: { host: 'evil.example:80' } })
  assert.equal(foreign.status, 403)
  assert.equal(calls.pruned, 1)
})

test('the handler reads a POST body and caps it', async () => {
  const { service } = await serviceFixture()
  const response = fakeResponse()
  const request = Readable.from([Buffer.from(JSON.stringify({ workspaceId: 'ws-a', op: 'add', tag: '来自流' }))])
  request.method = 'POST'
  request.url = ROUTE_PATH
  request.headers = localHeaders()
  await createHandler(service)(request, response)
  assert.equal(response.record.status, 200)
  assert.equal(JSON.parse(response.record.body).entry.tags[0], '来自流')

  const huge = fakeResponse()
  const large = Readable.from([Buffer.alloc(20 * 1024, 0x61)])
  large.method = 'POST'
  large.url = ROUTE_PATH
  large.headers = localHeaders()
  await createHandler(service)(large, huge)
  assert.equal(huge.record.status, 413)
})
