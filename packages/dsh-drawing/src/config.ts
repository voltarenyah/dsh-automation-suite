/**
 * Plugin configuration.
 *
 * One knob: where drawings and their derived indexes live, relative to the
 * session workspace. Keeping it configurable means a project can put the PDFs
 * anywhere (`docs/drawings`, `TIA/drawings`, …) without a code change.
 *
 * @module dsh-drawing/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Raw profile config as written in `cordis.patch.yml`. */
export interface PluginConfig {
  /** Workspace-relative directory holding drawings and their indexes. */
  dir: string
}

/** The schema the loader validates and `--dump-config-schema` prints. */
export const Config: Schema<PluginConfig> = Schema.object({
  dir: Schema.string()
    .default('drawing')
    .description('Workspace-relative directory that holds the PDF drawings and their derived indexes.'),
})

/** Apply defaults to a possibly-empty config block. */
export function resolveConfig(config?: Partial<PluginConfig>): PluginConfig {
  const dir = typeof config?.dir === 'string' && config.dir.trim() !== '' ? config.dir.trim() : 'drawing'
  return { dir }
}
