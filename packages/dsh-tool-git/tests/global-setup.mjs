/**
 * Vitest global setup: make the DeepSeek Harness runtime resolvable.
 *
 * The tests boot the plugin on the *real* `@deepseek-ai/dsh-tools` runtime rather
 * than a stub, so `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis`,
 * `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-system-prompt` have to be
 * importable from this checkout.
 *
 * They deliberately do **not** come from npm. The published registry line stops at
 * `0.1.0-rc.6`, while the harness this repository develops against ships a newer
 * runtime; installing the registry copy would validate the plugin against the
 * wrong API surface. `scripts/link-dsh-runtime.mjs` instead links the packages
 * extracted from the *installed app's own* `resources/app.asar`, so the tests run
 * against exactly the runtime the app loads — the same rule the sibling
 * `dsh-tia-openness-v17-min` package follows.
 */

import { linkRuntime, unresolvedRuntimePackages } from '../scripts/link-dsh-runtime.mjs'

export default function setup() {
  if (unresolvedRuntimePackages().length === 0) return

  const result = linkRuntime({ quiet: true })
  if (result.missing.length > 0) {
    throw new Error(
      `The harness runtime packages ${result.missing.join(', ')} are not available. ` +
        'Install DeepSeek Harness, or run "node scripts/link-dsh-runtime.mjs" once.',
    )
  }
}
