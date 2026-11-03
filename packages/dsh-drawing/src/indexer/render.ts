/**
 * Page rasteriser for the Drawing tab.
 *
 * Why a second PDF engine: `unpdf`/pdf.js reports text geometry but cannot paint
 * without a canvas implementation, and the sidebar needs a picture with the hit
 * marked on it. `@hyzyla/pdfium` is PDFium compiled to WebAssembly — MIT, no
 * native build step, and it renders to raw RGBA in-process; `pngjs` (MIT, pure
 * JS) encodes that to a PNG. `@napi-rs/canvas` would also work but drags a
 * platform binary into the distribution for something we do once per sheet.
 *
 * Rendered pages are cached on disk under the document's own directory, so a
 * second look at the same sheet costs one `stat`, not one render (~120 ms).
 *
 * @module dsh-drawing/indexer/render
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where a page image lives relative to the document directory. */
export function renderPath(dir: string, page: number, scale: number): string {
  const tag = Number.isInteger(scale) ? String(scale) : scale.toFixed(2).replace('.', 'p')
  return join(dir, 'render', `p${String(page).padStart(3, '0')}@${tag}x.png`)
}

/** One rendered page. */
export interface RenderedPage {
  /** Absolute path of the PNG. */
  path: string
  /** Pixel size of the image. */
  width: number
  height: number
  /** Display size the text boxes are expressed in (rotation applied). */
  displayWidth: number
  displayHeight: number
  /** True when the file was already on disk and still matches the PDF. */
  cached: boolean
}

/**
 * Render one page to PNG, or reuse the cached image.
 *
 * The cache key includes the PDF's mtime: re-exporting a drawing under the same
 * name invalidates its images without a manual purge.
 */
export async function renderPage(
  dir: string,
  pdfPath: string,
  page: number,
  scale = 2,
): Promise<RenderedPage> {
  const target = renderPath(dir, page, scale)
  const source = await stat(pdfPath)
  const cached = await stat(target).catch(() => undefined)

  if (cached !== undefined && cached.mtimeMs >= source.mtimeMs) {
    return {
      path: target,
      width: 0,
      height: 0,
      displayWidth: 842,
      displayHeight: 595,
      cached: true,
    }
  }

  const { PNG } = await import('pngjs')
  const { PDFiumLibrary } = await import('@hyzyla/pdfium')
  const library = await PDFiumLibrary.init()
  try {
    const document = await library.loadDocument(new Uint8Array(await readFile(pdfPath)))
    try {
      const pages = [...document.pages()]
      const target0 = pages[page - 1]
      if (target0 === undefined) throw new Error(`page ${page} is out of range (1..${pages.length})`)
      const image = await target0.render({
        scale,
        render: (options: { data: Uint8Array; width: number; height: number }) =>
          Promise.resolve(encodePng(PNG, options)),
      })
      await mkdir(join(dir, 'render'), { recursive: true })
      await writeFile(target, Buffer.from(image.data))
      const displayWidth = image.originalWidth ?? 842
      const displayHeight = image.originalHeight ?? 595
      target0.close()
      return {
        path: target,
        width: image.width,
        height: image.height,
        displayWidth,
        displayHeight,
        cached: false,
      }
    } finally {
      document.destroy?.()
    }
  } finally {
    library.destroy?.()
  }
}

/** Encode PDFium's raw RGBA buffer as PNG. */
function encodePng(
  PNG: typeof import('pngjs').PNG,
  options: { data: Uint8Array; width: number; height: number },
): Uint8Array {
  const png = new PNG({ width: options.width, height: options.height })
  png.data = Buffer.from(options.data)
  return new Uint8Array(PNG.sync.write(png))
}

/** True when a cached image already exists. */
export function hasRender(dir: string, page: number, scale = 2): boolean {
  return existsSync(renderPath(dir, page, scale))
}
