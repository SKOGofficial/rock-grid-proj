/**
 * The hovering exemplar chip.
 *
 * Summary:
 *   Floats in the corner of the viewport showing exactly what the user captured - not a screen
 *   grab of the box, but the 300 DPI crop that a detector would actually receive. That is the
 *   point of showing it: if the thumbnail is unreadable, the query is unreadable, and no
 *   downstream strategy will do better.
 */

import { useState } from 'react'

import { downloadDataUrl, exemplarFilename } from '../lib/crop'
import type { Selection } from '../types'

interface SelectionChipProps {
  selection: Selection
  onClear: () => void
  /** Run detection against this exemplar. */
  onDetect: () => void
  detecting: boolean
  /** Message from a failed run, shown inline. */
  error: string | null
}

/**
 * Render the exemplar chip.
 *
 * Parameters:
 *   props: see `SelectionChipProps`.
 * Returns:
 *   The chip element.
 * Raises:
 *   Nothing; a clipboard failure is reported in the button label rather than thrown.
 * Summary:
 *   Copy JSON emits the `Selection` object verbatim - the same shape the detection backend will
 *   receive - so a prototype can be developed against a real query before any of this is wired up.
 */
export function SelectionChip({
  selection,
  onClear,
  onDetect,
  detecting,
  error,
}: SelectionChipProps) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const { rect } = selection

  /**
   * Copy the selection to the clipboard as JSON.
   *
   * Parameters:
   *   None.
   * Returns:
   *   Promise resolving once the label has been updated.
   * Raises:
   *   Nothing.
   * Summary:
   *   The thumbnail is stripped from the copy; a base64 PNG would bury the coordinates that make
   *   the payload useful to read.
   */
  async function copyJson(): Promise<void> {
    const { thumbnailDataUrl: _thumbnail, ...payload } = selection
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setCopied('done')
    } catch {
      setCopied('failed')
    }
    window.setTimeout(() => setCopied('idle'), 1600)
  }

  return (
    <div className="selection-chip">
      <div className="selection-chip__head">
        <span className="selection-chip__label">Exemplar</span>
        <button
          type="button"
          className="selection-chip__close"
          onClick={onClear}
          title="Clear selection"
          aria-label="Clear selection"
        >
          &times;
        </button>
      </div>

      <div className="selection-chip__frame">
        <img src={selection.thumbnailDataUrl} alt="The region selected on the drawing" />
      </div>

      <div className="selection-chip__meta">
        <span>
          Page {selection.page} &middot; crop
          <b>
            {selection.cropSize.width} &times; {selection.cropSize.height} px @ {selection.cropDpi}{' '}
            DPI
          </b>
        </span>
        <span>
          Normalized box
          <b>
            {rect.x0.toFixed(4)}, {rect.y0.toFixed(4)}
            <br />
            {rect.x1.toFixed(4)}, {rect.y1.toFixed(4)}
          </b>
        </span>
      </div>

      <div className="selection-chip__actions">
        <button type="button" className="tool-button" onClick={copyJson}>
          {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Blocked' : 'Copy JSON'}
        </button>
        <button
          type="button"
          className="tool-button"
          onClick={() => downloadDataUrl(selection.thumbnailDataUrl, exemplarFilename(selection))}
        >
          Save PNG
        </button>
      </div>

      <button
        type="button"
        className="selection-chip__detect"
        onClick={onDetect}
        disabled={detecting}
      >
        {detecting ? 'Searching...' : 'Find matches'}
      </button>

      {error && <p className="selection-chip__error">{error}</p>}
    </div>
  )
}
