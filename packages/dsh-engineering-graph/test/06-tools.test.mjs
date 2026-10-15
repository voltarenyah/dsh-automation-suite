/**
 * The tool contract.
 *
 * These tests drive the registered tool bodies against a recording client stub, so
 * they assert what the model depends on: the tool names, the canonical envelope
 * every tool declares (validated with the registry's own validator, not a copy),
 * which engine parameters each tool sends for which arguments, and that an
 * operation failure is `ok: false` with the engine's code while a transport
 * failure is a throw.
 *
 * The stand-in context is the harness's; the definitions themselves are compiled by
 * the **real** `defineTool`, which is what makes the schema assertions meaningful.
 *
 * @module dsh-engineering-graph/test/tools
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertOutcomeMatchesSchema,
  createTestContext,
  executeTool,
  loadToolsModule,
  renderedText,
} from './helpers/harness.mjs'

/** The tool names this plugin registers, in registration order (deliberate; see `src/tools.ts`). */
const TOOL_NAMES = ['knowledge_schema', 'knowledge_ingest', 'knowledge_query']

/** A result frame shaped exactly like the engine's (`engine/Program.cs:ResultFrame`). */
function resultFrame(operation, options = {}) {
  const frame = {
    type: 'result',
    protocol: 1,
    id: 'stub',
    operation,
    ok: options.ok ?? true,
    durationMs: options.durationMs ?? 7,
  }
  if (options.data !== undefined) frame.data = options.data
  if (options.error !== undefined) frame.error = options.error
  return frame
}

/** An engine refusal, exactly as `EngineException` serializes it. */
function rejection(code, message, remediation) {
  return { code, message, ...(remediation === undefined ? {} : { remediation }) }
}

const NO_SIGNAL = { signal: new AbortController().signal }

/** A recording client stub: every call is captured and answered by `reply`. */
function recordingClient(reply) {
  const calls = []
  const logs = []
  const log = {
    debug: (message) => logs.push({ level: 'debug', message }),
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  }
  return {
    calls,
    logs,
    dependencies: {
      request: async (operation, params, options) => {
        calls.push({ operation, params, options })
        return reply(operation, params)
      },
      log,
    },
  }
}

async function harness(reply) {
  const tools = await loadToolsModule()
  const context = createTestContext()
  const recording = recordingClient(reply)
  tools.registerTools(context.ctx, recording.dependencies)
  const byName = Object.fromEntries(context.definitions.map((definition) => [definition.name, definition]))
  return { tools, context, calls: recording.calls, logs: recording.logs, byName }
}

test('registerTools registers the three deliberate tool names, in order', async () => {
  const { context } = await harness(() => resultFrame('GetSchema'))
  assert.deepEqual(context.registered(), TOOL_NAMES)
  for (const definition of context.definitions) {
    assert.ok(definition.description.length > 40, `${definition.name} needs a real description`)
  }
})

test('every tool declares the same canonical envelope output schema', async () => {
  const { byName } = await harness(() => resultFrame('GetSchema'))

  for (const name of TOOL_NAMES) {
    const schema = byName[name].output.schema
    assert.equal(schema.type, 'object', name)
    assert.equal(schema.additionalProperties, false, name)
    assert.deepEqual(
      [...schema.required].sort(),
      ['changes', 'diagnostics', 'dryRun', 'durationMs', 'ok', 'operation', 'summary'],
      `${name}: the required envelope members`,
    )
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      ['changes', 'data', 'diagnostics', 'dryRun', 'durationMs', 'error', 'ok', 'operation', 'summary'],
      `${name}: the envelope members`,
    )
    assert.equal(schema.properties.ok.type, 'boolean', name)
    assert.equal(schema.properties.operation.type, 'string', name)
    assert.equal(schema.properties.summary.type, 'string', name)
    assert.equal(schema.properties.durationMs.type, 'number', name)
    assert.equal(schema.properties.changes.type, 'array', name)
    assert.equal(schema.properties.diagnostics.type, 'array', name)
    // `data` and `error` are the author-only `json` node, which `defineTool`
    // compiles into an annotation-only schema: any lossless JSON is accepted.
    assert.equal(schema.properties.data.type, undefined, name)
    assert.equal(schema.properties.error.type, undefined, name)
  }
})

