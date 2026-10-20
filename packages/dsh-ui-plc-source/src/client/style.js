/**
 * The tab's stylesheet, inlined into the client bundle and injected once as a
 * `<style data-plugin …>` node. Tagging it is not decorative: the module system
 * reclaims plugin styles by `data-plugin` when the entry is invalidated, so an
 * untagged node would be claimed by whichever plugin materialises next.
 *
 * Only `--dsw-*` semantic tokens are used (with fallbacks), so the list follows
 * the app's light/dark themes without a second palette of its own.
 *
 * @module dsh-ui-plc-source/style
 */

/** Identifier of the injected stylesheet, unique across the page. */
export const TAG_ID = 'dsh-ui-plc-source/plc-blocks.css'

/** Stylesheet text. Class names are prefixed to stay out of the app's way. */
export const CSS = `
.plps-root {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.plps-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 6px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.2));
  flex-wrap: wrap;
}
.plps-title { flex: none; font-weight: 600; }
.plps-count { flex: none; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; }
.plps-filters {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}
/*
 * The native option popup is painted by Chromium on its own surface, so a
 * translucent fill token turns into a light card even in the dark theme while
 * the text keeps inheriting the theme's light colour -- light on light. The
 * popup therefore needs opaque colours of its own: the system colours follow
 * color-scheme, and the dark theme is pinned explicitly so the control and its
 * popup agree with the app's palette.
 */
.plps-select {
  flex: 1 1 0;
  min-width: 0;
  font: inherit;
  color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  border-radius: var(--dsw-radius-sm, 4px);
  padding: 1px 4px;
}
.plps-select option,
.plps-select optgroup {
  color: CanvasText;
  background-color: Canvas;
}
body[data-ds-dark-theme] .plps-select {
  color-scheme: dark;
}
.plps-search {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  border-radius: var(--dsw-radius-sm, 4px);
  padding: 1px 6px;
}
.plps-search::placeholder {
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.plps-clear {
  margin-left: 0;
}
.plps-btn {
  margin-left: auto;
  flex: none;
  border: 0;
  background: none;
  padding: 2px 6px;
  border-radius: var(--dsw-radius-sm, 4px);
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font: inherit;
  cursor: pointer;
}
.plps-btn:hover, .plps-btn:focus-visible {
  background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-secondary, #4b5563);
}
.plps-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0 12px; }
.plps-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 22px;
  padding: 0 10px 0 12px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.plps-row:hover { background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12)); }
/*
 * Selection is a view state the tab keeps (the actions that will consume it come
 * later), so it has to be visible without looking like a hover.
 */
.plps-selected,
.plps-selected:hover {
  background: var(--dsw-alias-fill-l2, rgba(128, 128, 128, 0.2));
}
/*
 * A refused object has no file: the row still reads as evidence (which objects
 * are missing and why), marked with the warning-tinted badge.
 */
.plps-refused {
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.plps-refused .plps-badge {
  color: var(--dsw-alias-label-warning, #b7791f);
}
/*
 * The context menu, using the app's own menu recipe: the shared menu surface
 * token (which is a translucent layer) plus the menu backdrop filter, so it
 * reads like every other menu in the product. A real element composites with its
 * backdrop; only the native option popup could not, which is why the selects
 * needed opaque colours of their own.
 */
.plps-menu {
  position: fixed;
  z-index: 100;
  min-width: 168px;
  padding: 3px;
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-specific-menu, Canvas);
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(12px));
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.24));
}
.plps-menu-item {
  display: block;
  width: 100%;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 4px);
  background: none;
  color: var(--dsw-alias-label-primary, CanvasText);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.plps-menu-item:hover:enabled,
.plps-menu-item:focus-visible {
  background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12));
}
.plps-menu-item:disabled {
  color: var(--dsw-alias-label-tertiary, #6b7280);
  cursor: default;
}
.plps-menu-note {
  padding: 0 8px 4px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 11px;
}
/* Inline chip for a cited block in the transcript. Same shape as the product's
   own reference chips, but a quieter fill: it carries no navigation. */
.plps-mention {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  max-width: 100%;
  padding: 0 4px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-fill-l2, rgba(128, 128, 128, 0.18));
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: baseline;
}
.plps-mention::before {
  content: '@';
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.plps-badge {
  flex: none;
  min-width: 34px;
  padding: 0 4px;
  border-radius: var(--dsw-radius-sm, 4px);
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  background: var(--dsw-alias-fill-l2, rgba(128, 128, 128, 0.18));
  color: var(--dsw-alias-label-secondary, #4b5563);
}
.plps-badge.plps-obj { color: var(--dsw-alias-label-tertiary, #6b7280); }
.plps-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.plps-meta {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 11px;
}
.plps-warn { flex: none; color: var(--dsw-alias-label-warning, #b7791f); font-size: 11px; }
.plps-device {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 11px;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.plps-hint { padding: 4px 12px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.plps-note {
  margin: 6px 12px 0;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-secondary, #4b5563);
  white-space: normal;
}
.plps-error { padding: 4px 12px; white-space: normal; color: var(--dsw-alias-label-error, #c0392b); }
`

/**
 * Inject the stylesheet once per page.
 *
 * @param pluginId - the owning package name, written to `data-plugin`.
 */
export function ensureStyle(pluginId) {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = pluginId
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
