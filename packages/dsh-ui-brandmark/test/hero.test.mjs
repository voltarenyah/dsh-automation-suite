/**
 * Contract tests for the hero branding plugin.
 *
 * The browser override itself lives in a bundle and is verified against a real
 * client (start-env + screenshot); what these tests pin down is the part that
 * can regress silently: the exact copy the product asked for, that every other
 * translation keeps falling through, and that the desktop icon really is the
 * artwork that ships.
 *
 * @module dsh-ui-brandmark/test/hero
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { HERO_HEADLINE, HERO_NAMESPACE, HERO_PREVIEW, heroCopy } from '../lib/model.js'

/** Absolute package root (`test/` is one level below it). */
const root = fileURLToPath(new URL('..', import.meta.url))

test('the conversation hero headline is the suite name', () => {
  assert.equal(HERO_NAMESPACE, 'conversation')
  assert.equal(HERO_HEADLINE, 'dsh-automation-suite')
  assert.equal(heroCopy('conversation', 'hero.headline'), 'dsh-automation-suite')
})

test('the conversation preview badge is the TIA edition label', () => {
  assert.equal(HERO_PREVIEW, 'TIA-V17')
  assert.equal(heroCopy('conversation', 'hero.preview'), 'TIA-V17')
})

test('every other lookup falls through untouched', () => {
  const others = [
    ['conversation', 'hero.chooseWorkspace'],
    ['conversation', 'todo.title'],
    ['common', 'hero.headline'],
    ['settings', 'hero.preview'],
    ['conversation', 'hero.headline.suffix'],
  ]
  for (const [namespace, key] of others) assert.equal(heroCopy(namespace, key), undefined, `${namespace}/${key}`)
})

test('the shipped mark is the 128px square desktop icon', () => {
  const png = readFileSync(join(root, 'assets', 'brandmark.png'))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.equal(width, 128)
  assert.equal(height, 128)
})

test('the manifest exposes the browser half and its Loader row', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-ui-brandmark')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`name: ${manifest.name}\\b`))
})
