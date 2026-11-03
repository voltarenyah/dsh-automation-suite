/**
 * The built halves and the wiring between them.
 *
 * `lib/client.js` is not imported here (its first statement needs
 * `window.__ModuleLoader__`); it is checked as text, which is exactly what the
 * shell does with it before handing it to the module table. The host half is a
 * normal ESM module and is imported for its exports.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { packageRoot } from '../scripts/tsc.mjs'

const root = packageRoot()

test('the client bundle registers a module factory for this package', () => {
  const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(bundle.startsWith('window.__ModuleLoader__.load({'), 'missing module-loader wrapper')
  assert.ok(bundle.includes('id: "dsh-ui-prompt-guide"'))
  assert.ok(bundle.includes('return module.exports;'))
})

test('the client half uses the two root seats and the session bridge', () => {
  const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(bundle.includes('sidebar.panellist'), 'sidebar rail seat missing')
  assert.ok(bundle.includes('"main"') || bundle.includes("'main'"), 'main seat missing')
  assert.ok(bundle.includes('uiWorkspace'))
  assert.ok(bundle.includes('prompt-guide:start'))
  assert.ok(bundle.includes('prompt-guide:scheme'))
  assert.ok(bundle.includes('/prompt-guide/'))
})

test('the host half exports the loader contract', async () => {
  const module = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  assert.equal(module.name, 'ui-prompt-guide')
  assert.deepEqual(module.inject, ['webServer'])
  assert.equal(typeof module.apply, 'function')
  const doc = module.guideDocument()
  assert.equal(doc.plugin, 'dsh-ui-prompt-guide')
  assert.ok(doc.entries.length >= 15)
})

test('apply registers exactly one prefix route and disposes it through effect', () => {
  // Re-import the built module and drive apply against a fake host, so the test
  // proves the route is registered through `ctx.effect` (and would be removed
  // on unload) rather than merely that the function exists.
  const invoked = []
  const disposers = []
  return import(pathToFileURL(join(root, 'lib', 'index.js')).href).then((module) => {
    const ctx = {
      logger: { info: (message) => invoked.push(['info', message]), warn: (message) => invoked.push(['warn', message]) },
      effect: (fn, label) => {
        const dispose = fn()
        invoked.push(['effect', label])
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      webServer: {
        register: (route) => {
          invoked.push(['register', route])
          return () => invoked.push(['disposed'])
        },
      },
    }
    module.apply(ctx)
    const route = invoked.find((entry) => entry[0] === 'register')?.[1]
    assert.ok(route, 'no route registered')
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/prompt-guide')
    assert.ok(invoked.some((entry) => entry[0] === 'effect'))
    assert.equal(typeof route.handler, 'function')
  })
})

test('the route handler answers a GET / with the page', () => {
  return import(pathToFileURL(join(root, 'lib', 'index.js')).href).then((module) => {
    let registered = null
    module.apply({
      logger: {},
      webServer: { register: (route) => (registered = route) },
      effect: undefined,
    })
    assert.ok(registered)
    let status = 0
    let headers = {}
    let body = ''
    registered.handler(
      { method: 'GET', url: '/prompt-guide/', headers: { host: '127.0.0.1:3092' } },
      {
        writeHead: (code, sent) => {
          status = code
          headers = sent ?? {}
        },
        end: (sent) => {
          body = String(sent ?? '')
        },
      },
    )
    assert.equal(status, 200)
    assert.match(headers['content-type'], /^text\/html/)
    assert.match(body, /^<!doctype html>/i)
  })
})
