/**
 * The dashboard stylesheet, inlined into the client bundle and injected once as
 * a `<style data-plugin …>` node.
 *
 * The page is a datasheet: hairline rules, monospace identifiers, one accent for
 * selection and state colour only for live sessions. Every colour is derived
 * from the host's `--dsw-*` semantic aliases, so the page follows the app's
 * light/dark theme; the system-colour fallbacks only cover a bare document
 * (tests, standalone fixtures) and still adapt on their own.
 *
 * Class names stay under the `pd-` prefix and the selectors under `.pd-root`
 * so nothing leaks into the shell.
 *
 * @module dsh-ui-project-dashboard/client/style
 */

/** Identifier of the injected stylesheet, unique across the page. */
export const TAG_ID = 'dsh-ui-project-dashboard/page.css'

export const CSS = `
.pd-root {
  --pd-page: var(--dsw-alias-bg-base, Canvas);
  --pd-surface: var(--dsw-alias-bg-layer-1, color-mix(in srgb, CanvasText 3%, Canvas));
  --pd-surface-2: var(--dsw-alias-bg-layer-2, color-mix(in srgb, CanvasText 7%, Canvas));
  --pd-ink: var(--dsw-alias-label-primary, CanvasText);
  --pd-ink-2: var(--dsw-alias-label-secondary, color-mix(in srgb, CanvasText 78%, Canvas));
  --pd-ink-3: color-mix(in srgb, var(--dsw-alias-label-tertiary, color-mix(in srgb, CanvasText 55%, Canvas)) 88%, var(--pd-ink));
  --pd-ink-4: color-mix(in srgb, var(--pd-ink-3) 68%, var(--pd-page));
  --pd-line: var(--dsw-alias-border-l2, color-mix(in srgb, CanvasText 18%, Canvas));
  --pd-line-soft: var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 11%, Canvas));
  --pd-accent: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 92%, var(--pd-ink));
  --pd-accent-strong: color-mix(in srgb, var(--pd-accent) 78%, var(--pd-ink));
  --pd-accent-soft: color-mix(in srgb, var(--pd-accent) 12%, var(--pd-surface));
  --pd-accent-ink: var(--pd-surface-2);
  --pd-green: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f8f63) 92%, var(--pd-ink));
  --pd-green-bright: color-mix(in srgb, var(--pd-green) 76%, #ffffff);
  --pd-green-soft: color-mix(in srgb, var(--pd-green) 12%, var(--pd-surface));
  --pd-amber: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a8751c) 92%, var(--pd-ink));
  --pd-amber-bright: color-mix(in srgb, var(--pd-amber) 76%, #ffffff);
  --pd-amber-soft: color-mix(in srgb, var(--pd-amber) 12%, var(--pd-surface));
  --pd-red: color-mix(in srgb, #b42318 55%, var(--pd-ink));
  --pd-shadow-pop: 0 20px 48px -26px rgb(0 0 0 / 45%);
  --pd-display: "Bahnschrift SemiCondensed", "Bahnschrift", "Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  --pd-body: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  --pd-mono: "Cascadia Mono", "Consolas", "SF Mono", ui-monospace, monospace;
  height: 100%;
  overflow-y: auto;
  scrollbar-width: thin;
  color: var(--pd-ink);
  background: var(--pd-page);
  font-family: var(--pd-body);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.pd-root *,
.pd-root *::before,
.pd-root *::after { box-sizing: border-box; }
.pd-root button,
.pd-root input { font: inherit; }
.pd-root button { cursor: pointer; color: inherit; }
.pd-root :focus-visible { outline: 2px solid var(--pd-accent); outline-offset: 2px; border-radius: 2px; }

.pd-page {
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  padding: 30px 40px 56px;
}

/* ------------------------------------------------------------------ header */
.pd-masthead-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}
.pd-kicker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  font-family: var(--pd-mono);
  font-size: 9.5px;
  letter-spacing: .15em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
}
.pd-kicker-mark { width: 6px; height: 6px; flex: none; background: var(--pd-accent); }
.pd-tools {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.pd-search-field { display: flex; flex-direction: column; gap: 5px; }
.pd-search-cap {
  font-family: var(--pd-mono);
  font-size: 8.5px;
  line-height: 1;
  letter-spacing: .15em;
  color: var(--pd-ink-3);
}
.pd-search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 326px;
  max-width: 100%;
  height: 38px;
  padding: 0 10px;
  border: 1px solid var(--pd-line);
  border-radius: 4px;
  background: var(--pd-surface);
  color: var(--pd-ink-3);
  transition: border-color .16s ease, background-color .16s ease, box-shadow .16s ease;
}
.pd-search:focus-within {
  border-color: var(--pd-accent);
  background: var(--pd-surface-2);
  box-shadow: 0 0 0 3px var(--pd-accent-soft);
}
.pd-search-icon { flex: none; display: inline-flex; color: var(--pd-ink-3); }
.pd-search input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--pd-ink);
  font-size: 13px;
}
.pd-search input::placeholder { color: var(--pd-ink-3); }
.pd-search input::-webkit-search-cancel-button { display: none; }
.pd-search-kbd {
  flex: none;
  min-width: 19px;
  height: 19px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--pd-line);
  border-radius: 3px;
  font-family: var(--pd-mono);
  font-size: 9.5px;
  color: var(--pd-ink-3);
  background: var(--pd-page);
  transition: opacity .12s ease;
}
.pd-search:focus-within .pd-search-kbd { opacity: 0; }
.pd-search-clear {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--pd-ink) 7%, transparent);
  color: var(--pd-ink-3);
}
.pd-search-clear:hover { color: var(--pd-ink); background: color-mix(in srgb, var(--pd-ink) 12%, transparent); }
.pd-result {
  align-self: flex-end;
  padding-bottom: 10px;
  font-family: var(--pd-mono);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--pd-ink-2);
  white-space: nowrap;
}
.pd-masthead-main { margin-top: 20px; }
.pd-title {
  margin: 0;
  font-family: var(--pd-display);
  font-size: clamp(33px, 4.1vw, 46px);
  line-height: 1.02;
  font-weight: 600;
  letter-spacing: -.015em;
  color: var(--pd-ink);
}
.pd-sub {
  margin: 10px 0 0;
  max-width: 66ch;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--pd-ink-2);
}

/* ------------------------------------------------------------ filter menu */
.pd-filter-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.pd-filter-cap {
  font-family: var(--pd-mono);
  font-size: 8.5px;
  line-height: 1;
  letter-spacing: .15em;
  color: var(--pd-ink-3);
}
.pd-filter-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--pd-line);
  border-radius: 4px;
  background: var(--pd-surface);
  color: var(--pd-ink-2);
  font-size: 12.5px;
  transition: border-color .16s ease, background-color .16s ease, color .16s ease, box-shadow .16s ease;
}
.pd-filter-btn:hover { border-color: var(--pd-accent); color: var(--pd-accent); }
.pd-filter-btn[aria-expanded="true"] {
  border-color: var(--pd-accent);
  background: var(--pd-surface-2);
  color: var(--pd-accent);
  box-shadow: 0 0 0 3px var(--pd-accent-soft);
}
.pd-filter-caret {
  display: inline-flex;
  margin-left: 2px;
  color: var(--pd-ink-3);
  transform: rotate(90deg);
  transition: transform .16s ease, color .16s ease;
}
.pd-filter-btn[aria-expanded="true"] .pd-filter-caret { transform: rotate(-90deg); color: var(--pd-accent); }
.pd-badge {
  min-width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--pd-accent);
  color: var(--pd-accent-ink);
  font-family: var(--pd-mono);
  font-size: 9.5px;
}

.pd-filter-panel {
  position: absolute;
  z-index: 60;
  top: calc(100% + 6px);
  right: 0;
  width: min(322px, calc(100vw - 36px));
  max-height: min(62vh, 430px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--pd-line);
  border-radius: 4px;
  background: var(--pd-surface-2);
  box-shadow: var(--pd-shadow-pop);
}
.pd-filter-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 8px;
  border-bottom: 1px solid var(--pd-line-soft);
  font-family: var(--pd-mono);
  font-size: 9.5px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
}
.pd-filter-clear {
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--pd-accent);
  font-family: var(--pd-body);
  font-size: 11px;
  letter-spacing: 0;
  text-transform: none;
}
.pd-filter-clear:hover { background: color-mix(in srgb, var(--pd-ink) 7%, transparent); }
.pd-filter-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
  scrollbar-width: thin;
}
.pd-filter-empty { padding: 10px 8px; font-size: 11.5px; color: var(--pd-ink-3); }
.pd-filter-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid var(--pd-line-soft);
  background: var(--pd-surface);
}
.pd-filter-foot-note {
  font-family: var(--pd-mono);
  font-size: 8.5px;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
}
.pd-filter-done {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--pd-accent);
  border-radius: 3px;
  background: var(--pd-accent);
  color: var(--pd-accent-ink);
  font-size: 11.5px;
}
.pd-filter-done:hover { background: var(--pd-accent-strong); border-color: var(--pd-accent-strong); }

.pd-filter-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 16px;
}
.pd-filter-chips-label {
  font-family: var(--pd-mono);
  font-size: 8.5px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
  margin-right: 2px;
}
.pd-chip {
  display: inline-flex;
  align-items: center;
  height: 27px;
  border: 1px solid var(--pd-line);
  border-radius: 3px;
  background: var(--pd-surface);
}
.pd-chip-mark {
  width: 6px;
  height: 6px;
  margin-left: 8px;
  flex: none;
  border-radius: 1px;
}
.pd-chip-mark.is-muted { background: var(--pd-ink-3); }
.pd-chip-label {
  max-width: 190px;
  padding: 0 8px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11.5px;
  color: var(--pd-ink);
}
.pd-chip-x {
  width: 25px;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-left: 1px solid var(--pd-line-soft);
  background: transparent;
  color: var(--pd-ink-3);
}
.pd-chip-x:hover { background: color-mix(in srgb, var(--pd-ink) 7%, transparent); color: var(--pd-ink); }
.pd-chip-clear {
  height: 27px;
  padding: 0 7px;
  border: 0;
  background: transparent;
  color: var(--pd-accent);
  font-size: 11px;
}
.pd-chip-clear:hover { text-decoration: underline; }

.pd-index-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-left: 2px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--pd-ink-2);
  font-family: var(--pd-body);
  font-size: 12.5px;
  text-align: left;
  transition: background-color .16s ease, color .16s ease, border-color .16s ease;
}
.pd-index-row:hover { background: color-mix(in srgb, var(--pd-ink) 6%, transparent); color: var(--pd-ink); }
.pd-index-row.is-on {
  border-left-color: var(--pd-accent);
  background: var(--pd-accent-soft);
  color: var(--pd-accent-strong);
}
.pd-index-all { height: 34px; margin-bottom: 4px; font-weight: 600; }
.pd-index-mark {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 1px;
  background: var(--pd-accent);
}
.pd-index-mark.is-muted { background: var(--pd-ink-3); }
.pd-index-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.pd-index-n {
  flex: none;
  font-family: var(--pd-mono);
  font-size: 10.5px;
  color: var(--pd-ink-3);
}
.pd-index-row.is-on .pd-index-n { color: var(--pd-accent-strong); }

.pd-tag-root { margin-top: 4px; }
.pd-tag-root-row { display: flex; align-items: center; gap: 1px; }
.pd-tag-root-toggle {
  flex: none;
  width: 22px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--pd-ink-3);
}
.pd-tag-root-toggle:hover { background: color-mix(in srgb, var(--pd-ink) 6%, transparent); color: var(--pd-ink); }
.pd-tag-root-toggle svg { transition: transform .16s ease; }
.pd-tag-root-toggle[aria-expanded="true"] svg { transform: rotate(90deg); }
.pd-tag-root .pd-index-row { padding-left: 4px; }
.pd-tag-children {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 1px 0 3px 26px;
}
.pd-tag-children[hidden] { display: none; }
.pd-tag-child { height: 28px; font-size: 12px; }
.pd-tag-tree { min-height: 0; }

/* ------------------------------------------------------------------ notice */
.pd-notice-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-top: 18px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--pd-amber-bright) 38%, var(--pd-line));
  border-left: 3px solid var(--pd-amber-bright);
  border-radius: 3px;
  background: var(--pd-amber-soft);
}
.pd-notice-head {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--pd-mono);
  font-size: 9.5px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--pd-amber);
  white-space: nowrap;
}
.pd-notice-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--pd-amber-bright); }
.pd-notice-copy {
  flex: 1 1 320px;
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--pd-ink-2);
}
.pd-notice-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  height: 27px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--pd-amber-bright) 45%, var(--pd-line));
  border-radius: 3px;
  background: var(--pd-surface-2);
  color: var(--pd-amber);
  font-size: 11px;
}
.pd-notice-action:hover { border-color: var(--pd-amber); color: var(--pd-amber); }

/* --------------------------------------------------------------- telemetry */
.pd-telemetry {
  display: grid;
  grid-template-columns: .9fr 1.15fr .9fr .9fr minmax(264px, 1.35fr);
  align-items: stretch;
  margin-top: 30px;
  border-top: 1px solid var(--pd-line);
  border-bottom: 1px solid var(--pd-line);
}
.pd-stat { min-width: 0; padding: 17px 20px 15px; }
.pd-stat + .pd-stat { border-left: 1px solid var(--pd-line-soft); }
.pd-stat:first-child { padding-left: 0; }
.pd-stat-label {
  display: block;
  font-family: var(--pd-mono);
  font-size: 9px;
  letter-spacing: .13em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
  white-space: nowrap;
}
.pd-stat-value {
  display: block;
  margin-top: 8px;
  font-family: var(--pd-mono);
  font-size: 30px;
  line-height: 1;
  font-weight: 500;
  letter-spacing: -.02em;
  font-variant-numeric: tabular-nums;
  color: var(--pd-ink);
  white-space: nowrap;
}
.pd-stat-value.is-live { color: var(--pd-green); }
.pd-stat-value.is-wait { color: var(--pd-amber); }
.pd-stat-meta {
  display: block;
  margin-top: 8px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
  line-height: 1.5;
  color: var(--pd-ink-3);
}
.pd-signal {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 13px 0 11px 22px;
  border-left: 1px solid var(--pd-line-soft);
}
.pd-signal-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-family: var(--pd-mono);
  font-size: 9px;
  letter-spacing: .13em;
  color: var(--pd-ink-3);
  text-transform: uppercase;
}
.pd-signal-span { color: var(--pd-ink-3); letter-spacing: .06em; }
.pd-signal-chart { display: block; width: 100%; height: 46px; margin-top: auto; }
.pd-chart-bar { fill: var(--pd-accent); }
.pd-chart-bar.is-zero { fill: var(--pd-line); }
.pd-chart-bar.is-today { fill: var(--pd-accent-strong); }
.pd-chart-line { stroke: var(--pd-line); }
.pd-signal-foot {
  font-family: var(--pd-mono);
  font-size: 8.5px;
  letter-spacing: .1em;
  color: var(--pd-ink-3);
  text-transform: uppercase;
}

.pd-register-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-top: 32px;
  padding-bottom: 9px;
}
.pd-register-title {
  font-family: var(--pd-mono);
  font-size: 9.5px;
  letter-spacing: .15em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
}
.pd-register-note { font-size: 11px; color: var(--pd-ink-3); }
.pd-register-count {
  margin-left: auto;
  font-family: var(--pd-mono);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--pd-ink-2);
  white-space: nowrap;
}

.pd-cols {
  display: grid;
  grid-template-columns: 40px minmax(0, 1.6fr) 112px 132px 124px 112px;
  gap: 16px;
  align-items: center;
  padding: 7px 4px 7px 19px;
  border-top: 1px solid var(--pd-line);
  border-bottom: 1px solid var(--pd-line);
  font-family: var(--pd-mono);
  font-size: 8.5px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
}
.pd-cols span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

/* -------------------------------------------------------------------- rows */
.pd-board { display: flex; flex-direction: column; }
.pd-ws {
  position: relative;
  display: grid;
  grid-template-columns: 40px minmax(0, 1.6fr) 112px 132px 124px 112px;
  gap: 16px;
  align-items: center;
  padding: 16px 4px 16px 16px;
  border-left: 3px solid var(--pd-line);
  border-bottom: 1px solid var(--pd-line-soft);
  background: transparent;
  opacity: 0;
  animation: pd-rise .34s cubic-bezier(.2, .75, .2, 1) forwards;
  animation-delay: calc(var(--i, 0) * 38ms);
  transition: background-color .18s ease, border-left-color .18s ease;
}
.pd-ws:hover { background: var(--pd-surface-2); }
.pd-ws.is-running { border-left-color: var(--pd-green-bright); }
.pd-ws.is-waiting { border-left-color: var(--pd-amber-bright); }
@keyframes pd-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.pd-ws-index {
  align-self: start;
  padding-top: 3px;
  font-family: var(--pd-mono);
  font-size: 10.5px;
  letter-spacing: .06em;
  color: var(--pd-ink-3);
}
.pd-ws-ident { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.pd-ws-title-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
.pd-ws-title {
  margin: 0;
  min-width: 0;
  max-width: 100%;
  font-size: 15px;
  line-height: 1.25;
  font-weight: 600;
  letter-spacing: -.01em;
  color: var(--pd-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pd-state-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 6px;
  border-radius: 3px;
  font-family: var(--pd-mono);
  font-size: 9px;
  letter-spacing: .05em;
  text-transform: uppercase;
  white-space: nowrap;
}
.pd-state-chip.is-run { color: var(--pd-green); background: var(--pd-green-soft); }
.pd-state-chip.is-wait { color: var(--pd-amber); background: var(--pd-amber-soft); }
.pd-state-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; }
.pd-state-chip.is-run .pd-state-dot { background: var(--pd-green-bright); animation: pd-pulse 2.1s ease-in-out infinite; }
.pd-state-chip.is-wait .pd-state-dot { background: var(--pd-amber-bright); }
@keyframes pd-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .4; }
}
.pd-ws-tags { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.pd-tag-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  max-width: 196px;
  border: 1px solid var(--pd-line);
  border-radius: 3px;
  background: var(--pd-surface);
  color: var(--pd-ink-2);
  overflow: hidden;
  transition: border-color .14s ease, background-color .14s ease, color .14s ease;
}
.pd-tag-pill:hover { border-color: var(--pd-ink-4); }
.pd-tag-pill.is-on { border-color: color-mix(in srgb, var(--pd-accent) 46%, transparent); background: var(--pd-accent-soft); color: var(--pd-accent); }
.pd-tag-main {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 100%;
  padding: 0 4px 0 6px;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: var(--pd-mono);
  font-size: 10.5px;
}
.pd-tag-leaf { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pd-tag-mark { flex: none; width: 5px; height: 5px; border-radius: 1px; }
.pd-tag-x {
  flex: none;
  width: 18px;
  height: 18px;
  margin-right: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--pd-ink-3);
  opacity: .5;
  transition: opacity .14s ease, background-color .14s ease, color .14s ease;
}
.pd-tag-pill:hover .pd-tag-x, .pd-tag-x:focus-visible { opacity: 1; }
.pd-tag-x:hover { background: color-mix(in srgb, var(--pd-ink) 8%, transparent); color: var(--pd-ink); }
.pd-tag-x:disabled { cursor: default; opacity: .35; }
.pd-tag-add {
  height: 22px;
  padding: 0 7px;
  border: 1px dashed var(--pd-line);
  border-radius: 3px;
  background: transparent;
  color: var(--pd-ink-3);
  font-family: var(--pd-mono);
  font-size: 10.5px;
}
.pd-tag-add:hover:not(:disabled) { border-color: var(--pd-accent); color: var(--pd-accent); }
.pd-tag-add:disabled { cursor: default; opacity: .5; }
.pd-ws-no-tags { font-family: var(--pd-mono); font-size: 10.5px; color: var(--pd-ink-3); }

.pd-ws-spark { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pd-spark-bars { display: flex; align-items: flex-end; gap: 3px; height: 26px; }
.pd-spark-bar {
  width: 5px;
  min-height: 2px;
  border-radius: 1px;
  background: var(--pd-accent);
  opacity: .55;
}
.pd-spark-bar.is-today { opacity: 1; background: var(--pd-accent-strong); }
.pd-spark-bar.is-zero { background: var(--pd-line); opacity: 1; }

.pd-ws-sessions, .pd-ws-last { display: grid; gap: 3px; min-width: 0; }
.pd-cell-label {
  font-family: var(--pd-mono);
  font-size: 8.5px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
  white-space: nowrap;
}
.pd-cell-value {
  font-family: var(--pd-mono);
  font-size: 21px;
  line-height: 1.1;
  font-weight: 500;
  letter-spacing: -.02em;
  font-variant-numeric: tabular-nums;
  color: var(--pd-ink);
  white-space: nowrap;
}
.pd-ws-last .pd-cell-value {
  font-family: var(--pd-body);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--pd-ink-2);
}
.pd-cell-meta {
  font-family: var(--pd-mono);
  font-size: 9px;
  line-height: 1.4;
  color: var(--pd-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pd-ws-actions { display: flex; align-items: center; justify-content: flex-end; }
.pd-new-session {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--pd-line);
  border-radius: 4px;
  background: var(--pd-surface);
  color: var(--pd-ink-2);
  font-size: 11.5px;
  white-space: nowrap;
  transition: border-color .16s ease, background-color .16s ease, color .16s ease;
}
.pd-new-session:hover { border-color: var(--pd-accent); background: var(--pd-accent-soft); color: var(--pd-accent); }
.pd-new-session svg { color: currentColor; }

/* ------------------------------------------------------------------- empty */
.pd-empty {
  margin-top: 18px;
  padding: 42px 24px;
  border: 1px dashed var(--pd-line);
  border-radius: 4px;
  background: var(--pd-surface);
  text-align: center;
  color: var(--pd-ink-2);
}
.pd-empty-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--pd-ink); }
.pd-empty-hint { margin: 8px 0 0; font-size: 12px; line-height: 1.6; color: var(--pd-ink-3); }
.pd-empty-action {
  margin-top: 16px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--pd-line);
  border-radius: 4px;
  background: var(--pd-surface-2);
  color: var(--pd-ink-2);
  font-size: 12px;
}
.pd-empty-action:hover { border-color: var(--pd-accent); color: var(--pd-accent); }

/* --------------------------------------------------------------- overlays */
.pd-editor {
  position: fixed;
  z-index: 60;
  width: min(300px, calc(100vw - 16px));
  padding: 11px;
  border: 1px solid var(--pd-line);
  border-radius: 4px;
  background: var(--pd-surface-2);
  box-shadow: var(--pd-shadow-pop);
}
.pd-editor-label {
  display: block;
  margin: 0 0 7px;
  font-family: var(--pd-mono);
  font-size: 9px;
  letter-spacing: .13em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
}
.pd-editor-input {
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--pd-line);
  border-radius: 3px;
  background: var(--pd-surface);
  color: var(--pd-ink);
  font-family: var(--pd-mono);
  font-size: 12.5px;
  outline: 0;
}
.pd-editor-input:focus { border-color: var(--pd-accent); box-shadow: 0 0 0 3px var(--pd-accent-soft); }
.pd-editor-error {
  margin: 6px 0 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--pd-red);
}
.pd-editor-suggest {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 7px;
  max-height: 160px;
  overflow-y: auto;
}
.pd-editor-suggest button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 27px;
  padding: 4px 7px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--pd-ink-2);
  font-family: var(--pd-mono);
  font-size: 10.5px;
  text-align: left;
}
.pd-editor-suggest button:hover { background: color-mix(in srgb, var(--pd-ink) 7%, transparent); color: var(--pd-ink); }
.pd-editor-hint { margin: 8px 0 0; font-size: 10px; line-height: 1.55; color: var(--pd-ink-3); }

.pd-toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  z-index: 80;
  transform: translateX(-50%);
  max-width: min(540px, calc(100vw - 32px));
  padding: 9px 13px;
  border: 1px solid var(--pd-line);
  border-radius: 4px;
  background: var(--pd-surface-2);
  color: var(--pd-ink);
  font-size: 12px;
  line-height: 1.45;
  box-shadow: var(--pd-shadow-pop);
}
.pd-toast.is-warn { border-color: color-mix(in srgb, var(--pd-amber) 55%, transparent); color: var(--pd-amber); }

/* -------------------------------------------------------------------- foot */
.pd-page-foot {
  margin-top: 30px;
  padding-top: 12px;
  border-top: 1px solid var(--pd-line);
  font-size: 10.5px;
  color: var(--pd-ink-3);
}
.pd-page-foot summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  list-style: none;
  cursor: pointer;
  font-family: var(--pd-mono);
  font-size: 9px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--pd-ink-3);
}
.pd-page-foot summary::-webkit-details-marker { display: none; }
.pd-page-foot summary:hover { color: var(--pd-ink); }
.pd-page-foot p {
  margin: 8px 0 0;
  max-width: 78ch;
  font-size: 11px;
  line-height: 1.6;
  color: var(--pd-ink-3);
}

/* -------------------------------------------------------------- responsive */
@media (max-width: 1180px) {
  .pd-page { padding: 28px 28px 48px; }
  .pd-cols { display: none; }
  .pd-telemetry { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pd-stat:nth-child(2) { border-left: 1px solid var(--pd-line-soft); }
  .pd-stat:nth-child(3) {
    padding-left: 0;
    border-left: 0;
    border-top: 1px solid var(--pd-line-soft);
  }
  .pd-stat:nth-child(4) { border-top: 1px solid var(--pd-line-soft); }
  .pd-signal {
    grid-column: 1 / -1;
    padding: 13px 0 11px;
    border-left: 0;
    border-top: 1px solid var(--pd-line-soft);
  }
  .pd-signal-chart { height: 44px; }
  .pd-ws {
    grid-template-columns: 34px minmax(0, 1fr) 98px 112px 112px;
    gap: 14px;
  }
  .pd-ws-spark { display: none; }
}
@media (max-width: 900px) {
  .pd-page { padding: 24px 24px 44px; }
  .pd-masthead-top { flex-direction: column; align-items: stretch; gap: 14px; }
  .pd-tools { justify-content: flex-start; align-items: flex-end; }
  .pd-search { width: min(100%, 390px); }
  .pd-result { align-self: flex-end; padding-bottom: 10px; margin-left: auto; }
  .pd-masthead-main { margin-top: 16px; }
}
@media (max-width: 760px) {
  .pd-ws {
    grid-template-columns: 24px minmax(0, 1fr) auto;
    grid-template-areas:
      "idx ident ident"
      ". sess last"
      ". act act";
    gap: 10px 12px;
    align-items: start;
    padding: 15px 2px 15px 10px;
  }
  .pd-ws-index { grid-area: idx; }
  .pd-ws-ident { grid-area: ident; }
  .pd-ws-sessions { grid-area: sess; align-items: start; }
  .pd-ws-last { grid-area: last; justify-items: end; text-align: right; }
  .pd-ws-actions { grid-area: act; justify-content: flex-start; margin-top: 2px; }
  .pd-ws-title { white-space: normal; overflow: visible; text-overflow: clip; }
  .pd-cell-value { font-size: 19px; }
  .pd-new-session { height: 32px; }
  .pd-tag-x { opacity: .85; }
}
@media (max-width: 640px) {
  .pd-page { padding: 20px 18px 40px; }
  .pd-masthead-top { gap: 12px; }
  .pd-tools { flex-wrap: wrap; gap: 10px; }
  .pd-search-field { flex: 1 1 100%; }
  .pd-search { width: 100%; }
  .pd-filter-wrap { order: 2; }
  .pd-filter-panel { left: 0; right: auto; max-height: min(58vh, 420px); }
  .pd-result { order: 3; align-self: center; padding-bottom: 0; margin-left: auto; }
  .pd-title { font-size: clamp(29px, 8.2vw, 36px); }
  .pd-sub { font-size: 13px; }
  .pd-telemetry { margin-top: 24px; }
  .pd-stat { padding: 14px 14px 13px; }
  .pd-stat:first-child { padding-left: 0; }
  .pd-stat-value { font-size: 23px; }
  .pd-stat-meta { font-size: 10.5px; white-space: normal; }
  .pd-stat:nth-child(2), .pd-stat:nth-child(4) { padding-right: 0; }
  .pd-signal { padding-top: 11px; }
  .pd-signal-chart { height: 40px; }
  .pd-register-head { margin-top: 26px; flex-wrap: wrap; row-gap: 3px; }
  .pd-register-count { margin-left: auto; }
  .pd-search input, .pd-editor-input { font-size: 16px; }
  .pd-empty { padding: 32px 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .pd-ws, .pd-state-dot, .pd-tag-root-toggle svg, .pd-search-kbd {
    animation: none !important;
    transition: none !important;
    opacity: 1 !important;
  }
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
