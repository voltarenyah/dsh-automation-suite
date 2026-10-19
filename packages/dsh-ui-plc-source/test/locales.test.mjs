/**
 * Guards the localization contract the app's language setting depends on.
 *
 * The typed namespace form `ctx.locale.register(ns, { zh, en })` requires both
 * built-in locales to carry the same key set, so the tests fail loudly when a
 * key is added to one dictionary and forgotten in the other — the failure mode
 * that otherwise shows up as a raw `plcSource.some.key` on screen.
 *
 * The dictionaries are imported from `src/` rather than `lib/`: they are browser
 * half data with no build step of their own (the client bundle inlines them).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NS, en, zh } from '../src/client/locales.js'

describe('locale dictionaries', () => {
  it('registers under a namespace the runtime accepts', () => {
    assert.equal(typeof NS, 'string')
    assert.ok(NS.length > 0)
    assert.match(NS, /^[A-Za-z][A-Za-z0-9]*$/)
  })

  it('carries the same key set in both built-in locales', () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
    assert.ok(Object.keys(zh).length > 20)
  })

  it('has non-empty copy everywhere', () => {
    for (const [locale, dictionary] of [
      ['zh', zh],
      ['en', en],
    ]) {
      for (const [key, value] of Object.entries(dictionary)) {
        assert.equal(typeof value, 'string', `${locale}.${key} must be a string`)
        assert.ok(value.trim().length > 0, `${locale}.${key} must not be empty`)
      }
    }
  })

  it('covers every error key the model can ask for', () => {
    const required = [
      'error.notFound',
      'error.outsideWorkspace',
      'error.notDirectory',
      'error.notRegularFile',
      'error.tooLarge',
      'error.notText',
      'error.watchUnsupported',
      'error.manifestInvalid',
      'error.cancelled',
      'error.lookupNotFound',
      'error.gateway',
      'error.other',
    ]
    for (const key of required) {
      assert.ok(key in zh, `zh is missing ${key}`)
      assert.ok(key in en, `en is missing ${key}`)
    }
  })

  it('keeps the interpolation placeholders of every parameterized key', () => {
    const placeholders = (value) => (value.match(/\{\w+\}/g) ?? []).sort()
    const parameterized = [
      'filter.device.all',
      'filter.type.all',
      'hint.truncated',
      'note.refused',
      'note.walked',
      'note.walked.files',
      'row.refusedTitle',
      'error.gateway',
      'error.other',
    ]
    for (const key of parameterized) {
      assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} placeholders differ`)
    }
  })
})
