/**
 * The Test Strategy workspace: open a sheet, find a symbol, box it.
 *
 * Summary:
 *   This page detects nothing. It exists to produce the one input every detection strategy needs
 *   - a clean exemplar - and to prove the plumbing around it works: streaming a 215-page drawing
 *   set, rasterizing a page, and holding a region selection that stays anchored to the drawing
 *   under any zoom.
 *
 *   State lives here rather than in the viewer because it is the state the future strategy runs
 *   will need: which document, which page, and which region.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { DocumentCanvas, type ViewerMode } from '../components/DocumentCanvas'
import { FileList } from '../components/FileList'
import { SelectionChip } from '../components/SelectionChip'
import { ViewerToolbar } from '../components/ViewerToolbar'
import { createSelection } from '../lib/crop'
import { clamp } from '../lib/geometry'
import { openDocument, type RenderSource } from '../lib/source'
import type { LibraryFile, NormRect, PageSize, Selection } from '../types'

const MIN_ZOOM = 0.05
const MAX_ZOOM = 12
/** Ratio between adjacent zoom steps on the toolbar buttons. */
const ZOOM_STEP = 1.25

type LoadState = 'empty' | 'loading' | 'ready' | 'error'

/**
 * Render the Test Strategy workspace.
 *
 * Parameters:
 *   None.
 * Returns:
 *   The workspace element.
 * Raises:
 *   Nothing; load failures surface in the viewer's status layer.
 * Summary:
 *   Owns the document, page, zoom, mode, and selection. The viewer below it is stateless apart
 *   from its render bookkeeping.
 */
