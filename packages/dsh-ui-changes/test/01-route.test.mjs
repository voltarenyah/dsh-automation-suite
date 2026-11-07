/**
 * The status route's pure half: fence, method/path/parameter rules, and the
 * JSON envelope — plus how the service's expected failures become status codes.
 *
 * `lib/route.js` is the built module `lib/index.js` wires into `webServer`, so
 * these tests pin the exact code path the browser calls.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { StatusError } from '../lib/errors.js'
import { ROUTE_PREFIX, STATUS_PATH, answer, createHandler, fenceFailure } from '../lib/route.js'

/** Headers a same-origin page in the desktop app sends. */
const HOST = { host: '127.0.0.1:3095' }

/**
 * @param {object} [over] - payload fields to override.
 * @returns {object} a complete status payload.
 */
function payload(over = {}) {
  return {
    ok: true,
    generatedAt: '2026-11-06T10:00:00.000Z',
    repo: 'C:/repo',
    branch: 'main',
    detached: false,
    head: 'abc1234',
    files: [],
    totals: { files: 0, adds: 0, dels: 0, truncated: false },
    limits: { maxFiles: 1000, timeoutMs: 10000 },
    ...over,
  }
}

/** A service that echoes the session id, so the routing is observable. */
const echo = {
  status: async (sessionId) => payload({ repo: `C:/repo/${sessionId}` }),
}

/**
 * @param {object} [over] - request fields to override.
 * @returns {object} a request that passes every check.
 */
function request(over = {}) {
  return { method: 'GET', url: `${STATUS_PATH}?session=session-1`, headers: HOST, ...over }
}

describe('route prefix', () => {
  it('mounts the endpoint under the plugin prefix', () => {
    assert.equal(STATUS_PATH.startsWith(`${ROUTE_PREFIX}/`), true)
  })
})

describe('fence', () => {
  it('accepts a loopback host', () => {
    assert.equal(fenceFailure(HOST), null)
  })

  it('refuses cross-site requests', () => {
    assert.equal(fenceFailure({ ...HOST, 'sec-fetch-site': 'cross-site' }), 'cross-site request refused')
  })

  it('refuses an origin that does not match the host', () => {
    assert.equal(fenceFailure({ ...HOST, origin: 'http://evil.example' }), 'origin does not match host')
  })

  it('accepts an origin that matches the host', () => {
    assert.equal(fenceFailure({ ...HOST, origin: 'http://127.0.0.1:3095' }), null)
  })

  it('refuses a non-loopback host unless it is trusted', () => {
    assert.equal(fenceFailure({ host: 'dsh.example:8080' }), 'host dsh.example is not trusted')
    assert.equal(fenceFailure({ host: 'dsh.example:8080' }, ['dsh.example']), null)
  })
})

describe('answer', () => {
  it('answers 200 with the payload', async () => {
    const result = await answer(echo, request())
    assert.equal(result.status, 200)
    const body = JSON.parse(result.body)
    assert.equal(body.ok, true)
    assert.equal(body.repo, 'C:/repo/session-1')
    assert.deepEqual(Object.keys(body.totals).sort(), ['adds', 'dels', 'files', 'truncated'])
  })

  it('omits the body for HEAD', async () => {
    const result = await answer(echo, request({ method: 'HEAD' }))
    assert.equal(result.status, 200)
    assert.equal(result.body, undefined)
  })

  it('rejects other methods with a hint', async () => {
    const result = await answer(echo, request({ method: 'POST' }))
    assert.equal(result.status, 405)
    assert.equal(result.headers.allow, 'GET, HEAD')
    assert.equal(JSON.parse(result.body).code, 'changes/method-not-allowed')
  })

  it('refuses a request without a session', async () => {
    const result = await answer(echo, request({ url: STATUS_PATH }))
    assert.equal(result.status, 400)
    assert.equal(JSON.parse(result.body).code, 'changes/bad-request')
  })

  it('404s on any other path under the prefix', async () => {
    const result = await answer(echo, request({ url: '/changes/api/diff?session=s' }))
    assert.equal(result.status, 404)
    assert.equal(JSON.parse(result.body).code, 'changes/route-not-found')
  })

  it('turns an expected failure into its own status and code', async () => {
    const service = {
      status: async () => {
        throw new StatusError('changes/not-a-repository', 409, 'no repo here')
      },
    }
    const result = await answer(service, request())
    assert.equal(result.status, 409)
    const body = JSON.parse(result.body)
    assert.equal(body.code, 'changes/not-a-repository')
    assert.equal(body.message, 'no repo here')
  })

  it('keeps a 503 visible for a composition without the git plugin', async () => {
    const service = {
      status: async () => {
        throw new StatusError('changes/no-git-service', 503, 'gitContext is not loaded')
      },
    }
    const result = await answer(service, request())
    assert.equal(result.status, 503)
    assert.equal(JSON.parse(result.body).code, 'changes/no-git-service')
  })

  it('turns an unexpected failure into a 500 with its own code', async () => {
    const service = {
      status: async () => {
        throw new Error('git exploded')
      },
    }
    const result = await answer(service, request())
    assert.equal(result.status, 500)
    const body = JSON.parse(result.body)
    assert.equal(body.code, 'changes/status-failed')
    assert.equal(body.message, 'git exploded')
  })
})

describe('createHandler', () => {
  it('writes the status, headers and body onto the response', async () => {
    const written = {}
    const response = {
      writeHead(status, headers) {
        written.status = status
        written.headers = headers
      },
      end(body) {
        written.body = body
      },
    }
    await createHandler(echo)(request(), response)
    assert.equal(written.status, 200)
    assert.equal(written.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(JSON.parse(written.body).ok, true)
  })

  it('catches a failure outside the service call', async () => {
    const written = {}
    const response = {
      writeHead(status) {
        written.status = status
      },
      end(body) {
        written.body = body
      },
    }
    // Reading `method` throws before `answer` reaches its own try block, so this
    // exercises the handler's last-resort branch.
    const broken = {
      get method() {
        throw new Error('unreadable request')
      },
      url: STATUS_PATH,
      headers: HOST,
    }
    await createHandler(echo)(broken, response)
    assert.equal(written.status, 500)
    assert.equal(JSON.parse(written.body).code, 'changes/internal')
  })
})
