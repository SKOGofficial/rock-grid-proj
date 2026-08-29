/**
 * Client for the detection backend - the seam where each strategy's program plugs in.
 *
 * Summary:
 *   Nothing is implemented yet, and that is the point. This module fixes the contract now
 *   (`DetectRequest` in, `DetectResponse` out, rectangles normalized) so that the computer-vision
 *   work described in FUTURE_WORK.md can be built and swapped in without the UI changing. Every
 *   strategy is reached through `runStrategy`; there is no second path.
 */

import type { DetectRequest, DetectResponse, Selection } from '../types'

/** Thrown by `runStrategy` for any strategy whose backend does not exist yet. */
export class NotImplementedError extends Error {
  readonly strategyId: string

  constructor(strategyId: string) {
    super(`The "${strategyId}" strategy has no backend yet. See FUTURE_WORK.md.`)
    this.name = 'NotImplementedError'
    this.strategyId = strategyId
  }
}

/**
 * Turn a user selection into a detection request.
 *
 * Parameters:
 *   strategyId: which strategy to run.
 *   selection: the exemplar the user drew.
 *   scope: `page` to search only the exemplar's page, `document` for the whole file.
 * Returns:
 *   A `DetectRequest` ready to post.
 * Raises:
 *   Nothing.
 * Summary:
 *   The request deliberately carries no pixels - only the normalized box and the DPI. The
 *   backend re-rasterizes from the same source file, which avoids a re-encoding round trip and
 *   guarantees the exemplar and the search page come from an identical rendering pipeline.
 */
export function buildDetectRequest(
  strategyId: string,
  selection: Selection,
  scope: 'page' | 'document' = 'page',
): DetectRequest {
  return {
    strategyId,
    fileName: selection.fileName,
    page: selection.page,
    bbox: selection.rect,
    dpi: selection.cropDpi,
    scope,
  }
}

/**
 * Run a detection strategy.
 *
 * Parameters:
 *   request: the detection request, normally from `buildDetectRequest`.
 *   signal: optional abort signal.
 * Returns:
 *   Promise of the strategy's matches.
 * Raises:
 *   `NotImplementedError` today, for every strategy. Once a backend exists it will throw on
 *   transport and server errors instead.
 * Summary:
 *   The single call site for all detection work. When the first strategy lands, replace the body
 *   with `POST /api/detect` and delete the throw - no caller changes.
 */
export async function runStrategy(
  request: DetectRequest,
  _signal?: AbortSignal,
): Promise<DetectResponse> {
  throw new NotImplementedError(request.strategyId)
}
