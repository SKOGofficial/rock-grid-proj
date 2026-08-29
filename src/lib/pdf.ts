/**
 * pdf.js-backed `RenderSource`.
 *
 * Summary:
 *   Wraps a `PDFDocumentProxy` so the rest of the app sees only the small `RenderSource`
 *   surface. Two details carry their weight here: pages are cached (pdf.js re-parses a page
 *   proxy on every `getPage` miss, and the viewer asks for the same page dozens of times while
 *   the user scrolls), and every render is cancellable.
 */

import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
// `?url` is the form that survives Vite's dependency handling; `new URL(..., import.meta.url)`
// against a file inside node_modules is the variant that breaks on build.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import type { PageSize } from '../types'
import type { RegionPx, RenderHandle, RenderSource } from './source'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** PDF user-space units are 1/72 inch by definition. */
const PDF_UNITS_PER_INCH = 72

/**
 * Open a PDF as a `RenderSource`.
 *
 * Parameters:
 *   url: path the document bytes can be fetched from, e.g. `/data/set.pdf`.
 * Returns:
 *   Promise of a `RenderSource` over the document.
 * Raises:
 *   Rejects if the document cannot be fetched or is not a valid PDF.
 * Summary:
 *   Uses ranged loading so the first page paints without waiting on the whole file - the seed
 *   drawing set is 21 MB, and the data-library plugin answers 206s specifically to make this work.
 */
export async function openPdfSource(url: string): Promise<RenderSource> {
  const task = pdfjs.getDocument({
    url,
    // Ranged/streamed loading. 256 KB chunks keep the first paint quick without thrashing.
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: true,
    disableStream: false,
  })
  const doc: PDFDocumentProxy = await task.promise
  const pageCache = new Map<number, Promise<PDFPageProxy>>()
  /**
   * Tail of the render chain for each page.
   *
   * pdf.js will not run two `render()` calls against the same page proxy at once: the second one
   * never resolves, and the viewer is left showing a blank canvas forever. Zooming and scrolling
   * produce exactly that overlap - a new render is requested while the previous is still in
   * flight - so renders are queued per page and each waits for its predecessor to settle.
   */
  const renderChain = new Map<number, Promise<void>>()
  let destroyed = false

  /**
   * Fetch a page proxy, memoized.
   *
   * Parameters:
   *   page: 1-based page number.
   * Returns:
   *   Promise of the pdf.js page proxy.
   * Raises:
   *   Rejects if the page number is out of range or the document has been destroyed.
   * Summary:
   *   The viewer re-renders on every scroll settle, so uncached `getPage` calls would dominate
   *   the render cost.
   */
  function getPage(page: number): Promise<PDFPageProxy> {
    if (destroyed) return Promise.reject(new Error('Document has been closed'))
    let cached = pageCache.get(page)
    if (!cached) {
      cached = doc.getPage(page)
      pageCache.set(page, cached)
    }
    return cached
  }

  return {
    kind: 'pdf',
    pageCount: doc.numPages,

    scaleForDpi(dpi: number): number {
      return dpi / PDF_UNITS_PER_INCH
    },

    async getPageSize(page: number): Promise<PageSize> {
      const proxy = await getPage(page)
      // scale 1 gives intrinsic points, already corrected for the page's /Rotate entry.
      const viewport = proxy.getViewport({ scale: 1 })
      return { width: viewport.width, height: viewport.height }
    },

    renderRegion(
      page: number,
      scale: number,
      region: RegionPx,
      canvas: HTMLCanvasElement,
    ): RenderHandle {
      let cancelled = false
      let task: { cancel(): void } | null = null
      const previous = renderChain.get(page)

      const done = (async () => {
        // Wait out any earlier render of this page. A cancelled predecessor unwinds immediately,
        // so this costs nothing in the common case of the user out-scrolling the renderer.
        if (previous) await previous
        if (cancelled) return
        const proxy = await getPage(page)
        if (cancelled) return

        const width = Math.max(1, Math.round(region.width))
        const height = Math.max(1, Math.round(region.height))
        canvas.width = width
        canvas.height = height

        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('Could not acquire a 2D canvas context')
        // Drawings are ink on white; without this the untouched margins render black.
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)

        // Shifting the viewport rather than translating the context is what makes this a true
        // partial render: pdf.js clips to the canvas and skips operators outside it.
        const viewport = proxy.getViewport({
          scale,
          offsetX: -region.x,
          offsetY: -region.y,
        })

        const renderTask = proxy.render({ canvas, canvasContext: context, viewport })
        task = renderTask
        try {
          await renderTask.promise
        } catch (error) {
          // A cancelled render is the normal outcome of scrolling, not a failure.
          if (cancelled || (error as { name?: string }).name === 'RenderingCancelledException') return
          throw error
        }
      })()

      // Successors wait on this render regardless of how it ends, so a failure does not wedge the
      // queue for the rest of the session.
      renderChain.set(
        page,
        done.catch(() => {}),
      )

      return {
        done,
        cancel() {
          cancelled = true
          task?.cancel()
        },
      }
    },

    destroy(): void {
      destroyed = true
      pageCache.clear()
      renderChain.clear()
      void doc.destroy()
    },
  }
}
