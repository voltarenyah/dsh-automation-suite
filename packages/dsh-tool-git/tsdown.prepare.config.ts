import { defineConfig } from 'tsdown'

/**
 * Consumer-side build for git installs (the `prepare` script): transpile
 * straight from src without tsc project references, which need the sibling
 * harness checkout that only dev machines and CI have. Types are NOT checked
 * here — `pnpm run typecheck` owns that on dev machines.
 *
 * `deps.neverBundle: true` keeps the harness runtime out of the bundle for the
 * same reason as in `tsdown.config.ts`: `@deepseek-ai/*` must resolve to the
 * host profile's copy at load time, and the build must not depend on whether the
 * dev-time runtime links are present. See that file for the full explanation.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/tools-entry.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: { neverBundle: true },
  tsconfig: 'tsconfig.prepare.json',
})
