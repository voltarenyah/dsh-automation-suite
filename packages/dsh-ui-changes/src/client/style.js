/**
 * The tab's stylesheet, inlined into the client bundle and injected once as a
 * `<style data-plugin …>` node.
 *
 * Colours come from the host's `--dsw-*` semantic tokens, so light and dark
 * follow the app without a palette of our own. Only the three git states carry
 * a hue (added = green, removed = red, changed = amber); everything else stays
 * on the neutral label/border tokens.
 *
 * The panel is one scroll container with a sticky header, like the sibling
 * Versions tab: the seat above us is `overflow: hidden` with a fixed height, so
 * a flex-child scroller would be silently clipped at small window heights.
 *
 * @module dsh-ui-changes/client/style
 */

/** Identifier of the injected stylesheet, unique across the page. */
export const TAG_ID = 'dsh-ui-changes/changes.css'

/** Stylesheet text. Class names are prefixed to stay out of the app's way. */
export const CSS = `
.chg-root {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1f2328);
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l1, #e5e5e5) transparent;
  overscroll-behavior: contain;
}
.chg-root::-webkit-scrollbar { width: 10px; height: 10px; }
.chg-root::-webkit-scrollbar-track { background: transparent; }
.chg-root::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, #e5e5e5);
  border-radius: 5px;
}

/* Header stays reachable while the list scrolls. */
.chg-head {
  position: sticky;
  top: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--dsw-alias-button-floating-fill, #fff) 90%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
}
.chg-title {
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chg-icon {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #57606a);
  font: inherit;
  cursor: pointer;
}
.chg-icon:hover {
  background: var(--dsw-alias-bg-l1, rgba(128, 128, 128, 0.08));
  color: var(--dsw-alias-label-primary, #1f2328);
}

.chg-summary {
  padding: 6px 10px;
  color: var(--dsw-alias-label-secondary, #57606a);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chg-list { padding: 4px 0 14px; }
.chg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
}
.chg-row:hover { background: var(--dsw-alias-bg-l1, rgba(128, 128, 128, 0.07)); }
.chg-badge {
  flex: 0 0 auto;
  width: 16px;
  text-align: center;
  font-family: var(--dsw-alias-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  font-weight: 600;
  border-radius: 4px;
}
.chg-badge.mod { color: var(--dsw-alias-state-warning-primary, #bf8700); }
.chg-badge.add { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.chg-badge.del { color: var(--dsw-alias-state-error-primary, #cf222e); }
.chg-badge.new { color: var(--dsw-alias-label-tertiary, #6b7280); }
.chg-badge.ren { color: var(--dsw-alias-state-business-primary, #4176e6); }
.chg-badge.conflict { color: var(--dsw-alias-state-error-primary, #cf222e); }

.chg-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;             /* long paths keep their tail visible */
  text-align: left;
  font-family: var(--dsw-alias-font-family-code, ui-monospace, monospace);
}
.chg-adds, .chg-dels {
  flex: 0 0 auto;
  font-family: var(--dsw-alias-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.chg-adds { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.chg-dels { color: var(--dsw-alias-state-error-primary, #cf222e); }

.chg-empty, .chg-hint, .chg-error {
  padding: 12px 10px;
  color: var(--dsw-alias-label-secondary, #57606a);
}
.chg-error { color: var(--dsw-alias-state-error-primary, #cf222e); }
`

/**
 * Inject the stylesheet once, tagged so the module system can reclaim it.
 *
 * @param {string} tagId - the `data-plugin` value.
 */
export function ensureStyle(tagId) {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin="${tagId}"]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin', tagId)
  style.textContent = CSS
  document.head.appendChild(style)
}
