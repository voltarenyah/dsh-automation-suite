/**
 * The global panel's row label and page title are product names, not data.
 *
 * They live in the dictionaries so the sidebar row follows the app language
 * (the seat re-resolves the label thunk on locale change) and so a typo here
 * cannot silently ship an English row in the Chinese UI.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NS, en, zh } from '../src/client/locales.js'

test('the sidebar row is localised', () => {
  assert.equal(NS, 'projectDashboard')
  assert.equal(zh.panel, '项目看板')
  assert.equal(en.panel, 'Project Dashboard')
})

test('the page title matches the row', () => {
  assert.equal(zh.title, '项目看板')
  assert.equal(en.title, 'Project Dashboard')
})
