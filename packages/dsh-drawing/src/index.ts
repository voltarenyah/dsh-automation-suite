/**
 * dsh-drawing — electrical drawings for DeepSeek Harness.
 *
 * What this build implements (P0 + P1 of `docs/research/drawing-plugin-plan.md`):
 *
 *   ingest    `drawing_open` copies a PDF into the workspace and builds its
 *             index once (sheets, cross references, named elements, profile);
 *             re-ingesting unchanged bytes returns the cached index
 *   browse    `drawing_status` / `drawing_search` / `drawing_sheet` answer from
 *             the index only — the PDF is never re-parsed for a query
 *   locate    `drawing_show` hands the page + highlight box to the right
 *             sidebar's Drawing tab (the browser half folds it out of the
 *             session's tool results)
 *
 * What it deliberately does not do: rebuild electrical connectivity from the
 * drawing (symbols are flattened line segments — see the research note), render
 * raster pages (P3), or keep a registry of drawings — the `drawing/` directory
 * **is** the record.
 *
 * The plugin owns no long-lived resource beyond the tool registrations, so
 * `apply` registers the tools inside an effect and returns.
 *
 * @module dsh-drawing
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { registerTools } from './tools/index.js'
import { registerViewer, type WebServerLike } from './viewer-route.js'

/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'drawing'

/** The plugin registers tools, and its viewer page needs the web server. */
export const inject = ['tools', 'webServer']

export { Config }

/** Register the drawing tools. */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)

  const disposers = registerTools((definition) => ctx.tools.register(definition), { settings, log })
  ctx.effect(
    () => () => {
      for (const dispose of disposers) dispose()
    },
    'drawing: tools',
  )

  // The panel's viewer page (pdf.js + a few static assets) is served from the
  // package. Optional: a host without a web server can still use the tools.
  const webServer = ctx.get('webServer')
  if (webServer === undefined || webServer === null) {
    log.warn?.('webServer is unavailable; the in-panel PDF viewer will not load')
    return
  }
  try {
    ctx.effect(() => registerViewer(webServer as WebServerLike), 'drawing: viewer route')
  } catch (error) {
    log.warn?.(`registering the viewer route failed: ${String(error)}`)
  }
}
