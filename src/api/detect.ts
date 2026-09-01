/**
 * Client for the detection service - the seam every strategy is reached through.
 *
 * Summary:
 *   `runStrategy` is the single call site for all detection work. Strategies with no backend
 *   answer 501 and surface here as `NotImplementedError`, so adding one never means changing a
 *   caller.
 *
 *   The service runs as a separate process (`npm run cv`), proxied by Vite at `/api/detect`. The
 *   most common failure in development is therefore that it simply is not running, which is why
 *   that case gets its own message rather than surfacing as a bare "Failed to fetch".
 */

import type { DetectOptions, DetectRequest, DetectResponse, Selection } from '../types'

/**
 * Resolution the backend searches at.
 *
 * Deliberately not `Selection.cropDpi`. That is 300, chosen so the exemplar thumbnail is legible;
 * searching at it would rasterize 78 MP instead of 19.4 and produce ~280 MB correlation maps per
 * orientation, for detail symbol matching does not use. The two numbers are unrelated and sat
 * close enough together to be confused once already.
 */
export const SEARCH_DPI = 150

/**
 * Options applied to every run unless a caller overrides them.
 *
 * `mirror` is on deliberately, and this constant is the whole of the fix for reflected symbols.
 * The matcher has always been able to search them - the bank in `_oriented_templates` covers all
 * eight orientations of the square - but nothing ever asked it to, so the app searched four.
 *
 * Leaving reflections out does not fail loudly, which is why it went unnoticed. A mirrored
 * instance still correlates against the unmirrored template - by however much the symbol resembles
 * its own reflection - so it lands in the reply as a second cluster below the upright instances.
 * A gap between two clusters is precisely what the service's automatic cutoff looks for, so the
 * usual outcome is a confident count with the mirrored instances ranked, then cut. Doors and
 * similar symbols are placed mirrored as a matter of course.
 *
 * The cost is a second pass over the same page - roughly double the elapsed time - and on *chiral*
 * symbols, anything carrying text or digits, a mirrored hit is a false positive rather than an
 * instance. That is what the toggle in the results panel is for.
 */
export const DEFAULT_DETECT_OPTIONS: DetectOptions = { mirror: true }

/** Thrown for any strategy whose backend does not exist yet - the service's 501. */
export class NotImplementedError extends Error {
  readonly strategyId: string

  constructor(strategyId: string) {
    super(`The "${strategyId}" strategy has no backend yet. See FUTURE_WORK.md.`)
    this.name = 'NotImplementedError'
    this.strategyId = strategyId
  }
}

/** Thrown when the detection service cannot be reached at all. */
export class ServiceUnavailableError extends Error {
  constructor() {
    super('The detection service is not running. Start it with `npm run cv` - see cv/README.md.')
    this.name = 'ServiceUnavailableError'
  }
}

/**
 * Turn a user selection into a detection request.
 *
 * Parameters:
 *   strategyId: which strategy to run.
 *   selection: the exemplar the user drew.
 *   scope: `page` to search only the exemplar's page. `document` is not implemented.
 *   options: overrides layered over `DEFAULT_DETECT_OPTIONS`.
 * Returns:
 *   A `DetectRequest` ready to post.
 * Raises:
 *   Nothing.
 * Summary:
 *   Carries the normalized box and a DPI, never pixels. The backend re-rasterizes both the page
 *   and the template from the same source at the same resolution, which is what guarantees they
 *   cannot differ in scale - and normalized cross-correlation is not scale-invariant.
 *
 *   Options are merged here rather than assembled at the call site so that every request carries
 *   the defaults. Setting only the option you care about used to mean sending only that option,
 *   which is how mirroring stayed off: the one caller set `includeHeatmap` and nothing else, and
 *   the service's own default supplied the rest.
 */
export function buildDetectRequest(
  strategyId: string,
  selection: Selection,
  scope: 'page' | 'document' = 'page',
  options: DetectOptions = {},
): DetectRequest {
  return {
    strategyId,
    fileName: selection.fileName,
    page: selection.page,
    bbox: selection.rect,
    dpi: SEARCH_DPI,
    scope,
    options: { ...DEFAULT_DETECT_OPTIONS, ...options },
  }
}

/**
 * Extract a readable message from a failed response.
 *
 * Parameters:
 *   response: the non-2xx response.
 * Returns:
 *   Promise of a message fit to show a user.
 * Raises:
 *   Nothing; falls back to the status text.
 * Summary:
 *   FastAPI reports errors two different ways. Deliberate refusals put a string in `detail`;
 *   validation failures put an array of `{msg, loc}` objects there instead. Rendering the array
 *   case naively yields "[object Object]", so the two are unpacked separately.
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown }
    const detail = body.detail

    if (typeof detail === 'string') return detail

    if (Array.isArray(detail)) {
      return detail
        .map((item) => {
          const entry = item as { msg?: string; loc?: unknown[] }
          const field = Array.isArray(entry.loc) ? entry.loc.slice(1).join('.') : ''
          return field ? `${field}: ${entry.msg ?? 'invalid'}` : (entry.msg ?? 'invalid')
        })
        .join('; ')
    }
  } catch {
    // Fall through to the status line.
  }
  return `Detection failed (HTTP ${response.status})`
}

/**
 * Run a detection strategy.
 *
 * Parameters:
 *   request: the detection request, normally from `buildDetectRequest`.
 *   signal: optional abort signal, so a superseded run can be cancelled.
 * Returns:
 *   Promise of the strategy's matches.
 * Raises:
 *   `NotImplementedError` when the strategy has no backend.
 *   `ServiceUnavailableError` when the service is unreachable.
 *   `Error` carrying the service's own message for anything else.
 * Summary:
 *   The only path to detection. Note the reply carries candidates on both sides of the cutoff -
 *   `matches.length` is larger than `count` by design; see `DetectResponse`.
 */
export async function runStrategy(
  request: DetectRequest,
  signal?: AbortSignal,
): Promise<DetectResponse> {
  let response: Response
  try {
    response = await fetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (cause) {
    // An aborted request is the caller's own doing and must not be reported as an outage.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ServiceUnavailableError()
  }

  if (response.status === 501) throw new NotImplementedError(request.strategyId)
  if (!response.ok) throw new Error(await readErrorMessage(response))

  return (await response.json()) as DetectResponse
}
