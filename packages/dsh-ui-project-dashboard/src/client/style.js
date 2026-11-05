/**
 * The dashboard stylesheet, inlined into the client bundle and injected once as
 * a `<style data-plugin …>` node.
 *
 * Colours are the host's `--dsw-*` semantic tokens (with neutral fallbacks), so
 * light/dark and font settings follow the app. Class names are prefixed `pd-`
 * to stay out of the shell's way. The composition is a datasheet: hairline
 * rules, monospace identifiers, one accent for selection, green/amber only for
 * session state.
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
  --pd-ink-4: color-mix(in srgb, var(--pd-ink-3) 62%, transparent);
  --pd-accent: var(--dsw-alias-state-business-primary, #4176e6);
  --pd-accent-soft: color-mix(in srgb, var(--pd-accent) 12%, transparent);
  --pd-green: var(--dsw-alias-state-success-primary, #2f8f63);
  --pd-green-soft: color-mix(in srgb, var(--pd-green) 14%, transparent);
  --pd-amber: var(--dsw-alias-state-warn-primary, #a8751c);
  --pd-amber-soft: color-mix(in srgb, var(--pd-amber) 14%, transparent);
  --pd-mono: "SF Mono", "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace;
  height: 100%;
  overflow-y: auto;
  color: var(--pd-ink);
  background: var(--dsw-alias-bg-base, transparent);
}

.pd-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 30px 40px 56px;
}

/* ------------------------------------------------------------------- header */
.pd-eyebrow {
  font-family: var(--pd-mono);
  font-size: 10px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
  margin-bottom: 14px;
}
.pd-title {
  margin: 0 0 6px;
  font-size: 30px;
  line-height: 1.15;
  font-weight: 300;
  letter-spacing: -0.015em;
}
.pd-sub {
  margin: 0 0 22px;
  padding-bottom: 22px;
  border-bottom: 1px solid var(--pd-line);
  color: var(--pd-ink-2);
  font-size: 13px;
}

/* ------------------------------------------------------------------ toolbar */
.pd-toolbar {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}
.pd-search {
  flex: 1 1 240px;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--pd-line);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--pd-ink-3);
  transition: border-color .14s ease, box-shadow .14s ease;
}
.pd-search:focus-within {
  border-color: var(--pd-accent);
  box-shadow: 0 0 0 3px var(--pd-accent-soft);
}
.pd-search-icon { font-size: 15px; line-height: 1; transform: translateY(-1px); }
.pd-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--pd-ink);
  font: 13px/1.4 inherit;
}
.pd-search input::placeholder { color: var(--pd-ink-4); }
.pd-search input::-webkit-search-cancel-button { display: none; }
.pd-search-clear {
  width: 20px; height: 20px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 50%;
  background: color-mix(in srgb, var(--pd-ink) 8%, transparent);
  color: var(--pd-ink-3);
  font-size: 13px; line-height: 1;
  cursor: pointer;
}
.pd-search-clear:hover { color: var(--pd-ink); }

.pd-tag-filter { position: relative; flex: none; }
.pd-filter-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 12px;
  border: 1px solid var(--pd-line);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--pd-ink-2);
  font-size: 12.5px;
  cursor: pointer;
}
.pd-filter-btn:hover { color: var(--pd-ink); border-color: var(--pd-line-soft); }
.pd-filter-btn[aria-expanded="true"] {
  border-color: var(--pd-accent);
  background: var(--pd-accent-soft);
  color: var(--pd-accent);
}
.pd-count {
  min-width: 16px; height: 16px; padding: 0 4px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 999px;
  background: var(--pd-accent);
  color: #fff;
  font-family: var(--pd-mono);
  font-size: 9.5px;
}

.pd-tag-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 30;
  width: 300px;
  max-width: calc(100vw - 32px);
  max-height: 380px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--pd-line);
  border-radius: 10px;
  background: var(--dsw-alias-button-floating-fill, var(--dsw-alias-bg-layer-2, #fff));
  box-shadow: 0 18px 44px -24px rgb(0 0 0 / 45%);
}
.pd-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 2px 6px 8px;
  font-family: var(--pd-mono);
  font-size: 9.5px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
}
.pd-panel-head button {
  border: 0; background: transparent;
  color: var(--pd-ink-3);
  font-size: 11px;
  cursor: pointer;
}
.pd-panel-head button:hover { color: var(--pd-ink); }
.pd-panel-empty { padding: 10px 8px; font-size: 11.5px; color: var(--pd-ink-3); }
.pd-tree-row {
  display: flex; align-items: center; gap: 7px;
  width: 100%;
  padding: 5px 8px;
  border: 0; border-radius: 6px;
  background: transparent;
  color: var(--pd-ink-2);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.pd-tree-row:hover { background: color-mix(in srgb, var(--pd-ink) 6%, transparent); color: var(--pd-ink); }
.pd-tree-row.is-on { background: var(--pd-accent-soft); color: var(--pd-accent); }
.pd-tree-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-tree-count {
  margin-left: auto;
  font-family: var(--pd-mono);
  font-size: 10px;
  color: var(--pd-ink-3);
}
.pd-tree-row.is-on .pd-tree-count { color: var(--pd-accent); }

.pd-tag-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }

