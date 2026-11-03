/**
 * The tab's stylesheet, inlined into the client bundle and injected once as a
 * `<style data-plugin …>` node.
 *
 * Generated from `mockup/page.tpl.html` by `scripts/style-from-mockup.mjs`: the
 * approved design is the single source of truth for the panel's look, and this file
 * only renames the class prefix to `hwv-` and swaps the standalone palette for the
 * host's `--dsw-*` semantic tokens. Edit the mockup, then re-run the script.
 *
 * @module dsh-ui-hardware/client/style
 */

/** Identifier of the injected stylesheet, unique across the page. */
export const TAG_ID = 'dsh-ui-hardware/hardware.css'

/** Stylesheet text. Class names are prefixed to stay out of the app's way. */
export const CSS = `

/* ============================================================================
   Hardware panel — "engineering rack" direction.

   The page is a spec sheet, not a card wall: one station is always the focus,
   its slots are drawn as a physical rack strip, and everything else recedes
   into monospace supporting data. Neutral surfaces carry the structure; a
   single accent marks selection, green only marks "I/O present", amber only
   marks "not exported". Type does the aesthetic work: DIN-flavoured display
   (Bahnschrift) against a technical mono for every identifier.
   ========================================================================= */
.hwv-root {
  /* Colours are the host's semantic tokens, so light and dark follow the app. */
  --bg: transparent;
  --surface: var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.08));
  --surface-2: color-mix(in srgb, var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.08)) 60%, transparent);
  --surface-3: color-mix(in srgb, var(--dsw-alias-fill-l2, rgba(128, 128, 128, 0.14)) 70%, transparent);
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
}

.display { font-family: Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif; font-stretch: 95%; }
.mono { font-family: "Cascadia Mono", Consolas, ui-monospace, monospace; font-variant-ligatures: none; }

/* --------------------------------------------------------------------- shell */
.hwv-root {
  height: 100%; display: flex; flex-direction: column; min-height: 0;
  container-type: inline-size; container-name: hw;
}

/* The masthead carries a hairline grid, like a drawing sheet. */
.hwv-top {
  position: sticky; top: 0; z-index: 8;
  background: linear-gradient(var(--grain), var(--grain)), var(--surface);
  border-bottom: 1px solid var(--rule-strong);
}
.hwv-bar { display: flex; align-items: center; gap: 10px; padding: 9px 14px 7px; flex-wrap: wrap; }
.hwv-mark {
  font-family: Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif;
  font-size: 11px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase;
}
.hwv-sep { width: 1px; height: 12px; background: var(--rule-strong); }
.hwv-proj { font-size: 11px; color: var(--ink-3); letter-spacing: .01em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@container hw (max-width: 520px) {
  /* Below ~520px the three actions plus the project name do not fit on one row:
     the project drops to its own line instead of squeezing a button. */
  .hwv-proj { order: 9; flex: 1 1 100%; }
  .hwv-sep { display: none; }
}
.hwv-spacer { flex: 1; }
.hwv-act {
  border: 1px solid var(--rule); background: transparent; color: var(--ink-2);
  font: inherit; font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase;
  padding: 4px 8px; min-height: 24px; border-radius: 2px; cursor: pointer;
}
.hwv-act:hover { color: var(--ink); border-color: var(--rule-strong); }
.hwv-act:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* Filter row: search is the only elastic element. */
.hwv-filter { display: flex; gap: 6px; align-items: center; padding: 0 14px 9px; flex-wrap: wrap; }
.hwv-search {
  flex: 1 1 160px; min-width: 0; min-height: 27px;
  background: var(--surface-2); border: 1px solid var(--rule); color: var(--ink);
  border-radius: 2px; font: inherit; font-size: 11.5px; padding: 4px 9px; outline: none;
}
.hwv-search::placeholder { color: var(--ink-3); }
.hwv-search:focus { border-color: var(--rule-strong); background: var(--surface-3); }

/* Segmented control: our own, because the native popup is painted by the OS. */
.hwv-seg { display: inline-flex; border: 1px solid var(--rule); border-radius: 2px; overflow: hidden; }
.hwv-seg button {
  border: 0; background: transparent; color: var(--ink-3); font: inherit;
  font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 10.5px;
  letter-spacing: .09em; text-transform: uppercase; padding: 5px 10px; min-height: 27px; cursor: pointer;
}
.hwv-seg button + button { border-left: 1px solid var(--rule); }
.hwv-seg button[aria-selected="true"] { background: var(--accent-soft); color: var(--ink); }

.hwv-select { position: relative; }
.hwv-select > button {
  display: inline-flex; align-items: center; gap: 6px; min-height: 27px;
  padding: 4px 9px; font: inherit; font-size: 11px; color: var(--ink-2);
  background: var(--surface-2); border: 1px solid var(--rule); border-radius: 2px; cursor: pointer;
}
.hwv-select > button:hover { color: var(--ink); border-color: var(--rule-strong); }
.hwv-caret { color: var(--ink-3); font-size: 8px; }
.hwv-menu {
  position: absolute; z-index: 30; top: calc(100% + 4px); right: 0; min-width: 190px; max-height: 280px;
  overflow-y: auto; margin: 0; padding: 4px; list-style: none; background: var(--surface);
  border: 1px solid var(--rule-strong); border-radius: 3px; box-shadow: 0 10px 28px rgba(0,0,0,.35);
}
.hwv-menu button {
  display: flex; width: 100%; justify-content: space-between; gap: 10px; align-items: baseline;
  border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 11.5px;
  padding: 5px 8px; border-radius: 2px; cursor: pointer; text-align: left;
}
.hwv-menu button:hover { background: var(--surface-2); }
.hwv-menu .n { color: var(--ink-3); font-size: 10px; }

/* Stats: a spec row of numbers, hairline-separated, not six cards. */
.hwv-stats {
  display: flex; align-items: stretch; flex-wrap: wrap;
  border-top: 1px solid var(--rule); padding: 0 14px;
}
.hwv-stat { display: flex; align-items: baseline; gap: 7px; padding: 7px 14px 7px 0; margin-right: 14px; border-right: 1px solid var(--rule); white-space: nowrap; }
.hwv-stat:last-child { border-right: 0; margin-right: 0; }
.hwv-stat b { font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.hwv-stat span {
  font-family: Bahnschrift, "Segoe UI", sans-serif;
  font-size: 9px; letter-spacing: .13em; text-transform: uppercase; color: var(--ink-3);
}
.hwv-stat.warn b { color: var(--warn); }

/* --------------------------------------------------------------------- main */
.hwv-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0,1fr); grid-template-rows: minmax(0,1fr); }

/* Rail: role groups, with a hairline spine on the left like a bus. */
.hwv-rail { min-height: 0; overflow-y: auto; scrollbar-width: thin; padding: 4px 0 18px; }
.hwv-rail-group + .hwv-rail-group { margin-top: 4px; }
.hwv-rail-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px 5px;
  font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 9px;
  letter-spacing: .15em; text-transform: uppercase; color: var(--ink-3);
}
.hwv-rail-head::after { content: ""; flex: 1; height: 1px; background: var(--rule); }
.hwv-dev {
  display: grid; grid-template-columns: 22px minmax(0,1fr) auto; gap: 9px; align-items: center;
  width: 100%; padding: 6px 14px 6px 12px; border: 0; border-left: 2px solid transparent;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.hwv-dev:hover { background: var(--surface-2); }
.hwv-dev[aria-current="true"] { background: var(--surface-2); border-left-color: var(--accent); }
.hwv-badge {
  display: grid; place-items: center; width: 22px; height: 22px; border-radius: 2px;
  border: 1px solid var(--rule-strong); color: var(--ink-2);
  font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 8px; letter-spacing: .04em;
}
.hwv-badge[data-role="controller"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.hwv-dev-main { min-width: 0; }
.hwv-dev-name { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hwv-dev-sub { display: block; font-size: 10px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hwv-dev-meta { text-align: right; font-size: 10px; color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.hwv-dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: var(--ok); vertical-align: 1px; }
.hwv-dot.warn { background: var(--warn); }

/* Splitter is a 9px band; the sheet starts with a stronger rule. */
.hwv-grip { display: none; cursor: col-resize; }
@container hw (min-width: 760px) {
  .hwv-main { grid-template-columns: minmax(200px, calc(var(--hwv-split, 34%) - 4px)) 9px minmax(0,1fr); }
  .hwv-grip { display: block; border-left: 1px solid var(--rule); }
  .hwv-grip:hover, .hwv-grip[data-drag="1"] { background: var(--accent-soft); border-left-color: var(--accent); }
  .hwv-rail { border-right: 1px solid var(--rule); }
}
@container hw (max-width: 759px) {
  .hwv-root[data-pane="detail"] .hwv-rail { display: none; }
  .hwv-root[data-pane="list"] .hwv-sheet { display: none; }
  .hwv-root[data-pane="detail"] .hwv-back { display: inline-grid; }
}
.hwv-back { display: none; place-items: center; min-width: 24px; }

/* -------------------------------------------------------------------- sheet */
.hwv-sheet { min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.hwv-sheet-in { padding: 14px 16px 28px; }

.hwv-station { display: flex; gap: 14px; align-items: flex-start; padding-bottom: 12px; }
.hwv-station-id { min-width: 0; flex: 1; }
.hwv-station-name {
  font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 19px; line-height: 24px;
  font-weight: 600; letter-spacing: -.01em; margin: 0 0 2px;
}
.hwv-station-mlfb { font-size: 12px; color: var(--ink-2); }
.hwv-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.hwv-chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 2px;
  border: 1px solid var(--rule); background: var(--surface-2);
  font-size: 10px; color: var(--ink-2); white-space: nowrap;
}
.hwv-chip.mono { font-size: 10.5px; }
.hwv-chip b { color: var(--ink); font-weight: 600; }
.hwv-chip.is-warn { border-color: color-mix(in srgb, var(--warn) 45%, transparent); color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); }
.hwv-chip.is-ok { border-color: color-mix(in srgb, var(--ok) 40%, transparent); color: var(--ok); background: color-mix(in srgb, var(--ok) 8%, transparent); }

/* The rack strip: the memorable element. Slots read left to right like the
   physical rack, each cell is the module's face. */
.hwv-rack-label {
  display: flex; align-items: center; gap: 8px; margin: 6px 0 6px;
  font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 9px;
  letter-spacing: .15em; text-transform: uppercase; color: var(--ink-3);
}
.hwv-rack-label::after { content: ""; flex: 1; height: 1px; background: var(--rule); }
.hwv-rack {
  display: flex; gap: 4px; overflow-x: auto; padding: 3px 0 6px;
  scrollbar-width: thin; scrollbar-color: var(--rule-strong) transparent;
  scroll-snap-type: x proximity;
}
.hwv-rack::-webkit-scrollbar { height: 7px; }
.hwv-rack::-webkit-scrollbar-thumb { background: var(--rule-strong); border-radius: 4px; }
.hwv-slot {
  flex: 0 0 auto; width: 76px; scroll-snap-align: start;
  display: flex; flex-direction: column; gap: 3px; text-align: left;
  padding: 6px 7px 7px; border-radius: 2px; cursor: pointer;
  border: 1px solid var(--rule); background: var(--surface-2); color: inherit; font: inherit;
  animation: hwv-rise .32s ease both;
}
/* Fades the right edge only when there is more rack to scroll to; the scrollbar
   stays visible underneath, so the affordance is not a guessing game. */
.hwv-rack.is-scroll {
  mask-image: linear-gradient(to right, #000 calc(100% - 30px), transparent);
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 30px), transparent);
  padding-right: 30px;
}
.hwv-slot:hover { border-color: var(--rule-strong); }
.hwv-slot[aria-current="true"] { border-color: var(--accent); background: var(--accent-soft); }
.hwv-slot-n { font-size: 9.5px; color: var(--ink-3); letter-spacing: .06em; display: flex; justify-content: space-between; }
.hwv-slot-n i { font-style: normal; color: var(--warn); font-weight: 600; }
.hwv-slot-v { font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 12.5px; font-weight: 600; letter-spacing: .02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hwv-slot-t { font-size: 9.5px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@keyframes hwv-rise { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

/* Selected slot detail: address windows + channels, dense and monospace. */
.hwv-slot-detail {
  border: 1px solid var(--rule); border-radius: 2px; background: var(--surface);
  padding: 10px 12px; margin-bottom: 14px;
  animation: hwv-fade .2s ease both;
}
@keyframes hwv-fade { from { opacity: .4; } to { opacity: 1; } }
.hwv-slot-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 7px; }
.hwv-slot-title .t { font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 13px; font-weight: 600; }
.hwv-slot-title .m { font-size: 11px; color: var(--ink-2); }
.hwv-kv { display: grid; grid-template-columns: max-content minmax(0,1fr); gap: 2px 12px; font-size: 11px; }
.hwv-kv dt { color: var(--ink-3); }
.hwv-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

/* Two supporting columns; they collapse to one below 900. */
.hwv-cols { display: grid; grid-template-columns: minmax(0,1fr); gap: 14px; }
@container hw (min-width: 900px) { .hwv-cols { grid-template-columns: minmax(0,1fr) minmax(0,1fr); } }
.hwv-sec-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
  font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 9px;
  letter-spacing: .15em; text-transform: uppercase; color: var(--ink-3);
}
.hwv-sec-head::after { content: ""; flex: 1; height: 1px; background: var(--rule); }
.hwv-list-mini { list-style: none; margin: 0; padding: 0; font-size: 11px; }
.hwv-list-mini li { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; padding: 3px 0; border-bottom: 1px solid var(--rule); }
.hwv-list-mini li:last-child { border-bottom: 0; }
.hwv-list-mini .l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hwv-list-mini .r { color: var(--ink-3); white-space: nowrap; font-size: 10.5px; }

.hwv-note {
  display: flex; gap: 9px; align-items: flex-start; margin: 0 0 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  background: color-mix(in srgb, var(--warn) 7%, transparent);
  border-radius: 2px; padding: 9px 11px; color: var(--ink-2);
}
.hwv-note .tag { color: var(--warn); font-family: Bahnschrift, "Segoe UI", sans-serif; font-size: 9px; letter-spacing: .12em; text-transform: uppercase; }

/* Dense tables are reserved for the full-width views. */
.hwv-tablewrap { overflow-x: auto; scrollbar-width: thin; }
table.hwv-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.hwv-table th {
  text-align: left; font-family: Bahnschrift, "Segoe UI", sans-serif; font-weight: 500;
  font-size: 9px; letter-spacing: .13em; text-transform: uppercase; color: var(--ink-3);
  padding: 5px 9px; border-bottom: 1px solid var(--rule-strong); white-space: nowrap;
  position: sticky; top: 0; background: var(--bg); z-index: 1;
}
.hwv-table td { padding: 4px 9px; border-bottom: 1px solid var(--rule); vertical-align: top; }
.hwv-table tr:hover td { background: var(--surface-2); }
.hwv-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hwv-table .ord { color: var(--ink-3); font-size: 10.5px; white-space: nowrap; }
.hwv-table .type { color: var(--ink-2); white-space: nowrap; }

.hwv-empty { padding: 16px; color: var(--ink-3); }
.hwv-foot {
  flex: 0 0 auto; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  padding: 6px 14px; border-top: 1px solid var(--rule); color: var(--ink-3); font-size: 10px;
  background: var(--surface);
}
.hwv-foot .mono { color: var(--ink-2); }

@media (prefers-reduced-motion: reduce) {
  .hwv-slot, .hwv-slot-detail { animation: none; }
}
`

/**
 * Inject the stylesheet once per document.
 *
 * @param {string} id - the plugin id, recorded on the node for debugging.
 */
export function ensureStyle(id) {
  const key = `${TAG_ID}#${id}`
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin="${key}"]`) !== null) return
  const node = document.createElement('style')
  node.setAttribute('data-plugin', key)
  node.textContent = CSS
  document.head.appendChild(node)
}