export function TestStrategyPage() {
  const [activeFile, setActiveFile] = useState<LibraryFile | null>(null)
  const [source, setSource] = useState<RenderSource | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('empty')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize | null>(null)
  const [zoom, setZoom] = useState(1)
  const [mode, setMode] = useState<ViewerMode>('select')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [viewport, setViewport] = useState<PageSize | null>(null)

  /**
   * Set when a newly opened document still needs its initial fit-to-page.
   *
   * State rather than a ref, because rendering is suspended while it is set: without that, every
   * document would first rasterize a full-size page at 100% only to have it thrown away a frame
   * later when the fit lands.
   */
  const [pendingFit, setPendingFit] = useState<'page' | 'width' | null>(null)
  /** Guards against an out-of-order crop resolving after a newer one. */
  const selectionTokenRef = useRef(0)

  /* -------------------------------------------------------------------------------------- *
   * Document lifecycle
   * -------------------------------------------------------------------------------------- */

  useEffect(() => {
    if (!activeFile) {
      setSource(null)
      setLoadState('empty')
      return
    }

    let cancelled = false
    let opened: RenderSource | null = null

    setLoadState('loading')
    setLoadError(null)
    setPageSize(null)
    setSource(null)

    openDocument(activeFile)
      .then((next) => {
        if (cancelled) {
          next.destroy()
          return
        }
        opened = next
        setSource(next)
        setPage(1)
        setPendingFit('page')
        setLoadState('ready')
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(cause instanceof Error ? cause.message : String(cause))
        setLoadState('error')
      })

    return () => {
      cancelled = true
      opened?.destroy()
    }
  }, [activeFile])

  // Page dimensions drive the stage size, so they must land before anything is painted.
  useEffect(() => {
    if (!source) return
    let cancelled = false
    source
      .getPageSize(page)
      .then((size) => {
        if (!cancelled) setPageSize(size)
      })
      .catch(() => {
        if (!cancelled) setPageSize(null)
      })
    return () => {
      cancelled = true
    }
  }, [source, page])

  /* -------------------------------------------------------------------------------------- *
   * Zoom
   * -------------------------------------------------------------------------------------- */

  const fitZoom = useCallback(
    (kind: 'page' | 'width'): number | null => {
      if (!pageSize || !viewport) return null
      const byWidth = viewport.width / pageSize.width
      const byHeight = viewport.height / pageSize.height
      return clamp(kind === 'width' ? byWidth : Math.min(byWidth, byHeight), MIN_ZOOM, MAX_ZOOM)
    },
    [pageSize, viewport],
  )

  // Fit a freshly opened document once both the page size and the viewport size are known.
  useEffect(() => {
    if (!pendingFit) return
    const next = fitZoom(pendingFit)
    if (next === null) return
    setPendingFit(null)
    setZoom(next)
  }, [fitZoom, pendingFit])

  const applyFit = useCallback(
    (kind: 'page' | 'width') => {
      const next = fitZoom(kind)
      if (next !== null) setZoom(next)
    },
    [fitZoom],
  )

  const handleZoomChange = useCallback((next: number) => {
    setZoom(clamp(next, MIN_ZOOM, MAX_ZOOM))
  }, [])

  const handleViewportResize = useCallback((size: PageSize) => {
    setViewport((previous) =>
      previous && previous.width === size.width && previous.height === size.height ? previous : size,
    )
  }, [])

  /* -------------------------------------------------------------------------------------- *
   * Selection
   * -------------------------------------------------------------------------------------- */

  const handleSelect = useCallback(
    (rect: NormRect) => {
      if (!source || !activeFile) return
      const token = ++selectionTokenRef.current
      createSelection(source, activeFile.name, page, rect)
        .then((next) => {
          // Drop the result if the user has already drawn again or changed documents.
          if (token === selectionTokenRef.current) setSelection(next)
        })
        .catch(() => {
          if (token === selectionTokenRef.current) setSelection(null)
        })
    },
    [activeFile, page, source],
  )

  const handleClearSelection = useCallback(() => {
    selectionTokenRef.current += 1
    setSelection(null)
  }, [])

  const handleSelectFile = useCallback(
    (file: LibraryFile) => {
      if (file.name === activeFile?.name) return
      selectionTokenRef.current += 1
      setSelection(null)
      setActiveFile(file)
    },
    [activeFile],
  )

  const handlePageChange = useCallback(
    (next: number) => {
      if (!source) return
      setPage(clamp(Math.round(next), 1, source.pageCount))
    },
    [source],
  )

  /* -------------------------------------------------------------------------------------- *
   * Render
   * -------------------------------------------------------------------------------------- */

  const ready = loadState === 'ready' && Boolean(pageSize)
  const status =
    loadState === 'error'
      ? { state: 'error' as const, message: loadError ?? undefined }
      : loadState === 'loading' || (loadState === 'ready' && !pageSize)
        ? { state: 'loading' as const, message: 'Rasterizing page...' }
        : loadState === 'empty'
          ? { state: 'empty' as const }
          : { state: 'ready' as const }

  return (
    <main className="workspace">
      <section className="viewer">
        <ViewerToolbar
          fileName={activeFile?.name ?? null}
          zoom={zoom}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          onZoomIn={() => handleZoomChange(zoom * ZOOM_STEP)}
          onZoomOut={() => handleZoomChange(zoom / ZOOM_STEP)}
          onFitPage={() => applyFit('page')}
          onFitWidth={() => applyFit('width')}
          onActualSize={() => handleZoomChange(1)}
          page={page}
          pageCount={source?.pageCount ?? 0}
          onPageChange={handlePageChange}
          mode={mode}
          onModeChange={setMode}
          disabled={!ready}
        />

        <DocumentCanvas
          source={source}
          page={page}
          pageSize={pageSize}
          zoom={zoom}
          mode={mode}
          // The box belongs to one page; showing it on any other would be a lie about where it is.
          selection={selection && selection.page === page ? selection.rect : null}
          onSelect={handleSelect}
          onZoomChange={handleZoomChange}
          onViewportResize={handleViewportResize}
          status={status}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          suspended={pendingFit !== null}
        />

        {selection && <SelectionChip selection={selection} onClear={handleClearSelection} />}
      </section>

      <FileList activeFileName={activeFile?.name ?? null} onSelectFile={handleSelectFile} />
    </main>
  )
}
