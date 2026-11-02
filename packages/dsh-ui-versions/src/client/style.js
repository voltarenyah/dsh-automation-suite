/**
 * The tab's stylesheet, inlined into the client bundle and injected once as a
 * `<style data-plugin …>` node.
 *
 * Colours come from the host's `--dsw-*` semantic tokens, so light and dark
 * follow the app without a palette of our own. Three hues carry the *faces*
 * (blue = Code, violet = Interface, teal = Comments; Properties stays neutral)
 * — the violet and teal are `color-mix` of host tokens rather than new literals,
 * so they keep following the theme. Everything else stays neutral, and the
 * change kind keeps its small semantic dot.
 *
 * The panel is one scroll container: the seat above it is `overflow: hidden`
 * with a fixed height, and a flex-child scroller silently clipped in the real
 * app at narrow window heights.
 *
 * @module dsh-ui-versions/client/style
 */

/** Identifier of the injected stylesheet, unique across the page. */
export const TAG_ID = 'dsh-ui-versions/versions.css'

/** Stylesheet text. Class names are prefixed to stay out of the app's way. */
export const CSS = `
.vsn-root {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1f2328);
  /* The layout follows the *pane*, not the window: a 1600px window can still
     hold a 380px sidebar, and a viewport media query would cram two columns
     into it (observed in the real app). */
  container-type: inline-size;
  container-name: vsn;
  /* A visible scrollbar: Chromium's overlay scrollbars hid the only way to
     reach content below the fold. */
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l1, #e5e5e5) transparent;
  overscroll-behavior: contain;
}
.vsn-root::-webkit-scrollbar { width: 10px; height: 10px; }
.vsn-root::-webkit-scrollbar-track { background: transparent; }
.vsn-root::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, #e5e5e5);
  border-radius: 5px;
}
.vsn-root::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1, #d4d4d4); }

/* Header and toolbar stay reachable while the panel scrolls: they are one
   sticky block, so no offset maths and no jump when the toolbar wraps. */
.vsn-sticky {
  position: sticky;
  top: 0;
  z-index: 6;
  background: color-mix(in srgb, var(--dsw-alias-button-floating-fill, #fff) 88%, transparent);
  backdrop-filter: blur(8px);
}
.vsn-head {
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
  display: flex;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  flex-wrap: wrap;
  align-items: center;
}
.vsn-toolbar input {
  flex: 1 1 140px;
  min-width: 0;
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
.vsn-toolbar input::placeholder { color: var(--dsw-alias-label-tertiary, #6b7280); }
.vsn-toolbar input:focus { border-color: var(--dsw-alias-label-secondary, #4b5563); }

/* A select-shaped dropdown of our own: the native popup is painted by the OS
   and came out as light text on a light list in the app's dark theme. */
.vsn-select { position: relative; }
.vsn-select-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 4px 8px;
  font: inherit;
  font-size: 11.5px;
  color: var(--dsw-alias-label-primary, #1f2328);
  background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  border-radius: var(--dsw-radius-sm, 4px);
  cursor: pointer;
  white-space: nowrap;
}
.vsn-select-button:hover { border-color: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.34)); }
.vsn-select-button .caret { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 9px; }
.vsn-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  right: 0;
  min-width: 100%;
  margin: 0;
  padding: 4px;
  list-style: none;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.34));
  background: var(--dsw-alias-button-floating-fill, #fff);
  box-shadow: 0 8px 24px var(--dsw-alias-label-shimmer, rgba(0, 0, 0, 0.18));
}
.vsn-menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
}
.vsn-menu button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.vsn-menu button.selected {
  color: var(--dsw-alias-state-business-primary, #4176e6);
  background: var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.1));
}

.vsn-body {
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
  min-width: 0;
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

/* The draggable split between the two panels (wide layout only). */
.vsn-divider { display: none; }

.vsn-vrow { border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24)); }
.vsn-vrow:last-child { border-bottom: 0; }
.vsn-vline {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr) auto;
  grid-template-areas:
    "sha subj date"
    ".   cs   badge";
  column-gap: 8px;
  row-gap: 1px;
  align-items: baseline;
  padding: 8px 9px;
  cursor: pointer;
}
.vsn-vline:hover { background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12)); }
.vsn-vrow.open .vsn-vline { background: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.12)); }
.vsn-sha {
  grid-area: sha;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  color: var(--dsw-alias-state-business-primary, #4176e6);
  white-space: nowrap;
}
.vsn-subj {
  grid-area: subj;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
/* The timestamp belongs to the row, not to the metadata cluster: it sits in the
   top-right corner so the eye can scan the timeline down the right edge. */
.vsn-vline > .vsn-date {
  grid-area: date;
  justify-self: end;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* Only the checksum this commit produced; the previous one lives in the
   expanded detail, where there is room to label it. */
.vsn-cs {
  grid-area: cs;
  min-width: 0;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary, #4b5563);
  overflow-wrap: anywhere;
}
.vsn-vline > .vsn-badge { grid-area: badge; justify-self: end; }

.vsn-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 6px 0 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
  margin-bottom: 2px;
}
.vsn-fact { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; }
.vsn-fact .label { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 10px; white-space: nowrap; }
.vsn-fact .val {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary, #4b5563);
  overflow-wrap: anywhere;
}

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
.vsn-badge.change-added::before { background: var(--dsw-alias-state-success-primary, #22c55e); }
.vsn-badge.change-modified::before { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.vsn-badge.change-removed::before { background: var(--dsw-alias-state-error-primary, #ec1313); }
.vsn-badge.plain::before { display: none; }

.vsn-delta {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 10px;
  white-space: nowrap;
}
.vsn-delta .plus { color: var(--dsw-alias-file-diff-added-marker, #01a241); }
.vsn-delta .minus { color: var(--dsw-alias-file-diff-deleted-marker, #ba2723); margin-left: 6px; }

/* Faces: three hues, derived from host tokens so both themes stay correct. */
.vsn-pills { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 0; }
.vsn-pill {
  --vsn-pill: var(--dsw-alias-label-tertiary, #6b7280);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 10px;
  line-height: 17px;
  color: var(--vsn-pill);
  border: 1px solid color-mix(in srgb, var(--vsn-pill) 34%, transparent);
  background: color-mix(in srgb, var(--vsn-pill) 10%, transparent);
  cursor: help;
  white-space: nowrap;
}
.vsn-pill::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--vsn-pill);
}
.vsn-pill:hover { background: color-mix(in srgb, var(--vsn-pill) 20%, transparent); }
.vsn-pill.face-code { --vsn-pill: var(--dsw-alias-state-business-primary, #4176e6); }
.vsn-pill.face-interface {
  --vsn-pill: color-mix(
    in srgb,
    var(--dsw-alias-state-business-primary, #4176e6) 55%,
    var(--dsw-alias-state-error-secondary, #f25a5a)
  );
}
.vsn-pill.face-comments {
  --vsn-pill: color-mix(
    in srgb,
    var(--dsw-alias-state-business-primary, #4176e6) 45%,
    var(--dsw-alias-state-success-primary, #22c55e)
  );
}
.vsn-pill.face-properties { --vsn-pill: var(--dsw-alias-label-secondary, #4b5563); }

.vsn-tag {
  display: inline-block;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24));
}
.vsn-tag.problem {
  color: var(--dsw-alias-state-warn-label, #b7791f);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 40%, transparent);
  background: var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.1));
}

.vsn-events { display: none; padding: 2px 9px 8px 18px; }
.vsn-vrow.open .vsn-events { display: block; }
.vsn-event { padding: 6px 0; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24)); }
.vsn-event:first-child { border-top: 0; }
.vsn-event-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
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
.vsn-blk:hover { color: var(--dsw-alias-state-business-primary, #4176e6); text-decoration: underline; }
.vsn-reason { color: var(--dsw-alias-label-secondary, #4b5563); font-size: 11px; margin-top: 4px; line-height: 1.45; }
.vsn-reason .label { color: var(--dsw-alias-label-tertiary, #6b7280); margin-right: 5px; }

.vsn-detail .vsn-tl { padding: 8px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.24)); }
.vsn-detail .vsn-tl:last-child { border-bottom: 0; }
.vsn-tl-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; }
.vsn-tl-head .seq { color: var(--dsw-alias-label-tertiary, #6b7280); font-family: ui-monospace, Consolas, monospace; font-size: 10px; }
.vsn-tl-head .date { margin-left: auto; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 10px; white-space: nowrap; }
.vsn-tl-subj { color: var(--dsw-alias-label-secondary, #4b5563); font-size: 11px; line-height: 1.45; margin-bottom: 3px; }

.vsn-empty { padding: 22px 12px; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; text-align: center; }
.vsn-error { padding: 22px 12px; color: var(--dsw-alias-state-error-primary, #c0392b); font-size: 11px; text-align: center; }
.vsn-hint { padding: 16px 12px; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; text-align: center; }

@container vsn (max-width: 560px) {
  .vsn-vline {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "sha  date"
      "subj subj"
      "cs   badge";
    row-gap: 2px;
  }
}
@container vsn (min-width: 760px) {
  .vsn-body {
    grid-template-columns: minmax(0, calc(var(--vsn-split, 62%) - 4px)) 8px minmax(0, 1fr);
    align-items: start;
  }
  .vsn-divider {
    display: block;
    align-self: stretch;
    min-height: 160px;
    cursor: col-resize;
    position: relative;
    touch-action: none;
  }
  .vsn-divider::after {
    content: '';
    position: absolute;
    inset: 0 50%;
    width: 1px;
    background: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.34));
  }
  /* A grip, so the split reads as adjustable instead of decorative. */
  .vsn-divider::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 8px;
    height: 30px;
    border-radius: 4px;
    background-image: radial-gradient(circle, var(--dsw-alias-label-tertiary, #6b7280) 1px, transparent 1.2px);
    background-size: 8px 7px;
    opacity: 0.5;
  }
  .vsn-divider:hover::after,
  .vsn-divider:focus-visible::after { width: 2px; background: var(--dsw-alias-state-business-primary, #4176e6); }
  .vsn-divider:hover::before { opacity: 1; }
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
