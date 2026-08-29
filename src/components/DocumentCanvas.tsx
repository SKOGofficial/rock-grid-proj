/**
 * The document viewport: a scrollable stage that paints one page of a `RenderSource`.
 *
 * Summary:
 *   Only the visible region of the page is rasterized, not the whole page. On a 42x30 inch
 *   architectural sheet that distinction is the difference between a usable viewer and one that
 *   either runs out of canvas memory or serves a blurry image: at 800% zoom a full-page canvas
 *   would be 24,000 px wide, while the visible region is never much larger than the window.
 *
 *   Three refinements keep it from feeling like a slideshow. Renders go to an offscreen canvas
 *   and are swapped in on completion, so the view never flashes white. Superseded renders are
 *   cancelled rather than awaited. And while a new zoom level is rasterizing, the previous canvas
 *   is CSS-scaled into position, so zooming responds immediately and merely sharpens a moment later.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { NormRect, PageSize } from '../types'
import { clamp } from '../lib/geometry'
import type { RenderSource } from '../lib/source'
import { SelectionOverlay } from './SelectionOverlay'

/** Padding between the stage and the viewport edge, in CSS pixels. Mirrors `.viewer__scroll`. */
export const STAGE_PADDING = 32

/** Extra margin rendered beyond the viewport so small scrolls do not trigger a re-render. */
const OVERSCAN = 384

/** Quiet period after scrolling stops before re-rendering, in milliseconds. */
const SCROLL_SETTLE_MS = 90

/**
 * Device pixel ratio ceiling. Above 2x the extra pixels are invisible on these drawings but the
 * canvas area - and therefore the render time - keeps growing quadratically.
 */
const MAX_DEVICE_PIXEL_RATIO = 2

export type ViewerMode = 'select' | 'pan'

