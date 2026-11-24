/**
 * The host row: what the package declares, and what it refuses to do.
 *
 * The split starts with an empty shell on purpose (root
 * `docs/version-control-plan.md` §7, S1): the row must exist before the tools
 * move, so the profile, the packaging and the doctor have something to point at
 * while the code is in flight. These tests hold the two properties that would be
 * expensive to discover later:
 *
 * - the **host row registers no model tool and no service** — a tool here would
 *   be inherited by every agent, including subagents (D23);
 * - the **bundle patch name equals the package name byte for byte**, because the
 *   loader treats that scalar as a module identifier (root AGENTS.md §1).
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { Config, apply, name } from '../lib/index.js'
import { configDefaults, resolveConfig } from '../lib/config.js'

/** A context that fails loudly if the host row registers anything. */
function fakeContext() {
  const logs = []
  const ctx = {
    logger(scope) {
      return {
        info: (message) => logs.push({ scope, message }),
        warn: (message) => logs.push({ scope, message, level: 'warn' }),
        error: (message) => logs.push({ scope, message, level: 'error' }),
      }
    },
    tools: {
      register() {
        throw new Error('the host row must not register model tools; use a /tools row')
      },
    },
    provide() {
      throw new Error('the host row registers no service yet (S2 adds versionControl)')
    },
  }
  return { ctx, logs }
}

test('the loader row identifies itself and carries a config schema', () => {
  assert.equal(name, 'version-control')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function', 'schemastery returns a schema function')
})

test('the host row registers no model tool and no service', () => {
  const { ctx, logs } = fakeContext()

  apply(ctx, {})

  const info = logs.filter((entry) => entry.level === undefined)
  assert.equal(info.length, 1, 'one line saying the row is ready')
  assert.match(info[0].message, /no model tools are registered on this row/u)
  assert.equal(info[0].scope, 'version-control')
})

test('config defaults describe where history and source trees live', () => {
  const resolved = resolveConfig()
  assert.deepEqual(resolved, configDefaults)
  assert.equal(resolved.stateDirName, '.dsh')
  assert.equal(resolved.sourceDirName, 'source')
  assert.equal(resolved.sourceIndexFile, '_dsh-engineering-context.json')
})

test('a name that could move writes out of the workspace falls back to the default', () => {
  for (const bad of ['../escape', 'nested/name', 'nested\\name', '..', '.', '', '   ', 'con', 'a:b', 'x?y']) {
    const resolved = resolveConfig({ stateDirName: bad, sourceDirName: bad })
    assert.equal(resolved.stateDirName, configDefaults.stateDirName, `stateDirName "${bad}" must fall back`)
    assert.equal(resolved.sourceDirName, configDefaults.sourceDirName, `sourceDirName "${bad}" must fall back`)
  }
  const kept = resolveConfig({ stateDirName: '.state', sourceDirName: 'src', sourceIndexFile: 'index.json' })
  assert.deepEqual(kept, { stateDirName: '.state', sourceDirName: 'src', sourceIndexFile: 'index.json' })
})

test('the bundle patch names the package exactly (loader contract)', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

  assert.equal(pkg.name, '@automation-suite/version-control')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(
    patch.includes(`name: '${pkg.name}'`),
    'cordis.patch.yml must carry the quoted, byte-identical package name',
  )
  assert.match(patch, /id: version-control/u)
})
