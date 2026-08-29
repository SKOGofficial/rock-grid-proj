/**
 * The rendering abstraction that keeps the viewer from caring what kind of file it is showing.
 *
 * Summary:
 *   A `RenderSource` can paint an arbitrary rectangle of a page at an arbitrary scale. That
 *   single primitive covers all three things the app needs: drawing the visible part of a huge
 *   sheet, drawing a whole small page, and cutting a high-resolution crop for the exemplar
 *   thumbnail. PDFs and bitmaps both implement it, so `DocumentCanvas` never branches on type.
 */

import type { FileKind, LibraryFile, PageSize } from '../types'

/** A rectangle in *rendered pixel* space: page-intrinsic coordinates multiplied by `scale`. */
export interface RegionPx {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A render in flight. Rendering is cancellable because the user out-scrolls and out-zooms the
 * renderer constantly; abandoning superseded work is the difference between a responsive viewer
 * and a stuttering one.
 */
export interface RenderHandle {
  /** Resolves when the render finishes, or when it is cancelled. Never rejects on cancellation. */
  readonly done: Promise<void>
  cancel(): void
}

export interface RenderSource {
  readonly kind: FileKind
  readonly pageCount: number

  /**
   * Convert a target DPI into a render scale for this source.
   *
   * Parameters:
   *   dpi: desired dots per inch.
   * Returns:
   *   The multiplier to pass as `scale`.
   * Raises:
   *   Nothing.
   * Summary:
   *   PDF pages are measured in 1/72 inch, so this is `dpi / 72`. Bitmaps have no physical size
   *   and no detail above their native resolution, so they pin to 1.
   */
  scaleForDpi(dpi: number): number

  /**
   * Intrinsic size of a page.
   *
   * Parameters:
   *   page: 1-based page number.
   * Returns:
   *   Promise of the page size in PDF points (pdf) or pixels (image).
   * Raises:
   *   Rejects if the page does not exist or the document is closed.
   * Summary:
   *   Async because pdf.js loads pages lazily; forcing every page of a drawing set to load
   *   just to know how big they are would defeat range-request streaming.
   */
  getPageSize(page: number): Promise<PageSize>

  /**
   * Paint a region of a page onto a canvas.
   *
   * Parameters:
   *   page: 1-based page number.
   *   scale: multiplier applied to the intrinsic page size before `region` is interpreted.
   *   region: the rectangle to paint, in scaled pixels, relative to the page's top-left.
   *   canvas: destination. Its backing store is resized to `region`'s dimensions.
   * Returns:
   *   A `RenderHandle`.
   * Raises:
   *   The returned promise rejects on genuine render failures, but resolves quietly when cancelled.
   * Summary:
   *   The one primitive everything else is built from. Painting only the visible region is what
   *   allows a 42x30 inch sheet to be viewed at 800% without allocating a canvas the size of a
   *   billboard.
   */
  renderRegion(
    page: number,
    scale: number,
    region: RegionPx,
    canvas: HTMLCanvasElement,
  ): RenderHandle

  /** Release the document and any worker resources. */
  destroy(): void
}

/**
 * Open a library file as a `RenderSource`.
 *
 * Parameters:
 *   file: the library entry to open.
 * Returns:
 *   Promise of a ready-to-render source.
 * Raises:
 *   Rejects if the bytes cannot be fetched or parsed.
 * Summary:
 *   The only place in the app that dispatches on file kind. Split into dynamic imports so a
 *   session that never opens a PDF never pays for the pdf.js bundle.
 */
export async function openDocument(file: LibraryFile): Promise<RenderSource> {
  if (file.kind === 'pdf') {
    const { openPdfSource } = await import('./pdf')
    return openPdfSource(file.url)
  }
  const { openImageSource } = await import('./raster')
  return openImageSource(file.url)
}

/**
 * A handle for work that finished or failed before it ever started.
 *
 * Parameters:
 *   done: the promise to expose.
 * Returns:
 *   A `RenderHandle` whose `cancel` is a no-op.
 * Raises:
 *   Nothing.
 * Summary:
 *   Lets callers treat trivial cases uniformly instead of null-checking handles.
 */
export function settledHandle(done: Promise<void>): RenderHandle {
  return { done, cancel: () => {} }
}
