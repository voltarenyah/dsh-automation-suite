/**
 * Build, then run the test suite.
 *
 * The tests drive the **built** `lib/`, like the sibling packages: they import
 * the same module the loader would, not TypeScript sources through a loader
 * hook. `lib/` is not committed, so the build happens first — which is why the
 * package's `test` script runs this file instead of `node --test`.
 *
 * @module dsh-drawing/scripts/run-tests
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { packageRoot, runTsc } from './tsc.mjs'

// The built `lib/` imports the harness runtime packages (`@deepseek-ai/dsh-tools`
// and friends), which only the app provides. Bootstrap the link on a fresh
// checkout so `pnpm -r test` is self-sufficient, exactly like the siblings.
if (!existsSync(join(packageRoot(), 'node_modules', '@deepseek-ai', 'dsh-tools'))) {
  const link = spawnSync(process.execPath, [join(packageRoot(), 'scripts', 'link-dsh-runtime.mjs')], {
    stdio: 'inherit',
    cwd: packageRoot(),
  })
  if ((link.status ?? 1) !== 0) {
    console.error('could not link the harness runtime; see scripts/link-dsh-runtime.mjs')
    process.exit(1)
  }
}

const build = runTsc(['-p', 'tsconfig.json'])
if (build !== 0) process.exit(build)

const testDir = join(packageRoot(), 'test')
const files = readdirSync(testDir)
  .filter((entry) => entry.endsWith('.test.mjs'))
  .sort()
  .map((entry) => join('test', entry))

if (files.length === 0) {
  console.error(`no test/*.test.mjs files found in ${testDir}`)
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
  stdio: 'inherit',
  cwd: packageRoot(),
})
process.exit(result.status ?? 1)
