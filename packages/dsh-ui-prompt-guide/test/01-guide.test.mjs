/**
 * The guide is the product: these tests keep it internally consistent and keep
 * every tool name honest.
 *
 * The failure this suite exists to prevent is a page that reads well and names a
 * tool that does not exist. `TOOL_CATALOG` is the allow-list; it is maintained by
 * hand from the sibling packages, so adding a name to it is the review step
 * (it must exist in some package's `src/tools*.ts`).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { CATEGORIES, ENTRIES, GUIDE_VERSION, TOOL_CATALOG, guideDocument } from '../lib/guide.js'
import { packageRoot } from '../scripts/tsc.mjs'

const doc = guideDocument()

/**
 * Assert one localized field and return its Chinese text.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function localized(value, label) {
  assert.equal(typeof value, 'object', `${label} must be an object`)
  assert.notEqual(value, null, `${label} must not be null`)
  for (const lang of ['zh', 'en']) {
    const text = value[lang]
    assert.equal(typeof text, 'string', `${label}.${lang} must be a string`)
    assert.ok(text.trim().length > 0, `${label}.${lang} must not be empty`)
  }
  return value.zh
}

test('payload declares its identity and stays JSON-safe', () => {
  assert.equal(doc.plugin, 'dsh-ui-prompt-guide')
  assert.equal(doc.version, GUIDE_VERSION)
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc)
})

test('categories are ordered, unique and each one has entries', () => {
  assert.ok(CATEGORIES.length >= 6, 'at least six categories')
  const ids = new Set()
  for (const category of CATEGORIES) {
    assert.match(category.id, /^[a-z][a-z0-9-]*$/)
    assert.ok(!ids.has(category.id), `duplicate category id ${category.id}`)
    ids.add(category.id)
    localized(category.title, `${category.id}.title`)
    localized(category.summary, `${category.id}.summary`)
    assert.equal(typeof category.order, 'number')
    assert.ok(
      ENTRIES.some((entry) => entry.category === category.id),
      `category ${category.id} has no entry`,
    )
  }
  const orders = CATEGORIES.map((category) => category.order)
  assert.equal(new Set(orders).size, orders.length, 'category order keys collide')
})

test('entries are unique, well-formed and point at a real category', () => {
  assert.ok(ENTRIES.length >= 20, 'at least twenty prompts')
  const ids = new Set()
  const categoryIds = new Set(CATEGORIES.map((category) => category.id))
  for (const entry of ENTRIES) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/)
    assert.ok(!ids.has(entry.id), `duplicate entry id ${entry.id}`)
    ids.add(entry.id)
    assert.ok(categoryIds.has(entry.category), `${entry.id}: unknown category ${entry.category}`)
    assert.equal(typeof entry.order, 'number')
    localized(entry.title, `${entry.id}.title`)
    localized(entry.when, `${entry.id}.when`)
    localized(entry.prompt, `${entry.id}.prompt`)
    localized(entry.outcome, `${entry.id}.outcome`)
    if (entry.note !== undefined) localized(entry.note, `${entry.id}.note`)

    for (const lang of ['zh', 'en']) {
      const prompt = entry.prompt[lang]
      assert.ok(prompt.trim().length >= 8, `${entry.id}.prompt.${lang} is too short`)
      assert.ok(prompt.length <= 400, `${entry.id}.prompt.${lang} is too long to paste`)
    }
  }

  // Order inside one category must be unique, otherwise the page's sort is not
  // deterministic and cards can jump around between reloads.
  const seen = new Set()
  for (const entry of ENTRIES) {
    const key = `${entry.category}/${entry.order}`
    assert.ok(!seen.has(key), `duplicate order ${key}`)
    seen.add(key)
  }
})

test('every tool a prompt mentions exists in the catalog', () => {
  const known = new Set(TOOL_CATALOG)
  for (const entry of ENTRIES) {
    for (const tool of entry.tools) {
      assert.ok(known.has(tool), `${entry.id}: "${tool}" is not in TOOL_CATALOG`)
      assert.match(tool, /^(\/tia-[a-z]+|[a-z][a-z0-9_]*)$/, `${entry.id}: "${tool}" is not a tool name or /tia- command`)
    }
  }
})

test('the catalog itself is unique and covers every advertised tool', () => {
  assert.equal(new Set(TOOL_CATALOG).size, TOOL_CATALOG.length, 'catalog has duplicates')
  for (const name of TOOL_CATALOG) {
    assert.ok(
      name.startsWith('/tia-') || /^[a-z][a-z0-9_]*$/.test(name),
      `catalog entry ${name} is neither a slash command nor a snake_case tool`,
    )
  }
  // Slash commands are a real, finite surface; all of them must be documented so
  // this page can be the one place a user looks.
  for (const command of ['/tia-open', '/tia-save', '/tia-compile', '/tia-close', '/tia-info', '/tia-find', '/tia-status']) {
    assert.ok(TOOL_CATALOG.includes(command), `${command} missing from the catalog`)
  }
})

test('the page payload is what the host route will serialise', () => {
  const serialised = JSON.stringify(guideDocument())
  assert.ok(serialised.includes('"plugin":"dsh-ui-prompt-guide"'))
  assert.ok(serialised.includes('"categories"'))
  assert.ok(serialised.includes('"entries"'))
  // JSON.stringify keeps non-ASCII as UTF-8 rather than escaping it; the page
  // decodes the response as UTF-8 JSON.
  assert.ok(serialised.includes('起步'), 'Chinese text should survive serialisation')
})

test('document() returns a copy, not the module-level arrays', () => {
  const first = guideDocument()
  first.entries.push({ id: 'injected' })
  const second = guideDocument()
  assert.equal(second.entries.length, ENTRIES.length)
  assert.ok(!second.entries.some((entry) => entry.id === 'injected'))
})

test('package metadata points at the built halves', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-ui-prompt-guide')
  assert.equal(manifest.main, './lib/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.files.includes('page'), 'page/ must ship with the package')
  const patch = readFileSync(join(packageRoot(), 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('id: ui-prompt-guide'))
  assert.ok(patch.includes('name: dsh-ui-prompt-guide'))
})
