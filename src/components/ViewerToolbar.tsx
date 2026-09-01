/**
 * Controls for the document viewport: zoom, paging, and the pointer mode.
 *
 * Summary:
 *   Purely presentational - every value is owned by the page above. The one piece of local state
 *   is the page-number field, which needs to tolerate half-typed input like an empty string or
 *   "1" on the way to "142" without snapping back on every keystroke.
 */

import { useEffect, useState } from 'react'

import type { ViewerMode } from './DocumentCanvas'

interface ViewerToolbarProps {
  fileName: string | null
  zoom: number
  minZoom: number
  maxZoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFitPage: () => void
  onFitWidth: () => void
  onActualSize: () => void
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  mode: ViewerMode
  onModeChange: (mode: ViewerMode) => void
  disabled: boolean
  /** Detection strategy in force. `undefined` when no strategy has a backend to choose from yet. */
  strategyId?: string
  /** Strategies with a backend - the only ones a run can actually be sent to. */
  strategyOptions?: { id: string; name: string }[]
  onStrategyChange?: (strategyId: string) => void
}

/**
 * Render the viewer toolbar.
 *
 * Parameters:
 *   props: see `ViewerToolbarProps`.
 * Returns:
 *   The toolbar element.
 * Raises:
 *   Nothing.
 * Summary:
 *   Commits the page field on blur and on Enter, and silently reverts anything out of range.
 */
export function ViewerToolbar({
  fileName,
  zoom,
  minZoom,
  maxZoom,
  onZoomIn,
  onZoomOut,
  onFitPage,
  onFitWidth,
  onActualSize,
  page,
  pageCount,
  onPageChange,
  mode,
  onModeChange,
  disabled,
  strategyId,
  strategyOptions,
  onStrategyChange,
}: ViewerToolbarProps) {
  const [pageDraft, setPageDraft] = useState(String(page))

  useEffect(() => {
    setPageDraft(String(page))
  }, [page])

  /**
   * Apply the typed page number, or restore the current one.
   *
   * Parameters:
   *   None.
   * Returns:
   *   void
   * Raises:
   *   Nothing.
   * Summary:
   *   Out-of-range and non-numeric input reverts rather than erroring; there is nowhere sensible
   *   to show a validation message on a toolbar this size.
   */
  function commitPage(): void {
    const parsed = Number.parseInt(pageDraft, 10)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= pageCount) {
      onPageChange(parsed)
    } else {
      setPageDraft(String(page))
    }
  }

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        <button
          type="button"
          className="tool-button"
          onClick={onZoomOut}
          disabled={disabled || zoom <= minZoom}
          title="Zoom out"
          aria-label="Zoom out"
        >
          &minus;
        </button>
        <span className="tool-readout">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="tool-button"
          onClick={onZoomIn}
          disabled={disabled || zoom >= maxZoom}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
      </div>

      <div className="toolbar__group">
        <button type="button" className="tool-button" onClick={onFitPage} disabled={disabled}>
          Fit page
        </button>
        <button type="button" className="tool-button" onClick={onFitWidth} disabled={disabled}>
          Fit width
        </button>
        <button type="button" className="tool-button" onClick={onActualSize} disabled={disabled}>
          100%
        </button>
      </div>

      <div className="toolbar__group">
        <button
          type="button"
          className="tool-button"
          onClick={() => onPageChange(page - 1)}
          disabled={disabled || page <= 1}
          title="Previous page"
          aria-label="Previous page"
        >
          &#8249;
        </button>
        <input
          className="tool-page-input"
          type="number"
          inputMode="numeric"
          value={pageDraft}
          disabled={disabled}
          aria-label="Page number"
          onChange={(event) => setPageDraft(event.target.value)}
          onBlur={commitPage}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitPage()
              event.currentTarget.blur()
            }
          }}
        />
        <span className="tool-readout">of {pageCount || '-'}</span>
        <button
          type="button"
          className="tool-button"
          onClick={() => onPageChange(page + 1)}
          disabled={disabled || page >= pageCount}
          title="Next page"
          aria-label="Next page"
        >
          &#8250;
        </button>
      </div>

      <div className="toolbar__group">
        <button
          type="button"
          className={'tool-button' + (mode === 'select' ? ' tool-button--active' : '')}
          onClick={() => onModeChange('select')}
          disabled={disabled}
          title="Drag to draw a bounding box"
        >
          Select
        </button>
        <button
          type="button"
          className={'tool-button' + (mode === 'pan' ? ' tool-button--active' : '')}
          onClick={() => onModeChange('pan')}
          disabled={disabled}
          title="Drag to pan (or hold space in Select mode)"
        >
          Pan
        </button>
      </div>

      {strategyOptions && strategyOptions.length > 1 && onStrategyChange && (
        <div className="toolbar__group">
          <select
            className="tool-button"
            value={strategyId}
            disabled={disabled}
            aria-label="Detection strategy"
            onChange={(event) => onStrategyChange(event.target.value)}
          >
            {strategyOptions.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <span className="toolbar__spacer" />
      {fileName && <span className="toolbar__filename">{fileName}</span>}
    </div>
  )
}
