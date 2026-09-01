/**
 * The Test Strategy workspace: open a sheet, find a symbol, box it.
 *
 * Summary:
 *   This page detects nothing. It exists to produce the one input every detection strategy needs
 *   - a clean exemplar - and to prove the plumbing around it works: streaming a multi-sheet drawing
 *   set, rasterizing a page, and holding a region selection that stays anchored to the drawing
 *   under any zoom.
 *
 *   State lives here rather than in the viewer because it is the state the future strategy runs
 *   will need: which document, which page, and which region.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { DocumentCanvas, type ViewerMode } from '../components/DocumentCanvas'
import { FileList } from '../components/FileList'
import { ResultsPanel } from '../components/ResultsPanel'
import { SelectionChip } from '../components/SelectionChip'
import { ViewerToolbar } from '../components/ViewerToolbar'
import { buildDetectRequest, runStrategy } from '../api/detect'
import { createSelection } from '../lib/crop'
import { clamp } from '../lib/geometry'
import { openDocument, type RenderSource } from '../lib/source'
import type { DetectResponse, LibraryFile, NormRect, PageSize, Selection } from '../types'

/** The only strategy with a backend today. */
const STRATEGY_ID = 'fft-ncc'

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
  const [detection, setDetection] = useState<DetectResponse | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  /** The user's cutoff override. Null means "use whatever the service suggested". */
  const [thresholdOverride, setThresholdOverride] = useState<number | null>(null)
  const [showNearMisses, setShowNearMisses] = useState(true)
  const [showHeatmap, setShowHeatmap] = useState(false)
  /**
   * Whether the search covers reflections as well as rotations.
   *
   * On by default - see `DEFAULT_DETECT_OPTIONS`. Unlike the two flags above this is not a view
   * setting: it changes what the service looks for, so changing it costs a run.
   */
  const [mirror, setMirror] = useState(true)

  /** Guards against an out-of-order crop resolving after a newer one. */
  const selectionTokenRef = useRef(0)
  /** Cancels a detection run superseded by a newer one, or by leaving the page. */
  const detectAbortRef = useRef<AbortController | null>(null)

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
   * Detection
   * -------------------------------------------------------------------------------------- */

  const clearDetection = useCallback(() => {
    detectAbortRef.current?.abort()
    detectAbortRef.current = null
    setDetection(null)
    setDetectError(null)
    setThresholdOverride(null)
    setDetecting(false)
  }, [])

  /**
   * Run detection.
   *
   * Parameters:
   *   run.heatmap: ask for the correlation response map as well as the matches.
   *   run.mirror: search reflected orientations alongside the rotations.
   *   run.keepThreshold: leave a cutoff the user has already chosen alone.
   * Returns:
   *   Nothing; results land in state.
   * Raises:
   *   Nothing; failures land in `detectError`.
   * Summary:
   *   An object rather than positional booleans. There are three call sites and three flags now,
   *   and `runDetection(true, false, true)` at a call site says nothing about what it does.
   *
   *   The flags are arguments rather than reads of component state because every caller is a
   *   toggle handler acting on the *next* value: `setMirror` has not landed by the time this runs,
   *   so reading state here would run the setting the user just moved away from.
   */
  const runDetection = useCallback(
    (run: { heatmap: boolean; mirror: boolean; keepThreshold?: boolean }) => {
      if (!selection) return
      // A superseded run must not land after a newer one and overwrite it.
      detectAbortRef.current?.abort()
      const controller = new AbortController()
      detectAbortRef.current = controller

      setDetecting(true)
      setDetectError(null)

      // Built with its options rather than mutated afterwards. Assigning `request.options`
      // replaces the whole object, so the previous `request.options = { includeHeatmap: true }`
      // would have dropped `mirror` on exactly the runs that asked for both.
      const request = buildDetectRequest(STRATEGY_ID, selection, 'page', {
        mirror: run.mirror,
        includeHeatmap: run.heatmap,
      })

      runStrategy(request, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return
          setDetection(response)
          // A run triggered only to fetch the response map must not throw away a cutoff the user
          // has already chosen - toggling a view should not silently change the count.
          if (!run.keepThreshold) setThresholdOverride(null)
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return
          setDetectError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (!controller.signal.aborted) setDetecting(false)
        })
    },
    [selection],
  )

  /**
   * The response map is opt-in, so turning it on for an existing result needs a fresh run.
   * Turning it off is free - the map is already in hand and simply stops being drawn.
   */
  const handleToggleHeatmap = useCallback(() => {
    const next = !showHeatmap
    setShowHeatmap(next)
    if (next && detection && !detection.heatmapPng) {
      runDetection({ heatmap: true, mirror, keepThreshold: true })
    }
  }, [detection, mirror, runDetection, showHeatmap])

  /**
   * Mirroring is a search setting, not a view setting, so both directions need a fresh run.
   *
   * The heatmap toggle turns off for free - the map is already in hand and simply stops being
   * drawn. This one cannot be served from the reply already held in either direction: turning it
   * on has to go and find the reflected instances, and turning it off has to actually remove them
   * from the answer rather than merely stop drawing them.
   *
   * The user's cutoff survives, for the same reason it survives a heatmap toggle - it is a score,
   * still meaningful against the new candidate set, and flipping a mode should not silently move a
   * number the user chose. The *derived* cutoff will move, because eight orientations roughly
   * double the background population the knee search examines; the auto button shows where it went.
   */
  const handleToggleMirror = useCallback(() => {
    const next = !mirror
    setMirror(next)
    if (detection) runDetection({ heatmap: showHeatmap, mirror: next, keepThreshold: true })
  }, [detection, mirror, runDetection, showHeatmap])

  useEffect(() => () => detectAbortRef.current?.abort(), [])

  /* -------------------------------------------------------------------------------------- *
   * Selection
   * -------------------------------------------------------------------------------------- */

  const handleSelect = useCallback(
    (rect: NormRect) => {
      if (!source || !activeFile) return
      const token = ++selectionTokenRef.current
      // Results describe the previous template, so they cannot outlive it.
      clearDetection()
      createSelection(source, activeFile.name, page, rect)
        .then((next) => {
          // Drop the result if the user has already drawn again or changed documents.
          if (token === selectionTokenRef.current) setSelection(next)
        })
        .catch(() => {
          if (token === selectionTokenRef.current) setSelection(null)
        })
    },
    [activeFile, clearDetection, page, source],
  )

  const handleClearSelection = useCallback(() => {
    selectionTokenRef.current += 1
    setSelection(null)
    clearDetection()
  }, [clearDetection])

  const handleSelectFile = useCallback(
    (file: LibraryFile) => {
      if (file.name === activeFile?.name) return
      selectionTokenRef.current += 1
      setSelection(null)
      clearDetection()
      setActiveFile(file)
    },
    [activeFile, clearDetection],
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

  // The cutoff in force: the user's, or the service's suggestion until they move it.
  const effectiveThreshold = thresholdOverride ?? detection?.thresholdUsed ?? 0
  // Detection is single-page, so matches only render on the page they were found on - the same
  // rule the exemplar box already follows.
  const pageMatches = detection?.matches.filter((match) => match.page === page)

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
      <section className={'viewer' + (detection ? ' viewer--has-results' : '')}>
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
          matches={pageMatches}
          matchThreshold={effectiveThreshold}
          showNearMisses={showNearMisses}
          heatmapPng={showHeatmap ? (detection?.heatmapPng ?? null) : null}
          heatmapFloor={detection?.floorUsed ?? 0}
        />

        {selection && (
          <SelectionChip
            selection={selection}
            onClear={handleClearSelection}
            onDetect={() => runDetection({ heatmap: showHeatmap, mirror })}
            detecting={detecting}
            error={detectError}
          />
        )}

        {detection && (
          <ResultsPanel
            detection={detection}
            threshold={effectiveThreshold}
            onThresholdChange={setThresholdOverride}
            onResetThreshold={() => setThresholdOverride(null)}
            showNearMisses={showNearMisses}
            onToggleNearMisses={() => setShowNearMisses((value) => !value)}
            showHeatmap={showHeatmap}
            onToggleHeatmap={handleToggleHeatmap}
            heatmapPending={detecting}
            mirror={mirror}
            onToggleMirror={handleToggleMirror}
            mirrorPending={detecting}
            onClear={clearDetection}
          />
        )}
      </section>

      <FileList activeFileName={activeFile?.name ?? null} onSelectFile={handleSelectFile} />
    </main>
  )
}
