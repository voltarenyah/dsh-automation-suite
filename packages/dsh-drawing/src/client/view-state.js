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
 * Viewer URL for a page. The fragment is honoured on load; the caller must
 * remount the iframe for it to take effect on an already open viewer. A numeric
 * zoom is passed because the embedded viewer otherwise sometimes opens at its
 * minimum zoom (25%) instead of fitting the pane.
 *
 * @param {string | null | undefined} url - the PDF blob URL.
 * @param {number} page
 * @param {number | undefined} zoomPercent - percent, e.g. 71 for "fit width".
 * @returns {string | undefined}
 */
export function pdfSrc(url, page, zoomPercent) {
  if (typeof url !== 'string' || url === '') return undefined
  const zoom = Number.isFinite(zoomPercent) ? `&zoom=${Math.round(zoomPercent)},0,0` : ''
  return `${url}#page=${clampPage(page, undefined)}${zoom}`
}

/**
 * The zoom percentage that makes a page of `frameWidth` points span the viewer.
 *
 * @param {number | undefined} frameWidth - page width in display points.
 * @param {number | undefined} viewerWidth - the pane's CSS pixel width.
 * @returns {number | undefined} percent, or undefined when it cannot be computed.
 */
export function fitZoom(frameWidth, viewerWidth) {
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return undefined
  if (!Number.isFinite(viewerWidth) || viewerWidth < 120) return undefined
  const percent = Math.round(((viewerWidth - 6) / frameWidth) * 100)
  return Math.min(200, Math.max(25, percent))
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

/**
 * A short excerpt around the first matching token, for the sheet list.
 *
 * @param {string | undefined} text - the page's case-preserving text.
 * @param { readonly string[] } tokens
 * @param {number} radius - characters of context on each side.
 * @returns {string} empty when there is nothing to show.
 */
export function searchSnippet(text, tokens, radius = 70) {
  if (typeof text !== 'string' || text === '' || !Array.isArray(tokens) || tokens.length === 0) return ''
  const lower = text.toLowerCase()
  const at = lower.indexOf(tokens[0])
  if (at < 0) return ''
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + tokens[0].length + radius)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}
