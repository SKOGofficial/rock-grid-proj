/**
 * Turning a drawn rectangle into an exemplar.
 *
 * Summary:
 *   The crop is re-rendered from the source document at a fixed DPI rather than scraped off the
 *   on-screen canvas. That distinction matters: a template captured at 40% zoom would be a
 *   handful of blurred pixels, and every downstream matcher - correlation, patch embedding,
 *   keypoints - inherits the quality of this one image. Re-rendering makes the exemplar identical
 *   whether the user drew it zoomed out or zoomed in.
 */

import type { NormRect, PageSize, Selection } from '../types'
import { rectToRegion } from './geometry'
import type { RenderSource } from './source'

/**
 * Rasterization DPI for exemplar crops.
 *
 * 300 DPI is the working resolution for symbol detection on architectural sheets: a receptacle
 * symbol is roughly 3/16 inch on a printed sheet, so ~56 px across here - enough structure for a
 * descriptor, small enough to correlate cheaply.
 */
export const CROP_DPI = 300

/** Upper bound on the crop's long edge, in pixels. Guards against selecting a whole sheet. */
const MAX_CROP_EDGE = 2048

/**
 * Render the selected region and package it as a `Selection`.
 *
 * Parameters:
 *   source: the open document to render from.
 *   fileName: name of the library file, carried into the selection for the backend's benefit.
 *   page: 1-based page the rectangle was drawn on.
 *   rect: the rectangle, in normalized page coordinates.
 * Returns:
 *   Promise of a fully populated `Selection`, including the PNG data URL of the crop.
 * Raises:
 *   Rejects if the page cannot be rendered.
 * Summary:
 *   Renders at `CROP_DPI`, backing off proportionally if that would produce an oversized image,
 *   and records the DPI actually used so the detection backend can rasterize the search page to
 *   match.
 */
export async function createSelection(
  source: RenderSource,
  fileName: string,
  page: number,
  rect: NormRect,
): Promise<Selection> {
  const pageSize: PageSize = await source.getPageSize(page)

  let scale = source.scaleForDpi(CROP_DPI)
  let region = rectToRegion(rect, pageSize.width, pageSize.height, scale)

  // Back off if the request is enormous - selecting an entire D-size sheet at 300 DPI would be a
  // 12,600 px canvas. Scale down rather than refuse, and report the DPI that was really used.
  const longEdge = Math.max(region.width, region.height)
  let effectiveDpi = CROP_DPI
  if (longEdge > MAX_CROP_EDGE) {
    const reduction = MAX_CROP_EDGE / longEdge
    scale *= reduction
    effectiveDpi = CROP_DPI * reduction
    region = rectToRegion(rect, pageSize.width, pageSize.height, scale)
  }

  const canvas = document.createElement('canvas')
  await source.renderRegion(page, scale, region, canvas).done

  return {
    fileName,
    page,
    rect,
    pageSize,
    thumbnailDataUrl: canvas.toDataURL('image/png'),
    cropDpi: Math.round(effectiveDpi),
    cropSize: { width: canvas.width, height: canvas.height },
    createdAt: new Date().toISOString(),
  }
}

/**
 * Save a data URL to disk under a given filename.
 *
 * Parameters:
 *   dataUrl: the `data:` URL to save.
 *   filename: suggested filename.
 * Returns:
 *   void
 * Raises:
 *   Nothing.
 * Summary:
 *   Lets the exemplar leave the browser as a PNG, so a detection prototype can be developed
 *   against a real template before any of this is wired to a backend.
 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/**
 * Build a filesystem-safe filename for an exemplar crop.
 *
 * Parameters:
 *   selection: the selection being exported.
 * Returns:
 *   A filename such as `skanska-drawing-set_p142_exemplar.png`.
 * Raises:
 *   Nothing.
 * Summary:
 *   Keeps the document and page in the filename so a folder of exported templates stays legible.
 */
export function exemplarFilename(selection: Selection): string {
  const stem = selection.fileName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-')
  return `${stem}_p${selection.page}_exemplar.png`
}
