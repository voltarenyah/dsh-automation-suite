/**
 * The PDF side of the extractor: one document, N pages of placed text runs.
 *
 * `unpdf` (MIT, bundles pdf.js) was chosen over the alternatives because it is
 * the only candidate that gives per-run placement **and** installs without a
 * native build step:
 *
 *   - pdf.js reports `transform` + `width` per run, which is exactly what
 *     `rules.placeItem()` needs (and its numbers match PDFium's char boxes to
 *     the digit on this drawing set);
 *   - `@hyzyla/pdfium` ships a renderer but no text geometry at all;
 *   - `mupdf` is AGPL, so it cannot be shipped in this distribution;
 *   - `pdfium-native` downloads binaries at install time.
 *
 * The import is lazy: the module costs 2 ms cold and nothing at plugin startup,
 * and the browser half must never see it (`scripts/build.mjs` asserts that).
 *
 * @module dsh-drawing/indexer/pdf
 */

import type { PdfDocumentProxy, PdfPageProxy, PdfTextItem } from 'unpdf'

import { placeItem, type PageGeometry, type RawTextItem, type Run } from './rules.js'

/** One page's placed text. */
export interface PageText {
  /** 1-based physical page in the PDF. */
  page: number
  geometry: PageGeometry
  runs: Run[]
}

/** The whole document, text only (no rasterisation). */
export interface DocumentText {
  pageCount: number
  pages: PageText[]
}

/** Placeholder when pdf.js hands back a non-text item (marked content etc.). */
function isTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as PdfTextItem).str === 'string' &&
    Array.isArray((item as PdfTextItem).transform) &&
    typeof (item as PdfTextItem).width === 'number'
  )
}

/** Open a PDF from a byte array and place every page's text runs. */
export async function readDocument(bytes: Uint8Array): Promise<DocumentText> {
  const { getDocumentProxy } = await import('unpdf')
  // pdf.js transfers the buffer to its worker; give it a private copy.
  const document = await getDocumentProxy(new Uint8Array(bytes))
  try {
    const pages: PageText[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      pages.push(await readPage(document, pageNumber))
    }
    return { pageCount: document.numPages, pages }
  } finally {
    await document.destroy?.()
  }
}

async function readPage(document: PdfDocumentProxy, pageNumber: number): Promise<PageText> {
  const page: PdfPageProxy = await document.getPage(pageNumber)
  try {
    const viewport = page.getViewport({ scale: 1 })
    const geometry: PageGeometry = {
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation ?? 0,
    }
    const content = await page.getTextContent()
    const runs: Run[] = []
    for (const item of content.items) {
      if (!isTextItem(item)) continue
      if (item.str.trim() === '') continue
      runs.push(placeItem(toRaw(item), geometry))
    }
    return { page: pageNumber, geometry, runs }
  } finally {
    page.cleanup()
  }
}

function toRaw(item: PdfTextItem): RawTextItem {
  return {
    str: item.str,
    width: item.width,
    height: item.height,
    transform: item.transform,
  }
}
