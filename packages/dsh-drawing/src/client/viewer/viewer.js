/**
 * The panel's PDF viewer.
 *
 * Loads the document **once** (a `blob:` URL created by the panel), lays out one
 * placeholder per page and paints pages lazily as they scroll into view. The
 * parent drives page changes with `postMessage`; jumping is a scroll, so it
 * never re-parses the PDF the way the browser's native viewer does.
 *
 * Message protocol:
 *   parent -> viewer  { type: 'drawing:page', page, highlight, frame }
 *   viewer -> parent  { type: 'drawing:ready', pages }
 *
 * `highlight` is in display points and `frame` is its `{width,height}`; both are
 * optional (a page turn without a hit sends `highlight: null`).
 *
 * @module dsh-drawing/client/viewer/viewer
 */

import * as pdfjs from './pdf.min.mjs'

const WORKER_URL = new URL('./pdf.worker.min.mjs', import.meta.url).href
/** pdf.js needs the bundled Foxit fonts when a PDF uses a standard font. */
const FONTS_URL = new URL('./standard_fonts/', import.meta.url).href

pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL

const params = new URLSearchParams(location.search)
const source = params.get('file')

const container = document.getElementById('pages')
const notice = document.getElementById('notice')
const zoomOut = document.getElementById('zoom-out')
const zoomIn = document.getElementById('zoom-in')

/** Zoom steps relative to fit-width (1). */
const ZOOM_LEVELS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3]
let zoomIndex = ZOOM_LEVELS.indexOf(1)

/** @type {import('./pdf.min.mjs').PDFDocumentProxy | null} */
let document_ = null
/** @type {Array<{ index: number, el: HTMLElement, page: any, rendered: boolean, rendering: boolean }>} */
let entries = []
let targetPage = 1
let highlight = null
let frame = null
/** @type {IntersectionObserver | null} */
let observer = null
let resizeTimer = 0

function notify(text, error = false) {
  notice.hidden = false
  notice.textContent = text
  notice.classList.toggle('notice--error', error)
}

function post(message) {
  if (window.parent === window) return
  window.parent.postMessage(message, location.origin)
}

/** Build one placeholder per page from its viewport size, so scroll positions
 *  are correct before any page is painted. */
function buildPages(sizes) {
  container.replaceChildren()
  entries = sizes.map((size, offset) => {
    const index = offset + 1
    const el = document.createElement('div')
    el.className = 'page'
    el.dataset.page = String(index)
    el.style.setProperty('--aspect', `${size.width} / ${size.height}`)
    container.appendChild(el)
    return { index, el, page: null, rendered: false, rendering: false }
  })
}

async function renderPage(entry) {
  if (document_ === null || entry.rendered || entry.rendering) return
  entry.rendering = true
  try {
    const page = entry.page ?? (await document_.getPage(entry.index))
    entry.page = page
    const width = entry.el.clientWidth || container.clientWidth || 600
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: (width * (window.devicePixelRatio || 1)) / base.width })
    let canvas = entry.el.querySelector('canvas')
    if (canvas === null) {
      canvas = document.createElement('canvas')
      canvas.className = 'page-canvas'
      entry.el.appendChild(canvas)
    }
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const context = canvas.getContext('2d', { alpha: false })
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport }).promise
    entry.rendered = true
    if (entry.index === targetPage) applyHighlight()
  } catch (error) {
    notify(`Could not render page ${entry.index}: ${String(error)}`, true)
  } finally {
    entry.rendering = false
  }
}

function applyHighlight() {
  for (const entry of entries) entry.el.querySelector('.drawing-hit')?.remove()
  if (highlight === null || typeof highlight !== 'object') return
  if (frame === null || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)) return
  if (frame.width <= 0 || frame.height <= 0) return
  const entry = entries[targetPage - 1]
  if (entry === undefined) return
  const box = document.createElement('div')
  box.className = 'drawing-hit'
  box.style.left = `${(highlight.x / frame.width) * 100}%`
  box.style.top = `${(highlight.y / frame.height) * 100}%`
  box.style.width = `${(highlight.w / frame.width) * 100}%`
  box.style.height = `${(highlight.h / frame.height) * 100}%`
  entry.el.appendChild(box)
}

