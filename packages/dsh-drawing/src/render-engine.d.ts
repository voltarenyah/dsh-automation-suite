/**
 * Ambient declarations for the rendering engine.
 *
 * Both packages ship without usable TypeScript types for the members we call
 * (`@hyzyla/pdfium` is ESM-only with a declaration file that this checkout's
 * resolution cannot always reach; `pngjs` has none at all). Pinned to the
 * surface actually used, and kept as a script for the same reason as
 * `unpdf.d.ts`.
 */

declare module '@hyzyla/pdfium' {
  export interface PdfiumRenderOptions {
    data: Uint8Array
    width: number
    height: number
  }

  export interface PdfiumRenderResult {
    width: number
    height: number
    originalWidth: number
    originalHeight: number
    data: Uint8Array
  }

  export interface PdfiumPage {
    render(options: {
      scale?: number
      render: (options: PdfiumRenderOptions) => Promise<Uint8Array>
    }): Promise<PdfiumRenderResult>
    close(): void
  }

  export interface PdfiumDocument {
    pages(): Generator<PdfiumPage>
    destroy(): void
  }

  export interface PdfiumLibrary {
    loadDocument(data: Uint8Array): Promise<PdfiumDocument>
    destroy(): void
  }

  export const PDFiumLibrary: {
    init(options?: { wasmUrl?: string }): Promise<PdfiumLibrary>
  }
}

declare module 'pngjs' {
  export class PNG {
    constructor(options: { width: number; height: number })
    data: Buffer
    static sync: {
      write(png: PNG): Buffer
    }
  }
}
