// Generates src/client/style.js from the approved mockup's stylesheet.
//
// The mockup paints its own light/dark palette because it runs standalone. In the
// plugin the host owns the theme, so the palette block is replaced by a token
// mapping onto the host's `--dsw-*` semantic tokens and the class prefix is
// renamed so the plugin cannot collide with the app or other plugins.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const template = readFileSync(join(root, 'mockup', 'page.tpl.html'), 'utf8')

const style = template.slice(template.indexOf('<style>') + 7, template.indexOf('</style>'))

// 1) drop the two standalone palette blocks
let css = style.replace(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}\n:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/, '@@TOKENS@@')
if (!css.includes('@@TOKENS@@')) throw new Error('palette block not found in the mockup stylesheet')

// 2) the plugin's tokens come from the host
const tokens = `.hwv-root {
  /* Colours are the host's semantic tokens, so light and dark follow the app. */
  --bg: transparent;
  --surface: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.08));
  --surface-2: color-mix(in srgb, var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.08)) 60%, transparent);
  --surface-3: color-mix(in srgb, var(--dsw-alias-fill-l2, rgba(128, 128, 128, 0.14)) 70%, transparent);
  /* A popup floats over content, so it needs an opaque fill. The host paints
     floating surfaces with this token; mapping a translucency here made the
     station picker unreadable. */
  --popup: var(--dsw-alias-button-floating-fill, #ffffff);
  --rule: var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.22));
  --rule-strong: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.34));
  --ink: var(--dsw-alias-label-primary, #1f2328);
  --ink-2: var(--dsw-alias-label-secondary, #4b5563);
  --ink-3: var(--dsw-alias-label-tertiary, #6b7280);
  --accent: var(--dsw-alias-state-business-primary, #4176e6);
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
  --ok: var(--dsw-alias-state-success-primary, #2f8f63);
  --warn: var(--dsw-alias-state-warn-primary, #a8751c);
  --grain: transparent;
}`
css = css.replace('@@TOKENS@@', tokens)

// 3) scope every class to .hwv-
css = css.replace(/\bhw-/g, 'hwv-')

// 4) the mockup set html/body; a panel owns only its own box
css = css.replace(/\* \{ box-sizing: border-box; \}\nhtml, body \{ height: 100%; margin: 0; \}\nbody \{[\s\S]*?\n\}\n/, '')

const out = `/**
 * The tab's stylesheet, inlined into the client bundle and injected once as a
 * \`<style data-plugin …>\` node.
 *
 * Generated from \`mockup/page.tpl.html\` by \`scripts/style-from-mockup.mjs\`: the
 * approved design is the single source of truth for the panel's look, and this file
 * only renames the class prefix to \`hwv-\` and swaps the standalone palette for the
 * host's \`--dsw-*\` semantic tokens. Edit the mockup, then re-run the script.
 *
 * @module dsh-ui-hardware/client/style
 */

/** Identifier of the injected stylesheet, unique across the page. */
export const TAG_ID = 'dsh-ui-hardware/hardware.css'

/** Stylesheet text. Class names are prefixed to stay out of the app's way. */
export const CSS = \`
${css.trimEnd()}
\`

/**
 * Inject the stylesheet once per document.
 *
 * @param {string} id - the plugin id, recorded on the node for debugging.
 */
export function ensureStyle(id) {
  const key = \`\${TAG_ID}#\${id}\`
  if (typeof document === 'undefined') return
  if (document.querySelector(\`style[data-plugin="\${key}"]\`) !== null) return
  const node = document.createElement('style')
  node.setAttribute('data-plugin', key)
  node.textContent = CSS
  document.head.appendChild(node)
}
`

writeFileSync(join(root, 'src', 'client', 'style.js'), out, 'utf8')
console.log(`wrote src/client/style.js (${(out.length / 1024).toFixed(1)} KB)`)
