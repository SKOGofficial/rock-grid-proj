/**
 * Bitmap-backed `RenderSource` for PNG/JPEG/WebP sheets.
 *
 * Summary:
 *   A single-page source, so the viewer treats a scanned sheet exactly like page 1 of a PDF.
 *   Decoding happens once into an `ImageBitmap`; every render is then a `drawImage` crop, which
 *   is fast enough that no caching layer is needed.
 */

import type { PageSize } from '../types'
import type { RegionPx, RenderHandle, RenderSource } from './source'

/**
 * Open a bitmap image as a single-page `RenderSource`.
 *
 * Parameters:
 *   url: path the image bytes can be fetched from, e.g. `/data/sheet.png`.
 * Returns:
 *   Promise of a `RenderSource` with `pageCount` 1.
 * Raises:
 *   Rejects if the image cannot be fetched or decoded.
 * Summary:
 *   Uses `createImageBitmap` so decoding happens off the main thread.
 */
export async function openImageSource(url: string): Promise<RenderSource> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load image (HTTP ${response.status})`)
  const bitmap = await createImageBitmap(await response.blob())
  let destroyed = false

  return {
    kind: 'image',
    pageCount: 1,

    scaleForDpi(): number {
      // A bitmap has no physical size and no detail above its native resolution, so crops are
      // taken at 1:1. Upsampling here would invent pixels the detector would then try to match on.
      return 1
    },

    async getPageSize(): Promise<PageSize> {
      return { width: bitmap.width, height: bitmap.height }
    },

    renderRegion(
      _page: number,
      scale: number,
      region: RegionPx,
      canvas: HTMLCanvasElement,
    ): RenderHandle {
      let cancelled = false

      const done = (async () => {
        if (destroyed || cancelled) return

        const width = Math.max(1, Math.round(region.width))
        const height = Math.max(1, Math.round(region.height))
        canvas.width = width
        canvas.height = height

        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('Could not acquire a 2D canvas context')
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)

        // Map the requested region (in scaled pixels) back to source pixels.
        const sourceX = region.x / scale
        const sourceY = region.y / scale
        const sourceWidth = width / scale
        const sourceHeight = height / scale

        // Crisp at high zoom: nearest-neighbour past 2x, smoothed when shrinking. Thin CAD
        // strokes vanish under bilinear filtering when magnified.
        context.imageSmoothingEnabled = scale < 2
        context.imageSmoothingQuality = 'high'
        context.drawImage(
          bitmap,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          width,
          height,
        )
      })()

      return {
        done,
        cancel() {
          cancelled = true
        },
      }
    },

    destroy(): void {
      destroyed = true
      bitmap.close()
    },
  }
}
