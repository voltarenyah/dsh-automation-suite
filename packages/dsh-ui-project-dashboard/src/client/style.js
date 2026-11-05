/**
 * The P0 page's stylesheet, inlined into the client bundle and injected once as
 * a `<style data-plugin …>` node.
 *
 * Colours are the host's `--dsw-*` semantic tokens (with neutral fallbacks), so
 * light/dark and font settings follow the app. Class names are prefixed `pd-`
 * to stay out of the shell's way.
 *
 * @module dsh-ui-project-dashboard/client/style
 */

/** Identifier of the injected stylesheet, unique across the page. */
export const TAG_ID = 'dsh-ui-project-dashboard/page.css'

export const CSS = `
.pd-root {
  --pd-line: var(--dsw-alias-border-l2, rgb(128 128 128 / 24%));
  --pd-line-soft: var(--dsw-alias-border-l1, rgb(128 128 128 / 14%));
  --pd-ink: var(--dsw-alias-label-primary, #1f2328);
  --pd-ink-2: var(--dsw-alias-label-secondary, #4b5563);
  --pd-ink-3: var(--dsw-alias-label-tertiary, #6b7280);
  --pd-accent: var(--dsw-alias-state-business-primary, #4176e6);
  --pd-accent-soft: color-mix(in srgb, var(--pd-accent) 12%, transparent);
  --pd-mono: "SF Mono", "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace;
  height: 100%;
  overflow-y: auto;
  color: var(--pd-ink);
  background: var(--dsw-alias-bg-base, transparent);
}

.pd-sheet {
  max-width: 760px;
  margin: 0 auto;
  padding: 54px 40px 72px;
}

.pd-eyebrow {
  font-family: var(--pd-mono);
  font-size: 10px;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
  margin-bottom: 14px;
}

.pd-title {
  margin: 0 0 10px;
  font-size: 30px;
  line-height: 1.15;
  font-weight: 300;
  letter-spacing: -0.015em;
}

.pd-lead {
  margin: 0 0 28px;
  max-width: 58ch;
  color: var(--pd-ink-2);
  font-size: 13.5px;
  line-height: 1.7;
}

.pd-h {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 10px;
  font-family: var(--pd-mono);
  font-size: 9.5px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
}
.pd-h::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--pd-line-soft);
}

.pd-facts {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 0;
  margin: 0 0 30px;
  border: 1px solid var(--pd-line);
  border-radius: 10px;
  overflow: hidden;
}
.pd-facts dt,
.pd-facts dd {
  margin: 0;
  padding: 9px 14px;
  border-bottom: 1px solid var(--pd-line-soft);
  font-size: 12.5px;
  line-height: 1.5;
}
.pd-facts dt {
  font-family: var(--pd-mono);
  font-size: 10px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
  background: color-mix(in srgb, var(--pd-ink) 3%, transparent);
  display: flex;
  align-items: center;
}
.pd-facts dd { color: var(--pd-ink); }
.pd-facts dt:nth-last-of-type(1),
.pd-facts dd:nth-last-of-type(1) { border-bottom: 0; }
.pd-facts code {
  font-family: var(--pd-mono);
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--pd-accent-soft);
  color: var(--pd-accent);
}

.pd-next {
  margin: 0;
  padding: 0;
  list-style: none;
  border-left: 2px solid var(--pd-line);
}
.pd-next li {
  position: relative;
  padding: 7px 0 7px 16px;
  font-size: 12.5px;
  color: var(--pd-ink-2);
}
.pd-next li::before {
  content: "";
  position: absolute;
  left: -4px;
  top: 14px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pd-accent);
}
.pd-next li b {
  font-family: var(--pd-mono);
  font-size: 10px;
  letter-spacing: .08em;
  color: var(--pd-ink-3);
  margin-right: 8px;
  font-weight: 500;
}

.pd-note {
  margin: 34px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--pd-line-soft);
  font-size: 11px;
  color: var(--pd-ink-3);
  line-height: 1.7;
}

@media (max-width: 640px) {
  .pd-sheet { padding: 34px 18px 56px; }
  .pd-facts { grid-template-columns: 96px minmax(0, 1fr); }
  .pd-facts dt { font-size: 9px; }
}
`

/**
 * Inject the stylesheet once per document.
 *
 * @param {string} id - the plugin id, recorded on the node for debugging.
 */
export function ensureStyle(id) {
  if (typeof document === 'undefined') return
  const key = `${TAG_ID}#${id}`
  if (document.querySelector(`style[data-plugin="${key}"]`) !== null) return
  const node = document.createElement('style')
  node.setAttribute('data-plugin', key)
  node.textContent = CSS
  document.head.appendChild(node)
}
