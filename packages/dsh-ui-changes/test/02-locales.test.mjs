/**
 * Dictionaries: both languages carry the same keys and the same placeholders,
 * every key has text, and the panel's keys all exist.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NS, en, zh } from '../src/client/locales.js'

/** Keys the panel and the tab registration actually call. */
const USED = [
  'tab.title', 'guide.title', 'guide.description',
  'title', 'refresh', 'loading', 'noSession',
  'summary', 'summaryNoHead', 'clean',
  'error.notRepo', 'error.noService', 'error.sessionUnknown', 'error.timeout',
  'error.failed', 'error.http', 'retry',
]

/**
 * @param {string} text - one dictionary sentence.
 * @returns {string[]} the `{placeholder}` names it carries, sorted.
 */
function placeholders(text) {
  return [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]).sort()
}

describe('locales', () => {
  it('uses one namespace', () => {
    assert.equal(NS, 'changes')
  })

  it('has the same key set in both languages', () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  })

  it('has every key the panel uses', () => {
    for (const key of USED) {
      assert.ok(key in zh, `zh is missing ${key}`)
      assert.ok(key in en, `en is missing ${key}`)
    }
  })

  it('has no empty text', () => {
    for (const [key, value] of Object.entries(zh)) assert.ok(value.length > 0, `zh.${key} is empty`)
    for (const [key, value] of Object.entries(en)) assert.ok(value.length > 0, `en.${key} is empty`)
  })

  it('uses the same placeholders on both sides', () => {
    for (const key of Object.keys(zh)) {
      assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `placeholders differ for ${key}`)
    }
  })
})
