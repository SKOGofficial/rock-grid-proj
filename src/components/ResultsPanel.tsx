/**
 * What the detector found, and the controls for arguing with it.
 *
 * Summary:
 *   The count is the product, but it rests on a cutoff that measurement has shown to be the least
 *   reliable number in the system. So this panel is built around moving that cutoff rather than
 *   around presenting the number.
 *
 *   Dragging the slider re-counts instantly. The reply already carries every candidate down to the
 *   floor, so nothing is refetched and no correlation is repeated - which is the entire reason the
 *   service returns far more matches than it counts.
 */

import type { DetectResponse } from '../types'

interface ResultsPanelProps {
  detection: DetectResponse
  /** The cutoff in force: the user's override, or the service's suggestion. */
  threshold: number
  onThresholdChange: (threshold: number) => void
  /** Return to the service's suggested cutoff. */
  onResetThreshold: () => void
  showNearMisses: boolean
  onToggleNearMisses: () => void
  showHeatmap: boolean
  onToggleHeatmap: () => void
  /** True while a run is fetching the response map after the heatmap toggle was switched on. */
  heatmapPending: boolean
  onClear: () => void
}

/**
 * Render the results panel.
 *
 * Parameters:
 *   props: see `ResultsPanelProps`.
 * Returns:
 *   The panel element.
 * Raises:
 *   Nothing.
 * Summary:
 *   The count shown is recomputed from `matches` on every render rather than read from
 *   `detection.count`, because the user may have moved the cutoff away from the one the service
 *   applied. `detection.count` is the service's answer; this is the current one.
 */
export function ResultsPanel({
  detection,
  threshold,
  onThresholdChange,
  onResetThreshold,
  showNearMisses,
  onToggleNearMisses,
  showHeatmap,
  onToggleHeatmap,
  heatmapPending,
  onClear,
}: ResultsPanelProps) {
  const counted = detection.matches.filter((match) => match.score >= threshold).length
  const moved = Math.abs(threshold - detection.thresholdUsed) > 1e-6

  return (
    <div className="results-panel">
      <div className="results-panel__head">
        <span className="results-panel__label">Matches</span>
        <button
          type="button"
          className="selection-chip__close"
          onClick={onClear}
          title="Clear results"
          aria-label="Clear results"
        >
          &times;
        </button>
      </div>

      <div className="results-panel__count">
        <strong>{counted}</strong>
        <span>
          of {detection.matches.length} candidate{detection.matches.length === 1 ? '' : 's'}
        </span>
      </div>

      {detection.truncated && (
        <p className="results-panel__warning">
          Hit the candidate ceiling - this count is a floor, not a total.
        </p>
      )}

      <label className="results-panel__slider">
        <span>
          Cutoff <b>{threshold.toFixed(3)}</b>
          {moved && (
            <button type="button" className="results-panel__reset" onClick={onResetThreshold}>
              auto {detection.thresholdUsed.toFixed(3)}
            </button>
          )}
        </span>
        <input
          type="range"
          min={detection.floorUsed}
          max={1}
          step={0.001}
          value={threshold}
          onChange={(event) => onThresholdChange(Number(event.target.value))}
          aria-label="Score cutoff"
        />
      </label>

      <div className="results-panel__toggles">
        <label>
          <input type="checkbox" checked={showNearMisses} onChange={onToggleNearMisses} />
          Near misses
        </label>
        <label>
          <input
            type="checkbox"
            checked={showHeatmap}
            onChange={onToggleHeatmap}
            disabled={heatmapPending}
          />
          {heatmapPending ? 'Heatmap...' : 'Heatmap'}
        </label>
      </div>

      <p className="results-panel__meta">
        {Math.round(detection.elapsedMs)} ms &middot; {detection.dpi.toFixed(0)} DPI
      </p>
    </div>
  )
}
