/**
 * Build both halves of the plugin.
 *
 * `lib/index.js` is the Node side: `tsc` compiles the empty host face, which
 * exists so the Loader row has a module to import.
 *
 * `lib/client.js` is the browser side, and it is **not** plain ESM: the host's
 * module system executes a bundle as a classic script that must do nothing but
 * register a closure factory, then materialise it on first use. The wrapper is
 * therefore a `banner`/`footer` pair around a CJS bundle, the same shape as the
 * sibling `dsh-ui-plc-source` package.
 *
 * Only the host's frozen platform table stays external; the client imports
 * nothing else.
 *
 * @module dsh-ui-tia-console/scripts/build
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { packageRoot, runTsc } from './tsc.mjs'

const root = packageRoot()
const repo = resolve(root, '..', '..')

/** Module table frozen by the running shell (host 0.2.1-rc.2). */
const PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

/**
 * @returns {string | null} esbuild's CJS entry point, or null when the store has none.
 */
function resolveEsbuild() {
  const candidates = [join(repo, 'node_modules', 'esbuild', 'lib', 'main.js')]
  const store = join(repo, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith('esbuild@')) continue
      candidates.push(join(store, entry, 'node_modules', 'esbuild', 'lib', 'main.js'))
    }
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

const hostBuild = runTsc(['-p', 'tsconfig.json'])
if (hostBuild !== 0) process.exit(hostBuild)

const esbuildPath = resolveEsbuild()
if (esbuildPath === null) {
  console.error(
    'esbuild was not found in this checkout (looked for node_modules/esbuild and node_modules/.pnpm/esbuild@*).\n' +
      'Run "pnpm install" at the repository root, or install esbuild where the store can see it.',
  )
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const id = manifest.name

const banner = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(id)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
].join('\n')

const footer = ['\t\treturn module.exports;', '\t}', '});'].join('\n')

mkdirSync(join(root, 'lib'), { recursive: true })

const require = createRequire(import.meta.url)
/** @type {import('esbuild')} */
const esbuild = require(esbuildPath)

await esbuild.build({
  entryPoints: [join(root, 'src', 'client', 'index.jsx')],
  outfile: join(root, 'lib', 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: PLATFORM_MODULES,
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: banner },
  footer: { js: footer },
})

const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const check = {
  wrapper: bundle.startsWith('window.__ModuleLoader__.load({'),
  id: bundle.includes(`id: ${JSON.stringify(id)}`),
  returns: bundle.includes('return module.exports;'),
  map: existsSync(join(root, 'lib', 'client.js.map')),
}
const missing = Object.entries(check)
  .filter(([, ok]) => !ok)
  .map(([name]) => name)
if (missing.length > 0) {
  console.error(`lib/client.js is missing: ${missing.join(', ')}`)
  process.exit(1)
}
console.log(`built lib/index.js and lib/client.js (${bundle.length} bytes)`)
