/**
 * The layer the exemplar box is drawn on.
 *
 * Summary:
 *   Sits over the render canvas at exactly the stage's size, turns a left-drag into a rectangle,
 *   and paints the committed selection. It works in stage CSS pixels while dragging and converts
 *   to normalized page coordinates once - at commit - so nothing downstream ever sees a pixel.
 */

import { useCallback, useRef, useState } from 'react'

import type { NormRect } from '../types'
import { isDegenerate, rectFromDrag, rectToPixels } from '../lib/geometry'

interface SelectionOverlayProps {
  /** Stage size in CSS pixels: intrinsic page size multiplied by the current zoom. */
  stageWidth: number
  stageHeight: number
  /** The committed selection for the page on screen, or null. */
  selection: NormRect | null
  /** Whether left-drag draws. When false the layer is transparent to pointer events so panning works. */
  enabled: boolean
  /** Called with the new rectangle when a drag commits. */
  onSelect: (rect: NormRect) => void
}

interface DragState {
  pointerId: number
  anchorX: number
  anchorY: number
}

/**
 * Render the selection layer.
 *
 * Parameters:
 *   props: see `SelectionOverlayProps`.
 * Returns:
 *   The overlay element.
 * Raises:
 *   Nothing.
 * Summary:
 *   Uses pointer capture so a drag that leaves the page - very common when boxing a symbol near
 *   the sheet edge - still completes on release instead of being silently dropped.
 */
export function SelectionOverlay({
  stageWidth,
  stageHeight,
  selection,
  enabled,
  onSelect,
}: SelectionOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [draft, setDraft] = useState<NormRect | null>(null)

  /**
   * Convert a pointer event to coordinates within the stage.
   *
   * Parameters:
   *   event: the pointer event.
   * Returns:
   *   `{ x, y }` in stage CSS pixels.
   * Raises:
   *   Nothing.
   * Summary:
   *   Reads the layer's box each time rather than caching it, because scrolling moves the layer
   *   between events.
   */
  const toStagePoint = useCallback((event: React.PointerEvent): { x: number; y: number } => {
    const bounds = layerRef.current?.getBoundingClientRect()
    if (!bounds) return { x: 0, y: 0 }
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }, [])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || event.button !== 0) return
      const point = toStagePoint(event)
      dragRef.current = { pointerId: event.pointerId, anchorX: point.x, anchorY: point.y }
      event.currentTarget.setPointerCapture(event.pointerId)
      setDraft(rectFromDrag(point.x, point.y, point.x, point.y, stageWidth, stageHeight))
      event.preventDefault()
    },
    [enabled, stageHeight, stageWidth, toStagePoint],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const point = toStagePoint(event)
      setDraft(rectFromDrag(drag.anchorX, drag.anchorY, point.x, point.y, stageWidth, stageHeight))
    },
    [stageHeight, stageWidth, toStagePoint],
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      dragRef.current = null
      const point = toStagePoint(event)
      const rect = rectFromDrag(drag.anchorX, drag.anchorY, point.x, point.y, stageWidth, stageHeight)
      setDraft(null)
      // A stray click in Select mode should not wipe out a carefully drawn exemplar.
      if (isDegenerate(rect, stageWidth, stageHeight)) return
      onSelect(rect)
    },
    [onSelect, stageHeight, stageWidth, toStagePoint],
  )

  const handlePointerCancel = useCallback(() => {
    dragRef.current = null
    setDraft(null)
  }, [])

  const active = draft ?? selection
  const pixels = active ? rectToPixels(active, stageWidth, stageHeight) : null

  return (
    <div
      ref={layerRef}
      className={'selection-layer' + (enabled ? ' selection-layer--select' : '')}
      style={{ pointerEvents: enabled ? 'auto' : 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {pixels && (
        <div
          className={'selection-box' + (draft ? ' selection-box--draft' : '')}
          style={{
            left: `${pixels.left}px`,
            top: `${pixels.top}px`,
            width: `${pixels.width}px`,
            height: `${pixels.height}px`,
          }}
        >
          <span className="selection-box__size">
            {Math.round(pixels.width)} x {Math.round(pixels.height)} px
          </span>
          <span className="selection-box__handle selection-box__handle--nw" />
          <span className="selection-box__handle selection-box__handle--ne" />
          <span className="selection-box__handle selection-box__handle--sw" />
          <span className="selection-box__handle selection-box__handle--se" />
        </div>
      )}
    </div>
  )
}