test('the declared parameters require exactly what the engine requires', async () => {
  const { byName } = await harness(() => resultFrame('GetSchema'))

  assert.deepEqual([...byName['knowledge_ingest'].parameters.required], ['export_root'])
  assert.deepEqual([...byName['knowledge_query'].parameters.required], ['db_path', 'sql'])
  assert.ok(!('required' in byName['knowledge_schema'].parameters), 'knowledge_schema has no required parameter')

  assert.deepEqual(Object.keys(byName['knowledge_schema'].parameters.properties), ['known_version'])
  assert.deepEqual(Object.keys(byName['knowledge_ingest'].parameters.properties).sort(), ['db_path', 'export_root'])
  assert.deepEqual(Object.keys(byName['knowledge_query'].parameters.properties).sort(), ['db_path', 'max_rows', 'sql'])
  assert.equal(byName['knowledge_query'].parameters.properties.max_rows.type, 'integer')
})

test('knowledge_query says the statement is read-only and points at knowledge_schema', async () => {
  const { byName } = await harness(() => resultFrame('GetSchema'))
  const description = byName['knowledge_query'].description
  assert.match(description, /read-only/)
  assert.match(description, /SELECT/)
  assert.match(description, /WITH/)
  assert.match(description, /EXPLAIN/)
  assert.match(description, /knowledge_schema/)
  assert.match(description, /QUERY_REJECTED/)
})

test('every tool declares a presentCall in the plugin presentation shape', async () => {
  const { byName } = await harness(() => resultFrame('GetSchema'))

  const schema = byName['knowledge_schema'].presentCall({})
  const ingest = byName['knowledge_ingest'].presentCall({ export_root: 'C:\\exp' })
  const query = byName['knowledge_query'].presentCall({ db_path: 'C:\\a.db', sql: 'SELECT 1' })

  for (const [presentation, kind] of [
    [schema, 'read'],
    [ingest, 'other'],
    [query, 'read'],
  ]) {
    assert.equal(presentation.card, 'generic')
    assert.equal(presentation.kind, kind)
    assert.ok(presentation.title.length > 0)
    assert.ok('rawInput' in presentation)
  }
  assert.equal(schema.title, 'Engineering graph schema')
  assert.equal(ingest.title, 'Ingest engineering exports')
  assert.equal(query.title, 'Query engineering graph')
})

test('each tool maps its parameters onto the engine\'s own camelCase names', async () => {
  const { calls, byName } = await harness((operation) => resultFrame(operation))

  await executeTool(byName['knowledge_schema'], {}, NO_SIGNAL)
  assert.deepEqual(calls[0].operation, 'GetSchema')
  assert.deepEqual(calls[0].params, {}, 'no known_version means no knownVersion')

  await executeTool(byName['knowledge_schema'], { known_version: 'abc' }, NO_SIGNAL)
  assert.deepEqual(calls[1].params, { knownVersion: 'abc' })

  await executeTool(byName['knowledge_ingest'], { export_root: 'C:\\exp' }, NO_SIGNAL)
  assert.deepEqual(calls[2].operation, 'Ingest')
  assert.deepEqual(calls[2].params, { exportRoot: 'C:\\exp' })

  await executeTool(byName['knowledge_ingest'], { export_root: 'C:\\exp', db_path: 'C:\\a.db' }, NO_SIGNAL)
  assert.deepEqual(calls[3].params, { exportRoot: 'C:\\exp', dbPath: 'C:\\a.db' })

  await executeTool(byName['knowledge_query'], { db_path: 'C:\\a.db', sql: 'SELECT 1' }, NO_SIGNAL)
  assert.deepEqual(calls[4].operation, 'Query')
  assert.deepEqual(calls[4].params, { dbPath: 'C:\\a.db', sql: 'SELECT 1' })

  await executeTool(byName['knowledge_query'], { db_path: 'C:\\a.db', sql: 'SELECT 1', max_rows: 5 }, NO_SIGNAL)
  assert.deepEqual(calls[5].params, { dbPath: 'C:\\a.db', sql: 'SELECT 1', maxRows: 5 })
})

