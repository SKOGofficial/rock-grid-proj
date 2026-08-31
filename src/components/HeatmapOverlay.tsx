/**
 * The correlation response map, drawn over the drawing.
 *
 * Summary:
 *   Boxes answer two of the three questions you have when a count comes back wrong - which
 *   candidates were cut, and which were merged. They cannot answer the third: whether a symbol the
 *   detector missed produced *any* signal at all. A blank patch of drawing looks identical whether
 *   the template scored 0.34 there or 0.02, and those call for completely different fixes.
 *
 *   The map arrives as grayscale rather than a colour image, which is what makes the threshold
 *   contour live: moving a slider redraws the line here, with no request to the service.
 */

import { useCallback, useEffect, useRef } from 'react'

interface HeatmapOverlayProps {
  /** Grayscale PNG data URL from `DetectResponse.heatmapPng`. */
  pngDataUrl: string
  /** Current cutoff, drawn as a contour line. */
  threshold: number
  /** Scores below this are painted transparent - it is the floor the map was collected to. */
  floor: number
}

/** Half-width of the contour band, in score units. */
const CONTOUR_BAND = 0.006

/**
 * Render the heatmap layer.
 *
 * Parameters:
 *   props: see `HeatmapOverlayProps`.
 * Returns:
 *   A canvas covering the stage.
 * Raises:
 *   Nothing; a map that fails to decode simply does not paint.
 * Summary:
 *   The map is page-sized and centre-aligned by construction on the service side, so it covers the
 *   stage exactly and needs no offset. Painting happens at the map's own resolution - roughly
 *   1400 px on its long edge - and CSS scales it to the stage, so the cost does not grow with zoom.
 */
export function HeatmapOverlay({ pngDataUrl, threshold, floor }: HeatmapOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sourceRef = useRef<ImageData | null>(null)

  /**
   * Colour-map the decoded scores onto the visible canvas.
   *
   * Parameters:
   *   None; reads the decoded map and the current threshold from refs and props.
   * Returns:
   *   void
   * Raises:
   *   Nothing.
   * Summary:
   *   A warm ramp under `multiply` blending, so the paper stays white where nothing correlated and
   *   darkens towards red where something did. The contour is a hard band at the cutoff, which is
   *   what turns "this peak is just under the line" from a number into something visible.
   */
  const paint = useCallback(() => {
    const source = sourceRef.current
    const canvas = canvasRef.current
    if (!source || !canvas) return

    canvas.width = source.width
    canvas.height = source.height
    const context = canvas.getContext('2d')
    if (!context) return

    const output = context.createImageData(source.width, source.height)
    const input = source.data
    const pixels = output.data
    const span = Math.max(1e-6, 1 - floor)

    for (let i = 0; i < pixels.length; i += 4) {
      const score = input[i] / 255

      if (score < floor) {
        pixels[i + 3] = 0
        continue
      }

      if (Math.abs(score - threshold) < CONTOUR_BAND) {
        pixels[i] = 20
        pixels[i + 1] = 70
        pixels[i + 2] = 220
        pixels[i + 3] = 230
        continue
      }

      const t = Math.min(1, (score - floor) / span)
      pixels[i] = 255
      pixels[i + 1] = Math.round(235 - 205 * t)
      pixels[i + 2] = Math.round(130 - 110 * t)
      pixels[i + 3] = Math.round((0.12 + 0.68 * t) * 255)
    }

    context.putImageData(output, 0, 0)
  }, [floor, threshold])

  // Decode once per map. Kept separate from painting so dragging the threshold does not re-decode.
  useEffect(() => {
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      const offscreen = document.createElement('canvas')
      offscreen.width = image.width
      offscreen.height = image.height
      const context = offscreen.getContext('2d', { willReadFrequently: true })
      if (!context) return
      context.drawImage(image, 0, 0)
      sourceRef.current = context.getImageData(0, 0, image.width, image.height)
      paint()
    }
    image.src = pngDataUrl
    return () => {
      cancelled = true
      sourceRef.current = null
    }
    // `paint` is intentionally excluded: it changes with the threshold, and re-decoding the image
    // on every slider tick is exactly what this split exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pngDataUrl])

  useEffect(() => {
    paint()
  }, [paint])

  return <canvas ref={canvasRef} className="heatmap-layer" />
}
