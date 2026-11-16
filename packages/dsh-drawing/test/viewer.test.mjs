/**
 * The viewer's static route: path containment, MIME types and the fence.
 *
 * The route only ever serves code that ships in the package; these tests pin
 * the traversal / extension / fence behaviour so a future refactor cannot turn
 * it into a file server for arbitrary paths.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { answerViewer, registerViewer, safeViewerFile } from '../lib/viewer-route.js'

/** A viewer-shaped directory plus a file outside it. */
async function makeRoot() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-drawing-viewer-'))
  const root = join(base, 'viewer')
  await mkdir(join(root, 'standard_fonts'), { recursive: true })
  await writeFile(join(root, 'viewer.html'), '<!doctype html><title>viewer</title>')
  await writeFile(join(root, 'viewer.mjs'), 'export const ok = true\n')
  await writeFile(join(root, 'viewer.css'), 'body { margin: 0 }\n')
  await writeFile(join(root, 'standard_fonts', 'FoxitSans.ttf'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(base, 'secret.txt'), 'do not serve')
  return { base, root }
}

test('serves the viewer page with its MIME type and length', async () => {
  const { root } = await makeRoot()
  const page = answerViewer(root, '/drawing-viewer/viewer.html', 'GET', {})
  assert.equal(page.status, 200)
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
  assert.match(String(page.body), /viewer/)
  assert.equal(page.headers['content-length'], String(Buffer.byteLength('<!doctype html><title>viewer</title>')))

  const head = answerViewer(root, '/drawing-viewer/viewer.html', 'HEAD', {})
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)

  const font = answerViewer(root, '/drawing-viewer/standard_fonts/FoxitSans.ttf', 'GET', {})
  assert.equal(font.status, 200)
  assert.equal(font.headers['content-type'], 'font/ttf')
})

test('refuses traversal, hidden segments and unknown extensions', async () => {
  const { root } = await makeRoot()
  assert.equal(answerViewer(root, '/drawing-viewer/../secret.txt', 'GET', {}).status, 404)
  assert.equal(answerViewer(root, '/drawing-viewer/%2e%2e/secret.txt', 'GET', {}).status, 404)
  assert.equal(answerViewer(root, '/drawing-viewer/.hidden', 'GET', {}).status, 404)
  assert.equal(answerViewer(root, '/drawing-viewer/viewer.html.exe', 'GET', {}).status, 404)
  assert.equal(safeViewerFile(root, '../secret.txt'), null)
  assert.equal(safeViewerFile(root, 'standard_fonts/FoxitSans.ttf') !== null, true)
})

test('fence refuses cross-site requests and other methods', async () => {
  const { root } = await makeRoot()
  assert.equal(answerViewer(root, '/drawing-viewer/viewer.html', 'GET', { 'sec-fetch-site': 'cross-site' }).status, 403)
  assert.equal(
    answerViewer(root, '/drawing-viewer/viewer.html', 'GET', { origin: 'http://evil.example', host: '127.0.0.1:1' }).status,
    403,
  )
  assert.equal(answerViewer(root, '/drawing-viewer/viewer.html', 'POST', {}).status, 405)
  assert.equal(answerViewer(root, '/drawing-viewer', 'GET', {}).status, 308)
  assert.equal(answerViewer(root, '/drawing-viewer/missing.mjs', 'GET', {}).status, 404)
})

test('registerViewer wires the prefix route to the answer function', async () => {
  const { root } = await makeRoot()
  let route
  const webServer = {
    register(value) {
      route = value
      return () => {}
    },
  }
  const dispose = registerViewer(webServer, root)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/drawing-viewer')
  const written = {}
  route.handler(
    { method: 'GET', url: '/drawing-viewer/viewer.mjs', headers: {} },
    {
      writeHead(status, headers) {
        written.status = status
        written.headers = headers
      },
      end(body) {
        written.body = body
      },
    },
  )
  assert.equal(written.status, 200)
  assert.equal(written.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(Buffer.isBuffer(written.body), true)
  assert.equal(typeof dispose, 'function')
})
