import { defineConfig } from 'vitest/config'

// `@deepseek-ai/*` resolves from node_modules, but not from npm: the packages are
// junctions placed there by `tests/global-setup.mjs`, sourced from the runtime the
// *installed* DeepSeek Harness app ships. That keeps the suite pinned to the API
// surface the plugin actually loads under — see tests/global-setup.mjs.
export default defineConfig({
  resolve: {
    extensions: ['.ts', '.js', '.mjs', '.json'],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globalSetup: ['tests/global-setup.mjs'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
