/**
 * The rail row and the framed page must agree on the feature's name.
 *
 * The rail label is a thunk re-resolved on locale change, so the product name
 * follows the app language without a reload; the iframe title (its accessible
 * name) reads the same key at render time.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NS, en, zh } from '../src/client/locales.js'

test('the sidebar label follows the app language', () => {
  assert.equal(NS, 'promptGuide')
  assert.equal(zh.label, '提示词引导')
  assert.equal(en.label, 'Prompt Guide')
})

test('the framed page keeps the same accessible name', () => {
  assert.equal(zh['iframe.title'], '提示词引导')
  assert.equal(en['iframe.title'], 'Prompt Guide')
})
