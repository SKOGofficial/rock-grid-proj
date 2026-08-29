/**
 * Conversions between normalized page rectangles and the pixel rectangles used for painting.
 *
 * Summary:
 *   Every pixel rectangle in the app is produced here and discarded within the frame that drew
 *   it. Keeping the conversions in one file is what makes "the selection is stored normalized"
 *   an enforceable rule rather than a convention.
 */

import type { NormRect } from '../types'

/** A rectangle in CSS pixels, relative to the page stage's top-left corner. */
export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Clamp a number into a closed interval.
 *
 * Parameters:
 *   value, min, max: self-explanatory.
 * Returns:
 *   `value` restricted to `[min, max]`.
 * Raises:
 *   Nothing.
 * Summary:
 *   Used to keep drags from producing rectangles that hang off the page.
 */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Build a normalized rectangle from two drag points.
 *
 * Parameters:
 *   ax, ay: the anchor point in stage pixels (where the drag began).
 *   bx, by: the current pointer position in stage pixels.
 *   stageWidth, stageHeight: the stage's current size in CSS pixels.
 * Returns:
 *   A `NormRect` with `x0 <= x1` and `y0 <= y1`, clamped to the page.
 * Raises:
 *   Nothing.
 * Summary:
 *   Handles all four drag directions by sorting the corners, and divides by the stage size so
 *   the result is independent of the zoom level the drag happened at.
 */
export function rectFromDrag(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  stageWidth: number,
  stageHeight: number,
): NormRect {
  const safeWidth = Math.max(1, stageWidth)
  const safeHeight = Math.max(1, stageHeight)
  return {
    x0: clamp(Math.min(ax, bx) / safeWidth, 0, 1),
    y0: clamp(Math.min(ay, by) / safeHeight, 0, 1),
    x1: clamp(Math.max(ax, bx) / safeWidth, 0, 1),
    y1: clamp(Math.max(ay, by) / safeHeight, 0, 1),
  }
}

/**
 * Project a normalized rectangle onto a stage of a given size.
 *
 * Parameters:
 *   rect: the normalized rectangle.
 *   stageWidth, stageHeight: the stage's current size in CSS pixels.
 * Returns:
 *   The equivalent `PixelRect`.
 * Raises:
 *   Nothing.
 * Summary:
 *   Called on every paint. Because the stage size already folds in the zoom factor, the box
 *   tracks the drawing automatically at any magnification.
 */
export function rectToPixels(rect: NormRect, stageWidth: number, stageHeight: number): PixelRect {
  const left = rect.x0 * stageWidth
  const top = rect.y0 * stageHeight
  return {
    left,
    top,
    width: (rect.x1 - rect.x0) * stageWidth,
    height: (rect.y1 - rect.y0) * stageHeight,
  }
}

/**
 * Scale a normalized rectangle into a render-pixel region.
 *
 * Parameters:
 *   rect: the normalized rectangle.
 *   pageWidth, pageHeight: intrinsic page size.
 *   scale: render scale that will be applied to the page.
 * Returns:
 *   `{ x, y, width, height }` in rendered pixels, rounded outwards so nothing is clipped.
 * Raises:
 *   Nothing.
 * Summary:
 *   The bridge from "what the user drew" to "what to rasterize" - used for the exemplar crop.
 */
export function rectToRegion(
  rect: NormRect,
  pageWidth: number,
  pageHeight: number,
  scale: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.floor(rect.x0 * pageWidth * scale)
  const y = Math.floor(rect.y0 * pageHeight * scale)
  const right = Math.ceil(rect.x1 * pageWidth * scale)
  const bottom = Math.ceil(rect.y1 * pageHeight * scale)
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  }
}

/**
 * Decide whether a drag produced a real rectangle or was effectively a click.
 *
 * Parameters:
 *   rect: the normalized rectangle.
 *   stageWidth, stageHeight: the stage size the drag happened on.
 *   minimumPixels: smallest accepted edge length in CSS pixels (default 4).
 * Returns:
 *   `true` when either edge is shorter than `minimumPixels`.
 * Raises:
 *   Nothing.
 * Summary:
 *   Without this, a stray click while in Select mode would silently replace a carefully drawn
 *   exemplar with a zero-area box.
 */
export function isDegenerate(
  rect: NormRect,
  stageWidth: number,
  stageHeight: number,
  minimumPixels = 4,
): boolean {
  return (
    (rect.x1 - rect.x0) * stageWidth < minimumPixels ||
    (rect.y1 - rect.y0) * stageHeight < minimumPixels
  )
}

/**
 * Format a byte count for the file list.
 *
 * Parameters:
 *   bytes: size in bytes.
 * Returns:
 *   A short human-readable string, e.g. `20.9 MB`.
 * Raises:
 *   Nothing.
 * Summary:
 *   Presentation helper; lives here to avoid a one-function module.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
