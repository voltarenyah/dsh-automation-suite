/**
 * The static-page half: path resolution, the trust fence, and the responses the
 * route produces.
 *
 * These are the cases that would otherwise become a security bug or a blank
 * page in production: a traversed path, a dotfile, a cross-site request, a
 * missing asset, and a `HEAD` that should send headers but no body.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { answer, contentTypeOf, fenceFailure, PAGE_ROOT, ROUTE_BASE, safePageFile } from '../lib/page.js'
import { packageRoot } from '../scripts/tsc.mjs'

const guideJson = () => JSON.stringify({ plugin: 'dsh-ui-prompt-guide', entries: [] })

test('content types are explicit and never guessed as HTML', () => {
  assert.match(contentTypeOf('index.html'), /^text\/html/)
  assert.match(contentTypeOf('app.js'), /^text\/javascript/)
  assert.match(contentTypeOf('style.css'), /^text\/css/)
  assert.match(contentTypeOf('guide.json'), /^application\/json/)
  assert.equal(contentTypeOf('secret.exe'), 'application/octet-stream')
})

test('path resolution refuses traversal, dotfiles and unknown extensions', () => {
  assert.equal(safePageFile(PAGE_ROOT, ''), null)
  assert.equal(safePageFile(PAGE_ROOT, '.gitignore'), null)
  assert.equal(safePageFile(PAGE_ROOT, '..'), null)
  assert.equal(safePageFile(PAGE_ROOT, '../package.json'), null)
  assert.equal(safePageFile(PAGE_ROOT, 'sub/../../package.json'), null)
  assert.equal(safePageFile(PAGE_ROOT, 'missing.js'), null)
  assert.equal(safePageFile(PAGE_ROOT, 'package.json'), null, 'only allow-listed extensions')
  assert.equal(safePageFile(join(PAGE_ROOT, 'nope'), 'index.html'), null, 'missing root')
  assert.notEqual(safePageFile(PAGE_ROOT, 'index.html'), null)
  assert.notEqual(safePageFile(PAGE_ROOT, 'app.js'), null)
})

test('the fence refuses cross-site and mismatched origins, not plain requests', () => {
  assert.equal(fenceFailure({}), null)
  assert.equal(fenceFailure({ host: '127.0.0.1:3082' }), null)
  assert.equal(fenceFailure({ 'sec-fetch-site': 'cross-site' }), 'cross-site request refused')
  assert.equal(fenceFailure({ origin: 'https://evil.example', host: '127.0.0.1:3082' }), 'origin does not match host')
  assert.equal(fenceFailure({ origin: 'http://127.0.0.1:3082', host: '127.0.0.1:3082' }), null)
  assert.equal(fenceFailure({ origin: 'not a url', host: '127.0.0.1:3082' }), 'origin is not a URL')
})

test('the root redirects to the trailing-slash page', () => {
  const response = answer(PAGE_ROOT, ROUTE_BASE, 'GET', { host: '127.0.0.1:3082' }, guideJson)
  assert.equal(response.status, 308)
  assert.equal(response.headers.location, `${ROUTE_BASE}/`)
})

test('GET / serves the page HTML', () => {
  const response = answer(PAGE_ROOT, `${ROUTE_BASE}/`, 'GET', { host: '127.0.0.1:3082' }, guideJson)
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /^text\/html/)
  assert.match(String(response.body), /^<!doctype html>/i)
})

test('HEAD sends headers without a body', () => {
  const response = answer(PAGE_ROOT, `${ROUTE_BASE}/`, 'HEAD', { host: '127.0.0.1:3082' }, guideJson)
  assert.equal(response.status, 200)
  assert.equal(response.body, undefined)
  assert.ok(Number(response.headers['content-length']) > 0)
})

test('the JSON endpoint serialises the guide and is never cached', () => {
  const response = answer(PAGE_ROOT, `${ROUTE_BASE}/api/guide`, 'GET', { host: '127.0.0.1:3082' }, guideJson)
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /^application\/json/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(String(response.body)), { plugin: 'dsh-ui-prompt-guide', entries: [] })
})

test('writes, traversal and cross-site requests are refused', () => {
  const post = answer(PAGE_ROOT, `${ROUTE_BASE}/`, 'POST', { host: '127.0.0.1:3082' }, guideJson)
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')

  const fence = answer(PAGE_ROOT, `${ROUTE_BASE}/`, 'GET', { 'sec-fetch-site': 'cross-site' }, guideJson)
  assert.equal(fence.status, 403)

  const traversal = answer(PAGE_ROOT, `${ROUTE_BASE}/../package.json`, 'GET', { host: '127.0.0.1:3082' }, guideJson)
  assert.equal(traversal.status, 404)
})

test('the page assets reference each other and the shell bridge', () => {
  const html = readFileSync(join(PAGE_ROOT, 'index.html'), 'utf8')
  assert.match(html, /<link rel="stylesheet" href="\.\/style\.css"/)
  assert.match(html, /<script src="\.\/app\.js"><\/script>/)
  assert.match(html, /id="cards"/)
  assert.match(html, /id="search"/)

  const app = readFileSync(join(PAGE_ROOT, 'app.js'), 'utf8')
  assert.match(app, /\.\/api\/guide/)
  assert.match(app, /prompt-guide:start/)
  assert.match(app, /prompt-guide:scheme/)
  assert.match(app, /start-failed/)
  // The first visit should follow the shell's language, not just the OS locale.
  assert.match(app, /parent\.document\.documentElement\.lang/)

  const css = readFileSync(join(PAGE_ROOT, 'style.css'), 'utf8')
  assert.match(css, /data-scheme="dark"/)
  assert.match(css, /prefers-color-scheme: dark/)
})

test('the page ships without a build step', () => {
  // `lib/` is generated; `page/` must exist in the checkout itself.
  for (const name of ['index.html', 'app.js', 'style.css']) {
    const file = join(packageRoot(), 'page', name)
    assert.ok(safePageFile(join(packageRoot(), 'page'), name) !== null, `${file} missing`)
  }
})
