/**
 * The tab's stylesheet, inlined into the client bundle and injected once as a
 * `<style data-plugin …>` node.
 *
 * Only `--dsw-*` semantic tokens are used (with fallbacks), so the list follows
 * the app's light/dark themes without a second palette of its own. Colour is
 * deliberately scarce: one primary label colour, one muted pair, and two
 * semantic tokens (warning for `modified`, error for `removed`).
 *
 * @module dsh-ui-versions/client/style
 */

/** Identifier of the injected stylesheet, unique across the page. */
export const TAG_ID = 'dsh-ui-versions/versions.css'

/** Stylesheet text. Class names are prefixed to stay out of the app's way. */
export const CSS = `
.vsn-root {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1f2328);
  /* The layout follows the *pane*, not the window: a 1600px window can still
     hold a 380px sidebar, and a viewport media query would cram two columns
     into it (observed in the real app). Container queries keep the approved
     wide/narrow rules tied to the space the tab actually gets. */
  container-type: inline-size;
  container-name: vsn;
}
.vsn-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
}
.vsn-title { font-weight: 600; }
.vsn-device { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; }
.vsn-spacer { flex: 1; }
.vsn-icon {
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  border-radius: var(--dsw-radius-sm, 4px);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 3px 7px;
  cursor: pointer;
}
.vsn-icon:hover { color: var(--dsw-alias-label-primary, #1f2328); }
.vsn-icon:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary, #1f2328);
  outline-offset: 1px;
}

.vsn-toolbar {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  flex-wrap: wrap;
}
.vsn-toolbar input,
.vsn-toolbar select {
  background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  color: var(--dsw-alias-label-primary, #1f2328);
  border-radius: var(--dsw-radius-sm, 4px);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 7px;
  min-height: 26px;
  outline: none;
}
.vsn-toolbar input { flex: 1; min-width: 120px; }
.vsn-toolbar input::placeholder { color: var(--dsw-alias-label-tertiary, #6b7280); }
.vsn-toolbar input:focus,
.vsn-toolbar select:focus { border-color: var(--dsw-alias-label-secondary, #4b5563); }

.vsn-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px 16px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  align-content: start;
}
.vsn-panel {
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  border-radius: var(--dsw-radius-sm, 4px);
  overflow: hidden;
}
.vsn-panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 10.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.vsn-count { margin-left: auto; letter-spacing: 0; text-transform: none; }

.vsn-vrow { border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24)); }
.vsn-vrow:last-child { border-bottom: 0; }
.vsn-vline {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  padding: 8px 9px;
  cursor: pointer;
}
.vsn-vline:hover { background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12)); }
.vsn-vrow.open .vsn-vline { background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12)); }
.vsn-sha {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #4b5563);
  white-space: nowrap;
}
.vsn-subj {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.vsn-meta {
  grid-column: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 10.5px;
}
.vsn-date { font-variant-numeric: tabular-nums; white-space: nowrap; }
.vsn-cs {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  /* Two 17-digit checksums on one line are wider than a sidebar: let them wrap
     instead of pushing the row past the pane edge. */
  min-width: 0;
  overflow-wrap: anywhere;
}
.vsn-cs .now { color: var(--dsw-alias-label-secondary, #4b5563); }
.vsn-cs .arrow { margin: 0 3px; }

.vsn-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  color: var(--dsw-alias-label-secondary, #4b5563);
  white-space: nowrap;
}
.vsn-badge::before {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary, #6b7280);
}
.vsn-badge.change-modified::before { background: var(--dsw-alias-label-warning, #b7791f); }
.vsn-badge.change-removed::before { background: var(--dsw-alias-label-error, #c0392b); }
.vsn-badge.plain::before { display: none; }
.vsn-face {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 9.5px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  border-radius: 3px;
  padding: 0 4px;
  white-space: nowrap;
}
.vsn-delta {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}

.vsn-events { display: none; padding: 2px 9px 8px 18px; }
.vsn-vrow.open .vsn-events { display: block; }
.vsn-event { padding: 6px 0; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24)); }
.vsn-event:first-child { border-top: 0; }
.vsn-event-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 3px; }
.vsn-blk {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary, #4b5563);
  word-break: break-all;
  cursor: pointer;
  background: none;
  border: 0;
  padding: 0;
  text-align: left;
}
.vsn-blk:hover { color: var(--dsw-alias-label-primary, #1f2328); text-decoration: underline; }
.vsn-fp {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 6px;
  padding: 0;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.vsn-fp .val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vsn-fp .arrow { margin: 0 5px; }
.vsn-fp .b { color: var(--dsw-alias-label-secondary, #4b5563); }
.vsn-reason { color: var(--dsw-alias-label-secondary, #4b5563); font-size: 11px; margin-top: 4px; line-height: 1.45; }
.vsn-reason .label { color: var(--dsw-alias-label-tertiary, #6b7280); margin-right: 5px; }

.vsn-detail .vsn-tl { padding: 8px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24)); }
.vsn-detail .vsn-tl:last-child { border-bottom: 0; }
.vsn-tl-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; }
.vsn-tl-head .seq { color: var(--dsw-alias-label-tertiary, #6b7280); font-family: ui-monospace, Consolas, monospace; font-size: 10px; }
.vsn-tl-head .date { margin-left: auto; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 10px; white-space: nowrap; }
.vsn-tl-subj { color: var(--dsw-alias-label-secondary, #4b5563); font-size: 11px; line-height: 1.45; margin-bottom: 3px; }

.vsn-empty { padding: 22px 12px; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; text-align: center; }
.vsn-error { padding: 22px 12px; color: var(--dsw-alias-label-error, #c0392b); font-size: 11px; text-align: center; }
.vsn-hint { padding: 16px 12px; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; text-align: center; }

@container vsn (max-width: 560px) {
  .vsn-vline { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .vsn-meta { grid-column: 1; }
  .vsn-fp { grid-template-columns: 64px minmax(0, 1fr); }
}
@container vsn (min-width: 760px) {
  .vsn-body { grid-template-columns: minmax(0, 1fr) 300px; align-items: start; }
}
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
