/**
 * Pure state helpers for the Drawing tab's single PDF surface.
 *
 * The panel shows exactly one thing: the browser's PDF viewer. "Which page" is
 * therefore the only state that moves, and these functions decide it without
 * touching React, so they can be tested in Node:
 *
 *  - `resolvePage` — explicit click > the agent's last view (same document) >
 *    the first sheet > page 1, clamped to the document's page count;
 *  - `pickDocument` — the document the agent last showed, else the first
 *    indexed one, else the first one;
 *  - `pdfSrc` — the viewer URL. The `#page=` fragment only takes effect when
 *    the iframe is (re)mounted, which is why the panel keys it by page.
 *
 * @module dsh-drawing/client/view-state
 */

/**
 * Clamp a page number into `1..pages` (no upper clamp when `pages` is unknown).
 *
 * @param {unknown} page
 * @param {number | null | undefined} pages
 * @returns {number}
 */
export function clampPage(page, pages) {
  const value = Number.isInteger(page) ? page : 1
  if (value < 1) return 1
  if (Number.isInteger(pages) && pages > 0 && value > pages) return pages
  return value
}

/**
 * The page the PDF viewer should show.
 *
 * @param {object} state
 * @param {number | null | undefined} state.targetPage - the user's explicit pick.
 * @param {object | undefined} state.view - the last `drawing_show` payload.
 * @param {string | null | undefined} state.documentFile - selected document.
 * @param {ReadonlyArray<object>} [state.sheets] - that document's sheet rows.
 * @param {number | null | undefined} [state.pages] - its page count.
 * @returns {number}
 */
export function resolvePage({ targetPage, view, documentFile, sheets, pages }) {
  let wanted
  if (Number.isInteger(targetPage)) wanted = targetPage
  else if (view !== null && typeof view === 'object' && view.document === documentFile && Number.isInteger(view.page)) {
    wanted = view.page
  } else {
    const first = Array.isArray(sheets) ? sheets.find((sheet) => Number.isInteger(sheet?.page)) : undefined
    wanted = first === undefined ? 1 : first.page
  }
  return clampPage(wanted, pages)
}

/**
 * The document to select when the tab first loads.
 *
 * @param {ReadonlyArray<object> | undefined} documents - manifest entries.
 * @param {object | undefined} view - the last `drawing_show` payload, if any.
 * @returns {object | undefined}
 */
export function pickDocument(documents, view) {
  const rows = Array.isArray(documents) ? documents.filter((entry) => typeof entry?.file === 'string') : []
  if (view !== null && typeof view === 'object' && typeof view.document === 'string') {
    const shown = rows.find((entry) => entry.file === view.document)
    if (shown !== undefined) return shown
  }
  return rows.find((entry) => entry.indexed === true) ?? rows[0]
}

/**
 * The document file a `drawing_show` payload points at, when it still exists.
 *
 * @param {object | undefined} view
 * @param {ReadonlyArray<object> | undefined} documents
 * @returns {string | undefined}
 */
export function viewDocument(view, documents) {
  if (view === null || typeof view !== 'object' || typeof view.document !== 'string') return undefined
  const rows = Array.isArray(documents) ? documents : []
  return rows.some((entry) => entry?.file === view.document) ? view.document : undefined
}

/**
 * URL of the in-panel viewer page for a PDF blob. The page is served by the
 * plugin's own static route and loads the document once; page changes arrive
 * by `postMessage`, not by re-navigating this URL.
 *
 * @param {string | null | undefined} url - the PDF blob URL.
 * @param {number} [page] - optional initial page.
 * @returns {string | undefined}
 */
export function viewerSrc(url, page) {
  if (typeof url !== 'string' || url === '') return undefined
  const initial = Number.isInteger(page) && page > 0 ? `&page=${page}` : ''
  return `/drawing-viewer/viewer.html?file=${encodeURIComponent(url)}${initial}`
}


/**
 * Split a filter query into lower-case tokens. Every token has to appear on a
 * page, so "rear door" finds pages that print both words, not just the phrase.
 *
 * @param {unknown} query
 * @returns {string[]}
 */
export function searchTokens(query) {
  if (typeof query !== 'string') return []
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '')
}

/**
 * True when every token occurs in a page's pre-built lower-case haystack.
 *
 * @param {string | undefined} haystack - lower-case page text.
 * @param { readonly string[] } tokens
 * @returns {boolean}
 */
export function pageMatches(haystack, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return true
  if (typeof haystack !== 'string') return false
  return tokens.every((token) => haystack.includes(token))
}
