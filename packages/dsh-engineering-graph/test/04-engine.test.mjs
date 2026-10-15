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

  // 3. Every check that ran reported success.
  assert.match(output, /self-test: OK/, output)
})
