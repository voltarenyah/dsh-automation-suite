/**
 * The zh and en dictionaries must carry the same key set; the runtime's typed
 * namespace form requires it, and a missing key would render as the raw key.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NS, en, zh } from '../src/client/locales.js'

test('zh and en declare exactly the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('no dictionary value is empty and the namespace is set', () => {
  assert.equal(NS, 'tiaConsole')
  for (const [key, value] of Object.entries(zh)) assert.ok(value.length > 0, `zh.${key}`)
  for (const [key, value] of Object.entries(en)) assert.ok(value.length > 0, `en.${key}`)
})
