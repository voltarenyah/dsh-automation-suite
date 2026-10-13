import { defineConfig } from 'tsdown'

/**
 * Author-side build. `tsc -b` emits declarations into `lib/types` first; this
 * pass emits the runtime JavaScript into `lib`.
 *
 * `deps.neverBundle: true` is load-bearing, not cosmetic. `@deepseek-ai/*` is
 * resolved from the *host's* runtime at load time — a profile supplies it — so a
 * bundled copy would give the plugin its own private `dsh-tools`/`cordis` and
 * break the tool registry it is supposed to register into. Without this option
 * the outcome silently depends on whether the dev-time runtime links happen to
 * exist: with them absent rolldown treats `@deepseek-ai/*` as unresolvable and
 * leaves them external anyway, but once `link:runtime` has run it resolves them
 * and inlines the whole runtime (57 kB → 391 kB) into the plugin. Declaring them
 * external makes the build deterministic either way.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: { neverBundle: true },
  tsconfig: 'tsconfig.prepare.json',
})