export interface ViewerStatus {
  state: 'empty' | 'loading' | 'ready' | 'error'
  message?: string
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface RenderedState {
  region: Rect
  zoom: number
  page: number
}

interface DocumentCanvasProps {
  source: RenderSource | null
  /** 1-based. */
  page: number
  pageSize: PageSize | null
  zoom: number
  mode: ViewerMode
  /** Committed selection, already filtered to the page on screen. */
  selection: NormRect | null
  onSelect: (rect: NormRect) => void
  onZoomChange: (zoom: number) => void
  /** Reports the scroll viewport's inner size so the parent can compute fit-to-page zoom. */
  onViewportResize: (size: PageSize) => void
  status: ViewerStatus
  minZoom: number
  maxZoom: number
  /** Hold off rendering - set while a freshly opened document is still waiting for its initial fit. */
  suspended?: boolean
}

/**
 * The visible rectangle of the stage, in stage CSS pixels.
 *
 * Parameters:
 *   scrollEl: the scroll container.
 *   stageEl: the page stage inside it.
 * Returns:
 *   The viewport rectangle expressed in the stage's own coordinate space.
 * Raises:
 *   Nothing.
 * Summary:
 *   `offsetLeft`/`offsetTop` account for the container padding and for the auto margins that
 *   centre a page smaller than the viewport.
 */
function visibleRect(scrollEl: HTMLElement, stageEl: HTMLElement): Rect {
  return {
    x: scrollEl.scrollLeft - stageEl.offsetLeft,
    y: scrollEl.scrollTop - stageEl.offsetTop,
    width: scrollEl.clientWidth,
    height: scrollEl.clientHeight,
  }
}

/**
 * The rectangle to rasterize: the visible rectangle plus overscan, clipped to the page.
 *
 * Parameters:
 *   scrollEl, stageEl: as above.
 *   stageWidth, stageHeight: the stage's size in CSS pixels.
 * Returns:
 *   The region to render, in stage CSS pixels.
 * Raises:
 *   Nothing.
 * Summary:
 *   Clipping to the page keeps the canvas from covering blank margin, which matters because the
 *   canvas is positioned in stage coordinates.
 */
function regionToRender(
  scrollEl: HTMLElement,
  stageEl: HTMLElement,
  stageWidth: number,
  stageHeight: number,
): Rect {
  const visible = visibleRect(scrollEl, stageEl)
  const x = clamp(visible.x - OVERSCAN, 0, stageWidth)
  const y = clamp(visible.y - OVERSCAN, 0, stageHeight)
  const right = clamp(visible.x + visible.width + OVERSCAN, 0, stageWidth)
  const bottom = clamp(visible.y + visible.height + OVERSCAN, 0, stageHeight)
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

/**
 * Position a canvas over the stage.
 *
 * Parameters:
 *   canvas: the canvas element.
 *   region: the region it holds, in the stage coordinates it was rendered for.
 *   ratio: current zoom divided by the zoom it was rendered at.
 * Returns:
 *   void
 * Raises:
 *   Nothing.
 * Summary:
 *   With `ratio` at 1 this places a fresh render exactly. With any other value it stretches a
 *   stale render to stand in until the new one arrives, which is what makes zooming feel instant.
 */
function placeCanvas(canvas: HTMLCanvasElement, region: Rect, ratio: number): void {
  canvas.style.left = `${region.x * ratio}px`
  canvas.style.top = `${region.y * ratio}px`
  canvas.style.width = `${region.width * ratio}px`
  canvas.style.height = `${region.height * ratio}px`
}

/**
 * Render the document viewport.
 *
 * Parameters:
 *   props: see `DocumentCanvasProps`.
 * Returns:
 *   The viewer element, including the toolbar-independent stage, overlay, and status layers.
 * Raises:
 *   Nothing; render failures are surfaced as an error message rather than thrown.
 * Summary:
 *   Owns scrolling, panning, wheel-zoom, and the render loop. Selection handling is delegated to
 *   `SelectionOverlay`; the parent owns page, zoom, and mode.
 */
export function DocumentCanvas({
  source,
  page,
  pageSize,
  zoom,
  mode,
  selection,
  onSelect,
  onZoomChange,
  onViewportResize,
  status,
  minZoom,
  maxZoom,
  suspended = false,
}: DocumentCanvasProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderedRef = useRef<RenderedState | null>(null)
  const anchorRef = useRef<{ pageX: number; pageY: number; clientX: number; clientY: number } | null>(
    null,
  )
  const panRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(
    null,
  )

  const [renderNonce, setRenderNonce] = useState(0)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)

  const stageWidth = pageSize ? pageSize.width * zoom : 0
  const stageHeight = pageSize ? pageSize.height * zoom : 0

  /* -------------------------------------------------------------------------------------- *
   * Render loop
   * -------------------------------------------------------------------------------------- */

  useEffect(() => {
    const scrollEl = scrollRef.current
    const stageEl = stageRef.current
    const canvas = canvasRef.current
    if (suspended || !source || !pageSize || !scrollEl || !stageEl || !canvas) return

    const region = regionToRender(scrollEl, stageEl, stageWidth, stageHeight)
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
    const scale = zoom * dpr

    // Render offscreen, then swap in one synchronous step: resizing a live canvas clears it, and
    // doing that mid-scroll is a visible white flash.
    const offscreen = document.createElement('canvas')
    const handle = source.renderRegion(
      page,
      scale,
      {
        x: region.x * dpr,
        y: region.y * dpr,
        width: region.width * dpr,
        height: region.height * dpr,
      },
      offscreen,
    )

    let cancelled = false
    handle.done
      .then(() => {
        if (cancelled || offscreen.width === 0) return
        canvas.width = offscreen.width
        canvas.height = offscreen.height
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) return
        context.drawImage(offscreen, 0, 0)
        renderedRef.current = { region, zoom, page }
        placeCanvas(canvas, region, 1)
        canvas.style.visibility = 'visible'
        setRenderError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setRenderError(error instanceof Error ? error.message : String(error))
      })

    return () => {
      cancelled = true
      handle.cancel()
    }
  }, [source, page, pageSize, zoom, stageWidth, stageHeight, renderNonce, suspended])

  // Hide whatever is on the canvas when the document or page changes - a stale page briefly
  // stretched over the new one reads as a rendering bug.
  useLayoutEffect(() => {
    renderedRef.current = null
    if (canvasRef.current) canvasRef.current.style.visibility = 'hidden'
  }, [source, page])