test('a successful operation fills the envelope from the engine frame', async () => {
  const data = { dbPath: 'C:\\a.db', columns: ['n'], rows: [[42]], rowCount: 1, truncated: false }
  const { byName } = await harness((operation) => resultFrame(operation, { data, durationMs: 11 }))
  const tool = byName['knowledge_query']

  const outcome = await executeTool(tool, { db_path: 'C:\\a.db', sql: 'SELECT COUNT(*) AS n FROM graph_nodes' }, NO_SIGNAL)
  assertOutcomeMatchesSchema(tool, outcome)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.operation, 'Query')
  assert.equal(outcome.dryRun, false, 'the engine has no dry-run mode')
  assert.deepEqual(outcome.data, data)
  assert.deepEqual(outcome.changes, [])
  assert.deepEqual(outcome.diagnostics, [])
  assert.equal(outcome.error, null)
  assert.equal(outcome.durationMs, 11)
  assert.equal(outcome.summary, '1 row(s) returned from C:\\a.db.')

  const rendered = renderedText(tool, { db_path: 'C:\\a.db', sql: 'SELECT 1' }, outcome)
  assert.match(rendered, /Query succeeded\./)
  assert.match(rendered, /Columns: n/)
  assert.match(rendered, /Rows: 1/)
  assert.match(rendered, /\[42\]/, 'a row is rendered as its JSON array, one per line')
  assert.match(rendered, /\(11 ms in the engine\)/)
  assert.ok(!rendered.includes('Error code:'), 'a success must not render an error section')
})

test('an operation failure is ok:false with the engine code, and renders the remediation', async () => {
  const { byName } = await harness((operation) =>
    resultFrame(operation, {
      ok: false,
      error: rejection(
        'QUERY_REJECTED',
        'Only read-only SELECT, WITH or EXPLAIN statements are allowed.',
        'Rewrite as a SELECT; the connection is opened read-only as a backstop.',
      ),
      durationMs: 3,
    }),
  )
  const tool = byName['knowledge_query']

  // Not a throw: the engine ran and answered, so the model keeps the code.
  const outcome = await executeTool(tool, { db_path: 'C:\\a.db', sql: 'DROP TABLE graph_nodes' }, NO_SIGNAL)
  assertOutcomeMatchesSchema(tool, outcome)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.operation, 'Query')
  assert.equal(outcome.data, null)
  assert.equal(outcome.error.code, 'QUERY_REJECTED')
  assert.equal(outcome.error.message, 'Only read-only SELECT, WITH or EXPLAIN statements are allowed.')
  assert.equal(outcome.error.details.remediation, 'Rewrite as a SELECT; the connection is opened read-only as a backstop.')
  assert.equal(outcome.durationMs, 3)
  assert.match(outcome.summary, /Query was refused: Only read-only/)

  const rendered = renderedText(tool, { db_path: 'C:\\a.db', sql: 'DROP TABLE graph_nodes' }, outcome)
  assert.match(rendered, /Query FAILED\./)
  assert.match(rendered, /Error code: QUERY_REJECTED/)
  assert.match(rendered, /Remediation: Rewrite as a SELECT/)
})

test('an engine failure without a remediation still yields the documented envelope', async () => {
  const { byName } = await harness((operation) =>
    resultFrame(operation, { ok: false, error: rejection('DB_NOT_FOUND', "Database 'C:\\nope.db' was not found.", undefined) }),
  )

  const outcome = await executeTool(byName['knowledge_query'], { db_path: 'C:\\nope.db', sql: 'SELECT 1' }, NO_SIGNAL)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'DB_NOT_FOUND')
  assert.deepEqual(outcome.error.details, {}, 'details is always an object, so a consumer may read .remediation')
  assert.equal(renderedText(byName['knowledge_query'], { db_path: 'C:\\nope.db', sql: 'SELECT 1' }, outcome).includes('Remediation:'), false)
})

test('a transport failure thrown by the client is not swallowed by the tool', async () => {
  const failure = new Error('engine_not_found: The engineering-graph engine was not found at C:\\nope.exe.')
  failure.name = 'ToolFailure'
  failure.code = 'engine_not_found'
  const { byName } = await harness(() => {
    throw failure
  })

  await assert.rejects(
    async () => await executeTool(byName['knowledge_ingest'], { export_root: 'C:\\exp' }, NO_SIGNAL),
    (error) => {
      assert.equal(error, failure, 'the transport failure must reach the framework unchanged')
      assert.match(error.message, /^engine_not_found: /)
      return true
    },
  )
})

