/**
 * Links the DSH runtime packages the plugin imports from the shared plugin
 * runtime cache. Mirrors the sibling TIA package's source choice (the installed
 * app's `<DSH_HOME>/plugin-runtime`), but does not extract it: run the TIA
 * package's `link:runtime` (or any sibling that extracts) once on a bare
 * checkout first.
 *
 * Usage:
 *   node scripts/link-dsh-runtime.mjs
 */

import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const source = join(home, 'plugin-runtime', 'node_modules', '@deepseek-ai')
const target = join(here, '..', 'node_modules', '@deepseek-ai')
const packages = ['cordis', 'dsh-tools', 'schemastery']

if (!existsSync(source)) {
  throw new Error(
    `The shared DSH runtime is missing at ${source}. ` +
      `Run a sibling package's link:runtime first (it extracts the app runtime), then retry.`,
  )
}

mkdirSync(target, { recursive: true })
for (const name of packages) {
  const from = join(source, name)
  const to = join(target, name)
  if (!existsSync(from)) throw new Error(`The shared runtime does not contain @deepseek-ai/${name}.`)
  if (existsSync(to)) continue
  symlinkSync(from, to, 'junction')
  console.log(`linked @deepseek-ai/${name}`)
}
