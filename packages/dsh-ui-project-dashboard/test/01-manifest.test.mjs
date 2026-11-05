/**
 * Structural tests for the P0 package.
 *
 * They pin the three things that silently break a UI plugin registration and do
 * not show up in a build log:
 *
 *  1. the Loader row's name equals `package.json`'s name (a mismatch makes
 *     `client-modules` never ask for the bundle);
 *  2. `exports["./client"]` exists and `dsh.client.platform` is `web` (the host
 *     drops non-web rows and rejects a missing bundle);
 *  3. the built bundle declares the two seats this plugin owns and the negative
 *     order that puts it above Plugins (the sidebar only sorts by `order`).
 *
 * @module dsh-ui-project-dashboard/test/manifest
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')
const manifest = JSON.parse(read('package.json'))

test('the Loader row name equals the package name verbatim', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /- id: project-dashboard/)
  assert.match(patch, new RegExp(`name: ${manifest.name}`))
})

test('the package declares the browser half correctly', () => {
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('the host half exports the Cordis plugin name', async () => {
  const host = await import('../lib/index.js')
  assert.equal(host.name, 'project-dashboard')
  assert.equal(typeof host.apply, 'function')
})

test('the built bundle registers the two root seats above Plugins', () => {
  const bundle = read('lib', 'client.js')
  assert.ok(bundle.startsWith('window.__ModuleLoader__.load({'))
  assert.ok(bundle.includes(`id: ${JSON.stringify(manifest.name)}`))
  assert.ok(bundle.includes('sidebar.panellist'))
  assert.ok(bundle.includes('name: "main"'))
  assert.match(bundle, /(?:var|const|let) ORDER = -10\b/)
  assert.ok(bundle.includes('project-dashboard'))
})
