/**
 * Ambient declaration for `unpdf` (MIT), the PDF text engine.
 *
 * Pinned to the surface this plugin actually calls, not the whole package: the
 * extraction recipe needs per-run text, its placement matrix and its advance
 * width. Those are pdf.js's `TextItem` fields, re-exported by unpdf's
 * `getDocumentProxy()`.
 *
 * Kept as a script for the same reason as `dsh-runtime.d.ts`.
 */
declare module 'unpdf' {
  /** One text run as pdf.js reports it. */
  export interface PdfTextItem {
    /** The run's text. */
    str: string
    /** Baseline direction, e.g. `'ltr'`. */
    dir?: string
    /** Advance width in text space units (points, before the matrix). */
    width: number
    /** Nominal text height in points. */
    height: number
    /**
     * `[a, b, c, d, e, f]` — places the baseline start at `(e, f)` in the page's
     * **unrotated** coordinate space, with the run advancing along `(a, b)`.
     */
    transform: [number, number, number, number, number, number]
    fontName?: string
    hasEOL?: boolean
  }

  export interface PdfTextContent {
    items: Array<PdfTextItem | { type?: string; str?: string }>
  }

  export interface PdfViewport {
    width: number
    height: number
    /** Degrees; equals the page's `/Rotate` value. */
    rotation: number
  }

  export interface PdfPageProxy {
    getViewport(params: { scale: number; rotation?: number }): PdfViewport
    getTextContent(): Promise<PdfTextContent>
    cleanup(): void
    pageNumber: number
  }

  export interface PdfDocumentProxy {
    numPages: number
    getPage(pageNumber: number): Promise<PdfPageProxy>
    destroy?(): Promise<void>
  }

  /**
   * Open a PDF from bytes. The calls take a fresh copy of the buffer (pdf.js
   * transfers it to its worker), so callers must not reuse the array.
   */
  export function getDocumentProxy(data: Uint8Array): Promise<PdfDocumentProxy>
}
