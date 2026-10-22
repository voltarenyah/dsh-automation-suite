/**
 * End to end through the real engine.
 *
 * This is the only test that exercises the whole stack at once: tool definition →
 * client queue → NDJSON over pipes → the C# engine → SQLite → the canonical
 * envelope. Everything below is a real wire interaction, in this order:
 *
 *   1. spawn `EngineeringGraph.Engine.exe`, read the `ready` frame;
 *   2. `{"type":"operation","operation":"GetSchema","params":{}}` → `result`;
 *   3. `{"operation":"Ingest","params":{"deviceDir":<fixtures copy>,"dbPath":<tmp>}}`
 *      → two `progress` frames plus one `result`, and the tool's freshness sidecar
 *      under `<tmp>/.dsh/local/graph/` carrying the ledger's PLC checksum;
 *   4. `{"operation":"Query","params":{"dbPath":<tmp>,"sql":"SELECT COUNT(*) …"}}`;
 *   5. `{"operation":"Query","params":{…,"sql":"DROP TABLE graph_nodes"}}` →
 *      `result` with `ok:false` and `QUERY_REJECTED` (the read-only guard), not a
 *      transport failure;
 *   6. the same count query again, proving the refused DROP changed nothing;
 *   7. two requests issued at once, proving the client serializes and still matches
 *      results to requests by id;
 *   8. `stop()` (closing stdin) and a second `stop()`.
 *
 * The engine is a build artifact (`.gitignore` excludes `engine/bin/`), so on a
 * checkout where the C# half has not been built this test **skips with the command
 * to fix that** instead of failing. Everything it writes lands in a fresh
 * `os.tmpdir()` directory, which is removed afterwards — including the fixture copy
 * it ingests, because the plugin derives the sidecar's location from `deviceDir`.
 *
 * @module dsh-engineering-graph/test/end-to-end
 */

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertOutcomeMatchesSchema,
  createTestContext,
  engineAvailable,
  engineClient,
  engineSkipReason,
  executeTool,
  findTool,
  loadToolsModule,
  logsAt,
  packageRoot,
  renderedText,
} from './helpers/harness.mjs'

/** The trimmed real V17 exports the engine crawls; see `engine/fixtures/README.md`. */
const FIXTURES = join(packageRoot, 'engine', 'fixtures')

/** The graph-node count, spelled once so every step asks the same question. */
const COUNT_SQL = 'SELECT COUNT(*) AS n FROM graph_nodes'

/**
 * The PLC checksum the export ledger records. The ingest records it in the
 * freshness sidecar, and the copy below is where it has to end up.
 */
const PLC_CHECKSUM = 'E1 F0 C1 F9 0A 1B 2C 3D'

