/**
 * Link the harness runtime packages this package's tests need.
 *
 * The tests import the built `lib/`, which imports `@deepseek-ai/dsh-tools`
 * (and `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`). Those are provided by
 * the running app at load time, not by npm — the sibling packages solve it the
 * same way: junction each package from `<DSH_HOME>/plugin-runtime` into this
 * package's `node_modules/@deepseek-ai/`.
 *
 * This script only ever CREATES links. It never deletes a directory: a junction
 * followed by a recursive delete would destroy the runtime cache (root
 * AGENTS.md §3). Existing entries are left alone.
 *
 * @module dsh-drawing/scripts/link-dsh-runtime
 */

import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @returns {string} this package's root directory. */
function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** Runtime packages this plugin needs at test time. */
const NEEDED = ['cordis', 'dsh-tools', 'schemastery']

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const source = join(dshHome, 'plugin-runtime', 'node_modules', '@deepseek-ai')
const target = join(packageRoot(), 'node_modules', '@deepseek-ai')

if (!existsSync(source)) {
  console.error(
    `runtime cache not found at ${source}\n` +
      'Run the extractor from a sibling package first, e.g.\n' +
      '  pnpm --filter @voltarenyah/dsh-engineering-context run link:runtime',
  )
  process.exit(1)
}

const available = new Set(readdirSync(source))
const missing = NEEDED.filter((name) => !available.has(name))
if (missing.length > 0) {
  console.error(`runtime cache is missing: ${missing.join(', ')}`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })
let linked = 0
for (const name of NEEDED) {
  const link = join(target, name)
  if (existsSync(link)) continue
  symlinkSync(join(source, name), link, 'junction')
  linked += 1
  console.log(`linked ${name}`)
}
console.log(linked === 0 ? 'nothing to link (already present)' : `linked ${linked} package(s)`)