test('knowledge_ingest forwards the engine progress frames to the plugin log', async () => {
  const frames = [
    { type: 'progress', id: 'stub', phase: 'ingest', message: 'Crawling C:\\exp' },
    { type: 'progress', id: 'stub', phase: 'ingest', message: 'Writing C:\\a.db' },
  ]
  const { calls, logs, byName } = await harness((operation) =>
    resultFrame(operation, {
      data: {
        dbPath: 'C:\\a.db',
        source: 'crawl',
        filesFound: 2,
        filesImported: 2,
        nodes: 5,
        edges: 4,
        byKind: { Project: 1, FB: 4 },
        warnings: [],
      },
    }),
  )

  const outcome = await executeTool(byName['knowledge_ingest'], { export_root: 'C:\\exp', db_path: 'C:\\a.db' }, NO_SIGNAL)

  // The stub cannot call the callback itself (the real client does, once per
  // frame), so the test feeds the captured callback the frames an ingest emits.
  const onProgress = calls[0].options.onProgress
  assert.equal(typeof onProgress, 'function', 'ingest must ask the client for progress')
  for (const frame of frames) onProgress(frame)

  assert.deepEqual(
    logs.filter((entry) => entry.level === 'debug').map((entry) => entry.message),
    ['engine ingest [ingest] Crawling C:\\exp', 'engine ingest [ingest] Writing C:\\a.db'],
  )

  assert.equal(outcome.summary, 'Ingested 2 of 2 file(s) into C:\\a.db: 5 node(s) and 4 edge(s).')
  const rendered = renderedText(byName['knowledge_ingest'], { export_root: 'C:\\exp' }, outcome)
  assert.match(rendered, /Source: crawl \(files found: 2\)/)
  assert.match(rendered, /By node kind: Project=1, FB=4/)
})

test('the schema tool renders the tables, kinds and example queries', async () => {
  const data = {
    version: 'deadbeef',
    ddl: 'CREATE TABLE IF NOT EXISTS graph_nodes (id TEXT);\nCREATE TABLE graph_edges (id TEXT);',
    nodeKinds: ['Project', 'FB'],
    edgeTypes: ['CALLS'],
    exampleQueries: [{ name: 'Count node kinds', sql: 'SELECT kind, COUNT(*) FROM graph_nodes GROUP BY kind' }],
    operations: ['GetSchema', 'Ingest', 'Query'],
  }
  const { byName } = await harness((operation) => resultFrame(operation, { data }))
  const tool = byName['knowledge_schema']

  const outcome = await executeTool(tool, {}, NO_SIGNAL)
  assert.equal(outcome.summary, 'The graph schema is version deadbeef with 2 node kind(s) and 1 edge type(s).')
  const rendered = renderedText(tool, {}, outcome)
  assert.match(rendered, /Tables: graph_nodes, graph_edges/)
  assert.match(rendered, /Node kinds \(2\): Project, FB/)
  assert.match(rendered, /Count node kinds: SELECT kind, COUNT\(\*\) FROM graph_nodes/)
  assert.match(rendered, /Operations: GetSchema, Ingest, Query/)

  // The known_version short circuit is a two-field payload and says so.
  const { byName: shortByName } = await harness((operation) => resultFrame(operation, { data: { version: 'deadbeef', unchanged: true } }))
  const shortOutcome = await executeTool(shortByName['knowledge_schema'], { known_version: 'deadbeef' }, NO_SIGNAL)
  assert.equal(shortOutcome.summary, 'The graph schema is unchanged (version deadbeef).')
  assert.match(renderedText(shortByName['knowledge_schema'], {}, shortOutcome), /unchanged/)
})

test('a failure frame with no error object still yields a usable envelope', async () => {
  // `outcomeOf` guards against a frame with `ok:false` and no error object, so a
  // future engine that forgets one cannot produce `error: null` on a failure.
  const { byName } = await harness((operation) => resultFrame(operation, { ok: false }))
  const outcome = await executeTool(byName['knowledge_schema'], {}, NO_SIGNAL)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'unknown_failure')
  assert.match(outcome.error.message, /no error detail/)
  const rendered = renderedText(byName['knowledge_schema'], {}, outcome)
  assert.match(rendered, /Error code: unknown_failure/)
})