test('ingest engine/fixtures into a temp db, then query the node count', async (t) => {
  if (!engineAvailable) {
    t.skip(engineSkipReason)
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-engineering-graph-'))
  t.after(() => {
    // A real directory this test created under the OS temp folder: no junction or
    // link is involved, so a recursive delete is safe here (root AGENTS.md §3).
    rmSync(dir, { recursive: true, force: true })
  })

  // The device directory is a **copy** under `<temp>/source/fixtures`, for two
  // reasons: the plugin derives the freshness sidecar's location from `deviceDir`
  // (two levels up), so ingesting `engine/fixtures` directly would write
  // `.dsh/local/graph/` inside the package; and test data must never leave
  // `os.tmpdir()`. The copy also lets this test supply an evidence ledger.
  const deviceDir = join(dir, 'source', 'fixtures')
  mkdirSync(deviceDir, { recursive: true })
  cpSync(FIXTURES, deviceDir, { recursive: true })
  writeFileSync(
    join(deviceDir, '_evidence.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        hashAlgo: 'xml-norm-v1',
        device: 'fixtures',
        software: 'fixtures',
        plcChecksum: PLC_CHECKSUM,
        stateId: 'state-e2e',
        objects: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const dbPath = join(dir, 'plc-knowledge.db')
  // The database deliberately lives in the temp directory in its own right: the
  // ingest must write somewhere this test owns and can delete.

  const logs = []
  const client = await engineClient({ logs })
  t.after(async () => {
    await client.stop()
  })

  const tools = await loadToolsModule()
  const context = createTestContext()
  const toolLog = {
    debug: (message) => logs.push({ scope: 'plugin', level: 'debug', message }),
    info: (message) => logs.push({ scope: 'plugin', level: 'info', message }),
    warn: (message) => logs.push({ scope: 'plugin', level: 'warn', message }),
    error: (message) => logs.push({ scope: 'plugin', level: 'error', message }),
  }
  tools.registerTools(context.ctx, {
    request: async (operation, params, options) => await client.request(operation, params, options),
    log: toolLog,
  })
  const schemaTool = findTool(context.definitions, 'knowledge_schema')
  const ingestTool = findTool(context.definitions, 'knowledge_ingest')
  const queryTool = findTool(context.definitions, 'knowledge_query')
  const exec = { signal: new AbortController().signal }

  // The engine is up and agrees about the catalog before anything is sent.
  const ready = await client.start()
  assert.deepEqual([...ready.operations], ['GetSchema', 'Ingest', 'Query'])

  // 1. Schema first: no database needed, and it documents what the query may use.
  const schemaOutcome = await executeTool(schemaTool, {}, exec)
  assertOutcomeMatchesSchema(schemaTool, schemaOutcome)
  assert.equal(schemaOutcome.ok, true, renderFailure(schemaOutcome))
  assert.equal(schemaOutcome.operation, 'GetSchema')
  assert.equal(schemaOutcome.error, null)
  assert.ok(schemaOutcome.durationMs >= 0)
  assert.ok(schemaOutcome.data.nodeKinds.includes('FB'), 'the schema names the node kinds')
  assert.ok(schemaOutcome.data.ddl.includes('CREATE TABLE'), 'the schema carries the DDL')
  assert.deepEqual([...schemaOutcome.data.operations], ['GetSchema', 'Ingest', 'Query'])
  assert.ok(
    schemaOutcome.data.exampleQueries.some((example) => typeof example.sql === 'string' && example.sql.length > 0),
    'the schema carries worked example queries',
  )

  // 2. Ingest the fixture copy into a database this test owns.
  const ingestOutcome = await executeTool(ingestTool, { device_dir: deviceDir, db_path: dbPath }, exec)
  assertOutcomeMatchesSchema(ingestTool, ingestOutcome)
  assert.equal(ingestOutcome.ok, true, renderFailure(ingestOutcome))
  assert.equal(ingestOutcome.operation, 'Ingest')
  assert.equal(ingestOutcome.data.dbPath, dbPath, 'the engine echoes the database it wrote')
  assert.ok(ingestOutcome.data.filesFound > 0, 'the crawl found the fixture XML')
  assert.equal(ingestOutcome.data.filesImported, ingestOutcome.data.filesFound, 'every fixture imported')
  assert.ok(ingestOutcome.data.nodes > 0, 'the graph has nodes')
  assert.ok(ingestOutcome.data.edges > 0, 'the graph has edges')
  assert.ok(Object.keys(ingestOutcome.data.byKind).length > 0, 'the per-kind counts are reported')
  assert.deepEqual(ingestOutcome.data.warnings, [])
  const nodeCount = ingestOutcome.data.nodes

  // The engine's progress frames travelled the wire and reached the plugin log:
  // this is the same callback the tools hand to the client.
  const progress = logsAt(logs, 'debug').filter((entry) => entry.message.startsWith('engine ingest ['))
  assert.ok(progress.length >= 2, `expected ingest progress frames, got: ${JSON.stringify(logs)}`)
  assert.ok(progress.some((entry) => entry.message.includes(deviceDir)), 'the first frame names the folder being crawled')

  // 2b. The tool recorded the graph's provenance after the real engine wrote the
  //     database: the sidecar lives under `<temp>/.dsh/local/graph/`, i.e. derived
  //     from the device directory — never from the process cwd, and never in the
  //     package.
  const sidecarPath = join(dir, '.dsh', 'local', 'graph', 'fixtures.json')
  assert.equal(existsSync(sidecarPath), true, 'a successful ingest must leave the freshness sidecar behind')
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  assert.equal(sidecar.schemaVersion, 1)
  assert.equal(sidecar.device, 'fixtures')
  assert.equal(sidecar.plcChecksum, PLC_CHECKSUM, 'the sidecar carries the evidence ledger checksum verbatim')
  assert.equal(sidecar.stateId, 'state-e2e')
  assert.equal(sidecar.sourceDir, 'source/fixtures')
  assert.match(sidecar.builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  // 3. The graph is non-empty, asked the way the model would ask.
  const countOutcome = await executeTool(queryTool, { db_path: dbPath, sql: COUNT_SQL }, exec)
  assertOutcomeMatchesSchema(queryTool, countOutcome)
  assert.equal(countOutcome.ok, true, renderFailure(countOutcome))
  assert.equal(countOutcome.operation, 'Query')
  assert.deepEqual([...countOutcome.data.columns], ['n'])
  assert.equal(countOutcome.data.rowCount, 1)
  assert.equal(countOutcome.data.truncated, false)
  assert.equal(countOutcome.data.rows[0][0], nodeCount)
  assert.ok(countOutcome.data.rows[0][0] > 0, 'the graph is not empty')
  assert.match(countOutcome.summary, /^1 row\(s\) returned from /)
  assert.match(renderedText(queryTool, { db_path: dbPath, sql: COUNT_SQL }, countOutcome), /Query succeeded\./)

  // 4. A write statement is the engine's read-only guard: an operation failure
  //    (`ok:false` + code), never a throw, and it must mention the remediation.
  const dropOutcome = await executeTool(queryTool, { db_path: dbPath, sql: 'DROP TABLE graph_nodes' }, exec)
  assertOutcomeMatchesSchema(queryTool, dropOutcome)
  assert.equal(dropOutcome.ok, false)
  assert.equal(dropOutcome.operation, 'Query')
  assert.equal(dropOutcome.error.code, 'QUERY_REJECTED')
  assert.match(dropOutcome.error.message, /read-only/)
  assert.match(dropOutcome.error.details.remediation, /SELECT/)
  assert.equal(dropOutcome.data, null)
  const renderedDrop = renderedText(queryTool, { db_path: dbPath, sql: 'DROP TABLE graph_nodes' }, dropOutcome)
  assert.match(renderedDrop, /Query FAILED\./)
  assert.match(renderedDrop, /Error code: QUERY_REJECTED/)
  assert.match(renderedDrop, /Remediation: /)

  // 5. A missing database is the engine's other structured refusal.
  const missingDb = await executeTool(queryTool, { db_path: join(dir, 'nope.db'), sql: 'SELECT 1' }, exec)
  assert.equal(missingDb.ok, false)
  assert.equal(missingDb.error.code, 'DB_NOT_FOUND')

  // 6. The refused DROP changed nothing.
  const afterOutcome = await executeTool(queryTool, { db_path: dbPath, sql: COUNT_SQL }, exec)
  assert.equal(afterOutcome.ok, true, renderFailure(afterOutcome))
  assert.equal(afterOutcome.data.rows[0][0], nodeCount, 'the graph survived the refused DROP')

  // 7. Two requests at once: the client queues them rather than interleaving, and
  //    both results are still matched to the request that asked for them.
  const [first, second] = await Promise.all([
    client.request('GetSchema', {}),
    client.request('Query', { dbPath, sql: COUNT_SQL }),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.data.rows[0][0], nodeCount)

  // 8. Status and shutdown. `stop()` closes stdin; the engine reads EOF and exits.
  const status = client.status()
  assert.equal(status.state, 'ready', 'the queue drained and the engine is idle again')
  assert.equal(status.inflightOperation, null)
  assert.equal(status.queueDepth, 0)
  assert.equal(status.restarts, 0, 'the engine never had to be replaced')
  assert.equal(status.requestsServed, 8, 'GetSchema, Ingest, count, DROP, DB_NOT_FOUND, count, then the concurrent pair')
  assert.ok(status.stderrTail.some((line) => line.includes('ready')), 'the engine notes itself on stderr')

  await client.stop()
  assert.equal(client.status().pid, null, 'stop() must not leave the engine behind')
  assert.equal(client.status().state, 'stopped')
  await client.stop()
  assert.equal(client.status().pid, null, 'stop() is idempotent')

  // 9. A fresh client can read the database this one wrote: the file is a normal
  //    SQLite database, not process state.
  const reopened = await engineClient()
  try {
    const frame = await reopened.request('Query', { dbPath, sql: COUNT_SQL })
    assert.equal(frame.ok, true)
    assert.equal(frame.data.rows[0][0], nodeCount)
  } finally {
    await reopened.stop()
  }
})

/** A failure message that carries the engine's own reason, for assertion output. */
function renderFailure(outcome) {
  return outcome.ok ? '' : `${outcome.error.code}: ${outcome.error.message}`
}
