import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

test('the bundle manifest and patch row agree on the package name', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')

  const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`name: '${manifest.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`, 'u'))
  assert.match(patch, /- id: tia-todo-bridge/u)
})

test('the package declares the runtime entry the Loader imports', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, './lib/index.js')
  assert.equal(manifest.exports['.'].default, './lib/index.js')
})
