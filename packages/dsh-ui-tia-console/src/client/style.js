/**
 * The bar's stylesheet, inlined into the client bundle and injected once as a
 * `<style data-plugin …>` node. Only `--dsw-*` semantic tokens are used (with
 * fallbacks), so it follows the app's light/dark themes.
 *
 * @module dsh-ui-tia-console/style
 */

/** Identifier of the injected stylesheet, unique across the page. */
export const TAG_ID = 'dsh-ui-tia-console/console.css'

/** Stylesheet text. All class names are prefixed to stay out of the app's way. */
export const CSS = `
.tiac-root {
  display: flex;
  flex-direction: column;
  margin: 0 2px 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.06));
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 12px;
  line-height: 18px;
}
.tiac-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 8px 0 10px;
}
.tiac-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-label-caption, #9ca3af);
}
.tiac-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary, #1a7f37); }
.tiac-dot[data-state="warn"] { background: var(--dsw-alias-label-warning, #b7791f); }
.tiac-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary, #c0392b); }
.tiac-dot[data-state="run"] { background: var(--dsw-alias-state-business-primary, #3b82f6); animation: tiac-pulse 1.4s ease-in-out infinite; }
@keyframes tiac-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.tiac-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tiac-text b { font-weight: 600; }
.tiac-elapsed {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.tiac-badge {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-fill-l2, rgba(128, 128, 128, 0.16));
  color: var(--dsw-alias-label-secondary, #4b5563);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.tiac-badge[data-error="true"] { color: var(--dsw-alias-label-warning, #b7791f); }
.tiac-actions { flex: none; display: flex; align-items: center; gap: 2px; }
.tiac-btn {
  border: 0;
  background: none;
  padding: 2px 6px;
  border-radius: var(--dsw-radius-sm, 4px);
  color: var(--dsw-alias-label-secondary, #4b5563);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.tiac-btn:hover:enabled, .tiac-btn:focus-visible {
  background: var(--dsw-alias-fill-l2, rgba(128, 128, 128, 0.2));
  color: var(--dsw-alias-label-primary, #1f2328);
}
.tiac-btn:disabled { opacity: 0.4; cursor: default; }
.tiac-chevron {
  flex: none;
  border: 0;
  background: none;
  padding: 2px 4px;
  color: var(--dsw-alias-label-caption, #9ca3af);
  font: inherit;
  cursor: pointer;
}
.tiac-body {
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.2));
  padding: 6px 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow: auto;
}
.tiac-kv { display: flex; gap: 6px; min-width: 0; }
.tiac-kv > span:first-child { flex: none; color: var(--dsw-alias-label-tertiary, #6b7280); }
.tiac-kv > code, .tiac-kv > b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
.tiac-error { color: var(--dsw-alias-state-error-primary, #c0392b); white-space: pre-wrap; }
.tiac-result { white-space: pre-wrap; color: var(--dsw-alias-label-secondary, #4b5563); }
.tiac-note { color: var(--dsw-alias-label-tertiary, #6b7280); white-space: normal; }
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
