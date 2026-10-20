/**
 * Build, then run the test suite.
 *
 * The tests drive the pure event fold in `src/client/model.js` directly (it is
 * plain ESM, not JSX), so a fresh checkout can run them without the browser
 * bundle. The host half is still compiled first: it is what the Loader row
 * imports, and a broken `lib/index.js` should fail here rather than at startup.
 *
 * @module dsh-ui-tia-console/scripts/run-tests
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
