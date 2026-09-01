/**
 * Detected instances, drawn over the drawing.
 *
 * Summary:
 *   Two states, and the second is the point. Candidates at or above the cutoff are drawn solid and
 *   counted; candidates below it are drawn faintly and are not.
 *
 *   Showing the near misses is what the service's oversized reply buys: drawn, the boundary is a
 *   judgement the user can make in a glance; hidden, it is a number with nothing behind it.
 *
 *   It also earned its keep as a diagnostic. The three instances that sat just beneath the line on
 *   sheet E4 - long read as the cutoff being set slightly too high - were visibly the *mirrored*
 *   ones once drawn, which is how the missing reflections in the orientation bank were found at
 *   all. A count alone would never have shown that; three faint boxes in a row did.
 *
 *   Positions come from the same normalized rectangles the exemplar uses, so matches track the
 *   drawing through zoom and resize without any work here.
 */

import { rectToPixels } from '../lib/geometry'
import type { DetectMatch } from '../types'

interface MatchOverlayProps {
  /** Stage size in CSS pixels: intrinsic page size multiplied by the current zoom. */
  stageWidth: number
  stageHeight: number
  /** Matches for the page on screen. Filtering by page is the caller's job. */
  matches: DetectMatch[]
  /** Scores at or above this are counted; below it they are near misses. */
  threshold: number
  /** Whether to draw the near misses at all. */
  showNearMisses: boolean
}

/**
 * Render the match layer.
 *
 * Parameters:
 *   props: see `MatchOverlayProps`.
 * Returns:
 *   The overlay element, or null when there is nothing to draw.
 * Raises:
 *   Nothing.
 * Summary:
 *   Transparent to pointer events throughout, so a new exemplar can be drawn straight over a set
 *   of results without clearing them first.
 */
export function MatchOverlay({
  stageWidth,
  stageHeight,
  matches,
  threshold,
  showNearMisses,
}: MatchOverlayProps) {
  if (matches.length === 0) return null

  return (
    <div className="match-layer">
      {matches.map((match, index) => {
        const counted = match.score >= threshold
        if (!counted && !showNearMisses) return null

        const pixels = rectToPixels(match.bbox, stageWidth, stageHeight)
        return (
          <div
            key={`${match.page}-${index}`}
            className={'match-box' + (counted ? '' : ' match-box--near')}
            style={{
              left: `${pixels.left}px`,
              top: `${pixels.top}px`,
              width: `${pixels.width}px`,
              height: `${pixels.height}px`,
            }}
            title={`score ${match.score.toFixed(3)}${
              match.rotationDeg ? ` · ${match.rotationDeg}°` : ''
            }${match.mirrored ? ' · mirrored' : ''}${counted ? '' : ' · below cutoff'}`}
          />
        )
      })}
    </div>
  )
}
