/**
 * Dictionaries: both languages carry the same keys, every key has text, and the
 * panel's keys all exist.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NS, en, zh } from '../src/client/locales.js'

/** Keys the panel and the tab registration actually call. */
const USED = [
  'tab.title', 'guide.title', 'guide.description',
  'title', 'device', 'versions', 'changes', 'baselineObjects',
  'search', 'allFaces', 'allProblems', 'history', 'timeline',
  'baseline', 'blocks', 'noChange', 'baselineNote', 'reason', 'problem',
  'pickBlock', 'noMatch', 'changesCount', 'none',
  'modified', 'added', 'removed',
  'faceChange', 'resize',
  'refresh', 'loading', 'noWorkspace', 'readFailed', 'noView', 'retry',
]

describe('locales', () => {
  it('uses one namespace', () => {
    assert.equal(NS, 'versions')
  })

  it('has the same key set in both languages', () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  })

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries(zh)) assert.ok(value.length > 0, `zh.${key} is empty`)
    for (const [key, value] of Object.entries(en)) assert.ok(value.length > 0, `en.${key} is empty`)
  })

  it('covers every key the panel calls', () => {
    for (const key of USED) {
      assert.ok(key in zh, `zh is missing ${key}`)
      assert.ok(key in en, `en is missing ${key}`)
    }
  })

  it('keeps placeholders in both languages', () => {
    for (const key of ['blocks', 'changesCount', 'faceChange']) {
      assert.match(zh[key], /\{n\}|\{face\}/u)
      assert.match(en[key], /\{n\}|\{face\}/u)
    }
    assert.match(zh.readFailed, /\{code\}/u)
    assert.match(en.readFailed, /\{code\}/u)
  })
})