function goToPage(value) {
  if (!Number.isInteger(value) || entries.length === 0) return
  targetPage = Math.min(Math.max(1, value), entries.length)
  const entry = entries[targetPage - 1]
  entry.el.scrollIntoView({ block: 'start' })
  void renderPage(entry)
  applyHighlight()
}

function observePages() {
  observer?.disconnect()
  observer = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        if (!record.isIntersecting) continue
        const entry = entries[Number(record.target.dataset.page) - 1]
        if (entry !== undefined) void renderPage(entry)
      }
    },
    { root: null, rootMargin: '150% 0px' },
  )
  for (const entry of entries) observer.observe(entry.el)
}

/** The page currently at the top of the viewport, if any. */
function topEntry() {
  for (const entry of entries) {
    if (entry.el.getBoundingClientRect().bottom > 0) return entry
  }
  return null
}

/** Paint every page that is near the viewport (after a zoom change). */
function renderVisible() {
  for (const entry of entries) {
    const rect = entry.el.getBoundingClientRect()
    if (rect.bottom < -window.innerHeight || rect.top > window.innerHeight * 2) continue
    void renderPage(entry)
  }
}

function updateZoomButtons() {
  if (zoomOut !== null) zoomOut.disabled = zoomIndex === 0
  if (zoomIn !== null) zoomIn.disabled = zoomIndex === ZOOM_LEVELS.length - 1
}

/**
 * Zoom one step, keeping the page at the top anchored (and the relative
 * position inside it) so the sheet does not jump away.
 */
function changeZoom(direction) {
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, zoomIndex + direction))
  if (next === zoomIndex) return
  const anchor = topEntry()
  let ratio = 0
  if (anchor !== null) {
    const rect = anchor.el.getBoundingClientRect()
    if (rect.height > 0) ratio = Math.min(1, Math.max(0, -rect.top / rect.height))
  }
  zoomIndex = next
  document.documentElement.style.setProperty('--zoom', String(ZOOM_LEVELS[zoomIndex]))
  for (const entry of entries) {
    if (!entry.rendered) continue
    entry.rendered = false
    entry.el.querySelector('canvas')?.remove()
  }
  window.requestAnimationFrame(() => {
    if (anchor !== null) {
      anchor.el.scrollIntoView({ block: 'start' })
      const height = anchor.el.getBoundingClientRect().height
      if (height > 0) window.scrollBy(0, Math.round(height * ratio))
    }
    renderVisible()
    applyHighlight()
    updateZoomButtons()
  })
}

zoomOut?.addEventListener('click', () => changeZoom(-1))
zoomIn?.addEventListener('click', () => changeZoom(1))
updateZoomButtons()

async function start(url) {
  notify('Loading drawing…')
  try {
    document_ = await pdfjs.getDocument({
      url,
      standardFontDataUrl: FONTS_URL,
      isEvalSupported: false,
    }).promise
    const sizes = []
    for (let index = 1; index <= document_.numPages; index += 1) {
      const page = await document_.getPage(index)
      const viewport = page.getViewport({ scale: 1 })
      sizes.push({ width: viewport.width, height: viewport.height })
    }
    buildPages(sizes)
    notice.hidden = true
    observePages()
    const initial = Number(params.get('page'))
    if (Number.isInteger(initial) && initial > 0) goToPage(initial)
    post({ type: 'drawing:ready', pages: document_.numPages })
  } catch (error) {
    notify(`Could not open the drawing: ${String(error)}`, true)
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  if (event.origin !== location.origin) return
  const data = event.data
  if (data === null || typeof data !== 'object' || data.type !== 'drawing:page') return
  frame = data.frame ?? null
  highlight = data.highlight ?? null
  if (Number.isInteger(data.page)) goToPage(data.page)
  else applyHighlight()
})

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    for (const entry of entries) {
      if (!entry.rendered) continue
      entry.rendered = false
      entry.el.querySelector('canvas')?.remove()
      const rect = entry.el.getBoundingClientRect()
      if (rect.bottom > -window.innerHeight && rect.top < window.innerHeight * 2) void renderPage(entry)
    }
  }, 250)
})

if (typeof source !== 'string' || !source.startsWith('blob:')) {
  notify('No drawing source was provided.', true)
} else {
  void start(source)
}
