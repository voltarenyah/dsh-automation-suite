/**
 * Build, then run the test suite.
 *
 * The tests drive the **built** `lib/`, like the sibling packages: they import
 * the same module the loader would, not a TypeScript source through a loader
 * hook. `lib/` is not committed, so the build has to happen first — which is why
 * the package's `test` script runs this file rather than `node --test` directly,
 * keeping `pnpm -r test` self-sufficient on a fresh checkout.
 *
 * @module dsh-ui-plc-source/scripts/run-tests
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { packageRoot, runTsc } from './tsc.mjs'

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