  // Stand-in scaling while a new zoom level rasterizes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const rendered = renderedRef.current
    if (!canvas || !rendered || rendered.page !== page) return
    placeCanvas(canvas, rendered.region, zoom / rendered.zoom)
  }, [zoom, page])

  /* -------------------------------------------------------------------------------------- *
   * Scroll, resize
   * -------------------------------------------------------------------------------------- */

  /**
   * Decide whether the visible area has drifted outside what is currently rendered.
   *
   * Parameters:
   *   None.
   * Returns:
   *   `true` when a re-render is required.
   * Raises:
   *   Nothing.
   * Summary:
   *   An edge that has reached the page boundary can never need more pixels, so it is excluded -
   *   otherwise scrolling against the end of the page would re-render forever.
   */
  const needsRerender = useCallback((): boolean => {
    const scrollEl = scrollRef.current
    const stageEl = stageRef.current
    const rendered = renderedRef.current
    if (!scrollEl || !stageEl) return false
    if (!rendered || rendered.zoom !== zoom || rendered.page !== page) return true

    const visible = visibleRect(scrollEl, stageEl)
    const region = rendered.region
    return (
      (visible.x < region.x && region.x > 0) ||
      (visible.y < region.y && region.y > 0) ||
      (visible.x + visible.width > region.x + region.width && region.x + region.width < stageWidth) ||
      (visible.y + visible.height > region.y + region.height &&
        region.y + region.height < stageHeight)
    )
  }, [page, stageHeight, stageWidth, zoom])

  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    let timer: number | undefined
    const onScroll = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (needsRerender()) setRenderNonce((value) => value + 1)
      }, SCROLL_SETTLE_MS)
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      window.clearTimeout(timer)
    }
  }, [needsRerender])

  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const observer = new ResizeObserver(() => {
      onViewportResize({
        width: Math.max(1, scrollEl.clientWidth - STAGE_PADDING * 2),
        height: Math.max(1, scrollEl.clientHeight - STAGE_PADDING * 2),
      })
      if (needsRerender()) setRenderNonce((value) => value + 1)
    })
    observer.observe(scrollEl)
    return () => observer.disconnect()
  }, [needsRerender, onViewportResize])

  /* -------------------------------------------------------------------------------------- *
   * Wheel zoom, anchored at the cursor
   * -------------------------------------------------------------------------------------- */

  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl || !pageSize) return

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      // Must be non-passive: without this the browser runs its own page zoom instead.
      event.preventDefault()
      const stageEl = stageRef.current
      if (!stageEl) return

      const bounds = stageEl.getBoundingClientRect()
      const next = clamp(zoom * Math.exp(-event.deltaY * 0.0015), minZoom, maxZoom)
      if (next === zoom) return

      anchorRef.current = {
        pageX: (event.clientX - bounds.left) / zoom,
        pageY: (event.clientY - bounds.top) / zoom,
        clientX: event.clientX,
        clientY: event.clientY,
      }
      onZoomChange(next)
    }

    scrollEl.addEventListener('wheel', onWheel, { passive: false })
    return () => scrollEl.removeEventListener('wheel', onWheel)
  }, [maxZoom, minZoom, onZoomChange, pageSize, zoom])

  // Re-anchor after the stage has been laid out at the new zoom, so the point under the cursor
  // stays under the cursor.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    anchorRef.current = null
    const scrollEl = scrollRef.current
    const stageEl = stageRef.current
    if (!scrollEl || !stageEl) return
    const bounds = stageEl.getBoundingClientRect()
    scrollEl.scrollLeft += bounds.left + anchor.pageX * zoom - anchor.clientX
    scrollEl.scrollTop += bounds.top + anchor.pageY * zoom - anchor.clientY
  }, [zoom])

  /* -------------------------------------------------------------------------------------- *
   * Panning
   * -------------------------------------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      event.preventDefault()
      setSpaceHeld(true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const panReady = mode === 'pan' || spaceHeld

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Middle-drag always pans, so panning stays available without leaving Select mode.
      const wantsPan = event.button === 1 || (event.button === 0 && panReady)
      if (!wantsPan) return
      const scrollEl = scrollRef.current
      if (!scrollEl) return
      panRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: scrollEl.scrollLeft,
        top: scrollEl.scrollTop,
      }
      scrollEl.setPointerCapture(event.pointerId)
      setPanning(true)
      event.preventDefault()
    },
    [panReady],
  )

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    const scrollEl = scrollRef.current
    if (!pan || !scrollEl || pan.pointerId !== event.pointerId) return
    scrollEl.scrollLeft = pan.left - (event.clientX - pan.x)
    scrollEl.scrollTop = pan.top - (event.clientY - pan.y)
  }, [])

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    panRef.current = null
    setPanning(false)
  }, [])

  /* -------------------------------------------------------------------------------------- *
   * Render
   * -------------------------------------------------------------------------------------- */

  const scrollClass =
    'viewer__scroll' +
    (panning ? ' viewer__scroll--panning' : panReady ? ' viewer__scroll--pan-ready' : '')

  return (
    <div
      ref={scrollRef}
      className={scrollClass}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {pageSize && (
        <div
          ref={stageRef}
          className="page-stage"
          style={{ width: `${stageWidth}px`, height: `${stageHeight}px` }}
        >
          <canvas ref={canvasRef} className="page-stage__canvas" style={{ visibility: 'hidden' }} />
          <SelectionOverlay
            stageWidth={stageWidth}
            stageHeight={stageHeight}
            selection={selection}
            enabled={mode === 'select' && !spaceHeld}
            onSelect={onSelect}
          />
        </div>
      )}

      {status.state === 'empty' && (
        <div className="viewer__empty">
          <strong>No document open</strong>
          <span>Pick a file from the library on the right to begin.</span>
        </div>
      )}

      {status.state === 'loading' && (
        <div className="viewer__status">
          <span className="spinner" />
          <span>{status.message ?? 'Loading document...'}</span>
        </div>
      )}

      {(status.state === 'error' || renderError) && (
        <div className="viewer__status viewer__error">
          <strong>Could not display this document</strong>
          <span>{status.message ?? renderError}</span>
        </div>
      )}
    </div>
  )
}
