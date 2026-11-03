/**
 * Stylesheet for the Drawing tab.
 *
 * Injected once per document; every class is namespaced by the plugin id so it
 * cannot collide with the host's own rules. Colours come from the shell's CSS
 * variables where they exist, with neutral fallbacks, so the panel follows the
 * active theme instead of hard-coding one.
 *
 * @module dsh-drawing/client/style
 */

const STYLE_ID = 'dsh-drawing-style'

const CSS = `
.dsh-drawing {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--dsh-text-primary, #1f2328);
}
.dsh-drawing__title {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.dsh-drawing__muted { color: var(--dsh-text-secondary, #656d76); }
.dsh-drawing__docs { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-drawing__doc {
  border: 1px solid var(--dsh-border, #d0d7de);
  background: transparent;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  cursor: pointer;
  color: inherit;
}
.dsh-drawing__doc--active {
  border-color: var(--dsh-accent, #0969da);
  color: var(--dsh-accent, #0969da);
  font-weight: 600;
}
.dsh-drawing__caveat {
  border-left: 3px solid var(--dsh-warning, #d4a72c);
  background: color-mix(in srgb, var(--dsh-warning, #d4a72c) 8%, transparent);
  padding: 6px 8px;
  border-radius: 4px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.dsh-drawing__toolbar { display: flex; gap: 6px; align-items: center; }
.dsh-drawing__input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--dsh-border, #d0d7de);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--dsh-surface, transparent);
  color: inherit;
}
.dsh-drawing__list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--dsh-border, #d0d7de);
  border-radius: 6px;
}
.dsh-drawing__row {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--dsh-border-weak, rgba(128,128,128,.18));
  cursor: pointer;
  align-items: baseline;
}
.dsh-drawing__row:hover { background: rgba(128,128,128,.08); }
.dsh-drawing__row--active { background: color-mix(in srgb, var(--dsh-accent, #0969da) 12%, transparent); }
.dsh-drawing__no { font-variant-numeric: tabular-nums; font-weight: 600; }
.dsh-drawing__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-drawing__foot { font-size: 11px; line-height: 1.5; }
.dsh-drawing__stage {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
}
.dsh-drawing__list { max-height: 34%; }
.dsh-drawing__viewer {
  flex: 1;
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--dsh-border, #d0d7de);
  border-radius: 6px;
  overflow: auto;
  background: rgba(128, 128, 128, 0.04);
}
.dsh-drawing__paper { position: relative; line-height: 0; }
.dsh-drawing__page { max-width: 100%; height: auto; display: block; }
.dsh-drawing__hit {
  position: absolute;
  border: 2px solid var(--dsh-accent, #0969da);
  background: color-mix(in srgb, var(--dsh-accent, #0969da) 22%, transparent);
  border-radius: 2px;
  pointer-events: none;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.6) inset;
}
.dsh-drawing__frame { width: 100%; height: 100%; min-height: 320px; border: 0; }
`

/** Inject the stylesheet once. */
export function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = CSS
  document.head.appendChild(element)
}