.pd-active-filters { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.pd-filter-chip {
  display: inline-flex; align-items: center; gap: 5px;
  height: 24px;
  padding: 0 4px 0 8px;
  border: 1px solid color-mix(in srgb, var(--pd-accent) 40%, transparent);
  border-radius: 999px;
  background: var(--pd-accent-soft);
  color: var(--pd-accent);
  font-family: var(--pd-mono);
  font-size: 10.5px;
}
.pd-filter-chip button {
  width: 16px; height: 16px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 50%;
  background: transparent; color: inherit;
  font-size: 12px; line-height: 1;
  cursor: pointer;
}
.pd-filter-chip button:hover { background: color-mix(in srgb, var(--pd-accent) 20%, transparent); }

.pd-result {
  margin-left: auto;
  font-family: var(--pd-mono);
  font-size: 11px;
  color: var(--pd-ink-4);
  white-space: nowrap;
}

/* ------------------------------------------------------------------- banner */
.pd-banner {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--pd-amber) 40%, transparent);
  border-radius: 8px;
  background: var(--pd-amber-soft);
  color: var(--pd-amber);
  font-size: 11.5px;
}
.pd-banner.is-warn { display: block; }

/* ------------------------------------------------------------------- ledger */
.pd-ledger {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin-bottom: 26px;
  border: 1px solid var(--pd-line);
  border-radius: 12px;
  background: var(--dsw-alias-fill-l1, color-mix(in srgb, var(--pd-ink) 3%, transparent));
  overflow: hidden;
}
.pd-ledger-cell { padding: 15px 16px 14px; border-right: 1px solid var(--pd-line-soft); min-width: 0; }
.pd-ledger-cell:last-child { border-right: 0; }
.pd-ledger-label {
  display: block;
  font-family: var(--pd-mono);
  font-size: 9.5px;
  letter-spacing: .13em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
  margin-bottom: 7px;
  white-space: nowrap;
}
.pd-ledger-value {
  display: flex; align-items: baseline; gap: 5px;
  font-family: var(--pd-mono);
  font-size: 25px;
  font-weight: 500;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--pd-ink);
  white-space: nowrap;
}
.pd-unit {
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--pd-ink-3);
}
.pd-ledger-meta {
  display: block;
  margin-top: 7px;
  font-size: 11px;
  color: var(--pd-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* -------------------------------------------------------------------- board */
.pd-board { display: flex; flex-direction: column; gap: 12px; }

.pd-ws {
  border: 1px solid var(--pd-line);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  transition: border-color .16s ease;
}
.pd-ws:hover { border-color: var(--pd-line-soft); }
.pd-ws-head {
  display: flex;
  gap: 12px;
  padding: 16px 18px 15px;
  min-width: 0;
}
.pd-index {
  font-family: var(--pd-mono);
  font-size: 10px;
  color: var(--pd-ink-4);
  letter-spacing: .06em;
  padding-top: 4px;
  flex: none;
}
.pd-ws-main { min-width: 0; flex: 1; }
.pd-ws-title-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
.pd-ws-title {
  font-size: 16px;
  font-weight: 550;
  letter-spacing: -0.005em;
  color: var(--pd-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}
.pd-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.pd-dot.is-live { background: var(--pd-green); box-shadow: 0 0 0 3px var(--pd-green-soft); }
.pd-dot.is-wait { background: var(--pd-amber); box-shadow: 0 0 0 3px var(--pd-amber-soft); }
.pd-ws-facts {
  display: flex; align-items: center; gap: 7px;
  margin-top: 7px;
  font-size: 11.5px;
  color: var(--pd-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pd-clock { color: var(--pd-ink-4); font-size: 11px; }
.pd-sep { color: var(--pd-ink-4); }

.pd-ws-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 16px 9px 46px;
  border-top: 1px solid var(--pd-line-soft);
}
.pd-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-width: 0; }
.pd-tags-empty { font-size: 10.5px; color: var(--pd-ink-4); }
.pd-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  max-width: 190px;
  border: 1px solid var(--pd-line);
  border-radius: 999px;
  background: transparent;
  color: var(--pd-ink-2);
  font-family: var(--pd-mono);
  font-size: 10px;
  overflow: hidden;
  transition: border-color .12s ease, background .12s ease;
}
.pd-tag:hover { border-color: var(--pd-line-soft); background: color-mix(in srgb, var(--pd-ink) 5%, transparent); }
.pd-tag-main {
  display: inline-flex; align-items: center; gap: 5px;
  height: 100%;
  padding: 0 2px 0 6px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  min-width: 0;
}
.pd-tag-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-tag-x {
  width: 16px; height: 16px;
  margin-right: 2px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 50%;
  background: transparent;
  color: var(--pd-ink-4);
  font-size: 9px; line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity .12s ease, color .12s ease;
}
.pd-tag:hover .pd-tag-x, .pd-tag-x:focus-visible { opacity: 1; }
.pd-tag-x:hover { color: var(--pd-ink); background: var(--pd-line-soft); }
.pd-tag-x:disabled { cursor: default; }
.pd-tag-add {
  height: 20px;
  padding: 0 7px;
  border: 1px dashed var(--pd-line);
  border-radius: 999px;
  background: transparent;
  color: var(--pd-ink-4);
  font-family: var(--pd-mono);
  font-size: 10px;
  cursor: pointer;
}
.pd-tag-add:hover:not(:disabled) { color: var(--pd-ink-2); border-color: var(--pd-line-soft); }
.pd-tag-add:disabled { cursor: default; opacity: .5; }

.pd-actions { margin-left: auto; padding-left: 10px; display: flex; align-items: center; gap: 2px; }
.pd-new {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--pd-line);
  border-radius: 999px;
  background: transparent;
  color: var(--pd-ink-3);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
  transition: color .14s ease, border-color .14s ease, background .14s ease;
}
.pd-new:hover { color: var(--pd-accent); border-color: color-mix(in srgb, var(--pd-accent) 45%, transparent); background: var(--pd-accent-soft); }
.pd-new svg { flex: none; }

/* -------------------------------------------------------------------- empty */
.pd-empty {
  padding: 40px 20px;
  border: 1px dashed var(--pd-line);
  border-radius: 12px;
  text-align: center;
  color: var(--pd-ink-2);
}
.pd-empty p { margin: 0 0 6px; font-size: 14px; }
.pd-empty .pd-empty-hint { color: var(--pd-ink-3); font-size: 12px; margin-bottom: 14px; }

/* ------------------------------------------------------------------ editor */
.pd-tag-editor {
  position: fixed;
  z-index: 60;
  width: 280px;
  padding: 10px;
  border: 1px solid var(--pd-line);
  border-radius: 10px;
  background: var(--dsw-alias-button-floating-fill, var(--dsw-alias-bg-layer-2, #fff));
  box-shadow: 0 18px 44px -24px rgb(0 0 0 / 45%);
}
.pd-tag-editor input {
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--pd-line);
  border-radius: 6px;
  background: transparent;
  color: var(--pd-ink);
  font-family: var(--pd-mono);
  font-size: 12.5px;
  outline: none;
}
.pd-tag-editor input:focus { border-color: var(--pd-accent); box-shadow: 0 0 0 3px var(--pd-accent-soft); }
.pd-suggest { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; max-height: 150px; overflow: auto; }
.pd-suggest button {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 7px;
  border: 0; border-radius: 5px;
  background: transparent;
  color: var(--pd-ink-2);
  font-family: var(--pd-mono);
  font-size: 10.5px;
  text-align: left;
  cursor: pointer;
}
.pd-suggest button:hover { background: color-mix(in srgb, var(--pd-ink) 6%, transparent); color: var(--pd-ink); }
.pd-editor-hint { margin-top: 7px; font-size: 10.5px; color: var(--pd-ink-4); line-height: 1.5; }

/* ------------------------------------------------------------------- toast */
.pd-toast {
  position: fixed;
  left: 50%; bottom: 26px;
  transform: translateX(-50%);
  max-width: min(560px, calc(100vw - 48px));
  padding: 9px 14px;
  border: 1px solid var(--pd-line);
  border-radius: 8px;
  background: var(--dsw-alias-button-floating-fill, var(--dsw-alias-bg-layer-2, #fff));
  color: var(--pd-ink-2);
  font-size: 12.5px;
  box-shadow: 0 12px 32px -18px rgb(0 0 0 / 45%);
  z-index: 80;
}
.pd-toast.is-warn { border-color: color-mix(in srgb, var(--pd-amber) 45%, transparent); color: var(--pd-amber); }

/* -------------------------------------------------------------------- foot */
.pd-foot {
  margin-top: 30px;
  padding-top: 14px;
  border-top: 1px solid var(--pd-line-soft);
  color: var(--pd-ink-4);
  font-size: 11px;
  line-height: 1.7;
}

/* -------------------------------------------------------------- responsive */
@media (max-width: 1180px) {
  .pd-page { padding: 26px 26px 48px; }
  .pd-ledger { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .pd-ledger-cell:nth-child(3n) { border-right: 0; }
  .pd-ledger-cell:nth-child(-n+3) { border-bottom: 1px solid var(--pd-line-soft); }
}
@media (max-width: 900px) {
  .pd-page { padding: 22px 18px 40px; }
  .pd-ledger { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pd-ledger-cell:nth-child(2n) { border-right: 0; }
  .pd-ledger-cell:nth-child(3n) { border-right: 1px solid var(--pd-line-soft); }
  .pd-ledger-cell:nth-child(-n+4) { border-bottom: 1px solid var(--pd-line-soft); }
  .pd-ws-strip { padding-left: 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .pd-root *, .pd-root *::before, .pd-root *::after { transition: none !important; }
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
