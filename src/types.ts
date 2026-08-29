/**
 * Shared vocabulary for the whole app.
 *
 * Summary:
 *   Two ideas here matter more than the rest. `NormRect` is the only rectangle type that ever
 *   crosses a module boundary, and `Selection` is the exact object handed to the detection
 *   backend. Everything else is bookkeeping.
 */

/** How a library file is rasterized: multi-page PDF, or a single-page bitmap. */
export type FileKind = 'pdf' | 'image'

/** One document in the `data/` library, as reported by `GET /api/library`. */
export interface LibraryFile {
  name: string
  /** Server path the bytes can be fetched from, e.g. `/data/skanska-drawing-set.pdf`. */
  url: string
  ext: string
  kind: FileKind
  sizeBytes: number
  /** ISO-8601 mtime. */
  modifiedAt: string
}

/**
 * A rectangle in normalized page coordinates: 0..1 of the page's intrinsic width and height,
 * origin top-left.
 *
 * This is the app's universal rectangle. Screen pixels are derived from it for painting and
 * thrown away immediately; nothing is ever stored in pixels. That is what lets a box survive
 * zooming, resizing, and leaving and re-entering a page - and it is what lets the detection
 * backend re-rasterize the same region at whatever DPI it wants.
 */
export interface NormRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Intrinsic page size: PDF points for `pdf` sources, pixels for `image` sources. */
export interface PageSize {
  width: number
  height: number
}

/**
 * The exemplar the user drew: one region of one page of one document, plus a rendered crop of it.
 *
 * This is the input to every detection strategy. `rect` says *where*, `thumbnailDataUrl` is the
 * *what* - a crop rendered at `cropDpi` rather than scraped off the screen, so the template is
 * the same quality no matter what zoom level the user happened to be at when they drew it.
 */
export interface Selection {
  fileName: string
  /** 1-based. */
  page: number
  rect: NormRect
  /** Intrinsic size of the page the rect is relative to. */
  pageSize: PageSize
  /** PNG data URL of the region, rendered at `cropDpi`. */
  thumbnailDataUrl: string
  cropDpi: number
  /** Pixel dimensions of the rendered crop. */
  cropSize: PageSize
  /** ISO-8601. */
  createdAt: string
}

/* ------------------------------------------------------------------------------------------ *
 * Detection contract
 *
 * Not implemented yet - see FUTURE_WORK.md. These types exist now so the UI and the future
 * computer-vision program are already speaking the same language, and so that adding a strategy
 * never means renegotiating the interface.
 * ------------------------------------------------------------------------------------------ */

/** What the frontend sends to run a strategy. */
export interface DetectRequest {
  strategyId: string
  fileName: string
  /** 1-based page the exemplar came from. Detection runs on this page unless `scope` widens it. */
  page: number
  /** The exemplar region, in normalized page coordinates. */
  bbox: NormRect
  /** DPI the backend should rasterize at. The frontend's crop DPI, so both sides see one image. */
  dpi: number
  /** Which pages to search. `page` is the default; `document` means the whole file. */
  scope?: 'page' | 'document'
  /** Strategy-specific knobs (similarity threshold, patch size, rotation set, ...). */
  options?: Record<string, unknown>
}

/** One detected instance. */
export interface DetectMatch {
  bbox: NormRect
  /** 1-based page the match is on. */
  page: number
  /** Similarity in 0..1, comparable only within a single response. */
  score: number
  /** Rotation of the match relative to the exemplar, if the strategy searched rotations. */
  rotationDeg?: number
}

/** What a strategy returns. */
export interface DetectResponse {
  strategyId: string
  matches: DetectMatch[]
  /** `matches.length` after the strategy's own thresholding and non-maximum suppression. */
  count: number
  elapsedMs: number
  /** The score cutoff actually applied, so the UI can offer a slider around it. */
  thresholdUsed?: number
}
