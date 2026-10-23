/**
 * The vendored C# engine: does it actually *run*?
 *
 * Everything else in this suite tests the TypeScript half. The engine is roughly
 * 300 KB of vendored C# that no test touched at all, so nothing caught a
 * regression in it — and, more importantly, nothing proved the two things a
 * successful compilation cannot: that the native SQLite provider (`e_sqlite3`)
 * loads at run time, and that real Simatic ML exports still parse into a graph.
 * `engine --self-test` checks exactly those two, so this test drives it.
 *
 * The engine is an ordinary build artifact (`.gitignore` excludes `engine/bin/`,
 * the same way the sibling package excludes `lib/`), so on a checkout where it
 * has not been built this test **skips with the command to fix that** instead of
 * failing. A red suite must mean "something is broken", not "you forgot to build
 * the other half".
 *
 * @module dsh-engineering-graph/test/engine
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loadEnginePathModule, packageRoot } from './helpers/harness.mjs'

/** The trimmed real V17 exports the engine crawls; see `engine/fixtures/README.md`. */
const FIXTURES = join(packageRoot, 'engine', 'fixtures')

test('the engine self test passes: native SQLite loads and real exports parse', async (t) => {
  const { bundledEnginePath } = await loadEnginePathModule()
  const engine = bundledEnginePath()

  if (!existsSync(engine)) {
    t.skip(`engine not built at ${engine} — build it with: pwsh -NoProfile -File engine/build.ps1`)
    return
  }

  // A real run: stdout and stderr are both captured, because a crash may write
  // its reason to either one.
  const result = spawnSync(engine, ['--self-test', FIXTURES], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

  assert.equal(result.status, 0, `engine self test exited ${result.status}:\n${output}`)

  // 1. The native provider loaded and a graph survived a write/read round trip.
  assert.match(output, /\[ok\] sqlite round-trip: nodes=\d+ edges=\d+/, output)

  // 2. Real exports parsed into a graph. The exact counts belong to the fixture
  //    set, so only the invariants are asserted: crawl mode imports everything it
  //    finds, and the result is not empty.
  const crawl = /\[ok\] export crawl \(([a-z-]+)\): filesFound=(\d+) filesImported=(\d+) nodes=(\d+) edges=(\d+)/.exec(output)
  assert.ok(crawl, `no crawl summary in the output:\n${output}`)

  const [, mode, found, imported, nodes, edges] = crawl
  assert.equal(mode, 'crawl', 'engine/fixtures has no metadata.json, so it must be crawled')
  assert.equal(imported, found, `only ${imported} of ${found} fixtures imported:\n${output}`)
  assert.ok(Number(nodes) > 0, 'the crawl produced no nodes')
  assert.ok(Number(edges) > 0, 'the crawl produced no edges')

  // 3. The three checks the TypeScript half relies on: an ingest into a real
  //    database, a query that returns rows, and the read-only guard refusing a
  //    write statement. The exact counts belong to the fixture set, so only the
  //    same invariants as above are asserted.
  const ingest = /\[ok\] ingest: filesFound=(\d+) filesImported=(\d+) nodes=(\d+) edges=(\d+)/.exec(output)
  assert.ok(ingest, `no ingest summary in the output:\n${output}`)
  const [, ingestFound, ingestImported, ingestNodes, ingestEdges] = ingest
  assert.equal(ingestImported, ingestFound, `only ${ingestImported} of ${ingestFound} fixtures ingested:\n${output}`)
  assert.ok(Number(ingestImported) > 0, 'the ingest wrote nothing')
  assert.ok(Number(ingestNodes) > 0, 'the ingest produced no nodes')
  assert.ok(Number(ingestEdges) > 0, 'the ingest produced no edges')

  const query = /\[ok\] query: columns=(\d+) rows=(\d+)/.exec(output)
  assert.ok(query, `no query summary in the output:\n${output}`)
  assert.ok(Number(query[1]) > 0, 'the query returned no columns')
  assert.ok(Number(query[2]) > 0, 'the query returned no rows')

  // 4. LAD networks must carry their translated logic. The engine asserts this
  //    itself because a broken translator/importer segment key empties every LAD
  //    network without moving a single node count: the crawl stays green and only
  //    a model reading the database notices (docs/decisions.md D28).
  const ladLogic = /\[ok\] LAD logic: (\d+)\/(\d+) LAD network/.exec(output)
  assert.ok(ladLogic, `no LAD-logic summary in the output:\n${output}`)
  assert.ok(Number(ladLogic[1]) > 0, `no LAD network carries translated logic:\n${output}`)

  assert.match(output, /\[ok\] read-only guard: DROP rejected with QUERY_REJECTED/, output)

  // 4. The incremental update path (B4) against a real manifest-driven device tree:
  //    one block mutated and replaced in place, one block removed, the three refusal
  //    codes, and the rollback guarantee when a batch fails half way through.
  const update = /\[ok\] incremental update: changed=(\d+) closure=(\d+)/.exec(output)
  assert.ok(update, `no incremental update summary in the output:\n${output}`)
  assert.equal(update[1], '1', 'exactly the one changed block must be replaced')
  assert.ok(Number(update[2]) >= 1, 'the dependency closure must include the calling block')
  assert.match(output, /blocks\/Main \[OB1\]\.xml/, 'Main calls the changed FC, so it is the closure')

  const removal = /\[ok\] incremental removal: removed=(\d+)/.exec(output)
  assert.ok(removal, `no incremental removal summary in the output:\n${output}`)
  assert.equal(removal[1], '1')

  assert.match(output, /\[ok\] update refusals: UPDATE_REQUIRES_FULL_REBUILD, UPDATE_UNKNOWN_COMPONENT, UPDATE_TOO_LARGE/, output)
  assert.match(output, /\[ok\] update atomicity: a failed batch left the database unchanged/, output)

  // 5. Every check that ran reported success.
  assert.match(output, /self-test: OK/, output)
})
