/**
 * The `/tools` row's own configuration and the `includeIngest` switch.
 *
 * Why this file exists: the tool surface is now *declared per agent preset*, and
 * the only thing that distinguishes the `leader` preset from the `expert` one is
 * this row's `includeIngest` flag. A regression here would not fail anything
 * else — the tools would keep working, the suite would stay green, and the
 * read-only subagent would silently regain a tool that rewrites a whole device
 * database. So the switch is asserted at both levels:
 *
 *   1. `resolveToolsEntryConfig` / the real schemastery `Config`: only a real
 *      boolean is trusted, everything else falls back to `true`;
 *   2. the registered names themselves, through the row's `apply`, in order.
 *
 * @module dsh-engineering-graph/test/tools-entry
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTestContext, loadPlugin, loadToolsEntry } from './helpers/harness.mjs'

const entry = await loadToolsEntry()
const plugin = await loadPlugin()

/** The full surface, in registration order (deliberate; see `src/tools.ts`). */
const ALL_TOOLS = ['knowledge_schema', 'knowledge_ingest', 'knowledge_query']

/** What the read-only preset keeps: the same two tools, in the same order. */
const READ_ONLY_TOOLS = ['knowledge_schema', 'knowledge_query']

/** Apply both rows on one context, the way a preset declares them. */
function applyBoth(toolsConfig) {
  const harness = createTestContext()
  // A missing engine keeps the test off the real subprocess while still
  // exercising the full registration path.
  plugin.apply(harness.ctx, { enginePath: 'C:\\does\\not\\exist\\EngineeringGraph.Engine.exe' })
  entry.apply(harness.ctx, toolsConfig)
  return harness
}

test('the row is a Loader entry in its own right, under its own name', () => {
  assert.equal(entry.name, 'engineering-graph-tools')
  assert.notEqual(entry.name, plugin.name, 'the two rows must be independently declarable in a profile')
  assert.equal(typeof entry.apply, 'function')
  assert.equal(typeof entry.resolveToolsEntryConfig, 'function')
  assert.notEqual(entry.Config, undefined, 'a profile needs a Config schema to validate includeIngest')
})

test('resolveToolsEntryConfig defaults includeIngest to true', () => {
  assert.deepEqual(entry.resolveToolsEntryConfig(), { includeIngest: true })
  assert.deepEqual(entry.resolveToolsEntryConfig({}), { includeIngest: true })
  assert.equal(entry.toolsEntryConfigDefaults.includeIngest, true)
})

test('resolveToolsEntryConfig trusts only a real boolean', () => {
  assert.equal(entry.resolveToolsEntryConfig({ includeIngest: false }).includeIngest, false)
  assert.equal(entry.resolveToolsEntryConfig({ includeIngest: true }).includeIngest, true)

  // A string that merely *looks* false is the dangerous case: trusting it would
  // remove the ingest tool from an agent that was supposed to have it, or keep it
  // on one that was not. Only a boolean counts, everything else is the default.
  for (const bad of ['false', 'true', 'no', 0, 1, null, undefined, {}, []]) {
    assert.equal(
      entry.resolveToolsEntryConfig({ includeIngest: bad }).includeIngest,
      true,
      `includeIngest ${String(bad)} must fall back to the default, not be trusted`,
    )
  }
})

test('the real schemastery schema applies the same default and rejects non-booleans', () => {
  assert.deepEqual(entry.Config({}), { includeIngest: true })
  assert.deepEqual(entry.Config({ includeIngest: false }), { includeIngest: false })
  assert.throws(() => entry.Config({ includeIngest: 'yes' }), 'a non-boolean must not validate')
})

test('by default the row registers exactly schema, ingest, query — in that order', () => {
  const { registered } = applyBoth({})
  assert.deepEqual(registered(), ALL_TOOLS)
})

test('the row registers all three when applied with no config block at all', () => {
  const { registered } = applyBoth(undefined)
  assert.deepEqual(registered(), ALL_TOOLS)
})

test('includeIngest:false registers exactly schema and query, in that order', () => {
  const { registered } = applyBoth({ includeIngest: false })
  assert.deepEqual(registered(), READ_ONLY_TOOLS)
})

test('the two surviving tools are byte-for-byte the ones the default row registers', () => {
  const full = applyBoth({})
  const readOnly = applyBoth({ includeIngest: false })

  const byName = (harness) => Object.fromEntries(harness.definitions.map((definition) => [definition.name, definition]))
  const fullByName = byName(full)
  const readOnlyByName = byName(readOnly)

  // The presentation is part of the model-facing contract too, and it is the one
  // member `deepEqual` cannot compare directly (it is a function), so it is
  // compared by its output for the arguments the tests already use elsewhere.
  const presentationArgs = {
    knowledge_schema: {},
    knowledge_query: { db_path: 'C:\\a.db', sql: 'SELECT 1' },
  }

  for (const name of READ_ONLY_TOOLS) {
    assert.equal(readOnlyByName[name].description, fullByName[name].description, `${name}: description must not change`)
    assert.deepEqual(readOnlyByName[name].parameters, fullByName[name].parameters, `${name}: parameters must not change`)
    assert.deepEqual(readOnlyByName[name].output.schema, fullByName[name].output.schema, `${name}: output schema must not change`)
    assert.deepEqual(
      readOnlyByName[name].presentCall(presentationArgs[name]),
      fullByName[name].presentCall(presentationArgs[name]),
      `${name}: presentation must not change`,
    )
  }
  assert.equal(readOnlyByName['knowledge_ingest'], undefined, 'knowledge_ingest must not be registered at all')
})

test('the row logs the names it registered and names the owner of the engine', () => {
  const { logs } = applyBoth({})
  const info = logs.filter((entry) => entry.level === 'info' && entry.scope === 'engineering-graph-tools')

  assert.equal(info.length, 1)
  assert.ok(info[0].message.includes(ALL_TOOLS.join(', ')))
  assert.ok(info[0].message.includes('knowledgeGraph service'))
})

test('the row says in its log when it deliberately withheld the ingest tool', () => {
  const { logs } = applyBoth({ includeIngest: false })
  const info = logs.filter((entry) => entry.level === 'info' && entry.scope === 'engineering-graph-tools')

  assert.equal(info.length, 1)
  assert.ok(info[0].message.includes(READ_ONLY_TOOLS.join(', ')))
  assert.ok(!info[0].message.includes('knowledge_ingest,'), 'the log must not claim the withheld tool was registered')
  assert.match(info[0].message, /knowledge_ingest is disabled/)
})

test('applying the row without the host row fails loudly instead of registering broken tools', () => {
  const harness = createTestContext()
  assert.throws(
    () => entry.apply(harness.ctx, {}),
    /knowledgeEngine service is not in this composition/u,
    'a tools row without its host row must say so, not register tools whose calls cannot work',
  )
  assert.deepEqual(harness.registered(), [])
})
